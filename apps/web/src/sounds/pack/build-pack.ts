/**
 * Build RestorffCut's built-in SFX pack "restorff-core" into apps/web/public/sfx/ (sounds agent, 2026-10-20).
 *
 *   cd apps/web && bun src/sounds/pack/build-pack.ts
 *
 * For every recipe in ./recipes.ts: render (seeded, so reproducible) → write a float WAV to a temp folder → measure
 * its true peak with ffmpeg ebur128 → gain it to TARGET_TP → encode 16-bit mono 48 kHz WAV into public/sfx →
 * measure the final file again (ebur128 with peak=true and a 0.5 s silent pad so sounds shorter than one 400 ms
 * block still get a loudness value; astats for sample peak / RMS / crest) → write manifest.json.
 * Fails (exit 1) if any file is above −1 dBTP or the pack is ≥ 3 MB. Needs ffmpeg on PATH (or FFMPEG=<path>).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RECIPES } from "./recipes";
import { durationOf, encodeFloatWav, finish, landmarks } from "./synth";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../../../public/sfx");
const TMP_DIR = process.env.SFX_TMP ?? join(tmpdir(), "restorffcut-sfx-build");
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
/** dBTP. Below the −1 dBTP ceiling, with 0.2 dB of room for the 16-bit rounding. */
const TARGET_TP = -1.2;
const CEILING_TP = -1.0;
const PACK_BYTES_MAX = 3_000_000;

function run(args: string[]): string {
	const result = spawnSync(FFMPEG, ["-hide_banner", "-nostats", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed:\n${result.stderr}`);
	return result.stderr;
}

const number = (text: string | undefined): number | null => {
	if (text === undefined) return null;
	if (/^-?inf$/i.test(text)) return null;
	const value = Number.parseFloat(text);
	return Number.isFinite(value) ? value : null;
};

interface Loudness {
	lufsI: number | null;
	lufsMMax: number | null;
	truePeak: number | null;
}

function measureLoudness(file: string, pad: boolean): Loudness {
	const filters = `${pad ? "apad=pad_dur=0.5," : ""}ebur128=peak=true:framelog=info`;
	const log = run(["-i", file, "-af", filters, "-f", "null", "-"]);
	const [frames, summary = ""] = log.split("Summary:");
	let lufsMMax: number | null = null;
	for (const match of frames.matchAll(/\bM:\s*(-?[\d.]+|-?inf)/g)) {
		const value = number(match[1]);
		if (value !== null && value > -120 && (lufsMMax === null || value > lufsMMax)) lufsMMax = value;
	}
	const lufsI = number(summary.match(/I:\s+(-?[\d.]+|-?inf) LUFS/)?.[1]);
	const truePeak = number(summary.match(/True peak:\s*[\r\n]+\s*Peak:\s+(-?[\d.]+|-?inf)/)?.[1]);
	return { lufsI: lufsI !== null && lufsI <= -70 ? null : lufsI, lufsMMax, truePeak };
}

function measureStats(file: string): { samplePeak: number | null; rms: number | null; crest: number | null } {
	const log = run(["-i", file, "-af", "astats", "-f", "null", "-"]);
	const overall = log.split("Overall").pop() ?? "";
	return {
		samplePeak: number(overall.match(/Peak level dB:\s*(-?[\d.]+|-?inf)/)?.[1]),
		rms: number(overall.match(/RMS level dB:\s*(-?[\d.]+|-?inf)/)?.[1]),
		crest: number(overall.match(/Crest factor:\s*(-?[\d.]+)/)?.[1]),
	};
}

const round = (value: number | null, step = 0.1): number | null =>
	value === null ? null : Math.round(value / step) * step === 0 ? 0 : Number((Math.round(value / step) * step).toFixed(3));

function main(): void {
	mkdirSync(OUT_DIR, { recursive: true });
	mkdirSync(TMP_DIR, { recursive: true });
	const version = run(["-version"]).split("\n")[0] || "ffmpeg";
	const versionLine = spawnSync(FFMPEG, ["-version"], { encoding: "utf8" }).stdout.split("\n")[0]?.trim() || version.trim();

	// stale files from an older pack would otherwise be served forever
	const keep = new Set(RECIPES.map((recipe) => `${recipe.id}.wav`).concat("manifest.json"));
	for (const name of readdirSync(OUT_DIR)) if (name.endsWith(".wav") && !keep.has(name)) unlinkSync(join(OUT_DIR, name));

	const sounds = [];
	const failures: string[] = [];
	let totalBytes = 0;
	let totalSeconds = 0;
	for (const recipe of RECIPES) {
		const signal = finish(recipe.render());
		const raw = join(TMP_DIR, `${recipe.id}.f32.wav`);
		writeFileSync(raw, encodeFloatWav(signal));
		const before = measureLoudness(raw, false);
		if (before.truePeak === null) throw new Error(`${recipe.id}: no true peak measured`);
		const file = join(OUT_DIR, `${recipe.id}.wav`);
		let gainDb = TARGET_TP - before.truePeak;
		let after = before;
		for (let attempt = 0; attempt < 3; attempt++) {
			run([
				"-y",
				"-i",
				raw,
				"-af",
				`volume=${gainDb.toFixed(3)}dB`,
				"-ar",
				"48000",
				"-ac",
				"1",
				"-c:a",
				"pcm_s16le",
				"-map_metadata",
				"-1",
				"-fflags",
				"+bitexact",
				"-flags:a",
				"+bitexact",
				file,
			]);
			after = measureLoudness(file, true);
			if (after.truePeak !== null && after.truePeak <= CEILING_TP) break;
			gainDb -= (after.truePeak ?? 0) - TARGET_TP;
		}
		unlinkSync(raw);
		const stats = measureStats(file);
		const marks = landmarks(signal);
		const bytes = statSync(file).size;
		const duration = durationOf(signal);
		totalBytes += bytes;
		totalSeconds += duration;
		if (after.truePeak === null || after.truePeak > CEILING_TP) failures.push(`${recipe.id}: true peak ${after.truePeak} dBTP`);
		const syncAt = recipe.sync === "peak" ? marks.peakAt : marks.onset;
		const defaultDb =
			after.lufsMMax === null ? -12 : Math.max(-30, Math.min(6, Math.round((recipe.target_lufs_m - after.lufsMMax) * 2) / 2));
		sounds.push({
			id: recipe.id,
			name: recipe.name,
			file: `${recipe.id}.wav`,
			url: `/sfx/${recipe.id}.wav`,
			category: recipe.category,
			tags: recipe.tags,
			roles: recipe.roles,
			description: recipe.description,
			licence: "generated, ours",
			duration_s: round(duration, 0.001),
			bytes,
			sync: recipe.sync,
			sync_s: round(syncAt, 0.001),
			peak_at_s: round(marks.peakAt, 0.001),
			onset_s: round(marks.onset, 0.001),
			true_peak_dbtp: round(after.truePeak),
			sample_peak_dbfs: round(stats.samplePeak, 0.01),
			rms_dbfs: round(stats.rms, 0.01),
			crest_factor: round(stats.crest, 0.01),
			lufs_i: round(after.lufsI),
			lufs_m_max: round(after.lufsMMax),
			target_lufs_m: recipe.target_lufs_m,
			default_db: defaultDb,
			gain_applied_db: round(gainDb, 0.01),
		});
		console.log(
			[
				recipe.id.padEnd(16),
				`${duration.toFixed(3)} s`.padStart(8),
				`${(bytes / 1024).toFixed(0)} KB`.padStart(7),
				`TP ${after.truePeak?.toFixed(1)} dBTP`.padStart(14),
				`I ${after.lufsI?.toFixed(1) ?? "n/a"} LUFS`.padStart(12),
				`Mmax ${after.lufsMMax?.toFixed(1) ?? "n/a"}`.padStart(11),
				`sync ${syncAt.toFixed(3)} s`.padStart(13),
				`default ${defaultDb} dB`,
			].join("  "),
		);
	}
	if (totalBytes >= PACK_BYTES_MAX) failures.push(`pack is ${totalBytes} bytes (limit ${PACK_BYTES_MAX})`);

	const manifest = {
		schema: "restorff-sfx-pack@1",
		pack: "restorff-core",
		version: "1.1.0",
		built: new Date().toISOString().slice(0, 10),
		licence: "generated, ours",
		licence_note:
			"Every sound is synthesized from code in apps/web/src/sounds/pack (no samples, no third-party audio), so RestorffCut owns it outright.",
		generator: "apps/web/src/sounds/pack/build-pack.ts",
		rebuild: "cd apps/web && bun src/sounds/pack/build-pack.ts",
		format: { container: "wav", codec: "pcm_s16le", sample_rate: 48000, channels: 1 },
		targets: { true_peak_dbtp_max: CEILING_TP, pack_bytes_max: PACK_BYTES_MAX },
		measured_with: `${versionLine}: ebur128=peak=true on each file plus 0.5 s of silence (so a sound shorter than one 400 ms block still has a momentary value; silent blocks fall under BS.1770's -70 LUFS gate), astats on the file`,
		fields: {
			sync_s: "seconds into the file where its event is: the loudest 10 ms window (sync=peak) or the first 10 ms window within 20 dB of it (sync=onset); place the sound at event_time - sync_s",
			lufs_m_max: "highest momentary (400 ms) loudness, LUFS",
			lufs_i: "integrated loudness, LUFS (null when every block is gated out)",
			default_db: "suggested element volume (dB) so lufs_m_max lands on target_lufs_m under a -14 LUFS mix",
		},
		total_bytes: totalBytes,
		total_duration_s: round(totalSeconds, 0.001),
		sounds,
	};
	writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	console.log(`\n${sounds.length} sounds, ${totalBytes} bytes (${(totalBytes / 1024 / 1024).toFixed(2)} MB), ${totalSeconds.toFixed(2)} s → ${OUT_DIR}`);
	if (failures.length) {
		console.error(`FAIL\n${failures.join("\n")}`);
		process.exit(1);
	}
	console.log("PASS: every file ≤ −1 dBTP, pack < 3 MB");
}

main();
