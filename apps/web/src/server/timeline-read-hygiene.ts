/**
 * Result hygiene for every MCP answer (mcp-discover, wave 5, 2026-10-20; recreations SUMMARY gaps 10 + 18a).
 *
 * 1. `scrubData` — `data:` URLs and long base64 never travel back to the model. A whole-value data URL becomes
 *    `{omitted: "data URL", mime, sha256, chars}`; one inside a longer string becomes
 *    `data:<mime>;base64,[omitted: sha256 <16 hex>, <n> chars]`. Why: the effects-library recreation's Orbit apply
 *    echoed ~74 KB of image data URLs, crossed the 75,000-char cap and answered `result_too_large` although it HAD
 *    committed — a model would have applied it twice. Strings under a key named `source` (composition code the model
 *    reads back and edits) keep their inline data URLs, so a get → update round trip never loses an image.
 * 2. `secondsInText` — the reducer writes its change summaries and conflicts in ticks ("video … at 0 ticks for
 *    6441600 on …", "[1020000, 1972000) ticks overlaps element …"). Results speak seconds; ticks appear only in fields
 *    named `*_ticks`. Rewrites the reducer's own message templates (packages/timeline-ops/src/reducer.ts) to seconds.
 *
 * Pure (node:crypto only). Tests: server/__tests__/mcp-discover.test.ts.
 */
import { createHash } from "node:crypto";

export const TICKS_PER_SECOND = 120_000;

/** Exact seconds for a tick count: 6 decimals give back every tick (|error| ≤ 0.06 tick), unlike ms rounding. */
export function exactSeconds(ticks: number): number {
	const seconds = Math.round((ticks * 25) / 3) / 1_000_000;
	return Object.is(seconds, -0) ? 0 : seconds;
}

export interface OmittedData {
	path: string;
	kind: "data URL" | "base64";
	mime: string | null;
	sha256: string;
	chars: number;
}

export interface ScrubResult<T> {
	value: T;
	omitted: OmittedData[];
}

/** A whole string that is a data URL (any length over this is stripped). */
const MIN_DATA_URL_CHARS = 120;
/** A data URL inside a longer string, with at least this much payload. */
const INLINE_DATA_URL = /data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?((?:;[a-z0-9.+-]+=[^;,"'\s)]*)*)(;base64)?,[A-Za-z0-9+/=%._~-]{200,}/gi;
const WHOLE_DATA_URL = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?((?:;[a-z0-9.+-]+=[^;,]*)*)(;base64)?,/i;
/** Bare base64 (no spaces) this long is a file, not text. */
const LONG_BASE64 = /^[A-Za-z0-9+/_-]{1500,}={0,2}$/;
/** Keys whose strings are code the model edits and sends back: inline data URLs stay. */
const KEEP_INLINE_KEYS = new Set(["source"]);

const sha16 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export function scrubData<T>(input: T): ScrubResult<T> {
	const omitted: OmittedData[] = [];
	const walk = (value: unknown, path: string, key: string, depth: number): unknown => {
		if (typeof value === "string") return scrubString(value, path, key, omitted);
		if (depth > 64 || value === null || typeof value !== "object") return value;
		if (Array.isArray(value)) {
			let changed = false;
			const out = value.map((item, index) => {
				const next = walk(item, `${path}[${index}]`, key, depth + 1);
				if (next !== item) changed = true;
				return next;
			});
			return changed ? out : value;
		}
		let changed = false;
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const next = walk(v, path ? `${path}.${k}` : k, k, depth + 1);
			if (next !== v) changed = true;
			out[k] = next;
		}
		return changed ? out : value;
	};
	return { value: walk(input, "", "", 0) as T, omitted };
}

function scrubString(text: string, path: string, key: string, omitted: OmittedData[]): unknown {
	if (text.length < MIN_DATA_URL_CHARS) return text;
	const whole = WHOLE_DATA_URL.exec(text);
	if (whole && text.indexOf(",") === whole[0].length - 1 && !/\s/.test(text.slice(whole[0].length, whole[0].length + 400))) {
		const entry: OmittedData = { path, kind: "data URL", mime: whole[1]?.toLowerCase() ?? null, sha256: sha16(text), chars: text.length };
		omitted.push(entry);
		return { omitted: entry.kind, mime: entry.mime, sha256: entry.sha256, chars: entry.chars };
	}
	if (LONG_BASE64.test(text)) {
		const entry: OmittedData = { path, kind: "base64", mime: null, sha256: sha16(text), chars: text.length };
		omitted.push(entry);
		return { omitted: entry.kind, sha256: entry.sha256, chars: entry.chars };
	}
	if (KEEP_INLINE_KEYS.has(key) || !text.includes("data:")) return text;
	let replaced = false;
	const out = text.replace(INLINE_DATA_URL, (match: string, mime: string | undefined, _params: string, b64: string | undefined) => {
		replaced = true;
		const entry: OmittedData = { path, kind: "data URL", mime: mime?.toLowerCase() ?? null, sha256: sha16(match), chars: match.length };
		omitted.push(entry);
		return `data:${mime ?? ""}${b64 ?? ""},[omitted: sha256 ${entry.sha256}, ${entry.chars} chars]`;
	});
	return replaced ? out : text;
}

// ─── ticks → seconds in the reducer's messages ─────────────────────────────────────────────────────────────────

const s = (ticks: string) => `${exactSeconds(Number(ticks))} s`;
const n = (ticks: string) => `${exactSeconds(Number(ticks))}`;

/** The reducer's templates (reducer.ts change summaries + conflicts), most specific first. */
const TEMPLATES: Array<[RegExp, (...groups: string[]) => string]> = [
	[/\[(-?\d+), (-?\d+)\) ticks overlaps element (\S+) \[(-?\d+), (-?\d+)\)/g, (a, b, id, c, d) => `[${n(a)}, ${n(b)}) s overlaps element ${id} [${n(c)}, ${n(d)}) s`],
	[/at (-?\d+) ticks for (-?\d+) on/g, (a, b) => `at ${s(a)} for ${s(b)} on`],
	[/trimmed to source \[(-?\d+), (-?\d+)\) ticks, now (-?\d+)\+(-?\d+)/g, (a, b, c, d) => `trimmed to source [${n(a)}, ${n(b)}) s, now at ${s(c)} for ${s(d)}`],
	[/out (-?\d+) ticks is past the media length (-?\d+)/g, (a, b) => `out ${s(a)} is past the media length ${s(b)}`],
	[/out \((-?\d+)\) must be after in \((-?\d+)\) ticks/g, (a, b) => `out (${s(a)}) must be after in (${s(b)})`],
	[/ends at (-?\d+) ticks but (\S+) starts at (-?\d+):/g, (a, id, b) => `ends at ${s(a)} but ${id} starts at ${s(b)}:`],
	[/closed a (-?\d+)-tick gap/g, (a) => `closed a ${s(a)} gap`],
	[/0–(-?\d+) ticks\)/g, (a) => `0–${s(a)})`],
	[/\((-?\d+) ticks each\)/g, (a) => `(${s(a)} each)`],
];

/** Any other "<n> ticks" with n = 0 or ≥ 1000 (a small count like "3 ticks" in prose is left alone). */
const GENERIC = /(^|[^\w.])(-?\d+) ticks\b/g;

export function secondsInText(text: string): string {
	if (!text.includes("tick")) return text;
	let out = text;
	for (const [pattern, to] of TEMPLATES) out = out.replace(pattern, (_match, ...groups: string[]) => to(...groups));
	out = out.replace(GENERIC, (match, lead: string, value: string) => {
		const ticks = Number(value);
		return ticks === 0 || Math.abs(ticks) >= 1000 ? `${lead}${s(value)}` : match;
	});
	return out;
}

/** secondsInText on every string of a payload, except fields named *_ticks and code (`source`). */
export function secondsEverywhere<T>(input: T): T {
	const walk = (value: unknown, key: string, depth: number): unknown => {
		if (typeof value === "string") return key.endsWith("_ticks") || key === "source" ? value : secondsInText(value);
		if (depth > 64 || value === null || typeof value !== "object") return value;
		if (Array.isArray(value)) {
			let changed = false;
			const out = value.map((item) => {
				const next = walk(item, key, depth + 1);
				if (next !== item) changed = true;
				return next;
			});
			return changed ? out : value;
		}
		let changed = false;
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const next = walk(v, k, depth + 1);
			if (next !== v) changed = true;
			out[k] = next;
		}
		return changed ? out : value;
	};
	return walk(input, "", 0) as T;
}
