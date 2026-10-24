/**
 * Captions: word timings → 1-3-word chunks, the caption style presets from the reference reels (EDT-12, EFFECTS.md
 * FX-18…FX-23), the caption safe area, and the layout that turns a caption document into ops@1.
 *
 * - `chunkWords` is shared by the reducer (`add_captions`) and the talking-head compiler. The editor's own chunker
 *   (transcription/caption.ts buildCaptionChunks) works from segment text with an assumed words-per-second; this one
 *   uses real word times, so chunks start exactly on the first word.
 * - `buildCaptionOps` is what the editor's "Auto captions" runs. A text element has ONE colour, so a highlighted or
 *   karaoke word is its own element placed over the chunk; placing it needs text measuring, which only a browser can
 *   do, so the caller passes `measure()` (tests pass a fake). It emits plain ops (add_track · insert · keyframe), so the
 *   result is deterministic, undoable and the same over MCP.
 * - captions-v2 (2026-10-20, docs/restorff/worklog/captions-v2.md): chunks of up to 5 words; a chunk may carry its own
 *   `look` (style, size or scale, case, key words, accent colour, anchor, zone) so one span can be restyled and a
 *   rebuild keeps it; the `key-word` style (lowercase, key words bigger in an accent colour, no box, blur-in);
 *   `wholeSizes` lays out at the whole font sizes the editor stores; `trackIndex` keeps the caption lanes in place.
 *
 * Owner: the captions agent (docs/restorff/worklog/captions.md); captions-v2 additions: the captions-v2 agent.
 */
import type { Author } from "./model.ts";
import type { Op, TextStyle, TimedWord } from "./ops.ts";
import { TICKS_PER_SECOND } from "./time.ts";

export interface CaptionChunk {
	text: string;
	/** Timeline seconds. */
	start: number;
	end: number;
	words: number;
}

export interface ChunkOptions {
	/** 1-5, default 3 (captions-v2: up to 5; `add_captions` still validates 1-3). */
	maxWords?: number;
	/** A pause longer than this (seconds) always ends a chunk; shorter pauses are bridged. Default 0.3. */
	gap?: number;
}

/** Letter case of caption words: as transcribed ("sentence"), all lower, all upper. */
export type CaptionCase = "lower" | "sentence" | "upper";

/**
 * A chunk's own look (captions-v2, 2026-10-20): what a per-span restyle changed. Every field is optional; what is
 * not set comes from the style. Stored on the chunk's base element (`restorff.caption.look`), so a rebuild (autocut,
 * a transcript fix, another style call) keeps it.
 */
export interface CaptionLook {
	/** Caption style id for this chunk (default: the build's style). */
	style?: string;
	/** Font size in editor units (px = size × canvasHeight / 90; whole units are stored). Wins over `scale`. */
	size?: number;
	/** Size relative to the style's own size (1.35 = 35 % bigger). */
	scale?: number;
	case?: CaptionCase;
	/** key-word style: the words drawn as key words (matched ignoring case and punctuation), or "auto". */
	keys?: string[] | "auto";
	/** The accent colour: key words (key-word), the word box (word-pop), the spoken words (karaoke). */
	key_color?: string;
	/** key-word style: key word size relative to the line's (default the style's, 1.3). */
	key_scale?: number;
	/** Text colour of the chunk. */
	color?: string;
	/** Vertical centre as a fraction of the safe area's height (0 top … 1 bottom); set by a zone or a face-aware placer. */
	anchor?: number;
	/** The zone the anchor came from ("auto" = face-aware, "style" = the style's own, or a zone name) — re-placed on rebuild. */
	zone?: string;
	/** Words per chunk when the span is re-chunked (1-5). */
	max_words?: number;
	/** Blur-in on entrance (true/false overrides the style). */
	blur_in?: boolean;
	/** Strip trailing , . ; : from every word. */
	strip_punctuation?: boolean;
	/**
	 * Text style over the style's own (font, weight, colour, box …): what a `set_caption_style` (an editing style,
	 * `revise`) changed on the chunk, so a rebuild draws it the same way instead of undoing it.
	 */
	text?: CaptionTextOverride;
	/** The line the chunk prefers (fraction of the safe area's height), e.g. an editing style's caption height. */
	line?: number;
	/** "none" = drawn without its word layer (a restyle to a new font removed it); a new `style` brings it back. */
	highlight?: "none";
}

/** The parts of a caption's text style a restyle may change (positions are the layout's). */
export type CaptionTextOverride = Pick<
	TextStyle,
	"font" | "weight" | "italic" | "letter_spacing" | "line_height" | "color" | "bg" | "bg_color" | "bg_radius" | "bg_padding_x" | "bg_padding_y" | "uppercase" | "opacity"
>;

const TEXT_OVERRIDE_KEYS = ["font", "weight", "italic", "letter_spacing", "line_height", "color", "bg", "bg_color", "bg_radius", "bg_padding_x", "bg_padding_y", "uppercase"] as const;

/**
 * A chunk's look after `set_caption_style {style}` (the reducer calls this on every caption element it restyles, so a
 * later rebuild keeps the restyle): text fields go to `look.text`, size to `look.size`, y to `look.line` (a fraction
 * of the caption safe area on `canvas`).
 */
export function lookAfterRestyle(
	look: CaptionLook | undefined,
	style: TextStyle,
	canvas: { width: number; height: number },
	opts: { layerRemoved?: boolean } = {},
): CaptionLook {
	const next: CaptionLook = { ...(look ?? {}) };
	if (opts.layerRemoved) {
		// drawn as the restyle left it: no word layer, and no blur-in (it lived on the removed runs)
		next.highlight = "none";
		next.blur_in = false;
	}
	const text: CaptionTextOverride = { ...(next.text ?? {}) };
	let changed = false;
	for (const key of TEXT_OVERRIDE_KEYS) {
		if (style[key] !== undefined) {
			(text as Record<string, unknown>)[key] = style[key];
			changed = true;
		}
	}
	if (changed) next.text = text;
	if (style.uppercase) next.case = "upper";
	if (typeof style.size === "number") {
		next.size = style.size;
		delete next.scale;
	}
	if (typeof style.y === "number") {
		const safe = scaleSafeArea(CAPTION_SAFE_AREA, canvas);
		next.line = Math.round(((style.y + canvas.height / 2 - safe.top) / (safe.bottom - safe.top)) * 10_000) / 10_000;
	}
	return next;
}

/** A chunk with its words (timeline seconds) — the caption document the editor edits. */
export interface CaptionDocChunk {
	start: number;
	end: number;
	words: TimedWord[];
	/** captions-v2: this chunk's own look (omitted = the build's style as it is). */
	look?: CaptionLook;
}

const BREAK_AFTER = /[.!?,;:]$/;

/** Most words a caption chunk may hold. */
export const MAX_CAPTION_WORDS = 5;

/** The same grouping as `chunkWords`, keeping each chunk's words. */
export function chunkWordGroups(words: readonly TimedWord[], options: ChunkOptions = {}): CaptionDocChunk[] {
	const maxWords = Math.min(MAX_CAPTION_WORDS, Math.max(1, Math.floor(options.maxWords ?? 3)));
	const gap = options.gap ?? 0.3;
	const groups: TimedWord[][] = [];
	let current: TimedWord[] = [];
	for (const word of words) {
		const text = word.text.trim();
		if (!text) continue;
		const previous = current[current.length - 1];
		const startsNew =
			current.length >= maxWords ||
			(previous !== undefined && (word.start - previous.end > gap || BREAK_AFTER.test(previous.text.trim())));
		if (startsNew && current.length) {
			groups.push(current);
			current = [];
		}
		current.push({ ...word, text });
	}
	if (current.length) groups.push(current);

	const chunks = groups.map((group) => ({
		start: group[0].start,
		end: group[group.length - 1].end,
		words: group,
	}));
	// Bridge short pauses so captions don't flicker; never overlap the next chunk.
	for (let i = 0; i < chunks.length - 1; i++) {
		const next = chunks[i + 1];
		if (next.start - chunks[i].end <= gap) chunks[i].end = next.start;
		if (chunks[i].end > next.start) chunks[i].end = next.start;
	}
	return chunks.filter((chunk) => chunk.end > chunk.start);
}

export function chunkWords(words: readonly TimedWord[], options: ChunkOptions = {}): CaptionChunk[] {
	return chunkWordGroups(words, options).map((chunk) => ({
		text: chunk.words.map((word) => word.text).join(" "),
		start: chunk.start,
		end: chunk.end,
		words: chunk.words.length,
	}));
}

// ---------------------------------------------------------------------------------------------------------------
// Safe area
// ---------------------------------------------------------------------------------------------------------------

/** Where captions may sit, in px of a reference canvas; scaled to the real canvas. Right margin leaves room for the
 * platform's buttons on vertical video. Owner default (2026-10-20): x 60–940, y 220–1500 on 1080×1920. */
export interface SafeArea {
	left: number;
	right: number;
	top: number;
	bottom: number;
	/** The canvas the numbers refer to. */
	width: number;
	height: number;
}

export const CAPTION_SAFE_AREA: SafeArea = { left: 60, right: 940, top: 220, bottom: 1500, width: 1080, height: 1920 };

/** The safe area on a given canvas, in canvas px (origin top-left). */
export function scaleSafeArea(area: SafeArea, canvas: { width: number; height: number }): SafeArea {
	const sx = canvas.width / area.width;
	const sy = canvas.height / area.height;
	return {
		left: area.left * sx,
		right: area.right * sx,
		top: area.top * sy,
		bottom: area.bottom * sy,
		width: canvas.width,
		height: canvas.height,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Caption style presets (EDT-12)
// ---------------------------------------------------------------------------------------------------------------

export type CaptionHighlight =
	| { kind: "none" }
	/** The active word sits on its own box (e.g. neon) and pops. FX-18 + the reels' highlighted key word. */
	| { kind: "word-box"; color: string; bg_color: string; bg_radius: number; pop: number }
	/** Karaoke: spoken words turn `color` as they are said; the chunk is drawn in the unspoken colour. FX-20. */
	| { kind: "karaoke"; color: string }
	/**
	 * Key words (captions-v2; the effects-library reel's class, E-5): the line is laid out run by run (plain words in the
	 * base colour, key words in `color` at `scale` × the line's size, sharing a baseline), no box. The chunk's base
	 * element still carries the whole text (hidden) so the caption document reads back the same.
	 */
	| { kind: "key-word"; color: string; scale: number; keys: "auto" | string[] };

export interface CaptionStylePreset {
	id: string;
	label: string;
	/** One line for the picker. */
	hint: string;
	/** Which reel / effect it comes from (EFFECTS.md). */
	source: string;
	/** Default words per chunk (1-3). */
	maxWords: number;
	/** Text style of the chunk. `size` is in editor units (px = size × canvasHeight / 90); x/y are set by the layout. */
	base: TextStyle;
	/** Centre of the caption as a fraction of the safe area's height (0 = top edge, 1 = bottom edge). */
	anchor: number;
	highlight: CaptionHighlight;
	/** A hard drop shadow (a copy of the chunk behind it), for legibility without a box. Offsets in em. */
	shadow?: { color: string; dx: number; dy: number; opacity: number };
	/** Entrance: scale from `from` to 1 over `dur` seconds (and a fade-in over the first third). */
	entrance?: { from: number; dur: number };
	/** Swatch colours for the picker (UI only). */
	swatch: { bg: string; fg: string; accent?: string };
	/** captions-v2: letter case of the words (default "upper" when `base.uppercase`, else "sentence" = as transcribed). */
	case?: CaptionCase;
	/** captions-v2: strip trailing , . ; : from every word. */
	stripPunctuation?: boolean;
	/**
	 * captions-v2: a blur-in on entrance — a `blur` effect whose intensity runs `from` → 0 over `dur` seconds. ops@1 can't
	 * add effects, so the builder only reports it (`CaptionBuild.blurIn`); the caller adds the effect after the reducer.
	 */
	blurIn?: { from: number; dur: number };
}

/** Background padding param for a padding of `em` × the font size (padding px = param × fontSize / 15). */
const padParam = (em: number, canvasHeight: number) => Math.round((em * canvasHeight) / 6);

export const CAPTION_STYLE_PRESETS: CaptionStylePreset[] = [
	{
		id: "word-pop",
		label: "Word pop · highlight",
		hint: "bold white, the spoken word pops on a neon box",
		source: "Def9pj5TWtA / DeBhOJ6T1Ja key word · FX-18",
		maxWords: 3,
		base: { font: "Archivo", size: 5.2, weight: "bold", color: "#FFFFFF" },
		anchor: 0.62,
		highlight: { kind: "word-box", color: "#0C0C0E", bg_color: "#F6FF00", bg_radius: 28, pop: 1.12 },
		shadow: { color: "#000000", dx: 0, dy: 0.06, opacity: 0.55 },
		swatch: { bg: "#16161A", fg: "#FFFFFF", accent: "#F6FF00" },
	},
	{
		id: "bold-white",
		label: "Bold white",
		hint: "clean bold sans, sentence case, no box",
		source: "DeIGbZypIUb · FX-18 captions-clean",
		maxWords: 3,
		base: { font: "Inter", size: 3.8, weight: "bold", color: "#FFFFFF" },
		anchor: 0.56,
		highlight: { kind: "none" },
		shadow: { color: "#000000", dx: 0, dy: 0.06, opacity: 0.5 },
		entrance: { from: 0.92, dur: 0.12 },
		swatch: { bg: "#16161A", fg: "#FFFFFF" },
	},
	{
		id: "serif-box",
		label: "Serif box · karaoke",
		hint: "serif on a green label, words turn cream as they're said",
		source: "DeUUFJQu8cw · FX-20 captions-karaoke-box",
		maxWords: 3,
		base: {
			font: "Playfair Display",
			size: 4.2,
			weight: "normal",
			color: "#A9BFA3",
			bg: true,
			bg_color: "#1E3A2B",
			bg_radius: 18,
		},
		anchor: 0.74,
		highlight: { kind: "karaoke", color: "#F4EAD5" },
		swatch: { bg: "#1E3A2B", fg: "#F4EAD5", accent: "#A9BFA3" },
	},
	{
		id: "mono-label",
		label: "Mono label",
		hint: "mono caps on a black label, lower third",
		source: "DePNgrmToh9 · paper-collage talking head",
		maxWords: 3,
		base: {
			font: "JetBrains Mono",
			size: 3.2,
			weight: "bold",
			color: "#EDEBE6",
			uppercase: true,
			letter_spacing: 2,
			bg: true,
			bg_color: "#0C0C0E",
			bg_radius: 10,
		},
		anchor: 0.86,
		highlight: { kind: "none" },
		swatch: { bg: "#0C0C0E", fg: "#EDEBE6" },
	},
	{
		id: "huge-centred",
		label: "Huge centred",
		hint: "one huge word at a time, moody",
		source: "DeUUFJQu8cw second half · moody-captions · FX-22",
		maxWords: 1,
		base: { font: "Oswald", size: 15, weight: "bold", color: "#EDEBE6", uppercase: true },
		anchor: 0.5,
		highlight: { kind: "none" },
		shadow: { color: "#000000", dx: 0, dy: 0.03, opacity: 0.35 },
		entrance: { from: 1.08, dur: 0.18 },
		swatch: { bg: "#0C0C0E", fg: "#EDEBE6" },
	},
	{
		id: "key-word",
		label: "Key words · lowercase",
		hint: "heavy rounded lowercase, no box, key words bigger in yellow, blur-in",
		source: "Def9pj5TWtA caption class · effects-library E-5",
		maxWords: 3,
		base: { font: "Nunito", size: 5, weight: "bold", color: "#FFFFFF" },
		anchor: 0.7,
		highlight: { kind: "key-word", color: "#FFD60A", scale: 1.3, keys: "auto" },
		shadow: { color: "#000000", dx: 0, dy: 0.05, opacity: 0.45 },
		entrance: { from: 0.94, dur: 0.14 },
		swatch: { bg: "#16161A", fg: "#FFFFFF", accent: "#FFD60A" },
		case: "lower",
		stripPunctuation: true,
		blurIn: { from: 12, dur: 0.18 },
	},
];

export const DEFAULT_CAPTION_STYLE_ID = "word-pop";

export function getCaptionStyle(id: string | undefined): CaptionStylePreset {
	return CAPTION_STYLE_PRESETS.find((preset) => preset.id === id) ?? CAPTION_STYLE_PRESETS[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Looks (captions-v2): a chunk's own style, size, case, key words, colour, zone
// ---------------------------------------------------------------------------------------------------------------

/**
 * The style a chunk is drawn in: its look's style (or the build's) with the look's overrides applied. Without a look
 * the build's style comes back unchanged (so documents without looks lay out exactly as before).
 */
export function resolveCaptionLook(style: CaptionStylePreset, look?: CaptionLook): CaptionStylePreset {
	if (!look) return style;
	const preset = look.style && look.style !== style.id ? getCaptionStyle(look.style) : style;
	const designed = preset.base.size ?? 5;
	const scale = typeof look.scale === "number" && look.scale > 0 ? look.scale : 1;
	const size = typeof look.size === "number" && look.size > 0 ? look.size : designed * scale;
	const { uppercase: textUpper, opacity: _opacity, ...text } = look.text ?? {};
	const base: TextStyle = { ...preset.base, ...text, size, ...(look.color ? { color: look.color } : {}) };
	let highlight = preset.highlight;
	if (look.highlight === "none") {
		highlight = { kind: "none" };
	} else if (highlight.kind === "key-word") {
		highlight = {
			...highlight,
			color: look.key_color ?? highlight.color,
			scale: typeof look.key_scale === "number" && look.key_scale > 0 ? look.key_scale : highlight.scale,
			keys: look.keys ?? highlight.keys,
		};
	} else if (look.key_color && highlight.kind === "word-box") {
		highlight = { ...highlight, bg_color: look.key_color };
	} else if (look.key_color && highlight.kind === "karaoke") {
		highlight = { ...highlight, color: look.key_color };
	}
	const blurIn = look.blur_in === false ? undefined : look.blur_in === true ? (preset.blurIn ?? { from: 12, dur: 0.18 }) : preset.blurIn;
	return {
		...preset,
		base,
		highlight,
		anchor: typeof look.anchor === "number" ? look.anchor : typeof look.line === "number" ? look.line : preset.anchor,
		maxWords: typeof look.max_words === "number" ? Math.min(MAX_CAPTION_WORDS, Math.max(1, Math.round(look.max_words))) : preset.maxWords,
		case: look.case ?? (textUpper ? "upper" : preset.case),
		stripPunctuation: look.strip_punctuation ?? preset.stripPunctuation,
		blurIn,
	};
}

/** A word as the caption shows it: the style's case; trailing , . ; : stripped when the style says so. */
export function captionWordText(text: string, style: CaptionStylePreset): string {
	let out = text.trim();
	if (style.stripPunctuation) out = out.replace(/[,.;:…]+$/u, "");
	const mode: CaptionCase = style.case ?? (style.base.uppercase ? "upper" : "sentence");
	if (mode === "upper") return out.toUpperCase();
	if (mode === "lower") return out.toLowerCase();
	return out;
}

/** Function words never picked as automatic key words. */
const KEY_STOPWORDS = new Set(
	(
		"a an the and or but so to of in on at for with from by as is are was were be been being am it its it's this that " +
		"these those there their they them then than i i'm i've i'll you you're your yours we we're our us he she his her " +
		"my me mine just not no yes do does did doing done have has had having can can't will won't would should could " +
		"if what which who whom whose how when where why all any some very really actually basically literally about up " +
		"out get got getting like also now one ones thing things something anything everything nothing because through " +
		"without going gonna wanna let's here into onto over under again still even much many more most other another " +
		"every each own same such only well right okay make makes making made take takes want wants know see look"
	).split(" "),
);

const keyCore = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}']/gu, "")
		.replace(/^'+|'+$/g, "");

function keyScore(raw: string, index: number): number {
	const core = keyCore(raw);
	if (!core || KEY_STOPWORDS.has(core)) return 0;
	let score = core.replace(/'/g, "").length;
	if (/\p{N}/u.test(core)) score += 5;
	if (index > 0 && /^\p{Lu}/u.test(raw.trim()) && core !== "i") score += 3;
	if (/!$/.test(raw.trim())) score += 2;
	return score;
}

/**
 * Which words of a chunk are key words. A list: those words (case and punctuation ignored; a phrase counts word by
 * word). "auto": the chunk's one most telling word — a number, a name mid-chunk, or a long content word (score ≥ 6:
 * letters, +5 digits, +3 capital mid-chunk, +2 "!"; the first of equals); never a function word — or none.
 */
export function pickKeyWords(words: readonly string[], keys: "auto" | readonly string[]): boolean[] {
	if (keys !== "auto") {
		const wanted = new Set(keys.flatMap((key) => key.split(/\s+/)).map(keyCore).filter(Boolean));
		return words.map((word) => wanted.has(keyCore(word)));
	}
	let best = -1;
	let bestScore = 0;
	words.forEach((word, i) => {
		const score = keyScore(word, i);
		if (score > bestScore) {
			best = i;
			bestScore = score;
		}
	});
	return words.map((_, i) => i === best && bestScore >= 6);
}

// ---------------------------------------------------------------------------------------------------------------
// Layout → ops
// ---------------------------------------------------------------------------------------------------------------

export interface CaptionFont {
	family: string;
	/** Editor units (px = size × canvasHeight / 90). */
	size: number;
	weight: "normal" | "bold";
	italic: boolean;
	/** px */
	letterSpacing: number;
}

/** Width in canvas px of one line of `text` in `font` on the canvas being laid out. */
export type MeasureText = (text: string, font: CaptionFont) => number;

/** Names of the tracks the builder makes (top to bottom: words, captions, shadow). */
export const CAPTION_TRACK_NAMES = { base: "CAPTIONS", words: "CAPTION WORDS", shadow: "CAPTION SHADOW" } as const;

/** Name of the n-th (0-based) lane of a layer: "CAPTION WORDS", "CAPTION WORDS 2", … (key-word runs show at once). */
export function captionLaneName(layer: "words" | "shadow", slot: number): string {
	const name = CAPTION_TRACK_NAMES[layer];
	return slot === 0 ? name : `${name} ${slot + 1}`;
}

export interface CaptionBuildInput {
	chunks: readonly CaptionDocChunk[];
	style: CaptionStylePreset;
	canvas: { width: number; height: number };
	measure: MeasureText;
	safeArea?: SafeArea;
	author?: Author;
	/** Prefix for refs (unique per batch). Default "cap". */
	refPrefix?: string;
	/** Line height of the editor's text default (DEFAULTS.text.lineHeight). */
	lineHeight?: number;
	/**
	 * captions-v2: lay every chunk out at a whole font size. The editor stores fontSize in whole units (params step 1),
	 * so a layout measured at 5.2 is drawn at 5 and highlight boxes drift off their words (SEEN 2026-10-20, mcp-cut
	 * worklog). Each chunk gets the rounded size if it still fits the safe width, else the next smaller one. Default false.
	 */
	wholeSizes?: boolean;
	/** captions-v2: overlay index of the caption lanes (default 0 = on top); a rebuild passes where the old ones were. */
	trackIndex?: number;
}

export interface CaptionChunkLayout {
	index: number;
	text: string;
	size: number;
	/** Canvas px from the canvas centre (the editor's transform.position). */
	x: number;
	y: number;
	width: number;
	/** Ref of the chunk's base element in the ops. */
	ref: string;
	/** Did the chunk have to shrink to fit the safe area? */
	shrunk: boolean;
	/** captions-v2: the style the chunk was drawn in. */
	style?: string;
	/** captions-v2: half the height of the chunk's box (px, text + box padding; key words included). */
	halfHeight?: number;
	/** captions-v2, key-word chunks: the key runs as shown, and their size. */
	keys?: string[];
	keySize?: number;
}

export interface CaptionBuild {
	ops: Op[];
	/** Track refs defined by the ops (`words` / `shadow` = the first lane; `wordSlots` / `shadowSlots` = every lane). */
	tracks: { base: string; words?: string; shadow?: string; wordSlots?: string[]; shadowSlots?: string[] };
	chunks: CaptionChunkLayout[];
	/**
	 * captions-v2: elements that blur in — a `blur` effect whose intensity runs `from` → 0 over `dur` seconds. ops@1 has
	 * no op for effects, so the caller adds them after the reducer (server: transcripts-timeline.ts addBlurIn).
	 */
	blurIn?: Array<{ ref: string; from: number; dur: number }>;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const round1 = (value: number) => Math.round(value * 10) / 10;
/**
 * Snap seconds to the editor's tick grid. `insert` converts `t` and `dur` separately, so with arbitrary floats
 * round(t) + round(dur) can land one tick past the next element's round(start) and the batch fails on overlap.
 */
const onTicks = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) / TICKS_PER_SECOND;

function fontOf(style: TextStyle, size: number): CaptionFont {
	return {
		family: style.font ?? "Arial",
		size,
		weight: style.weight ?? "normal",
		italic: style.italic ?? false,
		letterSpacing: style.letter_spacing ?? 0,
	};
}

interface PreparedWord {
	raw: string;
	text: string;
	start: number;
	end: number;
}

interface KeyRun {
	text: string;
	key: boolean;
}

/** Consecutive plain words, and consecutive key words, merged into runs (one element each). */
function keyRunsOf(words: readonly PreparedWord[], keys: "auto" | readonly string[]): KeyRun[] {
	const flags = pickKeyWords(
		words.map((word) => word.raw),
		keys,
	);
	const runs: KeyRun[] = [];
	words.forEach((word, i) => {
		const last = runs[runs.length - 1];
		if (last && last.key === flags[i]) last.text = `${last.text} ${word.text}`;
		else runs.push({ text: word.text, key: flags[i] });
	});
	return runs;
}

/** The size a line of `width(size)` px gets inside `available(size)` px: shrunk to fit; whole units when asked. */
function fitSize(
	designed: number,
	width: (size: number) => number,
	available: (size: number) => number,
	whole: boolean,
): { size: number; width: number; shrunk: boolean } {
	let size = designed;
	let measured = width(size);
	const room = available(size);
	let shrunk = false;
	if (measured > room && measured > 0) {
		const factor = room / measured;
		size = Math.max(1, Math.floor(size * factor * 0.98 * 100) / 100);
		measured = width(size);
		shrunk = true;
	}
	if (whole) {
		const fits = (s: number) => width(s) <= available(s);
		let s = Math.max(1, Math.round(size));
		if (!fits(s)) s = Math.max(1, Math.floor(size));
		while (s > 1 && !fits(s)) s -= 1;
		size = s;
		measured = width(s);
		shrunk = s < Math.round(designed);
	}
	return { size, width: measured, shrunk };
}

/**
 * Lay a caption document out and return the ops that build it: a CAPTIONS track (one text element per chunk), and when
 * a chunk's style needs them CAPTION WORDS lanes (highlighted / spoken / key-word runs, placed over the chunk by
 * measuring) and CAPTION SHADOW lanes. Every chunk is shrunk to fit the safe area's width and kept inside its height.
 * Each chunk is drawn in its own look (`chunk.look`: style, size, case, key words, colour, anchor) over `style`.
 */
export function buildCaptionOps(input: CaptionBuildInput): CaptionBuild {
	const { style, canvas, measure } = input;
	const author = input.author ?? "user";
	const prefix = input.refPrefix ?? "cap";
	const lineHeight = input.lineHeight ?? 1.2;
	const whole = input.wholeSizes === true;
	const lane = Math.max(0, Math.floor(input.trackIndex ?? 0));
	const safe = scaleSafeArea(input.safeArea ?? CAPTION_SAFE_AREA, canvas);
	const H = canvas.height;
	const emPx = (size: number) => (size * H) / 90;
	const padPx = (param: number, size: number) => (param * size) / 15;

	const prepared = input.chunks.map((raw) => {
		const st = resolveCaptionLook(style, raw.look);
		const chunk = { start: onTicks(raw.start), end: onTicks(raw.end) };
		const words: PreparedWord[] = raw.words
			.map((word) => ({ raw: word.text.trim(), text: captionWordText(word.text, st), start: onTicks(word.start), end: onTicks(word.end) }))
			.filter((word) => word.text);
		const runs = st.highlight.kind === "key-word" ? keyRunsOf(words, st.highlight.keys) : [];
		return { st, chunk, words, runs };
	});

	// lanes: key-word runs of one chunk are on screen together and elements on one track can't overlap in time, so a
	// key-word chunk needs a lane per run; word-box / karaoke words follow one another on one lane
	const wordLanes = prepared.reduce((most, p) => {
		if (!p.words.length) return most;
		if (p.st.highlight.kind === "key-word") return Math.max(most, p.runs.length);
		return p.st.highlight.kind === "none" ? most : Math.max(most, 1);
	}, 0);
	const shadowLanes = prepared.reduce((most, p) => {
		if (!p.st.shadow || !p.words.length) return most;
		return Math.max(most, p.st.highlight.kind === "key-word" ? p.runs.length : 1);
	}, 0);
	// lanes follow the chunks' own looks (an empty document gets the style's lanes, as before captions-v2)
	const hasShadow = prepared.length ? prepared.some((p) => p.st.shadow) : style.shadow !== undefined;
	const hasWords = prepared.length ? prepared.some((p) => p.st.highlight.kind !== "none") : style.highlight.kind !== "none";

	const ops: Op[] = [];
	const tracks: CaptionBuild["tracks"] = { base: `${prefix}-track` };
	ops.push({ op: "add_track", author, kind: "caption", name: CAPTION_TRACK_NAMES.base, index: lane, ref: tracks.base });
	if (hasShadow) {
		tracks.shadowSlots = [];
		for (let j = 0; j < Math.max(1, shadowLanes); j++) {
			const ref = j === 0 ? `${prefix}-shadow` : `${prefix}-shadow${j + 1}`;
			tracks.shadowSlots.push(ref);
			ops.push({ op: "add_track", author, kind: "text", name: captionLaneName("shadow", j), index: lane + 1 + j, ref });
		}
		tracks.shadow = tracks.shadowSlots[0];
	}
	if (hasWords) {
		tracks.wordSlots = [];
		for (let j = 0; j < Math.max(1, wordLanes); j++) {
			const ref = j === 0 ? `${prefix}-words` : `${prefix}-words${j + 1}`;
			tracks.wordSlots.push(ref);
			ops.push({ op: "add_track", author, kind: "text", name: captionLaneName("words", j), index: lane + j, ref });
		}
		tracks.words = tracks.wordSlots[0];
	}

	const safeWidth = safe.right - safe.left;
	const centreX = (safe.left + safe.right) / 2 - canvas.width / 2;
	const layouts: CaptionChunkLayout[] = [];
	const blurIn: NonNullable<CaptionBuild["blurIn"]> = [];

	const entranceOps = (el: string, dur: number, entrance: { from: number; dur: number }, opacity: number) => {
		const enter = Math.min(entrance.dur, dur / 2);
		ops.push({ op: "keyframe", author, el, prop: "scale", t: 0, value: entrance.from, local: true });
		ops.push({ op: "keyframe", author, el, prop: "scale", t: enter, value: 1, local: true, ease: "ease_out" });
		ops.push({ op: "keyframe", author, el, prop: "opacity", t: 0, value: 0, local: true });
		ops.push({ op: "keyframe", author, el, prop: "opacity", t: enter / 3, value: opacity, local: true });
	};

	prepared.forEach(({ st, chunk, words, runs }, index) => {
		if (!words.length || !(chunk.end > chunk.start)) return;
		const base = st.base;
		const text = words.map((word) => word.text).join(" ");
		const ref = `${prefix}-c${index}`;
		const dur = chunk.end - chunk.start;
		const anchorY = safe.top + st.anchor * (safe.bottom - safe.top);

		if (st.highlight.kind === "key-word") {
			// ── key-word: runs side by side on one baseline, key runs bigger in the accent colour, no box ──────────
			const hl = st.highlight;
			const keySizeOf = (s: number) => (whole ? Math.max(1, Math.round(s * hl.scale)) : round2(s * hl.scale));
			const runWidth = (run: KeyRun, s: number) => measure(run.text, fontOf(base, run.key ? keySizeOf(s) : s));
			const lineWidth = (s: number) =>
				runs.reduce((sum, run) => sum + runWidth(run, s), 0) + measure(" ", fontOf(base, s)) * Math.max(0, runs.length - 1);
			const fitted = fitSize(base.size ?? 5, lineWidth, () => safeWidth, whole);
			const size = fitted.size;
			const keySize = keySizeOf(size);
			const hasKey = runs.some((run) => run.key);
			// canvas text is drawn on its middle: lift a bigger word so both share a baseline (≈ 0.32 em above it)
			const lift = hasKey ? 0.32 * (emPx(keySize) - emPx(size)) : 0;
			const halfHeight = (lineHeight * emPx(hasKey ? keySize : size)) / 2 + lift;
			const centreY = Math.min(safe.bottom - halfHeight, Math.max(safe.top + halfHeight, anchorY));
			const x = round1(centreX);
			const y = round1(centreY - canvas.height / 2);
			const sharedStyle: TextStyle = { ...base, uppercase: false, size: round2(size), align: "center", x, y };
			// the hidden carrier: the whole chunk (the caption document and restyles read it; the runs draw it)
			ops.push({ op: "insert", author, track: tracks.base, t: chunk.start, dur, text, name: `Caption ${index + 1}`, style: { ...sharedStyle, opacity: 0 }, ref });
			const space = measure(" ", fontOf(base, size));
			let left = x - fitted.width / 2;
			runs.forEach((run, r) => {
				const runSize = run.key ? keySize : size;
				const width = runWidth(run, size);
				const rx = round1(left + width / 2);
				const ry = run.key ? round1(y - lift) : y;
				const runRef = `${ref}-r${r}`;
				const opacity = base.opacity ?? 1;
				ops.push({
					op: "insert",
					author,
					track: (tracks.wordSlots as string[])[r],
					t: chunk.start,
					dur,
					text: run.text,
					name: `Caption ${index + 1} · ${run.text}`,
					style: { ...sharedStyle, size: round2(runSize), color: run.key ? hl.color : base.color, x: rx, y: ry, opacity },
					ref: runRef,
				});
				if (st.entrance) entranceOps(runRef, dur, st.entrance, opacity);
				if (st.blurIn) blurIn.push({ ref: runRef, ...st.blurIn });
				if (st.shadow && tracks.shadowSlots?.[r]) {
					const shadowRef = `${runRef}-shadow`;
					ops.push({
						op: "insert",
						author,
						track: tracks.shadowSlots[r],
						t: chunk.start,
						dur,
						text: run.text,
						name: `Caption ${index + 1} shadow · ${run.text}`,
						style: {
							...sharedStyle,
							size: round2(runSize),
							color: st.shadow.color,
							bg: false,
							opacity: st.shadow.opacity,
							x: round1(rx + st.shadow.dx * emPx(runSize)),
							y: round1(ry + st.shadow.dy * emPx(runSize)),
						},
						ref: shadowRef,
					});
					if (st.entrance) entranceOps(shadowRef, dur, st.entrance, st.shadow.opacity);
					if (st.blurIn) blurIn.push({ ref: shadowRef, ...st.blurIn });
				}
				left += width + space;
			});
			layouts.push({
				index,
				text,
				size: round2(size),
				x,
				y,
				width: fitted.width,
				ref,
				shrunk: fitted.shrunk,
				style: st.id,
				halfHeight,
				keys: runs.filter((run) => run.key).map((run) => run.text),
				keySize,
			});
			return;
		}

		const boxed = base.bg === true;
		// revise-safety (2026-10-21): a word-box highlight draws each word on its own box (padding 0.16 em each side),
		// so the first and last words' boxes stick out of the line by that much — fit the line with it (MEASURED: word-pop
		// chunks at the safe width had their edge word boxes 7–13 px outside the safe area on 1080×1920)
		const wordBoxPad = st.highlight.kind === "word-box" && tracks.words ? padParam(0.16, H) : 0;
		const padX = boxed ? (base.bg_padding_x ?? padParam(0.32, H)) : 0;
		const padY = boxed ? (base.bg_padding_y ?? padParam(0.14, H)) : 0;
		const fitPad = Math.max(padX, wordBoxPad);

		// fit the width: shrink proportionally (measured width scales with size)
		const designedAvailable = safeWidth - 2 * padPx(fitPad, base.size ?? 5);
		const fitted = fitSize(
			base.size ?? 5,
			(s) => measure(text, fontOf(base, s)),
			(s) => (whole ? safeWidth - 2 * padPx(fitPad, s) : designedAvailable),
			whole,
		);
		const size = fitted.size;
		const width = fitted.width;
		const shrunk = fitted.shrunk;

		// vertical: anchor inside the safe area, then clamp the text (and its box) inside it
		const halfHeight = (lineHeight * emPx(size)) / 2 + padPx(padY, size);
		const centreY = Math.min(safe.bottom - halfHeight, Math.max(safe.top + halfHeight, anchorY));
		const x = round1(centreX);
		const y = round1(centreY - canvas.height / 2);
		const sharedStyle: TextStyle = { ...base, uppercase: false, size: round2(size), align: "center", x, y };
		if (boxed) {
			sharedStyle.bg_padding_x = padX;
			sharedStyle.bg_padding_y = padY;
		}

		ops.push({
			op: "insert",
			author,
			track: tracks.base,
			t: chunk.start,
			dur,
			text,
			name: `Caption ${index + 1}`,
			style: sharedStyle,
			ref,
		});

		if (st.entrance) entranceOps(ref, dur, st.entrance, base.opacity ?? 1);
		if (st.blurIn) blurIn.push({ ref, ...st.blurIn });

		if (st.shadow && tracks.shadow) {
			const shadowRef = `${ref}-shadow`;
			ops.push({
				op: "insert",
				author,
				track: tracks.shadow,
				t: chunk.start,
				dur,
				text,
				name: `Caption ${index + 1} shadow`,
				style: {
					...sharedStyle,
					color: st.shadow.color,
					bg: false,
					opacity: st.shadow.opacity,
					x: round1(x + st.shadow.dx * emPx(size)),
					y: round1(y + st.shadow.dy * emPx(size)),
				},
				ref: shadowRef,
			});
			if (st.entrance) entranceOps(shadowRef, dur, st.entrance, st.shadow.opacity);
			if (st.blurIn) blurIn.push({ ref: shadowRef, ...st.blurIn });
		}

		// per-word layer: each word's span runs from its start to the next word's start (the last to the chunk's end)
		if ((st.highlight.kind === "word-box" || st.highlight.kind === "karaoke") && tracks.words) {
			const highlight = st.highlight;
			const font = fontOf(base, size);
			const left = x - width / 2;
			const spaceAfter = (count: number) => (count > 0 ? measure(`${words.slice(0, count).map((w) => w.text).join(" ")} `, font) : 0);
			words.forEach((word, w) => {
				const from = Math.max(chunk.start, Math.min(word.start, chunk.end));
				const next = words[w + 1];
				const to = Math.min(chunk.end, next ? Math.max(from, next.start) : chunk.end);
				if (!(to - from > 0.001)) return;
				const wordRef = `${ref}-w${w}`;
				if (highlight.kind === "word-box") {
					const wordWidth = measure(word.text, font);
					const wx = round1(left + spaceAfter(w) + wordWidth / 2);
					ops.push({
						op: "insert",
						author,
						track: tracks.words as string,
						t: from,
						dur: to - from,
						text: word.text,
						name: `Caption ${index + 1} · ${word.text}`,
						style: {
							...sharedStyle,
							color: highlight.color,
							bg: true,
							bg_color: highlight.bg_color,
							bg_radius: highlight.bg_radius,
							bg_padding_x: padParam(0.16, H),
							bg_padding_y: padParam(0.04, H),
							x: wx,
						},
						ref: wordRef,
					});
					const span = to - from;
					const peak = Math.min(0.08, span / 3);
					const settle = Math.min(0.16, (span * 2) / 3);
					ops.push({ op: "keyframe", author, el: wordRef, prop: "scale", t: 0, value: 1, local: true });
					ops.push({ op: "keyframe", author, el: wordRef, prop: "scale", t: peak, value: highlight.pop, local: true, ease: "ease_out" });
					ops.push({ op: "keyframe", author, el: wordRef, prop: "scale", t: settle, value: 1, local: true, ease: "ease_in_out" });
				} else {
					// karaoke: the spoken prefix, left-aligned at the chunk's left edge, drawn over the unspoken chunk
					const spoken = words.slice(0, w + 1).map((item) => item.text).join(" ");
					ops.push({
						op: "insert",
						author,
						track: tracks.words as string,
						t: from,
						dur: to - from,
						text: spoken,
						name: `Caption ${index + 1} · ${w + 1}/${words.length}`,
						style: {
							...sharedStyle,
							color: highlight.color,
							bg: false,
							align: "left",
							x: round1(left),
						},
						ref: wordRef,
					});
				}
			});
		}

		layouts.push({ index, text, size: round2(size), x, y, width, ref, shrunk, style: st.id, halfHeight });
	});

	return { ops, tracks, chunks: layouts, ...(blurIn.length ? { blurIn } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// Caption document edits (the caption editor list) — pure, so every edit is a rebuild from a new document.
// ---------------------------------------------------------------------------------------------------------------

const MIN_CHUNK = 0.05;

/** Replace a chunk's text. Same word count → words keep their times; otherwise times are spread by letters. */
export function editChunkText(doc: readonly CaptionDocChunk[], index: number, text: string): CaptionDocChunk[] {
	const chunk = doc[index];
	if (!chunk) return [...doc];
	const tokens = text.trim().split(/\s+/).filter(Boolean);
	if (!tokens.length) return removeChunk(doc, index);
	let words: TimedWord[];
	if (tokens.length === chunk.words.length) {
		words = chunk.words.map((word, i) => ({ ...word, text: tokens[i] }));
	} else {
		const start = chunk.words[0]?.start ?? chunk.start;
		const end = chunk.words[chunk.words.length - 1]?.end ?? chunk.end;
		const letters = tokens.reduce((sum, token) => sum + token.length, 0) || 1;
		let cursor = start;
		words = tokens.map((token) => {
			const span = ((end - start) * token.length) / letters;
			const word = { text: token, start: cursor, end: cursor + span };
			cursor += span;
			return word;
		});
	}
	return doc.map((item, i) => (i === index ? { ...item, words } : item));
}

/** Merge a chunk with the next one. */
export function mergeChunkWithNext(doc: readonly CaptionDocChunk[], index: number): CaptionDocChunk[] {
	const a = doc[index];
	const b = doc[index + 1];
	if (!a || !b) return [...doc];
	const merged: CaptionDocChunk = { start: a.start, end: Math.max(a.end, b.end), words: [...a.words, ...b.words], ...(a.look ? { look: a.look } : {}) };
	return [...doc.slice(0, index), merged, ...doc.slice(index + 2)];
}

/** Split a chunk before word `at` (1 … words-1). Default: the middle. */
export function splitChunk(doc: readonly CaptionDocChunk[], index: number, at?: number): CaptionDocChunk[] {
	const chunk = doc[index];
	if (!chunk || chunk.words.length < 2) return [...doc];
	const cut = Math.min(chunk.words.length - 1, Math.max(1, at ?? Math.ceil(chunk.words.length / 2)));
	const left = chunk.words.slice(0, cut);
	const right = chunk.words.slice(cut);
	const boundary = Math.min(chunk.end - MIN_CHUNK, Math.max(chunk.start + MIN_CHUNK, right[0].start));
	return [
		...doc.slice(0, index),
		{ start: chunk.start, end: boundary, words: left, ...(chunk.look ? { look: chunk.look } : {}) },
		{ start: boundary, end: chunk.end, words: right, ...(chunk.look ? { look: chunk.look } : {}) },
		...doc.slice(index + 1),
	];
}

/** Shift a chunk (and its words) by `delta` seconds, never into its neighbours or before 0. */
export function nudgeChunk(doc: readonly CaptionDocChunk[], index: number, delta: number): CaptionDocChunk[] {
	const chunk = doc[index];
	if (!chunk) return [...doc];
	const before = doc[index - 1];
	const after = doc[index + 1];
	const lowest = Math.max(0, before ? before.end : 0) - chunk.start;
	const highest = after ? after.start - chunk.end : Number.POSITIVE_INFINITY;
	const shift = Math.min(highest, Math.max(lowest, delta));
	if (shift === 0) return [...doc];
	return doc.map((item, i) =>
		i === index
			? {
					start: item.start + shift,
					end: item.end + shift,
					words: item.words.map((word) => ({ ...word, start: word.start + shift, end: word.end + shift })),
					...(item.look ? { look: item.look } : {}),
				}
			: item,
	);
}

/** Move one edge of a chunk (`edge` start or end) by `delta` seconds, keeping it at least 50 ms long. */
export function nudgeChunkEdge(
	doc: readonly CaptionDocChunk[],
	index: number,
	edge: "start" | "end",
	delta: number,
): CaptionDocChunk[] {
	const chunk = doc[index];
	if (!chunk) return [...doc];
	const before = doc[index - 1];
	const after = doc[index + 1];
	let { start, end } = chunk;
	if (edge === "start") start = Math.min(end - MIN_CHUNK, Math.max(before ? before.end : 0, start + delta));
	else end = Math.max(start + MIN_CHUNK, Math.min(after ? after.start : Number.POSITIVE_INFINITY, end + delta));
	return doc.map((item, i) => (i === index ? { ...item, start, end } : item));
}

export function removeChunk(doc: readonly CaptionDocChunk[], index: number): CaptionDocChunk[] {
	return doc.filter((_, i) => i !== index);
}
