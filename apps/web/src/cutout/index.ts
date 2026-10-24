/**
 * Person cutout + the matte presets. Runbook: docs/restorff/worklog/cutout.md.
 *
 * For other agents:
 * - compose (Effects panel): `MATTE_PRESETS` lists the four presets with their EFFECTS.md ids; run one with
 *   `runMattePreset({ editor, ref, preset: { preset: "text-behind", options: { text: "STEEP" } } })`.
 * - bridge (command bar / Claude): `runCutOutPerson`, `runMattePreset`, `runSwitchToSize` (toasts + job tracking) or
 *   the bare `cutOutPerson`, `applyMattePreset`, `switchToSize` (no UI).
 */
export { cutOutPerson, resolvePlate, CUTOUT_TRACK_NAME, type CutoutResult } from "./cut-out-person";
export { applyMattePreset, MATTE_PRESETS, type MattePresetInfo } from "./presets";
export { runCutOutPerson, runMattePreset, runSwitchToSize } from "./actions";
export { useCutoutJobs, runCutoutJob } from "./store";
export { getCutoutSource, findCutoutFor } from "./timeline-utils";
export { PersonToolsButton } from "./components/person-tools-button";
export type * from "./types";
