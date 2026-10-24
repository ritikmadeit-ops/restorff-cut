/**
 * What `check` measures beyond the project JSON (gate-v2, 2026-10-20), so the gate sees what the viewer sees:
 *
 *   compositionFacts  each composition clip's own render (the media store's WebM): a frame diff → scene cuts and
 *                     designed flashes; an alpha grid (32 columns) → opaque or overlay, and what it covers (FACE).
 *                     Text from the library manifest (packages/compositions) for library pieces. Cached per media
 *                     hash in <gate dir>/compositions/<hash>.json (version COMP_CACHE_VERSION).
 *   mediaAlpha        overlay pictures (PNG plates, cut-outs): does the file carry alpha (ffprobe pix_fmt / alpha_mode).
 *   faceTracks        the person matte's face boxes (server/matte.ts getFaceBoxes) for every clip that has one.
 *   textMeasurer      the caption builder's own Chromium measurer (server/transcripts-measure.ts prepareMeasure) in
 *                     the editor's text-box model, so the gate and `captions` agree on every width.
 *   masterFlashes     per-frame luma changes of the encoded master (64 px grey frames) → FLASH's file half.
 *
 * Runners and paths: ffmpeg/ffprobe from @/gate/server/ffmpeg (RESTORFFCUT_FFMPEG / RESTORFFCUT_FFPROBE), the cache under
 * RESTORFFCUT_GATE_DIR (default <apps/web>/.data/gate, git-ignored). Nothing here writes to the project.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	compositionFacts as gateCompositionFacts,
	detectFlashes,
	type CompositionFacts,
	type FaceTrackLite,
	type FlashMeasure,
	type GateElement,
	type GateScene,
	type ManifestLike,
	type MediaInfo,
	type TextRect,
} from "@restorffcut/gate";
import { FFMPEG, FFPROBE, resolveGateDir } from "@/gate/server/ffmpeg";
import { getFaceBoxes } from "./matte";
import { findTranscript } from "./transcripts";
import { prepareTextMeasure, type MeasureReport } from "./transcripts-measure";

export const COMP_CACHE_VERSION = 3;
const GRID_COLS = 32;
const ALPHA_FPS = 5;

// ─── process helpers ─────────────────────────────────────────────────────────────────────────────────────────

function runBinary(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: Buffer; stderr: string; error?: string }> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let stderr = "";
		let settled = false;
		const child = spawn(cmd, args, { windowsHide: true, timeout: timeoutMs });
		child.stdout.on("data", (d: Buffer) => chunks.push(d));
		child.stderr.on("data", (d: Buffer) => {
			stderr = (stderr + d.toString("utf8")).slice(-20_000);
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			resolve({ code: null, stdout: Buffer.concat(chunks), stderr, error: error.message });
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			resolve({ code, stdout: Buffer.concat(chunks), stderr });
		});
	});
}

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

function median(values: number[]): number {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ─── probe ───────────────────────────────────────────────────────────────────────────────────────────────────

interface StreamInfo {
	width: number;
	height: number;
	fps: number;
	pixFmt: string;
	alphaMode: boolean;
	codec: string;
}

async function probeVideo(file: string): Promise<StreamInfo | null> {
	const r = await runBinary(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,pix_fmt,codec_name:stream_tags", "-of", "json", file], 30_000);
	if (r.code !== 0) return null;
	try {
		const j = JSON.parse(r.stdout.toString("utf8")) as { streams?: Array<Record<string, unknown>> };
		const s = j.streams?.[0];
		if (!s) return null;
		const rate = (v: unknown) => {
			const [n, d] = String(v ?? "").split("/").map(Number);
			return n && d ? n / d : 0;
		};
		const tags = (s.tags ?? {}) as Record<string, string>;
		return {
			width: Number(s.width) || 0,
			height: Number(s.height) || 0,
			fps: rate(s.avg_frame_rate) || rate(s.r_frame_rate) || 30,
			pixFmt: String(s.pix_fmt ?? ""),
			alphaMode: Object.entries(tags).some(([k, v]) => k.toLowerCase() === "alpha_mode" && String(v) === "1"),
			codec: String(s.codec_name ?? ""),
		};
	} catch {
		return null;
	}
}

function hasAlpha(info: StreamInfo): boolean {
	return info.alphaMode || /^(rgba|bgra|argb|abgr|yuva|gbrap|ya|pal8)/.test(info.pixFmt);
}

/** Decode a file to tiny RGBA (or grey) frames at its own rate; VP9 alpha needs the libvpx decoder. */
async function rawFrames(file: string, info: StreamInfo, cols: number, gray: boolean): Promise<{ frames: Buffer[]; cols: number; rows: number } | null> {
	const rows = Math.max(2, Math.round((cols * info.height) / Math.max(1, info.width)));
	const decoder = info.codec === "vp9" && info.alphaMode ? ["-c:v", "libvpx-vp9"] : info.codec === "vp8" && info.alphaMode ? ["-c:v", "libvpx"] : [];
	const fmt = gray ? "gray" : "rgba";
	const args = ["-v", "error", ...decoder, "-i", file, "-an", "-vf", `scale=${cols}:${rows}:flags=area,format=${fmt}`, "-f", "rawvideo", "-pix_fmt", fmt, "-"];
	const r = await runBinary(FFMPEG, args, 180_000);
	if (r.code !== 0) return null;
	const size = cols * rows * (gray ? 1 : 4);
	const frames: Buffer[] = [];
	for (let o = 0; o + size <= r.stdout.length; o += size) frames.push(r.stdout.subarray(o, o + size));
	return { frames, cols, rows };
}

/** Mean absolute luma change between consecutive frames (0..255); RGBA frames are premultiplied by alpha. */
export function frameDiffs(frames: Buffer[], channels: 1 | 4): number[] {
	const luma = (f: Buffer) => {
		if (channels === 1) return f;
		const out = new Float32Array(f.length / 4);
		for (let i = 0, j = 0; i < f.length; i += 4, j++) out[j] = ((0.299 * f[i] + 0.587 * f[i + 1] + 0.114 * f[i + 2]) * f[i + 3]) / 255;
		return out;
	};
	const diffs: number[] = [];
	let prev = frames.length ? luma(frames[0]) : null;
	for (let k = 1; k < frames.length; k++) {
		const cur = luma(frames[k]);
		let sum = 0;
		for (let i = 0; i < cur.length; i++) sum += Math.abs((cur[i] as number) - ((prev as ArrayLike<number>)[i] as number));
		diffs.push(sum / cur.length);
		prev = cur;
	}
	return diffs;
}

/**
 * Scene cuts in a run of frame diffs (32-column frames, alpha-premultiplied luma): a change ≥ max(2.5, 5 × the local
 * median), merged within 0.3 s (a whip or a light streak changes several frames in a row). MEASURED on the neon-grid
 * compositions 2026-10-20: the hook's light streak peaks at 3.8 over a 0.45 median, the five beat words at 7–10.5,
 * a hard cut at 122.8; typing, ignites and camera glides stay under 2 (ASSUMPTION for other looks).
 */
export function sceneCuts(diffs: number[], fps: number, opts: { min?: number; ratio?: number; mergeS?: number } = {}): number[] {
	const min = opts.min ?? 2.5;
	const ratio = opts.ratio ?? 5;
	const merge = opts.mergeS ?? 0.3;
	const cuts: number[] = [];
	for (let i = 0; i < diffs.length; i++) {
		const local = Math.max(0.5, median(diffs.slice(Math.max(0, i - 15), Math.min(diffs.length, i + 16))));
		if (diffs[i] < Math.max(min, ratio * local)) continue;
		const t = (i + 1) / fps;
		if (cuts.length && t - cuts[cuts.length - 1] < merge) continue;
		cuts.push(Math.round(t * 1000) / 1000);
	}
	return cuts;
}

/** Local spans where a render changes fast (≥ max(1, 3 × its median) per frame), merged across ≤ 2-frame gaps. */
export function motionSpans(diffs: number[], fps: number): Array<[number, number]> {
	const level = Math.max(1, 3 * median(diffs));
	const spans: Array<[number, number]> = [];
	for (let i = 0; i < diffs.length; i++) {
		if (diffs[i] < level) continue;
		const a = i / fps;
		const b = (i + 1) / fps;
		const last = spans[spans.length - 1];
		if (last && a - last[1] <= 2 / fps + 1e-9) last[1] = b;
		else spans.push([Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
	}
	for (const s of spans) s[1] = Math.round(s[1] * 1000) / 1000;
	return spans;
}

// ─── compositions ────────────────────────────────────────────────────────────────────────────────────────────

interface CompCache {
	v: number;
	hash: string;
	fps: number;
	frames: number;
	scenes: number[];
	flashes: number[];
	motion: Array<[number, number]>;
	opaque: boolean;
	alpha: { fps: number; cols: number; rows: number; frames: string[] };
	diffs_p50: number;
	diffs_max: number;
}

function cacheDir(): string {
	const dir = path.join(resolveGateDir(), "compositions");
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function measureComposition(file: string, hash: string): Promise<CompCache | null> {
	const cached = path.join(cacheDir(), `${hash}.json`);
	if (existsSync(cached)) {
		try {
			const c = JSON.parse(readFileSync(cached, "utf8")) as CompCache;
			if (c.v === COMP_CACHE_VERSION) return c;
		} catch {
			/* re-measure */
		}
	}
	const info = await probeVideo(file);
	if (!info) return null;
	const raw = await rawFrames(file, info, GRID_COLS, false);
	if (!raw || !raw.frames.length) return null;
	const diffs = frameDiffs(raw.frames, 4);
	const step = Math.max(1, Math.round(info.fps / ALPHA_FPS));
	const alphaFrames: string[] = [];
	let opaque = true;
	for (let k = 0; k < raw.frames.length; k += step) {
		const f = raw.frames[k];
		let bits = "";
		let solid = 0;
		for (let i = 3; i < f.length; i += 4) {
			bits += f[i] >= 96 ? "1" : "0";
			if (f[i] >= 250) solid++;
		}
		if (solid / (f.length / 4) < 0.97) opaque = false;
		alphaFrames.push(bits);
	}
	if (!hasAlpha(info)) opaque = true;
	const out: CompCache = {
		v: COMP_CACHE_VERSION,
		hash,
		fps: info.fps,
		frames: raw.frames.length,
		scenes: sceneCuts(diffs, info.fps),
		flashes: detectFlashes(diffs, { fps: info.fps }).map((f) => Math.round(f.t * 1000) / 1000),
		motion: motionSpans(diffs, info.fps),
		opaque,
		alpha: { fps: info.fps / step, cols: raw.cols, rows: raw.rows, frames: alphaFrames },
		diffs_p50: Math.round(median(diffs) * 10) / 10,
		diffs_max: Math.round(Math.max(0, ...diffs) * 10) / 10,
	};
	try {
		writeFileSync(cached, JSON.stringify(out));
	} catch {
		/* the cache is an optimisation */
	}
	return out;
}

export interface MediaRef {
	media_id: string;
	hash: string;
	file: string;
	mime?: string;
}

type LibraryManifests = Record<string, ManifestLike>;
let libraryCache: LibraryManifests | null = null;

/** Library manifests by name (packages/compositions), read once per server process. */
export async function libraryManifests(): Promise<LibraryManifests> {
	if (libraryCache) return libraryCache;
	const out: LibraryManifests = {};
	try {
		const lib = await import("@restorffcut/compositions");
		for (const entry of lib.listLibrary()) {
			try {
				out[entry.name] = lib.parseManifest(readFileSync(entry.html, "utf8")) as unknown as ManifestLike;
			} catch {
				/* skip a broken manifest */
			}
		}
	} catch {
		/* no library: text falls back to props */
	}
	libraryCache = out;
	return out;
}

function compositionElements(scene: GateScene): GateElement[] {
	const out: GateElement[] = [];
	for (const track of [...scene.tracks.overlay, scene.tracks.main]) {
		if (!track || track.type !== "video") continue;
		for (const el of track.elements) if ((el.restorff as { composition?: unknown } | null | undefined)?.composition) out.push(el);
	}
	return out;
}

export interface CompositionReport {
	measured: number;
	cached: number;
	failed: Array<{ element_id: string; why: string }>;
	opaque: number;
	scenes: number;
	ms: number;
}

/** Facts for every composition clip, keyed by element id (measured per media hash, cached). */
export async function compositionFacts(scene: GateScene, media: Map<string, MediaRef>): Promise<{ facts: Record<string, CompositionFacts>; report: CompositionReport }> {
	const started = Date.now();
	const els = compositionElements(scene);
	const lib = await libraryManifests();
	const facts: Record<string, CompositionFacts> = {};
	const report: CompositionReport = { measured: 0, cached: 0, failed: [], opaque: 0, scenes: 0, ms: 0 };
	const byHash = new Map<string, MediaRef>();
	for (const el of els) {
		const ref = el.mediaId ? media.get(el.mediaId) : undefined;
		if (ref) byHash.set(ref.hash, ref);
	}
	const measured = new Map<string, CompCache | null>();
	await pool([...byHash.values()], 4, async (ref) => {
		const had = existsSync(path.join(cacheDir(), `${ref.hash}.json`));
		const c = existsSync(ref.file) ? await measureComposition(ref.file, ref.hash) : null;
		if (c) had ? report.cached++ : report.measured++;
		measured.set(ref.hash, c);
	});
	for (const el of els) {
		const ref = el.mediaId ? media.get(el.mediaId) : undefined;
		const c = ref ? measured.get(ref.hash) : null;
		const comp = (el.restorff as { composition?: { name?: string; custom?: boolean } }).composition ?? {};
		const libManifest = !comp.custom && comp.name ? (lib[comp.name] ?? null) : null;
		const declared = gateCompositionFacts(el, undefined, libManifest);
		if (!c) report.failed.push({ element_id: el.id, why: ref ? "its render could not be decoded" : "its render is not in the server's media store" });
		const f: CompositionFacts = {
			...(declared?.text ? { text: declared.text } : {}),
			from: { ...(declared?.from ?? {}) },
		};
		if (c) {
			f.scenes = c.scenes;
			f.flashes = c.flashes;
			f.motion = c.motion;
			f.opaque = c.opaque;
			f.alpha = { fps: c.alpha.fps, cols: c.alpha.cols, rows: c.alpha.rows, frames: c.alpha.frames.map((bits) => Array.from(bits, (b) => (b === "1" ? 255 : 0))) };
			f.from = { ...f.from, scenes: "render", opaque: "render", alpha: "render" };
			if (c.opaque) report.opaque++;
			report.scenes += c.scenes.length;
		}
		facts[el.id] = f;
	}
	report.ms = Date.now() - started;
	return { facts, report };
}

// ─── overlay pictures: alpha ─────────────────────────────────────────────────────────────────────────────────

/**
 * Does each overlay picture's file carry alpha (cached per hash in memory for the process); for those that do, their
 * alpha grid (what they cover), keyed by media id, so FACE judges a PNG plate by its visible pixels.
 */
const alphaMemo = new Map<string, boolean | null>();
export async function mediaAlpha(scene: GateScene, media: Map<string, MediaRef>, infos: Record<string, MediaInfo>): Promise<Record<string, CompositionFacts>> {
	const grids: Record<string, CompositionFacts> = {};
	const wanted: MediaRef[] = [];
	for (const track of scene.tracks.overlay) {
		if (track.type !== "video") continue;
		for (const el of track.elements) {
			if ((el.restorff as { composition?: unknown } | null | undefined)?.composition) continue;
			const ref = el.mediaId ? media.get(el.mediaId) : undefined;
			if (ref && !wanted.includes(ref)) wanted.push(ref);
		}
	}
	await pool(wanted, 4, async (ref) => {
		if (!alphaMemo.has(ref.hash)) {
			const info = existsSync(ref.file) ? await probeVideo(ref.file) : null;
			alphaMemo.set(ref.hash, info ? hasAlpha(info) : null);
		}
		const alpha = alphaMemo.get(ref.hash);
		if (typeof alpha === "boolean") infos[ref.media_id] = { ...(infos[ref.media_id] ?? {}), alpha };
		if (alpha === true) {
			const c = await measureComposition(ref.file, ref.hash);
			if (c) grids[ref.media_id] = { alpha: { fps: c.alpha.fps, cols: c.alpha.cols, rows: c.alpha.rows, frames: c.alpha.frames.map((bits) => Array.from(bits, (b) => (b === "1" ? 255 : 0))) }, opaque: false, from: { alpha: "render" } };
		}
	});
	return grids;
}

// ─── faces ───────────────────────────────────────────────────────────────────────────────────────────────────

export function faceTracks(scene: GateScene, media: Map<string, MediaRef>): Record<string, FaceTrackLite> {
	const out: Record<string, FaceTrackLite> = {};
	for (const track of [...scene.tracks.overlay, scene.tracks.main]) {
		if (!track || track.type !== "video") continue;
		for (const el of track.elements) {
			if (el.type !== "video" || !el.mediaId || out[el.mediaId]) continue;
			const ref = media.get(el.mediaId);
			if (!ref) continue;
			const faces = getFaceBoxes(ref.hash);
			if (!faces?.frames?.length) continue;
			out[el.mediaId] = {
				source: { width: faces.source.width, height: faces.source.height },
				frames: faces.frames.map((f) => ({ t: f.t, box: (f.faces[0]?.box ?? f.face_seg ?? null) as [number, number, number, number] | null })),
			};
		}
	}
	return out;
}

/**
 * revise-safety (2026-10-21): media ids of video clips that speak (a server transcript with words) and have no face
 * track — the gate's FACE judges the captions over them against a presumed face band instead of skipping them.
 */
export function speakersWithoutFaces(scene: GateScene, media: Map<string, MediaRef>, faces: Record<string, FaceTrackLite>): string[] {
	const out = new Set<string>();
	for (const track of [...scene.tracks.overlay, scene.tracks.main]) {
		if (!track || track.type !== "video") continue;
		for (const el of track.elements) {
			if (el.type !== "video" || !el.mediaId || faces[el.mediaId] || out.has(el.mediaId)) continue;
			if ((el as { isSourceAudioEnabled?: boolean }).isSourceAudioEnabled === false) continue;
			const ref = media.get(el.mediaId);
			if (!ref) continue;
			if ((findTranscript(ref.hash)?.words.length ?? 0) > 0) out.add(el.mediaId);
		}
	}
	return [...out];
}

// ─── text: the caption builder's measurer in the editor's box model ──────────────────────────────────────────

function textElementsOf(scene: GateScene): GateElement[] {
	const out: GateElement[] = [];
	for (const track of scene.tracks.overlay) if (track.type === "text") for (const el of track.elements) if (el.type === "text") out.push(el);
	return out;
}

/**
 * ONE text measurer for the caption builder and the gate: captions-v2's `prepareTextMeasure` (every line measured in
 * headless Chromium with the real font, the editor's box from `textBoxOf`: lines × line height, alignment, background
 * padding × fontSize / 15). The builder's safe-area report uses the same box, so `captions` and `check` agree.
 */
export async function textMeasurer(scene: GateScene, canvasHeight: number): Promise<{ measure: (el: GateElement) => TextRect | null; report: MeasureReport }> {
	const els = textElementsOf(scene);
	const { measureText, report } = await prepareTextMeasure(els, canvasHeight);
	return {
		measure: (el) => (typeof el.params?.content === "string" && el.params.content ? measureText(el) : null),
		report,
	};
}

// ─── the master: FLASH's file half ───────────────────────────────────────────────────────────────────────────

/** A face box (x0, y0, x1, y1 in 0..1 of the canvas) around a cut: the flash test also runs inside it. */
export interface FaceRegion {
	t: number;
	box: [number, number, number, number];
}

/** Mean absolute change inside a box between consecutive grey frames. */
function regionDiffs(frames: Buffer[], cols: number, rows: number, box: [number, number, number, number], from: number, to: number): number[] {
	const c0 = Math.max(0, Math.floor(box[0] * cols));
	const c1 = Math.min(cols, Math.ceil(box[2] * cols));
	const r0 = Math.max(0, Math.floor(box[1] * rows));
	const r1 = Math.min(rows, Math.ceil(box[3] * rows));
	const out: number[] = [];
	for (let k = Math.max(1, from); k <= Math.min(frames.length - 1, to); k++) {
		let sum = 0;
		let n = 0;
		for (let y = r0; y < r1; y++) for (let x = c0; x < c1; x++) {
			sum += Math.abs(frames[k][y * cols + x] - frames[k - 1][y * cols + x]);
			n++;
		}
		out.push(n ? sum / n : 0);
	}
	return out;
}

/**
 * FLASH's file half: flashes in the whole frame near the timeline's cuts, plus — at cuts on a clip with face boxes —
 * flashes inside the speaker's face box (a same-camera sliver at a jump cut barely moves the whole frame: MEASURED on
 * the explainer-overlay master, 25.7 inside the face box vs 5.8 over the frame).
 */
export async function masterFlashes(
	file: string,
	near: number[],
	faces: FaceRegion[] = [],
): Promise<{ flashes: FlashMeasure[] | null; fps: number; frames: number; median_diff: number; ms: number; error?: string }> {
	const started = Date.now();
	const info = await probeVideo(file);
	if (!info) return { flashes: null, fps: 0, frames: 0, median_diff: 0, ms: Date.now() - started, error: "ffprobe could not read the master" };
	const raw = await rawFrames(file, info, 64, true);
	if (!raw) return { flashes: null, fps: info.fps, frames: 0, median_diff: 0, ms: Date.now() - started, error: "ffmpeg could not decode the master" };
	const fps = info.fps;
	const diffs = frameDiffs(raw.frames, 1);
	const meanLuma = (f: Buffer) => f.reduce((a, b) => a + b, 0) / f.length;
	const withLuma = (f: FlashMeasure): FlashMeasure => {
		const first = Math.round(f.t * fps);
		const frames = raw.frames.slice(first, first + f.frames);
		return frames.length ? { ...f, luma: Math.round((frames.reduce((a, fr) => a + meanLuma(fr), 0) / frames.length) * 10) / 10 } : f;
	};
	const found: FlashMeasure[] = detectFlashes(diffs, { fps, near, nearS: 4 / fps }).map((f) => withLuma({ ...f, region: "frame" }));
	for (const region of faces) {
		const at = Math.round(region.t * fps);
		const from = Math.max(1, at - 20);
		const local = regionDiffs(raw.frames, raw.cols, raw.rows, region.box, from, at + 20);
		// local[k] is the change into frame from + k, i.e. diffs index from + k - 1
		// face pass: a change ≥ max(10, 3 × the local median) inside the exact face box (MEASURED on the explainer-overlay
		// fixture: its slivers enter at 26.5 / 19.6 and leave at 24.5 / 20.7 against medians 5.5 / 5.8; gestures stay < 16)
		for (const f of detectFlashes(local, { fps, near: [region.t - (from - 1) / fps], nearS: 4 / fps, ratio: 3, minDiff: 10 })) {
			const shift = (from - 1) / fps;
			const g = { ...f, t: Math.round((f.t + shift) * 1000) / 1000, t_end: Math.round((f.t_end + shift) * 1000) / 1000, region: "face" as const };
			if (!found.some((x) => Math.abs(x.t - g.t) < 2.5 / fps)) found.push(withLuma(g));
		}
	}
	found.sort((a, b) => a.t - b.t);
	return { flashes: found, fps, frames: raw.frames.length, median_diff: Math.round(median(diffs) * 10) / 10, ms: Date.now() - started };
}

/** Per-frame diffs of a file (debugging / calibration). */
export async function fileDiffs(file: string, cols = 64): Promise<{ fps: number; diffs: number[] } | null> {
	const info = await probeVideo(file);
	if (!info) return null;
	const raw = await rawFrames(file, info, cols, true);
	return raw ? { fps: info.fps, diffs: frameDiffs(raw.frames, 1) } : null;
}
