/**
 * Which Restorff org a service-token call is for (security-pass agent, 2026-10-21).
 *
 * Every Restorff account reaches RestorffCut through ONE service token (the gateway's), so before this every
 * service-token project had the owner "service" and saved styles, the repeat history and dismissed suggestions were
 * one library for every org. The gateway now sends the caller's org on every forwarded call:
 *
 *   X-Restorff-Org: <org id>      [A-Za-z0-9_-]{1,64}; honoured ONLY with the service token (server/auth.ts
 *                                 resolveActor, mcp/handler.ts authorize). A browser session or local dev that sends
 *                                 it is ignored (they are scoped by their own user id); a malformed value with the
 *                                 service token is a 400, never a silent fall-back to the shared "service" library.
 *
 * For MCP calls the org also rides along the call in an AsyncLocalStorage (`runWithOrg` in handleMcp), so code that
 * builds its own Actor from the MCP auth (e.g. mcp/review.ts actorOf) still lands in the org's library:
 * styles-store.ts `styleOwner` reads `actor.org ?? currentOrg()` for service callers.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { HttpError } from "./http";

export const ORG_HEADER = "x-restorff-org";
const ORG_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The header's org id; null when it is absent; HttpError 400 when it is there but malformed. */
export function orgFromHeader(request: Request): string | null {
	const raw = request.headers.get(ORG_HEADER);
	if (raw === null) return null;
	const org = raw.trim();
	if (!ORG_RE.test(org)) throw new HttpError(400, `${ORG_HEADER} must be 1-64 characters of A-Z a-z 0-9 _ -`);
	return org;
}

interface TenantStore {
	org: string | null;
}

// on globalThis: a dev-server hot reload of this module must not split the setter (handler) from the reader (store)
const KEY = "__restorffcutTenant";
type GlobalWithTenant = typeof globalThis & { [KEY]?: AsyncLocalStorage<TenantStore> };
const storage = ((globalThis as GlobalWithTenant)[KEY] ??= new AsyncLocalStorage<TenantStore>());

/** Runs `fn` (and everything it awaits) as a call for `org` (null: no org). */
export function runWithOrg<T>(org: string | null, fn: () => T): T {
	return storage.run({ org }, fn);
}

/** The org of the service-token MCP call this code runs in, or null. */
export function currentOrg(): string | null {
	return storage.getStore()?.org ?? null;
}
