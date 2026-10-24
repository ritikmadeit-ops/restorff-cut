/**
 * MCP tool `plan` (timing-helper, 2026-10-21; the Sonnet replays' I-8 list): timing worked out from the words, never a
 * commit. Every Sonnet replay did this by hand — scene cuts from a new voice-over, 17 effect windows from a transcript,
 * a trim in-point — and copied numbers from an old run where the words did not match.
 *
 *   scenes   voice-over / transcript word timings (+ count or scene_s) → scene cut points on sentence ends and
 *            pauses, each with its line and words → `composition write` calls (t, duration_s, props {t0, line, words})
 *   effects  effect names in order + the transcript → {name, t, word, duration_s} windows on spoken words, ~1 s each
 *            unless the manifest needs more, never overlapping; transitions on a cut (a split first if none) →
 *            `timeline_ops` (splits) + `effects apply` calls
 *   trim     a clip's source words → in/out points that drop its silent head and tail → a `timeline_ops` call
 *
 * Words: `words` given (a voiceover answer's words, transcribe's [text, start, end]) or the timeline's own — the same
 * words `effects apply {word}` reads (server transcripts of the clips, voice-over takes included, else caption words).
 * Pure planners: ../server/timing-plan.ts. Runbook: docs/restorff/worklog/timing-helper.md.
 */
import { TRANSITION_KINDS } from "@restorffcut/timeline-ops";
import { findEffect, type LibraryEffect } from "@/server/effects-catalogue";
import { gate, loadLibrary, type PackageEntry, timelineWords } from "@/server/effects";
import { activeScene, type SourceWord, wordsFromTranscripts } from "@/server/effects-words";
import { HttpError } from "@/server/http";
import { listProjectMedia } from "@/server/media";
import { getProjectHead } from "@/server/projects";
import { resolveTrackStrict, trackLabel } from "@/server/timeline-read";
import {
	type EffectAsk,
	type EffectsPlan,
	normalizeWords,
	type PlanWord,
	planEffects,
	planScenes,
	planTrim,
	round3,
	findPhrase,
} from "@/server/timing-plan";
import { findTranscript } from "@/server/transcripts";
import type { ProjectSnapshot, SnapshotElement, SnapshotTrack } from "@/sync/snapshot";
import { fail, type JsonSchema, type Payload, type Tool, type ToolOutput } from "./protocol";

const TICKS = 120_000;
const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: "number", description, ...extra });
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const numberOr = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

type Next = { do: string; tool: string; arguments?: Record<string, unknown> };
interface Call {
	tool: string;
	arguments: Record<string, unknown>;
	why: string;
}

function failWith(code: string, message: string, next: Next, extra: Record<string, unknown> = {}): ToolOutput {
	const out = fail(code, message, extra);
	(out.payload as Payload).next = next;
	return out;
}

const listNext: Next = { do: "List the timelines.", tool: "timeline", arguments: { action: "list" } };

// ─── loading ────────────────────────────────────────────────────────────────────────────────────────────────

interface Head {
	id: string;
	snapshot: ProjectSnapshot;
	fps: number;
}

async function loadHead(timelineId: string, branch?: string): Promise<Head> {
	const head = await getProjectHead(timelineId, branch);
	if (!head.snapshot) throw new HttpError(409, `The head commit ${head.head.id} has no snapshot to read.`);
	const fps = head.snapshot.settings?.fps;
	const rate = typeof fps === "number" ? fps : fps ? fps.numerator / fps.denominator : 30;
	return { id: head.head.id, snapshot: head.snapshot, fps: rate > 0 ? rate : 30 };
}

function allTracks(snapshot: ProjectSnapshot): SnapshotTrack[] {
	const tracks = activeScene(snapshot)?.tracks;
	return tracks ? [...(tracks.overlay ?? []), ...(tracks.main ? [tracks.main] : []), ...(tracks.audio ?? [])] : [];
}

function findElement(snapshot: ProjectSnapshot, elementId: string): { track: SnapshotTrack; element: SnapshotElement } | null {
	for (const track of allTracks(snapshot)) {
		const element = (track.elements ?? []).find((candidate) => candidate.id === elementId);
		if (element) return { track, element };
	}
	return null;
}

/** A transcript lookup by media id (the store mcp-cut and voiceover write), as effects apply reads it. */
async function transcriptLookup(projectId: string): Promise<(mediaId: string) => SourceWord[] | null> {
	const media = await listProjectMedia(projectId).catch(() => []);
	const hashOf = new Map(media.map((row) => [row.media_id, row.hash]));
	const memo = new Map<string, SourceWord[] | null>();
	return (mediaId) => {
		if (!memo.has(mediaId)) {
			const hash = hashOf.get(mediaId);
			memo.set(mediaId, hash ? (findTranscript(hash)?.words ?? null) : null);
		}
		return memo.get(mediaId) ?? null;
	};
}

/** The snapshot with only one track's (or one element's) clips, for "the voice-over's words only". */
function onlyThese(snapshot: ProjectSnapshot, keep: (track: SnapshotTrack, element: SnapshotElement) => boolean): ProjectSnapshot {
	const copy = JSON.parse(JSON.stringify(snapshot)) as ProjectSnapshot;
	const scene = activeScene(copy);
	const tracks = scene?.tracks;
	if (!tracks) return copy;
	const filter = (track: SnapshotTrack) => ({ ...track, elements: (track.elements ?? []).filter((element) => keep(track, element)) });
	tracks.overlay = (tracks.overlay ?? []).map(filter);
	if (tracks.main) tracks.main = filter(tracks.main);
	tracks.audio = (tracks.audio ?? []).map(filter);
	return copy;
}

interface Words {
	words: PlanWord[];
	/** given = the words argument · transcripts / captions = what effects apply reads · track / element = filtered. */
	source: string;
	/** True when `effects apply {word, occurrence}` reads these exact words (so word arguments are safe). */
	same_as_apply: boolean;
	dropped?: number;
}

async function wordsFor(args: Record<string, unknown>, head: Head | null, timelineId: string | undefined): Promise<Words | ToolOutput> {
	if (Array.isArray(args.words)) {
		const { words, dropped } = normalizeWords(args.words);
		if (!words.length) return fail("invalid_arguments", "words has no usable items: give [{text, start, end}] (a voiceover answer's words), [text, start_s, end_s] (transcribe) or [{w, s, e}].");
		return { words, source: "given", same_as_apply: false, ...(dropped ? { dropped } : {}) };
	}
	if (!timelineId || !head) {
		return failWith("invalid_arguments", "Give timeline_id (its transcripts / voice-over words are read) or words ([{text, start, end}] in timeline seconds).", listNext);
	}
	const trackWanted = text(args.track);
	const elementWanted = text(args.element_id);
	if (trackWanted || elementWanted) {
		let trackId: string | null = null;
		if (trackWanted) {
			const found = resolveTrackStrict(head.snapshot, trackWanted);
			if (!found.match) {
				return failWith(found.ambiguous.length ? "ambiguous_track" : "unknown_track", `track "${trackWanted}" ${found.ambiguous.length ? "matches several tracks" : "is not on this timeline"}.`, { do: "Read the summary for track ids.", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } }, {
					tracks: (found.ambiguous.length ? found.ambiguous : []).map(trackLabel),
				});
			}
			trackId = found.match.track.id;
		}
		if (elementWanted && !findElement(head.snapshot, elementWanted)) {
			return failWith("not_found", `No element ${elementWanted} on this timeline's head.`, { do: "Read the summary for element ids.", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } });
		}
		const filtered = onlyThese(head.snapshot, (track, element) => (!trackId || track.id === trackId) && (!elementWanted || element.id === elementWanted));
		const words = wordsFromTranscripts(filtered, await transcriptLookup(timelineId));
		return { words, source: elementWanted ? "element" : "track", same_as_apply: false };
	}
	const { words, source } = await timelineWords(timelineId, head.snapshot);
	return { words, source, same_as_apply: source !== "none" };
}

const noWords = (timelineId: string): ToolOutput =>
	failWith("no_words", "No word timings on this timeline: no server transcript of its clips or voice-over takes, and no caption words.", {
		do: "Transcribe the clips (or place the voice-over with voiceover say, which stores its words), then plan again.",
		tool: "transcribe",
		arguments: { timeline_id: timelineId, all: true },
	});

// ─── scenes ─────────────────────────────────────────────────────────────────────────────────────────────────

async function scenes(args: Record<string, unknown>): Promise<ToolOutput> {
	const timelineId = text(args.timeline_id);
	const head = timelineId ? await loadHead(timelineId, text(args.branch)) : null;
	const got = await wordsFor(args, head, timelineId);
	if (!("same_as_apply" in got)) return got;
	if (!got.words.length && timelineId) return noWords(timelineId);
	const fps = numberOr(args.fps) ?? head?.fps ?? 30;
	const starts = Array.isArray(args.starts) ? (args.starts as unknown[]).filter((item): item is string => typeof item === "string" && !!item.trim()) : undefined;
	const plan = planScenes(got.words, {
		...(starts?.length ? { starts } : {}),
		count: numberOr(args.count),
		sceneS: numberOr(args.scene_s),
		minS: numberOr(args.min_s),
		maxS: numberOr(args.max_s),
		startS: numberOr(args.start_s),
		endS: numberOr(args.end_s),
		tailS: numberOr(args.tail_s),
		leadS: numberOr(args.lead_s),
		pauseS: numberOr(args.pause_s),
		fps,
	});
	const tl = timelineId ?? "<timeline_id>";
	const calls: Call[] = plan.scenes.map((scene) => ({
		tool: "composition",
		arguments: {
			action: "write",
			timeline_id: tl,
			t: scene.t,
			duration_s: scene.duration_s,
			source: `@file:scene-${scene.n}.html`,
			props: { t0: scene.t, line: scene.line, words: scene.words },
			message: `composition: scene ${scene.n} (${scene.t}–${scene.end} s)`,
		},
		why: `scene ${scene.n}: ${scene.cut}; "${scene.line.length > 80 ? `${scene.line.slice(0, 77)}…` : scene.line}"`,
	}));
	return {
		payload: {
			planned: "scenes",
			committed: false,
			words: { count: got.words.length, source: got.source, ...(got.dropped ? { dropped: got.dropped } : {}) },
			cuts: plan.scenes.slice(1).map((scene) => scene.t).concat(plan.end_s),
			scenes: plan.scenes,
			span: { start_s: plan.start_s, end_s: plan.end_s, target_s: plan.target_s, count_asked: plan.count_asked, candidates: plan.candidates },
			rules: starts?.length
				? "A cut lead_s (0.1 s, at most half the gap) before each starts phrase's first word, on the frame grid (found in order). Each scene's words are timeline seconds; its composition reads them as props.words with props.t0 = its start (local time = s − t0)."
				: "Cuts sit on sentence ends (or pauses ≥ pause_s inside a sentence), lead_s (0.1 s) before the next line's first word, on the frame grid; a DP picks the cuts that make scenes closest to the target length (count → total / count) — it balances lengths and knows no story: pass starts (each scene's first words) to cut on your beats. Each scene's words are timeline seconds; its composition reads them as props.words with props.t0 = its start (local time = s − t0).",
			...(plan.notes.length ? { notes: plan.notes } : {}),
			calls,
			calls_note:
				"One composition write per scene. source is \"@file:scene-N.html\": write each scene's HTML (composition contract) beside your calls file and run them with scripts/mcp-run.ts, which loads @file: paths — or put the HTML in source yourself.",
			next: timelineId
				? { do: "Write scene 1 with its t, duration_s and props (the first call in calls); the composition contract says how a scene reads props.", tool: "composition", arguments: { action: "contract" } }
				: { do: "Plan on a timeline to get ready calls (timeline_id).", tool: "timeline", arguments: { action: "list" } },
		},
	};
}

// ─── effects ────────────────────────────────────────────────────────────────────────────────────────────────

interface AskItem {
	name: string;
	word?: string;
	occurrence?: number;
	t?: number;
	duration_s?: number;
	params?: Record<string, unknown>;
}

function askItems(value: unknown): AskItem[] | string {
	if (!Array.isArray(value) || !value.length) return "effects needs a list of effect names (or {name, word?, occurrence?, t?, duration_s?, params?}).";
	const out: AskItem[] = [];
	for (const [i, item] of value.entries()) {
		if (typeof item === "string" && item.trim()) out.push({ name: item.trim() });
		else if (item && typeof item === "object" && !Array.isArray(item) && typeof (item as { name?: unknown }).name === "string") {
			const record = item as Record<string, unknown>;
			out.push({
				name: String(record.name).trim(),
				...(text(record.word) ? { word: text(record.word) } : {}),
				...(numberOr(record.occurrence) ? { occurrence: numberOr(record.occurrence) } : {}),
				...(numberOr(record.t) !== undefined ? { t: numberOr(record.t) } : {}),
				...(numberOr(record.duration_s) ? { duration_s: numberOr(record.duration_s) } : {}),
				...(record.params && typeof record.params === "object" && !Array.isArray(record.params) ? { params: record.params as Record<string, unknown> } : {}),
			});
		} else return `effects[${i}] must be a name or {name, …}.`;
	}
	return out;
}

interface Resolved {
	ask: EffectAsk;
	item: AskItem;
	effect: LibraryEffect | null;
	entry?: PackageEntry;
	needsParams?: Array<{ name: string; type?: unknown; description?: unknown }>;
	didYouMean?: Array<{ id: string; name: string }>;
}

function resolveAsk(item: AskItem, library: LibraryEffect[], entries: PackageEntry[], timelineId: string | undefined): Resolved {
	const found = findEffect(library, item.name);
	const pinned = {
		...(item.word ? { word: item.word } : {}),
		...(item.occurrence ? { occurrence: item.occurrence } : {}),
		...(item.t !== undefined ? { t: item.t } : {}),
		...(item.duration_s ? { duration_s: item.duration_s } : {}),
	};
	const base = { asked: item.name, natural_s: null, ...(Object.keys(pinned).length ? { pinned } : {}) };
	if (!found.effect) {
		return {
			ask: { ...base, id: item.name, name: item.name, kind: "skip", skip_reason: "unknown effect" },
			item,
			effect: null,
			didYouMean: found.candidates.slice(0, 3).map((candidate) => ({ id: candidate.id, name: candidate.name })),
		};
	}
	const effect = found.effect;
	const blocked = gate(effect, library, timelineId);
	const named = { ...base, id: effect.id, name: effect.name };
	if (blocked || !effect.apply) {
		const message = (blocked?.payload?.message as string | undefined) ?? `${effect.name} is ${effect.status}`;
		return { ask: { ...named, kind: "skip", skip_reason: message }, item, effect };
	}
	const apply = effect.apply;
	if (apply.kind === "composition") {
		const entry = entries.find((candidate) => candidate.name === apply.composition);
		const fit = (entry as { fit?: unknown } | undefined)?.fit;
		const natural = typeof fit === "number" ? fit : (entry?.duration ?? null);
		const required = ((entry as { required?: unknown } | undefined)?.required as string[] | undefined) ?? [];
		const needsParams = required
			.filter((key) => !(item.params && key in item.params))
			.map((key) => ({ name: key, type: entry?.params?.[key]?.type, description: entry?.params?.[key]?.description }));
		return {
			ask: { ...named, kind: "composition", natural_s: natural, compressible: fit !== false, span: fit === false },
			item,
			effect,
			entry,
			...(needsParams.length ? { needsParams } : {}),
		};
	}
	if (apply.kind === "shader") return { ask: { ...named, kind: "shader", natural_s: apply.hold_s, hold_to_sentence: apply.holdToSentence === true }, item, effect };
	if (apply.kind === "transition") return { ask: { ...named, kind: "transition", natural_s: TRANSITION_KINDS[apply.transition] ?? 0.35 }, item, effect };
	if (apply.kind === "grade") return { ask: { ...named, kind: "grade", natural_s: null, span: true }, item, effect };
	return { ask: { ...named, kind: "tool" }, item, effect };
}

function cutsOnMain(snapshot: ProjectSnapshot): number[] {
	const main = activeScene(snapshot)?.tracks?.main;
	const clips = [...(main?.elements ?? [])].filter((el) => el.type === "video" || el.type === "image").sort((a, b) => a.startTime - b.startTime);
	const out: number[] = [];
	for (let i = 0; i + 1 < clips.length; i++) if (clips[i].startTime + clips[i].duration === clips[i + 1].startTime) out.push(round3(clips[i + 1].startTime / TICKS));
	return out;
}

/** Where the picture ends: the last element end on any track that is not an effect layer (as effects apply clamps). */
function pictureEnd(snapshot: ProjectSnapshot): number {
	let end = 0;
	for (const track of allTracks(snapshot)) {
		if (track.type === "effect" || track.type === "audio") continue;
		for (const element of track.elements ?? []) end = Math.max(end, element.startTime + element.duration);
	}
	return round3(end / TICKS);
}

function mainClipAt(snapshot: ProjectSnapshot, t: number): SnapshotElement | null {
	const ticks = Math.round(t * TICKS);
	const main = activeScene(snapshot)?.tracks?.main;
	return (main?.elements ?? []).find((el) => (el.type === "video" || el.type === "image") && el.startTime < ticks && ticks < el.startTime + el.duration) ?? null;
}

async function effects(args: Record<string, unknown>): Promise<ToolOutput> {
	const items = askItems(args.effects);
	if (typeof items === "string") return fail("invalid_arguments", items);
	const timelineId = text(args.timeline_id);
	const head = timelineId ? await loadHead(timelineId, text(args.branch)) : null;
	const got = await wordsFor({ ...args, track: undefined, element_id: undefined }, head, timelineId);
	if (!("same_as_apply" in got)) return got;
	if (!got.words.length && timelineId) return noWords(timelineId);
	const { library, entries } = await loadLibrary();
	const resolved = items.map((item) => resolveAsk(item, library, entries, timelineId));
	const fps = numberOr(args.fps) ?? head?.fps ?? 30;
	const plan: EffectsPlan = planEffects(
		got.words,
		resolved.map((r) => r.ask),
		{
			defaultS: numberOr(args.default_s),
			gapS: numberOr(args.gap_s),
			fromS: numberOr(args.from_s),
			toS: numberOr(args.to_s),
			fillUnderS: numberOr(args.fill_under_s),
			maxRate: numberOr(args.max_rate),
			cuts: head ? cutsOnMain(head.snapshot) : [],
			...(head ? { pictureEndS: pictureEnd(head.snapshot) } : {}),
			leadS: numberOr(args.lead_s),
			fps,
		},
	);
	const tl = timelineId ?? "<timeline_id>";
	const total = plan.windows.length;
	const calls: Call[] = [];
	// transitions that need a cut: one timeline_ops commit with every split (left to right; the right piece is a ref)
	const splits = plan.windows.filter((win) => win.cut?.split).map((win) => win.cut!.t);
	if (splits.length) {
		if (!head) {
			calls.push({ tool: "timeline_ops", arguments: { timeline_id: tl, base_commit: "<head>", ops: splits.map((t) => ({ op: "split", el: "<clip under t>", t })), message: "split for transitions" }, why: "transitions need cuts" });
		} else {
			const ops: Array<Record<string, unknown>> = [];
			const pieceOf = new Map<string, string>();
			splits.forEach((t, i) => {
				const clip = mainClipAt(head.snapshot, t);
				if (!clip) return;
				const el = pieceOf.get(clip.id) ?? clip.id;
				const ref = `cut${i + 1}`;
				ops.push({ op: "split", el, t, ref });
				pieceOf.set(clip.id, ref);
			});
			if (ops.length) {
				calls.push({
					tool: "timeline_ops",
					arguments: { timeline_id: tl, base_commit: head.id, ops, message: `split at ${splits.join(" / ")} s for ${splits.length === 1 ? "a transition" : "transitions"}` },
					why: "transitions sit on a cut; these cuts do not exist yet (one commit, before the effects)",
				});
			}
		}
	}
	const windows = plan.windows.map((win) => {
		const r = resolved[win.ask];
		const params = r?.item.params ?? {};
		const arguments_: Record<string, unknown> = { action: "apply", name: win.id, timeline_id: tl };
		if (win.kind === "transition") {
			arguments_.t = win.cut?.t ?? win.t + win.duration_s / 2;
			arguments_.duration_s = win.duration_s;
		} else if (win.word && got.same_as_apply && findPhrase(got.words, win.word.arg, win.word.occurrence) === win.word.index) {
			arguments_.word = win.word.arg;
			if (win.word.occurrence > 1) arguments_.occurrence = win.word.occurrence;
			arguments_.duration_s = win.duration_s;
		} else {
			arguments_.t = win.t;
			arguments_.duration_s = win.duration_s;
		}
		if (Object.keys(params).length) arguments_.params = params;
		arguments_.message = `effect: ${win.name} (${win.n}/${total})`;
		calls.push({ tool: "effects", arguments: arguments_, why: `${win.t}–${win.end} s${win.word ? ` on "${win.word.text}"` : ""}: ${win.why.join("; ")}` });
		return {
			n: win.n,
			name: win.name,
			id: win.id,
			kind: win.kind,
			t: win.t,
			end: win.end,
			duration_s: win.duration_s,
			word: win.word ? win.word.text : null,
			...(win.word && win.word.occurrence > 1 ? { occurrence: win.word.occurrence } : {}),
			...(win.cut ? { cut: win.cut } : {}),
			natural_s: win.natural_s,
			...(r?.needsParams ? { needs_params: r.needsParams } : {}),
			...(r?.effect?.needs.includes("person_matte") ? { person_matte: "apply makes (or reuses) the clip's person matte; wait_s up to 120" } : {}),
			why: win.why,
		};
	});
	for (const span of plan.spans) {
		const r = resolved[span.ask];
		const params = r?.item.params ?? {};
		const arguments_: Record<string, unknown> = span.kind === "grade" ? { action: "apply", name: span.id, timeline_id: tl } : { action: "apply", name: span.id, timeline_id: tl, t: span.t, duration_s: span.duration_s };
		if (Object.keys(params).length) arguments_.params = params;
		arguments_.message = `effect: ${span.name}`;
		calls.push({ tool: "effects", arguments: arguments_, why: span.why });
	}
	for (const ask of plan.tools) {
		const r = resolved.find((candidate) => candidate.ask === ask);
		const apply = r?.effect?.apply;
		if (apply?.kind === "tool") calls.push({ tool: apply.tool, arguments: { ...apply.arguments, timeline_id: tl }, why: `${ask.name}: ${apply.why}` });
	}
	const spans = plan.spans.map(({ ask, ...span }) => {
		const r = resolved[ask];
		return { ...span, ...(r?.needsParams ? { needs_params: r.needsParams } : {}) };
	});
	const skipped = resolved
		.filter((r) => r.ask.kind === "skip")
		.map((r) => ({ asked: r.ask.asked, ...(r.effect ? { id: r.effect.id, name: r.effect.name, status: r.effect.status } : {}), why: r.ask.skip_reason, ...(r.didYouMean?.length ? { did_you_mean: r.didYouMean } : {}) }));
	const needParams = [...windows, ...spans].filter((item) => "needs_params" in item && item.needs_params);
	return {
		payload: {
			planned: "effects",
			committed: false,
			words: { count: got.words.length, source: got.source, ...(got.same_as_apply ? {} : { note: "these words are not the ones effects apply reads, so the calls use t (seconds), not word" }) },
			range: plan.range,
			needed_s: plan.needed_s,
			slack_s: plan.slack_s,
			fits: plan.fits,
			windows,
			...(spans.length ? { spans } : {}),
			...(plan.tools.length ? { tools: plan.tools.map((ask) => ({ asked: ask.asked, id: ask.id, name: ask.name })) } : {}),
			...(skipped.length ? { skipped } : {}),
			rules:
				"In the order given, each effect starts on a spoken word (the onset closest to an even spread that still leaves room for the rest; words like \"the\" / \"to\" only when nothing better is near), lasts default_s (1 s) unless its manifest's natural length needs more (fit-to-duration speeds a composition up at most max_rate = 4×), and never overlaps the next; a gap under fill_under_s (0.3 s) is closed. Transitions sit on a cut on the main track — an existing one in reach, else a split at a word boundary (planned first). Digital Zoom holds to its sentence end when there is room. fit:false compositions (toc-list) and grades span the whole plan.",
			...(plan.notes.length ? { notes: plan.notes } : {}),
			calls,
			calls_note: `${calls.length} calls in order: ${splits.length ? "the split commit first, then " : ""}one effects apply per window (each one commit)${spans.length ? ", then the spans" : ""}. ${needParams.length ? `${needParams.length} effect(s) need content in params (needs_params: words, cards, images the plan cannot invent) — fill them before sending. ` : ""}Run them with scripts/mcp-run.ts (it expands @img: paths) or send them one by one.`,
			next: calls[0]
				? { do: needParams.length ? "Fill each needs_params, then send the calls in order (dry_run: true on any of them shows it first)." : "Send the calls in order (dry_run: true on any of them shows it first).", tool: calls[0].tool, arguments: calls[0].arguments }
				: { do: "Nothing to apply: list the effects.", tool: "effects", arguments: { action: "list" } },
		},
	};
}

// ─── trim ───────────────────────────────────────────────────────────────────────────────────────────────────

async function trim(args: Record<string, unknown>): Promise<ToolOutput> {
	const timelineId = text(args.timeline_id);
	if (!timelineId) return failWith("invalid_arguments", "trim needs timeline_id and element_id (the clip) or media_id (the whole file).", listNext);
	const elementId = text(args.element_id);
	const mediaWanted = text(args.media_id);
	if (!elementId && !mediaWanted) {
		return failWith("invalid_arguments", "trim needs element_id (the clip to trim) or media_id (plan for the whole file).", { do: "Read the summary for the clip's element id.", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } });
	}
	const head = await loadHead(timelineId, text(args.branch));
	const found = elementId ? findElement(head.snapshot, elementId) : null;
	if (elementId && !found) return failWith("not_found", `No element ${elementId} on this timeline's head.`, { do: "Read the summary for element ids.", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } });
	const mediaId = found?.element.mediaId ?? mediaWanted;
	if (!mediaId) return fail("invalid_arguments", `Element ${elementId} plays no media file (type ${found?.element.type}).`);
	const media = await listProjectMedia(timelineId);
	const row = media.find((candidate) => candidate.media_id === mediaId);
	if (!row) return failWith("not_found", `Media ${mediaId} is not in this timeline's media store.`, { do: "List the media.", tool: "media", arguments: { action: "list", timeline_id: timelineId } });
	const record = findTranscript(row.hash);
	if (!record?.words.length) {
		return failWith("no_transcript", "This media has no transcript yet: transcribe it first (word timings are what the trim is planned from).", {
			do: "Transcribe the clip, then plan the trim again.",
			tool: "transcribe",
			arguments: elementId ? { timeline_id: timelineId, element_id: elementId, wait_s: 120 } : { timeline_id: timelineId, all: true, wait_s: 120 },
		});
	}
	const el = found?.element;
	const rate = (el?.retime as { rate?: number } | undefined)?.rate;
	const currentIn = el ? (el.trimStart ?? 0) / TICKS : 0;
	const currentOut = el ? currentIn + (el.duration / TICKS) * (typeof rate === "number" && rate > 0 ? rate : 1) : record.duration;
	const plan = planTrim(record.words, {
		duration: record.duration,
		preS: numberOr(args.pre_s),
		postS: numberOr(args.post_s),
		fromWord: text(args.from_word),
		toWord: text(args.to_word),
		occurrence: numberOr(args.occurrence),
		...(args.sentences === false ? { sentences: false } : {}),
		...(el && !text(args.from_word) && !text(args.to_word) ? { window: { from: currentIn, to: currentOut } } : {}),
		fps: head.fps,
	});
	if (!plan) return fail("no_speech", "No spoken words inside this clip: nothing to trim to.", { current: { in: round3(currentIn), out: round3(currentOut) } });
	const notes = [...plan.notes];
	let inPoint = plan.in;
	let outPoint = plan.out;
	if (found && el) {
		const siblings = (found.track.elements ?? []).filter((other) => other.id !== el.id);
		const touchesBefore = siblings.some((other) => other.startTime + other.duration === el.startTime);
		const touchesAfter = siblings.some((other) => other.startTime === el.startTime + el.duration);
		// a touching neighbour fixes that edge: trimming it would open a gap, extending it would overlap; and with one
		// after it, a new in-point plus the move back would shift this clip's end into the next clip
		if (touchesBefore && Math.abs(inPoint - currentIn) > 0.0005) {
			inPoint = round3(currentIn);
			notes.push("a clip ends where this one starts: the in-point stays (it is a cut, not silence)");
		}
		if (touchesAfter && Math.abs(outPoint - currentOut) > 0.0005) {
			outPoint = round3(currentOut);
			notes.push("a clip starts where this one ends: the out-point stays (it is a cut, not silence)");
		}
		if (touchesAfter && Math.abs(inPoint - currentIn) > 0.0005) {
			inPoint = round3(currentIn);
			notes.push("the in-point stays too: moving it would shift this clip into the next one — plan the trim before splitting (media_id), or move the clips after it");
		}
		if (rate && rate !== 1) notes.push(`the clip is retimed (${rate}×): in/out are source seconds`);
	}
	const unchanged = Math.abs(inPoint - currentIn) < 0.0005 && Math.abs(outPoint - currentOut) < 0.0005;
	const ops = el && !unchanged ? [{ op: "trim", el: el.id, in: inPoint, out: outPoint }, { op: "move", el: el.id, t: round3(el.startTime / TICKS) }] : null;
	// signed: > 0 = seconds dropped, < 0 = seconds given back (the pre/post roll reaches past the current in/out)
	const headCut = round3(inPoint - currentIn);
	const tailCut = round3(currentOut - outPoint);
	const change = (cut: number, where: string) => (Math.abs(cut) < 0.0005 ? `${where} as is` : cut > 0 ? `${cut} s off the ${where}` : `${-cut} s back on the ${where}`);
	return {
		payload: {
			planned: "trim",
			committed: false,
			media_id: mediaId,
			words: { count: record.words.length, model: record.model, source: "transcript of the media file (source seconds)" },
			current: { in: round3(currentIn), out: round3(currentOut) },
			in: inPoint,
			out: outPoint,
			...(inPoint !== plan.in || outPoint !== plan.out ? { speech: { in: plan.in, out: plan.out, note: "what the words alone give; the clip's neighbours hold the edges above" } } : {}),
			kept_s: round3(outPoint - inPoint),
			drops: { head_s: headCut, tail_s: tailCut, note: "seconds taken off (negative = given back: the roll reaches past the current in/out)" },
			first_word: plan.first_word,
			last_word: plan.last_word,
			rules: `in = the first word's start − pre_s (${numberOr(args.pre_s) ?? 0.1} s), out = the last word's end + post_s (${numberOr(args.post_s) ?? 0.2} s), on the frame grid, inside the file, never into the word before / after; source seconds. Whole sentences: a leading lower-case fragment and words after the last . ! ? go too (sentences: false keeps them). trim keeps the kept frames where they are, so a move puts the clip back at its start.`,
			...(notes.length ? { notes } : {}),
			...(ops
				? {
						calls: [
							{
								tool: "timeline_ops",
								arguments: { timeline_id: timelineId, base_commit: head.id, ops, message: `trim to the speech: ${change(headCut, "head")}, ${change(tailCut, "tail")}` },
								why: "one commit: trim to the speech, then move the clip back to where it started",
							},
						],
						next: { do: "Check it with a dry run, then send the same call without dry_run.", tool: "timeline_ops", arguments: { timeline_id: timelineId, base_commit: head.id, ops, message: "trim the silent head and tail", dry_run: true } },
					}
				: {
						next: el
							? { do: "Nothing to change on this clip (it already starts and ends on its speech, or its edges are cuts). Read the summary for the next step.", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } }
							: { do: "Plan on the clip that plays this file (element_id) for a ready timeline_ops call.", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } },
					}),
		},
	};
}

// ─── the tool ───────────────────────────────────────────────────────────────────────────────────────────────

export const PLAN_TOOL: Tool = {
	name: "plan",
	title: "Plan timing from the words (scenes · effects · trim) — never commits",
	description:
		"Works out timing from word timings so you never do it by hand; read-only (no commit) and answers the exact calls to send (calls[]: {tool, arguments, why}). scenes {timeline_id | words, starts? | count? | scene_s?}: scene cut points — before each starts phrase (each scene's first words: your story beats), else on the sentence ends and pauses that balance the scenes to count / scene_s (a cut lead_s before the next line, on the frame grid) — each scene with its line and words → composition write calls (t, duration_s, props {t0, line, words}). effects {timeline_id, effects: [names in order, or {name, word?, occurrence?, t?, duration_s?, params?}]}: a window per effect on a spoken word — ~1 s (default_s) unless its manifest's natural length needs more, never overlapping, transitions on a cut (a split call first when there is none), toc-list-like overlays and grades spanning the plan → effects apply calls with word + occurrence (the words effects apply itself reads). trim {timeline_id, element_id | media_id}: in/out points that drop the clip's silent head and tail and any mid-sentence fragment at either end (pre_s / post_s kept, never into a neighbouring word; from_word / to_word to start or end on a phrase) → one timeline_ops call (trim + move back). Words: the timeline's transcripts and voice-over takes (else caption words); track (\"VOICE\") or element_id narrows scenes to one source; or pass words ([{text, start, end}] as voiceover answers them, or transcribe's [text, start_s, end_s]).",
	inputSchema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["scenes", "effects", "trim"], description: "scenes · effects · trim (see the description)." },
			timeline_id: str("The timeline (its head is read; nothing is committed)."),
			branch: str("Branch to read (default: the project's default branch)."),
			words: { type: "array", items: { type: ["object", "array"] }, description: "scenes, effects: word timings in timeline seconds instead of the timeline's ([{text, start, end}] · [text, start, end] · [{w, s, e}]). With words, effects calls use t instead of word." },
			track: str("scenes: only words from this track's clips (\"VOICE\", a track id)."),
			element_id: str("scenes: only this clip's words. trim (required unless media_id): the clip to trim."),
			media_id: str("trim: plan for the whole media file (no timeline_ops call)."),
			starts: { type: "array", items: { type: "string" }, description: "scenes: the first words of each scene after the first, in story order (\"Cold brew\", \"Foam climbs\", \"So we wrote\"): you know the beats, the plan finds the times — a cut lead_s before each. Overrides count / scene_s." },
			count: num("scenes: this many scenes (when the sentences allow).", { minimum: 1 }),
			scene_s: num("scenes: target scene length in seconds (default 5) when count is not given.", { minimum: 0.5 }),
			min_s: num("scenes: shortest scene (soft; default min(2, target / 2))."),
			max_s: num("scenes: longest scene (soft; default max(2 × target, target + 4))."),
			start_s: num("scenes: where the first scene starts (default 0)."),
			end_s: num("scenes: where the last scene ends (default the last word's end + tail_s 0.8, on the frame grid)."),
			tail_s: num("scenes: hold after the last word when end_s is not given (default 0.8)."),
			lead_s: num("scenes, effects: a cut sits this long before the next line's first word (default 0.1; at most half the gap)."),
			pause_s: num("scenes: a pause this long inside a sentence is a cut candidate too (default 0.35)."),
			effects: { type: "array", items: { type: ["string", "object"] }, description: "effects: the effects in the order they appear — names (\"Orbit\", \"FX-05\", \"comp:toc-list\") or {name, word?, occurrence?, t?, duration_s?, params?} to pin one." },
			default_s: num("effects: window length when an effect needs no more (default 1).", { minimum: 0.1 }),
			gap_s: num("effects: plain footage at least between two windows (default 0).", { minimum: 0 }),
			from_s: num("effects: plan from here (default the first word)."),
			to_s: num("effects: plan up to here (default the last word's end + 0.3)."),
			fill_under_s: num("effects: a gap shorter than this between windows is closed (default 0.3).", { minimum: 0 }),
			max_rate: num("effects: the most a fit-to-duration composition is sped up (default 4).", { minimum: 1 }),
			pre_s: num("trim: kept before the first word (default 0.1).", { minimum: 0 }),
			post_s: num("trim: kept after the last word (default 0.2).", { minimum: 0 }),
			sentences: { type: "boolean", description: "trim: keep whole sentences (default true): a take that starts mid-sentence (a lower-case first word) or runs on after its last . ! ? loses those fragments too." },
			from_word: str("trim: start on this phrase instead of the first word."),
			to_word: str("trim: end after this phrase instead of the last word."),
			occurrence: num("trim with from_word: which time it is said (default 1).", { minimum: 1 }),
			fps: num("Frame grid (default the timeline's fps, else 30).", { minimum: 1 }),
		},
		required: ["action"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: true, openWorldHint: false },
	budgetSeconds: 60,
	async run(args) {
		try {
			switch (args.action) {
				case "scenes":
					return await scenes(args);
				case "effects":
					return await effects(args);
				case "trim":
					return await trim(args);
				default:
					return fail("invalid_arguments", `Unknown action ${String(args.action)} (scenes · effects · trim).`);
			}
		} catch (error) {
			if (error instanceof HttpError && error.status === 404) return failWith("not_found", error.message, listNext);
			throw error;
		}
	},
};

/** The line the server's instructions get. */
export const PLAN_INSTRUCTIONS =
	"Timing comes from the words, never by hand: plan scenes (voice-over → scene cuts + composition write calls), plan effects (effect names → non-overlapping windows on spoken words + effects apply calls), plan trim (a clip's silent head/tail → a timeline_ops call); plan never commits — send the calls it answers.";
