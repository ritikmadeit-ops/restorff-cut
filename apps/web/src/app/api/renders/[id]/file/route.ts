/** GET /api/renders/:id/file — the mastered MP4 of a finished render (Range supported). */
import { requireActor } from "@/server/auth";
import { handle } from "@/server/http";
import { renderRowOr404, serveRenderFile } from "@/server/renders-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (request: Request, ctx: Ctx) => {
	await requireActor(request);
	const { id } = await ctx.params;
	return serveRenderFile(renderRowOr404(id), request);
});
