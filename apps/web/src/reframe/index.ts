/**
 * Auto-reframe (9:16 master → 4:5, 1:1, 16:9 scenes that follow the speaker). Runbook: docs/restorff/worklog/cutout.md.
 */
export { switchToSize, canvasForScene, ReframeSceneCommand } from "./build";
export { planReframe, isFullFrame, type PlanInput } from "./plan";
export {
	REFRAME_SIZES,
	REFRAME_SIZE_ORDER,
	MASTER_SIZE_ID,
	sceneNameForSize,
	nearestSize,
	type ReframeSize,
	type ReframeSizeId,
} from "./sizes";
export { getReframeState, ensureReframeState, activeSizeOf, type ReframeState } from "./state";
