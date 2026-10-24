/**
 * The ops@1 reference over MCP (mcp-discover, wave 5, 2026-10-20; recreations SUMMARY gap 1).
 *
 * Why: in all five recreations `timeline_ops.ops` was `items: object`; the field names were found by trial (`el` on
 * the 9th probe), errors named the wrong field but never the right one, and `next` pointed at repo files a remote
 * Claude can't read. This file answers `timeline_ops {action: "reference", op?}`, builds the per-op `oneOf` schema for
 * `timeline_ops.ops`, and explains an invalid batch (allowed + required fields, a did-you-mean, an example).
 *
 * Generated from the validator so it can't drift: field names, required vs optional, types and ranges come from
 * `opFieldRules(op)` (packages/timeline-ops/src/validate.ts) by probing each rule; the cross-field rule from
 * `check({})`. Only the one-line meanings (units, what an id is) and the examples are written here, and the test
 * (server/__tests__/mcp-discover.test.ts) fails if a documented field is not in the validator, a validator field has
 * no meaning, an op has no example, or an example does not validate.
 */
import { GRADE_LOOKS, GRADE_NUDGES, OP_NAMES, OPS_VERSION, opFieldRules, TRANSITION_KINDS, validateOp, type ValidationError } from "@restorffcut/timeline-ops";
import type { JsonSchema, Payload } from "./protocol";

type OpName = (typeof OP_NAMES)[number];
type Rule = (value: unknown) => string | null;

// ─── what each field means (units, ids); types and ranges come from the validator ───────────────────────────────

const EL = "an element id from timeline summary / element (or a ref made earlier in this batch)";
const TRACK = 'a track id from timeline summary, "main" for the A-roll track, a ref from add_track in this batch, or an unambiguous track name ("MUSIC", "V2 B-ROLL")';
const T = "timeline time, seconds (exact values from summary, e.g. 4.533333)";
const STYLE = "text style: font, size (editor units: px = size × canvas height / 90), color, weight, italic, align, uppercase, letter_spacing, line_height, bg (box), bg_color, bg_radius, bg_padding_x, bg_padding_y, x / y (canvas px from the centre, y down), opacity (0–1)";
const SET_PROPS =
	"on an element: x · y (canvas px from the centre, y down) · scale (1 = 100 %) · scale_x · scale_y · rotation (degrees) · opacity (0–1) · volume (dB) · muted · blend · text · font · font_size · color · align · weight · name · hidden · speed (video/audio playback rate) · source_audio · or any raw key from timeline element's params; on a track (with track instead of el): name · muted · hidden";
const KEYFRAME_PROPS = "x · y · scale · rotation · opacity · volume, or a raw animatable param key";

export interface OpDoc {
	what: string;
	fields: Record<string, string>;
	example: Record<string, unknown>;
	notes?: string[];
}

export const OP_DOCS: Record<OpName, OpDoc> = {
	set_canvas: {
		what: "Change the canvas size, frame rate or background colour.",
		fields: { w: "canvas width, px (give h with it)", h: "canvas height, px", fps: "frames per second (30, 29.97, 24…) or {numerator, denominator}", background: "a CSS colour" },
		example: { op: "set_canvas", w: 1080, h: 1920 },
	},
	add_size_variant: {
		what: "Ask for another size (4:5, 1:1, 16:9). Kept as a pending instruction; over MCP use cutout reframe for a real reframed timeline.",
		fields: { aspect: '"4:5", "1:1" or "16:9"', reframe: "auto (face-aware) or keyframes" },
		example: { op: "add_size_variant", aspect: "4:5", reframe: "auto" },
	},
	import_media: {
		what: "Add a file to the project's media list (no clip yet). Over MCP prefer the media tool: it uploads, probes and places in one call.",
		fields: {
			kind: "video, audio or image",
			blob_sha: "sha256 of a file already in the server's media store",
			url: "where the file is",
			name: "a display name",
			duration: "length in seconds",
			width: "px",
			height: "px",
			fps: "frames per second",
			has_audio: "the video has a sound track",
			ref: "a name for it inside this batch (insert's media can use it)",
		},
		example: { op: "import_media", kind: "image", url: "https://example.com/halcyon-bottle.png", name: "halcyon-bottle.png", ref: "bottle" },
	},
	add_track: {
		what: "Add a lane. Visual lanes go on top by default, audio at the bottom; the answer's refs map your ref to the new track id.",
		fields: { kind: "video, audio, text, caption, overlay or effect", name: "the lane's name", index: "position in its group, 0 = top", ref: "a name for it inside this batch (later ops' track can use it)" },
		example: { op: "add_track", kind: "text", name: "TITLES", ref: "titles" },
	},
	remove_track: {
		what: "Remove a lane and everything on it.",
		fields: { track: TRACK },
		example: { op: "remove_track", track: "<track id>" },
	},
	reorder_tracks: {
		what: "Set the order of the overlay and audio lanes.",
		fields: { order: 'every overlay and audio track id, top to bottom ("main" may appear; overlays stay above it)' },
		example: { op: "reorder_tracks", order: ["<text track id>", "<overlay track id>", "main", "<music track id>"] },
	},
	insert: {
		what: "Put a clip, a text or a shape on a track at t. Exactly one of media, text, shape.",
		fields: {
			track: TRACK,
			t: `${T}: where it starts`,
			media: "a media id (media list / summary) or an import_media ref",
			media_kind: "video, audio or image (when media is not in this project's media list)",
			text: "the words of a text element",
			shape: "rectangle, ellipse, star or polygon",
			in: "source in-point, seconds into the file (video/audio)",
			out: "source out-point, seconds into the file (video/audio)",
			dur: "length on the timeline, seconds (images, text, shapes; or video/audio without out)",
			name: "a display name",
			params: 'raw editor params set after the defaults, e.g. {"transform.positionY": -600}',
			style: STYLE,
			ref: "a name for the new element inside this batch",
		},
		example: { op: "insert", track: "<text track id>", t: 2.5, text: "COLD BREW", dur: 1.5, style: { size: 12, color: "#EDEBE6", weight: "bold", y: -600 } },
	},
	move: {
		what: "Move an element to a new start time (and optionally to another track). Times must not overlap another element on that track.",
		fields: { el: EL, t: `${T}: the new start`, track: `move onto this track: ${TRACK}` },
		example: { op: "move", el: "<element id>", t: 4.533333 },
	},
	trim: {
		what: "Change a clip's source in/out points; the kept frames stay where they are on the timeline.",
		fields: { el: EL, in: "new source in-point, seconds into the file", out: "new source out-point, seconds into the file" },
		example: { op: "trim", el: "<element id>", in: 0.5, out: 6 },
	},
	split: {
		what: "Cut an element in two at t; the left piece keeps the id, the right piece gets a new id (refs[ref]).",
		fields: { el: EL, t: `${T}: inside the element`, ref: "a name for the right-hand piece inside this batch" },
		example: { op: "split", el: "<element id>", t: 8.52, ref: "right" },
	},
	delete: {
		what: "Remove an element (leaves a gap).",
		fields: { el: EL },
		example: { op: "delete", el: "<element id>" },
	},
	ripple_delete: {
		what: "Remove an element and close the gap.",
		fields: { el: EL, scope: "track (default: only its own track closes up) or all (every track)" },
		example: { op: "ripple_delete", el: "<element id>", scope: "track" },
	},
	set: {
		what: "Set one property of an element (el) or a track (track). Exactly one of el, track.",
		fields: { el: EL, track: TRACK, prop: SET_PROPS, value: "a number, string or boolean" },
		example: { op: "set", el: "<element id>", prop: "y", value: -600 },
		notes: [
			"To change a caption's words: set {el, prop: \"text\", value} on the CAPTIONS chunk and its CAPTION SHADOW twin; CAPTION WORDS has one element per word — set only the words that change (a whole chunk's text there garbles the karaoke). To add or drop words, rebuild with the captions tool.",
		],
	},
	keyframe: {
		what: "One keyframe: prop = value at time t. An animation is two or more keyframe ops (start value, end value).",
		fields: {
			el: EL,
			prop: KEYFRAME_PROPS,
			t: `${T} (or seconds from the element's start with local: true)`,
			value: "the value at t (same units as set)",
			ease: "how the value arrives at this key from the previous one: linear, hold, bezier, ease_in, ease_out, ease_in_out",
			local: "true: t is seconds from the element's start",
		},
		example: { op: "keyframe", el: "<element id>", prop: "scale", t: 3, value: 1.1, ease: "ease_out" },
	},
	add_captions: {
		what: "Caption words onto a text track. Over MCP prefer the captions tool (styles, measured layout, karaoke).",
		fields: {
			words: "[{text, start, end}] with start/end in timeline seconds, in time order",
			track: `${TRACK} (omitted: a new caption track on top)`,
			style: STYLE,
			max_words: "words per caption chunk",
			gap: "a pause longer than this many seconds starts a new chunk",
			ref: "a name for the caption track inside this batch",
		},
		example: { op: "add_captions", words: [{ text: "Steeped", start: 0.4, end: 0.8 }, { text: "slow.", start: 0.8, end: 1.3 }], max_words: 2 },
	},
	set_caption_style: {
		what: "Restyle a caption track (all of it).",
		fields: { style: STYLE, track: `${TRACK} (omitted: every caption track)` },
		example: { op: "set_caption_style", track: "<caption track id>", style: { size: 6, color: "#FFFFFF" } },
	},
	text_pop: {
		what: "A short title that pops in and out at t.",
		fields: { t: T, text: "the words", style: STYLE, dur: "seconds on screen (default 1.2)", track: TRACK, ref: "a name for it inside this batch" },
		example: { op: "text_pop", t: 1.2, text: "18 HOURS", dur: 1.2 },
	},
	transition: {
		what: "A transition on the cut between two clips that touch on the same track (a ends where b starts).",
		fields: {
			a: `the outgoing clip: ${EL}`,
			b: `the incoming clip: ${EL}`,
			kind: `one of ${Object.keys(TRANSITION_KINDS).join(", ")} (or cut / match = none)`,
			dur: "seconds, centred on the cut (default: the kind's own)",
		},
		example: { op: "transition", a: "<clip before the cut>", b: "<clip after the cut>", kind: "whip-left", dur: 0.3 },
	},
	gain: {
		what: "Set a clip's level.",
		fields: { el: EL, db: "absolute level in dB" },
		example: { op: "gain", el: "<element id>", db: -6 },
	},
	duck: {
		what: "Make a track quieter under another (music under the voice).",
		fields: {
			track: `the track that gets quieter (music): ${TRACK}`,
			under: `the track it ducks under (voice): ${TRACK}`,
			amount_db: "how much quieter, dB (sign ignored)",
			attack_ms: "fade-down time, ms",
			release_ms: "fade-up time, ms",
			spans: "[[start, end], …] timeline seconds where the voice speaks (default: every element on under)",
		},
		example: { op: "duck", track: "<music track id>", under: "main", amount_db: 10 },
	},
	sfx: {
		what: "A sound effect at t. Over MCP prefer the sounds tool (a generated pack, placed by name).",
		fields: { t: T, name: "what it is (whoosh, pop…)", media: "a media id or ref", url: "a library URL (needs dur)", dur: "seconds", track: TRACK, db: "level, dB", ref: "a name for it inside this batch" },
		example: { op: "sfx", t: 3.07, name: "whoosh", media: "<audio media id>" },
	},
	normalize: {
		what: "Record the loudness target (render masters to it).",
		fields: { lufs: "integrated loudness, LUFS", true_peak: "true-peak ceiling, dBTP" },
		example: { op: "normalize", lufs: -14, true_peak: -1 },
	},
	grade: {
		what: 'A real GPU colour grade on an element, a track, "main" (every clip on it) or "all" (a GRADE layer under the captions).',
		fields: {
			target: 'an element id, a track id, "main" or "all"',
			preset: `a look (${GRADE_LOOKS.map((look) => look.id).join(", ")}), a nudge (${GRADE_NUDGES.map((nudge) => nudge.id).join(", ")}) or "none"`,
			params: "slider values applied after the preset",
			lut: "a LUT name (kept as a pending instruction)",
		},
		example: { op: "grade", target: "all", preset: "warm-morning" },
	},
	apply_style: {
		what: "Apply an editing style (captions, pacing, grade) by id. styles list shows the ids.",
		fields: { preset_id: "restorff/style/<id> (styles list)", params: "style options" },
		example: { op: "apply_style", preset_id: "restorff/style/moody-captions" },
	},
	mark: {
		what: "A marker (bookmark) on the timeline with a note.",
		fields: { t: T, note: "the note", color: "a CSS colour", dur: "seconds (a range marker)" },
		example: { op: "mark", t: 12.4, note: "music hit here" },
	},
	beats: {
		what: "Record a music clip's beats (for cutting on the beat).",
		fields: { el: `the music element: ${EL}`, bpm: "beats per minute", times: "beat times, SOURCE seconds into the music file, ascending", downbeats: "indices into times that start a bar", source: "detected, board or manual" },
		example: { op: "beats", el: "<music element id>", bpm: 100, times: [0.3, 0.9, 1.5, 2.1], downbeats: [0] },
	},
	snap_cuts: {
		what: "Move the cuts of a track onto the nearest beat (beats op first).",
		fields: { track: `${TRACK} (default main)`, max_shift: "largest move per cut, seconds" },
		example: { op: "snap_cuts", track: "main", max_shift: 0.2 },
	},
};

const COMMON_DOCS = {
	op: "the op's name",
	author: "user · claude · compiler · preset — optional over MCP (filled with claude)",
	note: "free text kept in the change log",
};

export const ID_FIELDS = {
	el: EL,
	track: TRACK,
	under: "a track id (duck: the voice track)",
	a: "an element id (transition: the clip before the cut)",
	b: "an element id (transition: the clip after the cut)",
	target: 'grade: an element id, a track id, "main" or "all"',
	media: "a media id (timeline summary elements' media / media list) or an import_media ref",
	order: "track ids (reorder_tracks)",
	ref: "a name you give a new thing inside one batch; later ops in the same batch use it as an id; the answer's refs map it to the real id",
};

// ─── probing the validator's rules ─────────────────────────────────────────────────────────────────────────────

export interface FieldSpec {
	field: string;
	type: string;
	required: boolean;
	means: string;
	schema: JsonSchema;
}

const BIG = 1e15;

function numberSpec(rule: Rule): { text: string; schema: JsonSchema } {
	const integer = rule(0.5) === "must be an integer";
	const low = rule(-BIG);
	const high = rule(BIG);
	const schema: JsonSchema = { type: integer ? "integer" : "number" };
	const parts = [integer ? "integer" : "number"];
	const min = /must be >= (-?[\d.e+]+)/.exec(low ?? "");
	const gt = /must be > (-?[\d.e+]+)/.exec(low ?? "");
	const max = /must be <= (-?[\d.e+]+)/.exec(high ?? "");
	if (min) {
		schema.minimum = Number(min[1]);
		parts.push(`>= ${min[1]}`);
	}
	if (gt) {
		schema.exclusiveMinimum = Number(gt[1]);
		parts.push(`> ${gt[1]}`);
	}
	if (max) {
		schema.maximum = Number(max[1]);
		parts.push(`<= ${max[1]}`);
	}
	// gt with a max (num({gt, max})): the max check fires first on BIG; probe the lower bound just above 0 too
	if (!gt && !min && rule(0) && /must be > (-?[\d.e+]+)/.test(rule(0) ?? "")) {
		const value = Number(/must be > (-?[\d.e+]+)/.exec(rule(0) ?? "")?.[1]);
		schema.exclusiveMinimum = value;
		parts.push(`> ${value}`);
	}
	return { text: parts.join(", "), schema };
}

/** The validator's own words for a rule, turned into a type line and a JSON Schema. */
export function describeRule(rule: Rule): { text: string; schema: JsonSchema } {
	const nan = rule(Number.NaN) ?? "";
	const what = nan.replace(/^(params )?must be /, "");
	if (what === "a finite number") return numberSpec(rule);
	if (what === "a non-empty string") return { text: "string (not empty)", schema: { type: "string", minLength: 1 } };
	if (what === "a string") return { text: "string", schema: { type: "string" } };
	if (what === "a boolean") return { text: "boolean", schema: { type: "boolean" } };
	const choice = /^one of (.+)$/.exec(what);
	if (choice) {
		const values = choice[1].split(", ");
		return { text: `one of ${values.join(" | ")}`, schema: { type: "string", enum: values } };
	}
	if (what === "a number, string or boolean") return { text: "number | string | boolean", schema: { type: ["number", "string", "boolean"] } };
	if (what === "a number or {numerator, denominator}") return { text: "number or {numerator, denominator}", schema: { type: ["number", "object"] } };
	if (what === "an object") {
		const probe = rule({ __probe__: 1 }) ?? "";
		const known = /\(known: ([^)]+)\)/.exec(probe);
		if (known) {
			const keys = known[1].split(", ");
			return { text: `object with keys ${keys.join(", ")}`, schema: { type: "object", properties: Object.fromEntries(keys.map((key) => [key, {}])) } };
		}
		return { text: "object", schema: { type: "object" } };
	}
	if (what.startsWith("a non-empty array of {")) {
		const keys = /\{([^}]+)\}/.exec(what)?.[1].split(", ") ?? [];
		return {
			text: `array of {${keys.join(", ")}} (at least one)`,
			schema: { type: "array", minItems: 1, items: { type: "object", properties: Object.fromEntries(keys.map((key) => [key, {}])), required: keys } },
		};
	}
	if (what === "an array of non-empty strings") return { text: "array of strings", schema: { type: "array", items: { type: "string", minLength: 1 } } };
	if (what === "an array of [start, end] seconds") return { text: "array of [start, end] (seconds)", schema: { type: "array", items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 } } };
	if (what === "an array of seconds") return { text: "array of seconds, ascending", schema: { type: "array", items: { type: "number", minimum: 0 } } };
	if (what === "an array of integers >= 0") return { text: "array of integers >= 0", schema: { type: "array", items: { type: "integer", minimum: 0 } } };
	return { text: what || "any", schema: {} };
}

export function fieldsOf(op: string): { required: FieldSpec[]; optional: FieldSpec[]; rule: string | null } | null {
	const rules = opFieldRules(op);
	if (!rules) return null;
	const docs = (OP_DOCS as Record<string, OpDoc>)[op]?.fields ?? {};
	const spec = (field: string, rule: Rule, required: boolean): FieldSpec => {
		const { text, schema } = describeRule(rule);
		const means = docs[field] ?? "";
		return { field, type: text, required, means, schema: { ...schema, ...(means ? { description: means } : {}) } };
	};
	return {
		required: Object.entries(rules.required).map(([field, rule]) => spec(field, rule, true)),
		optional: Object.entries(rules.optional).map(([field, rule]) => spec(field, rule, false)),
		rule: rules.check ? rules.check({}) : null,
	};
}

// ─── the reference answer ───────────────────────────────────────────────────────────────────────────────────────

export function opReference(op: string) {
	const fields = fieldsOf(op);
	const doc = (OP_DOCS as Record<string, OpDoc>)[op];
	if (!fields || !doc) return null;
	const line = (spec: FieldSpec) => ({ field: spec.field, type: spec.type, ...(spec.means ? { means: spec.means } : {}) });
	return {
		op,
		what: doc.what,
		required: fields.required.map(line),
		optional: fields.optional.map(line),
		...(fields.rule ? { rule: fields.rule } : {}),
		example: doc.example,
		...(doc.notes ? { notes: doc.notes } : {}),
	};
}

export const REFERENCE_RULES = [
	"Times are seconds (numbers like 4.533333). Use the exact values timeline summary / element print; never ticks.",
	"el is an element id, track is a track id (or \"main\"); take both from timeline summary. A ref is a name you give a new thing so later ops in the same batch can use it.",
	"One batch = one commit, applied in order; every op must succeed or nothing is committed. dry_run: true shows what each op would do.",
	"author is filled in (claude); note is free text for the change log.",
	"Not sure of a field? timeline_ops {action: \"reference\", op: \"<name>\"}.",
];

/** `timeline_ops {action: "reference", op?}`. Unknown op → the closest names. */
export function referencePayload(op?: string): Payload {
	if (op) {
		const one = opReference(op);
		if (!one) {
			const close = closestOps(op);
			return {
				error: { code: "unknown_op", message: `No op "${op}". ops@1 has: ${OP_NAMES.join(", ")}.`, did_you_mean: close },
				next: { do: close.length ? `Read ${close[0]}.` : "Read the whole reference.", tool: "timeline_ops", arguments: { action: "reference", ...(close[0] ? { op: close[0] } : {}) } },
			};
		}
		return {
			ops_version: OPS_VERSION,
			...one,
			common: COMMON_DOCS,
			rules: REFERENCE_RULES,
			next: {
				do: "Fill the example with real ids and times from timeline summary (replace every <…>), add timeline_id, base_commit (the summary's head) and a one-line message, dry_run it, then send the same call without dry_run.",
				tool: "timeline_ops",
				arguments: { ops: [one.example], dry_run: true },
			},
		};
	}
	return {
		ops_version: OPS_VERSION,
		rules: REFERENCE_RULES,
		common: COMMON_DOCS,
		id_fields: ID_FIELDS,
		ops: OP_NAMES.map((name) => {
			const fields = fieldsOf(name);
			const doc = OP_DOCS[name];
			return {
				op: name,
				what: doc.what,
				required: fields?.required.map((spec) => spec.field) ?? [],
				optional: fields?.optional.map((spec) => spec.field) ?? [],
				...(fields?.rule ? { rule: fields.rule } : {}),
				example: doc.example,
			};
		}),
		next: { do: "Read one op in full (field types, units, ranges).", tool: "timeline_ops", arguments: { action: "reference", op: "move" } },
	};
}

/** The per-op schemas for timeline_ops.ops.items (oneOf keyed by `op`). */
export function opsItemSchema(): JsonSchema {
	return {
		type: "object",
		description: 'One ops@1 operation; "op" picks which. Field meanings, units and an example per op: timeline_ops {action: "reference", op}.',
		oneOf: OP_NAMES.map((name) => {
			const fields = fieldsOf(name);
			const properties: Record<string, JsonSchema> = { op: { const: name }, author: { type: "string", enum: ["user", "claude", "compiler", "preset"] }, note: { type: "string" } };
			for (const spec of [...(fields?.required ?? []), ...(fields?.optional ?? [])]) {
				// keep the schema small: types and ranges here; the long meanings are in the reference
				const { description: _description, ...schema } = spec.schema;
				properties[spec.field] = schema;
			}
			return { type: "object", title: name, description: OP_DOCS[name].what, properties, required: ["op", ...(fields?.required.map((spec) => spec.field) ?? [])] };
		}),
	};
}

// ─── explaining an invalid batch ────────────────────────────────────────────────────────────────────────────────

/** Words models used for fields, from the recreations' probes (and the obvious ones). Only offered if allowed. */
const FIELD_SYNONYMS: Record<string, string[]> = {
	el: ["target", "element", "element_id", "elementId", "id", "clip", "clip_id", "item", "el_id"],
	track: ["track_id", "trackId", "lane", "layer", "to_track"],
	t: ["start", "time", "at", "start_s", "time_s", "t_s", "position", "start_time", "seconds"],
	dur: ["duration", "duration_s", "length", "dur_s"],
	in: ["in_s", "source_in", "trim_start", "start_in"],
	out: ["out_s", "source_out", "trim_end", "end_in"],
	prop: ["property", "param", "key", "field", "name_of"],
	value: ["val", "to", "new_value", "v"],
	text: ["content", "words", "caption"],
	kind: ["type", "transition", "effect"],
	preset_id: ["style", "style_id", "preset"],
	note: ["comment", "label"],
	a: ["from", "left", "out_clip"],
	b: ["to", "right", "in_clip"],
	db: ["gain", "volume", "level"],
	amount_db: ["amount", "db"],
	target: ["el", "element", "track"],
	media: ["media_id", "mediaId", "file", "src"],
};

const OP_SYNONYMS: Record<string, OpName> = {
	remove: "delete",
	del: "delete",
	remove_element: "delete",
	cut: "split",
	razor: "split",
	add: "insert",
	add_clip: "insert",
	place: "insert",
	add_element: "insert",
	add_text: "text_pop",
	title: "text_pop",
	update: "set",
	set_prop: "set",
	transform: "set",
	position: "set",
	animate: "keyframe",
	keyframes: "keyframe",
	fade: "transition",
	crossfade: "transition",
	dissolve: "transition",
	volume: "gain",
	captions: "add_captions",
	caption: "add_captions",
	marker: "mark",
	bookmark: "mark",
	color: "grade",
	colour: "grade",
	lut: "grade",
	style: "apply_style",
	canvas: "set_canvas",
	resize: "set_canvas",
	ripple: "ripple_delete",
	trim_clip: "trim",
};

function editDistance(a: string, b: string): number {
	const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
	for (let j = 1; j <= b.length; j++) dp[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
	}
	return dp[a.length][b.length];
}

export function closestOps(name: string): string[] {
	const lower = name.toLowerCase().trim();
	const synonym = OP_SYNONYMS[lower];
	const near = OP_NAMES.filter((candidate) => editDistance(lower, candidate) <= 2 || candidate.includes(lower) || (lower.length > 3 && lower.includes(candidate)));
	return [...new Set([...(synonym ? [synonym] : []), ...near])].slice(0, 3);
}

/** Shapes models tried that have no single-field answer (paper-collage n 66: keyframe {keys: [[t, v], …]}). */
const SHAPE_HINTS: Record<string, Record<string, string>> = {
	keyframe: {
		keys: "t + value: ONE keyframe per op — send one keyframe op per key",
		keyframes: "t + value: ONE keyframe per op — send one keyframe op per key",
		from: "t + value (two keyframe ops: the start value, then the end value)",
		to: "t + value (two keyframe ops: the start value, then the end value)",
	},
	set: { props: "prop + value: ONE property per set op", values: "prop + value: ONE property per set op" },
};

export function closestField(op: string, field: string): string | null {
	const shape = SHAPE_HINTS[op]?.[field];
	if (shape) return shape;
	const fields = fieldsOf(op);
	if (!fields) return null;
	const allowed = [...fields.required, ...fields.optional].map((spec) => spec.field);
	for (const [canonical, words] of Object.entries(FIELD_SYNONYMS)) {
		if (allowed.includes(canonical) && words.includes(field)) return canonical;
	}
	const near = allowed.filter((candidate) => editDistance(field.toLowerCase(), candidate) <= Math.min(2, Math.floor(candidate.length / 2)));
	return near[0] ?? null;
}

export interface ExplainedError extends ValidationError {
	op: string | null;
	did_you_mean?: string;
	allowed?: string[];
	required?: string[];
}

/** An invalid batch → errors that name the allowed and required fields, a message that says the fix, the reference. */
export function explainInvalidOps(ops: unknown[], errors: ValidationError[]) {
	const named = (index: number) => {
		const op = ops[index] as { op?: unknown } | undefined;
		return typeof op?.op === "string" ? op.op : null;
	};
	const explained: ExplainedError[] = errors.map((error) => {
		const op = named(error.index);
		const fields = op ? fieldsOf(op) : null;
		const out: ExplainedError = { ...error, op };
		if (error.path === "op") {
			const close = op ? closestOps(op) : [];
			if (close.length) out.did_you_mean = close[0];
			out.allowed = [...OP_NAMES];
			return out;
		}
		if (!fields) return out;
		out.required = fields.required.map((spec) => spec.field);
		out.allowed = [...out.required, ...fields.optional.map((spec) => spec.field), "note", "author"];
		if (error.message.startsWith("unknown field")) {
			const close = closestField(op as string, error.path);
			if (close) out.did_you_mean = close;
		}
		return out;
	});
	const ops_involved = [...new Set(explained.map((error) => error.op).filter((op): op is string => Boolean(op && fieldsOf(op))))];
	const sentences = explained.slice(0, 4).map((error) => {
		const where = `op[${error.index}]${error.op ? ` ${error.op}` : ""}`;
		if (error.path === "op") return `${where}: "op" ${error.message}${error.did_you_mean ? ` — did you mean "${error.did_you_mean}"?` : ""}`;
		const field = error.path ? `"${error.path}" ` : "";
		const hint = error.did_you_mean ? ` — use "${error.did_you_mean}"` : "";
		const takes = error.op && fieldsOf(error.op) ? ` (${error.op} takes ${takesLine(error.op)})` : "";
		return `${where}: ${field}${error.message}${hint}${takes}`;
	});
	const first = ops_involved[0];
	return {
		message: `${sentences.join("; ")}. Nothing was applied.`,
		errors: explained.slice(0, 20),
		fields: Object.fromEntries(ops_involved.slice(0, 4).map((op) => [op, opReference(op)])),
		next: {
			do: first ? `Read ${first}'s fields and example, fix the op, and call timeline_ops again.` : "Read the op list, fix the ops, and call timeline_ops again.",
			tool: "timeline_ops",
			arguments: { action: "reference", ...(first ? { op: first } : {}) },
		},
	};
}

function takesLine(op: string): string {
	const fields = fieldsOf(op);
	if (!fields) return "";
	const required = fields.required.map((spec) => `${spec.field} (required)`);
	const optional = fields.optional.map((spec) => spec.field);
	return [...required, ...optional].join(", ") + (fields.rule ? `; ${fields.rule}` : "");
}

/** Re-exported for the tool entry: validate one op the way timeline_ops will. */
export { validateOp };
