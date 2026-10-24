/**
 * The storyboard of a project's head (EDT-14; mcp-review agent, 2026-10-20). Same data as MCP `storyboard`.
 *
 *   GET  /api/storyboard/:id[?branch=]   200 {head, branch, runtime, shots, hash, approval, rows}
 *   POST /api/storyboard/:id  {action:"edit_row", row, caption?, emphasis?, sentence?, base_commit?, dry_run?}
 *                             {action:"approve", by?, note?, base_commit?}
 *        Both commit as `claude` (a signed-in browser user gets 403: their edits go through the editor).
 */
import { assertMayAuthor, authHeaders, requireActor } from "@/server/auth";
import { handle, HttpError, json, readJson } from "@/server/http";
import { approveStoryboard, editStoryboardRow, getStoryboard } from "@/server/storyboard";
import { getLibrary, styleOwner } from "@/server/styles-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	const branch = new URL(request.url).searchParams.get("branch") ?? undefined;
	const { head, branch: used, board, approval } = await getStoryboard(id, branch);
	return json({ head, branch: used, runtime: board.runtime, shots: board.shots, hash: board.hash, approval, rows: board.rows }, 200, authHeaders(actor));
});

export const POST = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	assertMayAuthor(actor, "claude");
	const { id } = await ctx.params;
	const body = (await readJson(request)) as Record<string, unknown>;
	if (!body || typeof body !== "object") throw new HttpError(400, "body must be an object");
	const s = (key: string) => (typeof body[key] === "string" && (body[key] as string).trim() ? (body[key] as string).trim() : undefined);
	if (body.action === "edit_row") {
		if (typeof body.row !== "number") throw new HttpError(400, "row (a number) is required");
		const { library } = await getLibrary(await styleOwner(actor, id));
		const result = await editStoryboardRow({
			timelineId: id,
			edit: { row: body.row, caption: s("caption"), emphasis: s("emphasis"), sentence: s("sentence") },
			library,
			actor,
			baseCommit: s("base_commit"),
			branch: s("branch"),
			dryRun: body.dry_run === true,
			message: s("message"),
		});
		if (result.error || !result.outcome) throw new HttpError(422, result.error ?? "nothing changed", { not_understood: result.plan?.not_understood ?? [] });
		if (!result.outcome.ok) throw new HttpError(result.outcome.code === "conflict" ? 409 : 422, result.outcome.message, { head: result.outcome.head, details: result.outcome.details });
		return json({ commit: result.outcome.commit, dry_run: result.outcome.dry_run, labels: result.labels, notes: result.notes }, result.outcome.dry_run ? 200 : 201, authHeaders(actor));
	}
	if (body.action === "approve") {
		const result = await approveStoryboard({ timelineId: id, actor, by: s("by"), note: s("note"), baseCommit: s("base_commit"), branch: s("branch") });
		if ("conflict" in result) throw new HttpError(409, "the timeline moved on", result.conflict);
		return json({ approved: true, already: result.already, record: result.record, commit: result.commit }, result.already ? 200 : 201, authHeaders(actor));
	}
	throw new HttpError(400, "action must be edit_row or approve");
});
