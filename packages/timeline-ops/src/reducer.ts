/**
 * The pure reducer: apply(project, ops, options) -> { project, changes, conflicts }.
 *
 * Pure means: the input project is never mutated (it is cloned once with structuredClone), no globals, no clock
 * (timestamps only if the caller passes `at`), no randomness (ids come from `seed` + op index). Each op's effect is
 * re-implemented from the editor's command classes (apps/web/src/commands/**, the spec) — see PARITY.md.
 *
 * Speed (reducer-perf, 2026-10-20): near-linear in the batch size. The draft is cloned ONCE per batch; an op that
 * conflicts is undone through an undo log, not a per-op snapshot. Rules for every handler (reducer-state.ts):
 *   - never mutate a placed element, its params or its animations — build a copy and replace it;
 *   - change a track's elements only through ctx.state (append / replace / removeId / split / setAll), groups through
 *     setGroups / createTrack, track fields through ctx.state.setTrackProp;
 *   - anything else an op changes in place must be covered by savepoint() below.
 * test/equivalence.test.ts holds the reducer to the frozen pre-rewrite one (test/reference/reducer-v0.ts), byte for byte.
 */
import {
	clampAnimationsToDuration,
	isLeafChannelData,
	normalizeScalarChannel,
	segmentTypeFor,
	setScalarChannel,
	splitAnimationsAtTime,
	upsertScalarKeyframe,
} from "./animation.ts";
import { type CaptionLook, chunkWords, lookAfterRestyle } from "./captions.ts";
import { createIdSource, type IdSource } from "./ids.ts";
import type {
	AudioElement,
	AudioTrack,
	Author,
	Effect,
	EffectElement,
	EffectTrack,
	FrameRate,
	GraphicElement,
	ImageElement,
	MediaManifestEntry,
	OverlayTrack,
	ParamValue,
	Project,
	RestorffProjectMeta,
	ScalarAnimationKey,
	ScalarChannel,
	Scene,
	TextElement,
	Ticks,
	TimelineElement,
	TimelineTrack,
	TrackType,
	VideoElement,
} from "./model.ts";
import { EDITOR_PROJECT_VERSION, OLDEST_READABLE_PROJECT_VERSION } from "./model.ts";
import type {
	AddCaptionsOp,
	AddSizeVariantOp,
	AddTrackOp,
	ApplyStyleOp,
	DeleteOp,
	DuckOp,
	Ease,
	GainOp,
	GradeOp,
	ImportMediaOp,
	InsertOp,
	KeyframeOp,
	MarkOp,
	MoveOp,
	NormalizeOp,
	Op,
	OpName,
	RemoveTrackOp,
	ReorderTracksOp,
	RippleDeleteOp,
	SetCanvasOp,
	SetCaptionStyleOp,
	SetOp,
	SfxOp,
	SplitOp,
	TextPopOp,
	TextStyle,
	TransitionOp,
	TrimOp,
	BeatsOp,
	SnapCutsOp,
} from "./ops.ts";
import { OPS_VERSION } from "./ops.ts";
import { CUT_KINDS, normalizeTransitionKind, resolveTransitionKind, TRANSITION_KINDS } from "./transitions.ts";
import {
	applyGradeNudge,
	clampGradeParams,
	CUSTOM_LOOK,
	GRADE_EFFECT_TYPE,
	GRADE_LOOKS,
	GRADE_NUDGES,
	GRADE_TRACK_NAME,
	gradeEffectParams,
	gradeLabel,
	type GradeParams,
	lookParams,
	readGradeParams,
	type ResolvedGrade,
	resolveGradeName,
} from "./grades.ts";
import {
	coerceParamValue,
	defaultParams,
	ELEMENT_PARAMS,
	getParamDef,
	GRAPHIC_PARAMS,
	VOLUME_DB_MAX,
	VOLUME_DB_MIN,
} from "./params.ts";
import { BatchState } from "./reducer-state.ts";
import {
	buildEmptyTrack,
	CAPTIONS_TRACK_NAME,
	canElementGoOnTrack,
	clampRetimeRate,
	defaultTrackName,
	endOf,
	knownSourceDuration,
	orderedTracks,
	overlapsAny,
	rateOf,
	retimeOf,
	totalDuration,
} from "./scene.ts";
import {
	applyTextCase,
	BUILTIN_STYLES,
	defaultCaptionStyle,
	defaultPopStyle,
	type StyleExpander,
	styleToParams,
} from "./styles.ts";
import {
	floatToFrameRate,
	roundHalfAwayFromZero,
	roundTicksToFrame,
	secondsToTicks,
	ticksPerFrame,
	TICKS_PER_SECOND,
} from "./time.ts";
import { validateOp } from "./validate.ts";

// ---------------------------------------------------------------- public types

export interface ApplyOptions {
	/** Required: ids are derived from it, so the same (project, ops, seed) always gives the same output. */
	seed: string;
	/** Scene to edit. Default: project.currentSceneId, else the main scene. */
	sceneId?: string;
	/** "atomic" (default): the first conflict aborts the whole batch. "best_effort": skip conflicting ops. */
	mode?: "atomic" | "best_effort";
	/** "none" (default): seconds → ticks exactly. "frame": also round every op time to the project's frame grid. */
	snap?: "none" | "frame";
	/** ISO timestamp written to metadata.updatedAt / scene.updatedAt when something changed. Omitted → untouched. */
	at?: string;
	/** Extra `apply_style` presets (merged over the built-ins). */
	styles?: Record<string, StyleExpander>;
}

export type OpStatus = "applied" | "noop" | "pending" | "conflict" | "invalid" | "skipped" | "rolled_back";

export type ConflictKind =
	| "invalid_op"
	| "missing_target"
	| "incompatible"
	| "overlap"
	| "out_of_range"
	| "invariant"
	| "unknown_preset"
	| "duplicate_ref";

export interface Conflict {
	/** Op position: "3", or "3.1" for the first op an apply_style at 3 expanded to. */
	index: string;
	op: OpName | "?";
	kind: ConflictKind;
	message: string;
	target?: string;
}

export interface OpChange {
	index: string;
	op: OpName;
	author: Author;
	status: OpStatus;
	summary: string;
	created?: { elements?: string[]; tracks?: string[]; media?: string[]; keyframes?: string[]; bookmarks?: number[] };
	/** Element ids whose content changed (directly or by ripple). */
	updated?: string[];
	removed?: { elements?: string[]; tracks?: string[] };
	details?: Record<string, unknown>;
}

export interface UnsupportedRecord {
	index: string;
	op: OpName;
	/** The id of the pending instruction stored in project.metadata.restorff.pending. */
	pendingId: string;
	reason: string;
	honouredBy: "render" | "gateway" | "editor" | "variant-compiler";
}

export interface ApplyChanges {
	/** One entry per op, in order (apply_style's expansion follows it as "i.1", "i.2"…). */
	ops: OpChange[];
	/** Ops the model cannot express; each is also stored as a pending instruction in the project. */
	unsupported: UnsupportedRecord[];
	/** `ref` aliases defined in this batch → ids. */
	refs: Record<string, string>;
	/** The ops as they were applied, apply_style recorded expanded — what a commit should store. */
	applied: Op[];
	warnings: string[];
}

export interface ApplyResult {
	project: Project;
	changes: ApplyChanges;
	conflicts: Conflict[];
	/** True when every op was applied, recorded as a no-op, or stored as pending. */
	ok: boolean;
}

// ---------------------------------------------------------------- internals

interface Fail {
	__conflict: true;
	kind: ConflictKind;
	message: string;
	target?: string;
}

function fail(kind: ConflictKind, message: string, target?: string): never {
	const error: Fail = { __conflict: true, kind, message, target };
	throw error;
}

function isFail(value: unknown): value is Fail {
	return typeof value === "object" && value !== null && (value as Fail).__conflict === true;
}

interface Ctx {
	project: Project;
	scene: Scene;
	refs: Record<string, string>;
	ids: IdSource;
	index: string;
	author: Author;
	fps: FrameRate;
	snap: "none" | "frame";
	change: OpChange;
	unsupported: UnsupportedRecord[];
	styles: Record<string, StyleExpander>;
	opRaw: Op;
	/** The batch's undo log, live index and invariant multiset (reducer-state.ts). */
	state: BatchState;
	/** Refs this op defined (deleted again if it conflicts). */
	newRefs: string[];
	/** The ids in change.updated, for addUpdated. */
	updatedSeen?: Set<string>;
}

const newIdFor = (ctx: Ctx) => (purpose: string) => ctx.ids.next(purpose);

function meta(ctx: Ctx): RestorffProjectMeta {
	const metadata = ctx.project.metadata;
	if (!metadata.restorff) metadata.restorff = { opsVersion: OPS_VERSION, pending: [], media: [] };
	return metadata.restorff;
}

function manifest(ctx: Ctx): MediaManifestEntry[] {
	return ctx.project.metadata.restorff?.media ?? [];
}

function toTicks(ctx: Ctx, seconds: number): Ticks {
	const ticks = secondsToTicks(seconds);
	return ctx.snap === "frame" ? roundTicksToFrame(ticks, ctx.fps) : ticks;
}

function defineRef(ctx: Ctx, ref: string | undefined, id: string): void {
	if (!ref) return;
	if (ctx.refs[ref] !== undefined) fail("duplicate_ref", `ref "${ref}" is already defined in this batch`, ref);
	ctx.refs[ref] = id;
	ctx.newRefs.push(ref);
}

function resolveId(ctx: Ctx, ref: string): string {
	return ctx.refs[ref] ?? ref;
}

function findTrack(ctx: Ctx, ref: string): TimelineTrack {
	const tracks = ctx.scene.tracks;
	if (ref === "main") return tracks.main;
	const id = resolveId(ctx, ref);
	const track = orderedTracks(tracks).find((candidate) => candidate.id === id);
	if (!track) fail("missing_target", `track "${ref}" not found`, ref);
	return track;
}

function findElement(ctx: Ctx, ref: string): { track: TimelineTrack; element: TimelineElement; position: number } {
	const found = ctx.state.findElement(resolveId(ctx, ref));
	if (!found) fail("missing_target", `element "${ref}" not found`, ref);
	return found;
}

/** Drop own keys whose value is undefined, so JSON and deep-equality agree. */
function clean<T extends object>(value: T): T {
	for (const key of Object.keys(value) as Array<keyof T>) {
		if (value[key] === undefined) delete value[key];
	}
	return value;
}

/** track.elements = elements (diffed; prefer the specific helpers below). */
function setElements(ctx: Ctx, track: TimelineTrack, elements: TimelineElement[]): void {
	ctx.state.setAll(track, elements);
}

/** [...track.elements, element] */
function appendElement(ctx: Ctx, track: TimelineTrack, element: TimelineElement): void {
	ctx.state.append(track, element);
}

/** Every element with next.id on the track becomes `next`. */
function replaceElement(ctx: Ctx, track: TimelineTrack, next: TimelineElement): void {
	ctx.state.replace(track, next);
}

/** Every element with this id leaves the track. */
function removeElement(ctx: Ctx, track: TimelineTrack, id: string): void {
	ctx.state.removeId(track, id);
}

/** Reassign the overlay/audio groups (remove_track, reorder_tracks, a grade track removed). */
function setGroups(ctx: Ctx, overlay: OverlayTrack[], audio: AudioTrack[]): void {
	const tracks = ctx.scene.tracks;
	const before = orderedTracks(tracks);
	tracks.overlay = overlay;
	tracks.audio = audio;
	ctx.state.groupsChanged(before, orderedTracks(tracks));
}

function touch(ctx: Ctx, element: TimelineElement): TimelineElement {
	element.restorff = { ...(element.restorff ?? {}), author: ctx.author };
	return element;
}

function addUpdated(ctx: Ctx, id: string): void {
	const list = (ctx.change.updated ??= []);
	// membership in O(1): a ripple delete can update hundreds of elements
	const seen = (ctx.updatedSeen ??= new Set(list));
	if (!seen.has(id)) {
		seen.add(id);
		list.push(id);
	}
}

function addCreated(ctx: Ctx, kind: "elements" | "tracks" | "media" | "keyframes", id: string): void {
	const created = (ctx.change.created ??= {});
	(created[kind] ??= []).push(id);
}

function pending(
	ctx: Ctx,
	reason: string,
	honouredBy: UnsupportedRecord["honouredBy"],
	summary: string,
): void {
	const pendingId = ctx.ids.next("pending");
	meta(ctx).pending.push({
		id: pendingId,
		op: JSON.parse(JSON.stringify(ctx.opRaw)) as Record<string, unknown>,
		author: ctx.author,
		reason,
		honouredBy,
	});
	ctx.unsupported.push({ index: ctx.index, op: ctx.opRaw.op, pendingId, reason, honouredBy });
	ctx.change.status = "pending";
	ctx.change.summary = summary;
}

function noop(ctx: Ctx, summary: string): void {
	ctx.change.status = "noop";
	ctx.change.summary = summary;
}

/** placement/main-track.ts enforceMainTrackStart: the main track is magnetic to 0. */
function mainTrackStart(ctx: Ctx, trackId: string, requested: Ticks, excludeId?: string): Ticks {
	const main = ctx.scene.tracks.main;
	if (main.id !== trackId) return requested;
	const others = main.elements.filter((element) => element.id !== excludeId);
	if (!others.length) return 0;
	const earliest = Math.min(...others.map((element) => element.startTime));
	return requested <= earliest ? 0 : requested;
}

function assertNoOverlap(ctx: Ctx, track: TimelineTrack, start: Ticks, end: Ticks, excludeId?: string): void {
	if (!ctx.state.anyOverlap(track, start, end, excludeId)) return;
	// a conflict: name the first overlapping element in array order, as before
	const hit = overlapsAny(track.elements, start, end, excludeId);
	if (hit) {
		fail(
			"overlap",
			`[${start}, ${end}) ticks overlaps element ${hit.id} [${hit.startTime}, ${endOf(hit)}) on track ${track.id}`,
			hit.id,
		);
	}
}

/** Insert a new track into its group. groupIndex: 0 = top of the group; default = the editor's default. */
function createTrack(
	ctx: Ctx,
	type: TrackType,
	options: { name?: string; role?: NonNullable<TimelineTrack["restorff"]>["role"]; groupIndex?: number },
): TimelineTrack {
	const tracks = ctx.scene.tracks;
	// AddTrackCommand and placement/apply.ts both name new tracks from the tracks that exist before the insert.
	const track = buildEmptyTrack(ctx.ids.next("track"), type, options.name ?? defaultTrackName(tracks, type));
	track.restorff = clean({ role: options.role, createdBy: ctx.author });
	if (type === "audio") {
		// insert-index.ts: default = bottom of the audio group
		const index = Math.max(0, Math.min(options.groupIndex ?? tracks.audio.length, tracks.audio.length));
		tracks.audio.splice(index, 0, track as AudioTrack);
	} else {
		// insert-index.ts: effect → 0, others → just above main
		const fallback = type === "effect" ? 0 : tracks.overlay.length;
		const index = Math.max(0, Math.min(options.groupIndex ?? fallback, tracks.overlay.length));
		tracks.overlay.splice(index, 0, track as OverlayTrack);
	}
	ctx.state.trackCreated(track); // the splice itself is undone by the savepoint (group slices)
	addCreated(ctx, "tracks", track.id);
	return track;
}

/** Media lookup: the batch's refs, the manifest, then elements already using the id. */
function resolveMedia(
	ctx: Ctx,
	ref: string,
	kindHint?: "video" | "audio" | "image",
): { id: string; kind: "video" | "audio" | "image"; duration?: Ticks; entry?: MediaManifestEntry } {
	const id = resolveId(ctx, ref);
	const entry = manifest(ctx).find((candidate) => candidate.id === id);
	if (entry) return { id, kind: entry.kind, duration: entry.kind === "image" ? undefined : entry.duration, entry };
	for (const track of orderedTracks(ctx.scene.tracks)) {
		for (const element of track.elements) {
			if ("mediaId" in element && element.mediaId === id) {
				const kind = element.type === "image" ? "image" : element.type === "video" ? "video" : "audio";
				return { id, kind, duration: element.sourceDuration };
			}
		}
	}
	if (kindHint) return { id, kind: kindHint };
	fail("missing_target", `media "${ref}" is unknown: import_media it first or pass media_kind`, ref);
}

function coerceOrFail(ctx: Ctx, element: TimelineElement, key: string, value: unknown): ParamValue {
	const def = getParamDef(element.type, key, element.type === "graphic" ? element.definitionId : undefined);
	if (!def) fail("incompatible", `${element.type} elements have no param "${key}"`, element.id);
	const coerced = coerceParamValue(def, value);
	if (coerced === null) fail("out_of_range", `value ${JSON.stringify(value)} is not valid for ${key}`, element.id);
	if (key === "content" && typeof coerced === "string" && coerced.trim() === "") {
		fail("out_of_range", "text content must not be blank (InsertElementCommand rejects it)", element.id);
	}
	return coerced;
}

function applyParams(ctx: Ctx, element: TimelineElement, params: Record<string, unknown>): string[] {
	const changed: string[] = [];
	for (const [key, value] of Object.entries(params)) {
		const coerced = coerceOrFail(ctx, element, key, value);
		if (element.params[key] !== coerced) changed.push(key);
		element.params[key] = coerced;
		if (element.animations?.[key]) {
			(ctx.change.details ??= {}).animated = [...((ctx.change.details.animated as string[]) ?? []), key];
		}
	}
	return changed;
}

// ---------------------------------------------------------------- op handlers

function opSetCanvas(ctx: Ctx, op: SetCanvasOp): void {
	const settings = ctx.project.settings;
	const parts: string[] = [];
	if (op.w !== undefined && op.h !== undefined) {
		settings.canvasSize = { width: op.w, height: op.h };
		parts.push(`canvas ${op.w}x${op.h}`);
	}
	if (op.fps !== undefined) {
		const rate = typeof op.fps === "number" ? floatToFrameRate(op.fps) : { ...op.fps };
		if (ticksPerFrame(rate) === null) {
			fail(
				"out_of_range",
				`fps ${rate.numerator}/${rate.denominator} gives a non-integer ${TICKS_PER_SECOND}·den/num ticks per frame; the editor's frame maths would fall back`,
			);
		}
		settings.fps = rate;
		ctx.fps = rate;
		parts.push(`fps ${rate.numerator}/${rate.denominator}`);
	}
	if (op.background !== undefined) {
		settings.background = { type: "color", color: op.background };
		parts.push(`background ${op.background}`);
	}
	ctx.change.summary = parts.join(", ");
}

function opAddSizeVariant(ctx: Ctx, op: AddSizeVariantOp): void {
	pending(
		ctx,
		"the editor model has no size variants; 4:5 / 1:1 / 16:9 are derived timelines with reframe keyframes " +
			"(plan/05 §8 'Sizes'), built by a variant compiler that does not exist yet",
		"variant-compiler",
		`size variant ${op.aspect} (${op.reframe}) recorded, not built`,
	);
}

function opImportMedia(ctx: Ctx, op: ImportMediaOp): void {
	const media = meta(ctx).media;
	const existing = media.find(
		(entry) => (op.blob_sha && entry.blobSha === op.blob_sha) || (!op.blob_sha && op.url && entry.url === op.url),
	);
	if (existing) {
		defineRef(ctx, op.ref, existing.id);
		ctx.change.details = { mediaId: existing.id };
		noop(ctx, `media already in the manifest as ${existing.id}`);
		return;
	}
	const id = ctx.ids.next("media");
	const entry: MediaManifestEntry = clean({
		id,
		kind: op.kind,
		name: op.name ?? op.blob_sha?.slice(0, 12) ?? op.url ?? id,
		blobSha: op.blob_sha,
		url: op.url,
		duration: op.duration !== undefined && op.kind !== "image" ? secondsToTicks(op.duration) : undefined,
		width: op.width,
		height: op.height,
		fps: op.fps,
		hasAudio: op.has_audio,
		author: ctx.author,
	});
	media.push(entry);
	defineRef(ctx, op.ref, id);
	addCreated(ctx, "media", id);
	ctx.change.summary = `${op.kind} ${entry.name} added to the media manifest as ${id}`;
	ctx.change.details = {
		external:
			"the asset itself must be created in the editor's media store (services/storage MediaAssetData) with this id",
	};
}

const TRACK_KIND: Record<AddTrackOp["kind"], TrackType> = {
	video: "video",
	audio: "audio",
	text: "text",
	caption: "text",
	overlay: "graphic",
	effect: "effect",
};

function opAddTrack(ctx: Ctx, op: AddTrackOp): void {
	const type = TRACK_KIND[op.kind];
	const track = createTrack(ctx, type, {
		name: op.name ?? (op.kind === "caption" ? CAPTIONS_TRACK_NAME : undefined),
		role: op.kind === "caption" ? "caption" : undefined,
		groupIndex: op.index ?? (op.kind === "caption" ? 0 : undefined),
	});
	defineRef(ctx, op.ref, track.id);
	ctx.change.summary = `${op.kind} track "${track.name}" (${type}) added`;
}

function opRemoveTrack(ctx: Ctx, op: RemoveTrackOp): void {
	const tracks = ctx.scene.tracks;
	const track = findTrack(ctx, op.track);
	if (track.id === tracks.main.id) {
		fail("incompatible", "the main track cannot be removed (RemoveTrackCommand only filters overlay/audio)", op.track);
	}
	setGroups(
		ctx,
		tracks.overlay.filter((candidate) => candidate.id !== track.id),
		tracks.audio.filter((candidate) => candidate.id !== track.id),
	);
	ctx.change.removed = { tracks: [track.id], elements: track.elements.map((element) => element.id) };
	ctx.change.summary = `track "${track.name}" removed with ${track.elements.length} element(s)`;
}

function opReorderTracks(ctx: Ctx, op: ReorderTracksOp): void {
	const tracks = ctx.scene.tracks;
	const resolved = op.order.map((ref) => (ref === "main" ? tracks.main.id : resolveId(ctx, ref)));
	const movable = [...tracks.overlay, ...tracks.audio];
	const withoutMain = resolved.filter((id) => id !== tracks.main.id);
	const known = new Set(movable.map((track) => track.id));
	if (new Set(withoutMain).size !== withoutMain.length) fail("out_of_range", "order lists a track twice");
	for (const id of withoutMain) if (!known.has(id)) fail("missing_target", `track "${id}" not found`, id);
	if (withoutMain.length !== movable.length) {
		fail("out_of_range", `order must list all ${movable.length} overlay and audio tracks (got ${withoutMain.length})`);
	}
	const byId = new Map(movable.map((track) => [track.id, track]));
	const mainAt = resolved.indexOf(tracks.main.id);
	const overlay: OverlayTrack[] = [];
	const audio: AudioTrack[] = [];
	let seenAudio = false;
	resolved.forEach((id, position) => {
		if (id === tracks.main.id) return;
		const track = byId.get(id) as TimelineTrack;
		const isAudio = track.type === "audio";
		if (mainAt >= 0 && (isAudio ? position < mainAt : position > mainAt)) {
			fail("incompatible", `${track.type} track "${track.name}" cannot sit ${isAudio ? "above" : "below"} the main track`, id);
		}
		if (!isAudio && seenAudio) fail("incompatible", "overlay tracks must all come before audio tracks");
		if (isAudio) {
			seenAudio = true;
			audio.push(track as AudioTrack);
		} else {
			overlay.push(track as OverlayTrack);
		}
	});
	const unchanged =
		overlay.every((track, i) => track === tracks.overlay[i]) && audio.every((track, i) => track === tracks.audio[i]);
	setGroups(ctx, overlay, audio);
	if (unchanged) noop(ctx, "tracks already in that order");
	else ctx.change.summary = `tracks reordered: ${[...overlay, tracks.main, ...audio].map((t) => t.name).join(" / ")}`;
}

function buildInsertElement(ctx: Ctx, op: InsertOp): TimelineElement {
	const elementId = ctx.ids.next("element");
	const base = { id: elementId, startTime: 0, trimStart: 0, trimEnd: 0 };
	const defaultDuration = 5 * TICKS_PER_SECOND; // timeline/creation.ts DEFAULT_NEW_ELEMENT_DURATION
	if (op.media !== undefined) {
		const media = resolveMedia(ctx, op.media, op.media_kind);
		const name = op.name ?? media.entry?.name ?? media.id;
		if (media.kind === "image") {
			const duration =
				op.dur !== undefined ? toTicks(ctx, op.dur) : op.out !== undefined ? toTicks(ctx, op.out) - toTicks(ctx, op.in ?? 0) : defaultDuration;
			const image: ImageElement = {
				...base,
				type: "image",
				mediaId: media.id,
				name,
				duration,
				hidden: false,
				params: defaultParams(ELEMENT_PARAMS.image),
			};
			return image;
		}
		const inTicks = op.in !== undefined ? toTicks(ctx, op.in) : 0;
		const outTicks =
			op.out !== undefined
				? toTicks(ctx, op.out)
				: op.dur !== undefined
					? inTicks + toTicks(ctx, op.dur)
					: media.duration;
		if (outTicks === undefined) {
			fail("out_of_range", `media length unknown: give out or dur (or import_media with duration)`, op.media);
		}
		if (media.duration !== undefined && outTicks > media.duration) {
			fail("out_of_range", `out ${outTicks} ticks is past the media length ${media.duration}`, op.media);
		}
		if (outTicks <= inTicks) fail("out_of_range", "out must be after in", op.media);
		const common = {
			...base,
			mediaId: media.id,
			name,
			duration: outTicks - inTicks,
			trimStart: inTicks,
			trimEnd: media.duration !== undefined ? media.duration - outTicks : 0,
			sourceDuration: media.duration,
		};
		if (media.duration === undefined) {
			(ctx.change.details ??= {}).warning = "media length unknown: sourceDuration not set, trims cannot be bounds-checked";
		}
		if (media.kind === "video") {
			const video: VideoElement = clean({
				...common,
				type: "video",
				isSourceAudioEnabled: true,
				hidden: false,
				params: defaultParams(ELEMENT_PARAMS.video),
			});
			return video;
		}
		const audio: AudioElement = clean({
			...common,
			type: "audio",
			sourceType: "upload",
			params: defaultParams(ELEMENT_PARAMS.audio),
		});
		return audio;
	}
	const duration =
		op.dur !== undefined
			? toTicks(ctx, op.dur)
			: op.out !== undefined
				? toTicks(ctx, op.out) - toTicks(ctx, op.in ?? 0)
				: defaultDuration;
	if (op.text !== undefined) {
		const text: TextElement = {
			...base,
			type: "text",
			name: op.name ?? "Text",
			duration,
			params: { ...defaultParams(ELEMENT_PARAMS.text), content: applyTextCase(op.text, op.style) },
		};
		return text;
	}
	const shape = op.shape as string;
	const graphic: GraphicElement = {
		...base,
		type: "graphic",
		definitionId: shape,
		name: op.name ?? shape.charAt(0).toUpperCase() + shape.slice(1),
		duration,
		params: { ...defaultParams(ELEMENT_PARAMS.graphic), ...defaultParams(GRAPHIC_PARAMS[shape] ?? []) },
	};
	return graphic;
}

function opInsert(ctx: Ctx, op: InsertOp): void {
	const track = findTrack(ctx, op.track);
	const element = buildInsertElement(ctx, op);
	if (!canElementGoOnTrack(element.type, track.type)) {
		fail("incompatible", `${element.type} elements cannot be placed on ${track.type} tracks`, op.track);
	}
	if (op.style) applyParams(ctx, element, styleToParams(op.style));
	if (op.params) applyParams(ctx, element, op.params);
	if (!(element.duration > 0)) fail("out_of_range", "duration must be > 0");
	const requested = toTicks(ctx, op.t);
	element.startTime = mainTrackStart(ctx, track.id, requested);
	if (element.startTime !== requested) {
		(ctx.change.details ??= {}).adjustedStart = { requested, actual: element.startTime, rule: "main track starts at 0" };
	}
	assertNoOverlap(ctx, track, element.startTime, endOf(element));
	element.restorff = { createdBy: ctx.author, author: ctx.author };
	appendElement(ctx, track, element);
	defineRef(ctx, op.ref, element.id);
	addCreated(ctx, "elements", element.id);
	ctx.change.summary = `${element.type} "${element.name}" at ${element.startTime} ticks for ${element.duration} on "${track.name}"`;
}

function opMove(ctx: Ctx, op: MoveOp): void {
	const { track: source, element } = findElement(ctx, op.el);
	const target = op.track !== undefined ? findTrack(ctx, op.track) : source;
	if (!canElementGoOnTrack(element.type, target.type)) {
		fail("incompatible", `${element.type} elements cannot be placed on ${target.type} tracks`, op.track);
	}
	const requested = Math.max(0, toTicks(ctx, op.t));
	const startTime = mainTrackStart(ctx, target.id, requested, element.id);
	assertNoOverlap(ctx, target, startTime, startTime + element.duration, element.id);
	const moved = touch(ctx, { ...element, startTime });
	// MoveElementCommand: filter the element out of every track, append it to the target's elements.
	removeElement(ctx, source, element.id);
	appendElement(ctx, target, moved);
	addUpdated(ctx, element.id);
	if (startTime !== requested) {
		ctx.change.details = { adjustedStart: { requested, actual: startTime, rule: "main track starts at 0" } };
	}
	ctx.change.summary = `moved to ${startTime} ticks${target !== source ? ` on "${target.name}"` : ""}`;
}

function opTrim(ctx: Ctx, op: TrimOp): void {
	const { track, element } = findElement(ctx, op.el);
	const rate = rateOf(element);
	const toClip = (sourceTicks: number) => (rate === 1 ? sourceTicks : roundHalfAwayFromZero(sourceTicks / rate));
	const span = rate === 1 ? element.duration : roundHalfAwayFromZero(element.duration * rate);
	const currentIn = element.trimStart;
	const currentOut = currentIn + span;
	const newIn = op.in !== undefined ? toTicks(ctx, op.in) : currentIn;
	const newOut = op.out !== undefined ? toTicks(ctx, op.out) : currentOut;
	if (newOut <= newIn) fail("out_of_range", `out (${newOut}) must be after in (${newIn}) ticks`, op.el);
	const sourceDuration = knownSourceDuration(element, manifest(ctx));
	if (sourceDuration !== undefined && newOut > sourceDuration) {
		fail("out_of_range", `out ${newOut} ticks is past the media length ${sourceDuration}`, op.el);
	}
	const startTime = element.startTime + toClip(newIn - currentIn);
	if (startTime < 0) fail("out_of_range", `the new in point would start the clip before 0 (${startTime} ticks)`, op.el);
	const duration = toClip(newOut - newIn);
	const minDuration = ticksPerFrame(ctx.fps) ?? 1; // compute-resize.ts: one frame minimum
	if (duration < minDuration) fail("out_of_range", `duration ${duration} ticks is shorter than one frame`, op.el);
	assertNoOverlap(ctx, track, startTime, startTime + duration, element.id);
	const next: TimelineElement = {
		...element,
		startTime,
		duration,
		trimStart: newIn,
		trimEnd: Math.max(0, element.trimEnd - (newOut - currentOut)),
	};
	if (duration !== element.duration) {
		next.animations = clampAnimationsToDuration(element.animations, duration, newIdFor(ctx));
	}
	replaceElement(ctx, track, touch(ctx, clean(next)));
	addUpdated(ctx, element.id);
	ctx.change.summary = `trimmed to source [${newIn}, ${newOut}) ticks, now ${startTime}+${duration}`;
}

function opSplit(ctx: Ctx, op: SplitOp): void {
	const { track, element } = findElement(ctx, op.el);
	const splitTime = toTicks(ctx, op.t);
	if (splitTime <= element.startTime || splitTime >= endOf(element)) {
		fail("out_of_range", `split time ${splitTime} is not inside the element (${element.startTime}, ${endOf(element)})`, op.el);
	}
	const relative = splitTime - element.startTime;
	const rate = rateOf(element);
	// split-elements.ts:99-114 — snap the source split once, derive the right half from it.
	const leftSourceSpan = roundHalfAwayFromZero(Math.max(0, relative * rate));
	const totalSourceSpan = roundHalfAwayFromZero(Math.max(0, element.duration * rate));
	const rightSourceSpan = totalSourceSpan - leftSourceSpan;
	const { left, right } = splitAnimationsAtTime(element.animations, relative, newIdFor(ctx));
	const retime = retimeOf(element);
	const rightId = ctx.ids.next("element");
	const leftElement = clean({
		...element,
		duration: relative,
		trimEnd: element.trimEnd + rightSourceSpan,
		name: `${element.name} (left)`,
		animations: left,
		...(retime !== undefined ? { retime } : {}),
	} as TimelineElement);
	const rightElement = clean({
		...element,
		id: rightId,
		startTime: splitTime,
		duration: element.duration - relative,
		trimStart: element.trimStart + leftSourceSpan,
		name: `${element.name} (right)`,
		animations: right,
		...(retime !== undefined ? { retime } : {}),
		// v32: the transition into the original clip stays on the left half only.
		transitionIn: undefined,
	} as TimelineElement);
	touch(ctx, leftElement);
	touch(ctx, rightElement);
	// elements.flatMap(e => e.id === element.id ? [left, right] : [e])
	ctx.state.split(track, element.id, leftElement, rightElement);
	defineRef(ctx, op.ref, rightId);
	addUpdated(ctx, element.id);
	addCreated(ctx, "elements", rightId);
	ctx.change.summary = `split at ${splitTime} ticks: left ${element.id}, right ${rightId}`;
}

function opDelete(ctx: Ctx, op: DeleteOp): void {
	const { track, element } = findElement(ctx, op.el);
	removeElement(ctx, track, element.id);
	ctx.change.removed = { elements: [element.id] };
	ctx.change.summary = `deleted "${element.name}"`;
}

function opRippleDelete(ctx: Ctx, op: RippleDeleteOp): void {
	const { track, element } = findElement(ctx, op.el);
	const start = element.startTime;
	const end = endOf(element);
	const shift = end - start;
	removeElement(ctx, track, element.id);
	const straddling: string[] = [];
	const targets = op.scope === "all" ? orderedTracks(ctx.scene.tracks) : [track];
	for (const target of targets) {
		// mapElements: the callback returns its argument or a fresh copy (the state's positional fast path relies on it)
		ctx.state.mapElements(target, (candidate) => {
			// ripple/shift.ts: elements starting at or after the freed interval's end move left by its length.
			if (candidate.startTime >= end) {
				addUpdated(ctx, candidate.id);
				return { ...candidate, startTime: candidate.startTime - shift };
			}
			if (target !== track && candidate.startTime < end && endOf(candidate) > start) straddling.push(candidate.id);
			return candidate;
		});
	}
	ctx.change.removed = { elements: [element.id] };
	if (straddling.length) ctx.change.details = { straddling, note: "elements crossing the cut on other tracks were not moved" };
	ctx.change.summary = `ripple-deleted "${element.name}", closed a ${shift}-tick gap on ${op.scope === "all" ? "all tracks" : `"${track.name}"`}`;
}

const SET_ALIASES: Record<string, string[]> = {
	x: ["transform.positionX"],
	y: ["transform.positionY"],
	scale: ["transform.scaleX", "transform.scaleY"],
	scale_x: ["transform.scaleX"],
	scale_y: ["transform.scaleY"],
	rotation: ["transform.rotate"],
	opacity: ["opacity"],
	volume: ["volume"],
	muted: ["muted"],
	blend: ["blendMode"],
	text: ["content"],
	font: ["fontFamily"],
	font_size: ["fontSize"],
	color: ["color"],
	align: ["textAlign"],
	weight: ["fontWeight"],
};

function setSpeed(ctx: Ctx, track: TimelineTrack, element: TimelineElement, value: ParamValue): void {
	if (element.type !== "video" && element.type !== "audio") {
		fail("incompatible", `${element.type} elements cannot be retimed (RETIMABLE_ELEMENT_TYPES = video, audio)`, element.id);
	}
	if (typeof value !== "number") fail("out_of_range", "speed must be a number", element.id);
	const rate = clampRetimeRate(value);
	// update-pipeline.ts:35-80 — duration follows the visible source span at the new rate.
	const sourceDuration =
		element.sourceDuration ??
		element.trimStart + roundHalfAwayFromZero(element.duration * rateOf(element)) + element.trimEnd;
	const visible = Math.max(0, sourceDuration - element.trimStart - element.trimEnd);
	const duration = roundHalfAwayFromZero(visible / rate);
	if (!(duration > 0)) fail("out_of_range", "speed leaves no visible duration", element.id);
	assertNoOverlap(ctx, track, element.startTime, element.startTime + duration, element.id);
	const next = {
		...element,
		retime: { ...(element.retime ?? {}), rate },
		duration,
		animations: clampAnimationsToDuration(element.animations, duration, newIdFor(ctx)),
	} as TimelineElement;
	replaceElement(ctx, track, touch(ctx, clean(next)));
	ctx.change.summary = `speed ${rate}x, duration now ${duration} ticks`;
}

function setSourceAudio(ctx: Ctx, track: TimelineTrack, element: TimelineElement, value: ParamValue): void {
	if (element.type !== "video") fail("incompatible", "source_audio only applies to video elements", element.id);
	if (typeof value !== "boolean") fail("out_of_range", "source_audio must be true or false", element.id);
	const separated = element.isSourceAudioEnabled === false;
	if (value) {
		if (!separated) return noop(ctx, "source audio already enabled");
		// ToggleSourceAudioSeparationCommand "Recover audio": only flips the flag; the extracted element stays.
		replaceElement(ctx, track, touch(ctx, { ...element, isSourceAudioEnabled: true }));
		ctx.change.summary = "source audio recovered (the extracted audio element is left in place, like the editor)";
		return;
	}
	if (separated) return noop(ctx, "source audio already separated");
	const entry = manifest(ctx).find((candidate) => candidate.id === element.mediaId);
	if (entry?.hasAudio === false) fail("incompatible", "the media has no audio to extract", element.id);
	// audio-separation/index.ts buildSeparatedAudioElement
	const audio: AudioElement = clean({
		id: ctx.ids.next("element"),
		type: "audio",
		sourceType: "upload",
		mediaId: element.mediaId,
		name: element.name,
		duration: element.duration,
		startTime: element.startTime,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		sourceDuration: element.sourceDuration,
		params: {
			volume: typeof element.params.volume === "number" ? element.params.volume : 0,
			muted: element.params.muted === true,
		},
		retime: element.retime ? clean({ rate: element.retime.rate, maintainPitch: element.retime.maintainPitch }) : undefined,
		animations: element.animations?.volume
			? cloneWithNewKeyIds({ volume: element.animations.volume }, newIdFor(ctx))
			: undefined,
		restorff: { createdBy: ctx.author, author: ctx.author },
	});
	// placement: firstAvailable audio track, else a new one at the top of the audio group ("highest").
	const tracks = ctx.scene.tracks;
	let target: TimelineTrack | undefined = tracks.audio.find(
		(candidate) => !ctx.state.anyOverlap(candidate, audio.startTime, endOf(audio)),
	);
	if (!target) target = createTrack(ctx, "audio", { groupIndex: 0 });
	appendElement(ctx, target, audio);
	replaceElement(ctx, track, touch(ctx, { ...element, isSourceAudioEnabled: false }));
	addCreated(ctx, "elements", audio.id);
	ctx.change.summary = `source audio extracted to ${audio.id} on "${target.name}"`;
	if (!entry) ctx.change.details = { warning: "media not in the manifest: could not confirm it has audio" };
}

function cloneWithNewKeyIds(
	animations: NonNullable<TimelineElement["animations"]>,
	newId: (purpose: string) => string,
): NonNullable<TimelineElement["animations"]> {
	const copy = JSON.parse(JSON.stringify(animations)) as NonNullable<TimelineElement["animations"]>;
	for (const data of Object.values(copy)) {
		const channels = isLeafChannelData(data) ? [data] : Object.values(data ?? {});
		const idMap = new Map<string, string>();
		for (const channel of channels) {
			if (!channel) continue;
			for (const key of channel.keys) {
				if (!idMap.has(key.id)) idMap.set(key.id, newId("keyframe"));
				key.id = idMap.get(key.id) as string;
			}
		}
	}
	return copy;
}

function opSet(ctx: Ctx, op: SetOp): void {
	if (op.track !== undefined) {
		const track = findTrack(ctx, op.track);
		if (op.prop === "name") {
			if (typeof op.value !== "string" || !op.value.trim()) fail("out_of_range", "name must be a non-empty string");
			ctx.state.setTrackProp(track, "name", op.value);
		} else if (op.prop === "muted") {
			if (track.type !== "audio" && track.type !== "video") fail("incompatible", `${track.type} tracks cannot be muted`);
			if (typeof op.value !== "boolean") fail("out_of_range", "muted must be a boolean");
			ctx.state.setTrackProp(track, "muted", op.value);
		} else if (op.prop === "hidden") {
			if (track.type === "audio") fail("incompatible", "audio tracks cannot be hidden (canTrackBeHidden)");
			if (typeof op.value !== "boolean") fail("out_of_range", "hidden must be a boolean");
			ctx.state.setTrackProp(track, "hidden", op.value);
		} else {
			fail("incompatible", `unknown track prop "${op.prop}" (name, muted, hidden)`);
		}
		ctx.change.summary = `track "${track.name}" ${op.prop} = ${JSON.stringify(op.value)}`;
		return;
	}
	const { track, element } = findElement(ctx, op.el as string);
	addUpdated(ctx, element.id);
	if (op.prop === "speed") return setSpeed(ctx, track, element, op.value);
	if (op.prop === "source_audio") return setSourceAudio(ctx, track, element, op.value);
	const next = { ...element, params: { ...element.params } } as TimelineElement;
	if (op.prop === "name") {
		if (typeof op.value !== "string" || !op.value.trim()) fail("out_of_range", "name must be a non-empty string");
		next.name = op.value;
	} else if (op.prop === "hidden") {
		if (!["video", "image", "text", "sticker", "graphic"].includes(element.type)) {
			fail("incompatible", `${element.type} elements cannot be hidden`);
		}
		if (typeof op.value !== "boolean") fail("out_of_range", "hidden must be a boolean");
		(next as { hidden?: boolean }).hidden = op.value;
	} else {
		const keys = SET_ALIASES[op.prop] ?? [op.prop];
		applyParams(ctx, next, Object.fromEntries(keys.map((key) => [key, op.value])));
		// revise-safety (2026-10-21): a caption chunk built by the captions tool records a style `set` in its look, like
		// set_caption_style does — else the next captions rebuild undoes it (the oat run's moody half came back at the
		// style's size after a rebuild, next to restyled chunks: mixed sizes)
		const tag = next.restorff as (typeof next.restorff & { caption?: { look?: CaptionLook } }) | undefined;
		if (next.type === "text" && tag?.caption && typeof tag.caption === "object") {
			const style: Record<string, unknown> = {};
			for (const key of keys) {
				const styleKey = PARAM_TO_CAPTION_STYLE[key];
				if (styleKey) style[styleKey] = op.value;
			}
			if (Object.keys(style).length) {
				next.restorff = { ...tag, caption: { ...tag.caption, look: lookAfterRestyle(tag.caption.look, style as TextStyle, ctx.project.settings.canvasSize) } } as typeof next.restorff;
			}
		}
	}
	replaceElement(ctx, track, touch(ctx, next));
	ctx.change.summary = `${element.id} ${op.prop} = ${JSON.stringify(op.value)}`;
}

/** Editor text params → the TextStyle keys a caption look records (lookAfterRestyle). */
const PARAM_TO_CAPTION_STYLE: Record<string, string> = {
	fontSize: "size",
	fontFamily: "font",
	color: "color",
	fontWeight: "weight",
	letterSpacing: "letter_spacing",
	"background.enabled": "bg",
	"background.color": "bg_color",
	"background.cornerRadius": "bg_radius",
	"background.paddingX": "bg_padding_x",
	"background.paddingY": "bg_padding_y",
	"transform.positionY": "y",
};

const KEYFRAME_ALIASES: Record<string, string[]> = {
	x: ["transform.positionX"],
	y: ["transform.positionY"],
	scale: ["transform.scaleX", "transform.scaleY"],
	rotation: ["transform.rotate"],
	opacity: ["opacity"],
	volume: ["volume"],
};

/** Cubic-bezier control points (x1, y1, x2, y2) for the eased curves, CSS-style. */
const EASE_CURVES: Record<string, [number, number, number, number]> = {
	ease_in: [0.42, 0, 1, 1],
	ease_out: [0, 0, 0.58, 1],
	ease_in_out: [0.42, 0, 0.58, 1],
};

/**
 * `ease` describes how the value travels INTO this keyframe from the previous one: it sets the previous key's
 * segmentToNext (step for "hold", linear, bezier) and, for ease_*, explicit handles on both keys.
 */
function applyEase(channel: ScalarChannel, keyId: string, ease: Ease): { applied: boolean } {
	const keys = channel.keys;
	const index = keys.findIndex((key) => key.id === keyId);
	const previous = keys[index - 1];
	if (index <= 0 || !previous) return { applied: false };
	const current = keys[index];
	if (ease === "hold" || ease === "linear" || ease === "bezier") {
		previous.segmentToNext = segmentTypeFor(ease);
		delete previous.rightHandle;
		delete current.leftHandle;
		return { applied: true };
	}
	const [x1, y1, x2, y2] = EASE_CURVES[ease];
	const span = current.time - previous.time;
	const delta = current.value - previous.value;
	previous.segmentToNext = "bezier";
	previous.rightHandle = { dt: roundHalfAwayFromZero(x1 * span), dv: y1 * delta };
	current.leftHandle = { dt: roundHalfAwayFromZero((x2 - 1) * span), dv: (y2 - 1) * delta };
	return { applied: true };
}

function opKeyframe(ctx: Ctx, op: KeyframeOp): void {
	const { track, element } = findElement(ctx, op.el);
	if (op.prop === "crop") {
		return pending(
			ctx,
			"the editor has no crop property; a rectangle mask can crop, but mask params are not animatable " +
				"(timeline/animation-targets.ts resolves element, graphic and effect params only)",
			"editor",
			"crop keyframe recorded, not applied",
		);
	}
	const paths = KEYFRAME_ALIASES[op.prop] ?? [op.prop];
	for (const path of paths) {
		const def = getParamDef(element.type, path, element.type === "graphic" ? element.definitionId : undefined);
		if (!def || def.type !== "number" || !def.keyframable) {
			fail("incompatible", `"${op.prop}" is not a keyframable number on ${element.type} elements`, op.el);
		}
	}
	const requested = op.local ? toTicks(ctx, op.t) : toTicks(ctx, op.t) - element.startTime;
	// UpsertKeyframeCommand: time is clamped to [0, duration].
	const local = Math.max(0, Math.min(requested, element.duration));
	let animations = element.animations;
	const keyIds: string[] = [];
	let easeApplied: boolean | undefined;
	for (const path of paths) {
		const def = getParamDef(element.type, path);
		const value = def ? (coerceParamValue(def, op.value) as number) : op.value;
		const result = upsertScalarKeyframe(animations, path, local, value, undefined, newIdFor(ctx));
		animations = result.animations;
		keyIds.push(result.keyId);
		if (op.ease && animations?.[path]) {
			const channel = animations[path] as ScalarChannel;
			easeApplied = applyEase(channel, result.keyId, op.ease).applied;
			animations[path] = normalizeScalarChannel(channel);
		}
	}
	const next = touch(ctx, clean({ ...element, animations }));
	replaceElement(ctx, track, next);
	addUpdated(ctx, element.id);
	for (const id of keyIds) addCreated(ctx, "keyframes", id);
	const details: Record<string, unknown> = {};
	if (local !== requested) details.clamped = { requested, actual: local };
	if (easeApplied === false) details.ease = "ignored: no earlier keyframe on this property";
	if (Object.keys(details).length) ctx.change.details = details;
	ctx.change.summary = `${op.prop} = ${op.value} at ${local} ticks into ${element.id}`;
}

function captionTargets(ctx: Ctx, trackRef?: string): { track: TimelineTrack; element: TextElement }[] {
	const tracks = trackRef !== undefined ? [findTrack(ctx, trackRef)] : orderedTracks(ctx.scene.tracks);
	const result: { track: TimelineTrack; element: TextElement }[] = [];
	for (const track of tracks) {
		if (track.type !== "text") continue;
		for (const element of track.elements) {
			const isCaption = element.restorff?.role === "caption" || track.restorff?.role === "caption";
			if (trackRef !== undefined || isCaption) result.push({ track, element: element as TextElement });
		}
	}
	return result;
}

function opAddCaptions(ctx: Ctx, op: AddCaptionsOp): void {
	const track =
		op.track !== undefined
			? findTrack(ctx, op.track)
			: createTrack(ctx, "text", { name: CAPTIONS_TRACK_NAME, role: "caption", groupIndex: 0 });
	if (track.type !== "text") fail("incompatible", `captions go on a text track, "${track.name}" is ${track.type}`, op.track);
	if (op.track === undefined) defineRef(ctx, op.ref, track.id);
	const style: TextStyle = { ...defaultCaptionStyle(ctx.project.settings.canvasSize.height), ...(op.style ?? {}) };
	const params = styleToParams(style);
	const chunks = chunkWords(op.words, { maxWords: op.max_words, gap: op.gap });
	const existingCaptions = track.elements.length;
	const created: TextElement[] = [];
	chunks.forEach((chunk, i) => {
		const startTime = toTicks(ctx, chunk.start);
		const duration = toTicks(ctx, chunk.end) - startTime;
		if (!(duration > 0)) return;
		const element: TextElement = {
			id: ctx.ids.next("element"),
			type: "text",
			name: `Caption ${existingCaptions + i + 1}`,
			startTime,
			duration,
			trimStart: 0,
			trimEnd: 0,
			params: { ...defaultParams(ELEMENT_PARAMS.text), content: applyTextCase(chunk.text, style) },
			restorff: { createdBy: ctx.author, author: ctx.author, role: "caption" },
		};
		applyParams(ctx, element, params);
		assertNoOverlap(ctx, track, startTime, startTime + duration);
		appendElement(ctx, track, element);
		created.push(element);
		addCreated(ctx, "elements", element.id);
	});
	ctx.change.summary = `${created.length} caption chunk(s) on "${track.name}" (${op.words.length} words)`;
	ctx.change.details = { chunks: created.map((element) => element.params.content) };
}

/**
 * captions-v2, 2026-10-20: the caption layers captions.ts builds beside the CAPTIONS track — "CAPTION WORDS" (word
 * highlight, karaoke prefix, key-word runs) and "CAPTION SHADOW" lanes ("… 2", "… 3" for key-word runs), tagged
 * `restorff.captionLayer` by the server and the editor.
 */
function captionLayerOf(track: TimelineTrack): "words" | "shadow" | null {
	const tag = (track.restorff as { captionLayer?: string } | undefined)?.captionLayer;
	if (tag === "words" || tag === "shadow") return tag;
	if (tag === "base") return null;
	const match = /^CAPTION (WORDS|SHADOW)( \d+)?$/i.exec(track.name ?? "");
	return match ? (match[1].toUpperCase() === "WORDS" ? "words" : "shadow") : null;
}

/** Text params a word layer can't follow: its x positions were measured in the old font, weight, spacing and align. */
const MEASURED_TEXT_PARAMS = ["fontFamily", "fontWeight", "fontStyle", "letterSpacing", "textAlign"] as const;

const numberOr = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function opSetCaptionStyle(ctx: Ctx, op: SetCaptionStyleOp): void {
	const targets = captionTargets(ctx, op.track);
	if (!targets.length) fail("missing_target", "no caption elements to style", op.track);
	const params = styleToParams(op.style);
	// captions-v2: restyling the base captions also restyles their word and shadow layers — never leaves a copy behind
	// (warm-moody REPORT §5 item 1: karaoke ghosts on every frame; explainer-overlay §5 item 5: shadow ghost + 6 MUSTs).
	// Size and position follow exactly (offsets from the chunk scale with the size); a whole-chunk shadow follows
	// everything; a layer placed by measuring text can't follow a new font / weight / spacing / align / case, so it is
	// removed (the chunk's own text shows in the new look) and the change says so.
	const layerTracks = ctx.scene.tracks.overlay.filter(
		(track) => track.type === "text" && captionLayerOf(track) !== null && !targets.some((target) => target.track === track),
	);
	const followed: string[] = [];
	const dropped: string[] = [];
	let revealed = 0;
	for (const { track, element } of targets) {
		const before = element.params;
		const next = { ...element, params: { ...element.params } };
		applyParams(ctx, next, params);
		if (op.style.uppercase) next.params.content = String(next.params.content).toUpperCase();
		let layerRemoved = false;

		if (captionLayerOf(track) === null && layerTracks.length) {
			const start = element.startTime;
			const end = element.startTime + element.duration;
			const siblings: Array<{ track: TimelineTrack; element: TextElement; layer: "words" | "shadow" }> = [];
			for (const layerTrack of layerTracks) {
				const layer = captionLayerOf(layerTrack) as "words" | "shadow";
				for (const candidate of layerTrack.elements) {
					if (candidate.type !== "text") continue;
					if (candidate.startTime >= start && candidate.startTime + candidate.duration <= end) {
						siblings.push({ track: layerTrack, element: candidate as TextElement, layer });
					}
				}
			}
			if (siblings.length) {
				const oldSize = numberOr(before.fontSize, 15);
				const k = numberOr(next.params.fontSize, oldSize) / (oldSize || 1);
				const ox = numberOr(before["transform.positionX"], 0);
				const oy = numberOr(before["transform.positionY"], 0);
				const nx = numberOr(next.params["transform.positionX"], ox);
				const ny = numberOr(next.params["transform.positionY"], oy);
				const caseChanged = op.style.uppercase === true && String(before.content) !== String(before.content).toUpperCase();
				const geometry = caseChanged || MEASURED_TEXT_PARAMS.some((key) => key in params && next.params[key] !== before[key]);
				const hiddenCarrier = numberOr(before.opacity, 1) === 0 && siblings.some((sibling) => sibling.layer === "words");
				let droppedHere = 0;
				for (const sibling of siblings) {
					const own = sibling.element.params;
					const wholeChunk = sibling.layer === "shadow" && String(own.content) === String(before.content);
					if (geometry && !wholeChunk) {
						removeElement(ctx, sibling.track, sibling.element.id);
						dropped.push(sibling.element.id);
						droppedHere++;
						if (sibling.layer === "words") layerRemoved = true;
						continue;
					}
					const out = { ...sibling.element, params: { ...sibling.element.params } };
					const follow: Record<string, unknown> = {};
					if (wholeChunk) {
						for (const key of [...MEASURED_TEXT_PARAMS, "lineHeight"]) if (key in params) follow[key] = params[key];
					}
					if (k !== 1) follow.fontSize = numberOr(own.fontSize, oldSize) * k;
					follow["transform.positionX"] = nx + (numberOr(own["transform.positionX"], ox) - ox) * k;
					follow["transform.positionY"] = ny + (numberOr(own["transform.positionY"], oy) - oy) * k;
					// words drawn in the chunk's own colour (key-word plain runs) follow it; accents and shadows keep theirs
					if ("color" in params && sibling.layer === "words" && own.color === before.color) follow.color = params.color;
					if (hiddenCarrier && "opacity" in params && sibling.layer === "words") follow.opacity = params.opacity;
					applyParams(ctx, out, follow);
					if (op.style.uppercase) out.params.content = String(out.params.content).toUpperCase();
					replaceElement(ctx, sibling.track, touch(ctx, out));
					addUpdated(ctx, out.id);
					followed.push(out.id);
				}
				if (hiddenCarrier) {
					// the chunk's own element is a hidden carrier (key-word): it shows only when its runs are gone
					next.params.opacity = droppedHere > 0 ? 1 : 0;
					if (droppedHere > 0) revealed++;
				}
			}
		}
		// a chunk built by the captions builder remembers the restyle in its look, so a rebuild keeps it (captions-v2)
		const tag = next.restorff as (typeof next.restorff & { caption?: { look?: CaptionLook } }) | undefined;
		if (tag?.caption && typeof tag.caption === "object") {
			next.restorff = { ...tag, caption: { ...tag.caption, look: lookAfterRestyle(tag.caption.look, op.style, ctx.project.settings.canvasSize, { layerRemoved }) } } as typeof next.restorff;
		}
		replaceElement(ctx, track, touch(ctx, next));
		addUpdated(ctx, element.id);
	}
	ctx.change.summary = `styled ${targets.length} caption(s)${followed.length ? `, ${followed.length} word/shadow layer element(s) followed` : ""}${dropped.length ? `, ${dropped.length} word-layer element(s) removed` : ""}`;
	if (dropped.length) {
		ctx.change.removed = { elements: dropped };
		ctx.change.details = {
			...(ctx.change.details ?? {}),
			caption_layers: {
				followed: followed.length,
				removed: dropped.length,
				shown_carriers: revealed,
				why: "the word highlight / karaoke / key-word layer is placed by measuring the old font; a new font, weight, letter spacing, alignment or case would leave it offset (a ghost copy), so it was removed and each caption shows in the new look",
				fix: "the chunks remember this look (rebuilds keep it); to get a word layer back, call the MCP captions tool with a style (e.g. {style: \"key-word\"}) — it re-measures every word",
			},
		};
	} else if (followed.length) {
		ctx.change.details = { ...(ctx.change.details ?? {}), caption_layers: { followed: followed.length, removed: 0 } };
	}
}

function opTextPop(ctx: Ctx, op: TextPopOp): void {
	const startTime = toTicks(ctx, op.t);
	const duration = toTicks(ctx, op.dur ?? 1.2);
	let track: TimelineTrack | undefined;
	if (op.track !== undefined) {
		track = findTrack(ctx, op.track);
		if (track.type !== "text") fail("incompatible", `text_pop needs a text track, "${track.name}" is ${track.type}`, op.track);
	} else {
		track = ctx.scene.tracks.overlay.find(
			(candidate) =>
				candidate.type === "text" &&
				candidate.restorff?.role !== "caption" &&
				!ctx.state.anyOverlap(candidate, startTime, startTime + duration),
		);
		if (!track) track = createTrack(ctx, "text", { role: "text", groupIndex: 0 });
	}
	const style: TextStyle = { ...defaultPopStyle(ctx.project.settings.canvasSize.height), ...(op.style ?? {}) };
	const element: TextElement = {
		id: ctx.ids.next("element"),
		type: "text",
		name: op.text.length > 24 ? `${op.text.slice(0, 24)}…` : op.text,
		startTime,
		duration,
		trimStart: 0,
		trimEnd: 0,
		params: { ...defaultParams(ELEMENT_PARAMS.text), content: applyTextCase(op.text, style) },
		restorff: { createdBy: ctx.author, author: ctx.author, role: "text_pop" },
	};
	applyParams(ctx, element, styleToParams(style));
	assertNoOverlap(ctx, track, startTime, startTime + duration);
	// The pop: scale 0.6 → 1.08 → 1.0 over 0.2 s, opacity 0 → 1 over 0.08 s (clamped to the element's length).
	const at = (seconds: number) => Math.min(duration, secondsToTicks(seconds));
	const newId = newIdFor(ctx);
	let animations: TimelineElement["animations"];
	for (const path of ["transform.scaleX", "transform.scaleY"]) {
		for (const [seconds, value] of [[0, 0.6], [0.12, 1.08], [0.2, 1]] as const) {
			animations = upsertScalarKeyframe(animations, path, at(seconds), value, undefined, newId).animations;
		}
	}
	const baseOpacity = typeof element.params.opacity === "number" ? element.params.opacity : 1;
	for (const [seconds, value] of [[0, 0], [0.08, baseOpacity]] as const) {
		animations = upsertScalarKeyframe(animations, "opacity", at(seconds), value, undefined, newId).animations;
	}
	element.animations = animations;
	appendElement(ctx, track, element);
	defineRef(ctx, op.ref, element.id);
	addCreated(ctx, "elements", element.id);
	ctx.change.summary = `text pop "${op.text}" at ${startTime} ticks on "${track.name}"`;
}

function opTransition(ctx: Ctx, op: TransitionOp): void {
	const a = findElement(ctx, op.a);
	const b = findElement(ctx, op.b);
	const kind = normalizeTransitionKind(op.kind);
	if (CUT_KINDS.includes(kind)) {
		// revise-safety (2026-10-21): a cut where a transition is takes it away (no other op can; "take a pass" offers it)
		if ((b.element as { transitionIn?: unknown }).transitionIn) {
			const next = { ...b.element, transitionIn: undefined } as TimelineElement;
			replaceElement(ctx, b.track, touch(ctx, next));
			addUpdated(ctx, b.element.id);
			ctx.change.summary = `transition removed: a plain ${kind} between ${a.element.id} and ${b.element.id}`;
			return;
		}
		return noop(ctx, `a ${kind} is the model's default join between ${a.element.id} and ${b.element.id}; nothing to write`);
	}
	const resolved = resolveTransitionKind(kind);
	if (resolved) {
		// Project v32: `transitionIn` on the incoming clip, centred on the cut (rendered by the wasm compositor).
		for (const side of [a, b]) {
			if (side.element.type !== "video" && side.element.type !== "image") {
				fail("incompatible", `transitions join video/image clips; ${side.element.id} is ${side.element.type}`, side.element.id);
			}
		}
		if (a.track.id !== b.track.id) fail("incompatible", `${op.a} and ${op.b} are on different tracks`, op.b);
		if (Math.abs(endOf(a.element) - b.element.startTime) > 1) {
			fail("out_of_range", `${op.a} ends at ${endOf(a.element)} ticks but ${op.b} starts at ${b.element.startTime}: a transition needs a cut`, op.b);
		}
		const duration = Math.max(1, toTicks(ctx, op.dur ?? TRANSITION_KINDS[resolved]));
		const longest = Math.min(a.element.duration, b.element.duration);
		if (duration > longest) {
			fail("out_of_range", `a ${duration}-tick transition does not fit: both halves must fit inside both clips (max ${longest})`, op.b);
		}
		const half = duration / 2;
		const warnings: string[] = [];
		const rateA = rateOf(a.element);
		const rateB = rateOf(b.element);
		if (a.element.type === "video" && a.element.trimEnd < half * rateA) warnings.push(`${op.a} has no media past its out point: its last frame holds`);
		if (b.element.type === "video" && b.element.trimStart < half * rateB) warnings.push(`${op.b} has no media before its in point: its first frame holds`);
		const next = { ...b.element, transitionIn: { type: resolved, duration } } as TimelineElement;
		replaceElement(ctx, b.track, touch(ctx, next));
		addUpdated(ctx, b.element.id);
		if (warnings.length) ctx.change.details = { holds: warnings };
		ctx.change.summary = `${resolved} (${duration} ticks) on the cut ${a.element.id} → ${b.element.id}`;
		return;
	}
	if (kind === "fade" || kind === "fade-through") {
		const half = Math.max(1, Math.round(toTicks(ctx, op.dur ?? 0.3) / 2));
		for (const { track, element } of [a, b]) {
			if (!["video", "image", "text", "sticker", "graphic"].includes(element.type)) {
				fail("incompatible", `${element.type} elements have no opacity`, element.id);
			}
			if (half * 2 > element.duration) fail("out_of_range", `transition longer than ${element.id}`, element.id);
		}
		const newId = newIdFor(ctx);
		const fade = (element: TimelineElement, keys: Array<[number, number]>) => {
			let animations = element.animations;
			for (const [time, value] of keys) {
				animations = upsertScalarKeyframe(animations, "opacity", time, value, undefined, newId).animations;
			}
			return animations;
		};
		const opacityA = typeof a.element.params.opacity === "number" ? a.element.params.opacity : 1;
		const opacityB = typeof b.element.params.opacity === "number" ? b.element.params.opacity : 1;
		const nextA = { ...a.element, animations: fade(a.element, [[a.element.duration - half, opacityA], [a.element.duration, 0]]) };
		replaceElement(ctx, a.track, touch(ctx, nextA as TimelineElement));
		const fresh = findElement(ctx, op.b);
		const nextB = { ...fresh.element, animations: fade(fresh.element, [[0, 0], [half, opacityB]]) };
		replaceElement(ctx, fresh.track, touch(ctx, nextB as TimelineElement));
		addUpdated(ctx, a.element.id);
		addUpdated(ctx, b.element.id);
		ctx.change.summary = `dip through the background: ${a.element.id} fades out, ${b.element.id} fades in (${half} ticks each)`;
		return;
	}
	pending(
		ctx,
		`no "${kind}" transition in the editor (kinds: ${Object.keys(TRANSITION_KINDS).join(", ")}); kept for a later ` +
			"editor build to honour",
		"editor",
		`${kind} transition between ${a.element.id} and ${b.element.id} recorded, not applied`,
	);
}

function opGain(ctx: Ctx, op: GainOp): void {
	const { track, element } = findElement(ctx, op.el);
	if (element.type !== "audio" && element.type !== "video") {
		fail("incompatible", `${element.type} elements carry no audio`, op.el);
	}
	const next = { ...element, params: { ...element.params } } as TimelineElement;
	applyParams(ctx, next, { volume: op.db });
	replaceElement(ctx, track, touch(ctx, next));
	addUpdated(ctx, element.id);
	ctx.change.summary = `${element.id} volume ${next.params.volume} dB`;
}

/** Union of the intervals where `under` plays, merged when the gap is shorter than attack + release. */
function voiceIntervals(track: TimelineTrack, bridge: number): Array<[number, number]> {
	const spans = track.elements
		.filter((element) => element.params.muted !== true)
		.filter((element) => element.type !== "video" || element.isSourceAudioEnabled !== false)
		.map((element) => [element.startTime, endOf(element)] as [number, number]);
	return mergeSpans(spans, bridge);
}

/** Sorted union of spans, joining those whose gap is shorter than `bridge`. */
function mergeSpans(spans: Array<[number, number]>, bridge: number): Array<[number, number]> {
	const merged: Array<[number, number]> = [];
	for (const span of [...spans].sort((x, y) => x[0] - y[0])) {
		const last = merged[merged.length - 1];
		if (last && span[0] - last[1] < bridge) last[1] = Math.max(last[1], span[1]);
		else merged.push([span[0], span[1]]);
	}
	return merged;
}

function opDuck(ctx: Ctx, op: DuckOp): void {
	const music = findTrack(ctx, op.track);
	const voice = findTrack(ctx, op.under);
	for (const track of [music, voice]) {
		if (track.type !== "audio" && track.type !== "video") fail("incompatible", `"${track.name}" carries no audio`, track.id);
	}
	if (music.id === voice.id) fail("incompatible", "a track cannot duck under itself", op.track);
	const amount = -Math.abs(op.amount_db);
	const attack = Math.max(1, secondsToTicks((op.attack_ms ?? 80) / 1000));
	const release = Math.max(1, secondsToTicks((op.release_ms ?? 250) / 1000));
	const intervals = op.spans
		? mergeSpans(
				op.spans.map(([start, end]) => [secondsToTicks(start), secondsToTicks(end)] as [number, number]),
				attack + release,
			)
		: voiceIntervals(voice, attack + release);
	if (!intervals.length) return noop(ctx, `nothing plays on "${voice.name}"; no ducking needed`);
	// Envelope of the reduction (dB ≤ 0) over timeline ticks, piecewise linear.
	const points: Array<[number, number]> = [];
	for (const [start, end] of intervals) {
		points.push([start - attack, 0], [start, amount], [end, amount], [end + release, 0]);
	}
	const reductionAt = (time: number): number => {
		if (time <= points[0][0] || time >= points[points.length - 1][0]) return 0;
		for (let i = 0; i < points.length - 1; i++) {
			const [t0, v0] = points[i];
			const [t1, v1] = points[i + 1];
			if (time >= t0 && time <= t1) return t1 === t0 ? v1 : v0 + ((time - t0) / (t1 - t0)) * (v1 - v0);
		}
		return 0;
	};
	const newId = newIdFor(ctx);
	let ducked = 0;
	const replacedVolumeKeys: string[] = [];
	for (const element of [...music.elements]) {
		const start = element.startTime;
		const end = endOf(element);
		const times = [start, ...points.map(([time]) => time).filter((time) => time > start && time < end), end];
		const base = typeof element.params.volume === "number" ? element.params.volume : 0;
		const samples = times.map((time) => [time, reductionAt(time)] as [number, number]);
		if (samples.every(([, reduction]) => reduction === 0)) continue;
		const keys: ScalarAnimationKey[] = [];
		samples.forEach(([time, reduction], i) => {
			const previous = samples[i - 1];
			const following = samples[i + 1];
			// drop interior points on a flat stretch
			if (previous && following && previous[1] === reduction && following[1] === reduction) return;
			const value = Math.min(VOLUME_DB_MAX, Math.max(VOLUME_DB_MIN, Math.round((base + reduction) * 100) / 100));
			keys.push({ id: newId("keyframe"), time: time - start, value, segmentToNext: "linear", tangentMode: "flat" });
		});
		if (element.animations?.volume) replacedVolumeKeys.push(element.id);
		const next = { ...element, animations: setScalarChannel(element.animations, "volume", keys) } as TimelineElement;
		replaceElement(ctx, music, touch(ctx, clean(next)));
		addUpdated(ctx, element.id);
		ducked += 1;
	}
	if (!ducked) return noop(ctx, `no element on "${music.name}" overlaps "${voice.name}"`);
	if (replacedVolumeKeys.length) ctx.change.details = { replacedVolumeKeys };
	ctx.change.summary = `ducked ${ducked} element(s) on "${music.name}" by ${amount} dB under "${voice.name}" (${intervals.length} span(s))`;
}

function opSfx(ctx: Ctx, op: SfxOp): void {
	if (op.media === undefined && op.url === undefined) {
		return pending(
			ctx,
			`no sound library in the reducer: the gateway must resolve "${op.name}" to audio, import it, then re-issue sfx with media`,
			"gateway",
			`sfx "${op.name}" at ${op.t}s recorded, not placed`,
		);
	}
	const startTime = toTicks(ctx, op.t);
	let element: AudioElement;
	if (op.media !== undefined) {
		const media = resolveMedia(ctx, op.media, "audio");
		if (media.kind !== "audio") fail("incompatible", `sfx media must be audio, ${op.media} is ${media.kind}`, op.media);
		const duration = op.dur !== undefined ? toTicks(ctx, op.dur) : media.duration;
		if (duration === undefined) fail("out_of_range", "sfx length unknown: give dur or import_media with duration", op.media);
		if (media.duration !== undefined && duration > media.duration) fail("out_of_range", "dur is longer than the sound", op.media);
		element = clean({
			id: ctx.ids.next("element"),
			type: "audio",
			sourceType: "upload",
			mediaId: media.id,
			name: op.name,
			startTime,
			duration,
			trimStart: 0,
			trimEnd: media.duration !== undefined ? media.duration - duration : 0,
			sourceDuration: media.duration,
			params: defaultParams(ELEMENT_PARAMS.audio),
		});
	} else {
		const duration = toTicks(ctx, op.dur as number);
		element = {
			id: ctx.ids.next("element"),
			type: "audio",
			sourceType: "library",
			sourceUrl: op.url as string,
			name: op.name,
			startTime,
			duration,
			trimStart: 0,
			trimEnd: 0,
			sourceDuration: duration,
			params: defaultParams(ELEMENT_PARAMS.audio),
		};
	}
	element.restorff = { createdBy: ctx.author, author: ctx.author, role: "sfx" };
	if (op.db !== undefined) applyParams(ctx, element, { volume: op.db });
	let track: TimelineTrack | undefined;
	if (op.track !== undefined) {
		track = findTrack(ctx, op.track);
		if (track.type !== "audio") fail("incompatible", `sfx goes on an audio track, "${track.name}" is ${track.type}`, op.track);
		assertNoOverlap(ctx, track, startTime, endOf(element));
	} else {
		track = ctx.scene.tracks.audio.find(
			(candidate) => candidate.restorff?.role === "sfx" && !ctx.state.anyOverlap(candidate, startTime, endOf(element)),
		);
		if (!track) track = createTrack(ctx, "audio", { name: "SFX", role: "sfx" });
	}
	appendElement(ctx, track, element);
	defineRef(ctx, op.ref, element.id);
	addCreated(ctx, "elements", element.id);
	ctx.change.summary = `sfx "${op.name}" at ${startTime} ticks on "${track.name}"`;
}

function opNormalize(ctx: Ctx, op: NormalizeOp): void {
	// Project v32: the target lives in settings.loudness; the editor's export masters to it and measures the encoded
	// file (apps/web/src/audio/master.ts), so the gate's LOUD check reads the real master.
	ctx.project.settings = {
		...ctx.project.settings,
		loudness: { enabled: true, integratedLufs: op.lufs, truePeakDb: op.true_peak },
	};
	ctx.change.summary = `master loudness target ${op.lufs} LUFS integrated, true peak <= ${op.true_peak} dBTP (applied at export)`;
}

function opBeats(ctx: Ctx, op: BeatsOp): void {
	const { track, element } = findElement(ctx, op.el);
	if (element.type !== "audio") fail("incompatible", `beats go on a music (audio) element, ${op.el} is ${element.type}`, op.el);
	if (op.downbeats?.some((index) => index >= op.times.length)) {
		fail("out_of_range", "a downbeat index points past the last beat", op.el);
	}
	const next = {
		...element,
		beats: clean({
			bpm: op.bpm,
			times: op.times.map((seconds) => secondsToTicks(seconds)),
			downbeats: op.downbeats,
			source: op.source ?? "detected",
		}),
	} as TimelineElement;
	replaceElement(ctx, track, touch(ctx, next));
	addUpdated(ctx, element.id);
	ctx.change.summary = `${op.times.length} beats at ${op.bpm} BPM on "${element.name}"`;
}

/** Timeline ticks of every beat of every unmuted audio element (inside its visible span). */
function timelineBeats(scene: Scene): number[] {
	const beats: number[] = [];
	for (const track of scene.tracks.audio) {
		if (track.muted) continue;
		for (const element of track.elements) {
			if (!element.beats) continue;
			const rate = rateOf(element);
			for (const source of element.beats.times) {
				const time = element.startTime + (source - element.trimStart) / rate;
				if (time >= element.startTime && time < endOf(element)) beats.push(time);
			}
		}
	}
	return beats.sort((x, y) => x - y);
}

/**
 * Rolls every cut on a track to the nearest beat (frame-rounded) within max_shift: the outgoing clip's tail and the
 * incoming clip's head move together, so nothing else on the timeline moves. A cut stays when no beat is in reach, a
 * clip would run out of media (trim handles) or get shorter than 6 frames. Same rule as the editor's "Snap cuts to
 * beats" (apps/web/src/beats/timeline.ts).
 */
function opSnapCuts(ctx: Ctx, op: SnapCutsOp): void {
	const track = findTrack(ctx, op.track ?? "main");
	const beats = timelineBeats(ctx.scene);
	if (!beats.length) return noop(ctx, "no beats on any music element (run a beats op first)");
	const frame = ticksPerFrame(ctx.fps) ?? secondsToTicks(1 / 30);
	const maxShift = secondsToTicks(op.max_shift ?? 0.2);
	const minClip = frame * 6;
	const sorted = [...track.elements].sort((x, y) => x.startTime - y.startTime).map((element) => ({ ...element }) as TimelineElement);
	const hasMedia = (element: TimelineElement) => element.type === "video" || element.type === "audio";
	let moved = 0;
	let skipped = 0;
	const changed = new Set<string>();
	for (let i = 0; i < sorted.length - 1; i++) {
		const a = sorted[i];
		const b = sorted[i + 1];
		const cut = endOf(a);
		if (Math.abs(cut - b.startTime) > 1) continue;
		const nearest = beats.reduce((best, beat) => (Math.abs(beat - cut) < Math.abs(best - cut) ? beat : best), beats[0]);
		const target = roundTicksToFrame(Math.round(nearest), ctx.fps);
		const shift = target - cut;
		if (shift === 0) continue;
		const aSource = Math.round(shift * rateOf(a));
		const bSource = Math.round(shift * rateOf(b));
		const fits =
			Math.abs(shift) <= maxShift &&
			a.duration + shift >= minClip &&
			b.duration - shift >= minClip &&
			(!hasMedia(a) || a.trimEnd - aSource >= 0) &&
			(!hasMedia(b) || b.trimStart + bSource >= 0);
		if (!fits) {
			skipped++;
			continue;
		}
		a.duration += shift;
		if (hasMedia(a)) a.trimEnd -= aSource;
		b.startTime += shift;
		b.duration -= shift;
		if (hasMedia(b)) b.trimStart += bSource;
		a.animations = clampAnimationsToDuration(a.animations, a.duration, newIdFor(ctx));
		b.animations = clampAnimationsToDuration(b.animations, b.duration, newIdFor(ctx));
		changed.add(a.id);
		changed.add(b.id);
		moved++;
	}
	if (!moved) return noop(ctx, `no cut on "${track.name}" could move onto a beat (${skipped} out of reach)`);
	setElements(
		ctx,
		track,
		track.elements.map((element) => {
			if (!changed.has(element.id)) return element;
			addUpdated(ctx, element.id);
			return touch(ctx, clean(sorted.find((candidate) => candidate.id === element.id) as TimelineElement));
		}),
	);
	ctx.change.summary = `${moved} cut(s) on "${track.name}" moved onto the beat` + (skipped ? `, ${skipped} left` : "");
}

// ---------------------------------------------------------------- grade (grade agent, 2026-10-20; ./grades.ts)

/** Element types that carry an `effects` list (the editor's VISUAL_ELEMENT_TYPES). */
const GRADEABLE_TYPES: readonly string[] = ["video", "image", "text", "sticker", "graphic"];
const TIMELINE_TARGETS: readonly string[] = ["all", "timeline", "everything"];

type WithEffects = TimelineElement & { effects?: Effect[] };

function isGradeTrack(track: TimelineTrack): track is EffectTrack {
	if (track.type !== "effect") return false;
	if (track.restorff?.role === "grade") return true;
	return track.elements.length > 0 && track.elements.every((element) => element.effectType === GRADE_EFFECT_TYPE);
}

/** The grade a target ends up with: the preset (look = absolute, nudge = relative to `current`), then `params`. */
function nextGrade(op: GradeOp, resolved: ResolvedGrade | null, current: Record<string, unknown> | undefined): { params: GradeParams; look: string } {
	let params = readGradeParams(current);
	let look = typeof current?.look === "string" && current.look ? current.look : CUSTOM_LOOK;
	if (resolved?.kind === "look") {
		params = lookParams(resolved.look);
		look = resolved.look.id;
	} else if (resolved?.kind === "nudge") {
		params = applyGradeNudge(params, resolved.nudge);
	}
	if (op.params) params = clampGradeParams({ ...params, ...op.params });
	return { params, look };
}

/** Grade (or un-grade) one clip through its `effects` list. Returns false when nothing changed. */
function gradeElement(ctx: Ctx, track: TimelineTrack, element: TimelineElement, op: GradeOp, resolved: ResolvedGrade | null): boolean {
	if (element.type === "effect") {
		// a grade adjustment layer selected directly: its params are the grade
		if (element.effectType !== GRADE_EFFECT_TYPE) fail("incompatible", `effect element ${element.id} is ${element.effectType}, not a grade`, element.id);
		if (resolved?.kind === "none") {
			removeElement(ctx, track, element.id);
			(ctx.change.removed ??= {}).elements = [...(ctx.change.removed?.elements ?? []), element.id];
			return true;
		}
		const { params, look } = nextGrade(op, resolved, element.params);
		replaceElement(ctx, track, touch(ctx, { ...element, params: gradeEffectParams(params, look) }));
		addUpdated(ctx, element.id);
		return true;
	}
	if (!GRADEABLE_TYPES.includes(element.type)) fail("incompatible", `${element.type} elements have no picture to grade`, element.id);
	const effects = [...((element as WithEffects).effects ?? [])];
	const index = effects.findIndex((effect) => effect.type === GRADE_EFFECT_TYPE);
	if (resolved?.kind === "none") {
		if (index < 0) return false;
		effects.splice(index, 1);
	} else {
		const { params, look } = nextGrade(op, resolved, index >= 0 ? effects[index].params : undefined);
		const effectParams = gradeEffectParams(params, look);
		if (index >= 0) effects[index] = { ...effects[index], params: effectParams, enabled: true };
		// last in the chain: a grade colours what the other effects made
		else effects.push({ id: ctx.ids.next("effect"), type: GRADE_EFFECT_TYPE, params: effectParams, enabled: true });
	}
	replaceElement(ctx, track, touch(ctx, { ...element, effects } as TimelineElement));
	addUpdated(ctx, element.id);
	return true;
}

/** Overlay index for a new GRADE track: just above the topmost footage track (not text, not a MOTION/composition track). */
function gradeTrackIndex(tracks: Scene["tracks"]): number {
	const footage = tracks.overlay.findIndex(
		(track) => track.type === "video" && !track.name.toUpperCase().startsWith("MOTION") && !isGradeTrack(track),
	);
	return footage >= 0 ? footage : tracks.overlay.length;
}

function gradeTimeline(ctx: Ctx, op: GradeOp, resolved: ResolvedGrade | null): void {
	const tracks = ctx.scene.tracks;
	const gradeTracks = tracks.overlay.filter(isGradeTrack);
	let track: EffectTrack | undefined = gradeTracks[0];
	const existing = track?.elements.find((element) => element.effectType === GRADE_EFFECT_TYPE);
	if (resolved?.kind === "none") {
		if (!existing || !track) return noop(ctx, "no timeline grade to remove");
		const gone = track.elements.filter((element) => element.effectType === GRADE_EFFECT_TYPE).map((element) => element.id);
		setElements(ctx, track, track.elements.filter((element) => element.effectType !== GRADE_EFFECT_TYPE));
		const removed = (ctx.change.removed ??= {});
		removed.elements = gone;
		if (!track.elements.length && track.restorff?.role === "grade") {
			const id = track.id;
			setGroups(ctx, tracks.overlay.filter((candidate) => candidate.id !== id), tracks.audio);
			removed.tracks = [id];
		}
		ctx.change.summary = "timeline grade removed";
		return;
	}
	// the grade layer spans everything except itself
	let end = 0;
	for (const candidate of orderedTracks(tracks)) {
		if (isGradeTrack(candidate as TimelineTrack)) continue;
		for (const element of candidate.elements) end = Math.max(end, endOf(element));
	}
	if (end <= 0) return noop(ctx, "the timeline is empty: nothing to grade yet");
	const { params, look } = nextGrade(op, resolved, existing?.params);
	const effectParams = gradeEffectParams(params, look);
	const label = gradeLabel(effectParams);
	if (!track) {
		track = createTrack(ctx, "effect", { name: GRADE_TRACK_NAME, role: "grade", groupIndex: gradeTrackIndex(tracks) }) as EffectTrack;
	}
	const graded: EffectElement = existing
		? { ...existing, startTime: 0, duration: end, params: effectParams, name: `Grade · ${label}` }
		: {
				id: ctx.ids.next("element"),
				name: `Grade · ${label}`,
				type: "effect",
				effectType: GRADE_EFFECT_TYPE,
				startTime: 0,
				duration: end,
				trimStart: 0,
				trimEnd: 0,
				params: effectParams,
				restorff: { createdBy: ctx.author },
			};
	assertNoOverlap(ctx, track, 0, end, graded.id);
	touch(ctx, graded);
	if (existing) {
		replaceElement(ctx, track, graded);
		addUpdated(ctx, graded.id);
	} else {
		appendElement(ctx, track, graded);
		addCreated(ctx, "elements", graded.id);
	}
	ctx.change.summary = `timeline grade: ${label} (${GRADE_TRACK_NAME} layer, 0–${end} ticks)`;
	ctx.change.details = { look, params, track: track.id };
}

function opGrade(ctx: Ctx, op: GradeOp): void {
	const resolved = op.preset !== undefined ? resolveGradeName(op.preset) : null;
	if (op.preset !== undefined && !resolved) {
		return pending(
			ctx,
			`no grade look or nudge called "${op.preset}" (looks: ${GRADE_LOOKS.map((look) => look.id).join(", ")}; nudges: ` +
				`${GRADE_NUDGES.map((nudge) => nudge.id).join(", ")}); kept for a later editor build to honour`,
			"editor",
			`grade "${op.preset}" on ${op.target} recorded, not applied`,
		);
	}
	if (op.preset === undefined && op.params === undefined) {
		// a LUT alone: no LUT loader in the editor yet
		if (!TIMELINE_TARGETS.includes(op.target)) findElementOrTrack(ctx, op.target);
		return pending(
			ctx,
			"the editor has no LUT loader: the grade effect takes numbers (grades.ts), not a .cube file",
			"editor",
			`LUT ${op.lut} on ${op.target} recorded, not applied`,
		);
	}
	if (TIMELINE_TARGETS.includes(op.target)) return gradeTimeline(ctx, op, resolved);
	const found = findElementOrTrack(ctx, op.target);
	const what = resolved?.kind === "none" ? "grade removed" : resolved?.kind === "nudge" ? `grade ${resolved.nudge.label}` : "grade";
	if (found.element) {
		const changed = gradeElement(ctx, found.track, found.element, op, resolved);
		if (!changed) return noop(ctx, `${found.element.id} has no grade to remove`);
		const effect = ((found.track.elements.find((element) => element.id === found.element?.id) as WithEffects | undefined)?.effects ?? []).find(
			(candidate) => candidate.type === GRADE_EFFECT_TYPE,
		);
		const params = found.element.type === "effect" ? found.track.elements.find((element) => element.id === found.element?.id)?.params : effect?.params;
		ctx.change.summary = `${what} on ${found.element.id}${params ? `: ${gradeLabel(params)}` : ""}`;
		return;
	}
	const track = found.track;
	if (track.type !== "video") fail("incompatible", `grade a video track or a clip; "${track.name}" is a ${track.type} track`, op.target);
	let count = 0;
	for (const element of [...track.elements]) {
		if (element.type !== "video" && element.type !== "image") continue;
		const current = track.elements.find((candidate) => candidate.id === element.id) as TimelineElement;
		if (gradeElement(ctx, track, current, op, resolved)) count++;
	}
	if (!count) return noop(ctx, `no clip on "${track.name}" to ${resolved?.kind === "none" ? "un-grade" : "grade"}`);
	ctx.change.summary = `${what} on ${count} clip(s) of "${track.name}"`;
}

/** An element (checked first: ids are unique) or a track ("main" or an id / ref). */
function findElementOrTrack(ctx: Ctx, ref: string): { track: TimelineTrack; element?: TimelineElement } {
	if (ref !== "main") {
		const found = ctx.state.findElement(resolveId(ctx, ref));
		if (found) return { track: found.track, element: found.element };
	}
	return { track: findTrack(ctx, ref) };
}

function opMark(ctx: Ctx, op: MarkOp): void {
	const time = roundTicksToFrame(toTicks(ctx, op.t), ctx.fps); // bookmarks/utils.ts getFrameTime
	const bookmarks = ctx.scene.bookmarks ?? [];
	const index = bookmarks.findIndex((bookmark) => bookmark.time === time);
	const fields = clean({ note: op.note, color: op.color, duration: op.dur !== undefined ? toTicks(ctx, op.dur) : undefined });
	if (index >= 0) {
		bookmarks[index] = { ...bookmarks[index], ...fields };
		ctx.change.summary = `bookmark at ${time} ticks updated`;
	} else {
		bookmarks.push({ time, ...fields });
		bookmarks.sort((x, y) => x.time - y.time);
		(ctx.change.created ??= {}).bookmarks = [time];
		ctx.change.summary = `bookmark at ${time} ticks: ${op.note}`;
	}
	ctx.scene.bookmarks = bookmarks;
}

type Handler = (ctx: Ctx, op: never) => void;

const HANDLERS: Record<Exclude<OpName, "apply_style">, Handler> = {
	set_canvas: opSetCanvas,
	add_size_variant: opAddSizeVariant,
	import_media: opImportMedia,
	add_track: opAddTrack,
	remove_track: opRemoveTrack,
	reorder_tracks: opReorderTracks,
	insert: opInsert,
	move: opMove,
	trim: opTrim,
	split: opSplit,
	delete: opDelete,
	ripple_delete: opRippleDelete,
	set: opSet,
	keyframe: opKeyframe,
	add_captions: opAddCaptions,
	set_caption_style: opSetCaptionStyle,
	text_pop: opTextPop,
	transition: opTransition,
	gain: opGain,
	duck: opDuck,
	sfx: opSfx,
	normalize: opNormalize,
	grade: opGrade,
	mark: opMark,
	beats: opBeats,
	snap_cuts: opSnapCuts,
};

// ---------------------------------------------------------------- apply

function pickScene(project: Project, sceneId?: string): Scene {
	const scenes = project.scenes ?? [];
	const scene =
		(sceneId !== undefined ? scenes.find((candidate) => candidate.id === sceneId) : undefined) ??
		(sceneId === undefined ? scenes.find((candidate) => candidate.id === project.currentSceneId) : undefined) ??
		(sceneId === undefined ? scenes.find((candidate) => candidate.isMain) : undefined);
	if (!scene) throw new Error(sceneId ? `scene ${sceneId} not found` : "project has no current or main scene");
	return scene;
}

function cloneProject(project: Project): Project {
	return structuredClone(project);
}

/**
 * What an op may change in place besides track elements and track fields (those are undone by ctx.state): the
 * settings object, the pending/media lists, the bookmarks and the two track groups. O(tracks + bookmarks) per op —
 * no element is copied. (Replaces the per-op structuredClone of the whole draft.)
 */
interface Savepoint {
	hadSettings: boolean;
	settings: unknown;
	hadRestorff: boolean;
	restorff: RestorffProjectMeta | undefined;
	pendingLength?: number;
	mediaLength?: number;
	hadBookmarks: boolean;
	bookmarks: unknown;
	overlay: unknown;
	audio: unknown;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function savepoint(project: Project, scene: Scene): Savepoint {
	const metadata = project.metadata;
	const restorff = metadata.restorff;
	const bookmarks = scene.bookmarks as unknown;
	const { overlay, audio } = scene.tracks;
	return {
		hadSettings: Object.hasOwn(project, "settings"),
		settings: isPlainObject(project.settings) ? { ...project.settings } : project.settings,
		hadRestorff: Object.hasOwn(metadata, "restorff"),
		restorff,
		pendingLength: Array.isArray(restorff?.pending) ? restorff.pending.length : undefined,
		mediaLength: Array.isArray(restorff?.media) ? restorff.media.length : undefined,
		hadBookmarks: Object.hasOwn(scene, "bookmarks"),
		bookmarks: Array.isArray(bookmarks) ? bookmarks.slice() : bookmarks,
		overlay: Array.isArray(overlay) ? overlay.slice() : overlay,
		audio: Array.isArray(audio) ? audio.slice() : audio,
	};
}

function restore(project: Project, scene: Scene, saved: Savepoint): void {
	const loose = project as unknown as Record<string, unknown>;
	if (saved.hadSettings) loose.settings = saved.settings;
	else delete loose.settings;
	const metadata = project.metadata as unknown as Record<string, unknown>;
	if (saved.hadRestorff) {
		metadata.restorff = saved.restorff;
		if (saved.restorff && saved.pendingLength !== undefined) saved.restorff.pending.length = saved.pendingLength;
		if (saved.restorff && saved.mediaLength !== undefined) saved.restorff.media.length = saved.mediaLength;
	} else {
		delete metadata.restorff;
	}
	const looseScene = scene as unknown as Record<string, unknown>;
	if (saved.hadBookmarks) looseScene.bookmarks = saved.bookmarks;
	else delete looseScene.bookmarks;
	const tracks = scene.tracks as unknown as Record<string, unknown>;
	tracks.overlay = saved.overlay;
	tracks.audio = saved.audio;
}

/**
 * Apply ops@1 to a project. Never mutates `project`. See README.md for the contract and an example.
 */
export function apply(project: Project, ops: readonly Op[], options: ApplyOptions): ApplyResult {
	return applyBatch(project, ops, options, false);
}

/**
 * apply() that also checks, after every op, that the incremental state (reducer-state.ts) equals a rebuild from
 * scratch — throws if not. O(n²); for tests (test/equivalence.test.ts) only. Not exported from index.ts.
 */
export function applyWithSelfCheck(project: Project, ops: readonly Op[], options: ApplyOptions): ApplyResult {
	return applyBatch(project, ops, options, true);
}

function applyBatch(project: Project, ops: readonly Op[], options: ApplyOptions, selfCheck: boolean): ApplyResult {
	if (!options || typeof options.seed !== "string" || !options.seed) {
		throw new Error("apply(): options.seed is required (ids are derived from it)");
	}
	const mode = options.mode ?? "atomic";
	const warnings: string[] = [];
	if (project.version < OLDEST_READABLE_PROJECT_VERSION || project.version > EDITOR_PROJECT_VERSION) {
		warnings.push(`project version ${project.version}; this reducer was written against v${EDITOR_PROJECT_VERSION}`);
	}
	const changes: ApplyChanges = { ops: [], unsupported: [], refs: {}, applied: [], warnings };
	const conflicts: Conflict[] = [];

	const invalid = ops.flatMap((op, index) => validateOp(op, index));
	if (invalid.length) {
		for (const error of invalid) {
			const raw = ops[error.index] as { op?: unknown } | undefined;
			conflicts.push({
				index: String(error.index),
				op: typeof raw?.op === "string" ? (raw.op as OpName) : "?",
				kind: "invalid_op",
				message: `${error.path ? `${error.path}: ` : ""}${error.message}`,
			});
		}
		ops.forEach((op, index) => {
			changes.ops.push({
				index: String(index),
				op: (op as Op).op,
				author: (op as Op).author,
				status: invalid.some((error) => error.index === index) ? "invalid" : "skipped",
				summary: "batch rejected: invalid ops",
			});
		});
		return { project: cloneProject(project), changes, conflicts, ok: false };
	}

	// The ONE clone of the batch. An op that conflicts is undone in place (savepoint + ctx.state's undo log).
	const draft = cloneProject(project);
	const sceneId = pickScene(draft, options.sceneId).id;
	const styles = { ...BUILTIN_STYLES, ...(options.styles ?? {}) };
	let aborted = false;
	let anyChange = false;
	let state: BatchState | undefined;

	const runOne = (op: Op, index: string, allowExpand: boolean): void => {
		const change: OpChange = { index, op: op.op, author: op.author, status: "applied", summary: "" };
		changes.ops.push(change);
		if (aborted) {
			change.status = "skipped";
			change.summary = "skipped: an earlier op conflicted (atomic batch)";
			return;
		}
		if (op.op === "apply_style") {
			const expander = styles[op.preset_id];
			if (!allowExpand || !expander) {
				change.status = "conflict";
				change.summary = !allowExpand ? "apply_style cannot nest" : `unknown style preset "${op.preset_id}"`;
				conflicts.push({ index, op: op.op, kind: "unknown_preset", message: change.summary, target: op.preset_id });
				if (mode === "atomic") aborted = true;
				return;
			}
			const scene = pickScene(draft, sceneId);
			const expanded = expander({ project: structuredClone(draft), tracks: structuredClone(scene.tracks), op: op as ApplyStyleOp })
				.map((child) => ({ ...child, author: "preset" as const, note: child.note ?? `via ${op.preset_id}` }));
			const childErrors = expanded.flatMap((child, i) => validateOp(child, i));
			if (childErrors.length) {
				change.status = "conflict";
				change.summary = `style preset "${op.preset_id}" expanded to invalid ops`;
				conflicts.push({
					index,
					op: op.op,
					kind: "invalid_op",
					message: childErrors.map((e) => `${index}.${e.index + 1} ${e.path}: ${e.message}`).join("; "),
				});
				if (mode === "atomic") aborted = true;
				return;
			}
			change.summary = `style "${op.preset_id}" expanded to ${expanded.length} op(s)`;
			change.details = { expanded: expanded.map((child) => child.op) };
			expanded.forEach((child, i) => runOne(child, `${index}.${i + 1}`, false));
			return;
		}
		const scene = pickScene(draft, sceneId);
		const media = () => draft.metadata.restorff?.media;
		// Built where the old reducer ran its first full invariant check: a malformed project throws in the same place.
		state ??= new BatchState(draft, scene, media());
		const batch = state;
		const saved = savepoint(draft, scene);
		batch.begin();
		const ctx: Ctx = {
			project: draft,
			scene,
			refs: changes.refs,
			ids: createIdSource(options.seed, index),
			index,
			author: op.author,
			fps: draft.settings.fps,
			snap: options.snap ?? "none",
			change,
			unsupported: [],
			styles,
			opRaw: op,
			state: batch,
			newRefs: [],
		};
		try {
			(HANDLERS[op.op] as (ctx: Ctx, op: Op) => void)(ctx, op);
			// = checkInvariants(after) minus the problems the scene had before this op, in the same order
			const introduced = batch.check(media());
			if (introduced.length) fail("invariant", introduced.join("; "));
			batch.commit(media());
			if (selfCheck) batch.verify(media());
			changes.unsupported.push(...ctx.unsupported);
			changes.applied.push(op);
			if (change.status === "applied") anyChange = true;
			if (change.status === "pending") anyChange = true;
		} catch (error) {
			if (!isFail(error)) throw error;
			batch.rollback();
			restore(draft, scene, saved);
			if (selfCheck) batch.verify(media());
			for (const key of ctx.newRefs) delete changes.refs[key];
			change.status = "conflict";
			change.summary = error.message;
			delete change.created;
			delete change.updated;
			delete change.removed;
			conflicts.push({ index, op: op.op, kind: error.kind, message: error.message, target: error.target });
			if (mode === "atomic") aborted = true;
		}
	};

	ops.forEach((op, index) => runOne(op, String(index), true));

	if (mode === "atomic" && conflicts.length) {
		for (const change of changes.ops) {
			if (change.status === "applied" || change.status === "noop" || change.status === "pending") {
				change.status = "rolled_back";
			}
		}
		changes.applied = [];
		changes.unsupported = [];
		changes.refs = {};
		return { project: cloneProject(project), changes, conflicts, ok: false };
	}

	if (anyChange) {
		const main = draft.scenes.find((scene) => scene.isMain) ?? draft.scenes[0];
		if (main) draft.metadata.duration = totalDuration(main.tracks);
		if (options.at) {
			draft.metadata.updatedAt = options.at;
			const scene = pickScene(draft, sceneId);
			scene.updatedAt = options.at;
		}
	}
	return { project: draft, changes, conflicts, ok: conflicts.length === 0 };
}

/** Convenience for callers holding seconds: the tick value an op time will become. */
export function opTimeToTicks(seconds: number, fps?: FrameRate, snap: "none" | "frame" = "none"): Ticks {
	const ticks = secondsToTicks(seconds);
	return snap === "frame" && fps ? roundTicksToFrame(ticks, fps) : ticks;
}
