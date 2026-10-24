/**
 * Put one sound of the built-in pack on the SFX track through ops@1 (`sfx` + `gain`), as one undoable change.
 * The sound's EVENT (a whoosh's peak, a hit's attack — `sync_s` in the manifest) lands on the playhead, so "park the
 * playhead on the visual event, press +" is frame-accurate sync.
 */
import { isSfxTrack, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import type { EditorCore } from "@/core";
import { runOpsOnActiveScene } from "@/sound-design/snapshot";
import { TICKS_PER_SECOND } from "@/wasm";
import type { SfxSound } from "./library";

function laneFor(project: OpsProject, from: number, to: number): { id?: string; add?: Op } {
	const scene = project.scenes.find((candidate) => candidate.id === project.currentSceneId) ?? project.scenes[0];
	const lanes = scene.tracks.audio.filter(isSfxTrack);
	const free = lanes.find((track) =>
		track.elements.every((element) => {
			const start = element.startTime / TICKS_PER_SECOND;
			const end = (element.startTime + element.duration) / TICKS_PER_SECOND;
			return to <= start + 1e-6 || from >= end - 1e-6;
		}),
	);
	if (free) return { id: free.id };
	const name = lanes.length === 0 ? "SFX" : `SFX ${lanes.length + 1}`;
	return { id: "sfx-lane", add: { op: "add_track", author: "user", kind: "audio", name, ref: "sfx-lane" } };
}

export function placeSfxAtPlayhead({ editor, sound }: { editor: EditorCore; sound: SfxSound }): { ok: boolean; message: string } {
	const playhead = editor.playback.getCurrentTime() / TICKS_PER_SECOND;
	const t = Math.max(0, Math.round((playhead - sound.sync_s) * 1000) / 1000);
	const run = runOpsOnActiveScene({
		editor,
		seed: `${editor.project.getActive().metadata.id}/sfx/${sound.id}`,
		build: (snapshot) => {
			const lane = laneFor(snapshot, t, t + sound.duration_s);
			const ops: Op[] = [];
			if (lane.add) ops.push(lane.add);
			ops.push(
				{
					op: "sfx",
					author: "user",
					t,
					name: `SFX ${sound.id}`,
					url: sound.url,
					dur: sound.duration_s,
					track: lane.id,
					ref: "placed",
				},
				{ op: "gain", author: "user", el: "placed", db: sound.default_db },
			);
			return { project: snapshot, ops, extra: null };
		},
	});
	if (run.result.conflicts.length) {
		return { ok: false, message: run.result.conflicts.map((conflict) => conflict.message).join("; ") };
	}
	return {
		ok: true,
		message: `${sound.name} · ${sound.sync === "peak" ? "peak" : "attack"} on ${playhead.toFixed(2)} s · ${sound.default_db} dB`,
	};
}
