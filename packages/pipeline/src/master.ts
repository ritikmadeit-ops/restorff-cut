/**
 * Loudness mastering on the ENCODED file (EXPORT-GATE LOUD: −14 LUFS ±1, true peak ≤ −1 dBTP; "the mix is not the
 * master"). Two-pass ffmpeg loudnorm (pass 1 measures, pass 2 applies with the measured values, linear when it can),
 * video stream copied untouched, then the result is re-measured with ebur128 (peak=true) on the encoded output. If the
 * re-measure misses the target, one more pass runs with a lower true-peak ceiling.
 */
import { FFMPEG } from "./paths.ts";
import { run } from "./util.ts";

export interface Loudness {
	integratedLufs: number;
	truePeakDbtp: number;
	lra: number;
}

export interface MasterResult {
	input: string;
	output: string;
	before: Loudness;
	after: Loudness;
	passes: number;
	ok: boolean;
	ms: number;
}

const TARGET_I = -14;
const TARGET_TP = -1;
const TOLERANCE_I = 1;

/** ebur128 with true peak, the Judge's instrument (EXPORT-GATE: `ebur128=peak=true`). */
export async function measureLoudness(file: string): Promise<Loudness> {
	const r = await run(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"]);
	if (r.code !== 0) throw new Error(`ebur128 failed on ${file}: ${r.stderr.slice(-400)}`);
	const summary = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
	const num = (re: RegExp) => {
		const m = summary.match(re);
		return m ? Number(m[1]) : Number.NaN;
	};
	return {
		integratedLufs: num(/I:\s+(-?[\d.]+|-inf)\s+LUFS/),
		truePeakDbtp: num(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/),
		lra: num(/LRA:\s+(-?[\d.]+)\s+LU/),
	};
}

interface LoudnormStats {
	input_i: string;
	input_tp: string;
	input_lra: string;
	input_thresh: string;
	target_offset: string;
}

async function loudnormMeasure(file: string, tp: number): Promise<LoudnormStats> {
	const r = await run(FFMPEG, [
		"-hide_banner", "-nostats", "-i", file, "-map", "0:a:0",
		"-af", `loudnorm=I=${TARGET_I}:TP=${tp}:LRA=11:print_format=json`, "-f", "null", "-",
	]);
	if (r.code !== 0) throw new Error(`loudnorm pass 1 failed: ${r.stderr.slice(-400)}`);
	const json = r.stderr.slice(r.stderr.lastIndexOf("{"), r.stderr.lastIndexOf("}") + 1);
	return JSON.parse(json) as LoudnormStats;
}

async function loudnormApply(input: string, output: string, s: LoudnormStats, tp: number, sampleRate: number): Promise<void> {
	const filter =
		`loudnorm=I=${TARGET_I}:TP=${tp}:LRA=11:measured_I=${s.input_i}:measured_TP=${s.input_tp}` +
		`:measured_LRA=${s.input_lra}:measured_thresh=${s.input_thresh}:offset=${s.target_offset}:linear=true`;
	const r = await run(FFMPEG, [
		"-hide_banner", "-nostats", "-y", "-i", input,
		"-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
		"-af", filter, "-ar", String(sampleRate), "-c:a", "aac", "-b:a", "192k",
		"-movflags", "+faststart", output,
	]);
	if (r.code !== 0) throw new Error(`loudnorm pass 2 failed: ${r.stderr.slice(-600)}`);
}

export async function master(input: string, output: string, opts: { sampleRate?: number } = {}): Promise<MasterResult> {
	const started = performance.now();
	const before = await measureLoudness(input);
	let tp = -1.5; // headroom for AAC re-encode overshoot; the re-measure is what counts
	let after: Loudness = before;
	let passes = 0;
	for (; passes < 3; ) {
		passes++;
		const stats = await loudnormMeasure(input, tp);
		await loudnormApply(input, output, stats, tp, opts.sampleRate ?? 48000);
		after = await measureLoudness(output);
		const okI = Math.abs(after.integratedLufs - TARGET_I) <= TOLERANCE_I;
		const okTp = after.truePeakDbtp <= TARGET_TP;
		if (okI && okTp) break;
		tp -= 1;
	}
	const ok = Math.abs(after.integratedLufs - TARGET_I) <= TOLERANCE_I && after.truePeakDbtp <= TARGET_TP;
	return { input, output, before, after, passes, ok, ms: Math.round(performance.now() - started) };
}
