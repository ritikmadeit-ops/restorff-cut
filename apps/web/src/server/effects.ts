/**
 * The effects library, server half (mcp-effects agent, 2026-10-20; EDT-17): read the composition package, find the
 * moment (a time, a word, a clip), and apply a named effect to a timeline as ONE commit by `claude`.
 *
 *   composition  render through packages/compositions (cached by input hash) → the WebM into the project's media
 *                store → a clip on MOTION (a free MOTION track, else a new one on top) carrying
 *                `restorff.composition` = {name, props, hash, …}, exactly what the editor's Motion view drop stores.
 *   shader       an effect layer (type "effect") on an FX effect track for [t, t + hold) — the editor's Shaders /
 *                Library "add at playhead" makes the same element — placed just above the footage so captions and
 *                MOTION stay put; or, with element_id, the effect in that clip's `effects` (before its grade).
 *   transition   ops@1 `transition` at the cut nearest t (or into element_id) on the main track (or params.track).
 *   grade        ops@1 `grade` with a look: element_id, the clip under t, params.target, or "all" (GRADE layer).
 *
 * Paths: the composition package = `COMPOSITIONS_DIR` (app/api/compositions/_lib/service.ts); EFFECTS.md =
 * RESTORFFCUT_EFFECTS_DOC (default <apps/web>/../../docs/restorff/EFFECTS.md). The catalogue (pure) is
 * ./effects-catalogue.ts; words are ./effects-words.ts; the MCP tool is ../mcp/effects.ts.
 * Runbook: docs/restorff/worklog/mcp-effects.md.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	apply as applyOps,
	GRADE_LOOKS,
	GRADE_PARAM_KEYS,
	GRADE_PARAM_SPECS,
	type Op,
	type Project as OpsProject,
	resolveGradeName,
	resolveTransitionKind,
	TRANSITION_KINDS,
} from "@restorffcut/timeline-ops";
import { callService, COMPOSITIONS_DIR, ServiceError } from "@/app/api/compositions/_lib/service";
import type { ProjectSnapshot, SnapshotElement, SnapshotTrack } from "@/sync/snapshot";
import type { Actor } from "./auth";
import { buildEffectsLibrary, findEffect as findLibraryEffect, type LibraryEffect, type PackageComposition, SHADER_DEFINITIONS, shaderDefaults } from "./effects-catalogue";
import { effectTagOf, emptyTracks, findEffect as findApplied, type FoundEffect, newInstanceId, type PlateKeyRecord, planRemoval } from "./effects-instances";
import { CUTOUT_LANE, insertIndexFor, isBackLane, isCutoutLane, isFrontLane, isFxLane, isMotionLane, laneDrift, laneFree, MOTION as MOTION_LANE, MOTION_BACK as BACK_LANE, MOTION_FRONT as FRONT_LANE, nextLaneName } from "./effects-lanes";
import {
	clipSpan,
	clipStill,
	ensureMatte,
	finishSegment,
	matteFrames,
	personMediaId,
	planSegment,
	type SegmentPlan,
	segmentFields,
	segmentOps,
	segmentsOf,
	transitionWindows,
	uploadPerson,
} from "./effects-layers";
import { overlayAlpha, planMove, reportView } from "./effects-placement";
import { faceSpanOnCanvas, sourceToCanvas } from "./matte-face-span";
import { type AlphaFrames, type FaceSpan, faceSpanFrom, keepOutOf, moveRect, type OverlapReport, overlapReport, type Rect, safeBandFor } from "./matte-placement";
import {
	type EffectRecipe,
	faceProp,
	frameBreakWindow,
	isLayered,
	layeredInputs,
	layerPlan,
	mastheadOffsetFor,
	matteInput,
	plateKeysFor,
	readRecipe,
	storableProps,
	wantsBackgroundStill,
} from "./effects-layers-plan";
import { activeScene, captionWords, findWord, orderedTracks, type SourceWord, sentenceEnd, type TimelineWord, wordsFromTranscripts } from "./effects-words";
import { HttpError } from "./http";
import { type FaceTrack, type MatteJob, type MediaRecord, projectMediaRecord, waitForMatte } from "./matte";
import { PRESETS as CUTOUT_PRESETS, type Located, locate } from "./matte-presets";
import { listProjectMedia, putProjectMedia } from "./media";
import { getProjectHead, pushCommit } from "./projects";
import { findTranscript } from "./transcripts";

const TICKS = 120_000;
const MOTION = "MOTION";
const FX_TRACK = "FX";
const toTicks = (seconds: number) => Math.round(seconds * TICKS);
const toSeconds = (ticks: number) => Math.round((ticks / TICKS) * 1000) / 1000;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

export const EFFECTS_DOC = resolve(process.env.RESTORFFCUT_EFFECTS_DOC ?? join(process.cwd(), "..", "..", "docs", "restorff", "EFFECTS.md"));

/** A tool-shaped answer (structurally the MCP ToolOutput): the payload ends with `next`. */
export interface EffectResult {
	payload: Record<string, unknown>;
	isError?: boolean;
}

type Next = { do: string; tool: string; arguments?: Record<string, unknown> };

function failure(code: string, message: string, extra: Record<string, unknown> = {}, next?: Next): EffectResult {
	return { payload: { error: { code, message, ...extra }, ...(next ? { next } : {}) }, isError: true };
}

const summaryNext = (timelineId: string, what = "Read the timeline summary (element ids, times, cuts)."): Next => ({
	do: what,
	tool: "timeline",
	arguments: { action: "summary", timeline_id: timelineId },
});

// ─── the composition package (read live: new compositions show up without a code change) ───────────────────────

/** What `catalogue` answers per composition (packages/compositions src/service.ts CatalogueEntry). */
export interface PackageEntry {
	name: string;
	title: string;
	description: string;
	tags: string[];
	duration: number;
	size: [number, number];
	fps: number;
	params: Record<string, Record<string, unknown>>;
	example: Record<string, unknown>;
	hasSample: boolean;
	/** The manifest's `effect` block (collage-fx recipe: stack, inputs, plate keys), read from the file here. */
	effect?: unknown;
	/** fx-sync imports (2026-10-24): source, upstream id, path, commit, licence, author — shown by describe. */
	provenance?: Record<string, unknown>;
}

interface LibraryRenderAnswer {
	name: string;
	hash: string;
	file: string;
	cached: boolean;
	duration: number;
	width: number;
	height: number;
	fps: number;
	frames: number;
	bytes: number;
	params: Record<string, unknown>;
	ms: number;
}

const PACKAGE_TTL_MS = 15_000;

interface PackageRead {
	entries: PackageEntry[];
	compositions: PackageComposition[];
	error?: string;
	at: number;
}

function packageCache(): { value: PackageRead | null } {
	const g = globalThis as unknown as { __restorffcutEffectsPackage?: { value: PackageRead | null } };
	g.__restorffcutEffectsPackage ??= { value: null };
	return g.__restorffcutEffectsPackage;
}

/**
 * FX ids a composition's file names ("FX-13" in paper-cut.html …): how a new composition finds its catalogue row.
 * Same read: the manifest's `effect` block (the package's catalogue verb drops unknown manifest keys).
 */
async function readCompositionFile(name: string): Promise<{ fx: string[]; effect?: unknown }> {
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return { fx: [] };
	try {
		const text = await readFile(join(COMPOSITIONS_DIR, "compositions", name, `${name}.html`), "utf8");
		const fx = [...new Set(text.match(/FX-\d{2}/g) ?? [])].sort();
		const block = /<script type="application\/json" id="params">([\s\S]*?)<\/script>/.exec(text);
		let effect: unknown;
		try {
			effect = block ? (JSON.parse(block[1]) as { effect?: unknown }).effect : undefined;
		} catch {
			effect = undefined;
		}
		return { fx, ...(effect ? { effect } : {}) };
	} catch {
		return { fx: [] };
	}
}

export async function readPackage(): Promise<PackageRead> {
	const cache = packageCache();
	if (cache.value && Date.now() - cache.value.at < PACKAGE_TTL_MS) return cache.value;
	try {
		const entries = await callService<PackageEntry[]>({ verb: "catalogue" });
		const compositions = await Promise.all(
			entries.map(async (entry) => {
				const file = await readCompositionFile(entry.name);
				if (entry.effect === undefined && file.effect !== undefined) entry.effect = file.effect;
				return {
					name: entry.name,
					title: entry.title,
					description: entry.description,
					tags: entry.tags ?? [],
					duration: entry.duration,
					fx: file.fx,
					...(entry.provenance ? { provenance: entry.provenance } : {}),
				};
			}),
		);
		cache.value = { entries, compositions, at: Date.now() };
	} catch (error) {
		// keep serving the rows (without extras) when the package cannot be read; say why
		cache.value = { entries: [], compositions: [], error: error instanceof Error ? error.message : String(error), at: Date.now() };
	}
	return cache.value;
}

export async function loadLibrary(): Promise<{ library: LibraryEffect[]; entries: PackageEntry[]; packageError?: string }> {
	const pkg = await readPackage();
	return {
		library: buildEffectsLibrary(pkg.error ? null : pkg.compositions),
		entries: pkg.entries,
		...(pkg.error ? { packageError: pkg.error } : {}),
	};
}

/** The effect's own block of docs/restorff/EFFECTS.md (Seen · Layers · Inputs · Params · Build · Accept), trimmed. */
export async function effectReference(id: string): Promise<string | null> {
	if (!/^FX-\d{2}$/.test(id)) return null;
	let text: string;
	try {
		text = await readFile(EFFECTS_DOC, "utf8");
	} catch {
		return null;
	}
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => line.startsWith(`### ${id} `) || line.startsWith(`**${id} `));
	if (start < 0) return null;
	const out = [lines[start]];
	for (let i = start + 1; i < lines.length; i++) {
		if (/^(#{2,3} |\*\*FX-\d{2} |---)/.test(lines[i])) break;
		out.push(lines[i]);
	}
	return out.join("\n").trim().slice(0, 2400);
}

/** What `describe` shows for the params of each kind of apply. */
export function describeParams(effect: LibraryEffect, entries: PackageEntry[]): Record<string, unknown> {
	const apply = effect.apply;
	if (!apply) return {};
	if (apply.kind === "composition") {
		const entry = entries.find((candidate) => candidate.name === apply.composition);
		if (!entry) return { composition: apply.composition, problem: "not in packages/compositions right now" };
		const recipe = readRecipe(entry);
		const layered = recipe && isLayered(recipe, entry.params) ? layerPlan(recipe) : null;
		return {
			composition: entry.name,
			title: entry.title,
			description: entry.description,
			duration_s: entry.duration,
			params: entry.params,
			example: entry.example,
			how_params_work: "params are merged over the example (fictional Halcyon content): send the values that should change; every number shown must be true (NFR-04).",
			// fx-sync imports: where it came from and under which licence (NOTICE, third_party/<source>/)
			...(entry.provenance ? { provenance: entry.provenance } : {}),
			...(recipe && layered
				? {
						layers: {
							stack: recipe.stack,
							renders: layered.renders.map((render) => ({ entry: render.entry, layer: render.layer, goes: render.side.replace("_", " ") })),
							...(layered.usesCutout ? { person: "the clip's server person matte (made or reused by apply) goes on V2 CUTOUT above the clip, frame-aligned" } : {}),
							...(layered.plateKeys.length ? { plate_keys: layered.plateKeys, keyed: layered.plateKeysOn } : {}),
							inputs: recipe.inputs,
							filled_by_apply: layeredInputs(recipe, entry.params),
							one_overlay_instead: "params.layer = \"all\" places one overlay on MOTION (no person matte, nothing behind the speaker)",
						},
					}
				: {}),
		};
	}
	if (apply.kind === "shader") {
		const definition = SHADER_DEFINITIONS[apply.effectType];
		return {
			effect_type: apply.effectType,
			params: (definition?.params ?? []).map((param) => {
				const p = param as unknown as Record<string, unknown>;
				return { key: p.key, label: p.label, type: p.type, default: p.default, min: p.min, max: p.max };
			}),
			preset: apply.params,
			hold_s: apply.hold_s,
			...(apply.holdToSentence ? { hold: "until the end of the sentence holding the word (or hold_s); duration_s overrides" } : {}),
			placement: "an effect layer on an FX effect track from t (just above the footage, below captions and MOTION); with element_id the effect goes on that clip for its whole length",
		};
	}
	if (apply.kind === "transition") {
		return {
			transition: apply.transition,
			...(apply.options ? { directions: apply.options } : {}),
			default_dur_s: TRANSITION_KINDS[apply.transition] ?? null,
			params: {
				kind: `optional: any transition kind (${Object.keys(TRANSITION_KINDS).join(", ")})`,
				...(apply.options ? { direction: "optional: left · right · up · down" } : {}),
				track: "optional: the track id whose cut it goes on (default main)",
				reach_s: "optional: how far from t the cut may be (default 1.5)",
			},
			placement: "at the cut nearest t (or the word's onset), or into element_id from the clip before it; duration_s = transition length, centred on the cut",
		};
	}
	if (apply.kind === "grade") {
		return {
			look: apply.look,
			looks: GRADE_LOOKS.map((look) => ({ id: look.id, label: look.label, hint: look.hint })),
			sliders: GRADE_PARAM_SPECS.map((spec) => ({ key: spec.key, label: spec.label, min: spec.min, max: spec.max, default: spec.default })),
			params: {
				look: "optional: another look or a nudge (warmer, cooler, brighter, more contrast…)",
				target: "optional: an element id, a track id, \"main\" or \"all\" (default: element_id, else the clip under t, else all)",
				"<slider>": "optional: slider values applied after the look",
			},
		};
	}
	return { tool: apply.tool, arguments: apply.arguments, why: apply.why };
}

// ─── words ──────────────────────────────────────────────────────────────────────────────────────────────────

export type WordsSource = "transcripts" | "captions" | "none";

/** Server transcripts of the media its clips play (mcp-cut's store) first, else the caption elements' words. */
export async function timelineWords(projectId: string, snapshot: ProjectSnapshot): Promise<{ words: TimelineWord[]; source: WordsSource }> {
	try {
		const media = await listProjectMedia(projectId);
		const hashOf = new Map(media.map((row) => [row.media_id, row.hash]));
		const memo = new Map<string, SourceWord[] | null>();
		const words = wordsFromTranscripts(snapshot, (mediaId) => {
			if (!memo.has(mediaId)) {
				const hash = hashOf.get(mediaId);
				memo.set(mediaId, hash ? (findTranscript(hash)?.words ?? null) : null);
			}
			return memo.get(mediaId) ?? null;
		});
		if (words.length) return { words, source: "transcripts" };
	} catch {
		// no media on the server, or the transcript store is unreadable: fall back to captions
	}
	const captions = captionWords(snapshot);
	return captions.length ? { words: captions, source: "captions" } : { words: [], source: "none" };
}

// ─── snapshot helpers ─────────────────────────────────────────────────────────────────────────────────────────

function findElement(snapshot: ProjectSnapshot, elementId: string): { track: SnapshotTrack; element: SnapshotElement } | null {
	for (const track of orderedTracks(snapshot)) {
		const element = (track.elements ?? []).find((candidate) => candidate.id === elementId);
		if (element) return { track, element };
	}
	return null;
}

function canvasOf(snapshot: ProjectSnapshot): { width: number; height: number; fps: number } {
	const size = snapshot.settings?.canvasSize;
	const fps = snapshot.settings?.fps;
	const rate = typeof fps === "number" ? fps : fps ? fps.numerator / fps.denominator : 30;
	return { width: size?.width ?? 1080, height: size?.height ?? 1920, fps: Math.max(1, Math.min(120, Math.round(rate))) };
}

const overlaps = (track: SnapshotTrack, start: number, end: number) =>
	(track.elements ?? []).some((el) => start < el.startTime + el.duration && end > el.startTime);

// effects-v2: lane names, ranks and reuse live in ./effects-lanes.ts (MOTION / FX / MOTION FRONT / V2 CUTOUT / MOTION BACK)

const isGradeTrack = (track: SnapshotTrack) => (track.restorff as { role?: string } | undefined)?.role === "grade" || (track.name ?? "").toUpperCase() === "GRADE";

/** Where the picture ends: the last element end on any track that is not an effect layer. */
function timelineEnd(snapshot: ProjectSnapshot): number {
	let end = 0;
	for (const track of orderedTracks(snapshot)) {
		if (track.type === "effect") continue;
		for (const element of track.elements ?? []) end = Math.max(end, element.startTime + element.duration);
	}
	return end;
}

/** A person cutout (cutout tool / layered effect) or a rendered composition: never "the footage". */
const isDerived = (el: SnapshotElement) => {
	const restorff = el.restorff as { cutout?: unknown; composition?: unknown } | undefined;
	return !!restorff?.cutout || !!restorff?.composition;
};

/** The clip under `t` on the main track (else any footage clip under it; cutouts and compositions are not footage). */
function clipAt(snapshot: ProjectSnapshot, t: number): SnapshotElement | null {
	const ticks = toTicks(t);
	const scene = activeScene(snapshot);
	const tracks = [scene?.tracks?.main, ...(scene?.tracks?.overlay ?? []).filter((track) => track.type === "video" && !(track.name ?? "").toUpperCase().startsWith(MOTION))];
	for (const track of tracks) {
		const hit = (track?.elements ?? []).find((el) => (el.type === "video" || el.type === "image") && !isDerived(el) && el.startTime <= ticks && ticks < el.startTime + el.duration);
		if (hit) return hit;
	}
	return null;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

// ─── apply ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ApplyInput {
	effect: LibraryEffect;
	entries: PackageEntry[];
	timelineId: string;
	baseCommit?: string;
	branch?: string;
	t?: number;
	word?: string;
	occurrence?: number;
	elementId?: string;
	params: Record<string, unknown>;
	durationS?: number;
	message?: string;
	dryRun: boolean;
	/** Layered effects: how long to hold the call for a running person-matte job (seconds; default 90). */
	waitS?: number;
	/** The MCP call's signal (client gone / over budget). */
	signal?: AbortSignal;
	// ─── effects-v2 (all optional; old calls behave as before) ───────────────────────────────────────────────
	/** Build on this head instead of loading the branch head (effects update: the head with the old effect removed). */
	head?: Head;
	/** ops recorded before this apply's own in the same commit (effects update: the removal). */
	opsPrefix?: unknown[];
	/** The instance id to tag the new elements with (update keeps the old one). Default: a new id. */
	instance?: string;
	/** Param keys that count as the caller's (never moved by placement). Default: the keys of params. */
	givenKeys?: string[];
	/** Last edits on the snapshot before it is committed (update: drop the old effect's leftover lanes). */
	beforeCommit?: (snapshot: ProjectSnapshot, ops: unknown[]) => string[];
	/** Dry runs render (cached) to measure overlays against the face box; false = plan only. Default true. */
	measure?: boolean;
	/** Face-safe placement of overlays: "auto" (default) moves them off the face; "off" only reports. */
	placement?: "auto" | "off";
	/**
	 * director (2026-10-24): hand the finished snapshot + ops to the caller instead of committing, so several applies
	 * chain into ONE commit (pass `head` = the snapshot so far). Returns the id to report as commit_id.
	 */
	collect?: (c: { snapshot: ProjectSnapshot; ops: unknown[]; message: string }) => string;
}

interface Head {
	branch: string;
	headId: string;
	snapshot: ProjectSnapshot;
}

interface Anchor {
	t: number | null;
	word?: { asked: string; matched: string; start: number; end: number; source: WordsSource; occurrence: number; of: number };
	words?: TimelineWord[];
	index?: number;
}

const effectView = (effect: LibraryEffect) => ({ id: effect.id, name: effect.name, kind: effect.kind, status: effect.status });

/** The cutout tool's preset (mcp-cutout agent, server/matte-presets.ts) that builds this FX with the person matte. */
export function cutoutPresetFor(fxId: string): string | null {
	for (const [preset, info] of Object.entries(CUTOUT_PRESETS)) if (info.fx === fxId) return preset;
	return null;
}

/** The cutout tool (mcp-cutout agent): it makes the person matte a matte effect needs. */
const cutoutNext = (timelineId: string, elementId?: string): Next => ({
	do: elementId
		? "Make the person matte of this clip first (server-side cutout; a background job — poll cutout status), then come back."
		: "Make the person matte of the speaker's clip first (server-side cutout: element_id = the clip from timeline summary; a background job — poll cutout status), then come back.",
	tool: "cutout",
	arguments: { action: "matte", timeline_id: timelineId, element_id: elementId ?? "<the speaker's clip>" },
});

/** The behind-the-speaker version of a matte effect, when the cutout tool has a preset for it. */
export function matteVersion(effect: LibraryEffect, timelineId?: string, elementId?: string): Next | null {
	const preset = cutoutPresetFor(effect.id);
	if (!preset) return null;
	return {
		do: `With the person matte done, the cutout tool builds ${effect.name} behind the speaker (preset ${preset}).`,
		tool: "cutout",
		arguments: { action: "apply", timeline_id: timelineId ?? "<timeline>", element_id: elementId ?? "<the speaker's clip>", preset },
	};
}

/** Answers for effects that cannot be applied today (coming, or blocked on an input). Null = go ahead. */
export function gate(effect: LibraryEffect, library: LibraryEffect[], timelineId: string | undefined, elementId?: string): EffectResult | null {
	if (effect.status !== "coming" && effect.apply) return null;
	const tryInstead = library
		.filter((candidate) => candidate.group === effect.group && candidate.status !== "coming" && candidate.id !== effect.id)
		.slice(0, 4)
		.map((candidate) => ({ id: candidate.id, name: candidate.name, status: candidate.status }));
	if (effect.blocking.includes("person_matte")) {
		const then = matteVersion(effect, timelineId, elementId);
		return {
			payload: {
				status: "needs",
				needs: "person_matte",
				effect: effectView(effect),
				message: `${effect.name} draws behind (or around) the speaker, so it needs a person matte of the clip. ${effect.note}`,
				...(then ? { then } : {}),
				...(tryInstead.length ? { try_instead: tryInstead } : {}),
				next: timelineId ? cutoutNext(timelineId, elementId) : { do: "Make the person matte with the cutout tool, then apply again.", tool: "cutout" },
			},
		};
	}
	const writable = /C/.test(effect.build) && !/[SM]/.test(effect.build);
	return {
		payload: {
			status: "not_built",
			effect: effectView(effect),
			missing: effect.warning ?? effect.note,
			needs: effect.needs,
			...(tryInstead.length ? { try_instead: tryInstead } : {}),
			next: writable
				? { do: `Not in the library yet: write it yourself as a motion graphic (${effect.name}) — read the contract, then composition write at the same t.`, tool: "composition", arguments: { action: "contract" } }
				: { do: "Pick a ready effect instead.", tool: "effects", arguments: { action: "list", status: "ready" } },
		},
	};
}

async function resolveAnchor(input: ApplyInput, head: Head): Promise<Anchor | EffectResult> {
	if (input.word && input.word.trim()) {
		const { words, source } = await timelineWords(input.timelineId, head.snapshot);
		if (!words.length) {
			return failure(
				"no_words",
				"This timeline has no word timings yet: no server transcript of its media and no caption words. Nothing was applied.",
				{},
				{ do: "Transcribe the footage (or pass t in seconds instead of word).", tool: "transcribe", arguments: { timeline_id: input.timelineId } },
			);
		}
		const occurrence = Math.max(1, Math.floor(input.occurrence ?? 1));
		const match = findWord(words, input.word, occurrence);
		if (!match.found) {
			return failure(
				"word_not_found",
				match.occurrences
					? `"${input.word}" is said ${match.occurrences} time(s) on this timeline, not ${occurrence}. Nothing was applied.`
					: `"${input.word}" is not said on this timeline (words from ${source}). Nothing was applied.`,
				{ words_source: source, vocabulary: match.vocabulary },
				{ do: "Pick a word that is said (vocabulary), or pass t in seconds.", tool: "effects", arguments: { action: "apply", name: input.effect.id, timeline_id: input.timelineId } },
			);
		}
		return {
			t: match.start,
			word: { asked: input.word, matched: match.matched, start: match.start, end: match.end, source, occurrence, of: match.occurrences },
			words,
			index: match.index,
		};
	}
	if (typeof input.t === "number") {
		if (!(input.t >= 0)) return failure("invalid_arguments", "t must be >= 0 (timeline seconds).");
		return { t: input.t };
	}
	if (input.elementId) {
		const found = findElement(head.snapshot, input.elementId);
		if (!found) return failure("not_found", `No element ${input.elementId} on this timeline.`, {}, summaryNext(input.timelineId));
		return { t: toSeconds(found.element.startTime) };
	}
	return { t: null };
}

const isResult = (value: unknown): value is EffectResult => !!value && typeof value === "object" && "payload" in value;

function defaultMessage(input: ApplyInput, anchor: Anchor): string {
	if (input.message?.trim()) return input.message.trim().slice(0, 300);
	const where = anchor.word ? ` on "${anchor.word.matched}"` : anchor.t !== null ? ` at ${round3(anchor.t)} s` : "";
	return `effect: ${input.effect.name}${where}`;
}

function anchorView(anchor: Anchor, elementId?: string) {
	return {
		t: anchor.t === null ? null : round3(anchor.t),
		...(anchor.word ? { word: anchor.word } : {}),
		...(elementId ? { element_id: elementId } : {}),
	};
}

const renderNext = (timelineId: string, commitId: string, t: number | null): Next => ({
	do: `Render this commit and look at the frames${t !== null ? ` around ${round3(t)} s` : ""} (render → look).`,
	tool: "render",
	arguments: { timeline_id: timelineId, commit: commitId, quality: "preview" },
});

const EDITOR_NOTE = "The editor pulls this commit within ~15 s (or on focus) and shows it as \"Claude: <message>\".";

async function commitSnapshot(
	input: ApplyInput,
	head: Head,
	actor: Actor,
	snapshot: ProjectSnapshot,
	ops: unknown[],
	message: string,
): Promise<{ commitId: string; notes?: string[] } | EffectResult> {
	const recorded = [...(input.opsPrefix ?? []), ...ops];
	const notes = input.beforeCommit ? input.beforeCommit(snapshot, recorded) : [];
	if (input.collect) return { commitId: input.collect({ snapshot, ops: recorded, message }), ...(notes.length ? { notes } : {}) };
	const pushed = await pushCommit(input.timelineId, { base_commit: head.headId, branch: head.branch, author: "claude", snapshot, ops: recorded, message }, actor);
	if (!pushed.ok) {
		return failure("conflict", `The timeline moved while applying: its head is ${pushed.conflict.head.id}. Nothing was committed.`, { head: pushed.conflict.head.id }, summaryNext(input.timelineId, "Read the timeline again, then apply on its head."));
	}
	return { commitId: pushed.commit.id, ...(notes.length ? { notes } : {}) };
}

/** ops@1 only: dry run on the head here, else the server's reducer commits them (same as timeline_ops). */
async function commitOps(input: ApplyInput, head: Head, actor: Actor, ops: Op[], message: string): Promise<{ commitId: string; summaries: string[] } | EffectResult> {
	if (input.dryRun) {
		const result = applyOps(head.snapshot as unknown as OpsProject, ops, { seed: `${input.timelineId}/${head.headId}/effects-dry-run`, mode: "atomic" });
		return {
			payload: {
				dry_run: true,
				ok: result.ok,
				effect: effectView(input.effect),
				ops,
				changes: result.changes.ops.map((change) => ({ op: change.op, status: change.status, summary: change.summary })),
				conflicts: result.conflicts.slice(0, 10),
				next: result.ok
					? { do: "Looks right: apply it (same call without dry_run).", tool: "effects", arguments: { action: "apply", name: input.effect.id, timeline_id: input.timelineId } }
					: summaryNext(input.timelineId),
			},
			isError: !result.ok,
		};
	}
	if (input.head || input.opsPrefix?.length || input.beforeCommit || input.collect) {
		// effects-v2 update: the head was edited here (old effect removed): reduce locally, commit the snapshot
		const result = applyOps(head.snapshot as unknown as OpsProject, ops, { seed: `${input.timelineId}/${head.headId}/effects-update`, at: new Date().toISOString() });
		if (!result.ok) return failure("ops_conflict", "The reducer refused it (a target is missing, clips do not meet, or a value is out of range). Nothing was committed.", { ops, conflicts: result.conflicts.slice(0, 10) }, summaryNext(input.timelineId));
		const done = await commitSnapshot(input, head, actor, result.project as unknown as ProjectSnapshot, result.changes.applied, message);
		if (isResult(done)) return done;
		return { commitId: done.commitId, summaries: result.changes.ops.map((change) => change.summary ?? "").filter(Boolean) };
	}
	try {
		const pushed = await pushCommit(input.timelineId, { base_commit: head.headId, branch: head.branch, author: "claude", ops, message }, actor);
		if (!pushed.ok) {
			return failure("conflict", `The timeline moved while applying: its head is ${pushed.conflict.head.id}. Nothing was committed.`, { head: pushed.conflict.head.id }, summaryNext(input.timelineId));
		}
		const changes = (pushed.changes as { ops?: Array<{ summary?: string }> } | undefined)?.ops ?? [];
		return { commitId: pushed.commit.id, summaries: changes.map((change) => change.summary ?? "").filter(Boolean) };
	} catch (error) {
		if (error instanceof HttpError && error.status === 422) {
			const conflicts = error.extra?.conflicts;
			return failure("ops_conflict", "The reducer refused it (a target is missing, clips do not meet, or a value is out of range). Nothing was committed.", { ops, conflicts: Array.isArray(conflicts) ? conflicts.slice(0, 10) : conflicts }, summaryNext(input.timelineId));
		}
		throw error;
	}
}

// composition ───────────────────────────────────────────────────────────────────────────────────────────────────

const stripMeta = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith("$")));

/** Store the rendered WebM in the project's media store under `mediaId`, so the editor pulls it with the commit. */
async function uploadRender(projectId: string, mediaId: string, answer: LibraryRenderAnswer, title: string): Promise<{ size: number }> {
	const bytes = await readFile(answer.file);
	const sha = createHash("sha256").update(bytes).digest("hex");
	const meta = {
		name: `${title} · ${answer.hash.slice(0, 6)}.webm`,
		type: "video",
		width: answer.width,
		height: answer.height,
		duration: answer.duration,
		fps: answer.fps,
		hasAudio: false,
		size: bytes.byteLength,
		lastModified: Date.now(),
	};
	const request = new Request("http://restorffcut.internal/media", {
		method: "PUT",
		body: new Uint8Array(bytes),
		headers: {
			"content-type": "video/webm",
			"x-media-meta": Buffer.from(JSON.stringify(meta), "utf8").toString("base64url"),
			"x-media-sha256": sha,
		},
	});
	await putProjectMedia(projectId, mediaId, request);
	return { size: bytes.byteLength };
}

async function applyComposition(input: ApplyInput, head: Head, anchor: Anchor, actor: Actor): Promise<EffectResult> {
	const plan = input.effect.apply as { kind: "composition"; composition: string };
	const entry = input.entries.find((candidate) => candidate.name === plan.composition);
	if (!entry) return failure("not_in_package", `Composition "${plan.composition}" is not in packages/compositions right now.`, {}, { do: "List what is ready.", tool: "effects", arguments: { action: "list", kind: "composition", status: "ready" } });
	// a manifest recipe (layers around the person, plate keys, matte inputs) → build it in layers; layer "all" = one overlay
	const recipe = readRecipe(entry);
	if (recipe && isLayered(recipe, entry.params) && input.params.layer !== "all") return applyLayered(input, head, anchor, actor, entry, recipe);
	const given = givenSet(input);
	const props: Record<string, unknown> = { ...stripMeta(entry.example ?? {}), ...stripMeta(input.params) };
	const t = anchor.t ?? 0;
	const canvas = canvasOf(head.snapshot);
	const overlay = activeScene(head.snapshot)?.tracks?.overlay ?? [];
	// effects-v2: a free MOTION lane first; a new one goes under the caption lanes (never index 0: E-8)
	const freeTrack = (start: number, end: number) => overlay.find((track) => isMotionLane(track) && laneFree(track, start, end)) ?? null;
	const newLane = { name: nextLaneName(overlay, MOTION_LANE), index: insertIndexFor(overlay, 1) };
	const length = input.durationS ?? entry.duration;
	// effects-v2: the face over the overlay's window (face-safe placement; a `face` param gets the box)
	const face = await overlayFace(input, head, t, length, null);
	if (face.ok && paramType(entry, "face") === "object" && !given.has("face")) props.face = faceProp(rectCentre(face.place.span.face));
	const measure = !input.dryRun || input.measure !== false;

	if (input.dryRun && !measure) {
		const free = freeTrack(toTicks(t), toTicks(t + length));
		return {
			payload: {
				dry_run: true,
				effect: effectView(input.effect),
				at: anchorView(anchor, input.elementId),
				would: {
					render: { composition: entry.name, props: scrubData(props), duration_s: length, size: `${canvas.width}x${canvas.height}`, fps: canvas.fps },
					place: { track: free ? { id: free.id, name: free.name ?? null } : { new: newLane.name, index: newLane.index }, t: round3(t) },
				},
				placement: placementView(face, null),
				next: { do: "Apply it (same call without dry_run).", tool: "effects", arguments: applyAgain(input, { t: round3(t) }) },
			},
		};
	}

	let placed: Placed;
	try {
		placed = await renderAndPlace({ entry, wanted: [{ entry: "self", layer: null, side: "on_top" }], props, canvas, duration: input.durationS, place: face.ok ? face.place : null, given, off: input.placement === "off", signal: input.signal });
	} catch (error) {
		if (error instanceof ServiceError && error.status !== 500 && error.status !== 504) {
			return failure("render_refused", `The composition refused these params; nothing was rendered or committed: ${error.message}`, { props: scrubData(props) }, { do: "Fix the params (describe shows each one) and apply again.", tool: "effects", arguments: { action: "describe", name: input.effect.id } });
		}
		throw error;
	}
	const answer = placed.renders[0].answer;
	const finalProps = placed.props;
	const placement = placementView(face, placed);

	const start = toTicks(t);
	const end = start + toTicks(answer.duration);
	const free = freeTrack(start, end);
	const title = entry.title || entry.name;
	if (input.dryRun) {
		return {
			payload: {
				dry_run: true,
				effect: effectView(input.effect),
				at: anchorView(anchor, input.elementId),
				would: {
					render: { composition: entry.name, props: scrubData(finalProps), duration_s: answer.duration, size: `${canvas.width}x${canvas.height}`, fps: canvas.fps, rendered: { hash: answer.hash, cached: answer.cached, ms: answer.ms } },
					place: { track: free ? { id: free.id, name: free.name ?? null } : { new: newLane.name, index: newLane.index }, t: round3(t) },
				},
				placement,
				note: "Dry run rendered the overlay (cached by its props, so the apply reuses it) to measure where it lands against the face box. measure: false = plan only.",
				next: { do: "Apply it (same call without dry_run).", tool: "effects", arguments: applyAgain(input, { t: round3(t) }) },
			},
		};
	}
	const ops: Record<string, unknown>[] = [
		{ op: "import_media", author: "claude", kind: "video", name: title, url: `/api/compositions/file/${answer.hash}`, duration: answer.duration, width: answer.width, height: answer.height, fps: answer.fps, has_audio: false, ref: "fx_media" },
		...(free ? [] : [{ op: "add_track", author: "claude", kind: "video", name: newLane.name, index: newLane.index, ref: "fx_track" }]),
		{ op: "insert", author: "claude", track: free ? free.id : "fx_track", t, media: "fx_media", in: 0, out: answer.duration, name: title, ref: "fx_clip" },
	];
	const result = applyOps(head.snapshot as unknown as OpsProject, ops as unknown as Op[], { seed: `${input.timelineId}/${head.headId}/effects/${answer.hash}`, at: new Date().toISOString() });
	if (!result.ok) return failure("ops_conflict", "Placing the clip was refused by the timeline reducer. Nothing was committed.", { conflicts: result.conflicts.slice(0, 10) }, summaryNext(input.timelineId));
	const elementId = result.changes.refs.fx_clip;
	const mediaId = result.changes.refs.fx_media;
	const snapshot = result.project as unknown as ProjectSnapshot;
	const placedEl = elementId ? findElement(snapshot, elementId) : null;
	if (!placedEl || !mediaId) return failure("tool_failed", "The clip was not found after placing it (internal).");
	// the same source record the Motion view's drop stores (compositions/types.ts CompositionSource): re-render in place works
	const instance = input.instance ?? newInstanceId();
	const createdTracks = free ? [] : [result.changes.refs.fx_track].filter(Boolean);
	placedEl.element.restorff = {
		...(placedEl.element.restorff ?? {}),
		composition: { name: entry.name, props: finalProps, hash: answer.hash, width: answer.width, height: answer.height, fps: answer.fps, duration: answer.duration },
		effect: {
			id: input.effect.id,
			name: input.effect.name,
			instance,
			applied: appliedRecord(input, anchor, { kind: "composition", t, duration: answer.duration, plate: null, given, createdTracks }),
		},
	} as SnapshotElement["restorff"];

	const media = await uploadRender(input.timelineId, mediaId, answer, title);
	const message = defaultMessage(input, anchor);
	const done = await commitSnapshot(input, head, actor, snapshot, result.changes.applied, message);
	if (isResult(done)) return done;
	const notes: string[] = [...(done.notes ?? [])];
	const behind = recipe ? null : matteVersion(input.effect, input.timelineId, clipAt(head.snapshot, t)?.id);
	if (recipe && isLayered(recipe, entry.params)) {
		notes.push("Placed as one overlay (params.layer \"all\"): nothing passes behind the speaker. Without layer \"all\" apply builds it in layers around the person matte.");
	} else if (input.effect.needs.includes("person_matte")) {
		notes.push(
			behind
				? `Placed as an overlay. The behind-the-speaker version is the cutout tool's preset ${String(behind.arguments?.preset)} (cutout matte, then cutout apply).`
				: "Placed as an overlay. Layering it behind the speaker waits on a person matte (cutout tool).",
		);
	}
	return {
		payload: {
			applied: true,
			effect: effectView(input.effect),
			commit_id: done.commitId,
			branch: head.branch,
			message,
			at: anchorView(anchor, input.elementId),
			element_id: elementId,
			instance,
			media_id: mediaId,
			track: { id: placedEl.track.id, name: placedEl.track.name ?? null, created: !free },
			duration_s: answer.duration,
			composition: { name: entry.name, props: scrubData(finalProps), hash: answer.hash },
			render: { cached: answer.cached, ms: answer.ms, frames: answer.frames, size: `${answer.width}x${answer.height}`, fps: answer.fps, bytes: media.size },
			placement,
			...(input.effect.needs.includes("person_matte") ? { needs_for_full_effect: ["person_matte"] } : {}),
			...(behind ? { behind_the_speaker: behind } : {}),
			...(notes.length ? { notes } : {}),
			change_it: { update: { tool: "effects", arguments: { action: "update", timeline_id: input.timelineId, element_id: elementId, params: {} } }, remove: { tool: "effects", arguments: { action: "remove", timeline_id: input.timelineId, element_id: elementId } } },
			editor: EDITOR_NOTE,
			next: renderNext(input.timelineId, done.commitId, anchor.t),
		},
	};
}

// effects-v2 helpers: placement, tags, scrubbing ─────────────────────────────────────────────────────────────────

/** The same apply call without dry_run (what a dry run's next sends): params included unless they carry pixels. */
function applyAgain(input: ApplyInput, where: Record<string, unknown>): Record<string, unknown> {
	const params = stripMeta(input.params);
	const pixels = JSON.stringify(params).includes("data:");
	return {
		action: "apply",
		name: input.effect.id,
		timeline_id: input.timelineId,
		...(input.word ? { word: input.word, ...(input.occurrence ? { occurrence: input.occurrence } : {}) } : where),
		...(input.word && where.element_id ? { element_id: where.element_id } : {}),
		...(input.durationS !== undefined ? { duration_s: input.durationS } : {}),
		...(Object.keys(params).length && !pixels ? { params } : {}),
		...(pixels ? { params: "the same params you sent (they hold images)" } : {}),
		...(input.placement ? { placement: input.placement } : {}),
	};
}

/** The params the caller set (placement never moves them; update keeps them). */
function givenSet(input: ApplyInput): Set<string> {
	return new Set((input.givenKeys ?? Object.keys(stripMeta(input.params))).filter((key) => key !== "layer"));
}

/** Answers never echo data: URLs (E-7: an apply answered result_too_large with a hidden commit). */
export function scrubData(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return value.startsWith("data:") && value.length > 200 ? `${value.slice(0, value.indexOf(",") > 0 ? Math.min(value.indexOf(","), 40) : 30)} · ${value.length} chars` : value;
	if (depth > 6 || !value || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((item) => scrubData(item, depth + 1));
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, scrubData(item, depth + 1)]));
}

const rectCentre = (rect: Rect) => ({ ...rect, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 });

interface Place {
	face: Rect;
	keepOut: Rect;
	safe: { top: number; bottom: number };
	span: FaceSpan;
	clip_id: string;
	moved?: { scale?: number; x?: number; y?: number };
}

type FaceInfo = { ok: true; place: Place } | { ok: false; why: string; next?: Next };

const FACE_WHY: Record<string, string> = {
	no_clip: "no footage clip under the effect: nothing to keep clear",
	no_media: "the clip's media is not on the server, so its face box cannot be read",
	no_matte: "no face box yet for this clip (the cutout matte makes it): placement was not checked",
	no_faces: "no face found in the clip over the effect",
};

/** The face over [t, t + length] from the clip under it (or `clip`), ready for placement. */
async function overlayFace(input: ApplyInput, head: Head, t: number, length: number, clip: SnapshotElement | null): Promise<FaceInfo> {
	try {
		// revise-safety (2026-10-21): no face box yet → the clip's person matte is started (cached) and the answer says so
		const got = await faceSpanOnCanvas({ projectId: input.timelineId, snapshot: head.snapshot, from: t, to: t + length, clip, start: !input.dryRun });
		if (!got.ok) {
			const job = got.reason === "no_matte" && got.matte_job ? ` — the clip's person matte job ${got.matte_job.job_id} is ${got.started ? "started" : got.matte_job.state}: when it is done, effects update {element_id: <this effect's layer>} with no params re-places it clear of the face` : "";
			return { ok: false, why: `${FACE_WHY[got.reason] ?? got.reason}${job}`, ...(got.reason === "no_matte" ? { next: cutoutNext(input.timelineId, got.clip_id) } : {}) };
		}
		const canvas = canvasOf(head.snapshot);
		return { ok: true, place: { face: got.span.envelope, keepOut: keepOutOf(got.span, canvas), safe: safeBandFor(canvas), span: got.span, clip_id: got.clip_id } };
	} catch (error) {
		return { ok: false, why: `face box unreadable (${error instanceof Error ? error.message : String(error)})` };
	}
}

interface Rendered {
	entry: string;
	layer: string | null;
	side: string;
	props: Record<string, unknown>;
	answer: LibraryRenderAnswer;
}

interface Placed {
	renders: Rendered[];
	props: Record<string, unknown>;
	/** Per measured layer: where it lands against the face (final renders). */
	reports: Array<{ layer: string; report: OverlapReport }>;
	moves: string[];
	behind: string[];
}

function mergeAlpha(list: Array<AlphaFrames | null>): AlphaFrames | null {
	if (list.some((alpha) => alpha === null)) return null;
	const all = list as AlphaFrames[];
	return { width: all[0].width, height: all[0].height, frames: all.flatMap((alpha) => alpha.frames) };
}

/**
 * Render the layers (in parallel; cached by props), measure the ones that can cover the face (on top, or above the
 * person cutout) and move the overlay off the face (effects-placement planMove: drop display text, shift offsetY,
 * shrink scale) — at most 4 renders. `place` null = no face known: render once, no measuring.
 */
async function renderAndPlace({
	entry,
	wanted,
	props: first,
	canvas,
	duration,
	place,
	given,
	off,
	signal,
}: {
	entry: PackageEntry;
	wanted: Array<{ entry: string; layer: string | null; side: string }>;
	props: Record<string, unknown>;
	canvas: { width: number; height: number; fps: number };
	duration?: number;
	place: Place | null;
	given: Set<string>;
	off: boolean;
	signal?: AbortSignal;
}): Promise<Placed> {
	let props = first;
	const hasLayerParam = "layer" in entry.params;
	const tried = new Set<string>();
	const moves: string[] = [];
	let renders: Rendered[] = [];
	let reports: Placed["reports"] = [];
	const behind = wanted.filter((render) => render.side === "below_cutout").map((render) => render.layer ?? render.entry);
	for (let pass = 0; pass < 4; pass++) {
		const current = props;
		renders = await Promise.all(
			wanted.map(async (render) => {
				const layerProps = render.layer && hasLayerParam ? { ...current, layer: render.layer } : current;
				const answer = await callService<LibraryRenderAnswer>({
					verb: "render",
					request: { name: entry.name, props: layerProps, width: canvas.width, height: canvas.height, fps: canvas.fps, ...(duration !== undefined ? { duration } : {}) },
				});
				return { ...render, props: layerProps, answer };
			}),
		);
		if (!place) break;
		const measured = renders.filter((render) => render.side !== "below_cutout");
		if (!measured.length) break;
		const alphas = await Promise.all(measured.map((render) => overlayAlpha(render.answer.file, canvas, { signal })));
		reports = measured.map((render, i) => ({ layer: render.layer ?? render.entry, report: overlapReport(alphas[i], place.face, place.keepOut) }));
		const decision = planMove({ composition: entry.name, alpha: mergeAlpha(alphas), face: place.face, keepOut: place.keepOut, safe: place.safe, props: current, params: entry.params as Record<string, { type?: string }>, given, canvas, tried });
		if (!decision.change) {
			if (!decision.report.clear) moves.push(decision.why);
			break;
		}
		if (off) {
			moves.push(`placement off — it would have: ${decision.why}`);
			break;
		}
		if (pass === 3) {
			moves.push(`stopped after 4 renders; next move would have been: ${decision.why}`);
			break;
		}
		moves.push(decision.why);
		props = { ...current, ...decision.change };
	}
	return { renders, props, reports, moves, behind };
}

/** What answers say about placement (dry runs and applies). */
function placementView(face: FaceInfo, placed: Placed | null) {
	if (!face.ok) return { face_box: null, why: face.why, ...(face.next ? { next: face.next } : {}) };
	const span = face.place.span;
	return {
		face_box: span.face,
		face_envelope: face.place.face,
		keep_out: face.place.keepOut,
		head_top: span.head_top,
		from: `${span.frames} face frames of clip ${face.place.clip_id} (${Math.round(span.found * 100)} % detected; head top from the segmenter in ${span.head_top_from_segmenter})`,
		...(face.place.moved ? { face_moved_like_the_clip: face.place.moved } : {}),
		...(placed
			? {
					layers: placed.reports.map(({ layer, report }) => ({ layer, ...reportView(report) })),
					...(placed.behind.length ? { behind_the_person: placed.behind } : {}),
					...(placed.moves.length ? { moves: placed.moves } : {}),
					all_clear: placed.reports.every(({ report }) => report.clear),
				}
			: { layers: "not measured (measure: false)" }),
		units: "fractions of the canvas (left, top, width, height); face_covered = share of the face box under opaque pixels in the worst frame",
	};
}

/** The record update/remove read back (effects-instances.ts AppliedRecord). */
function appliedRecord(
	input: ApplyInput,
	anchor: Anchor,
	opts: { kind: "composition" | "layered" | "shader"; t: number; duration: number; plate: string | null; given: Set<string>; createdTracks: string[]; person?: string | null; createdCutout?: boolean; plateKeys?: PlateKeyRecord[] },
) {
	return {
		kind: opts.kind,
		t: round3(opts.t),
		duration_s: round3(opts.duration),
		...(anchor.word ? { word: anchor.word.asked, occurrence: anchor.word.occurrence } : {}),
		plate: opts.plate,
		given: [...opts.given],
		...(opts.person !== undefined ? { person: opts.person } : {}),
		created_tracks: opts.createdTracks,
		...(opts.createdCutout !== undefined ? { created_cutout: opts.createdCutout } : {}),
		...(opts.plateKeys?.length ? { plate_keys: opts.plateKeys } : {}),
	};
}

// layered: a composition's manifest recipe (effects-layers agent) ───────────────────────────────────────────────

const MATTE_WAIT_DEFAULT_S = 90;
const MATTE_WAIT_MAX_S = 120;
const r4 = (value: number) => Math.round(value * 10_000) / 10_000;
const numberOr = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const paramType = (entry: PackageEntry, key: string) => (entry.params[key] as { type?: string } | undefined)?.type;

/** The clip a layered effect is built on: element_id (or the clip of a cutout), else the footage under t. */
function plateFor(snapshot: ProjectSnapshot, t: number | null, elementId?: string): Located | null {
	const scene = activeScene(snapshot);
	if (elementId) {
		let found = locate(scene, elementId);
		const source = (found?.element.restorff as { cutout?: { sourceElementId?: string } } | undefined)?.cutout?.sourceElementId;
		if (found && source) found = locate(scene, source) ?? found;
		return found && (found.element.type === "video" || found.element.type === "image") ? found : null;
	}
	const clip = clipAt(snapshot, t ?? 0);
	return clip ? locate(scene, clip.id) : null;
}

/**
 * Build a composition the way its manifest `effect` block says (collage-fx recipes; EFFECTS.md "Layers"), as ONE
 * commit by claude, bottom → top: the clip → `self:back` render(s) on MOTION BACK → the person cutout on V2 CUTOUT
 * → `self:front` render(s) on MOTION FRONT; `self` entries of a stack without "cutout" go on a MOTION lane (under the
 * caption lanes). The server person matte (mcp-cutout's job) is made or reused; its frames, the clip still and the
 * face box fill the props the recipe's inputs name; the plate keys go on the clip and its cutout.
 *
 * effects-v2: the person cutout is a SEGMENT over this effect's window only (reused when one covers it, merged with
 * the segments it touches, kept out of transition windows; the person video is imported and uploaded once per
 * matte); lanes are reused in a fixed order (effects-lanes.ts); layers that can cover the face are measured and moved
 * off it (effects-placement.ts); every element is tagged with the instance + record `effects update/remove` read.
 */
async function applyLayered(input: ApplyInput, firstHead: Head, anchor: Anchor, actor: Actor, entry: PackageEntry, recipe: EffectRecipe): Promise<EffectResult> {
	let head = firstHead;
	const plan = layerPlan(recipe);
	const canvas = canvasOf(head.snapshot);
	const notes: string[] = [];
	const matteKind = matteInput(recipe, entry.params);
	const wantsStill = wantsBackgroundStill(recipe, entry.params);
	const needsMatte = plan.usesCutout || matteKind !== null;
	const title = entry.title || entry.name;
	const effect = effectView(input.effect);
	const given = givenSet(input);
	const measure = !input.dryRun || input.measure !== false;

	let plate = plateFor(head.snapshot, anchor.t, input.elementId);
	if (!plate && (needsMatte || wantsStill)) {
		return failure(
			"no_clip",
			`${input.effect.name} is built around the speaker's clip, and there is no video clip ${input.elementId ? `with id ${input.elementId}` : `under ${round3(anchor.t ?? 0)} s`} (cutouts and compositions do not count). Nothing was applied.`,
			{},
			summaryNext(input.timelineId),
		);
	}
	if (plate && (needsMatte || wantsStill) && plate.element.type !== "video") {
		return failure("unsupported", `${input.effect.name} needs a video clip (the server matte works on video); ${plate.element.id} is ${plate.element.type}.`, {}, summaryNext(input.timelineId));
	}
	if (!plate && plan.plateKeys.length) notes.push("No clip under t to key: the plate keys were skipped.");

	// when: the effect's window, inside the clip when the person is part of it (the cutout ends with the clip)
	const plateStart = plate ? plate.element.startTime / TICKS : 0;
	const plateEnd = plate ? (plate.element.startTime + plate.element.duration) / TICKS : Number.POSITIVE_INFINITY;
	let t = anchor.t ?? plateStart;
	if (plate && (t < plateStart - 1e-6 || t >= plateEnd)) {
		return failure("outside_clip", `t = ${round3(t)} s is outside the clip ${plate.element.id} (${round3(plateStart)}–${round3(plateEnd)} s).`, {}, summaryNext(input.timelineId));
	}
	let duration = input.durationS ?? entry.duration;
	// effects-v2: a person effect stays out of the transition windows on its clip's cuts (the person is cut out of
	// them so the transition moves the whole frame; back layers there would sit on the speaker — SEEN 8.15 s, Orbit)
	if (plate && plan.usesCutout) {
		const half = (win: { start: number; end: number }) => ({ start: win.start / TICKS, end: win.end / TICKS });
		for (const win of transitionWindows(head.snapshot, plate).map(half)) {
			if (win.start <= t + 1e-6 && win.end > t) {
				notes.push(`Starts at ${round3(win.end)} s, after the transition into the clip (${round3(win.start)}–${round3(win.end)} s), so the transition blurs the whole frame.`);
				duration = Math.max(0, duration - (win.end - t));
				t = win.end;
			} else if (win.start < t + duration && win.end >= t + duration) {
				notes.push(`Ends at ${round3(win.start)} s, before the transition out of the clip (${round3(win.start)}–${round3(win.end)} s).`);
				duration = Math.max(0, win.start - t);
			}
		}
		duration = Math.floor(duration * canvas.fps + 1e-6) / canvas.fps;
		if (duration < 0.5) return failure("no_person_window", `${input.effect.name} would have under 0.5 s outside the transition windows of clip ${plate.element.id}. Move it (t) or shorten the transition.`, {}, summaryNext(input.timelineId));
	}
	if (plate && needsMatte && t + duration > plateEnd + 1e-6) {
		const room = Math.floor((plateEnd - t) * canvas.fps) / canvas.fps;
		if (room < 0.5) return failure("clip_too_short", `Only ${round3(plateEnd - t)} s of the clip is left after ${round3(t)} s; ${input.effect.name} needs the speaker on screen.`, {}, summaryNext(input.timelineId));
		notes.push(`Shortened from ${round3(duration)} s to ${round3(room)} s: the clip (and its person cutout) ends at ${round3(plateEnd)} s.`);
		duration = round3(room);
	}

	// the person matte (cached by media hash; made in the background like cutout matte)
	let job: MatteJob | null = null;
	let faces: FaceTrack | null = null;
	let media: MediaRecord | null = null;
	let matteNote: string | null = null;
	if (plate && needsMatte) {
		const waitS = Math.max(0, Math.min(MATTE_WAIT_MAX_S, input.waitS ?? MATTE_WAIT_DEFAULT_S));
		const state = await ensureMatte({ projectId: input.timelineId, mediaId: String(plate.element.mediaId ?? ""), waitMs: input.dryRun ? 0 : waitS * 1000, start: !input.dryRun, signal: input.signal });
		if (state.state === "no_media") {
			return failure(
				"media_not_on_server",
				`The clip's media ${state.mediaId} is not in this timeline's media store on the server, so its person matte cannot be made. Nothing was applied.`,
				{},
				{ do: "List the timeline's media (or import the file with media import).", tool: "media", arguments: { action: "list", timeline_id: input.timelineId } },
			);
		}
		if (state.state === "error") {
			return failure("matte_failed", `The person matte failed: ${state.job.error}. Nothing was applied.`, { job_id: state.job.job_id }, {
				do: "Read the error, then run the matte again.",
				tool: "cutout",
				arguments: { action: "matte", timeline_id: input.timelineId, element_id: plate.element.id, force: true },
			});
		}
		if (state.state === "pending") {
			if (!input.dryRun) {
				const pending = state.job;
				return {
					payload: {
						applied: false,
						status: "matte_running",
						effect,
						message: `${input.effect.name} goes behind the speaker, so it needs the person matte of clip ${plate.element.id}. ${state.started ? "Started it" : "It is being made"} in the background (headless Chromium, ~20 s for 6 s of 1080x1920 plus ~10 s model load); nothing was committed yet.`,
						matte: pending ? { job_id: pending.job_id, state: pending.state, phase: pending.phase, done: pending.done, total: pending.total } : null,
						then: { do: "When the matte is done, call the same apply again (it reuses the cached matte).", tool: "effects", arguments: { action: "apply", name: input.effect.id, timeline_id: input.timelineId, element_id: plate.element.id, t: round3(t) } },
						next: pending
							? { do: "Wait for the person matte (wait_s holds the call), then apply again.", tool: "cutout", arguments: { action: "status", job_id: pending.job_id, wait_s: 90 } }
							: { do: "Start the person matte.", tool: "cutout", arguments: { action: "matte", timeline_id: input.timelineId, element_id: plate.element.id } },
					},
				};
			}
			media = state.media;
			matteNote = state.job ? `the person matte is ${state.job.state} (apply waits up to wait_s for it)` : "no person matte yet: apply starts it (cutout matte) and waits up to wait_s";
		} else {
			({ job, faces, media } = state);
			if (state.waitedMs > 1500 && !input.head) {
				// the matte took a while: build on the head as it is now
				const loaded = await getProjectHead(input.timelineId, input.branch);
				if (!loaded.snapshot) return failure("no_snapshot", "This timeline has no snapshot to add to.");
				const base = input.baseCommit;
				if (base && base !== loaded.head.id && !(base.length >= 7 && loaded.head.id.startsWith(base))) {
					return failure("conflict", `The timeline moved on while the matte ran: its head is ${loaded.head.id}. Nothing was applied.`, { head: loaded.head.id }, summaryNext(input.timelineId));
				}
				head = { branch: loaded.branch, headId: loaded.head.id, snapshot: loaded.snapshot };
				plate = locate(activeScene(head.snapshot), plate.element.id);
				if (!plate) return failure("not_found", "The clip vanished while the matte ran. Nothing was applied.", {}, summaryNext(input.timelineId));
			}
		}
	}
	if (plate && wantsStill && !media) media = await projectMediaRecord(input.timelineId, String(plate.element.mediaId ?? ""));

	let span: ReturnType<typeof clipSpan> | null = null;
	if (plate && job) {
		try {
			span = clipSpan(plate.element, job);
		} catch (error) {
			return failure("cannot_place", error instanceof Error ? error.message : String(error), {}, summaryNext(input.timelineId));
		}
	}

	// the face over the window on the canvas: median face, where it goes, the REAL head top (matte-placement.ts)
	const sourceSize = job?.source ?? faces?.source ?? (media?.meta ? { width: Number(media.meta.width) || canvas.width, height: Number(media.meta.height) || canvas.height } : { width: canvas.width, height: canvas.height });
	let fspan: FaceSpan | null = null;
	let faceClip = plate?.element.id ?? "";
	let faceWhy = "no clip to read a face from";
	if (plate && span && faces) {
		fspan = faceSpanFrom(faces.frames, span.sourceAt(t), span.sourceAt(t + duration), sourceToCanvas(plate.element, sourceSize, canvas));
		if (!fspan) faceWhy = FACE_WHY.no_faces;
	} else if (plate) {
		const got = await overlayFace(input, head, t, duration, plate.element);
		if (got.ok) {
			fspan = got.place.span;
			faceClip = got.place.clip_id;
		} else faceWhy = got.why;
	}
	const faceC = fspan ? rectCentre(fspan.face) : null;
	const headC = faceC && fspan ? { left: faceC.left - 0.1 * faceC.width, top: fspan.head_top, width: faceC.width * 1.2, height: Math.max(0.01, faceC.top + faceC.height - fspan.head_top), cx: faceC.cx } : null;

	// props: example < recipe props < what the matte fills < what the caller sent
	const givenParams = stripMeta(input.params);
	delete givenParams.layer;
	const has = (key: string) => key in givenParams;
	const base: Record<string, unknown> = { ...stripMeta(entry.example ?? {}), ...(recipe.props ?? {}), ...givenParams };
	const computed: Record<string, unknown> = {};
	const fed: string[] = [];
	const inputsUsed: Record<string, unknown> = {};
	if (faceC && headC && fspan) {
		// any composition with a face box param gets it (orbit, vertigo; headline-wall once its manifest takes one)
		if (paramType(entry, "face") === "object" && !has("face")) {
			computed.face = faceProp(faceC);
			inputsUsed.face = { ...(computed.face as object), from: `median of ${fspan.frames} face frames over the effect` };
		}
		if ("mastheadOffset" in entry.params && !has("mastheadOffset")) {
			computed.mastheadOffset = mastheadOffsetFor({ headTop: headC.top, canvas, wordmark: String(base.wordmark ?? ""), frameInset: numberOr(base.frameInset, 32) });
			inputsUsed.mastheadOffset = { value: computed.mastheadOffset, head_top: r4(headC.top), head_top_from: fspan.head_top_from_segmenter ? `the segmenter's head in ${fspan.head_top_from_segmenter} of ${fspan.frames} frames, else face top − 0.35 face heights` : "face top − 0.35 face heights" };
		}
		if (paramType(entry, "window") === "object" && !has("window")) {
			const current = (base.window ?? (entry.params.window as { default?: unknown }).default ?? {}) as { w?: number; h?: number };
			computed.window = frameBreakWindow({ head: headC, plateScale: numberOr(base.plateScale, 0.82), plateY: numberOr(base.plateY, 0), width: numberOr(current.w, 0.6), height: numberOr(current.h, 0.42) });
			inputsUsed.window = { ...(computed.window as object), head_top: r4(headC.top) };
		}
		// glass-type: the word's centre on the head top, so the head covers its lower half (E-2: it sat above the head)
		if (entry.name === "glass-type" && paramType(entry, "y") === "number" && !has("y")) {
			computed.y = r4(Math.min(0.9, Math.max(0.08, headC.top + 0.01)));
			inputsUsed.y = { value: computed.y, head_top: r4(headC.top) };
		}
	}
	const webm = job?.outputs?.person_webm;
	const matteFps = Math.max(1, Math.min(60, Math.round(Math.min(canvas.fps, webm?.fps ?? canvas.fps))));
	if ((!input.dryRun || measure) && plate && job && span) {
		try {
			if (matteKind === "frames" && !has("matte")) {
				const count = Math.max(1, Math.ceil(duration * matteFps - 1e-6));
				const frames = await matteFrames({ job, plate: plate.element, span, canvas, from: t, count, fps: matteFps, signal: input.signal });
				Object.assign(computed, { matte: frames.urls, matteFps, matteChannel: "alpha" });
				fed.push("matte");
				inputsUsed.matte = { frames: frames.urls.length, fps: matteFps, size: frames.size, bytes: frames.bytes, cached: frames.cached };
			}
			if (matteKind === "plate+matte" && !has("plate") && !has("background") && !has("matte") && media) {
				const still = await clipStill({ media, plate: plate.element, span, canvas, at: t, source: sourceSize, signal: input.signal });
				const one = await matteFrames({ job, plate: plate.element, span, canvas, from: t, count: 1, fps: matteFps, signal: input.signal });
				Object.assign(computed, { plate: still.url, matte: one.urls.slice(0, 1), matteChannel: "alpha" });
				fed.push("plate", "matte");
				inputsUsed.plate = { still_at: round3(t), bytes: still.bytes };
				inputsUsed.matte = { frames: 1, at: round3(t), bytes: one.bytes };
			}
		} catch (error) {
			return failure("matte_frames_failed", `Could not cut the person matte into frames: ${error instanceof Error ? error.message : String(error)}. Nothing was applied.`, {}, summaryNext(input.timelineId));
		}
	}
	if ((!input.dryRun || measure) && plate && wantsStill && !has("background") && media) {
		try {
			const spanForStill = span ?? { inS: 0, usedS: 0, rate: 1, webmAt: (x: number) => x, sourceAt: (x: number) => (plate.element.trimStart ?? 0) / TICKS + (x - plateStart) };
			const still = await clipStill({ media, plate: plate.element, span: spanForStill, canvas, at: t, source: sourceSize, signal: input.signal });
			computed.background = still.url;
			fed.push("background");
			inputsUsed.background = { still_at: round3(t), bytes: still.bytes };
		} catch (error) {
			notes.push(`No still of the clip for props.background (${error instanceof Error ? error.message : String(error)}): the composition's own fallback is used.`);
		}
	}
	const props: Record<string, unknown> = { ...base, ...computed };
	const keysPlan = plate && plan.plateKeys.length ? plateKeysFor({ recipe, name: entry.name, duration, defaultDuration: entry.duration, props }) : { keys: [], notes: [] };
	notes.push(...keysPlan.notes);

	// the person: a cutout segment over this window only (reused, merged with what it touches, or new)
	const start = toTicks(t);
	const end = start + toTicks(duration);
	const frameTicks = Math.round(TICKS / canvas.fps);
	const overlay = activeScene(head.snapshot)?.tracks?.overlay ?? [];
	let seg: SegmentPlan | null = null;
	let laneId: string | null = null;
	let laneIndex = -1;
	let laneNew = false;
	if (plan.usesCutout && plate && job && span) {
		seg = planSegment(head.snapshot, plate, start, end, frameTicks);
		if (!seg) {
			return failure("no_person_window", `${input.effect.name} at ${round3(t)} s for ${round3(duration)} s lies inside a transition window of clip ${plate.element.id}: there is no moment to put the person in. Move it (t) or shorten the transition.`, {}, summaryNext(input.timelineId));
		}
		notes.push(...seg.notes);
		if (seg.reuse) {
			laneId = seg.reuse.track.id;
			laneIndex = seg.reuse.index;
		} else {
			const mergeIds = new Set(seg.merge.map((item) => item.element.id));
			const union = seg.union;
			const fits = (track: SnapshotTrack) => (track.elements ?? []).every((el) => mergeIds.has(el.id) || !(union.start < el.startTime + el.duration && union.end > el.startTime));
			const fromMerge = seg.merge.find((item) => fits(item.track));
			const freeIndex = overlay.findIndex((track) => isCutoutLane(track) && fits(track));
			if (fromMerge) {
				laneId = fromMerge.track.id;
				laneIndex = fromMerge.index;
			} else if (freeIndex >= 0) {
				laneId = overlay[freeIndex].id;
				laneIndex = freeIndex;
			} else {
				laneNew = true;
				laneIndex = plate.group === "overlay" ? plate.index : overlay.length;
			}
		}
	}

	// placement: the face moved like the clip while the plate keys hold it (ui-world lowers it a quarter)
	const held = heldMove(keysPlan.keys);
	const place: Place | null = fspan
		? { face: moveRect(fspan.envelope, held ?? {}), keepOut: moveRect(keepOutOf(fspan, canvas), held ?? {}), safe: safeBandFor(canvas), span: fspan, clip_id: faceClip, ...(held ? { moved: held } : {}) }
		: null;
	const faceInfo: FaceInfo = place ? { ok: true, place } : { ok: false, why: faceWhy };
	const canRender = !needsMatte || !!job;

	if (input.dryRun && (!measure || !canRender)) {
		return {
			payload: {
				dry_run: true,
				effect,
				at: { ...anchorView(anchor, input.elementId), t: round3(t) },
				would: {
					stack: recipe.stack,
					clip: plate ? { element_id: plate.element.id, name: plate.element.name ?? null } : null,
					...(plan.usesCutout ? { person: personPlanView(seg, laneNew, laneId) ?? { create: "a V2 CUTOUT segment over the effect's window (after the matte is made)" } } : {}),
					renders: plan.renders.map((render) => ({ entry: render.entry, layer: render.layer, goes: render.side.replace("_", " ") })),
					duration_s: duration,
					fills: layeredInputs(recipe, entry.params),
					...(Object.keys(inputsUsed).length ? { computed: inputsUsed } : {}),
					...(keysPlan.keys.length ? { plate_keys: keysPlan.keys } : {}),
					...(matteNote ? { matte: matteNote } : job ? { matte: `done (${job.job_id}, cached)` } : {}),
				},
				placement: placementView(faceInfo, null),
				...(notes.length ? { notes } : {}),
				next: { do: "Apply it (same call without dry_run).", tool: "effects", arguments: applyAgain(input, { ...(plate ? { element_id: plate.element.id } : {}), t: round3(t) }) },
			},
		};
	}

	// render every layer (in parallel: each is its own Chromium), measure what can cover the face, move it off
	let placed: Placed;
	try {
		placed = await renderAndPlace({ entry, wanted: plan.renders, props, canvas, duration, place, given, off: input.placement === "off", signal: input.signal });
	} catch (error) {
		if (error instanceof ServiceError && error.status !== 500 && error.status !== 504) {
			return failure("render_refused", `The composition refused these params; nothing was rendered or committed: ${error.message.slice(0, 1200)}`, { props: scrubData(storableProps(props, fed)) }, { do: "Fix the params (describe shows each one) and apply again.", tool: "effects", arguments: { action: "describe", name: input.effect.id } });
		}
		throw error;
	}
	const renders = placed.renders;
	const finalProps = placed.props;
	const placement = placementView(faceInfo, placed);

	if (input.dryRun) {
		return {
			payload: {
				dry_run: true,
				effect,
				at: { ...anchorView(anchor, input.elementId), t: round3(t) },
				would: {
					stack: recipe.stack,
					clip: plate ? { element_id: plate.element.id, name: plate.element.name ?? null } : null,
					...(plan.usesCutout ? { person: personPlanView(seg, laneNew, laneId) } : {}),
					renders: renders.map((item) => ({ entry: item.entry, layer: item.layer, goes: item.side.replace("_", " "), rendered: { hash: item.answer.hash, cached: item.answer.cached, ms: item.answer.ms } })),
					duration_s: duration,
					...(Object.keys(inputsUsed).length ? { computed: inputsUsed } : {}),
					...(keysPlan.keys.length ? { plate_keys: keysPlan.keys } : {}),
					props: scrubData(storableProps(finalProps, fed)),
					matte: job ? `done (${job.job_id}, cached)` : null,
				},
				placement,
				...(notes.length ? { notes } : {}),
				note: "Dry run rendered the layers (cached by props: the apply reuses them) to measure where they land against the face box. measure: false = plan only.",
				next: { do: "Apply it (same call without dry_run).", tool: "effects", arguments: applyAgain(input, { ...(plate ? { element_id: plate.element.id } : {}), t: round3(t) }) },
			},
		};
	}

	// ops (batch A): lanes in the documented order, the render clips, the plate keys
	const ops: Record<string, unknown>[] = [];
	const createdRefs: string[] = [];
	const used = new Set<string>();
	const laneFor: string[] = [];
	const motionIndex = insertIndexFor(overlay, 1);
	let motionAdded = 0;
	renders.forEach((item, i) => {
		if (item.side !== "on_top") return;
		const free = overlay.find((track) => isMotionLane(track) && !used.has(track.id) && laneFree(track, start, end));
		if (free) {
			used.add(free.id);
			laneFor[i] = free.id;
			return;
		}
		const ref = `fx_track_${i}`;
		ops.push({ op: "add_track", author: "claude", kind: "video", name: nextLaneName(overlay, MOTION_LANE, motionAdded), index: motionIndex + motionAdded, ref });
		motionAdded++;
		createdRefs.push(ref);
		laneFor[i] = ref;
	});
	if (plan.usesCutout && laneIndex >= 0) {
		const shift = motionAdded && motionIndex <= laneIndex ? motionAdded : 0;
		const x = laneIndex + shift;
		if (laneNew) {
			ops.push({ op: "add_track", author: "claude", kind: "video", name: CUTOUT_LANE, index: x, ref: "cutout_track" }, { op: "set", author: "claude", track: "cutout_track", prop: "muted", value: true });
			createdRefs.push("cutout_track");
			laneId = "cutout_track";
		}
		const fronts: SnapshotTrack[] = [];
		for (let i = laneIndex - 1; i >= 0 && isFrontLane(overlay[i]); i--) fronts.push(overlay[i]);
		const backs: SnapshotTrack[] = [];
		for (let i = laneNew ? laneIndex : laneIndex + 1; i < overlay.length && isBackLane(overlay[i]); i++) backs.push(overlay[i]);
		let backsAdded = 0;
		renders.forEach((item, i) => {
			if (item.side !== "below_cutout") return;
			const free = backs.find((track) => !used.has(track.id) && laneFree(track, start, end));
			if (free) {
				used.add(free.id);
				laneFor[i] = free.id;
				return;
			}
			const ref = `fx_track_${i}`;
			ops.push({ op: "add_track", author: "claude", kind: "video", name: nextLaneName(overlay, BACK_LANE, backsAdded), index: x + 1 + backs.length + backsAdded, ref });
			backsAdded++;
			createdRefs.push(ref);
			laneFor[i] = ref;
		});
		let frontsAdded = 0;
		renders.forEach((item, i) => {
			if (item.side !== "above_cutout") return;
			const free = fronts.find((track) => !used.has(track.id) && laneFree(track, start, end));
			if (free) {
				used.add(free.id);
				laneFor[i] = free.id;
				return;
			}
			const ref = `fx_track_${i}`;
			ops.push({ op: "add_track", author: "claude", kind: "video", name: nextLaneName(overlay, FRONT_LANE, frontsAdded), index: x, ref });
			frontsAdded++;
			createdRefs.push(ref);
			laneFor[i] = ref;
		});
	}
	renders.forEach((item, i) => {
		const clipName = `${title}${item.layer ? ` · ${item.layer}` : ""}`;
		ops.push(
			{ op: "import_media", author: "claude", kind: "video", name: clipName, url: `/api/compositions/file/${item.answer.hash}`, duration: item.answer.duration, width: item.answer.width, height: item.answer.height, fps: item.answer.fps, has_audio: false, ref: `fx_media_${i}` },
			{ op: "insert", author: "claude", track: laneFor[i], t, media: `fx_media_${i}`, in: 0, out: item.answer.duration, name: clipName, ref: `fx_clip_${i}` },
		);
	});
	const keyRecords: PlateKeyRecord[] = [];
	const keyTargets: string[] = [];
	const writeKeys = (el: string, elStart: number) => {
		const p = plate?.element.params;
		const baseValues = { sx: numberOr(p?.["transform.scaleX"], 1), sy: numberOr(p?.["transform.scaleY"], 1), px: numberOr(p?.["transform.positionX"], 0), py: numberOr(p?.["transform.positionY"], 0) };
		const offset = (start - elStart) / TICKS;
		const record: PlateKeyRecord = { el, props: [], times: [] };
		for (const key of keysPlan.keys) {
			const at = round3(offset + key.t);
			const ease = key.ease ? { ease: key.ease } : {};
			const keyframe = (prop: string, value: number) => {
				ops.push({ op: "keyframe", author: "claude", el, prop, t: at, value, local: true, ...ease });
				if (!record.props.includes(prop)) record.props.push(prop);
			};
			if (key.scale !== undefined) {
				keyframe("transform.scaleX", r4(baseValues.sx * key.scale));
				keyframe("transform.scaleY", r4(baseValues.sy * key.scale));
			}
			if (key.x !== undefined) keyframe("transform.positionX", Math.round((baseValues.px + key.x * canvas.width) * 100) / 100);
			if (key.y !== undefined) keyframe("transform.positionY", Math.round((baseValues.py + key.y * canvas.height) * 100) / 100);
			record.times.push(Math.round(at * TICKS));
		}
		keyRecords.push(record);
		keyTargets.push(el);
	};
	if (plate && keysPlan.keys.length) {
		if (plan.plateKeysOn.includes("plate") || plan.plateKeysOn.length === 0) writeKeys(plate.element.id, plate.element.startTime);
		// the person moves with the clip: a reused segment gets the same keys (a new one copies them from the clip)
		if (seg?.reuse) writeKeys(seg.reuse.element.id, seg.reuse.element.startTime);
	}

	const result = applyOps(head.snapshot as unknown as OpsProject, ops as unknown as Op[], { seed: `${input.timelineId}/${head.headId}/effects-layers/${renders.map((item) => item.answer.hash.slice(0, 8)).join("-")}`, at: new Date().toISOString() });
	if (!result.ok) return failure("ops_conflict", "Placing the layers was refused by the timeline reducer. Nothing was committed.", { conflicts: result.conflicts.slice(0, 10) }, summaryNext(input.timelineId));
	let snapshot = result.project as unknown as ProjectSnapshot;
	let applied: unknown[] = [...result.changes.applied];
	const refs = result.changes.refs;

	// batch B: the person segment (one person video per matte job: imported and uploaded once)
	let cutoutId: string | null = seg?.reuse?.element.id ?? null;
	let personRef: string | null = null;
	let createdCutout = false;
	let segmentView: Record<string, unknown> | null = seg?.reuse ? { element_id: seg.reuse.element.id, reused: true, from: toSeconds(seg.reuse.element.startTime), to: toSeconds(seg.reuse.element.startTime + seg.reuse.element.duration) } : null;
	if (seg && !seg.reuse && plate && job && span && laneId) {
		const mediaId = personMediaId(snapshot, job);
		const lane = laneId === "cutout_track" ? refs.cutout_track : laneId;
		try {
			const fields = segmentFields({ snapshot, plateId: plate.element.id, job, faces, span, union: seg.union, mediaId });
			const b = applyOps(snapshot as unknown as OpsProject, segmentOps({ plate, job, fields, lane, index: 0, mediaId, merge: seg.merge }) as unknown as Op[], { seed: `${input.timelineId}/${head.headId}/effects-segment/${seg.union.start}`, at: new Date().toISOString() });
			if (!b.ok) return failure("ops_conflict", "Placing the person segment was refused by the timeline reducer. Nothing was committed.", { conflicts: b.conflicts.slice(0, 10) }, summaryNext(input.timelineId));
			snapshot = b.project as unknown as ProjectSnapshot;
			applied = [...applied, ...b.changes.applied];
			cutoutId = b.changes.refs.cutout_clip;
			finishSegment(snapshot, cutoutId, fields);
			if (!mediaId) personRef = b.changes.refs.cutout_media;
			createdCutout = true;
			const segStart = fields.startTime as number;
			if (keysPlan.keys.length) {
				const offset = (start - segStart) / TICKS;
				const plateRecord = keyRecords.find((record) => record.el === plate.element.id);
				keyRecords.push({ el: cutoutId, props: plateRecord?.props ?? [], times: keysPlan.keys.map((key) => Math.round((offset + key.t) * TICKS)) });
			}
			repointPerson(snapshot, seg.merge, cutoutId, segStart);
			segmentView = {
				element_id: cutoutId,
				from: toSeconds(segStart),
				to: toSeconds(segStart + (fields.duration as number)),
				...(seg.merge.length ? { merged: seg.merge.map((item) => item.element.id) } : {}),
				media: mediaId ? { reused: mediaId } : { imported: "person.webm (uploaded once for this matte)" },
			};
		} catch (error) {
			return failure("cannot_place", `The person segment could not be made: ${error instanceof Error ? error.message : String(error)}. Nothing was committed.`, {}, summaryNext(input.timelineId));
		}
	}

	// tag every layer: the instance + the record update/remove read back
	const instance = input.instance ?? newInstanceId();
	const createdTracks = createdRefs.map((ref) => refs[ref]).filter((id): id is string => !!id);
	const record = appliedRecord(input, anchor, {
		kind: "layered",
		t,
		duration,
		plate: plate?.element.id ?? null,
		given,
		createdTracks,
		...(plan.usesCutout ? { person: cutoutId, createdCutout } : {}),
		plateKeys: keyRecords,
	});
	const sceneAfter = activeScene(snapshot);
	const layerViews: Record<string, unknown>[] = [];
	for (let i = 0; i < renders.length; i++) {
		const render = renders[i];
		const elementId = refs[`fx_clip_${i}`];
		const mediaId = refs[`fx_media_${i}`];
		const found = elementId ? locate(sceneAfter, elementId) : null;
		if (!found || !mediaId) return failure("tool_failed", "A layer clip was not found after placing it (internal).");
		found.element.restorff = {
			...(found.element.restorff ?? {}),
			// the Motion view's CompositionSource (re-render in place works; pixel inputs are not stored: re-apply to refresh)
			composition: { name: entry.name, props: storableProps(render.props, fed), hash: render.answer.hash, width: render.answer.width, height: render.answer.height, fps: render.answer.fps, duration: render.answer.duration },
			effect: { id: input.effect.id, name: input.effect.name, layer: render.layer, side: render.side, stack: recipe.stack, ...(fed.length ? { fed_from_matte: fed, matte_job: job?.job_id ?? null } : {}), instance, applied: record },
		} as SnapshotElement["restorff"];
		layerViews.push({
			entry: render.entry,
			layer: render.layer,
			goes: render.side.replace("_", " "),
			element_id: elementId,
			media_id: mediaId,
			track: { id: found.track.id, name: found.track.name ?? null, created: !used.has(found.track.id) },
			render: { hash: render.answer.hash, cached: render.answer.cached, ms: render.answer.ms, frames: render.answer.frames, bytes: render.answer.bytes },
		});
	}

	// order bottom → top of the tracks this effect touches (what a look at the render should show)
	const involved = new Set([plate?.element.id, cutoutId, ...layerViews.map((view) => view.element_id as string)].filter(Boolean));
	const bottomUp = [...(sceneAfter?.tracks?.main ? [sceneAfter.tracks.main] : []), ...[...(sceneAfter?.tracks?.overlay ?? [])].reverse()];
	const order = bottomUp.flatMap((track) =>
		(track.elements ?? [])
			.filter((el) => involved.has(el.id))
			.map((el) => `${track.name ?? track.id}: ${el.id === plate?.element.id ? "the clip" : el.id === cutoutId ? "the person (cutout)" : (el.name ?? el.id)}`),
	);
	const drift = laneDrift(sceneAfter?.tracks?.overlay ?? []);
	if (drift.length) notes.push(`Lanes out of the documented order (from earlier edits; effects never reorder): ${drift.slice(0, 3).join("; ")}.`);

	// media: the renders and (when imported here) the person video, then one commit
	for (let i = 0; i < renders.length; i++) {
		const render = renders[i];
		await uploadRender(input.timelineId, refs[`fx_media_${i}`], render.answer, `${title}${render.layer ? ` ${render.layer}` : ""}`);
	}
	let personBytes: number | null = null;
	if (personRef && job) personBytes = (await uploadPerson(input.timelineId, personRef, job, `${plate?.element.name ?? "clip"} · cutout`)).bytes;
	const message = defaultMessage(input, { ...anchor, t });
	const done = await commitSnapshot(input, head, actor, snapshot, applied, message);
	if (isResult(done)) return done;
	notes.push(...(done.notes ?? []));
	return {
		payload: {
			applied: true,
			layered: true,
			effect,
			commit_id: done.commitId,
			branch: head.branch,
			message,
			instance,
			at: { ...anchorView(anchor, input.elementId), t: round3(t) },
			duration_s: duration,
			stack: recipe.stack,
			order_bottom_to_top: order,
			clip: plate ? { element_id: plate.element.id, name: plate.element.name ?? null } : null,
			...(plan.usesCutout
				? { person: { element_id: cutoutId, created: createdCutout, segment: segmentView, matte_job: job?.job_id ?? null, ...(personBytes !== null ? { uploaded_bytes: personBytes } : { uploaded_bytes: 0 }), face_found: faces?.summary.face_found ?? null } }
				: {}),
			layers: layerViews,
			...(Object.keys(inputsUsed).length ? { filled: inputsUsed } : {}),
			placement,
			...(keysPlan.keys.length ? { plate_keys: { keys: keysPlan.keys, on: keyTargets.concat(createdCutout && cutoutId ? [cutoutId] : []) } } : {}),
			composition: { name: entry.name, props: scrubData(storableProps(finalProps, fed)) },
			...(notes.length ? { notes } : {}),
			change_it: {
				update: { tool: "effects", arguments: { action: "update", timeline_id: input.timelineId, element_id: layerViews[0]?.element_id, params: {} } },
				remove: { tool: "effects", arguments: { action: "remove", timeline_id: input.timelineId, element_id: layerViews[0]?.element_id } },
			},
			editor: EDITOR_NOTE,
			next: renderNext(input.timelineId, done.commitId, t),
		},
	};
}

/** The plate key with the biggest move (the hold of ui-world / frame-break / pullback): how the face moves with it. */
function heldMove(keys: Array<{ scale?: number; x?: number; y?: number }>): { scale?: number; x?: number; y?: number } | null {
	let best: { scale?: number; x?: number; y?: number } | null = null;
	let score = 0;
	for (const key of keys) {
		const s = Math.abs(key.y ?? 0) + Math.abs(key.x ?? 0) + Math.abs((key.scale ?? 1) - 1);
		if (s > score + 1e-9) {
			score = s;
			best = { ...(key.scale !== undefined ? { scale: key.scale } : {}), ...(key.x !== undefined ? { x: key.x } : {}), ...(key.y !== undefined ? { y: key.y } : {}) };
		}
	}
	return best;
}

function personPlanView(seg: SegmentPlan | null, laneNew: boolean, laneId: string | null) {
	if (!seg) return null;
	if (seg.reuse) return { reuse: seg.reuse.element.id, from: toSeconds(seg.reuse.element.startTime), to: toSeconds(seg.reuse.element.startTime + seg.reuse.element.duration) };
	return {
		create: "a V2 CUTOUT segment (the person only over this window)",
		from: toSeconds(seg.union.start),
		to: toSeconds(seg.union.end),
		...(seg.merge.length ? { merges: seg.merge.map((item) => item.element.id) } : {}),
		lane: laneNew ? "a new V2 CUTOUT lane" : laneId,
		...(seg.notes.length ? { notes: seg.notes } : {}),
	};
}

/** Effects that stood on merged segments now stand on the new one (their key records move with it). */
function repointPerson(snapshot: ProjectSnapshot, merged: Located[], cutoutId: string, segStart: number): void {
	if (!merged.length) return;
	const old = new Map(merged.map((item) => [item.element.id, item.element.startTime]));
	const scene = activeScene(snapshot);
	for (const track of [...(scene?.tracks?.overlay ?? []), ...(scene?.tracks?.main ? [scene.tracks.main] : [])]) {
		for (const el of track.elements ?? []) {
			const applied = (el.restorff as { effect?: { applied?: { person?: string | null; plate_keys?: PlateKeyRecord[] } } } | undefined)?.effect?.applied;
			if (!applied) continue;
			if (applied.person && old.has(applied.person)) applied.person = cutoutId;
			for (const keys of applied.plate_keys ?? []) {
				const was = old.get(keys.el);
				if (was === undefined) continue;
				keys.times = keys.times.map((time) => time + (was - segStart));
				keys.el = cutoutId;
			}
		}
	}
}

// shader ────────────────────────────────────────────────────────────────────────────────────────────────────────

function shaderParams(effectType: string, preset: Record<string, number | string>, given: Record<string, unknown>): { values: Record<string, number | string>; ignored: string[] } {
	const definition = SHADER_DEFINITIONS[effectType];
	const known = new Map((definition?.params ?? []).map((param) => [param.key, param as unknown as { type: string; min?: number; max?: number }]));
	const values: Record<string, number | string> = { ...shaderDefaults(effectType), ...preset };
	const ignored: string[] = [];
	for (const [key, value] of Object.entries(given)) {
		const spec = known.get(key);
		if (!spec) {
			ignored.push(key);
			continue;
		}
		if (spec.type === "number" && typeof value === "number" && Number.isFinite(value)) {
			values[key] = Math.min(spec.max ?? Number.POSITIVE_INFINITY, Math.max(spec.min ?? Number.NEGATIVE_INFINITY, value));
		} else if (typeof value === "string" || typeof value === "number") {
			values[key] = value;
		} else ignored.push(key);
	}
	return { values, ignored };
}

/** Shaders with a focus point: the face's centre goes there unless the caller set it (E-2: Digital Zoom sat at 50/42). */
const FOCUS_KEYS: Record<string, [string, string]> = { "restorff-digital-zoom": ["focusX", "focusY"] };

/**
 * effects-v2: the focus of a shader on the speaker's face over [from, to] (percent of the frame). No face box yet →
 * start the clip's matte and wait up to wait_s (default 45 s); still none → the preset's point and a note.
 */
async function focusOnFace(input: ApplyInput, head: Head, effectType: string, values: Record<string, number | string>, from: number, to: number, clip: SnapshotElement | null): Promise<{ note: string; focus?: { x: number; y: number; face: Rect } }> {
	const keys = FOCUS_KEYS[effectType];
	if (!keys) return { note: "" };
	const given = givenSet(input);
	if (given.has(keys[0]) || given.has(keys[1])) return { note: `focus ${values[keys[0]]} / ${values[keys[1]]} as you set it` };
	let got = await faceSpanOnCanvas({ projectId: input.timelineId, snapshot: head.snapshot, from, to, clip, start: !input.dryRun });
	if (!got.ok && got.reason === "no_matte" && got.matte_job && !input.dryRun) {
		const waitS = Math.max(0, Math.min(MATTE_WAIT_MAX_S, input.waitS ?? 45));
		if (waitS > 0) {
			await waitForMatte(got.matte_job.job_id, waitS * 1000, input.signal);
			got = await faceSpanOnCanvas({ projectId: input.timelineId, snapshot: head.snapshot, from, to, clip });
		}
	}
	if (!got.ok) {
		return { note: `focus ${values[keys[0]]} / ${values[keys[1]]} (the preset's point): ${FACE_WHY[got.reason] ?? got.reason}${got.reason === "no_matte" && got.matte_job ? ` — the matte job ${got.matte_job.job_id} is ${got.started ? "started" : got.matte_job.state}; effects update this element with no params once it is done to centre it on the face` : ""}` };
	}
	const face = got.span.face;
	const x = Math.round((face.left + face.width / 2) * 1000) / 10;
	const y = Math.round((face.top + face.height / 2) * 1000) / 10;
	values[keys[0]] = Math.min(100, Math.max(0, x));
	values[keys[1]] = Math.min(100, Math.max(0, y));
	return { note: `focus on the face: ${values[keys[0]]} / ${values[keys[1]]} % (median of ${got.span.frames} face frames of clip ${got.clip_id})`, focus: { x: values[keys[0]] as number, y: values[keys[1]] as number, face } };
}

async function applyShader(input: ApplyInput, head: Head, anchor: Anchor, actor: Actor): Promise<EffectResult> {
	const plan = input.effect.apply as { kind: "shader"; effectType: string; params: Record<string, number | string>; hold_s: number; holdToSentence?: boolean };
	const { values, ignored } = shaderParams(plan.effectType, plan.params, input.params);
	const label = SHADER_DEFINITIONS[plan.effectType]?.name ?? input.effect.name;
	const message = defaultMessage(input, anchor);

	// on one clip, for its whole length
	if (input.elementId) {
		const snapshot = clone(head.snapshot);
		const found = findElement(snapshot, input.elementId);
		if (!found) return failure("not_found", `No element ${input.elementId} on this timeline.`, {}, summaryNext(input.timelineId));
		if (!["video", "image", "text", "sticker", "graphic"].includes(found.element.type)) {
			return failure("incompatible", `${found.element.type} elements have no picture for ${label}.`, {}, summaryNext(input.timelineId));
		}
		const effects = [...((found.element.effects as Array<{ id: string; type: string }> | undefined) ?? [])];
		const gradeAt = effects.findIndex((effect) => effect.type === "restorff-grade");
		const clipFrom = found.element.startTime / TICKS;
		const focus = await focusOnFace(input, head, plan.effectType, values, clipFrom, clipFrom + found.element.duration / TICKS, found.element.type === "video" ? found.element : null);
		const effect = { id: randomUUID(), type: plan.effectType, params: values, enabled: true };
		effects.splice(gradeAt >= 0 ? gradeAt : effects.length, 0, effect); // a grade stays last: it colours what the others made
		found.element.effects = effects;
		if (input.dryRun) {
			return { payload: { dry_run: true, effect: effectView(input.effect), would: { add_effect: { element_id: input.elementId, type: plan.effectType, params: values } }, ...(focus.note ? { focus: focus.note } : {}), ...(ignored.length ? { ignored_params: ignored } : {}), next: { do: "Apply it (same call without dry_run).", tool: "effects", arguments: applyAgain(input, { element_id: input.elementId }) } } };
		}
		const done = await commitSnapshot(input, head, actor, snapshot, [], message);
		if (isResult(done)) return done;
		return {
			payload: {
				applied: true,
				effect: effectView(input.effect),
				commit_id: done.commitId,
				branch: head.branch,
				message,
				at: anchorView(anchor, input.elementId),
				on_clip: { element_id: input.elementId, effect_id: effect.id, type: plan.effectType, params: values, whole_clip: true },
				...(focus.note ? { focus: focus.note } : {}),
				...(ignored.length ? { ignored_params: ignored } : {}),
				change_it: {
					update: { tool: "effects", arguments: { action: "update", timeline_id: input.timelineId, element_id: input.elementId, effect_id: effect.id, params: {} } },
					remove: { tool: "effects", arguments: { action: "remove", timeline_id: input.timelineId, element_id: input.elementId, effect_id: effect.id } },
				},
				editor: EDITOR_NOTE,
				next: renderNext(input.timelineId, done.commitId, anchor.t),
			},
		};
	}

	// an effect layer from t
	if (anchor.t === null) {
		return failure("where", `Say where ${input.effect.name} goes: t (seconds), word (it starts on the word), or element_id (the whole clip).`, {}, summaryNext(input.timelineId));
	}
	const t = anchor.t;
	let hold = input.durationS;
	let holdReason = "duration_s";
	if (hold === undefined && plan.holdToSentence) {
		let words = anchor.words;
		let index = anchor.index;
		if (!words) {
			words = (await timelineWords(input.timelineId, head.snapshot)).words;
			index = words.findIndex((word) => word.start >= t - 0.05);
		}
		if (words.length && index !== undefined && index >= 0) {
			const until = sentenceEnd(words, index);
			if (until > t) {
				hold = Math.min(8, Math.max(0.4, until - t));
				holdReason = "until the end of the sentence";
			}
		}
	}
	if (hold === undefined) {
		hold = plan.hold_s;
		holdReason = "the preset's hold";
	}
	const pictureEnd = timelineEnd(head.snapshot);
	const start = toTicks(t);
	if (pictureEnd > 0 && start >= pictureEnd) return failure("past_end", `t = ${t} s is after the picture ends (${toSeconds(pictureEnd)} s).`, {}, summaryNext(input.timelineId));
	const end = pictureEnd > 0 ? Math.min(start + toTicks(hold), pictureEnd) : start + toTicks(hold);

	const overlay = activeScene(head.snapshot)?.tracks?.overlay ?? [];
	const fxTracks = overlay.filter((track) => isFxLane(track) && !isGradeTrack(track));
	const free = fxTracks.find((track) => !overlaps(track, start, end)) ?? null;
	const newName = nextLaneName(overlay, FX_TRACK);
	// effects-v2: FX lanes sit under MOTION and over the footage and the person stack (effects-lanes.ts rank 2)
	const ops: Record<string, unknown>[] = free ? [] : [{ op: "add_track", author: "claude", kind: "effect", name: newName, index: insertIndexFor(overlay, 2), ref: "fx_track" }];
	const focus = await focusOnFace(input, head, plan.effectType, values, t, toSeconds(end), clipAt(head.snapshot, t));

	if (input.dryRun) {
		return {
			payload: {
				dry_run: true,
				effect: effectView(input.effect),
				at: anchorView(anchor),
				would: { layer: { type: plan.effectType, params: values, t: round3(t), duration_s: toSeconds(end - start), hold: holdReason, track: free ? { id: free.id, name: free.name ?? null } : { new: newName, below: "captions and MOTION" } } },
				...(focus.note ? { focus: focus.note } : {}),
				...(ignored.length ? { ignored_params: ignored } : {}),
				next: { do: "Apply it (same call without dry_run).", tool: "effects", arguments: applyAgain(input, { t: round3(t) }) },
			},
		};
	}

	let snapshot: ProjectSnapshot;
	let trackId: string;
	let applied: unknown[] = [];
	if (free) {
		snapshot = clone(head.snapshot);
		trackId = free.id;
	} else {
		const result = applyOps(head.snapshot as unknown as OpsProject, ops as unknown as Op[], { seed: `${input.timelineId}/${head.headId}/effects/${plan.effectType}/${start}`, at: new Date().toISOString() });
		if (!result.ok) return failure("ops_conflict", "Adding the FX track was refused by the reducer. Nothing was committed.", { conflicts: result.conflicts.slice(0, 10) }, summaryNext(input.timelineId));
		snapshot = result.project as unknown as ProjectSnapshot;
		trackId = result.changes.refs.fx_track;
		applied = result.changes.applied;
	}
	const track = (activeScene(snapshot)?.tracks?.overlay ?? []).find((candidate) => candidate.id === trackId);
	if (!track) return failure("tool_failed", "The FX track was not found after adding it (internal).");
	const elementId = randomUUID();
	// the element the editor's buildEffectElement makes (type "effect" + effectType + params), tagged as Claude's
	const element: SnapshotElement = {
		id: elementId,
		type: "effect",
		name: input.effect.name,
		effectType: plan.effectType,
		params: values,
		startTime: start,
		duration: end - start,
		trimStart: 0,
		trimEnd: 0,
		restorff: {
			createdBy: "claude",
			author: "claude",
			effect: {
				id: input.effect.id,
				name: input.effect.name,
				instance: input.instance ?? newInstanceId(),
				applied: appliedRecord(input, anchor, { kind: "shader", t, duration: toSeconds(end - start), plate: clipAt(head.snapshot, t)?.id ?? null, given: givenSet(input), createdTracks: free ? [] : [trackId] }),
			},
		} as SnapshotElement["restorff"],
	};
	track.elements = [...(track.elements ?? []), element].sort((a, b) => a.startTime - b.startTime);
	const done = await commitSnapshot(input, head, actor, snapshot, applied, message);
	if (isResult(done)) return done;
	const notes: string[] = [...(done.notes ?? [])];
	if (focus.note) notes.push(focus.note);
	if (input.effect.needs.includes("person_matte")) notes.push(`${input.effect.name} without a person matte is the approximation the Library calls partial.`);
	return {
		payload: {
			applied: true,
			effect: effectView(input.effect),
			commit_id: done.commitId,
			branch: head.branch,
			message,
			at: anchorView(anchor),
			element_id: elementId,
			layer: { type: plan.effectType, params: values, t: round3(t), duration_s: toSeconds(end - start), hold: holdReason },
			track: { id: track.id, name: track.name ?? null, created: !free },
			...(focus.focus ? { focus: { x: focus.focus.x, y: focus.focus.y, face_box: focus.focus.face } } : {}),
			...(ignored.length ? { ignored_params: ignored } : {}),
			...(notes.length ? { notes } : {}),
			change_it: {
				update: { tool: "effects", arguments: { action: "update", timeline_id: input.timelineId, element_id: elementId, params: {} } },
				remove: { tool: "effects", arguments: { action: "remove", timeline_id: input.timelineId, element_id: elementId } },
			},
			editor: EDITOR_NOTE,
			next: renderNext(input.timelineId, done.commitId, t),
		},
	};
}

// transition ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Cut {
	a: SnapshotElement;
	b: SnapshotElement;
	/** Ticks. */
	at: number;
}

function cutsOn(track: SnapshotTrack): Cut[] {
	const clips = [...(track.elements ?? [])].filter((el) => el.type === "video" || el.type === "image").sort((x, y) => x.startTime - y.startTime);
	const cuts: Cut[] = [];
	for (let i = 0; i + 1 < clips.length; i++) {
		const a = clips[i];
		const b = clips[i + 1];
		if (a.startTime + a.duration === b.startTime) cuts.push({ a, b, at: b.startTime });
	}
	return cuts;
}

async function applyTransition(input: ApplyInput, head: Head, anchor: Anchor, actor: Actor): Promise<EffectResult> {
	const plan = input.effect.apply as { kind: "transition"; transition: string; options?: string[] };
	let kind = plan.transition;
	if (typeof input.params.kind === "string") {
		const resolved = resolveTransitionKind(input.params.kind);
		if (!resolved) return failure("unknown_transition", `No transition "${input.params.kind}".`, { kinds: Object.keys(TRANSITION_KINDS) });
		kind = resolved;
	} else if (typeof input.params.direction === "string" && plan.options) {
		const wanted = plan.options.find((option) => option.endsWith(`-${String(input.params.direction).toLowerCase()}`));
		if (!wanted) return failure("invalid_arguments", `direction must be one of: ${plan.options.map((option) => option.split("-").pop()).join(", ")}.`);
		kind = wanted;
	}
	const scene = activeScene(head.snapshot);
	const trackRef = typeof input.params.track === "string" && input.params.track ? input.params.track : "main";
	const track = trackRef === "main" ? scene?.tracks?.main : orderedTracks(head.snapshot).find((candidate) => candidate.id === trackRef);
	if (!track) return failure("not_found", `No track ${trackRef}.`, {}, summaryNext(input.timelineId));
	const cuts = cutsOn(track);
	const cutList = () => cuts.slice(0, 30).map((cut) => ({ t: toSeconds(cut.at), a: cut.a.id, b: cut.b.id }));
	let cut: Cut | undefined;
	if (input.elementId) {
		cut = cuts.find((candidate) => candidate.b.id === input.elementId);
		if (!cut) return failure("no_cut", `Nothing on "${track.name ?? track.id}" ends where ${input.elementId} starts, so there is no cut to put ${input.effect.name} on.`, { cuts: cutList() }, summaryNext(input.timelineId));
	} else if (anchor.t !== null) {
		const t = toTicks(anchor.t);
		cut = [...cuts].sort((x, y) => Math.abs(x.at - t) - Math.abs(y.at - t))[0];
		const reach = typeof input.params.reach_s === "number" && input.params.reach_s > 0 ? input.params.reach_s : 1.5;
		if (!cut || Math.abs(cut.at - t) > toTicks(reach)) {
			return failure("no_cut_near", cuts.length ? `No cut within ${reach} s of ${round3(anchor.t)} s on "${track.name ?? track.id}".` : `"${track.name ?? track.id}" has no cuts (two clips that meet) for a transition.`, { cuts: cutList() }, summaryNext(input.timelineId));
		}
	} else {
		return failure("where", `Say where ${input.effect.name} goes: t (the cut nearest it), word, or element_id (the clip it leads into).`, { cuts: cutList() }, summaryNext(input.timelineId));
	}
	const op = { op: "transition", author: "claude", a: cut.a.id, b: cut.b.id, kind, ...(input.durationS ? { dur: input.durationS } : {}) } as unknown as Op;
	const message = defaultMessage(input, anchor);
	// effects-v2 (E-3): person cutouts over the transition window would stay sharp over the blurred frame (a sharp
	// speaker + a ghost head on Zoom Through): cut them out of the window so the transition moves the whole frame
	const durS = input.durationS ?? TRANSITION_KINDS[kind] ?? 0;
	const personOps = durS > 0 ? cutoutsOutOfWindow(head.snapshot, cut.at - toTicks(durS / 2), cut.at + toTicks(durS / 2)) : { ops: [], notes: [] };
	const done = await commitOps(input, head, actor, [op, ...(personOps.ops as unknown as Op[])], message);
	if (isResult(done)) return done;
	return {
		payload: {
			applied: true,
			effect: effectView(input.effect),
			commit_id: done.commitId,
			branch: head.branch,
			message,
			at: anchorView(anchor, input.elementId),
			transition: { kind, cut_t: toSeconds(cut.at), a: cut.a.id, b: cut.b.id, dur_s: input.durationS ?? TRANSITION_KINDS[kind] ?? null },
			changes: done.summaries,
			...(personOps.notes.length ? { person_cutouts: personOps.notes } : {}),
			change_it: {
				update: { tool: "effects", arguments: { action: "update", timeline_id: input.timelineId, element_id: cut.b.id, effect_id: "transition", params: { kind } } },
				remove: { tool: "effects", arguments: { action: "remove", timeline_id: input.timelineId, element_id: cut.b.id, effect_id: "transition" } },
			},
			editor: EDITOR_NOTE,
			next: renderNext(input.timelineId, done.commitId, toSeconds(cut.at)),
		},
	};
}

/**
 * ops@1 that take person cutouts (any lane) out of [from, to) ticks: inside → delete; across an edge → split there and
 * delete the part inside (split keeps the clip's keys aligned, unlike trim). Effects standing on a cut part keep the
 * part before the window (same element id); a part after it is a new element, noted.
 */
function cutoutsOutOfWindow(snapshot: ProjectSnapshot, from: number, to: number): { ops: Record<string, unknown>[]; notes: string[] } {
	const ops: Record<string, unknown>[] = [];
	const notes: string[] = [];
	let n = 0;
	for (const track of activeScene(snapshot)?.tracks?.overlay ?? []) {
		for (const el of track.elements ?? []) {
			// the person, and the layers of person effects around it (back cards without the person would sit on the
			// speaker inside the window — SEEN at 8.15 s with Orbit)
			const side = (el.restorff as { effect?: { side?: string } } | undefined)?.effect?.side;
			if (!(el.restorff as { cutout?: unknown } | undefined)?.cutout && side !== "below_cutout" && side !== "above_cutout") continue;
			const a = el.startTime;
			const b = el.startTime + el.duration;
			if (b <= from || a >= to) continue;
			const window = `${toSeconds(from)}–${toSeconds(to)} s`;
			const what = side ? `person-effect layer "${el.name ?? el.id}"` : "person cutout";
			if (a >= from && b <= to) {
				ops.push({ op: "delete", author: "claude", el: el.id });
				notes.push(`${what} ${el.id} (${toSeconds(a)}–${toSeconds(b)} s) removed: it lay inside the transition (${window})`);
			} else if (a < from && b <= to) {
				const ref = `pc_${n++}`;
				ops.push({ op: "split", author: "claude", el: el.id, t: from / TICKS, ref }, { op: "delete", author: "claude", el: ref });
				notes.push(`${what} ${el.id} now ends at ${toSeconds(from)} s, before the transition (${window})`);
			} else if (a >= from && b > to) {
				const ref = `pc_${n++}`;
				ops.push({ op: "split", author: "claude", el: el.id, t: to / TICKS, ref }, { op: "delete", author: "claude", el: el.id });
				notes.push(`${what} ${el.id} now starts at ${toSeconds(to)} s, after the transition (${window}); its part after it is a new element`);
			} else {
				const mid = `pc_${n++}`;
				const right = `pc_${n++}`;
				ops.push({ op: "split", author: "claude", el: el.id, t: from / TICKS, ref: mid }, { op: "split", author: "claude", el: mid, t: to / TICKS, ref: right }, { op: "delete", author: "claude", el: mid });
				notes.push(`${what} ${el.id} cut out of the transition (${window}): it stops at ${toSeconds(from)} s and starts again at ${toSeconds(to)} s`);
			}
		}
	}
	return { ops, notes };
}

// grade ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function applyGrade(input: ApplyInput, head: Head, anchor: Anchor, actor: Actor): Promise<EffectResult> {
	const plan = input.effect.apply as { kind: "grade"; look: string };
	const look = typeof input.params.look === "string" && input.params.look.trim() ? input.params.look.trim() : plan.look;
	if (!resolveGradeName(look)) {
		return failure("unknown_look", `No grade look or nudge "${look}".`, { looks: GRADE_LOOKS.map((candidate) => candidate.id) }, { do: "Describe a grade effect for the looks and sliders.", tool: "effects", arguments: { action: "describe", name: input.effect.id } });
	}
	const sliders: Record<string, number> = {};
	for (const key of GRADE_PARAM_KEYS) {
		const value = input.params[key];
		if (typeof value === "number" && Number.isFinite(value)) sliders[key] = value;
	}
	let target = typeof input.params.target === "string" && input.params.target.trim() ? input.params.target.trim() : undefined;
	let targetWhy = "params.target";
	if (!target && input.elementId) {
		target = input.elementId;
		targetWhy = "element_id";
	}
	if (!target && anchor.t !== null) {
		const clip = clipAt(head.snapshot, anchor.t);
		if (clip) {
			target = clip.id;
			targetWhy = `the clip under ${round3(anchor.t)} s`;
		}
	}
	if (!target) {
		target = "all";
		targetWhy = "the whole timeline (a GRADE adjustment layer)";
	}
	const op = { op: "grade", author: "claude", target, preset: look, ...(Object.keys(sliders).length ? { params: sliders } : {}) } as unknown as Op;
	const message = defaultMessage(input, anchor);
	const done = await commitOps(input, head, actor, [op], message);
	if (isResult(done)) return done;
	return {
		payload: {
			applied: true,
			effect: effectView(input.effect),
			commit_id: done.commitId,
			branch: head.branch,
			message,
			at: anchorView(anchor, input.elementId),
			grade: { look, target, target_is: targetWhy, ...(Object.keys(sliders).length ? { sliders } : {}) },
			changes: done.summaries,
			editor: EDITOR_NOTE,
			next: renderNext(input.timelineId, done.commitId, anchor.t),
		},
	};
}

/** Apply a named effect: gate → head → where → by kind. One commit by `claude` (none on dry_run). */
export async function applyEffect(input: ApplyInput, library: LibraryEffect[], actor: Actor): Promise<EffectResult> {
	let gated = gate(input.effect, library, input.timelineId, input.elementId);
	if (gated && gated.payload.status === "needs" && !input.elementId) {
		// name the clip the matte is for: the one under t / the word
		try {
			const loaded = await getProjectHead(input.timelineId, input.branch);
			if (loaded.snapshot) {
				const anchor = await resolveAnchor(input, { branch: loaded.branch, headId: loaded.head.id, snapshot: loaded.snapshot });
				const clip = !isResult(anchor) && anchor.t !== null ? clipAt(loaded.snapshot, anchor.t) : null;
				if (clip) gated = gate(input.effect, library, input.timelineId, clip.id) ?? gated;
			}
		} catch {
			// keep the answer without a clip id
		}
	}
	if (gated) return gated;
	const apply = input.effect.apply;
	if (!apply) return failure("not_built", `${input.effect.name} has no way to be applied yet.`);
	if (apply.kind === "tool") {
		return {
			payload: {
				status: "use_tool",
				effect: effectView(input.effect),
				message: `${input.effect.name} is made by the ${apply.tool} tool. ${apply.why}`,
				next: { do: `Use ${apply.tool} on this timeline.`, tool: apply.tool, arguments: { timeline_id: input.timelineId, ...apply.arguments } },
			},
		};
	}
	let head: Head;
	if (input.head) head = input.head;
	else {
		const loaded = await getProjectHead(input.timelineId, input.branch);
		if (!loaded.snapshot) return failure("no_snapshot", "This timeline has no snapshot to add to.");
		head = { branch: loaded.branch, headId: loaded.head.id, snapshot: loaded.snapshot };
	}
	const base = input.baseCommit;
	if (base && base !== head.headId && !(base.length >= 7 && head.headId.startsWith(base))) {
		return failure("conflict", `The timeline moved on: its head is ${head.headId}, not ${base}. Nothing was applied.`, { head: head.headId }, summaryNext(input.timelineId, "Read the timeline again, then apply on its head (or omit base_commit)."));
	}
	const anchor = await resolveAnchor(input, head);
	if (isResult(anchor)) return anchor;
	switch (apply.kind) {
		case "composition":
			return applyComposition(input, head, anchor, actor);
		case "shader":
			return applyShader(input, head, anchor, actor);
		case "transition":
			return applyTransition(input, head, anchor, actor);
		case "grade":
			return applyGrade(input, head, anchor, actor);
	}
}

// ─── effects-v2: change an applied effect (SUMMARY gap 15, recreation E-1) ─────────────────────────────────────────
//
// `effects update {element_id, params}` re-renders all of an effect's layers in ONE commit (the old layers, the
// person segment no other effect uses and the plate keys it wrote go; the new ones come with the same instance id;
// lanes are reused); `effects remove {element_id}` takes all of that away. element_id = any element of the effect (a
// layer, its FX layer, its person cutout, the clip it is built on when that is unambiguous; effect_id picks a shader
// on a clip). Updates merge params over the ones the caller set before; computed ones (face, masthead, window, matte
// frames, placement moves) are computed again.

export interface ChangeInput {
	timelineId: string;
	elementId: string;
	effectId?: string;
	params: Record<string, unknown>;
	t?: number;
	word?: string;
	occurrence?: number;
	durationS?: number;
	branch?: string;
	baseCommit?: string;
	message?: string;
	dryRun: boolean;
	waitS?: number;
	measure?: boolean;
	placement?: "auto" | "off";
	signal?: AbortSignal;
}

/** Params the server computes (never "the caller's" when an old apply did not record what it was given). */
const COMPUTED_KEYS = new Set(["face", "mastheadOffset", "window", "matte", "matteFps", "matteChannel", "plate", "background", "layer", "y"]);

async function changeHead(input: ChangeInput): Promise<Head | EffectResult> {
	const loaded = await getProjectHead(input.timelineId, input.branch);
	if (!loaded.snapshot) return failure("no_snapshot", "This timeline has no snapshot.");
	const base = input.baseCommit;
	if (base && base !== loaded.head.id && !(base.length >= 7 && loaded.head.id.startsWith(base))) {
		return failure("conflict", `The timeline moved on: its head is ${loaded.head.id}, not ${base}. Nothing was changed.`, { head: loaded.head.id }, summaryNext(input.timelineId));
	}
	return { branch: loaded.branch, headId: loaded.head.id, snapshot: loaded.snapshot };
}

function foundProblem(found: FoundEffect, input: ChangeInput, action: "update" | "remove"): EffectResult | null {
	if (found.kind === "none") return failure("not_an_effect", `${found.why} Nothing was changed.`, {}, summaryNext(input.timelineId, "Read the timeline summary: effect layers sit on MOTION / MOTION BACK / MOTION FRONT / FX lanes."));
	if (found.kind === "ambiguous") {
		const first = found.options[0] ?? {};
		return failure("ambiguous", `${input.elementId} belongs to more than one applied effect: pick one by its own element_id, or keep this clip and add effect_id ("transition", or a shader effect's id). Nothing was changed.`, { options: found.options }, {
			do: `${action} the one you mean.`,
			tool: "effects",
			arguments: { action, timeline_id: input.timelineId, element_id: (first.element_id as string) ?? input.elementId, ...(first.effect_id ? { effect_id: first.effect_id } : {}) },
		});
	}
	return null;
}

/** A minimal ApplyInput for commits made by update/remove themselves. */
function changeApplyInput(input: ChangeInput, effect: LibraryEffect, entries: PackageEntry[]): ApplyInput {
	return { effect, entries, timelineId: input.timelineId, params: input.params, dryRun: input.dryRun, branch: input.branch, waitS: input.waitS, signal: input.signal };
}

const stubEffect = (id: string, name: string): LibraryEffect =>
	({ id, slug: id, name, aliases: [], group: "", status: "ready", kind: "composition", build: "", needs: [], blocking: [], reels: [], note: "", apply: null, source: "catalogue" }) as unknown as LibraryEffect;

/** The props the members were rendered with (the layer the face check measured first: front / top, else any). */
function storedPropsOf(members: Located[]): Record<string, unknown> {
	const withProps = members.filter((item) => (item.element.restorff as { composition?: { props?: unknown } } | undefined)?.composition?.props);
	const pick = withProps.find((item) => (item.element.restorff as { effect?: { layer?: string | null } }).effect?.layer !== "back") ?? withProps[0];
	const props = (pick?.element.restorff as { composition?: { props?: Record<string, unknown> } } | undefined)?.composition?.props ?? {};
	const out = { ...props };
	delete out.layer;
	return out;
}

/** Legacy applies did not record what the caller set: everything that is not the example's, the recipe's or computed. */
function legacyGiven(props: Record<string, unknown>, entry: PackageEntry | undefined): string[] {
	const example = stripMeta(entry?.example ?? {});
	const recipeProps = (entry ? readRecipe(entry)?.props : undefined) ?? {};
	return Object.keys(props).filter((key) => !COMPUTED_KEYS.has(key) && JSON.stringify(props[key]) !== JSON.stringify(example[key]) && JSON.stringify(props[key]) !== JSON.stringify(recipeProps[key]));
}

/** The plate keys a legacy layered effect wrote, recomputed from its recipe (plate + every cutout of the plate). */
function legacyKeyRecords(snapshot: ProjectSnapshot, found: Extract<FoundEffect, { kind: "instance" }>, entries: PackageEntry[]): PlateKeyRecord[] {
	const member = found.members.find((item) => (item.element.restorff as { composition?: unknown } | undefined)?.composition);
	if (!member) return [];
	const composition = (member.element.restorff as { composition?: { name?: string } }).composition;
	const entry = entries.find((candidate) => candidate.name === composition?.name);
	const recipe = entry ? readRecipe(entry) : null;
	if (!entry || !recipe?.plateKeys?.length) return [];
	const startS = member.element.startTime / TICKS;
	const plate = clipAt(snapshot, startS + 1e-3);
	if (!plate) return [];
	const keysPlan = plateKeysFor({ recipe, name: entry.name, duration: member.element.duration / TICKS, defaultDuration: entry.duration, props: storedPropsOf(found.members) });
	const props = new Set<string>();
	for (const key of keysPlan.keys) {
		if (key.scale !== undefined) props.add("transform.scaleX").add("transform.scaleY");
		if (key.x !== undefined) props.add("transform.positionX");
		if (key.y !== undefined) props.add("transform.positionY");
	}
	const records: PlateKeyRecord[] = [];
	const plan = layerPlan(recipe);
	const targets: Array<{ id: string; start: number }> = [];
	if (plan.plateKeysOn.includes("plate") || plan.plateKeysOn.length === 0) targets.push({ id: plate.id, start: plate.startTime });
	for (const seg of segmentsOf(snapshot, plate.id)) targets.push({ id: seg.element.id, start: seg.element.startTime });
	for (const target of targets) {
		records.push({ el: target.id, props: [...props], times: keysPlan.keys.map((key) => Math.round(member.element.startTime - target.start + key.t * TICKS)) });
	}
	return records;
}

function elementsLeft(snapshot: ProjectSnapshot, instance: string | null, ids: string[]): number {
	const gone = new Set(ids);
	let left = 0;
	for (const track of activeScene(snapshot)?.tracks?.overlay ?? []) {
		for (const el of track.elements ?? []) {
			const tag = (el.restorff as { effect?: { instance?: string } } | undefined)?.effect;
			if (gone.has(el.id) || (instance && tag?.instance === instance)) left++;
		}
	}
	return left;
}

/** Re-render an applied effect with new params (and/or t, duration_s, word) as ONE commit. */
export async function updateEffect(input: ChangeInput, library: LibraryEffect[], entries: PackageEntry[], actor: Actor): Promise<EffectResult> {
	const head = await changeHead(input);
	if (isResult(head)) return head;
	const found = findApplied(head.snapshot, input.elementId, input.effectId);
	const problem = foundProblem(found, input, "update");
	if (problem) return problem;
	const changed = Object.keys(stripMeta(input.params));

	// a shader on a clip: new slider values in place (an empty update re-centres a focus on the face)
	if (found.kind === "clip_effect") {
		const snapshot = clone(head.snapshot);
		const clip = locate(activeScene(snapshot), found.clip.element.id);
		const fx = ((clip?.element.effects as Array<{ id: string; type: string; params?: Record<string, number | string> }> | undefined) ?? []).find((candidate) => candidate.id === found.effect.id);
		if (!clip || !fx) return failure("tool_failed", "The effect vanished (internal).");
		const { values, ignored } = shaderParams(fx.type, (fx.params ?? {}) as Record<string, number | string>, input.params);
		const effect = findLibraryEffect(library, fx.type).effect ?? stubEffect(`shader:${fx.type}`, SHADER_DEFINITIONS[fx.type]?.name ?? fx.type);
		const pseudo = changeApplyInput(input, effect, entries);
		const from = clip.element.startTime / TICKS;
		const focus = await focusOnFace(pseudo, head, fx.type, values, from, from + clip.element.duration / TICKS, clip.element.type === "video" ? clip.element : null);
		if (input.dryRun) return { payload: { dry_run: true, would: { element_id: clip.element.id, effect_id: fx.id, type: fx.type, params: values }, ...(focus.note ? { focus: focus.note } : {}), ...(ignored.length ? { ignored_params: ignored } : {}), next: { do: "Update it (same call without dry_run).", tool: "effects", arguments: { action: "update", timeline_id: input.timelineId, element_id: input.elementId, effect_id: fx.id, params: input.params } } } };
		fx.params = values;
		const message = input.message?.trim() || `effect update: ${SHADER_DEFINITIONS[fx.type]?.name ?? fx.type} on ${clip.element.name ?? clip.element.id} (${changed.join(", ") || "re-centred"})`;
		const done = await commitSnapshot(pseudo, head, actor, snapshot, [], message);
		if (isResult(done)) return done;
		return { payload: { updated: true, commit_id: done.commitId, branch: head.branch, message, on_clip: { element_id: clip.element.id, effect_id: fx.id, type: fx.type, params: values }, ...(focus.note ? { focus: focus.note } : {}), ...(ignored.length ? { ignored_params: ignored } : {}), editor: EDITOR_NOTE, next: renderNext(input.timelineId, done.commitId, from) } };
	}

	// a transition: another kind / direction / length on the same cut (person cutouts kept out of its window)
	if (found.kind === "transition") {
		const b = found.clip.element;
		const a = (found.clip.track.elements ?? []).find((el) => el.id !== b.id && Math.abs(el.startTime + el.duration - b.startTime) <= 1);
		if (!a) return failure("no_cut", `Nothing ends where ${b.id} starts any more, so its transition cannot change. Remove it instead.`, {}, summaryNext(input.timelineId));
		let kind = found.transition.type;
		if (typeof input.params.kind === "string") {
			const resolved = resolveTransitionKind(input.params.kind);
			if (!resolved) return failure("unknown_transition", `No transition "${input.params.kind}".`, { kinds: Object.keys(TRANSITION_KINDS) });
			kind = resolved;
		} else if (typeof input.params.direction === "string") {
			const turned = kind.replace(/-(left|right|up|down)$/, `-${String(input.params.direction).toLowerCase()}`);
			if (resolveTransitionKind(turned)) kind = turned;
		}
		const durS = input.durationS ?? found.transition.duration / TICKS;
		const effect = findLibraryEffect(library, kind).effect ?? stubEffect(`tr:${kind}`, kind);
		const pseudo = changeApplyInput(input, effect, entries);
		const ops = [{ op: "transition", author: "claude", a: a.id, b: b.id, kind, dur: durS }, ...cutoutsOutOfWindow(head.snapshot, b.startTime - toTicks(durS / 2), b.startTime + toTicks(durS / 2)).ops] as unknown as Op[];
		const message = input.message?.trim() || `effect update: transition ${found.transition.type} → ${kind}, ${round3(durS)} s`;
		const done = await commitOps(pseudo, head, actor, ops, message);
		if (isResult(done)) return done;
		return { payload: { updated: true, commit_id: done.commitId, branch: head.branch, message, transition: { kind, cut_t: toSeconds(b.startTime), a: a.id, b: b.id, dur_s: round3(durS) }, changes: done.summaries, editor: EDITOR_NOTE, next: renderNext(input.timelineId, done.commitId, toSeconds(b.startTime)) } };
	}
	if (found.kind !== "instance") return failure("not_an_effect", "Nothing to update (internal).");

	const effect = findLibraryEffect(library, found.effect.id).effect;
	if (!effect) return failure("unknown_effect", `The effect ${found.effect.id} (${found.effect.name}) is not in the library any more, so it cannot be re-rendered. Remove it instead.`, {}, { do: "Remove it.", tool: "effects", arguments: { action: "remove", timeline_id: input.timelineId, element_id: input.elementId } });
	const first = found.members[0];

	// a shader layer (FX lane): new values in place, optionally moved/resized
	if (first.element.type === "effect") {
		const snapshot = clone(head.snapshot);
		const el = locate(activeScene(snapshot), first.element.id);
		if (!el) return failure("tool_failed", "The effect layer vanished (internal).");
		const effectType = String(el.element.effectType ?? "");
		const { values, ignored } = shaderParams(effectType, (el.element.params ?? {}) as Record<string, number | string>, input.params);
		const startTicks = input.t !== undefined ? toTicks(input.t) : el.element.startTime;
		const durTicks = input.durationS !== undefined ? toTicks(input.durationS) : el.element.duration;
		if ((el.track.elements ?? []).some((other) => other.id !== el.element.id && startTicks < other.startTime + other.duration && startTicks + durTicks > other.startTime)) {
			return failure("lane_busy", `Another layer on ${el.track.name ?? el.track.id} is there: remove this one and apply it again where you want it.`, {}, summaryNext(input.timelineId));
		}
		const pseudo = { ...changeApplyInput(input, effect, entries), givenKeys: [...new Set([...((effectTagOf(el.element)?.applied?.given as string[] | undefined) ?? []), ...changed])] };
		const focus = await focusOnFace(pseudo, head, effectType, values, startTicks / TICKS, (startTicks + durTicks) / TICKS, clipAt(head.snapshot, startTicks / TICKS));
		if (input.dryRun) return { payload: { dry_run: true, would: { element_id: el.element.id, params: values, t: toSeconds(startTicks), duration_s: toSeconds(durTicks) }, ...(focus.note ? { focus: focus.note } : {}), ...(ignored.length ? { ignored_params: ignored } : {}), next: { do: "Update it (same call without dry_run).", tool: "effects", arguments: { action: "update", timeline_id: input.timelineId, element_id: el.element.id, params: input.params } } } };
		Object.assign(el.element, { params: values, startTime: startTicks, duration: durTicks });
		const tag = effectTagOf(el.element);
		if (tag?.applied) Object.assign(tag.applied, { t: toSeconds(startTicks), duration_s: toSeconds(durTicks), given: pseudo.givenKeys });
		el.track.elements = [...(el.track.elements ?? [])].sort((x, y) => x.startTime - y.startTime);
		const message = input.message?.trim() || `effect update: ${effect.name} (${changed.join(", ") || "re-centred"})`;
		const done = await commitSnapshot(pseudo, head, actor, snapshot, [], message);
		if (isResult(done)) return done;
		return { payload: { updated: true, effect: effectView(effect), commit_id: done.commitId, branch: head.branch, message, element_id: el.element.id, layer: { type: effectType, params: values, t: toSeconds(startTicks), duration_s: toSeconds(durTicks) }, ...(focus.note ? { focus: focus.note } : {}), ...(ignored.length ? { ignored_params: ignored } : {}), editor: EDITOR_NOTE, next: renderNext(input.timelineId, done.commitId, toSeconds(startTicks)) } };
	}

	// a composition (one overlay, or layers around the person): take it out, apply it again, one commit
	const compositionName = (first.element.restorff as { composition?: { name?: string } } | undefined)?.composition?.name;
	const entry = entries.find((candidate) => candidate.name === compositionName);
	if (!entry) return failure("not_in_package", `Composition "${compositionName}" is not in packages/compositions right now, so it cannot be re-rendered.`, {}, summaryNext(input.timelineId));
	const stored = storedPropsOf(found.members);
	const givenBefore = found.record?.given ?? legacyGiven(stored, entry);
	const params: Record<string, unknown> = { ...Object.fromEntries(givenBefore.filter((key) => key in stored).map((key) => [key, stored[key]])), ...stripMeta(input.params) };
	if (found.members.some((item) => (item.element.restorff as { effect?: { layer?: string | null } }).effect?.layer === undefined) && input.params.layer === "all") params.layer = "all";
	const givenKeys = [...new Set([...givenBefore, ...changed])];
	const t = input.t ?? found.record?.t ?? Math.min(...found.members.map((item) => item.element.startTime)) / TICKS;
	const duration = input.durationS ?? found.record?.duration_s ?? Math.max(...found.members.map((item) => item.element.duration)) / TICKS;
	const layered = found.members.some((item) => !!effectTagOf(item.element)?.side) || found.record?.kind === "layered";
	const plateId = layered ? (found.record?.plate ?? clipAt(head.snapshot, t + 1e-3)?.id ?? undefined) : undefined;
	const legacyKeys = found.legacy && !found.record ? legacyKeyRecords(head.snapshot, found, entries) : undefined;
	const removal = planRemoval(head.snapshot, found, { keepTracks: true, legacyKeys });
	const removedRun = applyOps(head.snapshot as unknown as OpsProject, removal.ops as unknown as Op[], { seed: `${input.timelineId}/${head.headId}/effects-update/remove`, at: new Date().toISOString() });
	if (!removedRun.ok) return failure("ops_conflict", "Taking the old version out was refused by the reducer. Nothing was changed.", { conflicts: removedRun.conflicts.slice(0, 10) }, summaryNext(input.timelineId));
	const removedSnapshot = removedRun.project as unknown as ProjectSnapshot;
	const keyInfo = removal.finish(removedSnapshot, removedRun.changes.refs);
	const oldLanes = [...new Set([...(found.record?.created_tracks ?? []), ...(removal.kept.tracks ?? [])])];
	const result = await applyEffect(
		{
			effect,
			entries,
			timelineId: input.timelineId,
			branch: head.branch,
			...(input.word ? { word: input.word, occurrence: input.occurrence } : { t }),
			...(plateId ? { elementId: plateId } : {}),
			params,
			givenKeys,
			durationS: duration,
			message: input.message?.trim() || `effect update: ${effect.name} (${changed.join(", ") || "re-rendered"})`,
			dryRun: input.dryRun,
			waitS: input.waitS,
			signal: input.signal,
			measure: input.measure,
			placement: input.placement,
			head: { ...head, snapshot: removedSnapshot },
			opsPrefix: removedRun.changes.applied,
			...(found.instance ? { instance: found.instance } : {}),
			beforeCommit: (snapshot, ops) => {
				const overlay = activeScene(snapshot)?.tracks?.overlay;
				const gone = emptyTracks(snapshot, oldLanes);
				if (!overlay || !gone.length) return [];
				const scene = activeScene(snapshot);
				if (scene?.tracks) scene.tracks.overlay = overlay.filter((track) => !gone.includes(track.id));
				for (const id of gone) ops.push({ op: "remove_track", author: "claude", track: id });
				return [`removed ${gone.length} lane(s) the old version left empty`];
			},
		},
		library,
		actor,
	);
	if (result.isError) return result;
	const payload = result.payload;
	return {
		payload: {
			...(input.dryRun ? { dry_run: true } : { updated: true }),
			changed: changed.length ? changed : "nothing: re-rendered (face box, placement and matte inputs computed again)",
			replaced: { elements: removal.removed.elements, person_cutout: removal.removed.cutout, keys_removed: keyInfo.keys_removed, ...(removal.kept.cutout ? { kept_cutout: removal.kept } : {}) },
			params_now: scrubData(params),
			...payload,
			...(removal.notes.length ? { update_notes: removal.notes } : {}),
			...(input.dryRun
				? {
						next: {
							do: "Update it (same call without dry_run).",
							tool: "effects",
							arguments: { action: "update", timeline_id: input.timelineId, element_id: input.elementId, ...(Object.keys(input.params).length ? { params: JSON.stringify(input.params).includes("data:") ? "the same params you sent" : input.params } : {}), ...(input.t !== undefined ? { t: input.t } : {}), ...(input.durationS !== undefined ? { duration_s: input.durationS } : {}) },
						},
					}
				: {}),
		},
	};
}

/** Take an applied effect away: its layers, the person segment no other effect uses, its plate keys, emptied lanes. */
export async function removeEffect(input: ChangeInput, library: LibraryEffect[], entries: PackageEntry[], actor: Actor): Promise<EffectResult> {
	const head = await changeHead(input);
	if (isResult(head)) return head;
	const found = findApplied(head.snapshot, input.elementId, input.effectId);
	const problem = foundProblem(found, input, "remove");
	if (problem) return problem;

	if (found.kind === "clip_effect" || found.kind === "transition") {
		const snapshot = clone(head.snapshot);
		const clip = locate(activeScene(snapshot), found.clip.element.id);
		if (!clip) return failure("tool_failed", "The clip vanished (internal).");
		let what: string;
		if (found.kind === "clip_effect") {
			clip.element.effects = ((clip.element.effects as Array<{ id: string }> | undefined) ?? []).filter((effect) => effect.id !== found.effect.id);
			what = `${SHADER_DEFINITIONS[found.effect.type]?.name ?? found.effect.type} on ${clip.element.name ?? clip.element.id}`;
		} else {
			delete (clip.element as { transitionIn?: unknown }).transitionIn;
			what = `the ${found.transition.type} transition into ${clip.element.name ?? clip.element.id}`;
		}
		if (input.dryRun) return { payload: { dry_run: true, would: { remove: what }, next: { do: "Remove it (same call without dry_run).", tool: "effects", arguments: { action: "remove", timeline_id: input.timelineId, element_id: input.elementId, ...(input.effectId ? { effect_id: input.effectId } : {}) } } } };
		const message = input.message?.trim() || `effect remove: ${what}`;
		const done = await commitSnapshot(changeApplyInput(input, stubEffect("remove", what), entries), head, actor, snapshot, [], message);
		if (isResult(done)) return done;
		return { payload: { removed: true, commit_id: done.commitId, branch: head.branch, message, what, editor: EDITOR_NOTE, next: summaryNext(input.timelineId, "Check the timeline summary: nothing of it is left.") } };
	}
	if (found.kind !== "instance") return failure("not_an_effect", "Nothing to remove (internal).");

	const legacyKeys = found.legacy && !found.record ? legacyKeyRecords(head.snapshot, found, entries) : undefined;
	const removal = planRemoval(head.snapshot, found, { keepTracks: false, legacyKeys });
	const run = applyOps(head.snapshot as unknown as OpsProject, removal.ops as unknown as Op[], { seed: `${input.timelineId}/${head.headId}/effects-remove`, at: new Date().toISOString() });
	if (!run.ok) return failure("ops_conflict", "The reducer refused the removal. Nothing was changed.", { conflicts: run.conflicts.slice(0, 10) }, summaryNext(input.timelineId));
	const snapshot = run.project as unknown as ProjectSnapshot;
	const keyInfo = removal.finish(snapshot, run.changes.refs);
	const view = {
		effect: found.effect,
		instance: found.instance,
		elements: removal.removed.elements,
		person_cutout: removal.removed.cutout,
		...(removal.kept.cutout ? { kept: removal.kept } : {}),
		lanes_removed: removal.removed.tracks,
		keys_removed: keyInfo.keys_removed,
	};
	if (input.dryRun) return { payload: { dry_run: true, would: view, ...(removal.notes.length ? { notes: removal.notes } : {}), next: { do: "Remove it (same call without dry_run).", tool: "effects", arguments: { action: "remove", timeline_id: input.timelineId, element_id: input.elementId } } } };
	const effect = findLibraryEffect(library, found.effect.id).effect ?? stubEffect(found.effect.id, found.effect.name);
	const message = input.message?.trim() || `effect remove: ${found.effect.name}`;
	const done = await commitSnapshot(changeApplyInput(input, effect, entries), head, actor, snapshot, run.changes.applied, message);
	if (isResult(done)) return done;
	const left = elementsLeft(snapshot, found.instance, [...removal.removed.elements, ...(removal.removed.cutout ? [removal.removed.cutout] : [])]);
	return {
		payload: {
			removed: true,
			commit_id: done.commitId,
			branch: head.branch,
			message,
			...view,
			check: { elements_of_it_left: left },
			...(removal.notes.length ? { notes: removal.notes } : {}),
			editor: EDITOR_NOTE,
			next: summaryNext(input.timelineId, "Check the timeline summary: nothing of it is left."),
		},
	};
}
