import type {
	AudioTrack,
	EffectTrack,
	GraphicTrack,
	OverlayTrack,
	SceneTracks,
	TextTrack,
	TimelineElement,
	TimelineTrack,
	VideoTrack,
} from "@/timeline";
import { generateUUID } from "@/utils/id";
import { buildEmptyTrack } from "./track-factory";
import { getDefaultTrackName } from "@/timeline/tracks";
import type { PlacementResult } from "./types";
import { updateTrackInSceneTracks } from "@/timeline/track-element-update";

export function applyPlacement({
	tracks,
	placementResult,
	elements,
	newTrackInsertIndexOverride,
}: {
	tracks: SceneTracks;
	placementResult: PlacementResult;
	elements: TimelineElement[];
	newTrackInsertIndexOverride?: number;
}): { updatedTracks: SceneTracks; targetTrackId: string } | null {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	if (placementResult.kind === "existingTrack") {
		const targetTrack = orderedTracks[placementResult.trackIndex];
		if (!targetTrack) {
			return null;
		}

		const updatedTracks = updateTrackInSceneTracks({
			tracks,
			trackId: targetTrack.id,
			update: (track) => ({
				...track,
				elements: [...track.elements, ...elements],
			}),
		});

		return { updatedTracks, targetTrackId: targetTrack.id };
	}

	const newTrackId = generateUUID();
	const insertIndex =
		newTrackInsertIndexOverride ?? placementResult.insertIndex;
	const updatedTracks =
		placementResult.trackType === "audio"
			? {
					...tracks,
					audio: insertIntoAudioTracks({
						tracks,
						insertIndex,
						track: buildPlacedAudioTrack({
							id: newTrackId,
							elements,
							name: getDefaultTrackName({ tracks, type: "audio" }),
						}),
					}),
				}
			: {
					...tracks,
					overlay: insertIntoOverlayTracks({
						tracks,
						insertIndex,
						track: buildPlacedOverlayTrack({
							id: newTrackId,
							type: placementResult.trackType,
							elements,
							name: getDefaultTrackName({
								tracks,
								type: placementResult.trackType,
							}),
						}),
					}),
				};
	return { updatedTracks, targetTrackId: newTrackId };
}

function insertIntoOverlayTracks({
	tracks,
	insertIndex,
	track,
}: {
	tracks: SceneTracks;
	insertIndex: number;
	track: OverlayTrack;
}): OverlayTrack[] {
	const normalizedInsertIndex = Math.max(
		0,
		Math.min(insertIndex, tracks.overlay.length),
	);
	const nextTracks = [...tracks.overlay];
	nextTracks.splice(normalizedInsertIndex, 0, track);
	return nextTracks;
}

function insertIntoAudioTracks({
	tracks,
	insertIndex,
	track,
}: {
	tracks: SceneTracks;
	insertIndex: number;
	track: AudioTrack;
}): AudioTrack[] {
	const audioInsertIndex = Math.max(
		0,
		Math.min(insertIndex - tracks.overlay.length - 1, tracks.audio.length),
	);
	const nextTracks = [...tracks.audio];
	nextTracks.splice(audioInsertIndex, 0, track);
	return nextTracks;
}

function buildPlacedAudioTrack({
	id,
	elements,
	name,
}: {
	id: string;
	elements: TimelineElement[];
	name?: string;
}): AudioTrack {
	return {
		...buildEmptyTrack({ id, type: "audio", name }),
		elements: elements as AudioTrack["elements"],
	};
}

function buildPlacedOverlayTrack({
	id,
	type,
	elements,
	name,
}: {
	id: string;
	type: Exclude<OverlayTrack["type"], "audio">;
	elements: TimelineElement[];
	name?: string;
}): OverlayTrack {
	switch (type) {
		case "video":
			return {
				...buildEmptyTrack({ id, type: "video", name }),
				elements: elements as VideoTrack["elements"],
			};
		case "text":
			return {
				...buildEmptyTrack({ id, type: "text", name }),
				elements: elements as TextTrack["elements"],
			};
		case "graphic":
			return {
				...buildEmptyTrack({ id, type: "graphic", name }),
				elements: elements as GraphicTrack["elements"],
			};
		case "effect":
			return {
				...buildEmptyTrack({ id, type: "effect", name }),
				elements: elements as EffectTrack["elements"],
			};
	}
}
