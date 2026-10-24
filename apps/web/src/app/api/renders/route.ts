/**
 * GET /api/renders?timeline_id=<project id> — renders made over MCP (`render` tool), newest first.
 * 200 {renders: RenderRow[]}. Same auth as the project store. Runbook: docs/restorff/worklog/mcp-render.md.
 *
 * POST /api/renders {timeline_id, commit?, branch?, quality?: "preview"|"final" (default final), fresh?} — start (or
 * reuse) a server render of a commit: the editor's Render final (ui-fix-render, 2026-10-21, QA #4) uses the same
 * job + detached worker as MCP `render`, so the browser tab never encodes.
 *   202 {render: RenderRow, repeated}  (poll GET /api/renders/:id; then POST /api/renders/:id/check)
 *   409 {error, code: "media_missing", missing: [{media_id, why}], on_server: [...]}  — upload those files first
 *   404 unknown timeline / commit · 400 bad body. Runbook: docs/restorff/worklog/ui-fix-render.md.
 */
import { authHeaders, requireActor } from "@/server/auth";
import { handle, HttpError, json, readJson, str } from "@/server/http";
import { MediaMissingError, projectRenders, startRender } from "@/server/renders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (request: Request) => {
	const actor = await requireActor(request);
	const timelineId = new URL(request.url).searchParams.get("timeline_id");
	if (!timelineId) throw new HttpError(400, "timeline_id is required");
	return json({ renders: projectRenders(timelineId) }, 200, authHeaders(actor));
});

export const POST = handle(async (request: Request) => {
	const actor = await requireActor(request);
	const body = (await readJson(request)) as Record<string, unknown> | null;
	if (!body || typeof body !== "object") throw new HttpError(400, "body must be a JSON object");
	const timelineId = str(body.timeline_id, "timeline_id", { max: 200 }) as string;
	const commit = str(body.commit, "commit", { optional: true, max: 80 });
	const branch = str(body.branch, "branch", { optional: true, max: 120 });
	if (body.quality !== undefined && body.quality !== "preview" && body.quality !== "final") {
		throw new HttpError(400, "quality must be preview or final");
	}
	const quality = body.quality === "preview" ? "preview" : "final";
	try {
		const { row, repeated } = await startRender({ projectId: timelineId, commit, branch, quality, fresh: body.fresh === true });
		return json({ render: row, repeated }, 202, authHeaders(actor));
	} catch (error) {
		if (error instanceof MediaMissingError) {
			throw new HttpError(409, error.message, { code: "media_missing", missing: error.missing, on_server: error.have });
		}
		throw error;
	}
});
