/**
 * Face-safe placement of rendered overlays (effects-v2 agent, 2026-10-20; SUMMARY gap 6, recreation E-2).
 *
 *   overlayAlpha(file)   the alpha of a rendered composition (VP9-with-alpha WebM) as small gray frames (FFmpeg)
 *   planMove(…)          after a render: is the overlay on the face? If so, which props move it off — drop a known
 *                        display-text prop (doodle-boil word, ui-world callouts), shift `offsetY` by the smallest
 *                        move that clears the face (matte-placement bestShift), or shrink `scale` when it fits
 *                        nowhere; never a prop the caller set. The caller re-renders (cached by props) and asks again.
 *
 * Only layers that can cover the face are measured: overlays on top and `front` layers above the person cutout.
 * Layers under the cutout are behind the person by construction. FFmpeg: $RESTORFFCUT_FFMPEG, else on PATH.
 */
import { spawn } from "node:child_process";
import {
	type AlphaFrames,
	bestShift,
	FACE_CLEAR_MAX,
	type OverlapReport,
	overlapReport,
	type Rect,
	rectBottom,
	rectRight,
	rowProfile,
	type SafeBand,
	zonesAround,
} from "./matte-placement";

const FFMPEG = () => process.env.RESTORFFCUT_FFMPEG?.trim() || "ffmpeg";

function runBytes(args: string[], signal?: AbortSignal, timeoutMs = 60_000): Promise<{ code: number; out: Buffer; err: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(FFMPEG(), args, { windowsHide: true, signal, timeout: timeoutMs });
		const chunks: Buffer[] = [];
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			err = (err + chunk.toString()).slice(-3000);
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code: code ?? 1, out: Buffer.concat(chunks), err }));
	});
}

/** Width of the measured frames (a 1080-wide canvas → 135 px: 8 canvas px per sample). */
export const MEASURE_WIDTH = 135;

/**
 * The overlay's alpha, `fps` frames a second (at most `maxFrames`), MEASURE_WIDTH wide, canvas aspect. Null when the
 * file has no alpha plane (an opaque full-frame render: it covers the face by design).
 */
export async function overlayAlpha(
	file: string,
	canvas: { width: number; height: number },
	opts: { fps?: number; maxFrames?: number; signal?: AbortSignal } = {},
): Promise<AlphaFrames | null> {
	const width = MEASURE_WIDTH;
	const height = Math.max(2, Math.round((width * canvas.height) / canvas.width));
	const fps = opts.fps ?? 8;
	const maxFrames = opts.maxFrames ?? 48;
	const args = ["-v", "error", "-c:v", "libvpx-vp9", "-i", file, "-vf", `fps=${fps},alphaextract,scale=${width}:${height}:flags=area`, "-frames:v", String(maxFrames), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"];
	const got = await runBytes(args, opts.signal);
	if (got.code !== 0) {
		if (/alpha|planes|alphaextract/i.test(got.err)) return null;
		throw new Error(`ffmpeg could not read the overlay's alpha: ${got.err.slice(-300).trim()}`);
	}
	const size = width * height;
	const frames: Uint8Array[] = [];
	for (let offset = 0; offset + size <= got.out.byteLength; offset += size) frames.push(new Uint8Array(got.out.buffer, got.out.byteOffset + offset, size));
	if (!frames.length) throw new Error("ffmpeg returned no frames for the overlay");
	return { width, height, frames };
}

/** Display text that may be dropped (set empty) when it lands on the face and the caller did not set it. */
export const DROPPABLE_TEXT: Record<string, Record<string, unknown>> = {
	"doodle-boil": { word: "" },
	"ui-world": { callouts: [] },
};

type ParamSpec = { type?: string; default?: unknown; min?: number; max?: number };

export interface MoveDecision {
	/** Props to change (re-render with them), or null = keep as is. */
	change: Record<string, unknown> | null;
	why: string;
	report: OverlapReport;
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
const clampTo = (value: number, spec: ParamSpec | undefined) => Math.min(spec?.max ?? Number.POSITIVE_INFINITY, Math.max(spec?.min ?? Number.NEGATIVE_INFINITY, value));

/**
 * One step of the placement loop for a rendered overlay. `given` = the params the caller set (never moved).
 * `face` is the face box on the canvas (moved like the clip when the effect keys it); `keepOut` the box to clear.
 */
export function planMove({
	composition,
	alpha,
	face,
	keepOut,
	safe,
	props,
	params,
	given,
	canvas,
	tried,
}: {
	composition: string;
	alpha: AlphaFrames | null;
	face: Rect;
	keepOut: Rect;
	safe: SafeBand;
	props: Record<string, unknown>;
	params: Record<string, ParamSpec>;
	given: Set<string>;
	canvas: { width: number; height: number };
	/** Moves already made in this loop (so it never repeats one). */
	tried: Set<string>;
}): MoveDecision {
	const report = overlapReport(alpha, face, keepOut);
	if (report.clear) return { change: null, why: "clear of the face", report };
	if (!alpha) return { change: null, why: "an opaque full-frame render covers the face by design", report };
	// 1. display text that can go (and is not the caller's)
	const droppable = DROPPABLE_TEXT[composition];
	if (droppable && !tried.has("drop")) {
		const change: Record<string, unknown> = {};
		for (const [key, empty] of Object.entries(droppable)) if (!given.has(key) && !isEmpty(props[key])) change[key] = empty;
		if (Object.keys(change).length) {
			tried.add("drop");
			return { change, why: `${Object.keys(change).join(", ")} landed on the face: dropped (set it yourself to keep it)`, report };
		}
	}
	const u = Math.min(canvas.width, canvas.height) / 1080;
	const offsetSpec = params.offsetY;
	const canShift = offsetSpec?.type === "number" && !given.has("offsetY") && !given.has("anchor");
	const box = report.bbox;
	if (!box) return { change: null, why: "nothing drawn", report };
	// 2. the smallest vertical move that clears the face's columns
	if (canShift && !tried.has("shift")) {
		const profile = rowProfile(alpha, { left: keepOut.left, right: rectRight(keepOut) });
		const shift = bestShift({ profile, keepOut, box, safe });
		const current = typeof props.offsetY === "number" ? props.offsetY : typeof offsetSpec.default === "number" ? offsetSpec.default : 0;
		if (shift.dy !== 0 && (shift.fits || shift.rows_on_face_after < shift.rows_on_face_before)) {
			const wanted = current + (shift.dy * canvas.height) / u;
			const next = Math.round(clampTo(wanted, offsetSpec));
			if (next !== current) {
				tried.add("shift");
				return {
					change: { offsetY: next },
					why: `moved ${shift.dy < 0 ? "up" : "down"} ${Math.abs(Math.round(shift.dy * canvas.height))} px (offsetY ${current} → ${next})${shift.fits ? "" : ": the closest it gets, still partly on the face"}${next !== Math.round(wanted) ? " (offsetY at its limit)" : ""}`,
					report,
				};
			}
		}
		tried.add("shift");
	}
	// 3. too tall for the free band: shrink it to the larger zone, then shift again
	const scaleSpec = params.scale;
	if (canShift && scaleSpec?.type === "number" && !given.has("scale") && !tried.has("scale")) {
		const zones = zonesAround(keepOut, safe);
		const room = zones.reduce((best, zone) => Math.max(best, zone.to - zone.from), 0);
		const current = typeof props.scale === "number" ? props.scale : typeof scaleSpec.default === "number" ? scaleSpec.default : 1;
		if (room > 0.05 && box.height > room) {
			const next = Math.round(clampTo(current * (room / box.height) * 0.92, scaleSpec) * 100) / 100;
			if (next < current) {
				tried.add("scale");
				tried.delete("shift");
				return { change: { scale: next }, why: `too tall for the free band (${Math.round(box.height * 100)} % of the height, ${Math.round(room * 100)} % free): scale ${current} → ${next}, then moved`, report };
			}
		}
		tried.add("scale");
	}
	const covered = Math.round(report.face_covered * 100);
	return {
		change: null,
		why: canShift
			? `still covers ${covered} % of the face box; no move clears it inside the safe area`
			: `covers ${covered} % of the face box and ${composition} has no free position param here${given.has("offsetY") || given.has("anchor") ? " (you set offsetY/anchor)" : ""}`,
		report,
	};
}

/** Short view of a report for answers (fractions of the canvas). */
export function reportView(report: OverlapReport, extra: Record<string, unknown> = {}) {
	return {
		bbox: report.bbox,
		face: report.face,
		face_covered: report.face_covered,
		bbox_overlap: report.bbox_overlap,
		clear: report.clear,
		...extra,
	};
}

export { FACE_CLEAR_MAX, rectBottom };
