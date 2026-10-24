// /render/<job> — dev-only headless render page (spike S2). See render-job.tsx and docs/restorff/PIPELINE.md.
import { notFound } from "next/navigation";
import { renderRouteEnabled } from "../../api/render-jobs/jobs-dir";
import { RenderJobRunner } from "./render-job";

export const dynamic = "force-dynamic";

export default async function RenderJobPage({
	params,
}: {
	params: Promise<{ job: string }>;
}) {
	if (!renderRouteEnabled()) notFound();
	const { job } = await params;
	return <RenderJobRunner job={job} />;
}
