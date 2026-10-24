import type { TrackType } from "@/timeline";

/**
 * Row heights by track ROLE, read from the Edit artboard's DOM (design canvas,
 * 2026-10-20): TEXT 26 · CAPTIONS 20 · V2 B-ROLL 30 · V1 A-ROLL 30 · MUSIC 20 ·
 * SFX 18. Captions and music get +2 px so their 11 px labels stay legible.
 */
export type TrackRole =
	| "text"
	| "captions"
	| "broll"
	| "aroll"
	| "music"
	| "sfx"
	| "graphic"
	| "effect";

export const TIMELINE_ROLE_HEIGHTS_PX: Record<TrackRole, number> = {
	text: 26,
	captions: 22,
	broll: 30,
	aroll: 30,
	music: 22,
	sfx: 18,
	graphic: 26,
	effect: 26,
} as const;

/** Fallback by type, for callers that only know the type. */
export const TIMELINE_TRACK_HEIGHTS_PX: Record<TrackType, number> = {
	video: 30,
	text: 26,
	audio: 22,
	graphic: 26,
	effect: 26,
} as const;

/** Clips sit 3 px inside their lane, top and bottom (artboard: top 3 / bottom 3, radius 5). */
export const TIMELINE_CLIP_INSET_PX = 3;

export const KEYFRAME_LANE_HEIGHT_PX = 20;
export const KEYFRAME_DIAMOND_SIZE_PX = 14;
export const EXPANDED_GROUP_HEADER_HEIGHT_PX = 18;

/** Artboard: rows are 6 px apart (flex gap 6). */
export const TIMELINE_TRACK_GAP_PX = 6;
/** Artboard: 24 px section padding + 96 px label column + 12 px gap = lanes start at 132. */
export const TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX = 132;
export const TIMELINE_RULER_HEIGHT_PX = 22;
export const TIMELINE_BOOKMARK_ROW_HEIGHT_PX = 16;
export const TIMELINE_SCROLLBAR_SIZE_PX = 12;
export const TIMELINE_CONTENT_TOP_PADDING_PX = 2;
