/**
 * Renders are read by id too (`render {render_id}`, `look {kind: "render", ref}`, `check {render_id}`): inside an
 * org-scoped MCP call a render of another org's timeline answers exactly like a render that does not exist
 * (mcp-gaps-mvp, 2026-10-24; the timeline half is server/timeline-scope.ts). Runs before the tool (protocol.ts
 * `guard`), so render-tool.ts itself is untouched. Without an org (local dev, a service call with no org) it does
 * nothing.
 */
import { getDb } from "@/lib/db/store";
import { getProjectRow } from "@/server/projects";
import { isRenderId, readRow } from "@/server/renders-store";
import { readOwner } from "@/server/timeline-scope";
import { fail, type ToolOutput } from "./protocol";

const RENDER_TOOLS = new Set(["render", "look", "check"]);

/** The render ids a call names (render_id, ref, ids[]). */
export function renderIdsIn(args: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const value of [args.render_id, args.ref, ...(Array.isArray(args.ids) ? args.ids : [])]) if (isRenderId(value)) out.push(value);
	return out;
}

export async function renderScopeGuard(tool: string, args: Record<string, unknown>): Promise<ToolOutput | null> {
	if (!RENDER_TOOLS.has(tool) || !readOwner()) return null;
	for (const id of renderIdsIn(args)) {
		const row = readRow(id);
		if (!row) continue; // the tool answers "not found" itself
		try {
			await getProjectRow(await getDb(), row.project_id);
		} catch {
			const out = fail("not_found", `No render ${id} on this server.`);
			return { ...out, payload: { ...out.payload, next: { do: "List your timelines.", tool: "timeline", arguments: { action: "list" } } } };
		}
	}
	return null;
}
