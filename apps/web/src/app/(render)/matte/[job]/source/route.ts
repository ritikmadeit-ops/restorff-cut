// GET /matte/<job_id>/source → the source media file of a matte job (dev only, read only). The headless matte page
// fetches it; the file is the project media store's content-addressed copy named in the job's spec.
// mcp-cutout agent, 2026-10-20; docs/restorff/worklog/mcp-cutout.md.
import { readFile } from "node:fs/promises";
import { readMatteJob, resolveMatteJob } from "@/server/matte";
import { renderRouteEnabled } from "../../../api/render-jobs/jobs-dir";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ job: string }> }) {
	if (!renderRouteEnabled()) return new Response("Not found", { status: 404 });
	const { job } = await params;
	const found = resolveMatteJob(job);
	const spec = found ? readMatteJob(found.dir)?.spec : null;
	if (!spec) return new Response(`no matte job "${job}"`, { status: 404 });
	try {
		const bytes = await readFile(spec.file);
		return new Response(new Uint8Array(bytes), {
			headers: {
				"content-type": spec.mime || "application/octet-stream",
				"content-length": String(bytes.byteLength),
				"cache-control": "no-store",
			},
		});
	} catch {
		return new Response("source file missing", { status: 410 });
	}
}
