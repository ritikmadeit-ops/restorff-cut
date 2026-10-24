/**
 * Layered effects — the server I/O half (effects-layers agent, 2026-10-20). What `effects apply` needs to build a
 * person effect the way its manifest recipe says (pure planning: ./effects-layers-plan.ts; orchestration:
 * ./effects.ts applyLayered):
 *
 *   ensureMatte      the clip's server person matte (mcp-cutout's job, cached by media sha256): start it, wait for it
 *   clipSpan         where the clip's frames are in person.webm (trims, retime, the job's range)
 *   faceOverWindow   median face / head box over the effect's source window (restorffcut-faces@1)
 *   matteFrames      the cutout as PNG frames in CANVAS space (white + the person's alpha) → data: URLs for props.matte
 *   clipStill        one frame of the clip in canvas space (JPEG data: URL) for props.background / props.plate
 *   cutoutOps        ops@1 that put the transparent person.webm on V2 CUTOUT above the clip, + the finish edit that
 *                    makes it frame-aligned (the clip's start, length, trims, retime, transform, keys) — the same
 *                    shape mcp-cutout's planPreset makes (server/matte-presets.ts), so either tool reuses the other's
 *   uploadPerson     the person WebM into the project's media store under the reducer's media id
 *
 * Paths: frames and stills are cached under RESTORFFCUT_EFFECTS_LAYERS_DIR (default <apps/web>/.data/effects-layers,
 * git-ignored), keyed by the matte job + the exact crop/size/time. FFmpeg: $RESTORFFCUT_FFMPEG, else on PATH.
 * Runbook: docs/restorff/worklog/effects-layers.md.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { apply as applyOps, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import type { Box } from "@/segmentation/types";
import type { ProjectSnapshot, SnapshotElement } from "@/sync/snapshot";
import {
	type FaceTrack,
	getFaceBoxes,
	type MatteJob,
	matteOutputFiles,
	type MediaRecord,
	findMatteJob,
	projectMediaRecord,
	startMatteJob,
	waitForMatte,
} from "./matte";
import { activeScene, CUTOUT_TRACK_NAME, drawnRect, type Located, locate, rateOf, type ServerCutoutSource, TICKS } from "./matte-presets";
import { putProjectMedia } from "./media";

const FFMPEG = () => process.env.RESTORFFCUT_FFMPEG?.trim() || "ffmpeg";

export function layersCacheRoot(): string {
	const configured = process.env.RESTORFFCUT_EFFECTS_LAYERS_DIR?.trim();
	return configured ? path.resolve(configured) : path.join(process.cwd(), ".data", "effects-layers");
}

const s3 = (seconds: number) => Math.round(seconds * 1000) / 1000;
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

function run(args: string[], signal?: AbortSignal, timeoutMs = 90_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(FFMPEG(), args, { windowsHide: true, signal, timeout: timeoutMs });
		let err = "";
		child.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString();
			if (err.length > 4000) err = err.slice(-2000);
		});
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-500).trim()}`))));
	});
}

// ─── the matte ───────────────────────────────────────────────────────────────────────────────────────────────

export type MatteState =
	| { state: "done"; job: MatteJob; faces: FaceTrack | null; media: MediaRecord; waitedMs: number }
	| { state: "pending"; job: MatteJob | null; media: MediaRecord; started: boolean }
	| { state: "error"; job: MatteJob; media: MediaRecord }
	| { state: "no_media"; mediaId: string };

/**
 * The clip's matte: cached → at once; running → wait up to `waitMs`; missing → start it (unless `start` is false, as
 * on a dry run) and wait. Same job and cache as MCP `cutout matte`.
 */
export async function ensureMatte({
	projectId,
	mediaId,
	waitMs,
	start,
	signal,
}: {
	projectId: string;
	mediaId: string;
	waitMs: number;
	start: boolean;
	signal?: AbortSignal;
}): Promise<MatteState> {
	const media = await projectMediaRecord(projectId, mediaId);
	if (!media) return { state: "no_media", mediaId };
	let job: MatteJob | null;
	let started = false;
	if (start) {
		const answer = startMatteJob({ media });
		job = answer.job;
		started = answer.started;
	} else {
		job = findMatteJob(media.hash);
	}
	const t0 = Date.now();
	if (job && (job.state === "queued" || job.state === "running") && waitMs > 0) job = (await waitForMatte(job.job_id, waitMs, signal)) ?? job;
	if (job?.state === "done") return { state: "done", job, faces: getFaceBoxes(job.media_hash, { variant: job.variant }), media, waitedMs: Date.now() - t0 };
	if (job?.state === "error") return { state: "error", job, media };
	return { state: "pending", job, media, started };
}

/** Where the clip's frames are in person.webm (whose timebase starts at the job's range.start). */
export interface ClipSpan {
	/** Seconds into person.webm of the clip's first frame. */
	inS: number;
	/** Source seconds the clip plays (duration × rate). */
	usedS: number;
	rate: number;
	/** Timeline seconds → seconds into person.webm. */
	webmAt: (timelineSeconds: number) => number;
	/** Timeline seconds → SOURCE seconds (face boxes are keyed by source time). */
	sourceAt: (timelineSeconds: number) => number;
}

export function clipSpan(plate: SnapshotElement, job: MatteJob): ClipSpan {
	const webm = job.outputs?.person_webm;
	if (!webm) throw new Error("the matte job has no person video");
	const range = job.range ?? { start: 0, end: webm.duration };
	const rate = rateOf(plate);
	const trimS = (plate.trimStart ?? 0) / TICKS;
	const startS = plate.startTime / TICKS;
	const inS = trimS - range.start;
	const usedS = (plate.duration / TICKS) * rate;
	if (inS < -1e-3 || inS + usedS > webm.duration + 0.05) {
		throw new Error(
			`the matte covers source ${range.start.toFixed(2)}–${range.end.toFixed(2)} s but the clip uses ${trimS.toFixed(2)}–${(trimS + usedS).toFixed(2)} s; run cutout matte with this clip's element_id first`,
		);
	}
	const sourceAt = (t: number) => trimS + (t - startS) * rate;
	return { inS: Math.max(0, inS), usedS, rate, sourceAt, webmAt: (t: number) => sourceAt(t) - range.start };
}

const median = (values: number[]) => {
	if (!values.length) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function medianBox(boxes: Box[]): Box | null {
	if (!boxes.length) return null;
	return [0, 1, 2, 3].map((i) => median(boxes.map((box) => box[i]))) as Box;
}

/** Median detector face and segmenter head (source-frame fractions) over [from, to] source seconds; summary as fallback. */
export function faceOverWindow(track: FaceTrack | null, from: number, to: number): { face: Box | null; head: Box | null; frames: number } {
	if (!track) return { face: null, head: null, frames: 0 };
	const frames = track.frames.filter((frame) => frame.t >= from - 1e-3 && frame.t <= to + 1e-3);
	const face = medianBox(frames.map((frame) => frame.faces[0]?.box ?? frame.face_seg).filter((box): box is Box => !!box));
	const head = medianBox(frames.map((frame) => frame.head).filter((box): box is Box => !!box));
	return { face: face ?? track.summary.face, head: head ?? track.summary.head ?? face, frames: frames.length };
}

// ─── frames + stills in canvas space ───────────────────────────────────────────────────────────────────────────

/** ffmpeg filters that draw a full-source frame where the clip sits on the canvas, at `outWidth` wide. */
function placeFilters(plate: SnapshotElement, source: { width: number; height: number }, canvas: { width: number; height: number }, outWidth: number, pad: string) {
	const k = outWidth / canvas.width;
	const outW = even(canvas.width * k);
	const outH = even(canvas.height * k);
	const rect = drawnRect(plate, source, canvas);
	const sx = Math.round(rect.left * k);
	const sy = Math.round(rect.top * k);
	const sw = even(rect.width * k);
	const sh = even(rect.height * k);
	const cx0 = Math.max(0, -sx);
	const cy0 = Math.max(0, -sy);
	const cx1 = Math.min(sw, outW - sx);
	const cy1 = Math.min(sh, outH - sy);
	if (cx1 - cx0 < 2 || cy1 - cy0 < 2) throw new Error("the clip is outside the canvas");
	const filters = [`scale=${sw}:${sh}`];
	if (cx0 > 0 || cy0 > 0 || cx1 < sw || cy1 < sh) filters.push(`crop=${cx1 - cx0}:${cy1 - cy0}:${cx0}:${cy0}`);
	if (outW !== cx1 - cx0 || outH !== cy1 - cy0) filters.push(`pad=${outW}:${outH}:${Math.max(0, sx)}:${Math.max(0, sy)}:color=${pad}`);
	return { filters, outW, outH, key: `${outW}x${outH}:${sx},${sy},${sw},${sh}` };
}

/**
 * The person matte as PNG frames for props.matte: white with the person's alpha, CANVAS space (the composition draws
 * each frame over the whole frame), `count` frames at `fps` from timeline second `from`. 540 px wide (half of a
 * 1080 canvas: the compositions only use the alpha edge; collage-fx's stand-in used half size too).
 */
export async function matteFrames({
	job,
	plate,
	span,
	canvas,
	from,
	count,
	fps,
	width = 540,
	signal,
}: {
	job: MatteJob;
	plate: SnapshotElement;
	span: ClipSpan;
	canvas: { width: number; height: number };
	from: number;
	count: number;
	fps: number;
	width?: number;
	signal?: AbortSignal;
}): Promise<{ urls: string[]; bytes: number; dir: string; cached: boolean; size: string }> {
	const webm = job.outputs?.person_webm;
	if (!webm) throw new Error("the matte job has no person video");
	const source = { width: webm.width, height: webm.height };
	const place = placeFilters(plate, source, canvas, Math.min(width, canvas.width), "black@0");
	const seek = Math.max(0, span.webmAt(from));
	// Same rate and fps: re-time by frame index (WebM keeps ms timestamps; LEARNINGS §4). Else resample.
	const byIndex = Math.abs(span.rate - 1) < 1e-6 && Math.abs(webm.fps - fps) < 1e-6;
	const retime = byIndex ? `setpts=N/${fps}/TB` : `setpts=(PTS-STARTPTS)/${span.rate},fps=${fps}`;
	const vf = [retime, "format=rgba", ...place.filters, "lutrgb=r=255:g=255:b=255"].join(",");
	const key = createHash("sha256").update(JSON.stringify({ job: job.job_id, finished: job.finished_at, seek: s3(seek), count, fps, vf })).digest("hex").slice(0, 20);
	const dir = path.join(layersCacheRoot(), "frames", key);
	const done = path.join(dir, "done.json");
	let cached = existsSync(done);
	if (!cached) {
		mkdirSync(dir, { recursive: true });
		const { webm: file } = matteOutputFiles(job);
		await run(["-y", "-v", "error", "-c:v", "libvpx-vp9", "-ss", String(s3(seek)), "-i", file, "-vf", vf, "-frames:v", String(count), "-start_number", "0", path.join(dir, "f_%04d.png")], signal);
		writeFileSync(done, JSON.stringify({ job: job.job_id, seek, count, fps, vf, at: new Date().toISOString() }));
		cached = false;
	}
	const files = readdirSync(dir).filter((name) => /^f_\d{4}\.png$/.test(name)).sort();
	if (!files.length) throw new Error("ffmpeg wrote no matte frames (is the clip inside the matte's range?)");
	let bytes = 0;
	const urls = files.map((name) => {
		const data = readFileSync(path.join(dir, name));
		bytes += data.byteLength;
		return `data:image/png;base64,${data.toString("base64")}`;
	});
	return { urls, bytes, dir, cached, size: `${place.outW}x${place.outH}` };
}

/** One frame of the clip at timeline second `at`, where it sits on the canvas, as a JPEG data: URL (canvas size). */
export async function clipStill({
	media,
	plate,
	span,
	canvas,
	at,
	source,
	signal,
}: {
	media: MediaRecord;
	plate: SnapshotElement;
	span: ClipSpan;
	canvas: { width: number; height: number };
	at: number;
	source: { width: number; height: number };
	signal?: AbortSignal;
}): Promise<{ url: string; bytes: number; cached: boolean; file: string }> {
	const place = placeFilters(plate, source, canvas, canvas.width, "black");
	const seek = Math.max(0, span.sourceAt(at));
	const vf = [...place.filters, "format=yuvj420p"].join(",");
	const key = createHash("sha256").update(JSON.stringify({ media: media.hash, seek: s3(seek), vf })).digest("hex").slice(0, 20);
	const file = path.join(layersCacheRoot(), "stills", `${key}.jpg`);
	const cached = existsSync(file);
	if (!cached) {
		mkdirSync(path.dirname(file), { recursive: true });
		await run(["-y", "-v", "error", "-ss", String(s3(seek)), "-i", media.file, "-frames:v", "1", "-vf", vf, "-q:v", "3", file], signal);
	}
	const data = readFileSync(file);
	return { url: `data:image/jpeg;base64,${data.toString("base64")}`, bytes: data.byteLength, cached, file };
}

/** effects-v2: the ffmpeg placement filters (scale / crop / pad) of a full-source frame onto the canvas (look kind clip). */
export function placeOnCanvas(plate: SnapshotElement, source: { width: number; height: number }, canvas: { width: number; height: number }, outWidth: number, pad: string) {
	return placeFilters(plate, source, canvas, outWidth, pad);
}

// ─── the person cutout on the timeline ─────────────────────────────────────────────────────────────────────────

/** A cutout of `plate` (made by the cutout tool or an earlier effect) that covers [start, end) ticks, if any. */
export function cutoutCovering(snapshot: ProjectSnapshot, plateId: string, start: number, end: number): Located | null {
	const overlay = activeScene(snapshot)?.tracks?.overlay ?? [];
	for (let index = 0; index < overlay.length; index++) {
		for (const element of overlay[index].elements ?? []) {
			const source = (element.restorff as { cutout?: ServerCutoutSource } | undefined)?.cutout;
			if (source?.sourceElementId !== plateId) continue;
			if (element.startTime <= start && element.startTime + element.duration >= end) return { element, track: overlay[index], group: "overlay", index };
		}
	}
	return null;
}

/**
 * ops@1 that add the person video on its own track directly above the clip (refs cutout_media / cutout_track /
 * cutout_clip). planPreset's cutout part (server/matte-presets.ts), the same shape so both tools reuse each other's.
 */
export function cutoutCreateOps({ plate, job, span, index }: { plate: Located; job: MatteJob; span: ClipSpan; index: number }): Record<string, unknown>[] {
	const webm = job.outputs?.person_webm;
	if (!webm) throw new Error("the matte job has no person video");
	const name = `${plate.element.name || "clip"} · cutout`;
	return [
		{ op: "import_media", author: "claude", kind: "video", name, url: `matte:${job.media_hash}/${job.variant}/person.webm`, duration: webm.duration, width: webm.width, height: webm.height, fps: webm.fps, has_audio: false, ref: "cutout_media" },
		{ op: "add_track", author: "claude", kind: "video", name: CUTOUT_TRACK_NAME, index, ref: "cutout_track" },
		{ op: "set", author: "claude", track: "cutout_track", prop: "muted", value: true },
		{ op: "insert", author: "claude", track: "cutout_track", t: s3(plate.element.startTime / TICKS), media: "cutout_media", in: s3(span.inS), out: s3(Math.min(webm.duration, span.inS + span.usedS)), name, ref: "cutout_clip" },
	];
}

/** After the reducer ran: the cutout copies the clip (start, length, trims, transform, keys, effects but blur, retime). */
export function finishCutout({
	snapshot,
	plateId,
	cutoutId,
	job,
	faces,
	span,
}: {
	snapshot: ProjectSnapshot;
	plateId: string;
	cutoutId: string;
	job: MatteJob;
	faces: FaceTrack | null;
	span: ClipSpan;
}): void {
	const scene = activeScene(snapshot);
	const made = locate(scene, cutoutId);
	const plate = locate(scene, plateId);
	if (!made || !plate) throw new Error("the cutout was not found after placing it (internal)");
	const p = plate.element;
	const webm = job.outputs?.person_webm;
	const range = job.range ?? { start: 0, end: webm?.duration ?? 0 };
	const webmTicks = Math.round((webm?.duration ?? 0) * TICKS);
	const used = Math.round(p.duration * span.rate);
	const trimStart = Math.max(0, Math.round((p.trimStart ?? 0) - range.start * TICKS));
	Object.assign(made.element, {
		startTime: p.startTime,
		duration: p.duration,
		trimStart,
		trimEnd: Math.max(0, webmTicks - trimStart - used),
		sourceDuration: webmTicks,
		params: structuredClone(p.params ?? {}),
		animations: p.animations ? structuredClone(p.animations) : undefined,
		effects: Array.isArray(p.effects) ? structuredClone((p.effects as Array<{ type?: string }>).filter((effect) => effect.type !== "blur")) : undefined,
		retime: p.retime ? structuredClone(p.retime) : undefined,
		isSourceAudioEnabled: false,
		hidden: false,
	});
	const cutoutSource: ServerCutoutSource = {
		sourceElementId: p.id,
		sourceMediaId: String(p.mediaId ?? ""),
		model: "multiclass",
		start: (p.trimStart ?? 0) / TICKS,
		end: (p.trimStart ?? 0) / TICKS + span.usedS,
		fps: webm?.fps ?? 0,
		person: faces?.summary.person ?? null,
		head: faces?.summary.head ?? null,
		face: faces?.summary.face ?? null,
		createdAt: new Date().toISOString(),
		server: { job_id: job.job_id, media_hash: job.media_hash, faces: "restorffcut-faces@1" },
	};
	made.element.restorff = { ...((made.element.restorff ?? {}) as Record<string, unknown>), cutout: cutoutSource } as SnapshotElement["restorff"];
}

// ─── effects-v2: person cutouts only over the span of person effects (SUMMARY gap 16, recreation E-3) ────────────
//
// A person effect gets a cutout SEGMENT covering its own window (not the whole clip), on one V2 CUTOUT lane, from the
// one person.webm of the clip's media (the media is imported and uploaded once per matte job, then reused: the
// recreation re-uploaded 13 MB per clip). Segments that overlap or touch the new window (within a frame) are merged
// into one (re-made from the clip, so they carry the clip's keys: "re-keyed"). Segments stay out of transition
// windows on the clip's cuts, so a transition (Zoom Through) blurs the whole frame, speaker included.

/** Ticks where a segment of `plate` must not be: the transition into it, and the one out of it into the next clip. */
export function transitionWindows(snapshot: ProjectSnapshot, plate: Located): Array<{ start: number; end: number; kind: string }> {
	const out: Array<{ start: number; end: number; kind: string }> = [];
	const p = plate.element;
	const into = p.transitionIn as { type?: string; duration?: number } | undefined;
	if (into?.type && (into.duration ?? 0) > 0) out.push({ start: p.startTime - (into.duration ?? 0) / 2, end: p.startTime + (into.duration ?? 0) / 2, kind: into.type });
	const end = p.startTime + p.duration;
	const next = (plate.track.elements ?? []).find((el) => el.id !== p.id && Math.abs(el.startTime - end) <= 1);
	const outOf = next?.transitionIn as { type?: string; duration?: number } | undefined;
	if (outOf?.type && (outOf.duration ?? 0) > 0) out.push({ start: end - (outOf.duration ?? 0) / 2, end: end + (outOf.duration ?? 0) / 2, kind: outOf.type });
	return out;
}

/** Person cutouts (any lane) made from `plateId`. */
export function segmentsOf(snapshot: ProjectSnapshot, plateId: string): Located[] {
	const overlay = activeScene(snapshot)?.tracks?.overlay ?? [];
	const out: Located[] = [];
	overlay.forEach((track, index) => {
		for (const element of track.elements ?? []) {
			if ((element.restorff as { cutout?: ServerCutoutSource } | undefined)?.cutout?.sourceElementId === plateId) out.push({ element, track, group: "overlay", index });
		}
	});
	return out;
}

/** A media id of this project that already holds the matte job's person.webm (no second import, no re-upload). */
export function personMediaId(snapshot: ProjectSnapshot, job: MatteJob): string | null {
	for (const track of activeScene(snapshot)?.tracks?.overlay ?? []) {
		for (const element of track.elements ?? []) {
			const server = (element.restorff as { cutout?: ServerCutoutSource } | undefined)?.cutout?.server;
			if (server?.job_id === job.job_id && element.mediaId) return String(element.mediaId);
		}
	}
	const manifest = ((snapshot.metadata?.restorff as { media?: Array<{ id?: string; url?: string }> } | undefined)?.media ?? []) as Array<{ id?: string; url?: string }>;
	const url = `matte:${job.media_hash}/${job.variant}/person.webm`;
	return manifest.find((entry) => entry.url === url && entry.id)?.id ?? null;
}

export interface SegmentPlan {
	/** The window the person is needed in, ticks (transition windows taken out). */
	start: number;
	end: number;
	/** A segment that already covers the window: reuse it as is. */
	reuse: Located | null;
	/** Segments to replace by one covering the union. */
	merge: Located[];
	union: { start: number; end: number };
	notes: string[];
}

/**
 * Which cutout segment the window [start, end) (ticks) needs: reuse, or make one over the union with what it touches.
 * Null when nothing is left of the window after the transition windows (no person needed there).
 */
export function planSegment(snapshot: ProjectSnapshot, plate: Located, start: number, end: number, frameTicks: number): SegmentPlan | null {
	const notes: string[] = [];
	let a = Math.max(start, plate.element.startTime);
	let b = Math.min(end, plate.element.startTime + plate.element.duration);
	for (const win of transitionWindows(snapshot, plate)) {
		if (win.start <= a && win.end > a) {
			notes.push(`the person starts after the ${win.kind} transition (${s3(win.end / TICKS)} s) so the transition blurs the speaker too`);
			a = Math.max(a, Math.ceil(win.end));
		}
		if (win.start < b && win.end >= b) {
			notes.push(`the person ends before the ${win.kind} transition (${s3(win.start / TICKS)} s) so the transition blurs the speaker too`);
			b = Math.min(b, Math.floor(win.start));
		}
	}
	if (b - a < frameTicks) return null;
	const segments = segmentsOf(snapshot, plate.element.id);
	const covering = segments.find((seg) => seg.element.startTime <= a && seg.element.startTime + seg.element.duration >= b);
	if (covering) return { start: a, end: b, reuse: covering, merge: [], union: { start: covering.element.startTime, end: covering.element.startTime + covering.element.duration }, notes };
	const touching = segments.filter((seg) => seg.element.startTime <= b + frameTicks && seg.element.startTime + seg.element.duration >= a - frameTicks);
	let us = a;
	let ue = b;
	for (const seg of touching) {
		us = Math.min(us, seg.element.startTime);
		ue = Math.max(ue, seg.element.startTime + seg.element.duration);
	}
	if (touching.length) notes.push(`merged with ${touching.length} person segment(s) next to it (one cutout across adjacent person effects)`);
	return { start: a, end: b, reuse: null, merge: touching, union: { start: us, end: ue }, notes };
}

/**
 * The fields of a cutout segment over `union` (ticks): made exactly like a whole-clip cutout (finishCutout copies the
 * clip's transform, keys, effects, retime) on a scratch copy, then cut with the reducer's own `split` (keys rebased
 * the way the editor's split does). Nothing here touches the real snapshot.
 */
export function segmentFields({
	snapshot,
	plateId,
	job,
	faces,
	span,
	union,
	mediaId,
}: {
	snapshot: ProjectSnapshot;
	plateId: string;
	job: MatteJob;
	faces: FaceTrack | null;
	span: ClipSpan;
	union: { start: number; end: number };
	mediaId: string | null;
}): Record<string, unknown> {
	const webm = job.outputs?.person_webm;
	if (!webm) throw new Error("the matte job has no person video");
	const plate = locate(activeScene(snapshot), plateId);
	if (!plate) throw new Error("the clip was not found (internal)");
	const p = plate.element;
	const ops: Record<string, unknown>[] = [
		...(mediaId ? [] : [{ op: "import_media", author: "claude", kind: "video", name: "scratch", url: `matte:${job.media_hash}/${job.variant}/person.webm`, duration: webm.duration, width: webm.width, height: webm.height, fps: webm.fps, has_audio: false, ref: "m" }]),
		{ op: "add_track", author: "claude", kind: "video", name: "SCRATCH", index: 0, ref: "tmp" },
		{ op: "insert", author: "claude", track: "tmp", t: p.startTime / TICKS, media: mediaId ?? "m", in: span.inS, out: Math.min(webm.duration, span.inS + span.usedS), name: "scratch", ref: "seg" },
	];
	const first = applyOps(snapshot as unknown as OpsProject, ops as unknown as Op[], { seed: `segment/${plateId}/${union.start}`, mode: "atomic" });
	if (!first.ok) throw new Error(`could not lay out the person segment: ${JSON.stringify(first.conflicts.slice(0, 2))}`);
	const scratch = first.project as unknown as ProjectSnapshot;
	finishCutout({ snapshot: scratch, plateId, cutoutId: first.changes.refs.seg, job, faces, span });
	const cuts: Record<string, unknown>[] = [];
	let target = first.changes.refs.seg;
	if (union.start > p.startTime) cuts.push({ op: "split", author: "claude", el: target, t: union.start / TICKS, ref: "right" });
	const tail = union.end < p.startTime + p.duration;
	let second = { project: scratch as unknown, refs: {} as Record<string, string> };
	if (cuts.length) {
		const result = applyOps(scratch as unknown as OpsProject, cuts as unknown as Op[], { seed: `segment/${plateId}/${union.start}/a`, mode: "atomic" });
		if (!result.ok) throw new Error(`could not cut the person segment: ${JSON.stringify(result.conflicts.slice(0, 2))}`);
		second = { project: result.project, refs: result.changes.refs };
		target = result.changes.refs.right;
	}
	if (tail) {
		const result = applyOps(second.project as OpsProject, [{ op: "split", author: "claude", el: target, t: union.end / TICKS }] as unknown as Op[], { seed: `segment/${plateId}/${union.start}/b`, mode: "atomic" });
		if (!result.ok) throw new Error(`could not cut the person segment: ${JSON.stringify(result.conflicts.slice(0, 2))}`);
		second = { project: result.project, refs: result.changes.refs };
	}
	const made = locate(activeScene(second.project as ProjectSnapshot), target);
	if (!made) throw new Error("the person segment was not found after cutting it (internal)");
	const el = made.element;
	const source = (el.restorff as { cutout?: ServerCutoutSource } | undefined)?.cutout;
	const rate = rateOf(p);
	const offsetS = ((el.startTime - p.startTime) / TICKS) * rate;
	return {
		name: `${p.name || "clip"} · cutout`,
		startTime: el.startTime,
		duration: el.duration,
		trimStart: el.trimStart,
		trimEnd: el.trimEnd,
		sourceDuration: el.sourceDuration,
		params: el.params ? structuredClone(el.params) : {},
		animations: el.animations ? structuredClone(el.animations) : undefined,
		effects: el.effects ? structuredClone(el.effects) : undefined,
		retime: el.retime ? structuredClone(el.retime) : undefined,
		isSourceAudioEnabled: false,
		hidden: false,
		cutout: source ? { ...source, start: s3(source.start + offsetS), end: s3(source.start + offsetS + ((el.duration / TICKS) * rate)), createdAt: new Date().toISOString() } : undefined,
	};
}

/**
 * ops@1 that put a segment on the person lane (`lane` = a track id, or null = a new V2 CUTOUT lane at `index`), with
 * `mediaId` reused or the person video imported (ref cutout_media). Refs: cutout_track, cutout_clip.
 */
export function segmentOps({
	plate,
	job,
	fields,
	lane,
	index,
	mediaId,
	merge,
}: {
	plate: Located;
	job: MatteJob;
	fields: Record<string, unknown>;
	lane: string | null;
	index: number;
	mediaId: string | null;
	merge: Located[];
}): Record<string, unknown>[] {
	const webm = job.outputs?.person_webm;
	if (!webm) throw new Error("the matte job has no person video");
	const name = `${plate.element.name || "clip"} · cutout`;
	const start = fields.startTime as number;
	const duration = fields.duration as number;
	const trimStart = fields.trimStart as number;
	const rate = rateOf(plate.element);
	return [
		...merge.map((seg) => ({ op: "delete", author: "claude", el: seg.element.id })),
		...(mediaId ? [] : [{ op: "import_media", author: "claude", kind: "video", name, url: `matte:${job.media_hash}/${job.variant}/person.webm`, duration: webm.duration, width: webm.width, height: webm.height, fps: webm.fps, has_audio: false, ref: "cutout_media" }]),
		...(lane
			? []
			: [
					{ op: "add_track", author: "claude", kind: "video", name: CUTOUT_TRACK_NAME, index, ref: "cutout_track" },
					{ op: "set", author: "claude", track: "cutout_track", prop: "muted", value: true },
				]),
		{ op: "insert", author: "claude", track: lane ?? "cutout_track", t: start / TICKS, media: mediaId ?? "cutout_media", in: trimStart / TICKS, out: (trimStart + duration * rate) / TICKS, name, ref: "cutout_clip" },
	];
}

/** After the reducer placed the segment: give it the fields segmentFields made (keys, transform, cutout source). */
export function finishSegment(snapshot: ProjectSnapshot, cutoutId: string, fields: Record<string, unknown>): void {
	const made = locate(activeScene(snapshot), cutoutId);
	if (!made) throw new Error("the person segment was not found after placing it (internal)");
	const { cutout, ...rest } = fields;
	Object.assign(made.element, rest);
	if (rest.animations === undefined) delete (made.element as { animations?: unknown }).animations;
	made.element.restorff = { ...((made.element.restorff ?? {}) as Record<string, unknown>), cutout } as SnapshotElement["restorff"];
}

/** Store the person WebM in the project's media store under the reducer's media id (the editor pulls it). */
export async function uploadPerson(projectId: string, mediaId: string, job: MatteJob, name: string): Promise<{ bytes: number }> {
	const bytes = await readFile(matteOutputFiles(job).webm);
	const webm = job.outputs?.person_webm;
	const meta = { name: `${name}.webm`, type: "video", width: webm?.width, height: webm?.height, duration: webm?.duration, fps: webm?.fps, hasAudio: false, size: bytes.byteLength, lastModified: Date.now() };
	const request = new Request("http://restorffcut.internal/media", {
		method: "PUT",
		body: new Uint8Array(bytes),
		headers: { "content-type": "video/webm", "x-media-meta": Buffer.from(JSON.stringify(meta), "utf8").toString("base64url") },
	});
	await putProjectMedia(projectId, mediaId, request);
	return { bytes: bytes.byteLength };
}
