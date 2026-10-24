/**
 * One params shape for `effects describe` (timing-helper, 2026-10-21; effects-library-nitro REPORT "Where Sonnet got
 * stuck" 4): describe answered a composition's params as a dict `{key: spec}` (packages/compositions manifests), a
 * shader's as a list `[{key, label, type, default, min, max}]`, and a transition's / grade's as a dict of prose — a
 * model reading three shapes guessed. Now every kind answers `params` as a list of rows:
 *
 *   {name, type, default?, label?, description?, min?, max?, step?, unit?, options?, required?, display?, preset?,
 *    of?, fields?, max_length?, min_items?, max_items?, required_unless?}
 *
 * and keeps what it answered before under `params_legacy` (additive: old readers move one key). Pure.
 */
import { GRADE_LOOKS, TRANSITION_KINDS } from "@restorffcut/timeline-ops";

export interface ParamRow {
	name: string;
	type: string;
	default?: unknown;
	label?: string;
	description?: string;
	min?: number;
	max?: number;
	step?: number;
	unit?: string;
	options?: unknown[];
	required?: boolean;
	display?: boolean;
	/** Shaders: the reel-tuned value effects apply uses when you send none. */
	preset?: unknown;
	of?: unknown;
	fields?: unknown;
	max_length?: number;
	min_items?: number;
	max_items?: number;
	required_unless?: string;
	/** mcp-gaps-mvp (2026-10-24): what an image param (or a list / object holding images) takes. */
	accepts?: string;
}

/**
 * What an image param takes over MCP (mcp-gaps-mvp, 2026-10-24; resolved server-side by server/composition-media.ts —
 * the same text as its IMAGE_ACCEPTS, kept here so this file stays pure).
 */
export const IMAGE_ACCEPTS =
	"a media_id from this timeline (media import / media list answer it; a video's id gives its frame at 1 s, media:<id>#t=2.5 another), this server's media URL /api/projects/<timeline>/media/<id>, an https: URL or a data: URL. Never a file path: import the file with media import first.";

/** True when a spec is an image, or a list / object that holds one. */
export function holdsImage(spec: unknown, depth = 0): boolean {
	if (!isRecord(spec) || depth > 6) return false;
	if (spec.type === "image") return true;
	if (spec.type === "list") return holdsImage(spec.of, depth + 1);
	if (spec.type === "object" && isRecord(spec.fields)) return Object.values(spec.fields).some((field) => holdsImage(field, depth + 1));
	return false;
}

export const PARAMS_NOTE =
	"params: one row per param, the same shape for every kind ({name, type, default, …}; send {name: value} in apply params). params_legacy: what describe answered before 2026-10-21 (compositions {key: spec}, shaders [{key, …}], transitions / grades {key: text}).";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const numberOr = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const textOr = (value: unknown) => (typeof value === "string" && value ? value : undefined);

function clean(row: ParamRow): ParamRow {
	return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as unknown as ParamRow;
}

/** A packages/compositions param spec (CONTRACT §2) as a row. */
export function specRow(name: string, spec: Record<string, unknown>): ParamRow {
	return clean({
		name,
		type: textOr(spec.type) ?? "unknown",
		default: spec.default,
		label: textOr(spec.label),
		description: textOr(spec.description),
		min: numberOr(spec.min),
		max: numberOr(spec.max),
		step: numberOr(spec.step),
		unit: textOr(spec.unit),
		options: Array.isArray(spec.options) ? spec.options : undefined,
		required: spec.required === true ? true : undefined,
		display: typeof spec.display === "boolean" ? spec.display : undefined,
		of: spec.of,
		fields: spec.fields,
		max_length: numberOr(spec.maxLength),
		min_items: numberOr(spec.minItems),
		max_items: numberOr(spec.maxItems),
		required_unless: textOr(spec.requiredUnless),
		accepts: holdsImage(spec) ? IMAGE_ACCEPTS : undefined,
	});
}

/** The rows for one `describeParams` answer (server/effects.ts), whatever its kind. */
export function paramRows(described: Record<string, unknown>): ParamRow[] {
	const params = described.params;
	// shader: [{key, label, type, default, min, max}] + the reel-tuned preset
	if (Array.isArray(params)) {
		const preset = isRecord(described.preset) ? described.preset : {};
		return params.filter(isRecord).map((param) =>
			clean({
				name: String(param.key ?? param.name ?? ""),
				type: textOr(param.type) ?? "number",
				default: param.default,
				label: textOr(param.label),
				min: numberOr(param.min),
				max: numberOr(param.max),
				preset: preset[String(param.key ?? param.name ?? "")],
			}),
		);
	}
	// composition: {key: spec}
	if (typeof described.composition === "string" && isRecord(params)) {
		return Object.entries(params).map(([name, spec]) => specRow(name, isRecord(spec) ? spec : {}));
	}
	// transition: {kind, direction?, track, reach_s} as prose
	if (typeof described.transition === "string") {
		const directions = Array.isArray(described.directions) ? (described.directions as string[]) : null;
		return [
			{ name: "kind", type: "enum", default: described.transition, options: Object.keys(TRANSITION_KINDS), description: "any transition kind (overrides direction)" },
			...(directions ? [{ name: "direction", type: "enum", options: directions.map((option) => option.split("-").pop()), description: "which way it moves" }] : []),
			{ name: "track", type: "string", default: "main", description: "the track id whose cut it goes on" },
			{ name: "reach_s", type: "number", default: 1.5, min: 0, unit: "s", description: "how far from t the cut may be" },
		];
	}
	// grade: {look, target, <slider>} as prose + looks + sliders
	if (typeof described.look === "string") {
		const sliders = Array.isArray(described.sliders) ? described.sliders.filter(isRecord) : [];
		return [
			{ name: "look", type: "enum", default: described.look, options: GRADE_LOOKS.map((look) => look.id), description: "a look, or a nudge (warmer, cooler, brighter, more contrast…)" },
			{ name: "target", type: "string", description: "an element id, a track id, \"main\" or \"all\" (default: element_id, else the clip under t, else all)" },
			...sliders.map((slider) =>
				clean({ name: String(slider.key), type: "number", default: slider.default, label: textOr(slider.label), min: numberOr(slider.min), max: numberOr(slider.max), description: "applied after the look" }),
			),
		];
	}
	return [];
}

/** describeParams' answer with `params` as rows and the old shape kept under `params_legacy`. */
export function withParamRows(described: Record<string, unknown>): Record<string, unknown> {
	const rows = paramRows(described);
	return {
		...described,
		params: rows,
		...(described.params !== undefined ? { params_legacy: described.params } : {}),
		params_note: PARAMS_NOTE,
	};
}
