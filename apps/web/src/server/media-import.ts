/**
 * Media into a server project without a browser (mcp-media agent, 2026-10-20; PARITY G01). A Claude over MCP brings a
 * file in one of four ways; each lands as a local file that is probed (ffprobe), hashed (sha256) and stored in the
 * project's media store (`./media.ts` putProjectMedia — the same store the editor uploads to and pulls from):
 *
 *   url          the server fetches it through ./safe-fetch.ts (http/https only, public addresses only — private,
 *                loopback, link-local and metadata addresses refused, redirects re-checked — size-capped, time-limited;
 *                dev allow-list RESTORFFCUT_FETCH_ALLOW)
 *   data_base64  the bytes in the call (the MCP body cap is 1,000,000 characters, so ≈ 700 KB of file at most)
 *   path_hint    a file on the server's own disk (local dev: any absolute path; production: only under
 *                RESTORFFCUT_IMPORT_ROOTS); a media extension and a stream ffprobe can read are required either way
 *   upload_id    a file sent first with `PUT <put_url>` (a signed, expiring URL from `media upload_url`), for big
 *                files a Claude has on its own machine: `curl -T file "<put_url>"`
 *
 *   RESTORFFCUT_IMPORT_MAX_MB   largest import (default 1024)
 *   RESTORFFCUT_IMPORT_ROOTS    `;`-separated folders a path import may read (required in production)
 *   RESTORFFCUT_UPLOAD_SECRET   HMAC key for upload URLs (default RESTORFFCUT_SERVICE_TOKEN, else a per-process key)
 *   RESTORFFCUT_FFPROBE         ffprobe binary (default "ffprobe" on PATH)
 * Staging lives under the media dir (`<RESTORFFCUT_MEDIA_DIR>/import-tmp`, `/uploads`), git-ignored with it.
 * Runbook: docs/restorff/worklog/mcp-media.md.
 */
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { resolveMediaDir } from "@/lib/db/store";
import { HttpError } from "./http";
import { putProjectMedia, type MediaDto } from "./media";
import { safeFetch } from "./safe-fetch";

export const IMPORT_MAX_BYTES = Math.max(1, Number(process.env.RESTORFFCUT_IMPORT_MAX_MB) || 1024) * 1024 * 1024;
const FFPROBE = process.env.RESTORFFCUT_FFPROBE?.trim() || "ffprobe";
const FETCH_TIMEOUT_MS = 120_000;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const UPLOAD_ID_RE = /^up_[a-f0-9]{32}$/;

export type MediaKind = "video" | "audio" | "image";

const MIME_BY_EXT: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
	".wav": "audio/wav",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".ogg": "audio/ogg",
	".opus": "audio/ogg",
	".flac": "audio/flac",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};
const EXT_BY_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]));
export const MEDIA_EXTENSIONS = Object.keys(MIME_BY_EXT);

export interface StagedFile {
	file: string;
	size: number;
	/** Delete `file` when done (true for anything this module copied; false for a path import read in place). */
	temporary: boolean;
	/** A file name to fall back on (from the URL, the path, or the upload). */
	nameHint: string | null;
	/** What the source said the type was (HTTP Content-Type), if anything. */
	contentType: string | null;
	source: "url" | "data_base64" | "path_hint" | "upload";
}

function stagingDir(sub: "import-tmp" | "uploads"): string {
	const dir = path.join(resolveMediaDir(), sub);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function extOf(name: string | null | undefined): string {
	const ext = path.extname(name ?? "").toLowerCase();
	return ext in MIME_BY_EXT ? ext : "";
}

export function discard(staged: StagedFile | null | undefined): void {
	if (!staged?.temporary) return;
	try {
		if (existsSync(staged.file)) unlinkSync(staged.file);
	} catch {
		// a leftover temp file is harmless; the media dir is git-ignored
	}
}

/** Stream a web body to `file`, stopping at `max` bytes. */
async function streamToFile(body: ReadableStream<Uint8Array>, file: string, max: number): Promise<number> {
	let size = 0;
	await new Promise<void>((resolve, reject) => {
		const out = createWriteStream(file);
		const input = Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream);
		input.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > max) input.destroy(new HttpError(413, `file larger than ${Math.round(max / 1048576)} MB`));
		});
		input.on("error", (error) => {
			out.destroy();
			reject(error);
		});
		out.on("error", reject);
		out.on("finish", () => resolve());
		input.pipe(out);
	}).catch((error) => {
		if (existsSync(file)) unlinkSync(file);
		throw error;
	});
	return size;
}

// ─── the four sources ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Fetch an http(s) URL into a temp file (size cap, timeout, the caller's abort signal). Through safeFetch
 * (security-pass, 2026-10-21): private, loopback, link-local and metadata addresses are refused, every redirect is
 * re-checked and the connection is pinned to the checked address (./safe-fetch.ts; dev allow-list
 * RESTORFFCUT_FETCH_ALLOW).
 */
export async function stageFromUrl(raw: string, signal?: AbortSignal): Promise<StagedFile> {
	const response = await safeFetch(raw.trim(), { signal, timeoutMs: FETCH_TIMEOUT_MS, maxBytes: IMPORT_MAX_BYTES }).catch((error: unknown) => {
		if (error instanceof HttpError && error.status === 413) {
			throw new HttpError(413, `${error.message} (the import limit: RESTORFFCUT_IMPORT_MAX_MB)`, error.extra);
		}
		throw error;
	});
	const final = new URL(response.url);
	if (!response.ok) {
		await response.body.cancel().catch(() => {});
		throw new HttpError(502, `${final.host} answered ${response.status} ${response.statusText}`.trim());
	}
	const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim() || null;
	const lastSegment = decodeURIComponent(final.pathname.split("/").filter(Boolean).pop() ?? "") || null;
	const ext = extOf(lastSegment) || (contentType ? (EXT_BY_MIME[contentType] ?? "") : "");
	const file = path.join(stagingDir("import-tmp"), `${randomUUID()}${ext}`);
	const size = await streamToFile(response.body, file, IMPORT_MAX_BYTES);
	if (!size) {
		unlinkSync(file);
		throw new HttpError(400, "the URL returned an empty file");
	}
	return { file, size, temporary: true, nameHint: lastSegment, contentType, source: "url" };
}

/** Decode base64 (a `data:` URL prefix is allowed) into a temp file. */
export async function stageFromBase64(data: string, nameHint: string | null): Promise<StagedFile> {
	const match = /^data:([^;,]+)?(?:;[^,]*)?,/.exec(data.slice(0, 200));
	const contentType = match?.[1] ?? null;
	const body = match ? data.slice(match[0].length) : data;
	const bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
	if (!bytes.length) throw new HttpError(400, "data_base64 decoded to nothing");
	if (bytes.length > IMPORT_MAX_BYTES) throw new HttpError(413, "data_base64 is larger than the import limit");
	const ext = extOf(nameHint) || (contentType ? (EXT_BY_MIME[contentType] ?? "") : "");
	const file = path.join(stagingDir("import-tmp"), `${randomUUID()}${ext}`);
	await writeFile(file, bytes);
	return { file, size: bytes.length, temporary: true, nameHint, contentType, source: "data_base64" };
}

function importRoots(): string[] {
	return (process.env.RESTORFFCUT_IMPORT_ROOTS ?? "")
		.split(";")
		.map((root) => root.trim())
		.filter(Boolean)
		.map((root) => path.resolve(root));
}

const isUnder = (file: string, root: string) => {
	const rel = path.relative(root, file);
	return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * A file on the server's disk, read in place. Null when it is not there (the Claude's own machine, say): the caller
 * then hands out an upload URL instead. Throws when it is there but not allowed.
 */
export function stageFromPath(hint: string): StagedFile | null {
	if (!path.isAbsolute(hint)) throw new HttpError(400, "path_hint must be an absolute path");
	if (!existsSync(hint)) return null;
	const file = realpathSync(hint);
	const info = statSync(file);
	if (!info.isFile()) throw new HttpError(400, "path_hint is not a file");
	if (!extOf(file)) throw new HttpError(400, `path_hint must be a media file (${MEDIA_EXTENSIONS.join(" ")})`);
	if (info.size > IMPORT_MAX_BYTES) throw new HttpError(413, `the file is ${Math.round(info.size / 1048576)} MB; the import limit is ${Math.round(IMPORT_MAX_BYTES / 1048576)} MB`);
	const roots = importRoots();
	if (roots.length) {
		if (!roots.some((root) => isUnder(file, root))) throw new HttpError(403, "path_hint is outside RESTORFFCUT_IMPORT_ROOTS");
	} else if (process.env.NODE_ENV === "production") {
		throw new HttpError(403, "path imports are off on this server (set RESTORFFCUT_IMPORT_ROOTS); use url or upload_url");
	}
	return { file, size: info.size, temporary: false, nameHint: path.basename(file), contentType: null, source: "path_hint" };
}

// ─── signed uploads ───────────────────────────────────────────────────────────────────────────────────────────

interface UploadTicket {
	upload_id: string;
	project_id: string;
	name: string | null;
	expires_at: string;
	created_at: string;
}

function uploadSecret(): string {
	const configured = process.env.RESTORFFCUT_UPLOAD_SECRET?.trim() || process.env.RESTORFFCUT_SERVICE_TOKEN?.trim();
	if (configured) return configured;
	const g = globalThis as unknown as { __restorffcutUploadKey?: string };
	g.__restorffcutUploadKey ??= randomBytes(32).toString("hex");
	return g.__restorffcutUploadKey;
}

const sign = (uploadId: string, projectId: string, expires: number) =>
	createHmac("sha256", uploadSecret()).update(`${uploadId}.${projectId}.${expires}`).digest("base64url");

const ticketPath = (uploadId: string) => path.join(stagingDir("uploads"), `${uploadId}.json`);
export const uploadFilePath = (uploadId: string) => path.join(stagingDir("uploads"), `${uploadId}.bin`);

/** Remove tickets (and their files) more than a day past expiry. Best effort. */
function sweepUploads(): void {
	try {
		const dir = stagingDir("uploads");
		const cutoff = Date.now() - 24 * 3600 * 1000;
		for (const entry of readdirSync(dir)) {
			const full = path.join(dir, entry);
			if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
		}
	} catch {
		// harmless
	}
}

/** A signed PUT path (the caller adds the origin) for one file into one project, valid for an hour. */
export async function createUploadTicket(projectId: string, name: string | null): Promise<{ upload_id: string; token: string; expires_at: string; max_bytes: number }> {
	sweepUploads();
	const uploadId = `up_${randomBytes(16).toString("hex")}`;
	const expires = Date.now() + UPLOAD_TTL_MS;
	const ticket: UploadTicket = { upload_id: uploadId, project_id: projectId, name, expires_at: new Date(expires).toISOString(), created_at: new Date().toISOString() };
	await writeFile(ticketPath(uploadId), JSON.stringify(ticket));
	return { upload_id: uploadId, token: `${uploadId}.${expires}.${sign(uploadId, projectId, expires)}`, expires_at: ticket.expires_at, max_bytes: IMPORT_MAX_BYTES };
}

async function readTicket(uploadId: string): Promise<UploadTicket | null> {
	if (!UPLOAD_ID_RE.test(uploadId)) return null;
	try {
		return JSON.parse(await readFile(ticketPath(uploadId), "utf8")) as UploadTicket;
	} catch {
		return null;
	}
}

/** PUT /api/media-uploads/:token — the token is the credential (HMAC over upload id, project, expiry). */
export async function receiveUpload(token: string, request: Request): Promise<{ upload_id: string; bytes: number; sha256: string }> {
	const [uploadId, expiresText, signature] = token.split(".");
	const expires = Number(expiresText);
	const ticket = uploadId ? await readTicket(uploadId) : null;
	if (!ticket || !signature || !Number.isFinite(expires)) throw new HttpError(404, "upload link not found");
	const expected = Buffer.from(sign(uploadId, ticket.project_id, expires));
	const given = Buffer.from(signature);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new HttpError(404, "upload link not found");
	if (Date.now() > expires) throw new HttpError(410, "upload link expired: ask media upload_url for a new one");
	if (!request.body) throw new HttpError(400, "the file goes in the request body");
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > IMPORT_MAX_BYTES) throw new HttpError(413, `file larger than ${Math.round(IMPORT_MAX_BYTES / 1048576)} MB`);
	const file = uploadFilePath(uploadId);
	const size = await streamToFile(request.body, `${file}.part`, IMPORT_MAX_BYTES);
	if (!size) {
		unlinkSync(`${file}.part`);
		throw new HttpError(400, "empty file");
	}
	if (existsSync(file)) unlinkSync(file);
	renameSync(`${file}.part`, file);
	return { upload_id: uploadId, bytes: size, sha256: await sha256File(file) };
}

/** The file a finished upload left, checked against the project it was issued for. */
export async function stageFromUpload(uploadId: string, projectId: string): Promise<StagedFile & { ticket: UploadTicket }> {
	const ticket = await readTicket(uploadId);
	if (!ticket) throw new HttpError(404, `no upload ${uploadId}: ask media upload_url first`);
	if (ticket.project_id !== projectId) throw new HttpError(403, `upload ${uploadId} was issued for another timeline`);
	const file = uploadFilePath(uploadId);
	if (!existsSync(file)) throw new HttpError(409, `upload ${uploadId} has no file yet: PUT it to the put_url first`);
	return { file, size: statSync(file).size, temporary: true, nameHint: ticket.name, contentType: null, source: "upload", ticket };
}

/** After a successful import: drop the ticket too (the file goes with discard()). */
export function forgetUpload(uploadId: string): void {
	try {
		const ticket = ticketPath(uploadId);
		if (existsSync(ticket)) unlinkSync(ticket);
	} catch {
		// harmless
	}
}

// ─── probe, hash, store ───────────────────────────────────────────────────────────────────────────────────────

export interface MediaProbe {
	kind: MediaKind;
	/** Seconds; null for a still image. */
	duration: number | null;
	width: number | null;
	height: number | null;
	fps: number | null;
	hasAudio: boolean;
	format: string;
	video_codec: string | null;
	audio_codec: string | null;
	/** Degrees the picture is rotated by its container (width/height above are already swapped for 90/270). */
	rotation: number;
}

interface ProbeStream {
	codec_type?: string;
	codec_name?: string;
	width?: number;
	height?: number;
	avg_frame_rate?: string;
	r_frame_rate?: string;
	duration?: string;
	nb_frames?: string;
	disposition?: { attached_pic?: number };
	tags?: { rotate?: string };
	side_data_list?: Array<{ rotation?: number }>;
}

function rate(text: string | undefined): number | null {
	if (!text) return null;
	const [a, b] = text.split("/").map(Number);
	if (!a || !Number.isFinite(a)) return null;
	const value = b ? a / b : a;
	return value > 0 && value < 1000 ? Math.round(value * 1000) / 1000 : null;
}

/** Parse `ffprobe -show_streams -show_format -of json` (exported for tests). */
export function parseProbe(json: string): MediaProbe | null {
	let data: { streams?: ProbeStream[]; format?: { format_name?: string; duration?: string } };
	try {
		data = JSON.parse(json);
	} catch {
		return null;
	}
	const streams = data.streams ?? [];
	const format = data.format?.format_name ?? "";
	const video = streams.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
	const audio = streams.find((stream) => stream.codec_type === "audio");
	if (!video && !audio) return null;
	const still =
		!!video &&
		(/(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|gif|gif_pipe)(,|$)/.test(format) ||
			(["png", "mjpeg", "webp", "bmp", "tiff"].includes(video.codec_name ?? "") && Number(video.nb_frames ?? "1") <= 1 && !audio));
	const kind: MediaKind = video ? (still ? "image" : "video") : "audio";
	const durationText = data.format?.duration ?? video?.duration ?? audio?.duration;
	const duration = kind === "image" ? null : durationText && Number(durationText) > 0 ? Math.round(Number(durationText) * 1000) / 1000 : null;
	const rotation = Number(video?.side_data_list?.find((entry) => typeof entry.rotation === "number")?.rotation ?? video?.tags?.rotate ?? 0) || 0;
	const sideways = Math.abs(rotation) % 180 === 90;
	return {
		kind,
		duration,
		width: video?.width ? (sideways ? video.height ?? null : video.width) : null,
		height: video?.height ? (sideways ? video.width ?? null : video.height) : null,
		fps: kind === "video" ? (rate(video?.avg_frame_rate) ?? rate(video?.r_frame_rate)) : null,
		hasAudio: !!audio,
		format,
		video_codec: video?.codec_name ?? null,
		audio_codec: audio?.codec_name ?? null,
		rotation,
	};
}

export function probeMedia(file: string): Promise<MediaProbe> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const child = spawn(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { windowsHide: true, timeout: 60_000 });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-2000);
		});
		child.on("error", (error) => reject(new HttpError(500, `ffprobe could not run (${FFPROBE}): ${error.message}`)));
		child.on("close", (code) => {
			const probe = code === 0 ? parseProbe(stdout) : null;
			if (!probe) reject(new HttpError(415, `not a video, audio or image file ffprobe can read${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""}`));
			else resolve(probe);
		});
	});
}

export function sha256File(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(file)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolve(hash.digest("hex")));
	});
}

export function mimeFor(staged: StagedFile, probe: MediaProbe, name: string): string {
	const byExt = MIME_BY_EXT[extOf(staged.file)] ?? MIME_BY_EXT[extOf(name)] ?? MIME_BY_EXT[extOf(staged.nameHint)];
	if (byExt) return byExt;
	if (staged.contentType && /^(video|audio|image)\//.test(staged.contentType)) return staged.contentType;
	if (probe.kind === "image") return /png/.test(probe.format) ? "image/png" : /webp/.test(probe.format) ? "image/webp" : "image/jpeg";
	if (probe.kind === "audio") return /wav/.test(probe.format) ? "audio/wav" : /mp3/.test(probe.format) ? "audio/mpeg" : "audio/mp4";
	return /webm|matroska/.test(probe.format) ? "video/webm" : /mov|mp4/.test(probe.format) ? "video/mp4" : "application/octet-stream";
}

/**
 * Store the file in the project's media store under `mediaId`, with the editor's MediaAssetData as meta (so the
 * editor's importRemoteMedia files it under the right name and type).
 */
export async function storeStagedFile(
	projectId: string,
	mediaId: string,
	staged: StagedFile,
	{ name, mime, sha, probe, kind = probe.kind }: { name: string; mime: string; sha: string; probe: MediaProbe; kind?: MediaKind },
): Promise<MediaDto> {
	const meta = {
		name,
		type: kind,
		width: probe.width ?? undefined,
		height: probe.height ?? undefined,
		duration: probe.duration ?? undefined,
		fps: probe.fps ?? undefined,
		hasAudio: probe.hasAudio,
		size: staged.size,
		lastModified: Date.now(),
	};
	const body = Readable.toWeb(createReadStream(staged.file)) as unknown as ReadableStream<Uint8Array>;
	const request = new Request("http://restorffcut.internal/media", {
		method: "PUT",
		body,
		headers: {
			"content-type": mime,
			"x-media-meta": Buffer.from(JSON.stringify(meta), "utf8").toString("base64url"),
			"x-media-sha256": sha,
		},
		// a streamed request body (Node's fetch Request needs this; Bun ignores it)
		duplex: "half",
	} as RequestInit & { duplex: "half" });
	return putProjectMedia(projectId, mediaId, request);
}
