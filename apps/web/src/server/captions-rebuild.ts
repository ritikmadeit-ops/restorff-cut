/**
 * Rebuilding a timeline's captions from its transcripts (or from the captions themselves), keeping every chunk's look
 * — the one rebuild that `captions`, `transcribe {action: edit}`, `autocut`, `revise` and the "take a pass" preset all
 * use (revise-safety agent, 2026-10-21; the code before this lived inside mcp/cut.ts, captions-v2 agent).
 *
 *   timelineCaptionWords(…)   spoken clips → words in timeline seconds (silence-clipped, the person's word fixes applied
 *                             — plus `extra` fixes not saved yet, so a revise dry run shows a transcript fix without
 *                             saving it)
 *   rebuildCaptionsCore(…)    the caption document → re-chunked from the words (looks kept word by word) → built,
 *                             measured, placed, tagged; nothing committed
 *   rebuildFromDoc(…)         the same build from the chunks already there (a restyle: no transcript needed)
 *   resolveWordFixes(…)       caption word fixes (timeline seconds) → transcript edits per media file (source seconds)
 *   applyLookChanges(…)       a restyle written into the chunks' looks over a span (so every later rebuild keeps it)
 */
import {
	getCaptionStyle,
	lookAfterRestyle,
	type CaptionDocChunk,
	type TextStyle,
	type TimedWord,
} from "@restorffcut/timeline-ops";
import type { ProjectSnapshot, SnapshotElement } from "@/sync/snapshot";
import type { WordFix } from "./caption-words";
import { listProjectMedia, type MediaDto } from "./media";
import {
	applyTranscriptEdits,
	clipWordsToSilences,
	detectSilences,
	findTranscript,
	resolveMediaFile,
	type MediaFile,
	type TranscriptEdit,
	type TranscriptRecord,
} from "./transcripts";
import {
	applyOverrides,
	buildCaptions,
	carryTimelineFixes,
	chunksOutside,
	clipWindow,
	clipWordsOnTimeline,
	mergeDocs,
	mergeWords,
	rateOf,
	readCaptionDoc,
	rechunk,
	spokenClips,
	type BuiltCaptions,
	type LookOverrides,
	type ReadChunk,
} from "./transcripts-timeline";

const T = 120_000;
const r3 = (value: number) => Math.round(value * 1000) / 1000;

/** Media files of the project on the server, listed once per call. */
export async function mediaIndex(timelineId: string): Promise<MediaDto[]> {
	return listProjectMedia(timelineId);
}

/** Transcript words of a media file, clipped to its measured silences (Whisper stretches words over pauses). */
export async function silenceClippedWords(media: MediaFile, record: TranscriptRecord, silence: number, signal?: AbortSignal) {
	const silences = await detectSilences(media, { minSeconds: silence }, signal).catch(() => []);
	const clipped = clipWordsToSilences(record.words, silences);
	return { words: clipped.words, clipped: clipped.clipped, silences: silences.length };
}

/** Fixes not saved yet, by media hash (a revise plan's transcript edit before its commit). */
export type ExtraEdits = Record<string, TranscriptEdit[]>;

/**
 * Words for captions on the whole timeline from server transcripts (with the person's word fixes): every spoken clip
 * whose media has one (silence-clipped words), plus the ranges they cover and the media without a transcript.
 */
export async function timelineCaptionWords(timelineId: string, clips: Array<{ element: SnapshotElement }>, signal?: AbortSignal, extra: ExtraEdits = {}) {
	const listed = await mediaIndex(timelineId);
	const lists: TimedWord[][] = [];
	const ranges: Array<{ start: number; end: number }> = [];
	const missing = new Set<string>();
	const cache = new Map<string, TimedWord[] | null>();
	const fixes = new Map<string, number>();
	for (const { element } of clips) {
		const mediaId = element.mediaId as string;
		if (!cache.has(mediaId)) {
			let words: TimedWord[] | null = null;
			try {
				const media = await resolveMediaFile(timelineId, mediaId, listed);
				const record = findTranscript(media.hash, extra[media.hash]?.length ? { extra: extra[media.hash] } : {});
				if (record) {
					words = (await silenceClippedWords(media, record, 0.35, signal)).words;
					const applied = (record.edits ?? []).filter((edit) => edit.matched.length).length;
					if (applied) fixes.set(mediaId, applied);
				}
			} catch {
				words = null;
			}
			cache.set(mediaId, words);
		}
		const words = cache.get(mediaId);
		if (!words) {
			missing.add(mediaId);
			continue;
		}
		lists.push(clipWordsOnTimeline(element, words));
		const w = clipWindow(element);
		ranges.push({ start: w.start, end: w.end });
	}
	return { words: mergeWords(lists), ranges, missing: [...missing], fixes: Object.fromEntries(fixes) };
}

/**
 * The caption document of `before`, moved onto `after`'s timeline (after a cut): each chunk follows the source
 * moment it showed (same media, a clip of `after` that still plays it). Chunks whose moment was cut out are dropped.
 */
export function remapDoc(doc: ReadChunk[], before: ProjectSnapshot, after: ProjectSnapshot): ReadChunk[] {
	const beforeClips = spokenClips(before);
	const afterClips = spokenClips(after);
	const out: ReadChunk[] = [];
	for (const chunk of doc) {
		const middle = (chunk.start + chunk.end) / 2;
		const clip = beforeClips.find(({ element }) => element.startTime / T <= middle && middle < (element.startTime + element.duration) / T);
		if (!clip) {
			out.push(chunk);
			continue;
		}
		const w = clipWindow(clip.element);
		const source = w.in + (middle - w.start) * rateOf(clip.element);
		const target = afterClips.find(({ element }) => {
			if (element.mediaId !== clip.element.mediaId) return false;
			const a = clipWindow(element);
			return source >= a.in - 1e-6 && source < a.out + 1e-6;
		});
		if (!target) continue;
		const a = clipWindow(target.element);
		const shift = a.start + (source - a.in) / rateOf(target.element) - middle;
		out.push({ ...chunk, start: chunk.start + shift, end: chunk.end + shift, words: chunk.words.map((word) => ({ ...word, start: word.start + shift, end: word.end + shift })) });
	}
	return out;
}

export type RebuildOutcome = { ok: true; built: BuiltCaptions; kept: number; carried: number; missing: string[]; fixes_used: Record<string, number> } | { ok: false; conflicts: unknown[] };

/** A restyle over a span, written into each chunk's look (the reducer's set_caption_style does the same). */
export interface LookChange {
	overrides?: LookOverrides;
	/** TextStyle keys (font, size, color, weight, bg…, y) recorded with lookAfterRestyle. */
	restyle?: TextStyle;
	/** Timeline seconds; chunks whose middle is inside change (none = every chunk). */
	span?: { t0: number; t1: number } | null;
}

export function applyLookChanges<C extends CaptionDocChunk>(doc: readonly C[], change: LookChange, canvas: { width: number; height: number }): C[] {
	return doc.map((chunk) => {
		const middle = (chunk.start + chunk.end) / 2;
		if (change.span && (middle < change.span.t0 - 1e-6 || middle >= change.span.t1 - 1e-6)) return chunk;
		let look = chunk.look ? { ...chunk.look } : {};
		if (change.overrides) look = applyOverrides(look, change.overrides);
		if (change.restyle && Object.keys(change.restyle).length) look = lookAfterRestyle(look, change.restyle, canvas);
		return { ...chunk, look };
	});
}

/** Rebuild the timeline's captions from the transcripts, keeping every chunk's look (after a cut or a word fix). */
export async function rebuildCaptionsCore({
	timelineId,
	snapshot,
	before,
	seed,
	signal,
	extra,
	look,
}: {
	timelineId: string;
	snapshot: ProjectSnapshot;
	/** The timeline before a cut (the caption document is read there and moved through the cut). */
	before?: ProjectSnapshot;
	seed: string;
	signal?: AbortSignal;
	/** Transcript fixes not saved yet (by media hash). */
	extra?: ExtraEdits;
	/** Restyles to write into the looks first (in order). */
	look?: LookChange | LookChange[];
}): Promise<RebuildOutcome> {
	const read = readCaptionDoc(before ?? snapshot);
	const canvas = { width: snapshot.settings?.canvasSize?.width ?? 1080, height: snapshot.settings?.canvasSize?.height ?? 1920 };
	let existing = before ? remapDoc(read.doc, before, snapshot) : read.doc;
	for (const change of look ? (Array.isArray(look) ? look : [look]) : []) existing = applyLookChanges(existing, change, canvas);
	const style = getCaptionStyle(read.styleId ?? undefined);
	const clips = spokenClips(snapshot);
	const words = await timelineCaptionWords(timelineId, clips, signal, extra ?? {});
	const carried = carryTimelineFixes(words.words, existing);
	const fresh = rechunk({ words: carried.words, existing, style });
	const kept = chunksOutside(existing, words.ranges);
	const doc = mergeDocs(fresh, kept);
	const faces = doc.some((chunk) => (chunk.look?.zone ?? "auto") === "auto") ? { projectId: timelineId } : null;
	const built = await buildCaptions({ snapshot, doc, style, seed, signal, faces });
	if (!built.result.ok) return { ok: false, conflicts: built.result.conflicts.slice(0, 10) };
	return { ok: true, built, kept: kept.length, carried: carried.carried, missing: words.missing, fixes_used: words.fixes };
}

/** Rebuild the captions from the chunks already there (a restyle): same words, new looks, measured and placed again. */
export async function rebuildFromDoc({
	timelineId,
	snapshot,
	seed,
	signal,
	look,
}: {
	timelineId: string;
	snapshot: ProjectSnapshot;
	seed: string;
	signal?: AbortSignal;
	look?: LookChange | LookChange[];
}): Promise<RebuildOutcome> {
	const read = readCaptionDoc(snapshot);
	const canvas = { width: snapshot.settings?.canvasSize?.width ?? 1080, height: snapshot.settings?.canvasSize?.height ?? 1920 };
	let doc = read.doc;
	for (const change of look ? (Array.isArray(look) ? look : [look]) : []) doc = applyLookChanges(doc, change, canvas);
	const style = getCaptionStyle(read.styleId ?? undefined);
	const faces = doc.some((chunk) => (chunk.look?.zone ?? "auto") === "auto") ? { projectId: timelineId } : null;
	const built = await buildCaptions({ snapshot, doc, style, seed, signal, faces });
	if (!built.result.ok) return { ok: false, conflicts: built.result.conflicts.slice(0, 10) };
	return { ok: true, built, kept: doc.length, carried: 0, missing: [], fixes_used: {} };
}

// ─── word fixes → transcript edits ──────────────────────────────────────────────────────────────────────────────

export interface ResolvedFixes {
	/** Transcript edits per media hash (not saved). */
	extra: ExtraEdits;
	/** Media id per hash (for the answer). */
	media: Record<string, string>;
	resolved: Array<{ fix: WordFix; media_id: string; hash: string; edit: TranscriptEdit; source_t: number; matched_at_s: number[] }>;
	/** Fixes with no transcribed clip under them (or no match in its transcript). */
	unresolved: Array<{ fix: WordFix; why: string }>;
}

/**
 * Caption word fixes (timeline seconds) → transcript edits on the media that was transcribed under them (source
 * seconds through the clip: start, trim, speed). A fix whose words the transcript does not have there is unresolved.
 */
export async function resolveWordFixes(timelineId: string, snapshot: ProjectSnapshot, fixes: readonly WordFix[]): Promise<ResolvedFixes> {
	const out: ResolvedFixes = { extra: {}, media: {}, resolved: [], unresolved: [] };
	if (!fixes.length) return out;
	const listed = await mediaIndex(timelineId).catch(() => [] as MediaDto[]);
	const clips = spokenClips(snapshot);
	const now = new Date().toISOString();
	for (const fix of fixes) {
		const t = (fix.t + Math.min(fix.t_end, fix.t + 0.2)) / 2;
		const under = clips.filter(({ element }) => element.startTime / T <= t + 1e-6 && t < (element.startTime + element.duration) / T);
		let done = false;
		let why = under.length ? "the transcript under it does not have these words there" : "no clip with sound under these words";
		for (const { element } of under) {
			let media: MediaFile;
			try {
				media = await resolveMediaFile(timelineId, element.mediaId as string, listed);
			} catch {
				why = "the clip's media is not on the server";
				continue;
			}
			const record = findTranscript(media.hash, out.extra[media.hash]?.length ? { extra: out.extra[media.hash] } : {});
			if (!record) {
				why = "the clip under these words has no server transcript";
				continue;
			}
			const w = clipWindow(element);
			const sourceT = r3(w.in + (fix.t - w.start) * rateOf(element));
			const edit: TranscriptEdit = { from: fix.from, to: fix.to, source_t: sourceT, created_at: now };
			const trial = applyTranscriptEdits(record.words, [edit]);
			const hits = trial.report[0]?.matched ?? [];
			if (!hits.length) continue;
			out.extra[media.hash] = [...(out.extra[media.hash] ?? []), edit];
			out.media[media.hash] = element.mediaId as string;
			out.resolved.push({ fix, media_id: element.mediaId as string, hash: media.hash, edit, source_t: sourceT, matched_at_s: hits });
			done = true;
			break;
		}
		if (!done) out.unresolved.push({ fix, why });
	}
	return out;
}
