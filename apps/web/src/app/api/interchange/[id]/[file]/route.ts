import { authHeaders, requireActor } from "@/server/auth";
import { handle, HttpError, json } from "@/server/http";
import { buildExport, INTERCHANGE_FORMATS, type InterchangeFormat } from "@/server/interchange";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; file: string }> };

/**
 * GET /api/interchange/:id/:commit.fcpxml | :commit.otio  (EDT-19; interchange agent 2026-10-20)
 *   :commit   a commit id, a unique prefix (≥ 4), or `head` (the head of ?branch=, default the project's default branch)
 *   ?media_root=<folder>   media as file:// URLs into that folder (by file name) instead of this server's media URLs
 *   ?summary=1             the summary JSON (tracks, clips, what could not be expressed) instead of the file
 * 200 the file as an attachment (FCPXML 1.10 / OTIO JSON), generated from the commit — same commit, same bytes.
 * Auth as the project API (Bearer service token, signed-in user, or local dev).
 */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id, file } = await ctx.params;
	const match = /^(.+)\.([a-z]+)$/.exec(decodeURIComponent(file));
	if (!match || !INTERCHANGE_FORMATS.includes(match[2] as InterchangeFormat)) {
		throw new HttpError(400, `ask for <commit>.fcpxml or <commit>.otio (commit = an id, a prefix or "head")`);
	}
	const url = new URL(request.url);
	const origin = process.env.RESTORFFCUT_PUBLIC_URL?.replace(/\/+$/, "") || url.origin;
	const result = await buildExport({
		projectId: id,
		commit: match[1],
		branch: url.searchParams.get("branch") ?? undefined,
		format: match[2] as InterchangeFormat,
		origin,
		mediaRoot: url.searchParams.get("media_root") || undefined,
	});
	if (url.searchParams.get("summary") === "1") {
		return json({ file_name: result.fileName, bytes: result.bytes, commit: result.commit, path: result.path, summary: result.summary }, 200, authHeaders(actor));
	}
	const ascii = result.fileName.replace(/[^\x20-\x7e]/g, "_");
	return new Response(result.body, {
		status: 200,
		headers: {
			"Content-Type": result.contentType,
			"Content-Length": String(result.bytes),
			"Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
			"Cache-Control": "private, no-store",
			"X-RestorffCut-Commit": result.commit.id,
			...authHeaders(actor),
		},
	});
});
