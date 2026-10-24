/**
 * Still frames from a render tree, for the storyboard cards and the
 * before/after wipe. The compositor is ONE shared WebGL canvas (the preview's
 * own <canvas>), so every grab is queued, and after a batch the caller's
 * current frame is rendered again so the live preview is left as it was.
 */
import type { FrameRate } from "restorffcut-wasm";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import type { RootNode } from "@/services/renderer/nodes/root-node";

let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
	const next = queue.then(job, job);
	queue = next.catch(() => undefined);
	return next;
}

export interface GrabSpec {
	tree: RootNode;
	/** Ticks. */
	time: number;
}

export interface GrabOptions {
	width: number;
	height: number;
	fps: FrameRate;
	/** Output width in px; height keeps the canvas aspect. */
	outWidth: number;
	/** Rendered after the batch so the visible preview shows this frame again. */
	restore?: GrabSpec | null;
	/** JPEG quality 0..1. */
	quality?: number;
	/** Called with each frame as it lands (index into `specs`). */
	onFrame?: (index: number, dataUrl: string) => void;
	/** Return true to stop early (e.g. the view closed). */
	isCancelled?: () => boolean;
}

/** Render each spec to a JPEG data URL, in order. Failed frames come back as null. */
export function grabFrames(specs: GrabSpec[], options: GrabOptions): Promise<Array<string | null>> {
	return enqueue(async () => {
		const renderer = new CanvasRenderer({
			width: options.width,
			height: options.height,
			fps: options.fps,
		});
		const target = document.createElement("canvas");
		target.width = Math.max(1, Math.round(options.outWidth));
		target.height = Math.max(1, Math.round((options.outWidth * options.height) / options.width));
		const results: Array<string | null> = [];
		try {
			for (let i = 0; i < specs.length; i++) {
				if (options.isCancelled?.()) break;
				try {
					await renderer.renderToCanvas({
						node: specs[i].tree,
						time: specs[i].time,
						targetCanvas: target,
					});
					const url = target.toDataURL("image/jpeg", options.quality ?? 0.82);
					results.push(url);
					options.onFrame?.(i, url);
				} catch (error) {
					console.warn("[storyboard] frame grab failed", error);
					results.push(null);
				}
			}
		} finally {
			if (options.restore) {
				try {
					await renderer.render({ node: options.restore.tree, time: options.restore.time });
				} catch {
					// The preview re-renders on its next frame change anyway.
				}
			}
		}
		return results;
	});
}
