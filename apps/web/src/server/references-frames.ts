/**
 * FFmpeg side of reference study (EDT-21, PARITY G14; mcp-references agent, 2026-10-20). Everything the browser's
 * `styles-lab/explainer/extract.ts` reads with a <canvas>, read here with ffmpeg instead, so a Claude over MCP gets
 * the same style card the Styles tab makes:
 *   images  one frame ≤ 64 px on the long side + a native-resolution 128 px centre crop (grain)
 *   videos  frames at 2 fps over the first 60 s at ≤ 32 px (palette, motion), scene changes from ffmpeg's scene score
 *           (pacing), a native centre crop from the middle (grain)
 * plus the contact sheets a Claude looks at (tiles of every image and of each clip's cuts + evenly spaced frames) and
 * a palette strip. No text is drawn into images (no font dependency): the JSON legend says what each tile is.
 * FFmpeg: $RESTORFFCUT_FFMPEG / $RESTORFFCUT_FFPROBE, else on PATH (same as server/renders-look.ts).
 */
import { spawn } from "node:child_process";
import type { PaletteColor, PixelFrame } from "@restorffcut/styles";

const FFMPEG = () => process.env.RESTORFFCUT_FFMPEG?.trim() || "ffmpeg";
const FFPROBE = () => process.env.RESTORFFCUT_FFPROBE?.trim() || "ffprobe";

/** Seconds of each clip that are studied (frames, cuts, motion). */
export const STUDY_SPAN_S = 60;
/** Frames per second sampled for palette + motion (the browser samples every 0.5 s). */
const SAMPLE_FPS = 2;
/** ffmpeg scene score above which a frame counts as a cut. */
export const SCENE_THRESHOLD = 0.3;

interface RunResult {
	stdout: Buffer;
	stderr: string;
}

function run(cmd: string, args: string[], opts: { signal?: AbortSignal; timeoutMs?: number; input?: Buffer; keepStderr?: boolean } = {}): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { windowsHide: true, signal: opts.signal, timeout: opts.timeoutMs ?? 60_000 });
		const chunks: Buffer[] = [];
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString();
			if (!opts.keepStderr && err.length > 4000) err = err.slice(-2000);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve({ stdout: Buffer.concat(chunks), stderr: err });
			else reject(new Error(`${cmd} exited ${code}: ${err.slice(-400).trim()}`));
		});
		if (opts.input) child.stdin.end(opts.input);
		else child.stdin.end();
	});
}

export interface Probe {
	width: number;
	height: number;
	/** Seconds; null for stills. */
	duration: number | null;
	codec: string | null;
}

export async function probeMedia(file: string, signal?: AbortSignal): Promise<Probe> {
	const { stdout } = await run(
		FFPROBE(),
		["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name,duration:format=duration", "-of", "json", file],
		{ signal, timeoutMs: 30_000 },
	);
	const parsed = JSON.parse(stdout.toString() || "{}") as { streams?: Array<{ width?: number; height?: number; codec_name?: string; duration?: string }>; format?: { duration?: string } };
	const stream = parsed.streams?.[0];
	if (!stream?.width || !stream?.height) throw new Error("no picture stream (not an image or a video ffmpeg can read)");
	const raw = Number.parseFloat(stream.duration ?? parsed.format?.duration ?? "");
	return { width: stream.width, height: stream.height, duration: Number.isFinite(raw) && raw > 0 ? raw : null, codec: stream.codec_name ?? null };
}

function fit(width: number, height: number, longSide: number): { w: number; h: number } {
	const scale = Math.min(1, longSide / Math.max(width, height));
	return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

function split(buffer: Buffer, w: number, h: number, channels: number): Uint8ClampedArray[] {
	const size = w * h * channels;
	const out: Uint8ClampedArray[] = [];
	for (let at = 0; at + size <= buffer.length; at += size) out.push(new Uint8ClampedArray(buffer.buffer, buffer.byteOffset + at, size));
	return out;
}

/** Downsampled RGBA frames: one for an image (≤ 64 px), 2 per second over `span` seconds for a video (≤ 32 px). */
export async function pixelFrames(file: string, probe: Probe, kind: "image" | "video", span: number, signal?: AbortSignal): Promise<PixelFrame[]> {
	if (kind === "image") {
		const { w, h } = fit(probe.width, probe.height, 64);
		const { stdout } = await run(FFMPEG(), ["-v", "error", "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { signal });
		return split(stdout, w, h, 4).slice(0, 1).map((data) => ({ width: w, height: h, data }));
	}
	const { w, h } = fit(probe.width, probe.height, 32);
	const { stdout } = await run(
		FFMPEG(),
		["-v", "error", "-t", span.toFixed(3), "-i", file, "-an", "-vf", `fps=${SAMPLE_FPS},scale=${w}:${h}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
		{ signal, timeoutMs: 120_000 },
	);
	return split(stdout, w, h, 4).map((data, i) => ({ width: w, height: h, data, t: Math.round((i / SAMPLE_FPS) * 1000) / 1000 }));
}

/** A native-resolution centre crop (≤ 128 px square): grain must not be averaged away by downsampling. */
export async function detailCrop(file: string, probe: Probe, at: number | null, signal?: AbortSignal): Promise<PixelFrame | null> {
	const side = Math.min(128, probe.width, probe.height);
	const x = Math.floor((probe.width - side) / 2);
	const y = Math.floor((probe.height - side) / 2);
	const seek = at !== null && at > 0 ? ["-ss", at.toFixed(3)] : [];
	const { stdout } = await run(FFMPEG(), ["-v", "error", ...seek, "-i", file, "-frames:v", "1", "-vf", `crop=${side}:${side}:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { signal });
	const [data] = split(stdout, side, side, 4);
	return data ? { width: side, height: side, data } : null;
}

/**
 * A cut that scores under SCENE_THRESHOLD still counts when it is a SPIKE: at least SCENE_SPIKE_MIN and at least
 * SCENE_SPIKE_RATIO × the median of the ±SCENE_SPIKE_RADIUS frames around it (+ SCENE_SPIKE_MARGIN). Cuts closer
 * than SCENE_MIN_GAP_S are one cut (the biggest). explainer-v2, 2026-10-20: the recreation's depth-parallax.mp4 cut at
 * 2 s from a paper scene to a similar paper scene scored 0.281 between frames scoring ≤ 0.01, so `gt(scene,0.3)` missed
 * it; tuned on synthetic clips (worklog explainer-v2.md).
 */
// 0.1: a cut between two framings of the same map scored 0.118; a small box jumping inside a still frame 0.076
export const SCENE_SPIKE_MIN = 0.1;
export const SCENE_SPIKE_RATIO = 4;
export const SCENE_SPIKE_MARGIN = 0.05;
export const SCENE_SPIKE_RADIUS = 6;
export const SCENE_MIN_GAP_S = 0.3;
/** A score this high is a cut even inside a busy passage. */
export const SCENE_HARD = 0.5;

/** Cut times from per-frame scene scores (pure; see the constants above). */
export function cutsFromScores(frames: ReadonlyArray<{ t: number; score: number }>, span = Number.POSITIVE_INFINITY): number[] {
	const picked: Array<{ t: number; score: number }> = [];
	for (let i = 0; i < frames.length; i++) {
		const { t, score } = frames[i] as { t: number; score: number };
		if (!(t > 0.05 && t < span)) continue;
		const around: number[] = [];
		for (let j = Math.max(0, i - SCENE_SPIKE_RADIUS); j <= Math.min(frames.length - 1, i + SCENE_SPIKE_RADIUS); j++) if (j !== i) around.push((frames[j] as { score: number }).score);
		around.sort((a, b) => a - b);
		const local = around.length ? (around[Math.floor(around.length / 2)] as number) : 0;
		const spike = score >= SCENE_SPIKE_MIN && score >= SCENE_SPIKE_RATIO * local + SCENE_SPIKE_MARGIN;
		const plain = score > SCENE_THRESHOLD && score >= 2 * local + SCENE_SPIKE_MARGIN;
		if (spike || plain || score >= SCENE_HARD) picked.push({ t, score });
	}
	// one cut per SCENE_MIN_GAP_S: keep the biggest score of a cluster
	const merged: Array<{ t: number; score: number }> = [];
	for (const cut of picked) {
		const last = merged.at(-1);
		if (last && cut.t - last.t < SCENE_MIN_GAP_S) {
			if (cut.score > last.score) merged[merged.length - 1] = cut;
		} else merged.push(cut);
	}
	return merged.map((cut) => Math.round(cut.t * 1000) / 1000);
}

/** Parse ffmpeg `metadata=print` output (pts_time line, then its lavfi.scene_score line) into per-frame scores. */
export function parseSceneScores(stderr: string): Array<{ t: number; score: number }> {
	const out: Array<{ t: number; score: number }> = [];
	let t: number | null = null;
	for (const line of stderr.split("\n")) {
		const time = /pts_time:\s*([0-9.]+)/.exec(line);
		if (time) {
			t = Number.parseFloat(time[1] as string);
			continue;
		}
		const score = /lavfi\.scene_score=([0-9.]+)/.exec(line);
		if (score && t !== null && Number.isFinite(t)) {
			out.push({ t, score: Number.parseFloat(score[1] as string) });
			t = null;
		}
	}
	return out;
}

/** Cut times (seconds) inside the first `span` seconds: ffmpeg's scene score of every frame → `cutsFromScores`. */
export async function sceneChanges(file: string, span: number, signal?: AbortSignal): Promise<number[]> {
	const { stderr } = await run(
		FFMPEG(),
		["-hide_banner", "-nostats", "-t", span.toFixed(3), "-i", file, "-an", "-vf", "scale=160:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score", "-f", "null", "-"],
		{ signal, timeoutMs: 180_000, keepStderr: true },
	);
	return cutsFromScores(parseSceneScores(stderr), span);
}

const stillCache = new Map<string, string>();

/** The average colour of a picture (a clip: its frame at `at` s) — area-scaled to one pixel. Null when unreadable. */
export async function toneOf(file: string, at?: number, signal?: AbortSignal): Promise<[number, number, number] | null> {
	try {
		const seek = at && at > 0 ? ["-ss", at.toFixed(3)] : [];
		const { stdout } = await run(FFMPEG(), ["-v", "error", ...seek, "-i", file, "-frames:v", "1", "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { signal, timeoutMs: 20_000 });
		return stdout.length >= 3 ? [stdout[0] as number, stdout[1] as number, stdout[2] as number] : null;
	} catch {
		return null;
	}
}

/** True when the picture stream carries alpha (rgba, yuva…, ya8, pal8 with transparency counts as maybe: false). */
export async function hasAlpha(file: string, signal?: AbortSignal): Promise<boolean> {
	try {
		const { stdout } = await run(FFPROBE(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", file], { signal, timeoutMs: 20_000 });
		const format = stdout.toString().trim();
		return /^(rgba|bgra|argb|abgr|ya8|ya16|yuva|gbrap|rgba64|bgra64)/.test(format);
	} catch {
		return false;
	}
}

/**
 * A still as a data: URL, long side ≤ 720 px (PNG when it may carry alpha, else JPEG), for composition image params:
 * the compositions service takes only data:/http(s): URLs from callers, never server paths. Cached by content hash.
 * `at` (seconds) takes a frame from a clip (explainer-v2: a clip's still for cut-outs and halftones).
 */
export async function stillDataUrl(file: string, hash: string, keepAlpha: boolean, signal?: AbortSignal, at?: number): Promise<string> {
	const key = `${hash}:${keepAlpha ? "png" : "jpg"}${at ? `@${at.toFixed(2)}` : ""}`;
	const cached = stillCache.get(key);
	if (cached) return cached;
	const scale = "scale='if(gt(iw,ih),min(720,iw),-2)':'if(gt(iw,ih),-2,min(720,ih))'";
	const codec = keepAlpha ? ["-vcodec", "png", "-pix_fmt", "rgba"] : ["-vcodec", "mjpeg", "-q:v", "3"];
	const seek = at && at > 0 ? ["-ss", at.toFixed(3)] : [];
	const { stdout } = await run(FFMPEG(), ["-v", "error", ...seek, "-i", file, "-frames:v", "1", "-vf", scale, "-f", "image2pipe", ...codec, "pipe:1"], { signal });
	if (!stdout.length) throw new Error("ffmpeg made no image");
	const url = `data:image/${keepAlpha ? "png" : "jpeg"};base64,${stdout.toString("base64")}`;
	if (stillCache.size > 64) stillCache.clear();
	stillCache.set(key, url);
	return url;
}

// ─── contact sheets ─────────────────────────────────────────────────────────────────────────────────────────────

const TILE = 200;
const GAP = 6;
const COLUMNS = 6;
const BG: [number, number, number] = [24, 24, 26];
const PAD_HEX = "0x1E1E1E";

/** One TILE×TILE RGB24 tile of a file (an image, or a video frame at `at`), letterboxed. */
async function tile(file: string, at: number | null, signal?: AbortSignal): Promise<Buffer | null> {
	const seek = at !== null && at > 0 ? ["-ss", at.toFixed(3)] : [];
	try {
		const { stdout } = await run(
			FFMPEG(),
			[
				"-v", "error", ...seek, "-i", file, "-frames:v", "1",
				"-vf", `scale=${TILE}:${TILE}:force_original_aspect_ratio=decrease:flags=area,pad=${TILE}:${TILE}:(ow-iw)/2:(oh-ih)/2:color=${PAD_HEX}`,
				"-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
			],
			{ signal },
		);
		return stdout.length >= TILE * TILE * 3 ? stdout.subarray(0, TILE * TILE * 3) : null;
	} catch {
		return null;
	}
}

/** RGB24 → JPEG through ffmpeg (no image library in the server). */
export async function encodeJpeg(rgb: Buffer, width: number, height: number, signal?: AbortSignal): Promise<string> {
	const { stdout } = await run(
		FFMPEG(),
		["-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-i", "pipe:0", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3", "pipe:1"],
		{ signal, input: rgb },
	);
	return stdout.toString("base64");
}

export interface SheetTileSpec {
	file: string;
	/** Seconds into a video; null = an image. */
	at: number | null;
	/** What the legend says for this tile. */
	label: string;
}

export interface Sheet {
	folder: string | null;
	columns: number;
	tiles: string[];
	data: string;
	mimeType: "image/jpeg";
}

/** Tiles in reading order, COLUMNS per row, one JPEG. Tiles that fail to decode are left dark (and said so). */
export async function contactSheet(folder: string | null, specs: SheetTileSpec[], signal?: AbortSignal): Promise<Sheet> {
	const rows = Math.max(1, Math.ceil(specs.length / COLUMNS));
	const cols = Math.min(COLUMNS, Math.max(1, specs.length));
	const width = GAP + cols * (TILE + GAP);
	const height = GAP + rows * (TILE + GAP);
	const canvas = Buffer.alloc(width * height * 3);
	for (let i = 0; i < width * height; i++) canvas.set(BG, i * 3);
	const tiles: Array<Buffer | null> = new Array(specs.length).fill(null);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(4, specs.length) }, async () => {
			while (next < specs.length) {
				const i = next++;
				const spec = specs[i] as SheetTileSpec;
				tiles[i] = await tile(spec.file, spec.at, signal);
			}
		}),
	);
	const legend: string[] = [];
	specs.forEach((spec, i) => {
		const pixels = tiles[i];
		legend.push(pixels ? spec.label : `${spec.label} (could not be decoded)`);
		if (!pixels) return;
		const x0 = GAP + (i % COLUMNS) * (TILE + GAP);
		const y0 = GAP + Math.floor(i / COLUMNS) * (TILE + GAP);
		for (let y = 0; y < TILE; y++) pixels.copy(canvas, ((y0 + y) * width + x0) * 3, y * TILE * 3, (y + 1) * TILE * 3);
	});
	return { folder, columns: cols, tiles: legend, data: await encodeJpeg(canvas, width, height, signal), mimeType: "image/jpeg" };
}

/** The card's palette as one strip: swatch widths follow each colour's share, left to right as the card lists them. */
export async function paletteStrip(palette: readonly PaletteColor[], signal?: AbortSignal): Promise<{ data: string; mimeType: "image/jpeg" } | null> {
	if (!palette.length) return null;
	const width = 960;
	const height = 120;
	const canvas = Buffer.alloc(width * height * 3);
	const total = palette.reduce((sum, color) => sum + color.share, 0) || 1;
	let x = 0;
	palette.forEach((color, index) => {
		const w = index === palette.length - 1 ? width - x : Math.max(8, Math.round((color.share / total) * width));
		for (let y = 0; y < height; y++) for (let dx = 0; dx < w && x + dx < width; dx++) canvas.set(color.rgb, (y * width + x + dx) * 3);
		x += w;
	});
	return { data: await encodeJpeg(canvas, width, height, signal), mimeType: "image/jpeg" };
}

/** The tile times for a clip: the first frame after each cut, plus `even` evenly spaced frames; at most `max`. */
export function clipTileTimes(span: number, cuts: readonly number[], even = 4, max = 8): number[] {
	const times = [0.05, ...cuts.map((t) => t + 0.1), ...Array.from({ length: even }, (_, i) => ((i + 0.5) / even) * span)]
		.filter((t) => t >= 0 && t < Math.max(0.1, span - 0.05))
		.sort((a, b) => a - b);
	const kept: number[] = [];
	for (const t of times) if (!kept.length || t - (kept.at(-1) as number) >= 0.4) kept.push(Math.round(t * 100) / 100);
	if (kept.length <= max) return kept;
	// too many cuts: keep an even spread of them
	return Array.from({ length: max }, (_, i) => kept[Math.round((i * (kept.length - 1)) / (max - 1))] as number);
}
