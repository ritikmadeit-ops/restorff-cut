/// <reference lib="webworker" />
/**
 * Person segmentation worker: decodes a media file with mediabunny at a reduced rate and size, runs the MediaPipe
 * image segmenter on each frame and returns an alpha matte (+ person / face / head boxes per frame).
 *
 * Loaded as a module worker (`new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`). MediaPipe's
 * loader uses importScripts (classic workers only); in module workers it falls back to `self.import(url)`. Our
 * `self.import` fetches the CLASSIC wasm loader script and evaluates it, then publishes its `ModuleFactory` on `self`
 * — no dynamic `import()` of a runtime URL, so nothing depends on bundler magic comments.
 */
import { FilesetResolver, ImageSegmenter, type MPMask } from "@mediapipe/tasks-vision";
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { boxWhere, EMPTY_BOXES, estimateHeadFromAlpha, unionBox } from "./boxes";
import type { SegmentationModelId } from "./config";
import type { SegWorkerRequest, SegWorkerResponse } from "./protocol";
import type { FrameBoxes, MatteHeader } from "./types";

type WorkerScope = typeof globalThis & {
	import?: (url: string) => Promise<unknown>;
	postMessage: (message: unknown, transfer?: Transferable[]) => void;
	onmessage: ((event: MessageEvent<SegWorkerRequest>) => void) | null;
};

const scope = self as unknown as WorkerScope;
scope.import = async (url: string) => {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`could not load ${url} (HTTP ${response.status})`);
	const source = await response.text();
	// The classic Emscripten loader declares `ModuleFactory` at its top level; expose it the way importScripts would.
	const run = new Function(
		`${source}\n;self.ModuleFactory = typeof ModuleFactory !== "undefined" ? ModuleFactory : self.ModuleFactory;`,
	);
	run();
};

let segmenter: ImageSegmenter | null = null;
let modelId: SegmentationModelId = "multiclass";
let delegate: "GPU" | "CPU" = "CPU";
let labels: string[] = [];
let backgroundIndex = -1;
let personIndex = 0;
let faceIndex = -1;
let hairIndex = -1;
const cancelled = new Set<string>();

function post(message: SegWorkerResponse, transfer: Transferable[] = []) {
	scope.postMessage(message, transfer);
}

async function init({
	wasmBase,
	modelUrl,
	model,
}: {
	wasmBase: string;
	modelUrl: string;
	model: SegmentationModelId;
}) {
	segmenter?.close();
	segmenter = null;
	modelId = model;
	// Classic (non-module) loader files: see the `self.import` shim above.
	const fileset = await FilesetResolver.forVisionTasks(wasmBase, false);
	try {
		segmenter = await ImageSegmenter.createFromOptions(fileset, {
			baseOptions: { modelAssetPath: modelUrl, delegate: "GPU" },
			canvas: new OffscreenCanvas(1, 1),
			runningMode: "IMAGE",
			outputConfidenceMasks: true,
			outputCategoryMask: false,
		});
		delegate = "GPU";
	} catch (gpuError) {
		console.warn("[segmentation] GPU delegate failed, using CPU", gpuError);
		segmenter = await ImageSegmenter.createFromOptions(fileset, {
			baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
			runningMode: "IMAGE",
			outputConfidenceMasks: true,
			outputCategoryMask: false,
		});
		delegate = "CPU";
	}
	labels = (segmenter.getLabels?.() ?? []).map((label) => label.toLowerCase());
	backgroundIndex = labels.findIndex((label) => label.includes("background"));
	faceIndex = labels.findIndex((label) => label.includes("face"));
	hairIndex = labels.findIndex((label) => label.includes("hair"));
	const personLabel = labels.findIndex(
		(label) => label.includes("person") || label.includes("selfie"),
	);
	// Multiclass: person = 1 - background. Selfie: a single "person" confidence mask (index 0).
	personIndex = personLabel >= 0 ? personLabel : 0;
	if (model === "multiclass" && backgroundIndex < 0) backgroundIndex = 0;
	if (model === "multiclass" && faceIndex < 0) faceIndex = 3;
	if (model === "multiclass" && hairIndex < 0) hairIndex = 1;
}

/** Runs the model on one frame; writes alpha (0..255) into `alphaOut` and returns the boxes. */
function segmentFrame({
	image,
	width,
	height,
	alphaOut,
}: {
	image: TexImageSource;
	width: number;
	height: number;
	alphaOut: Uint8Array;
}): FrameBoxes {
	if (!segmenter) throw new Error("segmenter not initialised");
	let boxes: FrameBoxes = EMPTY_BOXES;
	segmenter.segment(image, (result) => {
		const masks: MPMask[] = result.confidenceMasks ?? [];
		if (masks.length === 0) {
			alphaOut.fill(0);
			return;
		}
		const maskWidth = masks[0].width;
		const maskHeight = masks[0].height;
		const useBackground = modelId === "multiclass" && backgroundIndex >= 0 && masks[backgroundIndex];
		const source = useBackground
			? masks[backgroundIndex].getAsFloat32Array()
			: masks[Math.min(personIndex, masks.length - 1)].getAsFloat32Array();
		const sameSize = maskWidth === width && maskHeight === height;
		for (let y = 0; y < height; y++) {
			const sy = sameSize ? y : Math.min(maskHeight - 1, Math.floor((y * maskHeight) / height));
			for (let x = 0; x < width; x++) {
				const sx = sameSize ? x : Math.min(maskWidth - 1, Math.floor((x * maskWidth) / width));
				const value = source[sy * maskWidth + sx];
				const person = useBackground ? 1 - value : value;
				alphaOut[y * width + x] = Math.max(0, Math.min(255, Math.round(person * 255)));
			}
		}
		const personBox = boxWhere({ width, height, inside: (i) => alphaOut[i] > 127 });
		const coverage = personBox.count / (width * height);
		if (modelId === "multiclass" && faceIndex >= 0 && masks[faceIndex]) {
			const face = masks[faceIndex].getAsFloat32Array();
			const hair = hairIndex >= 0 && masks[hairIndex] ? masks[hairIndex].getAsFloat32Array() : null;
			const faceBox = boxWhere({
				width: maskWidth,
				height: maskHeight,
				inside: (i) => face[i] > 0.5,
				minPixels: 6,
			}).box;
			const hairBox = hair
				? boxWhere({ width: maskWidth, height: maskHeight, inside: (i) => hair[i] > 0.5, minPixels: 6 }).box
				: null;
			boxes = {
				person: personBox.box,
				face: faceBox,
				head: unionBox(faceBox, hairBox),
				coverage,
			};
		} else {
			const estimate = estimateHeadFromAlpha({ alpha: alphaOut, width, height, person: personBox.box });
			boxes = { person: personBox.box, face: estimate.face, head: estimate.head, coverage };
		}
	});
	return boxes;
}

/** 1-2-1 temporal blur over the analysed frames: removes single-frame flicker before interpolation. */
function smoothTemporally({ data, frameSize, count }: { data: Uint8Array; frameSize: number; count: number }) {
	if (count < 3) return;
	const previous = new Uint8Array(frameSize);
	previous.set(data.subarray(0, frameSize));
	for (let frame = 1; frame < count - 1; frame++) {
		const offset = frame * frameSize;
		const next = offset + frameSize;
		for (let i = 0; i < frameSize; i++) {
			const current = data[offset + i];
			const blended = (previous[i] + 2 * current + data[next + i] + 2) >> 2;
			previous[i] = current;
			data[offset + i] = blended;
		}
	}
}

async function analyze(request: Extract<SegWorkerRequest, { type: "analyze" }>) {
	const { jobId, file, start, end, fps, longSide, keepAlpha } = request;
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error("no video track in this media");
		if (!(await track.canDecode())) throw new Error("this browser cannot decode the media's video codec");
		const sourceWidth = track.displayWidth;
		const sourceHeight = track.displayHeight;
		const scale = longSide / Math.max(sourceWidth, sourceHeight);
		const width = Math.max(8, Math.round(sourceWidth * scale));
		const height = Math.max(8, Math.round(sourceHeight * scale));
		const times: number[] = [];
		const step = 1 / fps;
		for (let t = start; t < end - 1e-6; t += step) times.push(t);
		if (times.length === 0) times.push(start);
		const frameSize = width * height;
		const data = new Uint8Array(keepAlpha ? frameSize * times.length : 0);
		const scratch = new Uint8Array(frameSize);
		const boxes: FrameBoxes[] = [];
		const sink = new CanvasSink(track, { width, height, fit: "fill" });
		let index = 0;
		// +0.5 ms: a timestamp exactly on a frame boundary can otherwise return the previous frame.
		for await (const wrapped of sink.canvasesAtTimestamps(times.map((t) => t + 0.0005))) {
			if (cancelled.has(jobId)) {
				cancelled.delete(jobId);
				post({ type: "cancelled", jobId });
				return;
			}
			const target = keepAlpha ? data.subarray(index * frameSize, (index + 1) * frameSize) : scratch;
			if (wrapped) {
				boxes.push(segmentFrame({ image: wrapped.canvas as OffscreenCanvas, width, height, alphaOut: target }));
			} else if (index > 0) {
				if (keepAlpha) target.set(data.subarray((index - 1) * frameSize, index * frameSize));
				boxes.push(boxes[index - 1]);
			} else {
				target.fill(0);
				boxes.push(EMPTY_BOXES);
			}
			index++;
			if (index % 3 === 0 || index === times.length) {
				post({ type: "progress", jobId, done: index, total: times.length });
			}
			if (index >= times.length) break;
		}
		while (boxes.length < times.length) boxes.push(boxes[boxes.length - 1] ?? EMPTY_BOXES);
		if (keepAlpha) smoothTemporally({ data, frameSize, count: times.length });
		const header: MatteHeader = {
			version: 1,
			model: modelId,
			delegate,
			width,
			height,
			fps,
			start,
			end,
			times,
			boxes,
			sourceWidth,
			sourceHeight,
			hasAlpha: keepAlpha,
		};
		post({ type: "analyzed", jobId, header, data: data.buffer }, [data.buffer]);
	} finally {
		input.dispose();
	}
}

function segmentImage(request: Extract<SegWorkerRequest, { type: "segment-image" }>) {
	const { jobId, bitmap } = request;
	const width = bitmap.width;
	const height = bitmap.height;
	const alpha = new Uint8Array(width * height);
	const boxes = segmentFrame({ image: bitmap, width, height, alphaOut: alpha });
	bitmap.close();
	post({ type: "segmented-image", jobId, width, height, alpha: alpha.buffer, boxes }, [alpha.buffer]);
}

scope.onmessage = async (event: MessageEvent<SegWorkerRequest>) => {
	const message = event.data;
	switch (message.type) {
		case "init":
			try {
				await init(message);
				post({ type: "ready", model: modelId, delegate, labels });
			} catch (error) {
				post({ type: "init-error", error: error instanceof Error ? error.message : String(error) });
			}
			return;
		case "analyze":
			try {
				await analyze(message);
			} catch (error) {
				post({ type: "error", jobId: message.jobId, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		case "segment-image":
			try {
				segmentImage(message);
			} catch (error) {
				post({ type: "error", jobId: message.jobId, error: error instanceof Error ? error.message : String(error) });
			}
			return;
		case "cancel":
			cancelled.add(message.jobId);
			return;
	}
};
