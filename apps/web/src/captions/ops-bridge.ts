/**
 * Run ops@1 against the open scene and commit the result as ONE undoable editor command (BUILD-BRIEF B7: the editor
 * changes through ops, not through its browser commands one by one). Same mechanism as editing-style/apply.ts:
 *
 *   1. snapshot the active scene (AudioBuffers out — the reducer's structuredClone can't copy them),
 *   2. `apply()` from @restorffcut/timeline-ops (pure, deterministic for a seed; atomic by default),
 *   3. buffers back, optional post-processing (tags), then `TracksSnapshotCommand({before, after})`.
 *
 * Undo restores the tracks exactly as they were. Used by auto-cut and captions.
 */
import {
	apply,
	type ApplyResult,
	type Op,
	type Project as OpsProject,
} from "@restorffcut/timeline-ops";
import { TracksSnapshotCommand } from "@/commands/timeline";
import type { EditorCore } from "@/core";
import type { SceneTracks, TimelineTrack, TScene } from "@/timeline";

function mapTracks(tracks: SceneTracks, fn: (track: TimelineTrack) => TimelineTrack): SceneTracks {
	return {
		overlay: tracks.overlay.map(fn) as SceneTracks["overlay"],
		main: fn(tracks.main) as SceneTracks["main"],
		audio: tracks.audio.map(fn) as SceneTracks["audio"],
	};
}

function stripBuffers(tracks: SceneTracks, buffers: Map<string, AudioBuffer>): SceneTracks {
	return mapTracks(tracks, (track) => ({
		...track,
		elements: track.elements.map((element) => {
			if (element.type === "audio" && "buffer" in element && element.buffer) {
				buffers.set(element.id, element.buffer);
				const { buffer: _buffer, ...rest } = element;
				return rest;
			}
			return element;
		}),
	}) as TimelineTrack);
}

function restoreBuffers(tracks: SceneTracks, buffers: Map<string, AudioBuffer>): SceneTracks {
	if (!buffers.size) return tracks;
	return mapTracks(tracks, (track) => ({
		...track,
		elements: track.elements.map((element) => {
			const buffer = buffers.get(element.id);
			return buffer && element.type === "audio" ? { ...element, buffer } : element;
		}),
	}) as TimelineTrack);
}

export interface OpsRun {
	result: ApplyResult;
	before: SceneTracks;
	after: SceneTracks;
}

/** Apply ops to a snapshot of the active scene, without touching the editor. */
export function runOpsOnActiveScene({
	editor,
	ops,
	seed,
	mode = "atomic",
}: {
	editor: EditorCore;
	ops: Op[];
	seed: string;
	mode?: "atomic" | "best_effort";
}): OpsRun {
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveScene();
	const before = scene.tracks;
	const buffers = new Map<string, AudioBuffer>();
	const strip = (candidate: TScene): TScene => ({ ...candidate, tracks: stripBuffers(candidate.tracks, buffers) });
	const snapshot = {
		...project,
		currentSceneId: scene.id,
		scenes: editor.scenes.getScenes().map(strip),
	} as unknown as OpsProject;
	const result = apply(snapshot, ops, { seed, mode });
	const nextScene = result.project.scenes.find((candidate) => candidate.id === scene.id);
	if (!nextScene) throw new Error("the ops lost the active scene");
	const after = restoreBuffers(nextScene.tracks as unknown as SceneTracks, buffers);
	return { result, before, after };
}

/** Commit a run as one undo step. */
export function commitTracks({
	editor,
	before,
	after,
}: {
	editor: EditorCore;
	before: SceneTracks;
	after: SceneTracks;
}): void {
	editor.command.execute({ command: new TracksSnapshotCommand({ before, after }) });
}

/** Fresh-per-application seed (the reducer stays deterministic for a given seed). */
export function freshSeed(editor: EditorCore, what: string): string {
	return `${editor.project.getActive().metadata.id}/${what}/${Date.now()}`;
}

/** Describe the conflicts of a run in plain words. */
export function conflictText(result: ApplyResult): string {
	return result.conflicts.map((conflict) => `${conflict.op}: ${conflict.message}`).join("; ");
}
