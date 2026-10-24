/**
 * No server filesystem path in an MCP answer (mcp-gaps-mvp, 2026-10-24; worklog mcp-gaps-mvp.md, gap 2).
 *
 * The MVP test's client read `cards[0].image: image not found: C:\data\code\overkill\restorff-apps\restorffcut\
 * packages\compositions\compositions\orbit\b1cc6697-…` — the server's repo layout, in a tool error. Every MCP result
 * (errors included) now passes through `scrubServerPaths` (protocol.ts render): an absolute path — Windows `C:\…` /
 * `C:/…`, UNC `\\host\share\…`, `file://` URLs, POSIX paths under the usual system roots (/home, /Users, /tmp, /var,
 * /opt, /srv, /root, /mnt, /private, /app, /data, /usr, /etc, /workspace, /run) — becomes `<server path>` (+ `/name.ext`
 * when the last part is a file name, so "master.mp4" still reads as a file). URL paths (`/api/renders/…`,
 * `http://host/data/…`) are left alone.
 *
 * Paths the caller itself sent in the call's arguments are not the server's to hide (a local-dev `path_hint`, a
 * `references add {path}` echo): any path found in the arguments' strings is kept as written. Pure; no I/O.
 */

/** Windows drive paths: middle segments may hold spaces ("Program Files"), the last one may not. */
const WINDOWS = String.raw`(?<![A-Za-z0-9+.-])[A-Za-z]:(?:[\\/]+[^\\/"'<>|*?:\r\n\t]+(?=[\\/]))*[\\/]+[^\\/\s"'<>|*?:,;()\[\]{}]*`;
const UNC = String.raw`(?:\\\\|\\\\\\\\)[A-Za-z0-9._$-]+(?:[\\/]+[^\\/\s"'<>|*?:,;()\[\]{}]+)+`;
const FILE_URL = String.raw`file:\/\/[^\s"'<>]*`;
const POSIX = String.raw`(?<![\w/:.~-])\/(?:home|Users|tmp|var|opt|srv|root|mnt|private|app|data|usr|etc|workspace|run)\/[^\s"'<>|*?:,;()\[\]{}]*`;
const PATH_RE = new RegExp(`${FILE_URL}|${UNC}|${WINDOWS}|${POSIX}`, "g");

export const SERVER_PATH = "<server path>";

/** Lower-case, forward slashes, no trailing slash, no file:// — how two spellings of one path compare. */
export function normalisePath(p: string): string {
	let s = p.trim();
	if (/^file:/i.test(s)) {
		s = s.replace(/^file:\/*/i, "");
		try {
			s = decodeURIComponent(s);
		} catch {
			// keep it as is
		}
		if (!/^[A-Za-z]:/.test(s)) s = `/${s}`;
	}
	return s.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
}

/** Every path-looking substring of `text`. */
export function findPaths(text: string): string[] {
	return text.match(PATH_RE) ?? [];
}

/** The paths inside the caller's own arguments (any depth): these may come back as written. */
export function pathsIn(value: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
	if (depth > 12) return out;
	if (typeof value === "string") {
		if (value.length <= 4096) for (const p of findPaths(value)) out.add(normalisePath(p));
		return out;
	}
	if (Array.isArray(value)) {
		for (const item of value.slice(0, 2000)) pathsIn(item, out, depth + 1);
		return out;
	}
	if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) pathsIn(item, out, depth + 1);
	return out;
}

function replacement(p: string): string {
	const last = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
	return /^[^.\s]+\.[A-Za-z0-9]{1,5}$/.test(last) && !/^[A-Za-z]:$/.test(last) ? `${SERVER_PATH}/${last}` : SERVER_PATH;
}

/** One string with its server paths replaced. */
export function scrubText(text: string, allowed: Set<string> = new Set()): { text: string; count: number } {
	let count = 0;
	const out = text.replace(PATH_RE, (match) => {
		// a trailing sentence dot is not part of the path
		const trail = /[.]+$/.exec(match)?.[0] ?? "";
		const p = trail ? match.slice(0, -trail.length) : match;
		if (!p || allowed.has(normalisePath(p))) return match;
		count++;
		return `${replacement(p)}${trail}`;
	});
	return { text: out, count };
}

/** A JSON value with every server path in its strings (and keys) replaced; `count` = how many. */
export function scrubServerPaths<T>(value: T, allowed: Set<string> = new Set()): { value: T; count: number } {
	let count = 0;
	const walk = (v: unknown, depth: number): unknown => {
		if (typeof v === "string") {
			if (!/[\\/]/.test(v)) return v;
			const r = scrubText(v, allowed);
			count += r.count;
			return r.text;
		}
		if (depth > 40 || v === null || typeof v !== "object") return v;
		if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
		const o: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(v as Record<string, unknown>)) o[key] = walk(item, depth + 1);
		return o;
	};
	const scrubbed = walk(value, 0) as T;
	return { value: scrubbed, count };
}
