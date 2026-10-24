/**
 * Track/element helpers and the invariant checker. Mirrors apps/web/src/timeline/{placement,element-utils,index}.ts.
 */
import { allKeyTimes } from "./animation.ts";
import type {
	ElementType,
	MediaManifestEntry,
	RetimeConfig,
	Scene,
	SceneTracks,
	Ticks,
	TimelineElement,
	TimelineTrack,
	TrackType,
} from "./model.ts";

/** Display order top → bottom: overlays, main, audio (placement/resolve.ts:138). */
export function orderedTracks(tracks: SceneTracks): TimelineTrack[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

/** placement/compatibility.ts:3 ELEMENT_TRACK_MAP */
const ELEMENT_TRACK: Record<ElementType, TrackType> = {
	audio: "audio",
	text: "text",
	sticker: "graphic",
	graphic: "graphic",
	effect: "effect",
	video: "video",
	image: "video",
};

export function trackTypeForElement(type: ElementType): TrackType {
	return ELEMENT_TRACK[type];
}

export function canElementGoOnTrack(type: ElementType, trackType: TrackType): boolean {
	return ELEMENT_TRACK[type] === trackType;
}

/**
 * timeline/tracks.ts DEFAULT_TRACK_NAMES — RestorffCut's artboard names (the skin agent renamed them on 2026-10-20;
 * the upstream names were "Video track", "Text track"…).
 */
export const DEFAULT_TRACK_NAMES: Record<TrackType, string> = {
	video: "V2 B-ROLL",
	text: "TEXT",
	audio: "MUSIC",
	graphic: "GRAPHICS",
	effect: "EFFECTS",
};

/** timeline/tracks.ts CAPTIONS_TRACK_NAME (subtitles/insert.ts names caption tracks with it). */
export const CAPTIONS_TRACK_NAME = "CAPTIONS";

/** timeline/tracks.ts getDefaultTrackName: V2 B-ROLL, V3, V4…; MUSIC, SFX, AUDIO 3…; TEXT, TEXT 2… */
export function defaultTrackName(tracks: SceneTracks, type: TrackType): string {
	const existing =
		type === "audio" ? tracks.audio.length : tracks.overlay.filter((track) => track.type === type).length;
	switch (type) {
		case "video":
			return existing === 0 ? DEFAULT_TRACK_NAMES.video : `V${existing + 2}`;
		case "audio":
			if (existing === 0) return "MUSIC";
			if (existing === 1) return "SFX";
			return `AUDIO ${existing + 1}`;
		default:
			return existing === 0 ? DEFAULT_TRACK_NAMES[type] : `${DEFAULT_TRACK_NAMES[type]} ${existing + 1}`;
	}
}

/** placement/track-factory.ts buildEmptyTrack */
export function buildEmptyTrack(id: string, type: TrackType, name?: string): TimelineTrack {
	const trackName = name ?? DEFAULT_TRACK_NAMES[type];
	switch (type) {
		case "video":
			return { id, name: trackName, type: "video", elements: [], hidden: false, muted: false };
		case "text":
			return { id, name: trackName, type: "text", elements: [], hidden: false };
		case "graphic":
			return { id, name: trackName, type: "graphic", elements: [], hidden: false };
		case "audio":
			return { id, name: trackName, type: "audio", elements: [], muted: false };
		case "effect":
			return { id, name: trackName, type: "effect", elements: [], hidden: false };
	}
}

export function endOf(element: { startTime: Ticks; duration: Ticks }): Ticks {
	return element.startTime + element.duration;
}

/** placement/overlap.ts wouldElementOverlap (half-open intervals: touching is fine). */
export function overlapsAny(
	elements: readonly TimelineElement[],
	startTime: Ticks,
	endTime: Ticks,
	excludeId?: string,
): TimelineElement | null {
	for (const element of elements) {
		if (excludeId && element.id === excludeId) continue;
		if (startTime < endOf(element) && endTime > element.startTime) return element;
	}
	return null;
}

/** timeline/index.ts calculateTotalDuration */
export function totalDuration(tracks: SceneTracks): Ticks {
	let max = 0;
	for (const track of orderedTracks(tracks)) {
		for (const element of track.elements) max = Math.max(max, endOf(element));
	}
	return max;
}

/** retime/rate.ts clampRetimeRate */
export function clampRetimeRate(rate: number): number {
	if (!Number.isFinite(rate) || rate <= 0) return 1;
	return Math.min(Math.max(rate, 0.01), 5);
}

export function retimeOf(element: TimelineElement): RetimeConfig | undefined {
	return element.type === "video" || element.type === "audio" ? element.retime : undefined;
}

export function rateOf(element: TimelineElement): number {
	return clampRetimeRate(retimeOf(element)?.rate ?? 1);
}

/** The element's source length: its own sourceDuration, else the manifest's media duration. */
export function knownSourceDuration(
	element: TimelineElement,
	media: readonly MediaManifestEntry[],
): Ticks | undefined {
	if (typeof element.sourceDuration === "number") return element.sourceDuration;
	if ("mediaId" in element) {
		const entry = media.find((candidate) => candidate.id === element.mediaId);
		if (entry?.duration !== undefined && entry.kind !== "image") return entry.duration;
	}
	return undefined;
}

/** The invariant messages that name more than one thing (kept in one place for checkInvariants and the reducer). */
export const duplicateTrackProblem = (trackId: string) => `track ${trackId}: duplicate track id`;
export const duplicateElementProblem = (elementId: string) => `element ${elementId}: duplicate element id`;
export const overlapProblem = (trackId: string, elementId: string, nextId: string) =>
	`track ${trackId}: ${elementId} overlaps ${nextId}`;

/** The scene-level problems at the head of checkInvariants' list: the main track and the group/type pairing. */
export function groupProblems(tracks: SceneTracks): string[] {
	const problems: string[] = [];
	if (!tracks?.main || tracks.main.type !== "video") problems.push("main track missing or not a video track");
	// Arriving JSON is untyped: check the group/type pairing at runtime.
	for (const track of tracks.overlay as TimelineTrack[]) {
		if (track.type === "audio") problems.push(`track ${track.id}: audio track in the overlay group`);
	}
	for (const track of tracks.audio as TimelineTrack[]) {
		if (track.type !== "audio") problems.push(`track ${track.id}: ${track.type} track in the audio group`);
	}
	return problems;
}

/**
 * The problems of ONE element on a track of `trackType`, in checkInvariants' order — everything except the two that
 * need its neighbours (duplicate id, overlap). A pure function of (element, trackType, media): the reducer caches it
 * per element object, which is safe because the reducer never mutates a placed element (it replaces it).
 */
export function elementProblems(
	element: TimelineElement,
	trackType: TrackType,
	media: readonly MediaManifestEntry[],
): string[] {
	const problems: string[] = [];
	// the label is built only when there is something to report (this runs for every element the reducer touches)
	const add = (message: string) => problems.push(`element ${element.id}: ${message}`);
	if (!canElementGoOnTrack(element.type, trackType)) add(`${element.type} element on a ${trackType} track`);
	for (const field of ["startTime", "duration", "trimStart", "trimEnd"] as const) {
		if (!Number.isInteger(element[field])) add(`${field} is not an integer tick count`);
	}
	if (!(element.duration > 0)) add("duration must be > 0");
	if (element.startTime < 0) add("startTime < 0");
	if (element.trimStart < 0) add("trimStart < 0");
	if (element.trimEnd < 0) add("trimEnd < 0");
	const sourceDuration = knownSourceDuration(element, media);
	if (sourceDuration !== undefined) {
		const span = Math.round(element.duration * rateOf(element));
		if (element.trimStart + span > sourceDuration + 1) {
			add(`trimmed past the media length (${element.trimStart + span} > ${sourceDuration} ticks)`);
		}
	}
	if (element.animations) {
		for (const time of allKeyTimes(element.animations)) {
			if (!Number.isInteger(time) || time < 0 || time > element.duration) {
				add(`keyframe at ${time} outside [0, ${element.duration}]`);
			}
		}
	}
	// v32: a transition's length is a positive whole number of ticks.
	const transition = (element as { transitionIn?: { duration?: unknown } }).transitionIn;
	if (transition && !(Number.isInteger(transition.duration) && (transition.duration as number) > 0)) {
		add("transitionIn duration must be a positive integer tick count");
	}
	return problems;
}

/** A track's elements in checkInvariants' order: a stable sort by startTime. */
export function sortedByStart(elements: readonly TimelineElement[]): TimelineElement[] {
	return [...elements].sort((a, b) => a.startTime - b.startTime);
}

/** The overlap problems of one track: each element against the next one in sortedByStart order. */
export function trackOverlapProblems(trackId: string, sorted: readonly TimelineElement[]): string[] {
	const problems: string[] = [];
	for (let i = 0; i + 1 < sorted.length; i++) {
		if (sorted[i + 1].startTime < endOf(sorted[i])) problems.push(overlapProblem(trackId, sorted[i].id, sorted[i + 1].id));
	}
	return problems;
}

/**
 * Every invariant the reducer guarantees, as human-readable strings (empty = clean). The reducer rejects an op that
 * introduces a new violation, so a project that arrives with old problems can still be edited. (Since 2026-10-20 the
 * reducer keeps this list's multiset up to date incrementally — see reducer-state.ts — and calls this full check
 * only once per batch and to word a conflict; the order of this list is what a conflict message shows.)
 */
export function checkInvariants(scene: Scene, media: readonly MediaManifestEntry[]): string[] {
	const tracks = scene.tracks;
	const problems = groupProblems(tracks);
	const trackIds = new Set<string>();
	const elementIds = new Set<string>();
	for (const track of orderedTracks(tracks)) {
		if (trackIds.has(track.id)) problems.push(duplicateTrackProblem(track.id));
		trackIds.add(track.id);
		const sorted = sortedByStart(track.elements);
		for (let i = 0; i < sorted.length; i++) {
			const element = sorted[i];
			if (elementIds.has(element.id)) problems.push(duplicateElementProblem(element.id));
			elementIds.add(element.id);
			for (const problem of elementProblems(element, track.type, media)) problems.push(problem);
			const next = sorted[i + 1];
			if (next && next.startTime < endOf(element)) {
				problems.push(overlapProblem(track.id, element.id, next.id));
			}
		}
	}
	return problems;
}
