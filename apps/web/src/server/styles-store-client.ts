/**
 * BROWSER side of the saved-styles sync (mcp-review agent, 2026-10-20). Lives next to ./styles-store.ts so the two
 * halves are found together; it has no server imports and is safe in client code (and a no-op on the server).
 *
 * The styles lab (styles-lab/store.ts) calls these:
 *   pushServerStyles(library)      after save / restore / import  → POST /api/styles {action:"sync"}
 *   deleteServerStyle(id)          after delete                    → POST /api/styles {action:"delete"}
 *   dismissServerPattern(pattern)  after "not now"                 → POST /api/styles {action:"dismiss"}
 *   recordServerInstruction(rec)   after each typed instruction    → POST /api/styles {action:"record"}
 *   pullServerStyles(take)         once when the store loads       → GET  /api/styles, merged into the local state,
 *                                                                    then the merged library is pushed back
 * Every call is fire-and-forget: the server being down or the user signed out must never break the styles lab
 * (localStorage stays the working copy; the next push catches up).
 */
import type { InstructionRecord, StyleLibrary } from "@restorffcut/styles";
import { mergeHistory, mergeLibraries } from "./styles-store-merge";

const ENDPOINT = "/api/styles";

function inBrowser(): boolean {
	return typeof window !== "undefined" && typeof fetch === "function";
}

async function post(body: Record<string, unknown>): Promise<unknown> {
	const response = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	if (!response.ok) throw new Error(`${ENDPOINT} ${response.status}`);
	return response.json();
}

function quietly(what: string, run: () => Promise<unknown>): void {
	if (!inBrowser()) return;
	run().catch((error) => console.warn(`[styles sync] ${what} failed (kept in this browser):`, error instanceof Error ? error.message : error));
}

export function pushServerStyles(library: StyleLibrary): void {
	quietly("push", () => post({ action: "sync", library }));
}

export function deleteServerStyle(id: string): void {
	quietly("delete", () => post({ action: "delete", id }));
}

export function dismissServerPattern(pattern: string): void {
	quietly("dismiss", () => post({ action: "dismiss", pattern }));
}

export function recordServerInstruction(record: InstructionRecord): void {
	quietly("record", () => post({ action: "record", record }));
}

export interface LocalStylesState {
	library: StyleLibrary;
	history: InstructionRecord[];
}

/** Local state + what the server sent → the merged state (server tombstones drop deleted styles). Pure. */
export function mergeServerState(local: LocalStylesState, remote: { library?: unknown; history?: InstructionRecord[]; deleted?: Record<string, string> }): LocalStylesState {
	const merged = mergeLibraries(local.library, remote.library ?? null, remote.deleted ?? {});
	return { library: merged.library, history: mergeHistory(local.history, remote.history ?? []) };
}

/**
 * Pull the server's library + history, hand the merged state to `take`, then push the merged library back (so
 * styles saved in this browser before the server had a copy reach it once).
 */
export function pullServerStyles(getLocal: () => LocalStylesState, take: (state: LocalStylesState) => void): void {
	quietly("pull", async () => {
		const response = await fetch(ENDPOINT, { headers: { accept: "application/json" } });
		if (!response.ok) throw new Error(`${ENDPOINT} ${response.status}`);
		const remote = (await response.json()) as { library?: unknown; history?: InstructionRecord[]; deleted?: Record<string, string> };
		const merged = mergeServerState(getLocal(), remote);
		take(merged);
		await post({ action: "sync", library: merged.library });
	});
}
