/**
 * Composition image params take the user's own media (mcp-gaps-mvp, 2026-10-24; worklog mcp-gaps-mvp.md, gap 1).
 *
 * The MVP test's client imported eight product photos, then gave their media ids to Orbit's `cards[].image`
 * ("image not found: <server repo path>") and then the local paths ("only data:/http(s): URLs or paths inside the
 * composition folder are allowed"). It had no shell to make data: URLs, so the effect got drawn cards. Now, inside an
 * MCP tool call, any string in a render's props that is
 *
 *   - a media id of the call's timeline (`media list` / `media import` answer it)           "b1cc6697-…"
 *   - `media:<id>` (same, explicit; `media:<id>#t=2.5` = a video's frame at 2.5 s)            "media:b1cc6697-…"
 *   - this server's media URL for a timeline the caller may read                             "/api/projects/<tl>/media/<id>"
 *     (absolute or relative; `?t=` / `#t=` pick a video frame)
 *
 * is resolved HERE, on the server, from the media store, into an inline `data:` image before the compositions
 * service sees it — so the render stays network-blocked and never reads a path from the caller. An image goes as is
 * (≤ 2.5 MB of jpeg/png/webp/gif) or is scaled to ≤ 1920 px JPEG (PNG keeps PNG) with FFmpeg; a video gives one frame
 * (default at 1 s, or its middle when shorter); audio is refused with a message naming the param. Converted files are
 * cached under `.data/composition-media/` by content hash. The props stored on the timeline keep what the caller sent
 * (the id), never the data: URL. Outside an MCP call (the browser's routes) nothing is resolved — UNVERIFIED there.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, resolveMediaDir } from "@/lib/db/store";
import { rcMediaObjects, rcProjectMedia } from "@/lib/db/store-schema";
import { currentCallScope } from "./call-scope";
import { IMAGE_ACCEPTS } from "./params-list";
import { getProjectRow } from "./projects";

const ID = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const ID_RE = new RegExp(`^${ID}$`);
const MEDIA_REF_RE = new RegExp(`^media:(${ID})(?:#t=([0-9.]+))?$`);
const MEDIA_URL_RE = new RegExp(`^(?:https?://[^/\\s]+)?/api/projects/(${ID})/media/(${ID})([?#]\\S*)?$`);
const T_PARAM_RE = /[?#&]t=([0-9]+(?:\.[0-9]+)?)/;
/** Inline as is up to this size; above it the image is scaled down first. */
export const INLINE_MAX_BYTES = Math.round(2.5 * 1024 * 1024);
const MAX_SIDE = 1920;
const FFMPEG = () => process.env.RESTORFFCUT_FFMPEG?.trim() || "ffmpeg";
const INLINE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** What a model is told an image param takes (effects describe rows, the schemas): one text, in params-list.ts. */
export { IMAGE_ACCEPTS };

export interface MediaRefProblem {
	path: string;
	message: string;
}

interface MediaRow {
	mediaId: string;
	hash: string;
	mime: string;
	size: number;
	meta: Record<string, unknown> | null;
}

interface Ref {
	timelineId: string;
	mediaId: string;
	at: number | null;
	/** True when the string can only be a media reference (media:… or a media URL): not finding it is an error. */
	explicit: boolean;
}

/** Which media reference a string is, if any (bare ids need the timeline's media list to tell). */
export function parseMediaRef(value: string, scopeTimeline: string | null): Ref | null {
	const ref = MEDIA_REF_RE.exec(value);
	if (ref) return scopeTimeline ? { timelineId: scopeTimeline, mediaId: ref[1], at: ref[2] ? Number(ref[2]) : null, explicit: true } : null;
	const url = MEDIA_URL_RE.exec(value);
	if (url) {
		const t = url[3] ? T_PARAM_RE.exec(url[3]) : null;
		return { timelineId: url[1], mediaId: url[2], at: t ? Number(t[1]) : null, explicit: true };
	}
	if (scopeTimeline && ID_RE.test(value)) return { timelineId: scopeTimeline, mediaId: value, at: null, explicit: false };
	return null;
}

function mediaFile(hash: string): string {
	return path.join(resolveMediaDir(), hash.slice(0, 2), hash);
}

function cacheDir(): string {
	const configured = process.env.RESTORFFCUT_COMPOSITION_MEDIA_DIR?.trim();
	return configured ? path.resolve(configured) : path.join(path.dirname(resolveMediaDir()), "composition-media");
}

async function timelineMedia(timelineId: string): Promise<Map<string, MediaRow> | null> {
	const db = await getDb();
	try {
		// scoped like every read by id: another org's timeline is "not found"
		await getProjectRow(db, timelineId);
	} catch {
		return null;
	}
	const rows = await db
		.select({ mediaId: rcProjectMedia.mediaId, hash: rcProjectMedia.hash, meta: rcProjectMedia.meta, mime: rcMediaObjects.mime, size: rcMediaObjects.size })
		.from(rcProjectMedia)
		.innerJoin(rcMediaObjects, eq(rcMediaObjects.hash, rcProjectMedia.hash))
		.where(eq(rcProjectMedia.projectId, timelineId));
	return new Map(rows.map((row) => [row.mediaId, { ...row, size: Number(row.size), meta: (row.meta as Record<string, unknown> | null) ?? null }]));
}

function runFfmpeg(args: string[], timeoutMs = 60_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(FFMPEG(), args, { windowsHide: true, timeout: timeoutMs });
		let err = "";
		child.stderr.on("data", (chunk: Buffer) => {
			err = (err + chunk.toString("utf8")).slice(-2000);
		});
		child.on("error", (error) => reject(error));
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.split("\n").filter(Boolean).slice(-2).join(" | ")}`))));
	});
}

const durationOf = (row: MediaRow) => {
	const d = row.meta?.duration;
	return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : null;
};

/** The media as a data: URL a composition can show (cached conversions). Throws with a plain message. */
export async function mediaDataUrl(row: MediaRow, at: number | null): Promise<string> {
	const file = mediaFile(row.hash);
	if (!existsSync(file)) throw new Error(`media ${row.mediaId} is recorded but its file is missing on the server`);
	const kind = row.mime.split("/")[0];
	if (kind === "audio") throw new Error(`media ${row.mediaId} is audio (${row.mime}); an image param takes an image, or a video (its frame)`);
	if (kind === "image" && INLINE_MIMES.has(row.mime) && row.size <= INLINE_MAX_BYTES) {
		return `data:${row.mime};base64,${readFileSync(file).toString("base64")}`;
	}
	if (kind !== "image" && kind !== "video") throw new Error(`media ${row.mediaId} is ${row.mime}, not an image or a video`);
	const png = row.mime === "image/png";
	let seek = 0;
	if (kind === "video") {
		const duration = durationOf(row);
		seek = at ?? (duration !== null ? Math.min(1, duration / 2) : 1);
		if (duration !== null) seek = Math.max(0, Math.min(seek, Math.max(0, duration - 0.05)));
	}
	const dir = cacheDir();
	mkdirSync(dir, { recursive: true });
	const out = path.join(dir, `${row.hash}-${kind === "video" ? `t${seek.toFixed(3)}` : "still"}-${MAX_SIDE}.${png ? "png" : "jpg"}`);
	if (!existsSync(out)) {
		const tmp = `${out}.${process.pid}-${Date.now().toString(36)}.tmp.${png ? "png" : "jpg"}`;
		const scale = `scale='if(gt(iw,ih),min(${MAX_SIDE},iw),-2)':'if(gt(iw,ih),-2,min(${MAX_SIDE},ih))'`;
		try {
			await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", ...(kind === "video" ? ["-ss", seek.toFixed(3)] : []), "-i", file, "-frames:v", "1", "-vf", scale, ...(png ? [] : ["-q:v", "3"]), tmp]);
			if (!existsSync(tmp) || statSync(tmp).size === 0) throw new Error(kind === "video" ? `no frame at ${seek} s` : "no image out");
			renameSync(tmp, out);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw new Error(`media ${row.mediaId} could not be turned into an image (${error instanceof Error ? error.message.slice(0, 200) : String(error)})`);
		}
	}
	return `data:${png ? "image/png" : "image/jpeg"};base64,${readFileSync(out).toString("base64")}`;
}

/**
 * `props` with every media reference replaced by a data: image. Only inside an MCP tool call (its timeline is the
 * scope for bare ids); elsewhere the props come back unchanged. `problems` name the param path and what is allowed.
 */
export async function resolveMediaProps(props: unknown): Promise<{ props: unknown; resolved: number; problems: MediaRefProblem[] }> {
	const scope = currentCallScope();
	if (!scope || !props || typeof props !== "object") return { props, resolved: 0, problems: [] };
	const media = new Map<string, Map<string, MediaRow> | null>();
	const mediaOf = async (timelineId: string) => {
		if (!media.has(timelineId)) media.set(timelineId, await timelineMedia(timelineId));
		return media.get(timelineId) ?? null;
	};
	const problems: MediaRefProblem[] = [];
	let resolved = 0;
	const walk = async (value: unknown, at: string, depth: number): Promise<unknown> => {
		if (typeof value === "string") {
			if (value.length > 400 || value.startsWith("data:")) return value;
			const ref = parseMediaRef(value, scope.timelineId);
			if (!ref) return value;
			const list = await mediaOf(ref.timelineId);
			const row = list?.get(ref.mediaId);
			if (!row) {
				if (ref.explicit) {
					problems.push({
						path: at,
						message: list
							? `no media "${ref.mediaId}" in timeline ${ref.timelineId} (media list shows its ids). It takes ${IMAGE_ACCEPTS}`
							: `timeline ${ref.timelineId} not found (or not yours). It takes ${IMAGE_ACCEPTS}`,
					});
				}
				return value;
			}
			try {
				const url = await mediaDataUrl(row, ref.at);
				resolved++;
				return url;
			} catch (error) {
				problems.push({ path: at, message: error instanceof Error ? error.message : String(error) });
				return value;
			}
		}
		if (depth > 8 || value === null || typeof value !== "object") return value;
		if (Array.isArray(value)) {
			const out: unknown[] = [];
			for (let i = 0; i < value.length; i++) out.push(await walk(value[i], `${at}[${i}]`, depth + 1));
			return out;
		}
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = await walk(item, at ? `${at}.${key}` : key, depth + 1);
		return out;
	};
	const out = await walk(props, "", 0);
	return { props: out, resolved, problems };
}
