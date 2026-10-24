/// <reference lib="webworker" />
/**
 * Renders "the person only" for a span of a video: decode at full size → multiply by the interpolated matte → encode
 * WebM VP9 with alpha (mediabunny, `alpha: "keep"`). The editor imports the result as ordinary media; its video cache
 * decodes transparent WebM with `CanvasSink({ alpha: true })` (services/video-cache/service.ts).
 */
import {
	ALL_FORMATS,
	BlobSource,
	BufferTarget,
	CanvasSink,
	CanvasSource,
	Input,
	Output,
	QUALITY_HIGH,
	WebMOutputFormat,
	canEncodeVideo,
} from "mediabunny";
import { sampleMatteRgba } from "@/segmentation/matte";
import type { RenderWorkerRequest, RenderWorkerResponse } from "./render-protocol";

type WorkerScope = typeof globalThis & {
	postMessage: (message: unknown, transfer?: Transferable[]) => void;
	onmessage: ((event: MessageEvent<RenderWorkerRequest>) => void) | null;
};

const scope = self as unknown as WorkerScope;
const cancelled = new Set<string>();

function post(message: RenderWorkerResponse, transfer: Transferable[] = []) {
	scope.postMessage(message, transfer);
}

async function render(request: Extract<RenderWorkerRequest, { type: "render" }>) {
	const { jobId, file, start, end, fps, width, height, matteHeader, edge, featherPx } = request;
	const matte = { header: matteHeader, data: new Uint8Array(request.matteData) };
	if (!matteHeader.hasAlpha) throw new Error("the matte has no alpha frames");
	const supported = await canEncodeVideo("vp9", { width, height, alpha: "keep" });
	if (!supported) {
		throw new Error("this browser cannot encode transparent VP9 video (try a recent Chrome or Edge)");
	}

	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error("no video track in this media");

		const frame = new OffscreenCanvas(width, height);
		const ctx = frame.getContext("2d", { alpha: true });
		const small = new OffscreenCanvas(matteHeader.width, matteHeader.height);
		const smallCtx = small.getContext("2d");
		if (!ctx || !smallCtx) throw new Error("2D canvas unavailable in the worker");
		const matteImage = smallCtx.createImageData(matteHeader.width, matteHeader.height);

		const target = new BufferTarget();
		const output = new Output({ format: new WebMOutputFormat(), target });
		const source = new CanvasSource(frame, {
			codec: "vp9",
			bitrate: QUALITY_HIGH,
			alpha: "keep",
			keyFrameInterval: 1,
		});
		output.addVideoTrack(source, { frameRate: fps });
		await output.start();

		const times: number[] = [];
		for (let t = start; t < end - 1e-6; t += 1 / fps) times.push(t);
		if (times.length === 0) times.push(start);
		const sink = new CanvasSink(track, { width, height, fit: "fill" });
		let last: CanvasImageSource | null = null;
		let index = 0;
		for await (const wrapped of sink.canvasesAtTimestamps(times.map((t) => t + 0.0005))) {
			if (cancelled.has(jobId)) {
				cancelled.delete(jobId);
				await output.cancel();
				post({ type: "cancelled", jobId });
				return;
			}
			if (wrapped) last = wrapped.canvas as OffscreenCanvas;
			ctx.save();
			ctx.globalCompositeOperation = "copy";
			if (last) ctx.drawImage(last, 0, 0, width, height);
			else ctx.clearRect(0, 0, width, height);

			sampleMatteRgba({ track: matte, time: times[index], out: matteImage.data, edge });
			smallCtx.putImageData(matteImage, 0, 0);
			ctx.globalCompositeOperation = "destination-in";
			ctx.imageSmoothingEnabled = true;
			ctx.imageSmoothingQuality = "high";
			if (featherPx > 0) ctx.filter = `blur(${featherPx}px)`;
			ctx.drawImage(small, 0, 0, width, height);
			ctx.restore();

			await source.add(index / fps, 1 / fps);
			index++;
			if (index % 5 === 0 || index === times.length) {
				post({ type: "progress", jobId, done: index, total: times.length });
			}
			if (index >= times.length) break;
		}
		source.close();
		await output.finalize();
		const buffer = target.buffer;
		if (!buffer) throw new Error("the encoder produced no file");
		post({ type: "done", jobId, buffer, frames: index, duration: index / fps }, [buffer]);
	} finally {
		input.dispose();
	}
}

scope.onmessage = async (event: MessageEvent<RenderWorkerRequest>) => {
	const message = event.data;
	if (message.type === "cancel") {
		cancelled.add(message.jobId);
		return;
	}
	try {
		await render(message);
	} catch (error) {
		post({ type: "error", jobId: message.jobId, error: error instanceof Error ? error.message : String(error) });
	}
};
