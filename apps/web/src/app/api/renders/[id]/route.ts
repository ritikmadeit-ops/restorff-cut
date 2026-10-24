/** GET /api/renders/:id — one render's row (status, progress, loudness, file, last check). */
import { authHeaders, requireActor } from "@/server/auth";
import { handle, json } from "@/server/http";
import { renderRowOr404 } from "@/server/renders-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	return json({ render: renderRowOr404(id) }, 200, authHeaders(actor));
});
