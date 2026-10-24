/**
 * Talking-head auto-cut — the seed of the compiler (EDT-03).
 *
 * Input: word timings of ONE A-roll clip (seconds in the media file, e.g. from a transcriber), and where that clip
 * sits on the timeline. Output: ops@1 that (1) remove silences longer than `silence` (default 0.35 s), (2) remove the
 * earlier take(s) of a repeated sentence, keeping the last, and (3) add 1-3-word captions on the cut timeline.
 *
 * The cut ops are emitted from the END of the clip backwards, so every cut position is still the clip's original
 * position when it is applied, and the clip's id always names the left-most piece. Times are emitted as
 * ticks / 120000, so they convert back to the exact tick the compiler computed.
 */
import type { Author } from "../model.ts";
import type { Op, TextStyle, TimedWord } from "../ops.ts";
import { secondsToTicks, TICKS_PER_SECOND } from "../time.ts";

export interface TalkingHeadClip {
	/** Element id (or ref) of the A-roll clip. */
	el: string;
	/** Timeline start, seconds. */
	start: number;
	/** Source in / out of the clip, seconds. */
	in: number;
	out: number;
}

export interface CutOptions {
	clip: TalkingHeadClip;
	/** Pauses longer than this are cut (seconds). Default 0.35. */
	silence?: number;
	/** Breathing room kept before the first and after the last word of each kept stretch (seconds). Default 0.05. */
	pad?: number;
	/** Look this many sentences ahead for a retake. Default 3. */
	retakeWindow?: number;
	/** A pause this long also ends a sentence when the transcript has no punctuation (seconds). Default 0.8. */
	sentencePause?: number;
	captions?: boolean | { style?: TextStyle; maxWords?: number; track?: string };
	author?: Author;
	/** Prefix for the refs the ops define (must be unique per batch). Default "th". */
	refPrefix?: string;
	/**
	 * Indexes into `candidates` (the regions found with the same options and no `keep`) that a person unticked: those
	 * stretches stay in the edit, and any words inside them (a retake kept on purpose) stay in the captions.
	 */
	keep?: readonly number[];
	/**
	 * captions-v2, 2026-10-20: also find retakes on the words themselves, ignoring case, punctuation and sentence breaks —
	 * a run of ≥ 3 words said again straight away (after at most 3 filler words). Whisper punctuates two takes of one
	 * sentence differently ("…this entire video. I'm not editing anything just so you know this entire video I'm not
	 * editing anything."), so the sentence matcher alone misses them (warm-moody REPORT §5 item 5). Default true.
	 */
	repeats?: boolean;
	/**
	 * captions-v2, 2026-10-20: cut the tail with split + ripple_delete instead of `trim`, so a clip followed by another
	 * on the same track leaves no gap (warm-moody: 7 gaps, 1.55 s of black). Default false (the editor's own cut keeps
	 * `trim`); the MCP autocut passes true.
	 */
	rippleTail?: boolean;
}

export interface RemovedRegion {
	/** Source seconds. */
	start: number;
	end: number;
	reason: "silence" | "retake" | "head" | "tail";
	detail?: string;
}

/** A region the compiler would remove, with its stable index (for `keep`) and whether this plan removes it. */
export interface CutCandidate extends RemovedRegion {
	index: number;
	applied: boolean;
	/** Timeline seconds where the region sits before any cut (for previews: "seek here"). */
	at: number;
}

export interface CutPlan {
	ops: Op[];
	/** Kept stretches of the source, seconds, in order. */
	kept: Array<{ start: number; end: number }>;
	/** The regions this plan removes (candidates minus `keep`). */
	removed: RemovedRegion[];
	/** Every region found, in source order, kept-back ones included (`applied: false`). */
	candidates: CutCandidate[];
	/** Kept words with their new timeline times. */
	words: TimedWord[];
	/** Sentences dropped as retakes, with the sentence that replaced them. */
	retakes: Array<{ dropped: string; keptAs: string }>;
	stats: { sourceSeconds: number; keptSeconds: number; removedSeconds: number };
}

const SENTENCE_END = /[.!?]$/;

function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

interface Sentence {
	words: number[];
	text: string;
	norm: string;
}

function sentences(words: readonly TimedWord[], pause: number): Sentence[] {
	const result: Sentence[] = [];
	let current: number[] = [];
	const flush = () => {
		if (!current.length) return;
		const text = current.map((i) => words[i].text.trim()).join(" ");
		result.push({ words: current, text, norm: normalize(text) });
		current = [];
	};
	words.forEach((word, i) => {
		const previous = words[i - 1];
		if (current.length && previous && word.start - previous.end > pause) flush();
		current.push(i);
		if (SENTENCE_END.test(word.text.trim())) flush();
	});
	flush();
	return result;
}

/** An earlier sentence is a retake when a later one (within the window) says the same, or starts with it. */
function findRetakes(list: Sentence[], window: number): Map<number, number> {
	const dropped = new Map<number, number>();
	for (let i = 0; i < list.length; i++) {
		if (!list[i].norm) continue;
		for (let j = i + 1; j <= Math.min(list.length - 1, i + window); j++) {
			const same = list[j].norm === list[i].norm;
			const aborted = list[i].words.length >= 2 && list[j].norm.startsWith(`${list[i].norm} `);
			if (same || aborted) {
				dropped.set(i, j);
				break;
			}
		}
	}
	return dropped;
}

/**
 * Retakes found on the words (captions-v2): a run of `minWords`+ words followed, after at most `maxGap` filler words,
 * by the same run (each word compared lower-case without punctuation). The earlier run and the filler are dropped; the
 * last take stays. A run shorter than 5 words must start a phrase (the clip's first word, a word after . ! ? , ; : or
 * after a pause of 0.3 s or more), so "again and again and again" style speech is left alone.
 */
function findRepeats(
	words: readonly TimedWord[],
	taken: ReadonlySet<number>,
	opts: { minWords?: number; maxGap?: number; maxRun?: number } = {},
): Array<{ from: number; to: number; length: number }> {
	const minWords = opts.minWords ?? 3;
	const maxGap = opts.maxGap ?? 3;
	const maxRun = opts.maxRun ?? 40;
	const tokens = words.map((word) => normalize(word.text));
	const n = tokens.length;
	const phraseStart = (i: number) => {
		if (i === 0) return true;
		const previous = words[i - 1];
		return /[.!?,;:]$/.test(previous.text.trim()) || words[i].start - previous.end >= 0.3;
	};
	const found: Array<{ from: number; to: number; length: number }> = [];
	let i = 0;
	while (i < n) {
		let hit: { from: number; to: number; length: number } | null = null;
		for (let length = Math.min(maxRun, Math.floor((n - i) / 2)); length >= minWords && !hit; length--) {
			for (let gap = 0; gap <= maxGap && !hit; gap++) {
				const j = i + length + gap;
				if (j + length > n) break;
				let same = true;
				for (let k = 0; k < length; k++) {
					if (!tokens[i + k] || tokens[i + k] !== tokens[j + k] || taken.has(i + k) || taken.has(j + k)) {
						same = false;
						break;
					}
				}
				if (!same) continue;
				if (length < 5 && !phraseStart(i)) continue;
				// filler between the takes must not itself be a dropped sentence's word (the sentence matcher's)
				let fillerFree = true;
				for (let k = i + length; k < j; k++) if (taken.has(k)) fillerFree = false;
				if (fillerFree) hit = { from: i, to: j, length };
			}
		}
		if (hit) {
			found.push(hit);
			i = hit.to;
		} else {
			i++;
		}
	}
	return found;
}

const toSeconds = (ticks: number) => ticks / TICKS_PER_SECOND;

export function cutFromTranscript(words: readonly TimedWord[], options: CutOptions): CutPlan {
	const author = options.author ?? "compiler";
	const prefix = options.refPrefix ?? "th";
	const clip = options.clip;
	const silence = secondsToTicks(options.silence ?? 0.35);
	const pad = secondsToTicks(options.pad ?? 0.05);
	const clipIn = secondsToTicks(clip.in);
	const clipOut = secondsToTicks(clip.out);
	const clipStart = secondsToTicks(clip.start);

	const ordered = words
		.filter((word) => word.text.trim() && word.end > word.start && word.end > clip.in && word.start < clip.out)
		.slice()
		.sort((a, b) => a.start - b.start);
	const list = sentences(ordered, options.sentencePause ?? 0.8);
	const retakeOf = findRetakes(list, options.retakeWindow ?? 3);
	const droppedWord = new Set<number>();
	const retakes: CutPlan["retakes"] = [];
	for (const [i, j] of retakeOf) {
		for (const index of list[i].words) droppedWord.add(index);
		retakes.push({ dropped: list[i].text, keptAs: list[j].text });
	}
	if (options.repeats !== false && (options.retakeWindow ?? 3) > 0) {
		for (const repeat of findRepeats(ordered, droppedWord)) {
			for (let index = repeat.from; index < repeat.to; index++) droppedWord.add(index);
			const text = (from: number, to: number) => ordered.slice(from, to).map((word) => word.text.trim()).join(" ");
			retakes.push({ dropped: text(repeat.from, repeat.to), keptAs: text(repeat.to, repeat.to + repeat.length) });
		}
	}

	// Kept stretches in ticks: consecutive kept words join when the pause between them is short enough and no
	// dropped sentence sits between them.
	const stretches: Array<{ start: number; end: number; words: number[] }> = [];
	let previousKept = -1;
	ordered.forEach((word, index) => {
		if (droppedWord.has(index)) return;
		const start = secondsToTicks(word.start);
		const end = secondsToTicks(word.end);
		const last = stretches[stretches.length - 1];
		const contiguous = previousKept === index - 1 && last && start - last.end <= silence;
		if (contiguous) {
			last.end = Math.max(last.end, end);
			last.words.push(index);
		} else {
			stretches.push({ start, end, words: [index] });
		}
		previousKept = index;
	});

	// Pad each stretch, without crossing the clip or the neighbouring stretch's midpoint.
	const kept = stretches.map((stretch, i) => {
		const before = stretches[i - 1];
		const after = stretches[i + 1];
		let lowest = before ? Math.ceil((before.end + stretch.start) / 2) : clipIn;
		let highest = after ? Math.floor((stretch.end + after.start) / 2) : clipOut;
		// never pad into a dropped take that touches the stretch (a retake said with no pause before it)
		const first = stretch.words[0];
		const last = stretch.words[stretch.words.length - 1];
		if (droppedWord.has(first - 1)) lowest = Math.max(lowest, Math.min(stretch.start, secondsToTicks(ordered[first - 1].end)));
		if (droppedWord.has(last + 1)) highest = Math.min(highest, Math.max(stretch.end, secondsToTicks(ordered[last + 1].start)));
		return {
			start: Math.max(lowest, clipIn, stretch.start - pad),
			end: Math.min(highest, clipOut, stretch.end + pad),
			words: stretch.words,
		};
	});

	// Regions to remove, in source ticks.
	const found: Array<{ start: number; end: number; reason: RemovedRegion["reason"]; detail?: string }> = [];
	let cursor = clipIn;
	kept.forEach((stretch, i) => {
		if (stretch.start > cursor) {
			const between = ordered.filter((word, index) => droppedWord.has(index) &&
				secondsToTicks(word.start) >= cursor && secondsToTicks(word.end) <= stretch.start);
			found.push({
				start: cursor,
				end: stretch.start,
				reason: i === 0 ? "head" : between.length ? "retake" : "silence",
				detail: between.length ? between.map((word) => word.text).join(" ") : undefined,
			});
		}
		cursor = stretch.end;
	});
	if (cursor < clipOut) found.push({ start: cursor, end: clipOut, reason: "tail" });

	// A person may untick regions: those stay. Kept stretches become the complement of what is still removed, and the
	// kept words are the ones not dropped plus any word whose middle sits in a region kept back.
	const keepBack = new Set(options.keep ?? []);
	const removed = found.filter((_, index) => !keepBack.has(index));
	if (keepBack.size) {
		const keptBackRegions = found.filter((_, index) => keepBack.has(index));
		const inKeptBack = (index: number) => {
			const middle = secondsToTicks((ordered[index].start + ordered[index].end) / 2);
			return keptBackRegions.some((region) => middle >= region.start && middle <= region.end);
		};
		const complement: Array<{ start: number; end: number; words: number[] }> = [];
		let from = clipIn;
		for (const region of removed) {
			if (region.start > from) complement.push({ start: from, end: region.start, words: [] });
			from = Math.max(from, region.end);
		}
		if (from < clipOut) complement.push({ start: from, end: clipOut, words: [] });
		ordered.forEach((word, index) => {
			if (droppedWord.has(index) && !inKeptBack(index)) return;
			const middle = secondsToTicks((word.start + word.end) / 2);
			const home = complement.find((stretch) => middle >= stretch.start && middle <= stretch.end);
			home?.words.push(index);
		});
		kept.splice(0, kept.length, ...complement);
	}

	// Ops, from the end backwards. Timeline position of source tick s (before any cut) = clipStart + (s - clipIn).
	const ops: Op[] = [];
	const at = (sourceTicks: number) => toSeconds(clipStart + (sourceTicks - clipIn));
	const regions = [...removed].reverse();
	regions.forEach((region, k) => {
		const note = `${region.reason}${region.detail ? `: ${region.detail}` : ""}`;
		const reachesEnd = region.end >= clipOut;
		const reachesStart = region.start <= clipIn;
		if (reachesEnd && reachesStart) return; // nothing kept at all: leave the clip for a human
		if (reachesEnd && options.rippleTail) {
			// split off the tail and ripple-delete it: whatever follows on the track closes up (no gap)
			const tail = `${prefix}-tail`;
			ops.push({ op: "split", author, el: clip.el, t: at(region.start), ref: tail, note });
			ops.push({ op: "ripple_delete", author, el: tail, note });
		} else if (reachesEnd) {
			ops.push({ op: "trim", author, el: clip.el, out: toSeconds(region.start), note });
		} else if (reachesStart) {
			const ref = `${prefix}-head`;
			ops.push({ op: "split", author, el: clip.el, t: at(region.end), ref, note });
			ops.push({ op: "ripple_delete", author, el: clip.el, note });
		} else {
			const middle = `${prefix}-cut${k}-mid`;
			const right = `${prefix}-cut${k}-right`;
			ops.push({ op: "split", author, el: clip.el, t: at(region.start), ref: middle, note });
			ops.push({ op: "split", author, el: middle, t: at(region.end), ref: right, note });
			ops.push({ op: "ripple_delete", author, el: middle, note });
		}
	});

	// Kept words on the new timeline.
	const newWords: TimedWord[] = [];
	let timelineCursor = clipStart;
	for (const stretch of kept) {
		for (const index of stretch.words) {
			const word = ordered[index];
			// clamp to the stretch: a word kept back by `keep` may begin just before its stretch
			const local = (ticks: number) => Math.min(stretch.end, Math.max(stretch.start, ticks)) - stretch.start;
			const start = timelineCursor + local(secondsToTicks(word.start));
			const end = timelineCursor + local(secondsToTicks(word.end));
			if (end > start) newWords.push({ text: word.text.trim(), start: toSeconds(start), end: toSeconds(end) });
		}
		timelineCursor += stretch.end - stretch.start;
	}

	if (options.captions !== false && newWords.length) {
		const captionOptions = typeof options.captions === "object" ? options.captions : {};
		ops.push({
			op: "add_captions",
			author,
			words: newWords,
			max_words: captionOptions.maxWords ?? 3,
			...(captionOptions.style ? { style: captionOptions.style } : {}),
			...(captionOptions.track ? { track: captionOptions.track } : { ref: `${prefix}-captions` }),
		});
	}

	const keptTicks = kept.reduce((sum, stretch) => sum + (stretch.end - stretch.start), 0);
	return {
		ops,
		kept: kept.map((stretch) => ({ start: toSeconds(stretch.start), end: toSeconds(stretch.end) })),
		removed: removed.map((region) => ({ ...region, start: toSeconds(region.start), end: toSeconds(region.end) })),
		candidates: found.map((region, index) => ({
			...region,
			start: toSeconds(region.start),
			end: toSeconds(region.end),
			index,
			applied: !keepBack.has(index),
			at: at(region.start),
		})),
		words: newWords,
		retakes,
		stats: {
			sourceSeconds: toSeconds(clipOut - clipIn),
			keptSeconds: toSeconds(keptTicks),
			removedSeconds: toSeconds(clipOut - clipIn - keptTicks),
		},
	};
}
