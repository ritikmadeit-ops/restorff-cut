import type { EdgeShape } from "@/segmentation/matte";
import type { MatteHeader } from "@/segmentation/types";

export type RenderWorkerRequest =
	| {
			type: "render";
			jobId: string;
			file: File;
			/** Source range, seconds. */
			start: number;
			end: number;
			fps: number;
			width: number;
			height: number;
			matteHeader: MatteHeader;
			matteData: ArrayBuffer;
			edge: EdgeShape;
			/** Edge softening after upscaling the matte, output px. */
			featherPx: number;
	  }
	| { type: "cancel"; jobId: string };

export type RenderWorkerResponse =
	| { type: "progress"; jobId: string; done: number; total: number }
	| { type: "done"; jobId: string; buffer: ArrayBuffer; frames: number; duration: number }
	| { type: "error"; jobId: string; error: string }
	| { type: "cancelled"; jobId: string };
