/**
 * Server-side person matte + face boxes (mcp-cutout agent, 2026-10-20; EDT-22). Runbook:
 * docs/restorff/worklog/mcp-cutout.md.
 *
 * A matte job takes one media file of the project media store (content-addressed by sha256) and runs, in HEADLESS
 * Chromium, exactly the browser code the editor's Person tools use: the cutout agent's MediaPipe segmentation worker
 * (`@/segmentation`, tasks-vision 0.10.35, multiclass selfie model) and its VP9-with-alpha render worker
 * (`@/cutout/render`), plus MediaPipe's BlazeFace short-range face detector (Apache-2.0, model card READ 2026-10-20).
 * Outputs, cached by media hash:
 *
 *   <MATTE_ROOT>/<sha256>/<variant>/person.webm   the person only, transparent background (WebM VP9 alpha), same
 *                                                  timebase as the source from `range.start` (variant "full": 0)
 *   <MATTE_ROOT>/<sha256>/<variant>/faces.json    restorffcut-faces@1: per analysed frame (15 fps) the detector's
 *                                                  faces (box, score, 6 keypoints) + the segmenter's person/head/face
 *   <MATTE_ROOT>/<sha256>/<variant>/job.json      state, progress, timings, speeds (frames per second per phase)
 *
 * The job runs in the background as its own process (`node --experimental-transform-types src/server/matte-driver.ts
 * <dir>`, or bun; see driverCommand), which drives Chromium
 * over CDP with scripts/render/cdp.ts and opens the dev-only page /matte/<job_id>), so a crash or a slow encode never
 * blocks or takes down the web server. `job_id` = `<sha256[0:24]>.<variant>`.
 *
 * THE PLATFORM CAPABILITY other agents read (caption zones, effects): `getFaceBoxes(mediaHash)` → the face track, and
 * `faceAt(track, t)` → the main face at a source time. `mediaHashOf(projectId, mediaId)` maps a clip's media id to
 * the hash. Boxes are [x, y, w, h] in 0..1 of the SOURCE frame, top-left origin; times are SOURCE seconds.
 *
 * Paths and tunables live here and only here (env overrides):
 *   RESTORFFCUT_MATTE_DIR     default <apps/web>/.data/mattes (git-ignored)
 *   RESTORFFCUT_MATTE_RUNTIME default: the server's own runtime (process.execPath; Node 24 or bun) runs the driver
 *   RESTORFFCUT_DEV_URL       default http://localhost:8791 (the page the driver opens; never starts a server)
 *   RESTORFFCUT_MATTE_MAX_S   default 120 (longest span one job analyses)
 */
import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statfsSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, resolveMediaDir } from "@/lib/db/store";
import { rcMediaObjects, rcProjectMedia } from "@/lib/db/store-schema";
import type { Box } from "@/segmentation/types";
import { HttpError } from "./http";
import { getProjectRow } from "./projects";

// ─── paths + tunables ────────────────────────────────────────────────────────────────────────────────────────

export const MATTE_JOB_SCHEMA = "restorffcut-matte-job@1";
export const FACES_SCHEMA = "restorffcut-faces@1";

export function matteRoot(): string {
	const configured = process.env.RESTORFFCUT_MATTE_DIR?.trim();
	return configured ? path.resolve(configured) : path.join(process.cwd(), ".data", "mattes");
}

/** The driver script (run as its own process, never bundled by Next). */
export function matteDriverPath(): string {
	return path.join(process.cwd(), "src", "server", "matte-driver.ts");
}

/**
 * How the driver is started: the server's own runtime. Node (the dev server runs on Node 24) needs
 * --experimental-transform-types for scripts/render/cdp.ts (parameter properties); bun runs .ts as is.
 * Incident 2026-10-20: `spawn("bun")` from the dev server failed with ENOENT — on this PC `bun` on PATH is npm's
 * shell shim (bun.cmd), not an .exe, and Node's spawn does not run .cmd files without a shell.
 */
export function driverCommand(dir: string): { command: string; args: string[] } {
	const command = process.env.RESTORFFCUT_MATTE_RUNTIME?.trim() || process.execPath;
	const isBun = /^bun(\.exe)?$/i.test(path.basename(command));
	return {
		command,
		args: isBun ? [matteDriverPath(), dir] : ["--experimental-transform-types", "--no-warnings", matteDriverPath(), dir],
	};
}

export const MATTE_DEV_URL = (process.env.RESTORFFCUT_DEV_URL || "http://localhost:8791").replace(/\/$/, "");
export const MATTE_MAX_SECONDS = Number(process.env.RESTORFFCUT_MATTE_MAX_S) || 120;
/** Matte analysis rate (the cutout agent's MATTE_ANALYSIS_FPS); face boxes are reported at the same times. */
export const MATTE_FPS = 15;
/** Output rate cap of person.webm (the source rate when lower). */
export const MATTE_OUTPUT_MAX_FPS = 30;
/** Long side of the frames the face detector sees (BlazeFace works at 128 x 128 internally). */
export const FACE_LONG_SIDE = 640;
/** Refuse to start a job when the matte folder's disk has less than this free. */
export const MIN_FREE_BYTES = 2 * 1024 ** 3;
/** BlazeFace short range (Apache-2.0 per its model card). Same bucket as the segmentation models. */
export const FACE_MODEL_URL =
	process.env.NEXT_PUBLIC_RESTORFF_FACE_DETECTOR_URL ||
	"https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite";

// ─── types (the faces file is the shared contract) ─────────────────────────────────────────────────────────────

export interface FaceDetection {
	/** [x, y, w, h], 0..1 of the source frame. */
	box: Box;
	score: number;
	/** BlazeFace's 6 keypoints, 0..1: right eye, left eye, nose tip, mouth centre, right ear, left ear. */
	keypoints: Array<[number, number]>;
}

export interface FaceFrame {
	/** Source time, seconds. */
	t: number;
	/** Detector faces, largest first. */
	faces: FaceDetection[];
	/** Segmenter boxes at the same time (multiclass model): the person, head (face + hair), face skin. */
	person: Box | null;
	head: Box | null;
	face_seg: Box | null;
	/** Fraction of the frame that is person. */
	coverage: number;
}

export interface FaceTrack {
	schema: typeof FACES_SCHEMA;
	media_hash: string;
	source: { width: number; height: number; duration: number; fps: number };
	/** Source span analysed, seconds. */
	range: { start: number; end: number };
	fps: number;
	detector: { name: string; model_url: string; delegate: string; long_side: number };
	segmenter: { model: string; delegate: string; long_side: number };
	frames: FaceFrame[];
	summary: {
		frames: number;
		/** Share of frames with at least one detected face. */
		face_found: number;
		/** Median boxes over the span (null when never found). */
		face: Box | null;
		head: Box | null;
		person: Box | null;
		max_faces: number;
	};
}

export type MatteState = "queued" | "running" | "done" | "error";

export interface MatteSpec {
	job_id: string;
	media_hash: string;
	variant: string;
	/** Absolute path of the source file (served to the page by /matte/<job>/source). */
	file: string;
	mime: string;
	name: string;
	/** Source span, seconds; end null = to the end of the media (capped at MATTE_MAX_SECONDS). */
	start: number;
	end: number | null;
	max_seconds: number;
	matte_fps: number;
	out_max_fps: number;
	face_long_side: number;
	face_model_url: string;
	dev_url: string;
}

export interface MatteJob {
	schema: typeof MATTE_JOB_SCHEMA;
	job_id: string;
	media_hash: string;
	variant: string;
	state: MatteState;
	phase: string;
	/** 0..1 within the phase. */
	progress: number;
	done: number;
	total: number;
	spec: MatteSpec;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	pid: number | null;
	error: string | null;
	outputs?: {
		person_webm: { file: string; bytes: number; width: number; height: number; fps: number; frames: number; duration: number };
		faces: { file: string; frames: number };
	};
	source?: { width: number; height: number; duration: number; fps: number };
	range?: { start: number; end: number };
	timings?: Record<string, number>;
	speed?: Record<string, number>;
	env?: Record<string, unknown>;
	console?: Array<{ type: string; text: string }>;
}

// ─── media lookup ─────────────────────────────────────────────────────────────────────────────────────────────

export interface MediaRecord {
	media_id: string;
	hash: string;
	mime: string;
	size: number;
	meta: Record<string, unknown> | null;
	file: string;
}

function mediaFile(hash: string): string {
	return path.join(resolveMediaDir(), hash.slice(0, 2), hash);
}

/** A project's media id → its file in the media store (null when the editor never uploaded it). */
export async function projectMediaRecord(projectId: string, mediaId: string): Promise<MediaRecord | null> {
	const db = await getDb();
	await getProjectRow(db, projectId);
	const [row] = await db
		.select({ hash: rcProjectMedia.hash, meta: rcProjectMedia.meta, mime: rcMediaObjects.mime, size: rcMediaObjects.size })
		.from(rcProjectMedia)
		.innerJoin(rcMediaObjects, eq(rcMediaObjects.hash, rcProjectMedia.hash))
		.where(and(eq(rcProjectMedia.projectId, projectId), eq(rcProjectMedia.mediaId, mediaId)))
		.limit(1);
	if (!row) return null;
	return {
		media_id: mediaId,
		hash: row.hash,
		mime: row.mime,
		size: Number(row.size),
		meta: (row.meta as Record<string, unknown> | null) ?? null,
		file: mediaFile(row.hash),
	};
}

/** The sha256 of a project's media (the key every matte output is cached under). */
export async function mediaHashOf(projectId: string, mediaId: string): Promise<string | null> {
	return (await projectMediaRecord(projectId, mediaId))?.hash ?? null;
}

// ─── job folders ──────────────────────────────────────────────────────────────────────────────────────────────

const HASH_RE = /^[0-9a-f]{64}$/;
const VARIANT_RE = /^(full|r\d{1,9}-\d{1,9})$/;

export function variantFor(range?: { start?: number | null; end?: number | null }): string {
	const start = range?.start ?? 0;
	const end = range?.end ?? null;
	if (start <= 0 && end == null) return "full";
	return `r${Math.round(Math.max(0, start) * 1000)}-${end == null ? 0 : Math.round(end * 1000)}`;
}

export function jobIdFor(hash: string, variant: string): string {
	return `${hash.slice(0, 24)}.${variant}`;
}

export function jobDirFor(hash: string, variant: string): string {
	return path.join(matteRoot(), hash, variant);
}

/** job id → its folder (null when unknown). */
export function resolveMatteJob(jobId: string): { hash: string; variant: string; dir: string } | null {
	const match = /^([0-9a-f]{8,64})\.(full|r\d{1,9}-\d{1,9})$/.exec(jobId);
	if (!match) return null;
	const [, prefix, variant] = match;
	const root = matteRoot();
	if (!existsSync(root)) return null;
	const hash = readdirSync(root).find((name) => HASH_RE.test(name) && name.startsWith(prefix));
	if (!hash) return null;
	const dir = jobDirFor(hash, variant);
	return existsSync(path.join(dir, "job.json")) ? { hash, variant, dir } : null;
}

function writeJson(file: string, value: unknown) {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
	renameSync(tmp, file);
}

function pidAlive(pid: number | null): boolean {
	if (!pid || pid <= 0) return false;
	try {
		// Signal 0 only checks that the process exists; nothing is sent.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Reads a job; a queued/running job whose driver process is gone is reported as an error (stale). */
export function readMatteJob(dir: string): MatteJob | null {
	const file = path.join(dir, "job.json");
	if (!existsSync(file)) return null;
	let job: MatteJob;
	try {
		job = JSON.parse(readFileSync(file, "utf8")) as MatteJob;
	} catch {
		return null;
	}
	if (job.state === "queued" || job.state === "running") {
		const pidFile = path.join(dir, "driver.pid");
		const pid = job.pid ?? (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) || null : null);
		// Give a just-spawned driver a moment to write its first update.
		const age = Date.now() - Date.parse(job.started_at ?? job.created_at);
		if (age > 15_000 && !pidAlive(pid)) {
			job.state = "error";
			job.error = pid
				? `the matte driver (pid ${pid}) stopped without finishing; see ${path.join(dir, "driver.log")}`
				: `the matte driver never started; see ${path.join(dir, "driver.log")}`;
		}
	}
	return job;
}

export function getMatteJob(jobId: string): MatteJob | null {
	const found = resolveMatteJob(jobId);
	return found ? readMatteJob(found.dir) : null;
}

/** The newest job for a media hash (prefers "full"). */
export function findMatteJob(hash: string, variant?: string): MatteJob | null {
	if (variant) return readMatteJob(jobDirFor(hash, variant));
	const base = path.join(matteRoot(), hash);
	if (!existsSync(base)) return null;
	const variants = readdirSync(base).filter((name) => VARIANT_RE.test(name));
	const jobs = variants.map((name) => readMatteJob(path.join(base, name))).filter((job): job is MatteJob => !!job);
	const done = jobs.filter((job) => job.state === "done");
	const pick = (list: MatteJob[]) => list.find((job) => job.variant === "full") ?? list.sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at))[0] ?? null;
	return pick(done) ?? pick(jobs);
}

function freeBytes(dir: string): number | null {
	try {
		const stats = statfsSync(dir);
		return Number(stats.bavail) * Number(stats.bsize);
	} catch {
		return null;
	}
}

/**
 * Starts (or reuses) the matte job for a media file. Cached: a done job whose outputs exist is returned as is;
 * a running one is returned with its progress. `force` re-runs it.
 */
export function startMatteJob({
	media,
	range,
	force = false,
}: {
	media: MediaRecord;
	range?: { start?: number | null; end?: number | null };
	force?: boolean;
}): { job: MatteJob; cached: boolean; started: boolean } {
	if (!existsSync(media.file)) throw new HttpError(410, `media ${media.media_id} is recorded but its file is missing`);
	if (!media.mime.startsWith("video/")) {
		throw new HttpError(400, `media ${media.media_id} is ${media.mime}; the server matte works on video (stills: use the editor's Person tools)`);
	}
	const variant = variantFor(range);
	const dir = jobDirFor(media.hash, variant);
	const existing = readMatteJob(dir);
	if (existing && !force) {
		const outputsThere =
			existing.state === "done" &&
			existsSync(path.join(dir, "person.webm")) &&
			existsSync(path.join(dir, "faces.json"));
		if (outputsThere) return { job: existing, cached: true, started: false };
		if (existing.state === "queued" || existing.state === "running") return { job: existing, cached: false, started: false };
	}
	mkdirSync(dir, { recursive: true });
	const free = freeBytes(dir);
	if (free != null && free < MIN_FREE_BYTES) {
		throw new HttpError(507, `only ${(free / 1024 ** 3).toFixed(1)} GB free on the matte disk (needs ${MIN_FREE_BYTES / 1024 ** 3} GB); nothing started`);
	}
	const jobId = jobIdFor(media.hash, variant);
	const name = typeof media.meta?.name === "string" ? (media.meta.name as string) : media.media_id;
	const spec: MatteSpec = {
		job_id: jobId,
		media_hash: media.hash,
		variant,
		file: media.file,
		mime: media.mime,
		name,
		start: Math.max(0, range?.start ?? 0),
		end: range?.end ?? null,
		max_seconds: MATTE_MAX_SECONDS,
		matte_fps: MATTE_FPS,
		out_max_fps: MATTE_OUTPUT_MAX_FPS,
		face_long_side: FACE_LONG_SIDE,
		face_model_url: FACE_MODEL_URL,
		dev_url: MATTE_DEV_URL,
	};
	const now = new Date().toISOString();
	const job: MatteJob = {
		schema: MATTE_JOB_SCHEMA,
		job_id: jobId,
		media_hash: media.hash,
		variant,
		state: "queued",
		phase: "queued",
		progress: 0,
		done: 0,
		total: 0,
		spec,
		created_at: now,
		started_at: now,
		finished_at: null,
		pid: null,
		error: null,
	};
	writeJson(path.join(dir, "job.json"), job);
	const log = openSync(path.join(dir, "driver.log"), "a");
	try {
		const { command, args } = driverCommand(dir);
		const child = spawn(command, args, {
			cwd: process.cwd(),
			detached: true,
			stdio: ["ignore", log, log],
			windowsHide: true,
			env: { ...process.env },
		});
		child.on("error", (error) => {
			const failed = readMatteJob(dir) ?? job;
			writeJson(path.join(dir, "job.json"), { ...failed, state: "error", error: `could not start the matte driver: ${error.message}`, finished_at: new Date().toISOString() });
		});
		child.unref();
		job.pid = child.pid ?? null;
		// The driver owns job.json from here on; the pid goes in its own file (no write race).
		if (job.pid) writeFileSync(path.join(dir, "driver.pid"), String(job.pid));
	} finally {
		closeSync(log);
	}
	return { job: readMatteJob(dir) ?? job, cached: false, started: true };
}

/** Polls a job until it is done/error or `waitMs` passes. */
export async function waitForMatte(jobId: string, waitMs: number, signal?: AbortSignal): Promise<MatteJob | null> {
	const until = Date.now() + Math.max(0, waitMs);
	let job = getMatteJob(jobId);
	while (job && (job.state === "queued" || job.state === "running") && Date.now() < until && !signal?.aborted) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		job = getMatteJob(jobId);
	}
	return job;
}

export function matteOutputFiles(job: MatteJob): { webm: string; faces: string; dir: string } {
	const dir = jobDirFor(job.media_hash, job.variant);
	return { dir, webm: path.join(dir, "person.webm"), faces: path.join(dir, "faces.json") };
}

// ─── the face-box reader (other agents: caption zones, effects) ─────────────────────────────────────────────────

/**
 * The face track of a media file (by sha256), or null when no matte job has finished for it. Prefers the whole-file
 * variant. Start one with the MCP `cutout matte` (or `startMatteJob`).
 */
export function getFaceBoxes(mediaHash: string, opts: { variant?: string } = {}): FaceTrack | null {
	if (!HASH_RE.test(mediaHash)) return null;
	const job = findMatteJob(mediaHash, opts.variant);
	if (!job || job.state !== "done") return null;
	const file = matteOutputFiles(job).faces;
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as FaceTrack;
	} catch {
		return null;
	}
}

/** The frame nearest to a source time, and its main (largest) face — detector first, else the segmenter's. */
export function faceAt(track: FaceTrack, t: number): { frame: FaceFrame | null; face: Box | null; head: Box | null } {
	const frames = track.frames;
	if (!frames.length) return { frame: null, face: null, head: null };
	const index = Math.max(0, Math.min(frames.length - 1, Math.round((t - track.range.start) * track.fps)));
	const frame = frames[index];
	return { frame, face: frame.faces[0]?.box ?? frame.face_seg ?? null, head: frame.head ?? frame.faces[0]?.box ?? null };
}

/** Bytes on disk of a file (0 when missing). */
export function fileBytes(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
}
