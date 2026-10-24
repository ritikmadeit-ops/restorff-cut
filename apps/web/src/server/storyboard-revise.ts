/**
 * One-sentence revisions (EDT-16; reel DeUUFJQu8cw 36.0–43.3 s: "change the beat 23 caption", "tighter cut, bigger
 * captions, that's just one more sentence") — the planner behind MCP `revise` and `storyboard edit_row`
 * (mcp-review agent, 2026-10-20; rewritten clause by clause by the revise-v2 agent the same evening, BUILD-BRIEF §5f,
 * SUMMARY gaps 2 and 3). Pure: a sentence, the head snapshot, the owner's saved styles and the timeline's
 * compositions (with their params blocks) in; a plan out — ops@1, composition param changes (re-rendered in place),
 * caption chunks to rebuild, and an honest account of every clause.
 *
 * Order:
 *   1. the call's address (`beat` / `element_id` / `t`) — the default span of every clause.
 *   2. a saved-style trigger on the whole sentence → `apply_style restorff/user/<id>`.
 *   3. clause by clause (quotes protected, so "to 'cold brew, no compromise'" stays one clause):
 *      a. span words ("the second half", "from 24 s", "beats 3-5", "the ending", "this section" …) → that span only;
 *      b. a caption / title text change ("change the beat 3 caption to '…'") → the EXISTING chunk is rewritten (a
 *         layered caption is rebuilt on its own tracks: never a second caption track);
 *      c. a saved-style trigger;
 *      d. compositions ("the titles", "all the cards", "the counter", the element_id's composition): size, speed,
 *         colour, ease, position, exit, length → their params, re-rendered in place, ALL in this one commit;
 *         structural asks ("smoother transition", "loop the ending") → not_understood with the composition
 *         get → update recipe;
 *      e. captions / TEXT titles: bigger, colour, box, font … (layered captions are rebuilt chunk by chunk);
 *      f. with a span: grade words split the GRADE layer at the span's edges and grade the middle; an editing style
 *         grades the span and restyles only its captions; "tighter" removes pauses inside it; "slow down" slows the
 *         B-roll (or the compositions) on screen;
 *      g. without a span: the command bar's planner (`resolveSentence`) — byte-identical ops for a plain sentence.
 *   4. every clause ends `applied`, `nothing_to_change` or in `not_understood` with what to send instead.
 *      `understood` is true only when no clause was dropped.
 */
import {
	EDITING_STYLE_PRESETS,
	resolveGradeName,
	resolveSentence,
	tightenCut,
	type Op,
	type Project as OpsProject,
	type SceneTracks,
	type TextStyle,
} from "@restorffcut/timeline-ops";
import { matchTrigger, styleExpanders, USER_STYLE_PREFIX, type SavedStyle, type StyleLibrary } from "@restorffcut/styles";
import type { ProjectSnapshot, SnapshotElement, SnapshotTrack } from "@/sync/snapshot";
import { captionWords, chunkWordsOf, planWordFix, simulateFixes, wordKey, type CaptionWord, type WordFix } from "./caption-words";
import type { LookChange } from "./captions-rebuild";
import { stylePiecesLeftOut, type LeftOutPiece } from "./revise-pieces";
import { captionLayers, type ChunkChange } from "./storyboard-captions";
import {
	colourParams,
	isStructural,
	listCompositions,
	nudgeComposition,
	nudgeWords,
	pickCompositions,
	structuralHint,
	type CompositionTarget,
	type PropChange,
} from "./storyboard-compositions";
import { activeScene, buildStoryboard, captionTracksOf, findSnapshotElement, rowAt, textTracksOf, type Storyboard, type StoryboardRow } from "./storyboard-rows";
import { parseScope, resolveSpan, restoreQuotes, SPAN_HINT_RE, splitSentence, type ResolvedSpan } from "./storyboard-scope";

const TICKS = 120_000;
const AUTHOR = "claude" as const;

// ─── types ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RevisionAddress {
	beat?: number;
	element_id?: string;
	t?: number;
}

export interface RevisionScope {
	kind: "beat" | "element" | "time" | "span";
	label: string;
	start: number;
	end: number;
	rows: number[];
	caption_ids: string[];
	text_ids: string[];
	clip_ids: string[];
	/** The clips on screen (not the A-roll running under a cut-in): what a speed change retimes. */
	shot_ids: string[];
	element?: { id: string; type: string; track_id: string; role: "caption" | "text" | "clip" | "composition" | "other" };
	/** Where the address came from. */
	from: "arguments" | "sentence";
}

export interface NotUnderstood {
	clause: string;
	why: string;
	/**
	 * What to send instead. `tool` + `example_ops` = raw ops@1 through timeline_ops (ids are real ones where possible);
	 * `steps` = exact calls of another tool in order (composition get → update, captions, effects update).
	 */
	send: { tool: string; how: string; example_ops: Array<Record<string, unknown>>; steps?: Array<{ tool: string; arguments: Record<string, unknown> }> };
}

export type RevisionPreset =
	| { kind: "saved"; id: string; title: string; version: string; trigger: string; apply_as: string }
	| { kind: "builtin"; id: string; apply_as: string; scoped?: string };

/** One composition re-rendered by this revision (props = only the keys that change). */
export interface CompositionEdit {
	element_id: string;
	title: string;
	custom: boolean;
	props: Record<string, unknown>;
	changes: PropChange[];
	duration_s?: number;
	clause: string;
}

export interface ClauseReport {
	clause: string;
	status: "applied" | "nothing_to_change" | "not_understood" | "span";
	did: string[];
	span?: string;
}

export interface RevisionPlan {
	sentence: string;
	ops: Op[];
	labels: string[];
	preset: RevisionPreset | null;
	/** The call's own address (beat / element_id / t), else the first span a clause named. */
	scope: RevisionScope | null;
	not_understood: NotUnderstood[];
	/** True only when every clause was applied or had nothing to change. */
	understood: boolean;
	notes: string[];
	/** Pass to timeline-ops apply({styles}) when a saved style was chosen. */
	styles?: ReturnType<typeof styleExpanders>;
	/** For repeat detection: per clause, the ops it made. */
	clauses: Array<{ text: string; ops: Op[] }>;
	/** Compositions to re-render with new params (one commit with the ops). */
	compositions: CompositionEdit[];
	/** Layered caption chunks to rebuild (text or look), after the ops. */
	caption_changes: ChunkChange[];
	/** Every clause and what became of it. */
	clause_report: ClauseReport[];
	/** A short name for this revision as a version ("aesthetic", "moody second half", "titles bigger"). */
	milestone: string | null;
	error?: string;
	/**
	 * revise-safety: caption WORD fixes ("change the beat 3 caption to 'and Claude uses'" = Cloud → Claude). The caller
	 * makes them a transcript edit + a caption rebuild in the same commit when the captions come from a transcript;
	 * else it uses each clause's `fallback` (the same words changed in place on the chunks).
	 */
	word_fixes: PlannedWordFix[];
	/** revise-safety: restyles of tool-built plain captions, rebuilt from their own chunks with the look recorded. */
	caption_looks: LookChange[];
	/** revise-safety: caption chunks deleted because the sentence asked for it (the word guard does not count them). */
	exclude_chunks: string[];
	/** revise-safety: clauses refused because they would delete caption words (also in not_understood). */
	word_loss_refused: Array<{ clause: string; would_delete: Array<{ text: string; t: number }> }>;
	/** revise-safety: an editing style's pieces this commit does not add (also in not_understood, with the calls). */
	left_out: LeftOutPiece[];
	/** revise-safety: clips whose person matte the left-out pieces need (the caller starts them in the background). */
	matte_clips: string[];
}

/** A word fix and the direct caption edit that does the same when no transcript is under it. */
export interface PlannedWordFix extends WordFix {
	clause: string;
	/** The clause's fixes as caption edits (shared by every fix of the clause: set text / chunk text). */
	fallback: { ops: Op[]; chunks: ChunkChange[] };
}

// ─── words ──────────────────────────────────────────────────────────────────────────────────────────────────────

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
const COLOR_RE = new RegExp(`(#[0-9a-f]{6}\\b|\\b(${Object.keys(COLORS).join("|")})\\b)`, "i");
const STRONG_RE = /\b(much|way|a lot|lots|really|super|very|even|extra)\b/;
const SLIGHT_RE = /\b(slightly|a bit|a little|a touch|bit)\b/;
const CAPTION_RE = /\b(captions?|subtitles?|subs|words on screen)\b/;
const TEXT_RE = /\b(title|titles|headline|headlines|text|big word|on-screen text|pop|pops)\b/;
const STYLE_WORDS: Array<{ id: string; re: RegExp; label: string }> = [
	{ id: "moody-captions", re: /\b(mood(y|ier)|cinematic|noir|after dark|brooding)\b/, label: "moody" },
	{ id: "aesthetic-warm", re: /\b(aesthetic|magazine|editorial|dreamy|cozy|cosy)\b/, label: "aesthetic" },
	{ id: "paper-collage", re: /\b(paper|collage|scrapbook|zine)\b/, label: "paper collage" },
	{ id: "talking-head", re: /\b(clean(er)?|minimal(ist)?|professional|corporate)\b/, label: "clean" },
	{ id: "fast-ugc", re: /\b(punch(y|ier)|energetic|ugc|tiktok|hype|viral|high[- ]energy)\b/, label: "fast" },
];
/** TextStyle key → editor param key (timeline-ops styles.ts STYLE_TO_PARAM; not exported there). */
const STYLE_TO_PARAM: Record<string, string> = {
	font: "fontFamily",
	size: "fontSize",
	color: "color",
	weight: "fontWeight",
	align: "textAlign",
	bg: "background.enabled",
	bg_color: "background.color",
	bg_radius: "background.cornerRadius",
	bg_padding_x: "background.paddingX",
	bg_padding_y: "background.paddingY",
	x: "transform.positionX",
	y: "transform.positionY",
	opacity: "opacity",
};

const ADDRESS_WORDS = [
	/\b(?:in |on |at |for |of )?(?:the )?(?:beat|row)\s*#?\s*(\d{1,3})(?:'s)?\b/i,
	/\b(?:at|around|from)\s+(\d{1,3}(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b/i,
	/\b(?:at|around|from)\s+(\d{1,2}):(\d{2}(?:\.\d+)?)\b/i,
];
const ENDING_RE = /\b(?:in |on |at |for |of )?(?:the )?(ending|end|outro|last beat|final beat)\b/i;
const OPENING_RE = /\b(?:in |on |at |for |of )?(?:the )?(opening|intro|first beat|hook)\b/i;

const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;
const sec = (ticks: number) => ticks / TICKS;
const textOf = (element: SnapshotElement) => {
	const content = (element.params as Record<string, unknown> | undefined)?.content;
	return typeof content === "string" ? content : "";
};

// ─── address (kept for callers and tests: the sentence-level address words) ────────────────────────────────────

interface ParsedAddress {
	address: RevisionAddress;
	/** Sentence with the address words taken out. */
	rest: string;
	/** "the ending" / "the opening" */
	edge?: "end" | "start";
}

export function parseAddress(sentence: string): ParsedAddress {
	let rest = sentence;
	const address: RevisionAddress = {};
	const beat = rest.match(ADDRESS_WORDS[0] as RegExp);
	if (beat) {
		address.beat = Number(beat[1]);
		rest = rest.replace(beat[0], " ");
	}
	const seconds = rest.match(ADDRESS_WORDS[1] as RegExp);
	if (seconds && address.beat === undefined) {
		address.t = Number(seconds[1]);
		rest = rest.replace(seconds[0], " ");
	} else {
		const clock = rest.match(ADDRESS_WORDS[2] as RegExp);
		if (clock && address.beat === undefined) {
			address.t = Number(clock[1]) * 60 + Number(clock[2]);
			rest = rest.replace(clock[0], " ");
		}
	}
	let edge: ParsedAddress["edge"];
	if (address.beat === undefined && address.t === undefined) {
		const ending = rest.match(ENDING_RE);
		const opening = rest.match(OPENING_RE);
		if (ending) {
			edge = "end";
			rest = rest.replace(ending[0], " the video ");
		} else if (opening) {
			edge = "start";
			rest = rest.replace(opening[0], " the video ");
		}
	}
	return { address, rest: rest.replace(/\s+/g, " ").trim(), edge };
}

// ─── scopes ─────────────────────────────────────────────────────────────────────────────────────────────────────

function isPlateOrComposition(element: SnapshotElement): boolean {
	const restorff = element.restorff as { cutout?: unknown; effect?: unknown; composition?: unknown } | undefined;
	return !!restorff?.cutout || !!restorff?.effect || !!restorff?.composition;
}

/** Ids inside [start, end): captions starting there, TEXT clips over it, footage clips over it. From the snapshot. */
export function scopeFromSpan(snapshot: ProjectSnapshot, board: Storyboard, span: { start: number; end: number; label: string }, kind: RevisionScope["kind"], from: RevisionScope["from"]): RevisionScope {
	const a = Math.round(span.start * TICKS);
	const b = Math.round(span.end * TICKS);
	const scene = activeScene(snapshot);
	const captionIds = captionTracksOf(snapshot)
		.flatMap((track) => track.elements ?? [])
		.filter((element) => element.startTime >= a - 2 && element.startTime < b - 2)
		.sort((x, y) => x.startTime - y.startTime)
		.map((element) => element.id);
	const textIds = textTracksOf(snapshot)
		.flatMap((track) => track.elements ?? [])
		.filter((element) => element.startTime < b && element.startTime + element.duration > a && textOf(element))
		.map((element) => element.id);
	const clips: string[] = [];
	const shots: string[] = [];
	const footage: Array<{ track: SnapshotTrack; main: boolean }> = [
		...(scene?.tracks?.overlay ?? []).filter((track) => track.type === "video" && !/^MOTION/i.test(track.name ?? "") && !track.hidden).map((track) => ({ track, main: false })),
		...(scene?.tracks?.main ? [{ track: scene.tracks.main, main: true }] : []),
	];
	for (const { track } of footage) {
		for (const element of track.elements ?? []) {
			if ((element.type !== "video" && element.type !== "image") || element.hidden || isPlateOrComposition(element)) continue;
			if (element.startTime < b && element.startTime + element.duration > a) {
				clips.push(element.id);
				shots.push(element.id);
			}
		}
	}
	const rows = board.rows.filter((row) => row.start < span.end - 1e-6 && row.end > span.start + 1e-6).map((row) => row.row);
	return { kind, label: span.label, start: round(span.start), end: round(span.end), rows, caption_ids: captionIds, text_ids: [...new Set(textIds)], clip_ids: clips, shot_ids: shots, from };
}

function scopeFromRows(snapshot: ProjectSnapshot, board: Storyboard, rows: StoryboardRow[], kind: RevisionScope["kind"], label: string, from: RevisionScope["from"]): RevisionScope {
	const start = Math.min(...rows.map((row) => row.start));
	const end = Math.max(...rows.map((row) => row.end));
	return scopeFromSpan(snapshot, board, { start, end, label }, kind, from);
}

/** Resolve an address into the span and element ids it covers; a string = why it cannot be resolved. */
export function resolveScope(snapshot: ProjectSnapshot, board: Storyboard, address: RevisionAddress, from: RevisionScope["from"], edge?: "end" | "start"): RevisionScope | null | string {
	if (address.element_id) {
		const found = findSnapshotElement(snapshot, address.element_id);
		if (!found) return `no element ${address.element_id} on this timeline (timeline summary lists them)`;
		const { element, track } = found;
		const start = sec(element.startTime);
		const end = sec(element.startTime + element.duration);
		const isCaption = captionTracksOf(snapshot).some((candidate) => candidate.id === track.id);
		const isComposition = !!(element.restorff as { composition?: unknown } | undefined)?.composition;
		const role = isCaption ? "caption" : isComposition ? "composition" : element.type === "text" ? "text" : element.type === "video" || element.type === "image" ? "clip" : "other";
		const inner = scopeFromSpan(snapshot, board, { start, end, label: "" }, "element", from);
		return {
			...inner,
			kind: "element",
			label: `${isComposition ? "composition" : element.type} ${element.id} (${round(start, 2)}–${round(end, 2)} s)`,
			caption_ids: role === "caption" ? [element.id] : role === "clip" ? inner.caption_ids : [],
			text_ids: role === "text" ? [element.id] : [],
			clip_ids: role === "clip" ? [element.id] : [],
			shot_ids: role === "clip" ? [element.id] : [],
			element: { id: element.id, type: element.type, track_id: track.id, role },
		};
	}
	if (address.beat !== undefined) {
		const row = board.rows[address.beat - 1];
		if (!row) return `there is no beat ${address.beat}: this storyboard has ${board.rows.length} (storyboard get lists them)`;
		return scopeFromRows(snapshot, board, [row], "beat", `beat ${row.row} (${row.range})`, from);
	}
	if (address.t !== undefined) {
		const row = rowAt(board, address.t);
		if (!row) return `${address.t} s is outside the timeline (it runs ${board.runtime} s)`;
		return scopeFromRows(snapshot, board, [row], "time", `beat ${row.row} at ${address.t} s (${row.range})`, from);
	}
	if (edge) {
		const row = edge === "end" ? board.rows[board.rows.length - 1] : board.rows[0];
		if (!row) return "the timeline is empty";
		return scopeFromRows(snapshot, board, [row], "beat", `${edge === "end" ? "the last" : "the first"} beat, ${row.row} (${row.range})`, from);
	}
	return null;
}

// ─── caption / title text ───────────────────────────────────────────────────────────────────────────────────────

const QUOTED_TEXT_RE =
	/\b(?:(caption|captions|subtitle|subtitles|line|text|title|headline|words?|it|this|that)\b[^"“”‘’]*?\b(?:to|say|says|read|reads|with|into)\s*:?\s*|(?:make (?:it|this|that) say|should say|to say|to read)\s*:?\s*)["“‘']([^"”’]+)["”’']/i;
const BARE_TEXT_RE = /\b(caption|captions|subtitle|line|text|title|headline)\b(?:\s+\w+){0,3}?\s+(?:to say|to read|says?|reads?|to)\s*:?\s+(.{2,})$/i;
const NOT_TEXT_RE =
	/^(the |a )?(top|bottom|middle|cent(er|re)|left|right|yellow|white|black|red|green|blue|neon|bigger|smaller|huge|serif|mono|uppercase|bold|box|be (bigger|smaller))\b/i;

export interface TextChange {
	target: "caption" | "text";
	text: string;
	rest: string;
}

export function parseTextChange(sentence: string): TextChange | null {
	const quoted = sentence.match(QUOTED_TEXT_RE);
	if (quoted) {
		const subject = (quoted[1] ?? "").toLowerCase();
		const target: TextChange["target"] = /title|headline|text/.test(subject) && !/caption|subtitle/.test(subject) ? "text" : "caption";
		return { target, text: (quoted[2] ?? "").trim(), rest: sentence.replace(quoted[0], " ").replace(/\b(change|make|set|update|fix|edit|replace|rewrite)\s*(the)?\s*$/i, "").trim() };
	}
	const bare = sentence.match(BARE_TEXT_RE);
	if (bare && !NOT_TEXT_RE.test((bare[2] ?? "").trim())) {
		const subject = (bare[1] ?? "").toLowerCase();
		return { target: /title|headline|text/.test(subject) ? "text" : "caption", text: (bare[2] ?? "").trim().replace(/[.!]$/, ""), rest: "" };
	}
	return null;
}

/** New words over existing caption chunks, in proportion to their old word counts (every chunk keeps ≥ 1 word). */
export function distributeWords(oldTexts: string[], text: string): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const n = oldTexts.length;
	if (n <= 1) return [words.join(" ")];
	if (words.length <= n) return oldTexts.map((_, i) => words[i] ?? "");
	const weights = oldTexts.map((t) => Math.max(1, t.split(/\s+/).filter(Boolean).length));
	const total = weights.reduce((a, b) => a + b, 0);
	const out: string[] = [];
	let used = 0;
	for (let i = 0; i < n; i++) {
		const left = n - i - 1;
		const share = i === n - 1 ? words.length - used : Math.max(1, Math.min(words.length - used - left, Math.round((words.length * (weights[i] as number)) / total)));
		out.push(words.slice(used, used + share).join(" "));
		used += share;
	}
	return out;
}

/**
 * A caption or title's words in a scope: the EXISTING clips change (a layered caption chunk is rebuilt on its own
 * tracks: `chunks`); only a beat with no caption at all gets one, on the existing caption track.
 */
export function textChangeOps(
	snapshot: ProjectSnapshot,
	scope: RevisionScope,
	change: TextChange,
	compositions: CompositionTarget[] = [],
): { ops: Op[]; chunks?: ChunkChange[]; compositions?: CompositionEdit[]; label: string; note?: string } | { error: string } {
	const scene = activeScene(snapshot);
	const layered = change.target === "caption" && !!captionLayers(snapshot);
	const ids = change.target === "caption" ? scope.caption_ids : scope.text_ids;
	if (ids.length) {
		const elements = ids.map((id) => findSnapshotElement(snapshot, id)?.element).filter((e): e is SnapshotElement => !!e);
		const parts = distributeWords(elements.map(textOf), change.text);
		if (layered) {
			const chunks: ChunkChange[] = elements.map((element, i) => ({ id: element.id, text: parts[i] ?? "" }));
			return { ops: [], chunks, label: `${change.target} in ${scope.label} → "${change.text}" (${chunks.length} chunk${chunks.length === 1 ? "" : "s"} rewritten on their own layers)` };
		}
		const ops: Op[] = [];
		elements.forEach((element, i) => {
			const part = parts[i] ?? "";
			if (part) ops.push({ op: "set", author: AUTHOR, el: element.id, prop: "text", value: part });
			else ops.push({ op: "delete", author: AUTHOR, el: element.id });
		});
		return { ops, label: `${change.target} in ${scope.label} → "${change.text}"` };
	}
	const dur = Math.max(0.3, Math.min(scope.end - scope.start, change.target === "caption" ? 4 : 1.5));
	if (change.target === "text") {
		// a title composition over the span: its words prop changes (re-rendered in place)
		const titled = compositions.find((target) => target.start < scope.end && target.end > scope.start && target.words.length);
		const key = titled ? ["word", "title", "headline", "text", "words"].find((candidate) => typeof titled.props[candidate] === "string") : undefined;
		if (titled && key) {
			return {
				ops: [],
				compositions: [{ element_id: titled.element_id, title: titled.title, custom: titled.custom, props: { [key]: change.text }, changes: [{ key, from: titled.props[key], to: change.text, because: "new words" }], clause: change.text }],
				label: `${titled.title}: ${key} → "${change.text}"`,
			};
		}
		return {
			ops: [{ op: "text_pop", author: AUTHOR, t: round(scope.start + 0.05, 3), text: change.text, dur: round(Math.min(dur, scope.end - scope.start - 0.05), 3) }],
			label: `title "${change.text}" added over ${scope.label}`,
		};
	}
	const captionTrack = captionTracksOf(snapshot)[0];
	if (captionTrack) {
		const neighbour = [...(captionTrack.elements ?? [])].sort((a, b) => Math.abs(a.startTime / TICKS - scope.start) - Math.abs(b.startTime / TICKS - scope.start))[0];
		const params = { ...((neighbour?.params ?? {}) as Record<string, unknown>) };
		delete params.content;
		const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean"));
		return {
			ops: [{ op: "insert", author: AUTHOR, track: captionTrack.id, t: round(scope.start, 3), text: change.text, dur: round(dur, 3), name: change.text.slice(0, 24), params: clean as Record<string, number | string | boolean> } as Op],
			label: `caption "${change.text}" added in ${scope.label}`,
			note: `the beat had no caption: one caption clip was added on the existing ${captionTrack.name ?? "CAPTIONS"} track with its neighbour's look${captionLayers(snapshot) ? " (no word highlight: rebuild captions with the captions tool to give it one)" : ""}`,
		};
	}
	if (!scene) return { error: "no scene" };
	const words = change.text.split(/\s+/).filter(Boolean);
	const step = dur / Math.max(1, words.length);
	return {
		ops: [{ op: "add_captions", author: AUTHOR, words: words.map((w, i) => ({ text: w, start: round(scope.start + i * step, 3), end: round(scope.start + (i + 1) * step, 3) })) }],
		label: `captions "${change.text}" added in ${scope.label}`,
		note: "there was no caption track: a CAPTIONS track was created",
	};
}

// ─── caption words: a text change is a word fix, never a rewrite that drops words (revise-safety) ───────────────

/** Captions the captions tool built (chunks tagged with their words and look): they can be rebuilt from a transcript. */
export function toolCaptions(snapshot: ProjectSnapshot): boolean {
	return captionTracksOf(snapshot).some((track) => (track.elements ?? []).some((element) => !!(element.restorff as { caption?: unknown } | undefined)?.caption));
}

/** The caption words of some chunks, in time order (the chunks' shown text). */
export function scopeCaptionWords(snapshot: ProjectSnapshot, ids: readonly string[]): CaptionWord[] {
	const wanted = new Set(ids);
	const all = captionWords(snapshot).filter((word) => wanted.has(word.chunk_id));
	if (all.length) return all;
	return ids
		.map((id) => findSnapshotElement(snapshot, id)?.element)
		.filter((element): element is SnapshotElement => !!element)
		.sort((a, b) => a.startTime - b.startTime)
		.flatMap((element) => chunkWordsOf(element));
}

/** Fixes done as caption edits in place (no transcript under them): each touched chunk gets its words with the fixes. */
export function fixesAsCaptionEdits(snapshot: ProjectSnapshot, words: readonly CaptionWord[], fixes: readonly WordFix[]): { ops: Op[]; chunks: ChunkChange[] } {
	const layered = !!captionLayers(snapshot);
	const touched = [...new Set(fixes.flatMap((fix) => fix.chunk_ids))];
	const inside = words.filter((word) => touched.includes(word.chunk_id));
	const after = simulateFixes(inside, fixes);
	const ops: Op[] = [];
	const chunks: ChunkChange[] = [];
	for (const id of touched) {
		const text = after
			.filter((word) => word.chunk_id === id)
			.map((word) => word.text)
			.join(" ");
		if (layered) chunks.push({ id, text });
		else if (text) ops.push({ op: "set", author: AUTHOR, el: id, prop: "text", value: text });
		else ops.push({ op: "delete", author: AUTHOR, el: id });
	}
	return { ops, chunks };
}

export type CaptionTextPlan =
	| { kind: "fix"; fixes: PlannedWordFix[]; label: string; dropped: Array<{ text: string; t: number }> }
	| { kind: "same"; label: string }
	| { kind: "rewrite" }
	| { kind: "loss"; miss: NotUnderstood; would_delete: Array<{ text: string; t: number }> };

/**
 * "change the beat 3 caption to 'and Claude uses'": the new text is aligned inside the beat's words; only the words it
 * changes are fixed (Cloud → Claude), the others stay. A new line at least as long as the old one with little in common
 * is a rewrite (the old path: no word is lost). A SHORTER line with little in common is refused: it would delete words.
 */
export function captionTextPlan(snapshot: ProjectSnapshot, scope: RevisionScope, text: string, clause: string, timelineId: string): CaptionTextPlan {
	const words = scopeCaptionWords(snapshot, scope.caption_ids);
	const planned = planWordFix(words, text);
	if (planned.kind === "same") return { kind: "same", label: `caption in ${scope.label} already says "${text}"` };
	if (planned.kind === "rewrite") return { kind: "rewrite" };
	if (planned.kind === "loss") {
		const n = planned.would_delete.length;
		const shown = planned.would_delete
			.slice(0, 14)
			.map((word) => word.text)
			.join(" ");
		return {
			kind: "loss",
			would_delete: planned.would_delete,
			miss: {
				clause,
				why: `refused: it would delete ${n} caption word${n === 1 ? "" : "s"} in ${scope.label} that the new text does not repeat ("${shown}${n > 14 ? " …" : ""}") — a caption change never removes spoken words unless asked`,
				send: {
					tool: "transcribe",
					how: `Fix only the wrong words: name them — revise "change '<wrong word>' to '<right word>'" (one commit: the transcript fixed, captions rebuilt), or transcribe {action: "edit", fixes: [{from, to, t}]}. The beat says: "${planned.old_line.slice(0, 160)}". To replace the whole line on purpose (it drops those words), send the fix with from = that whole line, or revise with allow_word_loss: true.`,
					example_ops: [],
					steps: [{ tool: "transcribe", arguments: { timeline_id: timelineId, action: "edit", fixes: [{ from: "<the wrong word(s), as the caption shows them>", to: "<the right word(s)>", t: planned.t }], rebuild_captions: true } }],
				},
			},
		};
	}
	const fallback = fixesAsCaptionEdits(snapshot, words, planned.fixes);
	const fixes = planned.fixes.map((fix) => ({ ...fix, clause, fallback }));
	const said = planned.fixes.map((fix) => `"${fix.from}" → "${fix.to || "(removed)"}"`).join(", ");
	return {
		kind: "fix",
		fixes,
		dropped: planned.dropped,
		label: `caption in ${scope.label}: ${said} (a word fix — every other word of the beat stays)`,
	};
}

const QUOTE = `["“”‘’']`;
const NOT_QUOTE = `[^"“”‘’]`;
const SWAP_RES = [
	new RegExp(`\\b(?:change|replace|fix|correct|swap|turn)\\s+(?:the word\\s+|every\\s+)?${QUOTE}(${NOT_QUOTE}+?)${QUOTE}\\s+(?:to|with|into|for|by)\\s+${QUOTE}(${NOT_QUOTE}+?)${QUOTE}`, "i"),
	new RegExp(`${QUOTE}(${NOT_QUOTE}+?)${QUOTE}\\s+(?:should (?:be|say|read)|→|->|=>)\\s+${QUOTE}(${NOT_QUOTE}+?)${QUOTE}`, "i"),
	new RegExp(`\\b(?:it|the caption|the captions?)\\s+says?\\s+${QUOTE}(${NOT_QUOTE}+?)${QUOTE}[,;]?\\s+(?:it\\s+)?should\\s+(?:be|say|read)\\s+${QUOTE}(${NOT_QUOTE}+?)${QUOTE}`, "i"),
	/\b(?:change|replace|fix|correct)\s+(?:the word\s+)?([\p{L}\p{N}'-]+)\s+(?:to|with|into)\s+([\p{L}\p{N}'-]+)\s*[.!]?$/iu,
];
const SWAP_SUBJECT_RE = /\b(captions?|subtitles?|titles?|headlines?|line|text|beat|row|it|this|that|them|everything)\b/i;

/**
 * "change 'Cloud' to 'Claude'", "'Cloud' should be 'Claude'", "replace Cloud with Claude" → a word swap. `quoted`
 * false = the bare form, which only counts when the captions really have the word (else the clause goes on as before).
 */
export function parseWordSwap(clause: string): { from: string; to: string; quoted: boolean } | null {
	for (const [i, re] of SWAP_RES.entries()) {
		const hit = clause.match(re);
		if (!hit) continue;
		const from = (hit[1] ?? "").trim();
		const to = (hit[2] ?? "").trim();
		if (!from || from === to) continue;
		// the unquoted form must not be "change the captions to yellow" / "change it to serif"
		if (i === 3 && (SWAP_SUBJECT_RE.test(from) || NOT_TEXT_RE.test(to) || /^(the|a|an)$/i.test(from))) continue;
		return { from, to, quoted: i !== 3 };
	}
	return null;
}

/** Every occurrence of `from` among the caption words (in a scope when given) → one fix each. */
export function wordSwapFixes(words: readonly CaptionWord[], from: string, to: string, clause: string, snapshot: ProjectSnapshot): PlannedWordFix[] {
	const keys = from.split(/\s+/).map(wordKey).filter(Boolean);
	const out: WordFix[] = [];
	for (let i = 0; i + keys.length <= words.length; i++) {
		if (!keys.every((key, k) => wordKey(words[i + k]?.text ?? "") === key)) continue;
		const run = words.slice(i, i + keys.length);
		out.push({ from: run.map((word) => word.text).join(" "), to, t: run[0]?.start ?? 0, t_end: run[run.length - 1]?.end ?? 0, chunk_ids: [...new Set(run.map((word) => word.chunk_id))] });
		i += keys.length - 1;
	}
	const fallback = fixesAsCaptionEdits(snapshot, words, out);
	return out.map((fix) => ({ ...fix, clause, fallback }));
}

// ─── text styling ───────────────────────────────────────────────────────────────────────────────────────────────

interface StyleNudge {
	factor: number | null;
	style: TextStyle;
	labels: string[];
	hide?: boolean;
	show?: boolean;
}

/** "bigger", "yellow", "at the top", "on a box", "serif", "bold", "uppercase", "hide" → a nudge for text elements. */
export function parseTextNudge(clause: string, height: number): StyleNudge | null {
	const c = clause.toLowerCase();
	const out: StyleNudge = { factor: null, style: {}, labels: [] };
	if (/\b(hide|turn off|get rid of)\b/.test(c) && !/\b(box|background)\b/.test(c)) return { ...out, hide: true, labels: ["hidden"] };
	if (/\b(show|unhide|bring back|turn on)\b/.test(c)) return { ...out, show: true, labels: ["shown"] };
	if (/\b(huge|giant|massive|enormous)\b/.test(c)) out.factor = 1.8;
	else if (/\b(bigger|larger|big|large|increase)\b/.test(c)) out.factor = STRONG_RE.test(c) ? 1.6 : SLIGHT_RE.test(c) ? 1.15 : 1.35;
	else if (/\b(smaller|small|tiny|shrink|reduce)\b/.test(c)) out.factor = STRONG_RE.test(c) ? 0.6 : SLIGHT_RE.test(c) ? 0.88 : 0.75;
	if (out.factor !== null) out.labels.push(`${out.factor}× ${out.factor > 1 ? "bigger" : "smaller"}`);
	if (/\b(top|upper|higher|above)\b/.test(c)) {
		out.style.y = -Math.round(height * 0.3);
		out.labels.push("at the top");
	} else if (/\b(middle|cent(er|re)|centred|centered)\b/.test(c)) {
		out.style.y = 0;
		out.labels.push("in the middle");
	} else if (/\b(bottom|lower third|lower)\b/.test(c)) {
		out.style.y = Math.round(height * 0.3);
		out.labels.push("at the bottom");
	}
	const colour = c.match(COLOR_RE);
	if (colour) {
		const key = colour[0].toLowerCase();
		const hex = key.startsWith("#") ? key.toUpperCase() : COLORS[key];
		if (hex) {
			out.style.color = hex;
			out.labels.push(key);
		}
	}
	if (/\b(box|background|label|pill|plate)\b/.test(c)) {
		if (/\b(no|without|remove|off|drop)\b/.test(c)) {
			out.style.bg = false;
			out.labels.push("no box");
		} else {
			Object.assign(out.style, { bg: true, bg_color: "#0C0C0E", bg_radius: 12, bg_padding_x: 24, bg_padding_y: 10 });
			out.labels.push("on a box");
		}
	}
	if (/\bserif\b/.test(c) && !/\bsans\b/.test(c)) {
		out.style.font = "Instrument Serif";
		out.labels.push("serif");
	} else if (/\b(mono|monospace|typewriter)\b/.test(c)) {
		out.style.font = "JetBrains Mono";
		out.labels.push("mono");
	} else if (/\bsans\b/.test(c)) {
		out.style.font = "Archivo";
		out.labels.push("sans");
	}
	if (/\b(bold|bolder|heavier|thicker)\b/.test(c)) {
		out.style.weight = "bold";
		out.labels.push("bold");
	}
	if (/\b(upper ?case|all caps|caps|capitals)\b/.test(c)) {
		out.style.uppercase = true;
		out.labels.push("uppercase");
	}
	return out.factor !== null || Object.keys(out.style).length ? out : null;
}

function nudgeOps(snapshot: ProjectSnapshot, ids: string[], nudge: StyleNudge): Op[] {
	const ops: Op[] = [];
	for (const id of ids) {
		const element = findSnapshotElement(snapshot, id)?.element;
		if (!element) continue;
		if (nudge.hide || nudge.show) {
			ops.push({ op: "set", author: AUTHOR, el: id, prop: "hidden", value: Boolean(nudge.hide) });
			continue;
		}
		const params = (element.params ?? {}) as Record<string, unknown>;
		if (nudge.factor !== null) {
			const current = Number(params.fontSize);
			const size = Number.isFinite(current) && current > 0 ? current : 5;
			ops.push({ op: "set", author: AUTHOR, el: id, prop: "fontSize", value: round(Math.min(20, Math.max(2, size * nudge.factor)), 2) });
		}
		for (const [key, value] of Object.entries(nudge.style)) {
			if (key === "uppercase") {
				if (value) ops.push({ op: "set", author: AUTHOR, el: id, prop: "text", value: textOf(element).toUpperCase() });
				continue;
			}
			const param = STYLE_TO_PARAM[key];
			if (param && value !== undefined) ops.push({ op: "set", author: AUTHOR, el: id, prop: param, value: value as string | number | boolean });
		}
	}
	return ops;
}

/** A caption nudge as a look change over a span (or every chunk): size relative to each chunk, the rest recorded. */
export function lookChangeOf(nudge: StyleNudge, scope: { start: number; end: number } | null): LookChange {
	const { uppercase, ...restyle } = nudge.style;
	return {
		overrides: { ...(nudge.factor !== null ? { size: { relative: nudge.factor } } : {}), ...(uppercase ? { case: "upper" as const } : {}) },
		...(Object.keys(restyle).length ? { restyle } : {}),
		span: scope ? { t0: scope.start, t1: scope.end } : null,
	};
}

/** The same nudge on layered caption chunks: a rebuild per chunk (the word layer is re-measured). */
function nudgeChunks(ids: string[], nudge: StyleNudge): ChunkChange[] {
	const { uppercase: _upper, ...style } = nudge.style;
	return ids.map((id) => ({ id, ...(Object.keys(style).length ? { style } : {}), ...(nudge.factor !== null ? { sizeFactor: nudge.factor } : {}) }));
}

/** Hide / show layered captions in a span: the chunk and its word + shadow clips. */
function layeredHideOps(snapshot: ProjectSnapshot, ids: string[], hidden: boolean): Op[] {
	const layers = captionLayers(snapshot);
	const ops: Op[] = [];
	for (const id of ids) {
		const element = layers?.base.elements.find((candidate) => candidate.id === id);
		if (!element) continue;
		ops.push({ op: "set", author: AUTHOR, el: id, prop: "hidden", value: hidden });
		for (const track of [layers?.words, layers?.shadow]) {
			for (const other of track?.elements ?? []) {
				if (other.startTime >= element.startTime - 2 && other.startTime + other.duration <= element.startTime + element.duration + 2) ops.push({ op: "set", author: AUTHOR, el: other.id, prop: "hidden", value: hidden });
			}
		}
	}
	return ops;
}

// ─── footage pieces, grade layer pieces, scoped tighten ─────────────────────────────────────────────────────────

interface Piece {
	target: string;
	element: SnapshotElement;
	main: boolean;
	start: number;
	end: number;
	sourceIn: number;
	sourceLength: number | null;
}

/** Split each element at the scope's edges (when it runs past them by ≥ 0.1 s) and return the middle pieces. */
function middlePieces(snapshot: ProjectSnapshot, scope: { start: number; end: number }, prefix: string, ids: string[], kinds: string[] = ["video", "image"]): { ops: Op[]; targets: string[]; pieces: Piece[] } {
	const ops: Op[] = [];
	const pieces: Piece[] = [];
	let n = 0;
	for (const id of ids) {
		const found = findSnapshotElement(snapshot, id);
		const element = found?.element;
		if (!element || !kinds.includes(element.type)) continue;
		const start = sec(element.startTime);
		const end = sec(element.startTime + element.duration);
		if (end <= scope.start + 1e-6 || start >= scope.end - 1e-6) continue;
		const rate = Number((element.retime as { rate?: number } | undefined)?.rate) || 1;
		let current = id;
		if (scope.start - start >= 0.1) {
			const ref = `${prefix}-${++n}`;
			ops.push({ op: "split", author: AUTHOR, el: current, t: round(scope.start, 3), ref });
			current = ref;
		}
		if (end - scope.end >= 0.1) {
			const ref = `${prefix}-${++n}`;
			ops.push({ op: "split", author: AUTHOR, el: current, t: round(scope.end, 3), ref });
		}
		const pieceStart = scope.start - start >= 0.1 ? scope.start : start;
		const pieceEnd = end - scope.end >= 0.1 ? scope.end : end;
		const sourceDuration = typeof element.sourceDuration === "number" ? sec(element.sourceDuration as number) : null;
		pieces.push({
			target: current,
			element,
			main: found?.group === "main",
			start: pieceStart,
			end: pieceEnd,
			sourceIn: sec(element.trimStart ?? 0) + (pieceStart - start) * rate,
			sourceLength: sourceDuration,
		});
	}
	return { ops, targets: pieces.map((piece) => piece.target), pieces };
}

/** The timeline's GRADE layer pieces (effect elements of type restorff-grade on the GRADE track), in time order. */
export function gradeLayerPieces(snapshot: ProjectSnapshot): SnapshotElement[] {
	const overlay = activeScene(snapshot)?.tracks?.overlay ?? [];
	const tracks = overlay.filter((track) => track.type === "effect" && (track.restorff?.role === "grade" || (track.name ?? "").toUpperCase() === "GRADE" || (track.elements ?? []).some((element) => (element as { effectType?: string }).effectType === "restorff-grade")));
	return tracks
		.flatMap((track) => track.elements ?? [])
		.filter((element) => element.type === "effect" && (element as { effectType?: string }).effectType === "restorff-grade")
		.sort((a, b) => a.startTime - b.startTime);
}

/**
 * A grade on a span: the GRADE layer is split at the span's edges and the middle piece(s) graded; with no GRADE layer,
 * the footage clips in the span are split and graded (their own grade effect).
 */
function scopedGradeOps(snapshot: ProjectSnapshot, scope: RevisionScope, preset: string, prefix: string): { ops: Op[]; where: string; note?: string } {
	const layer = gradeLayerPieces(snapshot);
	if (layer.length) {
		const cut = middlePieces(snapshot, scope, `${prefix}-layer`, layer.map((element) => element.id), ["effect"]);
		if (cut.pieces.length) {
			return {
				ops: [...cut.ops, ...cut.targets.map((target) => ({ op: "grade", author: AUTHOR, target, preset }) as Op)],
				where: "the GRADE layer",
				note: `the GRADE layer is now in pieces at ${round(scope.start, 2)} s / ${round(scope.end, 2)} s: revise grades every piece for a whole-video grade; timeline_ops "grade all" would refuse the overlap (send grade per piece, or delete the extra pieces first)`,
			};
		}
	}
	const cut = middlePieces(snapshot, scope, `${prefix}-clip`, scope.clip_ids);
	return { ops: [...cut.ops, ...cut.targets.map((target) => ({ op: "grade", author: AUTHOR, target, preset }) as Op)], where: cut.pieces.length ? `${cut.pieces.length} clip${cut.pieces.length === 1 ? "" : "s"}` : "nothing" };
}

/** Whole-video grade ops when the GRADE layer is in pieces: one grade per piece (a look or a nudge applies to each). */
export function gradeEveryPiece(snapshot: ProjectSnapshot, ops: Op[]): Op[] {
	const pieces = gradeLayerPieces(snapshot);
	if (pieces.length < 2) return ops;
	return ops.flatMap((op) => {
		const g = op as Op & { target?: string };
		if (op.op !== "grade" || !["all", "timeline", "everything"].includes(String(g.target))) return [op];
		return pieces.map((piece) => ({ ...op, target: piece.id }) as Op);
	});
}

/** Before a whole-video style (its expander grades "all"): fold a split GRADE layer back into one piece. */
export function foldGradeLayer(snapshot: ProjectSnapshot): Op[] {
	const pieces = gradeLayerPieces(snapshot);
	return pieces.slice(1).map((piece) => ({ op: "delete", author: AUTHOR, el: piece.id }) as Op);
}

/** tightenCut, limited to the scope: speech is faked outside it so no pause there is found. */
function scopedTighten(project: OpsProject, scope: RevisionScope, strong: boolean): { ops: Op[]; removed: number } {
	const scene = project.scenes.find((s) => s.id === project.currentSceneId) ?? project.scenes.find((s) => s.isMain) ?? project.scenes[0];
	if (!scene) return { ops: [], removed: 0 };
	const tracks = scene.tracks as SceneTracks;
	let runtime = 0;
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) for (const el of track.elements) runtime = Math.max(runtime, el.startTime + el.duration);
	const a = Math.round(scope.start * TICKS);
	const b = Math.round(scope.end * TICKS);
	const fake = (id: string, from: number, to: number) => ({ id, type: "text", name: "", startTime: from, duration: Math.max(1, to - from), trimStart: 0, trimEnd: 0, params: { content: "·" }, restorff: { role: "caption" } });
	const guard = {
		id: "__scope-track",
		name: "CAPTIONS",
		type: "text",
		hidden: false,
		restorff: { role: "caption" },
		elements: [...(a > 0 ? [fake("__scope-a", 0, a)] : []), ...(b < runtime ? [fake("__scope-b", b, runtime)] : [])],
	} as unknown as SceneTracks["overlay"][number];
	const plan = tightenCut({ ...tracks, overlay: [guard, ...tracks.overlay] }, { strong, author: AUTHOR });
	const ops = plan.ops.filter((op) => !String((op as { el?: string }).el ?? "").startsWith("__scope"));
	return { ops, removed: round(plan.removedTicks / TICKS, 2) };
}

// ─── hints for what is not understood ───────────────────────────────────────────────────────────────────────────

function hintFor(clause: string, snapshot: ProjectSnapshot, board: Storyboard, scope: RevisionScope | null, why: string): NotUnderstood {
	const scene = activeScene(snapshot);
	const main = scene?.tracks?.main;
	const first = main?.elements?.[0];
	const clip = scope?.clip_ids[0] ?? first?.id ?? "<clip id>";
	const t = scope ? round(scope.start, 2) : 0;
	const c = clause.toLowerCase();
	let how = "Read timeline summary for element ids and times, then write ops@1 yourself (set · keyframe · text_pop · insert · split · delete · transition · gain · sfx).";
	let example: Array<Record<string, unknown>> = [{ op: "set", el: clip, prop: "opacity", value: 1 }];
	if (/\bloop/.test(c)) {
		how = "A loop = the last frame leads back into the first: insert the opening second of the first clip again at the very end (or end on a match of the first shot), then a short dissolve into it.";
		example = first
			? [
					{ op: "insert", track: main?.id ?? "main", media: first.mediaId ?? "<media id>", t: board.runtime, in: round(sec(first.trimStart ?? 0), 3), out: round(sec((first.trimStart ?? 0) + TICKS), 3), ref: "loop-in" },
					{ op: "transition", a: main?.elements?.[main.elements.length - 1]?.id ?? "<last clip>", b: "loop-in", kind: "dissolve", dur: 0.3 },
				]
			: [];
	} else if (/\b(zoom|push in|punch in|close ?up)\b/.test(c)) {
		how = "A punch-in = keyframes on the clip's scale over the beat.";
		example = [
			{ op: "keyframe", el: clip, prop: "scale", t, value: 1 },
			{ op: "keyframe", el: clip, prop: "scale", t: round(t + 0.4, 2), value: 1.15, ease: "ease_out" },
		];
	} else if (/\b(music|song|bed|louder|quieter|volume|duck)\b/.test(c)) {
		const audio = scene?.tracks?.audio ?? [];
		const music = audio.find((track) => !/^SFX/i.test(track.name ?? "") && track.restorff?.role !== "sfx");
		const bed = music?.elements?.[0];
		how = "Music level = gain (absolute dB) on the music clip, or duck the music track under the A-roll.";
		example = [
			{ op: "gain", el: bed?.id ?? "<music clip id>", db: -12 },
			{ op: "duck", track: music?.id ?? "<music track id>", under: main?.id ?? "main", amount_db: 8 },
		];
	} else if (/\b(whoosh|sfx|sound effect|hit|swoosh|pop sound)\b/.test(c)) {
		how = "A sound effect at a time: sfx (a name from the SFX library, or a media id).";
		example = [{ op: "sfx", name: "whoosh", t }];
	} else if (/\b(transition|whip|dissolve|fade|wipe)\b/.test(c)) {
		how = "A transition goes on the cut between two touching clips on one track.";
		example = [{ op: "transition", a: "<outgoing clip>", b: clip, kind: /whip/.test(c) ? "whip-left" : "dissolve" }];
	} else if (TEXT_RE.test(c) || /\b(write|say|words?)\b/.test(c)) {
		how = "On-screen text = text_pop at a time (or set prop text on an existing TEXT clip).";
		example = [{ op: "text_pop", t, text: "<the words>", dur: 1.5 }];
	} else if (/\b(add|put|insert|show|sparkle|glow|shine|animate|graphic|logo|sticker|effect)\b/.test(c)) {
		const query = c.replace(/\b(add|put|insert|show|some|a|an|the|to|on|in|of|it|this|that|please|make)\b/g, " ").replace(/\s+/g, " ").trim();
		return {
			clause,
			why,
			send: {
				tool: "effects",
				how: "A new graphic or effect is not a revision of what is there: find it in the effects library (effects list with a query, then effects apply at a time or on a clip), or write it as a composition (composition contract → composition write).",
				example_ops: [],
				steps: [
					{ tool: "effects", arguments: { action: "list", query: query || clause } },
					{ tool: "composition", arguments: { action: "contract" } },
				],
			},
		};
	} else if (/\b(remove|delete|cut|drop)\b/.test(c) && scope) {
		how = "Removing a beat: split the A-roll at the beat's edges, ripple_delete the middle piece, delete the captions in it.";
		example = [
			{ op: "split", el: clip, t: round(scope.start, 3), ref: "cut-a" },
			{ op: "split", el: "cut-a", t: round(scope.end, 3), ref: "cut-b" },
			{ op: "ripple_delete", el: "cut-a", scope: "all" },
			...scope.caption_ids.map((id) => ({ op: "delete", el: id })),
		];
	}
	return { clause, why, send: { tool: "timeline_ops", how, example_ops: example } };
}

/** A composition ask that is a code change: the exact get → update calls. */
function compositionRecipe(clause: string, targets: CompositionTarget[], timelineId: string, why: string): NotUnderstood {
	const target = targets[0];
	const how = `${structuralHint(clause)} ${target && !target.custom ? `${target.title} is a library composition: get returns its library source; updating it with your edited source makes it a custom composition (its code then travels in the clip).` : ""} One update per composition; send several at once as composition update {updates: [{element_id, source}]} for one commit.`.trim();
	return {
		clause,
		why,
		send: {
			tool: "composition",
			how,
			example_ops: [],
			steps: target
				? [
						{ tool: "composition", arguments: { action: "get", timeline_id: timelineId, element_id: target.element_id } },
						{ tool: "composition", arguments: { action: "update", timeline_id: timelineId, element_id: target.element_id, source: "<the source from get, edited>", message: clause } },
					]
				: [{ tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } }],
		},
	};
}

function compositionParamHint(clause: string, targets: CompositionTarget[], timelineId: string, why: string, props: Record<string, unknown> = {}): NotUnderstood {
	const target = targets[0];
	const params = target?.manifest ? Object.entries(target.manifest.params).map(([key, spec]) => `${key} (${spec.type}${key in target.props ? ` = ${JSON.stringify(target.props[key])}` : spec.default !== undefined ? ` = ${JSON.stringify(spec.default)}` : ""})`) : Object.keys(target?.props ?? {});
	return {
		clause,
		why,
		send: {
			tool: "composition",
			how: `Set the params yourself (merged; null removes). ${target ? `${target.title}'s params: ${params.slice(0, 16).join(", ") || "none declared"}.` : ""} Several compositions in one commit: composition update {element_ids: [...], props} or {updates: [{element_id, props}]}.`,
			example_ops: [],
			steps: [{ tool: "composition", arguments: { action: "update", timeline_id: timelineId, element_ids: targets.map((t) => t.element_id), props: Object.keys(props).length ? props : { "<param>": "<value>" }, message: clause } }],
		},
	};
}

// ─── the planner ────────────────────────────────────────────────────────────────────────────────────────────────

export interface PlanRevisionInput {
	sentence: string;
	snapshot: ProjectSnapshot;
	library: StyleLibrary;
	address?: RevisionAddress;
	board?: Storyboard;
	/** The timeline's compositions with their params blocks (listCompositions + library manifests). */
	compositions?: CompositionTarget[];
	/** For recipes in not_understood. */
	timelineId?: string;
	/** revise-safety: the person confirmed a caption change that drops words (default: such a change is refused). */
	allowWordLoss?: boolean;
}

function emptyPlan(sentence: string): RevisionPlan {
	return {
		sentence,
		ops: [],
		labels: [],
		preset: null,
		scope: null,
		not_understood: [],
		understood: false,
		notes: [],
		clauses: [],
		compositions: [],
		caption_changes: [],
		clause_report: [],
		milestone: null,
		word_fixes: [],
		caption_looks: [],
		exclude_chunks: [],
		word_loss_refused: [],
		left_out: [],
		matte_clips: [],
	};
}

/** Merge a composition edit into the plan (several clauses on one composition = one render with all their props). */
function addCompositionEdit(plan: RevisionPlan, edit: CompositionEdit): void {
	const known = plan.compositions.find((candidate) => candidate.element_id === edit.element_id);
	if (!known) {
		plan.compositions.push(edit);
		return;
	}
	Object.assign(known.props, edit.props);
	known.changes.push(...edit.changes);
	if (edit.duration_s !== undefined) known.duration_s = edit.duration_s;
}

const SUBJECT_RE = /\b(captions?|subtitles?|titles?|headlines?|cards?|charts?|graphs?|counters?|compositions?|overlays?|graphics|animations?|text|pops?|it|this|that|them|everything|video|cut|grade|look)\b/;

/** A version name from the sentence: "make the titles bigger" → "titles bigger", "give it a warm morning look" → "warm morning look". */
export function milestoneOf(sentence: string): string {
	const words = sentence
		.toLowerCase()
		.replace(/["“”‘’']/g, "")
		.replace(/[.!?]+$/g, "")
		.replace(/^(please |can you |could you |now |ok |okay )+/, "")
		.replace(/^(make|give|change|set|turn|put|do|let'?s make|let'?s)\s+/, "")
		.replace(/^(it|this|that|them|everything)\s+/, "")
		.replace(/^(a|an|the)\s+/, "")
		.split(/\s+/)
		.filter((word) => !["the", "a", "an", "please"].includes(word));
	return words.slice(0, 5).join(" ") || "revision";
}

export function planRevision(input: PlanRevisionInput): RevisionPlan {
	const sentence = input.sentence.trim();
	const snapshot = input.snapshot;
	const project = snapshot as unknown as OpsProject;
	const board = input.board ?? buildStoryboard(snapshot);
	const height = snapshot.settings?.canvasSize?.height ?? 1920;
	const timelineId = input.timelineId ?? "<timeline id>";
	const compositions = input.compositions ?? listCompositions(snapshot);
	const layered = !!captionLayers(snapshot);
	// revise-safety: captions the captions tool built (layered or not) are restyled by a rebuild with the look recorded
	// in every chunk — one size per span (a too-wide chunk splits instead of shrinking), placed clear of the face
	const rebuildable = toolCaptions(snapshot);
	const plan = emptyPlan(sentence);

	// 1. the call's address
	const given = input.address ?? {};
	const hasGiven = given.beat !== undefined || given.element_id !== undefined || given.t !== undefined;
	const argScope = hasGiven ? resolveScope(snapshot, board, given, "arguments") : null;
	if (typeof argScope === "string") {
		plan.error = argScope;
		return plan;
	}
	plan.scope = argScope;
	const argComposition = given.element_id ? (compositions.find((target) => target.element_id === given.element_id) ?? null) : null;
	const elementSpan = argScope?.element ? { start: argScope.start, end: argScope.end, id: argScope.element.id } : undefined;

	const report = (clause: string, status: ClauseReport["status"], did: string[] = [], span?: string) => plan.clause_report.push({ clause, status, did, ...(span ? { span } : {}) });
	const miss = (entry: NotUnderstood) => {
		plan.not_understood.push(entry);
		report(entry.clause, "not_understood", [entry.why]);
	};
	const applied = (clause: string, ops: Op[], labels: string[], span?: string) => {
		plan.ops.push(...ops);
		plan.labels.push(...labels);
		if (ops.length) plan.clauses.push({ text: clause, ops });
		report(clause, "applied", labels, span);
	};

	// 2. a saved style's trigger on the whole sentence
	const whole = matchTrigger(input.library, sentence);
	if (whole) {
		if (argScope) {
			miss(hintFor(sentence, snapshot, board, argScope, `"${whole.title}" is a saved style: it restyles the whole video. Send it without beat / element_id / t.`));
		} else {
			const applyAs = `${USER_STYLE_PREFIX}${whole.id}`;
			const op = { op: "apply_style", author: AUTHOR, preset_id: applyAs } as Op;
			plan.ops.push(...foldGradeLayer(snapshot), op);
			plan.styles = styleExpanders(input.library);
			plan.preset = { kind: "saved", id: whole.id, title: whole.title, version: whole.version, trigger: sentence, apply_as: applyAs };
			plan.labels.push(`saved style "${whole.title}" v${whole.version}`);
			plan.clauses.push({ text: sentence, ops: [op] });
			report(sentence, "applied", [`saved style "${whole.title}"`]);
			plan.milestone = whole.title;
		}
		plan.understood = plan.not_understood.length === 0;
		return plan;
	}

	// 3. clause by clause
	const { clauses, quotes } = splitSentence(sentence);
	const quoted = (text: string) => text.replace(/⟦q(\d+)⟧/g, (_all, n) => `"${quotes[Number(n)] ?? ""}"`);
	let carrySpan: ResolvedSpan | null = null;
	let carrySubject: string | null = null;
	const plainBatch: string[] = [];
	let refN = 0;
	let firstSpanScope: RevisionScope | null = null;

	for (const raw of clauses) {
		const shown = restoreQuotes(raw, quotes);
		// a. span words
		const parsed = parseScope(raw);
		let rest = parsed.rest;
		let span: ResolvedSpan | null = null;
		if (parsed.scope) {
			const resolved = resolveSpan(parsed.scope, board, { t: given.t, beat: given.beat, element: elementSpan });
			if (typeof resolved === "string") {
				miss({ clause: shown, why: resolved, send: { tool: "storyboard", how: "List the beats, then say \"beat N\", \"from 24 s\", \"the second half\", or send t / beat with revise.", example_ops: [], steps: [{ tool: "storyboard", arguments: { action: "get", timeline_id: timelineId } }] } });
				continue;
			}
			span = resolved;
		} else if (carrySpan && !argScope) span = carrySpan;
		// a clause that is only a span ("in beat 3") sets it for the clauses after it
		if (span && (!rest || /^(make|do|change|set|it|this|that|the|please|for|in|on|only|just|for this)$/.test(rest))) {
			carrySpan = span;
			report(shown, "span", [], span.label);
			continue;
		}
		const scope: RevisionScope | null = span ? scopeFromSpan(snapshot, board, span, "span", "sentence") : argScope;
		if (span && !firstSpanScope) firstSpanScope = scope;
		const spanLabel = scope?.label;
		// b. span words nobody could read: never drop them silently
		if (!parsed.scope && SPAN_HINT_RE.test(rest)) {
			miss({
				clause: shown,
				why: "it names a part of the video I can't place",
				send: { tool: "revise", how: "Say the part as \"from 24 s\", \"from 10 to 20 s\", \"the second half\", \"the last 10 s\", \"beat 5\" or \"beats 3-5\" — or send t / beat with the call.", example_ops: [], steps: [{ tool: "revise", arguments: { timeline_id: timelineId, sentence: `${rest.replace(SPAN_HINT_RE, "").replace(/\s+/g, " ").trim()} from <seconds> s` } }] },
			});
			continue;
		}
		// subject carried over: "make the captions bigger and yellow" → "yellow" is about the captions
		if (carrySubject && !SUBJECT_RE.test(rest) && rest.split(" ").length <= 4 && !resolveGradeName(rest) && !STYLE_WORDS.some((rule) => rule.re.test(rest)) && (COLOR_RE.test(rest) || nudgeWords(rest) || parseTextNudge(rest, height))) {
			rest = `${carrySubject} ${rest}`;
		}
		const c = rest;

		// c0. a word swap ("change 'Cloud' to 'Claude'"): every occurrence in the captions (in the span when one is named)
		const swap = parseTextChange(quoted(rest)) ? null : parseWordSwap(quoted(rest));
		const swapWords = swap ? (scope ? scopeCaptionWords(snapshot, scope.caption_ids) : captionWords(snapshot)) : [];
		const swapFixes = swap ? wordSwapFixes(swapWords, swap.from, swap.to, shown, snapshot) : [];
		if (swap && (swap.quoted || swapFixes.length)) {
			const words = swapWords;
			const fixes = swapFixes;
			if (!fixes.length) {
				const key = wordKey(swap.from.split(/\s+/)[0] ?? "");
				const near = [...new Set(words.filter((word) => key && (wordKey(word.text).startsWith(key.slice(0, 3)) || key.startsWith(wordKey(word.text).slice(0, 3)))).map((word) => `${word.text} @ ${round(word.start, 2)} s`))].slice(0, 8);
				miss({
					clause: shown,
					why: `no caption says "${swap.from}"${scope ? ` in ${scope.label}` : ""}${near.length ? ` (close: ${near.join(", ")})` : ""}`,
					send: { tool: "transcribe", how: "Name the word exactly as the captions show it (storyboard get lists every beat's line), or fix it in the transcript by index (transcribe {media_id} lists the words with their index).", example_ops: [], steps: [{ tool: "storyboard", arguments: { action: "get", timeline_id: timelineId } }] },
				});
				continue;
			}
			plan.word_fixes.push(...fixes);
			plan.milestone ??= `caption fix ${swap.from} → ${swap.to}`.slice(0, 60);
			applied(shown, [], [`captions: "${swap.from}" → "${swap.to}" (${fixes.length} place${fixes.length === 1 ? "" : "s"}, at ${fixes.map((fix) => `${round(fix.t, 2)} s`).join(", ")}; a word fix — nothing else changes)`], spanLabel);
			carrySubject = "captions";
			continue;
		}

		// c. text change
		const change = parseTextChange(quoted(rest));
		if (change) {
			if (!scope) {
				miss(hintFor(`${change.target} → "${change.text}"`, snapshot, board, null, "which one? Send beat (storyboard get), element_id or t with revise, or say \"beat 3\" / \"at 12 s\" in the sentence."));
				continue;
			}
			// revise-safety: a caption's new words are aligned inside the beat's words — a word fix, a rewrite that loses
			// no word, or a refusal (it would delete words the person did not ask to remove)
			if (change.target === "caption" && scope.caption_ids.length) {
				const text = captionTextPlan(snapshot, scope, change.text, shown, timelineId);
				if (text.kind === "same") {
					report(shown, "nothing_to_change", [text.label], spanLabel);
					carrySubject = "captions";
					continue;
				}
				if (text.kind === "fix") {
					plan.word_fixes.push(...text.fixes);
					plan.milestone ??= `caption fix ${text.fixes.map((fix) => `${fix.from} → ${fix.to || "(removed)"}`).join(", ")}`.slice(0, 60);
					if (text.dropped.length) plan.notes.push(`left out by the new text (removed on purpose): ${text.dropped.map((word) => `"${word.text}" @ ${word.t} s`).join(", ")}`);
					applied(shown, [], [text.label], spanLabel);
					carrySubject = "captions";
					continue;
				}
				if (text.kind === "loss" && !input.allowWordLoss) {
					plan.word_loss_refused.push({ clause: shown, would_delete: text.would_delete });
					miss(text.miss);
					continue;
				}
			}
			const made = textChangeOps(snapshot, scope, change, compositions);
			if ("error" in made) {
				miss(hintFor(shown, snapshot, board, scope, made.error));
				continue;
			}
			if (made.chunks?.length) plan.caption_changes.push(...made.chunks);
			for (const edit of made.compositions ?? []) addCompositionEdit(plan, { ...edit, clause: shown });
			if (made.note) plan.notes.push(made.note);
			applied(shown, made.ops, [made.label], spanLabel);
			carrySubject = change.target === "caption" ? "captions" : "titles";
			continue;
		}

		// d. a saved style's trigger on this clause
		const savedHit: SavedStyle | null = matchTrigger(input.library, quoted(rest));
		if (savedHit) {
			if (scope) {
				miss(hintFor(shown, snapshot, board, scope, `"${savedHit.title}" is a saved style: it restyles the whole video. Send it without a span (no beat / t / "from …").`));
			} else if (plan.preset) {
				miss(hintFor(shown, snapshot, board, null, `one style per sentence: "${plan.preset.kind === "saved" ? plan.preset.title : plan.preset.id}" is already applied by this sentence`));
			} else {
				const applyAs = `${USER_STYLE_PREFIX}${savedHit.id}`;
				const op = { op: "apply_style", author: AUTHOR, preset_id: applyAs } as Op;
				plan.ops.unshift(...foldGradeLayer(snapshot), op);
				plan.styles = styleExpanders(input.library);
				plan.preset = { kind: "saved", id: savedHit.id, title: savedHit.title, version: savedHit.version, trigger: shown, apply_as: applyAs };
				plan.labels.unshift(`saved style "${savedHit.title}" v${savedHit.version}`);
				plan.clauses.unshift({ text: shown, ops: [op] });
				report(shown, "applied", [`saved style "${savedHit.title}"`]);
				plan.milestone ??= savedHit.title;
			}
			continue;
		}

		// e. compositions
		const picked = pickCompositions(c, compositions, { within: scope && scope.kind !== "element" ? scope : null, element: argComposition });
		const titleTexts = /\b(titles?|headlines?|text|pops?|big words?)\b/.test(c) && !CAPTION_RE.test(c) ? (scope ? scope.text_ids : textTracksOf(snapshot).flatMap((track) => (track.elements ?? []).filter((element) => textOf(element)).map((element) => element.id))) : [];
		if (picked && (picked.targets.length || titleTexts.length)) {
			const words = nudgeWords(picked.words ? c.replace(picked.words, " ") : c);
			if (isStructural(c)) {
				miss(compositionRecipe(shown, picked.targets, timelineId, "that changes how the composition moves (its code), not a param: edit its source"));
				carrySubject = picked.noun;
				continue;
			}
			if (words) {
				if (words.colour && "ask" in words.colour) {
					const options = picked.targets.map((target) => `${target.title}: ${colourParams(target, words.colour?.part ?? "any").map((key) => `${key} ${String(target.props[key] ?? target.manifest?.params[key]?.default ?? "")}`).join(", ") || "no colour params"}`);
					miss(compositionParamHint(shown, picked.targets, timelineId, `which colour? Name one ("make ${picked.noun} orange", or a #hex). ${options.slice(0, 4).join(" · ")}`));
					carrySubject = picked.noun;
					continue;
				}
				const did: string[] = [];
				let changed = 0;
				const skipped: string[] = [];
				for (const target of picked.targets) {
					if (target.layered) {
						skipped.push(`${target.title} is a layer of the layered effect ${target.effect?.name ?? target.effect?.id ?? ""}: change it with effects update`);
						continue;
					}
					const nudged = nudgeComposition(target, words, height);
					skipped.push(...nudged.skipped.map((s) => `${target.title}: ${s.replace(`${target.title} `, "")}`));
					if (!nudged.changes.length) continue;
					const props = Object.fromEntries(nudged.changes.filter((ch) => ch.key !== "duration_s").map((ch) => [ch.key, ch.to]));
					addCompositionEdit(plan, { element_id: target.element_id, title: target.title, custom: target.custom, props, changes: nudged.changes, ...(nudged.duration_s !== undefined ? { duration_s: nudged.duration_s } : {}), clause: shown });
					changed++;
				}
				// TEXT-track titles take the size / colour / position part of the same words
				let textOps: Op[] = [];
				if (titleTexts.length) {
					const nudge = parseTextNudge(c.replace(picked.words, " titles "), height);
					if (nudge) textOps = nudgeOps(snapshot, titleTexts, nudge);
					if (textOps.length) did.push(`${titleTexts.length} title clip${titleTexts.length === 1 ? "" : "s"} ${nudge?.labels.join(", ")}`);
				}
				if (changed) did.unshift(`${changed} composition${changed === 1 ? "" : "s"} (${picked.how}): ${words.said.join(", ")} — re-rendered in place`);
				if (skipped.length) plan.notes.push(...skipped.slice(0, 12));
				if (!changed && !textOps.length) {
					if (skipped.length) report(shown, "nothing_to_change", skipped.slice(0, 6));
					else miss(compositionParamHint(shown, picked.targets, timelineId, `none of ${picked.noun} has a param for "${words.said.join(", ")}"`));
					carrySubject = picked.noun;
					continue;
				}
				applied(shown, textOps, did.length ? [`${picked.noun}${spanLabel ? ` in ${spanLabel}` : ""}: ${did.join("; ")}`] : [], spanLabel);
				carrySubject = picked.noun;
				continue;
			}
			// words about compositions that are no nudge ("make the titles sparkle"): only when the clause names them
			if (picked.noun !== "this composition" && !resolveGradeName(c) && !STYLE_WORDS.some((rule) => rule.re.test(c))) {
				miss(compositionParamHint(shown, picked.targets, timelineId, `no rule for "${c}" on ${picked.noun} (size, speed, colour, ease, position, exit, length)`));
				carrySubject = picked.noun;
				continue;
			}
		} else if (picked && !picked.targets.length && /\b(titles?|cards?|charts?|graphs?|counters?|compositions?|overlays?|graphics|animations?)\b/.test(c) && !CAPTION_RE.test(c)) {
			miss({ clause: shown, why: `there are no ${picked.noun} on this timeline${scope ? ` in ${scope.label}` : ""} (compositions: ${compositions.map((target) => target.title).slice(0, 8).join(", ") || "none"})`, send: { tool: "timeline", how: "Read the summary for the composition clips' ids, or address one with element_id.", example_ops: [], steps: [{ tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } }] } });
			continue;
		}
		// a structural ask on a clip or the timeline (no composition): the old recipes
		if (argComposition && isStructural(c)) {
			miss(compositionRecipe(shown, [argComposition], timelineId, "that changes how the composition moves (its code), not a param: edit its source"));
			continue;
		}

		// f. captions (layered ones are rebuilt chunk by chunk; plain ones get set ops) — scoped or whole
		const captionNudge = CAPTION_RE.test(c) || scope?.element?.role === "caption" ? parseTextNudge(c, height) : null;
		if (captionNudge && (layered || scope || rebuildable)) {
			const ids = scope ? scope.caption_ids : captionTracksOf(snapshot).flatMap((track) => (track.elements ?? []).map((element) => element.id));
			if (!ids.length) {
				miss(hintFor(shown, snapshot, board, scope, `there is no caption ${scope ? `in ${scope.label}` : "on this timeline"}: add them with the captions tool`));
				continue;
			}
			if (rebuildable && !captionNudge.hide && !captionNudge.show) {
				// revise-safety: tool-built captions are rebuilt from their own chunks with the restyle written into each
				// chunk's look — each chunk relative to its own size (a span keeps one size), measured and placed again,
				// and a later rebuild keeps it (the oat run's "bigger captions" set ONE absolute size, 13 × 1.35, everywhere)
				plan.caption_looks.push(lookChangeOf(captionNudge, scope));
				applied(shown, [], [`captions${spanLabel ? ` in ${spanLabel}` : ""}: ${captionNudge.labels.join(", ")} (${ids.length} chunk${ids.length === 1 ? "" : "s"} rebuilt, the look recorded in each)`], spanLabel);
				carrySubject = "captions";
				continue;
			}
			if (layered) {
				if (captionNudge.hide || captionNudge.show) {
					applied(shown, layeredHideOps(snapshot, ids, Boolean(captionNudge.hide)), [`captions${spanLabel ? ` in ${spanLabel}` : ""}: ${captionNudge.labels.join(", ")}`], spanLabel);
				} else {
					plan.caption_changes.push(...nudgeChunks(ids, captionNudge));
					if (captionNudge.style.uppercase) plan.notes.push("uppercase: the caption words keep their case in a rebuild; say it as a caption style change in the captions tool");
					applied(shown, [], [`captions${spanLabel ? ` in ${spanLabel}` : ""}: ${captionNudge.labels.join(", ")} (${ids.length} chunk${ids.length === 1 ? "" : "s"} rebuilt with their word layer)`], spanLabel);
				}
			} else {
				applied(shown, nudgeOps(snapshot, ids, captionNudge), [`captions in ${spanLabel}: ${captionNudge.labels.join(", ")}`], spanLabel);
			}
			carrySubject = "captions";
			continue;
		}
		// TEXT titles (pops, big words on the TEXT track), in a span or everywhere
		if ((TEXT_RE.test(c) || scope?.element?.role === "text") && !CAPTION_RE.test(c)) {
			const nudge = parseTextNudge(c, height);
			const ids = scope ? scope.text_ids : textTracksOf(snapshot).flatMap((track) => (track.elements ?? []).filter((element) => textOf(element)).map((element) => element.id));
			if (nudge) {
				if (!ids.length) {
					miss(hintFor(shown, snapshot, board, scope, `there is no title / TEXT clip ${scope ? `in ${scope.label}` : "on this timeline"}`));
					continue;
				}
				applied(shown, nudgeOps(snapshot, ids, nudge), [`text${spanLabel ? ` in ${spanLabel}` : ""}: ${nudge.labels.join(", ")}`], spanLabel);
				carrySubject = "titles";
				continue;
			}
		}

		// g. without a span: the command bar's planner (batched below, so its op order is kept)
		if (!scope) {
			plainBatch.push(quoted(rest));
			continue;
		}

		// h. with a span: speed, delete, style, grade, tighter
		const ops: Op[] = [];
		const labels: string[] = [];
		const slow = /\b(slow(er)?( (it|this|that|the \w+))?( right)? down|slower|slow[- ]?mo(tion)?|half speed)\b/.test(c) || /^slow\b/.test(c);
		const fast = /\b(speed (it|this|that)? ?up|faster|double speed|quicker)\b/.test(c) && !/\bcut\b/.test(c);
		if (slow || fast) {
			const rate = slow ? (/\b(half|much|way|slow[- ]?mo)/.test(c) ? 0.5 : 0.75) : /\b(double|much|way)\b/.test(c) ? 2 : 1.25;
			const shots = scope.shot_ids.map((id) => findSnapshotElement(snapshot, id)).filter((found) => found && found.element.type === "video");
			const broll = shots.filter((found) => found?.group !== "main").map((found) => found?.element.id as string);
			if (!broll.length) {
				// nothing to slow but the talking head: the compositions playing over it are the moving thing
				const active = compositions.filter((target) => target.start < scope.end && target.end > scope.start && !target.layered);
				const words = nudgeWords(slow ? "slower" : "faster");
				if (active.length && words) {
					let changed = 0;
					for (const target of active) {
						const nudged = nudgeComposition(target, { ...words, speed: slow ? (rate <= 0.5 ? 0.6 : 0.8) : rate >= 2 ? 1.6 : 1.25 }, height);
						if (!nudged.changes.length) continue;
						addCompositionEdit(plan, { element_id: target.element_id, title: target.title, custom: target.custom, props: Object.fromEntries(nudged.changes.map((ch) => [ch.key, ch.to])), changes: nudged.changes, clause: shown });
						changed++;
					}
					if (changed) {
						applied(shown, [], [`${scope.label}: ${changed} composition${changed === 1 ? "" : "s"} ${slow ? "slower" : "faster"} (their speed param; the talking head keeps its timing)`], spanLabel);
						continue;
					}
				}
				miss(
					hintFor(
						shown,
						snapshot,
						board,
						scope,
						shots.length
							? "this span shows the A-roll (the talking head): retiming it slows the voice and drops words. Put a B-roll cut-in over it and slow that, or send set speed yourself if that is really wanted."
							: "no video clip or composition with a speed param on screen in this span to retime",
					),
				);
				continue;
			}
			const cut = middlePieces(snapshot, scope, `rev-speed-${++refN}`, broll);
			ops.push(...cut.ops);
			for (const piece of cut.pieces) {
				const length = piece.end - piece.start;
				const out = round(piece.sourceIn + length * rate, 3);
				const fits = piece.sourceLength === null || out <= piece.sourceLength + 1e-6;
				const speedOp = { op: "set", author: AUTHOR, el: piece.target, prop: "speed", value: rate } as Op;
				const trimOp = { op: "trim", author: AUTHOR, el: piece.target, out } as Op;
				if (rate < 1) ops.push(trimOp, speedOp);
				else ops.push(speedOp, ...(fits ? [trimOp] : []));
				if (rate > 1 && !fits) plan.notes.push(`${piece.element.name ?? piece.element.id}: not enough footage to fill the beat at ${rate}×, so it ends early (the A-roll shows through)`);
			}
			if (shots.some((found) => found?.group === "main")) plan.notes.push(`${scope.label}: the talking head on screen there keeps its speed (retiming it would slow the voice)`);
			labels.push(`${scope.label}: B-roll ${rate < 1 ? "slow motion" : "sped up"} at ${rate}× (same length)`);
			applied(shown, ops, labels, spanLabel);
			continue;
		}
		if (scope.element && /\b(delete|remove|get rid of|drop)\b/.test(c) && /\b(it|this|that|element|clip|caption|title|text)\b/.test(c)) {
			// asked for: the word guard does not count a deleted caption's words as lost
			if (scope.element.role === "caption") plan.exclude_chunks.push(scope.element.id);
			applied(shown, [{ op: "delete", author: AUTHOR, el: scope.element.id }], [`deleted ${scope.element.id}`], spanLabel);
			continue;
		}
		const style = STYLE_WORDS.find((rule) => rule.re.test(c));
		const grade = style ? null : resolveSentence(c, { project, author: AUTHOR }).ops.find((op) => op.op === "grade") as (Op & { preset?: string }) | undefined;
		const pacing = /\b(tight(er|en)?|cut the pauses|remove (the )?(gaps|pauses)|snappier cut|quicker cut)\b/.test(c);
		if (style) {
			const preset = EDITING_STYLE_PRESETS.find((candidate) => candidate.id === style.id);
			if (preset) {
				const did: string[] = [];
				if (preset.grade) {
					const graded = scopedGradeOps(snapshot, scope, preset.grade, `rev-grade-${++refN}`);
					ops.push(...graded.ops);
					did.push(`${preset.grade} grade on ${graded.where}`);
					if (graded.note) plan.notes.push(graded.note);
				}
				const { yFraction, ...captionStyle } = preset.captions;
				const look: TextStyle = { ...captionStyle, ...(yFraction !== undefined ? { y: Math.round(height * yFraction) } : {}) };
				if (scope.caption_ids.length) {
					if (rebuildable) plan.caption_looks.push({ restyle: look, span: { t0: scope.start, t1: scope.end } });
					else if (layered) plan.caption_changes.push(...scope.caption_ids.map((id) => ({ id, style: look })));
					else ops.push(...nudgeOps(snapshot, scope.caption_ids, { factor: null, style: look, labels: [] }));
					did.push(`${scope.caption_ids.length} caption${scope.caption_ids.length === 1 ? "" : "s"} restyled (${preset.captions.font ?? "style font"})`);
				}
				plan.notes.push(`${preset.label} on ${scope.label}: grade and captions only — its pacing and its compositions are whole-video parts (say "make it ${style.label}" without a span for all of it)`);
				plan.preset ??= { kind: "builtin", id: preset.id, apply_as: `restorff/style/${preset.id}`, scoped: scope.label };
				plan.milestone ??= `${style.label} ${scope.label.replace(/\s*\(.*\)$/, "")}`;
				applied(shown, ops, [`${style.label} on ${scope.label}: ${did.join(" + ") || "nothing on screen to restyle"}`], spanLabel);
				continue;
			}
		}
		if (grade?.preset) {
			const graded = scopedGradeOps(snapshot, scope, grade.preset, `rev-grade-${++refN}`);
			ops.push(...graded.ops);
			labels.push(`${grade.preset} grade on ${scope.label} (${graded.where})`);
			if (graded.note) plan.notes.push(graded.note);
		}
		if (pacing) {
			const cut = scopedTighten(project, scope, STRONG_RE.test(c));
			if (cut.ops.length) {
				ops.push(...cut.ops);
				labels.push(`tighter cut in ${scope.label}: −${cut.removed} s`);
			} else if (!ops.length) {
				report(shown, "nothing_to_change", [`tighter cut in ${scope.label}: no pause to remove (pauses are found between captions)`], spanLabel);
				continue;
			}
		}
		if (ops.length) {
			applied(shown, ops, labels, spanLabel);
			continue;
		}
		miss(hintFor(shown, snapshot, board, scope, "no rule here matched it for a span (grade words, an editing style, speed, tighter, caption / title styling and words, composition params)"));
	}

	// 4. the plain clauses: the command bar's own planner, in one go (byte-identical ops for a plain sentence)
	if (plainBatch.length) {
		const intent = resolveSentence(plainBatch.join(", "), { project, author: AUTHOR });
		const styled = intent.ops.some((op) => op.op === "apply_style");
		const graded = intent.ops.some((op) => op.op === "grade");
		let ops = intent.ops;
		if (styled) ops = [...foldGradeLayer(snapshot), ...ops];
		else if (graded) ops = gradeEveryPiece(snapshot, ops);
		plan.ops.push(...ops);
		if (intent.label) plan.labels.push(intent.label);
		plan.notes.push(...intent.notes);
		if (intent.styleId && !plan.preset) {
			plan.preset = { kind: "builtin", id: intent.styleId, apply_as: `restorff/style/${intent.styleId}` };
			plan.milestone ??= STYLE_WORDS.find((rule) => rule.id === intent.styleId)?.label ?? intent.styleId;
		}
		for (const clause of intent.clauses) {
			if (clause.kinds.length) {
				plan.clauses.push({ text: clause.text, ops: clause.ops });
				const nothing = !clause.ops.length && !clause.kinds.includes("style");
				report(clause.text, nothing ? "nothing_to_change" : "applied", [...clause.labels, ...(nothing ? clause.notes : [])]);
				// revise-safety: what the style declares and this commit does not add, with the exact calls (never silent)
				if (clause.kinds.includes("style") && intent.styleId) {
					for (const piece of stylePiecesLeftOut(intent.styleId, snapshot, timelineId, clause.text)) {
						plan.left_out.push(piece);
						for (const id of piece.matte_clips) if (!plan.matte_clips.includes(id)) plan.matte_clips.push(id);
						miss({ clause: piece.clause, why: piece.why, send: piece.send });
					}
				}
				continue;
			}
			// the command bar's reason speaks to a person with a mouse; over MCP name the words that work
			const why = (clause.reason ?? "no rule matched").replace(
				/ — select a composition clip for slower \/ bigger \/ make it red$/,
				" — or name what it changes (\"the titles\", \"the counter\", \"the captions\", \"from 24 s\") or send element_id",
			);
			if (/word by word/.test(why)) {
				miss({ clause: clause.text, why, send: { tool: "revise", how: "Layered (word-highlight) captions are rebuilt by revise when the clause names them: say e.g. \"make the captions bigger\" or \"yellow captions\".", example_ops: [] } });
			} else {
				miss(hintFor(clause.text, snapshot, board, null, why));
			}
		}
	}

	plan.scope ??= firstSpanScope;
	if (plan.compositions.length) {
		const n = plan.compositions.length;
		plan.labels.push(`${n} composition${n === 1 ? "" : "s"} re-rendered with new params`);
	}
	const didSomething = plan.ops.length > 0 || plan.compositions.length > 0 || plan.caption_changes.length > 0 || plan.word_fixes.length > 0 || plan.caption_looks.length > 0;
	if (didSomething && !plan.milestone) {
		// several clauses: the version is named after what it did first ("warmer", not "warmer, and change beat 3")
		const applied = plan.clause_report.filter((entry) => entry.status === "applied");
		const first = applied.length > 1 ? applied.find((entry) => !/caption|text|title/.test(entry.clause)) ?? applied[0] : null;
		plan.milestone = milestoneOf(first ? `${first.clause}${applied.length > 1 ? " +" : ""}` : sentence).replace(/\s*\+$/, " +");
	}
	plan.milestone = plan.milestone ? plan.milestone.replace(/^the\s+/i, "").replace(/\s+the\s+/gi, " ").trim() : null;
	plan.understood = plan.not_understood.length === 0 && plan.clause_report.length > 0;
	return plan;
}
