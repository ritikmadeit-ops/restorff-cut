/**
 * Saved styles (EDT-20) on the server and in the browser: the pure merge both sides use (mcp-review agent,
 * 2026-10-20). No imports from node or the DOM: the browser store (styles-lab/store.ts) and the server store
 * (./styles-store.ts) both run it.
 *
 * Rules (a library = @restorffcut/styles StyleLibrary: current style per id + older versions + dismissed patterns):
 *   - a style only one side has is added, with its older versions;
 *   - both have it: the higher semver wins; the loser's version is kept as an older version (nothing is lost);
 *     same version, different content: the later `updated_at` wins;
 *   - `deleted` ids (server tombstones) drop a style unless that side saved it after the delete;
 *   - dismissed patterns are unioned.
 * History (the instructions repeat detection counts) is merged by (time, sentence) and capped.
 */
import type { InstructionRecord, SavedStyle, StyleLibrary } from "@restorffcut/styles";

export const STYLE_LIBRARY_FORMAT_ID = "restorffcut-styles@1";
export const HISTORY_CAP = 150;

/** -1 · 0 · 1; anything that is not x.y.z counts as 0.0.0. */
export function compareSemver(a: string | undefined, b: string | undefined): number {
	const parse = (v: string | undefined) => (/^\d+\.\d+\.\d+$/.test(v ?? "") ? (v as string).split(".").map(Number) : [0, 0, 0]);
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) {
		if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
	}
	return 0;
}

function emptyLib(): StyleLibrary {
	return { format: STYLE_LIBRARY_FORMAT_ID as StyleLibrary["format"], styles: {}, versions: {}, dismissed: [] };
}

/** Accepts anything shaped like a library (or null) and returns a well-formed one. */
export function normaliseLibrary(value: unknown): StyleLibrary {
	const v = (value ?? {}) as Partial<StyleLibrary>;
	return {
		format: STYLE_LIBRARY_FORMAT_ID as StyleLibrary["format"],
		styles: v.styles && typeof v.styles === "object" && !Array.isArray(v.styles) ? { ...v.styles } : {},
		versions: v.versions && typeof v.versions === "object" && !Array.isArray(v.versions) ? { ...v.versions } : {},
		dismissed: Array.isArray(v.dismissed) ? v.dismissed.filter((p): p is string => typeof p === "string") : [],
	};
}

function sameStyle(a: SavedStyle, b: SavedStyle): boolean {
	return a.version === b.version && JSON.stringify(a) === JSON.stringify(b);
}

/** Older versions of one id: deduped by version, oldest first, never including `current`'s version. */
function mergeVersions(current: SavedStyle, ...lists: Array<readonly SavedStyle[] | undefined>): SavedStyle[] {
	const byVersion = new Map<string, SavedStyle>();
	for (const list of lists) {
		for (const style of list ?? []) {
			if (!style || typeof style !== "object" || style.version === current.version) continue;
			const seen = byVersion.get(style.version);
			if (!seen || (style.updated_at ?? "") > (seen.updated_at ?? "")) byVersion.set(style.version, style);
		}
	}
	return [...byVersion.values()].sort((a, b) => compareSemver(a.version, b.version));
}

export interface MergeResult {
	library: StyleLibrary;
	/** Ids whose current style came from `incoming`. */
	taken: string[];
	/** Ids `incoming` had that were dropped by a tombstone. */
	dropped: string[];
}

/**
 * Merge `incoming` into `base`. `deleted` = id → ISO time it was deleted (server tombstones); a style saved after
 * its delete (updated_at later) comes back.
 */
export function mergeLibraries(baseValue: unknown, incomingValue: unknown, deleted: Record<string, string> = {}): MergeResult {
	const base = normaliseLibrary(baseValue);
	const incoming = normaliseLibrary(incomingValue);
	const out: StyleLibrary = { ...emptyLib(), styles: { ...base.styles }, versions: { ...base.versions }, dismissed: [...base.dismissed] };
	const taken: string[] = [];
	const dropped: string[] = [];
	for (const [id, style] of Object.entries(incoming.styles)) {
		if (!style || typeof style !== "object") continue;
		const deletedAt = deleted[id];
		if (deletedAt && (style.updated_at ?? "") <= deletedAt) {
			dropped.push(id);
			continue;
		}
		const current = out.styles[id];
		if (!current) {
			out.styles[id] = style;
			out.versions[id] = mergeVersions(style, incoming.versions[id], base.versions[id]);
			if (!out.versions[id].length) delete out.versions[id];
			taken.push(id);
			continue;
		}
		if (sameStyle(current, style)) {
			const versions = mergeVersions(current, base.versions[id], incoming.versions[id]);
			if (versions.length) out.versions[id] = versions;
			continue;
		}
		const order = compareSemver(style.version, current.version);
		const incomingWins = order > 0 || (order === 0 && (style.updated_at ?? "") > (current.updated_at ?? ""));
		const winner = incomingWins ? style : current;
		const loser = incomingWins ? current : style;
		out.styles[id] = winner;
		const versions = mergeVersions(winner, base.versions[id], incoming.versions[id], order === 0 ? [] : [loser]);
		if (versions.length) out.versions[id] = versions;
		else delete out.versions[id];
		if (incomingWins) taken.push(id);
	}
	for (const id of Object.keys(deleted)) {
		const style = out.styles[id];
		if (style && (style.updated_at ?? "") <= (deleted[id] ?? "")) {
			delete out.styles[id];
			delete out.versions[id];
		}
	}
	for (const pattern of incoming.dismissed) if (!out.dismissed.includes(pattern)) out.dismissed.push(pattern);
	return { library: out, taken, dropped };
}

/** Records merged by (at, sentence), oldest first, capped to the newest `cap`. */
export function mergeHistory(a: readonly InstructionRecord[] | undefined, b: readonly InstructionRecord[] | undefined, cap = HISTORY_CAP): InstructionRecord[] {
	const seen = new Map<string, InstructionRecord>();
	for (const record of [...(a ?? []), ...(b ?? [])]) {
		if (!record?.sentence?.trim()) continue;
		const key = `${record.at ?? ""}|${record.sentence.trim().toLowerCase()}|${record.projectId ?? ""}`;
		if (!seen.has(key)) seen.set(key, record);
	}
	return [...seen.values()].sort((x, y) => ((x.at ?? "") < (y.at ?? "") ? -1 : (x.at ?? "") > (y.at ?? "") ? 1 : 0)).slice(-cap);
}
