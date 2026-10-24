/**
 * Saved styles as PRE-01 presets (plan/05 §9). RestorffCut keeps its OWN copy of the preset shape — the source of
 * truth is Restorff's core (`restorff/services/core/src/presets.mjs` validatePreset / BUILTIN_PRESETS, a private
 * repo) and this package must stay importable from a public MIT repo, so nothing is imported from there.
 *
 * A saved style = kind "edit-style", stage "edit", outputs ops@1, plus three RestorffCut fields:
 *   triggers  the sentences that call it ("tighter cut, bigger captions")
 *   steps     the ops template (see StyleStep) that applyStyle() instantiates on any project
 *   origin    the repeat pattern it was saved from (EDT-20)
 * Versions: saving a style with an id that exists bumps its version (1.0.0 → 1.1.0) and keeps the old one.
 */
import { OP_NAMES } from "@restorffcut/timeline-ops";

export const STYLE_LIBRARY_FORMAT = "restorffcut-styles@1";
/** `apply_style` id of a saved style (ops@1 / ApplyOptions.styles key). */
export const USER_STYLE_PREFIX = "restorff/user/";

const PRESET_KINDS = ["workflow", "judge", "prompt-sheet", "style-guide", "brief-template", "edit-style"];
const PRESET_STAGES = ["research", "brief", "board", "generate", "edit", "judge"];
const REQUIRED = ["id", "kind", "stage", "version", "title", "instructions"] as const;

export type StyleParamSpec =
	/** `from`: for a legacy absolute caption size, the size it was saved from (lets migrateSavedStyle make a ratio). */
	| { type: "number"; default: number; min?: number; max?: number; label?: string; from?: number }
	| { type: "string"; default: string; label?: string }
	| { type: "color"; default: string; label?: string }
	| { type: "boolean"; default: boolean; label?: string }
	| { type: "enum"; default: string; options: string[]; label?: string };

/**
 * Where a template op lands on the project it is applied to:
 *   $captions  once per caption track that has captions (`track` = its id)
 *   $main      the main (A-roll) track (`track: "main"`)
 *   $clips     once per clip on the main track (`el` = its id)
 */
export type TargetSelector = "$captions" | "$main" | "$clips";

/** A value in a template op that comes from the style's params: `{ "$param": "caption_size" }`. */
export interface ParamRef {
	$param: string;
}

export type StyleStep =
	/** Re-resolved on the target project with timeline-ops resolveSentence (pacing, relative caption sizes…). */
	| { kind: "sentence"; sentence: string }
	/** A literal op (author is set when applied); values may be ParamRefs; `each` repeats it per target. */
	| { kind: "op"; op: Record<string, unknown>; each?: TargetSelector };

export interface StyleOrigin {
	kind: "instruction" | "ops";
	/** The normalised pattern key it was detected on (detectRepeats). */
	pattern: string;
	count: number;
	projects: number;
	examples: string[];
	/** Median caption size (editor units) before the latest recorded instruction ran (ui-fix-panels, QA #8). */
	caption_size_before?: number;
}

/**
 * Something about a saved style that needs the person (ui-fix-panels, QA #8). `absolute_caption_size`: saved with a
 * fixed caption size whose saved-from size is unknown — skipped when applied until a ratio is set.
 */
export interface StyleFlag {
	code: "absolute_caption_size";
	message: string;
	/** The absolute size it was saved with. */
	size: number;
	/** The ratio the style's trigger wording means ("bigger" → 1.35), if any. */
	suggested_scale?: number;
}

export interface SavedStyle {
	id: string;
	kind: "edit-style";
	stage: "edit";
	/** semver */
	version: string;
	title: string;
	/** Plain words: what it does (shown in the picker and to Claude over MCP). */
	instructions: string;
	licence: string;
	visibility: "private" | "org" | "public";
	inputs: string[];
	outputs: { schema: "ops@1" };
	params: Record<string, StyleParamSpec>;
	checks: unknown[];
	triggers: string[];
	steps: StyleStep[];
	origin: StyleOrigin | null;
	/** Change note of this version. */
	note?: string;
	/** Problems the person has to look at (caption-size migration). */
	flags?: StyleFlag[];
	created_at: string;
	updated_at: string;
}

export interface StyleLibrary {
	format: typeof STYLE_LIBRARY_FORMAT;
	/** Current version of each style, by id. */
	styles: Record<string, SavedStyle>;
	/** Older versions, oldest first, by id. */
	versions: Record<string, SavedStyle[]>;
	/** Pattern keys the person said "no" to: never suggested again. */
	dismissed: string[];
}

export function emptyLibrary(): StyleLibrary {
	return { format: STYLE_LIBRARY_FORMAT, styles: {}, versions: {}, dismissed: [] };
}

// ─── validation (the PRE-01 rules of presets.mjs validatePreset + the edit-style fields) ───────────────────────

export function validateStylePreset(value: unknown): string[] {
	const p = value as Partial<SavedStyle> | null | undefined;
	const problems: string[] = [];
	if (!p || typeof p !== "object") return ["a style must be an object"];
	for (const key of REQUIRED) if (p[key] === undefined || p[key] === "") problems.push(`missing ${key}`);
	if (p.id && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(p.id)) problems.push("id: lowercase letters, digits and dashes");
	if (p.kind && !PRESET_KINDS.includes(p.kind)) problems.push(`kind: one of ${PRESET_KINDS.join(", ")}`);
	if (p.kind && p.kind !== "edit-style") problems.push("kind: a saved style is an edit-style preset");
	if (p.stage && !PRESET_STAGES.includes(p.stage)) problems.push(`stage: one of ${PRESET_STAGES.join(", ")}`);
	if (p.version && !/^\d+\.\d+\.\d+$/.test(p.version)) problems.push("version: semver (1.0.0)");
	if (p.checks !== undefined && !Array.isArray(p.checks)) problems.push("checks: a list");
	if (!Array.isArray(p.triggers) || p.triggers.some((t) => typeof t !== "string" || !t.trim())) {
		problems.push("triggers: a list of sentences");
	}
	if (!Array.isArray(p.steps) || p.steps.length === 0) problems.push("steps: at least one step");
	else {
		p.steps.forEach((step, i) => {
			if (step?.kind === "sentence") {
				if (typeof step.sentence !== "string" || !step.sentence.trim()) problems.push(`steps[${i}]: empty sentence`);
			} else if (step?.kind === "op") {
				const name = (step.op as { op?: unknown })?.op;
				if (typeof name !== "string" || !(OP_NAMES as readonly string[]).includes(name)) problems.push(`steps[${i}]: unknown op`);
				if (step.each !== undefined && !["$captions", "$main", "$clips"].includes(step.each)) problems.push(`steps[${i}]: unknown target`);
			} else problems.push(`steps[${i}]: kind is "sentence" or "op"`);
		});
	}
	if (p.params !== undefined && (typeof p.params !== "object" || p.params === null || Array.isArray(p.params))) {
		problems.push("params: an object");
	}
	return problems;
}

// ─── versions ───────────────────────────────────────────────────────────────────────────────────────────────────

export function bumpVersion(version: string, part: "major" | "minor" | "patch" = "minor"): string {
	const [major = 1, minor = 0, patch = 0] = (/^\d+\.\d+\.\d+$/.test(version) ? version : "1.0.0").split(".").map(Number);
	if (part === "major") return `${major + 1}.0.0`;
	if (part === "patch") return `${major}.${minor}.${patch + 1}`;
	return `${major}.${minor + 1}.0`;
}

/** Lowercase-dash id from a title, 2–48 chars ("Tighter cut, bigger captions" → "tighter-cut-bigger-captions"). */
export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	return slug.length >= 2 ? slug : `style-${slug || "x"}`;
}

function nowIso(now?: string): string {
	return now ?? new Date().toISOString();
}

/** Content equality, ignoring version, dates and the change note (a re-save of the same thing is not a new version). */
function sameContent(a: SavedStyle, b: SavedStyle): boolean {
	const strip = (s: SavedStyle) => ({ ...s, version: "", created_at: "", updated_at: "", note: "", origin: null });
	return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

export interface SaveOptions {
	now?: string;
	/** Change note for this version. */
	note?: string;
	bump?: "major" | "minor" | "patch";
}

/**
 * Save a style into the library (pure). New id → stored as is (version from the style, default 1.0.0). Existing id
 * → the old version moves to `versions[id]` and the new one gets the bumped version (unless nothing changed).
 */
export function saveStyle(library: StyleLibrary, style: SavedStyle, options: SaveOptions = {}): { library: StyleLibrary; style: SavedStyle; changed: boolean } {
	const problems = validateStylePreset(style);
	if (problems.length) throw new Error(`invalid style "${style?.id}": ${problems.join("; ")}`);
	const at = nowIso(options.now);
	const current = library.styles[style.id];
	if (current && sameContent(current, style)) return { library, style: current, changed: false };
	const next: SavedStyle = current
		? { ...style, version: bumpVersion(current.version, options.bump), created_at: current.created_at, updated_at: at, note: options.note ?? style.note }
		: { ...style, version: style.version || "1.0.0", created_at: style.created_at || at, updated_at: at, note: options.note ?? style.note };
	const versions = current ? { ...library.versions, [style.id]: [...(library.versions[style.id] ?? []), current] } : library.versions;
	return { library: { ...library, styles: { ...library.styles, [style.id]: next }, versions }, style: next, changed: true };
}

export function deleteStyle(library: StyleLibrary, id: string): StyleLibrary {
	const { [id]: _gone, ...styles } = library.styles;
	const { [id]: _old, ...versions } = library.versions;
	return { ...library, styles, versions };
}

/** Make an old version current again — as a NEW version (history stays linear, nothing is lost). */
export function restoreVersion(library: StyleLibrary, id: string, version: string, options: SaveOptions = {}): StyleLibrary {
	const old = (library.versions[id] ?? []).find((candidate) => candidate.version === version);
	if (!old) throw new Error(`style "${id}" has no version ${version}`);
	return saveStyle(library, { ...old }, { ...options, note: options.note ?? `restored ${version}` }).library;
}

export function dismissPattern(library: StyleLibrary, pattern: string): StyleLibrary {
	return library.dismissed.includes(pattern) ? library : { ...library, dismissed: [...library.dismissed, pattern] };
}

export function listStyles(library: StyleLibrary): SavedStyle[] {
	return Object.values(library.styles).sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}

// ─── export / import (JSON) ─────────────────────────────────────────────────────────────────────────────────────

export function exportLibrary(library: StyleLibrary): string {
	return JSON.stringify({ ...library, exported_at: new Date().toISOString() }, null, 2);
}

export interface ImportResult {
	library: StyleLibrary;
	added: string[];
	/** Existing ids that got a new version from the file. */
	updated: string[];
	unchanged: string[];
	problems: string[];
}

/**
 * Merge a JSON export (a whole library, a list of styles, or one style) into `into`. Unknown ids are added with
 * their versions; known ids get the file's style as a new version when it differs. Invalid styles are reported,
 * never thrown.
 */
export function importLibrary(text: string, into: StyleLibrary = emptyLibrary(), options: SaveOptions = {}): ImportResult {
	const result: ImportResult = { library: into, added: [], updated: [], unchanged: [], problems: [] };
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		result.problems.push(`not JSON: ${error instanceof Error ? error.message : String(error)}`);
		return result;
	}
	const incoming: Array<{ style: SavedStyle; versions: SavedStyle[] }> = [];
	const record = data as Partial<StyleLibrary> & { kind?: string };
	if (record && typeof record === "object" && !Array.isArray(record) && record.styles && typeof record.styles === "object") {
		for (const style of Object.values(record.styles)) incoming.push({ style, versions: record.versions?.[style.id] ?? [] });
	} else if (Array.isArray(data)) {
		for (const style of data as SavedStyle[]) incoming.push({ style, versions: [] });
	} else if (record?.kind === "edit-style") {
		incoming.push({ style: record as unknown as SavedStyle, versions: [] });
	} else {
		result.problems.push("no styles found (expected a RestorffCut styles export)");
		return result;
	}
	for (const { style, versions } of incoming) {
		const problems = validateStylePreset(style);
		if (problems.length) {
			result.problems.push(`${(style as { id?: string })?.id ?? "?"}: ${problems.join("; ")}`);
			continue;
		}
		const existing = result.library.styles[style.id];
		if (!existing) {
			const valid = versions.filter((v) => validateStylePreset(v).length === 0);
			result.library = {
				...result.library,
				styles: { ...result.library.styles, [style.id]: style },
				versions: valid.length ? { ...result.library.versions, [style.id]: valid } : result.library.versions,
			};
			result.added.push(style.id);
			continue;
		}
		const saved = saveStyle(result.library, style, { ...options, note: options.note ?? `imported (file had ${style.version})` });
		result.library = saved.library;
		(saved.changed ? result.updated : result.unchanged).push(style.id);
	}
	return result;
}
