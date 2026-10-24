import { authHeaders, requireActor } from "@/server/auth";
import { handle, HttpError, json, readJson } from "@/server/http";
import { createBranch, listBranches } from "@/server/projects";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/projects/:id/branches — 200 {default_branch, branches: [{name, head, updated_at}]} */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	return json(await listBranches(id), 200, authHeaders(actor));
});

/** POST /api/projects/:id/branches {name, from_commit?} — 201 {name, head} · 409 if it exists. */
export const POST = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	const body = (await readJson(request)) as { name?: unknown; from_commit?: unknown };
	if (typeof body?.name !== "string") throw new HttpError(400, "name is required");
	const result = await createBranch(
		id,
		body.name,
		typeof body.from_commit === "string" ? body.from_commit : undefined,
	);
	return json(result, 201, authHeaders(actor));
});
