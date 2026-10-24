#!/usr/bin/env bun
// mcp-call — talk to RestorffCut's MCP endpoint (/api/mcp) exactly the way a Claude client does:
// initialize → notifications/initialized → tools/list | tools/call → DELETE the session. For recreation tests that
// must drive the editor the way a Claude does (docs/restorff/PARITY.md), and for poking the tools by hand.
//
//   bun scripts/mcp-call.ts list [--json] [--instructions]
//   bun scripts/mcp-call.ts call <tool> '<json args>' [--images <dir>] [--raw]
//   bun scripts/mcp-call.ts call <tool> @args.json   [--images <dir>] [--raw]
//
// list prints the server's `instructions` (what a real MCP client hands the model at initialize) to stderr before
// the tools; --instructions puts them in stdout too: {instructions, tools} instead of the bare tool array
// (mcp-discover, 2026-10-20 — every recreation had to read them from apps/web/src/mcp/tools.ts instead).
//
// Auth: `Authorization: Bearer $RESTORFFCUT_SERVICE_TOKEN`; when the variable is not set, the value is read from
// apps/web/.env.local (never printed). --org <id> (or $RESTORFFCUT_ORG) adds X-Restorff-Org: the call then sees only that
// org's timelines (mcp-gaps-mvp, 2026-10-24). A `status: "working"` answer is followed by re-sending the same call
// until it has a result (--no-follow stops at the first answer). Base URL: $RESTORFFCUT_URL (default http://localhost:8791) or --url.
// Output: stdout = JSON only (list: the tools; call: the result's structuredContent, or the whole JSON-RPC result with
// --raw). Progress lines go to stderr. Images in a result are saved to --images <dir>, which must be OUTSIDE the repo
// (frames of a render may come from third-party reels — BUILD-BRIEF §6 rule 11); without --images they are counted
// on stderr and dropped.
// Exit codes: 0 ok · 1 the tool answered isError, or a protocol/HTTP error · 2 usage.
// Runbook: docs/restorff/PARITY.md §"mcp-call".
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(REPO_ROOT, "apps", "web", ".env.local");
const DEFAULT_URL = "http://localhost:8791";
const CLIENT = { name: "restorffcut-mcp-call", version: "0.1.0" };
const PROTOCOL = "2025-11-25";

const USAGE = [
	"usage:",
	"  bun scripts/mcp-call.ts list [--json] [--instructions]",
	"  bun scripts/mcp-call.ts call <tool> '<json args>' [--images <dir>] [--raw]",
	"  bun scripts/mcp-call.ts call <tool> @args.json [--images <dir>] [--raw]",
	"options: --url <base> (default $RESTORFFCUT_URL or http://localhost:8791) · --timeout <seconds> (default 240)",
	"         --org <id> (X-Restorff-Org: act as that org, with the service token) · --no-follow (stop at a status \"working\" answer)",
].join("\n");

interface Options {
	command: string;
	tool?: string;
	args: Record<string, unknown>;
	images?: string;
	raw: boolean;
	json: boolean;
	instructions: boolean;
	url: string;
	timeoutS: number;
	/** mcp-gaps-mvp (2026-10-24): X-Restorff-Org for the call (timelines + styles are per org). */
	org: string | null;
	/** Re-send the same call while the server answers status "working" (the default; --no-follow stops). */
	follow: boolean;
}

function die(message: string, code = 2): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function parseArgs(argv: string[]): Options {
	const positional: string[] = [];
	let images: string | undefined;
	let raw = false;
	let json = false;
	let instructions = false;
	let url = process.env.RESTORFFCUT_URL || DEFAULT_URL;
	let timeoutS = 240;
	let org: string | null = process.env.RESTORFFCUT_ORG?.trim() || null;
	let follow = true;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--org") org = argv[++i] ?? die("--org needs an org id");
		else if (arg === "--no-follow") follow = false;
		else if (arg === "--images") images = argv[++i] ?? die("--images needs a folder");
		else if (arg === "--raw") raw = true;
		else if (arg === "--json") json = true;
		else if (arg === "--instructions") instructions = true;
		else if (arg === "--url") url = argv[++i] ?? die("--url needs a base URL");
		else if (arg === "--timeout") timeoutS = Number(argv[++i] ?? die("--timeout needs seconds"));
		else if (arg === "-h" || arg === "--help") die(USAGE, 0);
		else positional.push(arg);
	}
	const [command, tool, argText] = positional;
	if (command !== "list" && command !== "call") die(USAGE);
	if (command === "call" && !tool) die(`call needs a tool name\n${USAGE}`);
	if (!(timeoutS > 0)) die("--timeout must be a positive number of seconds");
	let args: Record<string, unknown> = {};
	if (command === "call" && argText !== undefined) {
		let text = argText;
		if (text.startsWith("@")) {
			const file = resolve(text.slice(1));
			if (!existsSync(file)) die(`no such file: ${file}`);
			text = readFileSync(file, "utf8");
		}
		try {
			args = JSON.parse(text) as Record<string, unknown>;
		} catch (error) {
			die(`arguments are not valid JSON: ${(error as Error).message}\n(PowerShell: quote the JSON in single quotes, or pass @args.json)`);
		}
		if (!args || typeof args !== "object" || Array.isArray(args)) die("arguments must be a JSON object");
	}
	if (images) {
		const dir = resolve(images);
		const rel = relative(REPO_ROOT, dir);
		if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) die(`--images must be outside the repo (${REPO_ROOT}); got ${dir}`);
		images = dir;
	}
	if (org !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(org)) die("--org must be 1-64 characters of A-Z a-z 0-9 _ -");
	return { command, tool, args, images, raw, json, instructions, url: url.replace(/\/+$/, ""), timeoutS, org, follow };
}

/** The service token: the environment first, else apps/web/.env.local. Never printed. */
function serviceToken(): string | null {
	const fromEnv = process.env.RESTORFFCUT_SERVICE_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	if (!existsSync(ENV_FILE)) return null;
	for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
		const match = /^\s*RESTORFFCUT_SERVICE_TOKEN\s*=\s*(.*)\s*$/.exec(line);
		if (!match) continue;
		const value = match[1].replace(/^(['"])(.*)\1$/, "$2").trim();
		return value || null;
	}
	return null;
}

interface RpcReply {
	status: number;
	headers: Headers;
	body: { jsonrpc?: string; id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } } | null;
}

class Client {
	private session: string | null = null;
	private protocol = PROTOCOL;
	private nextId = 1;
	constructor(
		private readonly endpoint: string,
		private readonly token: string | null,
		private readonly timeoutS: number,
		private readonly org: string | null = null,
	) {}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		if (this.token) headers.authorization = `Bearer ${this.token}`;
		if (this.org) headers["x-restorff-org"] = this.org;
		if (this.session) {
			headers["mcp-session-id"] = this.session;
			headers["mcp-protocol-version"] = this.protocol;
		}
		return headers;
	}

	private async post(message: Record<string, unknown>): Promise<RpcReply> {
		const response = await fetch(this.endpoint, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(message),
			signal: AbortSignal.timeout(this.timeoutS * 1000),
		});
		const text = await response.text();
		if (!text.trim()) return { status: response.status, headers: response.headers, body: null };
		// Streamable HTTP may answer as an SSE stream: the JSON-RPC message is in the `data:` lines.
		const isSse = (response.headers.get("content-type") ?? "").includes("text/event-stream");
		const payload = isSse
			? text
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.filter(Boolean)
					.pop() ?? ""
			: text;
		try {
			return { status: response.status, headers: response.headers, body: JSON.parse(payload) };
		} catch {
			throw new Error(`HTTP ${response.status}: not JSON: ${text.slice(0, 300)}`);
		}
	}

	async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const reply = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params });
		if (reply.body?.error) throw new Error(`${method}: HTTP ${reply.status}, JSON-RPC error ${reply.body.error.code}: ${reply.body.error.message}`);
		if (reply.status >= 400 || !reply.body?.result) throw new Error(`${method}: HTTP ${reply.status}${reply.body ? ` ${JSON.stringify(reply.body).slice(0, 300)}` : ""}`);
		return reply.body.result;
	}

	async initialize(): Promise<{ serverInfo: unknown; protocol: string; auth: string | null; instructions: boolean; instructionsText: string | null }> {
		const reply = await this.post({
			jsonrpc: "2.0",
			id: this.nextId++,
			method: "initialize",
			params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT },
		});
		if (reply.body?.error) throw new Error(`initialize: HTTP ${reply.status}, JSON-RPC error ${reply.body.error.code}: ${reply.body.error.message}`);
		if (reply.status >= 400 || !reply.body?.result) throw new Error(`initialize: HTTP ${reply.status}`);
		this.session = reply.headers.get("mcp-session-id");
		const result = reply.body.result;
		this.protocol = typeof result.protocolVersion === "string" ? result.protocolVersion : PROTOCOL;
		// The client's half of the handshake (a notification: no id, the server answers 202 with no body).
		await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
		return {
			serverInfo: result.serverInfo,
			protocol: this.protocol,
			auth: reply.headers.get("x-restorffcut-auth"),
			instructions: typeof result.instructions === "string",
			instructionsText: typeof result.instructions === "string" ? result.instructions : null,
		};
	}

	async close(): Promise<void> {
		if (!this.session) return;
		try {
			await fetch(this.endpoint, { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(10_000) });
		} catch {
			// best effort: the server drops idle sessions anyway
		}
		this.session = null;
	}

	get sessionId() {
		return this.session;
	}
}

interface ToolInfo {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] };
}

function compactTool(tool: ToolInfo) {
	const props = tool.inputSchema?.properties ?? {};
	return {
		name: tool.name,
		title: tool.title ?? null,
		required: tool.inputSchema?.required ?? [],
		...(props.action?.enum ? { actions: props.action.enum } : {}),
		...(props.kind?.enum ? { kinds: props.kind.enum } : {}),
		args: Object.keys(props),
	};
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

function saveImages(dir: string, tool: string, content: unknown): string[] {
	const items = Array.isArray(content) ? (content as Array<{ type?: string; data?: string; mimeType?: string }>) : [];
	const images = items.filter((item) => item.type === "image" && typeof item.data === "string");
	if (!images.length) return [];
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return images.map((image, i) => {
		const file = join(dir, `${tool}-${stamp}-${String(i + 1).padStart(2, "0")}.${EXT[image.mimeType ?? ""] ?? "bin"}`);
		writeFileSync(file, Buffer.from(image.data as string, "base64"));
		return file;
	});
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const token = serviceToken();
	const endpoint = `${options.url}/api/mcp`;
	const client = new Client(endpoint, token, options.timeoutS, options.org);
	let exitCode = 0;
	try {
		const started = Date.now();
		const init = await client.initialize();
		process.stderr.write(
			`initialize: ${endpoint} · server ${JSON.stringify(init.serverInfo)} · protocol ${init.protocol} · auth ${init.auth ?? "?"}${token ? " (bearer)" : " (no token)"} · session ${client.sessionId ? "yes" : "no"} · instructions ${init.instructions ? "yes" : "no"} · ${Date.now() - started} ms\n`,
		);
		if (options.command === "list") {
			// what a real client hands the model at initialize
			process.stderr.write(`instructions (${init.instructionsText?.length ?? 0} chars):\n${init.instructionsText ?? "(none)"}\n`);
			const result = await client.request("tools/list");
			const tools = (result.tools as ToolInfo[] | undefined) ?? [];
			process.stderr.write(`tools/list: ${tools.length} tools\n`);
			const listed = options.json ? tools : tools.map(compactTool);
			process.stdout.write(`${JSON.stringify(options.instructions ? { instructions: init.instructionsText, tools: listed } : listed, null, 2)}\n`);
		} else {
			const t0 = Date.now();
			let result = await client.request("tools/call", { name: options.tool, arguments: options.args });
			// mcp-gaps-mvp (2026-10-24): a call still running at the server's answer deadline (45 s) answers status
			// "working"; the same call again collects it (it never runs twice). Follow it, like a client should.
			for (let round = 1; options.follow && (result.structuredContent as { status?: unknown } | undefined)?.status === "working"; round++) {
				const working = (result.structuredContent as { working?: { seconds_so_far?: number } }).working;
				process.stderr.write(`tools/call ${options.tool}: working (${working?.seconds_so_far ?? "?"} s so far) · sending the same call again (${round})\n`);
				if ((Date.now() - t0) / 1000 > options.timeoutS) break;
				result = await client.request("tools/call", { name: options.tool, arguments: options.args });
			}
			const isError = result.isError === true;
			const images = (Array.isArray(result.content) ? result.content : []).filter((item: { type?: string }) => item?.type === "image").length;
			process.stderr.write(`tools/call ${options.tool}: ${isError ? "isError" : "ok"} · ${Date.now() - t0} ms · images ${images}\n`);
			if (images) {
				if (options.images) for (const file of saveImages(options.images, options.tool as string, result.content)) process.stderr.write(`saved ${file}\n`);
				else process.stderr.write("(images dropped: pass --images <dir outside the repo> to save them)\n");
			}
			// `not_built` is a normal answer (not isError): say it, so a test log can't mistake it for success.
			const status = (result.structuredContent as { status?: unknown } | undefined)?.status;
			if (status === "not_built") process.stderr.write(`note: ${options.tool} answered status "not_built" (exit 0; see its message)\n`);
			const out = options.raw
				? { ...result, content: (result.content as Array<Record<string, unknown>>).map((item) => (item.type === "image" ? { type: "image", mimeType: item.mimeType, bytes: Math.round(((item.data as string)?.length ?? 0) * 0.75) } : item)) }
				: (result.structuredContent ?? result.content);
			process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
			if (isError) exitCode = 1;
		}
	} catch (error) {
		process.stderr.write(`mcp-call: ${(error as Error).message}\n`);
		exitCode = 1;
	} finally {
		await client.close();
	}
	process.exit(exitCode);
}

await main();
