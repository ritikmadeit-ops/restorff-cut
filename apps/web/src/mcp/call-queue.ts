/**
 * No MCP call may hang past the client's own timeout (mcp-gaps-mvp, 2026-10-24; worklog mcp-gaps-mvp.md).
 *
 * What the MVP test measured: Claude Code cuts every MCP call at 60 s ("The operation timed out.") and runs a
 * server's non-read-only tools one at a time. Two layered person effects (Paper Cut, Doodle Boil: 46-57 s matte-layer
 * renders) and a `references build` ran past 60 s; the client gave up, nothing was committed, and the second call
 * started only when the first had timed out. This module gives protocol.ts three things:
 *
 *   1. An answer deadline (RESTORFFCUT_MCP_ANSWER_S, default 45 s). A call still running then is NOT aborted: it keeps
 *      running on the server and the client gets `status: "working"` with `next` = the same call. Sending exactly the
 *      same call again (same tool, same arguments, same caller) joins it — it never runs twice — and answers its result
 *      (waiting up to the deadline again). A result nobody collected is kept for 10 minutes.
 *   2. One write at a time per timeline, first come first served. A write to a timeline that another call is changing
 *      waits its turn (then runs on the new head — no "the timeline moved" conflict), and if the wait itself passes the
 *      deadline it too answers "working". Reads (list/get/summary/describe/status…, readOnly tools) never wait.
 *   3. A clear `timeline_busy` error instead of an endless wait when the queue in front is longer than the call's
 *      budget.
 * State lives on globalThis so a dev-server hot reload of this module keeps the queue and the pending calls.
 */
import { createHash } from "node:crypto";

export const DEFAULT_ANSWER_WITHIN_S = 45;
/** How long a finished result nobody collected yet is kept. */
export const KEEP_RESULT_MS = 10 * 60_000;

/** The answer deadline in ms (env RESTORFFCUT_MCP_ANSWER_S, read per call; 1-55 s). */
export function answerWithinMs(): number {
	const fromEnv = Number(process.env.RESTORFFCUT_MCP_ANSWER_S);
	const seconds = Number.isFinite(fromEnv) && fromEnv > 0 ? Math.min(fromEnv, 55) : DEFAULT_ANSWER_WITHIN_S;
	return Math.round(seconds * 1000);
}

/** Actions that only read: they never take the timeline's write turn. */
export const READ_ACTIONS = new Set([
	"list",
	"get",
	"summary",
	"element",
	"comments",
	"describe",
	"status",
	"versions",
	"history",
	"contract",
	"voices",
	"edits",
	"measure",
	"card",
	"resolve",
	"suggest",
	"reference",
]);

/** The timeline whose write turn this call needs, or null (reads, read-only tools, calls without a timeline). */
export function writeTurnFor(tool: { name: string; annotations?: Record<string, unknown> }, args: Record<string, unknown>): string | null {
	if (tool.annotations?.readOnlyHint === true) return null;
	const timelineId = typeof args.timeline_id === "string" ? args.timeline_id.trim() : "";
	if (!timelineId) return null;
	const action = typeof args.action === "string" ? args.action : "";
	if (action && READ_ACTIONS.has(action)) return null;
	if (!action && tool.name === "history") return null; // history's default action is list
	return timelineId;
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

/** Same caller + same tool + same arguments → the same key (the arguments in a stable key order). */
export function callKey(tool: string, args: Record<string, unknown>, caller: { userId?: string | null; org?: string | null } | null): string {
	return createHash("sha256")
		.update(`${caller?.userId ?? "-"}|${caller?.org ?? "-"}|${tool}|${stable(args)}`)
		.digest("hex");
}

// ── pending calls ──────────────────────────────────────────────────────────────────────────────────────────────

export interface PendingCall<R> {
	key: string;
	label: string;
	startedAt: number;
	timelineId: string | null;
	promise: Promise<R>;
	settled?: { value: R; at: number };
	/** True once a caller got "working" for it: its result must wait for a collector. */
	backgrounded: boolean;
}

interface QueueState {
	pending: Map<string, PendingCall<unknown>>;
	turns: Map<string, { tail: Promise<void>; holders: Array<{ label: string; since: number }> }>;
}

function state(): QueueState {
	const g = globalThis as unknown as { __restorffcutMcpQueue?: QueueState };
	g.__restorffcutMcpQueue ??= { pending: new Map(), turns: new Map() };
	return g.__restorffcutMcpQueue;
}

/** A running (or finished, uncollected) call with this key. */
export function pendingCall<R>(key: string): PendingCall<R> | null {
	const entry = state().pending.get(key) as PendingCall<R> | undefined;
	if (!entry) return null;
	if (entry.settled && Date.now() - entry.settled.at > KEEP_RESULT_MS) {
		state().pending.delete(key);
		return null;
	}
	return entry;
}

/** Register a call that just started; when it settles after someone was told "working", its result is kept. */
export function registerCall<R>(entry: Omit<PendingCall<R>, "backgrounded" | "settled">): PendingCall<R> {
	const full: PendingCall<R> = { ...entry, backgrounded: false };
	const { pending } = state();
	pending.set(entry.key, full as PendingCall<unknown>);
	entry.promise.then(
		(value) => {
			full.settled = { value, at: Date.now() };
			if (!full.backgrounded) {
				// answered directly: nothing to keep (a joined caller already holds the promise)
				if (pending.get(entry.key) === (full as PendingCall<unknown>)) pending.delete(entry.key);
				return;
			}
			const timer = setTimeout(() => {
				if (pending.get(entry.key) === (full as PendingCall<unknown>)) pending.delete(entry.key);
			}, KEEP_RESULT_MS);
			(timer as { unref?: () => void }).unref?.();
		},
		() => {
			if (pending.get(entry.key) === (full as PendingCall<unknown>)) pending.delete(entry.key);
		},
	);
	return full;
}

/** The result was handed to a caller: forget it (a later identical call runs again). */
export function collected(entry: PendingCall<unknown>): void {
	const { pending } = state();
	if (pending.get(entry.key) === entry) pending.delete(entry.key);
}

export const WORKING = Symbol("working");

/** The call's result if it settles within `ms`, else WORKING (the call keeps running). */
export async function within<R>(promise: Promise<R>, ms: number): Promise<R | typeof WORKING> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof WORKING>((resolve) => {
		timer = setTimeout(() => resolve(WORKING), Math.max(0, ms));
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

// ── one write at a time per timeline ───────────────────────────────────────────────────────────────────────────

export class TimelineBusyError extends Error {
	constructor(
		readonly timelineId: string,
		readonly holders: Array<{ label: string; seconds: number }>,
		readonly waitedMs: number,
	) {
		super(
			`Timeline ${timelineId} is busy: ${holders.map((holder) => `${holder.label} (running ${holder.seconds} s)`).join(", ") || "another change"} ` +
				`is changing it, and this call waited ${Math.round(waitedMs / 1000)} s for its turn. Nothing was done. Send this call again in a minute.`,
		);
	}
}

/** What is changing a timeline right now (for "working" answers). */
export function turnHolders(timelineId: string): Array<{ label: string; seconds: number }> {
	const turn = state().turns.get(timelineId);
	const now = Date.now();
	return (turn?.holders ?? []).map((holder) => ({ label: holder.label, seconds: Math.round((now - holder.since) / 1000) }));
}

/**
 * Wait for the timeline's write turn (FIFO), then hold it until `release()` is called. Throws TimelineBusyError when
 * the wait passes `maxWaitMs`, and the signal's reason when it aborts while waiting.
 */
export async function takeTurn(timelineId: string, label: string, { maxWaitMs, signal }: { maxWaitMs: number; signal?: AbortSignal }): Promise<() => void> {
	const { turns } = state();
	let turn = turns.get(timelineId);
	if (!turn) {
		turn = { tail: Promise.resolve(), holders: [] };
		turns.set(timelineId, turn);
	}
	const before = turn.tail;
	let release!: () => void;
	const mine = new Promise<void>((resolve) => {
		release = resolve;
	});
	turn.tail = before.then(() => mine);
	const t0 = Date.now();
	const cleanup = () => {
		const current = turns.get(timelineId);
		if (current && current.holders.length === 0 && current.tail === tailAfterMine) turns.delete(timelineId);
	};
	const tailAfterMine = turn.tail;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			before,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new TimelineBusyError(timelineId, turnHolders(timelineId), Date.now() - t0)), Math.max(0, maxWaitMs));
				onAbort = () => reject(signal?.reason ?? new Error("aborted"));
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} catch (error) {
		// give the turn up at once (whoever queued behind us still waits for the ones before us)
		release();
		cleanup();
		throw error;
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
	const holder = { label, since: Date.now() };
	turn.holders.push(holder);
	let done = false;
	return () => {
		if (done) return;
		done = true;
		const index = turn.holders.indexOf(holder);
		if (index >= 0) turn.holders.splice(index, 1);
		release();
		cleanup();
	};
}
