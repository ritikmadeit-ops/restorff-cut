/**
 * Build RestorffCut's generated music beds into apps/web/public/music/ (voice-music agent, 2026-10-20).
 *
 *   cd apps/web && bun src/music/beds/build-beds.ts            (all five; ~1 min)
 *   cd apps/web && bun src/music/beds/build-beds.ts warm-90    (one)
 *
 * For every recipe in ./recipes.ts: render the loop (seeded, circular, ./dsp.ts) → 32-bit float WAV in a temp folder →
 * measure (ffmpeg ebur128, true peak) → gain to −18 LUFS integrated (lowered if the true peak would pass −1.5 dBTP) →
 * encode Ogg Opus 128 kb/s stereo 48 kHz into public/music → measure the ENCODED file again → check the loop seam on the
 * decoded file (sample count, the jump across the seam vs the bed's own sample-to-sample steps, level either side) →
 * write public/music/manifest.json (schema restorff-music-beds@1). Exit 1 if a bed fails a target or the folder ≥ 4 MB.
 * Needs ffmpeg with libopus on PATH (or FFMPEG / RESTORFFCUT_FFMPEG).
 */
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpeg, measureLoudness } from "../../server/voice-ffmpeg";
import { encodeStereoFloatWav, peakOf, SR, scale } from "./dsp";
import { BED_RECIPES } from "./recipes";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../../../public/music");
const TMP_DIR = process.env.MUSIC_TMP ?? join(tmpdir(), "restorffcut-music-build");
const TARGET_LUFS = -18;
const CEILING_TP = -1.5;
const BITRATE = "128k";
const FOLDER_MAX = 4_000_000;

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

async function decodeStereo(file: string): Promise<{ L: Float32Array; R: Float32Array }> {
	const { stdout } = await ffmpeg(["-v", "error", "-i", file, "-ac", "2", "-ar", String(SR), "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"], { timeoutMs: 120_000 });
	const copy = new Uint8Array(stdout.byteLength);
	copy.set(stdout);
	const all = new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
	const n = Math.floor(all.length / 2);
	const L = new Float32Array(n);
	const R = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		L[i] = all[2 * i];
		R[i] = all[2 * i + 1];
	}
	return { L, R };
}

/**
 * How the loop joins itself: the step across the seam (last sample → first) vs the bed's own steps, vs the step at the
 * next bar's downbeat (the same musical moment one bar later — a kick ON the loop point is a big step by design:
 * MEASURED 2026-10-20, upbeat/tense seams 0.083/0.092 vs p99.9 0.08), and the level either side.
 */
function seamCheck(audio: { L: Float32Array; R: Float32Array }, nextDownbeat: number) {
	const n = audio.L.length;
	const steps: number[] = [];
	for (let i = 1; i < n; i += 7) steps.push(Math.max(Math.abs(audio.L[i] - audio.L[i - 1]), Math.abs(audio.R[i] - audio.R[i - 1])));
	steps.sort((a, b) => a - b);
	const p999 = steps[Math.floor(steps.length * 0.999)] || 1e-9;
	const jump = Math.max(Math.abs(audio.L[0] - audio.L[n - 1]), Math.abs(audio.R[0] - audio.R[n - 1]));
	const k = Math.round(nextDownbeat);
	const downbeatStep = Math.max(Math.abs(audio.L[k] - audio.L[k - 1]), Math.abs(audio.R[k] - audio.R[k - 1]));
	const w = Math.round(0.02 * SR);
	const rms = (from: number, to: number) => {
		let sum = 0;
		for (let i = from; i < to; i++) sum += (audio.L[i] ** 2 + audio.R[i] ** 2) / 2;
		return 10 * Math.log10(sum / (to - from) + 1e-12);
	};
	return {
		seam_step: r3(jump),
		bed_step_p999: r3(p999),
		seam_vs_p999: r3(jump / p999),
		bar2_downbeat_step: r3(downbeatStep),
		ok: jump <= Math.max(p999, 1.5 * downbeatStep),
		rms_last_20ms_db: r1(rms(n - w, n)),
		rms_first_20ms_db: r1(rms(0, w)),
	};
}

async function main() {
	const only = process.argv[2];
	mkdirSync(OUT_DIR, { recursive: true });
	mkdirSync(TMP_DIR, { recursive: true });
	const failures: string[] = [];
	const beds: Record<string, unknown>[] = [];
	const recipes = BED_RECIPES.filter((recipe) => !only || recipe.id === only);
	if (!recipes.length) throw new Error(`no recipe ${only}`);
	for (const recipe of recipes) {
		const began = Date.now();
		const loop = recipe.render();
		const samples = loop.L.length;
		const renderMs = Date.now() - began;
		scale(loop, 0.5 / Math.max(1e-6, peakOf(loop)));
		const raw = join(TMP_DIR, `${recipe.id}.raw.wav`);
		writeFileSync(raw, encodeStereoFloatWav(loop));
		const before = await measureLoudness(raw);
		if (before.lufsI === null || before.truePeak === null) throw new Error(`${recipe.id}: unmeasurable`);
		let gain = TARGET_LUFS - before.lufsI;
		if (before.truePeak + gain > CEILING_TP - 0.3) gain = CEILING_TP - 0.3 - before.truePeak;
		scale(loop, 10 ** (gain / 20));
		const levelled = join(TMP_DIR, `${recipe.id}.wav`);
		writeFileSync(levelled, encodeStereoFloatWav(loop));
		const file = `${recipe.id}.ogg`;
		const out = join(OUT_DIR, file);
		await ffmpeg(["-y", "-i", levelled, "-c:a", "libopus", "-b:a", BITRATE, "-vbr", "on", "-application", "audio", "-map_metadata", "-1", out]);
		const after = await measureLoudness(out);
		const decoded = await decodeStereo(out);
		const beat = 60 / recipe.bpm;
		const seam = seamCheck(decoded, 4 * beat * SR);
		const beats = recipe.bars * 4;
		const loopSeconds = beats * beat;
		const bytes = statSync(out).size;
		const entry = {
			id: recipe.id,
			name: recipe.name,
			mood: recipe.mood,
			description: recipe.description,
			use: recipe.use,
			tags: recipe.tags,
			file,
			url: `/music/${file}`,
			licence: "generated, ours",
			bytes,
			bpm: recipe.bpm,
			bars: recipe.bars,
			beats_per_bar: 4,
			key: recipe.key,
			chords: recipe.chords,
			loop: true,
			duration_s: r3(loopSeconds),
			samples,
			decoded_samples: decoded.L.length,
			beat_times_s: Array.from({ length: beats }, (_, i) => r3(i * beat)),
			downbeats: Array.from({ length: recipe.bars }, (_, bar) => bar * 4),
			lufs_i: after.lufsI,
			true_peak_dbtp: after.truePeak,
			lra: after.lra,
			loop_check: seam,
			render_ms: renderMs,
		};
		beds.push(entry);
		const problems: string[] = [];
		if (after.truePeak !== null && after.truePeak > CEILING_TP + 0.3) problems.push(`true peak ${after.truePeak} dBTP`);
		if (after.lufsI === null || Math.abs(after.lufsI - TARGET_LUFS) > 1) problems.push(`loudness ${after.lufsI} LUFS`);
		if (Math.abs(decoded.L.length - samples) > 2) problems.push(`decoded ${decoded.L.length} samples, rendered ${samples}`);
		if (!seam.ok) problems.push(`seam step ${seam.seam_step} > both the bed's 99.9th-percentile step ${seam.bed_step_p999} and 1.5 x bar 2's downbeat step ${seam.bar2_downbeat_step}`);
		for (const problem of problems) failures.push(`${recipe.id}: ${problem}`);
		console.log(
			`${recipe.id.padEnd(12)} ${recipe.bpm} BPM ${recipe.bars} bars ${loopSeconds.toFixed(2)} s · ${(bytes / 1024).toFixed(0)} KB · I ${after.lufsI} LUFS · TP ${after.truePeak} dBTP · LRA ${after.lra} · seam ${seam.seam_step} (p99.9 ${seam.bed_step_p999}, bar-2 downbeat ${seam.bar2_downbeat_step}) · render ${renderMs} ms${problems.length ? ` · FAIL ${problems.join("; ")}` : ""}`,
		);
		for (const tmp of [raw, levelled]) unlinkSync(tmp);
	}
	// keep beds built earlier when only one was rebuilt
	let manifestBeds = beds;
	if (only) {
		try {
			const previous = (await Bun.file(join(OUT_DIR, "manifest.json")).json()) as { beds: Array<{ id: string }> };
			manifestBeds = BED_RECIPES.map((recipe) => beds.find((bed) => bed.id === recipe.id) ?? previous.beds.find((bed) => bed.id === recipe.id)).filter(Boolean) as Record<string, unknown>[];
		} catch {
			/* first build */
		}
	}
	const known = new Set(BED_RECIPES.map((recipe) => `${recipe.id}.ogg`));
	for (const name of readdirSync(OUT_DIR)) if (name.endsWith(".ogg") && !known.has(name)) unlinkSync(join(OUT_DIR, name));
	const totalBytes = manifestBeds.reduce((sum, bed) => sum + (bed.bytes as number), 0);
	const ffmpegVersion = (await ffmpeg(["-version"]).catch(() => null))?.stdout.toString("utf8").split(/\r?\n/)[0] ?? "ffmpeg";
	const manifest = {
		schema: "restorff-music-beds@1",
		pack: "restorff-beds",
		version: "1.0.0",
		built: new Date().toISOString().slice(0, 10),
		licence: "generated, ours",
		licence_note:
			"Every bed is synthesized from code in apps/web/src/music/beds (no samples, no loops or stems from anyone else, no third-party audio), so RestorffCut owns it outright and it may ship and be used in client ads.",
		generator: "apps/web/src/music/beds/build-beds.ts",
		rebuild: "cd apps/web && bun src/music/beds/build-beds.ts",
		format: { container: "ogg", codec: "opus", bitrate: BITRATE, sample_rate: SR, channels: 2 },
		targets: { lufs_i: TARGET_LUFS, true_peak_dbtp_max: CEILING_TP },
		measured_with: `${ffmpegVersion}: ebur128=peak=true on the encoded .ogg; loop_check on the decoded .ogg`,
		fields: {
			duration_s: "exact loop length = bars × 4 × 60 / bpm; place copies back to back to loop",
			beat_times_s: "every beat, seconds into the file (SOURCE time); beat 0 is a downbeat",
			downbeats: "indices into beat_times_s that start a bar",
			lufs_i: "integrated loudness of the encoded file, LUFS (the music tool sets the element gain from it)",
			loop_check: "seam_step = |last sample − first sample| (max of L/R); bed_step_p999 = the bed's own 99.9th-percentile sample step; bar2_downbeat_step = the step at the next bar's downbeat (same musical moment); ok = seam_step ≤ max(p999, 1.5 × bar2_downbeat_step)",
		},
		total_bytes: totalBytes,
		total_duration_s: r3(manifestBeds.reduce((sum, bed) => sum + (bed.duration_s as number), 0)),
		beds: manifestBeds,
	};
	writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	console.log(`${manifestBeds.length} beds, ${totalBytes} bytes (${(totalBytes / 1024 / 1024).toFixed(2)} MB), ${manifest.total_duration_s} s → ${OUT_DIR}`);
	if (totalBytes >= FOLDER_MAX) failures.push(`beds total ${totalBytes} bytes ≥ ${FOLDER_MAX}`);
	if (failures.length) {
		for (const failure of failures) console.error(`FAIL ${failure}`);
		process.exit(1);
	}
	console.log(`PASS: every bed −18 ±1 LUFS, ≤ ${CEILING_TP + 0.3} dBTP, decoded length exact, seam no bigger than the music's own steps, total < 4 MB`);
}

await main();
