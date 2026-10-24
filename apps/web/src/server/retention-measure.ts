/**
 * Retention measurer, the ffmpeg half (agent retention, 2026-10-24). One measurer for the gate (`check`), `look`, the
 * `retention` tool and tools/mcp-test/score.py (via apps/web/scripts/retention.ts): the maths and the constants are in
 * packages/gate/src/retention.ts (score.py 0.1.1's detectors).
 *
 *   measureRetention(file)   → RetentionMap  (three ffmpeg runs in parallel, ~0.1-0.2x real time on this PC)
 *     grey frames   ffmpeg -i f -vf fps=15,scale=135:240:flags=area,format=gray -f rawvideo -     (streamed, diffed)
 *     scene cuts    ffmpeg -i f -an -vf select='gt(scene,0.3)',showinfo -f null -                (pts_time from stderr)
 *     sound         ffmpeg -i f -vn -ac 1 -ar 11025 -f s16le -                                    (onsets)
 *
 * Cache: <RESTORFFCUT_GATE_DIR or apps/web/.data/gate>/retention/<sha1(path|size|mtime)>.json, version RETENTION_CACHE.
 * Binaries: RESTORFFCUT_FFMPEG / RESTORFFCUT_FFPROBE (../gate/server/ffmpeg.ts). Imports are relative on purpose so the
 * CLI (apps/web/scripts/retention.ts) runs it without the Next.js path aliases.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { audioOnsets, RETENTION_DETECTOR, retentionMap, type RetentionMap } from "@restorffcut/gate";
import { FFMPEG, FFPROBE, resolveGateDir } from "../gate/server/ffmpeg";

export const RETENTION_CACHE = 2;

interface Spawned {
	code: number | null;
	error?: string;
	stderrTail: string;
}

/** Run a binary; stdout chunks go to `onData`, stderr lines to `onLine` (only the tail is kept). */
function runStreaming(cmd: string, args: string[], opts: { onData?: (chunk: Buffer) => void; onLine?: (line: string) => void; timeoutMs?: number; signal?: AbortSignal }): Promise<Spawned> {
	return new Promise((resolve) => {
		let settled = false;
		let tail = "";
		let partial = "";
		const child = spawn(cmd, args, { windowsHide: true, timeout: opts.timeoutMs ?? 600_000 });
		const abort = () => child.kill();
		opts.signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (d: Buffer) => opts.onData?.(d));
		child.stderr.on("data", (d: Buffer) => {
			const text = d.toString("utf8");
			tail = (tail + text).slice(-4000);
			if (!opts.onLine) return;
			partial += text;
			const lines = partial.split(/\r?\n/);
			partial = lines.pop() ?? "";
			for (const line of lines) opts.onLine(line);
		});
		const done = (out: Spawned) => {
			if (settled) return;
			settled = true;
			opts.signal?.removeEventListener("abort", abort);
			if (partial && opts.onLine) opts.onLine(partial);
			resolve(out);
		};
		child.on("error", (error) => done({ code: null, error: error.message, stderrTail: tail }));
		child.on("close", (code) => done({ code, stderrTail: tail }));
	});
}

export interface ProbeLite {
	duration_s: number;
	has_audio: boolean;
	width: number | null;
	height: number | null;
	fps: number | null;
}

export async function probeLite(file: string, signal?: AbortSignal): Promise<ProbeLite> {
	const chunks: Buffer[] = [];
	const r = await runStreaming(FFPROBE, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", file], { onData: (c) => chunks.push(c), timeoutMs: 60_000, signal });
	if (r.code !== 0) throw new Error(`ffprobe could not read ${path.basename(file)}: ${r.error ?? r.stderrTail.slice(-300)}`);
	const j = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { format?: { duration?: string }; streams?: Array<Record<string, unknown>> };
	const v = j.streams?.find((s) => s.codec_type === "video");
	const [n, d] = String(v?.r_frame_rate ?? "0/1").split("/").map(Number);
	return {
		duration_s: Math.round(Number(j.format?.duration ?? 0) * 100) / 100,
		has_audio: Boolean(j.streams?.some((s) => s.codec_type === "audio")),
		width: typeof v?.width === "number" ? v.width : null,
		height: typeof v?.height === "number" ? v.height : null,
		fps: n && d ? Math.round((n / d) * 100) / 100 : null,
	};
}

/** Per-frame mean absolute grey change at 135×240, 15 fps (streamed: two frames in memory). */
export async function greyDiffs(file: string, signal?: AbortSignal): Promise<number[]> {
	const { fps, width, height } = RETENTION_DETECTOR;
	const size = width * height;
	const diffs: number[] = [];
	let prev: Buffer | null = null;
	let pending: Buffer = Buffer.alloc(0);
	const r = await runStreaming(FFMPEG, ["-v", "error", "-i", file, "-vf", `fps=${fps},scale=${width}:${height}:flags=area,format=gray`, "-f", "rawvideo", "-"], {
		signal,
		onData: (chunk) => {
			pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
			let o = 0;
			while (pending.length - o >= size) {
				const frame = Buffer.from(pending.subarray(o, o + size));
				o += size;
				if (prev) {
					let sum = 0;
					for (let i = 0; i < size; i++) {
						const d = frame[i] - prev[i];
						sum += d < 0 ? -d : d;
					}
					diffs.push(sum / size);
				}
				prev = frame;
			}
			pending = pending.subarray(o);
		},
	});
	if (r.code !== 0) throw new Error(`ffmpeg could not decode ${path.basename(file)}: ${r.error ?? r.stderrTail.slice(-300)}`);
	return diffs;
}

/** ffmpeg scene cuts (> 0.3), seconds. */
export async function sceneCuts(file: string, signal?: AbortSignal): Promise<number[]> {
	const cuts: number[] = [];
	const r = await runStreaming(FFMPEG, ["-hide_banner", "-i", file, "-an", "-vf", `select='gt(scene,${RETENTION_DETECTOR.scene})',showinfo`, "-f", "null", "-"], {
		signal,
		onLine: (line) => {
			const m = /pts_time:([0-9.]+)/.exec(line);
			if (m) cuts.push(Math.round(Number(m[1]) * 1000) / 1000);
		},
	});
	if (r.code !== 0) throw new Error(`ffmpeg scene detection failed on ${path.basename(file)}: ${r.error ?? r.stderrTail.slice(-300)}`);
	return cuts;
}

/** Mono 16-bit PCM at 11025 Hz → onsets (s). */
export async function soundOnsets(file: string, signal?: AbortSignal): Promise<number[]> {
	const chunks: Buffer[] = [];
	const r = await runStreaming(FFMPEG, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(RETENTION_DETECTOR.sample_rate), "-f", "s16le", "-"], { signal, onData: (c) => chunks.push(c) });
	if (r.code !== 0) throw new Error(`ffmpeg could not decode the sound of ${path.basename(file)}: ${r.error ?? r.stderrTail.slice(-300)}`);
	const raw = Buffer.concat(chunks);
	const n = raw.length >> 1;
	const pcm = new Int16Array(n);
	for (let i = 0; i < n; i++) pcm[i] = raw.readInt16LE(i * 2);
	return audioOnsets(pcm);
}

function cacheFile(file: string): string | null {
	try {
		const st = statSync(file);
		const key = createHash("sha1").update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}|v${RETENTION_CACHE}`).digest("hex");
		const dir = path.join(resolveGateDir(), "retention");
		mkdirSync(dir, { recursive: true });
		return path.join(dir, `${key}.json`);
	} catch {
		return null;
	}
}

export interface MeasuredRetention {
	map: RetentionMap;
	probe: ProbeLite;
	ms: number;
	cached: boolean;
}

/** The retention map of an encoded file (cached per path + size + mtime). */
export async function measureRetention(file: string, opts: { signal?: AbortSignal; cache?: boolean } = {}): Promise<MeasuredRetention> {
	const started = Date.now();
	const cached = opts.cache === false ? null : cacheFile(file);
	if (cached && existsSync(cached)) {
		try {
			const c = JSON.parse(readFileSync(cached, "utf8")) as { v: number; map: RetentionMap; probe: ProbeLite };
			if (c.v === RETENTION_CACHE && c.map?.measurer) return { map: c.map, probe: c.probe, ms: Date.now() - started, cached: true };
		} catch {
			/* measure again */
		}
	}
	const probe = await probeLite(file, opts.signal);
	const [diffs, cuts, onsets] = await Promise.all([greyDiffs(file, opts.signal), sceneCuts(file, opts.signal), probe.has_audio ? soundOnsets(file, opts.signal) : Promise.resolve(null)]);
	const map = retentionMap({ duration: probe.duration_s, diffs, cuts, onsets });
	if (cached) {
		try {
			writeFileSync(cached, JSON.stringify({ v: RETENTION_CACHE, file: path.resolve(file), map, probe }));
		} catch {
			/* the cache is an optimisation */
		}
	}
	return { map, probe, ms: Date.now() - started, cached: false };
}
