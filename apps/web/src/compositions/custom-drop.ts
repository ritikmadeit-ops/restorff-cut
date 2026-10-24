/**
 * Custom compositions on the timeline (motion-code agent, 2026-10-20). Same mechanics as the library drop (drop.ts):
 * render → fetch the WebM → the editor's media import → a clip on the MOTION track; one undo step each. The clip
 * stores its code: element.restorff.composition = { custom: true, source, props, hash, width, height, fps, duration,
 * name, title, author } — saved with the project and its commits, so it can be reopened ("Edit code") and, when the
 * render is missing on this machine, re-made from the source (repairCustomRender).
 */
import type { EditorCore } from "@/core";
import { BatchCommand, type Command } from "@/commands";
import { AddMediaAssetCommand } from "@/commands/media";
import { InsertElementCommand, TracksSnapshotCommand } from "@/commands/timeline";
import type { ElementRef, SceneTracks, TimelineElement } from "@/timeline";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import { type CustomRenderAnswer, renderCustomAndProcess } from "./custom-api";
import {
	findElement,
	getCompositionSource,
	motionTrackFor,
	projectCanvas,
	replaceElementInTracks,
	withCompositionSource,
} from "./drop";
import { type CustomCompositionSource, isCustomSource, type ParamValues } from "./types";

/** Render custom code and place it on the MOTION track at the playhead (or `at` seconds). One undo step. */
export async function dropCustomComposition({
	editor,
	source,
	props,
	duration,
	at,
	author = "user",
}: {
	editor: EditorCore;
	source: string;
	props: ParamValues;
	duration?: number;
	at?: number;
	author?: "claude" | "user";
}): Promise<{ answer: CustomRenderAnswer }> {
	const project = editor.project.getActive();
	const imported = await renderCustomAndProcess({ source, props, duration, canvas: projectCanvas({ editor }), author });
	const addMedia = new AddMediaAssetCommand({ projectId: project.metadata.id, asset: imported.asset });
	const startTime = at !== undefined ? mediaTimeFromSeconds({ seconds: at }) : editor.playback.getCurrentTime();
	const length = mediaTimeFromSeconds({ seconds: imported.answer.duration });
	const { trackId, addTrack } = motionTrackFor({
		tracks: editor.scenes.getActiveScene().tracks,
		start: startTime,
		end: startTime + length,
	});
	const element = withCompositionSource({
		element: buildElementFromMedia({
			mediaId: addMedia.getAssetId(),
			mediaType: "video",
			name: imported.title,
			duration: length,
			startTime,
		}) as TimelineElement,
		source: imported.source,
	});
	const commands: Command[] = [addMedia];
	if (addTrack) commands.push(addTrack);
	commands.push(new InsertElementCommand({ element, placement: { mode: "explicit", trackId } }));
	editor.command.execute({ command: new BatchCommand(commands) });
	return { answer: imported.answer };
}

/**
 * Re-render a custom clip with new code, props and/or length and swap its media in place (same start and track; the
 * trims reset when the length changes). `force` swaps even when the hash is unchanged (a missing render).
 * Returns null when nothing would change.
 */
export async function rerenderCustomComposition({
	editor,
	ref,
	source,
	props,
	duration,
	force = false,
}: {
	editor: EditorCore;
	ref: ElementRef;
	source?: string;
	props?: ParamValues;
	duration?: number;
	force?: boolean;
}): Promise<{ answer: CustomRenderAnswer } | null> {
	const found = findElement({ editor, ref });
	const current = getCompositionSource({ element: found?.element });
	if (!found || !isCustomSource(current) || found.element.type !== "video") {
		throw new Error("select a custom composition clip first");
	}
	const project = editor.project.getActive();
	const imported = await renderCustomAndProcess({
		source: source ?? current.source,
		props: props ?? current.props,
		duration: duration ?? current.duration,
		canvas: projectCanvas({ editor }),
		author: current.author ?? "user",
	});
	if (!force && imported.answer.hash === current.hash && imported.source.source === current.source) return null;

	const again = findElement({ editor, ref });
	if (!again || again.element.type !== "video") throw new Error("the clip was removed while rendering");
	const old = again.element;
	const addMedia = new AddMediaAssetCommand({ projectId: project.metadata.id, asset: imported.asset });
	const newLength = mediaTimeFromSeconds({ seconds: imported.answer.duration });
	const sameLength = Math.abs(imported.answer.duration - current.duration) < 1e-6;
	const next = withCompositionSource({
		element: {
			...old,
			name: imported.title,
			mediaId: addMedia.getAssetId(),
			...(sameLength ? {} : { duration: newLength, trimStart: 0, trimEnd: 0, sourceDuration: newLength }),
		} as TimelineElement,
		source: imported.source,
	});
	const before = editor.scenes.getActiveScene().tracks;
	const after = replaceElementInTracks({ tracks: before, trackId: again.track.id, next });
	editor.command.execute({ command: new BatchCommand([addMedia, new TracksSnapshotCommand({ before, after })]) });
	return { answer: imported.answer };
}

export interface MissingCustomRender {
	ref: ElementRef;
	element: TimelineElement;
	source: CustomCompositionSource;
}

/**
 * Custom clips whose rendered video is not in this browser's media (a project opened on another machine, a cleared
 * cache, a commit pulled before its media). Empty while media is still loading.
 */
export function findMissingCustomRenders({
	tracks,
	mediaIds,
	loading,
}: {
	tracks: SceneTracks | null;
	mediaIds: Set<string>;
	loading: boolean;
}): MissingCustomRender[] {
	if (!tracks || loading) return [];
	const out: MissingCustomRender[] = [];
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		for (const element of track.elements) {
			const source = getCompositionSource({ element });
			if (!isCustomSource(source)) continue;
			const mediaId = (element as { mediaId?: string }).mediaId;
			if (mediaId && !mediaIds.has(mediaId)) out.push({ ref: { trackId: track.id, elementId: element.id }, element, source });
		}
	}
	return out;
}

/** Re-make a missing render from the clip's stored code and point the clip at it. One undo step. */
export async function repairCustomRender({ editor, ref }: { editor: EditorCore; ref: ElementRef }) {
	return rerenderCustomComposition({ editor, ref, force: true });
}

export function isMissingRender({ editor, element }: { editor: EditorCore; element: TimelineElement }): boolean {
	const mediaId = (element as { mediaId?: string }).mediaId;
	if (!mediaId || editor.media.isLoadingMedia()) return false;
	return !editor.media.getAssets().some((asset) => asset.id === mediaId);
}
