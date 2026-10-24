/**
 * Main-thread side of the segmentation worker: one worker per page, one model loaded at a time, jobs queued.
 */
import {
	ANALYSIS_LONG_SIDE,
	DEFAULT_SEGMENTATION_MODEL,
	getMediapipeWasmBase,
	getSegmentationModelUrl,
	type SegmentationModelId,
} from "./config";
import type { SegWorkerRequest, SegWorkerResponse } from "./protocol";
import type { FrameBoxes, MatteTrack, SegmentationProgress } from "./types";

type Pending = {
	resolve: (value: SegWorkerResponse) => void;
	reject: (error: Error) => void;
	onProgress?: SegmentationProgress;
};

class SegmentationClient {
	private worker: Worker | null = null;
	private loadedModel: SegmentationModelId | null = null;
	private ready: Promise<void> | null = null;
	private pending = new Map<string, Pending>();
	private queue: Promise<unknown> = Promise.resolve();
	private nextJob = 1;
	delegate: "GPU" | "CPU" | null = null;

	private ensureWorker(): Worker {
		if (this.worker) return this.worker;
		const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
		worker.onmessage = (event: MessageEvent<SegWorkerResponse>) => this.handle(event.data);
		worker.onerror = (event) => {
			const error = new Error(event.message || "segmentation worker crashed");
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
			this.terminate();
		};
		this.worker = worker;
		return worker;
	}

	private handle(message: SegWorkerResponse) {
		if (message.type === "ready" || message.type === "init-error") {
			const pending = this.pending.get("init");
			this.pending.delete("init");
			if (message.type === "ready") {
				this.delegate = message.delegate;
				pending?.resolve(message);
			} else {
				pending?.reject(new Error(`could not load the segmentation model: ${message.error}`));
			}
			return;
		}
		const pending = this.pending.get(message.jobId);
		if (!pending) return;
		if (message.type === "progress") {
			pending.onProgress?.({ done: message.done, total: message.total, phase: "segment" });
			return;
		}
		this.pending.delete(message.jobId);
		if (message.type === "error") pending.reject(new Error(message.error));
		else if (message.type === "cancelled") pending.reject(new DOMException("cancelled", "AbortError"));
		else pending.resolve(message);
	}

	private async loadModel(model: SegmentationModelId): Promise<void> {
		if (this.loadedModel === model && this.ready) return this.ready;
		const worker = this.ensureWorker();
		this.loadedModel = model;
		this.ready = new Promise<void>((resolve, reject) => {
			this.pending.set("init", { resolve: () => resolve(), reject });
			const message: SegWorkerRequest = {
				type: "init",
				model,
				wasmBase: getMediapipeWasmBase(),
				modelUrl: getSegmentationModelUrl(model),
			};
			worker.postMessage(message);
		});
		try {
			await this.ready;
		} catch (error) {
			this.ready = null;
			this.loadedModel = null;
			throw error;
		}
	}

	/** Serialises jobs: the worker holds one model and the GPU context; parallel jobs would only fight over it. */
	private enqueue<T>(run: () => Promise<T>): Promise<T> {
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		return next;
	}

	analyze({
		file,
		start,
		end,
		fps,
		model = DEFAULT_SEGMENTATION_MODEL,
		keepAlpha = true,
		onProgress,
		signal,
	}: {
		file: File;
		start: number;
		end: number;
		fps: number;
		model?: SegmentationModelId;
		keepAlpha?: boolean;
		onProgress?: SegmentationProgress;
		signal?: AbortSignal;
	}): Promise<MatteTrack> {
		return this.enqueue(async () => {
			onProgress?.({ done: 0, total: 1, phase: "load-model" });
			await this.loadModel(model);
			const jobId = `analyze-${this.nextJob++}`;
			const worker = this.ensureWorker();
			const abort = () => worker.postMessage({ type: "cancel", jobId } satisfies SegWorkerRequest);
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const answer = await new Promise<SegWorkerResponse>((resolve, reject) => {
					this.pending.set(jobId, { resolve, reject, onProgress });
					const message: SegWorkerRequest = {
						type: "analyze",
						jobId,
						file,
						start,
						end,
						fps,
						longSide: ANALYSIS_LONG_SIDE,
						keepAlpha,
					};
					worker.postMessage(message);
				});
				if (answer.type !== "analyzed") throw new Error("unexpected answer from the segmentation worker");
				return { header: answer.header, data: new Uint8Array(answer.data) };
			} finally {
				signal?.removeEventListener("abort", abort);
			}
		});
	}

	/** Segments one still image (any size; the result has the bitmap's size). */
	segmentImage({
		bitmap,
		model = DEFAULT_SEGMENTATION_MODEL,
	}: {
		bitmap: ImageBitmap;
		model?: SegmentationModelId;
	}): Promise<{ width: number; height: number; alpha: Uint8Array; boxes: FrameBoxes }> {
		return this.enqueue(async () => {
			await this.loadModel(model);
			const jobId = `image-${this.nextJob++}`;
			const worker = this.ensureWorker();
			const answer = await new Promise<SegWorkerResponse>((resolve, reject) => {
				this.pending.set(jobId, { resolve, reject });
				const message: SegWorkerRequest = { type: "segment-image", jobId, bitmap };
				worker.postMessage(message, [bitmap]);
			});
			if (answer.type !== "segmented-image") throw new Error("unexpected answer from the segmentation worker");
			return {
				width: answer.width,
				height: answer.height,
				alpha: new Uint8Array(answer.alpha),
				boxes: answer.boxes,
			};
		});
	}

	terminate() {
		this.worker?.terminate();
		this.worker = null;
		this.loadedModel = null;
		this.ready = null;
		this.delegate = null;
	}
}

export const segmentationClient = new SegmentationClient();
