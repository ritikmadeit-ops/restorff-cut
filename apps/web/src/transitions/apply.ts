/**
 * Editor actions for transitions (undoable: they go through UpdateElementsCommand).
 * Claude does not call these (BUILD-BRIEF B7) — it emits the ops@1 `transition` op, which
 * writes the same `transitionIn` field (packages/timeline-ops reducer).
 */
import type { EditorCore } from "@/core";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { mediaTimeFromSeconds, roundMediaTime } from "@/wasm";
import { getTransitionDefinition } from "./definitions";
import { findOutgoingClip, isTransitionClip, maxTransitionDuration } from "./timeline";

export interface TransitionTarget {
	trackId: string;
	elementId: string;
}

function allTracks(tracks: SceneTracks): TimelineTrack[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

function findElement(
	tracks: SceneTracks,
	target: TransitionTarget,
): { track: TimelineTrack; element: TimelineElement } | null {
	const track = allTracks(tracks).find((candidate) => candidate.id === target.trackId);
	const element = track?.elements.find((candidate) => candidate.id === target.elementId);
	return track && element ? { track, element } : null;
}

/**
 * The clip a transition should go on: the selected clip if it is a video/image, else the
 * clip on the main track whose start (a cut) is nearest the playhead.
 */
export function pickTransitionTarget(editor: EditorCore): TransitionTarget | null {
	const tracks = editor.scenes.getActiveScene().tracks;
	for (const ref of editor.selection.getSelectedElements()) {
		const found = findElement(tracks, ref);
		if (found && isTransitionClip(found.element)) {
			return { trackId: found.track.id, elementId: found.element.id };
		}
	}
	const playhead = editor.playback.getCurrentTime();
	let best: TransitionTarget | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const element of tracks.main.elements) {
		if (!isTransitionClip(element)) continue;
		const hasOutgoing = findOutgoingClip({ track: tracks.main, incoming: element }) !== null;
		if (!hasOutgoing && element.startTime > 0) continue;
		const distance = Math.abs(element.startTime - playhead);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = { trackId: tracks.main.id, elementId: element.id };
		}
	}
	return best;
}

/** Puts `type` on the cut INTO the target clip; returns the length used (ticks), or an error. */
export function setClipTransition({
	editor,
	target,
	type,
	durationSeconds,
}: {
	editor: EditorCore;
	target: TransitionTarget;
	type: string;
	durationSeconds?: number;
}): { ok: true; duration: number } | { ok: false; error: string } {
	const definition = getTransitionDefinition(type);
	if (!definition) return { ok: false, error: `Unknown transition "${type}"` };
	const tracks = editor.scenes.getActiveScene().tracks;
	const found = findElement(tracks, target);
	if (!found || !isTransitionClip(found.element)) {
		return { ok: false, error: "Pick a video or image clip" };
	}
	const outgoing = findOutgoingClip({ track: found.track, incoming: found.element });
	const requested = mediaTimeFromSeconds({
		seconds: durationSeconds ?? definition.defaultDurationSeconds,
	});
	const limit = maxTransitionDuration({ incoming: found.element, outgoing });
	const duration = roundMediaTime({ time: Math.max(1, Math.min(requested, limit)) });
	editor.timeline.updateElements({
		updates: [
			{
				trackId: target.trackId,
				elementId: target.elementId,
				patch: { transitionIn: { type: definition.id, duration } },
			},
		],
	});
	return { ok: true, duration };
}

export function removeClipTransition({
	editor,
	target,
}: {
	editor: EditorCore;
	target: TransitionTarget;
}): void {
	editor.timeline.updateElements({
		updates: [
			{
				trackId: target.trackId,
				elementId: target.elementId,
				patch: { transitionIn: undefined },
			},
		],
	});
}
