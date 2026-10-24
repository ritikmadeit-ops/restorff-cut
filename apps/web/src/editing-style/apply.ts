/**
 * Apply an EDITING STYLE to the open project through ops@1 (BUILD-BRIEF B7: Claude and presets edit through ops, not
 * through the editor's commands one by one):
 *
 *   1. render + import the style's compositions (same path as the Effects panel drop),
 *   2. run `apply_style restorff/style/<id>` with @restorffcut/timeline-ops' pure reducer on a snapshot of the
 *      project, the imported media ids passed in as params,
 *   3. write the reducer's tracks back as ONE undoable editor command (media imports + TracksSnapshotCommand).
 *
 * Presets (captions, pacing, joins, grade, compositions): packages/timeline-ops/src/styles.ts EDITING_STYLE_PRESETS.
 * Runbook: docs/restorff/worklog/compose.md.
 */
import {
	apply,
	getEditingStylePreset,
	STYLE_PRESET_PREFIX,
	type ApplyResult,
	type Project as OpsProject,
	type StyleCompositionMedia,
} from "@restorffcut/timeline-ops";
import { BatchCommand, type Command } from "@/commands";
import { AddMediaAssetCommand } from "@/commands/media";
import { TracksSnapshotCommand } from "@/commands/timeline";
import type { EditorCore } from "@/core";
import type { SceneTracks, TimelineElement, TimelineTrack, TScene } from "@/timeline";
import { renderAndProcess, withCompositionSource } from "@/compositions/drop";
import type { CompositionSource } from "@/compositions/types";

/** Marker on A-roll clips whose scale keys a style wrote, so the next style replaces them instead of stacking. */
type Tagged = TimelineElement & { restorff?: { style?: string; [key: string]: unknown } };
const STYLE_CHANNELS = ["transform.scaleX", "transform.scaleY"];

export interface StyleApplyReport {
	styleId: string;
	label: string;
	applied: number;
	/** Things recorded but not drawn yet (grade, whip …), in plain words. */
	pending: string[];
	/** Ops the reducer refused (best-effort mode skips them), with why. */
	skipped: string[];
	notes: string[];
	compositions: string[];
}

function allTracks(tracks: SceneTracks): TimelineTrack[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

/**
 * The reducer clones the project with structuredClone, which cannot copy AudioBuffers: take them out (keyed by
 * element id) and put them back afterwards. Also clears the previous style's scale keys on tagged A-roll clips.
 */
function prepareTracks(tracks: SceneTracks): { tracks: SceneTracks; buffers: Map<string, AudioBuffer> } {
	const buffers = new Map<string, AudioBuffer>();
	const strip = <T extends TimelineTrack>(track: T): T =>
		({
			...track,
			elements: track.elements.map((element) => {
				let next = element as Tagged;
				if (next.type === "audio" && "buffer" in next && next.buffer) {
					buffers.set(next.id, next.buffer as AudioBuffer);
					const { buffer: _buffer, ...rest } = next as Tagged & { buffer?: AudioBuffer };
					next = rest as Tagged;
				}
				if (next.restorff?.style && next.animations) {
					const animations = { ...next.animations } as Record<string, unknown>;
					for (const channel of STYLE_CHANNELS) delete animations[channel];
					const { style: _style, ...restorff } = next.restorff;
					next = { ...next, animations: animations as Tagged["animations"], restorff } as Tagged;
				}
				return next as TimelineElement;
			}),
		}) as T;
	return {
		tracks: { overlay: tracks.overlay.map(strip), main: strip(tracks.main), audio: tracks.audio.map(strip) },
		buffers,
	};
}

function sceneWithoutBuffers(scene: TScene): TScene {
	return { ...scene, tracks: prepareTracks(scene.tracks).tracks };
}

/** Put buffers back, tag the clips the style keyframed, and attach composition sources to the clips it inserted. */
function finishTracks({
	tracks,
	buffers,
	result,
	styleId,
	sources,
}: {
	tracks: SceneTracks;
	buffers: Map<string, AudioBuffer>;
	result: ApplyResult;
	styleId: string;
	sources: Map<string, CompositionSource>;
}): SceneTracks {
	const keyed = new Set<string>();
	for (const change of result.changes.ops) {
		if (change.op === "keyframe" && change.status === "applied") for (const id of change.updated ?? []) keyed.add(id);
	}
	const finish = <T extends TimelineTrack>(track: T): T =>
		({
			...track,
			elements: track.elements.map((element) => {
				let next = element as Tagged;
				const buffer = buffers.get(next.id);
				if (buffer) next = { ...next, buffer } as Tagged;
				if (keyed.has(next.id)) next = { ...next, restorff: { ...(next.restorff ?? {}), style: styleId } } as Tagged;
				if (next.type === "video") {
					const source = sources.get(next.mediaId);
					if (source) {
						next = withCompositionSource({
							element: { ...next, sourceDuration: next.duration } as TimelineElement,
							source,
						}) as Tagged;
					}
				}
				return next as TimelineElement;
			}),
		}) as T;
	return { overlay: tracks.overlay.map(finish), main: finish(tracks.main), audio: tracks.audio.map(finish) };
}

const PENDING_WORDS: Record<string, string> = {
	// grade agent, 2026-10-20: style grades are real looks now; this only shows for an unknown look name
	grade: "grade recorded, not drawn (unknown look)",
	transition: "joins recorded (unknown transition kind)",
};

export async function applyEditingStyle({
	editor,
	styleId,
	onStep,
}: {
	editor: EditorCore;
	styleId: string;
	onStep?: (step: string) => void;
}): Promise<StyleApplyReport> {
	const preset = getEditingStylePreset(styleId);
	if (!preset) throw new Error(`unknown editing style "${styleId}"`);
	const project = editor.project.getActive();

	// 1. compositions: render (cached by params) + process; committed below in the same undo step
	const imports: AddMediaAssetCommand[] = [];
	const media: StyleCompositionMedia[] = [];
	const sources = new Map<string, CompositionSource>();
	for (const item of preset.compositions) {
		onStep?.(`rendering ${item.name}…`);
		const imported = await renderAndProcess({ editor, name: item.name, props: item.props });
		const add = new AddMediaAssetCommand({ projectId: project.metadata.id, asset: imported.asset });
		imports.push(add);
		sources.set(add.getAssetId(), imported.source);
		media.push({
			name: item.name,
			media: add.getAssetId(),
			t: item.at,
			dur: imported.answer.duration,
			title: imported.title,
		});
	}

	// 2. the reducer, on a snapshot (buffers out, previous style's scale keys cleared)
	onStep?.("applying the style…");
	const scene = editor.scenes.getActiveScene();
	const before = scene.tracks;
	const prepared = prepareTracks(before);
	const snapshot = {
		...project,
		currentSceneId: scene.id,
		scenes: editor.scenes
			.getScenes()
			.map((candidate) => (candidate.id === scene.id ? { ...candidate, tracks: prepared.tracks } : sceneWithoutBuffers(candidate))),
	} as unknown as OpsProject;
	const result = apply(
		snapshot,
		[
			{
				op: "apply_style",
				author: "user",
				preset_id: `${STYLE_PRESET_PREFIX}${preset.id}`,
				params: { compositions: media },
			},
		],
		{
			// ids must be fresh per application; the reducer stays deterministic for a given seed
			seed: `${project.metadata.id}/${preset.id}/${Date.now()}`,
			mode: "best_effort",
		},
	);
	const nextScene = result.project.scenes.find((candidate) => candidate.id === scene.id);
	if (!nextScene) throw new Error("the style lost the active scene");
	const after = finishTracks({
		tracks: nextScene.tracks as unknown as SceneTracks,
		buffers: prepared.buffers,
		result,
		styleId: preset.id,
		sources,
	});

	// 3. one undo step
	const commands: Command[] = [...imports, new TracksSnapshotCommand({ before, after })];
	editor.command.execute({ command: new BatchCommand(commands) });

	const pendingKinds = new Set(result.changes.unsupported.map((record) => record.op));
	return {
		styleId: preset.id,
		label: preset.label,
		applied: result.changes.ops.filter((change) => change.status === "applied").length,
		pending: [...pendingKinds].map((kind) => PENDING_WORDS[kind] ?? `${kind} recorded`),
		skipped: result.conflicts.map((conflict) => `${conflict.op}: ${conflict.message}`),
		notes: preset.notes,
		compositions: media.map((item) => item.title ?? item.name),
	};
}
