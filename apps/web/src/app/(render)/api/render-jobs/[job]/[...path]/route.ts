// GET /api/render-jobs/<job>/<file...> → a file from a render job folder (dev only, read only, never outside the job).
import { readFile, stat } from "node:fs/promises";
import {
	contentTypeFor,
	renderRouteEnabled,
	resolveJobDir,
	resolveJobFile,
} from "../../jobs-dir";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ job: string; path: string[] }> },
) {
	if (!renderRouteEnabled()) return new Response("Not found", { status: 404 });
	const { job, path } = await params;
	const jobDir = resolveJobDir(job);
	if (!jobDir) return new Response(`no render job "${job}"`, { status: 404 });
	const file = resolveJobFile(jobDir, path ?? []);
	if (!file) return new Response("bad path", { status: 400 });
	try {
		const info = await stat(file);
		if (!info.isFile()) return new Response("not a file", { status: 404 });
		const bytes = await readFile(file);
		return new Response(new Uint8Array(bytes), {
			headers: {
				"content-type": contentTypeFor(file),
				"content-length": String(bytes.byteLength),
				"cache-control": "no-store",
			},
		});
	} catch {
		return new Response("not found", { status: 404 });
	}
}
