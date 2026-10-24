import type { SegmentationModelId } from "@/segmentation/config";
import type { Box } from "@/segmentation/types";

/**
 * Stored on a cutout element as `element.restorff.cutout` (scene tracks are stored as-is, so this survives reloads
 * and travels with commits).
 */
export interface CutoutSource {
	/** The clip it was cut from (same scene). */
	sourceElementId: string;
	sourceMediaId: string;
	model: SegmentationModelId;
	/** Source-media range the cutout covers, seconds. */
	start: number;
	end: number;
	/** Frame rate of the rendered cutout (video) or 0 (image). */
	fps: number;
	/** Median boxes over the clip, 0..1 of the source frame (null when nobody was found). */
	person: Box | null;
	head: Box | null;
	face: Box | null;
	createdAt: string;
}

/** Every preset a cutout unlocks (EFFECTS.md ids in `fx`). */
export type MattePresetId = "text-behind" | "green-screen" | "cover-story" | "frame-break";

export type GreenScreenBackground =
	| { kind: "color"; color: string }
	| { kind: "media"; mediaId: string }
	| { kind: "file"; file: File }
	| { kind: "blur"; intensity: number };

export interface TextBehindOptions {
	text: string;
	fontFamily?: string;
	color?: string;
}

export interface CoverStoryOptions {
	masthead: string;
	dateline?: string;
	lines?: string[];
	color?: string;
}

export interface FrameBreakOptions {
	/** Element scale inside the frame (1 = full canvas). */
	scale?: number;
	/** Frame size as a fraction of the scaled clip. */
	frameWidth?: number;
	frameHeight?: number;
	borderPx?: number;
	borderColor?: string;
	/** Seconds the shrink into the frame takes. */
	shrinkSeconds?: number;
}

export type MattePresetOptions =
	| { preset: "text-behind"; options: TextBehindOptions }
	| { preset: "green-screen"; options: { background: GreenScreenBackground } }
	| { preset: "cover-story"; options: CoverStoryOptions }
	| { preset: "frame-break"; options: FrameBreakOptions };

export interface CutoutProgress {
	phase: "load-model" | "segment" | "render" | "import" | "insert" | "cached";
	/** 0..1 within the phase. */
	progress: number;
	message: string;
}

export type CutoutProgressHandler = (progress: CutoutProgress) => void;
