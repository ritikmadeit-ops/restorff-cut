/**
 * Clauses and spans for one-sentence revisions (revise-v2 agent, 2026-10-20; BUILD-BRIEF §5f, SUMMARY gap 2). Pure.
 *
 *   splitSentence("Make it warmer, and change the beat 3 caption to \"Estate to roastery, to bottling\"")
 *     → ["make it warmer", "change the beat 3 caption to ⟦q0⟧"] + quotes ["Estate to roastery, to bottling"]
 *     (quoted words are protected first, so a comma inside them never splits a clause and their case survives)
 *   parseScope("make the second half moody") → { scope: {kind:"fraction", from:0.5, to:1}, rest: "make moody" }
 *   resolveSpan(scope, board) → { start, end, label } in timeline seconds, or a string saying why not
 *
 * Spans understood: "beat 5" · "beats 3-5" · "the first / second half" · "the first / last third|quarter" ·
 * "the first / last 10 s" · "from 24 s" · "from 24.6 s to the end" · "from 10 to 20 s" · "between 10 and 20 s" ·
 * "until 12 s" · "at 12.5 s" / "at 0:12" (the beat playing then) · "the ending" / "the opening" (last / first beat) ·
 * "this section | part | bit | beat | moment" (needs t, beat or element_id with the call).
 */
import { rowAt, type Storyboard } from "./storyboard-rows";

const NUM = String.raw`(\d{1,4}(?:\.\d+)?)`;
const CLOCK = String.raw`(\d{1,2}):(\d{2}(?:\.\d+)?)`;
const SEC = String.raw`\s*(?:s|sec|secs|seconds?)\b`;

export type ClauseScope =
	| { kind: "beat"; beat: number; words: string }
	| { kind: "beats"; from: number; to: number; words: string }
	| { kind: "fraction"; from: number; to: number; words: string }
	| { kind: "seconds"; from: number | null; to: number | null; words: string }
	| { kind: "head"; seconds: number; words: string }
	| { kind: "tail"; seconds: number; words: string }
	| { kind: "time"; t: number; words: string }
	/** The first / last beat; `relation` after|before = everything after / before it ("after the hook"). */
	| { kind: "edge"; edge: "start" | "end"; relation?: "after" | "before"; words: string }
	| { kind: "this"; words: string };

export interface SplitSentence {
	clauses: string[];
	/** The quoted texts, in order; a clause carries ⟦qN⟧ where quote N was. */
	quotes: string[];
}

const QUOTE_RE = /"([^"]+)"|“([^”]+)”|‘([^’]+)’|(?<![A-Za-z])'([^']+)'(?![A-Za-z])/g;

export function protectQuotes(sentence: string): { text: string; quotes: string[] } {
	const quotes: string[] = [];
	const text = sentence.replace(QUOTE_RE, (_all, a, b, c, d) => {
		quotes.push(String(a ?? b ?? c ?? d ?? "").trim());
		return ` ⟦q${quotes.length - 1}⟧ `;
	});
	return { text, quotes };
}

export function restoreQuotes(text: string, quotes: readonly string[]): string {
	return text.replace(/⟦q(\d+)⟧/g, (_all, n) => quotes[Number(n)] ?? "");
}

/**
 * Split a sentence into clauses on , ; ! ? + & and "and" / "then" / "also" / "plus" — never inside quotes, a number
 * ("24.6 s"), "black and white", "between 10 and 20 s" or "beats 3 and 4". Lower case, quotes kept as ⟦qN⟧.
 */
export function splitSentence(sentence: string): SplitSentence {
	const { text, quotes } = protectQuotes(sentence);
	const normal = text
		.toLowerCase()
		.replace(/\bblack (and|&|n) white\b/g, "black_and_white")
		.replace(new RegExp(String.raw`\bbetween ${NUM}(?:${SEC})? and ${NUM}${SEC}`, "g"), (_all, a, b) => `from ${a} s to ${b} s`)
		.replace(/\bbeats (\d{1,3}) (?:and|&) (\d{1,3})\b/g, (_all, a, b) => `beats ${a}-${b}`)
		.replace(/\s+/g, " ")
		.trim();
	const clauses = normal
		.split(/\s*(?:[,;!?+&]|\.(?!\d)|\band then\b|\bthen\b|\band\b|\balso\b|\bplus\b)\s*/)
		.map((part) => part.replace(/^(please|pls|can you|could you|now|just|and|ok|okay|also)\s+/g, "").replace(/\s+(please|pls)$/g, "").trim())
		.filter((part) => part.length > 0 && !/^(please|thanks|thank you)$/.test(part));
	return { clauses, quotes };
}

const n = (value: string | undefined) => Number(value);
const clock = (m: string | undefined, s: string | undefined) => Number(m) * 60 + Number(s);

/** Scope words in one clause → the scope and the clause without them. Null scope = none said. */
export function parseScope(clause: string): { scope: ClauseScope | null; rest: string } {
	let rest = ` ${clause} `;
	const take = (re: RegExp, make: (m: RegExpMatchArray) => ClauseScope): ClauseScope | null => {
		const m = rest.match(re);
		if (!m) return null;
		rest = rest.replace(m[0], " ");
		return make(m);
	};
	const pre = String.raw`(?:\b(?:in|on|at|for|of|during|over|across|to)\s+)?(?:the\s+)?`;
	const scope =
		take(new RegExp(String.raw`${pre}\bbeats?\s*#?\s*(\d{1,3})\s*(?:-|–|to|through|thru)\s*(\d{1,3})\b`, "i"), (m) => ({ kind: "beats", from: n(m[1]), to: n(m[2]), words: m[0].trim() })) ??
		take(new RegExp(String.raw`${pre}\b(?:beat|row)\s*#?\s*(\d{1,3})(?:'s)?\b`, "i"), (m) => ({ kind: "beat", beat: n(m[1]), words: m[0].trim() })) ??
		take(new RegExp(String.raw`${pre}\b(first|1st|front|opening|second|2nd|last|latter|back|final|closing)\s+half\b(?:\s+of\s+(?:it|the\s+(?:video|cut|ad|reel)))?`, "i"), (m) => {
			const first = /^(first|1st|front|opening)$/i.test(m[1] ?? "");
			return { kind: "fraction", from: first ? 0 : 0.5, to: first ? 0.5 : 1, words: m[0].trim() };
		}) ??
		take(new RegExp(String.raw`${pre}\b(first|opening|last|final|closing|middle)\s+(third|quarter)\b`, "i"), (m) => {
			const part = /third/i.test(m[2] ?? "") ? 1 / 3 : 1 / 4;
			const which = (m[1] ?? "").toLowerCase();
			if (which === "middle") return { kind: "fraction", from: 0.5 - part / 2, to: 0.5 + part / 2, words: m[0].trim() };
			const first = which === "first" || which === "opening";
			return { kind: "fraction", from: first ? 0 : 1 - part, to: first ? part : 1, words: m[0].trim() };
		}) ??
		take(new RegExp(String.raw`${pre}\b(first|opening|last|final|closing)\s+${NUM}${SEC}`, "i"), (m) => {
			const seconds = n(m[2]);
			return /^(first|opening)$/i.test(m[1] ?? "") ? { kind: "head", seconds, words: m[0].trim() } : { kind: "tail", seconds, words: m[0].trim() };
		}) ??
		take(new RegExp(String.raw`\b(?:from|between)\s+${NUM}(?:${SEC})?\s*(?:to|until|till|through|-|–)\s*${NUM}${SEC}`, "i"), (m) => ({ kind: "seconds", from: n(m[1]), to: n(m[2]), words: m[0].trim() })) ??
		take(new RegExp(String.raw`\b(?:from|between)\s+${CLOCK}\s*(?:to|until|till|-|–)\s*${CLOCK}\b`, "i"), (m) => ({ kind: "seconds", from: clock(m[1], m[2]), to: clock(m[3], m[4]), words: m[0].trim() })) ??
		take(new RegExp(String.raw`\b(?:from|after|since|starting at|starting from|onwards? from)\s+${NUM}${SEC}(?:\s+(?:on|onwards?|to the end|till the end|until the end))?`, "i"), (m) => ({ kind: "seconds", from: n(m[1]), to: null, words: m[0].trim() })) ??
		take(new RegExp(String.raw`\b(?:from|after|since|starting at)\s+${CLOCK}\b(?:\s+(?:on|onwards?|to the end|till the end|until the end))?`, "i"), (m) => ({ kind: "seconds", from: clock(m[1], m[2]), to: null, words: m[0].trim() })) ??
		take(new RegExp(String.raw`\b(?:until|till|up to|before)\s+${NUM}${SEC}`, "i"), (m) => ({ kind: "seconds", from: null, to: n(m[1]), words: m[0].trim() })) ??
		take(new RegExp(String.raw`\b(?:at|around)\s+${NUM}${SEC}`, "i"), (m) => ({ kind: "time", t: n(m[1]), words: m[0].trim() })) ??
		take(new RegExp(String.raw`\b(?:at|around)\s+${CLOCK}\b`, "i"), (m) => ({ kind: "time", t: clock(m[1], m[2]), words: m[0].trim() })) ??
		take(/\b(after|before|until|till|from)\s+the\s+(ending|end|outro|last beat|final beat|closing|opening|intro|first beat|hook|start|beginning)\b/i, (m) => {
			const start = /^(opening|intro|first beat|hook|start|beginning)$/i.test(m[2] ?? "");
			const after = /^(after|from)$/i.test(m[1] ?? "");
			return { kind: "edge", edge: start ? "start" : "end", relation: after ? "after" : "before", words: m[0].trim() };
		}) ??
		take(/(?:\b(?:in|on|at|for|of|during)\s+)?\bthe\s+(ending|end|outro|last beat|final beat|closing)\b/i, (m) => ({ kind: "edge", edge: "end", words: m[0].trim() })) ??
		take(/(?:\b(?:in|on|at|for|of|during)\s+)?\bthe\s+(opening|intro|first beat|hook|start|beginning)\b/i, (m) => ({ kind: "edge", edge: "start", words: m[0].trim() })) ??
		take(/(?:\b(?:in|on|for|during)\s+)?\b(this|that)\s+(section|part|bit|beat|moment|stretch|passage)\b/i, (m) => ({ kind: "this", words: m[0].trim() }));
	// "make it moody to the end" without a start: the end is not a span on its own
	return { scope, rest: rest.replace(/\s+/g, " ").trim() };
}

/** Words that say "only part of the video" — a clause that still holds one after parseScope has a span nobody read. */
export const SPAN_HINT_RE = /\b(half|halves|section|from \d|from the|until|till|after the|before the|between|onwards|the rest|the middle part|the first part|the last part|third|quarter|segment)\b/i;

export interface ResolvedSpan {
	start: number;
	end: number;
	label: string;
	/** Rows (beats) it touches. */
	rows: number[];
	/** True when the edges were snapped to beat edges (fuzzy spans: halves, thirds). */
	snapped: boolean;
}

const r2 = (value: number) => Math.round(value * 100) / 100;
const r3 = (value: number) => Math.round(value * 1000) / 1000;

/** Snap a fuzzy edge to the nearest beat edge within `reach` seconds (so a grade changes on a cut, not mid-shot). */
function snapEdge(board: Storyboard, t: number, reach: number): number {
	let best = t;
	let distance = reach;
	for (const row of board.rows) {
		for (const edge of [row.start, row.end]) {
			const d = Math.abs(edge - t);
			if (d < distance) {
				distance = d;
				best = edge;
			}
		}
	}
	return best;
}

function spanOf(board: Storyboard, start: number, end: number, label: string, snapped: boolean): ResolvedSpan | string {
	const a = Math.max(0, Math.min(start, board.runtime));
	const b = Math.max(0, Math.min(end, board.runtime));
	if (!(b - a >= 0.1)) return `that span (${r2(start)}–${r2(end)} s) is empty on this timeline (it runs ${board.runtime} s)`;
	const rows = board.rows.filter((row) => row.start < b && row.end > a).map((row) => row.row);
	return { start: r3(a), end: r3(b), label, rows, snapped };
}

/**
 * A clause scope → seconds on this timeline. `address` = what the call said (t / beat / element span) for "this
 * section". A string = why it cannot be resolved (said back to the caller as not_understood).
 */
export function resolveSpan(scope: ClauseScope, board: Storyboard, address: { t?: number; beat?: number; element?: { start: number; end: number; id: string } } = {}): ResolvedSpan | string {
	const runtime = board.runtime;
	if (!board.rows.length) return "the timeline is empty";
	switch (scope.kind) {
		case "beat": {
			const row = board.rows[scope.beat - 1];
			if (!row) return `there is no beat ${scope.beat}: this storyboard has ${board.rows.length} (storyboard get lists them)`;
			return spanOf(board, row.start, row.end, `beat ${row.row} (${row.range})`, false);
		}
		case "beats": {
			const a = board.rows[Math.min(scope.from, scope.to) - 1];
			const b = board.rows[Math.max(scope.from, scope.to) - 1];
			if (!a || !b) return `beats ${scope.from}–${scope.to}: this storyboard has ${board.rows.length} (storyboard get lists them)`;
			return spanOf(board, a.start, b.end, `beats ${a.row}–${b.row} (${a.range.split("–")[0]}–${b.range.split("–")[1]})`, false);
		}
		case "fraction": {
			const start = scope.from <= 0 ? 0 : snapEdge(board, runtime * scope.from, Math.min(1.5, runtime * 0.08));
			const end = scope.to >= 1 ? runtime : snapEdge(board, runtime * scope.to, Math.min(1.5, runtime * 0.08));
			return spanOf(board, start, end, `${scope.words.replace(/^(in|on|for|of|during|over|across|to)\s+/i, "")} (${r2(start)}–${r2(end)} s)`, true);
		}
		case "seconds": {
			const start = scope.from ?? 0;
			const end = scope.to ?? runtime;
			return spanOf(board, start, end, `${r2(start)}–${r2(end)} s`, false);
		}
		case "head":
			return spanOf(board, 0, scope.seconds, `the first ${scope.seconds} s`, false);
		case "tail":
			return spanOf(board, runtime - scope.seconds, runtime, `the last ${scope.seconds} s (${r2(runtime - scope.seconds)}–${r2(runtime)} s)`, false);
		case "time": {
			const row = rowAt(board, scope.t);
			if (!row) return `${scope.t} s is outside the timeline (it runs ${runtime} s)`;
			return spanOf(board, row.start, row.end, `beat ${row.row} at ${scope.t} s (${row.range})`, false);
		}
		case "edge": {
			const row = scope.edge === "end" ? board.rows[board.rows.length - 1] : board.rows[0];
			if (!row) return "the timeline is empty";
			if (scope.relation === "after") return spanOf(board, row.end, runtime, `after ${scope.edge === "end" ? "the last" : "the first"} beat (${r2(row.end)}–${r2(runtime)} s)`, false);
			if (scope.relation === "before") return spanOf(board, 0, row.start, `before ${scope.edge === "end" ? "the last" : "the first"} beat (0–${r2(row.start)} s)`, false);
			return spanOf(board, row.start, row.end, `${scope.edge === "end" ? "the last" : "the first"} beat, ${row.row} (${row.range})`, false);
		}
		case "this": {
			if (address.element) return spanOf(board, address.element.start, address.element.end, `element ${address.element.id} (${r2(address.element.start)}–${r2(address.element.end)} s)`, false);
			if (address.beat !== undefined) return resolveSpan({ kind: "beat", beat: address.beat, words: scope.words }, board);
			if (address.t !== undefined) return resolveSpan({ kind: "time", t: address.t, words: scope.words }, board);
			return `"${scope.words}": which one? Send t (seconds), beat (storyboard get) or element_id with the call, or say "from 24 s" / "beat 5" / "the second half"`;
		}
	}
}
