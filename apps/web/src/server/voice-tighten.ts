/**
 * Voice-over pacing (sound-voice-v2 agent, 2026-10-20; recreations SUMMARY gap 8, neon-grid G-2): Windows' voices
 * leave ~0.78 s after every sentence (MEASURED in the neon-grid recreation: speech 62.6 % vs the reel's 89 %).
 *
 *   tightenTake(take, {maxPause, keep})  every pause between two words longer than `maxPause` (0.35 s) is cut down to
 *                                        `keep` (0.2 s), from its middle, with 8 ms fades at each join (the cut sits in
 *                                        silence below −45 dBFS) → a new take (own key, hash, words) in the same cache,
 *                                        word timings shifted by what was removed before them, re-measured (ebur128 +
 *                                        the silencedetect timing check).
 *   speechShare(words, duration)         seconds of speech (word spans, gaps < 0.35 s merged) / duration — the
 *                                        recreations' measure.
 *   sapiSpeedFor(speed)                  SAPI only knows whole Rate steps (Rate = round(10·log3(speed)), voice-tts.ps1):
 *                                        the smallest stepped speed ≥ speed, so a fit loop never asks twice for the
 *                                        same audio.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TimedWord } from "@restorffcut/timeline-ops";
import { checkTiming, readTake, type VoiceTake, voiceDir, wavDataBytes } from "./voice";
import { ffmpeg, measureLoudness } from "./voice-ffmpeg";

export const TIGHTEN_VERSION = 1;
export const TIGHTEN_DEFAULTS = { maxPause: 0.35, keep: 0.2 } as const;
const RATE = 48_000;
const JOIN_FADE = 0.008;

const r3 = (value: number) => Math.round(value * 1000) / 1000;

export interface TightenInfo {
	from: string;
	max_pause_s: number;
	keep_s: number;
	pauses_cut: number;
	removed_s: number;
	version: number;
}

export type TightTake = VoiceTake & { tightened?: TightenInfo };

export interface SpeechShare {
	speech_s: number;
	duration_s: number;
	share: number;
	/** Pauses ≥ 0.35 s between words. */
	long_pauses: number;
	longest_pause_s: number;
}

/** Speech seconds (word spans, gaps < `gap` merged) over `duration`. */
export function speechShare(words: TimedWord[], duration: number, gap = 0.35): SpeechShare {
	const spans: Array<[number, number]> = [];
	let longPauses = 0;
	let longest = 0;
	for (const word of [...words].sort((a, b) => a.start - b.start)) {
		const last = spans[spans.length - 1];
		if (last && word.start - last[1] < gap) last[1] = Math.max(last[1], word.end);
		else {
			if (last) {
				longPauses += 1;
				longest = Math.max(longest, word.start - last[1]);
			}
			spans.push([word.start, word.end]);
		}
	}
	const speech = spans.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
	return { speech_s: r3(speech), duration_s: r3(duration), share: duration > 0 ? r3(speech / duration) : 0, long_pauses: longPauses, longest_pause_s: r3(longest) };
}

/** Where to cut: [from, to) inside each pause longer than maxPause, leaving `keep` s (half each side of the cut). */
export function pauseCuts(words: TimedWord[], maxPause: number, keep: number): Array<[number, number]> {
	const cuts: Array<[number, number]> = [];
	for (let i = 0; i + 1 < words.length; i++) {
		const a = words[i].end;
		const b = words[i + 1].start;
		if (b - a > maxPause + 1e-6) cuts.push([r3(a + keep / 2), r3(b - keep / 2)]);
	}
	return cuts.filter(([from, to]) => to - from > 0.01);
}

/** A time in the old take → the new one (removed spans before it subtracted; inside a cut → its start). */
export function shiftTime(time: number, cuts: Array<[number, number]>): number {
	let removed = 0;
	for (const [from, to] of cuts) {
		if (time >= to) removed += to - from;
		else if (time > from) return r3(from - removed);
	}
	return r3(time - removed);
}

export function shiftWords(words: TimedWord[], cuts: Array<[number, number]>): TimedWord[] {
	return words.map((word) => ({ text: word.text, start: shiftTime(word.start, cuts), end: shiftTime(word.end, cuts) }));
}

/** SAPI's stepped speed at or above `speed` (Rate = round(10·log3(speed)) in voice-tts.ps1), clamped to 0.5–2. */
export function sapiSpeedFor(speed: number): number {
	const level = Math.ceil(10 * (Math.log(Math.max(0.5, Math.min(2, speed))) / Math.log(3)) - 1e-9);
	return Math.round(Math.min(2, Math.max(0.5, 3 ** (level / 10))) * 100) / 100;
}

/** Cut the long pauses out of a take (cached by the base take + settings). Returns the base take when nothing is cut. */
export async function tightenTake(
	take: VoiceTake,
	{ maxPause = TIGHTEN_DEFAULTS.maxPause, keep = TIGHTEN_DEFAULTS.keep }: { maxPause?: number; keep?: number } = {},
	signal?: AbortSignal,
): Promise<{ take: TightTake; cached: boolean; cuts: Array<[number, number]> }> {
	const max = Math.max(0.1, Math.min(3, maxPause));
	const kept = Math.max(0.04, Math.min(max, keep));
	const cuts = pauseCuts(take.words, max, kept);
	if (!cuts.length) return { take, cached: true, cuts };
	const key = createHash("sha256").update(JSON.stringify({ tighten: TIGHTEN_VERSION, from: take.key, max: r3(max), keep: r3(kept) })).digest("hex").slice(0, 32);
	const existing = readTake(key) as TightTake | null;
	if (existing) return { take: existing, cached: true, cuts };

	const began = Date.now();
	const dir = voiceDir();
	const tmp = path.join(dir, "tmp", randomUUID());
	mkdirSync(tmp, { recursive: true });
	try {
		// the kept segments, each with an 8 ms fade at a join, then concatenated
		const segments: Array<[number, number]> = [];
		let at = 0;
		for (const [from, to] of cuts) {
			segments.push([at, from]);
			at = to;
		}
		segments.push([at, take.duration_s]);
		const parts = segments.map(([a, b], i) => {
			const len = Math.max(0, b - a);
			const fadeIn = i > 0 ? `,afade=t=in:d=${JOIN_FADE}` : "";
			const fadeOut = i < segments.length - 1 ? `,afade=t=out:st=${Math.max(0, len - JOIN_FADE).toFixed(4)}:d=${JOIN_FADE}` : "";
			return `[0:a]atrim=start=${a.toFixed(4)}:end=${b.toFixed(4)},asetpts=PTS-STARTPTS${fadeIn}${fadeOut}[s${i}]`;
		});
		const graph = `${parts.join(";")};${segments.map((_, i) => `[s${i}]`).join("")}concat=n=${segments.length}:v=0:a=1[out]`;
		const out = path.join(tmp, "tight.wav");
		await ffmpeg(
			["-y", "-i", take.file, "-filter_complex", graph, "-map", "[out]", "-ac", "1", "-ar", String(RATE), "-c:a", "pcm_s16le", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", out],
			{ signal },
		);
		const bytes = readFileSync(out);
		const hash = createHash("sha256").update(bytes).digest("hex");
		const duration = r3(wavDataBytes(bytes) / (RATE * 2));
		const words = shiftWords(take.words, cuts).map((word) => ({ ...word, end: Math.min(word.end, duration) }));
		const engineWords = shiftWords(take.engine_words, cuts);
		const loud = await measureLoudness(out, "", signal);
		const timing = await checkTiming(out, duration, words, engineWords);
		mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${key}.wav`);
		renameSync(out, file);
		const removed = r3(cuts.reduce((sum, [a, b]) => sum + (b - a), 0));
		const tight: TightTake = {
			...take,
			key,
			hash,
			file,
			bytes: bytes.byteLength,
			duration_s: duration,
			words,
			engine_words: engineWords,
			loudness: { ...take.loudness, lufs_i: loud.lufsI, true_peak_dbtp: loud.truePeak, lra: loud.lra },
			timing,
			created_at: new Date().toISOString(),
			ms: Date.now() - began,
			tightened: { from: take.key, max_pause_s: r3(max), keep_s: r3(kept), pauses_cut: cuts.length, removed_s: removed, version: TIGHTEN_VERSION },
		};
		writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(tight, null, 1));
		return { take: tight, cached: false, cuts };
	} finally {
		try {
			if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* harmless: .data/voice/tmp is git-ignored */
		}
	}
}
