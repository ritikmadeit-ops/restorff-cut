/**
 * Face-safe placement — the I/O half (effects-v2 agent, 2026-10-20): the speaker's face over a span of a TIMELINE, on
 * the canvas. Reads the face track the server matte job wrote (server/matte.ts `getFaceBoxes`, restorffcut-faces@1),
 * maps the window's timeline seconds to source seconds through the clip (start, trims, retime) and the boxes onto the
 * canvas through the clip's drawn rect (its base transform; keyframes are not followed — callers that key the clip
 * move the result with `moveRect`). Pure maths: ./matte-placement.ts.
 *
 * For other tools (captions-v2: face-aware zones):
 *   const got = await faceSpanOnCanvas({ projectId, snapshot, from: 2.0, to: 3.4 });
 *   if (got.ok) { const keep = keepOutOf(got.span, canvas); const zones = zonesAround(keep, safeBandFor(canvas)); }
 *   else got.reason  // no_clip · no_media · no_matte (start one: cutout matte, or start: true) · no_faces
 */
import type { ProjectSnapshot, SnapshotElement } from "@/sync/snapshot";
import { type FaceTrack, getFaceBoxes, type MatteJob, projectMediaRecord, startMatteJob } from "./matte";
import { type FaceSpan, faceSpanFrom, type Rect, roundRect, type SourceBox } from "./matte-placement";
import { activeScene, canvasOf, drawnRect, rateOf, TICKS } from "./matte-presets";

export type FaceSpanAnswer =
	| {
			ok: true;
			span: FaceSpan;
			clip_id: string;
			media_hash: string;
			/** Source seconds the window covers. */
			source: { from: number; to: number };
			track: FaceTrack;
	  }
	| { ok: false; reason: "no_clip" | "no_media" | "no_matte" | "no_faces"; clip_id?: string; media_id?: string; matte_job?: Pick<MatteJob, "job_id" | "state"> | null; started?: boolean };

const isDerived = (element: SnapshotElement) => {
	const restorff = element.restorff as { cutout?: unknown; composition?: unknown } | undefined;
	return !!restorff?.cutout || !!restorff?.composition;
};

/** The footage clip (video, not a cutout/composition) that covers most of [from, to) — main track first. */
export function footageClipOver(snapshot: ProjectSnapshot, from: number, to: number): SnapshotElement | null {
	const scene = activeScene(snapshot);
	const a = Math.round(from * TICKS);
	const b = Math.max(a + 1, Math.round(to * TICKS));
	const tracks = [scene?.tracks?.main, ...(scene?.tracks?.overlay ?? []).filter((track) => track.type === "video" && !(track.name ?? "").toUpperCase().startsWith("MOTION"))];
	let best: { el: SnapshotElement; covered: number } | null = null;
	for (const track of tracks) {
		for (const el of track?.elements ?? []) {
			if (el.type !== "video" || isDerived(el)) continue;
			const covered = Math.min(b, el.startTime + el.duration) - Math.max(a, el.startTime);
			if (covered > 0 && (!best || covered > best.covered)) best = { el, covered };
		}
		if (best) break; // the main track (or the first footage track with a clip there) wins
	}
	return best?.el ?? null;
}

/** Source box [x, y, w, h] of a clip → canvas fractions, through the clip's drawn rect. */
export function sourceToCanvas(clip: SnapshotElement, source: { width: number; height: number }, canvas: { width: number; height: number }) {
	const rect = drawnRect(clip, source, canvas);
	return (box: SourceBox): Rect =>
		roundRect({
			left: (rect.left + box[0] * rect.width) / canvas.width,
			top: (rect.top + box[1] * rect.height) / canvas.height,
			width: (box[2] * rect.width) / canvas.width,
			height: (box[3] * rect.height) / canvas.height,
		});
}

/**
 * The face over timeline seconds [from, to] on the canvas, from the clip under the window (or `clip`). `start: true`
 * starts the clip's matte job when there is none (background; the answer says no_matte + started).
 */
export async function faceSpanOnCanvas({
	projectId,
	snapshot,
	from,
	to,
	clip,
	start = false,
}: {
	projectId: string;
	snapshot: ProjectSnapshot;
	from: number;
	to: number;
	clip?: SnapshotElement | null;
	start?: boolean;
}): Promise<FaceSpanAnswer> {
	const el = clip ?? footageClipOver(snapshot, from, to);
	if (!el) return { ok: false, reason: "no_clip" };
	const mediaId = String(el.mediaId ?? "");
	const media = mediaId ? await projectMediaRecord(projectId, mediaId).catch(() => null) : null;
	if (!media) return { ok: false, reason: "no_media", clip_id: el.id, media_id: mediaId };
	const track = getFaceBoxes(media.hash);
	if (!track) {
		let job: MatteJob | null = null;
		let started = false;
		if (start && media.mime.startsWith("video/")) {
			try {
				const answer = startMatteJob({ media });
				job = answer.job;
				started = answer.started;
			} catch {
				job = null;
			}
		}
		return { ok: false, reason: "no_matte", clip_id: el.id, media_id: mediaId, matte_job: job ? { job_id: job.job_id, state: job.state } : null, started };
	}
	const rate = rateOf(el);
	const startS = el.startTime / TICKS;
	const trimS = (el.trimStart ?? 0) / TICKS;
	const endS = (el.startTime + el.duration) / TICKS;
	const a = Math.max(from, startS);
	const b = Math.min(to, endS);
	const source = { from: trimS + (a - startS) * rate, to: trimS + (Math.max(a, b) - startS) * rate };
	const canvas = canvasOf(snapshot);
	const span = faceSpanFrom(track.frames, source.from, source.to, sourceToCanvas(el, track.source, canvas));
	if (!span) return { ok: false, reason: "no_faces", clip_id: el.id, media_id: mediaId };
	return { ok: true, span, clip_id: el.id, media_hash: media.hash, source: { from: Math.round(source.from * 1000) / 1000, to: Math.round(source.to * 1000) / 1000 }, track };
}
