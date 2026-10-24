import type { SceneTracks } from "@/timeline";
import type { SnapPoint } from "@/timeline/snapping";
import { addMediaTime } from "@/wasm";
import { getBeatSnapPoints } from "@/beats/timeline";

export function getElementEdgeSnapPoints({
	tracks,
	excludeElementIds,
}: {
	tracks: SceneTracks;
	excludeElementIds?: Set<string>;
}): SnapPoint[] {
	const snapPoints: SnapPoint[] = [];
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];

	for (const track of orderedTracks) {
		for (const element of track.elements) {
			if (excludeElementIds?.has(element.id)) {
				continue;
			}

			snapPoints.push(
				{
					time: element.startTime,
					type: "element-start",
					elementId: element.id,
					trackId: track.id,
				},
				{
					time: addMediaTime({ a: element.startTime, b: element.duration }),
					type: "element-end",
					elementId: element.id,
					trackId: track.id,
				},
			);
		}
	}

	// Restorff "music to picture": detected beats of music elements snap like clip edges.
	for (const beat of getBeatSnapPoints({ tracks })) {
		if (!beat.elementId || !excludeElementIds?.has(beat.elementId)) {
			snapPoints.push(beat);
		}
	}

	return snapPoints;
}
