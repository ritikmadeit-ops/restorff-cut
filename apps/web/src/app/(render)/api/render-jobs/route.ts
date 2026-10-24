// GET /api/render-jobs → where this server looks for render jobs (dev only). The pipeline CLI asks this so it can
// register a job folder that lives elsewhere (a `<job>.path` pointer file). See jobs-dir.ts.
import { jobsRoot, renderRouteEnabled } from "./jobs-dir";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
	if (!renderRouteEnabled()) return new Response("Not found", { status: 404 });
	return Response.json({ schema: "restorffcut-render-jobs@1", root: jobsRoot() });
}
