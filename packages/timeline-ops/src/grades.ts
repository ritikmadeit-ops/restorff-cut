/**
 * Colour grade — the one place that says what a grade is. Pure data + small pure functions, imported by the reducer
 * (ops@1 `grade`), the editing styles, the storyboard compiler, the sentence resolver (intents.ts) and the editor
 * (apps/web/src/effects/definitions/grade.ts, the inspector's Grade picker). Owner: the grade agent
 * (docs/restorff/worklog/grade.md).
 *
 * The grade is ONE GPU pass, shader `restorff-grade` (rust/crates/effects/src/shaders/grade.wgsl). Its controls are
 * plain numbers, so every one is keyframable in the editor (`effects.<id>.params.<key>`). A **look** is a preset of
 * those numbers in our own words ("warm morning"); a **nudge** is a relative change ("warmer"). In a project a grade
 * is an ordinary effect `{ type: "restorff-grade", params }`:
 *   - on a clip:      in the element's `effects` list (keyframable, moves with the clip);
 *   - on a track:     on every video/image clip of that track;
 *   - on everything:  an adjustment layer — an effect element on a "GRADE" effect track placed just above the topmost
 *                     footage track, so captions, text and motion graphics above it keep their colours.
 * `params.look` (a string, not a slider) records the look the grade started from; the sliders are the truth.
 *
 * Units are what a person sees: exposure in stops, everything else −100…100 (grain and tints 0…100, hues in degrees).
 * `gradeUniforms` turns them into the shader's uniforms; the Rust registry's defaults are the identity.
 */

export const GRADE_EFFECT_TYPE = "restorff-grade";
export const GRADE_SHADER_ID = "restorff-grade";
/** Name of the effect track that holds a whole-timeline grade. */
export const GRADE_TRACK_NAME = "GRADE";
/** `params.look` value of a grade that matches no look. */
export const CUSTOM_LOOK = "custom";

export const GRADE_PARAM_KEYS = [
	"exposure",
	"contrast",
	"saturation",
	"temperature",
	"tint",
	"shadows",
	"midtones",
	"highlights",
	"vignette",
	"grain",
	"shadowHue",
	"shadowTint",
	"highlightHue",
	"highlightTint",
	"amount",
] as const;

export type GradeParamKey = (typeof GRADE_PARAM_KEYS)[number];
export type GradeParams = Record<GradeParamKey, number>;

export type GradeParamGroup = "light" | "colour" | "tone" | "split" | "texture" | "strength";

export interface GradeParamSpec {
	key: GradeParamKey;
	label: string;
	group: GradeParamGroup;
	min: number;
	max: number;
	step: number;
	/** The identity value: a grade with every param at its default leaves the picture untouched. */
	default: number;
	/** What the number means, for tooltips and the MCP tool description. */
	hint: string;
}

export const GRADE_PARAM_SPECS: readonly GradeParamSpec[] = [
	{ key: "exposure", label: "Exposure", group: "light", min: -3, max: 3, step: 0.05, default: 0, hint: "stops of light (+1 = twice the light)" },
	{ key: "contrast", label: "Contrast", group: "light", min: -100, max: 100, step: 1, default: 0, hint: "S-curve around mid grey; never clips" },
	{ key: "saturation", label: "Saturation", group: "colour", min: -100, max: 100, step: 1, default: 0, hint: "−100 = black and white, +100 = twice the colour" },
	{ key: "temperature", label: "Temperature", group: "colour", min: -100, max: 100, step: 1, default: 0, hint: "+ warmer (amber), − cooler (blue); brightness kept" },
	{ key: "tint", label: "Tint", group: "colour", min: -100, max: 100, step: 1, default: 0, hint: "+ magenta, − green; brightness kept" },
	{ key: "shadows", label: "Shadows", group: "tone", min: -100, max: 100, step: 1, default: 0, hint: "lift: + raises the blacks (a faded, matte look), − crushes them" },
	{ key: "midtones", label: "Midtones", group: "tone", min: -100, max: 100, step: 1, default: 0, hint: "gamma: + brighter mids, − darker mids; ends fixed" },
	{ key: "highlights", label: "Highlights", group: "tone", min: -100, max: 100, step: 1, default: 0, hint: "gain: scales the whites, black fixed" },
	{ key: "shadowHue", label: "Shadow hue", group: "split", min: 0, max: 360, step: 1, default: 0, hint: "colour pushed into the shadows (degrees: 0 red, 30 orange, 200 teal, 220 blue)" },
	{ key: "shadowTint", label: "Shadow tint", group: "split", min: 0, max: 100, step: 1, default: 0, hint: "how much of the shadow hue" },
	{ key: "highlightHue", label: "Highlight hue", group: "split", min: 0, max: 360, step: 1, default: 0, hint: "colour pushed into the highlights (degrees)" },
	{ key: "highlightTint", label: "Highlight tint", group: "split", min: 0, max: 100, step: 1, default: 0, hint: "how much of the highlight hue" },
	{ key: "vignette", label: "Vignette", group: "texture", min: -100, max: 100, step: 1, default: 0, hint: "+ darker edges, − lighter edges" },
	{ key: "grain", label: "Grain", group: "texture", min: 0, max: 100, step: 1, default: 0, hint: "film grain, new every frame, strongest in the midtones" },
	{ key: "amount", label: "Amount", group: "strength", min: 0, max: 100, step: 1, default: 100, hint: "strength of the whole grade (0 = off)" },
];

const SPEC_BY_KEY = new Map(GRADE_PARAM_SPECS.map((spec) => [spec.key, spec]));

export const NEUTRAL_GRADE: Readonly<GradeParams> = Object.freeze(
	Object.fromEntries(GRADE_PARAM_SPECS.map((spec) => [spec.key, spec.default])) as GradeParams,
);

export interface GradeLook {
	id: string;
	label: string;
	/** One line a person reads in the picker. */
	hint: string;
	/** Only what differs from neutral. */
	params: Partial<GradeParams>;
}

/**
 * The named looks. Numbers tuned against Halcyon Cold Brew test frames (grade agent, 2026-10-20); EFFECTS.md FX-38
 * (warm) and FX-39 (moody) give the starting points.
 */
export const GRADE_LOOKS: readonly GradeLook[] = [
	{
		id: "warm-morning",
		label: "warm morning",
		hint: "soft golden light, lifted blacks, peach highlights",
		params: {
			exposure: 0.1,
			contrast: -10,
			saturation: 6,
			temperature: 28,
			tint: 4,
			shadows: 16,
			midtones: 6,
			shadowHue: 25,
			shadowTint: 12,
			highlightHue: 30,
			highlightTint: 32,
			vignette: 10,
		},
	},
	{
		id: "moody",
		label: "moody",
		hint: "darker and cooler, muted colour, teal shadows, warm lights kept",
		params: {
			exposure: -0.6,
			contrast: 22,
			saturation: -30,
			temperature: -14,
			shadows: -4,
			midtones: -12,
			highlights: -6,
			shadowHue: 195,
			shadowTint: 45,
			highlightHue: 35,
			highlightTint: 28,
			vignette: 35,
		},
	},
	{
		id: "clean",
		label: "clean",
		hint: "true colour, a little crisper and brighter",
		params: { exposure: 0.05, contrast: 8, saturation: 6, highlights: 4 },
	},
	{
		id: "film",
		label: "film",
		hint: "faded blacks, soft highlights, a warm-green cast and grain",
		// first cut (shadows 22, contrast 14) left the blacks at ~9/255: not faded enough to read as film (MEASURED)
		params: {
			contrast: 10,
			saturation: -14,
			temperature: 8,
			tint: -8,
			shadows: 32,
			highlights: -8,
			shadowHue: 180,
			shadowTint: 22,
			highlightHue: 40,
			highlightTint: 22,
			vignette: 20,
			grain: 35,
		},
	},
	{
		id: "cool-night",
		label: "cool night",
		hint: "blue night: darker, cool, deep blue shadows",
		params: {
			exposure: -0.4,
			contrast: 16,
			saturation: -16,
			temperature: -45,
			tint: 6,
			shadows: -2,
			shadowHue: 220,
			shadowTint: 38,
			highlightHue: 200,
			highlightTint: 10,
			vignette: 30,
		},
	},
	{
		id: "punchy",
		label: "punchy",
		hint: "bold contrast and colour for fast cuts",
		// first cut had saturation 28 + temperature 5: skin went red-orange on the Halcyon test frame (SEEN, 13:25)
		params: { exposure: 0.05, contrast: 26, saturation: 16, midtones: 4, highlights: 6, vignette: 15 },
	},
	{
		id: "paper",
		label: "paper",
		hint: "faded and warm like printed paper, low contrast, light grain",
		params: {
			contrast: -14,
			saturation: -18,
			temperature: 18,
			shadows: 22,
			highlights: -4,
			highlightHue: 45,
			highlightTint: 15,
			grain: 25,
		},
	},
	{
		id: "mono",
		label: "black and white",
		hint: "black and white with a little contrast and grain",
		params: { saturation: -100, contrast: 18, vignette: 20, grain: 15 },
	},
];

export interface GradeNudge {
	id: string;
	label: string;
	/** Added to the current values (then clamped to each param's range). */
	delta: Partial<GradeParams>;
}

export const GRADE_NUDGES: readonly GradeNudge[] = [
	{ id: "warmer", label: "warmer", delta: { temperature: 15 } },
	{ id: "cooler", label: "cooler", delta: { temperature: -15 } },
	{ id: "brighter", label: "brighter", delta: { exposure: 0.25 } },
	{ id: "darker", label: "darker", delta: { exposure: -0.25 } },
	{ id: "more-contrast", label: "more contrast", delta: { contrast: 15 } },
	{ id: "less-contrast", label: "less contrast", delta: { contrast: -15 } },
	{ id: "more-saturation", label: "more colour", delta: { saturation: 15 } },
	{ id: "less-saturation", label: "less colour", delta: { saturation: -15 } },
	{ id: "more-grain", label: "more grain", delta: { grain: 20 } },
];

/** `grade { preset: "none" }` removes the grade from its target. */
export const NO_GRADE = "none";

/** Other words for a look or nudge (after lower-casing, `_`/space → `-`). */
const ALIASES: Readonly<Record<string, string>> = {
	warm: "warm-morning",
	"warm-grade": "warm-morning",
	"warm-look": "warm-morning",
	aesthetic: "warm-morning",
	golden: "warm-morning",
	"golden-hour": "warm-morning",
	morning: "warm-morning",
	cool: "cool-night",
	cold: "cool-night",
	night: "cool-night",
	"cool-grade": "cool-night",
	"blue-hour": "cool-night",
	"moody-grade": "moody",
	cinematic: "moody",
	neutral: "clean",
	natural: "clean",
	"clean-look": "clean",
	"film-look": "film",
	vintage: "film",
	retro: "film",
	analog: "film",
	analogue: "film",
	vivid: "punchy",
	"paper-texture": "paper",
	bw: "mono",
	"b-w": "mono",
	"b&w": "mono",
	"black-and-white": "mono",
	monochrome: "mono",
	greyscale: "mono",
	grayscale: "mono",
	contrast: "more-contrast",
	contrasty: "more-contrast",
	saturated: "more-saturation",
	"more-colour": "more-saturation",
	"more-color": "more-saturation",
	muted: "less-saturation",
	desaturated: "less-saturation",
	"less-colour": "less-saturation",
	"less-color": "less-saturation",
	dark: "darker",
	bright: "brighter",
	grainy: "more-grain",
	off: NO_GRADE,
	reset: NO_GRADE,
	"no-grade": NO_GRADE,
};

export function normalizeGradeName(name: string): string {
	return name.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export type ResolvedGrade =
	| { kind: "look"; look: GradeLook }
	| { kind: "nudge"; nudge: GradeNudge }
	| { kind: "none" };

/** A look, a nudge or "none" for a name or alias ("warm", "warm morning", "warmer", "B&W"); null when unknown. */
export function resolveGradeName(name: string): ResolvedGrade | null {
	const normalized = normalizeGradeName(name);
	const id = ALIASES[normalized] ?? normalized;
	if (id === NO_GRADE) return { kind: "none" };
	const look = GRADE_LOOKS.find((candidate) => candidate.id === id || normalizeGradeName(candidate.label) === id);
	if (look) return { kind: "look", look };
	const nudge = GRADE_NUDGES.find((candidate) => candidate.id === id || normalizeGradeName(candidate.label) === id);
	if (nudge) return { kind: "nudge", nudge };
	return null;
}

export function getGradeLook(id: string): GradeLook | undefined {
	const resolved = resolveGradeName(id);
	return resolved?.kind === "look" ? resolved.look : undefined;
}

function clampParam(key: GradeParamKey, value: number): number {
	const spec = SPEC_BY_KEY.get(key) as GradeParamSpec;
	if (!Number.isFinite(value)) return spec.default;
	const clamped = Math.min(spec.max, Math.max(spec.min, value));
	// keep values on a clean decimal grid (no 0.30000000000000004 in project JSON)
	return Math.round(clamped * 1000) / 1000;
}

export function clampGradeParams(params: Partial<Record<string, unknown>>): GradeParams {
	const result = { ...NEUTRAL_GRADE } as GradeParams;
	for (const key of GRADE_PARAM_KEYS) {
		const raw = params[key];
		const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
		if (Number.isFinite(value)) result[key] = clampParam(key, value);
	}
	return result;
}

/** Full params of a look (neutral + the look's own). */
export function lookParams(look: GradeLook | string): GradeParams {
	const resolved = typeof look === "string" ? getGradeLook(look) : look;
	return clampGradeParams({ ...NEUTRAL_GRADE, ...(resolved?.params ?? {}) });
}

export function applyGradeNudge(base: Partial<GradeParams>, nudge: GradeNudge | string): GradeParams {
	const resolved = typeof nudge === "string" ? GRADE_NUDGES.find((candidate) => candidate.id === nudge) : nudge;
	const current = clampGradeParams(base);
	if (!resolved) return current;
	const next = { ...current };
	for (const [key, delta] of Object.entries(resolved.delta) as Array<[GradeParamKey, number]>) {
		next[key] = clampParam(key, current[key] + delta);
	}
	return next;
}

/** Problems with a `params` object handed to `grade` (unknown keys, non-numbers, out of range); empty = fine. */
export function gradeParamProblems(params: unknown): string[] {
	if (typeof params !== "object" || params === null || Array.isArray(params)) return ["params must be an object"];
	const problems: string[] = [];
	for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
		const spec = SPEC_BY_KEY.get(key as GradeParamKey);
		if (!spec) {
			problems.push(`unknown grade param "${key}" (known: ${GRADE_PARAM_KEYS.join(", ")})`);
			continue;
		}
		if (typeof value !== "number" || !Number.isFinite(value)) problems.push(`${key} must be a number`);
		else if (value < spec.min || value > spec.max) problems.push(`${key} must be within ${spec.min}..${spec.max}`);
	}
	return problems;
}

/** The effect params written into a project: every slider + `look`. */
export function gradeEffectParams(params: Partial<GradeParams>, look: string): Record<string, number | string> {
	return { ...clampGradeParams(params), look };
}

/** Read a grade effect's params back (missing keys = neutral). */
export function readGradeParams(values: Readonly<Record<string, unknown>> | undefined): GradeParams {
	return clampGradeParams(values ?? {});
}

/** The look id whose params equal these (within rounding), or null. */
export function matchLook(params: Partial<GradeParams>): GradeLook | null {
	const current = clampGradeParams(params);
	for (const look of GRADE_LOOKS) {
		const target = lookParams(look);
		if (GRADE_PARAM_KEYS.every((key) => Math.abs(target[key] - current[key]) < 1e-6)) return look;
	}
	return null;
}

export function isNeutralGrade(params: Partial<GradeParams>): boolean {
	const current = clampGradeParams(params);
	return current.amount === 0 || GRADE_PARAM_KEYS.every((key) => key === "amount" || current[key] === NEUTRAL_GRADE[key]);
}

/**
 * What a person reads for a grade: "warm morning", "warm morning · edited", "custom", "none".
 */
export function gradeLabel(values: Readonly<Record<string, unknown>> | undefined): string {
	if (!values) return NO_GRADE;
	const params = readGradeParams(values);
	if (isNeutralGrade(params)) return NO_GRADE;
	const exact = matchLook(params);
	const strength = params.amount < 100 ? ` · ${Math.round(params.amount)} %` : "";
	if (exact) return `${exact.label}${strength}`;
	const lookId = typeof values.look === "string" ? values.look : "";
	const look = lookId && lookId !== CUSTOM_LOOK ? getGradeLook(lookId) : undefined;
	if (look) {
		const base = lookParams(look);
		const sameExceptAmount = GRADE_PARAM_KEYS.every((key) => key === "amount" || Math.abs(base[key] - params[key]) < 1e-6);
		return sameExceptAmount ? `${look.label}${strength}` : `${look.label} · edited`;
	}
	return CUSTOM_LOOK;
}

export type GradeUniformValue = number | number[];

/**
 * Shader uniforms for `restorff-grade` (rust/crates/effects/src/shaders/grade.wgsl header). `time` (seconds) seeds
 * the grain so it changes every frame; without it the grain is still.
 */
export function gradeUniforms(values: Readonly<Record<string, unknown>>, time = 0): Record<string, GradeUniformValue> {
	const p = readGradeParams(values);
	return {
		u_exposure: p.exposure,
		u_contrast: p.contrast / 100,
		u_saturation: 1 + p.saturation / 100,
		u_temperature: p.temperature / 100,
		u_tint: p.tint / 100,
		// shadows ±100 → lift ±0.25 (blacks up to 25 % grey); midtones ±100 → gamma 2^±1; highlights ±100 → gain 1 ± 0.5
		u_lift: (p.shadows / 100) * 0.25,
		u_gamma: 2 ** (p.midtones / 100),
		u_gain: 1 + (p.highlights / 100) * 0.5,
		u_vignette: p.vignette / 100,
		u_grain: p.grain / 100,
		u_grain_seed: Number.isFinite(time) ? time : 0,
		u_amount: p.amount / 100,
		u_split: [p.shadowHue / 360, p.shadowTint / 100, p.highlightHue / 360, p.highlightTint / 100],
	};
}

/** Words the MCP tool and the command bar can list. */
export function gradeVocabulary(): { looks: string[]; nudges: string[] } {
	return { looks: GRADE_LOOKS.map((look) => look.id), nudges: GRADE_NUDGES.map((nudge) => nudge.id) };
}
