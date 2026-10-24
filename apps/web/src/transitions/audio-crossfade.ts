/**
 * Audio crossfades under picture transitions (polish agent, 2026-10-20). The media agent's transitions blend the
 * picture over `cut ± duration/2` (transitions/timeline.ts) but the audio hard-cut at the cut. Here, where two clips
 * WITH AUDIO meet under a transition, the outgoing clip's audio fades out and the incoming clip's fades in, equal
 * power (cos / sin), over the transition's window — in preview (core/managers/audio-manager.ts) and in export
 * (media/audio.ts `createTimelineAudioBuffer`), from this one plan.
 *
 * Handles, like the picture side (which reads into trim handles): the outgoing clip keeps playing past the cut out of
 * its trimmed-off tail (`trimEnd`), the incoming clip starts early out of its trimmed-off head (`trimStart`). Where a
 * side has no handle, its fade happens inside the clip instead (out: `cut − half → cut`, in: `cut → cut + half`), so
 * there is never a hard edge; with both handles it is a true overlapping crossfade over the full window. Clips that
 * are retimed (rate ≠ 1) are not extended (their audio may be pitch-rendered from the trimmed span only); they still
 * get their in-clip fade.
 *
 * Pure: no editor, no audio context. Times out are timeline SECONDS.
 */
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { getTrackTransitions } from "./timeline";

export interface FadeWindow {
	/** Timeline seconds. */
	start: number;
	end: number;
}

export interface AudioCrossfade {
	/** Seconds of the element's audio played BEFORE its start (out of its head handle). */
	extendBefore: number;
	/** Seconds played AFTER its end (out of its tail handle). */
	extendAfter: number;
	fadeIn: FadeWindow | null;
	fadeOut: FadeWindow | null;
}

type ExtendableElement = Pick<TimelineElement, "id" | "type" | "trimStart" | "trimEnd"> & {
	retime?: { rate?: number; mode?: unknown } | null;
};

/** Constant rate 1 (no retime): source time = clip time, so the handles are exact. */
function canExtend(element: ExtendableElement): boolean {
	if (element.type !== "video") return false;
	const retime = element.retime;
	if (!retime) return true;
	return (retime.rate ?? 1) === 1 && retime.mode !== "curve";
}

/**
 * Which elements fade, and how far each one's audio runs past its edges. `isAudible` says whether an element's audio
 * is actually heard (has audio, not muted, track not muted); both sides of a transition must be audible.
 */
export function planAudioCrossfades({
	tracks,
	isAudible,
}: {
	tracks: SceneTracks;
	isAudible: (elementId: string) => boolean;
}): Map<string, AudioCrossfade> {
	const plan = new Map<string, AudioCrossfade>();
	const entry = (id: string): AudioCrossfade => {
		let found = plan.get(id);
		if (!found) {
			found = { extendBefore: 0, extendAfter: 0, fadeIn: null, fadeOut: null };
			plan.set(id, found);
		}
		return found;
	};

	const all: TimelineTrack[] = [...tracks.overlay, tracks.main, ...tracks.audio];
	for (const track of all) {
		if (track.type !== "video") continue;
		if ("muted" in track && track.muted) continue;
		for (const placed of getTrackTransitions(track)) {
			const outgoing = placed.outgoing;
			const incoming = placed.incoming;
			if (!outgoing) continue;
			if (!isAudible(outgoing.id) || !isAudible(incoming.id)) continue;

			const cut = placed.cut / TICKS_PER_SECOND;
			const half = (placed.end - placed.start) / 2 / TICKS_PER_SECOND;
			if (!(half > 0)) continue;
			const tail = canExtend(outgoing) ? Math.max(0, outgoing.trimEnd) / TICKS_PER_SECOND : 0;
			const head = canExtend(incoming) ? Math.max(0, incoming.trimStart) / TICKS_PER_SECOND : 0;
			const after = Math.min(half, tail);
			const before = Math.min(half, head);

			const out = entry(outgoing.id);
			out.extendAfter = Math.max(out.extendAfter, after);
			out.fadeOut = { start: cut - half, end: cut + after };

			const inc = entry(incoming.id);
			inc.extendBefore = Math.max(inc.extendBefore, before);
			inc.fadeIn = { start: cut - before, end: cut + half };
		}
	}
	return plan;
}

function progress(window: FadeWindow, t: number): number {
	const span = window.end - window.start;
	if (!(span > 0)) return t >= window.end ? 1 : 0;
	return Math.min(1, Math.max(0, (t - window.start) / span));
}

/** Equal-power gain (0..1) of an element's audio at timeline second `t`. */
export function crossfadeGainAt(fade: AudioCrossfade | null | undefined, t: number): number {
	if (!fade) return 1;
	let gain = 1;
	if (fade.fadeIn) gain *= Math.sin((progress(fade.fadeIn, t) * Math.PI) / 2);
	if (fade.fadeOut) gain *= Math.cos((progress(fade.fadeOut, t) * Math.PI) / 2);
	return gain;
}

/**
 * Points for Web Audio automation (linear ramps between them approximate the curve): `steps` per fade window,
 * from timeline second `from` on. Sorted, deduplicated.
 */
export function crossfadeAutomation(
	fade: AudioCrossfade,
	from: number,
	steps = 24,
): Array<{ t: number; gain: number }> {
	const times = new Set<number>([from]);
	for (const window of [fade.fadeIn, fade.fadeOut]) {
		if (!window) continue;
		for (let i = 0; i <= steps; i++) {
			const t = window.start + ((window.end - window.start) * i) / steps;
			if (t > from) times.add(t);
		}
	}
	return [...times].sort((a, b) => a - b).map((t) => ({ t, gain: crossfadeGainAt(fade, t) }));
}
