/**
 * "Take a pass at editing this" (revise-safety agent, 2026-10-21; warm-moody-oat REPORT item 1 and "what to build" 1):
 * one sentence → ONE commit that does what an editor's first pass does —
 *
 *   1. transcribe every clip with speech that has no transcript yet (one job at a time; waits within the call's budget,
 *      else answers "still transcribing: send the same call again" and commits nothing);
 *   2. autocut every clip (silences, retakes, false starts, heads and tails; tails ripple: no gaps);
 *   3. transitions on SET-UP CHANGES only, found from the clips themselves: two neighbouring clips from different
 *      source files, or from one file when the last frame of the first and the first frame of the next differ by more
 *      than a scene-change threshold (mean absolute luma difference of 36×64 grey frames, 0..1; MEASURED on the oat
 *      inputs: jump cuts inside one set-up 0.017–0.068, set-up changes 0.101–0.194 → threshold 0.085). A jump cut stays
 *      a cut. The kind: what the person said ("with dissolves"), else the active editing style's join, else whips
 *      (alternating left / right, 0.2 s);
 *   4. captions in the style the person asked for, else the style the timeline's captions have, else the active
 *      editing style's caption style (aesthetic → serif-box, moody → huge-centred, fast UGC → word-pop, talking head →
 *      bold-white, paper collage → mono-label), else word-pop — measured, face-aware, every look kept;
 *   then the word guard (cut-aware) and one commit by claude with the sentence as its message.
 *
 * The answer is the plan as done (every cut, every transition with why, the captions) plus the exact calls that undo
 * it (history restore) or alter it (another caption style, other transitions, keep the retakes).
 */
import { spawn } from "node:child_process";
import { apply, EDITING_STYLE_PRESETS, getCaptionStyle, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import { cutClip } from "@/mcp/cut";
import type { Payload, ToolOutput } from "@/mcp/protocol";
import type { Actor } from "./auth";
import { guardSnapshots, guardView, measureCaptionSpans, spansView, type WordGuard } from "./caption-words";
import { mediaIndex, remapDoc, timelineCaptionWords } from "./captions-rebuild";
import { getProjectHead, pushCommit } from "./projects";
import { recordMilestone } from "./storyboard-versions";
import { DEFAULT_TRANSCRIBE_MODEL, FFMPEG, findTranscript, resolveMediaFile, sourcePath, startTranscript, waitForJob, type TranscriptJob } from "./transcripts";
import { activeScene, buildCaptions, carryTimelineFixes, chunksOutside, clipWindow, mergeDocs, rateOf, readCaptionDoc, rechunk, spokenClips, type BuiltCaptions } from "./transcripts-timeline";
import type { ProjectSnapshot, SnapshotElement } from "@/sync/snapshot";

const T = 120_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Mean absolute luma difference (0..1) above which two neighbouring clips of ONE file are a set-up change. */
export const SETUP_CHANGE_SCORE = 0.085;
/** Seconds the call may wait for transcripts before answering "send it again" (revise's budget is 190 s). */
const TRANSCRIBE_WAIT_S = 100;
/** A style's join length (timeline-ops styles.ts JOIN_SECONDS: a whip is 4–6 frames). */
const JOIN_S = 0.2;

// ─── the sentence ───────────────────────────────────────────────────────────────────────────────────────────────

export interface FirstPassAsk {
	/** A caption style id the person named ("with serif captions"), or null. */
	captionStyle: string | null;
	/** A transition kind the person named ("whip", "dissolve", …), "none" for hard cuts, or null. */
	transition: string | null;
	/** Parts of the sentence that are neither (reported as not understood; the pass still runs). */
	unknown: string[];
}

const TRIGGER_RE =
	/^(?:(?:please|ok|okay|now|so|hey|alright)[,!]?\s+)*(?:can you\s+|could you\s+|would you\s+|go ahead and\s+|let'?s\s+|i want you to\s+)?(?:(?:take|do|have|give it)\s+(?:a|another|the|your)?\s*(?:first|quick|rough|initial)?\s*(?:pass|go|stab|crack|edit)(?:\s+at\s+(?:editing|cutting)?\s*(?:this|it|the video|the footage|these clips|my clips|them)?)?|(?:edit|cut)\s+(?:this|it|the video|the footage|these clips|my clips|them)(?:\s+(?:for me|together|down))?|(?:make|do)\s+(?:a|the)\s+(?:rough|first)\s+cut(?:\s+of\s+(?:this|it|the footage))?|rough cut\s+(?:this|it))/i;

const CAPTION_WORDS: Array<[RegExp, string]> = [
	[/\bkey[- ]?words?\b/, "key-word"],
	[/\bserif\b/, "serif-box"],
	[/\b(mono|typewriter|label)\b/, "mono-label"],
	[/\b(huge|one word|giant|moody)\b/, "huge-centred"],
	[/\b(word[- ]?pop|pop|neon|highlight(ed)?)\b/, "word-pop"],
	[/\b(bold|clean|white|simple)\b/, "bold-white"],
];
const TRANSITION_WORDS: Array<[RegExp, string]> = [
	[/\b(no transitions?|hard cuts?|straight cuts?|just cuts?|plain cuts?)\b/, "none"],
	[/\bwhips?\b|\bwhip pans?\b/, "whip"],
	[/\b(dissolves?|cross ?fades?|fades?)\b/, "dissolve"],
	[/\bpush(es)?\b/, "push-left"],
	[/\bslides?\b/, "slide-left"],
	[/\bzooms?\b/, "zoom-in"],
	[/\bflash(es)?\b/, "flash"],
	[/\bglitch(es)?\b/, "glitch"],
	[/\bwipes?\b/, "wipe-left"],
];
const FILLER_RE = /^(?:please|for me|thanks|thank you|now|the|captions?|subtitles?|transitions?|style|on|set[- ]?up changes?|between (?:the )?(?:clips|shots|set[- ]?ups)|at (?:the )?(?:cuts|set[- ]?up changes)|)$/;

/** "take a pass at editing this", "do a first pass with serif captions", "edit this for me" → the ask; else null. */
export function parseFirstPass(sentence: string): FirstPassAsk | null {
	const text = sentence.trim().toLowerCase().replace(/[.!?]+$/g, "").trim();
	const hit = text.match(TRIGGER_RE);
	if (!hit || hit.index !== 0) return null;
	const rest = text.slice(hit[0].length).trim();
	const ask: FirstPassAsk = { captionStyle: null, transition: null, unknown: [] };
	for (const raw of rest.split(/,|;|\band\b|\bwith\b|\busing\b|\bin\b|\bplus\b/)) {
		let part = raw.trim();
		if (!part) continue;
		let known = false;
		for (const [re, id] of CAPTION_WORDS) {
			if (re.test(part) && /\b(captions?|subtitles?|subs|style|words?)\b|^(serif|mono|key ?words?|word[- ]?pop|huge|bold)$/.test(part)) {
				ask.captionStyle = id;
				part = part.replace(re, " ");
				known = true;
				break;
			}
		}
		for (const [re, id] of TRANSITION_WORDS) {
			if (re.test(part)) {
				ask.transition = id;
				part = part.replace(re, " ");
				known = true;
				break;
			}
		}
		const left = part.replace(/\b(captions?|subtitles?|subs|transitions?|style|a|an|the|some|for me|please)\b/g, " ").replace(/\s+/g, " ").trim();
		if (!known && left && !FILLER_RE.test(left)) ask.unknown.push(raw.trim());
		else if (known && left && !FILLER_RE.test(left)) ask.unknown.push(left);
	}
	// a sentence that only starts like a pass but asks for something else ("edit this caption to …") is not a pass
	if (/\b(caption|title|beat|row)\s+(to|say)\b/.test(rest) || /["“']/.test(rest)) return null;
	return ask;
}

// ─── the active editing style ───────────────────────────────────────────────────────────────────────────────────

/** Caption style for an editing style (the closest look among the caption presets). */
export const STYLE_CAPTIONS: Record<string, string> = {
	"fast-ugc": "word-pop",
	"talking-head": "bold-white",
	"aesthetic-warm": "serif-box",
	"moody-captions": "huge-centred",
	"paper-collage": "mono-label",
};

/** The editing style the timeline shows now: its GRADE layer's look, else its captions' font (null = none). */
export function activeEditingStyle(snapshot: ProjectSnapshot): string | null {
	const overlay = activeScene(snapshot)?.tracks?.overlay ?? [];
	const grades = overlay
		.filter((track) => track.type === "effect")
		.flatMap((track) => track.elements ?? [])
		.filter((element) => (element as { effectType?: string }).effectType === "restorff-grade")
		.map((element) => String((element.params as Record<string, unknown> | undefined)?.preset ?? (element.params as Record<string, unknown> | undefined)?.look ?? element.name ?? "").toLowerCase());
	for (const preset of EDITING_STYLE_PRESETS) {
		const grade = (preset.grade ?? "").toLowerCase().replace(/-/g, " ");
		if (grade && grades.some((name) => name.replace(/-/g, " ").includes(grade))) return preset.id;
	}
	const fonts = overlay
		.filter((track) => track.type === "text")
		.flatMap((track) => track.elements ?? [])
		.map((element) => String((element.params as Record<string, unknown> | undefined)?.fontFamily ?? ""));
	for (const preset of EDITING_STYLE_PRESETS) if (preset.captions.font && fonts.includes(preset.captions.font)) return preset.id;
	return null;
}

// ─── set-up changes ─────────────────────────────────────────────────────────────────────────────────────────────

function greyFrame(file: string, t: number): Promise<Buffer | null> {
	return new Promise((resolve) => {
		const child = spawn(FFMPEG, ["-v", "error", "-ss", String(Math.max(0, t)), "-i", file, "-frames:v", "1", "-vf", "scale=36:64,format=gray", "-f", "rawvideo", "-"], { windowsHide: true });
		const parts: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => parts.push(chunk));
		child.on("error", () => resolve(null));
		child.on("close", () => {
			const all = Buffer.concat(parts);
			resolve(all.length >= 36 * 64 ? all.subarray(0, 36 * 64) : null);
		});
	});
}

/** Mean absolute luma difference (0..1) between the last frame of `a` and the first frame of `b` (source files). */
export async function sceneScore(fileA: string, tA: number, fileB: string, tB: number): Promise<number | null> {
	const [x, y] = await Promise.all([greyFrame(fileA, tA), greyFrame(fileB, tB)]);
	if (!x || !y) return null;
	let sum = 0;
	for (let i = 0; i < x.length; i++) sum += Math.abs((x[i] as number) - (y[i] as number));
	return Math.round((sum / (x.length * 255)) * 10_000) / 10_000;
}

export interface Join {
	a: string;
	b: string;
	at_s: number;
	setup_change: boolean;
	why: string;
	score?: number | null;
}

/** Every cut between touching clips on the A-roll track, and whether it is a set-up change. */
export async function findSetupChanges(timelineId: string, snapshot: ProjectSnapshot, fps: number): Promise<Join[]> {
	const main = activeScene(snapshot)?.tracks?.main;
	const clips = [...(main?.elements ?? [])].filter((element) => element.type === "video" || element.type === "image").sort((a, b) => a.startTime - b.startTime);
	const listed = await mediaIndex(timelineId).catch(() => []);
	const files = new Map<string, string | null>();
	const fileOf = async (element: SnapshotElement) => {
		const id = String(element.mediaId ?? "");
		if (!files.has(id)) {
			try {
				files.set(id, sourcePath(await resolveMediaFile(timelineId, id, listed)));
			} catch {
				files.set(id, null);
			}
		}
		return files.get(id) ?? null;
	};
	const joins: Join[] = [];
	for (let i = 1; i < clips.length; i++) {
		const a = clips[i - 1] as SnapshotElement;
		const b = clips[i] as SnapshotElement;
		if (Math.abs(a.startTime + a.duration - b.startTime) > 1) continue; // not touching: no cut to join
		const at = r3(b.startTime / T);
		if (a.mediaId !== b.mediaId) {
			joins.push({ a: a.id, b: b.id, at_s: at, setup_change: true, why: "a different source file" });
			continue;
		}
		const [fa, fb] = await Promise.all([fileOf(a), fileOf(b)]);
		const wa = clipWindow(a);
		const wb = clipWindow(b);
		const score = fa && fb ? await sceneScore(fa, wa.out - rateOf(a) / fps, fb, wb.in) : null;
		const change = score !== null && score > SETUP_CHANGE_SCORE;
		joins.push({ a: a.id, b: b.id, at_s: at, setup_change: change, why: score === null ? "same file (frames not readable: kept as a cut)" : change ? `same file, the picture changes (scene score ${score} > ${SETUP_CHANGE_SCORE})` : `same file, same set-up (scene score ${score} ≤ ${SETUP_CHANGE_SCORE}): a jump cut`, score });
	}
	return joins;
}

// ─── the pass ───────────────────────────────────────────────────────────────────────────────────────────────────

export type FirstPassResult =
	| {
			ok: true;
			dry_run: boolean;
			head: string;
			commit_id: string | null;
			message: string;
			ask: FirstPassAsk;
			transcribed: Array<{ media_id: string; status: string; words?: number; cached: boolean }>;
			autocut: { clips: number; removed_s: number; by_reason: Record<string, { count: number; seconds: number }>; gaps_on_track: number; cuts: Array<Record<string, unknown>>; skipped: Array<{ element_id: string; why: string }> };
			transitions: { kind: string; dur_s: number; added: Join[]; jump_cuts: Join[]; style_from: string };
			captions: { style: string; style_from: string; chunks: number; placement: BuiltCaptions["placement"]; outside_safe_area: number; outside?: BuiltCaptions["outsideSafeArea"]; split_to_fit?: number; media_without_transcript: string[] } | null;
			words: WordGuard;
			spans: ReturnType<typeof measureCaptionSpans>;
			duration_s: { before: number; after: number };
			version: string | null;
	  }
	| { ok: false; code: string; message: string; details?: Record<string, unknown>; next?: Payload };

function runtimeOf(snapshot: ProjectSnapshot): number {
	const scene = activeScene(snapshot);
	let end = 0;
	for (const track of [scene?.tracks?.main, ...(scene?.tracks?.overlay ?? []), ...(scene?.tracks?.audio ?? [])]) for (const element of track?.elements ?? []) end = Math.max(end, element.startTime + element.duration);
	return r2(end / T);
}

function fpsOf(snapshot: ProjectSnapshot): number {
	const fps = snapshot.settings?.fps;
	return typeof fps === "number" ? fps : fps ? fps.numerator / fps.denominator : 30;
}

export async function runFirstPass(input: {
	timelineId: string;
	sentence: string;
	ask: FirstPassAsk;
	actor: Actor;
	branch?: string;
	dryRun: boolean;
	baseCommit?: string;
	signal?: AbortSignal;
	allowWordLoss?: boolean;
}): Promise<FirstPassResult> {
	const { timelineId, sentence, ask } = input;
	const head = await getProjectHead(timelineId, input.branch);
	if (!head.snapshot) return { ok: false, code: "no_snapshot", message: "The head commit has no snapshot." };
	const headId = head.head.id;
	if (input.baseCommit && input.baseCommit !== headId && !(input.baseCommit.length >= 7 && headId.startsWith(input.baseCommit))) {
		return { ok: false, code: "conflict", message: `The timeline moved on: its head is ${headId}, not ${input.baseCommit}. Nothing was committed.`, details: { head: headId } };
	}
	const start = head.snapshot;
	const spoken = spokenClips(start).filter(({ element }) => element.type === "video");
	if (!spoken.length) return { ok: false, code: "no_clips", message: "No video clip with sound on this timeline: put the footage on V1 first (media import {place: {track: \"V1\"}})." };

	// 1. transcripts (one job at a time on the GPU; cached files come back at once)
	const listed = await mediaIndex(timelineId);
	const transcribed: Array<{ media_id: string; status: string; words?: number; cached: boolean }> = [];
	const jobs: TranscriptJob[] = [];
	for (const mediaId of [...new Set(spoken.map(({ element }) => String(element.mediaId)))]) {
		try {
			const media = await resolveMediaFile(timelineId, mediaId, listed);
			const record = findTranscript(media.hash);
			if (record) {
				transcribed.push({ media_id: mediaId, status: "done", words: record.words.length, cached: true });
				continue;
			}
			const started = startTranscript(media, { model: DEFAULT_TRANSCRIBE_MODEL, language: null, force: false, relisten: true });
			if (started.record) transcribed.push({ media_id: mediaId, status: "done", words: started.record.words.length, cached: true });
			else if (started.job) {
				jobs.push(started.job);
				transcribed.push({ media_id: mediaId, status: started.job.status, cached: false });
			}
		} catch (error) {
			transcribed.push({ media_id: mediaId, status: `error: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`, cached: false });
		}
	}
	const deadline = Date.now() + TRANSCRIBE_WAIT_S * 1000;
	for (const job of jobs) {
		const left = deadline - Date.now();
		const after = left > 0 ? await waitForJob(job.id, left, input.signal) : job;
		const row = transcribed.find((entry) => entry.media_id === job.media_id);
		if (!row || !after) continue;
		row.status = after.status;
		if (after.status === "done") row.words = findTranscript(after.hash)?.words.length;
	}
	const running = transcribed.filter((entry) => entry.status === "running" || entry.status === "queued");
	if (running.length) {
		return {
			ok: false,
			code: "transcribing",
			message: `Still transcribing ${running.length} of ${transcribed.length} file(s) (one at a time on the GPU). Nothing was committed: send the same call again — finished transcripts are cached.`,
			details: { transcribed },
			next: { do: "Send the same sentence again (it waits up to 100 s more for the transcripts).", tool: "revise", arguments: { timeline_id: timelineId, sentence } },
		};
	}

	// 2. autocut every clip with a transcript, left to right (tails ripple)
	let snapshot = start;
	let ops: Op[] = [];
	const cuts: Array<Record<string, unknown>> = [];
	const skipped: Array<{ element_id: string; why: string }> = [];
	const byReason: Record<string, { count: number; seconds: number }> = {};
	let removed = 0;
	for (const { element } of spoken) {
		const cut = await cutClip(timelineId, snapshot, element.id, { silence: 0.35, pad: 0.06, keepRetakes: false }, `${timelineId}/${headId}/first-pass/${element.id}`, input.signal);
		if (!cut.ok) {
			skipped.push({ element_id: element.id, why: cut.message });
			continue;
		}
		snapshot = cut.snapshot;
		ops = [...ops, ...(cut.ops as Op[])];
		removed += Number(cut.report.removed_s ?? 0);
		for (const entry of cut.report.cuts) {
			const total = byReason[entry.reason] ?? { count: 0, seconds: 0 };
			total.count += 1;
			total.seconds = r3(total.seconds + entry.length_s);
			byReason[entry.reason] = total;
		}
		cuts.push({ element_id: element.id, removed_s: cut.report.removed_s, cuts: cut.report.cuts.map((entry) => `${entry.reason} ${entry.length_s} s${(entry as { words?: string }).words ? ` "${(entry as { words?: string }).words}"` : ""}`) });
	}

	// 3. transitions on set-up changes
	const fps = fpsOf(snapshot);
	const joins = await findSetupChanges(timelineId, snapshot, fps);
	const styleNow = activeEditingStyle(start);
	const styleJoin = styleNow ? EDITING_STYLE_PRESETS.find((preset) => preset.id === styleNow)?.join ?? null : null;
	const kind = ask.transition ?? styleJoin ?? "whip";
	const styleFrom = ask.transition ? "the sentence" : styleJoin ? `the active editing style (${styleNow})` : "the default (whip)";
	const added: Join[] = [];
	const transitionOps: Op[] = [];
	if (kind !== "none") {
		let flip = false;
		for (const join of joins.filter((entry) => entry.setup_change)) {
			const resolved = kind === "whip" ? (flip ? "whip-right" : "whip-left") : kind;
			flip = !flip;
			transitionOps.push({ op: "transition", author: "claude", a: join.a, b: join.b, kind: resolved, dur: JOIN_S } as Op);
			added.push(join);
		}
	}
	if (transitionOps.length) {
		const result = apply(snapshot as unknown as OpsProject, transitionOps, { seed: `${timelineId}/${headId}/first-pass/joins`, at: new Date().toISOString() });
		if (!result.ok) return { ok: false, code: "ops_conflict", message: "The reducer refused the transitions. Nothing was committed.", details: { conflicts: result.conflicts.slice(0, 10) } };
		snapshot = result.project as unknown as ProjectSnapshot;
		ops = [...ops, ...(result.changes.applied as Op[])];
	}

	// 4. captions: the asked style, else the timeline's, else the active editing style's, else word-pop
	const read = readCaptionDoc(start);
	const styleId = ask.captionStyle ?? read.styleId ?? (styleNow ? STYLE_CAPTIONS[styleNow] : null) ?? "word-pop";
	const captionFrom = ask.captionStyle ? "the sentence" : read.styleId ? "the captions already on the timeline" : styleNow ? `the active editing style (${styleNow})` : "the default (word-pop)";
	const style = getCaptionStyle(styleId);
	const words = await timelineCaptionWords(timelineId, spokenClips(snapshot), input.signal);
	let captions: Extract<FirstPassResult, { ok: true }>["captions"] = null;
	if (words.words.length || read.doc.length) {
		const existing = remapDoc(read.doc, start, snapshot);
		const overrides = ask.captionStyle ? { style: styleId } : undefined;
		const carried = carryTimelineFixes(words.words, existing);
		const fresh = rechunk({ words: carried.words, existing, overrides, style });
		const kept = chunksOutside(existing, words.ranges);
		const doc = mergeDocs(fresh, kept);
		const built = await buildCaptions({ snapshot, doc, style, seed: `${timelineId}/${headId}/first-pass/captions`, signal: input.signal, faces: { projectId: timelineId } });
		if (!built.result.ok) return { ok: false, code: "ops_conflict", message: "The reducer refused the captions. Nothing was committed.", details: { conflicts: built.result.conflicts.slice(0, 10) } };
		snapshot = built.snapshot;
		ops = [...ops, ...built.ops];
		captions = { style: styleId, style_from: captionFrom, chunks: built.build.chunks.length, placement: built.placement, outside_safe_area: built.outsideSafeArea.length, ...(built.outsideSafeArea.length ? { outside: built.outsideSafeArea.slice(0, 10) } : {}), ...(built.split_to_fit ? { split_to_fit: built.split_to_fit } : {}), media_without_transcript: words.missing };
	}

	// 5. the word guard (cut-aware: words of cut-out retakes are gone on purpose)
	const guard = guardSnapshots(start, snapshot, { cutAware: true });
	if (!guard.ok && !input.allowWordLoss) {
		return { ok: false, code: "words_lost", message: `Refused: the pass would remove ${guard.lost.length} caption word(s) that were not cut out with their footage. Nothing was committed.`, details: { words: guardView(guard) } };
	}
	const gapsMain = (() => {
		const main = [...(activeScene(snapshot)?.tracks?.main?.elements ?? [])].sort((a, b) => a.startTime - b.startTime);
		let n = 0;
		for (let i = 1; i < main.length; i++) if ((main[i] as SnapshotElement).startTime - ((main[i - 1] as SnapshotElement).startTime + (main[i - 1] as SnapshotElement).duration) > 1) n++;
		return n;
	})();
	const base = {
		ok: true as const,
		head: headId,
		message: sentence,
		ask,
		transcribed,
		autocut: { clips: cuts.length, removed_s: r3(removed), by_reason: byReason, gaps_on_track: gapsMain, cuts, skipped },
		transitions: { kind, dur_s: JOIN_S, added, jump_cuts: joins.filter((join) => !join.setup_change), style_from: styleFrom },
		captions,
		words: guard,
		spans: measureCaptionSpans(snapshot),
		duration_s: { before: runtimeOf(start), after: runtimeOf(snapshot) },
	};
	if (input.dryRun) return { ...base, dry_run: true, commit_id: null, version: null };
	if (input.signal?.aborted) return { ok: false, code: "stopped", message: "The call ran out of time before committing; nothing was committed (transcripts and measurements are cached: the same call again is faster)." };
	const pushed = await pushCommit(timelineId, { base_commit: headId, branch: head.branch, author: "claude", snapshot, ops, message: sentence }, input.actor);
	if (!pushed.ok) return { ok: false, code: "conflict", message: "The timeline moved while committing. Nothing was committed.", details: { head: pushed.conflict.head.id } };
	let version: string | null = null;
	try {
		version = (await recordMilestone(timelineId, pushed.commit.id, "first pass", headId, input.actor.name)).name;
	} catch {
		version = null;
	}
	return { ...base, dry_run: false, commit_id: pushed.commit.id, version };
}

// ─── the answer ─────────────────────────────────────────────────────────────────────────────────────────────────

const STYLE_IDS = ["word-pop", "bold-white", "serif-box", "mono-label", "huge-centred", "key-word"];

export function firstPassView(done: FirstPassResult, ctx: { timelineId: string; sentence: string; dryRun: boolean }): ToolOutput {
	const id = ctx.timelineId;
	if (!done.ok) {
		return {
			isError: done.code !== "transcribing",
			payload: {
				timeline_id: id,
				sentence: ctx.sentence,
				preset: { kind: "first_pass" },
				committed: false,
				...(done.code === "transcribing" ? { status: "transcribing" } : { error: { code: done.code, message: done.message } }),
				message: done.message,
				...(done.details ?? {}),
				next: done.next ?? { do: "Read the timeline summary.", tool: "timeline", arguments: { action: "summary", timeline_id: id } },
			},
		};
	}
	const added = done.transitions.added;
	const understood = done.ask.unknown.length === 0;
	const alter = [
		{ do: "Another caption style for every chunk (one commit).", tool: "captions", arguments: { timeline_id: id, style: STYLE_IDS.find((s) => s !== done.captions?.style) ?? "word-pop" }, styles: STYLE_IDS },
		...(added.length
			? [
					{ do: "Other transitions on the same set-up changes (one commit): dissolves here; any kind from timeline_ops reference transition.", tool: "timeline_ops", arguments: { timeline_id: id, message: "dissolves on the set-up changes", ops: added.map((join) => ({ op: "transition", a: join.a, b: join.b, kind: "dissolve", dur: 0.3 })) } },
					{ do: "Hard cuts instead (removes these transitions, one commit).", tool: "timeline_ops", arguments: { timeline_id: id, message: "hard cuts on the set-up changes", ops: added.map((join) => ({ op: "transition", a: join.a, b: join.b, kind: "cut" })) } },
				]
			: []),
		{ do: "Keep the retakes / a looser cut: undo the pass, then autocut {all, keep_retakes: true} (or silence: 0.6) and captions.", tool: "autocut", arguments: { timeline_id: id, all: true, keep_retakes: true, dry_run: true } },
	];
	return {
		payload: {
			...(done.commit_id ? { commit_id: done.commit_id } : {}),
			timeline_id: id,
			sentence: ctx.sentence,
			preset: { kind: "first_pass", does: "transcribe all (if needed) + autocut all + transitions on set-up changes + captions, in ONE commit" },
			understood,
			clauses: [
				{ clause: ctx.sentence, status: "applied", did: [`autocut ${done.autocut.clips} clips −${done.autocut.removed_s} s`, `${added.length} ${done.transitions.kind} transition(s) on set-up changes, ${done.transitions.jump_cuts.length} jump cut(s) left as cuts`, done.captions ? `${done.captions.chunks} ${done.captions.style} captions` : "no captions (no words)"] },
				...done.ask.unknown.map((part) => ({ clause: part, status: "not_understood", did: ["a first pass takes a caption style (\"with serif captions\") and a transition (\"with dissolves\", \"no transitions\"); this part was left out"] })),
			],
			...(done.ask.unknown.length ? { not_understood: done.ask.unknown.map((part) => ({ clause: part, why: "not a caption style or a transition", send: { tool: "revise", how: "Send it as its own sentence after the pass.", example_ops: [] } })) } : { not_understood: [] }),
			dry_run: done.dry_run,
			head: done.head,
			transcribed: done.transcribed,
			autocut: done.autocut,
			transitions: { kind: done.transitions.kind, from: done.transitions.style_from, dur_s: done.transitions.dur_s, setup_changes: added.map((join) => ({ at_s: join.at_s, a: join.a, b: join.b, why: join.why, ...(join.score !== undefined ? { score: join.score } : {}) })), jump_cuts: done.transitions.jump_cuts.map((join) => ({ at_s: join.at_s, why: join.why })) },
			captions: done.captions,
			words: guardView(done.words),
			caption_spans: spansView(done.spans),
			duration_s: done.duration_s,
			...(done.version ? { version: done.version } : {}),
			undo: { do: "Undo the whole pass (a new commit that restores the timeline as it was).", tool: "history", arguments: { timeline_id: id, action: "restore", commit: done.head } },
			alter,
			next: done.dry_run
				? { do: "Looks right: commit it (same call without dry_run).", tool: "revise", arguments: { timeline_id: id, sentence: ctx.sentence, base_commit: done.head } }
				: { do: "Look at it: render a preview, then look at frames around the set-up changes.", tool: "render", arguments: { timeline_id: id, commit: done.commit_id, quality: "preview" } },
		},
	};
}
