/**
 * The compositions drop: render on the server → fetch the WebM (VP9 with alpha) → the editor's normal media import
 * (processMediaAssets + AddMediaAssetCommand, same path as paste/upload) → a clip on the MOTION overlay track at the
 * playhead. Re-render in place keeps the clip (start, length, track) and swaps its media. One undo step each.
 *
 * Runbook and decisions: docs/restorff/worklog/compose.md.
 */
import type { EditorCore } from "@/core";
import { BatchCommand, type Command } from "@/commands";
import { AddMediaAssetCommand } from "@/commands/media";
import {
	AddTrackCommand,
	InsertElementCommand,
	TracksSnapshotCommand,
} from "@/commands/timeline";
import { processMediaAssets, type ProcessedMediaAsset } from "@/media/processing";
import type { MediaAsset } from "@/media/types";
import type {
	ElementRef,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import { fetchCatalogue, fetchRenderFile, renderComposition } from "./api";
import { renderCustomAndProcess } from "./custom-api";
import { dropLayeredComposition } from "./drop-layered";
import {
	type CompositionEntry,
	type CompositionSource,
	isCustomSource,
	type ParamValues,
	type RenderAnswer,
} from "./types";

/** Overlay track compositions go on (top of the overlay group, above captions and B-roll). */
export const MOTION_TRACK_NAME = "MOTION";

/** What an element carries when it is a rendered composition (see CompositionSource). */
type WithSource = TimelineElement & {
	restorff?: { composition?: CompositionSource; [key: string]: unknown };
};

export function getCompositionSource({
	element,
}: {
	element: TimelineElement | null | undefined;
}): CompositionSource | null {
	if (!element || element.type !== "video") return null;
	return (element as WithSource).restorff?.composition ?? null;
}

export function withCompositionSource<T extends TimelineElement>({
	element,
	source,
}: {
	element: T;
	source: CompositionSource;
}): T {
	const current = (element as WithSource).restorff ?? {};
	return { ...element, restorff: { ...current, composition: source } } as T;
}

/** The project's canvas: compositions render at exactly this size and frame rate. */
export function projectCanvas({ editor }: { editor: EditorCore }): {
	width: number;
	height: number;
	fps: number;
} {
	const settings = editor.project.getActive().settings;
	const fps = settings.fps.numerator / settings.fps.denominator;
	return {
		width: settings.canvasSize.width,
		height: settings.canvasSize.height,
		fps: Math.max(1, Math.min(120, Math.round(fps))),
	};
}

export interface ImportedRender {
	answer: RenderAnswer;
	asset: ProcessedMediaAsset;
	source: CompositionSource;
	title: string;
}

/** Render (or hit the cache), download, and run the file through the editor's media processing. Nothing is committed. */
export async function renderAndProcess({
	editor,
	name,
	props,
}: {
	editor: EditorCore;
	name: string;
	props: ParamValues;
}): Promise<ImportedRender> {
	const canvas = projectCanvas({ editor });
	const catalogue = await fetchCatalogue();
	const entry = catalogue.find((candidate) => candidate.name === name);
	const title = entry?.title ?? name;
	const answer = await renderComposition({ name, props, ...canvas });
	const file = await fetchRenderFile({ answer, title });
	const [asset] = await processMediaAssets({ files: [file] });
	if (!asset) throw new Error(`the editor could not import the ${title} render`);
	return {
		answer,
		asset,
		title,
		source: {
			name,
			props,
			hash: answer.hash,
			width: answer.width,
			height: answer.height,
			fps: answer.fps,
			duration: answer.duration,
		},
	};
}

function overlaps({
	track,
	start,
	end,
}: {
	track: TimelineTrack;
	start: number;
	end: number;
}): boolean {
	return track.elements.some(
		(element) => start < element.startTime + element.duration && end > element.startTime,
	);
}

/** A MOTION track with room for [start, end), or a command that makes one on top. */
export function motionTrackFor({
	tracks,
	start,
	end,
}: {
	tracks: SceneTracks;
	start: number;
	end: number;
}): { trackId: string; addTrack: AddTrackCommand | null } {
	const motion = tracks.overlay.filter(
		(track) =>
			track.type === "video" &&
			track.name.toUpperCase().startsWith(MOTION_TRACK_NAME),
	);
	const free = motion.find((track) => !overlaps({ track, start, end }));
	if (free) return { trackId: free.id, addTrack: null };
	const addTrack = new AddTrackCommand({
		type: "video",
		index: 0,
		name: motion.length === 0 ? MOTION_TRACK_NAME : `${MOTION_TRACK_NAME} ${motion.length + 1}`,
	});
	return { trackId: addTrack.getTrackId(), addTrack };
}

/** Render a composition and drop it on the MOTION track at the playhead (or `at`). One undo step. */
export async function dropComposition({
	editor,
	entry,
	props,
	at,
}: {
	editor: EditorCore;
	entry: CompositionEntry;
	props: ParamValues;
	at?: number;
}): Promise<{ answer: RenderAnswer; layers?: string[]; note?: string }> {
	// a person effect (manifest recipe with a cutout) goes in layers around the clip's cutout, like MCP effects apply
	// (effects-layers agent, 2026-10-20: ./drop-layered.ts); without a cutout it drops one overlay as before
	const layered = await dropLayeredComposition({ editor, entry, props, at });
	if (layered.placed) return { answer: layered.answer, layers: layered.layers };
	const note = layered.why === "no person recipe" ? undefined : `One overlay (nothing behind the speaker): ${layered.why}.`;
	const project = editor.project.getActive();
	const imported = await renderAndProcess({ editor, name: entry.name, props });
	const addMedia = new AddMediaAssetCommand({
		projectId: project.metadata.id,
		asset: imported.asset,
	});
	const startTime =
		at !== undefined
			? mediaTimeFromSeconds({ seconds: at })
			: editor.playback.getCurrentTime();
	const duration = mediaTimeFromSeconds({ seconds: imported.answer.duration });
	const { trackId, addTrack } = motionTrackFor({
		tracks: editor.scenes.getActiveScene().tracks,
		start: startTime,
		end: startTime + duration,
	});
	const element = withCompositionSource({
		element: buildElementFromMedia({
			mediaId: addMedia.getAssetId(),
			mediaType: "video",
			name: entry.title,
			duration,
			startTime,
		}) as TimelineElement,
		source: imported.source,
	});
	const insert = new InsertElementCommand({
		element,
		placement: { mode: "explicit", trackId },
	});
	const commands: Command[] = [addMedia];
	if (addTrack) commands.push(addTrack);
	commands.push(insert);
	editor.command.execute({ command: new BatchCommand(commands) });
	return { answer: imported.answer, ...(note ? { note } : {}) };
}

export function findElement({
	editor,
	ref,
}: {
	editor: EditorCore;
	ref: ElementRef;
}): { track: TimelineTrack; element: TimelineElement } | null {
	const tracks = editor.scenes.getActiveScene().tracks;
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		if (track.id !== ref.trackId) continue;
		const element = track.elements.find((candidate) => candidate.id === ref.elementId);
		if (element) return { track: track as TimelineTrack, element };
	}
	return null;
}

export function replaceElementInTracks({
	tracks,
	trackId,
	next,
}: {
	tracks: SceneTracks;
	trackId: string;
	next: TimelineElement;
}): SceneTracks {
	const swap = <T extends TimelineTrack>(track: T): T =>
		track.id !== trackId
			? track
			: ({
					...track,
					elements: track.elements.map((element) =>
						element.id === next.id ? next : element,
					),
				} as T);
	return {
		overlay: tracks.overlay.map(swap),
		main: swap(tracks.main),
		audio: tracks.audio.map(swap),
	};
}

/**
 * Re-render a composition clip with new props and swap the clip's media in place (same start, track and, when the
 * render length is unchanged, the same trims). The old render's media asset is removed when nothing else uses it.
 * Returns null when the new props give the same render (same hash): nothing to do.
 */
export async function rerenderComposition({
	editor,
	ref,
	props,
}: {
	editor: EditorCore;
	ref: ElementRef;
	props: ParamValues;
}): Promise<{ answer: RenderAnswer } | null> {
	const prepared = await prepareRerender({ editor, ref, props });
	if (!prepared) return null;
	const before = editor.scenes.getActiveScene().tracks;
	const after = replaceElementInTracks({ tracks: before, trackId: prepared.trackId, next: prepared.next });
	// The old render stays in the media list: RemoveMediaAssetCommand revokes its object URL, so undoing the swap
	// would bring back a clip that can no longer play (open issue in the worklog).
	const commands: Command[] = [prepared.addMedia, new TracksSnapshotCommand({ before, after })];
	editor.command.execute({ command: new BatchCommand(commands) });
	return { answer: prepared.answer };
}

/**
 * The re-render of a composition clip WITHOUT touching the timeline (ui-fix-panels, QA #29: a "Tell Claude"
 * proposal must not change the timeline until Accept): the render, the media command that would add it, and the
 * clip as it would be. null when the render is the same file. The caller executes `addMedia` + the swap.
 */
export async function prepareRerender({
	editor,
	ref,
	props,
}: {
	editor: EditorCore;
	ref: ElementRef;
	props: ParamValues;
}): Promise<{ answer: RenderAnswer; addMedia: AddMediaAssetCommand; asset: MediaAsset; next: TimelineElement; trackId: string } | null> {
	const found = findElement({ editor, ref });
	const source = getCompositionSource({ element: found?.element });
	if (!found || !source || found.element.type !== "video") {
		throw new Error("select a composition clip first");
	}
	const project = editor.project.getActive();
	// A custom composition re-renders from the code it carries (motion-code agent); a library one by name.
	const imported = isCustomSource(source)
		? await renderCustomAndProcess({
				source: source.source,
				props,
				duration: source.duration,
				canvas: projectCanvas({ editor }),
				author: source.author ?? "user",
			})
		: await renderAndProcess({ editor, name: source.name, props });
	if (imported.answer.hash === source.hash) return null;

	// The clip may have moved while the render ran: read it again.
	const current = findElement({ editor, ref });
	if (!current || current.element.type !== "video") throw new Error("the clip was removed while rendering");
	const old = current.element;
	const addMedia = new AddMediaAssetCommand({
		projectId: project.metadata.id,
		asset: imported.asset,
	});
	const newLength = mediaTimeFromSeconds({ seconds: imported.answer.duration });
	const sameLength = Math.abs(imported.answer.duration - source.duration) < 1e-6;
	const next = withCompositionSource({
		element: {
			...old,
			mediaId: addMedia.getAssetId(),
			...(sameLength
				? {}
				: {
						duration: newLength,
						trimStart: 0,
						trimEnd: 0,
						sourceDuration: newLength,
					}),
		} as TimelineElement,
		source: imported.source,
	});
	return { answer: imported.answer, addMedia, asset: { ...imported.asset, id: addMedia.getAssetId() } as MediaAsset, next, trackId: current.track.id };
}
