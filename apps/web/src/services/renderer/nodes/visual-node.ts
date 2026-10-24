import { BaseNode } from "./base-node";
import type { Effect, EffectPass } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { BlendMode, Transform } from "@/rendering";
import type { RetimeConfig, VisualElement } from "@/timeline";

export interface VisualNodeParams {
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	retime?: RetimeConfig;
	transform: Transform;
	animations?: VisualElement["animations"];
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
	masks?: Mask[];
	/**
	 * Transitions: timeline ranges [start, end) in which this node draws nothing because a
	 * TransitionNode draws the clip there instead.
	 */
	suppress?: Array<{ start: number; end: number }>;
	/**
	 * Transitions: a transition side keeps drawing outside the clip's own span — before its
	 * start it holds the first state, after its end the last — while video frames come from
	 * the media's handles (trimStart / trimEnd) and freeze at the media's ends.
	 */
	holdOutsideSpan?: boolean;
}

export interface ResolvedVisualNodeState {
	localTime: number;
	transform: Transform;
	opacity: number;
	effectPasses: EffectPass[][];
}

export interface ResolvedVisualSourceNodeState extends ResolvedVisualNodeState {
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
	/**
	 * What `source` holds right now when the source object is reused for other content (a pooled video-frame canvas:
	 * the frame's timestamp). Undefined for immutable sources. See compositor/types.ts ExternalTextureDescriptor.
	 */
	sourceVersion?: string;
}

export abstract class VisualNode<
	Params extends VisualNodeParams = VisualNodeParams,
	Resolved extends ResolvedVisualNodeState = ResolvedVisualNodeState,
> extends BaseNode<Params, Resolved> {}
