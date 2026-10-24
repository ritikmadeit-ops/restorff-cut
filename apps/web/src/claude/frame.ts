/**
 * One frame of the timeline as a small JPEG data URL, drawn by the editor's own renderer (same path as the
 * preview's "copy snapshot": buildScene → CanvasRenderer.renderToCanvas). Used for the command bar's before/after.
 * `tracks` lets a caller draw a state that is not (or no longer) the editor's current one.
 */
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildScene } from "@/services/renderer/scene-builder";
import type { SceneTracks } from "@/timeline";

export async function captureFrame({
	editor,
	tracks,
	time,
	width = 360,
	extraAssets,
}: {
	editor: EditorCore;
	tracks?: SceneTracks;
	/** Ticks; default: the playhead. */
	time?: number;
	width?: number;
	/** Media a proposed state plays that is not in the media store yet (a proposal's renders, ui-fix-panels QA #29). */
	extraAssets?: MediaAsset[];
}): Promise<string | null> {
	try {
		const project = editor.project.getActiveOrNull();
		if (!project) return null;
		const sceneTracks = tracks ?? editor.scenes.getActiveScene().tracks;
		const duration = editor.timeline.getTotalDuration();
		if (!duration) return null;
		const { canvasSize, background, fps } = project.settings;
		const scene = buildScene({
			tracks: sceneTracks,
			mediaAssets: extraAssets?.length ? [...editor.media.getAssets(), ...extraAssets] : editor.media.getAssets(),
			duration,
			canvasSize,
			background,
		});
		// Full canvas size: the compositor is shared with the preview and must keep its size.
		const renderer = new CanvasRenderer({ width: canvasSize.width, height: canvasSize.height, fps });
		const target = document.createElement("canvas");
		target.width = width;
		target.height = Math.max(1, Math.round((width * canvasSize.height) / canvasSize.width));
		const at = Math.min(time ?? editor.playback.getCurrentTime(), editor.timeline.getLastFrameTime());
		await renderer.renderToCanvas({ node: scene, time: Math.max(0, at), targetCanvas: target });
		return target.toDataURL("image/jpeg", 0.82);
	} catch (error) {
		console.warn("[command-bar] frame capture failed", error);
		return null;
	}
}
