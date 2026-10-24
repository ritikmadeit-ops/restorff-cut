/**
 * Interchange on the server (EDT-19): a commit of a project → FCPXML 1.10 or OTIO, with media pointing at this
 * server's media store (or at a folder the receiving editor will hold, `media_root`), review comments as markers.
 * Used by the download route (app/api/interchange/[id]/[file]) and the MCP tools (mcp/interchange.ts).
 *
 * Files are generated on request from the commit (commits never change), so nothing is written to disk and the same
 * URL always returns the same bytes. Converters: ./interchange-fcpxml.ts, ./interchange-otio.ts (pure).
 */
import { listComments } from "./comments";
import { HttpError } from "./http";
import { toFcpxml } from "./interchange-fcpxml";
import { toOtio } from "./interchange-otio";
import { type ExportSummary, type MediaInfo, safeFileName, TICKS_PER_SECOND } from "./interchange-timeline";
import { listProjectMedia } from "./media";
import { type CommitDto, getCommit, getProjectHead } from "./projects";
import type { ProjectSnapshot } from "@/sync/snapshot";

export type InterchangeFormat = "fcpxml" | "otio";
export const INTERCHANGE_FORMATS: InterchangeFormat[] = ["fcpxml", "otio"];
export const CONTENT_TYPES: Record<InterchangeFormat, string> = { fcpxml: "application/xml; charset=utf-8", otio: "application/json; charset=utf-8" };

export interface ExportRequest {
	projectId: string;
	/** A commit id (or unique prefix ≥ 4), or "head" / undefined for the head of `branch`. */
	commit?: string;
	branch?: string;
	format: InterchangeFormat;
	/** Origin for absolute URLs (http://localhost:8791). */
	origin: string;
	/** A folder on the receiving editor's machine; media become file:// URLs into it (by file name). */
	mediaRoot?: string;
}

export interface ExportResult {
	format: InterchangeFormat;
	body: string;
	bytes: number;
	fileName: string;
	contentType: string;
	commit: Pick<CommitDto, "id" | "message" | "author" | "created_at" | "branch">;
	/** The route that serves this exact file. */
	path: string;
	summary: ExportSummary;
}

/** A local folder (C:\x, C:/x, /Users/x, file:///x) → a file:// URL prefix with a trailing slash. */
export function fileUrlPrefix(root: string): string {
	let path = root.trim().replace(/^file:\/\/\/?/i, "").replace(/\\/g, "/");
	if (!path.startsWith("/")) path = `/${path}`;
	const encoded = path
		.split("/")
		.map((segment, index) => (index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
		.join("/");
	return `file://${encoded.replace(/\/+$/, "")}/`;
}

/** Path of the route for one file (relative to the origin). */
export function exportPath(projectId: string, commitId: string, format: InterchangeFormat, mediaRoot?: string): string {
	const query = mediaRoot ? `?media_root=${encodeURIComponent(mediaRoot)}` : "";
	return `/api/interchange/${encodeURIComponent(projectId)}/${encodeURIComponent(commitId)}.${format}${query}`;
}

function mediaKind(meta: Record<string, unknown> | null, mime: string): MediaInfo["kind"] | undefined {
	const type = typeof meta?.type === "string" ? meta.type : "";
	if (type === "video" || type === "audio" || type === "image") return type;
	if (mime.startsWith("audio/")) return "audio";
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("video/")) return "video";
	return undefined;
}

async function loadCommit(projectId: string, commit: string | undefined, branch: string | undefined): Promise<{ commit: CommitDto; snapshot: ProjectSnapshot }> {
	if (!commit || commit === "head") {
		const head = await getProjectHead(projectId, branch);
		if (!head.snapshot) throw new HttpError(409, `the head of ${head.branch} has no snapshot`);
		return { commit: head.head, snapshot: head.snapshot };
	}
	const found = await getCommit(projectId, commit, { snapshot: true });
	if (!found.snapshot) throw new HttpError(409, `commit ${found.id} has no snapshot`);
	return { commit: found, snapshot: found.snapshot };
}

export async function buildExport(request: ExportRequest): Promise<ExportResult> {
	if (!INTERCHANGE_FORMATS.includes(request.format)) throw new HttpError(400, `format must be ${INTERCHANGE_FORMATS.join(" or ")}`);
	const { commit, snapshot } = await loadCommit(request.projectId, request.commit, request.branch);
	const stored = await listProjectMedia(request.projectId).catch(() => []);
	const media: Record<string, Partial<MediaInfo>> = {};
	for (const entry of stored) {
		const meta = entry.meta ?? {};
		const seconds = typeof meta.duration === "number" ? meta.duration : undefined;
		media[entry.media_id] = {
			...(typeof meta.name === "string" ? { name: meta.name } : {}),
			...(mediaKind(entry.meta, entry.mime) ? { kind: mediaKind(entry.meta, entry.mime) } : {}),
			...(seconds ? { durationTicks: Math.round(seconds * TICKS_PER_SECOND) } : {}),
			...(typeof meta.width === "number" ? { width: meta.width } : {}),
			...(typeof meta.height === "number" ? { height: meta.height } : {}),
			...(typeof meta.fps === "number" ? { fps: meta.fps } : {}),
			...(typeof meta.hasAudio === "boolean" ? { hasAudio: meta.hasAudio } : {}),
			mime: entry.mime,
		};
	}
	const comments = await listComments(request.projectId).catch(() => []);
	const origin = request.origin.replace(/\/+$/, "");
	const prefix = request.mediaRoot ? fileUrlPrefix(request.mediaRoot) : null;
	const input = {
		snapshot,
		media,
		comments: comments.map((comment) => ({
			id: comment.id,
			time_s: comment.time_s,
			time_end_s: comment.time_end_s,
			body: comment.body,
			author: comment.author,
			severity: comment.severity,
			status: comment.status,
			rule_id: comment.rule_id,
		})),
		timelineId: request.projectId,
		commitId: commit.id,
		exportedAt: commit.created_at ?? undefined,
		mediaUrl: (mediaId: string, fileName: string, sourceUrl?: string) => {
			if (prefix) return `${prefix}${encodeURIComponent(fileName)}`;
			if (sourceUrl) return /^[a-z][a-z0-9+.-]*:/i.test(sourceUrl) ? sourceUrl : `${origin}${sourceUrl.startsWith("/") ? "" : "/"}${sourceUrl}`;
			return `${origin}/api/projects/${encodeURIComponent(request.projectId)}/media/${encodeURIComponent(mediaId)}`;
		},
	};
	const out = request.format === "fcpxml" ? (() => {
		const { xml, summary } = toFcpxml(input);
		return { body: xml, summary };
	})() : (() => {
		const { text, summary } = toOtio(input);
		return { body: text, summary };
	})();
	const base = safeFileName(`${snapshot.metadata?.name || request.projectId} ${commit.id.slice(0, 7)}`)
		.replace(/[^\x21-\x7e]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-|-$/g, "");
	return {
		format: request.format,
		body: out.body,
		bytes: Buffer.byteLength(out.body, "utf8"),
		fileName: `${base}.${request.format}`,
		contentType: CONTENT_TYPES[request.format],
		commit: { id: commit.id, message: commit.message, author: commit.author, created_at: commit.created_at, branch: commit.branch },
		path: exportPath(request.projectId, commit.id, request.format, request.mediaRoot),
		summary: out.summary,
	};
}

/** media id → file name, for matching OTIO clips that lost our metadata (import_cuts). */
export async function mediaNamesOf(projectId: string): Promise<Record<string, string>> {
	const stored = await listProjectMedia(projectId).catch(() => []);
	const names: Record<string, string> = {};
	for (const entry of stored) if (typeof entry.meta?.name === "string") names[entry.media_id] = entry.meta.name;
	return names;
}
