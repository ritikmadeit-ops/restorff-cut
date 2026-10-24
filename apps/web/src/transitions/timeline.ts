/**
 * Where transitions sit on a track — pure functions over the project model, shared by the
 * renderer, the panel and the timeline badge.
 *
 * A transition belongs to the INCOMING clip (`transitionIn`) and is centred on its start:
 * it runs from `cut − duration/2` to `cut + duration/2`. The outgoing clip is the one that
 * ends exactly at the cut on the same track (±1 tick); without one, the transition comes
 * from whatever is underneath (a fade in from the background).
 */
import type { ClipTransition, ImageElement, TimelineElement, TimelineTrack, VideoElement } from "@/timeline";
import { getTransitionDefinition, type TransitionDefinition } from "./definitions";

export type TransitionClip = VideoElement | ImageElement;

export interface PlacedTransition {
	trackId: string;
	incoming: TransitionClip;
	/** The clip it transitions from; null = from what is underneath. */
	outgoing: TransitionClip | null;
	definition: TransitionDefinition;
	transition: ClipTransition;
	/** Timeline ticks. */
	cut: number;
	start: number;
	end: number;
}

/** Adjacent within one tick (rounding of seconds → ticks can leave a 1-tick seam). */
const TOUCH_TOLERANCE_TICKS = 1;

export function isTransitionClip(element: TimelineElement): element is TransitionClip {
	return element.type === "video" || element.type === "image";
}

function rateOf(element: TransitionClip): number {
	return element.type === "video" ? (element.retime?.rate ?? 1) : 1;
}

/**
 * True when `b` simply continues `a` (same media, same speed, source picks up where `a`
 * stopped) — a split, not a cut. A dissolve or push there shows the same picture twice
 * (a dip or flash still reads), so the panel warns. Splits drop `transitionIn` from their
 * right half (SplitElementsCommand, reducer `split`), so none is created by accident.
 */
export function isThroughEdit(a: TransitionClip, b: TransitionClip): boolean {
	if (a.type !== b.type || a.mediaId !== b.mediaId) return false;
	if (rateOf(a) !== rateOf(b)) return false;
	if (a.type === "image") return true;
	const sourceEndOfA = a.trimStart + Math.round(a.duration * rateOf(a));
	return Math.abs(sourceEndOfA - b.trimStart) <= Math.max(2, Math.round(rateOf(a) * 2));
}

export function findOutgoingClip({
	track,
	incoming,
}: {
	track: TimelineTrack;
	incoming: TimelineElement;
}): TransitionClip | null {
	let best: TransitionClip | null = null;
	for (const element of track.elements) {
		if (element.id === incoming.id || !isTransitionClip(element)) continue;
		if ("hidden" in element && element.hidden) continue;
		const end = element.startTime + element.duration;
		if (Math.abs(end - incoming.startTime) <= TOUCH_TOLERANCE_TICKS) {
			best = element;
		}
	}
	return best;
}

/** Longest transition a cut can take: both halves must fit inside both clips. */
export function maxTransitionDuration({
	incoming,
	outgoing,
}: {
	incoming: TimelineElement;
	outgoing: TimelineElement | null;
}): number {
	const limit = outgoing ? Math.min(incoming.duration, outgoing.duration) : incoming.duration;
	return Math.max(0, limit);
}

export function getTrackTransitions(track: TimelineTrack): PlacedTransition[] {
	if (track.type !== "video") return [];
	const placed: PlacedTransition[] = [];
	for (const element of track.elements) {
		if (!isTransitionClip(element) || !element.transitionIn) continue;
		if (element.hidden) continue;
		const definition = getTransitionDefinition(element.transitionIn.type);
		if (!definition) continue;
		const outgoing = findOutgoingClip({ track, incoming: element });
		const duration = Math.min(
			Math.round(element.transitionIn.duration),
			maxTransitionDuration({ incoming: element, outgoing }),
		);
		if (!(duration > 0)) continue;
		const half = duration / 2;
		placed.push({
			trackId: track.id,
			incoming: element,
			outgoing,
			definition,
			transition: element.transitionIn,
			cut: element.startTime,
			start: element.startTime - half,
			end: element.startTime + half,
		});
	}
	return placed;
}

/** How far through the transition `time` is, 0..1, or null outside it. */
export function transitionProgressAt({
	placed,
	time,
}: {
	placed: Pick<PlacedTransition, "start" | "end">;
	time: number;
}): number | null {
	if (time < placed.start || time >= placed.end) return null;
	return (time - placed.start) / (placed.end - placed.start);
}
