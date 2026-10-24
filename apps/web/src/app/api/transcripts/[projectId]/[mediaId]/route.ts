// Server transcripts of a project's media (mcp-cut agent, 2026-10-20). The same transcripts the MCP `transcribe`,
// `autocut` and `captions` tools use, for the editor's Transcript tab (shape = transcription/transcript-store.ts
// MediaTranscript). Runbook: docs/restorff/worklog/mcp-cut.md.
import { authHeaders, requireActor } from "@/server/auth";
import { handle, HttpError, json, readJson } from "@/server/http";
import { asEditorTranscript, findTranscript, resolveMediaFile, startTranscript } from "@/server/transcripts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; mediaId: string }> };

/**
 * GET /api/transcripts/:projectId/:mediaId[?model=large-v3] — 200 {transcript, record: {model, language, words,
 * duration, created_at}} · 404 when the media or its transcript is not on the server.
 */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { projectId, mediaId } = await ctx.params;
	const media = await resolveMediaFile(projectId, mediaId);
	const model = new URL(request.url).searchParams.get("model") ?? undefined;
	const record = findTranscript(media.hash, model ? { model } : {});
	if (!record) throw new HttpError(404, `no server transcript of media ${mediaId} yet (POST here, or the MCP transcribe tool, makes one)`);
	return json(
		{
			transcript: asEditorTranscript(record, media),
			record: { model: record.model, language: record.language, words: record.words.length, duration: record.duration, created_at: record.created_at, transcribed_in_ms: record.ms },
		},
		200,
		authHeaders(actor),
	);
});

/**
 * POST /api/transcripts/:projectId/:mediaId — body {model?, language?, force?} → 200 {transcript} when cached, else
 * 202 {job} (poll GET /api/transcripts/jobs/:jobId).
 */
export const POST = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { projectId, mediaId } = await ctx.params;
	const body = ((await readJson(request).catch(() => ({}))) ?? {}) as { model?: string; language?: string; force?: boolean; relisten?: boolean };
	const media = await resolveMediaFile(projectId, mediaId);
	const started = startTranscript(media, { model: body.model, language: body.language ?? null, force: body.force === true, relisten: body.relisten !== false });
	if (started.record) return json({ transcript: asEditorTranscript(started.record, media) }, 200, authHeaders(actor));
	return json({ job: started.job, joined: started.joined === true }, 202, authHeaders(actor));
});
