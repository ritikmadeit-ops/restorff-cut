/**
 * Editing caption chunks the `captions` tool built, in place (revise-v2 agent, 2026-10-20; SUMMARY gap 3, warm-moody
 * REPORT §5 items 1, 2 and 9). Those captions are three layers — CAPTIONS (one text clip per chunk), CAPTION WORDS
 * (the spoken / highlighted words, placed by MEASURING the font) and CAPTION SHADOW — so a `set text` on the base clip
 * leaves the word layer spelling the old words at the old places ("andlClaudeuses", SEEN), and an `add_captions`
 * makes a second caption track. Here a chunk is rebuilt the way the builder made it: its three layers deleted and
 * built again by @restorffcut/timeline-ops `buildCaptionOps` (measured in headless Chromium, server/transcripts-
 * measure.ts), on the SAME tracks, in the chunk's own style and size — for a new text (edit_row caption, revise
 * "change the beat 3 caption to …") or a new look on a span (revise "make the second half moody").
 *
 * Captions that are plain text clips (no word layer) are edited with `set` ops by the planner instead.
 */
import {
	buildCaptionOps,
	CAPTION_SAFE_AREA,
	CAPTION_STYLE_PRESETS,
	editChunkText,
	getCaptionStyle,
	lookAfterRestyle,
	scaleSafeArea,
	type CaptionDocChunk,
	type CaptionLook,
	type CaptionStylePreset,
	type Op,
	type TextStyle,
	type TimedWord,
} from "@restorffcut/timeline-ops";
import type { ProjectSnapshot, SnapshotElement, SnapshotTrack } from "@/sync/snapshot";
import { prepareMeasure, type MeasureReport } from "./transcripts-measure";

const TICKS = 120_000;
const r3 = (value: number) => Math.round(value * 1000) / 1000;
type Layer = "base" | "words" | "shadow";
type Tagged = { restorff?: { captionLayer?: Layer; role?: string; caption?: { style?: string; words?: TimedWord[]; look?: CaptionLook } } & Record<string, unknown> };

export interface CaptionLayers {
	base: SnapshotTrack;
	words: SnapshotTrack | null;
	shadow: SnapshotTrack | null;
}

function overlayOf(snapshot: ProjectSnapshot): SnapshotTrack[] {
	const scenes = snapshot.scenes ?? [];
	const scene = scenes.find((s) => s.id === snapshot.currentSceneId) ?? scenes.find((s) => s.isMain) ?? scenes[0];
	return scene?.tracks?.overlay ?? [];
}

const layerOf = (track: SnapshotTrack): Layer | null => {
	const tag = (track as Tagged).restorff?.captionLayer;
	if (tag === "base" || tag === "words" || tag === "shadow") return tag;
	const name = String(track.name ?? "").toUpperCase();
	if (name === "CAPTION WORDS") return "words";
	if (name === "CAPTION SHADOW") return "shadow";
	return null;
};

/** The layered caption tracks, when the captions have a word or shadow layer (else null: plain text clips). */
export function captionLayers(snapshot: ProjectSnapshot): CaptionLayers | null {
	const overlay = overlayOf(snapshot);
	const words = overlay.find((track) => track.type === "text" && layerOf(track) === "words" && (track.elements ?? []).length > 0) ?? null;
	const shadow = overlay.find((track) => track.type === "text" && layerOf(track) === "shadow" && (track.elements ?? []).length > 0) ?? null;
	if (!words && !shadow) return null;
	const base =
		overlay.find((track) => track.type === "text" && layerOf(track) === "base") ??
		overlay.find((track) => track.type === "text" && ((track as Tagged).restorff?.role === "caption" || String(track.name ?? "").toUpperCase().startsWith("CAPTIONS")));
	return base ? { base, words, shadow } : null;
}

/** Is this caption element a chunk of layered captions (so text / look changes must rebuild its layers)? */
export function isLayeredChunk(snapshot: ProjectSnapshot, elementId: string): boolean {
	const layers = captionLayers(snapshot);
	return !!layers && (layers.base.elements ?? []).some((element) => element.id === elementId);
}

export interface ChunkChange {
	/** The chunk's base-layer element id. */
	id: string;
	/** New words for the chunk ("" removes it). */
	text?: string;
	/** A new look: TextStyle keys over the chunk's own (font, color, weight, bg…, size absolute, y). */
	style?: TextStyle;
	/** Size × this (after `style.size`). */
	sizeFactor?: number;
}

export interface ChunkRebuild {
	ops: Op[];
	/** Tags to put on the new elements after the batch runs (ref → restorff), like the captions tool tags them. */
	tags: Array<{ ref: string; restorff: Record<string, unknown> }>;
	measure: MeasureReport | null;
	chunks: Array<{ id: string; text: string; size: number; removed?: boolean }>;
	notes: string[];
}

const p = (element: SnapshotElement) => (element.params ?? {}) as Record<string, unknown>;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const strOf = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** The chunk's words in timeline seconds: the caption tag's words, else the text spread by letters. */
function chunkWords(element: SnapshotElement): TimedWord[] {
	const start = element.startTime / TICKS;
	const end = (element.startTime + element.duration) / TICKS;
	const tag = (element as Tagged).restorff?.caption;
	if (tag?.words?.length) return tag.words.map((word) => ({ text: word.text, start: r3(start + word.start), end: r3(start + word.end) }));
	const tokens = String(p(element).content ?? "").trim().split(/\s+/).filter(Boolean);
	const letters = tokens.reduce((sum, token) => sum + token.length + 1, 0) || 1;
	let cursor = start;
	return tokens.map((token) => {
		const span = ((end - start) * (token.length + 1)) / letters;
		const word = { text: token, start: r3(cursor), end: r3(cursor + span) };
		cursor += span;
		return word;
	});
}

/** The preset the chunk was built in: its tag, else the one whose layers match what is on the timeline. */
function presetOf(element: SnapshotElement, layers: CaptionLayers): CaptionStylePreset {
	const id = (element as Tagged).restorff?.caption?.style;
	if (id && CAPTION_STYLE_PRESETS.some((preset) => preset.id === id)) return getCaptionStyle(id);
	const wordEl = (layers.words?.elements ?? []).find((candidate) => candidate.startTime >= element.startTime && candidate.startTime < element.startTime + element.duration);
	const kind = !layers.words ? "none" : p(wordEl ?? element)["background.enabled"] === true ? "word-box" : "karaoke";
	return CAPTION_STYLE_PRESETS.find((preset) => preset.highlight.kind === kind && !!preset.shadow === !!layers.shadow) ?? getCaptionStyle(undefined);
}

/** The chunk's look as a TextStyle, read back from its params (what a restyle or a size change starts from). */
function lookOf(element: SnapshotElement, preset: CaptionStylePreset): TextStyle {
	const params = p(element);
	const look: TextStyle = { ...preset.base };
	const font = strOf(params.fontFamily);
	if (font) look.font = font;
	const size = num(params.fontSize);
	if (size) look.size = size;
	const color = strOf(params.color);
	if (color) look.color = color;
	if (params.fontWeight === "bold" || params.fontWeight === "normal") look.weight = params.fontWeight;
	if (typeof params["background.enabled"] === "boolean") look.bg = params["background.enabled"] as boolean;
	const bgColor = strOf(params["background.color"]);
	if (bgColor) look.bg_color = bgColor;
	const radius = num(params["background.cornerRadius"]);
	if (radius !== undefined) look.bg_radius = radius;
	const px = num(params["background.paddingX"]);
	if (px !== undefined) look.bg_padding_x = px;
	const py = num(params["background.paddingY"]);
	if (py !== undefined) look.bg_padding_y = py;
	const spacing = num(params.letterSpacing);
	if (spacing !== undefined) look.letter_spacing = spacing;
	return look;
}

/**
 * Plan the rebuild of some chunks (no commit, no apply): ops for one batch (delete the chunks' three layers, build them
 * again on the same tracks) + the tags to set afterwards. Measures every new string once in headless Chromium.
 */
export async function planChunkRebuild(snapshot: ProjectSnapshot, changes: ChunkChange[], opts: { author?: "claude" | "user"; measureMethod?: "chromium" | "estimate"; prefix?: string } = {}): Promise<ChunkRebuild | { error: string }> {
	const layers = captionLayers(snapshot);
	if (!layers) return { error: "these captions have no word or shadow layer: change them with set ops" };
	const author = opts.author ?? "claude";
	const prefix = opts.prefix ?? "rb";
	const canvas = { width: snapshot.settings?.canvasSize?.width ?? 1080, height: snapshot.settings?.canvasSize?.height ?? 1920 };
	const H = canvas.height;
	const safe = scaleSafeArea(CAPTION_SAFE_AREA, canvas);
	const notes: string[] = [];

	interface Prepared {
		element: SnapshotElement;
		chunk: CaptionDocChunk | null;
		style: CaptionStylePreset;
	}
	const prepared: Prepared[] = [];
	for (const change of changes) {
		const element = (layers.base.elements ?? []).find((candidate) => candidate.id === change.id);
		if (!element) return { error: `${change.id} is not a caption chunk on ${layers.base.name ?? "CAPTIONS"}` };
		const start = r3(element.startTime / TICKS);
		const end = r3((element.startTime + element.duration) / TICKS);
		let chunk: CaptionDocChunk | null = { start, end, words: chunkWords(element) };
		if (typeof change.text === "string") {
			const edited = editChunkText([chunk], 0, change.text);
			chunk = edited[0] ?? null;
		}
		const preset = presetOf(element, layers);
		const base: TextStyle = { ...lookOf(element, preset), ...(change.style ?? {}) };
		if (change.sizeFactor) base.size = Math.max(1, Math.min(20, (base.size ?? 5) * change.sizeFactor));
		const y = change.style?.y ?? num(p(element)["transform.positionY"]);
		const anchor = y === undefined ? preset.anchor : Math.max(0, Math.min(1, (H / 2 + y - safe.top) / Math.max(1, safe.bottom - safe.top)));
		delete base.x;
		delete base.y;
		const style: CaptionStylePreset = {
			...preset,
			base,
			anchor,
			// a layer the timeline does not have is not invented here (the captions tool owns new layers)
			highlight: layers.words ? preset.highlight : { kind: "none" },
			...(layers.shadow ? {} : { shadow: undefined }),
		};
		prepared.push({ element, chunk, style });
	}

	// measure every string the builder will ask for, at once
	const caseOf = (text: string, style: TextStyle) => (style.uppercase ? text.toUpperCase() : text);
	const wanted: Array<{ text: string; font: { family: string; weight: "normal" | "bold"; italic: boolean } }> = [];
	for (const { chunk, style } of prepared) {
		if (!chunk) continue;
		const font = { family: style.base.font ?? "Arial", weight: style.base.weight ?? ("normal" as const), italic: style.base.italic ?? false };
		const words = chunk.words.map((word) => caseOf(word.text.trim(), style.base)).filter(Boolean);
		wanted.push({ text: words.join(" "), font });
		if (style.highlight.kind !== "none") {
			for (let i = 0; i < words.length; i++) {
				wanted.push({ text: words[i] as string, font });
				wanted.push({ text: `${words.slice(0, i).join(" ")} `, font });
				wanted.push({ text: words.slice(0, i + 1).join(" "), font });
			}
		}
	}
	const { measure, report } = wanted.length ? await prepareMeasure(wanted, H, { method: opts.measureMethod }) : { measure: null, report: null };
	if (report?.method === "estimate") notes.push(`caption widths were estimated, not measured (${report.error ?? "no Chromium"}): look at a still before export`);

	const ops: Op[] = [];
	const tags: ChunkRebuild["tags"] = [];
	const chunks: ChunkRebuild["chunks"] = [];
	const changeOf = new Map(changes.map((change) => [change.id, change]));
	const remap = (op: Op, refs: { base: string; words?: string; shadow?: string }): Op => {
		const track = (op as { track?: string }).track;
		if (!track) return op;
		if (track === refs.base) return { ...op, track: layers.base.id } as Op;
		if (refs.words && track === refs.words && layers.words) return { ...op, track: layers.words.id } as Op;
		if (refs.shadow && track === refs.shadow && layers.shadow) return { ...op, track: layers.shadow.id } as Op;
		return op;
	};
	prepared.forEach(({ element, chunk, style }, i) => {
		const a = element.startTime;
		const b = element.startTime + element.duration;
		const inside = (candidate: SnapshotElement) => candidate.startTime >= a - 2 && candidate.startTime + candidate.duration <= b + 2;
		ops.push({ op: "delete", author, el: element.id } as Op);
		for (const track of [layers.words, layers.shadow]) for (const candidate of track?.elements ?? []) if (inside(candidate)) ops.push({ op: "delete", author, el: candidate.id } as Op);
		if (!chunk || !chunk.words.length || !measure) {
			chunks.push({ id: element.id, text: "", size: 0, removed: true });
			return;
		}
		// whole font sizes only (the editor stores fontSize in steps of 1: a fractional layout drifts off its words)
		let size = Math.round(style.base.size ?? 5);
		let build = buildCaptionOps({ chunks: [chunk], style: { ...style, base: { ...style.base, size } }, canvas, measure, lineHeight: 1.2, author, refPrefix: `${prefix}${i}` });
		for (let pass = 0; pass < 4 && build.chunks[0] && build.chunks[0].size < size - 1e-6; pass++) {
			size = Math.max(1, Math.floor(build.chunks[0].size));
			build = buildCaptionOps({ chunks: [chunk], style: { ...style, base: { ...style.base, size } }, canvas, measure, lineHeight: 1.2, author, refPrefix: `${prefix}${i}` });
		}
		// keep the chunk's own name ("Caption 9", "Caption 9 · batch") instead of the one-chunk build's "Caption 1"
		const own = String(element.name ?? "").trim();
		for (const op of build.ops) {
			if (op.op === "add_track") continue;
			const named = op.op === "insert" && own && typeof (op as { name?: string }).name === "string" ? ({ ...op, name: (op as { name: string }).name.replace(/^Caption 1\b/, own) } as Op) : op;
			ops.push(remap(named, build.tracks));
		}
		const layout = build.chunks[0];
		if (!layout) return;
		const words = chunk.words.map((word) => ({ text: word.text, start: r3(Math.max(0, word.start - chunk.start)), end: r3(Math.max(0, word.end - chunk.start)) }));
		// revise-safety: the chunk keeps its look AND records this restyle in it, so the next captions rebuild draws it the
		// same (before, the tag was written without a look and a rebuild put the chunk back at the style's size)
		const asked0 = changeOf.get(element.id);
		const asked: TextStyle = { ...(asked0?.style ?? {}), ...(asked0?.sizeFactor || asked0?.style?.size !== undefined ? { size: Math.round(style.base.size ?? 5) } : {}) };
		delete asked.x;
		const oldLook = (element as Tagged).restorff?.caption?.look;
		const look = Object.keys(asked).length ? lookAfterRestyle(oldLook, asked, canvas) : oldLook;
		tags.push({ ref: layout.ref, restorff: { captionLayer: "base", role: "caption", caption: { style: style.id, words, ...(look && Object.keys(look).length ? { look } : {}) } } });
		for (const op of build.ops) {
			const ref = (op as { ref?: string }).ref;
			if (op.op !== "insert" || !ref || ref === layout.ref) continue;
			tags.push({ ref, restorff: { captionLayer: ref.endsWith("-shadow") ? "shadow" : "words" } });
		}
		chunks.push({ id: element.id, text: layout.text, size: layout.size });
	});
	return { ops, tags, measure: report, chunks, notes };
}

/** Put the tags on the elements a batch created (refs → ids from ApplyChanges.refs). */
export function tagRebuilt(snapshot: ProjectSnapshot, refs: Record<string, string>, tags: ChunkRebuild["tags"]): number {
	const byId = new Map<string, Record<string, unknown>>();
	for (const tag of tags) {
		const id = refs[tag.ref];
		if (id) byId.set(id, tag.restorff);
	}
	let n = 0;
	for (const track of overlayOf(snapshot)) {
		for (const element of track.elements ?? []) {
			const tag = byId.get(element.id);
			if (!tag) continue;
			element.restorff = { ...((element.restorff as Record<string, unknown> | undefined) ?? {}), ...tag } as SnapshotElement["restorff"];
			n++;
		}
	}
	return n;
}
