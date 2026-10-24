/**
 * Runtime validator for ops@1 (no dependencies). Checks shape and ranges only; whether a target exists is the
 * reducer's job (a missing target is a conflict, not an invalid op).
 */
import { AUTHORS, OP_NAMES, type Op } from "./ops.ts";
import { gradeParamProblems } from "./grades.ts";

export interface ValidationError {
	index: number;
	path: string;
	message: string;
}

export interface ValidationResult {
	ok: boolean;
	errors: ValidationError[];
}

type Rule = (value: unknown) => string | null;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const num = (opts: { min?: number; max?: number; gt?: number; integer?: boolean } = {}): Rule => (value) => {
	if (!isFiniteNumber(value)) return "must be a finite number";
	if (opts.integer && !Number.isInteger(value)) return "must be an integer";
	if (opts.min !== undefined && value < opts.min) return `must be >= ${opts.min}`;
	if (opts.max !== undefined && value > opts.max) return `must be <= ${opts.max}`;
	if (opts.gt !== undefined && !(value > opts.gt)) return `must be > ${opts.gt}`;
	return null;
};

const str: Rule = (value) => (typeof value === "string" && value.length > 0 ? null : "must be a non-empty string");
const anyStr: Rule = (value) => (typeof value === "string" ? null : "must be a string");
const bool: Rule = (value) => (typeof value === "boolean" ? null : "must be a boolean");
const oneOf = (values: readonly string[]): Rule => (value) =>
	typeof value === "string" && values.includes(value) ? null : `must be one of ${values.join(", ")}`;
const paramValue: Rule = (value) =>
	isFiniteNumber(value) || typeof value === "string" || typeof value === "boolean"
		? null
		: "must be a number, string or boolean";
const time = num({ min: 0 });

const fpsRule: Rule = (value) => {
	if (isFiniteNumber(value)) return value > 0 && value <= 240 ? null : "fps must be in (0, 240]";
	if (typeof value === "object" && value !== null) {
		const rate = value as { numerator?: unknown; denominator?: unknown };
		if (Number.isInteger(rate.numerator) && Number.isInteger(rate.denominator)) {
			return (rate.numerator as number) > 0 && (rate.denominator as number) > 0
				? null
				: "numerator and denominator must be > 0";
		}
	}
	return "must be a number or {numerator, denominator}";
};

const STYLE_RULES: Record<string, Rule> = {
	font: str,
	size: num({ gt: 0 }),
	color: str,
	weight: oneOf(["normal", "bold"]),
	italic: bool,
	align: oneOf(["left", "center", "right"]),
	uppercase: bool,
	letter_spacing: num(),
	line_height: num({ gt: 0 }),
	bg: bool,
	bg_color: str,
	bg_radius: num({ min: 0, max: 100 }),
	bg_padding_x: num({ min: 0 }),
	bg_padding_y: num({ min: 0 }),
	x: num(),
	y: num(),
	opacity: num({ min: 0, max: 1 }),
};

const styleRule: Rule = (value) => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "must be an object";
	for (const [key, entry] of Object.entries(value)) {
		const rule = STYLE_RULES[key];
		if (!rule) return `unknown style key "${key}" (known: ${Object.keys(STYLE_RULES).join(", ")})`;
		const problem = rule(entry);
		if (problem) return `${key} ${problem}`;
	}
	return null;
};

const paramsRule: Rule = (value) => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "must be an object";
	for (const [key, entry] of Object.entries(value)) {
		const problem = paramValue(entry);
		if (problem) return `${key} ${problem}`;
	}
	return null;
};

const wordsRule: Rule = (value) => {
	if (!Array.isArray(value) || value.length === 0) return "must be a non-empty array of {text, start, end}";
	for (let i = 0; i < value.length; i++) {
		const word = value[i] as { text?: unknown; start?: unknown; end?: unknown };
		if (typeof word !== "object" || word === null) return `[${i}] must be an object`;
		if (typeof word.text !== "string") return `[${i}].text must be a string`;
		if (!isFiniteNumber(word.start) || word.start < 0) return `[${i}].start must be a number >= 0`;
		if (!isFiniteNumber(word.end) || !(word.end > word.start)) return `[${i}].end must be > start`;
		if (i > 0 && (word.start as number) < ((value[i - 1] as { start: number }).start)) {
			return `[${i}] words must be in time order`;
		}
	}
	return null;
};

const stringArray: Rule = (value) =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)
		? null
		: "must be an array of non-empty strings";

// grade agent, 2026-10-20: grade sliders (./grades.ts GRADE_PARAM_SPECS — names and ranges)
const gradeParamsRule: Rule = (value) => {
	const problems = gradeParamProblems(value);
	return problems.length ? problems.join("; ") : null;
};

const objectRule: Rule = (value) =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? null : "must be an object";

/** [[start, end], …] in seconds, start ≥ 0, end > start. */
const spansRule: Rule = (value) => {
	if (!Array.isArray(value)) return "must be an array of [start, end] seconds";
	for (let i = 0; i < value.length; i++) {
		const span = value[i];
		if (!Array.isArray(span) || span.length !== 2 || !isFiniteNumber(span[0]) || !isFiniteNumber(span[1])) {
			return `[${i}] must be [start, end]`;
		}
		if (span[0] < 0 || !(span[1] > span[0])) return `[${i}] needs 0 <= start < end`;
	}
	return null;
};

const ascendingTimes: Rule = (value) => {
	if (!Array.isArray(value)) return "must be an array of seconds";
	for (let i = 0; i < value.length; i++) {
		if (!isFiniteNumber(value[i]) || value[i] < 0) return `[${i}] must be a number >= 0`;
		if (i > 0 && value[i] <= value[i - 1]) return `[${i}] times must ascend`;
	}
	return null;
};

const indexArray: Rule = (value) =>
	Array.isArray(value) && value.every((entry) => Number.isInteger(entry) && entry >= 0)
		? null
		: "must be an array of integers >= 0";

interface OpSchema {
	required: Record<string, Rule>;
	optional?: Record<string, Rule>;
	check?: (op: Record<string, unknown>) => string | null;
}

const SCHEMAS: Record<string, OpSchema> = {
	set_canvas: {
		required: {},
		optional: { w: num({ min: 16, max: 8192, integer: true }), h: num({ min: 16, max: 8192, integer: true }), fps: fpsRule, background: str },
		check: (op) => (op.w === undefined && op.h === undefined && op.fps === undefined && op.background === undefined
			? "needs at least one of w, h, fps, background"
			: (op.w === undefined) !== (op.h === undefined) ? "w and h go together" : null),
	},
	add_size_variant: { required: { aspect: str, reframe: oneOf(["auto", "keyframes"]) } },
	import_media: {
		required: { kind: oneOf(["video", "audio", "image"]) },
		optional: {
			blob_sha: str, url: str, name: str, duration: num({ gt: 0 }), width: num({ gt: 0, integer: true }),
			height: num({ gt: 0, integer: true }), fps: num({ gt: 0 }), has_audio: bool, ref: str,
		},
		check: (op) => (op.blob_sha === undefined && op.url === undefined ? "needs blob_sha or url" : null),
	},
	add_track: {
		required: { kind: oneOf(["video", "audio", "text", "caption", "overlay", "effect"]) },
		optional: { name: str, index: num({ min: 0, integer: true }), ref: str },
	},
	remove_track: { required: { track: str } },
	reorder_tracks: { required: { order: stringArray } },
	insert: {
		required: { track: str, t: time },
		optional: {
			media: str, media_kind: oneOf(["video", "audio", "image"]), text: anyStr,
			shape: oneOf(["rectangle", "ellipse", "star", "polygon"]), in: time, out: num({ gt: 0 }), dur: num({ gt: 0 }),
			name: str, params: paramsRule, style: styleRule, ref: str,
		},
		check: (op) => {
			const sources = ["media", "text", "shape"].filter((key) => op[key] !== undefined);
			if (sources.length !== 1) return "needs exactly one of media, text, shape";
			if (op.in !== undefined && op.out !== undefined && !((op.out as number) > (op.in as number))) return "out must be > in";
			if (op.text !== undefined && (op.text as string).trim() === "") return "text must not be blank";
			return null;
		},
	},
	move: { required: { el: str, t: time }, optional: { track: str } },
	trim: {
		required: { el: str },
		optional: { in: time, out: num({ gt: 0 }) },
		check: (op) => {
			if (op.in === undefined && op.out === undefined) return "needs in and/or out";
			if (op.in !== undefined && op.out !== undefined && !((op.out as number) > (op.in as number))) return "out must be > in";
			return null;
		},
	},
	split: { required: { el: str, t: time }, optional: { ref: str } },
	delete: { required: { el: str } },
	ripple_delete: { required: { el: str }, optional: { scope: oneOf(["track", "all"]) } },
	set: {
		required: { prop: str, value: paramValue },
		optional: { el: str, track: str },
		check: (op) => ((op.el === undefined) === (op.track === undefined) ? "needs exactly one of el, track" : null),
	},
	keyframe: {
		required: { el: str, prop: str, t: num(), value: num() },
		optional: { ease: oneOf(["linear", "hold", "bezier", "ease_in", "ease_out", "ease_in_out"]), local: bool },
		check: (op) => (op.local !== true && (op.t as number) < 0 ? "t must be >= 0" : null),
	},
	add_captions: {
		required: { words: wordsRule },
		optional: { track: str, style: styleRule, max_words: num({ min: 1, max: 3, integer: true }), gap: num({ min: 0 }), ref: str },
	},
	set_caption_style: { required: { style: styleRule }, optional: { track: str } },
	text_pop: {
		required: { t: time, text: str },
		optional: { style: styleRule, dur: num({ gt: 0 }), track: str, ref: str },
	},
	transition: { required: { a: str, b: str, kind: str }, optional: { dur: num({ gt: 0, max: 10 }) } },
	gain: { required: { el: str, db: num({ min: -60, max: 20 }) } },
	duck: {
		required: { track: str, under: str, amount_db: num({ min: -60, max: 60 }) },
		optional: { attack_ms: num({ min: 0, max: 5000 }), release_ms: num({ min: 0, max: 10000 }), spans: spansRule },
	},
	beats: {
		required: { el: str, bpm: num({ min: 20, max: 400 }), times: ascendingTimes },
		optional: { downbeats: indexArray, source: oneOf(["detected", "board", "manual"]) },
	},
	snap_cuts: { optional: { track: str, max_shift: num({ gt: 0, max: 2 }) }, required: {} },
	sfx: {
		required: { t: time, name: str },
		optional: { media: str, url: str, dur: num({ gt: 0 }), track: str, db: num({ min: -60, max: 20 }), ref: str },
		check: (op) => (op.url !== undefined && op.dur === undefined ? "a library url needs dur" : null),
	},
	normalize: { required: { lufs: num({ min: -40, max: -5 }), true_peak: num({ min: -9, max: 0 }) } },
	grade: {
		required: { target: str },
		optional: { preset: str, lut: str, params: gradeParamsRule },
		check: (op) =>
			op.preset === undefined && op.lut === undefined && op.params === undefined ? "needs preset, params or lut" : null,
	},
	apply_style: { required: { preset_id: str }, optional: { params: objectRule } },
	mark: { required: { t: time, note: anyStr }, optional: { color: str, dur: num({ gt: 0 }) } },
};

const COMMON: Record<string, Rule> = { op: oneOf(OP_NAMES), author: oneOf(AUTHORS), note: anyStr };

export function validateOp(value: unknown, index = 0): ValidationError[] {
	const errors: ValidationError[] = [];
	const push = (path: string, message: string) => errors.push({ index, path, message });
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		push("", "an op must be an object");
		return errors;
	}
	const op = value as Record<string, unknown>;
	for (const key of ["op", "author"]) {
		if (op[key] === undefined) push(key, "is required");
		else {
			const problem = COMMON[key](op[key]);
			if (problem) push(key, problem);
		}
	}
	if (errors.length) return errors;
	const schema = SCHEMAS[op.op as string];
	for (const [key, rule] of Object.entries(schema.required)) {
		if (op[key] === undefined) push(key, "is required");
		else {
			const problem = rule(op[key]);
			if (problem) push(key, problem);
		}
	}
	for (const [key, entry] of Object.entries(op)) {
		if (key === "op" || key === "author" || key in schema.required) continue;
		if (key === "note") {
			const problem = COMMON.note(entry);
			if (problem) push(key, problem);
			continue;
		}
		const rule = schema.optional?.[key];
		if (!rule) {
			push(key, `unknown field for ${op.op as string}`);
			continue;
		}
		if (entry === undefined) continue;
		const problem = rule(entry);
		if (problem) push(key, problem);
	}
	if (!errors.length && schema.check) {
		const problem = schema.check(op);
		if (problem) push("", problem);
	}
	return errors;
}

export function validateOps(value: unknown): ValidationResult {
	if (!Array.isArray(value)) return { ok: false, errors: [{ index: -1, path: "", message: "ops must be an array" }] };
	const errors = value.flatMap((op, index) => validateOp(op, index));
	return { ok: errors.length === 0, errors };
}

/**
 * mcp-discover (wave 5, 2026-10-20): the per-op field rules, read only, so the MCP op reference
 * (`timeline_ops {action: "reference"}`, apps/web/src/mcp/ops-reference.ts) is generated from this validator and
 * can't drift from it. Each rule returns null for a valid value, else the problem ("must be …").
 */
export interface OpFieldRules {
	required: Readonly<Record<string, (value: unknown) => string | null>>;
	optional: Readonly<Record<string, (value: unknown) => string | null>>;
	check?: (op: Record<string, unknown>) => string | null;
}

export function opFieldRules(op: string): OpFieldRules | null {
	const schema = Object.hasOwn(SCHEMAS, op) ? SCHEMAS[op] : undefined;
	return schema ? { required: schema.required, optional: schema.optional ?? {}, check: schema.check } : null;
}

/** Narrowing helper: throws with every problem listed. */
export function assertOps(value: unknown): asserts value is Op[] {
	const result = validateOps(value);
	if (!result.ok) {
		throw new Error(
			`invalid ops@1 batch:\n${result.errors.map((e) => `  op[${e.index}]${e.path ? `.${e.path}` : ""}: ${e.message}`).join("\n")}`,
		);
	}
}
