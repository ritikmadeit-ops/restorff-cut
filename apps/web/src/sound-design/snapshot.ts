/**
 * Run ops@1 on the open scene as ONE undoable editor change (BUILD-BRIEF B7: edits go through ops, not the editor's
 * commands one by one). Same path as editing-style/apply.ts:
 *   1. snapshot the project with AudioBuffers taken out (structuredClone cannot copy them),
 *   2. let the caller prepare the snapshot (e.g. remove a previous design) and build the ops,
 *   3. apply them with @restorffcut/timeline-ops' pure reducer,
 *   4. put the buffers back and write the scene's tracks with a single TracksSnapshotCommand (one Ctrl+Z).
 */
import { apply, type ApplyResult, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import { TracksSnapshotCommand } from "@/commands/timeline";
import type { EditorCore } from "@/core";
import type { SceneTracks, TimelineElement, TimelineTrack, TScene } from "@/timeline";

function stripBuffers(tracks: SceneTracks, buffers: Map<string, AudioBuffer>): SceneTracks {
	const strip = <T extends TimelineTrack>(track: T): T =>
		({
			...track,
			elements: track.elements.map((element) => {
				if (element.type === "audio" && element.buffer) {
					buffers.set(element.id, element.buffer);
					const { buffer: _buffer, ...rest } = element;
					return rest as TimelineElement;
				}
				return element;
			}),
		}) as T;
	return { overlay: tracks.overlay.map(strip), main: strip(tracks.main), audio: tracks.audio.map(strip) };
}

function restoreBuffers(tracks: SceneTracks, buffers: Map<string, AudioBuffer>): SceneTracks {
	const restore = <T extends TimelineTrack>(track: T): T =>
		({
			...track,
			elements: track.elements.map((element) => {
				const buffer = buffers.get(element.id);
				return buffer && element.type === "audio" ? ({ ...element, buffer } as TimelineElement) : element;
			}),
		}) as T;
	return { overlay: tracks.overlay.map(restore), main: restore(tracks.main), audio: tracks.audio.map(restore) };
}

export interface SnapshotRun<T> {
	result: ApplyResult;
	/** What `build` returned besides the ops (a plan, a report…). */
	extra: T;
	changed: boolean;
}

export function runOpsOnActiveScene<T>({
	editor,
	seed,
	build,
	finish,
}: {
	editor: EditorCore;
	seed: string;
	/** Gets the buffer-free snapshot; returns the project to apply on (may be a prepared copy) and the ops. */
	build: (snapshot: OpsProject) => { project: OpsProject; ops: Op[]; extra: T };
	/** Optional last touch on the reducer's output (e.g. markDesign). */
	finish?: (result: ApplyResult) => void;
}): SnapshotRun<T> {
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveScene();
	const before = scene.tracks;
	const buffers = new Map<string, AudioBuffer>();
	const snapshot = {
		...project,
		currentSceneId: scene.id,
		scenes: editor.scenes.getScenes().map((candidate: TScene) => ({
			...candidate,
			tracks: stripBuffers(candidate.tracks, buffers),
		})),
	} as unknown as OpsProject;

	const { project: prepared, ops, extra } = build(snapshot);
	const result = apply(prepared, ops, { seed: `${seed}/${Date.now()}`, mode: "best_effort" });
	finish?.(result);
	const nextScene = result.project.scenes.find((candidate) => candidate.id === scene.id);
	if (!nextScene) throw new Error("the change lost the active scene");
	const after = restoreBuffers(nextScene.tracks as unknown as SceneTracks, buffers);
	const changed = result.changes.ops.some((change) => change.status === "applied") || prepared !== snapshot;
	if (changed) editor.command.execute({ command: new TracksSnapshotCommand({ before, after }) });
	return { result, extra, changed };
}
