/**
 * Reframe bookkeeping lives in `project.metadata.restorff.reframe` (the storage layer keeps `metadata.restorff`
 * verbatim; scene objects only keep id/name/isMain/tracks/bookmarks, so nothing can be stored on a scene).
 */
import type { TCanvasSize, TProject } from "@/project/types";
import { MASTER_SIZE_ID, nearestSize, REFRAME_SIZE_ORDER, sceneNameForSize, type ReframeSizeId } from "./sizes";

export interface ReframeState {
	version: 1;
	masterSceneId: string;
	masterCanvas: TCanvasSize;
	/** Derived scene id per size. */
	scenes: Partial<Record<ReframeSizeId, string>>;
	builtAt: Partial<Record<ReframeSizeId, string>>;
}

type RestorffMeta = { restorff?: Record<string, unknown> };

export function getReframeState(project: TProject): ReframeState | null {
	const restorff = (project.metadata as RestorffMeta).restorff;
	const state = restorff?.reframe as ReframeState | undefined;
	if (!state || state.version !== 1 || !state.masterSceneId) return null;
	return state;
}

export function withReframeState(project: TProject, state: ReframeState): TProject {
	const restorff = (project.metadata as RestorffMeta).restorff ?? {};
	return {
		...project,
		metadata: { ...project.metadata, restorff: { ...restorff, reframe: state }, updatedAt: new Date() } as TProject["metadata"],
	};
}

/** The state to use, creating one from the current project when none exists (not saved until a reframe runs). */
export function ensureReframeState(project: TProject): ReframeState {
	const existing = getReframeState(project);
	if (existing && project.scenes.some((scene) => scene.id === existing.masterSceneId)) {
		// Forget derived scenes that were deleted.
		const scenes: ReframeState["scenes"] = {};
		for (const id of REFRAME_SIZE_ORDER) {
			const sceneId = existing.scenes[id];
			if (sceneId && project.scenes.some((scene) => scene.id === sceneId)) scenes[id] = sceneId;
		}
		return { ...existing, scenes };
	}
	const main = project.scenes.find((scene) => scene.isMain) ?? project.scenes[0];
	const activeIsMain = main?.id === project.currentSceneId;
	return {
		version: 1,
		masterSceneId: main?.id ?? project.currentSceneId,
		masterCanvas: activeIsMain ? project.settings.canvasSize : { width: 1080, height: 1920 },
		scenes: {},
		builtAt: {},
	};
}

/** Which size the active scene is: a derived scene, else the master (by state or by the canvas aspect). */
export function activeSizeOf(project: TProject): ReframeSizeId {
	const state = getReframeState(project);
	if (state) {
		for (const id of REFRAME_SIZE_ORDER) {
			if (state.scenes[id] === project.currentSceneId) return id;
		}
		if (state.masterSceneId === project.currentSceneId) return nearestSize(state.masterCanvas);
	}
	const byName = REFRAME_SIZE_ORDER.find(
		(id) => project.scenes.find((scene) => scene.id === project.currentSceneId)?.name === sceneNameForSize(id),
	);
	return byName ?? nearestSize(project.settings.canvasSize) ?? MASTER_SIZE_ID;
}
