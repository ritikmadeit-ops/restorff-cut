/**
 * EDT-11 "Remove dead air & retakes" on one clip: the clip's transcript (source seconds) → @restorffcut/timeline-ops
 * `cutFromTranscript` (silences over the threshold, earlier takes of repeated sentences, head / tail) → a preview
 * list a person can untick (`keep`) → the same ops through the reducer → ONE undo step (TracksSnapshotCommand).
 *
 * Ripple is per track (the editor's ripple mode): the clip's own track closes up; other tracks stay where they are, so
 * captions are rebuilt from the new timeline afterwards (the caller does that, as a second undo step).
 */
import { cutFromTranscript, type CutPlan } from "@restorffcut/timeline-ops";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import type { TimelineElement } from "@/timeline";
import { getTranscript, type MediaTranscript } from "@/transcription/transcript-store";
import { clipSourceWindow, listSpokenClips, rateOf, type SpokenClip } from "@/captions/timeline-words";
import { commitTracks, conflictText, freshSeed, runOpsOnActiveScene } from "@/captions/ops-bridge";

export interface CutSettings {
	/** Pauses longer than this are cut (seconds). */
	silence: number;
	/** Breathing room kept around words (seconds). */
	pad: number;
	/** Cut the earlier take of repeated sentences. */
	retakes: boolean;
}

export const DEFAULT_CUT_SETTINGS: CutSettings = { silence: 0.35, pad: 0.06, retakes: true };

export interface CutTarget {
	clip: SpokenClip;
	asset: MediaAsset;
}

/** The selected clip if it can carry speech, else the first clip on the main track. */
export function findCutTarget({ editor }: { editor: EditorCore }): CutTarget | null {
	const tracks = editor.scenes.getActiveScene().tracks;
	const clips = listSpokenClips(tracks);
	const assets = new Map(editor.media.getAssets().map((asset) => [asset.id, asset]));
	const selected = editor.selection.getSelectedElements();
	const pick =
		clips.find((clip) => selected.some((ref) => ref.elementId === clip.id)) ??
		clips.find((clip) => clip.trackId === tracks.main.id) ??
		clips[0];
	if (!pick) return null;
	const asset = assets.get(pick.mediaId);
	return asset ? { clip: pick, asset } : null;
}

export function planCut({
	clip,
	transcript,
	settings,
	keep,
}: {
	clip: TimelineElement;
	transcript: MediaTranscript;
	settings: CutSettings;
	keep?: number[];
}): CutPlan {
	if (rateOf(clip) !== 1) throw new Error("this clip is sped up or slowed down — auto-cut works on 1× clips for now");
	const window = clipSourceWindow(clip);
	return cutFromTranscript(transcript.words, {
		clip: { el: clip.id, start: window.start, in: window.in, out: window.out },
		silence: settings.silence,
		pad: settings.pad,
		// no retakes: a window of 0 sentences never matches
		retakeWindow: settings.retakes ? 3 : 0,
		captions: false,
		author: "user",
		keep,
	});
}

export function transcriptFor(target: CutTarget): MediaTranscript | null {
	return getTranscript(target.asset);
}

/** Apply a plan's ops (one undo step). Returns seconds removed. */
export function applyCut({ editor, plan }: { editor: EditorCore; plan: CutPlan }): number {
	if (!plan.ops.length) return 0;
	const run = runOpsOnActiveScene({ editor, ops: plan.ops, seed: freshSeed(editor, "autocut") });
	if (!run.result.ok) throw new Error(`cut not applied — ${conflictText(run.result)}`);
	commitTracks({ editor, before: run.before, after: run.after });
	return plan.stats.removedSeconds;
}
