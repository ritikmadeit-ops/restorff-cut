import { join } from "node:path";
import { fileResponse, SAMPLES_DIR } from "../../_lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/compositions/sample/<name> → the library's committed sample render (looping preview in the panel). */
export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ name: string }> },
) {
	const { name } = await params;
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
		return Response.json({ error: "bad name" }, { status: 400 });
	}
	return fileResponse({
		path: join(SAMPLES_DIR, `${name}.webm`),
		contentType: "video/webm",
		immutable: false,
	});
}
