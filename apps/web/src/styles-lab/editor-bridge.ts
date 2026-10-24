/**
 * Run ops@1 on the open project and write the result back as ONE undoable editor command — the same path as
 * editing-style/apply.ts (compose agent) and claude/apply-plan.ts (bridge agent), whose helpers are not exported;
 * this is a third copy of the snapshot/write-back (open issue: share one in the integration pass).
 *
 *   1. snapshot: the project as the reducer sees it, AudioBuffers taken out (structuredClone cannot copy them)
 *   2. apply(project, ops, best_effort)
 *   3. write back: buffers restored, composition sources attached to inserted renders, canvas/background changes as
 *      UpdateProjectSettingsCommand, then BatchCommand([...extra (media imports), settings?, TracksSnapshotCommand])
 */
import { apply, type ApplyResult, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import { BatchCommand, type Command } from "@/commands";
import { UpdateProjectSettingsCommand } from "@/commands/project";
import { TracksSnapshotCommand } from "@/commands/timeline";
import { withCompositionSource } from "@/compositions/drop";
import type { CompositionSource } from "@/compositions/types";
import type { EditorCore } from "@/core";
import type { TProjectSettings } from "@/project/types";
import type { SceneTracks, TimelineElement, TimelineTrack, TScene } from "@/timeline";

const TICKS = 120_000;

function stripBuffers(tracks: SceneTracks): { tracks: SceneTracks; buffers: Map<string, AudioBuffer> } {
	const buffers = new Map<string, AudioBuffer>();
	const strip = <T extends TimelineTrack>(track: T): T =>
		({
			...track,
			elements: track.elements.map((element) => {
				if (element.type === "audio" && "buffer" in element && element.buffer) {
					buffers.set(element.id, element.buffer as AudioBuffer);
					const { buffer: _buffer, ...rest } = element as TimelineElement & { buffer?: AudioBuffer };
					return rest as TimelineElement;
				}
				return element;
			}),
		}) as T;
	return { tracks: { overlay: tracks.overlay.map(strip), main: strip(tracks.main), audio: tracks.audio.map(strip) }, buffers };
}

export interface OpsSnapshot {
	project: OpsProject;
	sceneId: string;
	before: SceneTracks;
	buffers: Map<string, AudioBuffer>;
}

/** The open project as ops@1 sees it (active scene first-class, buffers out). */
export function opsSnapshot(editor: EditorCore): OpsSnapshot {
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveScene();
	const before = scene.tracks;
	const prepared = stripBuffers(before);
	const scenes = editor.scenes
		.getScenes()
		.map((candidate: TScene) => (candidate.id === scene.id ? { ...candidate, tracks: prepared.tracks } : { ...candidate, tracks: stripBuffers(candidate.tracks).tracks }));
	return {
		project: { ...project, currentSceneId: scene.id, scenes } as unknown as OpsProject,
		sceneId: scene.id,
		before,
		buffers: prepared.buffers,
	};
}

/** End of the main track, seconds (where an explainer is appended). */
export function mainTrackEnd(editor: EditorCore): number {
	const main = editor.scenes.getActiveScene().tracks.main;
	const end = main.elements.reduce((max, element) => Math.max(max, element.startTime + element.duration), 0);
	return end / TICKS;
}

export interface RunReport {
	result: ApplyResult;
	applied: number;
	/** Ops the reducer refused (best-effort skips them), with why. */
	skipped: string[];
	/** Op kinds recorded but not drawn (grade, transition…). */
	pending: string[];
	/** True when an editor command ran (Discard = one undo). */
	committed: boolean;
}

export function runOps({
	editor,
	ops,
	seed,
	extra = [],
	sources,
	snapshot,
}: {
	editor: EditorCore;
	ops: Op[];
	seed: string;
	/** Commands that must run in the same undo step, before the tracks change (media imports). */
	extra?: Command[];
	/** Media id → composition source, attached to the clips the ops inserted. */
	sources?: Map<string, CompositionSource>;
	snapshot?: OpsSnapshot;
}): RunReport {
	const snap = snapshot ?? opsSnapshot(editor);
	const result = apply(snap.project, ops, { seed, mode: "best_effort" });
	const applied = result.changes.ops.filter((change) => change.status === "applied").length;
	const skipped = result.conflicts.map((conflict) => `${conflict.op}: ${conflict.message}`);
	const pending = [...new Set(result.changes.unsupported.map((record) => record.op))];
	const nextScene = result.project.scenes.find((candidate) => candidate.id === snap.sceneId);
	if (!nextScene || (!applied && !extra.length)) return { result, applied, skipped, pending, committed: false };

	const finish = <T extends TimelineTrack>(track: T): T =>
		({
			...track,
			elements: track.elements.map((element) => {
				let next = element as TimelineElement;
				const buffer = snap.buffers.get(next.id);
				if (buffer) next = { ...next, buffer } as TimelineElement;
				if (next.type === "video" && sources) {
					const source = sources.get(next.mediaId);
					if (source) next = withCompositionSource({ element: { ...next, sourceDuration: next.duration } as TimelineElement, source });
				}
				return next;
			}),
		}) as T;
	const tracks = nextScene.tracks as unknown as SceneTracks;
	const after: SceneTracks = { overlay: tracks.overlay.map(finish), main: finish(tracks.main), audio: tracks.audio.map(finish) };

	const commands: Command[] = [...extra];
	const current = editor.project.getActive().settings;
	const next = result.project.settings as unknown as TProjectSettings;
	const updates: Partial<TProjectSettings> = {};
	if (next.canvasSize.width !== current.canvasSize.width || next.canvasSize.height !== current.canvasSize.height) {
		updates.canvasSize = { ...next.canvasSize };
	}
	if (JSON.stringify(next.background) !== JSON.stringify(current.background)) updates.background = next.background;
	if (Object.keys(updates).length) commands.push(new UpdateProjectSettingsCommand(updates));
	commands.push(new TracksSnapshotCommand({ before: snap.before, after }));
	editor.command.execute({ command: new BatchCommand(commands) });
	return { result, applied, skipped, pending, committed: true };
}

export const PENDING_WORDS: Record<string, string> = {
	// grade agent, 2026-10-20: known looks are applied; only an unknown look or a LUT pends
	grade: "grade recorded, not drawn (an unknown look or a LUT file)",
	transition: "joins recorded (drawn once the transition is supported)",
};
