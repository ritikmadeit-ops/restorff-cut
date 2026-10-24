/**
 * Client-side mirror of the composition contract (packages/compositions/src/types.ts, CONTRACT.md §2). The editor
 * never imports the package (it runs server-side only, see app/api/compositions/_lib/service.ts); these are the
 * shapes the /api/compositions routes return.
 */

export type ParamType =
	| "string"
	| "text"
	| "number"
	| "color"
	| "boolean"
	| "enum"
	| "easing"
	| "font"
	| "image"
	| "list"
	| "object";

export interface ParamSpec {
	type: ParamType;
	label?: string;
	description?: string;
	default?: unknown;
	maxLength?: number;
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
	options?: string[];
	of?: ParamSpec;
	minItems?: number;
	maxItems?: number;
	fields?: Record<string, ParamSpec>;
	/** A render refuses without it (the package's `needs`; ui-fix-panels, QA #9). */
	required?: boolean;
}

export type ParamValues = Record<string, unknown>;

export interface CompositionEntry {
	name: string;
	title: string;
	description: string;
	tags: string[];
	duration: number;
	size: [number, number];
	fps: number;
	params: Record<string, ParamSpec>;
	example: ParamValues;
	hasSample: boolean;
	/** Params a render needs (what goes on screen); the catalogue lists them. */
	required?: string[];
	/** The manifest's layer recipe (collage-fx `effect` block: stack, inputs, plate keys); read by ./drop-layered.ts. */
	effect?: unknown;
}

export interface RenderAnswer {
	name: string;
	hash: string;
	url: string;
	cached: boolean;
	duration: number;
	width: number;
	height: number;
	fps: number;
	frames: number;
	bytes: number;
	params: ParamValues;
	ms: number;
}

export interface NudgeChange {
	key: string;
	from: unknown;
	to: unknown;
	because: string;
}

export interface NudgeAnswer {
	props: ParamValues;
	changes: NudgeChange[];
	skipped: string[];
}

/**
 * What a composition clip remembers about itself, stored on the timeline element as `restorff.composition` (scene
 * tracks are saved as-is, so it travels with the project and its commits). Enough to re-render it in place.
 */
export interface CompositionSource {
	name: string;
	/** The props the user/Claude set (only overrides; defaults come from the composition). */
	props: ParamValues;
	/** Render input hash = the cache key of the file this clip plays. */
	hash: string;
	width: number;
	height: number;
	fps: number;
	duration: number;
	/**
	 * A custom composition (motion-code agent): code written in the Code view or by Claude over MCP, not a library
	 * name. Then `source` is the whole HTML file — it travels in the commit, so anyone can reopen and change it, and a
	 * missing render is re-made from it (POST /api/compositions/custom).
	 */
	custom?: true;
	source?: string;
	title?: string;
	/** Who wrote the code: "claude" (MCP) or "user" (the Code view). Kiln marks Claude's. */
	author?: "claude" | "user";
}

/** A source that is a custom composition (has its HTML). */
export type CustomCompositionSource = CompositionSource & { custom: true; source: string };

export function isCustomSource(source: CompositionSource | null | undefined): source is CustomCompositionSource {
	return !!source && source.custom === true && typeof source.source === "string";
}

export const EASINGS = [
	"linear",
	"smooth",
	"gentle",
	"snappy",
	"bouncy",
	"springy",
	"elastic",
	"bounce",
	"ease-in",
] as const;

export const FONTS = ["Archivo", "JetBrains Mono", "Instrument Serif"] as const;
