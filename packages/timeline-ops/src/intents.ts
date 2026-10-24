/**
 * Sentence → ops@1 for the edits that need no model ("tell Claude one sentence and the whole video changes",
 * REELS.md EDT-13 / EDT-16, reel DeUUFJQu8cw: "make it more aesthetic", "tighter cut, bigger captions").
 *
 * Pure and deterministic: a sentence plus the project in, a plan out. Nothing here guesses: a clause that matches no
 * rule comes back in `unmatched`, and the caller hands it to the user's own Claude (the editor's command bar copies a
 * ready prompt; Claude answers through the MCP `timeline_ops` tool). Owner: the bridge agent
 * (docs/restorff/worklog/bridge.md).
 *
 * What it understands (one sentence may hold several, split on commas / "and" / "then"):
 *   style     "make it moody" · "aesthetic" · "fast" · "clean" · "paper collage"  → apply_style restorff/style/<id>
 *   pacing    "tighter cut" · "cut the pauses" · "remove gaps" ("much tighter" = stronger) → split / delete / move
 *   captions  "bigger captions" · "captions at the top" · "yellow captions" · "captions on a box" · "serif captions"
 *             · "uppercase captions" · "hide captions"                         → set_caption_style / set (track)
 *   grade     "warmer" · "cooler" · "black and white" · "darker" · "brighter" · "more contrast" · "film look"
 *             · "warm morning" · "cool night" → grade (a look or a nudge of ./grades.ts on the timeline's GRADE
 *             layer — applied, one undo step; grade agent 2026-10-20)
 *   composition (only when the caller says a composition clip is selected): "slower" · "bigger" · "make it red" …
 *             → returned in `compositionClauses` for @restorffcut/compositions' nudge (it renders; this cannot)
 */
import type { Op, TextStyle } from "./ops.ts";
import type { Author, Project, SceneTracks, TimelineElement, TimelineTrack } from "./model.ts";
import { EDITING_STYLE_PRESETS, STYLE_PRESET_PREFIX } from "./styles.ts";

const TICKS = 120_000;

export type IntentKind = "style" | "pacing" | "captions" | "grade" | "composition";

export interface ClausePlan {
	/** The clause as typed (trimmed). */
	text: string;
	/** What it matched, in order; empty = not understood. */
	kinds: IntentKind[];
	/** Short human label per match: "moody style", "tighter cut", "captions 1.35× bigger". */
	labels: string[];
	ops: Op[];
	notes: string[];
	/** Why nothing was done for this clause (only when `kinds` is empty, or a match had nothing to change). */
	reason?: string;
}

export interface IntentPlan {
	sentence: string;
	clauses: ClausePlan[];
	/** Every op of every matched clause, in order (style first, then pacing, captions, grade). */
	ops: Op[];
	/** True when every clause matched something. */
	understood: boolean;
	/** True when at least one clause matched. */
	matched: boolean;
	/** "moody style + tighter cut + bigger captions" */
	label: string;
	/** Clauses nobody here understood: send them to the user's Claude. */
	unmatched: string[];
	/** Clauses for the selected composition's sentence nudge (caller renders). */
	compositionClauses: string[];
	/** The editing style picked, if any (the caller may render its compositions and pass them as apply_style params). */
	styleId: string | null;
	/** Things done only partly or recorded but not drawn, in plain words. */
	notes: string[];
}

export interface IntentContext {
	project: Project;
	/** Default: project.currentSceneId, else the main scene. */
	sceneId?: string;
	/** Author written on every op (default "user": the person typed it; MCP passes "claude"). */
	author?: Author;
	/** A composition clip is selected: short nudges ("slower", "bigger", "make it red") go to it. */
	compositionSelected?: boolean;
}

// ─── words ──────────────────────────────────────────────────────────────────────────────────────────────────────

const STYLE_RULES: Array<{ id: string; re: RegExp; label: string }> = [
	{ id: "moody-captions", re: /\b(mood(y|ier)|cinematic|noir|after dark|brooding|huge captions style)\b/, label: "moody" },
	{ id: "aesthetic-warm", re: /\b(aesthetic|magazine|editorial|dreamy|warm aesthetic|cozy|cosy)\b/, label: "aesthetic" },
	{ id: "paper-collage", re: /\b(paper|collage|cut-?outs?|scrapbook|explainer|zine)\b/, label: "paper collage" },
	{ id: "talking-head", re: /\b(clean(er)?|simple(r)?|minimal(ist)?|talking[- ]head|professional|corporate)\b/, label: "clean" },
	{ id: "fast-ugc", re: /\b(fast(er)?|punch(y|ier)|energetic|ugc|tiktok|hype|viral|snappy|high[- ]energy|whip)\b/, label: "fast" },
];

const PACING_RE =
	/\b(tight(er|en|en up|en it)?|snappier cut|quicker cut|faster (cut|pacing|pace|edit)|(cut|remove|trim|kill|drop|lose) (out )?(the |all )?(dead (air|space)|pauses?|silences?|gaps?|breaths?)|less (dead (air|space)|pauses?)|close (the )?gaps?|no (dead (air|space)|pauses))\b/;
const STRONG_RE = /\b(much|way|a lot|lots|really|super|very|even|extra|more aggressive(ly)?)\b/;

const CAPTION_SUBJECT_RE = /\b(captions?|subtitles?|subs|lyrics|words on screen|on-screen text)\b/;

const COLORS: Record<string, string> = {
	neon: "#F6FF00",
	yellow: "#FFD60A",
	white: "#FFFFFF",
	bone: "#EDEBE6",
	cream: "#F4E9DA",
	black: "#0C0C0E",
	red: "#E5484D",
	orange: "#E8A33D",
	amber: "#E8A33D",
	gold: "#E8B04B",
	green: "#3DD68C",
	blue: "#4C8DFF",
	purple: "#8E6CFF",
	pink: "#FF5FA2",
	grey: "#8C8C95",
	gray: "#8C8C95",
};
const COLOR_RE = new RegExp(`(#[0-9a-f]{6}\\b|\\b(${Object.keys(COLORS).join("|")})\\b)`);

// Grade words → a look or nudge of ./grades.ts (grade agent, 2026-10-20: applied as the real `restorff-grade`
// effect on the timeline's GRADE layer; nudges are relative to the grade already there). First match wins, so the
// specific looks come before the bare nudges ("warm morning" is a look, "warmer" a nudge).
const GRADE_RULES: Array<{ preset: string; re: RegExp; label: string }> = [
	{ preset: "mono", re: /\b(black_and_white|b&w|monochrome|gr[ae]yscale)\b/, label: "black and white" },
	{ preset: "warm-morning", re: /\b(warm morning|morning light|golden( hour)?|warm (look|tone|grade))\b/, label: "warm morning" },
	{ preset: "cool-night", re: /\b(cool night|night (look|grade)|blue hour|cold(er)? (look|tone)|cool (look|tone|grade)|blu(e|er) tint)\b/, label: "cool night" },
	{ preset: "film", re: /\b(film( look)?|vintage|retro|grain(y)?|analog(ue)?)\b/, label: "film" },
	{ preset: "punchy", re: /\b(punchy (look|grade|colou?rs?))\b/, label: "punchy" },
	{ preset: "clean", re: /\b(clean (look|grade|colou?rs?)|natural colou?rs?|neutral (look|grade))\b/, label: "clean" },
	{ preset: "none", re: /\b(no grade|remove the grade|ungrade|original colou?rs?)\b/, label: "no" },
	{ preset: "warmer", re: /\b(warm(er)?|warm it up)\b/, label: "warmer" },
	{ preset: "cooler", re: /\b(cool(er)?|cool it down)\b/, label: "cooler" },
	{ preset: "less-contrast", re: /\b(less contrast|softer contrast|flatter)\b/, label: "less contrast" },
	{ preset: "more-contrast", re: /\b(more contrast|contrast(y)?|crisper)\b/, label: "more contrast" },
	{ preset: "more-saturation", re: /\b(saturated?|vivid|more colou?r(ful)?|pop more)\b/, label: "more colour" },
	{ preset: "less-saturation", re: /\b(desaturat(e|ed)|muted colou?rs?|washed out|less colou?r)\b/, label: "less colour" },
	{ preset: "darker", re: /\b(dark(er|en)?|dimmer)\b/, label: "darker" },
	{ preset: "brighter", re: /\b(bright(er|en)?|lighter|lift the shadows)\b/, label: "brighter" },
];

/** What the compositions nudge understands (packages/compositions/src/edits.ts). */
const NUDGE_RE = new RegExp(
	`\\b(slow(er)?|fast(er)?|quick(er)?|big(ger)?|small(er)?|large(r)?|huge|tiny|bounc(y|ier)|spring(y|ier)|calm(er)?|snapp(y|ier)|smooth(er)?|move (it )?(up|down)|higher|lower|no exit|colou?r|accent|${Object.keys(COLORS).join("|")})\\b|#[0-9a-f]{6}`,
);
/** Words that say "the whole video", so a nudge never steals the clause. */
const WHOLE_RE = /\b(video|edit|cut|whole|everything|all of it|timeline|the ad|reel|footage|style|grade|look|captions?|subtitles?)\b/;

// ─── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

function normalise(sentence: string): string {
	return sentence
		.toLowerCase()
		.replace(/[“”"']/g, "")
		.replace(/\bblack (and|&|n) white\b/g, "black_and_white")
		.replace(/\s+/g, " ")
		.trim();
}

/** Split on , ; . ! ? + & and the words "and", "then", "also", "plus" (never inside "black_and_white"). */
export function splitClauses(sentence: string): string[] {
	return normalise(sentence)
		.split(/\s*(?:[,;.!?+&]|\band then\b|\bthen\b|\band\b|\balso\b|\bplus\b)\s*/)
		.map((part) => part.replace(/^(please|pls|can you|could you|now|just|and|ok|okay)\s+/g, "").trim())
		.filter((part) => part.length > 0);
}

function round(n: number, digits = 3): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

function sceneTracks(project: Project, sceneId?: string): SceneTracks | null {
	const scenes = project.scenes ?? [];
	const scene =
		(sceneId ? scenes.find((s) => s.id === sceneId) : undefined) ??
		scenes.find((s) => s.id === project.currentSceneId) ??
		scenes.find((s) => s.isMain) ??
		scenes[0];
	return scene?.tracks ?? null;
}

function allTracks(tracks: SceneTracks): TimelineTrack[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

/** Text tracks that hold captions (tagged by ops, named CAPTIONS…, or holding caption-tagged elements). */
/** The captions agent's word-highlight and shadow layers ("CAPTION WORDS", "CAPTION SHADOW"): laid out from measured
 * text, so they can't be rescaled here — only rebuilt by the Captions tab. */
function isCaptionOverlayLayer(track: TimelineTrack): boolean {
	const layer = (track.restorff as { captionLayer?: string } | undefined)?.captionLayer;
	return layer === "words" || layer === "shadow" || /^caption (words|shadow)$/i.test(track.name ?? "");
}

export function captionTracks(tracks: SceneTracks): TimelineTrack[] {
	return tracks.overlay.filter(
		(track) =>
			track.type === "text" &&
			!isCaptionOverlayLayer(track) &&
			(track.restorff?.role === "caption" ||
				/^(captions?|subtitles?)$/i.test(track.name ?? "") ||
				track.elements.some((element) => element.restorff?.role === "caption")),
	);
}

function median(values: number[]): number | undefined {
	if (!values.length) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

// ─── captions ───────────────────────────────────────────────────────────────────────────────────────────────────

function captionClause(clause: string, tracks: SceneTracks, height: number, author: Author): { ops: Op[]; labels: string[]; notes: string[]; reason?: string } {
	const targets = captionTracks(tracks).filter((track) => track.elements.length > 0);
	if (!targets.length) {
		return { ops: [], labels: [], notes: [], reason: "there are no captions on this timeline yet (add them first: auto-captions, or ask your Claude)" };
	}
	if (tracks.overlay.some((track) => isCaptionOverlayLayer(track) && track.elements.length > 0)) {
		return { ops: [], labels: [], notes: [], reason: "these captions are styled word by word — change them in the Captions tab (it re-measures every word)" };
	}
	const ops: Op[] = [];
	const labels: string[] = [];
	const notes: string[] = [];

	// show / hide the whole track
	if (/\b(hide|remove|turn off|no|delete|get rid of|drop)\b/.test(clause) && !/\b(box|background|label|pill|caps|uppercase)\b/.test(clause)) {
		for (const track of targets) ops.push({ op: "set", author, track: track.id, prop: "hidden", value: true });
		return { ops, labels: ["captions hidden"], notes };
	}
	if (/\b(show|turn on|bring back|unhide)\b/.test(clause)) {
		for (const track of targets) ops.push({ op: "set", author, track: track.id, prop: "hidden", value: false });
		return { ops, labels: ["captions shown"], notes };
	}

	const style: TextStyle = {};
	// size
	const sizes = targets.flatMap((track) =>
		track.elements.map((element) => Number((element.params as Record<string, unknown>)?.fontSize)).filter((n) => Number.isFinite(n) && n > 0),
	);
	const current = median(sizes) ?? 5;
	let factor: number | null = null;
	if (/\b(huge|giant|massive|enormous|gigantic)\b/.test(clause)) factor = 1.8;
	else if (/\b(bigger|larger|big|large|increase)\b/.test(clause)) {
		factor = STRONG_RE.test(clause) ? 1.6 : /\b(slightly|a bit|a little|a touch|bit)\b/.test(clause) ? 1.15 : 1.35;
	} else if (/\b(smaller|small|tiny|shrink|reduce|less big)\b/.test(clause)) {
		factor = STRONG_RE.test(clause) ? 0.6 : /\b(slightly|a bit|a little|a touch|bit)\b/.test(clause) ? 0.88 : 0.75;
	}
	if (factor !== null) {
		style.size = round(Math.min(20, Math.max(2, current * factor)), 2);
		labels.push(`captions ${round(factor, 2)}× ${factor > 1 ? "bigger" : "smaller"}`);
	}
	// position (y = px from the canvas centre, + is down)
	if (/\b(top|up|upper|higher|above)\b/.test(clause)) {
		style.y = -Math.round(height * 0.3);
		labels.push("captions at the top");
	} else if (/\b(middle|cent(er|re)|centred|centered)\b/.test(clause)) {
		style.y = 0;
		labels.push("captions in the middle");
	} else if (/\b(bottom|down|lower third|lower)\b/.test(clause)) {
		style.y = Math.round(height * 0.3);
		labels.push("captions at the bottom");
	}
	// colour
	const colour = clause.match(COLOR_RE);
	if (colour) {
		const hex = colour[0].startsWith("#") ? colour[0].toUpperCase() : COLORS[colour[0]];
		if (hex) {
			style.color = hex;
			labels.push(`captions ${colour[0]}`);
		}
	}
	// box
	if (/\b(box|background|label|pill|backing|plate)\b/.test(clause)) {
		if (/\b(no|without|remove|off|drop)\b/.test(clause)) {
			style.bg = false;
			labels.push("captions without a box");
		} else {
			style.bg = true;
			style.bg_color = "#0C0C0E";
			style.bg_radius = 12;
			style.bg_padding_x = 24;
			style.bg_padding_y = 10;
			labels.push("captions on a box");
		}
	}
	// type
	if (/\bserif\b/.test(clause) && !/\bsans\b/.test(clause)) {
		style.font = "Instrument Serif";
		labels.push("serif captions");
	} else if (/\b(mono|monospace|typewriter|code)\b/.test(clause)) {
		style.font = "JetBrains Mono";
		labels.push("mono captions");
	} else if (/\b(condensed|tall|bebas)\b/.test(clause)) {
		style.font = "Bebas Neue";
		labels.push("condensed captions");
	} else if (/\bsans\b/.test(clause)) {
		style.font = "Archivo";
		labels.push("sans captions");
	}
	if (/\b(bold|bolder|heavier|thicker)\b/.test(clause)) {
		style.weight = "bold";
		labels.push("bold captions");
	} else if (/\b(thin|thinner|light(er)? weight|regular weight|not bold)\b/.test(clause)) {
		style.weight = "normal";
		labels.push("regular-weight captions");
	}
	if (/\b(upper ?case|all caps|caps|capitals|shout)\b/.test(clause)) {
		style.uppercase = true;
		labels.push("uppercase captions");
	} else if (/\b(lower ?case)\b/.test(clause)) {
		notes.push("lowercase captions: the caption text is stored as typed, so lowering it is a text edit — ask your Claude");
	}
	if (!Object.keys(style).length) {
		return { ops: [], labels: [], notes, reason: "which caption change? (bigger, smaller, at the top, yellow, on a box, serif, uppercase, hide)" };
	}
	for (const track of targets) ops.push({ op: "set_caption_style", author, track: track.id, style });
	return { ops, labels, notes };
}

// ─── pacing ("tighter cut") ─────────────────────────────────────────────────────────────────────────────────────

type Span = [number, number];

function mergeSpans(spans: Span[], joinBelow: number): Span[] {
	const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
	const out: Span[] = [];
	for (const span of sorted) {
		const last = out[out.length - 1];
		if (last && span[0] - last[1] < joinBelow) last[1] = Math.max(last[1], span[1]);
		else out.push([span[0], span[1]]);
	}
	return out;
}

function subtract(range: Span, cover: Span[]): Span[] {
	const out: Span[] = [];
	let cursor = range[0];
	for (const [a, b] of cover) {
		if (b <= cursor || a >= range[1]) continue;
		if (a > cursor) out.push([cursor, Math.min(a, range[1])]);
		cursor = Math.max(cursor, b);
		if (cursor >= range[1]) break;
	}
	if (cursor < range[1]) out.push([cursor, range[1]]);
	return out;
}

const end = (element: TimelineElement) => element.startTime + element.duration;

export interface TightenOptions {
	/** Stronger: shorter pauses removed, less padding kept. */
	strong?: boolean;
	author?: Author;
}

export interface TightenPlan {
	ops: Op[];
	/** Ticks removed from the timeline. */
	removedTicks: number;
	pauses: number;
	gaps: number;
	trimmedHolds: number;
	notes: string[];
}

/**
 * Tighten the cut on the main track: drop pauses between captions (speech = caption coverage) inside clips that
 * have captions over them, trim head/tail holds on clips without captions, close gaps between main clips, and move
 * every other element left by what was removed before it (captions stay on their words). Ops: split / delete / move.
 */
export function tightenCut(tracks: SceneTracks, opts: TightenOptions = {}): TightenPlan {
	const author = opts.author ?? "user";
	const strong = Boolean(opts.strong);
	const s = (seconds: number) => Math.round(seconds * TICKS);
	const pad = s(strong ? 0.04 : 0.08);
	const threshold = s(strong ? 0.25 : 0.4);
	const hold = s(strong ? 0.25 : 0.12);
	const minPiece = s(0.1);
	const notes: string[] = [];

	const clips = tracks.main.elements
		.filter((element) => element.type === "video" || element.type === "image")
		.slice()
		.sort((x, y) => x.startTime - y.startTime) as TimelineElement[];
	if (!clips.length) return { ops: [], removedTicks: 0, pauses: 0, gaps: 0, trimmedHolds: 0, notes: ["no clips on the main track"] };

	const speech = mergeSpans(
		captionTracks(tracks).flatMap((track) => track.elements.map((element) => [element.startTime, end(element)] as Span)),
		1,
	);

	let spans: Span[] = [];
	let pauses = 0;
	let gaps = 0;
	let trimmedHolds = 0;
	for (let i = 0; i < clips.length; i++) {
		const clip = clips[i] as TimelineElement;
		const range: Span = [clip.startTime, end(clip)];
		const spoken = speech.some(([a, b]) => a < range[1] && b > range[0]);
		if (spoken) {
			for (const [a, b] of subtract(range, speech)) {
				if (b - a <= threshold) continue;
				const from = a === range[0] ? a : a + pad;
				const to = b === range[1] ? b : b - pad;
				if (to - from >= minPiece) {
					spans.push([from, to]);
					pauses++;
				}
			}
		} else if (clip.duration >= s(1.2) && clip.duration - 2 * hold >= s(0.6)) {
			spans.push([range[0], range[0] + hold], [range[1] - hold, range[1]]);
			trimmedHolds++;
		}
		const next = clips[i + 1];
		if (next && next.startTime > range[1]) {
			spans.push([range[1], next.startTime]);
			gaps++;
		}
	}
	spans = mergeSpans(spans, minPiece);
	// never leave a sliver (< 0.1 s) of a clip between a removed span and the clip's edge: a split there could be
	// shorter than a frame
	spans = mergeSpans(
		spans.map(([a, b]) => {
			let from = a;
			let to = b;
			for (const clip of clips) {
				if (to > clip.startTime && to < end(clip) && end(clip) - to < minPiece) to = end(clip);
				if (from > clip.startTime && from < end(clip) && from - clip.startTime < minPiece) from = clip.startTime;
			}
			return [from, to] as Span;
		}),
		minPiece,
	);
	if (!spans.length) {
		return {
			ops: [],
			removedTicks: 0,
			pauses: 0,
			gaps: 0,
			trimmedHolds: 0,
			notes: [
				speech.length
					? `already tight: no pause over ${round(threshold / TICKS, 2)} s between captions and no gaps`
					: "already tight: no gaps, and the clips are too short to trim (no captions to find pauses from)",
			],
		};
	}
	if (!speech.length) notes.push("no captions to find pauses from: trimmed the start and end of each clip and closed gaps instead (auto-cut from word timings does this properly)");

	const removedBefore = (x: number) => spans.reduce((sum, [a, b]) => (a < x ? sum + Math.min(b, x) - a : sum), 0);
	const map = (x: number) => x - removedBefore(x);
	const ops: Op[] = [];
	const deleted = new Set<string>();
	const pieces: Array<{ id: string; start: number; duration: number }> = [];
	let refN = 0;
	const t = (ticks: number) => ticks / TICKS;

	for (const clip of clips) {
		const clipEnd = end(clip);
		const inside = spans
			.filter(([a, b]) => a < clipEnd && b > clip.startTime)
			.map(([a, b]) => [Math.max(a, clip.startTime), Math.min(b, clipEnd)] as Span);
		let cur: string | null = clip.id;
		let curStart = clip.startTime;
		for (const [a, b] of inside) {
			if (!cur) break;
			if (a > curStart) {
				const ref = `tighten-${++refN}`;
				ops.push({ op: "split", author, el: cur, t: t(a), ref });
				pieces.push({ id: cur, start: curStart, duration: a - curStart });
				cur = ref;
				curStart = a;
			}
			if (b < clipEnd) {
				const ref = `tighten-${++refN}`;
				ops.push({ op: "split", author, el: cur, t: t(b), ref });
				ops.push({ op: "delete", author, el: cur });
				deleted.add(cur);
				cur = ref;
				curStart = b;
			} else {
				ops.push({ op: "delete", author, el: cur });
				deleted.add(cur);
				cur = null;
			}
		}
		if (cur) pieces.push({ id: cur, start: curStart, duration: clipEnd - curStart });
	}

	// moves, left to right per track, never onto the previous element
	const place = (items: Array<{ id: string; start: number; duration: number }>) => {
		let prevEnd = Number.NEGATIVE_INFINITY;
		for (const item of items.sort((x, y) => x.start - y.start)) {
			const target = Math.max(map(item.start), prevEnd);
			if (target !== item.start) ops.push({ op: "move", author, el: item.id, t: t(target) });
			prevEnd = target + item.duration;
		}
	};
	place(pieces);
	for (const track of allTracks(tracks)) {
		if (track === tracks.main) continue;
		place(track.elements.filter((element) => !deleted.has(element.id)).map((element) => ({ id: element.id, start: element.startTime, duration: element.duration })));
	}

	const removedTicks = spans.reduce((sum, [a, b]) => sum + (b - a), 0);
	return { ops, removedTicks, pauses, gaps, trimmedHolds, notes };
}

// ─── the resolver ───────────────────────────────────────────────────────────────────────────────────────────────

export function resolveSentence(sentence: string, ctx: IntentContext): IntentPlan {
	const author: Author = ctx.author ?? "user";
	const tracks = sceneTracks(ctx.project, ctx.sceneId);
	const height = ctx.project.settings?.canvasSize?.height ?? 1920;
	const clauses: ClausePlan[] = [];
	const notes: string[] = [];
	let styleId: string | null = null;
	let styleOps: Op[] = [];
	const pacingOps: Op[] = [];
	const captionOps: Op[] = [];
	const gradeOps: Op[] = [];
	const compositionClauses: string[] = [];

	for (const text of splitClauses(sentence)) {
		const plan: ClausePlan = { text, kinds: [], labels: [], ops: [], notes: [] };
		clauses.push(plan);
		const hasCaptionSubject = CAPTION_SUBJECT_RE.test(text);

		// 1. a composition clip is selected and the clause is a short nudge about "it"
		if (ctx.compositionSelected && !WHOLE_RE.test(text) && NUDGE_RE.test(text) && !STYLE_RULES.slice(0, 4).some((rule) => rule.re.test(text))) {
			plan.kinds.push("composition");
			plan.labels.push(`composition: ${text}`);
			compositionClauses.push(text);
			continue;
		}

		// 2. pacing
		if (PACING_RE.test(text)) {
			plan.kinds.push("pacing");
			if (!tracks) plan.notes.push("no scene to tighten");
			else {
				const strong = STRONG_RE.test(text);
				const cut = tightenCut(tracks, { strong, author });
				plan.ops.push(...cut.ops);
				pacingOps.push(...cut.ops);
				plan.notes.push(...cut.notes);
				const parts = [
					cut.pauses ? `${cut.pauses} pause${cut.pauses === 1 ? "" : "s"}` : "",
					cut.gaps ? `${cut.gaps} gap${cut.gaps === 1 ? "" : "s"}` : "",
					cut.trimmedHolds ? `holds on ${cut.trimmedHolds} clip${cut.trimmedHolds === 1 ? "" : "s"}` : "",
				].filter(Boolean);
				plan.labels.push(
					cut.ops.length
						? `${strong ? "much " : ""}tighter cut: −${round(cut.removedTicks / TICKS, 2)} s (${parts.join(", ")})`
						: "tighter cut: nothing to remove",
				);
			}
		}

		// 3. style (not when the clause is about captions only: "huge captions" is a caption edit)
		if (!hasCaptionSubject || /\b(style|look|vibe|feel|make it|more)\b/.test(text)) {
			const match = STYLE_RULES.filter((rule) => rule.re.test(text) && !(rule.id === "fast-ugc" && PACING_RE.test(text)));
			const rule = match[0];
			if (rule) {
				const preset = EDITING_STYLE_PRESETS.find((candidate) => candidate.id === rule.id);
				if (preset) {
					if (styleId && styleId !== preset.id) notes.push(`one style at a time: "${preset.label}" replaces the earlier one`);
					styleId = preset.id;
					styleOps = [{ op: "apply_style", author, preset_id: `${STYLE_PRESET_PREFIX}${preset.id}` }];
					plan.kinds.push("style");
					plan.labels.push(`${rule.label} style (${preset.label})`);
					plan.notes.push(...preset.notes);
				}
			}
		}

		// 4. captions
		if (hasCaptionSubject) {
			if (!tracks) plan.reason = "no scene";
			else {
				const result = captionClause(text, tracks, height, author);
				plan.notes.push(...result.notes);
				if (result.ops.length) {
					plan.kinds.push("captions");
					plan.labels.push(...result.labels);
					plan.ops.push(...result.ops);
					captionOps.push(...result.ops);
				} else if (result.reason && !plan.kinds.length) {
					plan.reason = result.reason;
				}
			}
		}

		// 5. grade (a style already carries its own grade; colour words about captions are caption colours)
		if (!plan.kinds.includes("style") && !hasCaptionSubject) {
			const rule = GRADE_RULES.find((candidate) => candidate.re.test(text));
			if (rule) {
				const op: Op = { op: "grade", author, target: "all", preset: rule.preset };
				plan.kinds.push("grade");
				plan.labels.push(`${rule.label} grade`);
				plan.ops.push(op);
				gradeOps.push(op);
			}
		}

		if (!plan.kinds.length && !plan.reason) {
			plan.reason = ctx.compositionSelected
				? "no rule matched (style, pacing, captions, grade, or a nudge for the selected composition)"
				: "no rule matched (style, pacing, captions or grade) — select a composition clip for slower / bigger / make it red";
		}
	}

	// style ops go first so caption edits in the same sentence land on top of the style's captions
	const styleClause = clauses.find((clause) => clause.kinds.includes("style"));
	if (styleClause) styleClause.ops.unshift(...styleOps);
	const ops = [...styleOps, ...pacingOps, ...captionOps, ...gradeOps];
	const unmatched = clauses.filter((clause) => !clause.kinds.length).map((clause) => clause.text);
	const labels = clauses.flatMap((clause) => clause.labels);
	for (const clause of clauses) for (const note of clause.notes) if (!notes.includes(note)) notes.push(note);
	return {
		sentence,
		clauses,
		ops,
		understood: clauses.length > 0 && unmatched.length === 0,
		matched: clauses.some((clause) => clause.kinds.length > 0),
		label: labels.join(" + "),
		unmatched,
		compositionClauses,
		styleId,
		notes,
	};
}
