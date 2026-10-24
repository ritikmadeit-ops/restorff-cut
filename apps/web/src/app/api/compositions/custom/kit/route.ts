import { callService, errorResponse } from "../../_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/compositions/custom/kit → { runtime, fontData, renderer, limits, defaults }
 * The composition runtime and the bundled fonts (base64), so the Code view's sandboxed preview iframe (no network,
 * inline-only CSP) runs a composition exactly as the renderer does.
 */
export async function GET() {
	try {
		const kit = await callService<unknown>({ verb: "custom-kit" });
		return Response.json(kit, { headers: { "cache-control": "no-cache" } });
	} catch (error) {
		return errorResponse(error);
	}
}
