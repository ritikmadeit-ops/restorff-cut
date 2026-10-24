/**
 * Saved styles on the server (EDT-20; mcp-review agent, 2026-10-20). The browser's styles lab syncs with this
 * (apps/web/src/server/styles-store-client.ts); Claude reaches the same library through MCP `styles` / `revise`.
 *
 *   GET  /api/styles[?project=<id>]   200 {owner, library, deleted, history}   (owner = server/styles-store.ts styleOwner:
 *                                     a signed-in user's own; the service token's X-Restorff-Org org; else the
 *                                     project's owner or you — security-pass 2026-10-21)
 *   POST /api/styles  {action:"sync", library}            merge (higher version wins, nothing lost) → {owner, library, deleted, taken}
 *                     {action:"save", style, note?}       one style (same id = new version) → {style, changed, versions}
 *                     {action:"delete", id}               tombstone → {deleted}
 *                     {action:"dismiss", pattern}         never suggest this repeat again → {dismissed}
 *                     {action:"record", record}           one typed instruction for repeat detection → {record}
 *                     {action:"suggest"}                  repeat suggestions → {suggestions}
 *   Every POST may carry project (or project_id) to pick the owner the same way.
 */
import type { InstructionRecord, SavedStyle } from "@restorffcut/styles";
import { authHeaders, requireActor } from "@/server/auth";
import { handle, HttpError, json, readJson } from "@/server/http";
import {
	deleteOwnerStyle,
	dismissOwnerPattern,
	getLibrary,
	listOwnerHistory,
	ownerSuggestions,
	recordOwnerInstruction,
	saveOwnerStyle,
	styleOwner,
	syncLibrary,
} from "@/server/styles-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (request: Request) => {
	const actor = await requireActor(request);
	const project = new URL(request.url).searchParams.get("project");
	const owner = await styleOwner(actor, project);
	const [{ library, deleted }, history] = await Promise.all([getLibrary(owner), listOwnerHistory(owner)]);
	return json({ owner, library, deleted, history }, 200, authHeaders(actor));
});

export const POST = handle(async (request: Request) => {
	const actor = await requireActor(request);
	const body = (await readJson(request)) as Record<string, unknown>;
	if (!body || typeof body !== "object") throw new HttpError(400, "body must be an object");
	const project = typeof body.project === "string" ? body.project : typeof body.project_id === "string" ? body.project_id : null;
	const owner = await styleOwner(actor, project);
	const headers = authHeaders(actor);
	switch (body.action) {
		case "sync": {
			const result = await syncLibrary(owner, body.library, { projectId: project, savedBy: actor.name });
			return json(result, 200, headers);
		}
		case "save": {
			if (!body.style || typeof body.style !== "object") throw new HttpError(400, "style is required");
			const result = await saveOwnerStyle(owner, body.style as SavedStyle, { projectId: project, savedBy: actor.name, note: typeof body.note === "string" ? body.note : undefined });
			return json({ owner, ...result }, result.changed ? 201 : 200, headers);
		}
		case "delete": {
			if (typeof body.id !== "string" || !body.id) throw new HttpError(400, "id is required");
			const deleted = await deleteOwnerStyle(owner, body.id);
			return json({ owner, deleted }, deleted ? 200 : 404, headers);
		}
		case "dismiss": {
			if (typeof body.pattern !== "string" || !body.pattern) throw new HttpError(400, "pattern is required");
			await dismissOwnerPattern(owner, body.pattern);
			return json({ owner, dismissed: body.pattern }, 200, headers);
		}
		case "record": {
			const record = body.record as InstructionRecord | undefined;
			if (!record || typeof record.sentence !== "string") throw new HttpError(400, "record {sentence, ops} is required");
			const stored = await recordOwnerInstruction(owner, { sentence: record.sentence, ops: Array.isArray(record.ops) ? record.ops : [], clauses: record.clauses, projectId: record.projectId ?? project, at: record.at }, "browser");
			return json({ owner, record: stored }, 201, headers);
		}
		case "suggest": {
			const suggestions = await ownerSuggestions(owner, { limit: 5 });
			return json({ owner, suggestions }, 200, headers);
		}
		default:
			throw new HttpError(400, "action must be one of sync · save · delete · dismiss · record · suggest");
	}
});
