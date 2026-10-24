import type { SceneTracks, TrackType } from "@/timeline";

/**
 * RestorffCut track names follow design/edit-artboard.png:
 * TEXT · CAPTIONS · V2 B-ROLL · V1 A-ROLL · MUSIC · SFX (the main track is
 * "V1 A-ROLL", see placement/main-track.ts; caption tracks are named by
 * subtitles/insert.ts).
 */
export const DEFAULT_TRACK_NAMES: Record<TrackType, string> = {
	video: "V2 B-ROLL",
	text: "TEXT",
	audio: "MUSIC",
	graphic: "GRAPHICS",
	effect: "EFFECTS",
} as const;

export const CAPTIONS_TRACK_NAME = "CAPTIONS";

/** Name for a new track given the tracks that already exist (V2, V3 ...; MUSIC then SFX). */
export function getDefaultTrackName({
	tracks,
	type,
}: {
	tracks: SceneTracks | null | undefined;
	type: TrackType;
}): string {
	if (!tracks) return DEFAULT_TRACK_NAMES[type];
	const existing =
		type === "audio"
			? tracks.audio.length
			: tracks.overlay.filter((track) => track.type === type).length;

	switch (type) {
		case "video":
			return existing === 0 ? DEFAULT_TRACK_NAMES.video : `V${existing + 2}`;
		case "audio":
			if (existing === 0) return "MUSIC";
			if (existing === 1) return "SFX";
			return `AUDIO ${existing + 1}`;
		default:
			return existing === 0
				? DEFAULT_TRACK_NAMES[type]
				: `${DEFAULT_TRACK_NAMES[type]} ${existing + 1}`;
	}
}
