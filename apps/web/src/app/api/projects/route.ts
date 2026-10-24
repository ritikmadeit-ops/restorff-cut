import { authHeaders, assertMayAuthor, requireActor } from "@/server/auth";
import { handle, HttpError, json, readJson } from "@/server/http";
import { assertAuthor, createProject, listProjects } from "@/server/projects";
import { getStoreInfo } from "@/lib/db/store";

/**
 * GET /api/projects — the caller's projects (no snapshots): a signed-in user's own, the service token + X-Restorff-Org
 * its org's; local dev and a service call with no org get every project (mcp-gaps-mvp, 2026-10-24).
 */
export const GET = handle(async (request: Request) => {
	const actor = await requireActor(request);
	const [projects, store] = await Promise.all([listProjects(actor), getStoreInfo()]);
	return json({ projects, store: { driver: store.driver } }, 200, authHeaders(actor));
});

/**
 * POST /api/projects — create a project from a snapshot.
 * Body: {snapshot, id?, name?, author?, message?, branch?, ops?}
 * 201 {project, commit} · 409 when the id exists.
 */
export const POST = handle(async (request: Request) => {
	const actor = await requireActor(request);
	const body = (await readJson(request)) as Record<string, unknown>;
	if (!body || typeof body !== "object") throw new HttpError(400, "body must be an object");
	if (body.author !== undefined) assertMayAuthor(actor, assertAuthor(body.author));
	const result = await createProject(actor, {
		id: typeof body.id === "string" ? body.id : undefined,
		name: typeof body.name === "string" ? body.name : undefined,
		snapshot: body.snapshot,
		author: body.author,
		message: typeof body.message === "string" ? body.message : undefined,
		branch: typeof body.branch === "string" ? body.branch : undefined,
		ops: body.ops,
	});
	return json(result, 201, authHeaders(actor));
});
