/**
 * Auto-reframe: the 9:16 master scene → a derived scene per size (4:5, 1:1, 16:9) whose full-frame clips follow the
 * speaker (person/face boxes per second from the segmentation worker), and a size switch that moves between them.
 *
 * Why scenes: the project has one canvas size; a scene per size keeps every delivery size editable on the same
 * timeline model and exportable with the normal exporter (switch size → export). Edits made to the master after a
 * size was built do NOT flow into it — use "Rebuild from master" (worklog: open issue).
 */
import { Command, createElementSelectionResult, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TCanvasSize } from "@/project/types";
import { getMatte } from "@/segmentation/cache";
import { BOX_ANALYSIS_FPS } from "@/segmentation/config";
import { subjectSeries, type SubjectSample } from "@/segmentation/matte";
import type { SceneTracks, TScene, TimelineElement, VideoElement } from "@/timeline";
import { buildDefaultScene } from "@/timeline/scenes";
import { mediaTimeToSeconds } from "@/wasm";
import { getCutoutSource } from "@/cutout/timeline-utils";
import type { CutoutProgressHandler } from "@/cutout/types";
import { isFullFrame, planReframe } from "./plan";
import { REFRAME_SIZES, nearestSize, sceneNameForSize, type ReframeSizeId } from "./sizes";
import { ensureReframeState, type ReframeState } from "./state";

type RestorffMeta = { restorff?: Record<string, unknown> };

interface SceneSwitch {
	scenes: TScene[];
	activeSceneId: string;
	canvasSize: TCanvasSize;
	restorff: Record<string, unknown> | undefined;
}

/** Scenes + active scene + canvas size + reframe state in one undoable step. */
export class ReframeSceneCommand extends Command {
	private saved: SceneSwitch | null = null;

	constructor(private next: SceneSwitch) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const project = editor.project.getActive();
		this.saved = {
			scenes: editor.scenes.getScenes(),
			activeSceneId: project.currentSceneId,
			canvasSize: project.settings.canvasSize,
			restorff: (project.metadata as RestorffMeta).restorff,
		};
		apply(this.next);
		return createElementSelectionResult([]);
	}

	undo(): void {
		if (this.saved) apply(this.saved);
	}
}

function apply(target: SceneSwitch) {
	const editor = EditorCore.getInstance();
	editor.scenes.setScenes({ scenes: target.scenes, activeSceneId: target.activeSceneId });
	const project = editor.project.getActive();
	const metadata = { ...project.metadata, updatedAt: new Date() } as typeof project.metadata & RestorffMeta;
	if (target.restorff === undefined) delete metadata.restorff;
	else metadata.restorff = target.restorff;
	editor.project.setActiveProject({
		project: {
			...project,
			currentSceneId: target.activeSceneId,
			settings: { ...project.settings, canvasSize: target.canvasSize },
			metadata,
		},
	});
	editor.save.markDirty();
}

function restorffWith(state: ReframeState): Record<string, unknown> {
	const project = EditorCore.getInstance().project.getActive();
	return { ...((project.metadata as RestorffMeta).restorff ?? {}), reframe: state };
}

/** Subject samples (1 per second, smoothed) for every full-frame video clip of the master. */
async function analyseSubjects({
	editor,
	tracks,
	master,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	tracks: SceneTracks;
	master: TCanvasSize;
	onProgress?: CutoutProgressHandler;
	signal?: AbortSignal;
}): Promise<Map<string, SubjectSample[]>> {
	const clips: VideoElement[] = [];
	for (const track of [tracks.main, ...tracks.overlay]) {
		if (track.type !== "video") continue;
		for (const element of track.elements as TimelineElement[]) {
			if (element.type !== "video" || getCutoutSource(element)) continue;
			if (!isFullFrame({ element, master })) continue;
			clips.push(element);
		}
	}
	const subjects = new Map<string, SubjectSample[]>();
	const assets = editor.media.getAssets();
	for (let index = 0; index < clips.length; index++) {
		if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
		const clip = clips[index];
		const asset = assets.find((candidate) => candidate.id === clip.mediaId);
		if (!asset?.file) continue;
		const rate = clip.retime?.rate && clip.retime.rate > 0 ? clip.retime.rate : 1;
		const start = Math.max(0, mediaTimeToSeconds({ time: clip.trimStart }));
		let end = start + mediaTimeToSeconds({ time: clip.duration }) * rate;
		if (asset.duration) end = Math.min(end, asset.duration);
		if (end <= start) continue;
		try {
			const matte = await getMatte({
				mediaId: asset.id,
				file: asset.file,
				start,
				end,
				fps: BOX_ANALYSIS_FPS,
				keepAlpha: false,
				signal,
				onProgress: ({ done, total }) =>
					onProgress?.({
						phase: "segment",
						progress: (index + (total > 0 ? done / total : 0)) / clips.length,
						message: `Finding the speaker · clip ${index + 1} of ${clips.length}`,
					}),
			});
			subjects.set(clip.id, subjectSeries({ header: matte.header, step: 1, window: 3 }));
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") throw error;
			console.warn(`[reframe] could not analyse ${clip.name}; it will be centred`, error);
		}
	}
	return subjects;
}

/**
 * Switches the editor to `size`. Builds the derived scene first when it does not exist yet (or when `rebuild`).
 * Returns the scene id now active.
 */
export async function switchToSize({
	editor,
	size,
	rebuild = false,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	size: ReframeSizeId;
	rebuild?: boolean;
	onProgress?: CutoutProgressHandler;
	signal?: AbortSignal;
}): Promise<string> {
	const project = editor.project.getActive();
	const state = ensureReframeState(project);
	if (project.currentSceneId === state.masterSceneId) state.masterCanvas = project.settings.canvasSize;
	const masterSize = nearestSize(state.masterCanvas);

	if (size === masterSize) {
		editor.command.execute({
			command: new ReframeSceneCommand({
				scenes: editor.scenes.getScenes(),
				activeSceneId: state.masterSceneId,
				canvasSize: state.masterCanvas,
				restorff: restorffWith(state),
			}),
		});
		return state.masterSceneId;
	}

	const target = REFRAME_SIZES[size];
	const existingId = state.scenes[size];
	if (existingId && !rebuild) {
		editor.command.execute({
			command: new ReframeSceneCommand({
				scenes: editor.scenes.getScenes(),
				activeSceneId: existingId,
				canvasSize: { width: target.width, height: target.height },
				restorff: restorffWith(state),
			}),
		});
		return existingId;
	}

	const masterScene = editor.scenes.getScenes().find((scene) => scene.id === state.masterSceneId);
	if (!masterScene) throw new Error("the master scene is missing");
	onProgress?.({ phase: "segment", progress: 0, message: "Finding the speaker…" });
	const subjects = await analyseSubjects({
		editor,
		tracks: masterScene.tracks,
		master: state.masterCanvas,
		onProgress,
		signal,
	});
	onProgress?.({ phase: "insert", progress: 0.5, message: `Building ${size}…` });

	// Synchronous from here.
	const latestMaster = editor.scenes.getScenes().find((scene) => scene.id === state.masterSceneId) ?? masterScene;
	const assets = new Map(
		editor.media.getAssets().map((asset) => [asset.id, { width: asset.width, height: asset.height, type: asset.type }]),
	);
	const tracks = planReframe({
		tracks: latestMaster.tracks,
		assets,
		master: state.masterCanvas,
		target,
		subjects,
	});
	let scenes = editor.scenes.getScenes();
	let sceneId = existingId;
	if (sceneId && scenes.some((scene) => scene.id === sceneId)) {
		scenes = scenes.map((scene) => (scene.id === sceneId ? { ...scene, tracks, updatedAt: new Date() } : scene));
	} else {
		const scene = { ...buildDefaultScene({ name: sceneNameForSize(size), isMain: false }), tracks };
		sceneId = scene.id;
		scenes = [...scenes, scene];
	}
	const nextState: ReframeState = {
		...state,
		scenes: { ...state.scenes, [size]: sceneId },
		builtAt: { ...state.builtAt, [size]: new Date().toISOString() },
	};
	editor.command.execute({
		command: new ReframeSceneCommand({
			scenes,
			activeSceneId: sceneId as string,
			canvasSize: { width: target.width, height: target.height },
			restorff: restorffWith(nextState),
		}),
	});
	onProgress?.({ phase: "insert", progress: 1, message: `${size} ready` });
	return sceneId as string;
}

/** Canvas size a scene should have, when it is a known reframe scene or the master (null = not managed). */
export function canvasForScene({ sceneId }: { sceneId: string }): TCanvasSize | null {
	const project = EditorCore.getInstance().project.getActiveOrNull();
	if (!project) return null;
	const state = ensureReframeState(project);
	if (!project.metadata || !(project.metadata as RestorffMeta).restorff?.reframe) return null;
	if (sceneId === state.masterSceneId) return state.masterCanvas;
	for (const [size, id] of Object.entries(state.scenes)) {
		if (id === sceneId) {
			const target = REFRAME_SIZES[size as ReframeSizeId];
			return { width: target.width, height: target.height };
		}
	}
	return null;
}
