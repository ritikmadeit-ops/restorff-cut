/**
 * Silence-aware word timings. Whisper stretches a word's timing across a pause and merges a repeated phrase into one
 * (READ in the planted test, 2026-10-20: "This tool is … [1.2 s silence] … This tool is called" came back as
 * "This tool is called@4.58-6.38" — the pause hidden inside "called"). The transcript-only cutter then keeps the
 * pause. Here the audio's own silences (ffmpeg silencedetect) clip any word that overlaps them, so the pause becomes
 * a gap between words and `cutFromTranscript` removes it.
 */
import type { TimedWord } from "@restorffcut/timeline-ops";
import { FFMPEG } from "./paths.ts";
import { run } from "./util.ts";

export interface Silence {
	start: number;
	end: number;
}

/** Silent intervals of at least `minSeconds` below `noiseDb` (dBFS). */
export async function detectSilences(file: string, opts: { noiseDb?: number; minSeconds?: number } = {}): Promise<Silence[]> {
	const noise = opts.noiseDb ?? -40;
	const d = opts.minSeconds ?? 0.35;
	const r = await run(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-map", "0:a:0", "-af", `silencedetect=noise=${noise}dB:d=${d}`, "-f", "null", "-"]);
	if (r.code !== 0) throw new Error(`silencedetect failed: ${r.stderr.slice(-400)}`);
	const out: Silence[] = [];
	let open: number | null = null;
	for (const line of r.stderr.split(/\r?\n/)) {
		const s = line.match(/silence_start:\s*(-?[\d.]+)/);
		if (s) open = Math.max(0, Number(s[1]));
		const e = line.match(/silence_end:\s*(-?[\d.]+)/);
		if (e && open !== null) {
			out.push({ start: open, end: Number(e[1]) });
			open = null;
		}
	}
	if (open !== null) out.push({ start: open, end: Number.POSITIVE_INFINITY });
	return out;
}

/**
 * Clip every word that overlaps a silence to its longest non-silent side. A word wholly inside a silence keeps its
 * timing (the recogniser heard something; don't drop words). Returns the new words and how many were clipped.
 */
export function clipWordsToSilences(words: readonly TimedWord[], silences: readonly Silence[], minWord = 0.06): { words: TimedWord[]; clipped: number } {
	let clipped = 0;
	const result = words.map((word) => {
		let { start, end } = word;
		for (const s of silences) {
			if (s.end <= start || s.start >= end) continue;
			const before = s.start - start; // speech before the silence
			const after = end - s.end; // speech after the silence
			if (before < minWord && after < minWord) continue; // word inside the silence: leave it
			if (after >= before) start = s.end;
			else end = s.start;
		}
		if (start !== word.start || end !== word.end) clipped++;
		return { ...word, start, end };
	});
	return { words: result, clipped };
}
