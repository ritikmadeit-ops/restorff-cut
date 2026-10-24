/**
 * "Ask your Claude": Restorff is bring-your-own-Claude — we never run or pay for Claude. A sentence the editor can't
 * do by itself becomes a ready prompt the person pastes into their own Claude, which edits through MCP
 * (`timeline` summary → `timeline_ops` on the head commit). Its commit then arrives through the sync engine.
 */

export function mcpUrl(origin: string): string {
	return `${origin.replace(/\/$/, "")}/api/mcp`;
}

/** The one-line setup for Claude Code (claude.ai / Desktop: add the same URL as a custom connector). */
export function claudeCodeSetup(origin: string): string {
	return `claude mcp add --transport http restorffcut ${mcpUrl(origin)}`;
}

export function buildClaudePrompt({
	sentence,
	projectId,
	projectName,
	head,
	origin,
	alsoDone,
}: {
	sentence: string;
	projectId: string;
	projectName: string;
	/** The head commit id, or null when the project has no server copy yet. */
	head: string | null;
	origin: string;
	/** What the editor already did locally from the same sentence (so Claude does only the rest). */
	alsoDone?: string;
}): string {
	return [
		`Edit my RestorffCut timeline "${projectName}" (timeline_id: ${projectId}${head ? `, head commit: ${head}` : ""}).`,
		``,
		`What I want: "${sentence}"`,
		alsoDone ? `Already done in the editor (leave it): ${alsoDone}.` : null,
		``,
		`Use the restorffcut MCP tools (${mcpUrl(origin)}):`,
		`1. timeline {action: "summary", timeline_id: "${projectId}"} — read the tracks, element ids and the head commit.`,
		`2. styles {action: "resolve", timeline_id: "${projectId}", sentence: "<my sentence>"} — the ops the editor would make, if any.`,
		`3. timeline_ops {timeline_id: "${projectId}", base_commit: <head>, ops: [...ops@1, author "claude"], message: "<my sentence>"} — one commit.`,
		`Tell me in one line what you changed. If something can't be done with ops@1, say so instead of guessing.`,
	]
		.filter((line) => line !== null)
		.join("\n");
}
