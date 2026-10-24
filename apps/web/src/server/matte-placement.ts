/**
 * Face-safe placement — the pure half (effects-v2 agent, 2026-10-20; SUMMARY gap 6, recreation E-2). Shared by
 * `effects apply / update` (server/effects.ts) and open to the captions tool (captions-v2): no Node imports, no I/O.
 * The I/O half that reads the face boxes of a timeline span is ./matte-face-span.ts; the overlay measurement (alpha of
 * a rendered WebM) is ./effects-placement.ts.
 *
 * Coordinates: every box here is a Rect in FRACTIONS of the canvas (0..1, top-left origin), unless it says source.
 *
 *   faceSpanFrom(frames, …)      median face, envelope (p10/p90 extents) and the REAL head top over a span of
 *                                restorffcut-faces@1 frames (the segmenter's head box only when it is plausible: the
 *                                incident below)
 *   keepOutOf(span)               the box overlays must stay out of: the face envelope + a margin
 *   zonesAround(keepOut, safe)    the free band above and below it inside the safe area
 *   alphaBox / faceCoverage / rowProfile   stats of an overlay's alpha frames (gray bytes, w × h each)
 *   bestShift(…)                  the smallest vertical move that takes an overlay's opaque rows off the face
 *   overlapReport(bbox, face)     what dry runs and applies report per overlay
 *
 * Incident (recreation effects-library, 2026-10-20): Cover Story's masthead was placed from head_top 0.2286 while
 * the face sat at 0.56: the segmenter's per-frame "head" box sometimes swallows the source's burned-in caption above
 * the head (SEEN in faces.json of that clip: head top 0.22 at t = 6, 10, 12, 16 s, face top 0.556), and the median
 * over a short window landed on those frames. Rule here: a frame's segmenter head counts only when its top lies
 * within 0.9 face heights above the detector face and it is at most 1.6 face widths wide; else head top = face top
 * − 0.35 face heights (the reframe rule of mcp-cutout).
 */

export type SourceBox = [number, number, number, number];

/** Fractions of the canvas, top-left origin. */
export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface FaceFrameLike {
	t: number;
	faces: Array<{ box: SourceBox }>;
	head: SourceBox | null;
	face_seg: SourceBox | null;
}

export interface FaceSpan {
	/** Median detector face over the span. */
	face: Rect;
	/** Where the face goes over the span: p10 of the tops/lefts, p90 of the bottoms/rights. */
	envelope: Rect;
	/** Median of the per-frame head top (fraction of the canvas height). */
	head_top: number;
	/** How many frames used the segmenter's head (the rest: face top − 0.35 face heights). */
	head_top_from_segmenter: number;
	/** Frames in the span, and the share with a detector face. */
	frames: number;
	found: number;
}

export interface SafeBand {
	top: number;
	bottom: number;
}

export interface Zone {
	name: "top" | "bottom";
	from: number;
	to: number;
}

const r4 = (value: number) => Math.round(value * 10_000) / 10_000;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function quantile(values: number[], q: number): number {
	if (!values.length) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const at = clamp(q, 0, 1) * (sorted.length - 1);
	const lo = Math.floor(at);
	const hi = Math.ceil(at);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

export const rectRight = (rect: Rect) => rect.left + rect.width;
export const rectBottom = (rect: Rect) => rect.top + rect.height;
export const roundRect = (rect: Rect): Rect => ({ left: r4(rect.left), top: r4(rect.top), width: r4(rect.width), height: r4(rect.height) });

/** The per-frame head top (canvas fraction) by the rule above; null without a face. */
export function headTopOf(face: Rect | null, segHead: Rect | null): { top: number; from: "segmenter" | "face" } | null {
	if (!face) return segHead ? { top: segHead.top, from: "segmenter" } : null;
	if (segHead) {
		const above = face.top - segHead.top;
		const plausible = above >= -0.05 * face.height && above <= 0.9 * face.height && segHead.width <= 1.6 * face.width;
		const centred = segHead.left + segHead.width / 2 >= face.left - 0.1 * face.width && segHead.left + segHead.width / 2 <= rectRight(face) + 0.1 * face.width;
		if (plausible && centred) return { top: segHead.top, from: "segmenter" };
	}
	return { top: face.top - 0.35 * face.height, from: "face" };
}

/**
 * The face over [from, to] (source seconds) of a face track, mapped to the canvas by `toCanvas`. Frames without a
 * detector face use the segmenter's face; frames with neither are skipped. Null when no frame has a face.
 */
export function faceSpanFrom(frames: FaceFrameLike[], from: number, to: number, toCanvas: (box: SourceBox) => Rect): FaceSpan | null {
	const inSpan = frames.filter((frame) => frame.t >= from - 1e-3 && frame.t <= to + 1e-3);
	// a very short span between two analysed frames: take the nearest frame
	const picked = inSpan.length
		? inSpan
		: frames.length
			? [frames.reduce((best, frame) => (Math.abs(frame.t - (from + to) / 2) < Math.abs(best.t - (from + to) / 2) ? frame : best))]
			: [];
	const faces: Rect[] = [];
	const heads: number[] = [];
	let fromSeg = 0;
	let detected = 0;
	for (const frame of picked) {
		const box = frame.faces[0]?.box ?? frame.face_seg;
		if (frame.faces[0]) detected++;
		if (!box) continue;
		const face = toCanvas(box);
		faces.push(face);
		const head = headTopOf(face, frame.head ? toCanvas(frame.head) : null);
		if (head) {
			heads.push(head.top);
			if (head.from === "segmenter") fromSeg++;
		}
	}
	if (!faces.length) return null;
	const median = (pick: (rect: Rect) => number) => quantile(faces.map(pick), 0.5);
	const face = roundRect({ left: median((f) => f.left), top: median((f) => f.top), width: median((f) => f.width), height: median((f) => f.height) });
	const left = quantile(faces.map((f) => f.left), 0.1);
	const top = quantile(faces.map((f) => f.top), 0.1);
	const right = quantile(faces.map(rectRight), 0.9);
	const bottom = quantile(faces.map(rectBottom), 0.9);
	return {
		face,
		envelope: roundRect({ left, top, width: right - left, height: bottom - top }),
		head_top: r4(quantile(heads, 0.5)),
		head_top_from_segmenter: fromSeg,
		frames: picked.length,
		found: picked.length ? r4(detected / picked.length) : 0,
	};
}

/** A face box moved like the clip: scale about the canvas centre, then shifted (x, y fractions of the canvas). */
export function moveRect(rect: Rect, move: { scale?: number; x?: number; y?: number }): Rect {
	const s = move.scale ?? 1;
	const left = 0.5 + (rect.left - 0.5) * s + (move.x ?? 0);
	const top = 0.5 + (rect.top - 0.5) * s + (move.y ?? 0);
	return roundRect({ left, top, width: rect.width * s, height: rect.height * s });
}

/** The box overlays stay out of: the face envelope grown by `margin` (fraction of the canvas height; x by the same px). */
export function keepOutOf(span: Pick<FaceSpan, "envelope">, canvas: { width: number; height: number }, margin = 0.02): Rect {
	const mx = (margin * canvas.height) / canvas.width;
	const e = span.envelope;
	const left = clamp(e.left - mx, 0, 1);
	const top = clamp(e.top - margin, 0, 1);
	const right = clamp(rectRight(e) + mx, 0, 1);
	const bottom = clamp(rectBottom(e) + margin, 0, 1);
	return roundRect({ left, top, width: right - left, height: bottom - top });
}

/**
 * The overlay safe band (fractions of the height): the caption safe area of ops@1 (CAPTION_SAFE_AREA: 220–1500 of
 * 1920 on 9:16, scaled), or 6–94 % on landscape/square canvases where that area is meaningless.
 */
export function safeBandFor(canvas: { width: number; height: number }): SafeBand {
	if (canvas.height / canvas.width > 1.3) return { top: r4(220 / 1920), bottom: r4(1500 / 1920) };
	return { top: 0.06, bottom: 0.94 };
}

/** The free bands above and below the keep-out box inside the safe band (empty bands are left out). */
export function zonesAround(keepOut: Rect, safe: SafeBand): Zone[] {
	const zones: Zone[] = [];
	if (keepOut.top - safe.top > 0.005) zones.push({ name: "top", from: r4(safe.top), to: r4(Math.min(keepOut.top, safe.bottom)) });
	if (safe.bottom - rectBottom(keepOut) > 0.005) zones.push({ name: "bottom", from: r4(Math.max(rectBottom(keepOut), safe.top)), to: r4(safe.bottom) });
	return zones;
}

/** Intersection of two rects as a fraction of `b`'s area (0 = clear). */
export function overlapOf(a: Rect, b: Rect): number {
	const w = Math.min(rectRight(a), rectRight(b)) - Math.max(a.left, b.left);
	const h = Math.min(rectBottom(a), rectBottom(b)) - Math.max(a.top, b.top);
	if (w <= 0 || h <= 0 || b.width <= 0 || b.height <= 0) return 0;
	return r4((w * h) / (b.width * b.height));
}

// ─── overlay alpha stats (frames = gray bytes: alpha 0..255, w × h, row-major) ─────────────────────────────────

export interface AlphaFrames {
	width: number;
	height: number;
	frames: Uint8Array[];
}

const OPAQUE = 64;

/** Union bounding box of the opaque pixels over all frames (fractions), or null when nothing is drawn. */
export function alphaBox(alpha: AlphaFrames, threshold = OPAQUE): Rect | null {
	const { width: w, height: h } = alpha;
	let x0 = w;
	let y0 = h;
	let x1 = -1;
	let y1 = -1;
	for (const frame of alpha.frames) {
		for (let y = 0; y < h; y++) {
			const row = y * w;
			for (let x = 0; x < w; x++) {
				if (frame[row + x] >= threshold) {
					if (x < x0) x0 = x;
					if (x > x1) x1 = x;
					if (y < y0) y0 = y;
					if (y > y1) y1 = y;
				}
			}
		}
	}
	if (x1 < 0) return null;
	return roundRect({ left: x0 / w, top: y0 / h, width: (x1 + 1 - x0) / w, height: (y1 + 1 - y0) / h });
}

function pixelRange(rect: Rect, alpha: AlphaFrames) {
	const x0 = clamp(Math.floor(rect.left * alpha.width), 0, alpha.width);
	const x1 = clamp(Math.ceil(rectRight(rect) * alpha.width), 0, alpha.width);
	const y0 = clamp(Math.floor(rect.top * alpha.height), 0, alpha.height);
	const y1 = clamp(Math.ceil(rectBottom(rect) * alpha.height), 0, alpha.height);
	return { x0, x1, y0, y1 };
}

/** The most of `rect` any one frame covers with opaque pixels (0..1), and in which frame. */
export function faceCoverage(alpha: AlphaFrames, rect: Rect, threshold = OPAQUE): { max: number; frame: number } {
	const { x0, x1, y0, y1 } = pixelRange(rect, alpha);
	const area = Math.max(1, (x1 - x0) * (y1 - y0));
	let best = { max: 0, frame: -1 };
	alpha.frames.forEach((frame, index) => {
		let count = 0;
		for (let y = y0; y < y1; y++) {
			const row = y * alpha.width;
			for (let x = x0; x < x1; x++) if (frame[row + x] >= threshold) count++;
		}
		const share = count / area;
		if (share > best.max) best = { max: r4(share), frame: index };
	});
	return best;
}

/** Per row: the most of the columns [left, right) any frame covers (0..1). Index = row (height of the frames). */
export function rowProfile(alpha: AlphaFrames, columns: { left: number; right: number }, threshold = OPAQUE): Float32Array {
	const x0 = clamp(Math.floor(columns.left * alpha.width), 0, alpha.width);
	const x1 = clamp(Math.ceil(columns.right * alpha.width), 0, alpha.width);
	const width = Math.max(1, x1 - x0);
	const out = new Float32Array(alpha.height);
	for (const frame of alpha.frames) {
		for (let y = 0; y < alpha.height; y++) {
			const row = y * alpha.width;
			let count = 0;
			for (let x = x0; x < x1; x++) if (frame[row + x] >= threshold) count++;
			const share = count / width;
			if (share > out[y]) out[y] = share;
		}
	}
	return out;
}

/**
 * The smallest vertical move (fraction of the height, + = down) that takes the overlay's opaque rows in the face's
 * columns out of the keep-out band, keeping the overlay's box inside the safe band. Rows count when ≥ `rowMin` of
 * the columns is covered (thin outlines and sparkles do not block a move). Answers the residual overlap too.
 */
export function bestShift({
	profile,
	keepOut,
	box,
	safe,
	rowMin = 0.04,
}: {
	profile: Float32Array;
	keepOut: Rect;
	box: Rect;
	safe: SafeBand;
	rowMin?: number;
}): { dy: number; rows_on_face_before: number; rows_on_face_after: number; fits: boolean } {
	const h = profile.length;
	const solid: number[] = [];
	for (let y = 0; y < h; y++) if (profile[y] >= rowMin) solid.push(y);
	const k0 = Math.floor(keepOut.top * h);
	const k1 = Math.ceil(rectBottom(keepOut) * h);
	const hits = (dyRows: number) => solid.reduce((n, y) => n + (y + dyRows >= k0 && y + dyRows < k1 ? 1 : 0), 0);
	const before = hits(0);
	// allowed moves keep the box inside the safe band (when it is taller than the band: no move at all)
	const minDy = Math.ceil((safe.top - box.top) * h);
	const maxDy = Math.floor((safe.bottom - rectBottom(box)) * h);
	if (before === 0) return { dy: 0, rows_on_face_before: 0, rows_on_face_after: 0, fits: true };
	let best = { dyRows: 0, hits: before };
	if (minDy <= maxDy) {
		for (let step = 1; step <= h; step++) {
			for (const dyRows of [-step, step]) {
				if (dyRows < minDy || dyRows > maxDy) continue;
				const n = hits(dyRows);
				if (n < best.hits) best = { dyRows, hits: n };
			}
			if (best.hits === 0) break;
		}
	}
	return { dy: r4(best.dyRows / h), rows_on_face_before: before, rows_on_face_after: best.hits, fits: best.hits === 0 };
}

export interface OverlapReport {
	bbox: Rect | null;
	face: Rect;
	keep_out: Rect;
	/** Share of the face box covered by opaque pixels in the worst frame. */
	face_covered: number;
	/** Share of the face box inside the overlay's bounding box. */
	bbox_overlap: number;
	clear: boolean;
}

/** Coverage up to this share of the face box counts as clear (thin outlines, sparkles at the edge). */
export const FACE_CLEAR_MAX = 0.03;

export function overlapReport(alpha: AlphaFrames | null, face: Rect, keepOut: Rect): OverlapReport {
	const bbox = alpha ? alphaBox(alpha) : null;
	const covered = alpha ? faceCoverage(alpha, face).max : 1;
	return {
		bbox,
		face,
		keep_out: keepOut,
		face_covered: covered,
		bbox_overlap: bbox ? overlapOf(bbox, face) : alpha ? 0 : 1,
		clear: covered <= FACE_CLEAR_MAX,
	};
}

/**
 * Where to put a box of `height` (fraction) so it clears the face: the zone it fits in nearest to where it is, else
 * the larger zone with the scale it needs (≥ minScale). For callers that place by numbers (captions: no render).
 */
export function placeInZones(
	box: Rect,
	zones: Zone[],
	minScale = 0.5,
): { zone: Zone | null; top: number; scale: number; fits: boolean } {
	if (!zones.length) return { zone: null, top: box.top, scale: 1, fits: false };
	const fitting = zones.filter((zone) => zone.to - zone.from >= box.height);
	if (fitting.length) {
		const centre = box.top + box.height / 2;
		const zone = fitting.reduce((best, z) => (Math.abs((z.from + z.to) / 2 - centre) < Math.abs((best.from + best.to) / 2 - centre) ? z : best));
		const top = clamp(box.top, zone.from, zone.to - box.height);
		return { zone, top: r4(top), scale: 1, fits: true };
	}
	const zone = zones.reduce((best, z) => (z.to - z.from > best.to - best.from ? z : best));
	const scale = Math.max(minScale, ((zone.to - zone.from) / box.height) * 0.96);
	const height = box.height * scale;
	return { zone, top: r4(zone.from + Math.max(0, (zone.to - zone.from - height) / 2)), scale: r4(scale), fits: height <= zone.to - zone.from + 1e-6 };
}
