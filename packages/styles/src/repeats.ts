/**
 * EDT-20 — skills = saved styles from repeated instructions (reel DeIGbZypIUb 40.9–44.7 s: "if you keep telling
 * Claude the same thing… make a skill out of it").
 *
 *   history (sentences typed in "Tell Claude…" + the op batches they produced)
 *     → detectRepeats(history, { threshold: 3 })   an instruction or op pattern seen ≥ 3 times
 *     → suggestion { pattern, count, examples, draft_style }
 *     → saveStyle(library, draft)                  a versioned PRE-01 edit-style preset with trigger sentences
 *     → applyStyle(style, project)                 ops@1 for any project
 *
 * Wording is normalised before comparing ("Bigger captions please" = "captions bigger"); op batches are compared by
 * shape (op names + their non-id, non-time fields; numbers become "#"), so "warmer" and "warm it up" (both `grade
 * warm`) count as one pattern even though the sentences differ.
 */
import {
	BUILTIN_STYLES,
	captionTracks,
	resolveSentence,
	splitClauses,
	validateOp,
	type Author,
	type MeasureText,
	type Op,
	type Project,
	type SceneTracks,
	type StyleContext,
	type StyleExpander,
} from "@restorffcut/timeline-ops";
import { CAPTION_SCALE_SPEC, fitCaptionSize, migrateSavedStyle, trackCaptionSize } from "./caption-size.ts";
import {
	slugify,
	USER_STYLE_PREFIX,
	type ParamRef,
	type SavedStyle,
	type StyleLibrary,
	type StyleOrigin,
	type StyleParamSpec,
	type StyleStep,
	type TargetSelector,
} from "./preset.ts";

// ─── the history the editor records ─────────────────────────────────────────────────────────────────────────────

export interface InstructionRecord {
	/** The sentence as typed. */
	sentence: string;
	/** The op batch it produced (empty when nothing here understood it). */
	ops: readonly Op[];
	/** Per clause (timeline-ops IntentPlan.clauses), when the caller has it: lets a draft keep clauses apart. */
	clauses?: ReadonlyArray<{ text: string; ops: readonly Op[] }>;
	projectId?: string;
	/** ISO time. */
	at?: string;
	/**
	 * Median caption size (editor units) on the project BEFORE the instruction ran (ui-fix-panels, QA #8): lets a draft
	 * store "bigger captions" as a ratio (size / this) instead of an absolute size. The command bar fills it in.
	 */
	caption_size_before?: number;
}

// ─── normalising ────────────────────────────────────────────────────────────────────────────────────────────────

const STOP = new Set([
	"a", "an", "the", "it", "its", "this", "that", "these", "those", "please", "pls", "can", "could", "would", "you",
	"make", "made", "let", "lets", "us", "me", "my", "our", "do", "be", "is", "are", "so", "just", "now", "again",
	"some", "bit", "little", "slightly", "touch", "of", "to", "for", "in", "on", "at", "with", "as", "up", "go", "get",
	"ok", "okay", "hey", "claude", "also", "then", "and", "plus", "more", "kind", "sort", "like", "look",
]);

const SYNONYMS: Record<string, string> = {
	captions: "caption", subtitles: "caption", subtitle: "caption", subs: "caption", sub: "caption", lyrics: "caption",
	bigger: "big", larger: "big", large: "big", increase: "big", enlarge: "big",
	smaller: "small", shrink: "small", tiny: "small", reduce: "small",
	tighter: "tight", tighten: "tight", snappier: "tight", snappy: "tight",
	faster: "fast", quicker: "fast", quick: "fast",
	slower: "slow",
	pauses: "pause", silences: "pause", silence: "pause", gaps: "gap", breaths: "pause", breath: "pause",
	warmer: "warm", cooler: "cool", colder: "cool", cold: "cool", darker: "dark", brighter: "bright", lighter: "bright",
	moodier: "moody", cinematic: "moody",
	colour: "color", colours: "color", colors: "color",
	centre: "center", centred: "center", centered: "center", middle: "center",
	remove: "cut", kill: "cut", drop: "cut", lose: "cut", delete: "cut", trim: "cut",
	upper: "top", higher: "top", above: "top", lower: "bottom", below: "bottom",
	huge: "huge", giant: "huge", massive: "huge", enormous: "huge",
	animate: "animate", animated: "animate", animation: "animate", animations: "animate",
	uppercase: "caps", capitals: "caps", "all-caps": "caps",
};

function stem(word: string): string {
	const mapped = SYNONYMS[word] ?? word;
	if (mapped.length > 3 && mapped.endsWith("s") && !mapped.endsWith("ss")) return SYNONYMS[mapped.slice(0, -1)] ?? mapped.slice(0, -1);
	return mapped;
}

/** One clause → its sorted content words ("Bigger captions please" → "big caption"). */
export function clauseKey(clause: string): string {
	const words = clause
		.toLowerCase()
		.replace(/[^a-z0-9#&\- ]+/g, " ")
		.split(/\s+/)
		.filter((word) => word && !STOP.has(word))
		.map(stem)
		.filter((word) => word && !STOP.has(word));
	return [...new Set(words)].sort().join(" ");
}

/** A sentence → its normalised key: clause keys, sorted, joined by " + " (clause order does not matter). */
export function instructionKey(sentence: string): string {
	const keys = splitClauses(sentence).map(clauseKey).filter(Boolean);
	return [...new Set(keys)].sort().join(" + ");
}

/** Fields that are ids, refs, times or free content: never part of an op's shape. */
const NOT_SHAPE = new Set([
	"author", "note", "el", "track", "a", "b", "media", "ref", "t", "in", "out", "dur", "words", "times", "spans",
	"downbeats", "order", "url", "blob_sha", "name", "text", "index", "under", "params",
]);

function shapeValue(value: unknown): string {
	if (typeof value === "number") return "#";
	if (typeof value === "string" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return "[]";
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => `${key}=${shapeValue((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return "?";
}

/** An op's shape: name + its non-id/non-time fields, numbers as "#" (`set_caption_style{style={color=#FFD60A,size=#}}`). */
export function opShape(op: Op): string {
	const record = op as unknown as Record<string, unknown>;
	const fields = Object.keys(record)
		.filter((key) => key !== "op" && !NOT_SHAPE.has(key) && record[key] !== undefined)
		.sort()
		.map((key) => `${key}=${shapeValue(record[key])}`);
	if (op.op === "apply_style") return `apply_style{${String((op as { preset_id: string }).preset_id)}}`;
	return fields.length ? `${op.op}{${fields.join(",")}}` : op.op;
}

/** A batch's signature: its distinct op shapes, sorted ("tighter cut" → "delete|move|split"). */
export function batchSignature(ops: readonly Op[]): string {
	return [...new Set(ops.map(opShape))].sort().join("|");
}

// ─── detecting repeats ──────────────────────────────────────────────────────────────────────────────────────────

export interface RepeatPattern {
	kind: "instruction" | "ops";
	/** Normalised key: `instruction:<key>` or `ops:<signature>`. */
	key: string;
	/** Human label: the most used wording. */
	label: string;
}

export interface RepeatSuggestion {
	pattern: RepeatPattern;
	/** Records in the pattern. */
	count: number;
	/** Distinct projects it was said on (records without a project id count as one). */
	projects: number;
	/** Distinct sentences as typed, most used first (≤ 5). */
	examples: string[];
	draft_style: SavedStyle;
}

export interface DetectOptions {
	/** Repeats needed before a suggestion (default 3). */
	threshold?: number;
	/** Count records (default) or distinct projects (EDT-20: "across projects"). */
	by?: "records" | "projects";
	/** Patterns already saved (origin or a trigger with the same key) or dismissed here are not suggested again. */
	library?: StyleLibrary;
	/** Extra dismissed pattern keys. */
	dismissed?: readonly string[];
	/** Most suggestions returned (default 3). */
	limit?: number;
	now?: string;
}

function distinctProjects(records: readonly InstructionRecord[]): number {
	return new Set(records.map((record) => record.projectId ?? "?")).size;
}

/** Distinct wordings, most used first. */
function examplesOf(records: readonly InstructionRecord[], max = 5): string[] {
	const counts = new Map<string, { text: string; n: number; last: number }>();
	records.forEach((record, i) => {
		const text = record.sentence.trim();
		const key = text.toLowerCase();
		const entry = counts.get(key);
		if (entry) {
			entry.n++;
			entry.last = i;
			entry.text = text;
		} else counts.set(key, { text, n: 1, last: i });
	});
	return [...counts.values()]
		.sort((a, b) => b.n - a.n || b.last - a.last)
		.slice(0, max)
		.map((entry) => entry.text);
}

function savedKeys(library: StyleLibrary | undefined): Set<string> {
	const keys = new Set<string>();
	if (!library) return keys;
	for (const key of library.dismissed) keys.add(key);
	for (const style of Object.values(library.styles)) {
		if (style.origin?.pattern) keys.add(style.origin.pattern);
		for (const trigger of style.triggers) {
			const key = instructionKey(trigger);
			if (key) keys.add(`instruction:${key}`);
		}
	}
	return keys;
}

/**
 * Find instructions (normalised wording) or op patterns (batch shape) repeated ≥ threshold times. Instruction
 * patterns win over op patterns covering the same records. Newest-first among equal counts.
 */
export function detectRepeats(history: readonly InstructionRecord[], options: DetectOptions = {}): RepeatSuggestion[] {
	const threshold = Math.max(2, options.threshold ?? 3);
	const by = options.by ?? "records";
	const skip = savedKeys(options.library);
	for (const key of options.dismissed ?? []) skip.add(key);

	type Group = { key: string; kind: RepeatPattern["kind"]; records: InstructionRecord[]; indices: number[] };
	const byInstruction = new Map<string, Group>();
	const byOps = new Map<string, Group>();
	history.forEach((record, index) => {
		if (!record?.sentence?.trim()) return;
		const ik = instructionKey(record.sentence);
		if (ik) {
			const key = `instruction:${ik}`;
			const group = byInstruction.get(key) ?? { key, kind: "instruction", records: [], indices: [] };
			group.records.push(record);
			group.indices.push(index);
			byInstruction.set(key, group);
		}
		const signature = batchSignature(record.ops ?? []);
		if (signature) {
			const key = `ops:${signature}`;
			const group = byOps.get(key) ?? { key, kind: "ops", records: [], indices: [] };
			group.records.push(record);
			group.indices.push(index);
			byOps.set(key, group);
		}
	});

	const measure = (group: Group) => (by === "projects" ? distinctProjects(group.records) : group.records.length);
	const fired: Group[] = [];
	const covered: Array<Set<number>> = [];
	for (const group of byInstruction.values()) {
		if (measure(group) >= threshold && !skip.has(group.key)) {
			fired.push(group);
			covered.push(new Set(group.indices));
		}
	}
	for (const group of byOps.values()) {
		if (measure(group) < threshold || skip.has(group.key)) continue;
		// already said by an instruction pattern (all its records inside one fired instruction group)
		if (covered.some((set) => group.indices.every((i) => set.has(i)))) continue;
		// one wording only → the instruction pattern is the right one (it may be dismissed/saved: then stay quiet)
		const wordings = new Set(group.records.map((record) => instructionKey(record.sentence)));
		if (wordings.size === 1 && skip.has(`instruction:${[...wordings][0]}`)) continue;
		fired.push(group);
	}

	return fired
		.sort((a, b) => measure(b) - measure(a) || Math.max(...b.indices) - Math.max(...a.indices))
		.slice(0, options.limit ?? 3)
		.map((group) => {
			const examples = examplesOf(group.records);
			const pattern: RepeatPattern = { kind: group.kind, key: group.key, label: examples[0] ?? group.key };
			const before = group.records[group.records.length - 1]?.caption_size_before;
			const origin: StyleOrigin = {
				kind: group.kind,
				pattern: group.key,
				count: group.records.length,
				projects: distinctProjects(group.records),
				examples,
				...(typeof before === "number" && before > 0 ? { caption_size_before: before } : {}),
			};
			return {
				pattern,
				count: group.records.length,
				projects: origin.projects,
				examples,
				draft_style: draftStyle({ records: group.records, origin }, { now: options.now }),
			};
		});
}

// ─── drafting a style ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Ops a template can carry literally (their targets are generic or selectable). A caption SIZE is never carried as an
 * absolute number (QA #8: "Bigger captions" saved at 20 blew size-5 captions off the frame): it becomes a ratio of the
 * size the captions had before (`style.scale`), or — when that size is unknown — the clause is kept as a sentence and
 * re-read on each project (relative again).
 */
function generalise(op: Op, record?: InstructionRecord): { op: Record<string, unknown>; each?: TargetSelector } | null {
	const { author: _author, note: _note, ...rest } = op as Op & { note?: string };
	switch (op.op) {
		case "set_caption_style": {
			const { track: _track, ...plain } = rest as Record<string, unknown>;
			const style = { ...((plain.style as Record<string, unknown> | undefined) ?? {}) };
			if (typeof style.size === "number") {
				const before = record?.caption_size_before;
				if (!(typeof before === "number" && before > 0)) return null;
				style.scale = Math.round((style.size / before) * 1000) / 1000;
				delete style.size;
			}
			return { op: { ...plain, style }, each: "$captions" };
		}
		case "grade": {
			// grade agent, 2026-10-20: a clip or track id means nothing in another project — a saved grade grades the
			// whole timeline (its GRADE layer); "main" stays the A-roll track
			const target = (rest as { target?: unknown }).target;
			const generic = target === "all" || target === "timeline" || target === "everything" || target === "main";
			return { op: generic ? rest : { ...rest, target: "all" } };
		}
		case "normalize":
		case "set_canvas":
			return { op: rest };
		case "apply_style": {
			const { params: _params, ...plain } = rest as Record<string, unknown>; // composition media ids are per project
			return { op: plain };
		}
		case "snap_cuts": {
			const { track, ...plain } = rest as Record<string, unknown>;
			return track === undefined || track === "main" ? { op: plain, each: "$main" } : null;
		}
		default:
			return null;
	}
}

function paramSpecFor(value: unknown, label: string): StyleParamSpec | null {
	if (typeof value === "number") return { type: "number", default: value, label };
	if (typeof value === "boolean") return { type: "boolean", default: value, label };
	if (typeof value === "string") return /^#[0-9a-f]{3,8}$/i.test(value) ? { type: "color", default: value, label } : { type: "string", default: value, label };
	return null;
}

/** Lift a caption style's values and a grade preset into params, so the saved style can be tuned without editing. */
function liftParams(steps: StyleStep[]): Record<string, StyleParamSpec> {
	const params: Record<string, StyleParamSpec> = {};
	for (const step of steps) {
		if (step.kind !== "op") continue;
		if (step.op.op === "set_caption_style" && step.op.style && typeof step.op.style === "object") {
			const style = step.op.style as Record<string, unknown>;
			for (const [key, value] of Object.entries(style)) {
				const name = `caption_${key}`;
				const spec: StyleParamSpec | null =
					key === "scale" && typeof value === "number"
						? { ...CAPTION_SCALE_SPEC, default: value }
						: paramSpecFor(value, `Caption ${key.replace(/_/g, " ")}`);
				if (!spec || params[name]) continue;
				params[name] = spec;
				style[key] = { $param: name } satisfies ParamRef;
			}
		}
		if (step.op.op === "grade" && typeof step.op.preset === "string" && !params.grade) {
			params.grade = { type: "string", default: step.op.preset, label: "Grade" };
			step.op.preset = { $param: "grade" } satisfies ParamRef;
		}
	}
	return params;
}

function stepsFor(record: InstructionRecord): StyleStep[] {
	const parts = record.clauses?.length ? record.clauses.map((clause) => ({ text: clause.text, ops: clause.ops })) : [{ text: record.sentence, ops: record.ops }];
	const steps: StyleStep[] = [];
	for (const part of parts) {
		const general = part.ops.length ? part.ops.map((op) => generalise(op, record)) : [null];
		if (general.every((entry) => entry !== null)) {
			const seen = new Set<string>();
			for (const entry of general as Array<{ op: Record<string, unknown>; each?: TargetSelector }>) {
				const key = JSON.stringify(entry);
				if (seen.has(key)) continue; // one set_caption_style per caption track → one template step
				seen.add(key);
				steps.push({ kind: "op", op: structuredClone(entry.op), ...(entry.each ? { each: entry.each } : {}) });
			}
		} else if (part.text.trim()) {
			steps.push({ kind: "sentence", sentence: part.text.trim() });
		}
	}
	return steps;
}

function capitalise(text: string): string {
	const t = text.trim().replace(/[.!?]+$/, "");
	return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function describe(steps: StyleStep[]): string {
	return steps
		.map((step) =>
			step.kind === "sentence"
				? `"${step.sentence}" (re-read on each project)`
				: step.op.op === "set_caption_style"
					? "the caption style"
					: step.op.op === "apply_style"
						? `the ${String(step.op.preset_id).split("/").pop()} editing style`
						: step.op.op === "grade"
							? "the grade"
							: String(step.op.op).replace(/_/g, " "),
		)
		.join(", ");
}

export interface DraftSource {
	records: readonly InstructionRecord[];
	origin?: StyleOrigin | null;
	title?: string;
	triggers?: string[];
}

/**
 * Draft a saved style (PRE-01 edit-style preset) from the records of a pattern. The template is the LATEST record
 * (how the person wants it now): clauses whose ops generalise (caption style, grade, an editing style, loudness,
 * canvas) become op steps with their values lifted into params; anything tied to this project's clips (pacing cuts,
 * keyframes, inserts) becomes a sentence step that is re-resolved on every project it is applied to.
 */
export function draftStyle(source: DraftSource, options: { now?: string; id?: string } = {}): SavedStyle {
	const records = source.records.filter((record) => record?.sentence?.trim());
	if (!records.length) throw new Error("draftStyle needs at least one instruction");
	const latest = records[records.length - 1] as InstructionRecord;
	const examples = source.origin?.examples ?? examplesOf(records);
	const steps = stepsFor(latest);
	const params = liftParams(steps);
	const title = capitalise(source.title ?? examples[0] ?? latest.sentence).slice(0, 60);
	const at = options.now ?? new Date().toISOString();
	const triggers = (source.triggers ?? examples).map((t) => t.trim()).filter(Boolean).slice(0, 5);
	const count = source.origin?.count ?? records.length;
	return {
		id: options.id ?? slugify(title),
		kind: "edit-style",
		stage: "edit",
		version: "1.0.0",
		title,
		instructions: `Saved after ${count} repeats of "${examples[0] ?? latest.sentence}". Applies ${describe(steps)}.`,
		licence: "private",
		visibility: "private",
		inputs: ["timeline"],
		outputs: { schema: "ops@1" },
		params,
		checks: [],
		triggers: triggers.length ? triggers : [latest.sentence.trim()],
		steps,
		origin: source.origin ?? null,
		created_at: at,
		updated_at: at,
	};
}

// ─── applying a saved style ─────────────────────────────────────────────────────────────────────────────────────

export interface ApplyStyleContext {
	/** Default: project.currentSceneId, else the main scene. */
	sceneId?: string;
	/** Written on every op (default "preset": a saved style is a preset). */
	author?: Author;
	/** Overrides for the style's params. */
	params?: Record<string, unknown>;
	/**
	 * Measures a line of caption text in canvas px (the editor passes its canvas measurer); without it caption sizes
	 * are capped with estimateTextWidth (errs wide).
	 */
	measure?: MeasureText;
}

export interface StylePlan {
	ops: Op[];
	/** Plain-words notes (what was skipped and why, what is recorded but not drawn). */
	notes: string[];
	/** Sentence parts nobody here understood: hand them to the person's Claude. */
	unresolved: string[];
}

function sceneTracks(project: Project, sceneId?: string): SceneTracks | null {
	const scenes = project.scenes ?? [];
	const scene =
		(sceneId ? scenes.find((s) => s.id === sceneId) : undefined) ??
		scenes.find((s) => s.id === project.currentSceneId) ??
		scenes.find((s) => s.isMain) ??
		scenes[0];
	return scene?.tracks ?? null;
}

function resolveParams(value: unknown, params: Record<string, unknown>): unknown {
	if (Array.isArray(value)) return value.map((entry) => resolveParams(entry, params));
	if (value && typeof value === "object") {
		const ref = value as Partial<ParamRef>;
		if (typeof ref.$param === "string" && Object.keys(value).length === 1) return params[ref.$param];
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.map(([key, entry]) => [key, resolveParams(entry, params)] as const)
				.filter(([, entry]) => entry !== undefined),
		);
	}
	return value;
}

/** Style → ops@1 plus notes. See applyStyle. */
export function planStyle(saved: SavedStyle, project: Project, context: ApplyStyleContext = {}): StylePlan {
	// QA #8: a style saved with an absolute caption size is turned into a ratio (or flagged) before it runs, so even a
	// library nobody migrated (the server's, an old export) can't blow captions off the frame.
	const style = migrateSavedStyle(saved).style;
	const author: Author = context.author ?? "preset";
	const tracks = sceneTracks(project, context.sceneId);
	const params: Record<string, unknown> = {};
	for (const [name, spec] of Object.entries(style.params ?? {})) params[name] = spec.default;
	Object.assign(params, context.params ?? {});
	const notes: string[] = [];
	const unresolved: string[] = [];
	const first: Op[] = [];
	const last: Op[] = [];

	// 1. sentence steps, resolved together so pacing / captions / grade come out in one consistent plan
	const sentences = style.steps.filter((step): step is { kind: "sentence"; sentence: string } => step.kind === "sentence").map((step) => step.sentence);
	let sentenceOps: Op[] = [];
	if (sentences.length) {
		const plan = resolveSentence(sentences.join(", "), { project, sceneId: context.sceneId, author });
		sentenceOps = plan.ops;
		unresolved.push(...plan.unmatched);
		for (const note of plan.notes) if (!notes.includes(note)) notes.push(note);
	}

	// 2. op steps, instantiated per target
	for (const step of style.steps) {
		if (step.kind !== "op") continue;
		const base = { ...(resolveParams(step.op, params) as Record<string, unknown>), author } as Record<string, unknown>;
		const targets: Array<Record<string, unknown>> = [];
		if (step.each === "$captions") {
			const captions = tracks ? captionTracks(tracks).filter((track) => track.elements.length > 0) : [];
			if (!captions.length) notes.push(`no captions on this timeline: ${String(base.op)} skipped (add captions first)`);
			for (const track of captions) {
				if (base.op !== "set_caption_style") {
					targets.push({ ...base, track: track.id });
					continue;
				}
				const textStyle = { ...((base.style as Record<string, unknown> | undefined) ?? {}) };
				// a relative size: × this track's own captions (QA #8)
				if (textStyle.scale !== undefined) {
					const scale = Number(textStyle.scale);
					delete textStyle.scale;
					if (Number.isFinite(scale) && scale > 0) textStyle.size = (trackCaptionSize(track) ?? 5) * scale;
				}
				// a flagged legacy absolute size is not applied (the flag says why and how to fix it)
				if (typeof textStyle.size === "number" && style.flags?.some((flag) => flag.code === "absolute_caption_size")) {
					delete textStyle.size;
					const flagNote = "caption size skipped: this style was saved with a fixed size, not a ratio — open it under My styles to set one";
					if (!notes.includes(flagNote)) notes.push(flagNote);
				}
				if (!Object.keys(textStyle).length) continue;
				targets.push({ ...base, style: textStyle, track: track.id });
			}
		} else if (step.each === "$main") {
			targets.push({ ...base, track: "main" });
		} else if (step.each === "$clips") {
			const clips = tracks?.main.elements ?? [];
			if (!clips.length) notes.push(`no clips on the main track: ${String(base.op)} skipped`);
			for (const clip of clips) targets.push({ ...base, el: clip.id });
		} else targets.push(base);
		for (const op of targets) {
			const errors = validateOp(op);
			if (errors.length) {
				notes.push(`${String(op.op)} skipped: ${errors.map((e) => `${e.path || "op"} ${e.message}`).join("; ")}`);
				continue;
			}
			(op.op === "apply_style" ? first : last).push(op as unknown as Op);
		}
	}
	// grade agent, 2026-10-20: grade ops are applied for real now (restorff-grade effect), so no "not drawn" note
	const ops = [...first, ...sentenceOps, ...last].map((op) => fitCaptionOp(op, project, tracks, context.measure, notes));
	return { ops, notes, unresolved };
}

/**
 * QA #8: every caption size a saved style sets stays inside the caption safe area, in whole editor units — whether it
 * came from a ratio step or a re-read sentence ("bigger captions" can ask for more than a long caption has room for).
 */
function fitCaptionOp(op: Op, project: Project, tracks: SceneTracks | null, measure: MeasureText | undefined, notes: string[]): Op {
	if (op.op !== "set_caption_style" || typeof op.style?.size !== "number" || !tracks) return op;
	const track = tracks.overlay.find((candidate) => candidate.id === op.track);
	if (!track) return op;
	const canvas = project.settings?.canvasSize ?? { width: 1080, height: 1920 };
	const wanted = Math.max(1, Math.round(op.style.size));
	const fit = fitCaptionSize({ track, wanted, canvas, measure });
	// a cap never shrinks captions below what they are now (that is not what "bigger" asked for): at worst they stay
	const current = trackCaptionSize(track);
	const floor = current ? Math.min(wanted, Math.max(1, Math.round(current))) : 1;
	const size = Math.max(fit.size, floor);
	if (size < wanted) {
		const words = fit.limitedBy ? ` (“${fit.limitedBy.length > 28 ? `${fit.limitedBy.slice(0, 27)}…` : fit.limitedBy}” is the widest)` : "";
		const note =
			size === floor && current && size <= Math.round(current)
				? `captions on ${track.name || "a caption track"} kept at size ${size}: no room to grow inside the safe area${words}`
				: `captions on ${track.name || "a caption track"} capped at size ${size} to stay inside the safe area${words}`;
		if (!notes.includes(note)) notes.push(note);
	}
	return { ...op, style: { ...op.style, size } };
}

/** A saved style → ops@1 for `project` (pure; the editor applies them as one undo step). */
export function applyStyle(style: SavedStyle, project: Project, context: ApplyStyleContext = {}): Op[] {
	return planStyle(style, project, context).ops;
}

/** The saved style whose trigger sentence means the same as `sentence` (normalised), if any. */
export function matchTrigger(library: StyleLibrary, sentence: string): SavedStyle | null {
	const key = instructionKey(sentence);
	if (!key) return null;
	for (const style of Object.values(library.styles)) {
		if (style.triggers.some((trigger) => instructionKey(trigger) === key)) return style;
	}
	return null;
}

/**
 * Saved styles as `apply_style` presets (`restorff/user/<id>`) for timeline-ops `apply(…, { styles })` — what the MCP
 * `styles` tool needs to list and apply them. apply_style cannot nest, so a built-in editing style inside a saved
 * style is expanded inline here.
 */
export function styleExpanders(library: StyleLibrary): Record<string, StyleExpander> {
	const out: Record<string, StyleExpander> = {};
	for (const style of Object.values(library.styles)) {
		out[`${USER_STYLE_PREFIX}${style.id}`] = (context: StyleContext) =>
			applyStyle(style, context.project, { params: context.op.params }).flatMap((op) => {
				if (op.op !== "apply_style") return [op];
				const builtin = BUILTIN_STYLES[op.preset_id];
				return builtin ? builtin({ ...context, op }) : [];
			});
	}
	return out;
}
