/**
 * Reference sets (EDT-21, PARITY G14; mcp-references agent, 2026-10-20): the image and video files a Claude (or the
 * person) drops as references for ONE timeline, studied into a style card, plus every explainer version built from
 * them. References are third-party material: they are studied, never imported into the project's media (BUILD-BRIEF
 * §6 rule 11; PARITY G14 "references stay outside projects").
 *
 * On disk (git-ignored, like the media store):
 *   $RESTORFFCUT_REFERENCES_DIR, else <apps/web>/.data/references
 *     <timeline_id>/set.json            ReferenceSet: files, the last study (card), versions
 *     <timeline_id>/files/<sha256>.<ext> the files, content-addressed
 *
 * Files come in four ways: base64 (`data`, ≤ ~700 KB: an MCP request is capped at 1 MB), an http(s) `url` (fetched
 * through ./safe-fetch.ts: public addresses only — security-pass, 2026-10-21), a local
 * `path` on the server's machine (a file or a whole folder — the folder's name becomes the reference folder; local dev
 * only, off when NODE_ENV=production or RESTORFFCUT_REFERENCES_PATHS=0), a `media_id` of the timeline's media store
 * (what `media import` makes), and the raw-upload route POST /api/references/<timeline_id>.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { StyleCard } from "@restorffcut/styles";
import { resolveMediaDir } from "@/lib/db/store";
import { HttpError } from "./http";
import { listProjectMedia } from "./media";
import { probeMedia } from "./references-frames";
import { safeFetch } from "./safe-fetch";

/** A reference by url: the whole download (security-pass, 2026-10-21; there was no limit). */
const URL_FETCH_TIMEOUT_MS = 120_000;

export const REFERENCES_DIR = path.resolve(process.env.RESTORFFCUT_REFERENCES_DIR?.trim() || path.join(process.cwd(), ".data", "references"));
/** Files per set. */
export const MAX_FILES = 80;
/** Bytes per file (url, path, upload). */
export const MAX_FILE_BYTES = (Number(process.env.RESTORFFCUT_REFERENCES_MAX_MB) || 500) * 1024 * 1024;
const TIMELINE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "tif", "tiff"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "m4v", "mkv", "avi"]);
const MIME_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/bmp": "bmp",
	"image/avif": "avif",
	"image/tiff": "tif",
	"video/mp4": "mp4",
	"video/quicktime": "mov",
	"video/webm": "webm",
	"video/x-matroska": "mkv",
	"video/x-m4v": "m4v",
};

export type ReferenceKind = "image" | "video";

export interface ReferenceFile {
	/** Stable id: ref-<first 12 of the sha256>[-<n> when the same bytes sit in two folders]. */
	id: string;
	name: string;
	folder: string | null;
	kind: ReferenceKind;
	ext: string;
	size: number;
	sha256: string;
	width: number;
	height: number;
	/** Seconds (videos). */
	duration: number | null;
	source: "upload" | "url" | "path" | "media";
	/** Where it came from (a URL, a path, a media id); never the bytes. */
	origin: string | null;
	added_at: string;
}

export interface StudiedFile {
	id: string;
	name: string;
	folder: string | null;
	kind: ReferenceKind;
	width: number;
	height: number;
	/** Seconds studied (videos: the first STUDY_SPAN_S). */
	studied_s: number | null;
	/** Cut times (videos). */
	cuts: number[];
	frames: number;
}

export interface ReferenceStudy {
	at: string;
	/** Which files the card was made from (changes when files are added or removed). */
	files_key: string;
	card: StyleCard;
	files: StudiedFile[];
	skipped: string[];
	failed: string[];
}

/** One explainer build (= one commit). `summary` is what the next version's "What's new" is diffed against. */
export interface ExplainerVersion {
	n: number;
	commit_id: string;
	branch: string;
	/** A branch pointing at this version's commit (explainer-v<n>), when it could be made. */
	version_branch: string | null;
	at: string;
	change_note: string;
	/** What this version made, so the next version can replace it. */
	element_ids: string[];
	track_ids: string[];
	media_ids: string[];
	summary: VersionSummary;
}

export interface VersionSummary {
	topic: string;
	answers: Record<string, unknown>;
	canvas: { width: number; height: number };
	duration: number;
	start: number;
	/** tag / pictures: v2 builds (explainer-v2, 2026-10-20) — the beat's label tag and the pictures its line is bound to. */
	beats: Array<{ index: number; kind: string; start: number; end: number; line: string; visual: string; tag?: string; pictures?: string[] }>;
	compositions: Array<{ key: string; name: string; props: Record<string, unknown>; rendered: boolean }>;
	effects: string[];
	assets: string[];
	/** One signature per plan op (ops@1 with placeholders, before binding): the ops diff. */
	op_signatures: string[];
}

export interface ReferenceSet {
	schema: "references-set@1";
	timeline_id: string;
	created_at: string;
	updated_at: string;
	files: ReferenceFile[];
	study: ReferenceStudy | null;
	versions: ExplainerVersion[];
}

export interface ReferenceFileSpec {
	data?: string;
	url?: string;
	path?: string;
	media_id?: string;
	name?: string;
	folder?: string;
	mime?: string;
}

export interface AddResult {
	added: ReferenceFile[];
	skipped: Array<{ name: string; reason: string }>;
	set: ReferenceSet;
}

// ─── paths + locking ────────────────────────────────────────────────────────────────────────────────────────────

export function assertTimelineId(id: string): string {
	if (!TIMELINE_RE.test(id)) throw new HttpError(400, "timeline_id must be 1-128 characters: letters, digits, . _ -");
	return id;
}

export function setDir(timelineId: string): string {
	return path.join(REFERENCES_DIR, assertTimelineId(timelineId));
}

export function filePathOf(timelineId: string, file: Pick<ReferenceFile, "sha256" | "ext">): string {
	return path.join(setDir(timelineId), "files", `${file.sha256}.${file.ext}`);
}

/** One writer per set at a time (add, remove, study and build all rewrite set.json). Survives hot reloads. */
export async function withSetLock<T>(timelineId: string, fn: () => Promise<T>): Promise<T> {
	const g = globalThis as unknown as { __restorffcutReferenceLocks?: Map<string, Promise<unknown>> };
	g.__restorffcutReferenceLocks ??= new Map();
	const locks = g.__restorffcutReferenceLocks;
	const previous = locks.get(timelineId) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(fn);
	locks.set(timelineId, next);
	try {
		return await next;
	} finally {
		if (locks.get(timelineId) === next) locks.delete(timelineId);
	}
}

export async function loadSet(timelineId: string): Promise<ReferenceSet> {
	const file = path.join(setDir(timelineId), "set.json");
	if (!existsSync(file)) {
		const now = new Date().toISOString();
		return { schema: "references-set@1", timeline_id: timelineId, created_at: now, updated_at: now, files: [], study: null, versions: [] };
	}
	const parsed = JSON.parse(await readFile(file, "utf8")) as ReferenceSet;
	parsed.files ??= [];
	parsed.versions ??= [];
	parsed.study ??= null;
	return parsed;
}

export async function saveSet(set: ReferenceSet): Promise<void> {
	const dir = setDir(set.timeline_id);
	await mkdir(dir, { recursive: true });
	set.updated_at = new Date().toISOString();
	const tmp = path.join(dir, `set.${randomUUID()}.tmp`);
	await writeFile(tmp, JSON.stringify(set, null, 1), "utf8");
	await rename(tmp, path.join(dir, "set.json"));
}

/** Changes whenever the set's files change: a stored study with another key is stale. */
export function filesKey(files: readonly ReferenceFile[]): string {
	return createHash("sha256")
		.update(files.map((file) => `${file.sha256}|${file.folder ?? ""}|${file.name}`).sort().join("\n"))
		.digest("hex")
		.slice(0, 16);
}

// ─── kinds ──────────────────────────────────────────────────────────────────────────────────────────────────────

function extOf(name: string): string {
	const match = /\.([A-Za-z0-9]{1,5})$/.exec(name.trim());
	return match ? (match[1] as string).toLowerCase() : "";
}

export function kindOfExt(ext: string): ReferenceKind | null {
	if (IMAGE_EXT.has(ext)) return "image";
	if (VIDEO_EXT.has(ext)) return "video";
	return null;
}

function cleanName(name: string | undefined, fallback: string): string {
	const base = path.basename((name ?? "").trim()).trim();
	return (base || fallback).slice(0, 160);
}

function cleanFolder(folder: string | undefined | null): string | null {
	const value = (folder ?? "").trim().slice(0, 80);
	return value || null;
}

export function pathsAllowed(): boolean {
	return process.env.NODE_ENV !== "production" && process.env.RESTORFFCUT_REFERENCES_PATHS !== "0";
}

// ─── adding ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface Staged {
	tmp: string;
	sha256: string;
	size: number;
	/** Delete `tmp` after use (false for files we only read in place). */
	owned: boolean;
}

async function stageBytes(timelineId: string, bytes: Buffer): Promise<Staged> {
	const dir = path.join(setDir(timelineId), "files");
	await mkdir(dir, { recursive: true });
	const tmp = path.join(dir, `${randomUUID()}.part`);
	await writeFile(tmp, bytes);
	return { tmp, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, owned: true };
}

async function stageStream(timelineId: string, stream: Readable): Promise<Staged> {
	const dir = path.join(setDir(timelineId), "files");
	await mkdir(dir, { recursive: true });
	const tmp = path.join(dir, `${randomUUID()}.part`);
	const hash = createHash("sha256");
	let size = 0;
	await new Promise<void>((resolve, reject) => {
		const out = createWriteStream(tmp);
		stream.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_FILE_BYTES) {
				stream.destroy(new HttpError(413, `a reference is larger than ${MAX_FILE_BYTES} bytes`));
				return;
			}
			hash.update(chunk);
		});
		stream.on("error", (error) => {
			out.destroy();
			reject(error);
		});
		out.on("error", reject);
		out.on("finish", () => resolve());
		stream.pipe(out);
	}).catch(async (error) => {
		if (existsSync(tmp)) await unlink(tmp).catch(() => undefined);
		throw error;
	});
	return { tmp, sha256: hash.digest("hex"), size, owned: true };
}

async function hashFile(file: string): Promise<Staged> {
	const hash = createHash("sha256");
	let size = 0;
	await new Promise<void>((resolve, reject) => {
		const input = createReadStream(file);
		input.on("data", (chunk: Buffer | string) => {
			const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			size += buffer.length;
			hash.update(buffer);
		});
		input.on("error", reject);
		input.on("end", () => resolve());
	});
	return { tmp: file, sha256: hash.digest("hex"), size, owned: false };
}

/** Put a staged file into the set (content-addressed), probe it, and record it. Returns null + reason when skipped. */
async function commitStaged(
	set: ReferenceSet,
	staged: Staged,
	meta: { name: string; folder: string | null; ext: string; source: ReferenceFile["source"]; origin: string | null },
	signal?: AbortSignal,
): Promise<{ file: ReferenceFile } | { reason: string }> {
	const cleanup = async () => {
		if (staged.owned && existsSync(staged.tmp)) await unlink(staged.tmp).catch(() => undefined);
	};
	const kind = kindOfExt(meta.ext);
	if (!kind) {
		await cleanup();
		return { reason: `not an image or a video (.${meta.ext || "?"}); references are images (png, jpg, webp, gif…) and clips (mp4, mov, webm…)` };
	}
	if (set.files.some((file) => file.sha256 === staged.sha256 && file.folder === meta.folder)) {
		await cleanup();
		return { reason: "already in the set (same file, same folder)" };
	}
	if (set.files.length >= MAX_FILES) {
		await cleanup();
		return { reason: `the set is full (${MAX_FILES} files): remove some first` };
	}
	const final = filePathOf(set.timeline_id, { sha256: staged.sha256, ext: meta.ext });
	await mkdir(path.dirname(final), { recursive: true });
	if (!existsSync(final)) {
		if (staged.owned) await rename(staged.tmp, final);
		else await copyFile(staged.tmp, final);
	} else await cleanup();
	let probe: Awaited<ReturnType<typeof probeMedia>>;
	try {
		probe = await probeMedia(final, signal);
	} catch (error) {
		if (!set.files.some((file) => file.sha256 === staged.sha256)) await unlink(final).catch(() => undefined);
		return { reason: `ffmpeg cannot read it: ${error instanceof Error ? error.message : String(error)}` };
	}
	const base = `ref-${staged.sha256.slice(0, 12)}`;
	const same = set.files.filter((file) => file.id === base || file.id.startsWith(`${base}-`)).length;
	const file: ReferenceFile = {
		id: same ? `${base}-${same + 1}` : base,
		name: meta.name,
		folder: meta.folder,
		kind,
		ext: meta.ext,
		size: staged.size,
		sha256: staged.sha256,
		width: probe.width,
		height: probe.height,
		duration: kind === "video" ? probe.duration : null,
		source: meta.source,
		origin: meta.origin,
		added_at: new Date().toISOString(),
	};
	set.files.push(file);
	return { file };
}

/** Every image/video under `dir` (depth ≤ 3): files right in it get the folder's own name, files in a subfolder that subfolder's name. */
async function walkFolder(dir: string, folder: string | null, out: Array<{ file: string; folder: string }>, depth = 0): Promise<void> {
	if (depth > 3 || out.length > MAX_FILES * 2) return;
	const entries = await readdir(dir, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));
	const own = folder ?? path.basename(dir);
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) await walkFolder(full, depth === 0 && folder === null ? entry.name : own, out, depth + 1);
		else if (entry.isFile() && kindOfExt(extOf(entry.name))) out.push({ file: full, folder: own });
	}
}

/** Add files to a timeline's reference set. Never throws for one bad file: it is listed in `skipped` with why. */
export async function addReferenceFiles(timelineId: string, specs: ReferenceFileSpec[], opts: { signal?: AbortSignal } = {}): Promise<AddResult> {
	return withSetLock(timelineId, async () => {
		const set = await loadSet(timelineId);
		const added: ReferenceFile[] = [];
		const skipped: AddResult["skipped"] = [];
		const record = (outcome: { file: ReferenceFile } | { reason: string }, name: string) => {
			if ("file" in outcome) added.push(outcome.file);
			else skipped.push({ name, reason: outcome.reason });
		};
		for (const [index, spec] of specs.entries()) {
			const label = spec.name ?? spec.path ?? spec.url ?? spec.media_id ?? `file ${index + 1}`;
			try {
				const ways = [spec.data, spec.url, spec.path, spec.media_id].filter((value) => typeof value === "string" && value.length > 0).length;
				if (ways !== 1) {
					skipped.push({ name: label, reason: "give exactly one of data (base64), url, path or media_id" });
					continue;
				}
				const folder = cleanFolder(spec.folder);
				if (spec.data) {
					const match = /^data:([^;,]+)?(;base64)?,/.exec(spec.data);
					const mime = (spec.mime ?? match?.[1] ?? "").toLowerCase();
					const bytes = Buffer.from(match ? spec.data.slice(match[0].length) : spec.data, "base64");
					if (!bytes.length) {
						skipped.push({ name: label, reason: "data is empty or not base64" });
						continue;
					}
					const name = cleanName(spec.name, `reference-${index + 1}.${MIME_EXT[mime] ?? "bin"}`);
					const ext = extOf(name) || MIME_EXT[mime] || "";
					record(await commitStaged(set, await stageBytes(timelineId, bytes), { name, folder, ext, source: "upload", origin: null }, opts.signal), name);
				} else if (spec.url) {
					let url: URL;
					try {
						url = new URL(spec.url);
					} catch {
						skipped.push({ name: label, reason: "url is not a valid absolute URL" });
						continue;
					}
					if (url.protocol !== "http:" && url.protocol !== "https:") {
						skipped.push({ name: label, reason: "only http(s) URLs" });
						continue;
					}
					// security-pass (2026-10-21): public addresses only, redirects re-checked, pinned, size + time capped
					// (./safe-fetch.ts). A refused or failed URL lands in `skipped` with the reason (the catch below).
					const response = await safeFetch(url, { signal: opts.signal, maxBytes: MAX_FILE_BYTES, timeoutMs: URL_FETCH_TIMEOUT_MS });
					if (!response.ok) {
						await response.body.cancel().catch(() => {});
						skipped.push({ name: label, reason: `download failed: HTTP ${response.status}` });
						continue;
					}
					const mime = (spec.mime ?? response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
					const name = cleanName(spec.name ?? decodeURIComponent(url.pathname.split("/").pop() ?? ""), `reference-${index + 1}.${MIME_EXT[mime] ?? "bin"}`);
					const ext = extOf(name) || MIME_EXT[mime] || "";
					const staged = await stageStream(timelineId, Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream));
					record(await commitStaged(set, staged, { name, folder, ext, source: "url", origin: url.toString() }, opts.signal), name);
				} else if (spec.path) {
					if (!pathsAllowed()) {
						skipped.push({ name: label, reason: "local paths are off on this server (production or RESTORFFCUT_REFERENCES_PATHS=0): send data or url" });
						continue;
					}
					const full = path.resolve(spec.path);
					const info = await stat(full).catch(() => null);
					if (!info) {
						skipped.push({ name: label, reason: `no such file or folder on the server: ${full}` });
						continue;
					}
					if (info.isDirectory()) {
						const found: Array<{ file: string; folder: string }> = [];
						await walkFolder(full, folder, found);
						if (!found.length) skipped.push({ name: label, reason: "no images or clips in that folder" });
						for (const item of found) {
							const size = (await stat(item.file)).size;
							if (size > MAX_FILE_BYTES) {
								skipped.push({ name: path.basename(item.file), reason: `larger than ${MAX_FILE_BYTES} bytes` });
								continue;
							}
							const name = path.basename(item.file);
							record(await commitStaged(set, await hashFile(item.file), { name, folder: item.folder, ext: extOf(name), source: "path", origin: item.file }, opts.signal), name);
						}
						continue;
					}
					if (info.size > MAX_FILE_BYTES) {
						skipped.push({ name: label, reason: `larger than ${MAX_FILE_BYTES} bytes` });
						continue;
					}
					const name = cleanName(spec.name ?? path.basename(full), path.basename(full));
					record(
						await commitStaged(set, await hashFile(full), { name, folder: folder ?? path.basename(path.dirname(full)), ext: extOf(path.basename(full)), source: "path", origin: full }, opts.signal),
						name,
					);
				} else if (spec.media_id) {
					const media = (await listProjectMedia(timelineId)).find((entry) => entry.media_id === spec.media_id);
					if (!media) {
						skipped.push({ name: label, reason: `media ${spec.media_id} is not in this timeline's media store (media list shows what is)` });
						continue;
					}
					const stored = path.join(resolveMediaDir(), media.hash.slice(0, 2), media.hash);
					if (!existsSync(stored)) {
						skipped.push({ name: label, reason: `media ${spec.media_id} is recorded but its file is missing` });
						continue;
					}
					const metaName = typeof media.meta?.name === "string" ? (media.meta.name as string) : undefined;
					const name = cleanName(spec.name ?? metaName, `${spec.media_id}.${MIME_EXT[media.mime] ?? "bin"}`);
					const ext = extOf(name) || MIME_EXT[media.mime] || "";
					record(await commitStaged(set, await hashFile(stored), { name, folder, ext, source: "media", origin: spec.media_id }, opts.signal), name);
				}
			} catch (error) {
				skipped.push({ name: label, reason: error instanceof Error ? error.message : String(error) });
			}
		}
		if (added.length) await saveSet(set);
		return { added, skipped, set };
	});
}

/** POST /api/references/<timeline_id>: the raw file as the body (X-Reference-Name, X-Reference-Folder, Content-Type). */
export async function addReferenceUpload(timelineId: string, request: Request): Promise<AddResult> {
	if (!request.body) throw new HttpError(400, "the file goes in the request body");
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > MAX_FILE_BYTES) throw new HttpError(413, `file larger than ${MAX_FILE_BYTES} bytes`);
	const mime = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	const decode = (value: string | null) => {
		if (!value) return undefined;
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	};
	const name = cleanName(decode(request.headers.get("x-reference-name")), `upload.${MIME_EXT[mime] ?? "bin"}`);
	const folder = cleanFolder(decode(request.headers.get("x-reference-folder")));
	return withSetLock(timelineId, async () => {
		const set = await loadSet(timelineId);
		const staged = await stageStream(timelineId, Readable.fromWeb(request.body as unknown as import("node:stream/web").ReadableStream));
		const outcome = await commitStaged(set, staged, { name, folder, ext: extOf(name) || MIME_EXT[mime] || "", source: "upload", origin: null });
		if ("file" in outcome) {
			await saveSet(set);
			return { added: [outcome.file], skipped: [], set };
		}
		return { added: [], skipped: [{ name, reason: outcome.reason }], set };
	});
}

/** Remove files by id (their bytes are deleted when no other entry uses them). */
export async function removeReferenceFiles(timelineId: string, ids: string[]): Promise<{ removed: string[]; unknown: string[]; set: ReferenceSet }> {
	return withSetLock(timelineId, async () => {
		const set = await loadSet(timelineId);
		const wanted = new Set(ids);
		const removed = set.files.filter((file) => wanted.has(file.id));
		set.files = set.files.filter((file) => !wanted.has(file.id));
		for (const file of removed) {
			if (!set.files.some((other) => other.sha256 === file.sha256 && other.ext === file.ext)) await unlink(filePathOf(timelineId, file)).catch(() => undefined);
		}
		if (removed.length) await saveSet(set);
		return { removed: removed.map((file) => file.id), unknown: ids.filter((id) => !removed.some((file) => file.id === id)), set };
	});
}

/** A compact view of a file for tool results. */
export function fileView(file: ReferenceFile) {
	return {
		id: file.id,
		name: file.name,
		folder: file.folder,
		kind: file.kind,
		size: file.size,
		dims: `${file.width}x${file.height}`,
		...(file.duration !== null ? { duration_s: Math.round(file.duration * 100) / 100 } : {}),
		source: file.source,
	};
}
