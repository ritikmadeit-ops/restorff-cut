/**
 * MCP tools `transcribe`, `autocut`, `captions` (mcp-cut agent, 2026-10-20; EDT-11, EDT-12; reel DeIGbZypIUb: a raw
 * talking head → transcribed → dead air and retakes cut → word captions). Until now these ran only in the browser
 * (Whisper in the editor, the CAPTIONS tab); here they run on the server and every edit is ONE commit as `claude`
 * that the editor pulls like any other.
 *
 *   transcribe  a media file of the timeline → word timings (TVF / faster-whisper large-v3, CUDA), cached per sha256,
 *               in the background: returns a job id, then the words (poll with job_id; wait_s waits for you).
 *               all: every clip's media (one job at a time). action edit: fix words ("Cloud" → "Claude"); the fix
 *               is kept beside the transcript and every caption rebuild uses it.
 *   autocut     a clip (or all: every clip, one commit) → timeline-ops cutFromTranscript on silence-clipped words →
 *               the cut list (silence · retake · false_start · head · tail, with times) → one commit; tails ripple
 *               (no gaps); retakes are matched ignoring case and punctuation; captions on the timeline are rebuilt
 *   captions    a clip or all of them → 1-5-word chunks in a caption style (word-pop · bold-white · serif-box ·
 *               mono-label · huge-centred · key-word), measured in headless Chromium with the real font, inside the
 *               caption safe area, clear of the face (zone auto) → one commit. size / case / keys / key_color / color
 *               / zone / words_per_chunk restyle every chunk, or with t0-t1 one span; the rest keep their look.
 *
 * captions-v2 (2026-10-20): sizes, key words, spans, ≤ 5 words, face-aware zones, transcript edits, autocut all /
 * transcribe all, ripple tails, punctuation-blind retakes. Server code: ../server/transcripts.ts (TVF jobs, cache,
 * silences, word fixes), transcripts-timeline.ts (clips → words, caption document with looks, build + tag),
 * transcripts-measure.ts (Chromium text measuring, one text box for builder and gate), transcripts-zones.ts (face-aware
 * zones). Runbook + example calls: docs/restorff/worklog/mcp-cut.md and captions-v2.md.
 */
import {
	apply,
	CAPTION_STYLE_PRESETS,
	cutFromTranscript,
	getCaptionStyle,
	MAX_CAPTION_WORDS,
	type CaptionCase,
	type CaptionDocChunk,
	type Project as OpsProject,
	type TimedWord,
} from "@restorffcut/timeline-ops";
import type { Actor } from "@/server/auth";
import { HttpError } from "@/server/http";
import { listProjectMedia, type MediaDto } from "@/server/media";
import { getProjectHead, pushCommit } from "@/server/projects";
import {
	applyTranscriptEdits,
	clipWordsToSilences,
	DEFAULT_TRANSCRIBE_MODEL,
	detectSilences,
	editKey,
	findTranscript,
	readEdits,
	resolveMediaFile,
	saveEdits,
	startTranscript,
	TRANSCRIBE_MODELS,
	waitForJob,
	withTranscriptEdits,
	type MediaFile,
	type TranscriptEdit,
	type TranscriptJob,
	type TranscriptRecord,
} from "@/server/transcripts";
import {
	applyOverrides,
	buildCaptions,
	CAPTION_ZONES,
	carryTimelineFixes,
	chunksOutside,
	clipWindow,
	findCaptionTracks,
	findElement,
	mergeDocs,
	rateOf,
	readCaptionDoc,
	rechunk,
	spokenClips,
	type BuiltCaptions,
	type CaptionZone,
	type LookOverrides,
} from "@/server/transcripts-timeline";
import { mediaIndex, rebuildCaptionsCore, rebuildFromDoc, silenceClippedWords, timelineCaptionWords, type LookChange } from "@/server/captions-rebuild";
import { guardSnapshots, guardView, measureCaptionSpans, spansView } from "@/server/caption-words";
import type { ProjectSnapshot, SnapshotElement } from "@/sync/snapshot";
import { fail, type JsonSchema, type Payload, type Tool, type ToolContext, type ToolOutput } from "./protocol";

const T = 120_000;
const r2 = (value: number) => Math.round(value * 100) / 100;
const r3 = (value: number) => Math.round(value * 1000) / 1000;
const STYLE_IDS = CAPTION_STYLE_PRESETS.map((preset) => preset.id);
const ZONES = ["auto", "style", ...Object.keys(CAPTION_ZONES)];

// ─── shared helpers ──────────────────────────────────────────────────────────────────────────────────────────

const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string, minimum?: number, maximum?: number): JsonSchema => ({
	type: "number",
	description,
	...(minimum !== undefined ? { minimum } : {}),
	...(maximum !== undefined ? { maximum } : {}),
});
const bool = (description: string): JsonSchema => ({ type: "boolean", description });

function need(args: Record<string, unknown>, key: string, why: string): string {
	const value = args[key];
	if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} is required ${why}`);
	return value.trim();
}

const opt = (args: Record<string, unknown>, key: string) => (typeof args[key] === "string" && (args[key] as string).trim() ? (args[key] as string).trim() : undefined);

function actorOf(ctx: ToolContext): Actor {
	const kind = ctx.auth?.kind === "service" ? "service" : "local-dev";
	return { kind, id: ctx.auth?.userId ?? kind, name: ctx.auth?.name ?? "Claude (MCP)" };
}

const summaryNext = (id: string, what = "Read the timeline summary (element ids, times).") => ({ do: what, tool: "timeline", arguments: { action: "summary", timeline_id: id } });
const renderNext = (id: string) => ({ do: "Render a preview (then render {render_id} until done), then look at a few frames (look {kind: render}).", tool: "render", arguments: { timeline_id: id, quality: "preview" } });

function withNext(out: ToolOutput, next: Payload): ToolOutput {
	if (out.payload) out.payload.next = next;
	return out;
}

const baseMatches = (given: string | undefined, head: string) => !given || given === head || (given.length >= 7 && head.startsWith(given));

function conflict(timelineId: string, head: string, given: string): ToolOutput {
	return withNext(fail("conflict", `The timeline moved on: its head is ${head}, not ${given}. Nothing was committed.`, { head }), summaryNext(timelineId, "Read the timeline again, then retry on its head (or omit base_commit)."));
}

async function loadHead(timelineId: string, branch?: string) {
	const head = await getProjectHead(timelineId, branch);
	if (!head.snapshot) throw new HttpError(409, "this timeline has no snapshot yet");
	return head as typeof head & { snapshot: ProjectSnapshot };
}

/** Commit a snapshot as Claude (the ops that made it are stored with it). */
async function commitSnapshot(ctx: ToolContext, timelineId: string, headId: string, branch: string, snapshot: ProjectSnapshot, ops: unknown[], message: string) {
	const pushed = await pushCommit(timelineId, { base_commit: headId, branch, author: "claude", snapshot, ops, message }, actorOf(ctx));
	if (!pushed.ok) return { ok: false as const, out: conflict(timelineId, pushed.conflict.head.id, headId) };
	return { ok: true as const, commit: pushed.commit };
}

const EDITOR_NOTE = "The editor pulls this commit within ~15 s (or on focus) and shows it as \"Claude: <message>\"; Ctrl+Z is not needed — the Versions panel restores the commit before.";

function noTranscript(timelineId: string, mediaId: string, elementId?: string): ToolOutput {
	return withNext(
		fail("no_transcript", `media ${mediaId} has no server transcript yet. Transcribe it first (one call starts it; a ~1-minute clip takes ~20-40 s).`),
		{ do: "Transcribe every clip, waiting for the words.", tool: "transcribe", arguments: { timeline_id: timelineId, ...(elementId ? { element_id: elementId } : { all: true }), wait_s: 120 } },
	);
}

/** Gaps between consecutive clips on a track (from its first clip to its last), after an edit. */
function gapsOn(snapshot: ProjectSnapshot, elementId: string): { count: number; seconds: number } {
	const found = findElement(snapshot, elementId);
	const elements = [...(found?.track.elements ?? [])].sort((a, b) => a.startTime - b.startTime);
	let count = 0;
	let ticks = 0;
	for (let i = 1; i < elements.length; i++) {
		const gap = elements[i].startTime - (elements[i - 1].startTime + elements[i - 1].duration);
		if (gap > 1) {
			count++;
			ticks += gap;
		}
	}
	return { count, seconds: r3(ticks / T) };
}

// ─── transcribe ──────────────────────────────────────────────────────────────────────────────────────────────

function jobView(job: TranscriptJob) {
	return {
		job_id: job.id,
		status: job.status,
		step: job.step,
		model: job.model,
		language: job.language,
		media_id: job.media_id,
		started_at: job.started_at,
		elapsed_s: r2(((job.finished_at ? Date.parse(job.finished_at) : Date.now()) - Date.parse(job.started_at)) / 1000),
		...(job.error ? { error: job.error } : {}),
	};
}

function wordsPayload(record: TranscriptRecord, maxWords: number) {
	const words = record.words.slice(0, maxWords).map((word) => [word.text, r3(word.start), r3(word.end)]);
	return {
		model: record.model,
		language: record.language,
		backend: record.backend,
		device: record.device,
		media_duration_s: r2(record.duration),
		word_count: record.words.length,
		transcribed_in_s: r2(record.ms / 1000),
		relisten: record.relisten
			? {
					stretches: record.relisten.stretches,
					replaced: record.relisten.replaced,
					added_words: record.relisten.added_words,
					seconds: r2(record.relisten.ms / 1000),
					...(record.relisten.error ? { error: record.relisten.error } : {}),
				}
			: "not run",
		...(record.edits?.length ? { word_fixes: record.edits.map((edit) => ({ from: edit.from, to: edit.to, matched_at_s: edit.matched })) } : {}),
		words_format: "[text, start_s, end_s] in seconds of the SOURCE media file (not the timeline); index = position in this list (for transcribe {action: \"edit\", fixes: [{index, to}]})",
		words,
		...(record.words.length > maxWords ? { truncated: true, note: `first ${maxWords} of ${record.words.length} words; ask with a larger max_words` } : {}),
		text: record.text.length > 20_000 ? `${record.text.slice(0, 20_000)}…` : record.text,
	};
}

/** Every clip with sound on the timeline, grouped by media file. */
function spokenMedia(snapshot: ProjectSnapshot): Map<string, string[]> {
	const byMedia = new Map<string, string[]>();
	for (const { element } of spokenClips(snapshot)) {
		const mediaId = element.mediaId as string;
		byMedia.set(mediaId, [...(byMedia.get(mediaId) ?? []), element.id]);
	}
	return byMedia;
}

async function transcribeAll(args: Record<string, unknown>, ctx: ToolContext, timelineId: string, snapshot: ProjectSnapshot): Promise<ToolOutput> {
	const model = opt(args, "model") ?? DEFAULT_TRANSCRIBE_MODEL;
	const language = opt(args, "language") ?? null;
	const waitS = typeof args.wait_s === "number" ? Math.min(150, Math.max(0, args.wait_s)) : 0;
	const listed = await mediaIndex(timelineId);
	const byMedia = spokenMedia(snapshot);
	if (!byMedia.size) return withNext(fail("no_clips", "No clip with sound on this timeline to transcribe."), summaryNext(timelineId));
	const rows: Array<{ media_id: string; element_ids: string[]; status: string; job_id?: string; words?: number; text?: string; error?: string; step?: string }> = [];
	const jobs: TranscriptJob[] = [];
	for (const [mediaId, elementIds] of byMedia) {
		try {
			const media = await resolveMediaFile(timelineId, mediaId, listed);
			const started = startTranscript(media, { model, language, force: args.force === true, relisten: args.relisten !== false });
			if (started.record) {
				const record = withTranscriptEdits(started.record);
				rows.push({ media_id: mediaId, element_ids: elementIds, status: "done", words: record.words.length, text: record.text.slice(0, 140) });
			} else if (started.job) {
				jobs.push(started.job);
				rows.push({ media_id: mediaId, element_ids: elementIds, status: started.job.status, job_id: started.job.id, step: started.job.step });
			}
		} catch (error) {
			rows.push({ media_id: mediaId, element_ids: elementIds, status: "error", error: (error as Error).message });
		}
	}
	// wait for the jobs (they run one at a time) until wait_s is used up
	const deadline = Date.now() + waitS * 1000;
	for (const job of jobs) {
		const left = deadline - Date.now();
		const after = left > 0 ? await waitForJob(job.id, left, ctx.signal) : job;
		const row = rows.find((candidate) => candidate.job_id === job.id);
		if (!row || !after) continue;
		row.status = after.status;
		row.step = after.step;
		if (after.status === "done") {
			const record = findTranscript(after.hash, { model: after.model, language: after.language });
			if (record) {
				row.words = record.words.length;
				row.text = record.text.slice(0, 140);
				delete row.step;
			}
		} else if (after.status !== "running") {
			row.error = after.error ?? after.step;
		}
	}
	const pending = rows.filter((row) => row.status === "running").length;
	const failed = rows.filter((row) => row.status !== "running" && row.status !== "done").length;
	const done = rows.length - pending - failed;
	return {
		payload: {
			all: true,
			media_files: rows.length,
			done,
			running: pending,
			failed,
			model,
			media: rows,
			note: "One transcription runs at a time (GPU); cached files come back at once. Words are in SOURCE seconds per media file — call transcribe {media_id} for one file's words.",
			next: pending
				? { do: "Still transcribing: ask again (waits up to wait_s).", tool: "transcribe", arguments: { timeline_id: timelineId, all: true, wait_s: 120 } }
				: { do: "Cut dead air and retakes from every clip (dry_run first shows the cut list).", tool: "autocut", arguments: { timeline_id: timelineId, all: true, dry_run: true } },
		},
	};
}

/** A fix as the tool takes it. */
interface FixArg {
	from?: string;
	to?: string;
	/** Timeline seconds (where it was seen in the captions). */
	t?: number;
	/** Source seconds (as transcribe returns words). */
	source_t?: number;
	/** Position in the transcript's word list (transcribe returns it in order). */
	index?: number;
}

async function transcribeEdit(args: Record<string, unknown>, ctx: ToolContext, timelineId: string, head: Awaited<ReturnType<typeof loadHead>>): Promise<ToolOutput> {
	const snapshot = head.snapshot;
	const listed = await mediaIndex(timelineId);
	// which media files: the one named, the clip's, else every clip's
	let mediaIds: string[];
	const elementId = opt(args, "element_id");
	const mediaArg = opt(args, "media_id");
	if (mediaArg) mediaIds = [mediaArg];
	else if (elementId) {
		const found = findElement(snapshot, elementId);
		if (!found?.element.mediaId) return withNext(fail("not_found", `No clip ${elementId} with a media file on this timeline.`), summaryNext(timelineId));
		mediaIds = [found.element.mediaId];
	} else mediaIds = [...spokenMedia(snapshot).keys()];
	const files: Array<{ mediaId: string; media: MediaFile; record: TranscriptRecord }> = [];
	for (const mediaId of mediaIds) {
		try {
			const media = await resolveMediaFile(timelineId, mediaId, listed);
			const record = findTranscript(media.hash);
			if (record) files.push({ mediaId, media, record });
		} catch {
			/* not on the server: skipped */
		}
	}
	if (!files.length) return noTranscript(timelineId, mediaIds[0] ?? "?", elementId);

	if (args.action === "edits" || args.reset === true) {
		if (args.reset === true) for (const file of files) saveEdits(file.media.hash, []);
		return {
			payload: {
				...(args.reset === true ? { reset: true } : {}),
				media: files.map((file) => ({ media_id: file.mediaId, fixes: args.reset === true ? [] : readEdits(file.media.hash) })),
				next: args.reset === true ? { do: "Rebuild the captions from the transcript as it was.", tool: "captions", arguments: { timeline_id: timelineId } } : summaryNext(timelineId),
			},
		};
	}

	const fixes = Array.isArray(args.fixes) ? (args.fixes as FixArg[]) : [];
	if (!fixes.length) return fail("invalid_arguments", "Pass fixes: [{from, to}] (optionally t = timeline seconds, or source_t), or [{index, to}] with media_id / element_id.");
	// resolve each fix per media file into a stored edit; check it matches something
	const planned = new Map<string, TranscriptEdit[]>();
	const results: Array<{ fix: FixArg; matched: Array<{ media_id: string; at_source_s: number[] }>; problem?: string }> = [];
	const now = new Date().toISOString();
	for (const fix of fixes) {
		const to = typeof fix.to === "string" ? fix.to : undefined;
		if (to === undefined) {
			results.push({ fix, matched: [], problem: "missing `to` (use \"\" to delete the words)" });
			continue;
		}
		const matched: Array<{ media_id: string; at_source_s: number[] }> = [];
		for (const file of files) {
			let from = typeof fix.from === "string" ? fix.from : undefined;
			let sourceT = typeof fix.source_t === "number" ? fix.source_t : undefined;
			if (typeof fix.index === "number") {
				if (files.length > 1) continue;
				const word = file.record.words[Math.floor(fix.index)];
				if (!word) continue;
				from = word.text;
				sourceT = word.start;
			}
			if (!from) continue;
			if (typeof fix.t === "number" && sourceT === undefined) {
				// timeline seconds → source seconds through the clips that play this media at that moment
				const clip = spokenClips(snapshot).find(({ element }) => element.mediaId === file.mediaId && fix.t !== undefined && element.startTime / T <= fix.t && fix.t < (element.startTime + element.duration) / T);
				if (!clip) continue;
				const w = clipWindow(clip.element);
				sourceT = w.in + (fix.t - w.start) * rateOf(clip.element);
			}
			const edit: TranscriptEdit = { from, to, ...(sourceT !== undefined ? { source_t: r3(sourceT) } : {}), created_at: now };
			const trial = applyTranscriptEdits(file.record.words, [edit]);
			const hits = trial.report[0]?.matched ?? [];
			if (!hits.length) continue;
			matched.push({ media_id: file.mediaId, at_source_s: hits });
			planned.set(file.mediaId, [...(planned.get(file.mediaId) ?? []), edit]);
		}
		results.push({ fix, matched, ...(matched.length ? {} : { problem: "matched no word" }) });
	}
	const missing = results.filter((result) => result.problem);
	if (missing.length) {
		// nothing is saved; show words that look close, with where they are
		const near = missing.map((result) => {
			const key = editKey(String(result.fix.from ?? "").split(/\s+/)[0] ?? "");
			const candidates = files.flatMap((file) =>
				file.record.words
					.map((word, index) => ({ word, index }))
					.filter(({ word }) => key && (editKey(word.text).startsWith(key.slice(0, 3)) || key.startsWith(editKey(word.text).slice(0, 3))))
					.slice(0, 8)
					.map(({ word, index }) => ({ media_id: file.mediaId, index, text: word.text, source_s: r3(word.start) })),
			);
			return { fix: result.fix, problem: result.problem, similar_words: candidates };
		});
		return withNext(fail("no_match", `${missing.length} of ${fixes.length} fixes matched no word; nothing was saved.`, { unmatched: near }), {
			do: "Read the words (with their index) and fix by index or exact text.",
			tool: "transcribe",
			arguments: { timeline_id: timelineId, ...(files.length === 1 ? { media_id: files[0].mediaId } : {}) },
		});
	}
	const previousEdits = new Map<string, ReturnType<typeof readEdits>>();
	for (const file of files) {
		const add = planned.get(file.mediaId);
		if (!add?.length) continue;
		previousEdits.set(file.media.hash, readEdits(file.media.hash));
		saveEdits(file.media.hash, [...readEdits(file.media.hash), ...add]);
	}
	const fixedReport = results.map((result) => ({ from: result.fix.from ?? `#${result.fix.index}`, to: result.fix.to, matched: result.matched }));

	// the captions on the timeline that come from these files are rebuilt from the fixed words (same looks): one commit
	const existing = readCaptionDoc(snapshot);
	if (args.rebuild_captions === false || !existing.doc.length) {
		return {
			payload: {
				saved: true,
				fixes: fixedReport,
				captions: existing.doc.length ? { rebuilt: false, why: "rebuild_captions: false" } : { rebuilt: false, why: "no captions on this timeline yet" },
				note: "Saved beside the transcript: every captions build, autocut and storyboard read the fixed words from now on (a forced re-transcription keeps them).",
				next: { do: "Caption the timeline (the fixed words are used).", tool: "captions", arguments: { timeline_id: timelineId } },
			},
		};
	}
	const built = await rebuildCaptions({ ctx, timelineId, snapshot, seed: `${timelineId}/${head.head.id}/transcript-fix` });
	if ("out" in built) return built.out;
	// revise-safety: the rebuild may change only the fixed words (a fix to "" removes words on purpose)
	const wordCheck = guardSnapshots(snapshot, built.built.snapshot, {
		fixes: fixes.filter((fix) => typeof fix.from === "string" && typeof fix.to === "string").map((fix) => ({ from: fix.from as string, to: fix.to as string, ...(typeof fix.t === "number" ? { t: fix.t } : {}) })),
		tolerance: 1,
	});
	if (!wordCheck.ok && args.allow_word_loss !== true) {
		for (const [hash, list] of previousEdits) saveEdits(hash, list);
		return withNext(fail("words_lost", `Refused: the caption rebuild would lose ${wordCheck.lost.length} word(s) besides the fixed ones (${wordCheck.lost.slice(0, 8).map((word) => `"${word.text}" @ ${word.t} s`).join(", ")}). Nothing was committed and the fix was not kept. Send allow_word_loss: true if that is meant, or rebuild_captions: false to keep the fix without rebuilding.`, { words: guardView(wordCheck) }), summaryNext(timelineId));
	}
	const message = opt(args, "message") ?? `transcript fix: ${fixedReport.map((fix) => `${fix.from} → ${fix.to || "(removed)"}`).join(", ")} · captions rebuilt`;
	const done = await commitSnapshot(ctx, timelineId, head.head.id, head.branch, built.built.snapshot, built.built.ops, message);
	if (!done.ok) return done.out;
	return {
		payload: {
			commit_id: done.commit.id,
			message: done.commit.message,
			saved: true,
			fixes: fixedReport,
			words: guardView(wordCheck),
			caption_spans: spansView(measureCaptionSpans(built.built.snapshot)),
			captions: { rebuilt: true, chunks: built.built.build.chunks.length, kept_looks: true, outside_safe_area: built.built.outsideSafeArea.length },
			editor: EDITOR_NOTE,
			next: renderNext(timelineId),
		},
	};
}

async function transcribe(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const maxWords = typeof args.max_words === "number" ? Math.max(1, Math.floor(args.max_words)) : 2000;
	const jobId = opt(args, "job_id");
	const timelineIdArg = opt(args, "timeline_id");
	const cutNext = (timelineId: string, elementId?: string) =>
		elementId
			? { do: "Cut dead air and retakes from the clip (dry_run first to see the cut list).", tool: "autocut", arguments: { timeline_id: timelineId, element_id: elementId, dry_run: true } }
			: { do: "Cut dead air and retakes from every clip (dry_run first to see the cut list).", tool: "autocut", arguments: { timeline_id: timelineId, all: true, dry_run: true } };

	if (jobId) {
		const waitS = typeof args.wait_s === "number" ? args.wait_s : 60;
		const job = await waitForJob(jobId, Math.min(150, Math.max(0, waitS)) * 1000, ctx.signal);
		if (!job) return fail("unknown_job", `No transcription job ${jobId}.`);
		const timelineId = timelineIdArg ?? job.project_id;
		if (job.status === "running") {
			return { payload: { ...jobView(job), next: { do: "Still transcribing: ask again (this waits up to wait_s for it).", tool: "transcribe", arguments: { timeline_id: timelineId, job_id: job.id, wait_s: 90 } } } };
		}
		if (job.status !== "done") {
			return withNext(fail("transcription_failed", job.error ?? job.step, jobView(job)), { do: "Start it again (force: true re-runs).", tool: "transcribe", arguments: { timeline_id: timelineId, media_id: job.media_id, force: true } });
		}
		const record = findTranscript(job.hash, { model: job.model, language: job.language });
		if (!record) return fail("tool_failed", "The job finished but its transcript file is missing (internal).", jobView(job));
		return { payload: { ...jobView(job), cached: false, ...wordsPayload(record, maxWords), next: cutNext(timelineId, opt(args, "element_id")) } };
	}

	const timelineId = need(args, "timeline_id", "(or job_id to poll a job)");
	const head = await loadHead(timelineId, opt(args, "branch"));
	if (args.action === "edit" || args.action === "edits") return transcribeEdit(args, ctx, timelineId, head);
	if (args.all === true) return transcribeAll(args, ctx, timelineId, head.snapshot);
	let mediaId = opt(args, "media_id");
	const elementId = opt(args, "element_id");
	if (!mediaId && elementId) {
		const found = findElement(head.snapshot, elementId);
		if (!found) return withNext(fail("not_found", `No element ${elementId} on this timeline.`), summaryNext(timelineId));
		if (!found.element.mediaId) return withNext(fail("no_media", `Element ${elementId} (${found.element.type}) plays no media file.`), summaryNext(timelineId));
		mediaId = found.element.mediaId;
	}
	if (!mediaId) return withNext(fail("invalid_arguments", "Pass media_id or element_id (the clip whose speech to transcribe), or all: true for every clip."), summaryNext(timelineId));
	const model = opt(args, "model") ?? DEFAULT_TRANSCRIBE_MODEL;
	const language = opt(args, "language") ?? null;
	const media = await resolveMediaFile(timelineId, mediaId);
	const started = startTranscript(media, { model, language, force: args.force === true, relisten: args.relisten !== false });
	if (started.record) {
		return { payload: { status: "done", cached: true, media_id: mediaId, ...wordsPayload(withTranscriptEdits(started.record), maxWords), next: cutNext(timelineId, elementId) } };
	}
	const job = started.job as TranscriptJob;
	const waitS = typeof args.wait_s === "number" ? Math.min(150, Math.max(0, args.wait_s)) : 0;
	const after = waitS > 0 ? await waitForJob(job.id, waitS * 1000, ctx.signal) : job;
	if (after && after.status === "done") {
		const record = findTranscript(after.hash, { model: after.model, language: after.language });
		if (record) return { payload: { ...jobView(after), cached: false, ...wordsPayload(record, maxWords), next: cutNext(timelineId, elementId) } };
	}
	if (after && after.status !== "running") {
		return withNext(fail("transcription_failed", after.error ?? after.step, jobView(after)), { do: "Check RESTORFF_PY / RESTORFF_TVF_DIR on the server (python -m tvf doctor), then force a re-run.", tool: "transcribe", arguments: { timeline_id: timelineId, media_id: mediaId, force: true } });
	}
	return {
		payload: {
			...jobView(after ?? job),
			joined: started.joined === true,
			note: "Transcribing in the background (TVF → faster-whisper with word timestamps). The words come back from the poll below.",
			next: { do: "Collect the words (waits up to wait_s seconds).", tool: "transcribe", arguments: { timeline_id: timelineId, job_id: job.id, wait_s: 90, ...(elementId ? { element_id: elementId } : {}) } },
		},
	};
}

export const TRANSCRIBE_TOOL: Tool = {
	name: "transcribe",
	title: "Transcribe speech (word timings) · fix words",
	description:
		"Word-timed transcript of a clip's media file, made on the server with faster-whisper (TVF; large-v3 on the GPU by default), cached per file. Starts a background job and returns its job_id; call again with job_id (wait_s waits up to that many seconds) to get the words as [text, start_s, end_s] in SOURCE seconds. all: true = every clip with sound on the timeline (one job at a time; poll with the same call). A file transcribed before comes back at once. action \"edit\" fixes words for good: fixes [{from: \"Cloud\", to: \"Claude\"}] (every match; t = timeline seconds or source_t limits it to one), or [{index, to}] with media_id; to \"\" deletes; the fix is stored beside the transcript, so captions, autocut and every later rebuild use it — and the captions already on the timeline are rebuilt with it in ONE commit (their looks kept). action \"edits\" lists the fixes; reset: true clears them. Then autocut and captions.",
	inputSchema: {
		type: "object",
		properties: {
			timeline_id: str("The timeline (project id). Required unless polling with job_id."),
			action: { type: "string", enum: ["transcribe", "edit", "edits"], description: "transcribe (default) · edit = fix words (fixes) · edits = list the fixes." },
			element_id: str("The clip whose media to transcribe / fix (from timeline summary)."),
			media_id: str("Or the media id directly (from timeline summary / media list)."),
			all: bool("Transcribe every clip with sound on the timeline (each media file once)."),
			fixes: {
				type: "array",
				description: "action edit: [{from, to, t?, source_t?}] or [{index, to}]. from/to are words (several allowed: \"hyper frames\" → \"HyperFrames\"); matching ignores case and punctuation and keeps the word's punctuation; t = timeline seconds (one occurrence near it); source_t = source seconds; index = position in transcribe's word list (needs media_id or element_id).",
				items: { type: "object" },
			},
			reset: bool("action edit/edits: remove every fix of the media file(s)."),
			rebuild_captions: bool("action edit: rebuild the captions on the timeline with the fix (default true; one commit)."),
			allow_word_loss: bool("action edit: commit even if the rebuild loses caption words besides the fixed ones (default: refused from 2, and the fix is not kept)."),
			language: str("ISO code like en (default: detect)."),
			model: { type: "string", enum: [...TRANSCRIBE_MODELS], description: `faster-whisper model with weights on this server (default ${DEFAULT_TRANSCRIBE_MODEL}).` },
			force: bool("Re-transcribe even if a cached transcript exists (word fixes are kept)."),
			relisten: bool("Second pass (default true): each stretch between pauses is transcribed again on its own, so a restarted phrase Whisper merged into one comes back and autocut can drop the false start. false = Whisper's single pass only."),
			job_id: str("Poll a job started earlier."),
			wait_s: num("Wait up to this long for the words before answering (0-150; default 0 when starting, 60 when polling).", 0, 150),
			max_words: num("Most words to return (default 2000).", 1),
			message: str("action edit: commit message (default: transcript fix: from → to · captions rebuilt)."),
			branch: str("Branch (default: the project's default branch)."),
		},
		required: [],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	budgetSeconds: 180,
	run: transcribe,
};

// ─── autocut ─────────────────────────────────────────────────────────────────────────────────────────────────

const normalizeText = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();

type CutReason = "silence" | "retake" | "false_start" | "head" | "tail";

/** Rebuild the timeline's captions from the transcripts, keeping every chunk's look (after a cut or a word fix). */
async function rebuildCaptions({
	ctx,
	timelineId,
	snapshot,
	before,
	seed,
}: {
	ctx: ToolContext;
	timelineId: string;
	snapshot: ProjectSnapshot;
	/** The timeline before a cut (the caption document is read there and moved through the cut). */
	before?: ProjectSnapshot;
	seed: string;
}): Promise<{ built: BuiltCaptions; kept: number; carried: number } | { out: ToolOutput }> {
	const done = await rebuildCaptionsCore({ timelineId, snapshot, before, seed, signal: ctx.signal });
	if (!done.ok) {
		return { out: withNext(fail("ops_conflict", "The caption rebuild was refused by the reducer. Nothing was committed.", { conflicts: done.conflicts }), summaryNext(timelineId)) };
	}
	return { built: done.built, kept: done.kept, carried: done.carried };
}

interface ClipCut {
	ok: true;
	snapshot: ProjectSnapshot;
	ops: unknown[];
	report: Record<string, unknown> & { removed_s: number; clip_out_s: number; cuts: Array<{ reason: CutReason; length_s: number }> };
	pieces: Array<{ id: string; t: number; dur: number }>;
	snap: string;
}

/** Plan and apply the cut of one clip on `snapshot` (no commit). Used by autocut and revise "take a pass". */
export async function cutClip(
	timelineId: string,
	snapshot: ProjectSnapshot,
	elementId: string,
	settings: { silence: number; pad: number; keepRetakes: boolean },
	seed: string,
	signal?: AbortSignal,
): Promise<ClipCut | { ok: false; code: string; message: string; mediaId?: string; extra?: Record<string, unknown> }> {
	const found = findElement(snapshot, elementId);
	if (!found) return { ok: false, code: "not_found", message: `No element ${elementId} on this timeline.` };
	const element = found.element;
	if ((element.type !== "video" && element.type !== "audio") || !element.mediaId) {
		return { ok: false, code: "not_a_clip", message: `Element ${elementId} is a ${element.type}; autocut works on a video or audio clip with speech.` };
	}
	if (rateOf(element) !== 1) return { ok: false, code: "retimed", message: "This clip is sped up or slowed down; autocut works on 1× clips (as in the editor)." };
	const media = await resolveMediaFile(timelineId, element.mediaId);
	const record = findTranscript(media.hash);
	if (!record) return { ok: false, code: "no_transcript", message: `media ${element.mediaId} has no server transcript yet.`, mediaId: element.mediaId };

	const clipped = await silenceClippedWords(media, record, settings.silence, signal);
	const w = clipWindow(element);
	const cutOptions = {
		clip: { el: element.id, start: w.start, in: w.in, out: w.out },
		silence: settings.silence,
		pad: settings.pad,
		retakeWindow: settings.keepRetakes ? 0 : 3,
		captions: false as const,
		author: "claude" as const,
		refPrefix: `ac${elementId.slice(0, 6)}`,
		// captions-v2: the tail ripples (no gap before the next clip); retakes are matched on the words, punctuation-blind
		rippleTail: true,
		repeats: true,
	};
	// regions shorter than one frame (a 6 ms "head" before a word that starts on the clip's first frame) are not
	// worth a split: they stay (cutFromTranscript `keep` = the editor's unticked regions)
	const fps = snapshot.settings?.fps;
	const frame = 1 / (typeof fps === "number" ? fps : fps ? fps.numerator / fps.denominator : 30);
	const draft = cutFromTranscript(clipped.words, cutOptions);
	const tiny = draft.candidates.filter((region) => region.end - region.start < frame).map((region) => region.index);
	const plan = tiny.length ? cutFromTranscript(clipped.words, { ...cutOptions, keep: tiny }) : draft;

	// the cut list, with false starts told apart from full retakes
	const retakeKinds = plan.retakes.map((retake) => ({ ...retake, kind: normalizeText(retake.dropped) === normalizeText(retake.keptAs) ? "retake" : "false_start" }));
	const at = (source: number) => w.start + (source - w.in);
	const cuts = plan.removed.map((region) => {
		let reason: CutReason = region.reason;
		let keptAs: string | undefined;
		if (region.reason === "retake") {
			const detail = normalizeText(region.detail ?? "");
			const matches = retakeKinds.filter((retake) => detail.includes(normalizeText(retake.dropped)) || normalizeText(retake.dropped).includes(detail));
			reason = matches.length && matches.every((retake) => retake.kind === "retake") ? "retake" : "false_start";
			keptAs = matches[matches.length - 1]?.keptAs;
		}
		return {
			reason,
			source_s: [r3(region.start), r3(region.end)],
			timeline_s: [r3(at(region.start)), r3(at(region.end))],
			length_s: r3(region.end - region.start),
			...(region.detail ? { words: region.detail } : {}),
			...(keptAs ? { kept_take: keptAs } : {}),
		};
	});
	const byReason: Record<string, { count: number; seconds: number }> = {};
	for (const cut of cuts) {
		const entry = byReason[cut.reason] ?? { count: 0, seconds: 0 };
		entry.count += 1;
		entry.seconds = r3(entry.seconds + cut.length_s);
		byReason[cut.reason] = entry;
	}
	const inS = r3(w.end - w.start);
	const report = {
		element_id: elementId,
		media_id: element.mediaId,
		transcript: { model: record.model, words: record.words.length, words_clipped_to_silence: clipped.clipped, silences_found: clipped.silences, ...(record.edits?.length ? { word_fixes: record.edits.length } : {}) },
		...(tiny.length ? { left_in_under_one_frame: tiny.length } : {}),
		clip_in_s: inS,
		clip_out_s: r3(plan.stats.keptSeconds),
		removed_s: r3(inS - plan.stats.keptSeconds),
		cuts,
		by_reason: byReason,
		retakes: retakeKinds.map((retake) => ({ kind: retake.kind, dropped: retake.dropped, kept: retake.keptAs })),
	};
	if (!plan.ops.length) return { ok: true, snapshot, ops: [], report, pieces: [{ id: elementId, t: r3(element.startTime / T), dur: r3(element.duration / T) }], snap: "none" };

	let result = apply(snapshot as unknown as OpsProject, plan.ops, { seed, snap: "frame", at: new Date().toISOString() });
	let snap = "frame";
	if (!result.ok) {
		// frame snapping can make two neighbouring cuts collide on very short stretches (pipeline autocut.ts)
		result = apply(snapshot as unknown as OpsProject, plan.ops, { seed, at: new Date().toISOString() });
		snap = "none";
	}
	if (!result.ok) return { ok: false, code: "ops_conflict", message: "The reducer refused the cut.", extra: { conflicts: result.conflicts.slice(0, 10) } };
	const next = result.project as unknown as ProjectSnapshot;
	// pieces of the clip after the cut (the left-most keeps the id)
	const pieceIds = new Set<string>([elementId, ...Object.values(result.changes.refs)]);
	const after = findElement(next, elementId);
	const pieces = (after?.track.elements ?? []).filter((candidate) => pieceIds.has(candidate.id)).map((piece) => ({ id: piece.id, t: r3(piece.startTime / T), dur: r3(piece.duration / T) }));
	if (pieces.length) {
		// what the timeline really holds after frame snapping (the plan's own number is before snapping)
		report.clip_out_s = r3(pieces.reduce((sum, piece) => sum + piece.dur, 0));
		report.removed_s = r3(inS - report.clip_out_s);
	}
	return { ok: true, snapshot: next, ops: [...result.changes.applied], report, pieces, snap };
}

async function autocut(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "");
	const all = args.all === true;
	const elementIdArg = opt(args, "element_id");
	if (!all && !elementIdArg) return withNext(fail("invalid_arguments", "Pass element_id (the talking-head clip, from timeline summary) or all: true (every clip with a transcript, one commit)."), summaryNext(timelineId));
	const settings = {
		silence: typeof args.silence === "number" ? args.silence : 0.35,
		pad: typeof args.pad === "number" ? args.pad : 0.06,
		keepRetakes: args.keep_retakes === true,
	};
	const dryRun = args.dry_run === true;
	const head = await loadHead(timelineId, opt(args, "branch"));
	const base = opt(args, "base_commit");
	if (!baseMatches(base, head.head.id)) return conflict(timelineId, head.head.id, base ?? "");
	const started = Date.now();

	// which clips: the one named, or every video clip with sound (each with its own transcript), left to right — not
	// uploaded audio (music beds, voice-over takes have their own tools)
	const targets = all ? spokenClips(head.snapshot).filter(({ element }) => element.type === "video").map(({ element }) => element.id) : [elementIdArg as string];
	let snapshot = head.snapshot;
	let ops: unknown[] = [];
	const reports: Array<Record<string, unknown>> = [];
	const skipped: Array<{ element_id: string; why: string }> = [];
	const seed = `${timelineId}/${head.head.id}/autocut`;
	let snapUsed = "frame";
	let lastPieces: Array<{ id: string; t: number; dur: number }> = [];
	for (const elementId of targets) {
		const cut = await cutClip(timelineId, snapshot, elementId, settings, `${seed}/${elementId}`, ctx.signal);
		if (!cut.ok) {
			if (!all) {
				if (cut.code === "no_transcript") return noTranscript(timelineId, cut.mediaId ?? "?", elementId);
				return withNext(fail(cut.code, cut.message, cut.extra ?? {}), summaryNext(timelineId));
			}
			skipped.push({ element_id: elementId, why: cut.message });
			continue;
		}
		snapshot = cut.snapshot;
		ops = [...ops, ...cut.ops];
		if (cut.snap === "none" && cut.ops.length) snapUsed = "none";
		reports.push({ ...cut.report, pieces_after: cut.pieces });
		lastPieces = cut.pieces;
	}
	if (all && !reports.length) {
		return withNext(fail("no_transcript", "No clip on this timeline has a transcript yet.", { skipped }), { do: "Transcribe every clip first.", tool: "transcribe", arguments: { timeline_id: timelineId, all: true, wait_s: 120 } });
	}
	const removed = r3(reports.reduce((sum, report) => sum + Number(report.removed_s ?? 0), 0));
	const byReason: Record<string, { count: number; seconds: number }> = {};
	for (const report of reports) {
		for (const [reason, entry] of Object.entries((report.by_reason ?? {}) as Record<string, { count: number; seconds: number }>)) {
			const total = byReason[reason] ?? { count: 0, seconds: 0 };
			total.count += entry.count;
			total.seconds = r3(total.seconds + entry.seconds);
			byReason[reason] = total;
		}
	}
	const firstId = targets.find((id) => findElement(snapshot, id)) ?? targets[0];
	const gaps = gapsOn(snapshot, firstId);
	const summary = all
		? { all: true, clips: reports.length, removed_s: removed, by_reason: byReason, gaps_on_track: gaps, clips_cut: reports, ...(skipped.length ? { skipped } : {}) }
		: { ...reports[0], gaps_on_track: gaps };

	if (!ops.length) {
		return { payload: { ...summary, committed: false, message: "Nothing to cut with these settings.", next: { do: "Caption the timeline.", tool: "captions", arguments: { timeline_id: timelineId, style: "word-pop", dry_run: true } } } };
	}
	const existing = readCaptionDoc(head.snapshot);
	if (dryRun) {
		return {
			payload: {
				dry_run: true,
				...summary,
				...(all ? {} : { pieces_after: lastPieces }),
				captions_would_rebuild: existing.doc.length > 0,
				ms: Date.now() - started,
				next: { do: "Looks right: commit it (same call without dry_run). keep_retakes: true keeps the earlier takes.", tool: "autocut", arguments: { timeline_id: timelineId, ...(all ? { all: true } : { element_id: elementIdArg }), base_commit: head.head.id } },
			},
		};
	}

	// captions already on the timeline are rebuilt from the new cut, each chunk keeping its look
	let captions: Payload | null = null;
	if (existing.doc.length) {
		const rebuilt = await rebuildCaptions({ ctx, timelineId, snapshot, before: head.snapshot, seed: `${seed}/captions` });
		if ("out" in rebuilt) {
			captions = { rebuilt: false, why: "the caption rebuild was refused by the reducer; the cut is committed without it" };
		} else {
			snapshot = rebuilt.built.snapshot;
			ops = [...ops, ...rebuilt.built.ops];
			captions = { rebuilt: true, chunks: rebuilt.built.build.chunks.length, kept_from_before: rebuilt.kept, kept_looks: true, measure: rebuilt.built.measure.method, outside_safe_area: rebuilt.built.outsideSafeArea.length };
		}
	}
	// revise-safety: caption words of the cut-out footage go with it; any other lost word refuses the cut
	const wordCheck = guardSnapshots(head.snapshot, snapshot, { cutAware: true, tolerance: 1 });
	if (!wordCheck.ok && args.allow_word_loss !== true) {
		return withNext(fail("words_lost", `Refused: the cut would lose ${wordCheck.lost.length} caption word(s) whose footage stays (${wordCheck.lost.slice(0, 8).map((word) => `"${word.text}" @ ${word.t} s`).join(", ")}). Nothing was committed. Send allow_word_loss: true if that is meant.`, { words: guardView(wordCheck) }), summaryNext(timelineId));
	}
	if (captions) captions = { ...captions, words: guardView(wordCheck), caption_spans: spansView(measureCaptionSpans(snapshot)) };

	const counts = Object.entries(byReason)
		.map(([reason, entry]) => `${entry.count} ${reason.replace("_", " ")}`)
		.join(", ");
	const message = opt(args, "message") ?? `autocut${all ? ` ${reports.length} clips` : ""}: -${r2(removed)} s (${counts})${captions?.rebuilt ? " · captions rebuilt" : ""}`;
	const done = await commitSnapshot(ctx, timelineId, head.head.id, head.branch, snapshot, ops, message);
	if (!done.ok) return done.out;
	return {
		payload: {
			commit_id: done.commit.id,
			message: done.commit.message,
			...summary,
			snap: snapUsed,
			...(all ? {} : { pieces_after: lastPieces }),
			timeline_duration_s: done.commit.stats?.duration_s ?? null,
			captions: captions ?? { rebuilt: false, why: "the timeline had no captions; add them with the captions tool" },
			ms: Date.now() - started,
			editor: EDITOR_NOTE,
			next: captions?.rebuilt ? renderNext(timelineId) : { do: "Caption the cut timeline (dry_run first).", tool: "captions", arguments: { timeline_id: timelineId, style: "word-pop", dry_run: true } },
		},
	};
}

export const AUTOCUT_TOOL: Tool = {
	name: "autocut",
	title: "Cut dead air and retakes",
	description:
		"Cuts a talking-head clip (element_id) or every clip (all: true — one commit) from its transcript (call transcribe first): pauses longer than `silence` (words are first clipped to the audio's measured silences, so a pause Whisper hid inside a word is found), the earlier take of a repeated sentence (retake — matched on the words, ignoring case and punctuation, so two takes Whisper punctuated differently are still found), an aborted start that the next sentence restarts (false_start), and dead air before the first / after the last word (head, tail). Every cut ripples: the clips after it close up, no gaps (gaps_on_track says so). Returns the cut list with source and timeline times and commits it as ONE commit (author claude); captions already on the timeline are rebuilt in the same commit, keeping their looks and word fixes. dry_run: true returns the list only. keep_retakes: true cuts silences only.",
	inputSchema: {
		type: "object",
		properties: {
			timeline_id: str("The timeline."),
			element_id: str("The clip to cut (from timeline summary)."),
			all: bool("Cut every clip with sound that has a transcript, left to right, as one commit."),
			silence: num("Cut pauses longer than this, seconds (default 0.35).", 0.1, 5),
			pad: num("Breathing room kept around words, seconds (default 0.06).", 0, 1),
			keep_retakes: bool("Keep repeated / restarted sentences (cut silences only). Default false."),
			allow_word_loss: bool("Commit even if caption words whose footage stays would be lost (default: refused from 2; words of cut-out footage always go with it)."),
			dry_run: bool("Return the cut list without committing."),
			base_commit: str("Optional: the head you read; if the timeline moved on nothing is done."),
			message: str("Commit message (default: autocut: -N s (counts by reason))."),
			branch: str("Branch (default: the project's default branch)."),
		},
		required: ["timeline_id"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
	budgetSeconds: 120,
	run: autocut,
};

// ─── captions ────────────────────────────────────────────────────────────────────────────────────────────────

const SIZE_WORDS: Record<string, number> = { bigger: 1.35, larger: 1.35, "much bigger": 1.6, huge: 1.8, smaller: 0.75, "much smaller": 0.6, "a bit bigger": 1.15, "a bit smaller": 0.88 };

/**
 * `size`: a number = editor units (1 unit = 1/90 of the canvas height: on 1080×1920, 5 → 107 px tall letters; whole
 * units are stored); "1.35x" / "135%" = relative to each chunk's current size; "110px" = pixels of the canvas;
 * "bigger" / "smaller" (1.35× / 0.75×).
 */
export function parseCaptionSize(value: unknown, canvasHeight: number): LookOverrides["size"] | { error: string } | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "number") {
		if (!(value >= 1 && value <= 40)) return { error: "size as a number is editor units, 1-40 (5 ≈ 107 px letters on 1080×1920); for relative use \"1.35x\"" };
		return { absolute: value };
	}
	if (typeof value !== "string") return { error: "size must be a number (editor units) or a string like \"1.35x\", \"135%\", \"110px\"" };
	const text = value.trim().toLowerCase();
	if (SIZE_WORDS[text]) return { relative: SIZE_WORDS[text] };
	const rel = /^(\d+(?:\.\d+)?)\s*(x|×)$/.exec(text);
	if (rel) return { relative: Number(rel[1]) };
	const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(text);
	if (pct) return { relative: Number(pct[1]) / 100 };
	const px = /^(\d+(?:\.\d+)?)\s*px$/.exec(text);
	if (px) return { absolute: (Number(px[1]) * 90) / canvasHeight };
	const plain = /^(\d+(?:\.\d+)?)$/.exec(text);
	if (plain) return parseCaptionSize(Number(plain[1]), canvasHeight);
	return { error: `size "${value}" not understood: use a number (editor units), "1.35x", "135%", "110px", "bigger" or "smaller"` };
}

function chunkView(built: BuiltCaptions, limit: number) {
	return built.build.chunks.slice(0, limit).map((chunk) => {
		const source = built.doc[chunk.index];
		return {
			t: r3(source?.start ?? 0),
			end: r3(source?.end ?? 0),
			text: chunk.text,
			style: chunk.style,
			size: chunk.size,
			x: chunk.x,
			y: chunk.y,
			...(chunk.keys?.length ? { keys: chunk.keys, key_size: chunk.keySize } : {}),
			...(chunk.shrunk ? { shrunk: true } : {}),
		};
	});
}

/** captions {action: "measure"}: sizes and fonts by span (revise-safety). */
async function captionsMeasure(timelineId: string, branch?: string): Promise<ToolOutput> {
	const head = await loadHead(timelineId, branch);
	const report = measureCaptionSpans(head.snapshot);
	return {
		payload: {
			timeline_id: timelineId,
			head: head.head.id,
			...report,
			size_units: "editor units: letters are size × canvas height / 90 px tall (on 1080×1920, 5 → 107 px)",
			span_rule: "a span = consecutive caption chunks in one font and one caption style; inside a span every chunk should have one size (key-word styles bump key words on the word layer, not here)",
			next: report.mixed_spans
				? { do: `${report.mixed_spans} span(s) mix sizes: give each its most common size (one commit; pass size to choose).`, tool: "captions", arguments: { timeline_id: timelineId, action: "unify", dry_run: true } }
				: report.chunks
					? { do: "One size per span: nothing to unify.", tool: "storyboard", arguments: { action: "get", timeline_id: timelineId } }
					: { do: "No captions yet: caption the timeline.", tool: "captions", arguments: { timeline_id: timelineId, dry_run: true } },
		},
	};
}

/** captions {action: "unify"}: every mixed span gets one size (its most common, or `size`), rebuilt; one commit (revise-safety). */
async function captionsUnify(args: Record<string, unknown>, ctx: ToolContext, timelineId: string): Promise<ToolOutput> {
	const head = await loadHead(timelineId, opt(args, "branch"));
	const base = opt(args, "base_commit");
	if (!baseMatches(base, head.head.id)) return conflict(timelineId, head.head.id, base ?? "");
	const before = measureCaptionSpans(head.snapshot);
	const forced = typeof args.size === "number" && args.size >= 1 && args.size <= 40 ? Math.round(args.size) : null;
	const targets = before.spans.filter((span) => span.mixed || (forced !== null && span.size !== forced));
	if (!targets.length) {
		return { payload: { timeline_id: timelineId, committed: false, message: "Every span already has one size.", caption_spans: spansView(before), next: { do: "Nothing to unify.", tool: "storyboard", arguments: { action: "get", timeline_id: timelineId } } } };
	}
	const looks: LookChange[] = targets.map((span) => ({ overrides: { size: { absolute: forced ?? span.size } }, span: { t0: span.from - 0.001, t1: span.to + 0.001 } }));
	let snapshot: ProjectSnapshot;
	let ops: unknown[];
	let how: string;
	if (readCaptionDoc(head.snapshot).styleId) {
		const remade = await rebuildFromDoc({ timelineId, snapshot: head.snapshot, seed: `${timelineId}/${head.head.id}/captions/unify`, signal: ctx.signal, look: looks });
		if (!remade.ok) return withNext(fail("ops_conflict", "The reducer refused the rebuild. Nothing was committed.", { conflicts: remade.conflicts }), summaryNext(timelineId));
		snapshot = remade.built.snapshot;
		ops = remade.built.ops;
		how = "rebuilt from the chunks there (same words), each span's size written into every chunk's look";
	} else {
		// captions not built by the captions tool: a set on each odd chunk (nothing else changes)
		const set: Array<Record<string, unknown>> = [];
		const baseTrack = findCaptionTracks(head.snapshot).find((track) => /^CAPTIONS?( \d+)?$/i.test(String(track.name ?? ""))) ?? findCaptionTracks(head.snapshot)[0];
		for (const span of targets) {
			for (const element of baseTrack?.elements ?? []) {
				const t = element.startTime / T;
				if (t < span.from - 0.001 || t >= span.to) continue;
				if (Number((element.params as Record<string, unknown>)?.fontSize) !== (forced ?? span.size)) set.push({ op: "set", author: "claude", el: element.id, prop: "fontSize", value: forced ?? span.size });
			}
		}
		const result = apply(head.snapshot as unknown as OpsProject, set as never, { seed: `${timelineId}/${head.head.id}/captions/unify`, at: new Date().toISOString() });
		if (!result.ok) return withNext(fail("ops_conflict", "The reducer refused the sizes. Nothing was committed.", { conflicts: result.conflicts.slice(0, 10) }), summaryNext(timelineId));
		snapshot = result.project as unknown as ProjectSnapshot;
		ops = result.changes.applied;
		how = "a fontSize set on each chunk off its span's size";
	}
	const after = measureCaptionSpans(snapshot);
	const words = guardSnapshots(head.snapshot, snapshot);
	if (!words.ok && args.allow_word_loss !== true) return withNext(fail("words_lost", `Refused: the rebuild would lose ${words.lost.length} caption word(s). Nothing was committed.`, { words: guardView(words) }), summaryNext(timelineId));
	const report = { before: spansView(before), after: spansView(after), unified: targets.map((span) => ({ from: span.from, to: span.to, font: span.font, sizes: span.sizes, to_size: forced ?? span.size })), how, words: guardView(words) };
	if (args.dry_run === true) {
		return { payload: { dry_run: true, timeline_id: timelineId, ...report, next: { do: "Commit it (same call without dry_run).", tool: "captions", arguments: { timeline_id: timelineId, action: "unify", ...(forced !== null ? { size: forced } : {}), base_commit: head.head.id } } } };
	}
	const message = opt(args, "message") ?? `captions: one size per span (${targets.map((span) => `${r2(span.from)}-${r2(span.to)} s → ${forced ?? span.size}`).join(", ")})`;
	const done = await commitSnapshot(ctx, timelineId, head.head.id, head.branch, snapshot, ops, message);
	if (!done.ok) return done.out;
	return { payload: { commit_id: done.commit.id, message: done.commit.message, timeline_id: timelineId, ...report, editor: EDITOR_NOTE, next: renderNext(timelineId) } };
}

async function captions(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "");
	if (args.action === "measure") return captionsMeasure(timelineId, opt(args, "branch"));
	if (args.action === "unify") return captionsUnify(args, ctx, timelineId);
	const styleArg = opt(args, "style");
	if (styleArg && !STYLE_IDS.includes(styleArg)) return fail("unknown_style", `No caption style "${styleArg}".`, { styles: STYLE_IDS });
	const zone = opt(args, "zone") as CaptionZone | undefined;
	if (zone && !ZONES.includes(zone)) return fail("invalid_arguments", `zone must be one of ${ZONES.join(", ")}.`);
	const elementId = opt(args, "element_id");
	const dryRun = args.dry_run === true;
	const head = await loadHead(timelineId, opt(args, "branch"));
	const base = opt(args, "base_commit");
	if (!baseMatches(base, head.head.id)) return conflict(timelineId, head.head.id, base ?? "");
	const started = Date.now();
	const canvasHeight = head.snapshot.settings?.canvasSize?.height ?? 1920;

	// the look this call asks for
	const size = parseCaptionSize(args.size, canvasHeight);
	if (size && "error" in size) return fail("invalid_arguments", size.error);
	const caseArg = opt(args, "case") as CaptionCase | undefined;
	if (caseArg && !["lower", "sentence", "upper"].includes(caseArg)) return fail("invalid_arguments", "case must be lower, sentence or upper.");
	let keys: string[] | "auto" | undefined;
	if (args.keys === "auto") keys = "auto";
	else if (Array.isArray(args.keys)) keys = (args.keys as unknown[]).map(String).filter((key) => key.trim());
	else if (typeof args.keys === "string" && args.keys.trim()) keys = args.keys.split(",").map((key) => key.trim()).filter(Boolean);
	const wordsPerChunk = typeof args.words_per_chunk === "number" ? Math.min(MAX_CAPTION_WORDS, Math.max(1, Math.round(args.words_per_chunk))) : undefined;
	const t0 = typeof args.t0 === "number" ? args.t0 : undefined;
	const t1 = typeof args.t1 === "number" ? args.t1 : undefined;
	if ((t0 === undefined) !== (t1 === undefined)) return fail("invalid_arguments", "Pass both t0 and t1 (timeline seconds) to restyle one span, or neither.");
	const span = t0 !== undefined && t1 !== undefined ? { t0: Math.min(t0, t1), t1: Math.max(t0, t1) } : null;
	const overrides: LookOverrides = {
		...(styleArg ? { style: styleArg } : {}),
		...(size ? { size: size as LookOverrides["size"] } : {}),
		...(caseArg ? { case: caseArg } : {}),
		...(keys !== undefined ? { keys } : {}),
		...(opt(args, "key_color") ? { key_color: opt(args, "key_color") } : {}),
		...(typeof args.key_scale === "number" ? { key_scale: args.key_scale } : {}),
		...(opt(args, "color") ? { color: opt(args, "color") } : {}),
		...(zone ? { zone } : {}),
		...(wordsPerChunk ? { max_words: wordsPerChunk } : {}),
		...(typeof args.blur_in === "boolean" ? { blur_in: args.blur_in } : {}),
	};
	const notes: string[] = [];
	const existing = readCaptionDoc(head.snapshot);
	const styleId = styleArg ?? existing.styleId ?? "word-pop";
	const style = getCaptionStyle(styleId);
	if ((keys !== undefined || args.key_scale !== undefined) && (styleArg ?? existing.styleId ?? "word-pop") !== "key-word") {
		notes.push("keys / key_scale draw key words in the key-word style only; with word-pop key_color recolours the word box, with serif-box the spoken words");
	}

	let clips = spokenClips(head.snapshot);
	if (elementId) {
		const found = findElement(head.snapshot, elementId);
		if (!found) return withNext(fail("not_found", `No element ${elementId} on this timeline.`), summaryNext(timelineId));
		clips = clips.filter((clip) => clip.element.id === elementId);
		if (!clips.length) return withNext(fail("not_spoken", `Element ${elementId} is not a clip with sound (video with its audio on, or uploaded audio).`), summaryNext(timelineId));
	}
	if (!clips.length) return withNext(fail("no_clips", "No clip with sound on this timeline to caption."), summaryNext(timelineId));

	const words = await timelineCaptionWords(timelineId, clips, ctx.signal);
	if (!words.words.length) {
		const first = words.missing[0];
		if (first) return noTranscript(timelineId, first, elementId);
		return withNext(fail("no_words", "The transcripts have no words inside these clips."), summaryNext(timelineId));
	}
	// a person's text fixes on the timeline survive the rebuild; each word keeps the look of the chunk it was in
	const carried = carryTimelineFixes(words.words, existing.doc);
	const fresh = rechunk({ words: carried.words, existing: existing.doc, overrides, span, style });
	const inSpan = (chunk: CaptionDocChunk) => !span || (chunk.end > span.t0 && chunk.start < span.t1);
	const kept = chunksOutside(existing.doc, words.ranges).map((chunk) => (inSpan(chunk) && !elementId ? { ...chunk, look: applyOverrides(chunk.look ?? {}, overrides) } : chunk));
	const doc = mergeDocs(fresh, kept);
	const measureMethod = opt(args, "measure") === "estimate" ? "estimate" : "chromium";
	const faces = doc.some((chunk) => (chunk.look?.zone ?? "auto") === "auto") ? { projectId: timelineId } : null;
	const built = await buildCaptions({ snapshot: head.snapshot, doc, style, seed: `${timelineId}/${head.head.id}/captions/${JSON.stringify(overrides)}/${span ? `${span.t0}-${span.t1}` : "all"}`, measureMethod, signal: ctx.signal, faces });
	if (!built.result.ok) {
		return withNext(fail("ops_conflict", "The reducer refused the captions. Nothing was committed.", { conflicts: built.result.conflicts.slice(0, 10) }), summaryNext(timelineId));
	}
	const verbatim = fresh.every((chunk) => chunk.words.every((word) => carried.words.some((source) => source.text === word.text && Math.abs(source.start - word.start) < 1e-6)));
	const styles = built.build.chunks.reduce<Record<string, number>>((count, chunk) => ({ ...count, [chunk.style ?? style.id]: (count[chunk.style ?? style.id] ?? 0) + 1 }), {});
	const lanes = { base: "CAPTIONS", ...(built.build.tracks.wordSlots?.length ? { words: built.build.tracks.wordSlots.map((_, i) => (i === 0 ? "CAPTION WORDS" : `CAPTION WORDS ${i + 1}`)) } : {}), ...(built.build.tracks.shadowSlots?.length ? { shadow: built.build.tracks.shadowSlots.map((_, i) => (i === 0 ? "CAPTION SHADOW" : `CAPTION SHADOW ${i + 1}`)) } : {}) };
	const placement = built.placement;
	if (faces && placement.no_face && placement.media_without_faces.length) {
		const started = (placement.matte_jobs ?? []).filter((job) => job.job_id).map((job) => `${job.media_id} (${job.started ? "started" : job.state})`);
		notes.push(
			`${placement.fallback_top_band ?? placement.no_face} chunk(s) sit over ${placement.media_without_faces.length} clip(s) with no face box yet, so they were placed in the conservative top band (centre 15–30 % of the frame height) instead of the style's line${started.length ? `; person matte job(s) started: ${started.join(", ")} — when done (cutout {action: "status", element_id}), run captions again to place them by the face` : `; run cutout {action: "matte", element_id} on those clips, then captions again, to place them by the face`}`,
		);
	}
	if (built.split_to_fit) notes.push(`${built.split_to_fit} chunk(s) were too wide for the safe area at their size: each was split in two (same size) instead of shrunk`);
	if (carried.carried) notes.push(`${carried.carried} word(s) changed on the timeline were kept; make them permanent with transcribe {action: "edit"}`);
	if (size && "relative" in size && size.relative > 1) {
		const capped = built.build.chunks.filter((chunk) => chunk.shrunk && inSpan(built.doc[chunk.index] ?? { start: 0, end: 0, words: [] })).length;
		const fewer = Math.max(1, (wordsPerChunk ?? 3) - 1);
		if (capped) notes.push(`${capped} chunk(s) are already as wide as the safe area allows, so they could not grow${fewer < (wordsPerChunk ?? 3) ? `; fewer words per chunk lets them (words_per_chunk: ${fewer}${span ? " with the same t0/t1" : ""})` : ""}`);
	}
	// revise-safety: words before vs after — a rebuild that loses caption words (an overlap dropped, a stale transcript)
	// is refused from 2 words up (1 is reported: a re-transcription can merge two words)
	const wordCheck = guardSnapshots(head.snapshot, built.snapshot, { tolerance: 1 });
	if (!wordCheck.ok && args.allow_word_loss !== true) {
		return withNext(fail("words_lost", `Refused: these captions would lose ${wordCheck.lost.length} word(s) the captions there show (${wordCheck.lost.slice(0, 8).map((word) => `"${word.text}" @ ${word.t} s`).join(", ")}). Nothing was committed. If they are gone from the speech on purpose, send the same call with allow_word_loss: true.`, { words: guardView(wordCheck) }), {
			do: "Read the words the transcript has (the lost ones may be a stale transcript or a fix to make).",
			tool: "transcribe",
			arguments: { timeline_id: timelineId, action: "edits" },
		});
	}
	if (wordCheck.lost.length) notes.push(`1 caption word is not in the new captions: "${wordCheck.lost[0]?.text}" @ ${wordCheck.lost[0]?.t} s (fix it with transcribe {action: "edit"} if it should be there)`);
	const report = {
		words: guardView(wordCheck),
		caption_spans: spansView(measureCaptionSpans(built.snapshot)),
		...(built.split_to_fit ? { split_to_fit: built.split_to_fit } : {}),
		style: { id: style.id, label: style.label, words_per_chunk: wordsPerChunk ?? style.maxWords, highlight: style.highlight.kind },
		...(span ? { span: { t0: span.t0, t1: span.t1 } } : {}),
		look: overrides,
		chunks: built.build.chunks.length,
		chunks_by_style: styles,
		from_transcript: fresh.length,
		kept_from_before: kept.length,
		replaced_tracks: built.removedTracks,
		layers: lanes,
		lane_index: built.lane,
		elements_added: built.result.changes.ops.filter((change) => change.op === "insert" && change.status === "applied").length,
		shrunk_to_fit: built.build.chunks.filter((chunk) => chunk.shrunk).length,
		font_sizes: built.build.chunks.reduce<Record<string, number>>((count, chunk) => ({ ...count, [String(chunk.size)]: (count[String(chunk.size)] ?? 0) + 1 }), {}),
		size_units: "editor units: letters are size × canvas height / 90 px tall (on 1080×1920, 5 → 107 px); whole units only",
		placement,
		outside_safe_area: built.outsideSafeArea.length,
		...(built.outsideSafeArea.length ? { outside: built.outsideSafeArea.slice(0, 10) } : {}),
		safe_area: "x 60-940, y 220-1500 on 1080x1920 (scaled to the canvas) — measured like the export gate's SAFE check (gate textBox, Chromium widths, box padding included)",
		...(built.blurIn ? { blur_in: built.blurIn } : {}),
		verbatim,
		...(Object.keys(words.fixes).length ? { transcript_fixes_used: words.fixes } : {}),
		...(carried.carried ? { timeline_fixes_kept: carried.carried } : {}),
		measure: built.measure,
		...(words.missing.length ? { media_without_transcript: words.missing } : {}),
		...(notes.length ? { notes } : {}),
	};
	if (dryRun) {
		return {
			payload: {
				dry_run: true,
				...report,
				sample: chunkView(built, 40),
				ms: Date.now() - started,
				next: { do: "Commit it (same call without dry_run).", tool: "captions", arguments: { ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== "dry_run")), timeline_id: timelineId, base_commit: head.head.id } },
			},
		};
	}
	const what = [
		styleArg ? style.label : null,
		size ? ("relative" in size ? `${size.relative}×` : `size ${r2(size.absolute)}`) : null,
		caseArg ?? null,
		keys ? `keys ${keys === "auto" ? "auto" : keys.join("/")}` : null,
		zone && zone !== "auto" ? zone : null,
	]
		.filter(Boolean)
		.join(" · ");
	const message = opt(args, "message") ?? `captions: ${what || style.label} · ${built.build.chunks.length} chunks${span ? ` · ${r2(span.t0)}-${r2(span.t1)} s` : ""}`;
	const done = await commitSnapshot(ctx, timelineId, head.head.id, head.branch, built.snapshot, built.ops, message);
	if (!done.ok) return done.out;
	return {
		payload: {
			commit_id: done.commit.id,
			message: done.commit.message,
			...report,
			sample: chunkView(built, 12),
			ms: Date.now() - started,
			editor: `${EDITOR_NOTE} The CAPTIONS tab's caption list reads these back (edit words, merge/split, nudge, restyle).`,
			next: renderNext(timelineId),
		},
	};
}

export const CAPTIONS_TOOL: Tool = {
	name: "captions",
	title: "Captions",
	description: `Word captions from the server transcript (with its word fixes), verbatim, in a caption style (${CAPTION_STYLE_PRESETS.map((preset) => `${preset.id}: ${preset.hint}`).join("; ")}). 1-5 words per chunk (default 3; breaks on punctuation and pauses), every chunk shrunk to fit and kept inside the caption safe area (measured like the export gate); highlight / karaoke / key words are placed by measuring the real font in headless Chromium. Replaces the timeline's caption layers (CAPTIONS, CAPTION WORDS, CAPTION SHADOW — base, words and shadow always change together) as ONE commit by claude; the editor's CAPTIONS tab reads them back. Restyle: size (a number = editor units, 5 ≈ 107 px letters on 1080×1920; "1.35x" / "135%" relative; "110px"; "bigger"/"smaller"), case lower|sentence|upper, keys (key-word style: ["claude","edit"] or "auto"), key_color (accent: key words / word box / spoken words), key_scale, color, words_per_chunk, blur_in, zone (auto = clear of the face when the clip has a cutout face track, else the style's line; style; top · upper · middle · lower · bottom). Without t0/t1 the look applies to every chunk; with t0/t1 (timeline seconds) only to chunks in that span — the others keep the look they have. Looks and word fixes survive every rebuild (autocut, transcript fixes). Without style the timeline's current style is kept. element_id = that clip only (other captions stay); all (or neither) = every clip with a transcript. dry_run: true shows the chunks without committing. One look per span: a chunk too wide for the safe area is split in two at its size (not shrunk); words without a chunk take their neighbours' look; action "measure" lists sizes and fonts by span and action "unify" gives each mixed span one size; every answer has caption_spans (mixed spans listed) and words {before, after, lost} (a rebuild that loses words is refused). Clips with no face box yet: their chunks go in the top band (centre 15–30 % of the height) and the clip's person matte is started (at most 2 per call); captions again after it finishes places them by the face. Which style for which tone, key words, text behind the speaker: guide {topic: "captions"}.`,
	inputSchema: {
		type: "object",
		properties: {
			timeline_id: str("The timeline."),
			action: { type: "string", enum: ["build", "measure", "unify"], description: "build (default): caption / restyle as below · measure: caption sizes and fonts by span (a span = consecutive chunks in one font and style), with the chunks off their span's size and why · unify: every mixed span gets one size (its most common, or size), one commit (dry_run first)." },
			allow_word_loss: bool("Only when the person said so: commit even if the new captions show fewer of the words the captions there show (default: refused from 2 lost words, with the list)."),
			element_id: str("Caption this clip only."),
			all: bool("Caption every clip that has a transcript (the default when element_id is not given)."),
			style: { type: "string", enum: STYLE_IDS, description: "Caption style id (default: the timeline's current style, else word-pop). With t0/t1: that span only." },
			size: { type: ["number", "string"], description: "Font size: a number = editor units (1 unit = canvas height / 90 px; 5 ≈ 107 px letters on 1080×1920; whole units are stored), or \"1.35x\" / \"135%\" relative to each chunk's current size, or \"110px\", or \"bigger\" / \"smaller\"." },
			case: { type: "string", enum: ["lower", "sentence", "upper"], description: "Letter case (sentence = as transcribed)." },
			keys: { type: ["array", "string"], description: "key-word style: the key words (matched ignoring case and punctuation), e.g. [\"claude\", \"edit\"], or \"auto\" (one telling word per chunk)." },
			key_color: str("Accent colour (#RRGGBB): key words (key-word), the word box (word-pop), the spoken words (serif-box)."),
			key_scale: num("key-word style: key word size relative to the line (default 1.3).", 1, 2.5),
			color: str("Text colour of the captions (#RRGGBB)."),
			words_per_chunk: num("1-5 (default: the style's; huge-centred is 1).", 1, MAX_CAPTION_WORDS),
			zone: { type: "string", enum: ZONES, description: "Vertical zone: auto (default: the style's line, moved clear of the face when the clip has a cutout face track), style (the style's own line), top, upper, middle, lower, bottom." },
			blur_in: bool("Blur each caption in (default on for key-word)."),
			t0: num("Restyle only the chunks from this timeline second (with t1).", 0),
			t1: num("…to this timeline second.", 0),
			measure: { type: "string", enum: ["chromium", "estimate"], description: "How text is measured (default chromium: the real font; estimate = 0.55 em per character)." },
			dry_run: bool("Show the chunks and layout without committing."),
			base_commit: str("Optional: the head you read; if the timeline moved on nothing is done."),
			message: str("Commit message (default: captions: <what changed> · N chunks)."),
			branch: str("Branch (default: the project's default branch)."),
		},
		required: ["timeline_id"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	budgetSeconds: 120,
	run: captions,
};

/** The line the server's instructions get. */
export const CUT_INSTRUCTIONS =
	"Talking head: transcribe {all: true} (poll the same call) → autocut {all: true} (dry_run shows the cut list: silence, retake, false_start; tails ripple, no gaps) → captions (style word-pop | bold-white | serif-box | mono-label | huge-centred | key-word; size \"1.35x\", case, keys, zone; t0/t1 restyles one span) — each edit is one commit. A wrong word: transcribe {action: \"edit\", fixes: [{from, to}]} (captions rebuild with it). Mixed caption sizes: captions {action: \"measure\"} lists sizes by span, captions {action: \"unify\"} gives each span one size.";
