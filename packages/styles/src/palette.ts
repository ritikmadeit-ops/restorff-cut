/**
 * Colour maths for the style card: k-means palette on downsampled pixels, HSL, luma, frame histograms. Pure and
 * deterministic (seeded k-means++), so the same references always give the same card.
 */

export type Rgb = [number, number, number];

/** RGBA pixels of one downsampled frame (ImageData.data in the browser), row-major. */
export interface PixelFrame {
	width: number;
	height: number;
	data: ArrayLike<number>;
	/** Seconds into the video (videos only). */
	t?: number;
}

export interface PaletteColor {
	hex: string;
	rgb: Rgb;
	/** Fraction of the sampled pixels in this cluster (all colours sum to 1). */
	share: number;
	/** 0–1 */
	luma: number;
	/** HSL saturation 0–1 */
	saturation: number;
	/** HSL hue 0–360 */
	hue: number;
	/** paper = light and quiet (backgrounds), ink = dark (text), accent = the loudest colour, tone = the rest. */
	role: "paper" | "ink" | "accent" | "tone";
}

/** Mulberry32: a tiny seeded PRNG. */
export function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function toHex([r, g, b]: Rgb): string {
	const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
	return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

export function hexToRgb(hex: string): Rgb {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return [0, 0, 0];
	const n = Number.parseInt(m[1] as string, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Rec. 709 luma, 0–1. */
export function luma([r, g, b]: Rgb): number {
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function rgbToHsl([r, g, b]: Rgb): { h: number; s: number; l: number } {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l };
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
	else if (max === gn) h = (bn - rn) / d + 2;
	else h = (rn - gn) / d + 4;
	return { h: h * 60, s, l };
}

/** Opaque pixels of the frames, evenly subsampled to at most `max`. */
export function samplePixels(frames: readonly PixelFrame[], max = 24_000): Rgb[] {
	let total = 0;
	for (const frame of frames) total += Math.floor(frame.data.length / 4);
	const stride = Math.max(1, Math.ceil(total / max));
	const out: Rgb[] = [];
	let n = 0;
	for (const frame of frames) {
		const { data } = frame;
		for (let i = 0; i + 3 < data.length; i += 4) {
			if (n++ % stride !== 0) continue;
			if ((data[i + 3] as number) < 128) continue;
			out.push([data[i] as number, data[i + 1] as number, data[i + 2] as number]);
		}
	}
	return out;
}

const dist2 = (a: Rgb, b: Rgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** k-means++ in RGB, seeded. Returns centroids with their member counts (empty clusters dropped). */
export function kmeans(pixels: readonly Rgb[], k: number, options: { iterations?: number; seed?: number } = {}): Array<{ center: Rgb; count: number }> {
	if (!pixels.length) return [];
	const random = prng(options.seed ?? 7);
	const kk = Math.max(1, Math.min(k, pixels.length));
	const centers: Rgb[] = [[...(pixels[Math.floor(random() * pixels.length)] as Rgb)] as Rgb];
	const nearest = pixels.map((p) => dist2(p, centers[0] as Rgb));
	while (centers.length < kk) {
		const sum = nearest.reduce((a, b) => a + b, 0);
		if (sum === 0) break; // every pixel is already a centre
		let pick = random() * sum;
		let index = 0;
		for (; index < nearest.length - 1; index++) {
			pick -= nearest[index] as number;
			if (pick <= 0) break;
		}
		const center = [...(pixels[index] as Rgb)] as Rgb;
		centers.push(center);
		for (let i = 0; i < pixels.length; i++) nearest[i] = Math.min(nearest[i] as number, dist2(pixels[i] as Rgb, center));
	}
	const assign = new Int32Array(pixels.length);
	const iterations = options.iterations ?? 12;
	for (let it = 0; it < iterations; it++) {
		let moved = 0;
		for (let i = 0; i < pixels.length; i++) {
			let best = 0;
			let bestD = Number.POSITIVE_INFINITY;
			for (let c = 0; c < centers.length; c++) {
				const d = dist2(pixels[i] as Rgb, centers[c] as Rgb);
				if (d < bestD) {
					bestD = d;
					best = c;
				}
			}
			if (assign[i] !== best) moved++;
			assign[i] = best;
		}
		const sums = centers.map(() => [0, 0, 0, 0]);
		for (let i = 0; i < pixels.length; i++) {
			const s = sums[assign[i] as number] as number[];
			const p = pixels[i] as Rgb;
			s[0] += p[0];
			s[1] += p[1];
			s[2] += p[2];
			s[3] += 1;
		}
		sums.forEach((s, c) => {
			if (s[3]) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]] as Rgb;
		});
		if (it > 0 && moved === 0) break;
	}
	const counts = centers.map(() => 0);
	for (let i = 0; i < pixels.length; i++) counts[assign[i] as number]++;
	return centers.map((center, c) => ({ center: center.map((v) => Math.round(v)) as Rgb, count: counts[c] as number })).filter((entry) => entry.count > 0);
}

/** Merge clusters closer than `minDistance` (RGB units) — k-means on a flat image splits one colour in two. */
function mergeClose(clusters: Array<{ center: Rgb; count: number }>, minDistance = 28): Array<{ center: Rgb; count: number }> {
	const out: Array<{ center: Rgb; count: number }> = [];
	for (const cluster of [...clusters].sort((a, b) => b.count - a.count)) {
		const near = out.find((entry) => Math.sqrt(dist2(entry.center, cluster.center)) < minDistance);
		if (near) {
			const n = near.count + cluster.count;
			near.center = near.center.map((v, i) => Math.round((v * near.count + (cluster.center[i] as number) * cluster.count) / n)) as Rgb;
			near.count = n;
		} else out.push({ center: [...cluster.center] as Rgb, count: cluster.count });
	}
	return out;
}

/** The palette of a set of frames: up to `k` colours, biggest first, each with a role. */
export function paletteFromFrames(frames: readonly PixelFrame[], options: { k?: number; seed?: number; maxPixels?: number } = {}): PaletteColor[] {
	const pixels = samplePixels(frames, options.maxPixels);
	const clusters = mergeClose(kmeans(pixels, options.k ?? 6, { seed: options.seed }));
	const total = clusters.reduce((sum, c) => sum + c.count, 0) || 1;
	const colors: PaletteColor[] = clusters
		.map(({ center, count }) => {
			const { h, s } = rgbToHsl(center);
			return { hex: toHex(center), rgb: center, share: count / total, luma: luma(center), saturation: s, hue: h, role: "tone" as PaletteColor["role"] };
		})
		.sort((a, b) => b.share - a.share);
	// roles: the loudest saturated colour is the accent; the lightest quiet one with a real share is paper; the darkest is ink
	const accent = colors
		.filter((c) => c.saturation > 0.35 && c.luma > 0.12 && c.luma < 0.92)
		.sort((a, b) => b.saturation * Math.sqrt(b.share) - a.saturation * Math.sqrt(a.share))[0];
	if (accent) accent.role = "accent";
	const paper = colors.filter((c) => c.role === "tone" && c.luma > 0.62 && c.share >= 0.08).sort((a, b) => b.luma * b.share - a.luma * a.share)[0];
	if (paper) paper.role = "paper";
	const ink = colors.filter((c) => c.role === "tone" && c.luma < 0.3).sort((a, b) => a.luma - b.luma)[0];
	if (ink) ink.role = "ink";
	return colors;
}

function hueGap(a: number, b: number): number {
	const d = Math.abs(a - b) % 360;
	return d > 180 ? 360 - d : d;
}

/**
 * Saturated colours that k-means merged into a bigger cluster (explainer-v2, 2026-10-20): the recreation's references
 * drew a red outline, red route dots and a red scrap on every sheet, yet the card listed an "orange" (red + mustard
 * averaged) and no red. The loud pixels (HSL s > 0.45, luma 0.1–0.85) are clustered on their own; a cluster with at
 * least `minShare` of all pixels whose hue is > 18° from every palette colour of similar saturation (or > 60 RGB units
 * away) is added as a `tone`, and every share is rescaled so they still sum to 1.
 */
export function recoverSaturated(frames: readonly PixelFrame[], palette: readonly PaletteColor[], options: { minShare?: number; maxPixels?: number } = {}): PaletteColor[] {
	const pixels = samplePixels(frames, options.maxPixels ?? 24_000);
	if (!pixels.length) return [...palette];
	const loud = pixels.filter((p) => {
		const { s } = rgbToHsl(p);
		const y = luma(p);
		return s > 0.45 && y > 0.1 && y < 0.85;
	});
	if (loud.length < 8) return [...palette];
	const minShare = options.minShare ?? 0.002;
	const added: PaletteColor[] = [];
	// hue peaks, not k-means: the many lightness shades of one big saturated colour (a mustard paper with a vignette)
	// take every k-means centre and swallow a small red (MEASURED 2026-10-20: k = 4 merged it, k = 8 found it)
	const BIN = 10;
	const bins = Array.from({ length: 36 }, () => ({ count: 0, r: 0, g: 0, b: 0 }));
	for (const p of loud) {
		const bin = bins[Math.floor(rgbToHsl(p).h / BIN) % 36] as { count: number; r: number; g: number; b: number };
		bin.count++;
		bin.r += p[0];
		bin.g += p[1];
		bin.b += p[2];
	}
	const peaks: Array<{ center: Rgb; count: number }> = [];
	bins.forEach((bin, i) => {
		const prev = bins[(i + 35) % 36] as { count: number };
		const next = bins[(i + 1) % 36] as { count: number };
		if (!bin.count || bin.count < prev.count || bin.count < next.count) return;
		// the peak bin and its two neighbours make the colour
		const group = [prev, bin, next] as Array<{ count: number; r: number; g: number; b: number }>;
		const count = group.reduce((sum, item) => sum + item.count, 0);
		const center: Rgb = [0, 1, 2].map((c) => Math.round(group.reduce((sum, item) => sum + (c === 0 ? item.r : c === 1 ? item.g : item.b), 0) / count)) as Rgb;
		peaks.push({ center, count });
	});
	for (const { center, count } of peaks.sort((a, b) => b.count - a.count)) {
		const share = count / pixels.length;
		if (share < minShare) continue;
		const { h, s } = rgbToHsl(center);
		const known = [...palette, ...added].some((color) => {
			const close = Math.sqrt(dist2(color.rgb, center)) < 60;
			const sameHue = color.saturation > 0.3 && hueGap(color.hue, h) <= 18;
			return close || sameHue;
		});
		if (known) continue;
		added.push({ hex: toHex(center), rgb: center, share, luma: luma(center), saturation: s, hue: h, role: "tone" });
	}
	if (!added.length) return [...palette];
	const extra = added.reduce((sum, color) => sum + color.share, 0);
	const scale = Math.max(0, 1 - extra);
	return [...palette.map((color) => ({ ...color, share: color.share * scale })), ...added].sort((a, b) => b.share - a.share);
}

/**
 * Per reference: the share of its pixels nearest each palette colour (within 70 RGB units). The accent is the loud
 * colour that RECURS across references in small areas (outlines, routes, stamps), not the one that fills a frame.
 */
export function paletteCoverage(groups: ReadonlyArray<readonly PixelFrame[]>, palette: readonly PaletteColor[]): Array<{ presence: number; maxShare: number; avgShare: number }> {
	const stats = palette.map(() => ({ presence: 0, maxShare: 0, avgShare: 0, sum: 0 }));
	for (const frames of groups) {
		const pixels = samplePixels(frames, 6000);
		if (!pixels.length) continue;
		const counts = palette.map(() => 0);
		for (const p of pixels) {
			let best = -1;
			let bestD = 70 * 70;
			palette.forEach((color, c) => {
				const d = dist2(color.rgb, p);
				if (d < bestD) {
					bestD = d;
					best = c;
				}
			});
			if (best >= 0) counts[best] = (counts[best] as number) + 1;
		}
		counts.forEach((count, c) => {
			const share = count / pixels.length;
			const stat = stats[c] as { presence: number; maxShare: number; sum: number };
			if (share >= 0.003) {
				stat.presence++;
				stat.sum += share;
			}
			stat.maxShare = Math.max(stat.maxShare, share);
		});
	}
	return stats.map((stat) => ({ presence: stat.presence, maxShare: stat.maxShare, avgShare: stat.presence ? stat.sum / stat.presence : 0 }));
}

/** Luma plane (0–255) of a frame. */
export function lumaPlane(frame: PixelFrame): Float32Array {
	const n = Math.floor(frame.data.length / 4);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const j = i * 4;
		out[i] = 0.2126 * (frame.data[j] as number) + 0.7152 * (frame.data[j + 1] as number) + 0.0722 * (frame.data[j + 2] as number);
	}
	return out;
}

/**
 * Grain: the mean high-frequency residual (|4·L − neighbours| / 4, 0–255) over FLAT pixels only (local gradient
 * < 14), so edges and text do not count as texture. Undefined when the frame has no flat area.
 */
export function grainOf(frame: PixelFrame): number | undefined {
	const { width: w, height: h } = frame;
	if (w < 3 || h < 3) return undefined;
	const L = lumaPlane(frame);
	let sum = 0;
	let n = 0;
	for (let y = 1; y < h - 1; y++) {
		for (let x = 1; x < w - 1; x++) {
			const i = y * w + x;
			const up = L[i - w] as number;
			const down = L[i + w] as number;
			const left = L[i - 1] as number;
			const right = L[i + 1] as number;
			const gradient = Math.max(Math.abs(right - left), Math.abs(down - up)) / 2;
			if (gradient >= 14) continue;
			sum += Math.abs(4 * (L[i] as number) - up - down - left - right) / 4;
			n++;
		}
	}
	return n >= 16 ? sum / n : undefined;
}

/**
 * Grain at three scales (explainer-v2, 2026-10-20): the robust spread (1.4826 × median |L − 5×5 mean|) of the luma
 * over locally flat pixels, at the native size, ½ and ¼ (2×2 area steps); the frame's grain is the largest of the three.
 * Why: `grainOf` (a 1-pixel Laplacian over pixels whose gradient is < 14) read the recreation's grainy paper as
 * "clean" (1.13 / 0.77): blurred paper noise lives at 2–4 px, and strong grain pushes pixels over the gradient cut-off.
 * Measured on the synthetic references (MEASURED 2026-10-20): drawn flat colour 0.00 at every scale; ffmpeg paper
 * noise 1.3–3.3; heavy paper 6–14; a halftone sheet ≈ 90 (a print texture). Undefined when nothing is flat.
 */
export function grainBands(frame: PixelFrame): { bands: number[]; grain: number } | undefined {
	let L = lumaPlane(frame);
	let w = frame.width;
	let h = frame.height;
	const bands: number[] = [];
	for (let scale = 0; scale < 3; scale++) {
		if (w < 9 || h < 9) break;
		const residuals: number[] = [];
		for (let y = 2; y < h - 2; y++) {
			for (let x = 2; x < w - 2; x++) {
				const i = y * w + x;
				// flat at this scale: the 4-px central differences stay small (edges and text do not count as grain)
				const gradient = Math.max(Math.abs((L[i + 2] as number) - (L[i - 2] as number)), Math.abs((L[i + 2 * w] as number) - (L[i - 2 * w] as number))) / 4;
				if (gradient > 6) continue;
				let sum = 0;
				for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) sum += L[i + dy * w + dx] as number;
				residuals.push(Math.abs((L[i] as number) - sum / 25));
			}
		}
		if (residuals.length >= 32) {
			residuals.sort((a, b) => a - b);
			bands.push(1.4826 * (residuals[Math.floor(residuals.length / 2)] as number));
		}
		// 2×2 area step down
		const W = w >> 1;
		const H = h >> 1;
		const next = new Float32Array(W * H);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const a = 2 * y * w + 2 * x;
				next[y * W + x] = ((L[a] as number) + (L[a + 1] as number) + (L[a + w] as number) + (L[a + w + 1] as number)) / 4;
			}
		}
		L = next;
		w = W;
		h = H;
	}
	if (!bands.length) return undefined;
	return { bands, grain: Math.max(...bands) };
}

/** 24-bin RGB histogram (8 per channel), normalised. */
export function histogram(frame: PixelFrame): Float32Array {
	const out = new Float32Array(24);
	let n = 0;
	for (let i = 0; i + 3 < frame.data.length; i += 4) {
		out[(frame.data[i] as number) >> 5] += 1;
		out[8 + ((frame.data[i + 1] as number) >> 5)] += 1;
		out[16 + ((frame.data[i + 2] as number) >> 5)] += 1;
		n++;
	}
	if (n) for (let i = 0; i < 24; i++) out[i] = (out[i] as number) / (3 * n);
	return out;
}

/** Half the L1 distance of two histograms: 0 = same colours, 1 = nothing in common. */
export function histogramDistance(a: Float32Array, b: Float32Array): number {
	let d = 0;
	for (let i = 0; i < a.length; i++) d += Math.abs((a[i] as number) - (b[i] as number));
	return d / 2;
}

/** Mean absolute luma difference of two same-size frames, 0–1. */
export function frameDifference(a: PixelFrame, b: PixelFrame): number | undefined {
	if (a.width !== b.width || a.height !== b.height) return undefined;
	const la = lumaPlane(a);
	const lb = lumaPlane(b);
	let sum = 0;
	for (let i = 0; i < la.length; i++) sum += Math.abs((la[i] as number) - (lb[i] as number));
	return la.length ? sum / la.length / 255 : undefined;
}
