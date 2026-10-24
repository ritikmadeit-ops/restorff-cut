/** Small helpers: run a program, probe media, time a step. Node and Bun compatible (no Bun-only APIs). */
import { spawn } from "node:child_process";
import { FFPROBE } from "./paths.ts";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	ms: number;
}

/** Run a program to completion. `echo` streams its output to this process's stderr as it arrives. */
export function run(
	cmd: string,
	args: string[],
	opts: { cwd?: string; env?: Record<string, string | undefined>; echo?: boolean; timeoutMs?: number } = {},
): Promise<RunResult> {
	const started = performance.now();
	return new Promise((resolvePromise, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
			if (opts.echo) process.stderr.write(d);
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString();
			if (opts.echo) process.stderr.write(d);
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (opts.timeoutMs) {
			timer = setTimeout(() => reject(new Error(`${cmd} timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs);
		}
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolvePromise({ code: code ?? -1, stdout, stderr, ms: Math.round(performance.now() - started) });
		});
	});
}

export interface Probe {
	duration: number;
	size: number;
	video: null | {
		codec: string;
		width: number;
		height: number;
		fps: { numerator: number; denominator: number };
		fpsFloat: number;
		frames: number | null;
		duration: number | null;
	};
	audio: null | { codec: string; sampleRate: number; channels: number; duration: number | null };
}

function parseRate(rate: string | undefined): { numerator: number; denominator: number } {
	const [n, d] = String(rate ?? "0/1").split("/").map(Number);
	if (!n || !d) return { numerator: 30, denominator: 1 };
	return { numerator: n, denominator: d };
}

export async function probe(file: string): Promise<Probe> {
	const r = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
	if (r.code !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr.slice(-400)}`);
	const j = JSON.parse(r.stdout) as {
		format: { duration?: string; size?: string };
		streams: Array<Record<string, string | number | undefined>>;
	};
	const v = j.streams.find((s) => s.codec_type === "video");
	const a = j.streams.find((s) => s.codec_type === "audio");
	const fps = parseRate(String(v?.avg_frame_rate ?? v?.r_frame_rate));
	return {
		duration: Number(j.format.duration ?? 0),
		size: Number(j.format.size ?? 0),
		video: v
			? {
					codec: String(v.codec_name),
					width: Number(v.width),
					height: Number(v.height),
					fps,
					fpsFloat: fps.numerator / fps.denominator,
					frames: v.nb_frames ? Number(v.nb_frames) : null,
					duration: v.duration ? Number(v.duration) : null,
				}
			: null,
		audio: a
			? {
					codec: String(a.codec_name),
					sampleRate: Number(a.sample_rate),
					channels: Number(a.channels),
					duration: a.duration ? Number(a.duration) : null,
				}
			: null,
	};
}

export function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)} s`;
}

/** Time an async step and print `[step] done in N s`. */
export async function step<T>(name: string, timings: Record<string, number>, fn: () => Promise<T>): Promise<T> {
	const started = performance.now();
	console.error(`\n[${name}] start`);
	try {
		return await fn();
	} finally {
		const ms = Math.round(performance.now() - started);
		timings[name] = ms;
		console.error(`[${name}] ${seconds(ms)}`);
	}
}
