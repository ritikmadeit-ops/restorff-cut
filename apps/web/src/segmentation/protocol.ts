import type { SegmentationModelId } from "./config";
import type { FrameBoxes, MatteHeader } from "./types";

export type SegWorkerRequest =
	| {
			type: "init";
			wasmBase: string;
			modelUrl: string;
			model: SegmentationModelId;
	  }
	| {
			type: "analyze";
			jobId: string;
			file: File;
			start: number;
			end: number;
			fps: number;
			longSide: number;
			keepAlpha: boolean;
	  }
	| {
			type: "segment-image";
			jobId: string;
			bitmap: ImageBitmap;
	  }
	| { type: "cancel"; jobId: string };

export type SegWorkerResponse =
	| { type: "ready"; model: SegmentationModelId; delegate: "GPU" | "CPU"; labels: string[] }
	| { type: "init-error"; error: string }
	| { type: "progress"; jobId: string; done: number; total: number }
	| { type: "analyzed"; jobId: string; header: MatteHeader; data: ArrayBuffer }
	| {
			type: "segmented-image";
			jobId: string;
			width: number;
			height: number;
			alpha: ArrayBuffer;
			boxes: FrameBoxes;
	  }
	| { type: "error"; jobId: string; error: string }
	| { type: "cancelled"; jobId: string };
