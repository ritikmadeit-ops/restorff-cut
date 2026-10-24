import { authHeaders, requireActor } from "@/server/auth";
import {
	createComment,
	importFindings,
	listComments,
	looksLikeFinding,
	updateComment,
} from "@/server/comments";
import { handle, HttpError, json, readJson } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/:id/comments[?commit=<id>][&status=open|resolved][&finding=1]
 * 200 {comments[]} ordered by time. `finding=1` includes the original finding@1 objects.
 */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	const q = new URL(request.url).searchParams;
	const comments = await listComments(id, {
		commit: q.get("commit") ?? undefined,
		status: q.get("status") ?? undefined,
		withFinding: q.get("finding") === "1",
	});
	return json({ comments }, 200, authHeaders(actor));
});

/**
 * POST /api/projects/:id/comments — three shapes:
 *   [finding@1, …]                         Judge findings → comments (upsert by finding id)
 *   {findings: [finding@1, …], commit_id?}  same, pinned against that commit's timeline
 *   {time_s, body, author?, track_id?, track_name?, element_id?, rule_id?, severity?, parent_id?, commit_id?}
 * 201 {comments[], errors[]}
 */
export const POST = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	const body = await readJson(request);
	let findings: unknown[] | null = null;
	let commitId: string | null = null;
	if (Array.isArray(body)) {
		findings = body;
	} else if (body && typeof body === "object") {
		const b = body as Record<string, unknown>;
		if (Array.isArray(b.findings)) {
			findings = b.findings;
			commitId = typeof b.commit_id === "string" ? b.commit_id : null;
		} else if (looksLikeFinding(b)) {
			findings = [b];
		}
	} else {
		throw new HttpError(400, "body must be an array of finding@1 objects or a comment object");
	}
	if (findings) {
		const result = await importFindings(id, findings, { commitId });
		const status = result.imported.length ? 201 : 400;
		return json({ comments: result.imported, errors: result.errors }, status, authHeaders(actor));
	}
	const comment = await createComment(id, body as Record<string, unknown>, {
		defaultAuthor: actor.kind === "service" ? "claude" : actor.name,
	});
	return json({ comments: [comment], errors: [] }, 201, authHeaders(actor));
});

/** PATCH /api/projects/:id/comments {id, status?: open|resolved, body?, resolved_by?} — 200 {comment} */
export const PATCH = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	const body = (await readJson(request)) as Record<string, unknown>;
	if (typeof body?.id !== "string") throw new HttpError(400, "id (the comment id) is required");
	const comment = await updateComment(id, body.id, body, actor.name);
	return json({ comment }, 200, authHeaders(actor));
});
