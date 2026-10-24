/**
 * Auto-reframe planning (pure): master tracks (9:16) + subject points per clip → tracks for another canvas size.
 *
 * Rules (documented in docs/restorff/worklog/cutout.md):
 * - Full-frame video/image clips (scale ≈ 1, position ≈ 0 in the master) are scaled to COVER the new canvas and get
 *   position keyframes that keep the subject's head at the size's anchor point, clamped so the frame stays covered.
 *   Existing scale keyframes are multiplied by the cover factor; existing position keyframes are replaced.
 * - A cutout gets exactly the transform of its source clip, so it stays aligned.
 * - Other visual elements (text, captions, stickers, picture-in-picture) keep their size rule and have their
 *   position (and position keyframes) scaled with the canvas. Full-canvas rectangles are re-stretched to the canvas.
 * - Audio and effect layers are copied unchanged. Every track and element gets a new id.
 */
import type { ChannelData, ElementAnimations, ScalarChannel } from "@/animation/types";
import type { MediaAsset } from "@/media/types";
import type { SubjectSample } from "@/segmentation/matte";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";
import { getCutoutSource, readNumber, scalarChannel, withCutoutSource } from "@/cutout/timeline-utils";
import type { ReframeSize } from "./sizes";

export interface PlanInput {
	tracks: SceneTracks;
	assets: Map<string, Pick<MediaAsset, "width" | "height" | "type">>;
	master: { width: number; height: number };
	target: ReframeSize;
	/** Subject samples (source time) per master element id. */
	subjects: Map<string, SubjectSample[]>;
	/** Minimum move (fraction of the target width) before a new position key is written. */
	deadZone?: number;
}

type Transform = { params: Record<string, unknown>; animations: ElementAnimations | undefined };

function isScalarChannel(data: ChannelData | undefined): data is ScalarChannel {
	return !!data && Array.isArray((data as ScalarChannel).keys);
}

function scaleChannel(data: ChannelData | undefined, factor: number): ChannelData | undefined {
	if (!isScalarChannel(data)) return data;
	return { ...data, keys: data.keys.map((key) => ({ ...key, value: key.value * factor })) };
}

export function isFullFrame({
	element,
	master,
}: {
	element: TimelineElement;
	master: { width: number; height: number };
}): boolean {
	const params = element.params as Record<string, unknown>;
	const scaleX = Math.abs(readNumber(params, "transform.scaleX", 1));
	const scaleY = Math.abs(readNumber(params, "transform.scaleY", 1));
	const x = Math.abs(readNumber(params, "transform.positionX", 0));
	const y = Math.abs(readNumber(params, "transform.positionY", 0));
	return (
		scaleX >= 0.95 &&
		scaleY >= 0.95 &&
		Math.abs(scaleX - scaleY) < 0.05 &&
		x <= master.width * 0.03 &&
		y <= master.height * 0.03
	);
}

/** Transform that makes a full-frame clip cover the target and follow its subject. */
function trackingTransform({
	element,
	asset,
	target,
	samples,
	deadZone,
}: {
	element: TimelineElement;
	asset: Pick<MediaAsset, "width" | "height"> | undefined;
	target: ReframeSize;
	samples: SubjectSample[] | undefined;
	deadZone: number;
}): Transform {
	const params = { ...(element.params as Record<string, unknown>) };
	const sourceWidth = asset?.width || target.width;
	const sourceHeight = asset?.height || target.height;
	const contain = Math.min(target.width / sourceWidth, target.height / sourceHeight);
	const cover = Math.max(target.width / sourceWidth, target.height / sourceHeight);
	const factor = cover / contain;
	const baseX = readNumber(params, "transform.scaleX", 1);
	const baseY = readNumber(params, "transform.scaleY", 1);
	const drawnWidth = sourceWidth * contain * Math.abs(baseX) * factor;
	const drawnHeight = sourceHeight * contain * Math.abs(baseY) * factor;
	const maxX = Math.max(0, (drawnWidth - target.width) / 2);
	const maxY = Math.max(0, (drawnHeight - target.height) / 2);
	const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
	const offsetFor = (point: { x: number; y: number }) => ({
		x: clamp(-(point.x - 0.5) * drawnWidth, maxX),
		y: clamp(target.height * target.headAnchorY - target.height / 2 - (point.y - 0.5) * drawnHeight, maxY),
	});

	const rate = "retime" in element && element.retime?.rate && element.retime.rate > 0 ? element.retime.rate : 1;
	const trimStart = mediaTimeToSeconds({ time: element.trimStart });
	const durationSeconds = mediaTimeToSeconds({ time: element.duration });
	const keys: Array<{ time: number; x: number; y: number }> = [];
	for (const sample of samples ?? []) {
		const clipTime = (sample.time - trimStart) / rate;
		if (clipTime < -0.25 || clipTime > durationSeconds + 0.25) continue;
		const offset = offsetFor(sample);
		keys.push({ time: Math.max(0, Math.min(durationSeconds, clipTime)), ...offset });
	}
	const cutout = getCutoutSource(element);
	if (keys.length === 0) {
		const head = cutout?.head;
		const point = head ? { x: head[0] + head[2] / 2, y: head[1] + head[3] / 2 } : { x: 0.5, y: 0.4 };
		keys.push({ time: 0, ...offsetFor(point) });
	}
	// Dead zone: skip keys that move less than `deadZone` of the width from the last kept key.
	const kept: typeof keys = [];
	for (const key of keys) {
		const last = kept[kept.length - 1];
		if (!last || Math.hypot(key.x - last.x, key.y - last.y) >= deadZone * target.width) kept.push(key);
	}
	const lastKey = keys[keys.length - 1];
	if (kept.length > 1 && kept[kept.length - 1] !== lastKey) kept.push(lastKey);

	params["transform.scaleX"] = baseX * factor;
	params["transform.scaleY"] = baseY * factor;
	params["transform.positionX"] = kept[0].x;
	params["transform.positionY"] = kept[0].y;

	const animations: ElementAnimations = { ...(element.animations ?? {}) };
	animations["transform.scaleX"] = scaleChannel(animations["transform.scaleX"], factor);
	animations["transform.scaleY"] = scaleChannel(animations["transform.scaleY"], factor);
	delete animations["transform.positionX"];
	delete animations["transform.positionY"];
	if (kept.length > 1) {
		const toTicks = (seconds: number) => mediaTimeFromSeconds({ seconds }) as number;
		animations["transform.positionX"] = scalarChannel(kept.map((key) => ({ time: toTicks(key.time), value: key.x })));
		animations["transform.positionY"] = scalarChannel(kept.map((key) => ({ time: toTicks(key.time), value: key.y })));
	}
	for (const key of Object.keys(animations)) if (animations[key] === undefined) delete animations[key];
	return { params, animations: Object.keys(animations).length ? animations : undefined };
}

/** Positions scale with the canvas; full-canvas rectangles are re-stretched. */
function proportionalTransform({
	element,
	master,
	target,
}: {
	element: TimelineElement;
	master: { width: number; height: number };
	target: ReframeSize;
}): Transform {
	const params = { ...(element.params as Record<string, unknown>) };
	const sx = target.width / master.width;
	const sy = target.height / master.height;
	params["transform.positionX"] = readNumber(params, "transform.positionX", 0) * sx;
	params["transform.positionY"] = readNumber(params, "transform.positionY", 0) * sy;
	if (element.type === "graphic" && element.definitionId === "rectangle") {
		const masterSide = Math.min(master.width, master.height);
		const targetSide = Math.min(target.width, target.height);
		params["transform.scaleX"] = readNumber(params, "transform.scaleX", 1) * sx * (masterSide / targetSide);
		params["transform.scaleY"] = readNumber(params, "transform.scaleY", 1) * sy * (masterSide / targetSide);
	}
	let animations = element.animations;
	if (animations) {
		animations = {
			...animations,
			"transform.positionX": scaleChannel(animations["transform.positionX"], sx),
			"transform.positionY": scaleChannel(animations["transform.positionY"], sy),
		};
		for (const key of Object.keys(animations)) if (animations[key] === undefined) delete animations[key];
	}
	return { params, animations };
}

export function planReframe(input: PlanInput): SceneTracks {
	const { tracks, assets, master, target, subjects } = input;
	const deadZone = input.deadZone ?? 0.012;
	const newIds = new Map<string, string>();
	const all = [...tracks.overlay, tracks.main, ...tracks.audio] as TimelineTrack[];
	for (const track of all) for (const element of track.elements as TimelineElement[]) newIds.set(element.id, generateUUID());

	const byId = new Map<string, TimelineElement>();
	for (const track of all) for (const element of track.elements as TimelineElement[]) byId.set(element.id, element);

	const transforms = new Map<string, Transform>();
	const transformFor = (element: TimelineElement): Transform | null => {
		const cached = transforms.get(element.id);
		if (cached) return cached;
		let result: Transform | null = null;
		if (element.type === "video" || element.type === "image") {
			const cutout = getCutoutSource(element);
			const source = cutout ? byId.get(cutout.sourceElementId) : undefined;
			if (source && source.id !== element.id) {
				const sourceTransform = transformFor(source);
				// Same transform as the plate; keep the cutout's own non-transform params.
				result = sourceTransform
					? {
							params: { ...(element.params as Record<string, unknown>), ...pickTransform(sourceTransform.params) },
							animations: mergeTransformAnimations(element.animations, sourceTransform.animations),
						}
					: null;
			} else if (isFullFrame({ element, master })) {
				result = trackingTransform({
					element,
					asset: assets.get(element.mediaId),
					target,
					samples: subjects.get(element.id),
					deadZone,
				});
			} else {
				result = proportionalTransform({ element, master, target });
			}
		} else if (element.type === "text" || element.type === "graphic" || element.type === "sticker") {
			result = proportionalTransform({ element, master, target });
		}
		if (result) transforms.set(element.id, result);
		return result;
	};

	const mapElement = (element: TimelineElement): TimelineElement => {
		const transform = transformFor(element);
		let next = {
			...cloneElement(element),
			id: newIds.get(element.id) ?? generateUUID(),
		} as TimelineElement;
		if (transform) {
			next = { ...next, params: transform.params as TimelineElement["params"], animations: transform.animations };
		}
		const cutout = getCutoutSource(element);
		if (cutout) {
			next = withCutoutSource(next, {
				...cutout,
				sourceElementId: newIds.get(cutout.sourceElementId) ?? cutout.sourceElementId,
			});
		}
		return next;
	};
	const mapTrack = <T extends TimelineTrack>(track: T): T =>
		({
			...track,
			id: generateUUID(),
			elements: (track.elements as TimelineElement[]).map(mapElement),
		}) as T;

	return {
		overlay: tracks.overlay.map(mapTrack),
		main: mapTrack(tracks.main),
		audio: tracks.audio.map(mapTrack),
	};
}

/** Deep copy, except an audio element's decoded AudioBuffer (not cloneable; shared by reference). */
function cloneElement(element: TimelineElement): TimelineElement {
	const { buffer, ...rest } = element as TimelineElement & { buffer?: AudioBuffer };
	const copy = structuredClone(rest) as TimelineElement & { buffer?: AudioBuffer };
	if (buffer) copy.buffer = buffer;
	return copy;
}

const TRANSFORM_KEYS = ["transform.scaleX", "transform.scaleY", "transform.positionX", "transform.positionY", "transform.rotate"];

function pickTransform(params: Record<string, unknown>): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	for (const key of TRANSFORM_KEYS) if (key in params) picked[key] = params[key];
	return picked;
}

function mergeTransformAnimations(
	own: ElementAnimations | undefined,
	fromSource: ElementAnimations | undefined,
): ElementAnimations | undefined {
	const merged: ElementAnimations = { ...(own ?? {}) };
	for (const key of TRANSFORM_KEYS) delete merged[key];
	for (const key of TRANSFORM_KEYS) {
		const channel = fromSource?.[key];
		if (channel) merged[key] = structuredClone(channel);
	}
	return Object.keys(merged).length ? merged : undefined;
}
