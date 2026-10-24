/**
 * The MCP protocol layer: Streamable HTTP as a web-standard handler, (Request, {signal, auth}) → Response.
 *
 * Copied from Restorff's gateway (`restorff/apps/gateway/src/mcp.mjs`, 2026-10-20) and turned into TypeScript for
 * RestorffCut's standalone MCP (plan/06-mcp.md §4). Protocol versions 2025-03-26, 2025-06-18 and 2025-11-25. No
 * dependencies. What it does:
 *   - one JSON-RPC message per POST; `initialize` opens a session (Mcp-Session-Id) owned by the caller
 *   - every tool call has a time budget (30 s default, never over 200 s — claude.ai cuts a call at 240 s)
 *   - mcp-gaps-mvp (2026-10-24, ./call-queue.ts): an answer within 45 s (Claude Code cuts a call at 60 s): a call
 *     still running then keeps running and answers `status: "working"`; the same call again collects it. One write
 *     per timeline at a time (others queue; `timeline_busy` past the budget). No server path in any answer.
 *   - arguments are checked against the tool's inputSchema before the tool runs
 *   - results are capped (≈25 k tokens of text, ≤ 12 images); images go in `content` only, never in
 *     `structuredContent` (Claude Code hands structuredContent to the model instead of content)
 *   - every result, errors included, passes through `decorate(payload, ctx)` — where `next` goes
 *   - then hygiene (mcp-discover, 2026-10-20): data: URLs / long base64 → mime + sha256 + length, commit_id first;
 *     over the cap, a write answers commit_id + `trimmed` (never an error), a read names a real paging argument
 * Tools: {name, title, description, inputSchema, annotations?, budgetSeconds?, run(args, ctx)}; run returns
 * {payload, images?, isError?}. Runbook: docs/restorff/worklog/bridge.md.
 */
import { randomUUID } from "node:crypto";
import { runWithCallScope } from "@/server/call-scope";
import { pathsIn, scrubServerPaths } from "@/server/path-scrub";
import { scrubData } from "@/server/timeline-read-hygiene";
import {
	answerWithinMs,
	callKey,
	collected,
	type PendingCall,
	pendingCall,
	registerCall,
	takeTurn,
	TimelineBusyError,
	turnHolders,
	within,
	WORKING,
	writeTurnFor,
} from "./call-queue";

export const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const MAX_BUDGET_SECONDS = 200;
const MAX_BODY = 1_000_000;
const MAX_SESSIONS = 10_000;
const OVER_BUDGET = Symbol("over-budget");

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Payload = Record<string, unknown>;

export interface ToolImage {
	data: string;
	mimeType: string;
}

export interface ToolOutput {
	payload?: Payload;
	images?: ToolImage[];
	isError?: boolean;
}

/** A tools/call result as it goes on the wire (render's answer). */
export interface RenderedResult {
	content: unknown[];
	structuredContent: Payload;
	isError?: boolean;
}

export interface McpAuth {
	userId: string;
	kind: string;
	name: string;
	/** Service token only: the Restorff org of this call (X-Restorff-Org; security-pass 2026-10-21, server/tenant.ts). */
	org?: string;
}

export interface ToolContext {
	sessionId: string | null;
	signal: AbortSignal;
	auth: McpAuth | null;
	request: Request;
}

export interface JsonSchema {
	type?: string | string[];
	description?: string;
	enum?: unknown[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	minItems?: number;
	minimum?: number;
	maximum?: number;
	additionalProperties?: boolean;
	// mcp-discover (2026-10-20): per-op schemas for timeline_ops.ops (oneOf keyed by `op`); checkArgs ignores these
	title?: string;
	const?: unknown;
	oneOf?: JsonSchema[];
	minLength?: number;
	maxItems?: number;
	exclusiveMinimum?: number;
}

export interface Tool {
	name: string;
	title?: string;
	description: string;
	inputSchema: JsonSchema;
	annotations?: Record<string, unknown>;
	budgetSeconds?: number;
	run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput> | ToolOutput;
}

interface Session {
	userId: string | null;
	clientInfo: unknown;
	protocolVersion: string;
	startedAt: string;
}

interface RpcMessage {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

export interface McpHandlerOptions {
	serverInfo: { name: string; version: string; title?: string };
	instructions?: string;
	tools: Tool[];
	/** args + request: the call's arguments and HTTP request (mcp-media, 2026-10-20: editor_url on timeline results). */
	decorate?: (payload: Payload, ctx: { tool: string; isError: boolean; args?: Record<string, unknown>; request?: Request }) => Payload | Promise<Payload>;
	log?: (entry: Record<string, unknown>) => void;
	defaultBudgetSeconds?: number;
	maxResultChars?: number;
	maxImages?: number;
	/**
	 * mcp-discover (2026-10-20): what to ask for instead when a READ answer is over the cap (a real paging argument,
	 * never "page it" with none). Writes over the cap never error: they answer commit_id first (see render()).
	 */
	pageHint?: (tool: string, args: Record<string, unknown>, payload: Payload) => Payload | null;
	/**
	 * mcp-gaps-mvp (2026-10-24): runs before a tool; an answer here is the call's answer and the tool never runs
	 * (render ids of another org's timeline → not found: ./render-scope.ts).
	 */
	guard?: (tool: string, args: Record<string, unknown>) => Promise<ToolOutput | null> | ToolOutput | null;
}

/**
 * Result hygiene, every tool (mcp-discover, 2026-10-20; recreations SUMMARY 18a): data: URLs and long base64 never
 * go back to the model (mime + sha256 + length instead), a successful write's `commit_id` comes first, and an answer
 * still over the cap after a write is cut down around its commit_id — never a bare `result_too_large` (the
 * effects-library recreation's Orbit apply committed, answered result_too_large, and invited a double apply).
 */
const FIRST_KEYS = ["commit_id", "committed", "status", "render_id", "head", "timeline_id", "branch", "message"];

function commitIdOf(payload: Payload): string | null {
	if (typeof payload.commit_id === "string" && payload.commit_id) return payload.commit_id;
	const commit = payload.commit as { id?: unknown } | undefined;
	if (commit && typeof commit === "object" && typeof commit.id === "string") return commit.id;
	return null;
}

/** commit_id (then status, head…) first, everything else in its order, `next` last. */
export function orderKeys(payload: Payload): Payload {
	const keys = Object.keys(payload);
	const nextIsLast = payload.next === undefined || keys[keys.length - 1] === "next";
	if (!commitIdOf(payload) && payload.status === undefined && nextIsLast) return payload;
	const out: Payload = {};
	if (commitIdOf(payload) || payload.status !== undefined) for (const key of FIRST_KEYS) if (payload[key] !== undefined) out[key] = payload[key];
	for (const [key, value] of Object.entries(payload)) if (!(key in out) && key !== "next") out[key] = value;
	if (payload.next !== undefined) out.next = payload.next;
	return out;
}

/** The fields of `payload` that fit in `limit` chars (small ones first), and what was dropped. */
export function fitFields(payload: Payload, limit: number, keep: Payload = {}): { fitted: Payload; dropped: Array<{ field: string; chars: number }> } {
	const fitted: Payload = { ...keep };
	const dropped: Array<{ field: string; chars: number }> = [];
	let used = JSON.stringify(fitted).length;
	const sized = Object.entries(payload)
		.filter(([key]) => !(key in keep))
		.map(([key, value]) => ({ key, value, chars: JSON.stringify(value ?? null).length + key.length + 4 }))
		.sort((a, b) => a.chars - b.chars);
	for (const { key, value, chars } of sized) {
		if (used + chars <= limit) {
			fitted[key] = value;
			used += chars;
		} else dropped.push({ field: key, chars });
	}
	// back in the original order
	const ordered: Payload = {};
	for (const key of [...Object.keys(keep), ...Object.keys(payload)]) if (key in fitted && !(key in ordered)) ordered[key] = fitted[key];
	return { fitted: ordered, dropped };
}

/** An answer over the cap: a write keeps its commit_id and says it IS made; a read names what to ask for instead. */
export function oversize(
	payload: Payload,
	{ tool, isError, chars, limit, hint }: { tool: string; isError: boolean; chars: number; limit: number; hint: Payload | null },
): { payload: Payload; isError: boolean } {
	const commitId = isError ? null : commitIdOf(payload);
	const room = limit - 2_500;
	if (commitId) {
		const keep: Payload = { commit_id: commitId, committed: true };
		const { next, ...rest } = payload;
		const { fitted, dropped } = fitFields(rest, room, keep);
		return {
			isError: false,
			payload: {
				...fitted,
				trimmed: {
					chars,
					limit,
					dropped,
					note: `The commit ${commitId} IS made: do not send this ${tool} call again. This answer was ${chars} chars, so the fields in dropped were left out; read the result with timeline summary.`,
				},
				next:
					next ??
					(typeof payload.timeline_id === "string"
						? { do: "Read the timeline summary to see what changed.", tool: "timeline", arguments: { action: "summary", timeline_id: payload.timeline_id } }
						: { do: "List the timelines.", tool: "timeline", arguments: { action: "list" } }),
			},
		};
	}
	const { next: _next, error, ...rest } = payload;
	const small = Object.fromEntries(Object.entries(rest).filter(([, value]) => value === null || typeof value !== "object"));
	const { fitted, dropped } = fitFields(small, Math.min(room, 6_000));
	const ask = hint ?? { do: `Ask ${tool} for less: a filter, fewer ids or times, or a smaller limit (its inputSchema lists them).`, tool };
	return {
		isError: true,
		payload: {
			error: {
				code: "result_too_large",
				message: `The answer was ${chars} chars (limit ${limit}). ${typeof ask.do === "string" ? ask.do : "Ask for less."}`,
				chars,
				limit,
				...(error && typeof error === "object" ? { original_error: error } : {}),
			},
			...(Object.keys(fitted).length ? { partial: fitted } : {}),
			left_out: [...dropped.map((entry) => entry.field), ...Object.keys(rest).filter((key) => !(key in small))],
			next: ask,
		},
	};
}

/** Sessions live on globalThis so a dev-server hot reload of this module does not drop them. */
function sessionStore(): Map<string, Session> {
	const g = globalThis as unknown as { __restorffcutMcpSessions?: Map<string, Session> };
	g.__restorffcutMcpSessions ??= new Map();
	return g.__restorffcutMcpSessions;
}

export function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolOutput {
	return { payload: { error: { code, message, ...extra } }, isError: true };
}

export function makeMcpHandler({
	serverInfo,
	instructions,
	tools,
	decorate = (payload) => payload,
	log = () => {},
	defaultBudgetSeconds = 30,
	maxResultChars = 75_000,
	maxImages = 12,
	pageHint = () => null,
	guard = () => null,
}: McpHandlerOptions) {
	const sessions = sessionStore();
	const toolMap = new Map<string, Tool>();
	for (const tool of tools) {
		if (toolMap.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
		if ((tool.budgetSeconds ?? defaultBudgetSeconds) > MAX_BUDGET_SECONDS) {
			throw new Error(`${tool.name}: budget over ${MAX_BUDGET_SECONDS} s - make it a job`);
		}
		toolMap.set(tool.name, tool);
	}

	return async function handle(request: Request, { signal, auth = null }: { signal?: AbortSignal; auth?: McpAuth | null } = {}): Promise<Response> {
		const headers = request.headers;
		const sessionId = headers.get("mcp-session-id");
		const base = { sessionId, userId: auth?.userId ?? null };

		const versionHeader = headers.get("mcp-protocol-version");
		if (versionHeader && !SUPPORTED_VERSIONS.includes(versionHeader)) {
			return json(400, rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${versionHeader}`));
		}
		if (request.method === "GET") return json(405, rpcError(null, -32000, "This server does not offer a GET stream."));
		if (request.method === "DELETE") {
			if (sessionId && sessions.get(sessionId)?.userId === base.userId) sessions.delete(sessionId);
			log({ ...base, http: "DELETE" });
			return new Response(null, { status: 200 });
		}
		if (request.method !== "POST") return json(405, rpcError(null, -32000, "Method not allowed."));

		const text = await request.text();
		if (text.length > MAX_BODY) return json(413, rpcError(null, -32600, "Body too large."));
		let msg: unknown;
		try {
			msg = JSON.parse(text);
		} catch {
			return json(400, rpcError(null, -32700, "Parse error."));
		}
		if (Array.isArray(msg)) return json(400, rpcError(null, -32600, "Batches are not supported: send one message per request."));
		if (msg === null || typeof msg !== "object") return json(400, rpcError(null, -32600, "Invalid request."));
		const message = msg as RpcMessage;

		if (message.method !== "initialize") {
			if (!sessionId) return json(400, rpcError(null, -32000, "Missing Mcp-Session-Id: call initialize first."));
			const session = sessions.get(sessionId);
			// Unknown, expired or someone else's session: 404 tells the client to initialize again (spec).
			if (!session || session.userId !== base.userId) return json(404, rpcError(null, -32001, "Session not found."));
		}

		const extraHeaders: Record<string, string> = {};
		const out = await dispatch(message, { sessionId, signal: signal ?? new AbortController().signal, auth, request }, base, extraHeaders);
		if (!out) return new Response(null, { status: 202, headers: extraHeaders });
		return json(200, out, extraHeaders);
	};

	async function dispatch(m: RpcMessage, ctx: ToolContext, base: Record<string, unknown>, extraHeaders: Record<string, string>) {
		if (!m.method) return null; // a response from the client: nothing to answer
		if (m.id === undefined) {
			log({ ...base, notification: m.method });
			return null;
		}
		const { id, method } = m;
		const params = m.params ?? {};
		switch (method) {
			case "initialize": {
				const asked = params.protocolVersion as string | undefined;
				const protocolVersion = asked && SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
				const sid = randomUUID();
				if (sessions.size >= MAX_SESSIONS) {
					const oldest = sessions.keys().next().value;
					if (oldest) sessions.delete(oldest);
				}
				sessions.set(sid, {
					userId: (base.userId as string | null) ?? null,
					clientInfo: params.clientInfo ?? null,
					protocolVersion,
					startedAt: new Date().toISOString(),
				});
				extraHeaders["mcp-session-id"] = sid;
				log({ ...base, method, newSession: sid, clientInfo: params.clientInfo, askedVersion: asked ?? null });
				return ok(id, {
					protocolVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo,
					...(instructions ? { instructions } : {}),
				});
			}
			case "ping":
				return ok(id, {});
			case "tools/list":
				return ok(id, { tools: [...toolMap.values()].map(describeTool) });
			case "resources/list":
				return ok(id, { resources: [] });
			case "resources/templates/list":
				return ok(id, { resourceTemplates: [] });
			case "prompts/list":
				return ok(id, { prompts: [] });
			case "tools/call": {
				const tool = toolMap.get(params.name as string);
				if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
				return ok(id, await runTool(tool, params, ctx, base));
			}
			default:
				log({ ...base, method, note: "method not found" });
				return rpcError(id, -32601, `Method not found: ${method}`);
		}
	}

	async function runTool(tool: Tool, params: Record<string, unknown>, ctx: ToolContext, base: Record<string, unknown>) {
		const t0 = Date.now();
		const args = (params.arguments ?? {}) as Record<string, unknown>;
		// Argument names only: values can carry brand material.
		log({ ...base, tool: tool.name, argKeys: Object.keys(args ?? {}), phase: "start" });
		const finish = async (out: ToolOutput | undefined, phase: string) => {
			log({ ...base, tool: tool.name, phase, seconds: (Date.now() - t0) / 1000 });
			return render(tool, out, { args, request: ctx.request });
		};

		const problems = checkArgs(tool.inputSchema, args);
		if (problems.length) {
			return finish(fail("invalid_arguments", `Fix the arguments and call ${tool.name} again.`, { problems }), "invalid");
		}

		const guarded = await guard(tool.name, args);
		if (guarded) return finish(guarded, "guarded");

		// mcp-gaps-mvp (2026-10-24; ./call-queue.ts): the same call again joins the one still running (never runs twice)
		const key = callKey(tool.name, args, ctx.auth);
		const answerMs = answerWithinMs();
		const running = pendingCall<RenderedResult>(key);
		if (running) {
			log({ ...base, tool: tool.name, phase: "joined", seconds: (Date.now() - running.startedAt) / 1000 });
			return collect(tool, running, args, ctx, answerMs);
		}

		const budgetMs = (tool.budgetSeconds ?? defaultBudgetSeconds) * 1000;
		const ac = new AbortController();
		const onClientGone = () => ac.abort(new Error("client went away"));
		ctx.signal?.addEventListener("abort", onClientGone, { once: true });
		if (ctx.signal?.aborted) onClientGone();
		// once the client was told "working", the call no longer belongs to that request: it finishes on the server
		const detach = () => ctx.signal?.removeEventListener("abort", onClientGone);
		const turnFor = writeTurnFor(tool, args);
		const label = `${tool.name}${typeof args.action === "string" ? ` ${args.action}` : ""}`;

		const work = (async (): Promise<RenderedResult> => {
			let release: (() => void) | null = null;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				// one write at a time per timeline (first come first served); a wait longer than the budget is "busy"
				if (turnFor) release = await takeTurn(turnFor, label, { maxWaitMs: budgetMs, signal: ac.signal });
				const overBudget = new Promise<typeof OVER_BUDGET>((resolve) => {
					timer = setTimeout(() => {
						ac.abort(new Error("over budget"));
						resolve(OVER_BUDGET);
					}, budgetMs);
				});
				const scope = { timelineId: typeof args.timeline_id === "string" ? args.timeline_id : null };
				const out = await Promise.race([Promise.resolve().then(() => runWithCallScope(scope, () => tool.run(args, { ...ctx, signal: ac.signal }))), overBudget]);
				if (out === OVER_BUDGET) {
					return await finish(fail("over_budget", `${tool.name} took longer than its ${budgetMs / 1000} s budget.`), "over-budget");
				}
				return await finish(out, "done");
			} catch (err) {
				if (err instanceof TimelineBusyError) {
					return finish(
						fail("timeline_busy", err.message, { timeline_id: err.timelineId, busy_with: err.holders, retry_after_s: 30, next: { do: "Send the same call again in about 30 s.", tool: tool.name, arguments: args } }),
						"busy",
					);
				}
				const gone = Boolean(ctx.signal?.aborted);
				const e = err as { message?: string; status?: number; extra?: Record<string, unknown> };
				return finish(
					fail(e?.status ? `http_${e.status}` : "tool_failed", String(e?.message ?? err), e?.extra ?? {}),
					gone ? "client-gone" : "error",
				);
			} finally {
				clearTimeout(timer);
				release?.();
				detach();
			}
		})();
		const entry = registerCall<RenderedResult>({ key, label, startedAt: t0, timelineId: turnFor, promise: work });
		const result = await within(work, answerMs);
		if (result !== WORKING) {
			collected(entry as PendingCall<unknown>);
			return result;
		}
		detach();
		entry.backgrounded = true;
		log({ ...base, tool: tool.name, phase: "working", seconds: (Date.now() - t0) / 1000 });
		return working(tool, entry, args, ctx);
	}

	/** A joined call: its result if it settles within the deadline (handed over once), else "working" again. */
	async function collect(tool: Tool, entry: PendingCall<RenderedResult>, args: Record<string, unknown>, ctx: ToolContext, answerMs: number) {
		const result = entry.settled ? entry.settled.value : await within(entry.promise, answerMs);
		if (result !== WORKING) {
			collected(entry as PendingCall<unknown>);
			return result;
		}
		entry.backgrounded = true;
		return working(tool, entry, args, ctx);
	}

	/** The answer for a call still running past the deadline: it keeps running; the same call collects it. */
	function working(tool: Tool, entry: PendingCall<RenderedResult>, args: Record<string, unknown>, ctx: ToolContext) {
		const seconds = Math.round((Date.now() - entry.startedAt) / 1000);
		const others = entry.timelineId ? turnHolders(entry.timelineId).filter((holder) => holder.label !== entry.label) : [];
		const budget = tool.budgetSeconds ?? defaultBudgetSeconds;
		return render(
			tool,
			{
				payload: {
					status: "working",
					working: {
						call: entry.label,
						seconds_so_far: seconds,
						answer_within_s: Math.round(answerWithinMs() / 1000),
						budget_s: budget,
						...(entry.timelineId ? { timeline_id: entry.timelineId } : {}),
						...(others.length ? { queued_behind: others } : {}),
					},
					message:
						`${entry.label} is still running on the server (${seconds} s so far). MCP clients cut a call at about 60 s, so this server answers within ${Math.round(answerWithinMs() / 1000)} s instead of making you wait; ` +
						`the call was NOT stopped: it finishes (and commits, if it writes) on its own within ${budget} s. Send exactly the same ${tool.name} call again to get its result: it waits for it and never runs it twice. ` +
						"Don't send a different change to this timeline meanwhile (it would queue behind this one).",
					next: { do: `Send the same ${tool.name} call again (same arguments) to collect its result.`, tool: tool.name, arguments: args },
				},
			},
			{ args, request: ctx.request },
		);
	}

	async function render(tool: Tool, out: ToolOutput | undefined, call: { args?: Record<string, unknown>; request?: Request } = {}): Promise<RenderedResult> {
		let payload: Payload = out?.payload ?? {};
		let images: ToolImage[] = out?.images ?? [];
		let isError = Boolean(out?.isError);
		if (images.length > maxImages) {
			({ payload, isError } = fail("too_many_images", `At most ${maxImages} images per call. Ask for fewer.`, { asked: images.length }) as Required<Pick<ToolOutput, "payload" | "isError">>);
			images = [];
		}
		let decorated = await decorate(payload, { tool: tool.name, isError, ...call });
		// hygiene (every tool): no data: URLs / long base64 back to the model; commit_id first
		const scrubbed = scrubData(decorated);
		decorated = scrubbed.value;
		// mcp-gaps-mvp (2026-10-24): no server filesystem path in any answer (paths the caller sent may come back)
		decorated = scrubServerPaths(decorated, pathsIn(call.args ?? {})).value;
		if (scrubbed.omitted.length) {
			decorated = {
				...decorated,
				omitted_data: {
					count: scrubbed.omitted.length,
					items: scrubbed.omitted.slice(0, 5),
					note: "data: URLs and base64 are never echoed back: each is replaced by its mime, the first 16 hex of its SHA-256 and its length. Send your own data again if a later call needs it.",
				},
			};
		}
		decorated = orderKeys(decorated);
		let text = JSON.stringify(decorated);
		if (text.length > maxResultChars) {
			const cut = oversize(decorated, {
				tool: tool.name,
				// a read-only tool's commit_id names what it read, not a commit it made
				isError: isError || tool.annotations?.readOnlyHint === true,
				chars: text.length,
				limit: maxResultChars,
				hint: pageHint(tool.name, call.args ?? {}, decorated),
			});
			decorated = cut.payload;
			isError = cut.isError;
			text = JSON.stringify(decorated);
			if (isError) images = [];
		}
		const content = [{ type: "text", text }, ...images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }))];
		return { content, structuredContent: decorated, ...(isError ? { isError: true } : {}) };
	}
}

/** A small JSON Schema check: object type, required, unknown keys, and per-property type / enum / minItems / min / max. */
export function checkArgs(schema: JsonSchema | undefined, args: unknown): string[] {
	if (!schema) return [];
	if (typeof args !== "object" || args === null || Array.isArray(args)) return ["arguments must be an object"];
	const props = schema.properties ?? {};
	const problems: string[] = [];
	const record = args as Record<string, unknown>;
	for (const key of schema.required ?? []) if (record[key] === undefined) problems.push(`missing "${key}"`);
	for (const [key, value] of Object.entries(record)) {
		const prop = Object.hasOwn(props, key) ? props[key] : undefined;
		if (!prop) {
			if (schema.additionalProperties === false) problems.push(`unknown argument "${key}"`);
			continue;
		}
		const types = ([] as string[]).concat(prop.type ?? []);
		if (types.length && !types.some((type) => isType(value, type))) problems.push(`"${key}" must be ${types.join(" or ")}`);
		else if (prop.enum && !prop.enum.includes(value)) problems.push(`"${key}" must be one of: ${prop.enum.join(", ")}`);
		else if (Array.isArray(value) && prop.minItems !== undefined && value.length < prop.minItems) problems.push(`"${key}" needs at least ${prop.minItems} items`);
		else if (typeof value === "number" && prop.minimum !== undefined && value < prop.minimum) problems.push(`"${key}" must be >= ${prop.minimum}`);
		else if (typeof value === "number" && prop.maximum !== undefined && value > prop.maximum) problems.push(`"${key}" must be <= ${prop.maximum}`);
	}
	return problems;
}

function isType(value: unknown, type: string): boolean {
	if (type === "integer") return Number.isInteger(value);
	if (type === "number") return typeof value === "number" && Number.isFinite(value);
	if (type === "array") return Array.isArray(value);
	if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
	if (type === "null") return value === null;
	return typeof value === type;
}

function describeTool({ name, title, description, inputSchema, annotations }: Tool) {
	return { name, ...(title ? { title } : {}), description, inputSchema, ...(annotations ? { annotations } : {}) };
}

const ok = (id: RpcMessage["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

function json(status: number, obj: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
}
