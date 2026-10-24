import { join } from "node:path";
import { CACHE_DIR, fileResponse } from "../../_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/compositions/file/<hash> → the cached render (video/webm, VP9 with alpha). Same hash, same bytes. */
export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ hash: string }> },
) {
	const { hash } = await params;
	if (!/^[a-f0-9]{64}$/.test(hash)) {
		return Response.json({ error: "bad hash" }, { status: 400 });
	}
	return fileResponse({
		path: join(CACHE_DIR, `${hash}.webm`),
		contentType: "video/webm",
		immutable: true,
	});
}
