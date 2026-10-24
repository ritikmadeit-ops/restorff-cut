import { authHeaders, requireActor } from "@/server/auth";
import { handle, json } from "@/server/http";
import { getProjectHead } from "@/server/projects";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/:id[?branch=main]
 * 200 {project, branch, head, snapshot} — the head commit of the branch and its project JSON.
 */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	const branch = new URL(request.url).searchParams.get("branch") ?? undefined;
	const result = await getProjectHead(id, branch);
	return json(result, 200, authHeaders(actor));
});
