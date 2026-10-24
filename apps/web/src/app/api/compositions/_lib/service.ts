/**
 * Server side of the compositions drop (runbook: docs/restorff/worklog/compose.md).
 *
 * The routes never import @restorffcut/compositions: they run its CLI as a child process
 * (`<node> packages/compositions/src/cli.ts api <verb>`, JSON on stdin → JSON on stdout). Why: the renderer drives
 * Chromium and FFmpeg, finds its fonts and runtime through import.meta.url, and a crashed render must not take the
 * web server down. Node 24 runs the package's .ts files directly (type stripping), so nothing is built.
 *
 * Paths live here and only here:
 *   RESTORFFCUT_COMPOSITIONS_DIR    the package folder        (default <apps/web>/../../packages/compositions)
 *   RESTORFFCUT_COMPOSITIONS_CACHE  where renders are cached  (default <package>/out/editor-cache, git-ignored)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveMediaProps } from "@/server/composition-media";

export const COMPOSITIONS_DIR = resolve(
	process.env.RESTORFFCUT_COMPOSITIONS_DIR ??
		join(process.cwd(), "..", "..", "packages", "compositions"),
);
export const CACHE_DIR = resolve(
	process.env.RESTORFFCUT_COMPOSITIONS_CACHE ??
		join(COMPOSITIONS_DIR, "out", "editor-cache"),
);
export const SAMPLES_DIR = join(COMPOSITIONS_DIR, "samples");
/** Custom compositions (code written in the editor or by Claude over MCP) cache apart: <cache>/custom/<hash>.webm. */
export const CUSTOM_CACHE_DIR = join(CACHE_DIR, "custom");
const CLI = join(COMPOSITIONS_DIR, "src", "cli.ts");

export type ServiceVerb =
	| "catalogue"
	| "render"
	| "nudge"
	| "custom-validate"
	| "custom-render"
	| "custom-nudge"
	| "custom-kit"
	| "custom-examples"
	| "custom-contract"
	// composition-v3: the timeline kit over MCP
	| "kit-validate"
	| "library-kit"
	| "library-kits";

/** A render can take a while (≈1 s per output second on the dev PC); give up after this. */
const TIMEOUT_MS = 240_000;

export class ServiceError extends Error {
	constructor(
		message: string,
		readonly status: number,
		/** Structured detail from the package (custom compositions: `{ errors, warnings }`). */
		readonly details?: unknown,
	) {
		super(message);
	}
}

/** Verbs whose `props` may name the timeline's media (resolved to data: images first — server/composition-media.ts). */
const MEDIA_VERBS = new Set<ServiceVerb>(["render", "custom-render", "custom-validate"]);

/**
 * Run one service verb in a child process and return its `result` (throws ServiceError with the package's message).
 * mcp-gaps-mvp (2026-10-24): inside an MCP tool call, image props that name a media id of the call's timeline (or
 * `media:<id>`, or this server's media URL) are turned into data: images here, so the network-blocked render never
 * reads a path from the caller; a reference that can't be used is a 422 naming the param.
 */
export async function callService<T>({
	verb,
	request,
}: {
	verb: ServiceVerb;
	request?: unknown;
}): Promise<T> {
	if (MEDIA_VERBS.has(verb) && request && typeof request === "object" && (request as { props?: unknown }).props) {
		const resolved = await resolveMediaProps((request as { props: unknown }).props);
		if (resolved.problems.length) {
			throw new ServiceError(`media in the params can't be used:\n  - ${resolved.problems.map((problem) => `${problem.path}: ${problem.message}`).join("\n  - ")}`, 422, { errors: resolved.problems.map((problem) => `${problem.path}: ${problem.message}`) });
		}
		if (resolved.resolved) request = { ...(request as Record<string, unknown>), props: resolved.props };
	}
	return runService<T>(verb, request);
}

function runService<T>(verb: ServiceVerb, request?: unknown): Promise<T> {
	if (!existsSync(CLI)) {
		return Promise.reject(
			new ServiceError(
				`compositions package not found at ${COMPOSITIONS_DIR} (set RESTORFFCUT_COMPOSITIONS_DIR)`,
				500,
			),
		);
	}
	return new Promise<T>((resolvePromise, reject) => {
		const child = spawn(process.execPath, [CLI, "api", verb], {
			cwd: COMPOSITIONS_DIR,
			env: { ...process.env, RESTORFFCUT_COMPOSITIONS_CACHE: CACHE_DIR },
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new ServiceError(`compositions ${verb} timed out after ${TIMEOUT_MS / 1000} s`, 504));
		}, TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(new ServiceError(`could not start the compositions service: ${error.message}`, 500));
		});
		child.on("close", () => {
			clearTimeout(timer);
			const line = out.trim().split("\n").pop() ?? "";
			try {
				const parsed = JSON.parse(line) as { ok: boolean; result?: T; error?: string; details?: unknown };
				if (parsed.ok) resolvePromise(parsed.result as T);
				else reject(new ServiceError(parsed.error ?? "compositions service failed", 422, parsed.details));
			} catch {
				reject(
					new ServiceError(
						`compositions service gave no answer${err ? `: ${err.trim().slice(-600)}` : ""}`,
						500,
					),
				);
			}
		});
		child.stdin.end(JSON.stringify(request ?? {}));
	});
}

export function errorResponse(error: unknown): Response {
	const status = error instanceof ServiceError ? error.status : 500;
	const message = error instanceof Error ? error.message : String(error);
	const details = error instanceof ServiceError ? error.details : undefined;
	return Response.json(details ? { error: message, report: details } : { error: message }, { status });
}

/** Stream a file from disk with a content type; 404 when missing. */
export async function fileResponse({
	path,
	contentType,
	immutable,
}: {
	path: string;
	contentType: string;
	immutable: boolean;
}): Promise<Response> {
	if (!existsSync(path)) return Response.json({ error: "not found" }, { status: 404 });
	const bytes = await readFile(path);
	return new Response(new Uint8Array(bytes), {
		headers: {
			"content-type": contentType,
			"content-length": String(bytes.byteLength),
			"cache-control": immutable
				? "public, max-age=31536000, immutable"
				: "no-cache",
		},
	});
}
