/**
 * Small pure helpers over SceneTracks used by the cutout presets and auto-reframe.
 */
import type { ScalarAnimationKey, ScalarChannel } from "@/animation/types";
import type { MediaAsset } from "@/media/types";
import type { OverlayTrack, SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { generateUUID } from "@/utils/id";
import type { MediaTime } from "@/wasm";
import type { CutoutSource } from "./types";

export type TrackLocation = { kind: "main" } | { kind: "overlay"; index: number } | { kind: "audio"; index: number };

export interface LocatedElement {
	track: TimelineTrack;
	element: TimelineElement;
	location: TrackLocation;
}

export function locateElement({
	tracks,
	elementId,
}: {
	tracks: SceneTracks;
	elementId: string;
}): LocatedElement | null {
	const main = tracks.main.elements.find((element) => element.id === elementId);
	if (main) return { track: tracks.main, element: main, location: { kind: "main" } };
	for (let index = 0; index < tracks.overlay.length; index++) {
		const track = tracks.overlay[index];
		const element = (track.elements as TimelineElement[]).find((candidate) => candidate.id === elementId);
		if (element) return { track, element, location: { kind: "overlay", index } };
	}
	for (let index = 0; index < tracks.audio.length; index++) {
		const track = tracks.audio[index];
		const element = track.elements.find((candidate) => candidate.id === elementId);
		if (element) return { track, element, location: { kind: "audio", index } };
	}
	return null;
}

type WithRestorff = TimelineElement & { restorff?: { cutout?: CutoutSource; [key: string]: unknown } };

export function getCutoutSource(element: TimelineElement | null | undefined): CutoutSource | null {
	if (!element) return null;
	return (element as WithRestorff).restorff?.cutout ?? null;
}

export function withCutoutSource<T extends TimelineElement>(element: T, source: CutoutSource): T {
	const current = (element as WithRestorff).restorff ?? {};
	return { ...element, restorff: { ...current, cutout: source } } as T;
}

/** The cutout made from `sourceElementId`, if one is on the timeline. */
export function findCutoutFor({
	tracks,
	sourceElementId,
}: {
	tracks: SceneTracks;
	sourceElementId: string;
}): LocatedElement | null {
	for (let index = 0; index < tracks.overlay.length; index++) {
		const track = tracks.overlay[index];
		for (const element of track.elements as TimelineElement[]) {
			if (getCutoutSource(element)?.sourceElementId === sourceElementId) {
				return { track, element, location: { kind: "overlay", index } };
			}
		}
	}
	return null;
}

/** Overlay index at which a new track sits directly above the given location. */
export function overlayIndexAbove({ tracks, location }: { tracks: SceneTracks; location: TrackLocation }): number {
	if (location.kind === "overlay") return location.index;
	return tracks.overlay.length;
}

export function insertOverlayTrack({
	tracks,
	index,
	track,
}: {
	tracks: SceneTracks;
	index: number;
	track: OverlayTrack;
}): SceneTracks {
	const overlay = [...tracks.overlay];
	overlay.splice(Math.max(0, Math.min(index, overlay.length)), 0, track);
	return { ...tracks, overlay };
}

export function replaceElementInTracks({
	tracks,
	next,
}: {
	tracks: SceneTracks;
	next: TimelineElement;
}): SceneTracks {
	const swap = <T extends TimelineTrack>(track: T): T =>
		(track.elements as TimelineElement[]).some((element) => element.id === next.id)
			? ({
					...track,
					elements: (track.elements as TimelineElement[]).map((element) =>
						element.id === next.id ? next : element,
					),
				} as T)
			: track;
	return { overlay: tracks.overlay.map(swap), main: swap(tracks.main), audio: tracks.audio.map(swap) };
}

export function appendElementToTrack({
	tracks,
	trackId,
	element,
}: {
	tracks: SceneTracks;
	trackId: string;
	element: TimelineElement;
}): SceneTracks {
	const add = <T extends TimelineTrack>(track: T): T =>
		track.id === trackId
			? ({
					...track,
					elements: [...(track.elements as TimelineElement[]), element].sort((a, b) => a.startTime - b.startTime),
				} as T)
			: track;
	return { overlay: tracks.overlay.map(add), main: add(tracks.main), audio: tracks.audio.map(add) };
}

export function isTrackFree({
	track,
	start,
	end,
	ignoreId,
}: {
	track: TimelineTrack;
	start: number;
	end: number;
	ignoreId?: string;
}): boolean {
	return !(track.elements as TimelineElement[]).some(
		(element) => element.id !== ignoreId && start < element.startTime + element.duration && end > element.startTime,
	);
}

export function newVideoTrack(name: string, elements: TimelineElement[] = []): OverlayTrack {
	return {
		id: generateUUID(),
		name,
		type: "video",
		elements: elements as never,
		muted: true,
		hidden: false,
	};
}

export function newTextTrack(name: string, elements: TimelineElement[] = []): OverlayTrack {
	return { id: generateUUID(), name, type: "text", elements: elements as never, hidden: false };
}

export function newGraphicTrack(name: string, elements: TimelineElement[] = []): OverlayTrack {
	return { id: generateUUID(), name, type: "graphic", elements: elements as never, hidden: false };
}

/** A scalar channel with linear (or held) segments, the format ops@1 and the editor use. */
export function scalarChannel(
	keys: Array<{ time: MediaTime | number; value: number }>,
	segment: ScalarAnimationKey["segmentToNext"] = "linear",
): ScalarChannel {
	return {
		keys: keys
			.slice()
			.sort((a, b) => a.time - b.time)
			.map((key) => ({
				id: generateUUID(),
				time: Math.max(0, Math.round(key.time)) as MediaTime,
				value: key.value,
				segmentToNext: segment,
				tangentMode: "flat" as const,
			})),
	};
}

export function readNumber(params: Record<string, unknown> | undefined, key: string, fallback: number): number {
	const raw = params?.[key];
	const value = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

/** Where a media element is drawn on the canvas (renderer rule: contain-fit, then scale, then offset from centre). */
export function elementRect({
	element,
	asset,
	canvas,
}: {
	element: TimelineElement;
	asset: Pick<MediaAsset, "width" | "height"> | null | undefined;
	canvas: { width: number; height: number };
}): { left: number; top: number; width: number; height: number } {
	const sourceWidth = asset?.width || canvas.width;
	const sourceHeight = asset?.height || canvas.height;
	const contain = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
	const params = element.params as Record<string, unknown>;
	const width = Math.abs(sourceWidth * contain * readNumber(params, "transform.scaleX", 1));
	const height = Math.abs(sourceHeight * contain * readNumber(params, "transform.scaleY", 1));
	const centerX = canvas.width / 2 + readNumber(params, "transform.positionX", 0);
	const centerY = canvas.height / 2 + readNumber(params, "transform.positionY", 0);
	return { left: centerX - width / 2, top: centerY - height / 2, width, height };
}
