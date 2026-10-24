import { readCustomInput, validateCustomComposition } from "../../_lib/custom";
import { errorResponse } from "../../_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/compositions/custom/validate  { source, props? }
 * → { ok, errors[], warnings[], manifest | null, values, protocol, bytes }  (always 200: refusal is data here)
 * What the Code view lists inline while you type; no browser is started.
 */
export async function POST(request: Request) {
	try {
		const input = readCustomInput(await request.json().catch(() => null));
		return Response.json(await validateCustomComposition({ source: input.source, props: input.props }));
	} catch (error) {
		return errorResponse(error);
	}
}
