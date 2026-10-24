import { publicAnswer, readCustomInput, renderCustomComposition } from "../_lib/custom";
import { errorResponse } from "../_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/compositions/custom  { source, props?, duration_s?, width?, height?, fps? }
 * → 200 { hash, url, width, height, duration, fps, frames, bytes, cached, name, title, params, ms, report }
 * → 422 { error, report: { errors, warnings } } when the code is refused (network APIs, external URLs, no protocol…)
 *
 * Validates the HTML/CSS/JS, renders it frame by frame with the network blocked in Chromium (WebM VP9 with alpha),
 * caches it by hash. The video is at `url` (GET /api/compositions/custom/<hash>).
 */
export async function POST(request: Request) {
	try {
		const input = readCustomInput(await request.json().catch(() => null));
		const answer = await renderCustomComposition(input);
		return Response.json(publicAnswer(answer));
	} catch (error) {
		return errorResponse(error);
	}
}
