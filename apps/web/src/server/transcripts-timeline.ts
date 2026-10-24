/**
 * Transcripts on a timeline, server side (mcp-cut agent, 2026-10-20): which clips speak, their words in timeline
 * seconds, the caption document already on the timeline, and building captions in one of the caption styles — the
 * browser's captions/timeline-words.ts + captions/build.ts on a project snapshot instead of the live editor.
 *
 * Captions are built by @restorffcut/timeline-ops `buildCaptionOps` (the editor's own builder) with a measure from
 * ./transcripts-measure.ts, and tagged exactly like captions/build.ts tags them, so the editor's caption list reads
 * them back: tracks `restorff.captionLayer` = base | words | shadow, named CAPTIONS / CAPTION WORDS / CAPTION SHADOW
 * (key-word lanes "CAPTION WORDS 2" …); every element `restorff.captionLayer`; chunk elements `restorff.role =
 * "caption"` and `restorff.caption = {style, words (seconds relative to the element), look?}`.
 *
 * captions-v2 (2026-10-20, docs/restorff/worklog/captions-v2.md):
 * - every chunk carries its own look (`restorff.caption.look`: size / scale, case, key words, accent, zone, words per
 *   chunk) — a span can be restyled, and every rebuild (autocut, a transcript fix, another captions call) keeps it;
 * - re-chunking from the transcript keeps the looks of the chunks the words were in, and keeps text a person changed on
 *   the timeline (`set content`) — a rebuild never undoes a fix;
 * - zone "auto" (the default) places each shot's captions clear of the face (./transcripts-zones.ts);
 * - the safe-area report is the export gate's own SAFE geometry (packages/gate textBox + safeArea) with the builder's
 *   Chromium measure (./transcripts-measure.ts textBoxOf) — one measure for both;
 * - the caption lanes stay where they were in the track list; the key-word style's blur-in is added as a `blur`
 *   effect with an animated intensity (ops@1 has no op for effects).
 */
import { safeArea as gateSafeArea, textBox as gateTextBox, type GateElement } from "@restorffcut/gate";
import {
	apply,
	buildCaptionOps,
	CAPTION_SAFE_AREA,
	captionWordText,
	chunkWordGroups,
	editChunkText,
	getCaptionStyle,
	resolveCaptionLook,
	scaleSafeArea,
	TICKS_PER_SECOND,
	type ApplyResult,
	type CaptionBuild,
	type CaptionCase,
	type CaptionDocChunk,
	type CaptionLook,
	type CaptionStylePreset,
	type Op,
	type Project as OpsProject,
	type TimedWord,
} from "@restorffcut/timeline-ops";
import type { ProjectSnapshot, SnapshotElement, SnapshotScene, SnapshotTrack } from "@/sync/snapshot";
import { projectMediaRecord, startMatteJob } from "./matte";
import { prepareMeasure, recordingMeasure, textBoxOf, type MeasureReport } from "./transcripts-measure";
import { footageAt, keepOutForPieces, placeClearOf } from "./transcripts-zones";

const T = TICKS_PER_SECOND;
const sec = (ticks: number) => ticks / T;
const r3 = (value: number) => Math.round(value * 1000) / 1000;

export type CaptionLayer = "base" | "words" | "shadow";
type Tagged = {
	restorff?: { role?: string; captionLayer?: CaptionLayer; caption?: { style: string; words: TimedWord[]; look?: CaptionLook }; [key: string]: unknown };
};

// ─── scene + elements ────────────────────────────────────────────────────────────────────────────────────────

export function activeScene(snapshot: ProjectSnapshot): SnapshotScene | null {
	const scenes = snapshot.scenes ?? [];
	return scenes.find((scene) => scene.id === snapshot.currentSceneId) ?? scenes.find((scene) => scene.isMain) ?? scenes[0] ?? null;
}

export function sceneTracks(scene: SnapshotScene | null): Array<{ group: "overlay" | "main" | "audio"; track: SnapshotTrack }> {
	if (!scene?.tracks) return [];
	return [
		...(scene.tracks.overlay ?? []).map((track) => ({ group: "overlay" as const, track })),
		...(scene.tracks.main ? [{ group: "main" as const, track: scene.tracks.main }] : []),
		...(scene.tracks.audio ?? []).map((track) => ({ group: "audio" as const, track })),
	];
}

export function findElement(snapshot: ProjectSnapshot, elementId: string): { track: SnapshotTrack; group: string; element: SnapshotElement } | null {
	for (const { track, group } of sceneTracks(activeScene(snapshot))) {
		const element = (track.elements ?? []).find((candidate) => candidate.id === elementId);
		if (element) return { track, group, element };
	}
	return null;
}

export const rateOf = (element: SnapshotElement) => {
	const retime = element.retime as { rate?: number } | undefined;
	return typeof retime?.rate === "number" && retime.rate > 0 ? retime.rate : 1;
};

/** A clip's window: source seconds [in, out) and its timeline start (captions/timeline-words.ts clipSourceWindow). */
export function clipWindow(element: SnapshotElement): { in: number; out: number; start: number; end: number } {
	const rate = rateOf(element);
	const sourceIn = sec(element.trimStart ?? 0);
	return {
		in: sourceIn,
		out: sourceIn + sec(element.duration) * rate,
		start: sec(element.startTime),
		end: sec(element.startTime + element.duration),
	};
}

/** Clips that can carry speech: video with its sound on, uploaded audio (captions/timeline-words.ts listSpokenClips). */
export function spokenClips(snapshot: ProjectSnapshot): Array<{ element: SnapshotElement; track: SnapshotTrack; group: string }> {
	const clips: Array<{ element: SnapshotElement; track: SnapshotTrack; group: string }> = [];
	for (const { track, group } of sceneTracks(activeScene(snapshot))) {
		for (const element of track.elements ?? []) {
			const params = (element.params ?? {}) as Record<string, unknown>;
			if (!element.mediaId || params.muted === true) continue;
			if (element.type === "video" && element.isSourceAudioEnabled !== false) clips.push({ element, track, group });
			else if (element.type === "audio" && element.sourceType === "upload") clips.push({ element, track, group });
		}
	}
	return clips.sort((a, b) => a.element.startTime - b.element.startTime);
}

/** The words of one clip on the timeline: a word belongs to the clip when its middle is inside the clip's window. */
export function clipWordsOnTimeline(element: SnapshotElement, words: readonly TimedWord[]): TimedWord[] {
	const rate = rateOf(element);
	const w = clipWindow(element);
	const toTimeline = (source: number) => w.start + (source - w.in) / rate;
	const out: TimedWord[] = [];
	for (const word of words) {
		const middle = (word.start + word.end) / 2;
		if (middle < w.in || middle >= w.out) continue;
		const start = Math.max(w.start, toTimeline(word.start));
		const end = Math.min(w.end, toTimeline(word.end));
		if (end > start) out.push({ text: word.text, start: r3(start), end: r3(end) });
	}
	return out;
}

/** Words of several clips merged in time order; a word said twice at the same moment (video + its audio) once. */
export function mergeWords(lists: TimedWord[][]): TimedWord[] {
	const words = lists.flat().sort((a, b) => a.start - b.start);
	const unique: TimedWord[] = [];
	for (const word of words) {
		const previous = unique[unique.length - 1];
		if (previous && previous.text === word.text && Math.abs(previous.start - word.start) < 0.03) continue;
		unique.push(word);
	}
	return unique;
}

// ─── the caption document already on the timeline (captions/build.ts readCaptionDoc) ─────────────────────────

/** CAPTIONS, CAPTION WORDS, CAPTION SHADOW and the key-word lanes "CAPTION WORDS 2" … */
const LAYER_NAME = /^CAPTION(S| WORDS| SHADOW)( \d+)?$/i;

export function findCaptionTracks(snapshot: ProjectSnapshot): SnapshotTrack[] {
	const overlay = activeScene(snapshot)?.tracks?.overlay ?? [];
	return overlay.filter((track) => {
		if (track.type !== "text") return false;
		const tag = (track as Tagged).restorff;
		return Boolean(tag?.captionLayer) || tag?.role === "caption" || LAYER_NAME.test(String(track.name ?? ""));
	});
}

/** A chunk read back from the timeline; `edited` = its text was changed on the timeline (not from the transcript). */
export type ReadChunk = CaptionDocChunk & { edited?: boolean };

const plainText = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, "")
		.replace(/\s+/g, " ")
		.trim();

export function readCaptionDoc(snapshot: ProjectSnapshot): { doc: ReadChunk[]; styleId: string | null; tracks: number; edited: number; lane: number | null } {
	const tracks = findCaptionTracks(snapshot);
	const overlay = activeScene(snapshot)?.tracks?.overlay ?? [];
	const lanes = tracks.map((track) => overlay.indexOf(track)).filter((index) => index >= 0);
	const lane = lanes.length ? Math.min(...lanes) : null;
	const base =
		tracks.find((track) => (track as Tagged).restorff?.captionLayer === "base") ??
		tracks.find((track) => {
			const name = String(track.name ?? "").toUpperCase();
			return !(track as Tagged).restorff?.captionLayer && /^CAPTIONS?( \d+)?$/.test(name);
		});
	if (!base) return { doc: [], styleId: null, tracks: tracks.length, edited: 0, lane };
	let styleId: string | null = null;
	let edited = 0;
	const elements = [...(base.elements ?? [])].sort((a, b) => a.startTime - b.startTime);
	const doc = elements.map((element): ReadChunk => {
		const start = sec(element.startTime);
		const end = start + sec(element.duration);
		const tag = (element as Tagged).restorff?.caption;
		if (tag && !styleId) styleId = tag.style;
		const content = String((element.params as Record<string, unknown> | undefined)?.content ?? "");
		const look: CaptionLook | undefined = tag ? { ...(tag.look ?? {}), ...(tag.style ? { style: tag.style } : {}) } : undefined;
		let words: TimedWord[];
		let changed = false;
		if (tag?.words?.length) {
			words = tag.words.map((word) => ({ text: word.text, start: start + word.start, end: start + word.end }));
			// text changed on the timeline (`set content`): the person's words win over the tag's
			const shown = resolveCaptionLook(getCaptionStyle(tag.style), tag.look);
			const display = words.map((word) => captionWordText(word.text, shown)).filter(Boolean).join(" ");
			if (content.trim() && plainText(display) !== plainText(content)) {
				words = editChunkText([{ start, end, words }], 0, content)[0]?.words ?? words;
				changed = true;
				edited++;
			}
		} else {
			const tokens = content.trim().split(/\s+/).filter(Boolean);
			const letters = tokens.reduce((sum, token) => sum + token.length + 1, 0) || 1;
			let cursor = start;
			words = tokens.map((token) => {
				const span = ((end - start) * (token.length + 1)) / letters;
				const word = { text: token, start: cursor, end: cursor + span };
				cursor += span;
				return word;
			});
		}
		return { start, end, words, ...(look && Object.keys(look).length ? { look } : {}), ...(changed ? { edited: true } : {}) };
	});
	return { doc: doc.filter((chunk) => chunk.words.length && chunk.end > chunk.start), styleId, tracks: tracks.length, edited, lane };
}

// ─── looks: what a captions call changes, per span ───────────────────────────────────────────────────────────

/** Where the caption sits: a fraction of the safe area's height (0 top … 1 bottom). `style` = the style's own. */
export const CAPTION_ZONES = { top: 0.1, upper: 0.3, middle: 0.5, lower: 0.72, bottom: 0.94 } as const;
/** "auto" (the default) = the style's own line, moved clear of the face when the clip has a face track. */
export type CaptionZone = keyof typeof CAPTION_ZONES | "style" | "auto";

/** What one captions call asks to change (only the fields given). */
export interface LookOverrides {
	/** A style resets the look of the chunks it touches (their zone stays). */
	style?: string;
	size?: { absolute: number } | { relative: number };
	case?: CaptionCase;
	keys?: string[] | "auto";
	key_color?: string;
	key_scale?: number;
	color?: string;
	zone?: CaptionZone;
	max_words?: number;
	blur_in?: boolean;
}

const r4 = (value: number) => Math.round(value * 10_000) / 10_000;

export function applyOverrides(look: CaptionLook, overrides: LookOverrides): CaptionLook {
	const next: CaptionLook = overrides.style ? { style: overrides.style, ...(look.zone ? { zone: look.zone } : {}) } : { ...look };
	if (overrides.size) {
		if ("absolute" in overrides.size) {
			next.size = overrides.size.absolute;
			delete next.scale;
		} else if (typeof next.size === "number") {
			next.size = r4(next.size * overrides.size.relative);
		} else {
			next.scale = r4((next.scale ?? 1) * overrides.size.relative);
		}
	}
	if (overrides.case !== undefined) next.case = overrides.case;
	if (overrides.keys !== undefined) next.keys = overrides.keys;
	if (overrides.key_color !== undefined) next.key_color = overrides.key_color;
	if (overrides.key_scale !== undefined) next.key_scale = overrides.key_scale;
	if (overrides.color !== undefined) next.color = overrides.color;
	if (overrides.zone !== undefined) next.zone = overrides.zone;
	if (overrides.max_words !== undefined) next.max_words = overrides.max_words;
	if (overrides.blur_in !== undefined) next.blur_in = overrides.blur_in;
	return next;
}

const lookKey = (look: CaptionLook) =>
	JSON.stringify(
		Object.keys(look)
			.sort()
			.map((key) => [key, (look as Record<string, unknown>)[key]]),
	);

/**
 * Words (timeline seconds) → chunks with looks. Each word takes the look of the chunk it was in on the timeline
 * (`existing`), then the call's `overrides` when it lies in `span` (or always without a span). Words with one look are
 * chunked together (that look's words per chunk); a look change always starts a new chunk.
 */
export function rechunk({
	words,
	existing,
	overrides,
	span,
	style,
}: {
	words: readonly TimedWord[];
	existing: readonly CaptionDocChunk[];
	overrides?: LookOverrides;
	span?: { t0: number; t1: number } | null;
	style: CaptionStylePreset;
}): CaptionDocChunk[] {
	const lookAt = (word: TimedWord): CaptionLook => {
		const middle = (word.start + word.end) / 2;
		const chunk = existing.find((candidate) => middle >= candidate.start - 1e-6 && middle < candidate.end + 1e-6);
		if (chunk) return chunk.look ? { ...chunk.look } : {};
		// revise-safety: a word no chunk holds (its chunk was deleted, or a fix brought it back) takes the look of the
		// nearest chunk within 3 s — else it fell back to the style's defaults and the span ended up with mixed sizes
		// (warm-moody-oat: the words of six deleted chunks came back at size 4 among 12s and 17s)
		let near: CaptionDocChunk | null = null;
		let gap = 3;
		for (const candidate of existing) {
			const distance = middle < candidate.start ? candidate.start - middle : middle - candidate.end;
			if (distance < gap) {
				gap = distance;
				near = candidate;
			}
		}
		return near?.look ? { ...near.look } : {};
	};
	const inSpan = (word: TimedWord) => {
		if (!span) return true;
		const middle = (word.start + word.end) / 2;
		return middle >= span.t0 - 1e-6 && middle < span.t1 - 1e-6;
	};
	const runs: Array<{ key: string; look: CaptionLook; words: TimedWord[] }> = [];
	for (const word of words) {
		let look = lookAt(word);
		if (overrides && inSpan(word)) look = applyOverrides(look, overrides);
		const key = lookKey(look);
		const last = runs[runs.length - 1];
		if (last && last.key === key) last.words.push(word);
		else runs.push({ key, look, words: [word] });
	}
	const chunks: CaptionDocChunk[] = runs.flatMap((run) =>
		chunkWordGroups(run.words, { maxWords: resolveCaptionLook(style, run.look).maxWords }).map((chunk) => (Object.keys(run.look).length ? { ...chunk, look: run.look } : chunk)),
	);
	// bridge short pauses across look changes too (never overlap the next chunk)
	for (let i = 0; i < chunks.length - 1; i++) {
		const next = chunks[i + 1];
		if (next.start - chunks[i].end <= 0.3) chunks[i].end = next.start;
		if (chunks[i].end > next.start) chunks[i].end = next.start;
	}
	return chunks.filter((chunk) => chunk.end > chunk.start);
}

/**
 * Text a person changed on the timeline (`set content` on a caption) is kept when the captions are rebuilt from the
 * transcript: the fresh words inside such a chunk take its words (one for one when the counts match, else the chunk's
 * words replace them). Prefer `transcribe {action: "edit"}`, which fixes the transcript itself.
 */
export function carryTimelineFixes(words: readonly TimedWord[], existing: readonly ReadChunk[]): { words: TimedWord[]; carried: number } {
	let out = words.map((word) => ({ ...word }));
	let carried = 0;
	for (const chunk of existing) {
		if (!chunk.edited) continue;
		const inside = out.map((word, i) => ({ word, i })).filter(({ word }) => {
			const middle = (word.start + word.end) / 2;
			return middle >= chunk.start - 1e-6 && middle < chunk.end + 1e-6;
		});
		if (!inside.length) continue;
		if (inside.length === chunk.words.length) {
			inside.forEach(({ i }, k) => {
				if (plainText(out[i].text) !== plainText(chunk.words[k].text)) {
					out[i] = { ...out[i], text: chunk.words[k].text };
					carried++;
				}
			});
		} else {
			const drop = new Set(inside.map(({ i }) => i));
			out = [...out.filter((_, i) => !drop.has(i)), ...chunk.words.map((word) => ({ ...word }))].sort((a, b) => a.start - b.start);
			carried += chunk.words.length;
		}
	}
	return { words: out, carried };
}

// ─── build captions ──────────────────────────────────────────────────────────────────────────────────────────

export interface PlacementReport {
	/** Chunks placed by the face-aware zone ("auto"). */
	face_aware: number;
	/** …of which moved off the style's line (below the chin / above the brow / least overlap). */
	moved: number;
	below: number;
	above: number;
	least_overlap: number;
	/** "auto" chunks over a clip without a face track. */
	no_face: number;
	/** media of video clips with no face track: run `cutout {action: "matte"}` on them to place by face. */
	media_without_faces: string[];
	/**
	 * revise-safety: of `no_face`, the chunks over a video clip with no face box, placed in the conservative top band
	 * (centre 15–30 % of the frame height) instead of the style's line (which can sit on the eyes in a close-up).
	 */
	fallback_top_band?: number;
	/** revise-safety: person matte jobs started (cached; at most 2 per build) for media without a face track. */
	matte_jobs?: Array<{ media_id: string; job_id?: string; state?: string; started?: boolean; error?: string }>;
}

/** The conservative zone for captions over a clip with no face box: the caption's centre in the top 15–30 % of the frame. */
export const NO_FACE_BAND = { top: 0.15, bottom: 0.3 } as const;

export interface BuiltCaptions {
	result: ApplyResult;
	build: CaptionBuild;
	snapshot: ProjectSnapshot;
	ops: Op[];
	measure: MeasureReport;
	removedTracks: number;
	outsideSafeArea: Array<{ index: number; text: string; why: string }>;
	/** The chunks as built (looks resolved, anchors set). */
	doc: CaptionDocChunk[];
	placement: PlacementReport;
	/** Elements given the blur-in effect. */
	blurIn: number;
	/** Overlay index of the caption lanes. */
	lane: number;
	/** revise-safety: chunks split in two because they were too wide for the safe area at their size. */
	split_to_fit?: number;
}

/** A named zone (or the style's own line) as the chunk's anchor; "auto" anchors are set after layout (by face). */
function withZoneAnchor(chunk: CaptionDocChunk): CaptionDocChunk {
	const zone = chunk.look?.zone;
	if (!chunk.look) return chunk;
	const { anchor: _old, ...look } = chunk.look;
	if (zone && zone in CAPTION_ZONES) return { ...chunk, look: { ...look, anchor: CAPTION_ZONES[zone as keyof typeof CAPTION_ZONES] } };
	return { ...chunk, look };
}

/** Every text the ops insert, with its font (for measuring the elements themselves, as the gate does). */
function insertTexts(ops: readonly Op[]): Array<{ text: string; font: { family: string; weight: "normal" | "bold"; italic: boolean } }> {
	const out: Array<{ text: string; font: { family: string; weight: "normal" | "bold"; italic: boolean } }> = [];
	for (const op of ops) {
		if (op.op !== "insert" || typeof op.text !== "string") continue;
		const style = op.style ?? {};
		out.push({ text: op.text, font: { family: style.font ?? "Arial", weight: style.weight ?? "normal", italic: style.italic ?? false } });
	}
	return out;
}

/**
 * Face-aware placement of the chunks whose zone is "auto" (or unset), with effects-v2's face model
 * (./transcripts-zones.ts keepOutForPieces → matte-face-span faceSpanOnCanvas + matte-placement keepOutOf): chunks
 * over the same media file (one set-up, all its pieces after a cut) share one line, the first clear of that take's
 * keep-out box over their span (./transcripts-zones.ts placeClearOf).
 */
async function placeOnFaces(
	projectId: string,
	snapshot: ProjectSnapshot,
	doc: CaptionDocChunk[],
	build: CaptionBuild,
	style: CaptionStylePreset,
	canvas: { width: number; height: number },
	startMattes = true,
): Promise<{ doc: CaptionDocChunk[]; report: PlacementReport; changed: boolean }> {
	const safe = scaleSafeArea(CAPTION_SAFE_AREA, canvas);
	const report: PlacementReport = { face_aware: 0, moved: 0, below: 0, above: 0, least_overlap: 0, no_face: 0, media_without_faces: [] };
	// group: media file → its pieces (clip id → chunk indexes)
	const groups = new Map<string, Map<string, { clip: SnapshotElement; indexes: number[] }>>();
	for (const layout of build.chunks) {
		const chunk = doc[layout.index];
		const zone = chunk?.look?.zone ?? "auto";
		if (!chunk || zone !== "auto") continue;
		const clip = footageAt(snapshot, (chunk.start + chunk.end) / 2);
		if (!clip) {
			report.no_face++;
			continue;
		}
		const media = String(clip.mediaId ?? clip.id);
		const pieces = groups.get(media) ?? new Map();
		const piece = pieces.get(clip.id) ?? { clip, indexes: [] };
		piece.indexes.push(layout.index);
		pieces.set(clip.id, piece);
		groups.set(media, pieces);
	}
	const anchors = new Map<number, number>();
	const layoutOf = new Map(build.chunks.map((layout) => [layout.index, layout]));
	for (const [media, pieces] of groups) {
		const all = [...pieces.values()].flatMap((piece) => piece.indexes);
		const keep = await keepOutForPieces(
			projectId,
			snapshot,
			[...pieces.values()].map((piece) => ({
				clip: piece.clip,
				from: Math.min(...piece.indexes.map((i) => doc[i].start)),
				to: Math.max(...piece.indexes.map((i) => doc[i].end)),
			})),
		);
		if (!keep.keepOut) {
			report.no_face += all.length;
			if (keep.missing) {
				report.media_without_faces.push(media);
				// revise-safety: no face box yet → the conservative top band (never the style's mid-frame line, which sat on
				// the eyes of the oat run's c02 close-up), and the clip's person matte started for the next build
				const layouts = all.map((i) => layoutOf.get(i)).filter((layout): layout is NonNullable<typeof layout> => !!layout);
				const halfHeight = Math.max(0, ...layouts.map((layout) => layout.halfHeight ?? 0));
				const lo = Math.max(safe.top, NO_FACE_BAND.top * canvas.height) + halfHeight;
				const hi = NO_FACE_BAND.bottom * canvas.height - halfHeight;
				const centre = hi >= lo ? Math.min(hi, Math.max(lo, ((NO_FACE_BAND.top + NO_FACE_BAND.bottom) / 2) * canvas.height)) : lo;
				const anchor = (centre - safe.top) / Math.max(1, safe.bottom - safe.top);
				for (const i of all) anchors.set(i, anchor);
				report.fallback_top_band = (report.fallback_top_band ?? 0) + all.length;
				if (startMattes && (report.matte_jobs?.length ?? 0) < 2) {
					const clipOfMedia = [...pieces.values()][0]?.clip;
					const mediaId = String(clipOfMedia?.mediaId ?? "");
					try {
						const record = mediaId ? await projectMediaRecord(projectId, mediaId) : null;
						if (record && record.mime.startsWith("video/")) {
							const answer = startMatteJob({ media: record });
							report.matte_jobs = [...(report.matte_jobs ?? []), { media_id: mediaId, job_id: answer.job.job_id, state: answer.job.state, started: answer.started }];
						}
					} catch (error) {
						report.matte_jobs = [...(report.matte_jobs ?? []), { media_id: mediaId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) }];
					}
				}
			}
			continue;
		}
		const layouts = all.map((i) => layoutOf.get(i)).filter((layout): layout is NonNullable<typeof layout> => !!layout);
		const halfHeight = Math.max(...layouts.map((layout) => layout.halfHeight ?? 0));
		const halfWidth = Math.max(...layouts.map((layout) => layout.width / 2));
		const first = resolveCaptionLook(style, doc[all[0]].look);
		const preferredY = safe.top + first.anchor * (safe.bottom - safe.top);
		const cx = canvas.width / 2 + (layouts[0]?.x ?? 0);
		// the keep-out box already carries its margin (keepOutOf: 2 % of the height): no extra padding here
		const placed = placeClearOf(keep.keepOut.band, { halfHeight, halfWidth, cx }, { top: safe.top, bottom: safe.bottom }, preferredY, 8, { top: 0, bottom: 0 });
		report.face_aware += all.length;
		if (placed.where !== "style") report.moved += all.length;
		if (placed.where === "below") report.below += all.length;
		if (placed.where === "above") report.above += all.length;
		if (placed.where === "least-overlap") report.least_overlap += all.length;
		const anchor = (placed.y - safe.top) / (safe.bottom - safe.top);
		for (const i of all) anchors.set(i, anchor);
	}
	if (!anchors.size) return { doc, report, changed: false };
	const next = doc.map((chunk, i) => (anchors.has(i) ? { ...chunk, look: { ...(chunk.look ?? {}), anchor: anchors.get(i) as number } } : chunk));
	return { doc: next, report, changed: true };
}

/**
 * Replace every caption track with captions from `doc` (each chunk in its look over `style`; one batch: remove_track ×
 * old + buildCaptionOps), apply on the snapshot, tag the result like the editor does, add the blur-ins. Nothing is
 * committed here.
 */
export async function buildCaptions({
	snapshot,
	doc: input,
	style,
	seed,
	author = "claude",
	measureMethod,
	signal,
	faces,
}: {
	snapshot: ProjectSnapshot;
	doc: CaptionDocChunk[];
	style: CaptionStylePreset;
	seed: string;
	author?: "claude" | "compiler" | "user";
	measureMethod?: "chromium" | "estimate";
	signal?: AbortSignal;
	/** The timeline whose clips' face tracks place zone "auto" chunks (the default); null/omitted = the style's own line. */
	faces?: { projectId: string; /** start the person matte of face-less clips (default true, at most 2) */ startMattes?: boolean } | null;
}): Promise<BuiltCaptions> {
	const canvas = {
		width: snapshot.settings?.canvasSize?.width ?? 1080,
		height: snapshot.settings?.canvasSize?.height ?? 1920,
	};
	const old = findCaptionTracks(snapshot);
	const overlay = activeScene(snapshot)?.tracks?.overlay ?? [];
	const lanes = old.map((track) => overlay.indexOf(track)).filter((index) => index >= 0);
	const lane = lanes.length ? Math.min(...lanes) : 0;
	let doc = input.map((chunk) => withZoneAnchor(chunk));
	const options = { style, canvas, lineHeight: 1.2, author, refPrefix: "cap", wholeSizes: true, trackIndex: lane } as const;

	// pass 1 writes down every string the layout measures; Chromium measures exactly those (plus the inserted texts)
	const recorder = recordingMeasure(canvas.height);
	const draft = buildCaptionOps({ ...options, chunks: doc, measure: recorder.measure });
	let { measure, report } = await prepareMeasure([...recorder.strings(), ...insertTexts(draft.ops)], canvas.height, { method: measureMethod });
	if (signal?.aborted) throw new Error("stopped");
	let build = buildCaptionOps({ ...options, chunks: doc, measure });

	// revise-safety: a chunk too wide for the safe area is split in two at its own size instead of shrunk — a shrunk
	// chunk is a second size inside its span (the oat run's 12 among 17s); a single word that is too wide still shrinks
	let splitToFit = 0;
	for (let pass = 0; pass < 2; pass++) {
		const wide = new Set(build.chunks.filter((layout) => layout.shrunk && (doc[layout.index]?.words.length ?? 0) > 1).map((layout) => layout.index));
		if (!wide.size) break;
		doc = doc.flatMap((chunk, i) => (wide.has(i) ? splitChunk(chunk) : [chunk]));
		splitToFit += wide.size;
		const again = recordingMeasure(canvas.height);
		const redraft = buildCaptionOps({ ...options, chunks: doc, measure: again.measure });
		({ measure, report } = await prepareMeasure([...again.strings(), ...insertTexts(redraft.ops)], canvas.height, { method: measureMethod }));
		if (signal?.aborted) throw new Error("stopped");
		build = buildCaptionOps({ ...options, chunks: doc, measure });
	}

	let placement: PlacementReport = { face_aware: 0, moved: 0, below: 0, above: 0, least_overlap: 0, no_face: 0, media_without_faces: [] };
	if (faces) {
		const placed = await placeOnFaces(faces.projectId, snapshot, doc, build, style, canvas, faces.startMattes !== false);
		placement = placed.report;
		if (placed.changed) {
			doc = placed.doc;
			build = buildCaptionOps({ ...options, chunks: doc, measure });
		}
	} else {
		placement.no_face = doc.filter((chunk) => (chunk.look?.zone ?? "auto") === "auto").length;
	}

	const ops: Op[] = [...old.map((track) => ({ op: "remove_track" as const, author, track: track.id })), ...build.ops];
	const result = apply(snapshot as unknown as OpsProject, ops, { seed, at: new Date().toISOString() });
	let tagged = snapshot;
	let blurred = 0;
	if (result.ok) {
		tagged = tagCaptions(result.project as unknown as ProjectSnapshot, result, build, doc, style);
		blurred = addBlurIn(tagged, result, build);
	}
	return {
		result,
		build,
		snapshot: tagged,
		ops: result.ok ? (result.changes.applied as Op[]) : ops,
		measure: report,
		removedTracks: old.length,
		outsideSafeArea: result.ok ? checkSafeArea(tagged, canvas, measure) : [],
		doc,
		placement,
		blurIn: blurred,
		lane,
		split_to_fit: splitToFit,
	};
}

/** Split a chunk in two (after punctuation near its middle when there is one); both halves keep its look. */
export function splitChunk(chunk: CaptionDocChunk): CaptionDocChunk[] {
	const n = chunk.words.length;
	if (n < 2) return [chunk];
	let cut = Math.ceil(n / 2);
	for (const shift of [0, -1, 1]) {
		const k = Math.ceil(n / 2) + shift;
		if (k > 0 && k < n && /[.,!?;:]$/.test(chunk.words[k - 1]?.text.trim() ?? "")) {
			cut = k;
			break;
		}
	}
	const a = chunk.words.slice(0, cut);
	const b = chunk.words.slice(cut);
	const middle = b[0]?.start ?? chunk.end;
	return [
		{ ...chunk, start: chunk.start, end: middle, words: a },
		{ ...chunk, start: middle, end: chunk.end, words: b },
	];
}

/** The look stored on a chunk: without its computed anchor (a rebuild re-places it) and without the style (own field). */
function storedLook(look: CaptionLook | undefined): CaptionLook | undefined {
	if (!look) return undefined;
	const { anchor: _anchor, style: _style, ...rest } = look;
	return Object.keys(rest).length ? rest : undefined;
}

function tagCaptions(snapshot: ProjectSnapshot, result: ApplyResult, build: CaptionBuild, doc: CaptionDocChunk[], style: CaptionStylePreset): ProjectSnapshot {
	const refs = result.changes.refs;
	const layerOf = new Map<string, CaptionLayer>();
	layerOf.set(refs[build.tracks.base], "base");
	for (const ref of build.tracks.wordSlots ?? (build.tracks.words ? [build.tracks.words] : [])) layerOf.set(refs[ref], "words");
	for (const ref of build.tracks.shadowSlots ?? (build.tracks.shadow ? [build.tracks.shadow] : [])) layerOf.set(refs[ref], "shadow");
	const tagOf = new Map<string, { style: string; words: TimedWord[]; look?: CaptionLook; shrunk?: boolean }>();
	for (const layout of build.chunks) {
		const id = refs[layout.ref];
		const chunk = doc[layout.index];
		if (!id || !chunk) continue;
		const look = storedLook(chunk.look);
		tagOf.set(id, {
			style: layout.style ?? resolveCaptionLook(style, chunk.look).id,
			words: chunk.words.map((word) => ({ text: word.text, start: r3(Math.max(0, word.start - chunk.start)), end: r3(Math.max(0, word.end - chunk.start)) })),
			...(look ? { look } : {}),
			// revise-safety: drawn smaller than its look asks (one word too wide for the safe area) — captions measure says why
			...(layout.shrunk ? { shrunk: true } : {}),
		});
	}
	const scene = activeScene(snapshot);
	if (!scene?.tracks?.overlay) return snapshot;
	scene.tracks.overlay = scene.tracks.overlay.map((track) => {
		const layer = layerOf.get(track.id);
		if (!layer) return track;
		const current = (track as Tagged).restorff ?? {};
		return {
			...track,
			restorff: { ...current, captionLayer: layer },
			elements: (track.elements ?? []).map((element) => {
				const tag = (element as Tagged).restorff ?? {};
				const caption = tagOf.get(element.id);
				return {
					...element,
					restorff: { ...tag, captionLayer: layer, ...(layer === "base" ? { role: "caption" } : {}), ...(caption ? { caption } : {}) },
				};
			}),
		} as SnapshotTrack;
	});
	return snapshot;
}

/**
 * The key-word style's blur-in: a `blur` effect (effects/definitions/blur.ts, intensity 0-100) on each run, its
 * intensity keyed `from` → 0 over `dur` seconds (an effect param channel, `effects.<id>.params.intensity`). ops@1 has
 * no op for effects, so this edits the snapshot after the reducer, like the caption tags. Returns how many got one.
 */
const BLUR_REST = 0.05;

function addBlurIn(snapshot: ProjectSnapshot, result: ApplyResult, build: CaptionBuild): number {
	if (!build.blurIn?.length) return 0;
	const want = new Map<string, { from: number; dur: number }>();
	for (const entry of build.blurIn) {
		const id = result.changes.refs[entry.ref];
		if (id) want.set(id, { from: entry.from, dur: entry.dur });
	}
	let count = 0;
	for (const { track } of sceneTracks(activeScene(snapshot))) {
		track.elements = (track.elements ?? []).map((element) => {
			const blur = want.get(element.id);
			if (!blur) return element;
			count++;
			const effectId = `blurin-${element.id.slice(0, 8)}`;
			const end = Math.max(1, Math.min(element.duration, Math.round(blur.dur * T)));
			const path = `effects.${effectId}.params.intensity`;
			const animations = { ...((element.animations as Record<string, unknown> | undefined) ?? {}) };
			// rest at BLUR_REST, not 0: a blur at 0 builds no pass and the export throws "At least one effect pass is
			// required" (MEASURED 2026-10-20, render rmvh0uxryh77054); 0.05 is σ ≈ 0.006 px — invisible
			animations[path] = {
				keys: [
					{ id: `${effectId}-k0`, time: 0, value: blur.from, segmentToNext: "linear", tangentMode: "flat" },
					{ id: `${effectId}-k1`, time: end, value: BLUR_REST, segmentToNext: "linear", tangentMode: "flat" },
				],
			};
			const effects = [...(((element as { effects?: unknown[] }).effects as unknown[]) ?? []), { id: effectId, type: "blur", params: { intensity: BLUR_REST }, enabled: true }];
			return { ...element, effects, animations } as SnapshotElement;
		});
	}
	return count;
}

/**
 * Every caption element (all layers) against the caption safe area, with the export gate's own geometry (gate
 * textBox: transform applied; gate safeArea) and the builder's Chromium measure (textBoxOf). The gate measures the
 * same way when it is given `measureText` (gate-v2), so "0 outside" here is 0 SAFE findings there.
 */
function checkSafeArea(snapshot: ProjectSnapshot, canvas: { width: number; height: number }, measure: Parameters<typeof textBoxOf>[2]) {
	const area = gateSafeArea(canvas);
	const out: Array<{ index: number; text: string; why: string }> = [];
	const tracks = findCaptionTracks(snapshot);
	const base = tracks.find((track) => (track as Tagged).restorff?.captionLayer === "base");
	const chunkStarts = (base?.elements ?? []).map((element) => element.startTime).sort((a, b) => a - b);
	for (const track of tracks) {
		for (const element of track.elements ?? []) {
			const params = (element.params ?? {}) as Record<string, unknown>;
			if (!String(params.content ?? "").trim()) continue;
			if (typeof params.opacity === "number" && params.opacity === 0) continue; // a hidden key-word carrier
			const box = gateTextBox(element as unknown as GateElement, canvas, (el) => textBoxOf((el.params ?? {}) as Record<string, unknown>, canvas.height, measure));
			const why: string[] = [];
			if (box.x0 < area.x0 - 0.5) why.push(`left edge ${Math.round(box.x0)} < ${Math.round(area.x0)}`);
			if (box.x1 > area.x1 + 0.5) why.push(`right edge ${Math.round(box.x1)} > ${Math.round(area.x1)}`);
			if (box.y0 < area.y0 - 0.5) why.push(`top ${Math.round(box.y0)} < ${Math.round(area.y0)}`);
			if (box.y1 > area.y1 + 0.5) why.push(`bottom ${Math.round(box.y1)} > ${Math.round(area.y1)}`);
			if (!why.length) continue;
			let index = 0;
			while (index + 1 < chunkStarts.length && chunkStarts[index + 1] <= element.startTime) index++;
			out.push({ index, text: `${String(params.content)} (${track.name})`, why: why.join(", ") });
		}
	}
	return out;
}

/** Group words into chunks (timeline-ops chunkWordGroups: 1-5 words, breaks on punctuation and pauses > 0.3 s). */
export function chunkDoc(words: TimedWord[], maxWords: number): CaptionDocChunk[] {
	return chunkWordGroups(words, { maxWords });
}

/** Existing chunks that lie wholly outside every given time range (they are kept when only those ranges are rebuilt). */
export function chunksOutside<C extends CaptionDocChunk>(doc: C[], ranges: Array<{ start: number; end: number }>): C[] {
	return doc.filter((chunk) => ranges.every((range) => chunk.end <= range.start + 1e-6 || chunk.start >= range.end - 1e-6));
}

/** Merge two caption documents by time; a chunk that overlaps an earlier one is dropped (never two at once). */
export function mergeDocs(a: CaptionDocChunk[], b: CaptionDocChunk[]): CaptionDocChunk[] {
	const all = [...a, ...b].sort((x, y) => x.start - y.start);
	const out: CaptionDocChunk[] = [];
	for (const chunk of all) {
		const previous = out[out.length - 1];
		if (previous && chunk.start < previous.end - 1e-6) continue;
		out.push(chunk);
	}
	return out;
}
