import { createComment, listComments } from "@/server/comments";
import { handle, HttpError, json, readJson } from "@/server/http";
import { openSharedProject, resolveShareToken } from "@/server/share";

type Ctx = { params: Promise<{ token: string }> };

/** GET /api/share/:token/comments — 200 {comments[]} for the shared project. */
export const GET = handle(async (_request: Request, ctx: Ctx) => {
	const { token } = await ctx.params;
	const link = await resolveShareToken(token);
	return json({ comments: await listComments(link.projectId) }, 200, { "Cache-Control": "no-store" });
});

/**
 * POST /api/share/:token/comments {author, body, time_s, time_end_s?, track_id?, element_id?, severity?, parent_id?}
 * A reviewer's comment, anchored to the commit the link shows. 201 {comment} · 403 when the link is view-only.
 */
export const POST = handle(async (request: Request, ctx: Ctx) => {
	const { token } = await ctx.params;
	const link = await resolveShareToken(token);
	if (!link.canComment) throw new HttpError(403, "this link is view-only");
	const body = (await readJson(request)) as Record<string, unknown>;
	if (!body || typeof body !== "object") throw new HttpError(400, "body must be an object");
	if (typeof body.author !== "string" || !body.author.trim()) {
		throw new HttpError(400, "author (your name) is required");
	}
	const shared = await openSharedProject(token, false);
	const comment = await createComment(
		link.projectId,
		{ ...body, rule_id: undefined, commit_id: undefined },
		{ defaultAuthor: "reviewer", shareLinkId: link.id, commitId: shared.commit.id },
	);
	return json({ comment }, 201);
});
