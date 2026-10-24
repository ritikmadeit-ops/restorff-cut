/**
 * The editor's project model, mirrored as plain types (no imports from apps/web, so this package stays pure and
 * importable from Node, Bun, the gateway and the Next app alike).
 *
 * Source of truth: apps/web/src/project/types.ts and apps/web/src/timeline/types.ts (see MODEL.md for file:line).
 * All times are integer TICKS (120 000 per second). Dates are ISO strings in the serialized form the editor stores
 * (services/storage/types.ts SerializedProject); `Date` objects are tolerated because the reducer never reads them.
 */

export type Ticks = number;

export interface FrameRate {
	numerator: number;
	denominator: number;
}

export type ParamValue = number | string | boolean;
export type ParamValues = Record<string, ParamValue>;

// ---------------------------------------------------------------- animation (animation/types.ts)

export type ScalarSegmentType = "step" | "linear" | "bezier";
export type TangentMode = "auto" | "aligned" | "broken" | "flat";
export type AnimationInterpolation = "linear" | "hold" | "bezier";

export interface CurveHandle {
	dt: Ticks;
	dv: number;
}

export interface ScalarAnimationKey {
	id: string;
	/** Relative to the element's startTime. */
	time: Ticks;
	value: number;
	leftHandle?: CurveHandle;
	rightHandle?: CurveHandle;
	segmentToNext: ScalarSegmentType;
	tangentMode: TangentMode;
}

export interface DiscreteAnimationKey {
	id: string;
	time: Ticks;
	value: string | boolean;
}

export interface ScalarChannel {
	keys: ScalarAnimationKey[];
	extrapolation?: { before: "hold" | "linear"; after: "hold" | "linear" };
}

export interface DiscreteChannel {
	keys: DiscreteAnimationKey[];
}

export type AnimationChannel = ScalarChannel | DiscreteChannel;
export type CompositeChannelData = Record<string, AnimationChannel | undefined>;
export type ChannelData = AnimationChannel | CompositeChannelData;
export type ElementAnimations = Record<string, ChannelData | undefined>;

// ---------------------------------------------------------------- effects / masks (opaque to ops@1)

export interface Effect {
	id: string;
	type: string;
	params: ParamValues;
	enabled: boolean;
}

/** Masks are carried through untouched (ops@1 has no mask op). */
export interface Mask {
	id: string;
	type: string;
	params: Record<string, unknown>;
}

// ---------------------------------------------------------------- Restorff extension (additive, see MODEL.md §7)

export type Author = "user" | "claude" | "compiler" | "preset";

export interface RestorffElementTag {
	createdBy?: Author;
	/** The author of the last op that changed this element. */
	author?: Author;
	role?: "caption" | "text_pop" | "sfx";
}

export interface RestorffTrackTag {
	/** "grade" (grade agent, 2026-10-20): the effect track holding the whole-timeline grade (./grades.ts). */
	role?: "caption" | "sfx" | "music" | "broll" | "aroll" | "text" | "grade";
	createdBy?: Author;
}

// ---------------------------------------------------------------- elements (timeline/types.ts)

export interface RetimeConfig {
	rate: number;
	maintainPitch?: boolean;
}

interface BaseElement {
	id: string;
	name: string;
	duration: Ticks;
	startTime: Ticks;
	trimStart: Ticks;
	trimEnd: Ticks;
	sourceDuration?: Ticks;
	animations?: ElementAnimations;
	params: ParamValues;
	restorff?: RestorffElementTag;
}

/**
 * Project v32: a transition INTO a video/image clip from the clip ending where it starts on the same track, centred on
 * the cut (half before, half after). Kinds: ./transitions.ts. Rendered by the wasm compositor.
 */
export interface ClipTransition {
	type: string;
	/** Total length, ticks. */
	duration: Ticks;
}

/** Project v32: beats of a music element's SOURCE media (move and trim with the clip). */
export interface BeatGrid {
	bpm: number;
	/** Source ticks, ascending. */
	times: Ticks[];
	/** Indices into `times` that start a bar. */
	downbeats?: number[];
	source: "detected" | "board" | "manual";
}

/** Project v32: the master loudness the export normalises to (measured on the encoded file). */
export interface LoudnessTarget {
	enabled: boolean;
	integratedLufs: number;
	truePeakDb: number;
}

export interface UploadAudioElement extends BaseElement {
	type: "audio";
	sourceType: "upload";
	mediaId: string;
	retime?: RetimeConfig;
	beats?: BeatGrid;
}

export interface LibraryAudioElement extends BaseElement {
	type: "audio";
	sourceType: "library";
	sourceUrl: string;
	retime?: RetimeConfig;
	beats?: BeatGrid;
}

export type AudioElement = UploadAudioElement | LibraryAudioElement;

export interface VideoElement extends BaseElement {
	type: "video";
	mediaId: string;
	isSourceAudioEnabled?: boolean;
	hidden?: boolean;
	retime?: RetimeConfig;
	effects?: Effect[];
	masks?: Mask[];
	transitionIn?: ClipTransition;
}

export interface ImageElement extends BaseElement {
	type: "image";
	mediaId: string;
	hidden?: boolean;
	effects?: Effect[];
	masks?: Mask[];
	transitionIn?: ClipTransition;
}

export interface TextElement extends BaseElement {
	type: "text";
	hidden?: boolean;
	effects?: Effect[];
}

export interface StickerElement extends BaseElement {
	type: "sticker";
	stickerId: string;
	intrinsicWidth?: number;
	intrinsicHeight?: number;
	hidden?: boolean;
	effects?: Effect[];
}

export interface GraphicElement extends BaseElement {
	type: "graphic";
	definitionId: string;
	hidden?: boolean;
	effects?: Effect[];
	masks?: Mask[];
}

export interface EffectElement extends BaseElement {
	type: "effect";
	effectType: string;
}

export type TimelineElement =
	| AudioElement
	| VideoElement
	| ImageElement
	| TextElement
	| StickerElement
	| GraphicElement
	| EffectElement;

export type ElementType = TimelineElement["type"];

// ---------------------------------------------------------------- tracks

export type TrackType = "video" | "text" | "audio" | "graphic" | "effect";

interface BaseTrack {
	id: string;
	name: string;
	restorff?: RestorffTrackTag;
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

export type TimelineTrack = VideoTrack | TextTrack | AudioTrack | GraphicTrack | EffectTrack;
export type OverlayTrack = VideoTrack | TextTrack | GraphicTrack | EffectTrack;

export interface SceneTracks {
	/** Display order top to bottom, all above the main track. */
	overlay: OverlayTrack[];
	main: VideoTrack;
	/** Display order top to bottom, all below the main track. */
	audio: AudioTrack[];
}

export interface Bookmark {
	time: Ticks;
	note?: string;
	color?: string;
	duration?: Ticks;
}

export interface Scene {
	id: string;
	name: string;
	isMain: boolean;
	tracks: SceneTracks;
	bookmarks: Bookmark[];
	createdAt: string | Date;
	updatedAt: string | Date;
}

// ---------------------------------------------------------------- project (project/types.ts)

export type Background = { type: "color"; color: string } | { type: "blur"; blurIntensity: number };

export interface CanvasSize {
	width: number;
	height: number;
}

export interface ProjectSettings {
	fps: FrameRate;
	canvasSize: CanvasSize;
	canvasSizeMode?: "preset" | "custom";
	lastCustomCanvasSize?: CanvasSize | null;
	originalCanvasSize?: CanvasSize | null;
	background: Background;
	/** v32. Absent = −14 LUFS / −1 dBTP. */
	loudness?: LoudnessTarget;
}

/** Restorff's additive block in project metadata: things the editor model cannot express yet. */
export interface RestorffProjectMeta {
	opsVersion: "ops@1";
	/** Ops the model cannot express, kept so they are never silently dropped (see MODEL.md §6). */
	pending: PendingInstruction[];
	/** Media referenced by ops; the assets themselves live in the editor's media store, not in the project. */
	media: MediaManifestEntry[];
}

export interface PendingInstruction {
	id: string;
	op: Record<string, unknown>;
	author: Author;
	reason: string;
	/** Who should honour it: the render worker, the gateway, a future editor feature. */
	honouredBy: "render" | "gateway" | "editor" | "variant-compiler";
}

export interface MediaManifestEntry {
	id: string;
	kind: "video" | "audio" | "image";
	name: string;
	blobSha?: string;
	url?: string;
	duration?: Ticks;
	width?: number;
	height?: number;
	fps?: number;
	hasAudio?: boolean;
	author: Author;
}

export interface ProjectMetadata {
	id: string;
	name: string;
	thumbnail?: string;
	duration: Ticks;
	createdAt: string | Date;
	updatedAt: string | Date;
	restorff?: RestorffProjectMeta;
}

export interface TimelineViewState {
	zoomLevel: number;
	scrollLeft: number;
	playheadTime: Ticks;
}

export interface Project {
	metadata: ProjectMetadata;
	scenes: Scene[];
	currentSceneId: string;
	settings: ProjectSettings;
	version: number;
	timelineViewState?: TimelineViewState;
}

/**
 * apps/web/src/services/storage/migrations/index.ts CURRENT_PROJECT_VERSION. v32 (2026-10-20, media agent) only added
 * optional fields (transitionIn, beats, settings.loudness), so the reducer reads v31 and v32 alike.
 */
export const EDITOR_PROJECT_VERSION = 32;
export const OLDEST_READABLE_PROJECT_VERSION = 31;
