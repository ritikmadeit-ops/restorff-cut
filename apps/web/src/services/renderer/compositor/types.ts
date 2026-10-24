import type { BlendMode } from "@/rendering";
import type { EffectPass, EffectUniformValue } from "@/effects/types";

export type FrameDescriptor = {
	width: number;
	height: number;
	clear: {
		color: [number, number, number, number];
	};
	items: FrameItemDescriptor[];
};

export type LayerItemDescriptor = {
	type: "layer";
	textureId: string;
	transform: QuadTransformDescriptor;
	opacity: number;
	blendMode: BlendMode;
	effectPassGroups: EffectPass[][];
	mask: LayerMaskDescriptor | null;
};

/**
 * A cut with a transition (Restorff). The compositor draws `from` and `to` each over the
 * scene so far, mixes the two with the transition shader (`listTransitionShaders()` in
 * restorffcut-wasm), and the mix becomes the scene.
 */
export type TransitionItemDescriptor = {
	type: "transition";
	shader: string;
	/** 0 = only `from`, 1 = only `to`. */
	progress: number;
	uniforms: Record<string, EffectUniformValue>;
	from: LayerItemDescriptor[];
	to: LayerItemDescriptor[];
};

export type FrameItemDescriptor =
	| LayerItemDescriptor
	| {
			type: "sceneEffect";
			effectPassGroups: EffectPass[][];
	  }
	| TransitionItemDescriptor;

export type QuadTransformDescriptor = {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotationDegrees: number;
	flipX: boolean;
	flipY: boolean;
};

export type LayerMaskDescriptor = {
	textureId: string;
	feather: number;
	inverted: boolean;
};

export type TextureCanvasDrawFn = (
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
) => void;

/**
 * A layer texture whose pixels come from somewhere outside the renderer —
 * typically a decoded video/image frame or a sticker. Cached by reference
 * identity of the source object AND `version`.
 *
 * RestorffCut (ui-fix-render, 2026-10-21): identity alone is not enough for video. The video cache decodes into a
 * pool of 3 canvases (mediabunny CanvasSink `poolSize: 3`) that are redrawn round-robin, so the SAME canvas object
 * comes back holding a different frame — e.g. every whole-second seek at 30 fps (30 frames ≡ 0 mod 3). With an
 * identity-only cache the paused preview kept showing the old frame (QA 2026-10-20 #6, PSNR ∞ across seeks).
 * Video frames pass `version` = the decoded frame's timestamp; immutable sources (images, stickers) leave it out.
 */
export type ExternalTextureDescriptor = {
	kind: "external";
	id: string;
	source: CanvasImageSource;
	width: number;
	height: number;
	/** What the source holds right now (a video frame's timestamp); a cache hit needs the same source and version. */
	version?: string;
};

/**
 * A layer texture that the renderer rasterizes from scene state (color fill,
 * text layout, mask shape, blur backdrop). Cached by `contentHash`: when it
 * matches the previous frame's hash for this id, the upload is skipped
 * entirely and the persistent canvas is not even cleared.
 */
export type RenderedTextureDescriptor = {
	kind: "rendered";
	id: string;
	contentHash: string;
	width: number;
	height: number;
	draw: TextureCanvasDrawFn;
};

export type TextureUploadDescriptor =
	| ExternalTextureDescriptor
	| RenderedTextureDescriptor;
