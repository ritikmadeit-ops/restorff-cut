import type {
	ImageElement,
	SceneTracks,
	TimelineTrack,
	VideoElement,
} from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { getTrackTransitions } from "@/transitions/timeline";
import { TransitionNode } from "./nodes/transition-node";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { ImageNode } from "./nodes/image-node";
import { TextNode } from "./nodes/text-node";
import { StickerNode } from "./nodes/sticker-node";
import { GraphicNode } from "./nodes/graphic-node";
import { ColorNode } from "./nodes/color-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import type { AnyBaseNode } from "./nodes/base-node";
import type { TBackground, TCanvasSize } from "@/project/types";
import { DEFAULT_BACKGROUND_BLUR_INTENSITY } from "@/background/blur";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
} from "@/rendering";

const PREVIEW_MAX_IMAGE_SIZE = 2048;

function getVisibleSortedElements({ track }: { track: TimelineTrack }) {
	return track.elements
		.filter((element) => !("hidden" in element && element.hidden))
		.slice()
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

function buildMediaNode({
	element,
	mediaMap,
	isPreview,
	suppress,
	holdOutsideSpan,
	frameCacheKey,
}: {
	element: VideoElement | ImageElement;
	mediaMap: Map<string, MediaAsset>;
	isPreview?: boolean;
	suppress?: Array<{ start: number; end: number }>;
	holdOutsideSpan?: boolean;
	frameCacheKey?: string;
}): VideoNode | ImageNode | null {
	const mediaAsset = mediaMap.get(element.mediaId);
	if (!mediaAsset?.file || !mediaAsset?.url) {
		return null;
	}

	const shared = {
		duration: element.duration,
		timeOffset: element.startTime,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		transform: buildTransformFromParams({ params: element.params }),
		animations: element.animations,
		opacity: readOpacityFromParams({ params: element.params }),
		blendMode: readBlendModeFromParams({ params: element.params }),
		effects: element.effects ?? [],
		masks: element.masks ?? [],
		...(suppress && suppress.length > 0 && { suppress }),
		...(holdOutsideSpan && { holdOutsideSpan }),
	};

	if (element.type === "video" && mediaAsset.type === "video") {
		return new VideoNode({
			...shared,
			mediaId: mediaAsset.id,
			url: mediaAsset.url,
			file: mediaAsset.file,
			retime: element.retime,
			sourceDuration: element.sourceDuration,
			...(frameCacheKey && { frameCacheKey }),
		});
	}
	if (element.type === "image" && mediaAsset.type === "image") {
		return new ImageNode({
			...shared,
			url: mediaAsset.url,
			...(isPreview && {
				maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
			}),
		});
	}
	return null;
}

/**
 * Transition nodes for one track, plus the ranges in which each clip's own node must
 * stay quiet because a transition draws it.
 */
function buildTrackTransitions({
	track,
	mediaMap,
	isPreview,
}: {
	track: TimelineTrack;
	mediaMap: Map<string, MediaAsset>;
	isPreview?: boolean;
}): {
	nodes: TransitionNode[];
	suppressed: Map<string, Array<{ start: number; end: number }>>;
} {
	const nodes: TransitionNode[] = [];
	const suppressed = new Map<string, Array<{ start: number; end: number }>>();
	const suppress = (elementId: string, start: number, end: number) => {
		const ranges = suppressed.get(elementId) ?? [];
		ranges.push({ start, end });
		suppressed.set(elementId, ranges);
	};

	for (const placed of getTrackTransitions(track)) {
		const sameMedia =
			placed.outgoing !== null &&
			placed.outgoing.mediaId === placed.incoming.mediaId;
		const to = buildMediaNode({
			element: placed.incoming,
			mediaMap,
			isPreview,
			holdOutsideSpan: true,
			frameCacheKey: sameMedia
				? `${placed.incoming.mediaId}::transition-in`
				: undefined,
		});
		if (!to) continue;
		const from = placed.outgoing
			? buildMediaNode({
					element: placed.outgoing,
					mediaMap,
					isPreview,
					holdOutsideSpan: true,
				})
			: null;

		nodes.push(
			new TransitionNode({
				transitionType: placed.definition.id,
				shader: placed.definition.shader,
				uniforms: placed.definition.uniforms,
				start: placed.start,
				end: placed.end,
				from,
				to,
			}),
		);
		suppress(placed.incoming.id, placed.start, placed.end);
		if (placed.outgoing) {
			suppress(placed.outgoing.id, placed.start, placed.end);
		}
	}

	return { nodes, suppressed };
}

function buildTrackNodes({
	tracks,
	mediaMap,
	canvasSize,
	isPreview,
}: {
	tracks: TimelineTrack[];
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
}): AnyBaseNode[] {
	const nodes: AnyBaseNode[] = [];

	for (const track of tracks) {
		const elements = getVisibleSortedElements({ track });
		const transitions = buildTrackTransitions({ track, mediaMap, isPreview });

		for (const element of elements) {
			if (element.type === "effect") {
				nodes.push(
					new EffectLayerNode({
						effectType: element.effectType,
						effectParams: element.params,
						timeOffset: element.startTime,
						duration: element.duration,
					}),
				);
				continue;
			}

			if (element.type === "video" || element.type === "image") {
				const node = buildMediaNode({
					element,
					mediaMap,
					isPreview,
					suppress: transitions.suppressed.get(element.id),
				});
				if (node) {
					nodes.push(node);
				}
			}

			if (element.type === "text") {
				nodes.push(
					new TextNode({
						...element,
						transform: buildTransformFromParams({ params: element.params }),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
						canvasHeight: canvasSize.height,
						textBaseline: "middle",
						effects: element.effects ?? [],
					}),
				);
			}

			if (element.type === "sticker") {
				nodes.push(
					new StickerNode({
						stickerId: element.stickerId,
						intrinsicWidth: element.intrinsicWidth,
						intrinsicHeight: element.intrinsicHeight,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
					}),
				);
			}

			if (element.type === "graphic") {
				nodes.push(
					new GraphicNode({
						definitionId: element.definitionId,
						params: element.params,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
						masks: element.masks ?? [],
					}),
				);
			}
		}

		// Same z-position as the track's clips (they never overlap on one track).
		nodes.push(...transitions.nodes);
	}

	return nodes;
}

function buildBlurBackgroundNodes({
	track,
	mediaMap,
	blurIntensity,
}: {
	track: TimelineTrack | undefined;
	mediaMap: Map<string, MediaAsset>;
	blurIntensity: number;
}): AnyBaseNode[] {
	if (!track) {
		return [];
	}

	const nodes: AnyBaseNode[] = [];
	const elements = getVisibleSortedElements({ track });

	for (const element of elements) {
		if (element.type !== "video" && element.type !== "image") {
			continue;
		}

		const mediaAsset = mediaMap.get(element.mediaId);
		if (
			!mediaAsset?.file ||
			!mediaAsset?.url ||
			(mediaAsset.type !== "video" && mediaAsset.type !== "image")
		) {
			continue;
		}

		nodes.push(
			new BlurBackgroundNode({
				mediaId: mediaAsset.id,
				url: mediaAsset.url,
				file: mediaAsset.file,
				mediaType: mediaAsset.type,
				duration: element.duration,
				timeOffset: element.startTime,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				retime: element.type === "video" ? element.retime : undefined,
				blurIntensity,
			}),
		);
	}

	return nodes;
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	background: TBackground;
	isPreview?: boolean;
};

export function buildScene({
	canvasSize,
	tracks,
	mediaAssets,
	duration,
	background,
	isPreview,
}: BuildSceneParams) {
	const rootNode = new RootNode({ duration });
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));

	const visibleTracks = [
		...tracks.overlay.filter((track) => !("hidden" in track && track.hidden)),
		...(!tracks.main.hidden ? [tracks.main] : []),
	];
	const orderedTracksBottomToTop = visibleTracks.slice().reverse();
	const mainTrack = tracks.main.hidden ? undefined : tracks.main;

	const allNodes = buildTrackNodes({
		tracks: orderedTracksBottomToTop,
		mediaMap,
		canvasSize,
		isPreview,
	});

	if (background.type === "blur") {
		const blurNodes = buildBlurBackgroundNodes({
			track: mainTrack,
			mediaMap,
			blurIntensity:
				background.blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY,
		});
		for (const node of blurNodes) {
			rootNode.add(node);
		}
	} else if (
		background.type === "color" &&
		background.color !== "transparent"
	) {
		rootNode.add(new ColorNode({ color: background.color }));
	}

	for (const node of allNodes) {
		rootNode.add(node);
	}

	return rootNode;
}
