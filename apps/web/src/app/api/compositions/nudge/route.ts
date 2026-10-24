import { callService, errorResponse, ServiceError } from "../_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/compositions/nudge  { name, props, sentence }  e.g. "slower, bigger and make it red"
 * → { props, changes: [{ key, from, to, because }], skipped: [] }   (422 with the rules when nothing matched)
 * A custom composition sends its `source` (HTML) instead of relying on `name` (motion-code agent, 2026-10-20).
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		const custom = typeof body?.source === "string";
		if (!body || (!custom && typeof body.name !== "string") || typeof body.sentence !== "string") {
			throw new ServiceError("body must be JSON with name (or source) and sentence", 400);
		}
		const answer = await callService<unknown>({
			verb: custom ? "custom-nudge" : "nudge",
			request: custom
				? { source: body.source, props: body.props ?? {}, sentence: body.sentence }
				: { name: body.name, props: body.props ?? {}, sentence: body.sentence },
		});
		return Response.json(answer);
	} catch (error) {
		return errorResponse(error);
	}
}
