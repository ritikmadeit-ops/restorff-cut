import type { FrameRate } from "restorffcut-wasm";
import type { TScene } from "@/timeline/types";
import type { MediaTime } from "@/wasm";

export type TBackground =
	| {
			type: "color";
			color: string;
	  }
	| {
			type: "blur";
			blurIntensity: number;
	  };

export interface TCanvasSize {
	width: number;
	height: number;
}

export interface TProjectMetadata {
	id: string;
	name: string;
	thumbnail?: string;
	duration: MediaTime;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Restorff (project v32): the master loudness the export normalises to, measured on the
 * encoded file (EXPORT-GATE "LOUD"). Absent = the owner's default, −14 LUFS / −1 dBTP.
 */
export interface TLoudnessTarget {
	enabled: boolean;
	/** Integrated loudness target, LUFS (BS.1770-4). */
	integratedLufs: number;
	/** True-peak ceiling, dBTP. */
	truePeakDb: number;
}

export interface TProjectSettings {
	fps: FrameRate;
	canvasSize: TCanvasSize;
	canvasSizeMode?: "preset" | "custom";
	lastCustomCanvasSize?: TCanvasSize | null;
	originalCanvasSize?: TCanvasSize | null;
	background: TBackground;
	loudness?: TLoudnessTarget;
	/** Restorff: the delivery preset every export uses unless the caller overrides it. */
	delivery?: TDeliverySettings;
}

/** Restorff (optional, no migration needed): see `@/export/presets`. */
export interface TDeliverySettings {
	/** Preset id; absent = the project canvas as it is. */
	preset?: string;
	/** When the preset's aspect differs from the canvas: letterbox ("contain") or crop ("cover"). */
	fit?: "contain" | "cover";
}

export interface TTimelineViewState {
	zoomLevel: number;
	scrollLeft: number;
	playheadTime: MediaTime;
}

export interface TProject {
	metadata: TProjectMetadata;
	scenes: TScene[];
	currentSceneId: string;
	settings: TProjectSettings;
	version: number;
	timelineViewState?: TTimelineViewState;
}

export type TProjectSortKey = "createdAt" | "updatedAt" | "name" | "duration";
export type TSortOrder = "asc" | "desc";
export type TProjectSortOption = `${TProjectSortKey}-${TSortOrder}`;
