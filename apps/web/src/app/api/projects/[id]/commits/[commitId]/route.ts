import { authHeaders, requireActor } from "@/server/auth";
import { handle, json } from "@/server/http";
import { getCommit } from "@/server/projects";

type Ctx = { params: Promise<{ id: string; commitId: string }> };

/**
 * GET /api/projects/:id/commits/:commitId — one commit with its snapshot and ops.
 * `commitId` may be a unique prefix (>= 4 hex characters).
 */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id, commitId } = await ctx.params;
	const commit = await getCommit(id, commitId, { snapshot: true, ops: true });
	return json({ commit }, 200, authHeaders(actor));
});
