/**
 * Custom compositions on the server (motion-code agent, 2026-10-20): HTML/CSS/JS written in the editor's Code view or
 * by Claude over MCP → validated → rendered by the package with the network blocked → cached by hash. Used by the
 * /api/compositions/custom routes and by the MCP `composition` tool (src/mcp/composition.ts).
 * Runbook: packages/compositions/README.md "Custom compositions"; worklog docs/restorff/worklog/motion-code.md.
 */
import { join } from "node:path";
import { callService, CUSTOM_CACHE_DIR, ServiceError } from "./service";

export interface CustomReport {
	errors: string[];
	warnings: string[];
	protocol: "rc" | "hf" | null;
	sourceBytes: number;
	network: "blocked";
	blocked: string[];
}

/** What the package answers (`api custom-render`). `file` is a server path: never send it to a page. */
export interface CustomRenderServiceAnswer {
	hash: string;
	file: string;
	cached: boolean;
	name: string;
	title: string;
	duration: number;
	width: number;
	height: number;
	fps: number;
	frames: number;
	bytes: number;
	params: Record<string, unknown>;
	ms: number;
	report: CustomReport;
	/** composition-v3: the source included the kit; the kit HTML's sha and where it came from (sent / library:<name>). */
	kit?: boolean;
	kitSha?: string;
	kitFrom?: string | null;
}

export interface CustomValidateAnswer {
	ok: boolean;
	errors: string[];
	warnings: string[];
	manifest: {
		name: string;
		title: string;
		description: string;
		duration: number;
		size: [number, number];
		fps: number;
		params: Record<string, unknown>;
	} | null;
	values: Record<string, unknown>;
	protocol: "rc" | "hf" | null;
	bytes: number;
}

export interface CustomRenderInput {
	source: string;
	props?: Record<string, unknown>;
	duration_s?: number;
	width?: number;
	height?: number;
	fps?: number;
	/** The timeline kit, for a source with `<!-- rc-kit -->` (composition-v3; packages/compositions CONTRACT §9c). */
	kit?: string | { css?: string; js?: string; html?: string };
}

const HASH_RE = /^[a-f0-9]{64}$/;

export function customFileUrl(hash: string): string {
	return `/api/compositions/custom/${hash}`;
}

export function customFilePath(hash: string): string {
	if (!HASH_RE.test(hash)) throw new ServiceError("bad hash", 400);
	return join(CUSTOM_CACHE_DIR, `${hash}.webm`);
}

/** Basic shape checks before spawning anything (the package validates the source itself). */
export function readCustomInput(body: unknown): CustomRenderInput {
	if (!body || typeof body !== "object") throw new ServiceError("body must be JSON: {source, props?, duration_s?, width?, height?, fps?}", 400);
	const b = body as Record<string, unknown>;
	if (typeof b.source !== "string" || !b.source.trim()) throw new ServiceError("source is required: the composition's HTML", 400);
	if (b.source.length > 300_000) throw new ServiceError("source is too large (the limit is 256 KB)", 413);
	if (b.props !== undefined && (b.props === null || typeof b.props !== "object" || Array.isArray(b.props))) {
		throw new ServiceError("props must be a JSON object", 400);
	}
	const num = (key: string) => {
		const value = b[key];
		if (value === undefined || value === null) return undefined;
		if (typeof value !== "number" || !Number.isFinite(value)) throw new ServiceError(`${key} must be a number`, 400);
		return value;
	};
	return {
		source: b.source,
		props: (b.props as Record<string, unknown> | undefined) ?? {},
		duration_s: num("duration_s") ?? num("duration"),
		width: num("width"),
		height: num("height"),
		fps: num("fps"),
	};
}

/** Validate + render (cached). Throws ServiceError 422 with `details = {errors, warnings}` when refused. */
export function renderCustomComposition(input: CustomRenderInput): Promise<CustomRenderServiceAnswer> {
	return callService<CustomRenderServiceAnswer>({ verb: "custom-render", request: input });
}

export function validateCustomComposition(input: { source: string; props?: Record<string, unknown> }): Promise<CustomValidateAnswer> {
	return callService<CustomValidateAnswer>({ verb: "custom-validate", request: input });
}

/** The page-safe answer: the server path replaced by the URL the video is served at. */
export function publicAnswer(answer: CustomRenderServiceAnswer) {
	const { file: _file, ...rest } = answer;
	return { ...rest, url: customFileUrl(answer.hash) };
}
