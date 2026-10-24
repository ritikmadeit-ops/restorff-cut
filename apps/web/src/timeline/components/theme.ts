import type { TimelineTrack, TrackType } from "@/timeline";
import { CAPTIONS_TRACK_NAME } from "@/timeline/tracks";
import { getTrackRole } from "./track-layout";
import type { TrackRole } from "./layout";

// Colours read from the Edit artboard's DOM; the CSS variables live in
// app/globals.css (--rc-clip-*).
export const TIMELINE_AUDIO_WAVEFORM_COLOR = "rgba(201, 210, 190, 0.45)";

export const TIMELINE_TRACK_THEME: Record<
	TrackType,
	{
		elementClassName: string;
		waveformColor?: string;
	}
> = {
	video: { elementClassName: "bg-[var(--rc-clip-aroll)] text-bone" },
	text: { elementClassName: "bg-[var(--rc-clip-text)] text-[#0C0C0E]" },
	audio: {
		elementClassName: "bg-[var(--rc-clip-music)] text-[var(--rc-clip-music-ink)]",
		waveformColor: TIMELINE_AUDIO_WAVEFORM_COLOR,
	},
	graphic: { elementClassName: "bg-[var(--rc-clip-graphic)] text-bone" },
	effect: { elementClassName: "bg-[var(--rc-clip-effect)] text-bone" },
} as const;

/** Clip fill + ink per artboard role: TEXT bone pill, CAPTIONS grey, B-ROLL brown, A-ROLL slate, MUSIC olive, SFX dot. */
const ROLE_CLASS: Record<TrackRole, string> = {
	text: "bg-[var(--rc-clip-text)] text-[#0C0C0E]",
	captions: "bg-[var(--rc-clip-caption)] text-bone",
	broll: "bg-[var(--rc-clip-broll)] text-bone",
	aroll: "bg-[var(--rc-clip-aroll)] text-bone",
	music: "bg-[var(--rc-clip-music)] text-[var(--rc-clip-music-ink)]",
	sfx: "bg-[var(--rc-clip-sfx)] text-bone",
	graphic: "bg-[var(--rc-clip-graphic)] text-bone",
	effect: "bg-[var(--rc-clip-effect)] text-bone",
};

/** Lane behind each track row (artboard: #16161A, radius 6). */
export const TIMELINE_LANE_CLASS = "rounded-[6px] bg-[var(--rc-lane)]";

export const SELECTED_TRACK_ROW_CLASS = "bg-accent/40";
export const DEFAULT_TIMELINE_BOOKMARK_COLOR = "#EDEBE6";

/** True for a captions text track (named by subtitles/insert.ts, or role "caption" from ops@1). */
export function isCaptionsTrack(track: TimelineTrack | undefined): boolean {
	if (!track) return false;
	return track.type === "text" && (track.name === CAPTIONS_TRACK_NAME || getTrackRole(track) === "captions");
}

export function getTimelineElementClassName({
	type,
	track,
}: {
	type: TrackType;
	track?: TimelineTrack;
}): string {
	if (track) return ROLE_CLASS[getTrackRole(track)];
	return TIMELINE_TRACK_THEME[type].elementClassName.trim();
}
