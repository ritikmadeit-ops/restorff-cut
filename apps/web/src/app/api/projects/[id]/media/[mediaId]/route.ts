import { authHeaders, requireActor } from "@/server/auth";
import { handle, json } from "@/server/http";
import { putProjectMedia, serveProjectMedia } from "@/server/media";

type Ctx = { params: Promise<{ id: string; mediaId: string }> };

/**
 * PUT /api/projects/:id/media/:mediaId — the raw file as the body.
 * Headers: Content-Type (the file's), X-Media-Meta (base64url JSON of the editor's MediaAssetData, optional),
 * X-Media-Sha256 (optional check). 201 {media}. Same bytes are stored once (sha256).
 */
export const PUT = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id, mediaId } = await ctx.params;
	const media = await putProjectMedia(id, mediaId, request);
	return json({ media }, 201, authHeaders(actor));
});

/** GET /api/projects/:id/media/:mediaId — the file (Range supported). */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	await requireActor(request);
	const { id, mediaId } = await ctx.params;
	return serveProjectMedia(id, mediaId, request);
});
