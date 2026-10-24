/**
 * Project media on the server: content-addressed files (sha256) on disk, and a
 * per-project map mediaId → file + the editor's MediaAssetData. Lets an editor
 * opening /editor/<id> on another machine, and the review player, get the real
 * footage instead of placeholders.
 *
 * Ported from OpenCut-AI's version-control media store (vc_media_objects +
 * commit media refs; MIT, see NOTICE). Theirs kept a storage URL per object;
 * ours writes files under RESTORFFCUT_MEDIA_DIR (default apps/web/.data/media).
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { getDb, resolveMediaDir } from "@/lib/db/store";
import { rcMediaObjects, rcProjectMedia } from "@/lib/db/store-schema";
import { HttpError, iso } from "./http";
import { getProjectRow } from "./projects";

const MAX_BYTES = (Number(process.env.RESTORFFCUT_MEDIA_MAX_MB) || 2048) * 1024 * 1024;
const MEDIA_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface MediaDto {
	media_id: string;
	hash: string;
	size: number;
	mime: string;
	meta: Record<string, unknown> | null;
	updated_at: string | null;
}

function filePath(hash: string): string {
	return path.join(resolveMediaDir(), hash.slice(0, 2), hash);
}

export async function listProjectMedia(projectId: string): Promise<MediaDto[]> {
	const db = await getDb();
	await getProjectRow(db, projectId);
	const rows = await db
		.select({
			mediaId: rcProjectMedia.mediaId,
			hash: rcProjectMedia.hash,
			meta: rcProjectMedia.meta,
			updatedAt: rcProjectMedia.updatedAt,
			size: rcMediaObjects.size,
			mime: rcMediaObjects.mime,
		})
		.from(rcProjectMedia)
		.innerJoin(rcMediaObjects, eq(rcMediaObjects.hash, rcProjectMedia.hash))
		.where(eq(rcProjectMedia.projectId, projectId));
	return rows.map((r) => ({
		media_id: r.mediaId,
		hash: r.hash,
		size: Number(r.size),
		mime: r.mime,
		meta: (r.meta as Record<string, unknown> | null) ?? null,
		updated_at: iso(r.updatedAt),
	}));
}

function parseMeta(header: string | null): Record<string, unknown> | null {
	if (!header) return null;
	try {
		const json = Buffer.from(header, "base64url").toString("utf8");
		const value = JSON.parse(json) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const { thumbnailUrl: _thumb, ...rest } = value as Record<string, unknown>;
		return rest;
	} catch {
		throw new HttpError(400, "X-Media-Meta must be base64url JSON");
	}
}

/** PUT body → temp file while hashing → content-addressed file; maps mediaId → hash. */
export async function putProjectMedia(projectId: string, mediaId: string, request: Request): Promise<MediaDto> {
	if (!MEDIA_ID_RE.test(mediaId)) throw new HttpError(400, "invalid media id");
	const db = await getDb();
	await getProjectRow(db, projectId);
	if (!request.body) throw new HttpError(400, "the file goes in the request body");
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > MAX_BYTES) throw new HttpError(413, `file larger than ${MAX_BYTES} bytes`);
	const mime = (request.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
	const meta = parseMeta(request.headers.get("x-media-meta"));

	const dir = resolveMediaDir();
	mkdirSync(path.join(dir, "tmp"), { recursive: true });
	const tmp = path.join(dir, "tmp", `${randomUUID()}.part`);
	const hash = createHash("sha256");
	let size = 0;
	await new Promise<void>((resolve, reject) => {
		const out = createWriteStream(tmp);
		const input = Readable.fromWeb(request.body as unknown as import("node:stream/web").ReadableStream);
		input.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BYTES) {
				input.destroy(new HttpError(413, `file larger than ${MAX_BYTES} bytes`));
				return;
			}
			hash.update(chunk);
		});
		input.on("error", (error) => {
			out.destroy();
			reject(error);
		});
		out.on("error", reject);
		out.on("finish", () => resolve());
		input.pipe(out);
	}).catch((error) => {
		if (existsSync(tmp)) unlinkSync(tmp);
		throw error;
	});
	if (size === 0) {
		unlinkSync(tmp);
		throw new HttpError(400, "empty file");
	}
	const digest = hash.digest("hex");
	const expected = request.headers.get("x-media-sha256");
	if (expected && expected.toLowerCase() !== digest) {
		unlinkSync(tmp);
		throw new HttpError(400, `sha256 mismatch: got ${digest}`);
	}
	const final = filePath(digest);
	mkdirSync(path.dirname(final), { recursive: true });
	if (existsSync(final)) unlinkSync(tmp);
	else renameSync(tmp, final);

	await db.insert(rcMediaObjects).values({ hash: digest, size, mime }).onConflictDoNothing();
	const now = new Date();
	await db
		.insert(rcProjectMedia)
		.values({ projectId, mediaId, hash: digest, meta, updatedAt: now })
		.onConflictDoUpdate({
			target: [rcProjectMedia.projectId, rcProjectMedia.mediaId],
			set: { hash: digest, meta, updatedAt: now },
		});
	return { media_id: mediaId, hash: digest, size, mime, meta, updated_at: iso(now) };
}

/** Streams a project's media file, honouring a single `Range: bytes=a-b` (video seeking). */
export async function serveProjectMedia(projectId: string, mediaId: string, request: Request): Promise<Response> {
	const db = await getDb();
	const [row] = await db
		.select({ hash: rcProjectMedia.hash, mime: rcMediaObjects.mime })
		.from(rcProjectMedia)
		.innerJoin(rcMediaObjects, eq(rcMediaObjects.hash, rcProjectMedia.hash))
		.where(and(eq(rcProjectMedia.projectId, projectId), eq(rcProjectMedia.mediaId, mediaId)))
		.limit(1);
	if (!row) throw new HttpError(404, `media ${mediaId} not found`);
	const file = filePath(row.hash);
	if (!existsSync(file)) throw new HttpError(410, `media ${mediaId} is recorded but its file is missing`);
	const total = statSync(file).size;
	const headers: Record<string, string> = {
		"Content-Type": row.mime,
		"Accept-Ranges": "bytes",
		"Cache-Control": "private, max-age=31536000, immutable",
		ETag: `"${row.hash}"`,
	};
	const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
	if (range && (range[1] || range[2])) {
		let start = range[1] ? Number(range[1]) : total - Number(range[2]);
		let end = range[1] && range[2] ? Number(range[2]) : total - 1;
		start = Math.max(0, start);
		end = Math.min(total - 1, end);
		if (start > end) {
			return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
		}
		const stream = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream;
		return new Response(stream, {
			status: 206,
			headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(end - start + 1) },
		});
	}
	const stream = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
	return new Response(stream, { status: 200, headers: { ...headers, "Content-Length": String(total) } });
}
