/**
 * Timing planners (timing-helper, 2026-10-21; the Sonnet replays' I-8 list, recreations SUMMARY "Sonnet replays").
 *
 * Every Sonnet replay worked out timing by hand: scene cut points from a new voice-over's word timings (neon-grid-nitro:
 * 8.75 / 13.25 / 18.2 / 21.8 / 27.2 / 36.0), effect windows {t, word, duration} with no overlap from the transcript
 * (effects-library-nitro: 17 windows copied from the Opus run's offsets), and the trim in-point (0.74 s, inferred).
 * These planners do it from the words. Pure: words in (seconds), plans out; no Node imports, no I/O. The MCP tool
 * that loads the words, the effect manifests and the clip, and turns plans into calls is ../mcp/plan.ts.
 *
 *   planScenes   sentence ends and pauses → cut candidates (a frame-aligned cut just before the next line's first
 *                word); a DP picks the cuts that make scenes closest to a target length (or a target count)
 *   planEffects  effect names in order → windows on spoken words: ~default_s each unless the manifest's natural length
 *                needs more (fit-to-duration compresses at most max_rate×), never overlapping; transitions sit on a
 *                cut (an existing one, else a split at a word boundary); fit:false compositions and grades span
 *   planTrim     a clip's source words → in/out points that drop the silent head and tail (pre/post roll kept)
 */

export interface PlanWord {
	text: string;
	/** Seconds (timeline seconds for scenes/effects; SOURCE seconds for trim). */
	start: number;
	end: number;
}

const EPS = 1e-6;
/** A planned split stays at least this far from an existing cut (no sliver clips). */
export const MIN_PIECE_S = 0.5;
export const round3 = (value: number) => Math.round(value * 1000) / 1000;
/**
 * Frame-grid times (cuts, scene starts, lengths in whole frames) keep 6 decimals, like timeline summary: 8.833333 is
 * the 265th frame to the tick; 8.833 would sit 40 ticks before it (mcp-discover: "times that touch must be equal").
 */
export const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** The same normalisation as effects-words.ts findWord (case, accents and punctuation ignored). */
export const tokenOf = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");

/** The word as a `word` argument: its letters and inner punctuation, no leading/trailing punctuation. */
export const cleanWord = (text: string) => text.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

export const isSentenceEnd = (text: string) => /[.!?…]["'”’)\]]*$/.test(text.trim());

/** Function words a viewer does not hear as the moment (an effect anchored on "the" looks arbitrary). */
export const STOP_WORDS = new Set(
	(
		"a an and are as at be but by do does for from had has have i if in is it its it's me my no not of on or our so " +
		"than that that's the their them then there these they this those to too up us was we were what when which who " +
		"will with you your just can could would should all any some very really also into out about over get got let " +
		"let's i'm you're we're they're don't isn't"
	).split(" "),
);

export const isStopWord = (text: string) => STOP_WORDS.has(text.toLowerCase().replace(/[^a-z']/g, ""));

/** Frame grid helpers (seconds). */
export const frameFloor = (seconds: number, fps: number) => Math.floor(seconds * fps + EPS) / fps;
export const frameCeil = (seconds: number, fps: number) => Math.ceil(seconds * fps - EPS) / fps;
export const frameRound = (seconds: number, fps: number) => Math.round(seconds * fps) / fps;

// ─── words in ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Words from any of the shapes the tools answer: voiceover `words` [{text, start, end}], transcribe `[text, start_s,
 * end_s]`, a composition's props `[{w, s, e}]`. Invalid items are counted, the rest sorted by start.
 */
export function normalizeWords(input: unknown): { words: PlanWord[]; dropped: number } {
	if (!Array.isArray(input)) return { words: [], dropped: 0 };
	const words: PlanWord[] = [];
	let dropped = 0;
	for (const item of input) {
		let text: unknown;
		let start: unknown;
		let end: unknown;
		if (Array.isArray(item)) [text, start, end] = item;
		else if (item && typeof item === "object") {
			const record = item as Record<string, unknown>;
			text = record.text ?? record.w ?? record.word;
			start = record.start ?? record.s ?? record.start_s;
			end = record.end ?? record.e ?? record.end_s;
		}
		if (typeof text !== "string" || typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
			dropped++;
			continue;
		}
		words.push({ text, start, end: Math.max(start, end) });
	}
	words.sort((a, b) => a.start - b.start);
	return { words, dropped };
}

/** Where the sentence holding words[index] ends: a word ending in . ! ? or before a pause ≥ `pause` (effects-words.ts). */
export function sentenceEndOf(words: PlanWord[], index: number, pause = 0.6): number {
	for (let i = index; i < words.length; i++) {
		const next = words[i + 1];
		if (isSentenceEnd(words[i].text)) return words[i].end;
		if (!next || next.start - words[i].end >= pause) return words[i].end;
	}
	return words[words.length - 1]?.end ?? 0;
}

// ─── cut points ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A cut just before the next line: `lead` seconds before its first word (at most half the gap), floored to the frame
 * grid, never before the previous word's end when the gap allows a frame. Picture leads sound by a few frames.
 */
export function cutBefore(prevEnd: number, nextStart: number, lead = 0.1, fps = 30): number {
	const gap = Math.max(0, nextStart - prevEnd);
	const wanted = nextStart - Math.min(lead, gap / 2);
	let cut = frameFloor(wanted, fps);
	if (cut < prevEnd - EPS) {
		// a gap under a frame: the first frame after the last word if it is still before the next one, else the frame
		// at or before the next word's onset (never after it: the line would start in the scene before)
		const up = frameCeil(prevEnd, fps);
		cut = up <= nextStart + EPS ? up : frameFloor(nextStart, fps);
	}
	return round6(cut);
}

export interface Boundary {
	/** Index of the last word before the cut. */
	after: number;
	kind: "sentence" | "pause";
	prev_end: number;
	next_start: number;
	gap_s: number;
	cut: number;
}

/** Every sentence end, and every pause ≥ pause_s inside a sentence, as a frame-aligned cut candidate. */
export function boundariesOf(words: PlanWord[], { pauseS = 0.35, leadS = 0.1, fps = 30 } = {}): Boundary[] {
	const out: Boundary[] = [];
	for (let i = 0; i + 1 < words.length; i++) {
		const gap = words[i + 1].start - words[i].end;
		const sentence = isSentenceEnd(words[i].text);
		if (!sentence && gap < pauseS) continue;
		out.push({
			after: i,
			kind: sentence ? "sentence" : "pause",
			prev_end: round3(words[i].end),
			next_start: round3(words[i + 1].start),
			gap_s: round3(gap),
			cut: cutBefore(words[i].end, words[i + 1].start, leadS, fps),
		});
	}
	return out;
}

// ─── scenes ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface ScenesOptions {
	/**
	 * The first words of each scene after the first, in order ("Cold brew", "Foam climbs", …): the story's beats, which
	 * only the script's writer knows. Each is found after the one before; the cut sits lead_s before it. Overrides
	 * count / scene_s.
	 */
	starts?: string[];
	/** Exactly this many scenes (when the words allow it). */
	count?: number;
	/** Target scene length in seconds (default 5) when count is not given. */
	sceneS?: number;
	minS?: number;
	maxS?: number;
	/** Where the first scene starts (default 0). */
	startS?: number;
	/** Where the last scene ends (default: the last word's end + tailS, on the frame grid). */
	endS?: number;
	tailS?: number;
	leadS?: number;
	pauseS?: number;
	fps?: number;
}

export interface PlannedScene {
	n: number;
	t: number;
	end: number;
	duration_s: number;
	/** Why it starts here: "start", "sentence end (gap 0.31 s)", "pause 0.42 s". */
	cut: string;
	line: string;
	first_word: { text: string; start: number } | null;
	/** The words said in it, timeline seconds ({w, s, e}: what the neon-grid compositions read with t0). */
	words: Array<{ w: string; s: number; e: number }>;
}

export interface ScenesPlan {
	scenes: PlannedScene[];
	start_s: number;
	end_s: number;
	target_s: number;
	count_asked: number | null;
	candidates: number;
	notes: string[];
}

function wordsIn(words: PlanWord[], from: number, to: number, last: boolean) {
	return words.filter((word) => word.start >= from - EPS && (last ? word.start <= to + EPS : word.start < to - EPS));
}

/**
 * Scene cuts on sentence ends (and pauses) that make scenes closest to the target length: a DP over the candidates
 * minimising Σ((L − target) / target)², with soft limits min_s / max_s and a small cost for cutting on a pause
 * instead of a sentence end. With count: exactly count scenes when there are enough candidates.
 */
export function planScenes(words: PlanWord[], options: ScenesOptions = {}): ScenesPlan {
	const fps = options.fps ?? 30;
	const notes: string[] = [];
	const start = options.startS ?? 0;
	const lastEnd = words.length ? words[words.length - 1].end : start;
	const end = round6(options.endS ?? frameCeil(lastEnd + (options.tailS ?? 0.8), fps));
	const total = Math.max(0, end - start);
	const count = options.count && options.count >= 1 ? Math.floor(options.count) : null;
	const target = count ? total / count : Math.max(0.5, options.sceneS ?? 5);
	const minS = options.minS ?? Math.min(2, target * 0.5);
	const maxS = options.maxS ?? Math.max(target * 2, target + 4);
	const bounds = boundariesOf(words, { pauseS: options.pauseS, leadS: options.leadS, fps }).filter((b) => b.cut > start + 0.25 && b.cut < end - 0.25);
	// positions: 0 = start, 1..m = candidates, m+1 = end
	const pos = [start, ...bounds.map((b) => b.cut), end];
	const m = bounds.length;
	const sceneCost = (i: number, j: number) => {
		const length = pos[j] - pos[i];
		let cost = ((length - target) / target) ** 2;
		if (length < minS) cost += 1 + 10 * ((minS - length) / target) ** 2;
		if (length > maxS) cost += 1 + 10 * ((length - maxS) / target) ** 2;
		if (!wordsIn(words, pos[i], pos[j], j === m + 1).length) cost += 2; // a scene with nothing said in it
		if (j <= m && bounds[j - 1].kind === "pause") cost += 0.15; // cutting inside a sentence
		return cost;
	};
	let chosen: number[] = [];
	if (options.starts?.length) {
		// the writer's beats: a cut before each phrase, found in order
		const cutsAt: Array<{ cut: number; label: string }> = [];
		let after = 0;
		for (const phrase of options.starts) {
			const index = findPhraseFrom(words, phrase, after);
			if (index < 0) {
				notes.push(`"${phrase}" is not said after the scene before: no cut for it.`);
				continue;
			}
			const cut = index > 0 ? cutBefore(words[index - 1].end, words[index].start, options.leadS ?? 0.1, fps) : round6(start);
			if (cut <= start + EPS || cut >= end - EPS) {
				notes.push(`"${phrase}" starts at ${round3(words[index].start)} s, outside ${round3(start)}–${end} s: no cut for it.`);
				continue;
			}
			cutsAt.push({ cut, label: `before "${phrase}"` });
			after = index + 1;
		}
		const points = [start, ...cutsAt.map((item) => item.cut), end];
		const scenesByStarts: PlannedScene[] = [];
		for (let n = 0; n + 1 < points.length; n++) {
			const inside = wordsIn(words, points[n], points[n + 1], n + 2 === points.length);
			scenesByStarts.push({
				n: n + 1,
				t: round6(points[n]),
				end: round6(points[n + 1]),
				duration_s: round6(points[n + 1] - points[n]),
				cut: n === 0 ? "start" : cutsAt[n - 1].label,
				line: inside.map((word) => word.text).join(" "),
				first_word: inside[0] ? { text: inside[0].text, start: round3(inside[0].start) } : null,
				words: inside.map((word) => ({ w: word.text, s: round3(word.start), e: round3(word.end) })),
			});
		}
		return { scenes: scenesByStarts, start_s: round6(start), end_s: end, target_s: round3(target), count_asked: count, candidates: m, notes };
	}
	if (count) {
		const k = Math.min(count, m + 1);
		if (k < count) notes.push(`Only ${m} cut candidates (sentence ends + pauses): ${k} scenes instead of ${count}.`);
		// dp[s][j] = best cost of s scenes covering start..pos[j]
		const dp: number[][] = Array.from({ length: k + 1 }, () => new Array(m + 2).fill(Number.POSITIVE_INFINITY));
		const back: number[][] = Array.from({ length: k + 1 }, () => new Array(m + 2).fill(-1));
		dp[0][0] = 0;
		for (let s = 1; s <= k; s++) {
			for (let j = 1; j <= m + 1; j++) {
				for (let i = s - 1; i < j; i++) {
					if (!Number.isFinite(dp[s - 1][i])) continue;
					const cost = dp[s - 1][i] + sceneCost(i, j);
					if (cost < dp[s][j]) {
						dp[s][j] = cost;
						back[s][j] = i;
					}
				}
			}
		}
		let j = m + 1;
		for (let s = k; s > 0; s--) {
			chosen.unshift(j);
			j = back[s][j];
		}
	} else {
		const dp = new Array(m + 2).fill(Number.POSITIVE_INFINITY);
		const back = new Array(m + 2).fill(-1);
		dp[0] = 0;
		for (let j = 1; j <= m + 1; j++) {
			for (let i = 0; i < j; i++) {
				const cost = dp[i] + sceneCost(i, j);
				if (cost < dp[j]) {
					dp[j] = cost;
					back[j] = i;
				}
			}
		}
		let j = m + 1;
		while (j > 0) {
			chosen.unshift(j);
			j = back[j];
		}
	}
	chosen = chosen.filter((j) => j > 0);
	const scenes: PlannedScene[] = [];
	let from = 0;
	chosen.forEach((j, n) => {
		const t = round6(pos[from]);
		const stop = round6(pos[j]);
		const inside = wordsIn(words, pos[from], pos[j], j === m + 1);
		const b = from > 0 ? bounds[from - 1] : null;
		scenes.push({
			n: n + 1,
			t,
			end: stop,
			duration_s: round6(stop - t),
			cut: b ? (b.kind === "sentence" ? `sentence end (gap ${b.gap_s} s)` : `pause ${b.gap_s} s`) : "start",
			line: inside.map((word) => word.text).join(" "),
			first_word: inside[0] ? { text: inside[0].text, start: round3(inside[0].start) } : null,
			words: inside.map((word) => ({ w: word.text, s: round3(word.start), e: round3(word.end) })),
		});
		from = j;
	});
	const short = scenes.filter((scene) => scene.duration_s < minS - EPS).length;
	const long = scenes.filter((scene) => scene.duration_s > maxS + EPS).length;
	if (short) notes.push(`${short} scene(s) shorter than min_s ${round3(minS)} s: the sentences don't allow better.`);
	if (long) notes.push(`${long} scene(s) longer than max_s ${round3(maxS)} s: no sentence end or pause to cut on inside.`);
	if (!words.length) notes.push("No words: one scene over the whole span.");
	return { scenes, start_s: round6(start), end_s: end, target_s: round3(target), count_asked: count, candidates: m, notes };
}

// ─── effects ────────────────────────────────────────────────────────────────────────────────────────────────

export type PlanKind = "composition" | "shader" | "transition" | "grade" | "tool" | "skip";

export interface EffectAsk {
	/** As asked. */
	asked: string;
	/** Catalogue id (FX-01, comp:toc-list, tr:dissolve…). */
	id: string;
	/** The effect's name. */
	name: string;
	kind: PlanKind;
	/** Seconds the effect's every beat needs at speed 1 (manifest fit / duration; shader hold; transition length). */
	natural_s: number | null;
	/** A composition whose clock is compressed to fit a shorter window (fit-to-duration, CONTRACT §3b). */
	compressible?: boolean;
	/** One window over the whole plan (fit:false compositions such as toc-list; grades). */
	span?: boolean;
	/** Shader presets that hold to the end of the sentence (Digital Zoom). */
	hold_to_sentence?: boolean;
	/** What the caller fixed: a word (+ occurrence), a time, a length. */
	pinned?: { word?: string; occurrence?: number; t?: number; duration_s?: number };
	skip_reason?: string;
}

export interface EffectsOptions {
	/** Window length when the effect needs no more (default 1 s). */
	defaultS?: number;
	/** Seconds of plain footage at least between two windows (default 0: windows may touch). */
	gapS?: number;
	/** The span to plan over (default: the first word … the last word's end + 0.3 s). */
	fromS?: number;
	toS?: number;
	/** A gap shorter than this between two windows is closed by extending the first (default 0.3 s). */
	fillUnderS?: number;
	/** The most a fit-to-duration composition is sped up (default 4×: 4 s of beats in 1 s). */
	maxRate?: number;
	/** Existing cuts on the main track (timeline seconds): transitions use one when it is in reach. */
	cuts?: number[];
	/** How far (s) from its evenly-spread place a transition may move to sit on an existing cut (default 4). */
	cutReachS?: number;
	/** Where the picture ends (timeline seconds): the default to_s never passes it (effects apply clamps there). */
	pictureEndS?: number;
	leadS?: number;
	fps?: number;
}

export interface PlannedWindow {
	n: number;
	/** Index of the ask in the list given to planEffects. */
	ask: number;
	asked: string;
	id: string;
	name: string;
	kind: PlanKind;
	t: number;
	end: number;
	duration_s: number;
	/** The word the window starts on (index into the words), or null when it starts between words. */
	word: { text: string; arg: string; index: number; occurrence: number; start: number } | null;
	/** Transitions: the cut it sits on; split = the cut does not exist yet. */
	cut?: { t: number; split: boolean };
	natural_s: number | null;
	why: string[];
}

export interface EffectsPlan {
	windows: PlannedWindow[];
	spans: Array<{ ask: number; asked: string; id: string; name: string; kind: PlanKind; t: number; end: number; duration_s: number; why: string }>;
	tools: EffectAsk[];
	skipped: EffectAsk[];
	range: { from: number; to: number };
	needed_s: number;
	slack_s: number;
	fits: boolean;
	notes: string[];
}

/** The window length an effect needs (before snapping): ~default_s unless its natural length needs more. */
export function lengthFor(ask: EffectAsk, defaultS: number, maxRate: number): { length: number; why: string } {
	if (ask.pinned?.duration_s) return { length: ask.pinned.duration_s, why: `duration_s ${ask.pinned.duration_s} s as asked` };
	if (ask.kind === "transition") {
		const length = ask.natural_s ?? 0.35;
		return { length, why: `transition length ${length} s, centred on the cut` };
	}
	if (ask.kind === "composition" && ask.natural_s) {
		if (ask.compressible) {
			const least = ask.natural_s / maxRate;
			if (least > defaultS + EPS) return { length: least, why: `natural ${ask.natural_s} s; fit-to-duration compresses it at most ${maxRate}×, so it needs ${round3(least)} s` };
			return { length: defaultS, why: `natural ${ask.natural_s} s, compressed to ${defaultS} s (fit-to-duration, ${round3(ask.natural_s / defaultS)}×)` };
		}
		if (ask.natural_s > defaultS) return { length: ask.natural_s, why: `natural ${ask.natural_s} s (not compressible)` };
	}
	if (ask.kind === "shader" && ask.hold_to_sentence) return { length: defaultS, why: `${defaultS} s, held to the end of its sentence when there is room` };
	return { length: defaultS, why: `${defaultS} s` };
}

/** Occurrence of words[index] as findWord counts it (exact token matches before it, 1-based). */
export function occurrenceOf(words: PlanWord[], index: number): number {
	const wanted = tokenOf(words[index].text);
	let n = 0;
	for (let i = 0; i <= index; i++) if (tokenOf(words[i].text) === wanted) n++;
	return n;
}

/** findWord's rule (effects-words.ts) for a pinned word: the phrase's occurrence-th start index, or -1. */
export function findPhrase(words: PlanWord[], phrase: string, occurrence = 1): number {
	const wanted = phrase.split(/\s+/).map(tokenOf).filter(Boolean);
	if (!wanted.length) return -1;
	const tokens = words.map((word) => tokenOf(word.text));
	const hits: number[] = [];
	for (let i = 0; i + wanted.length <= tokens.length; i++) if (wanted.every((w, k) => tokens[i + k] === w)) hits.push(i);
	if (!hits.length && wanted.length === 1 && wanted[0].length >= 3) tokens.forEach((t, i) => t.startsWith(wanted[0]) && hits.push(i));
	return hits[Math.max(1, Math.floor(occurrence)) - 1] ?? -1;
}

/** The first start index of `phrase` at or after `fromIndex` (same matching as findPhrase), or -1. */
export function findPhraseFrom(words: PlanWord[], phrase: string, fromIndex = 0): number {
	const wanted = phrase.split(/\s+/).map(tokenOf).filter(Boolean);
	if (!wanted.length) return -1;
	const tokens = words.map((word) => tokenOf(word.text));
	for (let i = Math.max(0, fromIndex); i + wanted.length <= tokens.length; i++) if (wanted.every((w, k) => tokens[i + k] === w)) return i;
	if (wanted.length === 1 && wanted[0].length >= 3) for (let i = Math.max(0, fromIndex); i < tokens.length; i++) if (tokens[i].startsWith(wanted[0])) return i;
	return -1;
}

function wordRef(words: PlanWord[], index: number): PlannedWindow["word"] {
	const word = words[index];
	return { text: word.text, arg: cleanWord(word.text), index, occurrence: occurrenceOf(words, index), start: round3(word.start) };
}

/** The first word of a sentence (or after a pause ≥ 0.3 s): a moment a viewer hears as a start, whatever the word. */
export function startsSentence(words: PlanWord[], index: number): boolean {
	return index === 0 || isSentenceEnd(words[index - 1].text) || words[index].start - words[index - 1].end >= 0.3;
}

/** How much worse a word is as an effect's first moment, in seconds of distance from its ideal place. */
export function anchorPenalty(words: PlanWord[], index: number): number {
	if (startsSentence(words, index)) return -0.1;
	const word = words[index].text;
	return (isStopWord(word) ? 0.5 : 0) + (isSentenceEnd(word) ? 0.15 : 0);
}

interface Slot {
	ask: EffectAsk;
	askIndex: number;
	length: number;
	why: string[];
	/** Placed before the runs: a pinned word / t, or a transition on an existing cut. */
	fixed: boolean;
	t: number;
	word: PlannedWindow["word"];
	cut?: { t: number; split: boolean };
}

/**
 * Windows for effects in the order given, on spoken words, never overlapping.
 *   1. fixed first: a pinned word / t; then each transition on an existing main-track cut within cut_reach_s of its
 *      evenly-spread place, when the windows before and after it still fit (no split needed);
 *   2. the runs between fixed windows: each window's ideal start = back to back with the run's slack spread evenly;
 *      the planner takes the word onset closest to it that still leaves room for the rest of the run, preferring words
 *      a viewer hears as the moment (not "the", "to", "is"; not the last word of a sentence); a transition with no
 *      cut in reach gets a split at a word boundary (a sentence end when one is near);
 *   3. hold-to-sentence shaders run to their sentence end when there is room; gaps under fill_under_s are closed;
 *      lengths snap to whole frames.
 */
export function planEffects(words: PlanWord[], asks: EffectAsk[], options: EffectsOptions = {}): EffectsPlan {
	const fps = options.fps ?? 30;
	const defaultS = options.defaultS ?? 1;
	const gapS = Math.max(0, options.gapS ?? 0);
	const fillUnder = options.fillUnderS ?? 0.3;
	const maxRate = options.maxRate ?? 4;
	const lead = options.leadS ?? 0.1;
	const reach = options.cutReachS ?? 4;
	const notes: string[] = [];
	const spoken = words.filter((word) => tokenOf(word.text));
	const from = round3(options.fromS ?? spoken[0]?.start ?? 0);
	const lastWordEnd = spoken.length ? spoken[spoken.length - 1].end + 0.3 : from;
	const to = round3(options.toS ?? (options.pictureEndS && options.pictureEndS > from ? Math.min(lastWordEnd, options.pictureEndS) : lastWordEnd));
	const windowed = asks.filter((ask) => !ask.span && (ask.kind === "composition" || ask.kind === "shader" || ask.kind === "transition"));
	const spansAsked = asks.filter((ask) => ask.span && (ask.kind === "composition" || ask.kind === "grade"));
	const tools = asks.filter((ask) => ask.kind === "tool");
	const skipped = asks.filter((ask) => ask.kind === "skip");
	const slots: Slot[] = windowed.map((ask) => {
		const { length, why } = lengthFor(ask, defaultS, maxRate);
		return { ask, askIndex: asks.indexOf(ask), length, why: [why], fixed: false, t: Number.NaN, word: null };
	});
	/**
	 * How long a window holds the screen before the next may start: its length, or for a transition only up to its
	 * cut — the next effect may land on the cut, over the transition's second half (the new shot), as the reels do.
	 */
	const held = (slot: Slot) => (slot.ask.kind === "transition" ? slot.length / 2 : slot.length);
	const needed = slots.reduce((sum, slot) => sum + held(slot), 0) + gapS * Math.max(0, slots.length - 1);
	const slack = to - from - needed;
	let fits = slack >= -EPS;
	if (!fits) notes.push(`The ${slots.length} windows need ${round3(needed)} s but the span is ${round3(to - from)} s: they run past to_s (shorten default_s, drop some, or widen from_s/to_s).`);
	const spread = slots.length ? Math.max(0, slack) / slots.length : 0;
	const candidates = words.map((word, index) => ({ word, index })).filter(({ word }) => tokenOf(word.text) && word.start >= from - EPS && word.start < to - EPS);
	const cuts = [...(options.cuts ?? [])].sort((a, b) => a - b);
	const byDistance = (centre: number) => (a: number, b: number) => Math.abs(a - centre) - Math.abs(b - centre);
	const cutForWord = (index: number) => (index > 0 ? cutBefore(words[index - 1].end, words[index].start, lead, fps) : round6(frameRound(words[index].start, fps)));
	const wordFrom = (t: number) => words.findIndex((word) => tokenOf(word.text) && word.start >= t - 0.02);
	const onCut = (slot: Slot, c: number, existing: boolean) => {
		slot.cut = { t: round6(c), split: !existing };
		slot.t = round6(c - slot.length / 2);
		const index = wordFrom(c);
		slot.word = index >= 0 ? wordRef(words, index) : null;
	};

	// 1a. pinned words / times
	for (const slot of slots) {
		const pin = slot.ask.pinned;
		if (!pin) continue;
		if (pin.word) {
			const index = findPhrase(words, pin.word, pin.occurrence ?? 1);
			if (index < 0) {
				slot.why.push(`pinned word "${pin.word}" is not said: placed by the plan instead`);
				continue;
			}
			if (slot.ask.kind === "transition") {
				const c = cutForWord(index);
				const existing = cuts.filter((cut) => Math.abs(cut - c) <= 2 / fps + EPS).sort(byDistance(c))[0];
				onCut(slot, existing ?? c, existing !== undefined);
			} else slot.t = round3(words[index].start);
			slot.word = wordRef(words, index);
			slot.fixed = true;
			slot.why.push(`on "${pin.word}" as asked`);
		} else if (typeof pin.t === "number") {
			if (slot.ask.kind === "transition") {
				const existing = cuts.filter((cut) => Math.abs(cut - pin.t!) <= 0.5 + EPS).sort(byDistance(pin.t))[0];
				onCut(slot, existing ?? frameRound(pin.t, fps), existing !== undefined);
			} else {
				slot.t = round3(pin.t);
				const index = words.findIndex((word) => Math.abs(word.start - pin.t!) <= 0.02 && tokenOf(word.text));
				slot.word = index >= 0 ? wordRef(words, index) : null;
			}
			slot.fixed = true;
			slot.why.push(`at t ${round3(pin.t)} s as asked`);
		}
	}
	// windows start on word onsets (transitions on any boundary): exact packing, earliest forward / latest backward
	const onsetFrom = (t: number) => candidates.find(({ word }) => word.start >= t - EPS);
	const onsetUpTo = (t: number) => {
		for (let c = candidates.length - 1; c >= 0; c--) if (candidates[c].word.start <= t + EPS) return candidates[c];
		return undefined;
	};
	/** Can these windows all start on onsets inside [runFrom, runTo] (each as early as it can)? */
	const packs = (run: Slot[], runFrom: number, runTo: number) => {
		let at = runFrom;
		for (const slot of run) {
			let start = at;
			if (slot.ask.kind !== "transition") {
				const onset = onsetFrom(at);
				if (!onset) return false;
				start = onset.word.start;
			}
			at = start + held(slot) + gapS;
		}
		return at - gapS <= runTo + EPS;
	};
	/** The latest start of each window of a run that still lets every later one start on an onset before runTo. */
	const latestStarts = (run: Slot[], runTo: number) => {
		const out: number[] = new Array(run.length);
		let limit = runTo;
		for (let r = run.length - 1; r >= 0; r--) {
			let start = limit - held(run[r]);
			if (run[r].ask.kind !== "transition") start = onsetUpTo(start)?.word.start ?? Number.NEGATIVE_INFINITY;
			out[r] = start;
			limit = start - gapS;
		}
		return out;
	};
	/** Does slot i fit at `start` with the fixed windows around it and the free ones between them? */
	const roomFor = (i: number, start: number) => {
		let a = i - 1;
		while (a >= 0 && !slots[a].fixed) a--;
		let b = i + 1;
		while (b < slots.length && !slots[b].fixed) b++;
		const prevEnd = a >= 0 ? slots[a].t + held(slots[a]) + gapS : from;
		const nextStart = b < slots.length ? slots[b].t - gapS : to;
		return start >= prevEnd - EPS && packs(slots.slice(a + 1, i), prevEnd, start - gapS) && packs(slots.slice(i + 1, b), start + held(slots[i]) + gapS, nextStart);
	};
	// 1b. transitions onto an existing cut near their evenly-spread place
	const ideals: number[] = [];
	{
		let at = from;
		for (const slot of slots) {
			ideals.push(at);
			at += held(slot) + gapS + spread;
		}
	}
	slots.forEach((slot, i) => {
		if (slot.fixed || slot.ask.kind !== "transition") return;
		const centre = ideals[i] + slot.length / 2;
		for (const c of cuts.filter((cut) => Math.abs(cut - centre) <= reach + EPS).sort(byDistance(centre))) {
			if (!roomFor(i, c - slot.length / 2)) continue;
			onCut(slot, c, true);
			slot.fixed = true;
			slot.why.push(`on the existing cut at ${round3(c)} s (no split needed)`);
			break;
		}
	});

	// 2. the runs between fixed windows
	const placeRun = (run: Slot[], runFrom: number, runTo: number) => {
		const need = run.reduce((sum, slot) => sum + held(slot), 0) + gapS * Math.max(0, run.length - 1);
		const runSpread = run.length ? Math.max(0, runTo - runFrom - need) / run.length : 0;
		const latestOf = latestStarts(run, runTo);
		let earliest = runFrom;
		let ideal = runFrom;
		run.forEach((slot, r) => {
			const latest = Math.max(earliest, latestOf[r]);
			const target = Math.min(latest, Math.max(earliest, ideal));
			if (slot.ask.kind === "transition") {
				const lo = earliest + slot.length / 2;
				const hi = latest + slot.length / 2;
				const centre = target + slot.length / 2;
				const existing = cuts.filter((c) => c >= lo - EPS && c <= hi + EPS && Math.abs(c - centre) <= reach + EPS).sort(byDistance(centre))[0];
				// a new split never lands within MIN_PIECE_S of an existing cut (it would leave a sliver clip)
				const farFromCuts = (c: number) => cuts.every((x) => Math.abs(x - c) >= MIN_PIECE_S - EPS);
				if (existing !== undefined) {
					onCut(slot, existing, true);
					slot.why.push(`on the existing cut at ${round3(existing)} s (no split needed)`);
				} else {
					let best: { cut: number; index: number; score: number } | null = null;
					for (const { index } of candidates) {
						if (index === 0) continue;
						const c = cutForWord(index);
						if (c < lo - EPS || c > hi + EPS || !farFromCuts(c)) continue;
						const score = Math.abs(c - centre) + (isSentenceEnd(words[index - 1].text) ? 0 : 0.2) + (isStopWord(words[index].text) ? 0.1 : 0);
						if (!best || score < best.score) best = { cut: c, index, score };
					}
					const fallback = round6(frameRound(Math.min(hi, Math.max(lo, centre)), fps));
					const near = cuts.filter((x) => x >= lo - MIN_PIECE_S - EPS && x <= hi + MIN_PIECE_S + EPS).sort(byDistance(centre))[0];
					if (best) {
						onCut(slot, best.cut, false);
						slot.word = wordRef(words, best.index);
						slot.why.push(`needs a cut: split the clip at ${best.cut} s, before "${words[best.index].text}"`);
					} else if (near !== undefined && !farFromCuts(fallback)) {
						onCut(slot, near, true);
						slot.why.push(`on the existing cut at ${round3(near)} s (the run is tight: a new split here would leave a sliver clip)`);
					} else {
						onCut(slot, fallback, false);
						slot.why.push(`needs a cut: split the clip at ${fallback} s (no word boundary in reach)`);
					}
				}
			} else {
				let best: { index: number; score: number } | null = null;
				for (const { word, index } of candidates) {
					if (word.start < earliest - EPS || word.start > latest + EPS) continue;
					const score = Math.abs(word.start - target) + anchorPenalty(words, index);
					if (!best || score < best.score) best = { index, score };
				}
				if (!best) {
					const next = candidates.find(({ word }) => word.start >= earliest - EPS);
					if (next) {
						best = { index: next.index, score: 0 };
						slot.why.push("tight: the first word after the window before (the rest may run past to_s)");
					}
				}
				if (best) {
					slot.word = wordRef(words, best.index);
					slot.t = round3(words[best.index].start);
				} else {
					slot.t = round3(earliest);
					slot.why.push("no word left in the span: starts right after the window before");
				}
			}
			earliest = slot.t + held(slot) + gapS;
			ideal = Math.max(ideal + held(slot) + gapS + runSpread, earliest);
		});
	};
	for (let k = 0; k < slots.length; ) {
		if (slots[k].fixed) {
			k++;
			continue;
		}
		let m = k;
		while (m < slots.length && !slots[m].fixed) m++;
		const runFrom = k > 0 ? slots[k - 1].t + held(slots[k - 1]) + gapS : from;
		const runTo = m < slots.length ? slots[m].t - gapS : to;
		const run = slots.slice(k, m);
		if (!packs(run, runFrom, runTo)) {
			fits = false;
			const between = `${k > 0 ? `after ${slots[k - 1].ask.name}` : "from the start"} ${m < slots.length ? `before ${slots[m].ask.name} (fixed at ${round3(slots[m].t)} s)` : "to the end"}`;
			notes.push(`The ${run.length} window(s) ${between} do not fit on spoken words in ${round3(Math.max(0, runTo - runFrom))} s: some run late or overlap — lower default_s, raise max_rate, widen from_s / to_s, or move a pin.`);
		}
		placeRun(run, runFrom, runTo);
		k = m;
	}
	const windows: PlannedWindow[] = slots.map((slot, i) => ({
		n: i + 1,
		ask: slot.askIndex,
		asked: slot.ask.asked,
		id: slot.ask.id,
		name: slot.ask.name,
		kind: slot.ask.kind,
		t: slot.t,
		end: round6(slot.t + slot.length),
		duration_s: round6(slot.length),
		word: slot.word,
		...(slot.cut ? { cut: slot.cut } : {}),
		natural_s: slot.ask.natural_s,
		why: slot.why,
	}));
	windows.forEach((win, i) => {
		const prev = windows[i - 1];
		if (!prev) return;
		// after a transition the next window may start on its cut (over the new shot), not before
		const prevHeld = prev.kind === "transition" && prev.cut ? prev.cut.t : prev.end;
		if (win.t < prevHeld + gapS - EPS) {
			win.why.push(`overlaps the window before by ${round3(prevHeld + gapS - win.t)} s`);
			notes.push(`${win.name} overlaps ${prev.name} by ${round3(prevHeld + gapS - win.t)} s.`);
			fits = false;
		} else if (prev.kind === "transition" && win.t < prev.end - EPS) {
			win.why.push(`starts ${round3(win.t - prevHeld)} s after the cut, over the second half of ${prev.name} (the new shot)`);
		}
	});
	// natural length after placing: hold-to-sentence shaders run to their sentence end when there is room
	windows.forEach((win, i) => {
		const ask = windowed[i];
		const next = windows[i + 1];
		const room = next ? next.t - gapS : to;
		if (ask.hold_to_sentence && win.word && !ask.pinned?.duration_s) {
			const until = sentenceEndOf(words, win.word.index);
			const end = Math.min(until, room, win.t + 2.5);
			if (end > win.end + EPS) {
				win.end = round6(end);
				win.why.push(`held to the end of its sentence (${round3(until)} s)${end < until - EPS ? ", up to the next window" : ""}`);
			}
		}
	});
	// close short gaps (a flash of plain footage between two effects) and snap lengths to whole frames
	windows.forEach((win, i) => {
		const next = windows[i + 1];
		if (win.kind !== "transition" && next && !windowed[i].pinned?.duration_s) {
			const gap = next.t - gapS - win.end;
			if (gap > EPS && gap < fillUnder) {
				win.end = round6(next.t - gapS);
				win.why.push(`extended ${round3(gap)} s to meet the next window`);
			}
		}
		let frames = Math.max(1, Math.round((win.end - win.t) * fps));
		// rounding up to a whole frame must not run into the next window (a transition may: the next starts on its cut)
		if (win.kind !== "transition" && next && frames > 1 && win.t + frames / fps > next.t - gapS + EPS) frames -= 1;
		win.duration_s = round6(frames / fps);
		win.end = round6(win.t + frames / fps);
	});
	const first = windows[0]?.t ?? from;
	const last = windows.length ? Math.max(...windows.map((win) => win.end)) : to;
	if (last > to + EPS) {
		fits = false;
		notes.push(`The windows run ${round3(last - to)} s past to_s (${to} s), each on the first word it could take: lower default_s, raise max_rate, or widen to_s.`);
	}
	const spans = spansAsked.map((ask) => {
		const t = round6(Math.min(first, from));
		const end = round6(Math.max(last, t + 0.1));
		return {
			ask: asks.indexOf(ask),
			asked: ask.asked,
			id: ask.id,
			name: ask.name,
			kind: ask.kind,
			t,
			end,
			duration_s: round6(end - t),
			why: ask.kind === "grade" ? "a grade colours whole clips (or the timeline), not a window" : "timed to the voice (fit: false): one clip across every window",
		};
	});
	return { windows, spans, tools, skipped, range: { from, to }, needed_s: round3(needed), slack_s: round3(slack), fits, notes };
}

// ─── trim ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface TrimOptions {
	/** Source seconds of the media (out never passes it). */
	duration?: number;
	/** Kept before the first word (default 0.1 s) and after the last (default 0.2 s). */
	preS?: number;
	postS?: number;
	/** Start / end on these phrases instead of the first / last word. */
	fromWord?: string;
	toWord?: string;
	occurrence?: number;
	/** Only words inside this source window (a clip's current in/out). */
	window?: { from: number; to: number };
	/**
	 * Keep whole sentences (default true): a leading fragment (the take starts mid-sentence on a lower-case word) and
	 * trailing words after the last sentence end are trimmed off with the silence.
	 */
	sentences?: boolean;
	fps?: number;
}

const FRAGMENT_REACH = 15;
const isCapitalStart = (text: string) => /^["'“‘(]?\p{Lu}/u.test(text.trim()) && !/^I(?:$|['’])/.test(cleanWord(text));

export interface TrimPlan {
	in: number;
	out: number;
	kept_s: number;
	first_word: { text: string; start: number } | null;
	last_word: { text: string; end: number } | null;
	head_silence_s: number;
	tail_silence_s: number;
	notes: string[];
}

/** In/out (SOURCE seconds) that keep the speech plus a short pre/post roll and drop the silence around it. */
export function planTrim(words: PlanWord[], options: TrimOptions = {}): TrimPlan | null {
	const fps = options.fps ?? 30;
	const pre = options.preS ?? 0.1;
	const post = options.postS ?? 0.2;
	const notes: string[] = [];
	const inside = options.window
		? words.filter((word) => (word.start + word.end) / 2 >= options.window!.from - EPS && (word.start + word.end) / 2 <= options.window!.to + EPS)
		: words;
	const spoken = inside.filter((word) => tokenOf(word.text));
	if (!spoken.length) return null;
	let firstIndex = 0;
	let lastIndex = spoken.length - 1;
	if (options.sentences !== false) {
		if (!options.fromWord && /^\p{Ll}/u.test(spoken[0].text.trim())) {
			const start = spoken.findIndex((word, i) => i > 0 && i <= FRAGMENT_REACH && (isSentenceEnd(spoken[i - 1].text) || isCapitalStart(word.text)));
			if (start > 0) {
				notes.push(`dropped a leading fragment "${spoken.slice(0, start).map((word) => word.text).join(" ")}" (it starts mid-sentence)`);
				firstIndex = start;
			}
		}
		if (!options.toWord && !isSentenceEnd(spoken[lastIndex].text)) {
			for (let i = lastIndex - 1; i >= Math.max(firstIndex, lastIndex - FRAGMENT_REACH); i--) {
				if (!isSentenceEnd(spoken[i].text)) continue;
				notes.push(`dropped a trailing fragment "${spoken.slice(i + 1).map((word) => word.text).join(" ")}" (after the last sentence end)`);
				lastIndex = i;
				break;
			}
		}
	}
	if (options.fromWord) {
		const found = findPhrase(spoken, options.fromWord, options.occurrence ?? 1);
		if (found < 0) notes.push(`from_word "${options.fromWord}" is not said: starting at the first word`);
		else firstIndex = found;
	}
	if (options.toWord) {
		const wanted = options.toWord.split(/\s+/).map(tokenOf).filter(Boolean);
		const found = findPhraseFrom(spoken, options.toWord, firstIndex);
		if (found < 0) notes.push(`to_word "${options.toWord}" is not said after the start: ending at the last word`);
		else lastIndex = Math.min(spoken.length - 1, found + Math.max(0, wanted.length - 1));
	}
	const first = spoken[firstIndex];
	const last = spoken[lastIndex];
	// the pre/post roll never reaches into the word before / after (a file cut from a longer take starts and ends
	// on fragments: "…cut | Just so you know … do it. | You…")
	const allSpoken = words.filter((word) => tokenOf(word.text));
	const before = allSpoken[allSpoken.indexOf(first) - 1];
	const after = allSpoken[allSpoken.indexOf(last) + 1];
	const floorAt = Math.max(0, before ? before.end + 0.02 : 0, options.window && !options.fromWord ? options.window.from - pre : 0);
	const ceilAt = Math.min(options.duration ?? Number.POSITIVE_INFINITY, after ? after.start - 0.02 : Number.POSITIVE_INFINITY);
	let inPoint = frameFloor(Math.max(floorAt, first.start - pre), fps);
	if (inPoint < floorAt - EPS) inPoint = Math.min(frameCeil(floorAt, fps), first.start);
	let outPoint = frameCeil(Math.min(ceilAt, last.end + post), fps);
	if (outPoint > ceilAt + EPS) outPoint = Math.max(frameFloor(ceilAt, fps), last.end);
	if (before && first.start - pre < floorAt - EPS) notes.push(`pre-roll shortened: "${before.text}" ends ${round3(before.end)} s, just before "${first.text}"`);
	if (after && last.end + post > ceilAt + EPS) notes.push(`post-roll shortened: "${after.text}" starts ${round3(after.start)} s, just after "${last.text}"`);
	inPoint = round6(inPoint);
	outPoint = round6(outPoint);
	const highest = options.duration ?? Number.POSITIVE_INFINITY;
	return {
		in: inPoint,
		out: outPoint,
		kept_s: round6(outPoint - inPoint),
		first_word: { text: first.text, start: round3(first.start) },
		last_word: { text: last.text, end: round3(last.end) },
		head_silence_s: round3(Math.max(0, first.start - (options.window?.from ?? 0))),
		tail_silence_s: Number.isFinite(highest) ? round3(Math.max(0, (options.window?.to ?? highest) - last.end)) : 0,
		notes,
	};
}
