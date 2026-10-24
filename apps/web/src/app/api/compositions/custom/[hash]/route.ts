import { customFilePath } from "../../_lib/custom";
import { errorResponse, fileResponse } from "../../_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/compositions/custom/<hash> → the cached custom render (video/webm, VP9 with alpha). Same hash, same bytes.
 * 404 when the cache no longer has it: re-render from the source stored in the clip (POST /api/compositions/custom).
 */
export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ hash: string }> },
) {
	try {
		const { hash } = await params;
		return await fileResponse({ path: customFilePath(hash), contentType: "video/webm", immutable: true });
	} catch (error) {
		return errorResponse(error);
	}
}
