import { handle } from "@/server/http";
import { serveProjectMedia } from "@/server/media";
import { resolveShareToken } from "@/server/share";

type Ctx = { params: Promise<{ token: string; mediaId: string }> };

/** GET /api/share/:token/media/:mediaId — a shared project's media file, for the review player (Range supported). */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	const { token, mediaId } = await ctx.params;
	const link = await resolveShareToken(token);
	return serveProjectMedia(link.projectId, mediaId, request);
});
