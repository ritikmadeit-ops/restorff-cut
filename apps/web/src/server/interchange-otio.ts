/**
 * Snapshot ↔ OpenTimelineIO JSON (`.otio`), written by hand from the OTIO schema docs (opentimelineio.readthedocs.io,
 * "Schema reference"; OTIO 0.15+ object versions: Timeline.1, Stack.1, Track.1, Clip.2, Gap.1, Transition.1,
 * ExternalReference.1, GeneratorReference.1, Marker.2, Effect.1, LinearTimeWarp.1, RationalTime.1, TimeRange.1).
 * No dependencies, no I/O.
 *
 *   toOtio(input)          snapshot → Timeline.1 (+ a summary and what it could not say)
 *   validateOtio(value)    shape check against the schema (strict for our own output, lenient for files from elsewhere)
 *   readOtio(value, fps)   any OTIO timeline → per-track clip cut points in the project's frames (for import_cuts)
 *
 * Layout: the Stack holds video tracks bottom → top (V1 A-ROLL first, so later tracks composite on top, as OTIO reads
 * them), then audio tracks (audio 0 = A1). Times are RationalTimes at the project rate in whole frames. Each clip and
 * track carries `metadata.restorffcut` (element / track / media ids and the exact ticks) so a re-import into
 * RestorffCut is tick-exact; other editors ignore it.
 */
import {
	baseSummary,
	type ExportSummary,
	flattenSnapshot,
	type FrameRate,
	fpsValue,
	type IClip,
	type IMarker,
	type InterchangeInput,
	INTERCHANGE_VERSION,
	type ITrack,
	TICKS_PER_SECOND,
	ticksPerFrame,
	toFrames,
	type TrackSummary,
} from "./interchange-timeline";

export const OTIO_VERSION = "Timeline.1 (OpenTimelineIO 0.15+ JSON)";

type Json = Record<string, unknown>;

const rt = (value: number, rate: number): Json => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
const range = (start: number, duration: number, rate: number): Json => ({ OTIO_SCHEMA: "TimeRange.1", duration: rt(duration, rate), start_time: rt(start, rate) });

const DISSOLVES = new Set(["dissolve", "blur", "dip-black", "dip-white"]);

const MARKER_COLORS: Record<string, string> = { must: "RED", should: "ORANGE", could: "YELLOW", info: "CYAN" };

function markerJson(marker: IMarker, rate: number): Json {
	const color = marker.kind === "bookmark" ? "PURPLE" : marker.resolved ? "GREEN" : (MARKER_COLORS[marker.severity ?? ""] ?? "BLUE");
	return {
		OTIO_SCHEMA: "Marker.2",
		metadata: { restorffcut: { kind: marker.kind, ...(marker.severity ? { severity: marker.severity } : {}), ...(marker.resolved ? { resolved: true } : {}) } },
		name: marker.name,
		color,
		marked_range: range(marker.start, marker.dur, rate),
		comment: marker.note,
	};
}

export function toOtio(input: InterchangeInput): { otio: Json; text: string; summary: ExportSummary } {
	const timeline = flattenSnapshot(input);
	const notes = timeline.notes.clone();
	const rate = fpsValue(timeline.fps);
	const counts = { tracks: 0, clips: 0, titles: 0, audio: 0, generators: 0, gaps: 0, transitions: 0, markers: 0 };
	const trackSummaries: TrackSummary[] = [];

	const gap = (duration: number): Json => {
		counts.gaps += 1;
		return { OTIO_SCHEMA: "Gap.1", metadata: {}, name: "", source_range: range(0, duration, rate), effects: [], markers: [], enabled: true };
	};

	function clipJson(clip: IClip, track: ITrack): Json | null {
		const duration = clip.end - clip.start;
		const effects: Json[] = [];
		if (clip.rate !== 1) effects.push({ OTIO_SCHEMA: "LinearTimeWarp.1", metadata: {}, name: "retime", effect_name: "LinearTimeWarp", time_scalar: clip.rate });
		for (const effect of clip.effects) {
			effects.push({ OTIO_SCHEMA: "Effect.1", metadata: { restorffcut: { type: effect } }, name: effect, effect_name: effect });
			notes.add(`otio-effect-${effect}`, `${effect} effect`, "OTIO: named as an Effect (other editors ignore its settings)", clip.id);
		}
		if (clip.volumeDb !== undefined) notes.add("otio-volume", "clip volume (dB)", "OTIO: kept in metadata only (restorffcut.volume_db)", clip.id);
		if (clip.scale) notes.add("otio-scale", "clip scale", "OTIO: kept in metadata only (restorffcut.scale)", clip.id);
		let reference: Json;
		if (clip.kind === "video" || clip.kind === "image" || clip.kind === "audio") {
			const info = clip.media;
			if (!info) {
				notes.add("no-media", "clip without a media file", "not exported", clip.id);
				return null;
			}
			const available = info.durationTicks ? Math.floor(info.durationTicks / timeline.tpf) : 0;
			reference = {
				OTIO_SCHEMA: "ExternalReference.1",
				metadata: { restorffcut: { media_id: info.id, file_name: info.fileName, kind: info.kind } },
				name: info.name,
				available_range: info.kind === "image" || !available ? null : range(0, available, rate),
				available_image_bounds: null,
				target_url: info.url,
			};
			if (clip.kind === "audio") counts.audio += 1;
			else counts.clips += 1;
		} else if (clip.kind === "text") {
			const style = clip.style;
			reference = {
				OTIO_SCHEMA: "GeneratorReference.1",
				metadata: {},
				name: "Text",
				available_range: null,
				available_image_bounds: null,
				generator_kind: "Text",
				parameters: {
					text: clip.text ?? "",
					...(style
						? { font: style.font, size_px: style.sizePx, color_rgba: style.color, bold: style.bold, italic: style.italic, align: style.align, x_px: style.x, y_px: style.y }
						: {}),
				},
			};
			counts.titles += 1;
		} else if (clip.kind === "graphic" || clip.kind === "sticker") {
			reference = {
				OTIO_SCHEMA: "GeneratorReference.1",
				metadata: {},
				name: clip.generator ?? clip.kind,
				available_range: null,
				available_image_bounds: null,
				generator_kind: `restorffcut.${clip.kind}`,
				parameters: { id: clip.generator ?? clip.kind },
			};
			counts.generators += 1;
			notes.add(`otio-${clip.kind}`, `${clip.kind} element`, "OTIO: a generator placeholder with its timing (other editors show it offline)", clip.id);
		} else {
			return null;
		}
		return {
			OTIO_SCHEMA: "Clip.2",
			metadata: {
				restorffcut: {
					element_id: clip.id,
					type: clip.kind,
					track_id: track.id,
					...(clip.mediaId ? { media_id: clip.mediaId } : {}),
					ticks: clip.ticks,
					...(clip.rate !== 1 ? { rate: clip.rate } : {}),
					...(clip.volumeDb !== undefined ? { volume_db: clip.volumeDb } : {}),
					...(clip.scale ? { scale: clip.scale } : {}),
					...(clip.composition ? { composition: clip.composition } : {}),
					...(clip.author ? { author: clip.author } : {}),
				},
			},
			name: clip.name,
			source_range: range(clip.kind === "video" || clip.kind === "audio" ? clip.inF : 0, duration, rate),
			effects,
			markers: [],
			enabled: clip.enabled,
			media_references: { DEFAULT_MEDIA: reference },
			active_media_reference_key: "DEFAULT_MEDIA",
		};
	}

	function trackJson(track: ITrack): Json | null {
		if (track.type === "effect") {
			for (const clip of track.clips) notes.add(`layer-${clip.generator}`, `${clip.generator} adjustment layer (track ${track.name})`, "not exported: re-create it in the other editor", clip.id);
			trackSummaries.push({ name: track.name, kind: "effect layer", clips: track.clips.length, exported: false });
			return null;
		}
		const children: Json[] = [];
		let cursor = 0;
		let exported = 0;
		for (const clip of track.clips) {
			const json = clipJson(clip, track);
			if (!json) continue;
			if (clip.start > cursor) children.push(gap(clip.start - cursor));
			if (clip.transitionIn) {
				const previous = children[children.length - 1];
				const previousDuration = previous ? (((previous.source_range as Json).duration as Json).value as number) : 0;
				const frames = Math.min(clip.transitionIn.frames, clip.end - clip.start + previousDuration);
				const before = Math.min(Math.floor(frames / 2), previousDuration);
				const after = Math.min(frames - Math.floor(frames / 2), clip.end - clip.start);
				if (!previous || before < 1) {
					notes.add("transition-at-start", "transition into the first clip of a track", "not exported (nothing before it to transition from)", clip.id);
				} else {
					counts.transitions += 1;
					children.push({
						OTIO_SCHEMA: "Transition.1",
						metadata: { restorffcut: { type: clip.transitionIn.type, frames: clip.transitionIn.frames } },
						name: clip.transitionIn.type,
						transition_type: DISSOLVES.has(clip.transitionIn.type) ? "SMPTE_Dissolve" : "Custom_Transition",
						in_offset: rt(before, rate),
						out_offset: rt(after, rate),
					});
				}
			}
			children.push(json);
			cursor = clip.end;
			exported += 1;
		}
		counts.tracks += 1;
		const kind = track.type === "audio" ? "Audio" : "Video";
		trackSummaries.push({ name: track.name, kind: `${kind} (${track.type})`, clips: exported, exported: true });
		return {
			OTIO_SCHEMA: "Track.1",
			metadata: {
				restorffcut: {
					track_id: track.id,
					group: track.group,
					type: track.type,
					...(track.role ? { role: track.role } : {}),
					hidden: track.hidden,
					muted: track.muted,
					// what this track held at export: import_cuts deletes only these when they come back missing
					element_ids: children.flatMap((child) => {
						const id = ((child.metadata as Json | undefined)?.restorffcut as Json | undefined)?.element_id;
						return typeof id === "string" ? [id] : [];
					}),
				},
			},
			name: track.name,
			source_range: null,
			effects: [],
			markers: [],
			enabled: !track.hidden && !track.muted,
			children,
			kind,
		};
	}

	const overlay = timeline.tracks.filter((track) => track.group === "overlay");
	const main = timeline.tracks.filter((track) => track.group === "main");
	const audio = timeline.tracks.filter((track) => track.group === "audio");
	const order = [...main, ...[...overlay].reverse(), ...audio];
	const stackChildren = order.map(trackJson).filter((json): json is Json => !!json);
	const markers = timeline.markers.map((marker) => markerJson(marker, rate));
	counts.markers = markers.length;

	const otio: Json = {
		OTIO_SCHEMA: "Timeline.1",
		metadata: {
			restorffcut: {
				interchange: INTERCHANGE_VERSION,
				...(timeline.timelineId ? { timeline_id: timeline.timelineId } : {}),
				...(timeline.commitId ? { commit: timeline.commitId } : {}),
				...(timeline.exportedAt ? { exported_at: timeline.exportedAt } : {}),
				fps: { numerator: timeline.fps.num, denominator: timeline.fps.den },
				ticks_per_second: TICKS_PER_SECOND,
				canvas: { width: timeline.width, height: timeline.height },
				...(timeline.loudness ? { loudness: timeline.loudness } : {}),
			},
		},
		name: timeline.name,
		global_start_time: rt(0, rate),
		tracks: {
			OTIO_SCHEMA: "Stack.1",
			metadata: {},
			name: "tracks",
			source_range: null,
			effects: [],
			markers,
			enabled: true,
			children: stackChildren,
		},
	};
	return {
		otio,
		text: `${JSON.stringify(otio, null, 4)}\n`,
		summary: { ...baseSummary(timeline, "otio", OTIO_VERSION), tracks: trackSummaries, counts, not_expressed: notes.list() },
	};
}

// ─── validation ───────────────────────────────────────────────────────────────────────────────────────────────

type Check = (value: unknown, path: string, errors: string[], strict: boolean) => void;

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

const str: Check = (value, path, errors) => {
	if (typeof value !== "string") errors.push(`${path}: expected a string`);
};
const bool: Check = (value, path, errors) => {
	if (typeof value !== "boolean") errors.push(`${path}: expected true/false`);
};
const finite: Check = (value, path, errors) => {
	if (typeof value !== "number" || !Number.isFinite(value)) errors.push(`${path}: expected a number`);
};
const dict: Check = (value, path, errors) => {
	if (!isObject(value)) errors.push(`${path}: expected an object`);
};
const nullable =
	(check: Check): Check =>
	(value, path, errors, strict) => {
		if (value !== null) check(value, path, errors, strict);
	};
const listOf =
	(check: Check): Check =>
	(value, path, errors, strict) => {
		if (!Array.isArray(value)) {
			errors.push(`${path}: expected a list`);
			return;
		}
		value.forEach((item, index) => check(item, `${path}[${index}]`, errors, strict));
	};
const anyValue: Check = () => {};

const ITEM = { name: str, metadata: dict, source_range: "range?", effects: "effects", markers: "markers", enabled: bool } as const;

/** Fields per schema; "!" = required even when lenient. Strings name the nested checks below. */
const SHAPES: Record<string, Record<string, Check | string>> = {
	"Timeline.1": { name: str, metadata: dict, global_start_time: "time?", "tracks!": "Stack.1" },
	"Stack.1": { ...ITEM, "children!": "composables" },
	"Track.1": { ...ITEM, "children!": "composables", "kind!": "kind" },
	"Clip.1": { ...ITEM, media_reference: "reference?" },
	"Clip.2": { ...ITEM, "media_references!": "references", "active_media_reference_key!": str },
	"Gap.1": { ...ITEM, "source_range!": "range" },
	"Transition.1": { name: str, metadata: dict, transition_type: str, "in_offset!": "time", "out_offset!": "time" },
	"ExternalReference.1": { name: str, metadata: dict, available_range: "range?", available_image_bounds: anyValue, "target_url!": str },
	"GeneratorReference.1": { name: str, metadata: dict, available_range: "range?", available_image_bounds: anyValue, "generator_kind!": str, parameters: dict },
	"MissingReference.1": { name: str, metadata: dict, available_range: "range?", available_image_bounds: anyValue },
	"ImageSequenceReference.1": { name: str, metadata: dict, available_range: "range?", "target_url_base!": str },
	"Marker.1": { name: str, metadata: dict, color: str, "marked_range!": "range" },
	"Marker.2": { name: str, metadata: dict, color: str, "marked_range!": "range", comment: str },
	"Effect.1": { name: str, metadata: dict, effect_name: str },
	"LinearTimeWarp.1": { name: str, metadata: dict, effect_name: str, "time_scalar!": finite },
	"FreezeFrame.1": { name: str, metadata: dict, effect_name: str, time_scalar: finite },
	"RationalTime.1": { "rate!": finite, "value!": finite },
	"TimeRange.1": { "start_time!": "time", "duration!": "time" },
};

const KIND_SCHEMAS: Record<string, string[]> = {
	composables: ["Track.1", "Stack.1", "Clip.1", "Clip.2", "Gap.1", "Transition.1"],
	reference: ["ExternalReference.1", "GeneratorReference.1", "MissingReference.1", "ImageSequenceReference.1"],
	effect: ["Effect.1", "LinearTimeWarp.1", "FreezeFrame.1"],
	marker: ["Marker.1", "Marker.2"],
};

function schemaCheck(allowed: string[]): Check {
	return (value, path, errors, strict) => checkObject(value, path, errors, strict, allowed);
}

function named(kind: string): Check {
	const optional = kind.endsWith("?");
	const base = optional ? kind.slice(0, -1) : kind;
	let check: Check;
	switch (base) {
		case "time":
			check = schemaCheck(["RationalTime.1"]);
			break;
		case "range":
			check = schemaCheck(["TimeRange.1"]);
			break;
		case "composables":
			check = listOf(schemaCheck(KIND_SCHEMAS.composables));
			break;
		case "effects":
			check = listOf(schemaCheck(KIND_SCHEMAS.effect));
			break;
		case "markers":
			check = listOf(schemaCheck(KIND_SCHEMAS.marker));
			break;
		case "reference":
			check = schemaCheck(KIND_SCHEMAS.reference);
			break;
		case "references":
			check = (value, path, errors, strict) => {
				if (!isObject(value)) {
					errors.push(`${path}: expected an object of media references`);
					return;
				}
				for (const [key, reference] of Object.entries(value)) schemaCheck(KIND_SCHEMAS.reference)(reference, `${path}.${key}`, errors, strict);
			};
			break;
		case "kind":
			check = (value, path, errors) => {
				if (value !== "Video" && value !== "Audio") errors.push(`${path}: expected "Video" or "Audio"`);
			};
			break;
		default:
			check = schemaCheck([base]);
	}
	return optional ? nullable(check) : check;
}

function checkObject(value: unknown, path: string, errors: string[], strict: boolean, allowed: string[]): void {
	if (errors.length > 50) return;
	if (!isObject(value)) {
		errors.push(`${path}: expected an OTIO object`);
		return;
	}
	const schema = value.OTIO_SCHEMA;
	if (typeof schema !== "string") {
		errors.push(`${path}: missing OTIO_SCHEMA`);
		return;
	}
	const shape = SHAPES[schema];
	if (!allowed.includes(schema)) {
		// unknown schemas are legal OTIO (plugins); only known-but-misplaced ones are errors
		if (shape || strict) errors.push(`${path}: ${schema} is not allowed here (expected ${allowed.join(" | ")})`);
		return;
	}
	for (const [rawKey, rule] of Object.entries(shape)) {
		const required = rawKey.endsWith("!");
		const key = required ? rawKey.slice(0, -1) : rawKey;
		if (!(key in value)) {
			if (required || strict) errors.push(`${path}.${key}: missing (${schema})`);
			continue;
		}
		const check = typeof rule === "string" ? named(rule) : rule;
		check(value[key], `${path}.${key}`, errors, strict);
	}
	if (schema === "RationalTime.1" && typeof value.rate === "number" && !(value.rate > 0)) errors.push(`${path}.rate: must be > 0`);
	if (schema === "TimeRange.1" && isObject(value.duration) && typeof value.duration.value === "number" && value.duration.value < 0) {
		errors.push(`${path}.duration: must not be negative`);
	}
	if (schema === "Clip.2" && isObject(value.media_references) && typeof value.active_media_reference_key === "string") {
		if (!(value.active_media_reference_key in value.media_references)) errors.push(`${path}.active_media_reference_key: names no media reference`);
	}
	if (schema === "Track.1" && Array.isArray(value.children)) checkTransitions(value.children, `${path}.children`, errors);
}

/** A transition sits between two items and fits inside both. */
function checkTransitions(children: unknown[], path: string, errors: string[]): void {
	children.forEach((child, index) => {
		if (!isObject(child) || child.OTIO_SCHEMA !== "Transition.1") return;
		const before = children[index - 1];
		const after = children[index + 1];
		const isItem = (item: unknown) => isObject(item) && item.OTIO_SCHEMA !== "Transition.1";
		if (!isItem(before) || !isItem(after)) {
			errors.push(`${path}[${index}]: a transition needs an item on both sides`);
			return;
		}
		const seconds = (time: unknown) => (isObject(time) && typeof time.value === "number" && typeof time.rate === "number" && time.rate > 0 ? time.value / time.rate : 0);
		const length = (item: unknown) => (isObject(item) ? itemSeconds(item) : 0);
		if (seconds(child.in_offset) > length(before) + 1e-9) errors.push(`${path}[${index}].in_offset: longer than the item before it`);
		if (seconds(child.out_offset) > length(after) + 1e-9) errors.push(`${path}[${index}].out_offset: longer than the item after it`);
	});
}

/** Duration of an item in seconds: its source_range, else (for compositions) what its children add up to. */
function itemSeconds(item: Json): number {
	const sourceRange = item.source_range;
	if (isObject(sourceRange) && isObject(sourceRange.duration)) {
		const { value, rate } = sourceRange.duration as { value?: number; rate?: number };
		if (typeof value === "number" && typeof rate === "number" && rate > 0) return value / rate;
	}
	const children = Array.isArray(item.children) ? (item.children as unknown[]).filter(isObject) : [];
	if (item.OTIO_SCHEMA === "Track.1") return children.filter((child) => child.OTIO_SCHEMA !== "Transition.1").reduce((sum, child) => sum + itemSeconds(child), 0);
	if (item.OTIO_SCHEMA === "Stack.1") return children.reduce((max, child) => Math.max(max, itemSeconds(child)), 0);
	const reference = isObject(item.media_references) && typeof item.active_media_reference_key === "string" ? (item.media_references as Json)[item.active_media_reference_key] : item.media_reference;
	if (isObject(reference) && isObject(reference.available_range) && isObject(reference.available_range.duration)) {
		const { value, rate } = reference.available_range.duration as { value?: number; rate?: number };
		if (typeof value === "number" && typeof rate === "number" && rate > 0) return value / rate;
	}
	return 0;
}

/** The first Timeline.1 in an OTIO document (a bare timeline, or a SerializableCollection holding one). */
export function findTimeline(value: unknown): Json | null {
	if (!isObject(value)) return null;
	if (value.OTIO_SCHEMA === "Timeline.1") return value;
	if (typeof value.OTIO_SCHEMA === "string" && value.OTIO_SCHEMA.startsWith("SerializableCollection") && Array.isArray(value.children)) {
		for (const child of value.children) {
			const found = findTimeline(child);
			if (found) return found;
		}
	}
	return null;
}

/** Errors against the OTIO schema shape; [] = valid. strict = every documented field present (our own output). */
export function validateOtio(value: unknown, { strict = false }: { strict?: boolean } = {}): string[] {
	const errors: string[] = [];
	const timeline = findTimeline(value);
	if (!timeline) return ["not an OTIO timeline: expected OTIO_SCHEMA Timeline.1 (or a SerializableCollection holding one)"];
	checkObject(timeline, "timeline", errors, strict, ["Timeline.1"]);
	return errors.slice(0, 50);
}

// ─── reading cut points ───────────────────────────────────────────────────────────────────────────────────────

export interface OtioCut {
	name: string;
	/** Project frames, [start, end). */
	start: number;
	end: number;
	/** Source in point, project frames. */
	inF: number;
	/** The same in exact ticks (from the item's own rate). */
	ticks: { start: number; end: number; in: number };
	kind: "media" | "text" | "generator" | "missing";
	enabled: boolean;
	elementId?: string;
	mediaId?: string;
	mediaUrl?: string;
	mediaName?: string;
	text?: string;
	generator?: string;
	/** What our own export recorded (exact ticks), when present. */
	exported?: { start: number; duration: number; trimStart: number };
}

export interface OtioTrackCuts {
	/** Position in the stack. */
	index: number;
	name: string;
	kind: "Video" | "Audio";
	trackId?: string;
	/** Element ids our export put on this track (absent in OTIO from elsewhere, or if the other editor dropped it). */
	exportedIds?: string[];
	cuts: OtioCut[];
}

export interface OtioCutList {
	name: string;
	timelineId?: string;
	commit?: string;
	tracks: OtioTrackCuts[];
	warnings: string[];
}

const toTicks = (time: unknown): number => {
	if (!isObject(time)) return 0;
	const value = typeof time.value === "number" ? time.value : 0;
	const rate = typeof time.rate === "number" && time.rate > 0 ? time.rate : 1;
	return Math.round((value / rate) * TICKS_PER_SECOND);
};

const metaOf = (item: Json): Json => (isObject(item.metadata) && isObject(item.metadata.restorffcut) ? (item.metadata.restorffcut as Json) : {});

/** Media id from one of this server's media URLs (`…/media/<id>`), else undefined. */
export function mediaIdFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const match = /\/api\/projects\/[^/]+\/media\/([^/?#]+)/.exec(url);
	return match ? decodeURIComponent(match[1]) : undefined;
}

/** Every track's clips with their cut points in the project's frames. Gaps and transitions only move the cursor. */
export function readOtio(value: unknown, fps: FrameRate): OtioCutList {
	const timeline = findTimeline(value);
	if (!timeline) throw new Error("not an OTIO timeline: expected OTIO_SCHEMA Timeline.1");
	const tpf = ticksPerFrame(fps);
	const frames = (ticks: number) => toFrames(ticks, tpf);
	const warnings: string[] = [];
	const meta = metaOf(timeline);
	const stack = isObject(timeline.tracks) ? timeline.tracks : null;
	const children = stack && Array.isArray(stack.children) ? (stack.children as unknown[]) : [];
	if (stack && isObject(stack.source_range)) warnings.push("the stack has a source_range (a trimmed timeline): ignored, cut points are read from 0");
	const globalStart = toTicks(timeline.global_start_time);
	if (globalStart) warnings.push(`global_start_time is ${globalStart / TICKS_PER_SECOND} s: cut points are read relative to it`);

	const tracks: OtioTrackCuts[] = [];
	children.forEach((child, index) => {
		if (!isObject(child)) return;
		if (child.OTIO_SCHEMA !== "Track.1") {
			warnings.push(`stack item ${index} is ${String(child.OTIO_SCHEMA)}, not a track: skipped`);
			return;
		}
		const trackMeta = metaOf(child);
		const out: OtioTrackCuts = {
			index,
			name: typeof child.name === "string" ? child.name : `Track ${index + 1}`,
			kind: child.kind === "Audio" ? "Audio" : "Video",
			...(typeof trackMeta.track_id === "string" ? { trackId: trackMeta.track_id } : {}),
			...(Array.isArray(trackMeta.element_ids) ? { exportedIds: trackMeta.element_ids.filter((id): id is string => typeof id === "string") } : {}),
			cuts: [],
		};
		let cursor = 0;
		for (const item of Array.isArray(child.children) ? (child.children as unknown[]) : []) {
			if (!isObject(item)) continue;
			const schema = String(item.OTIO_SCHEMA ?? "");
			if (schema.startsWith("Transition")) continue;
			const length = Math.round(itemSeconds(item) * TICKS_PER_SECOND);
			if (schema.startsWith("Clip")) {
				const clipMeta = metaOf(item);
				const sourceRange = isObject(item.source_range) ? item.source_range : null;
				const inTicks = sourceRange ? toTicks(sourceRange.start_time) : 0;
				const reference = isObject(item.media_references) && typeof item.active_media_reference_key === "string" ? (item.media_references as Json)[item.active_media_reference_key] : item.media_reference;
				const ref = isObject(reference) ? reference : {};
				const refSchema = String(ref.OTIO_SCHEMA ?? "");
				const refMeta = metaOf(ref);
				const url = typeof ref.target_url === "string" ? ref.target_url : undefined;
				const parameters = isObject(ref.parameters) ? ref.parameters : {};
				const kind: OtioCut["kind"] = refSchema.startsWith("ExternalReference")
					? "media"
					: refSchema.startsWith("GeneratorReference")
						? ref.generator_kind === "Text" || typeof parameters.text === "string"
							? "text"
							: "generator"
						: "missing";
				const ticks = clipMeta.ticks as { start?: number; duration?: number; trimStart?: number } | undefined;
				out.cuts.push({
					name: typeof item.name === "string" ? item.name : "",
					start: frames(cursor),
					end: Math.max(frames(cursor) + 1, frames(cursor + length)),
					inF: frames(inTicks),
					ticks: { start: cursor, end: cursor + length, in: inTicks },
					kind,
					enabled: item.enabled !== false,
					...(typeof clipMeta.element_id === "string" ? { elementId: clipMeta.element_id } : {}),
					...((typeof clipMeta.media_id === "string" ? clipMeta.media_id : typeof refMeta.media_id === "string" ? refMeta.media_id : mediaIdFromUrl(url))
						? { mediaId: (typeof clipMeta.media_id === "string" ? clipMeta.media_id : typeof refMeta.media_id === "string" ? refMeta.media_id : mediaIdFromUrl(url)) as string }
						: {}),
					...(url ? { mediaUrl: url } : {}),
					...(typeof ref.name === "string" && ref.name ? { mediaName: ref.name } : {}),
					...(kind === "text" && typeof parameters.text === "string" ? { text: parameters.text } : {}),
					...(kind === "generator" ? { generator: String(parameters.id ?? ref.generator_kind ?? "") } : {}),
					...(ticks && typeof ticks.start === "number" && typeof ticks.duration === "number"
						? { exported: { start: ticks.start, duration: ticks.duration, trimStart: typeof ticks.trimStart === "number" ? ticks.trimStart : 0 } }
						: {}),
				});
			} else if (schema.startsWith("Stack") || schema.startsWith("Track")) {
				warnings.push(`track "${out.name}": a nested ${schema} (compound clip) at ${(cursor / TICKS_PER_SECOND).toFixed(3)} s is not read`);
			}
			cursor += length;
		}
		tracks.push(out);
	});
	return {
		name: typeof timeline.name === "string" ? timeline.name : "",
		...(typeof meta.timeline_id === "string" ? { timelineId: meta.timeline_id } : {}),
		...(typeof meta.commit === "string" ? { commit: meta.commit } : {}),
		tracks,
		warnings,
	};
}
