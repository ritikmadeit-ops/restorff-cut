/**
 * Face-aware caption zones (captions-v2 agent, 2026-10-20; recreations gap 4/6, warm-moody REPORT §5 item 14:
 * "captions sit over the mouth", effects-library E-2: "caption zones ignore faces (lower = y 0.59, on the eyes)").
 *
 * The face model is effects-v2's shared one (server/matte-face-span.ts `faceSpanOnCanvas`: the face track of the
 * footage clip under a span, mapped to the canvas; server/matte-placement.ts `keepOutOf`: the p10/p90 face envelope +
 * 2 % margin) — the same box effects keep out of. This file only chooses the caption LINE: the style's own line when
 * its box misses the keep-out box, else just below the chin, else just above the brow — whichever fits inside the
 * caption safe area and is nearest the style's line — else the one that overlaps least. All pieces of one take (one
 * media file) share one line, so captions don't jump between chunks or across a cut.
 */
import type { ProjectSnapshot, SnapshotElement } from "@/sync/snapshot";
import { faceSpanOnCanvas, footageClipOver } from "./matte-face-span";
import { keepOutOf, rectBottom, rectRight, type Rect } from "./matte-placement";

/** A face region on the canvas, px (origin top-left). */
export interface FaceBand {
	x0: number;
	x1: number;
	y0: number;
	y1: number;
	/** Frames the band was made from. */
	frames: number;
}

export interface Placement {
	/** Caption centre, canvas px from the top. */
	y: number;
	where: "style" | "below" | "above" | "least-overlap";
	/** px of the caption box that still overlaps the (padded) face, 0 when clear. */
	overlap: number;
}

/**
 * A caption line clear of a face band: the preferred line when its box misses it, else the nearest of "just below"
 * / "just above" that fits inside [top, bottom] (the caption safe area), else the one that overlaps least. The band
 * is padded by `padding` (fractions of its height: default 10 % above for the brow, 15 % below for the chin; pass 0
 * for a band that already has its margin, like effects-v2's keep-out box). `halfHeight` / `halfWidth` / `cx` are the
 * caption box's (px).
 */
export function placeClearOf(
	band: FaceBand | null,
	box: { halfHeight: number; halfWidth: number; cx: number },
	area: { top: number; bottom: number },
	preferredY: number,
	margin = 16,
	padding: { top: number; bottom: number } = { top: 0.1, bottom: 0.15 },
): Placement {
	const clampY = (y: number) => Math.min(area.bottom - box.halfHeight, Math.max(area.top + box.halfHeight, y));
	const preferred = clampY(preferredY);
	if (!band) return { y: preferred, where: "style", overlap: 0 };
	const h = band.y1 - band.y0;
	const avoid = { y0: band.y0 - padding.top * h, y1: band.y1 + padding.bottom * h };
	// a line that doesn't reach the face horizontally is fine wherever it is
	if (box.cx + box.halfWidth < band.x0 || box.cx - box.halfWidth > band.x1) return { y: preferred, where: "style", overlap: 0 };
	const overlapAt = (y: number) => Math.max(0, Math.min(y + box.halfHeight, avoid.y1) - Math.max(y - box.halfHeight, avoid.y0));
	if (overlapAt(preferred) === 0) return { y: preferred, where: "style", overlap: 0 };
	const below = avoid.y1 + box.halfHeight + margin;
	const above = avoid.y0 - box.halfHeight - margin;
	const fits = (y: number) => y + box.halfHeight <= area.bottom + 0.5 && y - box.halfHeight >= area.top - 0.5;
	const options: Placement[] = [];
	if (fits(below)) options.push({ y: below, where: "below", overlap: 0 });
	if (fits(above)) options.push({ y: above, where: "above", overlap: 0 });
	if (options.length) return options.sort((a, b) => Math.abs(a.y - preferredY) - Math.abs(b.y - preferredY))[0];
	const squeezed = [clampY(below), clampY(above)].map((y) => ({ y, where: "least-overlap" as const, overlap: overlapAt(y) }));
	return squeezed.sort((a, b) => a.overlap - b.overlap || Math.abs(a.y - preferredY) - Math.abs(b.y - preferredY))[0];
}

/** The footage clip (and its media) under a timeline moment — effects-v2's rule (main track first, not cut-outs). */
export function footageAt(snapshot: ProjectSnapshot, t: number): SnapshotElement | null {
	return footageClipOver(snapshot, t, t + 1 / 30);
}

export interface FaceKeepOut {
	/** The keep-out band on the canvas, px (effects-v2 keepOutOf: envelope + 2 % margin). */
	band: FaceBand;
	clips: number;
}

/**
 * The keep-out band of one media file over the given pieces: each piece's face span over its own chunks (source
 * times through that piece), keep-out boxes joined. `missing` = the media has no face track (no cutout matte yet).
 */
export async function keepOutForPieces(
	projectId: string,
	snapshot: ProjectSnapshot,
	pieces: Array<{ clip: SnapshotElement; from: number; to: number }>,
): Promise<{ keepOut: FaceKeepOut | null; missing: boolean }> {
	const canvas = { width: snapshot.settings?.canvasSize?.width ?? 1080, height: snapshot.settings?.canvasSize?.height ?? 1920 };
	let joined: Rect | null = null;
	let frames = 0;
	let clips = 0;
	let missing = false;
	for (const piece of pieces) {
		const answer = await faceSpanOnCanvas({ projectId, snapshot, from: piece.from, to: piece.to, clip: piece.clip });
		if (!answer.ok) {
			if (answer.reason === "no_matte") missing = true;
			continue;
		}
		const keep = keepOutOf(answer.span, canvas);
		frames += answer.span.frames;
		clips++;
		if (!joined) joined = keep;
		else {
			const left = Math.min(joined.left, keep.left);
			const top = Math.min(joined.top, keep.top);
			const right = Math.max(rectRight(joined), rectRight(keep));
			const bottom = Math.max(rectBottom(joined), rectBottom(keep));
			joined = { left, top, width: right - left, height: bottom - top };
		}
	}
	if (!joined) return { keepOut: null, missing };
	return {
		keepOut: {
			band: { x0: joined.left * canvas.width, x1: rectRight(joined) * canvas.width, y0: joined.top * canvas.height, y1: rectBottom(joined) * canvas.height, frames },
			clips,
		},
		missing,
	};
}
