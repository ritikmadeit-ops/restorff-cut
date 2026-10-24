/**
 * `look` for the standalone MCP: frames of the newest rendered file of a timeline, as JPEGs (≤ 12).
 *
 * The editor keeps media in the browser, so the server cannot draw a timeline itself. What it can see are the
 * pipeline agent's headless render jobs (`app/(render)/api/render-jobs/jobs-dir.ts`): folders with project.json and
 * render.mp4 / master.mp4. A job matches when its folder name or its project.json `metadata.id` is the timeline id.
 * No render → `not_built`, said plainly. FFmpeg: $RESTORFFCUT_FFMPEG / $RESTORFFCUT_FFPROBE, else on PATH.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { jobsRoot, resolveJobDir } from "@/app/(render)/api/render-jobs/jobs-dir";

export interface FoundRender {
	job: string;
	file: string;
	mtime: string;
}

const RENDER_FILES = ["master.mp4", "render.mp4"];

export function findLatestRender(timelineId: string): FoundRender | null {
	const root = jobsRoot();
	if (!existsSync(root)) return null;
	const names = new Set<string>();
	for (const entry of readdirSync(root)) names.add(entry.endsWith(".path") ? entry.slice(0, -5) : entry);
	let best: (FoundRender & { ms: number }) | null = null;
	for (const job of names) {
		const dir = resolveJobDir(job);
		if (!dir) continue;
		let projectId: string | null = null;
		try {
			const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as { metadata?: { id?: string } };
			projectId = project.metadata?.id ?? null;
		} catch {
			projectId = null;
		}
		if (job !== timelineId && projectId !== timelineId) continue;
		for (const name of RENDER_FILES) {
			const file = join(dir, name);
			if (!existsSync(file)) continue;
			const ms = statSync(file).mtimeMs;
			if (!best || ms > best.ms) best = { job, file, ms, mtime: new Date(ms).toISOString() };
			break;
		}
	}
	return best ? { job: best.job, file: best.file, mtime: best.mtime } : null;
}

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { windowsHide: true, signal });
		const chunks: Buffer[] = [];
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(Buffer.concat(chunks));
			else reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`));
		});
	});
}

export async function probeDuration(file: string, signal?: AbortSignal): Promise<number> {
	const ffprobe = process.env.RESTORFFCUT_FFPROBE || "ffprobe";
	const out = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], signal);
	const seconds = Number.parseFloat(out.toString().trim());
	if (!Number.isFinite(seconds)) throw new Error("ffprobe could not read the duration");
	return seconds;
}

/** `count` frames evenly spread over [t0, t1] (seconds), 270 px wide JPEGs, base64. */
export async function grabFrames({
	file,
	t0,
	t1,
	count,
	signal,
}: {
	file: string;
	t0: number;
	t1: number;
	count: number;
	signal?: AbortSignal;
}): Promise<Array<{ t: number; data: string }>> {
	const ffmpeg = process.env.RESTORFFCUT_FFMPEG || "ffmpeg";
	const times = Array.from({ length: count }, (_, i) => (count === 1 ? (t0 + t1) / 2 : t0 + ((t1 - t0) * (i + 0.5)) / count));
	const frames: Array<{ t: number; data: string }> = [];
	for (const t of times) {
		const jpeg = await run(
			ffmpeg,
			["-v", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=270:-2", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "5", "pipe:1"],
			signal,
		);
		if (jpeg.length) frames.push({ t: Math.round(t * 100) / 100, data: jpeg.toString("base64") });
	}
	return frames;
}
