/**
 * Frames of a rendered file for MCP `look` (EDT-09: Claude sees its own edit): contact sheets (one image per second,
 * that second's 7 frames tiled left to right — the gateway's `contactSheets`, TVF's view_seconds idea) or stills at
 * given times. JPEG, base64. FFmpeg: $RESTORFFCUT_FFMPEG / $RESTORFFCUT_FFPROBE, else on PATH.
 */
import { spawn } from "node:child_process";

const FFMPEG = () => process.env.RESTORFFCUT_FFMPEG?.trim() || "ffmpeg";
const FFPROBE = () => process.env.RESTORFFCUT_FFPROBE?.trim() || "ffprobe";

function run(cmd: string, args: string[], signal?: AbortSignal, timeoutMs = 30_000): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { windowsHide: true, signal, timeout: timeoutMs });
		const chunks: Buffer[] = [];
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			err = (err + chunk.toString()).slice(-2000);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(Buffer.concat(chunks));
			else reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`));
		});
	});
}

export async function probeDurationS(file: string, signal?: AbortSignal): Promise<number> {
	const out = await run(FFPROBE(), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], signal);
	const seconds = Number.parseFloat(out.toString().trim());
	if (!Number.isFinite(seconds)) throw new Error("ffprobe could not read the duration");
	return seconds;
}

/** Run `fn` over `items` with at most `limit` at a time, keeping order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return out;
}

export interface Sheet {
	second: number;
	data: string;
	mimeType: "image/jpeg";
}

/**
 * One image per whole second in [t0, t1), at most `max`: that second's 7 frames (fps=7) at `height` px, tiled 7x1.
 * A 9:16 render at height 360 gives a 1421x360 sheet (frames 203 px wide).
 */
export async function contactSheets(
	file: string,
	opts: { t0?: number; t1?: number | null; max?: number; height?: number; duration?: number; signal?: AbortSignal } = {},
): Promise<{ duration_s: number; sheets: Sheet[]; next_t0: number | null }> {
	const duration = opts.duration ?? (await probeDurationS(file, opts.signal));
	const max = Math.max(1, Math.min(12, opts.max ?? 12));
	const start = Math.max(0, Math.floor(opts.t0 ?? 0));
	const end = Math.min(opts.t1 == null ? duration : opts.t1, duration);
	const seconds: number[] = [];
	for (let s = start; s < end && seconds.length < max; s += 1) seconds.push(s);
	const height = opts.height ?? 360;
	const sheets = await pool(seconds, 4, async (second) => {
		const jpg = await run(
			FFMPEG(),
			[
				"-v", "error", "-ss", String(second), "-t", "1", "-i", file,
				"-vf", `fps=7,scale=-2:${height},tile=7x1`, "-frames:v", "1",
				"-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "pipe:1",
			],
			opts.signal,
		);
		return { second, data: jpg.toString("base64"), mimeType: "image/jpeg" as const };
	});
	const last = seconds.at(-1);
	const nextT0 = last !== undefined && last + 1 < end - 0.05 ? last + 1 : null;
	return { duration_s: Math.round(duration * 100) / 100, sheets: sheets.filter((s) => s.data.length > 0), next_t0: nextT0 };
}

export interface Still {
	t: number;
	data: string;
	mimeType: "image/jpeg";
}

// ─── effects-v2 (additive, 2026-10-20): one scene from its layers' own files — look {kind: "clip"} ──────────────

/** One layer of a scene still: a frame of `file` at `at` seconds, placed on the canvas by `place` (ffmpeg filters). */
export interface StillLayer {
	file: string;
	at: number;
	/** VP9 WebM with alpha (composition renders, person cutouts): decoded with libvpx-vp9 so the alpha survives. */
	alpha?: boolean;
	/** Filters that put the frame where it sits on the canvas, after format=rgba (default: scale to the canvas). */
	place?: string[];
}

/**
 * One JPEG of layers composited bottom → top over black, canvas size, long side `maxSide` (432x768 for 9:16) —
 * no timeline render: straight from the files on disk (composition renders, the clip's media, person.webm).
 */
export async function compositeStill(
	canvas: { width: number; height: number },
	layers: StillLayer[],
	opts: { maxSide?: number; signal?: AbortSignal } = {},
): Promise<{ data: string; mimeType: "image/jpeg" }> {
	const side = opts.maxSide ?? 768;
	const args: string[] = ["-v", "error", "-f", "lavfi", "-i", `color=c=black:s=${canvas.width}x${canvas.height}:d=1`];
	for (const layer of layers) {
		if (layer.alpha) args.push("-c:v", "libvpx-vp9");
		args.push("-ss", Math.max(0, layer.at).toFixed(3), "-i", layer.file);
	}
	const chain: string[] = ["[0:v]format=rgba[b0]"];
	layers.forEach((layer, i) => {
		const place = layer.place?.length ? layer.place : [`scale=${canvas.width}:${canvas.height}`];
		// after an input seek the first frame can carry a small positive pts (the frame after the seek point); the one
		// output frame is at pts 0, so without the rebase that layer is not drawn at all (SEEN: Cover Story at 0.64 s)
		chain.push(`[${i + 1}:v]setpts=PTS-STARTPTS,format=rgba,${place.join(",")}[l${i + 1}]`, `[b${i}][l${i + 1}]overlay=0:0:format=auto:eof_action=pass[b${i + 1}]`);
	});
	const scale = `scale='if(gt(iw,ih),min(${side},iw),-2)':'if(gt(iw,ih),-2,min(${side},ih))'`;
	chain.push(`[b${layers.length}]${scale},format=yuvj420p[out]`);
	args.push("-filter_complex", chain.join(";"), "-map", "[out]", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3", "pipe:1");
	const jpg = await run(FFMPEG(), args, opts.signal, 45_000);
	return { data: jpg.toString("base64"), mimeType: "image/jpeg" };
}

/** The frame at each time (exact seek), long side `maxSide` px (a 9:16 render → 432x768). At most 12. */
export async function stills(
	file: string,
	times: number[],
	opts: { maxSide?: number; duration?: number; signal?: AbortSignal } = {},
): Promise<{ duration_s: number; stills: Still[] }> {
	const duration = opts.duration ?? (await probeDurationS(file, opts.signal));
	const side = opts.maxSide ?? 768;
	const lastFrame = Math.max(0, duration - 0.04);
	const wanted = times.slice(0, 12).map((t) => Math.min(Math.max(0, t), lastFrame));
	const scale = `scale='if(gt(iw,ih),min(${side},iw),-2)':'if(gt(iw,ih),-2,min(${side},ih))'`;
	const out = await pool(wanted, 4, async (t) => {
		const jpg = await run(
			FFMPEG(),
			["-v", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", scale, "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3", "pipe:1"],
			opts.signal,
		);
		return { t: Math.round(t * 1000) / 1000, data: jpg.toString("base64"), mimeType: "image/jpeg" as const };
	});
	return { duration_s: Math.round(duration * 100) / 100, stills: out.filter((s) => s.data.length > 0) };
}
