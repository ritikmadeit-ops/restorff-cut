/**
 * FROZEN REFERENCE — src/scene.ts exactly as it was at commit f1cfb487 (import paths changed only). Used by
 * test/reference/reducer-v0.ts and by test/equivalence.test.ts to prove the split-up checkInvariants in src/scene.ts
 * still returns the same list. Do not edit.
 *
 * Track/element helpers and the invariant checker. Mirrors apps/web/src/timeline/{placement,element-utils,index}.ts.
 */
import { allKeyTimes } from "../../src/animation.ts";
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
} from "../../src/model.ts";

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

/**
 * Every invariant the reducer guarantees, as human-readable strings (empty = clean). The reducer compares the set
 * before and after each op and rejects the op if it introduced a new violation, so a project that arrives with old
 * problems can still be edited.
 */
export function checkInvariants(scene: Scene, media: readonly MediaManifestEntry[]): string[] {
	const problems: string[] = [];
	const tracks = scene.tracks;
	if (!tracks?.main || tracks.main.type !== "video") problems.push("main track missing or not a video track");
	const trackIds = new Set<string>();
	const elementIds = new Set<string>();
	// Arriving JSON is untyped: check the group/type pairing at runtime.
	for (const track of tracks.overlay as TimelineTrack[]) {
		if (track.type === "audio") problems.push(`track ${track.id}: audio track in the overlay group`);
	}
	for (const track of tracks.audio as TimelineTrack[]) {
		if (track.type !== "audio") problems.push(`track ${track.id}: ${track.type} track in the audio group`);
	}
	for (const track of orderedTracks(tracks)) {
		if (trackIds.has(track.id)) problems.push(`track ${track.id}: duplicate track id`);
		trackIds.add(track.id);
		const sorted = [...track.elements].sort((a, b) => a.startTime - b.startTime);
		for (let i = 0; i < sorted.length; i++) {
			const element = sorted[i];
			const label = `element ${element.id}`;
			if (elementIds.has(element.id)) problems.push(`${label}: duplicate element id`);
			elementIds.add(element.id);
			if (!canElementGoOnTrack(element.type, track.type)) {
				problems.push(`${label}: ${element.type} element on a ${track.type} track`);
			}
			for (const field of ["startTime", "duration", "trimStart", "trimEnd"] as const) {
				if (!Number.isInteger(element[field])) problems.push(`${label}: ${field} is not an integer tick count`);
			}
			if (!(element.duration > 0)) problems.push(`${label}: duration must be > 0`);
			if (element.startTime < 0) problems.push(`${label}: startTime < 0`);
			if (element.trimStart < 0) problems.push(`${label}: trimStart < 0`);
			if (element.trimEnd < 0) problems.push(`${label}: trimEnd < 0`);
			const sourceDuration = knownSourceDuration(element, media);
			if (sourceDuration !== undefined) {
				const span = Math.round(element.duration * rateOf(element));
				if (element.trimStart + span > sourceDuration + 1) {
					problems.push(`${label}: trimmed past the media length (${element.trimStart + span} > ${sourceDuration} ticks)`);
				}
			}
			for (const time of allKeyTimes(element.animations)) {
				if (!Number.isInteger(time) || time < 0 || time > element.duration) {
					problems.push(`${label}: keyframe at ${time} outside [0, ${element.duration}]`);
				}
			}
			// v32: a transition's length is a positive whole number of ticks.
			const transition = (element as { transitionIn?: { duration?: unknown } }).transitionIn;
			if (transition && !(Number.isInteger(transition.duration) && (transition.duration as number) > 0)) {
				problems.push(`${label}: transitionIn duration must be a positive integer tick count`);
			}
			const next = sorted[i + 1];
			if (next && next.startTime < endOf(element)) {
				problems.push(`track ${track.id}: ${element.id} overlaps ${next.id}`);
			}
		}
	}
	return problems;
}
