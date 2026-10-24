/**
 * Caption words on a timeline: what a revision may never lose (revise-safety agent, 2026-10-21; warm-moody-oat REPORT
 * §"Where Sonnet got stuck" items 3 and 4). Pure: snapshots in, words / plans / reports out.
 *
 *   captionWords(snapshot)        every caption word on screen, in order (the base caption layer: one element per
 *                                 chunk; its shown text, timed by the captions tool's word tags when they agree)
 *   planWordFix(old, newText)     "change the beat 3 caption to 'and Claude uses'" → the WORD fixes that text asks for
 *                                 (Cloud → Claude), aligned inside the beat's words — never a rewrite of the whole beat
 *                                 that deletes the words the new text did not repeat (the oat run lost 15 words that way)
 *   wordGuard(before, after, …)   words before vs after a change: the caption words that disappeared without a reason
 *                                 (not fixed on purpose, not cut out of the footage, not deleted on request)
 *   survivesCut(before, after)    a before-word whose source moment the cut timeline no longer plays (autocut) is
 *                                 explained, not lost
 *   measureCaptionSpans(snapshot) caption sizes and fonts by span (a span = consecutive chunks in one font and style):
 *                                 the read-out a Claude needs to see a mix (the oat run ended with sizes 4, 12 and 17)
 */
import { getCaptionStyle, resolveCaptionLook, type CaptionLook, type TimedWord } from "@restorffcut/timeline-ops";
import type { ProjectSnapshot, SnapshotElement, SnapshotTrack } from "@/sync/snapshot";
import { activeScene, clipWindow, findCaptionTracks, rateOf, spokenClips } from "./transcripts-timeline";

const T = 120_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** A word compared for a fix or a count: lower case, letters / digits / apostrophes only (transcripts.ts editKey). */
export const wordKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

export interface CaptionWord extends TimedWord {
	/** The base-layer element (caption chunk) that shows it. */
	chunk_id: string;
}

type Tagged = { restorff?: { captionLayer?: string; role?: string; caption?: { style?: string; words?: TimedWord[]; look?: CaptionLook; shrunk?: boolean } } };

/** The caption chunks' track: the captions tool's base layer, else the first text track that holds captions. */
export function baseCaptionTrack(snapshot: ProjectSnapshot): SnapshotTrack | null {
	const tracks = findCaptionTracks(snapshot);
	const tagged = tracks.find((track) => (track as Tagged).restorff?.captionLayer === "base");
	if (tagged) return tagged;
	const named = tracks.find((track) => !(track as Tagged).restorff?.captionLayer && /^CAPTIONS?( \d+)?$/i.test(String(track.name ?? "")));
	if (named) return named;
	const overlay = activeScene(snapshot)?.tracks?.overlay ?? [];
	return (
		overlay.find((track) => track.type === "text" && ((track as Tagged).restorff?.role === "caption" || (track.elements ?? []).some((element) => (element as Tagged).restorff?.role === "caption"))) ?? null
	);
}

const contentOf = (element: SnapshotElement) => String((element.params as Record<string, unknown> | undefined)?.content ?? "");

/** The words one chunk shows, in timeline seconds: its tag's words when they spell its text, else its text by letters. */
export function chunkWordsOf(element: SnapshotElement): CaptionWord[] {
	const start = element.startTime / T;
	const end = (element.startTime + element.duration) / T;
	const tokens = contentOf(element).trim().split(/\s+/).filter(Boolean);
	const tag = (element as Tagged).restorff?.caption;
	if (tag?.words?.length && tag.words.length === tokens.length && tag.words.every((word, i) => wordKey(word.text) === wordKey(tokens[i] ?? ""))) {
		return tag.words.map((word, i) => ({ text: tokens[i] ?? word.text, start: r3(start + word.start), end: r3(start + word.end), chunk_id: element.id }));
	}
	const letters = tokens.reduce((sum, token) => sum + token.length + 1, 0) || 1;
	let cursor = start;
	return tokens.map((token) => {
		const span = ((end - start) * (token.length + 1)) / letters;
		const word = { text: token, start: r3(cursor), end: r3(cursor + span), chunk_id: element.id };
		cursor += span;
		return word;
	});
}

/** Every caption word on screen, in time order (hidden chunks too: a key-word carrier holds its line's words). */
export function captionWords(snapshot: ProjectSnapshot): CaptionWord[] {
	const base = baseCaptionTrack(snapshot);
	if (!base) return [];
	return [...(base.elements ?? [])]
		.filter((element) => element.type === "text")
		.sort((a, b) => a.startTime - b.startTime)
		.flatMap((element) => chunkWordsOf(element));
}

// ─── a caption text change → word fixes ─────────────────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		prev = row;
	}
	return prev[b.length];
}

/** Two words that are one mis-heard for the other ("cloud" / "claude", "hyper" / "hyperframes"). */
export function similarWords(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
	return 1 - levenshtein(a, b) / Math.max(a.length, b.length) >= 0.5;
}

export interface WordFix {
	/** The caption words as they are (one or more). */
	from: string;
	/** What they should say ("" removes them). */
	to: string;
	/** Timeline seconds of the first word (pins the fix to that occurrence). */
	t: number;
	t_end: number;
	chunk_ids: string[];
}

export type WordFixPlan =
	/** The new text repeats the old words except a few: these fixes, nothing else changes. */
	| { kind: "fix"; fixes: WordFix[]; window: { from: number; to: number; words: number }; dropped: Array<{ text: string; t: number }>; kept_outside: number }
	/** The new text says the same words. */
	| { kind: "same" }
	/** A new line at least as long as the old one, with little in common: a rewrite that loses no word. */
	| { kind: "rewrite" }
	/** A shorter line with little in common: it would delete these words. */
	| { kind: "loss"; would_delete: Array<{ text: string; t: number }>; old_line: string; t: number };

type Step = { kind: "match" | "sub" | "del" | "ins"; o?: number; n?: number; /** part of a merge / split ("hyper frames" ↔ "HyperFrames") */ joined?: boolean };

/**
 * Align the new text inside the old words (semi-global: old words before and after the aligned window are free and
 * stay as they are). Scores: same word +2, a similar word +1, another word −1, an old word left out −1.5, a new word
 * added −1. A "fix" needs at least one same word and same + similar ≥ half the new words (one similar word for a
 * one-word text), and at most 3 old words left out inside the window.
 */
export function planWordFix(old: readonly CaptionWord[], newText: string): WordFixPlan {
	const tokens = newText.trim().split(/\s+/).filter((token) => wordKey(token));
	const N = tokens.map(wordKey);
	const O = old.map((word) => wordKey(word.text));
	const m = N.length;
	const n = O.length;
	if (!m) return n ? { kind: "loss", would_delete: old.map((w) => ({ text: w.text, t: r2(w.start) })), old_line: old.map((w) => w.text).join(" "), t: r2(old[0]?.start ?? 0) } : { kind: "same" };
	if (!n) return { kind: "rewrite" };
	const score = (a: string, b: string) => (a === b ? 2 : similarWords(a, b) ? 1 : -1);
	// dp[i][j]: N[0..i) aligned, ending at O[j)
	type Move = "diag" | "left" | "up" | "start" | "merge" | "split";
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	const from: Move[][] = Array.from({ length: m + 1 }, () => new Array<Move>(n + 1).fill("start"));
	for (let i = 1; i <= m; i++) {
		dp[i][0] = -i;
		from[i][0] = "up";
	}
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const diag = dp[i - 1][j - 1] + score(N[i - 1] as string, O[j - 1] as string);
			const left = dp[i][j - 1] - 1.5;
			const up = dp[i - 1][j] - 1;
			if (diag >= left && diag >= up) {
				dp[i][j] = diag;
				from[i][j] = "diag";
			} else if (left >= up) {
				dp[i][j] = left;
				from[i][j] = "left";
			} else {
				dp[i][j] = up;
				from[i][j] = "up";
			}
			// two old words written as one ("hyper frames" → "HyperFrames"), or one old word as two
			if (j >= 2 && N[i - 1] === `${O[j - 2]}${O[j - 1]}` && dp[i - 1][j - 2] + 2.5 > dp[i][j]) {
				dp[i][j] = dp[i - 1][j - 2] + 2.5;
				from[i][j] = "merge";
			}
			if (i >= 2 && O[j - 1] === `${N[i - 2]}${N[i - 1]}` && dp[i - 2][j - 1] + 2.5 > dp[i][j]) {
				dp[i][j] = dp[i - 2][j - 1] + 2.5;
				from[i][j] = "split";
			}
		}
	}
	let endJ = 0;
	for (let j = 0; j <= n; j++) if (dp[m][j] > dp[m][endJ]) endJ = j;
	const steps: Step[] = [];
	let i = m;
	let j = endJ;
	while (i > 0) {
		const move = from[i][j];
		if (move === "diag") {
			steps.unshift({ kind: N[i - 1] === O[j - 1] ? "match" : "sub", o: j - 1, n: i - 1 });
			i--;
			j--;
		} else if (move === "merge") {
			steps.unshift({ kind: "sub", o: j - 2, n: i - 1, joined: true }, { kind: "del", o: j - 1, joined: true });
			i--;
			j -= 2;
		} else if (move === "split") {
			steps.unshift({ kind: "sub", o: j - 1, n: i - 2, joined: true }, { kind: "ins", n: i - 1, joined: true });
			i -= 2;
			j--;
		} else if (move === "left") {
			steps.unshift({ kind: "del", o: j - 1 });
			j--;
		} else {
			steps.unshift({ kind: "ins", n: i - 1 });
			i--;
		}
	}
	const same = steps.filter((step) => step.kind === "match" || (step.kind === "sub" && step.joined)).length;
	const similar = steps.filter((step) => step.kind === "sub" && !step.joined && similarWords(N[step.n as number] as string, O[step.o as number] as string)).length;
	const dels = steps.filter((step) => step.kind === "del" && !step.joined);
	const accepted = m === 1 ? same + similar >= 1 : same >= 1 && same + similar >= Math.ceil(m / 2);
	if (!accepted || dels.length > 3) {
		if (m >= n) return { kind: "rewrite" };
		const kept = new Set(steps.filter((step) => step.kind === "match").map((step) => step.o));
		return {
			kind: "loss",
			would_delete: old.filter((_, k) => !kept.has(k)).map((word) => ({ text: word.text, t: r2(word.start) })),
			old_line: old.map((word) => word.text).join(" "),
			t: r2(old[0]?.start ?? 0),
		};
	}
	if (same === m && !dels.length && steps.every((step) => step.kind === "match")) return { kind: "same" };
	// only words added (every old word kept): nothing can be lost — the caller's in-place rewrite does it
	if (steps.every((step) => step.kind === "match" || step.kind === "ins")) return { kind: "rewrite" };
	// runs of non-matching steps → one fix each; an insert-only run is anchored on its neighbour word
	const fixes: WordFix[] = [];
	const dropped: Array<{ text: string; t: number }> = [];
	let k = 0;
	while (k < steps.length) {
		if (steps[k]?.kind === "match") {
			k++;
			continue;
		}
		const run: Step[] = [];
		while (k < steps.length && steps[k]?.kind !== "match") run.push(steps[k++] as Step);
		let olds = run.filter((step) => step.o !== undefined).map((step) => step.o as number);
		let news = run.filter((step) => step.n !== undefined).map((step) => step.n as number);
		if (!olds.length) {
			// only new words: anchor on the matched word before (or after) them
			const before = steps.slice(0, k - run.length).reverse().find((step) => step.kind === "match");
			const after = steps.slice(k).find((step) => step.kind === "match");
			const anchor = before ?? after;
			if (!anchor || anchor.o === undefined || anchor.n === undefined) continue;
			olds = [anchor.o];
			news = before ? [anchor.n, ...news] : [...news, anchor.n];
		}
		const oldWords = olds.map((o) => old[o] as CaptionWord);
		const fromText = oldWords.map((word) => word.text).join(" ");
		const toText = news.map((nIndex) => tokens[nIndex] as string).join(" ");
		if (!news.length) for (const word of oldWords) dropped.push({ text: word.text, t: r2(word.start) });
		fixes.push({ from: fromText, to: toText, t: r3(oldWords[0]?.start ?? 0), t_end: r3(oldWords[oldWords.length - 1]?.end ?? 0), chunk_ids: [...new Set(oldWords.map((word) => word.chunk_id))] });
	}
	const os = steps.filter((step) => step.o !== undefined).map((step) => step.o as number);
	const lo = Math.min(...os);
	const hi = Math.max(...os);
	if (!fixes.length) return { kind: "same" };
	return { kind: "fix", fixes, window: { from: r2(old[lo]?.start ?? 0), to: r2(old[hi]?.end ?? 0), words: hi - lo + 1 }, dropped, kept_outside: n - (hi - lo + 1) };
}

/** Apply word fixes to a word list (by key, one occurrence near `t` when given, else every one). Pure. */
export function simulateFixes<W extends TimedWord>(words: readonly W[], fixes: ReadonlyArray<{ from: string; to: string; t?: number }>): W[] {
	let out = [...words];
	for (const fix of fixes) {
		const from = fix.from.trim().split(/\s+/).map(wordKey).filter(Boolean);
		const to = fix.to.trim().split(/\s+/).filter((token) => wordKey(token));
		if (!from.length) continue;
		const hits: number[] = [];
		for (let i = 0; i + from.length <= out.length; i++) if (from.every((key, k) => wordKey(out[i + k]?.text ?? "") === key)) hits.push(i);
		let chosen = hits;
		if (fix.t !== undefined && hits.length) {
			const t = fix.t;
			const nearest = hits.reduce((best, i) => (Math.abs((out[i] as W).start - t) < Math.abs((out[best] as W).start - t) ? i : best), hits[0] as number);
			chosen = Math.abs((out[nearest] as W).start - t) <= 2.5 ? [nearest] : [];
		}
		for (const i of [...chosen].sort((a, b) => b - a)) {
			const first = out[i] as W;
			const replacement = to.map((text) => ({ ...first, text }));
			out = [...out.slice(0, i), ...replacement, ...out.slice(i + from.length)];
		}
	}
	return out;
}

// ─── the guard ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Is the source moment under timeline second `t` of `before` still played by `after` (same media)? */
export function survivesCut(before: ProjectSnapshot, after: ProjectSnapshot): (t: number) => boolean {
	const beforeClips = spokenClips(before);
	const afterClips = spokenClips(after);
	return (t: number) => {
		const clip = beforeClips.find(({ element }) => element.startTime / T <= t && t < (element.startTime + element.duration) / T);
		if (!clip) return true; // no footage under it (a voice-over line, a title): a cut can't explain its loss
		const w = clipWindow(clip.element);
		const source = w.in + (t - w.start) * rateOf(clip.element);
		return afterClips.some(({ element }) => {
			if (element.mediaId !== clip.element.mediaId) return false;
			const a = clipWindow(element);
			return source >= a.in - 0.02 && source < a.out + 0.02;
		});
	};
}

export interface WordGuard {
	/** Caption words on screen before and after. */
	before: number;
	after: number;
	/** Before-words whose footage the change cut out (autocut, a removed beat): gone on purpose. */
	cut: number;
	/** Words the change was asked to change or remove (word fixes, a deleted caption). */
	fixed: number;
	/** Caption words that disappeared without a reason. */
	lost: Array<{ text: string; t: number }>;
	ok: boolean;
}

/**
 * Words before vs after: the before-words (after the asked fixes, without the asked deletions and the cut-out
 * footage) that the after-words do not keep, in order (longest common subsequence, by word key).
 */
export function wordGuard({
	before,
	after,
	fixes = [],
	exclude = [],
	survives,
	tolerance = 0,
}: {
	before: readonly CaptionWord[];
	after: readonly CaptionWord[];
	/** Fixes this change makes on purpose (from → to; t pins one occurrence). */
	fixes?: ReadonlyArray<{ from: string; to: string; t?: number }>;
	/** Chunks deleted on request: their words are not counted. */
	exclude?: readonly string[];
	/** Cut-aware: false = the word's footage was cut out. */
	survives?: (t: number) => boolean;
	/** Lost words allowed before `ok` turns false. */
	tolerance?: number;
}): WordGuard {
	const excluded = new Set(exclude);
	let fixed = 0;
	const asked = before.filter((word) => {
		if (!excluded.has(word.chunk_id)) return true;
		fixed++;
		return false;
	});
	let cut = 0;
	const kept = survives
		? asked.filter((word) => {
				if (survives((word.start + word.end) / 2)) return true;
				cut++;
				return false;
			})
		: [...asked];
	const expected = simulateFixes(kept, fixes);
	fixed += Math.max(0, kept.length - expected.length);
	const a = expected.map((word) => wordKey(word.text)).filter(Boolean);
	const aw = expected.filter((word) => wordKey(word.text));
	const b = after.map((word) => wordKey(word.text)).filter(Boolean);
	// LCS by rows (Uint16 is enough below 65k words)
	const rows = a.length;
	const cols = b.length;
	const table: Uint16Array[] = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
	for (let i = rows - 1; i >= 0; i--) {
		for (let j = cols - 1; j >= 0; j--) {
			table[i][j] = a[i] === b[j] ? (table[i + 1][j + 1] as number) + 1 : Math.max(table[i + 1][j] as number, table[i][j + 1] as number);
		}
	}
	const lost: Array<{ text: string; t: number }> = [];
	let i = 0;
	let j = 0;
	while (i < rows) {
		if (j < cols && a[i] === b[j]) {
			i++;
			j++;
		} else if (j < cols && (table[i][j + 1] as number) >= (table[i + 1][j] as number)) {
			j++;
		} else {
			const word = aw[i] as CaptionWord;
			lost.push({ text: word.text, t: r2(word.start) });
			i++;
		}
	}
	return { before: before.length, after: after.length, cut, fixed, lost, ok: lost.length <= tolerance };
}

/** The guard between two snapshots (words read from their caption layers). */
export function guardSnapshots(
	before: ProjectSnapshot,
	after: ProjectSnapshot,
	opts: { fixes?: ReadonlyArray<{ from: string; to: string; t?: number }>; exclude?: readonly string[]; cutAware?: boolean; tolerance?: number } = {},
): WordGuard {
	return wordGuard({
		before: captionWords(before),
		after: captionWords(after),
		fixes: opts.fixes,
		exclude: opts.exclude,
		survives: opts.cutAware ? survivesCut(before, after) : undefined,
		tolerance: opts.tolerance,
	});
}

/** The guard as an answer field (lost words listed up to 20). */
export function guardView(guard: WordGuard) {
	return {
		before: guard.before,
		after: guard.after,
		...(guard.cut ? { cut_with_footage: guard.cut } : {}),
		...(guard.fixed ? { fixed_on_purpose: guard.fixed } : {}),
		lost: guard.lost.length,
		...(guard.lost.length ? { lost_words: guard.lost.slice(0, 20) } : {}),
	};
}

// ─── sizes and fonts by span ────────────────────────────────────────────────────────────────────────────────────

export interface CaptionSpan {
	from: number;
	to: number;
	chunks: number;
	font: string;
	style: string | null;
	/** Size (editor units, as stored) → chunks. */
	sizes: Record<string, number>;
	/** The span's size: the one most chunks have. */
	size: number;
	/** More than one size among chunks that could have the span's size (one word wider than the safe area does not count). */
	mixed: boolean;
	/** Chunks off the span's size, with why when it can be told. */
	odd: Array<{ t: number; text: string; size: number; why: string }>;
	/** One-word chunks wider than the safe area at the span's size: drawn smaller (nothing to split). */
	fit_exceptions?: number;
	/** The size every chunk of the span fits at (when there are fit exceptions): unify {size} with it makes them all equal. */
	fits_all_at?: number;
}

export interface CaptionSpanReport {
	chunks: number;
	spans: CaptionSpan[];
	mixed_spans: number;
	fonts: Record<string, number>;
	sizes: Record<string, number>;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Sizes and fonts of the caption chunks (base layer), by span: consecutive chunks in one font and one caption style. */
export function measureCaptionSpans(snapshot: ProjectSnapshot): CaptionSpanReport {
	const base = baseCaptionTrack(snapshot);
	const elements = [...(base?.elements ?? [])].filter((element) => element.type === "text" && contentOf(element).trim()).sort((a, b) => a.startTime - b.startTime);
	const spans: CaptionSpan[] = [];
	const fonts: Record<string, number> = {};
	const sizes: Record<string, number> = {};
	let current: { span: CaptionSpan; members: SnapshotElement[] } | null = null;
	const close = () => {
		if (!current) return;
		const { span, members } = current;
		const ranked = Object.entries(span.sizes).sort((x, y) => y[1] - x[1] || Number(y[0]) - Number(x[0]));
		span.size = Number(ranked[0]?.[0] ?? 0);
		const sizesSeen = new Set<number>();
		let exceptions = 0;
		let fitsAll = span.size;
		for (const element of members) {
			const size = num((element.params as Record<string, unknown>)?.fontSize) ?? 0;
			if (size === span.size) {
				sizesSeen.add(size);
				continue;
			}
			const tag = (element as Tagged).restorff?.caption;
			let why = "differs from the span's size";
			let exception = false;
			if (tag) {
				const designed = resolveCaptionLook(getCaptionStyle(tag.style), tag.look).base.size ?? size;
				const oneWord = contentOf(element).trim().split(/\s+/).length === 1;
				if ((tag.shrunk || size < designed - 0.5) && oneWord && designed >= span.size - 0.5) {
					why = `one word wider than the safe area at ${r2(designed)}: drawn at ${size}`;
					exception = true;
				} else if (tag.shrunk || size < designed - 0.5) why = `shrunk to fit the safe area (its look asks ${r2(designed)})`;
				else if (!tag.look || (tag.look.size === undefined && tag.look.scale === undefined)) why = "no size in its look (the style's default): words that lost their chunk, or built before a restyle";
				else why = `its look asks ${r2(designed)} (a restyle that reached only some chunks)`;
			} else why = "not built by the captions tool (no look): set by hand or by a set op";
			if (exception) {
				exceptions++;
				fitsAll = Math.min(fitsAll, size);
			} else sizesSeen.add(size);
			if (span.odd.length < 12) span.odd.push({ t: r2(element.startTime / T), text: contentOf(element).slice(0, 40), size, why });
		}
		sizesSeen.add(span.size);
		span.mixed = sizesSeen.size > 1;
		if (exceptions) {
			span.fit_exceptions = exceptions;
			span.fits_all_at = fitsAll;
		}
		spans.push(span);
		current = null;
	};
	for (const element of elements) {
		const params = (element.params ?? {}) as Record<string, unknown>;
		const font = String(params.fontFamily ?? "?");
		const size = Math.round((num(params.fontSize) ?? 0) * 100) / 100;
		const style = (element as Tagged).restorff?.caption?.style ?? null;
		fonts[font] = (fonts[font] ?? 0) + 1;
		sizes[String(size)] = (sizes[String(size)] ?? 0) + 1;
		const start = element.startTime / T;
		const end = (element.startTime + element.duration) / T;
		if (!current || current.span.font !== font || current.span.style !== style) {
			close();
			current = { span: { from: r2(start), to: r2(end), chunks: 0, font, style, sizes: {}, size: 0, mixed: false, odd: [] }, members: [] };
		}
		current.span.to = r2(end);
		current.span.chunks++;
		current.span.sizes[String(size)] = (current.span.sizes[String(size)] ?? 0) + 1;
		current.members.push(element);
	}
	close();
	return { chunks: elements.length, spans, mixed_spans: spans.filter((span) => span.mixed).length, fonts, sizes };
}

/** The short form for answers: how many spans, and the mixed ones in full. */
export function spansView(report: CaptionSpanReport) {
	return {
		chunks: report.chunks,
		spans: report.spans.length,
		fonts: report.fonts,
		sizes: report.sizes,
		mixed_spans: report.mixed_spans,
		...(report.mixed_spans
			? {
					mixed: report.spans.filter((span) => span.mixed).map((span) => ({ from: span.from, to: span.to, font: span.font, style: span.style, sizes: span.sizes, size: span.size, odd: span.odd.slice(0, 5) })),
					unify: "captions {action: \"unify\"} gives every mixed span its most common size (or pass size)",
				}
			: {}),
		...(report.spans.some((span) => span.fit_exceptions)
			? {
					fit_exceptions: report.spans
						.filter((span) => span.fit_exceptions)
						.map((span) => ({ from: span.from, to: span.to, size: span.size, words_drawn_smaller: span.fit_exceptions, fits_all_at: span.fits_all_at, words: span.odd.filter((odd) => odd.why.startsWith("one word")).slice(0, 5).map((odd) => `${odd.text} @ ${odd.t} s (${odd.size})`) })),
					fit_exceptions_note: "one word wider than the safe area at the span's size is drawn smaller (nothing to split); captions {action: \"unify\", size: fits_all_at} makes every chunk of the span the same",
				}
			: {}),
	};
}
