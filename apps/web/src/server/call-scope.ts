/**
 * The timeline an MCP tool call is about, for code deep inside it that has no argument for it (mcp-gaps-mvp,
 * 2026-10-24). protocol.ts runs every tool call inside `runWithCallScope({timelineId: args.timeline_id})`; the
 * compositions service wrapper (app/api/compositions/_lib/service.ts) reads it to resolve `media_id` image params
 * against that timeline's media (server/composition-media.ts). AsyncLocalStorage on globalThis, like tenant.ts, so a
 * dev-server hot reload can't split the setter from the reader.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface CallScope {
	/** The call's `timeline_id` argument, when it has one. */
	timelineId: string | null;
}

const KEY = "__restorffcutCallScope";
type GlobalWithScope = typeof globalThis & { [KEY]?: AsyncLocalStorage<CallScope> };
const storage = ((globalThis as GlobalWithScope)[KEY] ??= new AsyncLocalStorage<CallScope>());

export function runWithCallScope<T>(scope: CallScope, fn: () => T): T {
	return storage.run(scope, fn);
}

/** The scope of the MCP tool call this code runs in, or null (a browser route, a script). */
export function currentCallScope(): CallScope | null {
	return storage.getStore() ?? null;
}
