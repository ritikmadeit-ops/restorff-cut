// /matte/<job_id> — dev-only headless matte page (mcp-cutout agent, 2026-10-20). Opened by src/server/matte-driver.ts
// in headless Chromium; see matte-job.tsx and docs/restorff/worklog/mcp-cutout.md. Same gate as /render/<job>.
import { notFound } from "next/navigation";
import { renderRouteEnabled } from "../../api/render-jobs/jobs-dir";
import { MatteJobRunner } from "./matte-job";

export const dynamic = "force-dynamic";

export default async function MatteJobPage({ params }: { params: Promise<{ job: string }> }) {
	if (!renderRouteEnabled()) notFound();
	const { job } = await params;
	return <MatteJobRunner job={job} />;
}
