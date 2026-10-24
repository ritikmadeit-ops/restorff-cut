/**
 * Server side of MCP `cutout reframe` (mcp-cutout agent, 2026-10-20; EDT-06 sizes): a 9:16 commit → the same cut at
 * 4:5 / 1:1 / 16:9, following the speaker's face. The rules are the cutout agent's auto-reframe
 * (`@/reframe/plan.ts`, documented in docs/restorff/worklog/cutout.md), ported from the editor's TimelineElement to
 * the commit snapshot and driven by the server face track (server/matte.ts) instead of the browser matte:
 *
 * - Full-frame video/image clips (scale ≈ 1, position ≈ 0) are scaled to COVER the new canvas and get one position
 *   key per second keeping the head at the size's anchor (REFRAME_SIZES[size].headAnchorY: 36–40 % from the top),
 *   moving average of 3, 1.2 % dead zone, clamped so the frame stays covered. Existing position keys are replaced.
 * - A cutout (element.restorff.cutout) gets exactly its source clip's transform, so it stays aligned.
 * - Text, captions, graphics, stickers and picture-in-picture keep their size and have their position (and position
 *   keys) scaled with the canvas; rectangles are re-stretched.
 * - Audio and effect layers are unchanged.
 * Head point per frame: the detector's main face box grown to a head (up 35 % for hair, 10 % each side), else the
 * segmenter's head (face + hair), else the top quarter of the person box, else (0.5, 0.4).
 *
 * Output = ops@1 (set_canvas, set, keyframe) run through the reducer, so the commit records what changed.
 */
import type { Op } from "@restorffcut/timeline-ops";
import { REFRAME_SIZES, type ReframeSizeId } from "@/reframe/sizes";
import { subjectSeries } from "@/segmentation/matte";
import type { Box, FrameBoxes, MatteHeader } from "@/segmentation/types";
import type { ProjectSnapshot, SnapshotElement, SnapshotTrack } from "@/sync/snapshot";
import type { FaceTrack } from "./matte";
import { activeScene, canvasOf, cutoutSourceOf, num, rateOf, TICKS } from "./matte-presets";

export type TargetSize = Exclude<ReframeSizeId, "9:16">;
export const TARGET_SIZES: TargetSize[] = ["4:5", "1:1", "16:9"];

/** Delivery preset per size (apps/web/src/export/presets.ts ids). */
export const DELIVERY_PRESET: Record<ReframeSizeId, string> = {
	"9:16": "vertical-1080x1920",
	"4:5": "portrait-1080x1350",
	"1:1": "square-1080x1080",
	"16:9": "landscape-1920x1080",
};

export function branchForSize(size: ReframeSizeId): string {
	return `reframe-${size.replace(":", "x")}`;
}

/** A detector face grown to a head box (hair above, ears at the sides). */
export function headFromFace(face: Box): Box {
	const x = Math.max(0, face[0] - face[2] * 0.1);
	const y = Math.max(0, face[1] - face[3] * 0.35);
	return [x, y, Math.min(1 - x, face[2] * 1.2), Math.min(1 - y, face[3] * 1.35)];
}

/** The face track as the MatteHeader that `subjectSeries` (segmentation/matte.ts) reads. */
export function faceHeader(track: FaceTrack): MatteHeader {
	const boxes: FrameBoxes[] = track.frames.map((frame) => {
		const face = frame.faces[0]?.box ?? null;
		return {
			person: frame.person,
			face: face ?? frame.face_seg,
			head: face ? headFromFace(face) : frame.head,
			coverage: frame.coverage,
		};
	});
	return {
		version: 1,
		model: "multiclass",
		delegate: "CPU",
		width: 0,
		height: 0,
		fps: track.fps,
		start: track.range.start,
		end: track.range.end,
		times: track.frames.map((frame) => frame.t),
		boxes,
		sourceWidth: track.source.width,
		sourceHeight: track.source.height,
		hasAlpha: false,
	};
}

export function isFullFrame(element: SnapshotElement, master: { width: number; height: number }): boolean {
	const scaleX = Math.abs(num(element.params, "transform.scaleX", 1));
	const scaleY = Math.abs(num(element.params, "transform.scaleY", 1));
	const x = Math.abs(num(element.params, "transform.positionX", 0));
	const y = Math.abs(num(element.params, "transform.positionY", 0));
	return scaleX >= 0.95 && scaleY >= 0.95 && Math.abs(scaleX - scaleY) < 0.05 && x <= master.width * 0.03 && y <= master.height * 0.03;
}

type ScalarChannel = { keys: Array<{ time: number; value: number }> };
const isScalar = (channel: unknown): channel is ScalarChannel => !!channel && Array.isArray((channel as ScalarChannel).keys);
const s3 = (seconds: number) => Math.round(seconds * 1000) / 1000;

export interface ReframePlan {
	ops: Op[];
	/** Snapshot edits made BEFORE the reducer runs (on a copy): position channels removed from tracked clips. */
	prepare: (snapshot: ProjectSnapshot) => void;
	/** After the reducer: delivery setting. */
	finish: (snapshot: ProjectSnapshot) => void;
	tracked: Array<{ element_id: string; name: string; keys: number; media_id: string; face_found: number | null; scale: number }>;
	scaled: number;
	notes: string[];
}

/**
 * `facesFor(mediaId)` → the face track of that media (null = none: the clip is centred on its upper third, like the
 * editor does without a matte).
 */
export function planReframe({
	snapshot,
	size,
	facesFor,
	mediaSize,
	deadZone = 0.012,
}: {
	snapshot: ProjectSnapshot;
	size: TargetSize;
	facesFor: (mediaId: string) => FaceTrack | null;
	mediaSize: (mediaId: string) => { width: number; height: number } | null;
	deadZone?: number;
}): ReframePlan {
	const target = REFRAME_SIZES[size];
	const master = canvasOf(snapshot);
	const scene = activeScene(snapshot);
	const tracks: SnapshotTrack[] = [...(scene?.tracks?.overlay ?? []), ...(scene?.tracks?.main ? [scene.tracks.main] : [])];
	const ops: Record<string, unknown>[] = [{ op: "set_canvas", author: "claude", w: target.width, h: target.height }];
	const tracked: ReframePlan["tracked"] = [];
	const notes: string[] = [];
	const clearPositions = new Set<string>();
	let scaled = 0;
	const byId = new Map<string, SnapshotElement>();
	for (const track of tracks) for (const element of track.elements ?? []) byId.set(element.id, element);

	type TrackingResult = { scaleX: number; scaleY: number; keys: Array<{ time: number; x: number; y: number }>; scaleAnimFactor: number };
	const tracking = new Map<string, TrackingResult>();

	const track = (element: SnapshotElement): TrackingResult => {
		const cached = tracking.get(element.id);
		if (cached) return cached;
		const mediaId = String(element.mediaId ?? "");
		const faces = facesFor(mediaId);
		const media = mediaSize(mediaId) ?? (faces ? { width: faces.source.width, height: faces.source.height } : { width: target.width, height: target.height });
		const contain = Math.min(target.width / media.width, target.height / media.height);
		const cover = Math.max(target.width / media.width, target.height / media.height);
		const factor = cover / contain;
		const baseX = num(element.params, "transform.scaleX", 1);
		const baseY = num(element.params, "transform.scaleY", 1);
		const drawnWidth = media.width * contain * Math.abs(baseX) * factor;
		const drawnHeight = media.height * contain * Math.abs(baseY) * factor;
		const maxX = Math.max(0, (drawnWidth - target.width) / 2);
		const maxY = Math.max(0, (drawnHeight - target.height) / 2);
		const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
		const offsetFor = (point: { x: number; y: number }) => ({
			x: Math.round(clamp(-(point.x - 0.5) * drawnWidth, maxX)),
			y: Math.round(clamp(target.height * target.headAnchorY - target.height / 2 - (point.y - 0.5) * drawnHeight, maxY)),
		});
		const rate = rateOf(element);
		const trimStart = (element.trimStart ?? 0) / TICKS;
		const duration = element.duration / TICKS;
		const keys: Array<{ time: number; x: number; y: number }> = [];
		if (faces) {
			for (const sample of subjectSeries({ header: faceHeader(faces), step: 1, window: 3 })) {
				const clipTime = (sample.time - trimStart) / rate;
				if (clipTime < -0.25 || clipTime > duration + 0.25) continue;
				keys.push({ time: Math.max(0, Math.min(duration, clipTime)), ...offsetFor(sample) });
			}
		}
		if (!keys.length) {
			const head = faces?.summary.face ? headFromFace(faces.summary.face) : faces?.summary.head ?? null;
			keys.push({ time: 0, ...offsetFor(head ? { x: head[0] + head[2] / 2, y: head[1] + head[3] / 2 } : { x: 0.5, y: 0.4 }) });
		}
		const kept: typeof keys = [];
		for (const key of keys) {
			const last = kept[kept.length - 1];
			if (!last || Math.hypot(key.x - last.x, key.y - last.y) >= deadZone * target.width) kept.push(key);
		}
		const lastKey = keys[keys.length - 1];
		if (kept.length > 1 && kept[kept.length - 1] !== lastKey) kept.push(lastKey);
		const result = { scaleX: baseX * factor, scaleY: baseY * factor, keys: kept, scaleAnimFactor: factor };
		tracking.set(element.id, result);
		tracked.push({ element_id: element.id, name: String(element.name ?? ""), keys: kept.length, media_id: mediaId, face_found: faces ? faces.summary.face_found : null, scale: Math.round(factor * 1000) / 1000 });
		return result;
	};

	const emitTracking = (element: SnapshotElement, result: TrackingResult) => {
		ops.push({ op: "set", author: "claude", el: element.id, prop: "transform.scaleX", value: Math.round(result.scaleX * 100) / 100 });
		ops.push({ op: "set", author: "claude", el: element.id, prop: "transform.scaleY", value: Math.round(result.scaleY * 100) / 100 });
		for (const prop of ["transform.scaleX", "transform.scaleY"]) {
			const channel = element.animations && (element.animations as Record<string, unknown>)[prop];
			if (!isScalar(channel)) continue;
			for (const key of channel.keys) {
				ops.push({ op: "keyframe", author: "claude", el: element.id, prop, t: s3(key.time / TICKS), value: Math.round(key.value * result.scaleAnimFactor * 100) / 100, local: true });
			}
		}
		clearPositions.add(element.id);
		if (result.keys.length === 1) {
			ops.push({ op: "set", author: "claude", el: element.id, prop: "transform.positionX", value: result.keys[0].x });
			ops.push({ op: "set", author: "claude", el: element.id, prop: "transform.positionY", value: result.keys[0].y });
		} else {
			for (const key of result.keys) {
				ops.push({ op: "keyframe", author: "claude", el: element.id, prop: "transform.positionX", t: s3(key.time), value: key.x, local: true });
				ops.push({ op: "keyframe", author: "claude", el: element.id, prop: "transform.positionY", t: s3(key.time), value: key.y, local: true });
			}
		}
	};

	// Text BEHIND the person (on a track between a cutout and its clip: BEHIND TEXT, COVER MASTHEAD) is anchored to the
	// head, not to the canvas: it follows the clip's transform (offset from the clip's centre and font size scale with
	// the clip's drawn size). Added by the mcp-cutout agent: with the canvas rule "ONE POUR." landed on the face in 1:1.
	const anchoredTo = new Map<string, SnapshotElement>();
	const overlay = scene?.tracks?.overlay ?? [];
	overlay.forEach((cutoutTrack, cutoutIndex) => {
		for (const element of cutoutTrack.elements ?? []) {
			const source = cutoutSourceOf(element);
			const plate = source ? byId.get(source.sourceElementId) : undefined;
			if (!plate || !isFullFrame(plate, master)) continue;
			const plateIndex = overlay.findIndex((candidate) => (candidate.elements ?? []).some((el) => el.id === plate.id));
			const below = plateIndex >= 0 ? plateIndex : overlay.length;
			for (let i = cutoutIndex + 1; i < below; i++) {
				for (const behind of overlay[i].elements ?? []) {
					const overlapsInTime = behind.startTime < plate.startTime + plate.duration && behind.startTime + behind.duration > plate.startTime;
					if (behind.type === "text" && overlapsInTime) anchoredTo.set(behind.id, plate);
				}
			}
		}
	});
	const plateDrawnHeight = (plate: SnapshotElement, canvasSize: { width: number; height: number }, coverFactor: number) => {
		const media = mediaSize(String(plate.mediaId ?? "")) ?? { width: canvasSize.width, height: canvasSize.height };
		const contain = Math.min(canvasSize.width / media.width, canvasSize.height / media.height);
		return media.height * contain * Math.abs(num(plate.params, "transform.scaleY", 1)) * coverFactor;
	};
	let anchored = 0;

	const sx = target.width / master.width;
	const sy = target.height / master.height;
	for (const t of tracks) {
		for (const element of t.elements ?? []) {
			const type = element.type;
			const plate = anchoredTo.get(element.id);
			if (plate) {
				const result = track(plate);
				const k = plateDrawnHeight(plate, target, result.scaleAnimFactor) / plateDrawnHeight(plate, master, 1);
				const first = result.keys[0];
				const dx = num(element.params, "transform.positionX", 0) - num(plate.params, "transform.positionX", 0);
				const dy = num(element.params, "transform.positionY", 0) - num(plate.params, "transform.positionY", 0);
				// Text px = fontSize × canvasHeight / 90: keep the size relative to the clip, not to the canvas.
				const fontSize = Math.max(1, Math.round(num(element.params, "fontSize", 15) * k * (master.height / target.height)));
				// Keep the line inside the frame, like textBehindLayout does in the master (SEEN 2026-10-20: at 16:9 the
				// 3.16x crop pushed "ONE POUR." above the top edge).
				const emPx = fontSize * (target.height / 90);
				const centreY = target.height / 2 + first.y + dy * k;
				const clampedY = Math.max(emPx * 0.6, Math.min(target.height - emPx * 0.6, centreY));
				ops.push({ op: "set", author: "claude", el: element.id, prop: "transform.positionX", value: Math.round(first.x + dx * k) });
				ops.push({ op: "set", author: "claude", el: element.id, prop: "transform.positionY", value: Math.round(clampedY - target.height / 2) });
				ops.push({ op: "set", author: "claude", el: element.id, prop: "fontSize", value: fontSize });
				anchored++;
				continue;
			}
			if (type === "video" || type === "image") {
				const cutout = cutoutSourceOf(element);
				const source = cutout ? byId.get(cutout.sourceElementId) : undefined;
				if (source && source.id !== element.id && (source.type === "video" || source.type === "image") && isFullFrame(source, master)) {
					emitTracking(element, track(source));
					continue;
				}
				if (isFullFrame(element, master)) {
					emitTracking(element, track(element));
					continue;
				}
			}
			if (type === "video" || type === "image" || type === "text" || type === "graphic" || type === "sticker") {
				scaled++;
				ops.push({ op: "set", author: "claude", el: element.id, prop: "transform.positionX", value: Math.round(num(element.params, "transform.positionX", 0) * sx) });
				ops.push({ op: "set", author: "claude", el: element.id, prop: "transform.positionY", value: Math.round(num(element.params, "transform.positionY", 0) * sy) });
				if (type === "graphic" && element.definitionId === "rectangle") {
					const masterSide = Math.min(master.width, master.height);
					const targetSide = Math.min(target.width, target.height);
					ops.push({ op: "set", author: "claude", el: element.id, prop: "transform.scaleX", value: Math.round(num(element.params, "transform.scaleX", 1) * sx * (masterSide / targetSide) * 100) / 100 });
					ops.push({ op: "set", author: "claude", el: element.id, prop: "transform.scaleY", value: Math.round(num(element.params, "transform.scaleY", 1) * sy * (masterSide / targetSide) * 100) / 100 });
				}
				for (const [prop, factor] of [["transform.positionX", sx], ["transform.positionY", sy]] as const) {
					const channel = element.animations && (element.animations as Record<string, unknown>)[prop];
					if (!isScalar(channel)) continue;
					for (const key of channel.keys) {
						ops.push({ op: "keyframe", author: "claude", el: element.id, prop, t: s3(key.time / TICKS), value: Math.round(key.value * factor), local: true });
					}
				}
			}
		}
	}
	if (!tracked.length) notes.push("No full-frame clip found: nothing follows a face; positions were only scaled with the canvas.");
	if (anchored) notes.push(`${anchored} text layer(s) behind the person follow the clip (position and size relative to the head), at the clip's first reframe key.`);
	return {
		ops: ops as unknown as Op[],
		prepare: (snap) => {
			const sc = activeScene(snap);
			for (const tr of [...(sc?.tracks?.overlay ?? []), ...(sc?.tracks?.main ? [sc.tracks.main] : [])]) {
				for (const element of tr.elements ?? []) {
					if (!clearPositions.has(element.id) || !element.animations) continue;
					const animations = { ...(element.animations as Record<string, unknown>) };
					delete animations["transform.positionX"];
					delete animations["transform.positionY"];
					element.animations = Object.keys(animations).length ? animations : undefined;
				}
			}
		},
		finish: (snap) => {
			snap.settings = { ...(snap.settings ?? {}), delivery: { preset: DELIVERY_PRESET[size], fit: "cover" } };
		},
		tracked,
		scaled,
		notes,
	};
}
