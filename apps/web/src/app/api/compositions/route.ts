import { callService, errorResponse } from "./_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/compositions → the composition library: names, params (with meanings), example props, sample flag. */
export async function GET() {
	try {
		const entries = await callService<unknown[]>({ verb: "catalogue" });
		return Response.json({ compositions: entries });
	} catch (error) {
		return errorResponse(error);
	}
}
