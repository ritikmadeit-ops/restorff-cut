/**
 * Does an export play a bed's loop copies back to back without a gap, a click or a drift? (voice-music agent,
 * 2026-10-20). The render (mono 48 kHz) is compared with the ideal = the bed file looped: aligned by cross-correlation
 * (±20 ms) on a 2 s window at ALIGN_AT seconds (default 10), gain-matched there by least squares; then the residual
 * energy in 10 ms windows — median per loop copy, and around each seam vs the file's median.
 *
 *   cd apps/web && bun src/music/seam-check.ts <render.mp4> public/music/tense-100.ogg 19.2 19.2 38.4
 *   (args: render, bed file, loop seconds, seam times…; ALIGN_AT=22 to align inside the second copy)
 *
 * Read it: lag_ms 0 in every copy = sample-aligned copies. A seam is fine when its residual peak is no higher than
 * the peaks at the bed's own downbeats (a mastering limiter and AAC leave residue on every loud transient). A copy
 * that drifted would show a residual near the signal level all through it. The master's gain may drift slowly
 * (MEASURED 1.70 → 1.57 over 40 s on 2026-10-20), which raises the median of the copy you did not align on.
 */
import { spawnSync } from "node:child_process";

const SR = 48_000;
const FFMPEG = process.env.RESTORFFCUT_FFMPEG || process.env.FFMPEG || "ffmpeg";

function decode(file: string): Float32Array {
	const result = spawnSync(FFMPEG, ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "pipe:1"], { maxBuffer: 1 << 30 });
	if (result.error) throw result.error;
	const bytes = new Uint8Array(result.stdout.byteLength);
	bytes.set(result.stdout);
	return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
}

if (import.meta.main) {
	const [render, bed, loopArg, ...seamArgs] = process.argv.slice(2);
	if (!render || !bed || !loopArg) {
		console.error("usage: bun src/music/seam-check.ts <render> <bed file> <loop seconds> <seam seconds…>");
		process.exit(2);
	}
	const audio = decode(render);
	const loop = decode(bed);
	const loopN = Math.round(Number(loopArg) * SR);
	const ideal = new Float32Array(audio.length + SR);
	for (let i = 0; i < ideal.length; i++) ideal[i] = loop[i % loopN];
	const from = Number(process.env.ALIGN_AT ?? 10) * SR;
	const len = 2 * SR;
	let lag = 0;
	let best = Number.NEGATIVE_INFINITY;
	for (let candidate = -960; candidate <= 960; candidate++) {
		let dot = 0;
		for (let i = 0; i < len; i += 2) dot += audio[from + i] * (ideal[from + i + candidate] ?? 0);
		if (dot > best) {
			best = dot;
			lag = candidate;
		}
	}
	let num = 0;
	let den = 0;
	for (let i = 0; i < len; i++) {
		num += audio[from + i] * ideal[from + i + lag];
		den += ideal[from + i + lag] ** 2;
	}
	const gain = num / den;
	const w = Math.round(0.01 * SR);
	const residual: number[] = [];
	const signal: number[] = [];
	for (let k = 0; k + w < audio.length - 2 * SR; k += w) {
		let e = 0;
		let s = 0;
		for (let i = k; i < k + w; i++) {
			const d = audio[i] - gain * (ideal[i + lag] ?? 0);
			e += d * d;
			s += audio[i] * audio[i];
		}
		residual.push(10 * Math.log10(e / w + 1e-12));
		signal.push(10 * Math.log10(s / w + 1e-12));
	}
	const median = (values: number[]) => {
		const sorted = [...values].sort((a, b) => a - b);
		return sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10 : null;
	};
	const copies = [];
	for (let start = 0; start * SR < audio.length - 2 * SR; start += Number(loopArg)) {
		copies.push({ from_s: start, residual_median_db: median(residual.slice(Math.round(((start + 1) * SR) / w), Math.round(((start + Number(loopArg) - 1) * SR) / w))) });
	}
	console.log(JSON.stringify({ lag_ms: (lag / SR) * 1000, gain: Math.round(gain * 10000) / 10000, residual_median_db: median(residual), signal_median_db: median(signal), copies }));
	for (const seam of seamArgs.map(Number)) {
		const k = Math.round((seam * SR) / w);
		const around = residual.slice(k - 3, k + 4);
		if (!around.length) {
			console.log(JSON.stringify({ seam_s: seam, note: "within the last 2 s of the file: not checked" }));
			continue;
		}
		console.log(
			JSON.stringify({
				seam_s: seam,
				residual_db_by_10ms: around.map((v) => Math.round(v * 10) / 10),
				signal_db_by_10ms: signal.slice(k - 3, k + 4).map((v) => Math.round(v * 10) / 10),
				peak_vs_median_db: Math.round((Math.max(...around) - (median(residual) ?? 0)) * 10) / 10,
			}),
		);
	}
}
