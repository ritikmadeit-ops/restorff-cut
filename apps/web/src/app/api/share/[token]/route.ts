import { handle, json } from "@/server/http";
import { openSharedProject } from "@/server/share";

type Ctx = { params: Promise<{ token: string }> };

/**
 * GET /api/share/:token — public (the token is the credential).
 * 200 {link, project, commit, head, snapshot, comments[]} · 404 when unknown, expired or revoked.
 * `commit` is what the link shows (pinned, or the branch head); `head` is the branch head now.
 */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	const { token } = await ctx.params;
	const countView = new URL(request.url).searchParams.get("view") === "1";
	const payload = await openSharedProject(token, countView);
	return json(payload, 200, { "Cache-Control": "no-store" });
});
