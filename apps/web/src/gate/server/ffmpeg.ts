/**
 * Server only: run ffprobe / ffmpeg on a rendered file and return the gate's FileMeasures
 * (packages/gate parses the text). Paths and limits live here, in one place:
 *
 *   RESTORFFCUT_FFMPEG        ffmpeg binary (default "ffmpeg" on PATH; verified with ffmpeg 8.1)
 *   RESTORFFCUT_FFPROBE       ffprobe binary (default "ffprobe" on PATH)
 *   RESTORFFCUT_GATE_DIR      temp folder for uploads (default <apps/web>/.data/gate, git-ignored)
 *   RESTORFFCUT_GATE_MAX_MB   upload cap in MB (default 400)
 *   RESTORFFCUT_GATE_KEEP=1   keep the uploaded file after measuring (debugging)
 */
import { spawn } from "node:child_process";
import path from "node:path";
import {
	parseBlackdetect,
	parseEbur128,
	parseFfprobe,
	parseFreezedetect,
	type FileMeasures,
} from "@restorffcut/gate";

export const FFMPEG = process.env.RESTORFFCUT_FFMPEG?.trim() || "ffmpeg";
export const FFPROBE = process.env.RESTORFFCUT_FFPROBE?.trim() || "ffprobe";
export const GATE_MAX_BYTES = Math.max(1, Number(process.env.RESTORFFCUT_GATE_MAX_MB) || 400) * 1024 * 1024;
export const GATE_KEEP = process.env.RESTORFFCUT_GATE_KEEP === "1";

export function resolveGateDir(): string {
	const configured = process.env.RESTORFFCUT_GATE_DIR?.trim();
	if (configured) return path.resolve(configured);
	return path.join(process.cwd(), ".data", "gate");
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	error?: string;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawn(cmd, args, { windowsHide: true, timeout: timeoutMs });
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
		});
		child.stderr.on("data", (d: Buffer) => {
			// ebur128 prints a line per 100 ms; keep only the tail (the Summary block is last).
			stderr = (stderr + d.toString("utf8")).slice(-400_000);
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			resolve({ code: null, stdout, stderr, error: error.message });
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			resolve({ code, stdout, stderr });
		});
	});
}

export async function toolVersions(): Promise<{ ffmpeg: string | null; ffprobe: string | null }> {
	const [a, b] = await Promise.all([run(FFMPEG, ["-version"], 10_000), run(FFPROBE, ["-version"], 10_000)]);
	const first = (r: RunResult) => (r.code === 0 ? (r.stdout.split(/\r?\n/)[0] ?? "").trim() : null);
	return { ffmpeg: first(a), ffprobe: first(b) };
}

/** Measure one encoded file: FORMAT (ffprobe), LOUD (ebur128 true peak), CLEAN (blackdetect + freezedetect). */
export async function measureFile(filePath: string, label: string): Promise<FileMeasures> {
	const errors: FileMeasures["errors"] = [];
	const probeRun = await run(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath], 60_000);
	const probe = probeRun.code === 0 ? parseFfprobe(probeRun.stdout) : null;
	if (!probe) {
		const why = probeRun.error ?? (probeRun.stderr.trim().slice(-300) || "ffprobe failed");
		errors.push({ rule: "FORMAT", why: `ffprobe: ${why}` });
	}
	const timeout = Math.max(120_000, (probe?.duration_s ?? 60) * 4_000);
	const [loudRun, detectRun] = await Promise.all([
		probe && !probe.audio_codec
			? Promise.resolve<RunResult | null>(null)
			: run(
					FFMPEG,
					["-hide_banner", "-nostats", "-i", filePath, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"],
					timeout,
				),
		run(
			FFMPEG,
			[
				"-hide_banner",
				"-nostats",
				"-i",
				filePath,
				"-vf",
				"blackdetect=d=0.08:pix_th=0.10,freezedetect=n=-60dB:d=0.2",
				"-an",
				"-f",
				"null",
				"-",
			],
			timeout,
		),
	]);
	let loudness = null;
	if (loudRun) {
		loudness = loudRun.code === 0 ? parseEbur128(loudRun.stderr) : null;
		if (!loudness) {
			errors.push({
				rule: "LOUD",
				why: `ffmpeg ebur128: ${loudRun.error ?? (loudRun.stderr.trim().slice(-300) || "no summary")}`,
			});
		}
	}
	let black = null;
	let frozen = null;
	if (detectRun.code === 0) {
		black = parseBlackdetect(detectRun.stderr);
		frozen = parseFreezedetect(detectRun.stderr, probe?.duration_s ?? null);
	} else {
		errors.push({
			rule: "CLEAN",
			why: `ffmpeg blackdetect/freezedetect: ${detectRun.error ?? (detectRun.stderr.trim().slice(-300) || "failed")}`,
		});
	}
	return { file: label, probe, loudness, black, frozen, errors };
}
