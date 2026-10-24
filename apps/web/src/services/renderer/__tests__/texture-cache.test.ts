import { describe, expect, test } from "bun:test";
import { isExternalCacheHit } from "../compositor/texture-cache";

/**
 * QA 2026-10-20 #6 (ui-fix-render): paused seeks showed the same frame. The video cache's CanvasSink pool hands out
 * 3 canvases round-robin; at 30 fps a 1 s seek moves 30 frames, so the next frame lands in the SAME canvas object.
 */
function pool(size: number) {
	const canvases = Array.from({ length: size }, (_, i) => ({ id: `canvas-${i}` }));
	let next = 0;
	return {
		frameAt(seconds: number, fps = 30) {
			// Every decoded frame takes the next slot (mediabunny CanvasSink._videoSampleToWrappedCanvas).
			const canvas = canvases[next];
			next = (next + 1) % size;
			const timestamp = Math.round(seconds * fps) / fps;
			return { canvas, timestamp, duration: 1 / fps };
		},
	};
}

const version = (f: { timestamp: number; duration: number }) => `${f.timestamp}+${f.duration}`;

describe("external texture cache (QA #6)", () => {
	test("a pooled canvas redrawn with another frame is NOT a cache hit", () => {
		const sink = pool(3);
		const first = sink.frameAt(3);
		// a whole-second seek decodes 30 more frames: the 30th lands back in the first canvas
		let last = first;
		for (let i = 1; i <= 30; i++) last = sink.frameAt(3 + i / 30);
		expect(last.canvas).toBe(first.canvas);
		const previous = { kind: "external", source: first.canvas, version: version(first), width: 1080, height: 1920 };
		const next = { source: last.canvas, version: version(last), width: 1080, height: 1920 };
		expect(isExternalCacheHit(previous, next)).toBe(false);
		// the old rule (identity + size only) would have skipped the upload: the stale frame QA saw
		const identityOnly = { ...previous, version: undefined };
		expect(isExternalCacheHit(identityOnly, { ...next, version: undefined })).toBe(true);
	});

	test("the same frame in the same canvas is still a hit (no re-upload while paused)", () => {
		const sink = pool(3);
		const f = sink.frameAt(4);
		const previous = { kind: "external", source: f.canvas, version: version(f), width: 1080, height: 1920 };
		expect(isExternalCacheHit(previous, { source: f.canvas, version: version(f), width: 1080, height: 1920 })).toBe(true);
	});

	test("immutable sources (no version) keep the identity rule", () => {
		const image = { id: "png" };
		const previous = { kind: "external", source: image, width: 100, height: 50 };
		expect(isExternalCacheHit(previous, { source: image, width: 100, height: 50 })).toBe(true);
		expect(isExternalCacheHit(previous, { source: { id: "other" }, width: 100, height: 50 })).toBe(false);
		expect(isExternalCacheHit(previous, { source: image, width: 101, height: 50 })).toBe(false);
	});

	test("a rendered entry under the same id never counts as an external hit", () => {
		const image = { id: "png" };
		expect(isExternalCacheHit({ kind: "rendered", width: 100, height: 50 }, { source: image, width: 100, height: 50 })).toBe(false);
		expect(isExternalCacheHit(undefined, { source: image, width: 100, height: 50 })).toBe(false);
	});
});
