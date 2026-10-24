// A server transcription job (mcp-cut agent, 2026-10-20). Runbook: docs/restorff/worklog/mcp-cut.md.
import { authHeaders, requireActor } from "@/server/auth";
import { handle, HttpError, json } from "@/server/http";
import { getTranscriptJob } from "@/server/transcripts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ jobId: string }> };

/** GET /api/transcripts/jobs/:jobId — 200 {job: {id, status: running|done|error|interrupted, step, ms, words, error}} */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { jobId } = await ctx.params;
	const job = getTranscriptJob(jobId);
	if (!job) throw new HttpError(404, `no transcription job ${jobId}`);
	return json({ job }, 200, authHeaders(actor));
});
