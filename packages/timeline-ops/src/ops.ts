/**
 * ops@1 — the timeline op vocabulary of plan/06-mcp.md §5, as TypeScript types.
 *
 * Conventions:
 * - Every op carries `author` (user · claude · compiler · preset).
 * - Every time in an op is in SECONDS (a JS number). The reducer converts to ticks at the boundary with the editor's
 *   own rule: ticks = round_half_away_from_zero(seconds × 120 000) — identical to `mediaTimeFromSeconds`.
 * - `t` is TIMELINE time unless the op says otherwise (`keyframe` takes `local: true` for element-relative time).
 * - `in` / `out` are SOURCE times (seconds into the media file), like an NLE's in and out points.
 * - Targets (`el`, `track`, `media`) are an id from the project, or a `ref` given earlier in the same batch.
 *   `track: "main"` is the main video track.
 * - Only erasable TypeScript syntax (no enums/namespaces), so Node 24 can run these files with type stripping.
 */
import type { Author, FrameRate, ParamValue } from "./model.ts";

export const OPS_VERSION = "ops@1";

export const OP_NAMES = [
	"set_canvas",
	"add_size_variant",
	"import_media",
	"add_track",
	"remove_track",
	"reorder_tracks",
	"insert",
	"move",
	"trim",
	"split",
	"delete",
	"ripple_delete",
	"set",
	"keyframe",
	"add_captions",
	"set_caption_style",
	"text_pop",
	"transition",
	"gain",
	"duck",
	"sfx",
	"normalize",
	"grade",
	"apply_style",
	"mark",
	"beats",
	"snap_cuts",
] as const;

export type OpName = (typeof OP_NAMES)[number];

export const AUTHORS: readonly Author[] = ["user", "claude", "compiler", "preset"];

interface OpBase {
	author: Author;
	/** Free text kept in the change log; never interpreted. */
	note?: string;
}

/** Friendly text styling, mapped onto the editor's text params (params/registry.ts:176-327). */
export interface TextStyle {
	font?: string;
	/** Editor font-size units: rendered px = size × canvasHeight / 90 (text/typography.ts:9). */
	size?: number;
	color?: string;
	weight?: "normal" | "bold";
	italic?: boolean;
	align?: "left" | "center" | "right";
	/** Uppercase the text content when it is written. */
	uppercase?: boolean;
	letter_spacing?: number;
	line_height?: number;
	/** Background box behind the text. */
	bg?: boolean;
	bg_color?: string;
	bg_radius?: number;
	bg_padding_x?: number;
	bg_padding_y?: number;
	/** Position, canvas px from the canvas centre (y grows downward). */
	x?: number;
	y?: number;
	opacity?: number;
}

// ---------------------------------------------------------------- Canvas
export interface SetCanvasOp extends OpBase {
	op: "set_canvas";
	w?: number;
	h?: number;
	/** A float (29.97 → 30000/1001, as the editor's floatToFrameRate) or an exact rational. */
	fps?: number | FrameRate;
	/** Background colour (CSS colour string). */
	background?: string;
}

export interface AddSizeVariantOp extends OpBase {
	op: "add_size_variant";
	aspect: string;
	reframe: "auto" | "keyframes";
}

// ---------------------------------------------------------------- Media
export interface ImportMediaOp extends OpBase {
	op: "import_media";
	blob_sha?: string;
	url?: string;
	kind: "video" | "audio" | "image";
	name?: string;
	/** Seconds. Needed for exact trims and for the "trim within media length" invariant. */
	duration?: number;
	width?: number;
	height?: number;
	fps?: number;
	has_audio?: boolean;
	ref?: string;
}

// ---------------------------------------------------------------- Tracks
export type TrackKind = "video" | "audio" | "text" | "caption" | "overlay" | "effect";

export interface AddTrackOp extends OpBase {
	op: "add_track";
	kind: TrackKind;
	name?: string;
	/** Position inside its group, 0 = top. Default: video/text/caption/overlay on top, audio at the bottom. */
	index?: number;
	ref?: string;
}

export interface RemoveTrackOp extends OpBase {
	op: "remove_track";
	track: string;
}

export interface ReorderTracksOp extends OpBase {
	op: "reorder_tracks";
	/** Every overlay and audio track id, top to bottom. "main" may appear; overlays must stay above it. */
	order: string[];
}

// ---------------------------------------------------------------- Elements
export type ShapeKind = "rectangle" | "ellipse" | "star" | "polygon";

export interface InsertOp extends OpBase {
	op: "insert";
	track: string;
	t: number;
	/** One of media / text / shape. */
	media?: string;
	/** Needed when `media` is an id not imported in this project's manifest. */
	media_kind?: "video" | "audio" | "image";
	text?: string;
	shape?: ShapeKind;
	/** Source in/out, seconds (video/audio). */
	in?: number;
	out?: number;
	/** Duration, seconds (image/text/shape; or video/audio when `out` is absent). */
	dur?: number;
	name?: string;
	/** Raw editor params, applied after defaults (keys as in params/registry.ts). */
	params?: Record<string, ParamValue>;
	style?: TextStyle;
	ref?: string;
}

export interface MoveOp extends OpBase {
	op: "move";
	el: string;
	t: number;
	track?: string;
}

export interface TrimOp extends OpBase {
	op: "trim";
	el: string;
	/** New source in point, seconds. The kept frames stay where they are on the timeline. */
	in?: number;
	/** New source out point, seconds. */
	out?: number;
}

export interface SplitOp extends OpBase {
	op: "split";
	el: string;
	t: number;
	/** Alias for the new right-hand element. */
	ref?: string;
}

export interface DeleteOp extends OpBase {
	op: "delete";
	el: string;
}

export interface RippleDeleteOp extends OpBase {
	op: "ripple_delete";
	el: string;
	/** "track" (the editor's ripple mode: only the element's track closes up) or "all" tracks. Default "track". */
	scope?: "track" | "all";
}

// ---------------------------------------------------------------- Motion
export type Ease = "linear" | "hold" | "bezier" | "ease_in" | "ease_out" | "ease_in_out";

export interface SetOp extends OpBase {
	op: "set";
	/** Element target, or `track` for track props (name, muted, hidden). */
	el?: string;
	track?: string;
	prop: string;
	value: ParamValue;
}

export interface KeyframeOp extends OpBase {
	op: "keyframe";
	el: string;
	/** x · y · scale · rotation · opacity · crop · volume, or a raw animatable param key. */
	prop: string;
	t: number;
	value: number;
	ease?: Ease;
	/** When true, `t` is seconds from the element's start instead of timeline seconds. */
	local?: boolean;
}

// ---------------------------------------------------------------- Text
export interface TimedWord {
	text: string;
	/** Timeline seconds. */
	start: number;
	end: number;
}

export interface AddCaptionsOp extends OpBase {
	op: "add_captions";
	/** Existing text track; omitted → a new caption track is created on top. */
	track?: string;
	words: TimedWord[];
	style?: TextStyle;
	/** Words per caption chunk, 1-3 (default 3). */
	max_words?: number;
	/** A gap longer than this (seconds) always starts a new chunk. Default 0.3. */
	gap?: number;
	ref?: string;
}

export interface SetCaptionStyleOp extends OpBase {
	op: "set_caption_style";
	track?: string;
	style: TextStyle;
}

export interface TextPopOp extends OpBase {
	op: "text_pop";
	t: number;
	text: string;
	style?: TextStyle;
	/** Seconds on screen, default 1.2. */
	dur?: number;
	track?: string;
	ref?: string;
}

// ---------------------------------------------------------------- Transitions
export interface TransitionOp extends OpBase {
	op: "transition";
	/** The outgoing clip (must end where `b` starts, on the same track). */
	a: string;
	/** The incoming clip; the transition is written on it (`transitionIn`, project v32). */
	b: string;
	/** A kind from ./transitions.ts (dissolve, whip-left, flash, zoom-in…) or an alias; cut/match = nothing to do. */
	kind: string;
	/** Seconds, default the kind's own (0.25–0.6). Centred on the cut. */
	dur?: number;
}

// ---------------------------------------------------------------- Audio
export interface GainOp extends OpBase {
	op: "gain";
	el: string;
	/** Absolute element level in dB (the editor's `volume` param, −60..+20). */
	db: number;
}

export interface DuckOp extends OpBase {
	op: "duck";
	/** The track that gets quieter (music). */
	track: string;
	/** The track it ducks under (voice). */
	under: string;
	/** How far to duck, dB (sign ignored: always a reduction). */
	amount_db: number;
	attack_ms?: number;
	release_ms?: number;
	/**
	 * Where the voice actually speaks, timeline seconds [start, end] (e.g. from a transcript or VAD). Without it the
	 * whole span of every element on `under` counts as voice.
	 */
	spans?: Array<[number, number]>;
}

export interface BeatsOp extends OpBase {
	op: "beats";
	/** The music element. */
	el: string;
	bpm: number;
	/** Beat times in SOURCE seconds (into the media file), ascending. */
	times: number[];
	/** Indices into `times` that start a bar. */
	downbeats?: number[];
	source?: "detected" | "board" | "manual";
}

export interface SnapCutsOp extends OpBase {
	op: "snap_cuts";
	/** The track whose cuts move; default "main". */
	track?: string;
	/** Largest move per cut, seconds (default 0.2 ≈ 6 frames at 30 fps). */
	max_shift?: number;
}

export interface SfxOp extends OpBase {
	op: "sfx";
	t: number;
	name: string;
	/** An imported media id/ref (upload audio)… */
	media?: string;
	/** …or a library URL (needs `dur`). With neither, the op is kept pending for the gateway to resolve. */
	url?: string;
	dur?: number;
	track?: string;
	db?: number;
	ref?: string;
}

export interface NormalizeOp extends OpBase {
	op: "normalize";
	lufs: number;
	true_peak: number;
}

// ---------------------------------------------------------------- Look
/**
 * A colour grade (the `restorff-grade` GPU effect; looks, nudges and params: ./grades.ts).
 * - `target`: an element id/ref (the grade goes in its `effects`), a track id/ref or "main" (every video/image clip on
 *   it), or "all" (an adjustment layer on a GRADE effect track above the footage, below text and captions).
 * - `preset`: a look ("warm morning", "moody", "clean", "film", "cool night", "punchy", "paper", "mono"), a nudge
 *   relative to the current grade ("warmer", "cooler", "brighter", "darker", "more contrast", …) or "none" (remove).
 * - `params`: slider values applied after the preset (exposure in stops, the rest −100…100; see GRADE_PARAM_SPECS).
 * - `lut`: kept as a pending instruction (no LUT loader yet).
 */
export interface GradeOp extends OpBase {
	op: "grade";
	target: string;
	preset?: string;
	params?: Record<string, number>;
	lut?: string;
}

export interface ApplyStyleOp extends OpBase {
	op: "apply_style";
	preset_id: string;
	params?: Record<string, unknown>;
}

// ---------------------------------------------------------------- Notes
export interface MarkOp extends OpBase {
	op: "mark";
	t: number;
	note: string;
	color?: string;
	dur?: number;
}

export type Op =
	| SetCanvasOp
	| AddSizeVariantOp
	| ImportMediaOp
	| AddTrackOp
	| RemoveTrackOp
	| ReorderTracksOp
	| InsertOp
	| MoveOp
	| TrimOp
	| SplitOp
	| DeleteOp
	| RippleDeleteOp
	| SetOp
	| KeyframeOp
	| AddCaptionsOp
	| SetCaptionStyleOp
	| TextPopOp
	| TransitionOp
	| GainOp
	| DuckOp
	| SfxOp
	| NormalizeOp
	| GradeOp
	| ApplyStyleOp
	| MarkOp
	| BeatsOp
	| SnapCutsOp;
