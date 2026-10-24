import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface VideoNodeParams extends VisualNodeParams {
	url: string;
	file: File;
	mediaId: string;
	/** Media length in ticks; transition sides clamp source time to it. */
	sourceDuration?: number;
	/**
	 * Video-cache key; defaults to `mediaId`. A transition between two pieces of the same
	 * file needs a second decoder for its incoming side, so that side uses its own key.
	 */
	frameCacheKey?: string;
}

export class VideoNode extends VisualNode<
	VideoNodeParams,
	ResolvedVisualSourceNodeState
> {}
