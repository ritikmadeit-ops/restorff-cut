/**
 * Turns a matte into media the editor can import:
 * - video: a WebM VP9 with alpha, rendered in a worker (render-worker.ts);
 * - still image: a PNG with alpha, rendered on the main thread.
 */
import { DEFAULT_EDGE, type EdgeShape } from "@/segmentation/matte";
import type { FrameBoxes, MatteTrack } from "@/segmentation/types";
import { segmentationClient } from "@/segmentation/client";
import type { SegmentationModelId } from "@/segmentation/config";
import type { RenderWorkerRequest, RenderWorkerResponse } from "./render-protocol";

/** Output long side is capped here (1080 x 1920 for 9:16). */
export const CUTOUT_MAX_LONG_SIDE = 1920;
export const CUTOUT_MAX_SHORT_SIDE = 1080;
export const CUTOUT_FEATHER_PX = 1.5;

export function cutoutOutputSize({
	sourceWidth,
	sourceHeight,
}: {
	sourceWidth: number;
	sourceHeight: number;
}): { width: number; height: number } {
	const long = Math.max(sourceWidth, sourceHeight);
	const short = Math.min(sourceWidth, sourceHeight);
	const scale = Math.min(1, CUTOUT_MAX_LONG_SIDE / long, CUTOUT_MAX_SHORT_SIDE / short);
	// VP9 needs even dimensions.
	const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
	return { width: even(sourceWidth), height: even(sourceHeight) };
}

let jobCounter = 1;

export async function renderCutoutVideo({
	file,
	matte,
	start,
	end,
	fps,
	name,
	edge = DEFAULT_EDGE,
	featherPx = CUTOUT_FEATHER_PX,
	onProgress,
	signal,
}: {
	file: File;
	matte: MatteTrack;
	start: number;
	end: number;
	fps: number;
	name: string;
	edge?: EdgeShape;
	featherPx?: number;
	onProgress?: (info: { done: number; total: number }) => void;
	signal?: AbortSignal;
}): Promise<{ file: File; frames: number; duration: number; width: number; height: number }> {
	const { width, height } = cutoutOutputSize({
		sourceWidth: matte.header.sourceWidth,
		sourceHeight: matte.header.sourceHeight,
	});
	const worker = new Worker(new URL("./render-worker.ts", import.meta.url), { type: "module" });
	const jobId = `cutout-${jobCounter++}`;
	const abort = () => worker.postMessage({ type: "cancel", jobId } satisfies RenderWorkerRequest);
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const answer = await new Promise<Extract<RenderWorkerResponse, { type: "done" }>>((resolve, reject) => {
			worker.onmessage = (event: MessageEvent<RenderWorkerResponse>) => {
				const message = event.data;
				if (message.jobId !== jobId) return;
				if (message.type === "progress") onProgress?.({ done: message.done, total: message.total });
				else if (message.type === "done") resolve(message);
				else if (message.type === "error") reject(new Error(message.error));
				else if (message.type === "cancelled") reject(new DOMException("cancelled", "AbortError"));
			};
			worker.onerror = (event) => reject(new Error(event.message || "cutout render worker crashed"));
			// The matte bytes are copied (not transferred) so the cached matte stays usable.
			const matteData = matte.data.slice().buffer;
			const message: RenderWorkerRequest = {
				type: "render",
				jobId,
				file,
				start,
				end,
				fps,
				width,
				height,
				matteHeader: matte.header,
				matteData,
				edge,
				featherPx,
			};
			worker.postMessage(message, [matteData]);
		});
		const output = new File([answer.buffer], `${name}.webm`, { type: "video/webm" });
		return { file: output, frames: answer.frames, duration: answer.duration, width, height };
	} finally {
		signal?.removeEventListener("abort", abort);
		worker.terminate();
	}
}

/** Still image → PNG of the person only (+ the boxes found). */
export async function renderCutoutImage({
	file,
	name,
	model,
	edge = DEFAULT_EDGE,
	featherPx = CUTOUT_FEATHER_PX,
}: {
	file: File;
	name: string;
	model?: SegmentationModelId;
	edge?: EdgeShape;
	featherPx?: number;
}): Promise<{ file: File; boxes: FrameBoxes; width: number; height: number }> {
	const full = await createImageBitmap(file);
	const width = full.width;
	const height = full.height;
	const analysisScale = Math.min(1, 1024 / Math.max(width, height));
	const small = await createImageBitmap(full, {
		resizeWidth: Math.max(8, Math.round(width * analysisScale)),
		resizeHeight: Math.max(8, Math.round(height * analysisScale)),
		resizeQuality: "high",
	});
	const result = await segmentationClient.segmentImage({ bitmap: small, model });

	const matteCanvas = new OffscreenCanvas(result.width, result.height);
	const matteCtx = matteCanvas.getContext("2d");
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d", { alpha: true });
	if (!ctx || !matteCtx) throw new Error("2D canvas unavailable");
	const image = matteCtx.createImageData(result.width, result.height);
	const span = Math.max(1e-3, edge.high - edge.low);
	for (let i = 0; i < result.alpha.length; i++) {
		const t = Math.min(1, Math.max(0, (result.alpha[i] / 255 - edge.low) / span));
		const o = i * 4;
		image.data[o] = 255;
		image.data[o + 1] = 255;
		image.data[o + 2] = 255;
		image.data[o + 3] = Math.round(t * t * (3 - 2 * t) * 255);
	}
	matteCtx.putImageData(image, 0, 0);
	ctx.drawImage(full, 0, 0);
	ctx.globalCompositeOperation = "destination-in";
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	if (featherPx > 0) ctx.filter = `blur(${featherPx}px)`;
	ctx.drawImage(matteCanvas, 0, 0, width, height);
	full.close();
	const blob = await canvas.convertToBlob({ type: "image/png" });
	return {
		file: new File([blob], `${name}.png`, { type: "image/png" }),
		boxes: result.boxes,
		width,
		height,
	};
}
