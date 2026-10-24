import { callService, errorResponse } from "../../_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/compositions/custom/examples → { examples: [{ name, title, description, duration, size, file, source, props }] }
 * The worked examples in packages/compositions/examples/custom (fictional Halcyon content): the Code view's starters.
 */
export async function GET() {
	try {
		const examples = await callService<unknown[]>({ verb: "custom-examples" });
		return Response.json({ examples });
	} catch (error) {
		return errorResponse(error);
	}
}
