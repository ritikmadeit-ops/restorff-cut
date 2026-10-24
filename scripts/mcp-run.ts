#!/usr/bin/env bun
// mcp-run — run a list of RestorffCut MCP calls in order over ONE session, logged (timing-helper, 2026-10-21).
// Every recreation and Sonnet replay rebuilt this in the scratchpad (sonnet-replay/mc.ts, sonnet-replay-3/mc.py,
// recreate-warm-moody/mcpx.py): a logging wrapper, @img: expansion, ids carried from one answer into the next call.
//
//   bun scripts/mcp-run.ts <steps file> [--log <file.jsonl>] [--images <dir outside the repo>] [--var name=value]…
//                          [--from N] [--to N] [--keep-going] [--dry] [--quiet] [--max-print chars] [--url] [--timeout s]
//
// Steps file — any of:
//   · a JSON array of steps, or JSONL (one step per line; blank lines and lines starting with // or # are skipped)
//   · a `plan` answer saved by mcp-call ({…, calls: [{tool, arguments, why}]}) — plan's calls run as they are
//   · a recorded calls.jsonl (recreations): {tool, args} per line; a step whose args were scrubbed in that log
//     ("<image/jpeg sha256=… len=…>") is refused — put @img:<path> back first
// A step: {tool, args | arguments, as?: "name", note?, until?: {path, equals? | in?: [...]}, max_tries?, expect_error?}
//
// Inside args (strings, recursively):
//   "$prev.timeline.timeline_id"  the previous answer's value at that path (any JSON type; [i] indexes arrays)
//   "$tl.timeline_id"             the answer of the step with as: "tl"        "$3.commit_id"  step 3's answer
//   "$var.name"                   a --var name=value                         "$$…"           a literal "$…"
//   "… ${prev.render_id} …"       the same, inside a longer string (stringified)
//   "@img:frames/a.jpg"           that image as a data: URL (jpg/png/webp/gif)
//   "@file:scene-1.html"          that file's text (a composition source, a long brief)
//   Paths are relative to the steps file's folder (or absolute).
// until: repeat the same call (a poll: render {render_id, wait_s}) until the answer's path equals / is in the values;
//   max_tries (default 20). Only for calls that are safe to repeat.
//
// Log: one JSON line per call (default <steps file>.log.jsonl beside it): {n, at, tool, as?, note?, args, ok, error?,
//   ms, tries?, images?, result} with data: URLs / base64 shown as "<mime sha256=16hex len=N>" and texts over 4,000
//   chars as {sha256, chars, head}. While a call is in flight `<log>.pending` names it: if the runner dies (a Bun crash
//   after the server committed: neon-grid-nitro REPORT §8), the next run says so — read timeline summary / history
//   before sending that step again. --from N reloads the answers of steps < N from the log for $refs.
//
// Exit: 0 every step ok · 1 a step failed (stopped there; --keep-going runs on) or a protocol error · 2 usage.
// Relation to the other runners: scripts/mcp-call.ts = one call by hand (this file copies its handshake);
// scripts/mcpx.py = the Python one-call logger of the warm-moody runs and scripts/render_wait.sh = its render poll
// (both moved into scripts/ by the revise-safety agent); here a step with `until` replaces render_wait.sh.
// Runbook: docs/restorff/worklog/timing-helper.md.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(REPO_ROOT, "apps", "web", ".env.local");
const DEFAULT_URL = "http://localhost:8791";
const CLIENT = { name: "restorffcut-mcp-run", version: "0.1.0" };
const PROTOCOL = "2025-11-25";
const LONG_TEXT = 4_000;
const MAX_LOGGED_RESULT = 60_000;

const USAGE = [
	"usage: bun scripts/mcp-run.ts <steps.json | steps.jsonl | plan-answer.json | calls.jsonl> [options]",
	"options: --log <file.jsonl> · --images <dir outside the repo> · --var name=value (repeat) · --from N · --to N",
	"         --keep-going · --dry (expand and print, send nothing) · --quiet · --max-print <chars> (default 3000)",
	"         --url <base> (default $RESTORFFCUT_URL or http://localhost:8791) · --timeout <seconds per call> (default 240)",
].join("\n");

interface Step {
	tool: string;
	args: Record<string, unknown>;
	as?: string;
	note?: string;
	until?: { path: string; equals?: unknown; in?: unknown[] };
	max_tries?: number;
	expect_error?: boolean;
}

interface Options {
	file: string;
	log: string;
	images?: string;
	vars: Record<string, string>;
	from: number;
	to: number;
	keepGoing: boolean;
	dry: boolean;
	quiet: boolean;
	maxPrint: number;
	url: string;
	timeoutS: number;
}

function die(message: string, code = 2): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function parseArgs(argv: string[]): Options {
	const positional: string[] = [];
	const vars: Record<string, string> = {};
	let log: string | undefined;
	let images: string | undefined;
	let from = 1;
	let to = Number.POSITIVE_INFINITY;
	let keepGoing = false;
	let dry = false;
	let quiet = false;
	let maxPrint = 3000;
	let url = process.env.RESTORFFCUT_URL || DEFAULT_URL;
	let timeoutS = 240;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => argv[++i] ?? die(`${arg} needs a value\n${USAGE}`);
		if (arg === "--log") log = value();
		else if (arg === "--images") images = value();
		else if (arg === "--var") {
			const pair = value();
			const at = pair.indexOf("=");
			if (at < 1) die(`--var needs name=value, got ${pair}`);
			vars[pair.slice(0, at)] = pair.slice(at + 1);
		} else if (arg === "--from") from = Number(value());
		else if (arg === "--to") to = Number(value());
		else if (arg === "--keep-going") keepGoing = true;
		else if (arg === "--dry") dry = true;
		else if (arg === "--quiet") quiet = true;
		else if (arg === "--max-print") maxPrint = Number(value());
		else if (arg === "--url") url = value();
		else if (arg === "--timeout") timeoutS = Number(value());
		else if (arg === "-h" || arg === "--help") die(USAGE, 0);
		else positional.push(arg);
	}
	if (positional.length !== 1) die(USAGE);
	const file = resolve(positional[0]);
	if (!existsSync(file)) die(`no such file: ${file}`);
	if (!(from >= 1) || !(to >= from)) die("--from / --to must be step numbers (1-based), from <= to");
	if (!(timeoutS > 0) || !(maxPrint >= 0)) die("--timeout and --max-print must be positive numbers");
	if (images) {
		const dir = resolve(images);
		const rel = relative(REPO_ROOT, dir);
		if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) die(`--images must be outside the repo (${REPO_ROOT}); got ${dir}`);
		images = dir;
	}
	const ext = extname(file);
	return {
		file,
		log: resolve(log ?? join(dirname(file), `${basename(file, ext)}.log.jsonl`)),
		images,
		vars,
		from,
		to,
		keepGoing,
		dry,
		quiet,
		maxPrint,
		url: url.replace(/\/+$/, ""),
		timeoutS,
	};
}

// ─── steps ──────────────────────────────────────────────────────────────────────────────────────────────────

function toStep(raw: unknown, where: string): Step {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) die(`${where}: a step must be an object {tool, args}`);
	const record = raw as Record<string, unknown>;
	const tool = record.tool;
	const args = (record.args ?? record.arguments ?? {}) as unknown;
	if (typeof tool !== "string" || !tool) die(`${where}: tool is missing`);
	if (!args || typeof args !== "object" || Array.isArray(args)) die(`${where}: args must be an object`);
	const until = record.until as Step["until"] | undefined;
	if (until && (typeof until !== "object" || typeof until.path !== "string")) die(`${where}: until needs {path, equals | in}`);
	return {
		tool,
		args: args as Record<string, unknown>,
		...(typeof record.as === "string" && record.as ? { as: record.as } : {}),
		...(typeof record.note === "string" ? { note: record.note } : typeof record.why === "string" ? { note: record.why } : {}),
		...(until ? { until } : {}),
		...(typeof record.max_tries === "number" ? { max_tries: record.max_tries } : {}),
		...(record.expect_error === true ? { expect_error: true } : {}),
	};
}

function readSteps(file: string): Step[] {
	const text = readFileSync(file, "utf8").replace(/^﻿/, "");
	const trimmed = text.trim();
	if (!trimmed) die(`${file} is empty`);
	if (trimmed.startsWith("[") || (trimmed.startsWith("{") && !trimmed.includes("\n{"))) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			if (trimmed.startsWith("[")) die(`${file}: not valid JSON: ${(error as Error).message}`);
			parsed = null;
		}
		if (Array.isArray(parsed)) return parsed.map((raw, i) => toStep(raw, `step ${i + 1}`));
		if (parsed && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			if (Array.isArray(record.calls)) return record.calls.map((raw, i) => toStep(raw, `calls[${i}]`));
			if (Array.isArray(record.steps)) return record.steps.map((raw, i) => toStep(raw, `steps[${i}]`));
			if (typeof record.tool === "string") return [toStep(record, "step 1")];
		}
	}
	const steps: Step[] = [];
	text.split(/\r?\n/).forEach((line, i) => {
		const t = line.trim();
		if (!t || t.startsWith("//") || t.startsWith("#")) return;
		let raw: unknown;
		try {
			raw = JSON.parse(t);
		} catch (error) {
			die(`${file}:${i + 1}: not valid JSON: ${(error as Error).message}`);
		}
		steps.push(toStep(raw, `${basename(file)}:${i + 1}`));
	});
	return steps;
}

// ─── substitution ───────────────────────────────────────────────────────────────────────────────────────────

const REF = /^\$(prev|var|\d+|[A-Za-z_][\w-]*)((?:\.[\w-]+|\[\d+\])*)$/;
const INLINE_REF = /\$\{(prev|var|\d+|[A-Za-z_][\w-]*)((?:\.[\w-]+|\[\d+\])*)\}/g;
const SCRUBBED = /^<[a-z]+\/[\w.+-]+ sha256=[0-9a-f]{8,} len=\d+>$/;
const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

class RefError extends Error {}

interface Context {
	results: Map<string, unknown>;
	vars: Record<string, string>;
	base: string;
	prevKey: string | null;
	/** --dry: leave $refs that need an answer as they are. */
	lenient: boolean;
}

function walk(value: unknown, path: string): unknown {
	let current = value;
	for (const part of path.match(/\.[\w-]+|\[\d+\]/g) ?? []) {
		if (current === null || current === undefined) return undefined;
		current = part.startsWith("[") ? (current as unknown[])[Number(part.slice(1, -1))] : (current as Record<string, unknown>)[part.slice(1)];
	}
	return current;
}

function lookup(name: string, path: string, ctx: Context, shown: string): unknown {
	if (name === "var") {
		const key = path.replace(/^\./, "");
		if (!(key in ctx.vars)) throw new RefError(`${shown}: no --var ${key}=…`);
		return ctx.vars[key];
	}
	const key = name === "prev" ? ctx.prevKey : name;
	if (!key || !ctx.results.has(key)) throw new RefError(`${shown}: ${name === "prev" ? "there is no answer before this step" : `no answer named or numbered "${name}" yet`}`);
	const found = walk(ctx.results.get(key), path);
	if (found === undefined) throw new RefError(`${shown}: the answer of "${key}" has nothing at ${path || "(root)"}`);
	return found;
}

function expand(value: unknown, ctx: Context): unknown {
	if (Array.isArray(value)) return value.map((item) => expand(item, ctx));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, expand(item, ctx)]));
	if (typeof value !== "string") return value;
	if (value.startsWith("$$")) return value.slice(1);
	if (SCRUBBED.test(value)) throw new RefError(`"${value}" was scrubbed in a log: put the file back as @img:<path>`);
	if (value.startsWith("@img:") || value.startsWith("@file:")) {
		const isImage = value.startsWith("@img:");
		const target = value.slice(isImage ? 5 : 6);
		const file = isAbsolute(target) ? target : resolve(ctx.base, target);
		if (!existsSync(file)) throw new RefError(`${value}: no such file ${file}`);
		if (!isImage) return readFileSync(file, "utf8");
		const mime = MIME[extname(file).toLowerCase()];
		if (!mime) throw new RefError(`${value}: not an image this runner knows (${Object.keys(MIME).join(" ")})`);
		return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
	}
	const whole = REF.exec(value);
	if (whole) {
		try {
			return lookup(whole[1], whole[2], ctx, value);
		} catch (error) {
			if (ctx.lenient && error instanceof RefError) return value;
			throw error;
		}
	}
	return value.replace(INLINE_REF, (match, name: string, path: string) => {
		try {
			const found = lookup(name, path, ctx, match);
			return typeof found === "string" ? found : JSON.stringify(found);
		} catch (error) {
			if (ctx.lenient && error instanceof RefError) return match;
			throw error;
		}
	});
}

// ─── scrubbing (log + screen) ────────────────────────────────────────────────────────────────────────────────

const sha16 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function scrub(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(scrub);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, scrub(item)]));
	if (typeof value !== "string") return value;
	const dataUrl = /^data:([\w/+.-]+);base64,/.exec(value);
	if (dataUrl) return `<${dataUrl[1]} sha256=${sha16(value)} len=${value.length}>`;
	if (value.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(value)) return `<base64 sha256=${sha16(value)} len=${value.length}>`;
	if (value.length > LONG_TEXT) return { sha256: sha16(value), chars: value.length, head: value.slice(0, 160) };
	return value;
}

// ─── the client (the same handshake as scripts/mcp-call.ts) ───────────────────────────────────────────────────

function serviceToken(): string | null {
	const fromEnv = process.env.RESTORFFCUT_SERVICE_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	if (!existsSync(ENV_FILE)) return null;
	for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
		const match = /^\s*RESTORFFCUT_SERVICE_TOKEN\s*=\s*(.*)\s*$/.exec(line);
		if (match) return match[1].replace(/^(['"])(.*)\1$/, "$2").trim() || null;
	}
	return null;
}

class SessionLost extends Error {}

class Client {
	private session: string | null = null;
	private protocol = PROTOCOL;
	private nextId = 1;
	constructor(
		private readonly endpoint: string,
		private readonly token: string | null,
		private readonly timeoutS: number,
	) {}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
		if (this.token) headers.authorization = `Bearer ${this.token}`;
		if (this.session) {
			headers["mcp-session-id"] = this.session;
			headers["mcp-protocol-version"] = this.protocol;
		}
		return headers;
	}

	private async post(message: Record<string, unknown>) {
		const response = await fetch(this.endpoint, { method: "POST", headers: this.headers(), body: JSON.stringify(message), signal: AbortSignal.timeout(this.timeoutS * 1000) });
		const text = await response.text();
		if (!text.trim()) return { status: response.status, headers: response.headers, body: null as null | Record<string, unknown> };
		const isSse = (response.headers.get("content-type") ?? "").includes("text/event-stream");
		const payload = isSse
			? (text
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.filter(Boolean)
					.pop() ?? "")
			: text;
		try {
			return { status: response.status, headers: response.headers, body: JSON.parse(payload) as Record<string, unknown> };
		} catch {
			throw new Error(`HTTP ${response.status}: not JSON: ${text.slice(0, 300)}`);
		}
	}

	async initialize(): Promise<void> {
		this.session = null;
		const reply = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } });
		const result = reply.body?.result as Record<string, unknown> | undefined;
		if (reply.status >= 400 || !result) throw new Error(`initialize: HTTP ${reply.status} ${JSON.stringify(reply.body ?? {}).slice(0, 200)}`);
		this.session = reply.headers.get("mcp-session-id");
		this.protocol = typeof result.protocolVersion === "string" ? result.protocolVersion : PROTOCOL;
		await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
	}

	/** tools/call; a lost session (404: the dev server reloaded) never reached a tool, so it is opened again once. */
	async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
		for (let attempt = 0; ; attempt++) {
			const reply = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } });
			if (reply.status === 404 && attempt === 0) {
				await this.initialize();
				continue;
			}
			if (reply.status === 404) throw new SessionLost("tools/call: session not found twice");
			const error = reply.body?.error as { code: number; message: string } | undefined;
			if (error) throw new Error(`tools/call: HTTP ${reply.status}, JSON-RPC error ${error.code}: ${error.message}`);
			const result = reply.body?.result as Record<string, unknown> | undefined;
			if (reply.status >= 400 || !result) throw new Error(`tools/call: HTTP ${reply.status} ${JSON.stringify(reply.body ?? {}).slice(0, 300)}`);
			// mcp-gaps-mvp (2026-10-24): a call still running at the server's 45 s answer deadline answers status
			// "working"; the same call again collects it (never runs twice). Follow it so a recorded step gets its result.
			if ((result.structuredContent as { status?: unknown } | undefined)?.status === "working" && attempt < 12) {
				process.stderr.write(`tools/call ${name}: working on the server · sending the same call again\n`);
				continue;
			}
			return result;
		}
	}

	async close(): Promise<void> {
		if (!this.session) return;
		try {
			await fetch(this.endpoint, { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(10_000) });
		} catch {
			// best effort
		}
		this.session = null;
	}
}

// ─── run ────────────────────────────────────────────────────────────────────────────────────────────────────

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

function saveImages(dir: string, n: number, tool: string, content: unknown): string[] {
	const items = Array.isArray(content) ? (content as Array<{ type?: string; data?: string; mimeType?: string }>) : [];
	const images = items.filter((item) => item.type === "image" && typeof item.data === "string");
	if (!images.length) return [];
	mkdirSync(dir, { recursive: true });
	return images.map((image, i) => {
		const file = join(dir, `${String(n).padStart(3, "0")}-${tool}-${String(i + 1).padStart(2, "0")}.${EXT[image.mimeType ?? ""] ?? "bin"}`);
		writeFileSync(file, Buffer.from(image.data as string, "base64"));
		return file;
	});
}

/** Answers of earlier steps from a previous log (for --from N): ids survive the scrub. */
function preload(log: string, before: number, results: Map<string, unknown>): string | null {
	if (!existsSync(log)) return null;
	let last: string | null = null;
	for (const line of readFileSync(log, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { n?: number; as?: string; result?: unknown };
			if (typeof entry.n !== "number" || entry.n >= before) continue;
			results.set(String(entry.n), entry.result);
			if (entry.as) results.set(entry.as, entry.result);
			last = String(entry.n);
		} catch {
			// a torn line: skip
		}
	}
	return last;
}

function matches(result: unknown, until: NonNullable<Step["until"]>): boolean {
	const found = walk(result, until.path.startsWith(".") || until.path.startsWith("[") ? until.path : `.${until.path}`);
	if (Array.isArray(until.in)) return until.in.some((value) => JSON.stringify(value) === JSON.stringify(found));
	return JSON.stringify(found) === JSON.stringify(until.equals);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const steps = readSteps(options.file);
	const base = dirname(options.file);
	const pending = `${options.log}.pending`;
	if (existsSync(pending)) {
		process.stderr.write(`WARNING: ${pending} says a call was in flight when the last run died:\n  ${readFileSync(pending, "utf8").trim()}\n  It may have committed: read timeline summary / history before sending that step again.\n`);
	}
	const results = new Map<string, unknown>();
	let prevKey = options.from > 1 ? preload(options.log, options.from, results) : null;
	if (options.from > 1) process.stderr.write(`from step ${options.from}: ${results.size ? `answers of earlier steps loaded from ${options.log}` : "no earlier answers in the log ($refs to them will fail)"}\n`);
	const last = Math.min(options.to, steps.length);
	if (options.from > steps.length) die(`--from ${options.from}: the file has ${steps.length} steps`);
	const client = options.dry ? null : new Client(`${options.url}/api/mcp`, serviceToken(), options.timeoutS);
	let exitCode = 0;
	try {
		if (client) await client.initialize();
		if (!options.dry) mkdirSync(dirname(options.log), { recursive: true });
		process.stderr.write(`mcp-run: ${steps.length} steps in ${options.file} · running ${options.from}–${last}${options.dry ? " (dry: nothing sent)" : ` · log ${options.log}`}\n`);
		for (let n = options.from; n <= last; n++) {
			const step = steps[n - 1];
			let args: Record<string, unknown>;
			try {
				args = expand(step.args, { results, vars: options.vars, base, prevKey, lenient: options.dry }) as Record<string, unknown>;
			} catch (error) {
				process.stderr.write(`#${n} ${step.tool}: ${(error as Error).message} — not sent\n`);
				exitCode = 1;
				if (options.keepGoing) continue;
				break;
			}
			if (options.dry) {
				process.stdout.write(`#${n} ${step.tool}${step.as ? ` as ${step.as}` : ""}${step.note ? ` · ${step.note}` : ""}\n${JSON.stringify(scrub(args), null, 2).slice(0, options.maxPrint || undefined)}\n`);
				continue;
			}
			const started = Date.now();
			let result: Record<string, unknown> = {};
			let tries = 0;
			let failure: string | null = null;
			writeFileSync(pending, `${JSON.stringify({ n, tool: step.tool, at: new Date().toISOString(), args: scrub(args) })}\n`);
			try {
				const maxTries = step.until ? Math.max(1, step.max_tries ?? 20) : 1;
				for (;;) {
					tries++;
					result = await (client as Client).call(step.tool, args);
					if (!step.until || result.isError === true || matches(result.structuredContent ?? result, step.until) || tries >= maxTries) break;
					if (!options.quiet) process.stderr.write(`#${n} ${step.tool}: try ${tries}: ${step.until.path} = ${JSON.stringify(walk(result.structuredContent, `.${step.until.path}`))}\n`);
				}
				if (step.until && !matches(result.structuredContent ?? result, step.until) && result.isError !== true) failure = `${step.until.path} never reached ${JSON.stringify(step.until.equals ?? step.until.in)} in ${tries} tries`;
			} catch (error) {
				failure = (error as Error).message;
			} finally {
				rmSync(pending, { force: true });
			}
			const ms = Date.now() - started;
			const answer = (result.structuredContent ?? result.content ?? null) as unknown;
			const isError = result.isError === true;
			const ok = !failure && (isError ? step.expect_error === true : step.expect_error !== true);
			const images = options.images ? saveImages(options.images, n, step.tool, result.content) : [];
			const imageCount = (Array.isArray(result.content) ? result.content : []).filter((item: { type?: string }) => item?.type === "image").length;
			results.set(String(n), answer);
			if (step.as) results.set(step.as, answer);
			prevKey = String(n);
			const loggedResult = scrub(answer);
			const resultText = JSON.stringify(loggedResult);
			appendFileSync(
				options.log,
				`${JSON.stringify({
					n,
					at: new Date().toISOString(),
					tool: step.tool,
					...(step.as ? { as: step.as } : {}),
					...(step.note ? { note: step.note } : {}),
					args: scrub(args),
					ok,
					...(isError ? { is_error: true } : {}),
					...(failure ? { error: failure } : {}),
					ms,
					...(tries > 1 ? { tries } : {}),
					...(imageCount ? { images: images.length ? images : imageCount } : {}),
					result: resultText.length > MAX_LOGGED_RESULT ? { omitted: "result too long for the log", sha256: sha16(resultText), chars: resultText.length, head: resultText.slice(0, 2000) } : loggedResult,
				})}\n`,
			);
			const status = failure ? `FAILED (${failure})` : isError ? (ok ? "isError (expected)" : "isError") : ok ? "ok" : "ok but expected an error";
			process.stdout.write(`#${n} ${step.tool}${step.as ? ` as ${step.as}` : ""} · ${status} · ${ms} ms${tries > 1 ? ` · ${tries} tries` : ""}${imageCount ? ` · images ${images.length ? images.join(", ") : `${imageCount} (pass --images <dir> to save)`}` : ""}\n`);
			if (!options.quiet && options.maxPrint > 0) process.stdout.write(`${resultText.slice(0, options.maxPrint)}${resultText.length > options.maxPrint ? ` …(+${resultText.length - options.maxPrint} chars in the log)` : ""}\n`);
			if (!ok) {
				exitCode = 1;
				if (!options.keepGoing) {
					process.stderr.write(`stopped at step ${n}: fix it, then run again with --from ${n} (earlier answers reload from the log)\n`);
					break;
				}
			}
		}
	} catch (error) {
		process.stderr.write(`mcp-run: ${(error as Error).message}\n`);
		exitCode = 1;
	} finally {
		await client?.close();
	}
	process.exit(exitCode);
}

await main();
