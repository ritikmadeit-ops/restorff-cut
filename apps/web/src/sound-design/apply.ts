/**
 * "Design the sound" in the editor (sounds agent, 2026-10-20). Owner: *"video is 50% audio, so good music, perfect
 * sync and soundeffects is a must."*
 *
 * Reads the built-in pack's manifest, removes what a previous run placed, plans with
 * @restorffcut/timeline-ops `designSound` (hit at 0.0 s, riser into the hook, whoosh per cut, pop per text in,
 * optional caption ticks, ≥ 0.25 s apart, light duck) and applies the ops as ONE undoable change.
 * Planner + rules: packages/timeline-ops/src/sound-design.ts. Runbook: docs/restorff/worklog/sounds.md.
 */
import {
	designSound,
	markDesign,
	previousDesign,
	type PlannedSfx,
	type SoundDesignOptions,
	withoutPreviousDesign,
} from "@restorffcut/timeline-ops";
import type { EditorCore } from "@/core";
import { loadSfxPack } from "@/sounds/library";
import { runOpsOnActiveScene } from "./snapshot";

export interface SoundDesignReport {
	/** "placed 14 SFX: 6 whoosh, 5 pop, 1 riser, 2 hits" */
	summary: string;
	placed: PlannedSfx[];
	/** How many SFX of a previous run were replaced. */
	replaced: number;
	dropped: number;
	skipped: string[];
	notes: string[];
	hookEnd: number | null;
}

export async function designTheSound({
	editor,
	options = {},
}: {
	editor: EditorCore;
	options?: SoundDesignOptions;
}): Promise<SoundDesignReport> {
	const pack = await loadSfxPack();
	const run = runOpsOnActiveScene({
		editor,
		seed: `${editor.project.getActive().metadata.id}/sound-design`,
		build: (snapshot) => {
			const previous = previousDesign(snapshot);
			const prepared = previous.elements.length || previous.duckKeys ? withoutPreviousDesign(snapshot) : snapshot;
			const plan = designSound(prepared, pack.sounds, options);
			return { project: prepared, ops: plan.ops, extra: { plan, replaced: previous.elements.length } };
		},
		finish: (result) => {
			markDesign(result);
		},
	});
	const { plan, replaced } = run.extra;
	return {
		summary: plan.summary,
		placed: plan.placed,
		replaced,
		dropped: plan.dropped.length,
		skipped: run.result.conflicts.map((conflict) => `${conflict.op}: ${conflict.message}`),
		notes: plan.notes,
		hookEnd: plan.hookEnd,
	};
}
