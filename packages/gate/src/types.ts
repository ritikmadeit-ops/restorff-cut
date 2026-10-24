/**
 * Types for the export gate. `Finding` is finding@1 (docs/restorff/EXPORT-GATE.md §4; canonical schema
 * restorff/workers/judge/schemas/finding.schema.json). The project types are deliberately LOOSE: the gate reads the
 * editor's project JSON (in-memory TProject or the serialized form) and must not break when another agent adds a
 * field. Times in the project are integer ticks (120 000 / s); every time in a finding is seconds.
 */

export type Severity = "must" | "should" | "info";
export type FindingStatus = "open" | "candidate" | "confirmed" | "dismissed" | "fixed";
/**
 * The finding@1 lane (the canonical schema's enum; the comments store validates it). The REAL lane the finding sits on
 * (e.g. "MOTION", "PAPER") is `Finding.track_name` + `track_id` (gate-v2, 2026-10-20).
 */
export type FindingTrack = "TEXT" | "CAPTIONS" | "V2 B-ROLL" | "V1 A-ROLL" | "MUSIC" | "SFX" | "MASTER" | null;
export type Evidence = "MEASURED" | "SEEN" | "READ" | "TIMELINE";

/** What kind of piece the timeline is: it chooses the rule set (piece.ts PROFILES; EXPORT-GATE §2a). */
export type PieceType = "ad" | "explainer" | "brand_film" | "motion_graphic" | "talking_head";

/** How the piece was decided, said in every result. */
export interface PieceDecision {
	type: PieceType;
	/** "project" (metadata.restorff.piece) and "brief" are owner-set and win over a check argument (D13). */
	source: "project" | "brief" | "check argument" | "inferred";
	why: string;
	/** A check argument that lost to an owner-set piece, with why. */
	ignored?: { type: string; why: string } | null;
}

/**
 * An exact call that fixes the finding. The gate fills everything it knows; the server adds `timeline_id` and
 * `base_commit` (the head) for tools that need them. `ops` are ops@1.
 */
export interface FixCall {
	tool: string;
	arguments: Record<string, unknown>;
	/** One line: what the call does and why it fixes the finding. */
	does?: string;
}

/**
 * finding@1. Note: the brief for the gate asked for `evidence: "TIMELINE"` on timeline checks; the canonical schema
 * enum is MEASURED · SEEN · READ. We emit "TIMELINE" for exact timeline reads (and the file checks emit "MEASURED");
 * `toSchemaFinding` maps TIMELINE → READ when a strict finding@1 consumer needs it.
 */
export interface Finding {
	id: string;
	rule: string;
	severity: Severity;
	status: FindingStatus;
	t: number;
	t_end: number | null;
	track: FindingTrack;
	element_id: string | null;
	measure?: Record<string, number | string | boolean | null>;
	target?: string;
	evidence: Evidence;
	message: string;
	fix: string;
	source: string;
	file?: string;
	render_id?: string | null;
	commit?: string | null;
	dismissed_reason?: string | null;
	resolved_by?: string | null;
	/** The real lane (track id + its name on the timeline, e.g. "MOTION"); `track` stays the finding@1 lane. */
	track_id?: string | null;
	track_name?: string | null;
	/** The exact call that fixes it (gate-v2). `fix` stays the plain sentence. */
	fix_call?: FixCall | null;
}

// ------------------------------------------------------------------ loose project shape

export interface GateAnimationKey {
	time: number;
	value: unknown;
}
export type GateChannel = { keys?: GateAnimationKey[] } | Record<string, { keys?: GateAnimationKey[] } | undefined>;

export interface GateElement {
	id: string;
	name?: string;
	type: string;
	startTime: number;
	duration: number;
	trimStart?: number;
	trimEnd?: number;
	sourceDuration?: number;
	mediaId?: string;
	hidden?: boolean;
	isSourceAudioEnabled?: boolean;
	retime?: { rate: number } | null;
	params?: Record<string, unknown>;
	animations?: Record<string, GateChannel | undefined>;
	beats?: { bpm?: number; times: number[]; downbeats?: number[] } | null;
	restorff?: { role?: string; silence?: string; dramatic?: boolean; [k: string]: unknown } | null;
	[k: string]: unknown;
}

export interface GateTrack {
	id: string;
	name?: string;
	type: string;
	elements: GateElement[];
	hidden?: boolean;
	muted?: boolean;
	restorff?: { role?: string; [k: string]: unknown } | null;
	[k: string]: unknown;
}

export interface GateScene {
	id: string;
	isMain?: boolean;
	tracks: { overlay: GateTrack[]; main: GateTrack; audio: GateTrack[] };
	[k: string]: unknown;
}

/** What a brief can tell the gate (metadata.restorff.brief). Every field optional. */
export interface GateBrief {
	/** false = this ad has no offer: R15 is skipped. An object = the verified offer strings (exact match). */
	offer?: false | { price?: string; reason?: string; cta?: string };
	price?: string;
	reason?: string;
	cta?: string;
	/** Delivery size, e.g. {width:1080,height:1920} or "1080x1920". Default 1080x1920. */
	deliver?: { width: number; height: number } | string;
	fps?: number;
	/** The opening is one marked dramatic shot (R1 exemption). */
	dramatic_open?: boolean;
	/** The piece type (owner-set; metadata.restorff.piece wins over it). */
	piece?: PieceType;
	/** Where it runs: reels · tiktok · shorts · feed · youtube · broadcast (chooses the SAFE zone). */
	platform?: string;
}

export interface GateOverride {
	rule: string;
	reason: string;
	/** "user:<id>" — the project owner. Never "claude…". */
	by: string;
	/** ISO time. */
	at: string;
	finding_id?: string | null;
	/** Seconds; an override matches findings of its rule within ±0.5 s of t (null/undefined = every finding of the rule). */
	t?: number | null;
	/** Display label for `by`, e.g. "local user (owner until sign-in)". */
	by_label?: string;
}

export interface GateRestorffMeta {
	brief?: GateBrief;
	overrides?: GateOverride[];
	/** Spans the music bed is deliberately silent (R12): seconds. */
	silences?: Array<{ t: number; t_end: number; reason: string }>;
	/** The board's music moments (R21): seconds. */
	board?: { music?: { hits?: Array<{ t: number; what?: string; shot?: string }> } };
	music?: { hits?: Array<{ t: number; what?: string; shot?: string }> };
	/** The piece type, set by the owner (a string, or {type, set_by, at}). Chooses the rule set. */
	piece?: PieceType | { type: PieceType; set_by?: string; at?: string } | null;
	/** Where it runs (SAFE zone): reels · tiktok · shorts · feed · youtube · broadcast. */
	platform?: string;
	[k: string]: unknown;
}

export interface GateProject {
	metadata: { id?: string; name?: string; restorff?: GateRestorffMeta | null; [k: string]: unknown };
	scenes: GateScene[];
	currentSceneId?: string;
	settings: {
		fps: { numerator: number; denominator: number } | number;
		canvasSize: { width: number; height: number };
		[k: string]: unknown;
	};
	[k: string]: unknown;
}

/** The box a text element occupies on the canvas, in canvas px, relative to its anchor (before scale). */
export interface TextRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface MediaInfo {
	/** Seconds. */
	duration?: number;
	width?: number;
	height?: number;
	fps?: number;
	hasAudio?: boolean;
	/** The file carries an alpha channel (a PNG cut-out, a VP9-alpha overlay): it never covers the frame. */
	alpha?: boolean;
}

/**
 * What a composition says about itself (gate-v2). Declared by the composition (manifest or props `scenes` / `text` /
 * `opaque`), or measured by the server on the composition's own render (scene cuts from a frame diff, an alpha grid).
 * Times are seconds from the composition's own start (its local time, before trim and speed).
 */
export interface CompositionFacts {
	/** Scene boundaries inside the composition (local seconds, > 0). */
	scenes?: number[];
	/** On-screen text: content and, when known, when it shows (local seconds) and where (0..1 of the canvas). */
	text?: Array<{ content: string; t?: number; t_end?: number; role?: string; box?: [number, number, number, number] }>;
	/** Fully opaque full-frame picture (it hides everything under it). */
	opaque?: boolean;
	/**
	 * Coverage grid of the visible (alpha) pixels: `frames[i]` is rows × cols bytes (0..255), sampled at `fps`
	 * from local time 0. Used for FACE (overlay vs face box) and for `opaque`.
	 */
	alpha?: { fps: number; cols: number; rows: number; frames: number[][] };
	/** Big picture changes measured inside the composition's own render that last 1–3 frames (designed flashes). */
	flashes?: number[];
	/** Local spans [from, to] where the composition's own render changes fast (its own animation: slams, slides, whips). */
	motion?: Array<[number, number]>;
	/** Where the facts came from, per field ("manifest", "props", "render"). */
	from?: Record<string, string>;
}

/** A face track for a media file: boxes in 0..1 of the SOURCE frame, times in SOURCE seconds (server/matte.ts). */
export interface FaceTrackLite {
	source: { width: number; height: number };
	frames: Array<{ t: number; box: [number, number, number, number] | null }>;
}

/** A measured flash on the encoded file (two big frame changes 1–3 frames apart), seconds. */
export interface FlashMeasure {
	t: number;
	t_end: number;
	frames: number;
	/** The frame-difference sizes (0..255 mean abs luma) entering and leaving the flash, and the local median. */
	in_diff: number;
	out_diff: number;
	median_diff: number;
	/** Mean luma (0..255) of the flash frames, when measured: under 12 it is a black frame. */
	luma?: number;
	/** Where the change was measured: the whole frame, or the speaker's face box (a same-camera sliver at a jump cut). */
	region?: "frame" | "face";
}

export interface TimelineCheckOptions {
	/** Which scene (default: currentSceneId, else the main scene). */
	sceneId?: string;
	/**
	 * Exact text measurement (the editor's `visualRect`, or the server's Chromium measurer — the caption builder's).
	 * Without it the gate estimates the box from font size and character count (ASSUMPTION: 0.55 em per character).
	 */
	measureText?: (element: GateElement) => TextRect | null;
	/** Name of the measurer, reported on SAFE findings (default "canvas" when measureText is given). */
	measureMethod?: string;
	/** The media store's facts, by mediaId (durations in seconds) — for CLEAN "clip shorter than its slot". */
	media?: Record<string, MediaInfo>;
	/** Stamped on every finding. */
	source?: string;
	commit?: string | null;
	/** The piece type asked for in this run (`check {piece}`); an owner-set piece wins (D13). */
	piece?: PieceType | string | null;
	/** Where it runs (overrides metadata/brief platform): reels · tiktok · shorts · feed · youtube · broadcast. */
	platform?: string | null;
	/** Facts about composition elements, by element id or by mediaId (the server's measurements of their renders). */
	compositions?: Record<string, CompositionFacts>;
	/** Face tracks by mediaId (only media with a finished matte). */
	faces?: Record<string, FaceTrackLite>;
	/**
	 * revise-safety (2026-10-21): media ids of talking clips (speech transcribed) with no face track yet — FACE judges
	 * captions over them against a presumed face band (the middle of the frame) instead of skipping them.
	 */
	presumedFaces?: string[];
	/** Facts the server knows outside the project JSON, for inferring the piece. */
	hints?: { references?: boolean };
}

export interface CheckRun {
	findings: Finding[];
	/** Check ids that ran. */
	ran: string[];
	/** Checks that should have run and did not, with why: the gate is INCOMPLETE while any is listed. */
	not_run: Array<{ rule: string; why: string }>;
	/** Checks that did not apply (e.g. R15 with offer:false), with why. Never blocks. */
	skipped: Array<{ rule: string; why: string }>;
	/** The piece the rules were chosen for (timeline runs). */
	piece?: PieceDecision;
	/** The picture changes the rhythm rules counted (timeline runs): how many of each kind. */
	changes?: Record<string, number>;
}

export type GateState = "PASS" | "BLOCKED" | "INCOMPLETE";

export interface GateReport extends CheckRun {
	state: GateState;
	/** Musts still blocking (open or candidate, not overridden). */
	blocking: Finding[];
	/** Overrides that matched a finding or a not-run check. */
	applied_overrides: GateOverride[];
	counts: { must: number; should: number; info: number };
}

// ------------------------------------------------------------------ file checks

export interface LoudnessMeasure {
	integrated_lufs: number | null;
	true_peak_dbtp: number | null;
	lra_lu: number | null;
}

export interface ProbeMeasure {
	width: number | null;
	height: number | null;
	fps: number | null;
	video_codec: string | null;
	audio_codec: string | null;
	duration_s: number | null;
	container: string | null;
}

export interface SpanMeasure {
	t: number;
	t_end: number;
	duration: number;
}

export interface FileMeasures {
	file: string;
	probe: ProbeMeasure | null;
	loudness: LoudnessMeasure | null;
	black: SpanMeasure[] | null;
	frozen: SpanMeasure[] | null;
	/** Which measurement failed, with the error text. */
	errors: Array<{ rule: string; why: string }>;
	/** FLASH on the file (gate-v2): measured flashes; undefined = not measured (FLASH's file half is skipped). */
	flashes?: FlashMeasure[] | null;
	/** Retention (2026-10-24, HOOK / DEAD): the measured hook and still stretches; undefined = not measured. */
	retention?: {
		first_change_s: number | null;
		longest_still_s: number | null;
		longest_at: [number, number] | null;
		still_over_3s: number;
		events_per_10s: number;
		cuts_per_10s: number;
		cuts_on_hit_pct: number | null;
	} | null;
}

export interface FileExpect {
	width: number;
	height: number;
	fps: number;
	/** Default true: H.264 + AAC (EXPORT-GATE FORMAT). */
	requireH264Aac?: boolean;
	lufs?: number;
	lufsTolerance?: number;
	truePeakMax?: number;
}
