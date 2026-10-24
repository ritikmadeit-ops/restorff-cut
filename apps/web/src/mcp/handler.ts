/**
 * The standalone MCP endpoint's handler: auth + the protocol layer + the tools.
 *
 * Auth (same rules as the project store, server/auth.ts):
 *   - `Authorization: Bearer <RESTORFFCUT_SERVICE_TOKEN>` (constant-time compare), plus `X-Restorff-Org` (the org the
 *     Restorff gateway forwards for; scopes saved styles and the repeat history — server/tenant.ts), or
 *   - local dev: NODE_ENV ≠ production, addressed to localhost, not through a proxy (RESTORFFCUT_LOCAL_DEV=0 turns
 *     it off). Responses then carry `X-RestorffCut-Auth: local-dev`.
 * Anything else: 401.
 */
import { isLocalDevRequest, safeEqual } from "@/server/auth";
import { HttpError } from "@/server/http";
import { getProjectHead } from "@/server/projects";
import { orgFromHeader, runWithOrg } from "@/server/tenant";
import { secondsEverywhere } from "@/server/timeline-read-hygiene";
import { auditNext, defaultNext, type HeadLookup } from "./hints";
import { withLinks } from "./media-tool";
import { makeMcpHandler, type McpAuth, type Payload } from "./protocol";
import { renderScopeGuard } from "./render-scope";
import { SERVER_INSTRUCTIONS, TOOLS } from "./tools";

/** For the hint rules that must know a timeline's head (hints.ts). */
const lookupHead: HeadLookup = async (timelineId) => {
	try {
		const head = await getProjectHead(timelineId);
		return { head: head.head.id, snapshot: head.snapshot };
	} catch {
		return null;
	}
};

/** A READ over the result cap: the real argument that asks for less (mcp-discover, 2026-10-20; was "Page it" with none). */
function pageHint(tool: string, args: Record<string, unknown>): Payload | null {
	const timelineId = typeof args.timeline_id === "string" ? args.timeline_id : undefined;
	if (tool === "timeline" && timelineId) {
		return {
			do: "Read it in pages: the same call with offset (the answer's page.next_offset), or narrow it with track, from_s + to_s, or element_ids; one element in full: action element.",
			tool: "timeline",
			arguments: { action: args.action === "summary" ? "summary" : "get", timeline_id: timelineId, offset: typeof args.offset === "number" ? args.offset : 0 },
		};
	}
	if (tool === "look") {
		const times = Array.isArray(args.times) ? (args.times as unknown[]).slice(0, 4) : undefined;
		return { do: "Ask for fewer frames: at most 4 times per call (or a shorter t0–t1).", tool: "look", arguments: { ...args, ...(times ? { times } : {}) } };
	}
	return null;
}

const handler = makeMcpHandler({
	serverInfo: { name: "restorffcut", title: "RestorffCut", version: "0.1.0" },
	instructions: SERVER_INSTRUCTIONS,
	tools: TOOLS,
	decorate: async (payload, { tool, isError, args, request }) => {
		const withNext = payload.next ? payload : { ...payload, next: defaultNext(tool, args, payload) };
		// mcp-discover (SUMMARY gap 10): known-misleading hints rewritten where they are still wrong (hints.ts)
		const audited = await auditNext(withNext, { tool, args: args ?? {}, isError }, lookupHead);
		// mcp-media (PARITY G12): every successful timeline-scoped result carries the editor link
		const linked = isError ? audited : withLinks(audited, args, request);
		// mcp-discover: seconds everywhere — the reducer's "<n> ticks" messages become seconds
		return secondsEverywhere(linked);
	},
	pageHint,
	// mcp-gaps-mvp (2026-10-24): a render id of another org's timeline answers "not found" (./render-scope.ts)
	guard: renderScopeGuard,
	log: (entry) => {
		if (process.env.RESTORFFCUT_MCP_LOG === "1") console.log("[mcp]", JSON.stringify(entry));
	},
});

function bearer(request: Request): string | null {
	const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization")?.trim() ?? "");
	return match ? match[1].trim() : null;
}

/**
 * The caller. With the service token, `X-Restorff-Org` (the Restorff org the gateway forwards for) becomes auth.org;
 * it is ignored for local dev (security-pass, 2026-10-21; server/tenant.ts). Throws HttpError 400 on a malformed org.
 * The MCP session stays the service's (userId "service"): the gateway keeps one session and sends the org per call.
 */
export function authorize(request: Request): McpAuth | null {
	const token = bearer(request);
	const serviceToken = process.env.RESTORFFCUT_SERVICE_TOKEN;
	if (token) {
		if (serviceToken && safeEqual(token, serviceToken)) {
			const org = orgFromHeader(request);
			return { userId: "service", kind: "service", name: "Claude (MCP)", ...(org ? { org } : {}) };
		}
		return null;
	}
	if (isLocalDevRequest(request)) return { userId: "local-dev", kind: "local-dev", name: "Claude (MCP, local dev)" };
	return null;
}

export async function handleMcp(request: Request): Promise<Response> {
	let auth: McpAuth | null;
	try {
		auth = authorize(request);
	} catch (error) {
		const message = error instanceof HttpError ? error.message : "bad request";
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message } }), { status: 400, headers: { "content-type": "application/json" } });
	}
	if (!auth) {
		return new Response(
			JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "authentication required: Authorization: Bearer <RESTORFFCUT_SERVICE_TOKEN>" } }),
			{ status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="restorffcut"' } },
		);
	}
	const caller = auth;
	// the org rides along everything the call awaits (styles-store.ts styleOwner reads it for service callers)
	const response = await runWithOrg(caller.kind === "service" ? (caller.org ?? null) : null, () => handler(request, { signal: request.signal, auth: caller }));
	response.headers.set("x-restorffcut-auth", auth.kind);
	return response;
}
