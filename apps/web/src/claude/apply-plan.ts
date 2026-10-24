/**
 * A sentence plan (@restorffcut/timeline-ops resolveSentence) as a PROPOSAL for the open project, then applied only
 * on Accept (ui-fix-panels, 2026-10-21, QA #29: the command bar used to apply first and undo on Discard, so a GRADE
 * track sat on the timeline before anyone accepted it):
 *   prepareProposal  1. a style's compositions are rendered + processed (same path as the EDITING STYLE picker),
 *                    2. every op of the plan runs through the pure reducer on a snapshot of the project, in ONE batch,
 *                    3. composition clauses ("slower", "make it red") go to the selected composition's sentence nudge
 *                       and are re-rendered — and the timeline is NOT touched: the proposal holds the tracks as they
 *                       would be and the media they would add (the command bar draws its "after" frame from them);
 *   commitProposal   writes it back as ONE undoable editor command (imports + render swap + TracksSnapshotCommand);
 *                    if the timeline changed while the card was open, the ops are re-run on the timeline as it is now.
 * Discard = drop the proposal (nothing to undo). The snapshot preparation mirrors editing-style/apply.ts (compose
 * agent): AudioBuffers out and back in, the previous style's scale keys cleared when a new style comes in,
 * composition sources attached to inserted renders.
 */
import {
	apply,
	getEditingStylePreset,
	type IntentPlan,
	type Op,
	type Project as OpsProject,
	type StyleCompositionMedia,
} from "@restorffcut/timeline-ops";
import { BatchCommand, type Command } from "@/commands";
import { AddMediaAssetCommand } from "@/commands/media";
import { TracksSnapshotCommand } from "@/commands/timeline";
import { nudgeComposition } from "@/compositions/api";
import { prepareRerender, renderAndProcess, replaceElementInTracks, withCompositionSource } from "@/compositions/drop";
import type { CompositionSource } from "@/compositions/types";
import type { EditorCore } from "@/core";
import { useEditingStyleStore } from "@/editing-style/store";
import type { MediaAsset } from "@/media/types";
import type { ElementRef, SceneTracks, TimelineElement, TimelineTrack, TScene } from "@/timeline";

type Tagged = TimelineElement & { restorff?: { style?: string; [key: string]: unknown } };
const STYLE_CHANNELS = ["transform.scaleX", "transform.scaleY"];

export interface PlanApplyReport {
	label: string;
	applied: number;
	/** Recorded but not drawn yet (grade, whips…), in plain words. */
	pending: string[];
	/** Ops the reducer refused (best-effort skips them), with why. */
	skipped: string[];
	notes: string[];
	compositions: string[];
	nudged: string[];
	/** Undo steps made: Discard undoes exactly these. */
	commands: number;
	/** Clauses that turned out not to be understood after all (e.g. a nudge with no matching rule). */
	unmatched: string[];
}

const PENDING_WORDS: Record<string, string> = {
	// grade agent, 2026-10-20: known looks and nudges are applied (undoable); only an unknown look or a LUT pends
	grade: "grade recorded, not drawn (an unknown look or a LUT file)",
	transition: "joins recorded (drawn once the transition is supported)",
};

function prepareTracks(tracks: SceneTracks, clearStyleKeys: boolean): { tracks: SceneTracks; buffers: Map<string, AudioBuffer> } {
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
				if (clearStyleKeys && next.restorff?.style && next.animations) {
					const animations = { ...next.animations } as Record<string, unknown>;
					for (const channel of STYLE_CHANNELS) delete animations[channel];
					const { style: _style, ...restorff } = next.restorff;
					next = { ...next, animations: animations as Tagged["animations"], restorff } as Tagged;
				}
				return next as TimelineElement;
			}),
		}) as T;
	return { tracks: { overlay: tracks.overlay.map(strip), main: strip(tracks.main), audio: tracks.audio.map(strip) }, buffers };
}

function finishTracks({
	tracks,
	buffers,
	styleKeyed,
	styleId,
	sources,
}: {
	tracks: SceneTracks;
	buffers: Map<string, AudioBuffer>;
	styleKeyed: Set<string>;
	styleId: string | null;
	sources: Map<string, CompositionSource>;
}): SceneTracks {
	const finish = <T extends TimelineTrack>(track: T): T =>
		({
			...track,
			elements: track.elements.map((element) => {
				let next = element as Tagged;
				const buffer = buffers.get(next.id);
				if (buffer) next = { ...next, buffer } as Tagged;
				if (styleId && styleKeyed.has(next.id)) next = { ...next, restorff: { ...(next.restorff ?? {}), style: styleId } } as Tagged;
				if (next.type === "video") {
					const source = sources.get(next.mediaId);
					if (source) next = withCompositionSource({ element: { ...next, sourceDuration: next.duration } as TimelineElement, source }) as Tagged;
				}
				return next as TimelineElement;
			}),
		}) as T;
	return { overlay: tracks.overlay.map(finish), main: finish(tracks.main), audio: tracks.audio.map(finish) };
}

export interface SelectedCompositionRef {
	ref: ElementRef;
	source: CompositionSource;
}

/** A sentence's edit, worked out but not on the timeline yet (QA #29). */
export interface PlanProposal {
	report: PlanApplyReport;
	/** The tracks the proposal was worked out on. */
	before: SceneTracks;
	/** The tracks as they would be; null when nothing would change. */
	after: SceneTracks | null;
	/** Media the proposed tracks play that the media store doesn't have yet (for drawing the "after" frame). */
	assets: MediaAsset[];
	/** Re-run on the timeline as it is now (Accept after something else changed it). */
	rebuild: (current: SceneTracks) => SceneTracks | null;
	/** Undo steps Accept makes (0 or 1). */
	commands: Command[];
	/** Called after Accept writes it (editing-style store etc.). */
	onCommit: () => void;
}

/**
 * Work out a sentence's edit without touching the timeline: renders and processes what it needs (style compositions,
 * a nudged composition), runs the ops on a snapshot, and returns the tracks as they would be. Accept with
 * commitProposal; Discard = drop it.
 */
export async function prepareProposal({
	editor,
	plan,
	composition,
	onStep,
}: {
	editor: EditorCore;
	plan: IntentPlan;
	composition?: SelectedCompositionRef | null;
	onStep?: (step: string) => void;
}): Promise<PlanProposal> {
	const project = editor.project.getActive();
	const report: PlanApplyReport = {
		label: plan.label,
		applied: 0,
		pending: [],
		skipped: [],
		notes: [...plan.notes],
		compositions: [],
		nudged: [],
		commands: 0,
		unmatched: [...plan.unmatched],
	};
	const before = editor.scenes.getActiveScene().tracks;
	const imports: AddMediaAssetCommand[] = [];
	const assets: MediaAsset[] = [];
	const sources = new Map<string, CompositionSource>();
	const media: StyleCompositionMedia[] = [];
	const preset = plan.ops.length && plan.styleId ? getEditingStylePreset(plan.styleId) : undefined;

	// 1. a style's compositions: rendered and processed, not imported yet
	for (const item of preset?.compositions ?? []) {
		onStep?.(`rendering ${item.name}…`);
		try {
			const imported = await renderAndProcess({ editor, name: item.name, props: item.props });
			const add = new AddMediaAssetCommand({ projectId: project.metadata.id, asset: imported.asset });
			imports.push(add);
			assets.push({ ...imported.asset, id: add.getAssetId() } as MediaAsset);
			sources.set(add.getAssetId(), imported.source);
			media.push({ name: item.name, media: add.getAssetId(), t: item.at, dur: imported.answer.duration, title: imported.title });
		} catch (error) {
			report.notes.push(`${item.name} was not added: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const ops: Op[] = plan.ops.map((op) => (op.op === "apply_style" && media.length ? { ...op, params: { ...(op.params ?? {}), compositions: media } } : op));

	// 2. the selected composition's nudge: rendered, the swap kept for later
	let swap: { addMedia: AddMediaAssetCommand; next: TimelineElement; trackId: string } | null = null;
	if (plan.compositionClauses.length) {
		if (!composition) {
			report.unmatched.push(...plan.compositionClauses);
		} else {
			const sentence = plan.compositionClauses.join(", ");
			try {
				onStep?.(`asking ${composition.source.name} to change…`);
				// custom compositions (motion-code) nudge through their own params block, so send their code along
				const answer = await nudgeComposition({ name: composition.source.name, props: composition.source.props, sentence, source: composition.source.custom ? composition.source.source : undefined });
				if (!answer.changes.length) {
					report.unmatched.push(...plan.compositionClauses);
				} else {
					onStep?.(`re-rendering ${composition.source.name}…`);
					const prepared = await prepareRerender({ editor, ref: composition.ref, props: answer.props });
					if (prepared) {
						swap = { addMedia: prepared.addMedia, next: prepared.next, trackId: prepared.trackId };
						assets.push(prepared.asset);
					}
					report.nudged = answer.changes.map((change) => `${change.key}: ${String(change.from)} → ${String(change.to)}`);
					if (answer.skipped.length) report.notes.push(...answer.skipped.map((skip) => `${composition.source.name}: ${skip}`));
				}
			} catch (error) {
				report.unmatched.push(...plan.compositionClauses);
				report.notes.push(`${composition.source.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	// 3. the reducer on a snapshot of `current` (+ the swap): the tracks as they would be
	const styleKeyed = new Set<string>();
	const rebuild = (current: SceneTracks): SceneTracks | null => {
		let tracks: SceneTracks | null = null;
		if (ops.length) {
			onStep?.("working it out…");
			const scene = editor.scenes.getActiveScene();
			const prepared = prepareTracks(current, Boolean(preset));
			const snapshot = {
				...project,
				currentSceneId: scene.id,
				scenes: editor.scenes
					.getScenes()
					.map((candidate: TScene) =>
						candidate.id === scene.id ? { ...candidate, tracks: prepared.tracks } : { ...candidate, tracks: prepareTracks(candidate.tracks, false).tracks },
					),
			} as unknown as OpsProject;
			const result = apply(snapshot, ops, { seed: `${project.metadata.id}/sentence/${Date.now()}`, mode: "best_effort" });
			const nextScene = result.project.scenes.find((candidate) => candidate.id === scene.id);
			if (!nextScene) throw new Error("the edit lost the active scene");
			styleKeyed.clear();
			for (const change of result.changes.ops) {
				if (change.op === "keyframe" && change.status === "applied" && change.author === "preset") for (const id of change.updated ?? []) styleKeyed.add(id);
			}
			tracks = finishTracks({ tracks: nextScene.tracks as unknown as SceneTracks, buffers: prepared.buffers, styleKeyed, styleId: preset?.id ?? null, sources });
			report.applied = result.changes.ops.filter((change) => change.status === "applied").length;
			report.pending = [...new Set(result.changes.unsupported.map((record) => record.op))].map((kind) => PENDING_WORDS[kind] ?? `${kind} recorded`);
			report.skipped = result.conflicts.map((conflict) => `${conflict.op}: ${conflict.message}`);
			report.compositions = media.map((item) => item.title ?? item.name);
			if (!report.applied && !imports.length) tracks = null;
		}
		if (swap) tracks = replaceElementInTracks({ tracks: tracks ?? current, trackId: swap.trackId, next: swap.next });
		return tracks;
	};
	const after = rebuild(before);
	const commands: Command[] = after ? [...imports, ...(swap ? [swap.addMedia] : [])] : [];
	return {
		report,
		before,
		after,
		assets,
		rebuild,
		commands,
		onCommit: () => {
			if (preset) useEditingStyleStore.getState().setStyle({ projectId: project.metadata.id, styleId: preset.id });
		},
	};
}

/**
 * Accept: write the proposal as ONE undo step. When the timeline changed since it was worked out (another edit while
 * the card was open), the ops are re-run on the timeline as it is now, so nothing done meanwhile is overwritten.
 * Returns the undo steps made (0 when there was nothing to change).
 */
export function commitProposal({ editor, proposal }: { editor: EditorCore; proposal: PlanProposal }): number {
	if (!proposal.after) return 0;
	const current = editor.scenes.getActiveScene().tracks;
	const after = current === proposal.before ? proposal.after : proposal.rebuild(current);
	if (!after) return 0;
	editor.command.execute({ command: new BatchCommand([...proposal.commands, new TracksSnapshotCommand({ before: current, after })]) });
	proposal.onCommit();
	proposal.report.commands = 1;
	return 1;
}

/** Prepare + commit in one go (callers that do not show a proposal). */
export async function applyPlan(args: {
	editor: EditorCore;
	plan: IntentPlan;
	composition?: SelectedCompositionRef | null;
	onStep?: (step: string) => void;
}): Promise<PlanApplyReport> {
	const proposal = await prepareProposal(args);
	commitProposal({ editor: args.editor, proposal });
	return proposal.report;
}
