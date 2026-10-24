/**
 * The editor's element parameter registry, copied as data (apps/web/src/params/registry.ts:96-352,
 * timeline/defaults.ts, graphics/definitions/*.ts). Used to build new elements with the exact default params the
 * editor would give them, to validate `set` props, and to coerce values the way the editor does
 * (params/index.ts:309 coerceParamValue + utils/math.ts snapToStep).
 */
import type { ElementType, ParamValue, ParamValues } from "./model.ts";

export interface ParamDef {
	key: string;
	type: "number" | "boolean" | "color" | "select" | "text" | "font";
	default: ParamValue;
	min?: number;
	max?: number;
	step?: number;
	/** false when the editor does not allow keyframes on it. */
	keyframable: boolean;
	options?: string[];
}

const BLEND_MODES = [
	"normal", "darken", "multiply", "color-burn", "lighten", "screen", "plus-lighter", "color-dodge", "overlay",
	"soft-light", "hard-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];

/** timeline/audio-constants.ts */
export const VOLUME_DB_MIN = -60;
export const VOLUME_DB_MAX = 20;
/** animation/transform.ts */
export const MIN_TRANSFORM_SCALE = 0.01;

const VISUAL: ParamDef[] = [
	{ key: "transform.positionX", type: "number", default: 0, min: -100_000, step: 1, keyframable: true },
	{ key: "transform.positionY", type: "number", default: 0, min: -100_000, step: 1, keyframable: true },
	{ key: "transform.scaleX", type: "number", default: 1, min: MIN_TRANSFORM_SCALE, step: 0.01, keyframable: true },
	{ key: "transform.scaleY", type: "number", default: 1, min: MIN_TRANSFORM_SCALE, step: 0.01, keyframable: true },
	{ key: "transform.rotate", type: "number", default: 0, min: -360, max: 360, step: 1, keyframable: true },
	{ key: "opacity", type: "number", default: 1, min: 0, max: 1, step: 0.01, keyframable: true },
	{ key: "blendMode", type: "select", default: "normal", keyframable: false, options: BLEND_MODES },
];

const AUDIO: ParamDef[] = [
	{ key: "volume", type: "number", default: 0, min: VOLUME_DB_MIN, max: VOLUME_DB_MAX, step: 0.01, keyframable: true },
	{ key: "muted", type: "boolean", default: false, keyframable: false },
];

const TEXT: ParamDef[] = [
	{ key: "content", type: "text", default: "Default text", keyframable: false },
	{ key: "fontFamily", type: "font", default: "Arial", keyframable: false },
	{ key: "fontSize", type: "number", default: 15, min: 1, step: 1, keyframable: true },
	{ key: "color", type: "color", default: "#ffffff", keyframable: true },
	{ key: "textAlign", type: "select", default: "center", keyframable: false, options: ["left", "center", "right"] },
	{ key: "fontWeight", type: "select", default: "normal", keyframable: false, options: ["normal", "bold"] },
	{ key: "fontStyle", type: "select", default: "normal", keyframable: false, options: ["normal", "italic"] },
	{
		key: "textDecoration",
		type: "select",
		default: "none",
		keyframable: false,
		options: ["none", "underline", "line-through"],
	},
	{ key: "letterSpacing", type: "number", default: 0, min: -100, step: 0.1, keyframable: true },
	{ key: "lineHeight", type: "number", default: 1.2, min: 0.1, step: 0.1, keyframable: true },
	{ key: "background.enabled", type: "boolean", default: false, keyframable: false },
	{ key: "background.color", type: "color", default: "#000000", keyframable: true },
	{ key: "background.cornerRadius", type: "number", default: 0, min: 0, max: 100, step: 1, keyframable: true },
	{ key: "background.paddingX", type: "number", default: 30, min: 0, step: 1, keyframable: true },
	{ key: "background.paddingY", type: "number", default: 42, min: 0, step: 1, keyframable: true },
	{ key: "background.offsetX", type: "number", default: 0, min: -100_000, step: 1, keyframable: true },
	{ key: "background.offsetY", type: "number", default: 0, min: -100_000, step: 1, keyframable: true },
];

/** params/registry.ts:333-352 — which params each element type carries. */
export const ELEMENT_PARAMS: Record<ElementType, ParamDef[]> = {
	video: [...VISUAL, ...AUDIO],
	image: VISUAL,
	text: [...TEXT, ...VISUAL],
	sticker: VISUAL,
	graphic: VISUAL,
	audio: AUDIO,
	effect: [],
};

const STROKE: ParamDef[] = [
	{ key: "fill", type: "color", default: "#ffffff", keyframable: true },
	{ key: "stroke", type: "color", default: "#000000", keyframable: true },
	{ key: "strokeWidth", type: "number", default: 0, min: 0, max: 64, step: 1, keyframable: true },
	{ key: "strokeAlign", type: "select", default: "center", keyframable: true, options: ["inside", "center", "outside"] },
];

/** graphics/definitions/{rectangle,ellipse,star,polygon}.ts — the four built-in shapes (keys, defaults, ranges). */
export const GRAPHIC_PARAMS: Record<string, ParamDef[]> = {
	rectangle: [...STROKE, { key: "cornerRadius", type: "number", default: 0, min: 0, max: 50, step: 1, keyframable: true }],
	ellipse: [...STROKE],
	star: [
		...STROKE,
		{ key: "points", type: "number", default: 5, min: 3, max: 12, step: 1, keyframable: true },
		{ key: "depth", type: "number", default: 45, min: 1, max: 99, step: 1, keyframable: true },
	],
	polygon: [
		...STROKE,
		{ key: "sides", type: "number", default: 5, min: 3, max: 12, step: 1, keyframable: true },
		{ key: "cornerRadius", type: "number", default: 0, min: 0, max: 50, step: 1, keyframable: true },
	],
};

export function defaultParams(defs: readonly ParamDef[]): ParamValues {
	const values: ParamValues = {};
	for (const def of defs) values[def.key] = def.default;
	return values;
}

export function getParamDef(
	elementType: ElementType,
	key: string,
	graphicDefinitionId?: string,
): ParamDef | null {
	const own = ELEMENT_PARAMS[elementType].find((def) => def.key === key);
	if (own) return own;
	if (elementType === "graphic" && graphicDefinitionId) {
		return GRAPHIC_PARAMS[graphicDefinitionId]?.find((def) => def.key === key) ?? null;
	}
	return null;
}

/** utils/math.ts getFractionDigitsForStep */
function fractionDigitsForStep(step: number): number {
	const normalized = step.toString().toLowerCase();
	if (normalized.includes("e-")) return Number(normalized.split("e-")[1] ?? 0);
	const [, fractional = ""] = normalized.split(".");
	return fractional.length;
}

/** utils/math.ts snapToStep */
export function snapToStep(value: number, step: number): number {
	if (step <= 0) return value;
	const snapped = Math.round(value / step) * step;
	return Number(snapped.toFixed(fractionDigitsForStep(step)));
}

/** params/index.ts:309 coerceParamValue: null when the value cannot be stored. */
export function coerceParamValue(def: ParamDef, value: unknown): ParamValue | null {
	switch (def.type) {
		case "number": {
			if (typeof value !== "number" || Number.isNaN(value)) return null;
			const stepped = snapToStep(value, def.step ?? 0);
			const max = def.max ?? Number.POSITIVE_INFINITY;
			return Math.min(max, Math.max(def.min ?? Number.NEGATIVE_INFINITY, stepped));
		}
		case "boolean":
			return typeof value === "boolean" ? value : null;
		case "color":
		case "text":
		case "font":
			return typeof value === "string" ? value : null;
		case "select":
			return typeof value === "string" && (def.options ?? []).includes(value) ? value : null;
	}
}
