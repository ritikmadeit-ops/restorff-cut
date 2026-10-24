/**
 * Text style mapping (ops' friendly TextStyle → the editor's text params) and the built-in `apply_style` presets.
 */
import type { ApplyStyleOp, Op, TextStyle } from "./ops.ts";
import type { ParamValues, Project, SceneTracks, TimelineElement, TimelineTrack } from "./model.ts";
import { rateOf } from "./scene.ts";

/** TextStyle key → editor param key (params/registry.ts text + visual params). */
const STYLE_TO_PARAM: Record<string, string> = {
	font: "fontFamily",
	size: "fontSize",
	color: "color",
	weight: "fontWeight",
	align: "textAlign",
	letter_spacing: "letterSpacing",
	line_height: "lineHeight",
	bg: "background.enabled",
	bg_color: "background.color",
	bg_radius: "background.cornerRadius",
	bg_padding_x: "background.paddingX",
	bg_padding_y: "background.paddingY",
	x: "transform.positionX",
	y: "transform.positionY",
	opacity: "opacity",
};

export function styleToParams(style: TextStyle | undefined): ParamValues {
	const params: ParamValues = {};
	if (!style) return params;
	for (const [key, value] of Object.entries(style)) {
		if (value === undefined) continue;
		if (key === "italic") {
			params.fontStyle = value ? "italic" : "normal";
			continue;
		}
		if (key === "uppercase") continue;
		const paramKey = STYLE_TO_PARAM[key];
		if (paramKey) params[paramKey] = value as ParamValues[string];
	}
	return params;
}

export function applyTextCase(text: string, style: TextStyle | undefined): string {
	return style?.uppercase ? text.toUpperCase() : text;
}

/**
 * Caption default for vertical video: the editor's own subtitle default (bold, size 5 = 5/90 of canvas height,
 * subtitles/build-subtitle-text-element.ts SUBTITLE_FONT_SIZE and resolveSubtitleStyle) placed in the lower part of
 * the frame. The editor measures text
 * with a canvas to place it; the reducer cannot, so it uses a fixed offset from the centre instead.
 */
export function defaultCaptionStyle(canvasHeight: number): TextStyle {
	return { size: 5, weight: "bold", color: "#ffffff", align: "center", y: Math.round(canvasHeight * 0.2) };
}

/** A bigger headline-style text, upper third. */
export function defaultPopStyle(canvasHeight: number): TextStyle {
	return { size: 8, weight: "bold", color: "#ffffff", align: "center", y: -Math.round(canvasHeight * 0.22) };
}

export interface StyleContext {
	project: Project;
	tracks: SceneTracks;
	op: ApplyStyleOp;
}

/** An `apply_style` preset: a pure function from context to ops (recorded expanded, author forced to "preset"). */
export type StyleExpander = (context: StyleContext) => Op[];

// ---------------------------------------------------------------------------------------------------------------
// EDITING STYLE presets — the five styles of the editor's EDITING STYLE picker (design/edit-artboard.png), written
// as data + one expander. Each style says what it does to captions, pacing, joins, grade and which compositions it
// adds. Joins are real transitions (media agent, project v32) and the grade is the real `restorff-grade` effect
// (grade agent, ./grades.ts), both since 2026-10-20. Owner: the compose agent (docs/restorff/worklog/compose.md).
// ---------------------------------------------------------------------------------------------------------------

/** A composition a style adds (rendered by @restorffcut/compositions, imported, then inserted by the expander). */
export interface StyleComposition {
	/** Composition name in the library (packages/compositions/compositions/<name>). */
	name: string;
	/** Seconds from the start of the timeline; negative = seconds before the end of the A-roll (an end card). */
	at: number;
	/** Props for the render (fictional Halcyon Cold Brew content). */
	props: Record<string, unknown>;
}

/** Pacing = what happens to the A-roll (main track) clips. */
export type StylePacing =
	| { kind: "none" }
	/** Hard jump punch-ins: the clip alternates 1 ↔ `scale` every `every` seconds (a jump-cut feel without cutting). */
	| { kind: "jump"; every: number; scale: number }
	/** Slow push: each clip scales from 1 to `scale` over its whole length (ease in-out). */
	| { kind: "push"; scale: number }
	/** Light punch-ins: every `every` seconds, ease to `scale` over `ramp` seconds, hold, ease back. */
	| { kind: "punch"; every: number; scale: number; ramp: number };

export interface EditingStylePreset {
	id: string;
	label: string;
	hint: string;
	/** Applied to every caption track (text tracks named CAPTIONS or tagged role caption). y is a fraction of height. */
	captions: TextStyle & { yFraction?: number };
	pacing: StylePacing;
	/** Join between touching A-roll clips: a transition kind (./transitions.ts; "whip" alternates left / right). */
	join: string | null;
	/**
	 * "whip on beats": when the music has a beat grid (ops `beats`), cuts first roll onto the nearest beat (`snap_cuts`)
	 * and only the cuts on a beat get the join; with no beat grid every join gets it.
	 */
	joinOnBeats?: boolean;
	/** Grade: a look or alias from ./grades.ts (EFFECTS.md FX-38 warm = "warm morning", FX-39 moody), applied to the timeline. */
	grade: string | null;
	compositions: StyleComposition[];
	/** What this style cannot do yet, said plainly to the user. */
	notes: string[];
}

export const STYLE_PRESET_PREFIX = "restorff/style/";
/** Overlay track the expander puts compositions on (top of the overlay group). */
export const MOTION_TRACK_NAME = "MOTION";
/** Most joins a style records in one go (each is a pending instruction). */
const MAX_JOINS = 24;

export const EDITING_STYLE_PRESETS: EditingStylePreset[] = [
	{
		id: "fast-ugc",
		label: "Fast UGC · whip on beats",
		hint: "jump punch-ins every 1.5 s, whips between clips, bold word captions, a big-word hook",
		captions: { font: "Archivo Black", size: 6.5, weight: "bold", color: "#FFFFFF", bg: false, yFraction: 0.17 },
		pacing: { kind: "jump", every: 1.5, scale: 1.12 },
		join: "whip",
		joinOnBeats: true,
		grade: "punchy",
		compositions: [
			{
				name: "big-word-punch",
				at: 0,
				props: { word: "COLD", kicker: "HALCYON COLD BREW", sub: "Steeped 18 hours. Never bitter." },
			},
			{ name: "cta-social", at: -3.5, props: { keyword: "STEEP", handle: "@halcyon.coldbrew" } },
		],
		notes: [
			"Whips land on the beat when the music has a beat grid (Detect beats first): cuts roll onto the nearest beat, then whip. Without one, every cut whips.",
			"The punch-ins keep a fixed 1.5 s rhythm; they do not follow the beat yet.",
		],
	},
	{
		id: "talking-head",
		label: "Talking head · clean",
		hint: "light punch-ins every 4 s, clean white captions, fact pills",
		captions: { font: "Inter", size: 4.6, weight: "bold", color: "#FFFFFF", bg: false, yFraction: 0.2 },
		pacing: { kind: "punch", every: 4, scale: 1.06, ramp: 0.5 },
		join: null,
		grade: "clean",
		compositions: [
			{
				name: "badge-pills",
				at: 1,
				props: { pills: ["SMALL BATCH", "18-HOUR STEEP", "NO ADDED SUGAR"] },
			},
		],
		notes: ["Dead space and retakes come out with auto-cut, which needs word timings (TVF import); not run here."],
	},
	{
		id: "aesthetic-warm",
		label: "Aesthetic · warm magazine",
		hint: "slow push on every clip, serif captions on a label, a magazine-cover opener, warm grade",
		captions: {
			font: "Instrument Serif",
			size: 6,
			weight: "normal",
			color: "#F4E9DA",
			bg: true,
			bg_color: "#2F3B2C",
			bg_radius: 6,
			bg_padding_x: 26,
			bg_padding_y: 10,
			yFraction: 0.2,
		},
		pacing: { kind: "push", scale: 1.08 },
		join: null,
		grade: "warm-morning",
		compositions: [{ name: "magazine-cover", at: 0, props: {} }],
		notes: ["Grade: warm morning on the whole timeline (a GRADE layer under the captions); change it from the inspector's Grade row."],
	},
	{
		id: "moody-captions",
		label: "Moody · huge captions",
		hint: "huge condensed captions, a slow push, one big word, moody grade",
		captions: { font: "Bebas Neue", size: 13, weight: "normal", color: "#EDEBE6", bg: false, yFraction: 0 },
		pacing: { kind: "push", scale: 1.05 },
		join: null,
		grade: "moody",
		compositions: [
			{
				name: "big-word-punch",
				at: 0,
				props: { word: "NIGHT", kicker: "AFTER DARK", sub: "Cold brew for the late shift", accent: "#E8A33D", color: "#EDEBE6" },
			},
		],
		notes: ["Grade: moody on the whole timeline (darker, cooler, teal shadows; lamps stay warm)."],
	},
	{
		id: "paper-collage",
		label: "Paper collage",
		hint: "typewriter captions on yellow label tags, paper cut-out cards, a map route",
		captions: {
			font: "Special Elite",
			size: 4.8,
			weight: "normal",
			color: "#111111",
			bg: true,
			bg_color: "#F2D04B",
			bg_radius: 0,
			bg_padding_x: 22,
			bg_padding_y: 8,
			yFraction: 0.22,
		},
		pacing: { kind: "none" },
		join: null,
		grade: "paper",
		compositions: [
			{ name: "paper-cut", at: 0, props: {} },
			{ name: "map-route", at: 4, props: {} },
		],
		notes: [
			"Cutting the speaker out (torn white edge, FX-13) needs the person matte; the collage pieces are overlays.",
			"Grade: paper (faded, warm, light grain) on the whole timeline; there is no paper texture overlay yet.",
		],
	},
];

/** One rendered + imported composition the caller hands the expander through `apply_style` params. */
export interface StyleCompositionMedia {
	name: string;
	/** Media id in the editor's media store. */
	media: string;
	/** Seconds on the timeline (default: the preset's `at`). */
	t?: number;
	/** Seconds (the render's length). */
	dur: number;
	title?: string;
}

function isCaptionTrack(track: TimelineTrack): boolean {
	return track.type === "text" && (track.restorff?.role === "caption" || track.name.toUpperCase().startsWith("CAPTIONS"));
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

const TICKS = 120_000;
/** A style's join length, seconds (FX-40: a whip is 4–6 frames, ≤ 0.2 s). */
const JOIN_SECONDS = 0.2;
/** How far a cut may roll to land on a beat (snap_cuts max_shift), seconds. */
const BEAT_REACH_SECONDS = 0.2;
/** Joins that alternate direction from cut to cut. */
const JOIN_ALTERNATES: Record<string, string[]> = {
	whip: ["whip-left", "whip-right"],
	push: ["push-left", "push-right"],
};

/** Timeline ticks of every beat on unmuted music (same reading as the reducer's snap_cuts). */
function beatTimes(tracks: SceneTracks): number[] {
	const beats: number[] = [];
	for (const track of tracks.audio) {
		if (track.muted) continue;
		for (const element of track.elements) {
			if (!element.beats) continue;
			const rate = rateOf(element);
			for (const source of element.beats.times) {
				const time = element.startTime + (source - element.trimStart) / rate;
				if (time >= element.startTime && time < element.startTime + element.duration) beats.push(time);
			}
		}
	}
	return beats.sort((x, y) => x - y);
}
const endSeconds = (element: TimelineElement) => (element.startTime + element.duration) / TICKS;
const startSeconds = (element: TimelineElement) => element.startTime / TICKS;

/** Keyframe ops for one A-roll clip (absolute timeline seconds; the reducer turns them into element-local keys). */
function pacingOps(pacing: StylePacing, element: TimelineElement): Op[] {
	const a = startSeconds(element);
	const b = endSeconds(element);
	const len = b - a;
	const ops: Op[] = [];
	const key = (t: number, value: number, ease?: "hold" | "ease_in_out" | "linear") =>
		ops.push({ op: "keyframe", author: "preset", el: element.id, prop: "scale", t: round3(t), value, ...(ease ? { ease } : {}) });
	if (pacing.kind === "jump") {
		key(a, 1);
		let zoomed = false;
		for (let t = a + pacing.every; t < b - 0.25; t += pacing.every) {
			zoomed = !zoomed;
			key(t, zoomed ? pacing.scale : 1, "hold");
		}
	} else if (pacing.kind === "push") {
		if (len < 0.5) return ops;
		key(a, 1);
		key(b, pacing.scale, "ease_in_out");
	} else if (pacing.kind === "punch") {
		key(a, 1);
		for (let t = a + pacing.every; t + pacing.ramp * 2 + 1 < b; t += pacing.every) {
			key(t, 1);
			key(t + pacing.ramp, pacing.scale, "ease_in_out");
			const back = Math.min(t + pacing.every * 0.6, b - pacing.ramp);
			key(back, pacing.scale);
			key(back + pacing.ramp, 1, "ease_in_out");
		}
	}
	return ops;
}

/**
 * Expand an editing style into ops. Context it reads: the active scene's tracks and the canvas height. Params:
 * `compositions` — StyleCompositionMedia[] for the compositions already rendered and imported by the caller (the
 * reducer is pure: it cannot render). Compositions an earlier style added (made by a preset on a MOTION track) are
 * deleted first, so switching styles replaces them instead of stacking.
 */
export function expandEditingStyle(preset: EditingStylePreset, context: StyleContext): Op[] {
	const { tracks, project, op } = context;
	const height = project.settings.canvasSize.height;
	const ops: Op[] = [];

	// 1. compositions a previous style added
	const motionTracks = tracks.overlay.filter((track) => track.type === "video" && track.name.toUpperCase().startsWith(MOTION_TRACK_NAME));
	const removed = new Set<string>();
	for (const track of motionTracks) {
		for (const element of track.elements) {
			if (element.restorff?.createdBy === "preset") {
				ops.push({ op: "delete", author: "preset", el: element.id });
				removed.add(element.id);
			}
		}
	}

	// 2. captions
	const { yFraction, ...captionStyle } = preset.captions;
	const style: TextStyle = { ...captionStyle, align: "center", ...(yFraction !== undefined ? { y: Math.round(height * yFraction) } : {}) };
	for (const track of tracks.overlay) {
		if (isCaptionTrack(track) && track.elements.length) ops.push({ op: "set_caption_style", author: "preset", track: track.id, style });
	}

	// 3. pacing on the A-roll
	const aroll = tracks.main.elements
		.filter((element) => element.type === "video" || element.type === "image")
		.slice()
		.sort((x, y) => x.startTime - y.startTime);
	if (preset.pacing.kind !== "none") for (const element of aroll) ops.push(...pacingOps(preset.pacing, element));

	// 4. joins between touching A-roll clips (real transitions, project v32). "whip on beats" (grade agent,
	//    2026-10-20): with a beat grid, cuts first roll onto the nearest beat (snap_cuts, the editor's own rule), then
	//    only the cuts within reach of a beat get the join; whips alternate left / right like a camera swinging back.
	if (preset.join) {
		const beats = preset.joinOnBeats ? beatTimes(tracks) : [];
		if (beats.length) ops.push({ op: "snap_cuts", author: "preset", track: "main", max_shift: BEAT_REACH_SECONDS });
		const kinds = JOIN_ALTERNATES[preset.join] ?? [preset.join];
		// a clip must stay longer than the join after a snap moved both of its edges
		const minClip = (JOIN_SECONDS + 2 * BEAT_REACH_SECONDS) * TICKS;
		const reach = BEAT_REACH_SECONDS * TICKS;
		let joins = 0;
		for (let i = 1; i < aroll.length && joins < MAX_JOINS; i++) {
			const prev = aroll[i - 1] as TimelineElement;
			const next = aroll[i] as TimelineElement;
			if (prev.startTime + prev.duration !== next.startTime) continue;
			if (prev.duration < minClip || next.duration < minClip) continue;
			const cut = next.startTime;
			if (beats.length && !beats.some((beat) => Math.abs(beat - cut) <= reach)) continue;
			ops.push({ op: "transition", author: "preset", a: prev.id, b: next.id, kind: kinds[joins % kinds.length] as string, dur: JOIN_SECONDS });
			joins++;
		}
	}

	// 5. grade: the real `restorff-grade` effect on a GRADE layer over the footage (grade agent, ./grades.ts)
	if (preset.grade) ops.push({ op: "grade", author: "preset", target: "all", preset: preset.grade });

	// 6. compositions the caller rendered and imported
	const media = Array.isArray(op.params?.compositions) ? (op.params?.compositions as StyleCompositionMedia[]) : [];
	if (media.length) {
		const arollEnd = aroll.reduce((end, element) => Math.max(end, endSeconds(element)), 0);
		const free = (track: TimelineTrack, a: number, b: number) =>
			track.elements.every((element) => removed.has(element.id) || endSeconds(element) <= a || startSeconds(element) >= b);
		const created: { ref: string; spans: Array<[number, number]> }[] = [];
		let n = 0;
		for (const item of media) {
			const asked = item.t ?? preset.compositions.find((c) => c.name === item.name)?.at ?? 0;
			// negative = before the end of the A-roll (end cards); never before 0
			const at = round3(asked < 0 ? Math.max(0, arollEnd + asked) : asked);
			const span: [number, number] = [at, at + item.dur];
			let target: string | undefined = motionTracks.find((track) => free(track, span[0], span[1]))?.id;
			if (!target) {
				const mine = created.find((c) => c.spans.every(([a, b]) => b <= span[0] || a >= span[1]));
				if (mine) {
					target = mine.ref;
					mine.spans.push(span);
				}
			} else {
				// reserve the span on the existing track for the next items (context.tracks is the expander's own copy)
				const track = motionTracks.find((candidate) => candidate.id === target) as { elements: TimelineElement[] };
				track.elements = [
					...track.elements,
					{ id: `reserved-${n}`, startTime: Math.round(span[0] * TICKS), duration: Math.round(item.dur * TICKS) } as TimelineElement,
				];
			}
			if (!target) {
				n++;
				const ref = `style-motion-${n}`;
				const name = motionTracks.length + created.length === 0 ? MOTION_TRACK_NAME : `${MOTION_TRACK_NAME} ${motionTracks.length + created.length + 1}`;
				ops.push({ op: "add_track", author: "preset", kind: "video", name, index: 0, ref });
				created.push({ ref, spans: [span] });
				target = ref;
			}
			ops.push({
				op: "insert",
				author: "preset",
				track: target,
				t: round3(at),
				media: item.media,
				media_kind: "video",
				dur: item.dur,
				name: item.title ?? item.name,
			});
		}
	}
	return ops;
}

/** Look a preset up by id ("fast-ugc") or by its apply_style id ("restorff/style/fast-ugc"). */
export function getEditingStylePreset(id: string): EditingStylePreset | undefined {
	const bare = id.startsWith(STYLE_PRESET_PREFIX) ? id.slice(STYLE_PRESET_PREFIX.length) : id;
	return EDITING_STYLE_PRESETS.find((preset) => preset.id === bare);
}

/**
 * Built-in presets: `restorff/bold-captions` plus one `restorff/style/<id>` per editing style. Restorff's preset
 * store (plan/05 §9) can add more through `ApplyOptions.styles`.
 */
export const BUILTIN_STYLES: Record<string, StyleExpander> = {
	"restorff/bold-captions": () => [
		{
			op: "set_caption_style",
			author: "preset",
			style: { weight: "bold", size: 6, color: "#ffffff", bg: true, bg_color: "#000000", bg_radius: 20, uppercase: true },
		},
	],
	...Object.fromEntries(
		EDITING_STYLE_PRESETS.map((preset) => [
			`${STYLE_PRESET_PREFIX}${preset.id}`,
			(context: StyleContext) => expandEditingStyle(preset, context),
		]),
	),
};
