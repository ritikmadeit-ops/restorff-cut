/**
 * FACE (gate-v2, 2026-10-20): no overlay over the speaker's face. The face box comes from the server's person matte
 * (apps/web/src/server/matte.ts getFaceBoxes: [x, y, w, h] in 0..1 of the SOURCE frame at SOURCE times), mapped onto
 * the canvas through the clip's placement; an overlay's box comes from the text measurer (text), the server's alpha
 * grid of a composition's own render (compositions), or the media size (pictures).
 *
 * ASSUMPTIONs: a clip is drawn "contain"-fitted at scale 1, centred, then scaled and moved by its transform at that
 * moment (keyframes followed linearly; rotation ignored); the face box is the detector's largest face.
 */
import { alphaCoverage, alphaFrameAt } from "./compositions.ts";
import { elEnd, elStart, ticksToSeconds } from "./project.ts";
import type { CompositionFacts, FaceTrackLite, GateElement } from "./types.ts";

export type Box01 = [number, number, number, number]; // x0, y0, x1, y1 in 0..1 of the canvas

function num(v: unknown, d: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/**
 * A transform param at timeline time t, following its keyframes (element-local ticks; linear between keys — the
 * editor eases with beziers, ASSUMPTION: close enough for a face box), else the base param.
 */
export function paramAt(el: GateElement, key: string, t: number, fallback: number): number {
	const channel = el.animations?.[key] as { keys?: Array<{ time: number; value: unknown }> } | undefined;
	const keys = (channel?.keys ?? []).filter((k) => typeof k.value === "number").sort((a, b) => a.time - b.time);
	if (!keys.length) return num(el.params?.[key], fallback);
	const local = (t - elStart(el)) * 120_000;
	if (local <= keys[0].time) return keys[0].value as number;
	const last = keys[keys.length - 1];
	if (local >= last.time) return last.value as number;
	for (let i = 0; i < keys.length - 1; i++) {
		const a = keys[i];
		const b = keys[i + 1];
		if (local >= a.time && local <= b.time) {
			const f = b.time > a.time ? (local - a.time) / (b.time - a.time) : 0;
			return (a.value as number) + ((b.value as number) - (a.value as number)) * f;
		}
	}
	return last.value as number;
}

/** The face box at timeline time t under a clip, in 0..1 of the canvas (null when no face at that moment). */
export function faceOnCanvas(
	clip: GateElement,
	track: FaceTrackLite,
	t: number,
	canvas: { width: number; height: number },
): Box01 | null {
	if (!track.frames.length) return null;
	const rate = clip.retime?.rate || 1;
	const src = ticksToSeconds(clip.trimStart ?? 0) + (t - elStart(clip)) * rate;
	// nearest frame (frames are sorted by t)
	let lo = 0;
	let hi = track.frames.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (track.frames[mid].t < src) lo = mid + 1;
		else hi = mid;
	}
	const cands = [track.frames[lo], track.frames[lo - 1]].filter(Boolean);
	const frame = cands.sort((a, b) => Math.abs(a.t - src) - Math.abs(b.t - src))[0];
	if (!frame?.box || Math.abs(frame.t - src) > 0.5) return null;
	const { width: W, height: H } = track.source;
	if (!W || !H) return null;
	const contain = Math.min(canvas.width / W, canvas.height / H);
	const dw = W * contain * Math.abs(paramAt(clip, "transform.scaleX", t, 1));
	const dh = H * contain * Math.abs(paramAt(clip, "transform.scaleY", t, 1));
	const left = canvas.width / 2 + paramAt(clip, "transform.positionX", t, 0) - dw / 2;
	const top = canvas.height / 2 + paramAt(clip, "transform.positionY", t, 0) - dh / 2;
	const [x, y, w, h] = frame.box;
	const box: Box01 = [
		(left + x * dw) / canvas.width,
		(top + y * dh) / canvas.height,
		(left + (x + w) * dw) / canvas.width,
		(top + (y + h) * dh) / canvas.height,
	];
	return box[2] > 0 && box[0] < 1 && box[3] > 0 && box[1] < 1 ? box : null;
}

/** Share of the face box (0..1) that a box covers. */
export function boxCoverage(face: Box01, over: Box01): number {
	const w = Math.max(0, Math.min(face[2], over[2]) - Math.max(face[0], over[0]));
	const h = Math.max(0, Math.min(face[3], over[3]) - Math.max(face[1], over[1]));
	const area = (face[2] - face[0]) * (face[3] - face[1]);
	return area > 0 ? (w * h) / area : 0;
}

/** Share of the face covered by a composition's visible pixels at timeline time t (null when not measured). */
export function compositionFaceCoverage(el: GateElement, facts: CompositionFacts, face: Box01, t: number): number | null {
	const a = facts.alpha;
	if (!a) return null;
	const rate = el.retime?.rate || 1;
	const local = ticksToSeconds(el.trimStart ?? 0) + (t - elStart(el)) * rate;
	const grid = alphaFrameAt(facts, local);
	if (!grid) return null;
	return alphaCoverage(grid, a.cols, a.rows, face);
}

/** Sample times across [a, b) at `step` seconds (always includes a). */
export function sampleTimes(a: number, b: number, step = 0.1): number[] {
	const out: number[] = [];
	for (let t = a; t < b - 1e-9; t += step) out.push(Math.round(t * 1000) / 1000);
	return out;
}

/** Runs of consecutive samples where `hit` holds: [{t, t_end, peak}]. */
export function runsOf(samples: Array<{ t: number; v: number }>, threshold: number, step: number): Array<{ t: number; t_end: number; peak: number }> {
	const out: Array<{ t: number; t_end: number; peak: number }> = [];
	let open: { t: number; t_end: number; peak: number } | null = null;
	for (const s of samples) {
		if (s.v >= threshold) {
			if (open && s.t - open.t_end <= step * 1.5) {
				open.t_end = s.t + step;
				open.peak = Math.max(open.peak, s.v);
			} else {
				if (open) out.push(open);
				open = { t: s.t, t_end: s.t + step, peak: s.v };
			}
		}
	}
	if (open) out.push(open);
	return out;
}

export function within(el: GateElement, t: number): boolean {
	return elStart(el) <= t + 1e-9 && t < elEnd(el) - 1e-9;
}
