import type { MigrationResult, ProjectRecord } from "./types";
import { getProjectId, isRecord } from "./utils";

/**
 * v31 → v32 (Restorff media agent, 2026-10-20). Additive only (see ../AGENTS.md):
 * - `settings.loudness` = the master target the export normalises to (−14 LUFS integrated,
 *   −1 dBTP true peak, enabled), added when absent. Existing projects export as before plus
 *   mastering; a down-migration can drop the key.
 * - New optional element fields need no data change: video/image `transitionIn`
 *   ({ type, duration ticks }) and audio `beats` ({ bpm, times source ticks, downbeats?,
 *   source }). Older editors ignore them.
 */
export const DEFAULT_PROJECT_LOUDNESS = {
	enabled: true,
	integratedLufs: -14,
	truePeakDb: -1,
} as const;

export function transformProjectV31ToV32({
	project,
}: {
	project: ProjectRecord;
}): MigrationResult<ProjectRecord> {
	if (!getProjectId({ project })) {
		return { project, skipped: true, reason: "no project id" };
	}

	const version = project.version;
	if (typeof version !== "number") {
		return { project, skipped: true, reason: "invalid version" };
	}
	if (version >= 32) {
		return { project, skipped: true, reason: "already v32" };
	}
	if (version !== 31) {
		return { project, skipped: true, reason: "not v31" };
	}

	const nextProject: ProjectRecord = { ...project, version: 32 };
	if (isRecord(project.settings) && !isRecord(project.settings.loudness)) {
		nextProject.settings = {
			...project.settings,
			loudness: { ...DEFAULT_PROJECT_LOUDNESS },
		};
	}
	return { project: nextProject, skipped: false };
}
