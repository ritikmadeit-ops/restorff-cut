import type { ElementAnimations } from "@/animation/types";
import type { Effect } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { ParamValues } from "@/params";
import type { MediaTime } from "@/wasm";

export type ElementRef = {
	trackId: string;
	elementId: string;
};

export interface Bookmark {
	time: MediaTime;
	note?: string;
	color?: string;
	duration?: MediaTime;
}

export interface TScene {
	id: string;
	name: string;
	isMain: boolean;
	tracks: SceneTracks;
	bookmarks: Bookmark[];
	createdAt: Date;
	updatedAt: Date;
}

export type TrackType = "video" | "text" | "audio" | "graphic" | "effect";

interface BaseTrack {
	id: string;
	name: string;
}

export interface VideoTrack extends BaseTrack {
	type: "video";
	elements: (VideoElement | ImageElement)[];
	muted: boolean;
	hidden: boolean;
}

export interface TextTrack extends BaseTrack {
	type: "text";
	elements: TextElement[];
	hidden: boolean;
}

export interface AudioTrack extends BaseTrack {
	type: "audio";
	elements: AudioElement[];
	muted: boolean;
}

export interface GraphicTrack extends BaseTrack {
	type: "graphic";
	elements: (StickerElement | GraphicElement)[];
	hidden: boolean;
}

export interface EffectTrack extends BaseTrack {
	type: "effect";
	elements: EffectElement[];
	hidden: boolean;
}

export type TimelineTrack =
	| VideoTrack
	| TextTrack
	| AudioTrack
	| GraphicTrack
	| EffectTrack;

export type OverlayTrack = VideoTrack | TextTrack | GraphicTrack | EffectTrack;

export interface SceneTracks {
	overlay: OverlayTrack[];
	main: VideoTrack;
	audio: AudioTrack[];
}

export interface RetimeConfig {
	rate: number;
	maintainPitch?: boolean;
}

/**
 * Restorff (project v32): a transition INTO this clip from the clip that ends where it
 * starts on the same track, centred on the cut (half before, half after). With no clip
 * touching its start it transitions from what is underneath (e.g. a fade in from black).
 * Rendered by the wasm compositor (`apps/web/src/transitions`, `rust/crates/effects`).
 */
export interface ClipTransition {
	/** Registry id from `@/transitions/definitions` (e.g. "whip-left", "dissolve"). */
	type: string;
	/** Total length in ticks. */
	duration: MediaTime;
}

/**
 * Restorff (project v32): beats found in a music element's SOURCE media, so they move and
 * trim with the clip. Timeline time of a beat = startTime + (beat − trimStart) / rate.
 */
export interface BeatGrid {
	/** Tempo the tracker locked to, beats per minute. */
	bpm: number;
	/** Beat times in source ticks, ascending. */
	times: MediaTime[];
	/** Indices into `times` that start a bar (estimated), when known. */
	downbeats?: number[];
	/** Where the grid came from. */
	source: "detected" | "board" | "manual";
}

interface BaseAudioElement extends BaseTimelineElement {
	type: "audio";
	buffer?: AudioBuffer;
	retime?: RetimeConfig;
	beats?: BeatGrid;
}

export interface UploadAudioElement extends BaseAudioElement {
	sourceType: "upload";
	mediaId: string;
}

export interface LibraryAudioElement extends BaseAudioElement {
	sourceType: "library";
	sourceUrl: string;
}

export type AudioElement = UploadAudioElement | LibraryAudioElement;

interface BaseTimelineElement {
	id: string;
	name: string;
	duration: MediaTime;
	startTime: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	sourceDuration?: MediaTime;
	animations?: ElementAnimations;
	params: ParamValues;
}

export interface VideoElement extends BaseTimelineElement {
	type: "video";
	mediaId: string;
	isSourceAudioEnabled?: boolean;
	hidden?: boolean;
	retime?: RetimeConfig;
	effects?: Effect[];
	masks?: Mask[];
	transitionIn?: ClipTransition;
}

export interface ImageElement extends BaseTimelineElement {
	type: "image";
	mediaId: string;
	hidden?: boolean;
	effects?: Effect[];
	masks?: Mask[];
	transitionIn?: ClipTransition;
}

export interface TextElement extends BaseTimelineElement {
	type: "text";
	hidden?: boolean;
	effects?: Effect[];
}

export interface StickerElement extends BaseTimelineElement {
	type: "sticker";
	stickerId: string;
	/** Natural dimensions of the sticker asset, stored at insert time. Used by renderer and preview bounds to avoid split-brain geometry. */
	intrinsicWidth?: number;
	intrinsicHeight?: number;
	hidden?: boolean;
	effects?: Effect[];
}

export interface GraphicElement extends BaseTimelineElement {
	type: "graphic";
	definitionId: string;
	hidden?: boolean;
	effects?: Effect[];
	masks?: Mask[];
}

export interface EffectElement extends BaseTimelineElement {
	type: "effect";
	effectType: string;
}

export type ElementUpdatePatch = { params?: Partial<ParamValues> };

export type TimelineElement =
	| AudioElement
	| VideoElement
	| ImageElement
	| TextElement
	| StickerElement
	| GraphicElement
	| EffectElement;

export type ElementType = TimelineElement["type"];

function elementTypes<T extends ElementType[]>(...types: T): T {
	return types;
}

export const MASKABLE_ELEMENT_TYPES = elementTypes("video", "image", "graphic");

export type MaskableElement = Extract<
	TimelineElement,
	{ type: (typeof MASKABLE_ELEMENT_TYPES)[number] }
>;

export const RETIMABLE_ELEMENT_TYPES = elementTypes("video", "audio");

export type RetimableElement = Extract<
	TimelineElement,
	{ type: (typeof RETIMABLE_ELEMENT_TYPES)[number] }
>;

export const VISUAL_ELEMENT_TYPES = elementTypes(
	"video",
	"image",
	"text",
	"sticker",
	"graphic",
);

export type VisualElement = Extract<
	TimelineElement,
	{ type: (typeof VISUAL_ELEMENT_TYPES)[number] }
>;

export type CreateUploadAudioElement = Omit<UploadAudioElement, "id">;
export type CreateLibraryAudioElement = Omit<LibraryAudioElement, "id">;
export type CreateAudioElement =
	| CreateUploadAudioElement
	| CreateLibraryAudioElement;
export type CreateVideoElement = Omit<VideoElement, "id">;
export type CreateImageElement = Omit<ImageElement, "id">;
export type CreateTextElement = Omit<TextElement, "id">;
export type CreateStickerElement = Omit<StickerElement, "id">;
export type CreateGraphicElement = Omit<GraphicElement, "id">;
export type CreateEffectElement = Omit<EffectElement, "id">;
export type CreateTimelineElement =
	| CreateAudioElement
	| CreateVideoElement
	| CreateImageElement
	| CreateTextElement
	| CreateStickerElement
	| CreateGraphicElement
	| CreateEffectElement;

export interface ElementDragState {
	isDragging: boolean;
	elementId: string | null;
	dragElementIds: string[];
	dragTimeOffsets: Record<string, MediaTime>;
	trackId: string | null;
	startMouseX: number;
	startMouseY: number;
	startElementTime: MediaTime;
	clickOffsetTime: MediaTime;
	currentTime: MediaTime;
	currentMouseY: number;
}

export type ElementDragView =
	| { readonly kind: "idle" }
	| {
			readonly kind: "dragging";
			readonly anchorElementId: string;
			readonly trackId: string;
			readonly memberTimeOffsets: ReadonlyMap<string, MediaTime>;
			readonly startMouseX: number;
			readonly startMouseY: number;
			readonly startElementTime: MediaTime;
			readonly clickOffsetTime: MediaTime;
			readonly currentTime: MediaTime;
			readonly currentMouseX: number;
			readonly currentMouseY: number;
			readonly dropTarget: DropTarget | null;
	  };

export interface DropTarget {
	trackIndex: number;
	isNewTrack: boolean;
	insertPosition: "above" | "below" | null;
	xPosition: MediaTime;
	targetElement: { elementId: string; trackId: string } | null;
}

export interface ComputeDropTargetParams {
	elementType: ElementType;
	mouseX: number;
	mouseY: number;
	tracks: SceneTracks;
	playheadTime: MediaTime;
	isExternalDrop: boolean;
	elementDuration: MediaTime;
	pixelsPerSecond: number;
	zoomLevel: number;
	verticalDragDirection?: "up" | "down" | null;
	startTimeOverride?: MediaTime;
	excludeElementId?: string;
	targetElementTypes?: string[];
}

export interface ClipboardItem {
	trackId: string;
	trackType: TrackType;
	element: CreateTimelineElement;
}
