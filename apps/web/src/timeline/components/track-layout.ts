import type { TrackType } from "@/timeline";
import { CAPTIONS_TRACK_NAME } from "@/timeline/tracks";
import {
	KEYFRAME_LANE_HEIGHT_PX,
	TIMELINE_ROLE_HEIGHTS_PX,
	TIMELINE_TRACK_GAP_PX,
	type TrackRole,
} from "./layout";

/** What the layout needs to know about a track: its type, and (when known) name / Restorff role. */
export type TrackLike = {
	type: TrackType;
	name?: string;
	restorff?: { role?: string };
};

/**
 * The artboard role of a track: TEXT · CAPTIONS · V2 B-ROLL · V1 A-ROLL · MUSIC · SFX.
 * Uses `track.restorff.role` (written by ops@1) first, then the track name.
 */
export function getTrackRole(track: TrackLike): TrackRole {
	const role = track.restorff?.role;
	const name = (track.name ?? "").toUpperCase();
	switch (track.type) {
		case "text":
			if (role === "caption" || name.startsWith(CAPTIONS_TRACK_NAME)) return "captions";
			return "text";
		case "video":
			if (role === "aroll" || name === "V1 A-ROLL" || name === "MAIN TRACK") return "aroll";
			return "broll";
		case "audio":
			if (role === "sfx" || name.startsWith("SFX")) return "sfx";
			return "music";
		case "graphic":
			return "graphic";
		case "effect":
			return "effect";
	}
}

export function getTrackHeight(track: TrackLike): number {
	return TIMELINE_ROLE_HEIGHTS_PX[getTrackRole(track)];
}

export function getExpandedTrackHeight({
	track,
	expandedLaneCount,
}: {
	track: TrackLike;
	expandedLaneCount: number;
}): number {
	return getTrackHeight(track) + expandedLaneCount * KEYFRAME_LANE_HEIGHT_PX;
}

export function getCumulativeHeightBefore({
	tracks,
	trackIndex,
	getExtraHeight,
}: {
	tracks: TrackLike[];
	trackIndex: number;
	getExtraHeight?: (trackIndex: number) => number;
}): number {
	return tracks
		.slice(0, trackIndex)
		.reduce(
			(sum, track, i) =>
				sum +
				getTrackHeight(track) +
				(getExtraHeight?.(i) ?? 0) +
				TIMELINE_TRACK_GAP_PX,
			0,
		);
}

export function getTotalTracksHeight({
	tracks,
	getExtraHeight,
}: {
	tracks: TrackLike[];
	getExtraHeight?: (trackIndex: number) => number;
}): number {
	const tracksHeight = tracks.reduce(
		(sum, track, i) => sum + getTrackHeight(track) + (getExtraHeight?.(i) ?? 0),
		0,
	);
	const gapsHeight = Math.max(0, tracks.length - 1) * TIMELINE_TRACK_GAP_PX;
	return tracksHeight + gapsHeight;
}
