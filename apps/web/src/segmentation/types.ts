import type { SegmentationModelId } from "./config";

/** Normalised box [x, y, w, h] in 0..1 of the frame, top-left origin. */
export type Box = [number, number, number, number];

export interface FrameBoxes {
	/** Pixels with person confidence > 0.5. */
	person: Box | null;
	/** Face: the face-skin class (multiclass) or an estimate from the top of the person mask (selfie). */
	face: Box | null;
	/** Head: face + hair (multiclass) or the estimated head band (selfie). */
	head: Box | null;
	/** Fraction of the frame covered by the person (0..1). */
	coverage: number;
}

export interface MatteHeader {
	version: 1;
	model: SegmentationModelId;
	delegate: "GPU" | "CPU";
	/** Matte frame size in px (the analysis size, long side = ANALYSIS_LONG_SIDE). */
	width: number;
	height: number;
	/** Analysis rate, frames per second of SOURCE time. */
	fps: number;
	/** Source-time range analysed, seconds. */
	start: number;
	end: number;
	/** Source time of each analysed frame, seconds. */
	times: number[];
	boxes: FrameBoxes[];
	/** Display size of the analysed media. */
	sourceWidth: number;
	sourceHeight: number;
	/** Whether alpha bytes are stored (false = boxes only). */
	hasAlpha: boolean;
}

/** An alpha matte for a span of one media file: `count` frames of width*height bytes (0 = background). */
export interface MatteTrack {
	header: MatteHeader;
	data: Uint8Array;
}

export interface AnalyzeRequest {
	file: File;
	start: number;
	end: number;
	fps: number;
	model: SegmentationModelId;
	/** false = compute boxes only (cheaper to store). */
	keepAlpha: boolean;
}

export type SegmentationProgress = (info: { done: number; total: number; phase: string }) => void;
