import { authHeaders, requireActor } from "@/server/auth";
import { handle, json } from "@/server/http";
import { listProjectMedia } from "@/server/media";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/projects/:id/media — 200 {media: [{media_id, hash, size, mime, meta, updated_at}]} */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	return json({ media: await listProjectMedia(id) }, 200, authHeaders(actor));
});
