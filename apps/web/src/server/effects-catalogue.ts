/**
 * The effects library — ONE catalogue for the editor and for a Claude over MCP (mcp-effects agent, 2026-10-20; EDT-17:
 * "every effect is a preset invokable by name from the UI and over MCP").
 *
 * Source of truth: the 62 rows of `@/compositions/effects-catalogue` (EFFECTS_CATALOGUE — what the Effects panel's
 * Library view shows; ids, names, honest status, `via`, the one-line note). Other agents keep those rows current
 * (compose, grade, collage-fx), so this module never copies them: it READS them and adds what a Claude needs to use
 * them by name — aliases, the kind of apply (composition · shader · transition · grade · tool), the inputs each effect
 * needs (person matte, face box, word timings…), the reels it comes from, and reel-tuned preset values for shaders.
 *
 * On top of the 62 it lists what else can be applied by name: package compositions no row points at yet (the
 * collage-fx agent adds them; read from packages/compositions at run time by ./effects.ts, never a hard-coded list),
 * every transition kind (timeline-ops transitions.ts), every grade look (grades.ts) and shader definitions no row uses.
 *
 * Pure: no Node imports, safe in the browser bundle. The server half (package reads, words, apply + commit) is
 * ./effects.ts; the MCP tool is ../mcp/effects.ts. Runbook: docs/restorff/worklog/mcp-effects.md.
 */
import {
	type CatalogueEffect,
	EFFECTS_CATALOGUE,
	type EffectStatus as LibraryStatus,
} from "@/compositions/effects-catalogue";
import { blurEffectDefinition } from "@/effects/definitions/blur";
import { digitalZoomEffectDefinition } from "@/effects/definitions/digital-zoom";
import { glassTypeEffectDefinition } from "@/effects/definitions/glass-type";
import { vertigoEffectDefinition } from "@/effects/definitions/vertigo";
import type { EffectDefinition } from "@/effects/types";
import {
	GRADE_EFFECT_TYPE,
	GRADE_LOOKS,
	resolveGradeName,
	resolveTransitionKind,
	TRANSITION_KINDS,
} from "@restorffcut/timeline-ops";

// ─── types ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The Library view says available · partial · coming; over MCP "available" reads "ready". */
export type EffectReadiness = "ready" | "partial" | "coming";

export type EffectKind = "composition" | "shader" | "transition" | "grade" | "captions" | "layout";

/** What an effect needs from the footage, the person or Claude to be the real thing. */
export type EffectNeed =
	| "person_matte"
	| "face_box"
	| "words"
	| "images"
	| "numbers"
	| "places"
	| "two_clips"
	| "two_renders"
	| "clip"
	| "clean_plate"
	| "cut_list"
	| "self_check";

/** How `effects apply` makes it. */
export type EffectApply =
	/** Render a package composition server-side and place it on MOTION (like the Motion view's drop). */
	| { kind: "composition"; composition: string }
	/** A compositor effect: an effect layer on an FX track for [t, t + hold), or on one clip with element_id. */
	| { kind: "shader"; effectType: string; params: Record<string, number | string>; hold_s: number; holdToSentence?: boolean }
	/** ops@1 `transition` at the cut nearest t (or into element_id). */
	| { kind: "transition"; transition: string; options?: string[] }
	/** ops@1 `grade` with a look. */
	| { kind: "grade"; look: string }
	/** Another MCP tool does this one. */
	| { kind: "tool"; tool: string; arguments: Record<string, unknown>; why: string };

export interface LibraryEffect {
	/** FX-NN for the 62; comp:<name> · tr:<kind> · grade:<look> · shader:<type> for the rest. */
	id: string;
	slug: string;
	name: string;
	aliases: string[];
	group: string;
	status: EffectReadiness;
	kind: EffectKind;
	/** EFFECTS.md build path: S shader · C composition · O timeline ops · M person matte. */
	build: string;
	/** Everything it needs to be the real thing. */
	needs: EffectNeed[];
	/** The subset of `needs` that stops it from being applied today. */
	blocking: EffectNeed[];
	/** Reference reels it is seen in (ids from docs/restorff/REELS.md). */
	reels: string[];
	note: string;
	apply: EffectApply | null;
	/** Where the row comes from. */
	source: "catalogue" | "package" | "transition" | "grade" | "shader";
	/** Other FX ids this one relates to (package compositions name them in their source). */
	related?: string[];
	/** Something the catalogue and the package disagree on (e.g. a row pointing at a composition that is gone). */
	warning?: string;
	/** fx-sync imports: where the composition came from and its licence. */
	provenance?: Record<string, unknown>;
}

/** What ./effects.ts reads from packages/compositions (the `catalogue` verb + a scan of each file for FX-NN). */
export interface PackageComposition {
	name: string;
	title: string;
	description: string;
	tags: string[];
	duration: number;
	/** FX ids the composition's file names (e.g. paper-cut → FX-13, FX-52, FX-60). */
	fx: string[];
	/** fx-sync imports (2026-10-24): {source, upstream, licence, …}; such rows are grouped "Imported · <category>". */
	provenance?: Record<string, unknown>;
}

// ─── shader definitions (the same objects the editor registers) ───────────────────────────────────────────────

export const SHADER_DEFINITIONS: Record<string, EffectDefinition> = Object.fromEntries(
	[digitalZoomEffectDefinition, vertigoEffectDefinition, glassTypeEffectDefinition, blurEffectDefinition].map((definition) => [
		definition.type,
		definition,
	]),
);

/** Default values of a shader definition's params (what buildDefaultEffectInstance gives the editor). */
export function shaderDefaults(effectType: string): Record<string, number | string> {
	const definition = SHADER_DEFINITIONS[effectType];
	const out: Record<string, number | string> = {};
	for (const param of definition?.params ?? []) {
		const value = (param as { default?: unknown }).default;
		if (typeof value === "number" || typeof value === "string") out[param.key] = value;
	}
	return out;
}

// ─── what the 62 rows need over MCP (from EFFECTS.md: Inputs, Params, Seen) ──────────────────────────────────

const REEL = {
	named: "Def9pj5TWtA",
	explainer: "DeIGbZypIUb",
	aesthetic: "DeUUFJQu8cw",
	motion: "DeBhOJ6T1Ja",
	collage: "DePNgrmToh9",
} as const;
const ALL_REELS = Object.values(REEL);

interface Overlay {
	aliases?: string[];
	/** Needs besides the person matte (that one comes from an "M" in the build path). */
	needs?: EffectNeed[];
	reels?: string[];
	/** Replaces the apply derived from the row's `via`. */
	apply?: EffectApply;
}

const named = (extra: Partial<Overlay> = {}): Overlay => ({ reels: [REEL.named], ...extra });

/** Keyed by FX id. Reels and inputs: EFFECTS.md (READ 2026-10-20). Preset values: the reel's, per EFFECTS.md Params. */
const OVERLAY: Record<string, Overlay> = {
	"FX-01": named({ needs: ["images", "face_box"], aliases: ["orbiting cards", "card ring"] }),
	"FX-02": named({ needs: ["images"], aliases: ["thumbnail wall", "wall of reels"] }),
	"FX-03": named({ needs: ["images", "words"], aliases: ["ui world", "chat ui"] }),
	"FX-04": named({ aliases: ["break the frame", "out of frame"] }),
	"FX-05": named({
		needs: ["words", "face_box"],
		aliases: ["punch in", "punch-in", "crash zoom", "push in", "zoom in on the word"],
		// EFFECTS.md FX-05: scale 1.0 → 1.35 (amount 35; 100 = 2x), cut on the word, hold until the next sentence;
		// centre = face box (ASSUMPTION until the face box exists server-side: a little above centre).
		apply: { kind: "shader", effectType: "restorff-digital-zoom", params: { amount: 35, focusX: 50, focusY: 42 }, hold_s: 1.5, holdToSentence: true },
	}),
	"FX-06": named({ needs: ["words"], aliases: ["phone", "device mockup", "app screen"] }),
	"FX-07": named({ needs: ["words"], aliases: ["to-do list", "tick list", "steps list"] }),
	"FX-08": named({ aliases: ["press wall", "headlines"] }),
	"FX-09": named({
		needs: ["two_clips", "face_box"],
		aliases: ["zoom through", "zoom-through cut", "zoom through cut"],
		// EFFECTS.md FX-09 is a cut transition: the editor's zoom-in transition (radial push) at the cut.
		apply: { kind: "transition", transition: "zoom-in" },
	}),
	"FX-10": named({ needs: ["numbers"], aliases: ["chart", "graph", "bar chart", "line chart", "growth chart", "sales chart"] }),
	"FX-11": named({ aliases: ["pullback", "pull back", "editor window"] }),
	"FX-12": named({ aliases: ["background replace", "key out"] }),
	"FX-13": named({ aliases: ["paper cutout", "ransom letters"] }),
	"FX-14": named({ aliases: ["doodles", "boil outline"] }),
	// FX-15 / FX-17 apply their compositions (the Library rows' via: vertigo, glass-type — collage-fx agent), built in
	// layers by effects apply; the older shaders stay reachable as shader:restorff-vertigo / shader:restorff-glass-type
	// (effects-layers agent, 2026-10-20).
	"FX-15": named({ needs: ["clean_plate", "face_box"], aliases: ["dolly zoom", "dolly-zoom"] }),
	"FX-16": { reels: [REEL.named, REEL.aesthetic], aliases: ["masthead"] },
	"FX-17": named({ aliases: ["glass", "glass panel", "glass letters"] }),

	"FX-18": {
		reels: [REEL.explainer],
		needs: ["words"],
		aliases: ["captions", "clean captions", "subtitles", "word captions"],
		// the captions tool's style ids (mcp-cut agent, mcp/cut.ts): bold-white = "clean bold sans, sentence case, no box"
		apply: { kind: "tool", tool: "captions", arguments: { style: "bold-white" }, why: "Captions come from the transcript as a whole caption track (style bold-white), not as one placed preset." },
	},
	"FX-19": { reels: [REEL.explainer], needs: ["words"], aliases: ["underline", "emphasis line"] },
	"FX-20": {
		reels: [REEL.aesthetic],
		needs: ["words"],
		aliases: ["karaoke captions", "boxed captions", "karaoke"],
		apply: {
			kind: "tool",
			tool: "captions",
			arguments: { style: "serif-box" },
			why: "Karaoke captions are the caption track's serif-box style (serif on a green label, words turn cream as they are said). One placed word-pop overlay instead: comp:word-pop.",
		},
	},
	"FX-21": { reels: [REEL.aesthetic], needs: ["words"], aliases: ["caption stack", "mixed type"] },
	"FX-22": { reels: [REEL.explainer, REEL.named, REEL.motion], needs: ["words"], aliases: ["big word", "word punch", "one big word"] },
	"FX-23": { reels: [REEL.motion], needs: ["words"], aliases: ["ignite", "glow type"] },
	"FX-24": { reels: [REEL.explainer], aliases: ["type on", "typewriter title", "section title"] },
	"FX-25": { reels: [REEL.aesthetic, REEL.motion], aliases: ["strikethrough", "strike through", "cross out"] },
	"FX-26": { reels: [REEL.aesthetic, REEL.motion, REEL.collage], aliases: ["stamp", "rubber stamp"] },
	"FX-27": { reels: [REEL.explainer], needs: ["images"], aliases: ["ui card", "card pop", "screenshot card"] },
	"FX-28": { reels: [REEL.explainer], needs: ["words"], aliases: ["badges", "pills"] },
	"FX-29": { reels: [REEL.explainer], aliases: ["explainer panel", "glass panel kit"] },
	"FX-30": { reels: [REEL.explainer, REEL.aesthetic, REEL.motion], needs: ["words"], aliases: ["prompt box", "chat box", "typing prompt"] },
	"FX-31": { reels: [REEL.explainer], aliases: ["chips", "ticking chips"] },
	"FX-32": { reels: [REEL.explainer, REEL.aesthetic, REEL.named], needs: ["numbers"], aliases: ["counter", "count up", "count down", "flip clock"] },
	"FX-33": { reels: [REEL.explainer], needs: ["cut_list"], aliases: ["dead space", "waveform"] },
	"FX-34": { reels: [REEL.explainer], needs: ["self_check"], aliases: ["filmstrip", "frame check"] },
	"FX-35": { reels: ALL_REELS, aliases: ["cta", "end card", "follow button", "comment cta"] },

	"FX-36": { reels: [REEL.aesthetic], needs: ["two_renders"], aliases: ["before after", "before and after"] },
	"FX-37": { reels: [REEL.aesthetic], aliases: ["grade wipe"] },
	"FX-38": { reels: [REEL.aesthetic], aliases: ["warm", "warm grade", "warm morning", "aesthetic", "make it more aesthetic"] },
	"FX-39": { reels: [REEL.aesthetic], aliases: ["moody", "moody grade", "make it moody"] },
	"FX-40": {
		reels: [REEL.aesthetic, REEL.collage, REEL.motion],
		needs: ["two_clips"],
		aliases: ["whip", "whip pan", "swish", "blur transition"],
		apply: { kind: "transition", transition: "whip-left", options: ["whip-left", "whip-right", "whip-up", "whip-down"] },
	},
	"FX-41": { reels: [REEL.motion], aliases: ["zoom blur exit"] },

	"FX-42": { reels: [REEL.aesthetic], needs: ["images", "face_box"], aliases: ["floating thumbnails", "thumbnails"] },
	"FX-43": { reels: [REEL.aesthetic], aliases: ["text behind", "text behind person", "word behind head"] },
	"FX-44": { reels: [REEL.aesthetic], needs: ["images", "clip"], aliases: ["collage", "grid of covers"] },
	"FX-45": { reels: [REEL.aesthetic], aliases: ["droste", "picture in picture"] },
	"FX-46": { reels: [REEL.aesthetic], aliases: ["storyboard card"] },
	"FX-47": { reels: [REEL.aesthetic], aliases: ["comment card"] },

	"FX-48": { reels: [REEL.motion], needs: ["words"], aliases: ["neon grid", "3d grid", "kinetic grid"] },
	"FX-49": { reels: [REEL.motion], aliases: ["flowchart", "flow chart", "spark"] },
	"FX-50": { reels: [REEL.motion], aliases: ["easing curve", "bezier demo"] },
	"FX-51": { reels: [REEL.motion], aliases: ["paper form", "form sheet"] },

	"FX-52": { reels: [REEL.collage], needs: ["images"], aliases: ["red outline cutout"] },
	"FX-53": { reels: [REEL.collage], aliases: ["old paper", "paper background"] },
	"FX-54": { reels: [REEL.collage], needs: ["places"], aliases: ["map", "route map", "travel map"] },
	"FX-55": { reels: [REEL.collage], needs: ["clip"], aliases: ["retro tv", "tv frame", "old tv"] },
	"FX-56": { reels: [REEL.collage], needs: ["images"], aliases: ["halftone"] },
	"FX-57": { reels: [REEL.collage], aliases: ["triptych", "three panels"] },
	"FX-58": { reels: [REEL.collage], aliases: ["thread timeline", "history timeline"] },
	"FX-59": { reels: [REEL.collage], aliases: ["label tag", "tags"] },
	"FX-60": { reels: [REEL.collage], aliases: ["letter tiles", "cracking sign"] },
	"FX-61": { reels: [REEL.collage], needs: ["images"], aliases: ["parallax", "side scroll"] },
	"FX-62": { reels: [REEL.collage], needs: ["clip"], aliases: ["split screen", "split hook"] },
};

// ─── building the library ─────────────────────────────────────────────────────────────────────────────────────

const READINESS: Record<LibraryStatus, EffectReadiness> = { available: "ready", partial: "partial", coming: "coming" };

/** Lower case, spaces/underscores → "-", quotes and other punctuation dropped; "FX 5" → "fx-05". */
export function normalizeName(value: string): string {
	const base = value
		.toLowerCase()
		.replace(/[‘’“”"'`]/g, "")
		.replace(/[^a-z0-9:]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const fx = /^fx-?(\d{1,2})$/.exec(base);
	return fx ? `fx-${fx[1].padStart(2, "0")}` : base;
}

const titleCase = (kind: string) => kind.replace(/(^|-)([a-z])/g, (_m, dash: string, ch: string) => `${dash ? " " : ""}${ch.toUpperCase()}`);

function applyFromVia(row: CatalogueEffect): EffectApply | null {
	const via = row.via;
	if (!via) return null;
	if (via.kind === "composition") return { kind: "composition", composition: via.name };
	if (via.kind === "shader") {
		if (via.type === GRADE_EFFECT_TYPE) {
			const look = typeof via.params?.look === "string" ? via.params.look : "custom";
			return { kind: "grade", look };
		}
		return { kind: "shader", effectType: via.type, params: { ...(via.params ?? {}) }, hold_s: 2 };
	}
	return null; // editor-only rows need an overlay apply
}

function kindOf(apply: EffectApply | null, build: string): EffectKind {
	if (apply?.kind === "tool") return apply.tool === "captions" ? "captions" : "layout";
	if (apply) return apply.kind;
	if (build.includes("C")) return "composition";
	if (build.includes("S")) return "shader";
	return "layout";
}

function uniq(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const key = normalizeName(value);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(value);
	}
	return out;
}

function fromRow(row: CatalogueEffect, packageByName: Map<string, PackageComposition> | null, packageByFx: Map<string, PackageComposition[]>): LibraryEffect {
	const overlay = OVERLAY[row.id] ?? {};
	let apply = overlay.apply ?? applyFromVia(row);
	let status = READINESS[row.status];
	let note = row.note;
	let warning: string | undefined;

	// a composition the row points at must exist in the package (when we could read it)
	if (apply?.kind === "composition" && packageByName && !packageByName.has(apply.composition)) {
		warning = `the catalogue row points at composition "${apply.composition}", which is not in packages/compositions`;
		apply = null;
		status = "coming";
	}
	// a coming row whose composition has landed in the package (named after the slug, or naming this FX id)
	if (status === "coming" && !apply && packageByName) {
		const landed = packageByName.get(row.slug) ?? packageByFx.get(row.id)?.[0];
		if (landed) {
			apply = { kind: "composition", composition: landed.name };
			status = "partial";
			note = `${landed.title}: ${firstSentence(landed.description)} (in packages/compositions; the Library row still says coming)`;
		}
	}

	const needs = new Set<EffectNeed>(overlay.needs ?? []);
	if (row.build.includes("M")) needs.add("person_matte");
	const blocking: EffectNeed[] = status === "coming" && needs.has("person_matte") ? ["person_matte"] : [];
	if (status === "coming" && needs.has("clean_plate")) blocking.push("clean_plate");

	const aliases = uniq([
		row.slug,
		row.name,
		...(overlay.aliases ?? []),
		...(apply?.kind === "composition" ? [apply.composition] : []),
		...(apply?.kind === "shader" ? (SHADER_DEFINITIONS[apply.effectType]?.keywords ?? []) : []),
	]);

	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		aliases,
		group: row.group,
		status,
		kind: kindOf(apply, row.build),
		build: row.build,
		needs: [...needs],
		blocking,
		reels: overlay.reels ?? [],
		note,
		apply,
		source: "catalogue",
		...(warning ? { warning } : {}),
	};
}

function firstSentence(text: string): string {
	const match = /^(.+?[.!?])(\s|$)/.exec(text.trim());
	return (match ? match[1] : text.trim()).slice(0, 200);
}

const GROUP_PACKAGE = "More compositions (package)";
/** fx-sync's import categories (tools/fx-sync lib/classify.ts), carried as a tag on each imported composition. */
const IMPORTED_CATEGORIES = ["captions", "kinetic-type", "transitions", "hooks", "cta", "data", "ui-product", "proof", "backgrounds", "other"];
export const GROUP_IMPORTED_PREFIX = "Imported · ";

function importedGroup(entry: PackageComposition): string {
	const category = entry.tags.find((tag) => IMPORTED_CATEGORIES.includes(tag)) ?? "other"; // fx-sync puts it first
	return `${GROUP_IMPORTED_PREFIX}${category}`;
}
const GROUP_TRANSITIONS = "Transitions";
const GROUP_GRADES = "Grades";
const GROUP_SHADERS = "Shaders";

/**
 * The whole library: the 62 Library rows (enriched) + package compositions no row applies + transitions + grade looks
 * + unused shader definitions. `compositions` = the package's catalogue (null when it could not be read: then rows are
 * taken at their word and no extras are listed).
 */
export function buildEffectsLibrary(compositions: PackageComposition[] | null): LibraryEffect[] {
	const packageByName = compositions ? new Map(compositions.map((entry) => [entry.name, entry])) : null;
	const packageByFx = new Map<string, PackageComposition[]>();
	for (const entry of compositions ?? []) {
		for (const fx of entry.fx) packageByFx.set(fx, [...(packageByFx.get(fx) ?? []), entry]);
	}

	const rows = EFFECTS_CATALOGUE.map((row) => fromRow(row, packageByName, packageByFx));
	const out: LibraryEffect[] = [...rows];

	const usedCompositions = new Set(rows.flatMap((row) => (row.apply?.kind === "composition" ? [row.apply.composition] : [])));
	for (const entry of compositions ?? []) {
		if (usedCompositions.has(entry.name)) continue;
		out.push({
			id: `comp:${entry.name}`,
			slug: entry.name,
			name: entry.title || entry.name,
			aliases: uniq([entry.name, entry.title]),
			group: entry.provenance ? importedGroup(entry) : GROUP_PACKAGE,
			status: "ready",
			kind: "composition",
			build: "C",
			needs: [],
			blocking: [],
			reels: [],
			note: firstSentence(entry.description || entry.title),
			apply: { kind: "composition", composition: entry.name },
			source: "package",
			...(entry.fx.length ? { related: entry.fx } : {}),
			...(entry.provenance ? { provenance: entry.provenance } : {}),
		});
	}

	const usedTransitions = new Set(rows.flatMap((row) => (row.apply?.kind === "transition" ? [row.apply.transition] : [])));
	for (const [kind, seconds] of Object.entries(TRANSITION_KINDS)) {
		out.push({
			id: `tr:${kind}`,
			slug: kind,
			name: titleCase(kind),
			aliases: [kind],
			group: GROUP_TRANSITIONS,
			status: "ready",
			kind: "transition",
			build: "S+O",
			needs: ["two_clips"],
			blocking: [],
			reels: [],
			note: `Transition "${kind}" across a cut (default ${seconds} s, centred on the cut).${usedTransitions.has(kind) ? " A named preset uses it too." : ""}`,
			apply: { kind: "transition", transition: kind },
			source: "transition",
		});
	}

	const usedLooks = new Set(rows.flatMap((row) => (row.apply?.kind === "grade" ? [row.apply.look] : [])));
	for (const look of GRADE_LOOKS) {
		if (usedLooks.has(look.id)) continue;
		out.push({
			id: `grade:${look.id}`,
			slug: `grade-${look.id}`,
			name: `Grade · ${look.label}`,
			aliases: uniq([look.id, look.label]),
			group: GROUP_GRADES,
			status: "ready",
			kind: "grade",
			build: "S",
			needs: [],
			blocking: [],
			reels: [],
			note: `Grade look "${look.label}": ${look.hint}.`,
			apply: { kind: "grade", look: look.id },
			source: "grade",
		});
	}

	const usedShaders = new Set(rows.flatMap((row) => (row.apply?.kind === "shader" ? [row.apply.effectType] : [])));
	for (const definition of Object.values(SHADER_DEFINITIONS)) {
		if (usedShaders.has(definition.type)) continue;
		out.push({
			id: `shader:${definition.type}`,
			slug: definition.type,
			name: definition.name,
			aliases: uniq([definition.type, definition.name, ...definition.keywords]),
			group: GROUP_SHADERS,
			status: "ready",
			kind: "shader",
			build: "S",
			needs: [],
			blocking: [],
			reels: [],
			note: `The ${definition.name} compositor effect.`,
			apply: { kind: "shader", effectType: definition.type, params: {}, hold_s: 2 },
			source: "shader",
		});
	}
	return out;
}

export function countByStatus(library: LibraryEffect[]): Record<EffectReadiness, number> {
	const counts: Record<EffectReadiness, number> = { ready: 0, partial: 0, coming: 0 };
	for (const effect of library) counts[effect.status]++;
	return counts;
}

// ─── finding an effect by name ────────────────────────────────────────────────────────────────────────────────

export type FindResult = { effect: LibraryEffect } | { effect: null; candidates: LibraryEffect[] };

/**
 * An effect by id (FX-10, "fx 10", comp:…), slug, name, alias, composition name, transition kind or alias
 * ("crossfade"), or grade look ("warm morning"). Exact matches first, in that order; then a contains-match, which
 * answers with candidates when it is not unique.
 */
export function findEffect(library: LibraryEffect[], query: string): FindResult {
	const q = normalizeName(query);
	if (!q) return { effect: null, candidates: [] };
	const exact = (pick: (effect: LibraryEffect) => string[]) => library.find((effect) => pick(effect).some((value) => normalizeName(value) === q));
	const hit =
		exact((effect) => [effect.id]) ??
		exact((effect) => [effect.slug]) ??
		exact((effect) => [effect.name]) ??
		exact((effect) => effect.aliases) ??
		exact((effect) => (effect.apply?.kind === "composition" ? [effect.apply.composition] : []));
	if (hit) return { effect: hit };

	const transition = resolveTransitionKind(query);
	if (transition) {
		const found = library.find((effect) => effect.id === `tr:${transition}`);
		if (found) return { effect: found };
	}
	const grade = resolveGradeName(query);
	if (grade?.kind === "look") {
		const found = library.find((effect) => effect.apply?.kind === "grade" && effect.apply.look === grade.look.id);
		if (found) return { effect: found };
	}

	// whole words only: "zoom" finds every zoom; "sparkle tornado" must not find "spark"
	const words = (value: string) => normalizeName(value).split("-").filter((part) => part.length > 1);
	const asked = words(query);
	const loose = library.filter((effect) =>
		[effect.slug, effect.name, ...effect.aliases].some((value) => {
			const have = words(value);
			if (!have.length || !asked.length) return false;
			return asked.every((word) => have.includes(word)) || (have.length > 1 && have.every((word) => asked.includes(word)));
		}),
	);
	if (loose.length === 1) return { effect: loose[0] };
	return { effect: null, candidates: loose.slice(0, 8) };
}
