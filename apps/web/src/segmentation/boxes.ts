/**
 * Boxes from masks (pure functions; used in the worker and on the main thread).
 */
import type { Box, FrameBoxes } from "./types";

/** Bounding box of the pixels where `inside(i)` is true; null when fewer than `minPixels`. */
export function boxWhere({
	width,
	height,
	inside,
	minPixels = 12,
}: {
	width: number;
	height: number;
	inside: (index: number) => boolean;
	minPixels?: number;
}): { box: Box | null; count: number } {
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	let count = 0;
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			if (!inside(row + x)) continue;
			count++;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	if (count < minPixels || maxX < 0) return { box: null, count };
	return {
		box: [minX / width, minY / height, (maxX - minX + 1) / width, (maxY - minY + 1) / height],
		count,
	};
}

export function unionBox(a: Box | null, b: Box | null): Box | null {
	if (!a) return b;
	if (!b) return a;
	const x0 = Math.min(a[0], b[0]);
	const y0 = Math.min(a[1], b[1]);
	const x1 = Math.max(a[0] + a[2], b[0] + b[2]);
	const y1 = Math.max(a[1] + a[3], b[1] + b[3]);
	return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * Head band estimate for models without a face class: the top of the person mask, as tall as ~0.9 of the
 * shoulders-free width there, capped at 30 % of the person's height. ASSUMPTION (not measured against labelled data):
 * good enough to centre a reframe or place a headline, not for "never cover the face" checks.
 */
export function estimateHeadFromAlpha({
	alpha,
	width,
	height,
	person,
}: {
	alpha: Uint8Array;
	width: number;
	height: number;
	person: Box | null;
}): { head: Box | null; face: Box | null } {
	if (!person) return { head: null, face: null };
	const top = Math.floor(person[1] * height);
	const personHeightPx = person[3] * height;
	// Width of the mask a little below the top: the head, not the shoulders.
	const probeRow = Math.min(height - 1, top + Math.max(2, Math.round(personHeightPx * 0.08)));
	let left = width;
	let right = -1;
	for (let x = 0; x < width; x++) {
		if (alpha[probeRow * width + x] > 127) {
			if (x < left) left = x;
			if (x > right) right = x;
		}
	}
	if (right < left) return { head: null, face: null };
	const headWidthPx = right - left + 1;
	const headHeightPx = Math.min(personHeightPx * 0.3, headWidthPx * 1.3);
	const head: Box = [left / width, top / height, headWidthPx / width, headHeightPx / height];
	const face: Box = [
		head[0] + head[2] * 0.12,
		head[1] + head[3] * 0.22,
		head[2] * 0.76,
		head[3] * 0.78,
	];
	return { head, face };
}

export const EMPTY_BOXES: FrameBoxes = { person: null, face: null, head: null, coverage: 0 };

export function boxCenter(box: Box): { x: number; y: number } {
	return { x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 };
}
