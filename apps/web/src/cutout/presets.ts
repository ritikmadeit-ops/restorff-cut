/**
 * One-click presets built on a cutout (EFFECTS.md "M" — person matte):
 * - text-behind  (FX-43) a big headline between the background and the person
 * - green-screen (FX-12) replace the background with a colour, an image/video, or blur it
 * - cover-story  (FX-16) magazine masthead behind the head + inset frame + dateline and cover lines in front
 * - frame-break  (FX-04) the clip shrinks into a framed inset and the person breaks out over the frame
 *
 * Every preset: makes the cutout first if the clip has none (reuses it otherwise), then inserts its elements with ONE
 * undo step. Layer order follows EFFECTS.md "Layers" (bottom → top).
 */
import { BatchCommand, type Command } from "@/commands";
import { AddMediaAssetCommand } from "@/commands/media";
import { TracksSnapshotCommand } from "@/commands/timeline";
import type { EditorCore } from "@/core";
import { buildDefaultEffectInstance } from "@/effects";
import { loadFullFont } from "@/fonts/google-fonts";
import { buildDefaultMaskInstance } from "@/masks";
import type { RectangleMask } from "@/masks/types";
import { processMediaAssets, type ProcessedMediaAsset } from "@/media/processing";
import type { MediaAsset } from "@/media/types";
import type { Box } from "@/segmentation/types";
import type {
	ElementRef,
	ImageElement,
	OverlayTrack,
	SceneTracks,
	TimelineElement,
	VideoElement,
} from "@/timeline";
import { buildElementFromMedia, buildGraphicElement, buildTextElement } from "@/timeline/element-utils";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds } from "@/wasm";
import { cutOutPerson, projectInfo } from "./cut-out-person";
// Pure layout maths shared with the MCP `cutout apply` (server); moved there by the mcp-cutout agent, 2026-10-20.
import {
	backgroundRectParams,
	CONDENSED_FONTS,
	coverScale,
	coverStoryLayout,
	frameBreakLayout,
	headOnCanvas as headOnCanvasFromRect,
	textBehindLayout,
} from "./preset-layout";
import {
	elementRect,
	getCutoutSource,
	insertOverlayTrack,
	locateElement,
	newGraphicTrack,
	newTextTrack,
	newVideoTrack,
	readNumber,
	replaceElementInTracks,
	scalarChannel,
	type LocatedElement,
} from "./timeline-utils";
import type {
	CoverStoryOptions,
	CutoutProgressHandler,
	CutoutSource,
	FrameBreakOptions,
	GreenScreenBackground,
	MattePresetId,
	MattePresetOptions,
	TextBehindOptions,
} from "./types";

export interface MattePresetInfo {
	id: MattePresetId;
	/** EFFECTS.md id. */
	fx: string;
	name: string;
	description: string;
}

/** For the Effects panel / command bar: what each preset is. */
export const MATTE_PRESETS: MattePresetInfo[] = [
	{
		id: "text-behind",
		fx: "FX-43",
		name: "Text behind person",
		description: "A big headline between the background and the speaker.",
	},
	{
		id: "green-screen",
		fx: "FX-12",
		name: "Green screen",
		description: "Replace the background with a colour, an image or a blur — no green screen needed.",
	},
	{
		id: "cover-story",
		fx: "FX-16",
		name: "Cover story",
		description: "Magazine masthead behind the head, inset frame, dateline and cover lines.",
	},
	{
		id: "frame-break",
		fx: "FX-04",
		name: "Frame break",
		description: "The shot shrinks into a framed inset and the speaker breaks out over its edge.",
	},
];

interface Context {
	editor: EditorCore;
	canvas: { width: number; height: number };
	before: SceneTracks;
	plate: LocatedElement;
	cutout: LocatedElement;
	source: CutoutSource;
	asset: MediaAsset | null;
}

/** Overlay index right below the cutout track (= between the person and the clip). */
function behindIndex(context: Context): number {
	return context.cutout.location.kind === "overlay" ? context.cutout.location.index + 1 : context.before.overlay.length;
}

/** Overlay index right above the cutout track. */
function frontIndex(context: Context): number {
	return context.cutout.location.kind === "overlay" ? context.cutout.location.index : 0;
}

function seconds(value: number) {
	return mediaTimeFromSeconds({ seconds: value });
}

/** The head box on the canvas (px), or a sensible guess when nobody was found. */
function headOnCanvas(context: Context): { top: number; centerX: number; height: number } {
	const rect = elementRect({ element: context.plate.element, asset: context.asset, canvas: context.canvas });
	const head: Box | null = context.source.head;
	return headOnCanvasFromRect({ rect, head, person: context.source.person, canvas: context.canvas });
}

function textElement({
	name,
	content,
	plate,
	params,
	animations,
}: {
	name: string;
	content: string;
	plate: TimelineElement;
	params: Record<string, unknown>;
	animations?: TimelineElement["animations"];
}): TimelineElement {
	const created = buildTextElement({
		raw: { name, duration: plate.duration, params: { content, ...params } as never },
		startTime: plate.startTime,
	});
	return { ...created, id: generateUUID(), animations } as TimelineElement;
}

function fadeScaleIn({ from = 0.92, fadeSeconds = 0.25, delaySeconds = 0 } = {}) {
	return {
		opacity: scalarChannel([
			{ time: seconds(delaySeconds), value: 0 },
			{ time: seconds(delaySeconds + fadeSeconds), value: 1 },
		]),
		"transform.scaleX": scalarChannel([
			{ time: seconds(delaySeconds), value: from },
			{ time: seconds(delaySeconds + fadeSeconds), value: 1 },
		]),
		"transform.scaleY": scalarChannel([
			{ time: seconds(delaySeconds), value: from },
			{ time: seconds(delaySeconds + fadeSeconds), value: 1 },
		]),
	};
}

/** Fonts a preset draws with; loaded before the timeline is read so the insert itself is synchronous. */
async function preloadFonts(preset: MattePresetOptions) {
	const fonts: Array<{ family: string; weights: number[] }> = [];
	if (preset.preset === "text-behind") {
		const family = preset.options.fontFamily ?? "Anton";
		fonts.push({ family, weights: CONDENSED_FONTS.test(family) ? [400] : [400, 700] });
	}
	if (preset.preset === "cover-story") {
		fonts.push({ family: "Bodoni Moda", weights: [400, 700] }, { family: "Archivo", weights: [400, 700] });
	}
	await Promise.all(fonts.map((font) => loadFullFont(font).catch(() => undefined)));
}

// ---------------------------------------------------------------- text behind (FX-43)

function textBehind(context: Context, options: TextBehindOptions) {
	const layer = textBehindLayout({
		text: options.text,
		fontFamily: options.fontFamily,
		color: options.color,
		canvas: context.canvas,
		head: headOnCanvas(context),
	});
	const element = textElement({
		name: `Behind · ${layer.content}`,
		content: layer.content,
		plate: context.plate.element,
		params: layer.params,
		animations: fadeScaleIn(layer.animation),
	});
	const after = insertOverlayTrack({
		tracks: context.before,
		index: behindIndex(context),
		track: newTextTrack("BEHIND TEXT", [element]),
	});
	return { after, commands: [] as Command[] };
}

// ---------------------------------------------------------------- green screen (FX-12)

/** A background file imported before the timeline is read (so the insert stays one synchronous step). */
type PreparedBackground =
	| Exclude<GreenScreenBackground, { kind: "file" }>
	| { kind: "processed"; asset: ProcessedMediaAsset };

async function prepareBackground(background: GreenScreenBackground): Promise<PreparedBackground> {
	if (background.kind !== "file") return background;
	const [processed] = await processMediaAssets({ files: [background.file] });
	if (!processed) throw new Error("the editor could not import the background file");
	if (processed.type === "audio") throw new Error("pick an image or a video for the background");
	return { kind: "processed", asset: processed };
}

function greenScreen(context: Context, background: PreparedBackground) {
	const { canvas, plate, before, editor } = context;
	const plateElement = plate.element as VideoElement | ImageElement;
	const commands: Command[] = [];

	if (background.kind === "blur") {
		const blur = buildDefaultEffectInstance({ effectType: "blur" });
		blur.params = { ...blur.params, intensity: Math.max(0, Math.min(100, background.intensity)) };
		const next = {
			...plateElement,
			effects: [...(plateElement.effects ?? []).filter((effect) => effect.type !== "blur"), blur],
		} as TimelineElement;
		return { after: replaceElementInTracks({ tracks: before, next }), commands };
	}

	if (background.kind === "color") {
		const created = buildGraphicElement({
			definitionId: "rectangle",
			name: "Background",
			startTime: plateElement.startTime,
			params: backgroundRectParams({ canvas, color: background.color }) as never,
		});
		const element = { ...created, id: generateUUID(), duration: plateElement.duration } as TimelineElement;
		const after = insertOverlayTrack({
			tracks: before,
			index: behindIndex(context),
			track: newGraphicTrack("BACKGROUND", [element]),
		});
		return { after, commands };
	}

	let media: Pick<MediaAsset, "type" | "width" | "height" | "duration" | "name"> & { id: string };
	if (background.kind === "processed") {
		const add = new AddMediaAssetCommand({
			projectId: editor.project.getActive().metadata.id,
			asset: background.asset,
		});
		commands.push(add);
		media = { ...background.asset, id: add.getAssetId() };
	} else {
		const found = editor.media.getAssets().find((asset) => asset.id === background.mediaId);
		if (!found) throw new Error("that background media is not in this project");
		if (found.type === "audio") throw new Error("pick an image or a video for the background");
		media = found;
	}
	const mediaDuration =
		media.type === "video" && media.duration ? seconds(media.duration) : plateElement.duration;
	const duration = Math.min(plateElement.duration, mediaDuration) as typeof plateElement.duration;
	const created = buildElementFromMedia({
		mediaId: media.id,
		mediaType: media.type,
		name: `Background · ${media.name}`,
		duration,
		startTime: plateElement.startTime,
	});
	const scale = coverScale({
		canvas,
		width: media.width || canvas.width,
		height: media.height || canvas.height,
	});
	const element = {
		...created,
		id: generateUUID(),
		...(media.type === "video" ? { isSourceAudioEnabled: false, sourceDuration: mediaDuration } : {}),
		params: { ...created.params, "transform.scaleX": scale, "transform.scaleY": scale },
	} as TimelineElement;
	const after = insertOverlayTrack({
		tracks: before,
		index: behindIndex(context),
		track: newVideoTrack("BACKGROUND", [element]),
	});
	return { after, commands };
}

// ---------------------------------------------------------------- cover story (FX-16)

function coverStory(context: Context, options: CoverStoryOptions) {
	const { canvas, plate } = context;
	const layout = coverStoryLayout({
		masthead: options.masthead,
		dateline: options.dateline,
		lines: options.lines,
		color: options.color,
		canvas,
		head: headOnCanvas(context),
	});
	const mastheadElement = textElement({
		name: `Masthead · ${layout.masthead.content}`,
		content: layout.masthead.content,
		plate: plate.element,
		params: layout.masthead.params,
		animations: fadeScaleIn(layout.masthead.animation),
	});

	const frameCreated = buildGraphicElement({
		definitionId: "rectangle",
		name: "Cover frame",
		startTime: plate.element.startTime,
		params: layout.frame as never,
	});
	const frameElement = { ...frameCreated, id: generateUUID(), duration: plate.element.duration } as TimelineElement;

	const datelineElement = textElement({
		name: "Dateline",
		content: layout.dateline.content,
		plate: plate.element,
		params: layout.dateline.params,
		animations: fadeScaleIn(layout.dateline.animation),
	});
	const linesElement = layout.lines
		? textElement({
				name: "Cover lines",
				content: layout.lines.content,
				plate: plate.element,
				params: layout.lines.params,
				animations: fadeScaleIn(layout.lines.animation),
			})
		: null;

	// Behind the person: frame (lowest), masthead. In front: cover lines, dateline (top).
	let after = insertOverlayTrack({
		tracks: context.before,
		index: behindIndex(context),
		track: newGraphicTrack("COVER FRAME", [frameElement]),
	});
	after = insertOverlayTrack({
		tracks: after,
		index: behindIndex(context),
		track: newTextTrack("COVER MASTHEAD", [mastheadElement]),
	});
	const front: OverlayTrack[] = [];
	if (linesElement) front.push(newTextTrack("COVER LINES", [linesElement]));
	front.unshift(newTextTrack("COVER DATELINE", [datelineElement]));
	for (const track of front.reverse()) {
		after = insertOverlayTrack({ tracks: after, index: frontIndex(context), track });
	}
	return { after, commands: [] as Command[] };
}

// ---------------------------------------------------------------- frame break (FX-04)

function frameBreak(context: Context, options: FrameBreakOptions) {
	const layout = frameBreakLayout(options);
	const scale = layout.scale;
	const shrink = layout.shrinkSeconds;
	const plateElement = context.plate.element as VideoElement | ImageElement;
	const cutoutElement = context.cutout.element as VideoElement | ImageElement;
	const baseScaleX = readNumber(plateElement.params as Record<string, unknown>, "transform.scaleX", 1);
	const baseScaleY = readNumber(plateElement.params as Record<string, unknown>, "transform.scaleY", 1);
	const scaleKeys = (base: number) =>
		scalarChannel([
			{ time: 0, value: base },
			{ time: seconds(shrink), value: base * scale },
		]);
	const scaleAnimations = {
		"transform.scaleX": scaleKeys(baseScaleX),
		"transform.scaleY": scaleKeys(baseScaleY),
	};
	const mask = buildDefaultMaskInstance({ maskType: "rectangle" }) as RectangleMask;
	mask.params = { ...mask.params, ...layout.mask };
	const nextPlate = {
		...plateElement,
		masks: [mask],
		animations: { ...(plateElement.animations ?? {}), ...structuredClone(scaleAnimations) },
	} as TimelineElement;
	const nextCutout = {
		...cutoutElement,
		animations: { ...(cutoutElement.animations ?? {}), ...structuredClone(scaleAnimations) },
	} as TimelineElement;
	let after = replaceElementInTracks({ tracks: context.before, next: nextPlate });
	after = replaceElementInTracks({ tracks: after, next: nextCutout });
	return { after, commands: [] as Command[] };
}

// ---------------------------------------------------------------- entry point

/**
 * Applies a preset to the clip at `ref` (a clip or its cutout). Makes the cutout first when needed (that is its own
 * undo step); the preset itself is one more.
 */
export async function applyMattePreset({
	editor,
	ref,
	preset,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	ref: ElementRef;
	preset: MattePresetOptions;
	onProgress?: CutoutProgressHandler;
	signal?: AbortSignal;
}): Promise<{ cutout: { trackId: string; elementId: string } }> {
	const made = await cutOutPerson({ editor, ref, onProgress, signal });
	onProgress?.({ phase: "insert", progress: 0.3, message: "Placing the effect…" });
	await preloadFonts(preset);
	const background =
		preset.preset === "green-screen" ? await prepareBackground(preset.options.background) : null;

	// Synchronous from here: read the timeline, build the change, execute it.
	const { canvas } = projectInfo({ editor });
	const before = editor.scenes.getActiveScene().tracks;
	const cutout = locateElement({ tracks: before, elementId: made.cutout.elementId });
	const plate = locateElement({ tracks: before, elementId: made.source.elementId });
	if (!cutout || !plate) throw new Error("the clip or its cutout is no longer on the timeline");
	const source = getCutoutSource(cutout.element);
	if (!source) throw new Error("the cutout lost its source information");
	const plateElement = plate.element as VideoElement | ImageElement;
	const asset = editor.media.getAssets().find((candidate) => candidate.id === plateElement.mediaId) ?? null;
	const context: Context = { editor, canvas, before, plate, cutout, source, asset };

	let result: { after: SceneTracks; commands: Command[] };
	switch (preset.preset) {
		case "text-behind":
			result = textBehind(context, preset.options);
			break;
		case "green-screen":
			result = greenScreen(context, background as PreparedBackground);
			break;
		case "cover-story":
			result = coverStory(context, preset.options);
			break;
		case "frame-break":
			result = frameBreak(context, preset.options);
			break;
	}
	editor.command.execute({
		command: new BatchCommand([...result.commands, new TracksSnapshotCommand({ before, after: result.after })]),
	});
	onProgress?.({ phase: "insert", progress: 1, message: "Done" });
	return { cutout: made.cutout };
}
