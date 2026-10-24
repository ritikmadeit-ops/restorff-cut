/**
 * POST /api/renders/:id/check {piece?, comments?: boolean (default true)} — the export gate on a finished server render
 * (the same `checkRender` as MCP `check`: timeline checks with piece types + fix calls, file checks on the master).
 * The editor's Render final calls it after the render (ui-fix-render, 2026-10-21, QA #4).
 *
 * 200 {report, measures, runs: {timeline, file}, piece, head, render_id, commit, comments: {posted, fixed, errors}}
 * 409 the render is not done · 404 unknown render. Findings are posted as timeline comments (markers) unless
 * comments: false. Runbook: docs/restorff/worklog/ui-fix-render.md.
 */
import { authHeaders, requireActor } from "@/server/auth";
import { handle, HttpError, json } from "@/server/http";
import { checkRender } from "@/server/renders-check";
import { renderRowOr404 } from "@/server/renders-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const PIECES = new Set(["ad", "explainer", "brand_film", "motion_graphic", "talking_head"]);

export const POST = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	const row = renderRowOr404(id);
	if (row.status !== "done") throw new HttpError(409, `render ${row.render_id} is ${row.status}, not done`, { status: row.status });
	let body: Record<string, unknown> = {};
	const text = await request.text();
	if (text.trim()) {
		try {
			body = JSON.parse(text) as Record<string, unknown>;
		} catch {
			throw new HttpError(400, "body must be JSON");
		}
	}
	const piece = typeof body.piece === "string" && PIECES.has(body.piece) ? body.piece : null;
	const result = await checkRender(row, { comments: body.comments !== false, piece });
	return json(
		{
			render_id: row.render_id,
			commit: row.commit,
			report: result.report,
			measures: result.measures,
			runs: result.runs,
			piece: result.piece,
			head: result.head,
			comments: { posted: result.comments.posted, fixed: result.comments.fixed, errors: result.comments.errors.slice(0, 10) },
		},
		200,
		authHeaders(actor),
	);
});
