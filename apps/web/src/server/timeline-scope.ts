/**
 * Whose timelines a caller sees (mcp-gaps-mvp, 2026-10-24; worklog mcp-gaps-mvp.md, gap 3).
 *
 * Before this, `timeline list` answered every project in the store (79 on the dev server, old recreations of other
 * projects included) and any id could be read. Now a project's `owner` says whose it is and a scoped caller sees only
 * its own:
 *
 *   caller                                              new project's owner   sees (list + reads by id)
 *   service token + X-Restorff-Org: <org> (gateway,     org:<org>             owner = org:<org> only
 *     the MVP test's per-run org)
 *   signed-in user (browser session, REST list)         <user id>             own projects in the list
 *   local dev / service token with no org (scripts)     local-dev / service   everything (as before)
 *
 * For MCP the org comes from the call's AsyncLocalStorage (tenant.ts currentOrg, set by mcp/handler.ts), so every
 * read by id inside a tool — getProjectRow / getProjectHead and everything built on them — answers 404 "not found"
 * for another org's timeline, the same answer as an id that does not exist (no existence oracle).
 * The same `org:<org>` owner string the saved styles use (styles-store.ts styleOwner).
 */
import type { Actor } from "./auth";
import { currentOrg } from "./tenant";

export const orgOwner = (org: string) => `org:${org}`;

function orgOf(actor?: Actor | null): string | null {
	if (actor && actor.kind !== "service") return null;
	return actor?.org ?? currentOrg();
}

/** The owner a project created by `actor` gets. */
export function ownerFor(actor: Actor): string {
	const org = orgOf(actor);
	return org ? orgOwner(org) : actor.id;
}

/**
 * The owner a list is filtered to, or null for no filter. With no actor (MCP code, which carries the org in the
 * call's AsyncLocalStorage): the org's owner, else null.
 */
export function listOwner(actor?: Actor | null): string | null {
	if (actor?.kind === "user") return actor.id;
	const org = orgOf(actor);
	return org ? orgOwner(org) : null;
}

/** The owner a read by id must match inside an org-scoped MCP call, or null (no check). */
export function readOwner(): string | null {
	const org = currentOrg();
	return org ? orgOwner(org) : null;
}
