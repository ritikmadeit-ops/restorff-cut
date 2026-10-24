#!/usr/bin/env bun
/**
 * Background worker for one MCP render (started detached by ./renders.ts; never imported by Next):
 *
 *   bun apps/web/src/server/renders-worker.ts <render_id> <renders dir>
 *
 * Reads the row (./renders-store.ts), runs the pipeline CLI exactly as Restorff's gateway does
 * (restorff/apps/gateway/src/workers.mjs renderJob): `render <job> --out <job>/render.mp4 --quality <q> --gpu hw`
 * (the editor's own export in headless Chromium against the dev server), then `master` (two-pass loudnorm on the
 * encoded file, −14 LUFS / ≤ −1 dBTP), moves the master into the renders dir, probes it and writes the row
 * (phase, progress, loudness, timings, error). Its stdout/stderr go to the row's log file.
 * Exit 0 = done, 1 = failed (the row says why). Runbook: docs/restorff/worklog/mcp-render.md.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRow, updateRow, type RenderLoudness, type RenderRow } from "./renders-store.ts";

const REPO_ROOT = process.env.RESTORFFCUT_REPO?.trim()
	? path.resolve(process.env.RESTORFFCUT_REPO.trim())
	: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CLI = path.join(REPO_ROOT, "packages", "pipeline", "src", "cli.ts");
const FFPROBE = process.env.RESTORFFCUT_FFPROBE?.trim() || process.env.FFPROBE || "ffprobe";
const GPU = process.env.RESTORFFCUT_RENDER_GPU?.trim() || "hw";

function log(line: string) {
	process.stderr.write(`[renders-worker ${new Date().toISOString()}] ${line}\n`);
}

/** Run a program; stream its stderr to ours (the log) and hand each line to onLine. */
function run(cmd: string, args: string[], onLine?: (line: string) => void): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd: REPO_ROOT, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let pending = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			const text = d.toString();
			stderr = (stderr + text).slice(-20_000);
			process.stderr.write(text);
			pending += text;
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) onLine?.(line);
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

function lastJson<T>(stdout: string): T | null {
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start < 0 || end < start) return null;
	try {
		return JSON.parse(stdout.slice(start, end + 1)) as T;
	} catch {
		return null;
	}
}

interface Probe {
	duration: number | null;
	width: number | null;
	height: number | null;
	fps: number | null;
	video_codec: string | null;
	audio_codec: string | null;
}

async function probe(file: string): Promise<Probe> {
	const r = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
	if (r.code !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr.slice(-300)}`);
	const j = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: Array<Record<string, string | number | undefined>> };
	const v = (j.streams ?? []).find((s) => s.codec_type === "video");
	const a = (j.streams ?? []).find((s) => s.codec_type === "audio");
	const [n, d] = String(v?.avg_frame_rate ?? "0/1").split("/").map(Number);
	// The picture's length: loudnorm's resampling leaves the AAC stream ~0.1 s longer than the video (MEASURED
	// 2026-10-20: video 6.000 s / audio 6.100 s), and the container reports the longer one.
	const videoDuration = v?.duration ? Number(v.duration) : null;
	return {
		duration: videoDuration ?? (j.format?.duration ? Number(j.format.duration) : null),
		width: v?.width ? Number(v.width) : null,
		height: v?.height ? Number(v.height) : null,
		fps: n && d ? Math.round((n / d) * 1000) / 1000 : null,
		video_codec: v ? String(v.codec_name) : null,
		audio_codec: a ? String(a.codec_name) : null,
	};
}

async function main() {
	const [renderId, dir] = process.argv.slice(2);
	if (!renderId || !dir) {
		process.stderr.write("usage: bun renders-worker.ts <render_id> <renders dir>\n");
		process.exit(2);
	}
	const row = readRow(renderId, dir);
	if (!row) throw new Error(`no render row ${renderId} in ${dir}`);
	const t0 = performance.now();
	const patch = (p: Partial<RenderRow>) => updateRow(renderId, p, dir);
	patch({ status: "running", phase: "render", started_at: new Date().toISOString(), pid: process.pid, progress: 0 });
	log(`render ${renderId}: ${row.project_id}@${row.commit.slice(0, 12)} ${row.quality} · job ${row.job_dir} · repo ${REPO_ROOT}`);

	const bun = process.execPath;
	const renderOut = path.join(row.job_dir, "render.mp4");
	const masterOut = path.join(row.job_dir, "master.mp4");

	// 1. the editor's own export, headless (pipeline CLI → scripts/render/render.ts)
	let lastWrite = 0;
	const tRender = performance.now();
	const rendered = await run(
		bun,
		[CLI, "render", row.job_dir, "--out", renderOut, "--quality", row.quality, "--gpu", GPU],
		(line) => {
			const m = /\[render\] (\w+) ([\d.]+)%/.exec(line);
			if (m && Date.now() - lastWrite > 2000) {
				lastWrite = Date.now();
				patch({ progress: Math.min(1, Number(m[2]) / 100) });
			}
		},
	);
	if (rendered.code !== 0 || !existsSync(renderOut)) {
		throw new Error(`pipeline render exit ${rendered.code}: ${rendered.stderr.trim().split(/\r?\n/).slice(-3).join(" | ").slice(-600)}`);
	}
	const renderReport = lastJson<{ timings?: { renderMs?: number }; wallPerOutputSecond?: number }>(rendered.stdout);
	const renderMs = Math.round(performance.now() - tRender);

	// 2. master (needs an audio stream; a silent render is stored as is and the gate's LOUD check says so)
	patch({ phase: "master", progress: 1 });
	const raw = await probe(renderOut);
	let loudness: RenderRow["loudness"] = { before: null, after: null, passes: null, ok: null };
	const tMaster = performance.now();
	if (raw.audio_codec) {
		const mastered = await run(bun, [CLI, "master", renderOut, "--out", masterOut]);
		if (mastered.code !== 0 || !existsSync(masterOut)) {
			throw new Error(`pipeline master exit ${mastered.code}: ${mastered.stderr.trim().split(/\r?\n/).slice(-3).join(" | ").slice(-600)}`);
		}
		const m = lastJson<{ before: RenderLoudness; after: RenderLoudness; passes: number; ok: boolean }>(mastered.stdout);
		loudness = m ? { before: m.before, after: m.after, passes: m.passes, ok: m.ok } : loudness;
		unlinkSync(renderOut); // the unmastered intermediate (the master is the deliverable)
	} else {
		log("the render has no audio stream: stored without mastering");
		renameSync(renderOut, masterOut);
	}
	const masterMs = Math.round(performance.now() - tMaster);

	// 3. store
	patch({ phase: "store" });
	const storeDir = path.join(dir, renderId);
	mkdirSync(storeDir, { recursive: true });
	const stored = path.join(storeDir, "master.mp4");
	try {
		renameSync(masterOut, stored);
	} catch {
		copyFileSync(masterOut, stored);
		unlinkSync(masterOut);
	}
	const info = await probe(stored);
	patch({
		status: "done",
		phase: "done",
		progress: 1,
		finished_at: new Date().toISOString(),
		file: stored,
		bytes: statSync(stored).size,
		duration_s: info.duration === null ? null : Math.round(info.duration * 1000) / 1000,
		width: info.width,
		height: info.height,
		fps: info.fps,
		video_codec: info.video_codec,
		audio_codec: info.audio_codec,
		loudness,
		timings: {
			render_ms: renderReport?.timings?.renderMs ?? renderMs,
			master_ms: masterMs,
			total_ms: Math.round(performance.now() - t0),
			wall_per_output_s: renderReport?.wallPerOutputSecond ?? null,
		},
		error: null,
	});
	log(`done ${stored} (${info.duration} s, ${info.width}x${info.height}, audio ${info.audio_codec ?? "none"})`);
}

main().then(
	() => process.exit(0),
	(error) => {
		const message = error instanceof Error ? error.message : String(error);
		log(`failed: ${message}`);
		const [renderId, dir] = process.argv.slice(2);
		if (renderId && dir) {
			try {
				updateRow(renderId, { status: "failed", phase: "failed", finished_at: new Date().toISOString(), error: message.slice(0, 2000) }, dir);
			} catch {
				/* the row is gone */
			}
		}
		process.exit(1);
	},
);
