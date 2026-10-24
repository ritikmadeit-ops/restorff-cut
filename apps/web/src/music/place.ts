/**
 * "+" on a music bed in the Sounds panel: the same plan as the MCP `music` tool (server/music-plan.ts) — loop copies on
 * a MUSIC track under the whole cut, the beat grid on each, the auto level, ducked under a VOICE track's words, faded —
 * as ONE undoable editor change (sound-design/snapshot.ts runOpsOnActiveScene).
 */
import { apply } from "@restorffcut/timeline-ops";
import type { EditorCore } from "@/core";
import { MUSIC_MIX, type MusicBed, planBed, planMusicEnvelope, tagBed } from "@/server/music-plan";
import { runOpsOnActiveScene } from "@/sound-design/snapshot";

export function placeBedUnderCut({ editor, bed }: { editor: EditorCore; bed: MusicBed }): { ok: boolean; message: string } {
	let summary = "";
	const run = runOpsOnActiveScene({
		editor,
		seed: `${editor.project.getActive().metadata.id}/music/${bed.id}`,
		build: (snapshot) => {
			const plan = planBed(snapshot, bed, { t: 0, level: "auto", author: "user" });
			const placed = apply(snapshot, plan.ops, { seed: `${snapshot.metadata.id}/music/${plan.run}/${Date.now()}`, mode: "atomic" });
			if (!placed.ok) return { project: snapshot, ops: [], extra: placed.conflicts.map((conflict) => conflict.message).join("; ") };
			tagBed(placed.project, plan, placed.changes.refs, bed, { level: "auto", duckDb: MUSIC_MIX.duckDb });
			const envelope = planMusicEnvelope(placed.project, { author: "user" });
			summary = `${bed.name} · ${plan.span.t}–${plan.span.end} s${plan.copies.length > 1 ? ` · ${plan.copies.length} loops` : ""}${envelope.ducked.length ? " · ducked under the voice" : ""}`;
			return { project: placed.project, ops: envelope.ops, extra: null as string | null };
		},
	});
	if (run.extra) return { ok: false, message: run.extra };
	if (run.result.conflicts.length) return { ok: false, message: run.result.conflicts.map((conflict) => conflict.message).join("; ") };
	return { ok: true, message: summary };
}
