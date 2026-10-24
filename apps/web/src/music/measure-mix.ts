/**
 * Measure a rendered mix by spans (voice-music agent, 2026-10-20): EBU R128 integrated loudness + true peak of the whole
 * file, then of each named span (ffmpeg atrim → ebur128), plus its RMS (astats). Used to check that a music bed sits
 * under a voice-over: measure the voiced spans and a music-only span; to get the bed's level UNDER the voice, render
 * again with the VOICE track muted and align the two renders on the music-only span (runbook:
 * docs/restorff/worklog/voice-music.md, "Measure a mix").
 *
 *   cd apps/web && bun src/music/measure-mix.ts <file.mp4|wav> voice1:0.3:2.1 voice2:3.1:5.1 music_only:5.6:7.4
 *
 * Output: one JSON line for the whole file, one per span ({span, from, to, I, TP, momentary_mean, blocks, rms_db}).
 * A span shorter than 0.4 s has no 400 ms block: I reads −70 (gated) — use rms_db there.
 */
import { spawnSync } from "node:child_process";

const FFMPEG = process.env.RESTORFFCUT_FFMPEG || process.env.FFMPEG || "ffmpeg";

function ffmpegLog(args: string[]): string {
	const result = spawnSync(FFMPEG, ["-hide_banner", "-nostats", ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
	if (result.error) throw result.error;
	return result.stderr;
}

export function loudnessOf(file: string, filters = "") {
	const log = ffmpegLog(["-i", file, "-af", `${filters}ebur128=peak=true`, "-f", "null", "-"]);
	const [frames, summary = ""] = log.split("Summary:");
	const I = summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1] ?? null;
	const TP = summary.match(/True peak:\s*[\r\n]+\s*Peak:\s+(-?[\d.]+|-inf)/)?.[1] ?? null;
	const momentary = [...frames.matchAll(/\bM:\s*(-?[\d.]+)/g)].map((m) => Number(m[1])).filter((v) => v > -70);
	return {
		I: I === null ? null : Number(I),
		TP: TP === null || TP === "-inf" ? null : Number(TP),
		momentary_mean: momentary.length ? Math.round((momentary.reduce((a, b) => a + b, 0) / momentary.length) * 10) / 10 : null,
		blocks: momentary.length,
	};
}

export function rmsOf(file: string, filters = ""): number | null {
	const log = ffmpegLog(["-i", file, "-af", `${filters}astats=metadata=0:reset=0`, "-f", "null", "-"]);
	const value = (log.split("Overall").pop() ?? "").match(/RMS level dB:\s*(-?[\d.]+)/)?.[1];
	return value === undefined ? null : Math.round(Number(value) * 10) / 10;
}

if (import.meta.main) {
	const [file, ...spans] = process.argv.slice(2);
	if (!file) {
		console.error("usage: bun src/music/measure-mix.ts <file> name:start:end ...");
		process.exit(2);
	}
	console.log(JSON.stringify({ file, whole: loudnessOf(file) }));
	for (const span of spans) {
		const [name, from, to] = span.split(":");
		const trim = `atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS,`;
		console.log(JSON.stringify({ span: name, from: Number(from), to: Number(to), ...loudnessOf(file, trim), rms_db: rmsOf(file, trim) }));
	}
}
