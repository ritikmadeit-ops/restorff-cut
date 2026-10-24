/**
 * "Cut out person": the selected clip → the same clip with only the person (transparent background) on a new
 * overlay track directly above it, aligned frame for frame (same start, length, retime, transform, keyframes).
 * Anything placed on a track between the two then appears BEHIND the person.
 *
 * How the matte reaches the render path: the editor's mask system draws masks from params (no per-frame image input
 * without a renderer change), so the cutout is rendered OFFLINE in the browser to a WebM VP9 with alpha (mediabunny,
 * the editor's own encoder library) and imported as ordinary media. Stills become a PNG with alpha.
 */
import { BatchCommand, type Command } from "@/commands";
import { AddMediaAssetCommand } from "@/commands/media";
import { TracksSnapshotCommand } from "@/commands/timeline";
import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import type { MediaAsset } from "@/media/types";
import { getMatte } from "@/segmentation/cache";
import {
	DEFAULT_SEGMENTATION_MODEL,
	MATTE_ANALYSIS_FPS,
	type SegmentationModelId,
} from "@/segmentation/config";
import { medianBox } from "@/segmentation/matte";
import type { ElementRef, ImageElement, SceneTracks, TimelineElement, VideoElement } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds, mediaTimeToSeconds, type MediaTime } from "@/wasm";
import { renderCutoutImage, renderCutoutVideo } from "./render";
import {
	findCutoutFor,
	getCutoutSource,
	insertOverlayTrack,
	isTrackFree,
	locateElement,
	newVideoTrack,
	overlayIndexAbove,
	appendElementToTrack,
	withCutoutSource,
	type LocatedElement,
} from "./timeline-utils";
import type { CutoutProgressHandler, CutoutSource } from "./types";

export const CUTOUT_TRACK_NAME = "V2 CUTOUT";

export interface CutoutResult {
	/** The cutout element (new or the one already on the timeline). */
	cutout: { trackId: string; elementId: string };
	/** The clip it was cut from. */
	source: { trackId: string; elementId: string };
	created: boolean;
}

export function projectInfo({ editor }: { editor: EditorCore }) {
	const project = editor.project.getActive();
	const { width, height } = project.settings.canvasSize;
	const fps = project.settings.fps.numerator / project.settings.fps.denominator;
	return { project, canvas: { width, height }, fps: Number.isFinite(fps) && fps > 0 ? fps : 30 };
}

function findAsset({ editor, mediaId }: { editor: EditorCore; mediaId: string }): MediaAsset {
	const asset = editor.media.getAssets().find((candidate) => candidate.id === mediaId);
	if (!asset) throw new Error("the clip's media is not loaded in this project");
	if (!asset.file) throw new Error("the clip's media file is not available");
	return asset;
}

/** Resolves a ref to the clip that should be cut out (a cutout's ref resolves to its source clip). */
export function resolvePlate({
	editor,
	ref,
}: {
	editor: EditorCore;
	ref: ElementRef;
}): { plate: LocatedElement; cutout: LocatedElement | null } {
	const tracks = editor.scenes.getActiveScene().tracks;
	const located = locateElement({ tracks, elementId: ref.elementId });
	if (!located) throw new Error("select a clip on the timeline first");
	const source = getCutoutSource(located.element);
	if (source) {
		const plate = locateElement({ tracks, elementId: source.sourceElementId });
		if (!plate) throw new Error("this cutout's source clip is no longer on the timeline");
		return { plate, cutout: located };
	}
	if (located.element.type !== "video" && located.element.type !== "image") {
		throw new Error("cut out works on video and image clips");
	}
	return { plate: located, cutout: findCutoutFor({ tracks, sourceElementId: located.element.id }) };
}

function sourceRange({ element, asset }: { element: VideoElement; asset: MediaAsset }) {
	const rate = element.retime?.rate && element.retime.rate > 0 ? element.retime.rate : 1;
	const start = Math.max(0, mediaTimeToSeconds({ time: element.trimStart }));
	let end = start + mediaTimeToSeconds({ time: element.duration }) * rate;
	if (asset.duration && asset.duration > 0) end = Math.min(end, asset.duration);
	if (end <= start) end = start + 1 / 30;
	return { start, end, rate };
}

/** Where the cutout track goes: reuse a free cutout track directly above the clip, else insert a new one. */
function placeCutout({
	tracks,
	plate,
	element,
}: {
	tracks: SceneTracks;
	plate: LocatedElement;
	element: TimelineElement;
}): { after: SceneTracks; trackId: string } {
	const aboveIndex = overlayIndexAbove({ tracks, location: plate.location });
	const neighbour = aboveIndex - 1 >= 0 ? tracks.overlay[aboveIndex - 1] : null;
	const end = element.startTime + element.duration;
	if (
		neighbour &&
		neighbour.type === "video" &&
		neighbour.name.toUpperCase().includes("CUTOUT") &&
		isTrackFree({ track: neighbour, start: element.startTime, end })
	) {
		return { after: appendElementToTrack({ tracks, trackId: neighbour.id, element }), trackId: neighbour.id };
	}
	const track = newVideoTrack(CUTOUT_TRACK_NAME, [element]);
	return { after: insertOverlayTrack({ tracks, index: aboveIndex, track }), trackId: track.id };
}

/**
 * Makes (or finds) the cutout for the clip at `ref`. One undo step for the insert. Long jobs: segmentation runs in a
 * worker (cached per media + range in OPFS), the render in a second worker.
 */
export async function cutOutPerson({
	editor,
	ref,
	model = DEFAULT_SEGMENTATION_MODEL,
	force = false,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	ref: ElementRef;
	model?: SegmentationModelId;
	/** Make a new cutout even if one exists for this clip. */
	force?: boolean;
	onProgress?: CutoutProgressHandler;
	signal?: AbortSignal;
}): Promise<CutoutResult> {
	const { plate, cutout: existing } = resolvePlate({ editor, ref });
	if (existing && !force) {
		return {
			cutout: { trackId: existing.track.id, elementId: existing.element.id },
			source: { trackId: plate.track.id, elementId: plate.element.id },
			created: false,
		};
	}
	const plateElement = plate.element as VideoElement | ImageElement;
	const asset = findAsset({ editor, mediaId: plateElement.mediaId });
	const { project, fps: projectFps } = projectInfo({ editor });
	const baseName = `${plateElement.name || asset.name} · cutout`;

	let file: File;
	let source: CutoutSource;
	let mediaDurationSeconds: number | null = null;

	if (plateElement.type === "image") {
		onProgress?.({ phase: "segment", progress: 0, message: "Finding the person…" });
		const still = await renderCutoutImage({ file: asset.file, name: baseName, model });
		file = still.file;
		source = {
			sourceElementId: plateElement.id,
			sourceMediaId: asset.id,
			model,
			start: 0,
			end: 0,
			fps: 0,
			person: still.boxes.person,
			head: still.boxes.head,
			face: still.boxes.face,
			createdAt: new Date().toISOString(),
		};
	} else {
		const { start, end } = sourceRange({ element: plateElement, asset });
		const matte = await getMatte({
			mediaId: asset.id,
			file: asset.file,
			start,
			end,
			fps: MATTE_ANALYSIS_FPS,
			model,
			keepAlpha: true,
			signal,
			onProgress: ({ done, total, phase }) =>
				onProgress?.({
					phase: phase === "load-model" ? "load-model" : phase === "cached" ? "cached" : "segment",
					progress: total > 0 ? done / total : 0,
					message:
						phase === "load-model"
							? "Loading the person model…"
							: phase === "cached"
								? "Matte found in the cache"
								: `Finding the person · frame ${done} of ${total}`,
				}),
		});
		const outFps = Math.max(1, Math.min(60, Math.round(asset.fps || projectFps), Math.round(projectFps)));
		const rendered = await renderCutoutVideo({
			file: asset.file,
			matte,
			start,
			end,
			fps: outFps,
			name: baseName,
			signal,
			onProgress: ({ done, total }) =>
				onProgress?.({
					phase: "render",
					progress: total > 0 ? done / total : 0,
					message: `Rendering the cutout · frame ${done} of ${total}`,
				}),
		});
		file = rendered.file;
		mediaDurationSeconds = rendered.duration;
		source = {
			sourceElementId: plateElement.id,
			sourceMediaId: asset.id,
			model,
			start,
			end,
			fps: outFps,
			person: medianBox({ header: matte.header, kind: "person", from: start, to: end }),
			head: medianBox({ header: matte.header, kind: "head", from: start, to: end }),
			face: medianBox({ header: matte.header, kind: "face", from: start, to: end }),
			createdAt: new Date().toISOString(),
		};
	}

	onProgress?.({ phase: "import", progress: 0, message: "Importing the cutout…" });
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed) throw new Error("the editor could not import the cutout");

	// The timeline may have changed during the job: read it again.
	const before = editor.scenes.getActiveScene().tracks;
	const current = locateElement({ tracks: before, elementId: plateElement.id });
	if (!current) throw new Error("the clip was removed while the cutout was being made");
	const live = current.element as VideoElement | ImageElement;

	const addMedia = new AddMediaAssetCommand({ projectId: project.metadata.id, asset: processed });
	const cutoutElement = buildCutoutElement({
		plate: live,
		mediaId: addMedia.getAssetId(),
		name: baseName,
		mediaDurationSeconds: processed.duration ?? mediaDurationSeconds,
		source,
	});
	const { after, trackId } = placeCutout({ tracks: before, plate: current, element: cutoutElement });
	const commands: Command[] = [addMedia, new TracksSnapshotCommand({ before, after })];
	editor.command.execute({ command: new BatchCommand(commands) });
	onProgress?.({ phase: "insert", progress: 1, message: "Cutout added" });
	return {
		cutout: { trackId, elementId: cutoutElement.id },
		source: { trackId: current.track.id, elementId: live.id },
		created: true,
	};
}

function buildCutoutElement({
	plate,
	mediaId,
	name,
	mediaDurationSeconds,
	source,
}: {
	plate: VideoElement | ImageElement;
	mediaId: string;
	name: string;
	mediaDurationSeconds: number | null;
	source: CutoutSource;
}): TimelineElement {
	const common = {
		id: generateUUID(),
		name,
		mediaId,
		startTime: plate.startTime,
		duration: plate.duration,
		params: { ...plate.params },
		animations: plate.animations ? structuredClone(plate.animations) : undefined,
		// Keep the clip's look (grades etc.) but never its blur: Green screen blurs the plate, not the person.
		effects: plate.effects
			? structuredClone(plate.effects.filter((effect) => effect.type !== "blur"))
			: undefined,
		hidden: false,
	};
	if (plate.type === "image") {
		return withCutoutSource(
			{ ...common, type: "image", trimStart: plate.trimStart, trimEnd: plate.trimEnd } as ImageElement,
			source,
		);
	}
	const rate = plate.retime?.rate && plate.retime.rate > 0 ? plate.retime.rate : 1;
	const usedTicks = Math.round(plate.duration * rate);
	const mediaTicks = mediaDurationSeconds
		? (mediaTimeFromSeconds({ seconds: mediaDurationSeconds }) as number)
		: usedTicks;
	const element: VideoElement = {
		...common,
		type: "video",
		trimStart: 0 as MediaTime,
		trimEnd: Math.max(0, mediaTicks - usedTicks) as MediaTime,
		sourceDuration: Math.max(mediaTicks, usedTicks) as MediaTime,
		retime: plate.retime ? { ...plate.retime } : undefined,
		isSourceAudioEnabled: false,
	};
	return withCutoutSource(element, source);
}
