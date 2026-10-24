import { authHeaders, requireActor } from "@/server/auth";
import { handle, json } from "@/server/http";
import { getProjectHead } from "@/server/projects";
import { addReferenceUpload, fileView, filesKey, loadSet } from "@/server/references-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/references/:timelineId — the timeline's reference set: files, the stored style card, explainer versions
 * (mcp-references agent, 2026-10-20; the MCP tool `references` is the main way in).
 */
export const GET = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	const set = await loadSet(id);
	return json(
		{
			timeline_id: id,
			files: set.files.map(fileView),
			study: set.study ? { at: set.study.at, current: set.study.files_key === filesKey(set.files), card: set.study.card, files: set.study.files } : null,
			versions: set.versions.map(({ summary: _summary, element_ids: _e, track_ids: _t, media_ids: _m, ...version }) => version),
		},
		200,
		authHeaders(actor),
	);
});

/**
 * POST /api/references/:timelineId — one reference file as the raw body, for clips too big for an MCP request (1 MB).
 * Headers: Content-Type (the file's), X-Reference-Name (file name with extension, URL-encoded), X-Reference-Folder
 * (optional, URL-encoded). 201 {added, skipped} — then call the MCP tool `references` {action: "study"}.
 */
export const POST = handle(async (request: Request, ctx: Ctx) => {
	const actor = await requireActor(request);
	const { id } = await ctx.params;
	await getProjectHead(id); // the timeline must exist
	const result = await addReferenceUpload(id, request);
	return json({ timeline_id: id, added: result.added.map(fileView), skipped: result.skipped, files: result.set.files.length }, result.added.length ? 201 : 422, authHeaders(actor));
});
