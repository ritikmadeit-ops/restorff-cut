import { authHeaders, assertMayAuthor, requireActor } from "@/server/auth";
import { handle, HttpError, json, readJson } from "@/server/http";
import { assertAuthor, listCommits, pushCommit, type PushInput } from "@/server/projects";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/:id/commits[?branch=main][&since=<commit>][&limit=100][&all=1]
 * 200 {branch, head, commits[]} — first-parent history of the branch, newest first, no snapshots.
 * `since` stops before that commit (what you have not seen yet); `all=1` lists every commit in the project.
 */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	const q = new URL(request.url).searchParams;
	const limit = q.get("limit") ? Number.parseInt(q.get("limit")!, 10) : undefined;
	const result = await listCommits(id, {
		branch: q.get("branch") ?? undefined,
		since: q.get("since") ?? undefined,
		limit: Number.isFinite(limit) ? limit : undefined,
		all: q.get("all") === "1",
	});
	return json(result, 200, authHeaders(actor));
});

/**
 * POST /api/projects/:id/commits
 * Body: {base_commit, branch?, author, ops?, snapshot, message}
 * 201 {commit, branch, created_branch} · 409 {conflict: {branch, head, since[], base_found}}
 * Without `snapshot`, `ops` (ops@1) are applied to base_commit's snapshot by the reducer:
 * 201 adds {changes}; a refused batch is 422 {error, conflicts, changes} and commits nothing.
 */
export const POST = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	const body = (await readJson(request)) as PushInput;
	if (!body || typeof body !== "object") throw new HttpError(400, "body must be an object");
	assertMayAuthor(actor, assertAuthor(body.author));
	const result = await pushCommit(id, body, actor);
	if (!result.ok) {
		return json(
			{
				error: `base_commit is not the head of ${result.conflict.branch}: pull, re-apply, push again`,
				conflict: result.conflict,
			},
			409,
			authHeaders(actor),
		);
	}
	return json(
		{
			commit: result.commit,
			branch: result.branch,
			created_branch: result.created_branch,
			// Only for ops-only pushes: what the reducer did (ops@1 `changes`).
			...(result.changes !== undefined ? { changes: result.changes } : {}),
		},
		201,
		authHeaders(actor),
	);
});
