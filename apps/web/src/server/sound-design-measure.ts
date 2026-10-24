/**
 * Measure a rendered cut's sound sync (sound-voice-v2 agent, 2026-10-20): visible cuts vs audio onsets, loudness.
 * The same method the paper-collage recreation used on the reel and on our render (recreations/paper-collage REPORT §5),
 * ported from its measure.py so the numbers compare:
 *   - cuts: ffmpeg `select='gt(scene,THR)'` + showinfo pts_time (THR 0.3), merged when closer than --merge s (0.2);
 *   - onsets: mono 11025 Hz PCM, RMS energy per 256-sample hop (23 ms) in dB, strength = energy − mean of the previous 8
 *     hops (184 ms), local peaks ≥ 6 dB, ≥ 0.10 s apart; the onset time is the hop's start;
 *   - a cut is "on a hit" when an onset lies within ±W s (W = --window, 0.05; the recreation used 0.10, also printed);
 *     chance = the share of the timeline within ±W of an onset (what random cuts would score);
 *   - loudness: ffmpeg ebur128 integrated LUFS + true peak.
 *
 *   cd apps/web && bun src/server/sound-design-measure.ts <video> [--times 1.5,4,…] [--threshold 0.3] [--merge 0.2]
 *                                                         [--window 0.05] [--json]
 * --times uses these cut times instead of scene detection (e.g. the timeline's own cut list).
 * Needs ffmpeg + ffprobe on PATH (RESTORFFCUT_FFMPEG / FFMPEG override ffmpeg). Read-only.
 */
import { spawnSync } from "node:child_process";

const FFMPEG = process.env.RESTORFFCUT_FFMPEG || process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";

export interface SyncMeasure {
	file: string;
	duration_s: number;
	cuts: number[];
	cuts_source: string;
	onsets: number[];
	window_s: number;
	on_hit: number;
	on_hit_share: number;
	on_hit_010: number;
	chance_share: number;
	per_cut: Array<{ cut: number; nearest_onset_offset_s: number | null }>;
	loudness: { lufs_i: number | null; true_peak_dbtp: number | null };
}

function run(bin: string, args: string[], binary = false) {
	const out = spawnSync(bin, args, { encoding: binary ? "buffer" : "utf8", maxBuffer: 1024 * 1024 * 1024 });
	if (out.error) throw out.error;
	return out;
}

/** Scene-change times (s) from ffmpeg's scene score, merged when closer than `merge`. */
export function sceneCuts(file: string, threshold = 0.3, merge = 0.2): number[] {
	const r = run(FFMPEG, ["-hide_banner", "-i", file, "-an", "-vf", `select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"]);
	const times = [...String(r.stderr).matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number.parseFloat(m[1])).sort((a, b) => a - b);
	const merged: number[] = [];
	for (const t of times) if (!merged.length || t - merged[merged.length - 1] >= merge) merged.push(t);
	return merged;
}

/** Onset times (s): the recreation's detector (23 ms RMS hops, ≥ 6 dB over the previous 184 ms, ≥ 0.10 s apart). */
export function audioOnsets(file: string): number[] {
	const SR = 11025;
	const HOP = 256;
	const r = run(FFMPEG, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], true);
	const buf = r.stdout as Buffer;
	const n = Math.floor(buf.length / 2);
	const energy: number[] = [];
	for (let k = 0; k + HOP < n; k += HOP) {
		let sum = 0;
		for (let i = k; i < k + HOP; i++) {
			const v = buf.readInt16LE(i * 2);
			sum += v * v;
		}
		energy.push(10 * Math.log10(sum / HOP + 1e-9));
	}
	const strength = new Array<number>(energy.length).fill(0);
	for (let k = 8; k < energy.length; k++) {
		let mean = 0;
		for (let j = k - 8; j < k; j++) mean += energy[j];
		strength[k] = Math.max(0, energy[k] - mean / 8);
	}
	const onsets: number[] = [];
	let last = -1;
	for (let k = 1; k < strength.length - 1; k++) {
		if (strength[k] >= 6 && strength[k] >= strength[k - 1] && strength[k] >= strength[k + 1]) {
			const t = (k * HOP) / SR;
			if (t - last >= 0.1) {
				onsets.push(Math.round(t * 1000) / 1000);
				last = t;
			}
		}
	}
	return onsets;
}

export function loudness(file: string): { lufs_i: number | null; true_peak_dbtp: number | null } {
	const r = run(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]);
	const text = String(r.stderr);
	const summary = text.split("Summary:").pop() ?? "";
	const i = summary.match(/I:\s+(-?[0-9.]+) LUFS/);
	const tp = summary.match(/Peak:\s+(-?[0-9.]+) dBFS/);
	return { lufs_i: i ? Number.parseFloat(i[1]) : null, true_peak_dbtp: tp ? Number.parseFloat(tp[1]) : null };
}

export function measureSync(file: string, opts: { times?: number[]; threshold?: number; merge?: number; window?: number } = {}): SyncMeasure {
	const probe = run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
	const duration = Number.parseFloat(String(probe.stdout).trim());
	const W = opts.window ?? 0.05;
	const cuts = opts.times ?? sceneCuts(file, opts.threshold ?? 0.3, opts.merge ?? 0.2);
	const onsets = audioOnsets(file);
	const near = (c: number, w: number) => onsets.some((o) => Math.abs(o - c) <= w + 1e-9);
	const onHit = cuts.filter((c) => near(c, W)).length;
	const onHit010 = cuts.filter((c) => near(c, 0.1)).length;
	let covered = 0;
	let total = 0;
	for (let g = 0; g < duration; g += 0.01) {
		total += 1;
		if (near(g, W)) covered += 1;
	}
	const r3 = (v: number) => Math.round(v * 1000) / 1000;
	return {
		file,
		duration_s: r3(duration),
		cuts: cuts.map(r3),
		cuts_source: opts.times ? "given" : `scene>${opts.threshold ?? 0.3}, merged <${opts.merge ?? 0.2} s`,
		onsets,
		window_s: W,
		on_hit: onHit,
		on_hit_share: cuts.length ? r3(onHit / cuts.length) : 0,
		on_hit_010: onHit010,
		chance_share: total ? r3(covered / total) : 0,
		per_cut: cuts.map((cut) => {
			let best: number | null = null;
			for (const o of onsets) if (Math.abs(o - cut) <= 0.5 && (best === null || Math.abs(o - cut) < Math.abs(best))) best = o - cut;
			return { cut: r3(cut), nearest_onset_offset_s: best === null ? null : r3(best) };
		}),
		loudness: loudness(file),
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const file = args.find((a) => !a.startsWith("--") && !/^[0-9.,]+$/.test(a));
	if (!file) {
		console.error("usage: bun src/server/sound-design-measure.ts <video> [--times a,b,…] [--threshold 0.3] [--merge 0.2] [--window 0.05] [--json]");
		process.exit(2);
	}
	const flag = (name: string) => {
		const i = args.indexOf(name);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const times = flag("--times")?.split(",").filter(Boolean).map(Number);
	const result = measureSync(file, {
		times,
		threshold: flag("--threshold") ? Number(flag("--threshold")) : undefined,
		merge: flag("--merge") ? Number(flag("--merge")) : undefined,
		window: flag("--window") ? Number(flag("--window")) : undefined,
	});
	if (args.includes("--json")) console.log(JSON.stringify(result, null, 1));
	else {
		console.log(`file ${result.file}`);
		console.log(`duration_s ${result.duration_s}`);
		console.log(`cuts (${result.cuts_source}) ${result.cuts.length} -> ${((10 * result.cuts.length) / result.duration_s).toFixed(2)} per 10 s`);
		console.log(`cut_times ${JSON.stringify(result.cuts)}`);
		console.log(`onsets ${result.onsets.length} (${((10 * result.onsets.length) / result.duration_s).toFixed(1)} per 10 s)`);
		console.log(`cuts_on_hit (±${result.window_s} s) ${result.on_hit}/${result.cuts.length} = ${(100 * result.on_hit_share).toFixed(1)} %  chance ${(100 * result.chance_share).toFixed(1)} %  (±0.10 s: ${result.on_hit_010}/${result.cuts.length})`);
		console.log(`loudness_I ${result.loudness.lufs_i} LUFS  true_peak ${result.loudness.true_peak_dbtp} dBFS`);
		for (const c of result.per_cut) console.log(`  cut ${c.cut.toFixed(2).padStart(6)}: nearest onset ${c.nearest_onset_offset_s === null ? "none within 0.5 s" : `${c.nearest_onset_offset_s >= 0 ? "+" : ""}${c.nearest_onset_offset_s.toFixed(3)} s`}`);
	}
}
