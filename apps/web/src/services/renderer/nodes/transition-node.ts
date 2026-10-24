import type { EffectUniformValue } from "@/effects/types";
import { BaseNode } from "./base-node";
import type { ImageNode } from "./image-node";
import type { VideoNode } from "./video-node";

/**
 * A transition at one cut (Restorff). Draws both sides — copies of the outgoing and the
 * incoming clip's nodes that hold outside their own spans — and lets the wasm compositor
 * mix them with a transition shader (frame item `{ type: "transition" }`). The clips' own
 * nodes are suppressed for [start, end), so nothing is drawn twice.
 */
export type TransitionSideNode = VideoNode | ImageNode;

export interface TransitionNodeParams {
	/** Registry id, for diagnostics. */
	transitionType: string;
	shader: string;
	uniforms: Record<string, EffectUniformValue>;
	/** Timeline ticks: [start, end) centred on the cut. */
	start: number;
	end: number;
	/** null = from whatever is underneath. */
	from: TransitionSideNode | null;
	to: TransitionSideNode;
}

export interface ResolvedTransitionNodeState {
	progress: number;
}

export class TransitionNode extends BaseNode<
	TransitionNodeParams,
	ResolvedTransitionNodeState
> {}
