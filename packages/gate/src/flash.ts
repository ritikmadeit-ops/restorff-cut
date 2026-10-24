/**
 * FLASH (gate-v2, 2026-10-20): frames from a different picture lasting 1–3 frames at a cut. The recreations shipped
 * 2-frame flashes through a passing gate (explainer-overlay: autocut's pad kept 1–2 frames of later footage at each
 * jump cut). Two halves:
 * - timeline (exact): a base-picture run of 1–3 frames between other pictures (changes.ts `flashes`);
 * - file (measured): on the encoded master, two big frame changes 1–3 frames apart with steady pictures before, inside
 *   and after — `detectFlashes` over the per-frame mean luma differences the server measures (ffmpeg → tiny grey
 *   frames). A whip or a dissolve changes every frame, so it never matches; a designed flash (a flash transition, a
 *   flash inside a composition's own render) is filtered by `filterDesignedFlashes`.
 * Pure.
 */
import { storedComposition } from "./compositions.ts";
import { elEnd, elStart, fpsOf, pickScene, ticksToSeconds, videoElements } from "./project.ts";
import type { CompositionFacts, FlashMeasure, GateProject } from "./types.ts";

export interface FlashDetectOptions {
	fps: number;
	/** Longest flash, frames (default 3). */
	maxFrames?: number;
	/** A change is big when ≥ max(minDiff, ratio × the local median). Defaults 6 and 3.5 (ASSUMPTION, tuned on the recreations). */
	minDiff?: number;
	ratio?: number;
	/** Only flashes within `nearS` seconds of one of these times (the timeline's cuts). Omit to look everywhere. */
	near?: number[];
	nearS?: number;
}

function median(values: number[]): number {
	if (!values.length) return 0;
	const s = [...values].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * `diffs[i]` = mean absolute luma difference (0..255) between frame i and frame i + 1, i.e. the change that frame
 * i + 1 brings. Returns the flashes: frames i + 1 … j shown between two big changes (diffs[i], diffs[j]).
 */
export function detectFlashes(diffs: number[], opts: FlashDetectOptions): FlashMeasure[] {
	const fps = opts.fps || 30;
	const maxF = opts.maxFrames ?? 3;
	const minDiff = opts.minDiff ?? 6;
	const ratio = opts.ratio ?? 3.5;
	const n = diffs.length;
	const local: number[] = new Array(n);
	const W = 15;
	for (let i = 0; i < n; i++) local[i] = Math.max(0.5, median(diffs.slice(Math.max(0, i - W), Math.min(n, i + W + 1))));
	const big = (i: number) => i >= 0 && i < n && diffs[i] >= Math.max(minDiff, ratio * local[i]);
	const out: FlashMeasure[] = [];
	for (let i = 0; i < n; i++) {
		if (!big(i) || big(i - 1)) continue;
		for (let j = i + 1; j <= Math.min(n - 1, i + maxF); j++) {
			if (!big(j)) continue;
			let steadyInside = true;
			for (let k = i + 1; k < j; k++) if (big(k)) steadyInside = false;
			// a whip changes every frame: inside frames must be steady; a 1-frame flash also needs a steady frame after
			if (!steadyInside || (j - i === 1 && big(j + 1))) break;
			const t = (i + 1) / fps;
			const t_end = (j + 1) / fps;
			if (opts.near?.length) {
				const reach = opts.nearS ?? (maxF + 1) / fps;
				if (!opts.near.some((c) => c >= t - reach - 1e-6 && c <= t_end + reach + 1e-6)) break;
			}
			out.push({ t, t_end, frames: j - i, in_diff: round1(diffs[i]), out_diff: round1(diffs[j]), median_diff: round1(local[i]) });
			i = j; // the leaving change is not a new flash's entry
			break;
		}
	}
	return out;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Under this mean luma (0..255) the flash frames are black: a black frame is never "designed". */
export const BLACK_LUMA = 12;

/**
 * Drop measured flashes the cut means to have:
 * - inside a transition window on a clip (a flash / whip transition);
 * - where a composition on screen animates fast in its own render at that moment (`CompositionFacts.motion` /
 *   `flashes`, local times): any time for the composition that IS the picture; only in its first or last 0.3 s for an
 *   overlay (a stamp's slam, a card's exit), so an overlay animating over a jump cut does not excuse the cut.
 * A black flash frame is never excused (a composition whose frame 0 is empty is a defect, not a design).
 */
export function filterDesignedFlashes(
	flashes: FlashMeasure[],
	project: GateProject,
	compositions?: Record<string, CompositionFacts>,
	sceneId?: string,
): { kept: FlashMeasure[]; designed: Array<FlashMeasure & { why: string }> } {
	const scene = pickScene(project, sceneId);
	if (!scene) return { kept: flashes, designed: [] };
	const kept: FlashMeasure[] = [];
	const designed: Array<FlashMeasure & { why: string }> = [];
	const placed = videoElements(scene);
	const frame = 1 / (fpsOf(project) || 30);
	for (const f of flashes) {
		let why: string | null = null;
		if (f.luma !== undefined && f.luma < BLACK_LUMA) {
			kept.push(f);
			continue;
		}
		const faceRegion = f.region === "face";
		for (const p of placed) {
			const el = p.el;
			const tr = (el as { transitionIn?: { type?: string; duration?: number } }).transitionIn;
			if (tr && typeof tr.duration === "number") {
				const half = tr.duration / 120_000 / 2;
				const cut = elStart(el);
				if (f.t >= cut - half - 0.05 && f.t_end <= cut + half + 0.05) {
					why = `inside the ${tr.type ?? "transition"} into ${el.name ?? el.id}`;
					break;
				}
			}
			const comp = storedComposition(el);
			if (!comp || f.t_end <= elStart(el) - frame || f.t >= elEnd(el) + frame) continue;
			const facts = compositions?.[el.id] ?? (el.mediaId ? compositions?.[el.mediaId] : undefined);
			if (!facts) continue;
			const edge = f.t - elStart(el) <= 0.3 + frame || elEnd(el) - f.t_end <= 0.3 + frame;
			const isBase = facts.opaque === true;
			// a flash measured on the face is the speaker's picture: an overlay animating elsewhere does not excuse it
			if (!isBase && (!edge || faceRegion)) continue;
			const rate = el.retime?.rate || 1;
			const toLocal = (t: number) => ticksToSeconds(el.trimStart ?? 0) + (t - elStart(el)) * rate;
			const a = toLocal(f.t) - 2 * frame;
			const b = toLocal(f.t_end) + 2 * frame;
			const moving = (facts.motion ?? []).some(([x, y]) => x <= b && y >= a) || (facts.flashes ?? []).some((x) => x >= a && x <= b);
			if (moving) {
				why = `"${comp.name ?? el.name}" animates there in its own render (${isBase ? "the composition is the picture" : edge ? "the overlay's entrance or exit" : "designed"})`;
				break;
			}
		}
		if (why) designed.push({ ...f, why });
		else kept.push(f);
	}
	return { kept, designed };
}
