/**
 * Beats on the timeline: where a music element's beats land, snap points for them, and
 * "snap cuts to beats" (a roll edit of each cut on a track to the nearest beat).
 */
import type { AudioElement, SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import type { SnapPoint } from "@/timeline/snapping/types";
import { roundMediaTime, type MediaTime } from "@/wasm";

export interface TimelineBeat {
	time: number;
	isDownbeat: boolean;
	elementId: string;
	trackId: string;
}

function rateOf(element: AudioElement): number {
	return element.retime?.rate ?? 1;
}

/** Beats of one audio element that fall inside its visible span, in timeline ticks. */
export function getElementTimelineBeats({
	element,
	trackId,
}: {
	element: AudioElement;
	trackId: string;
}): TimelineBeat[] {
	const grid = element.beats;
	if (!grid || grid.times.length === 0) return [];
	const rate = rateOf(element);
	const downbeats = new Set(grid.downbeats ?? []);
	const end = element.startTime + element.duration;
	const beats: TimelineBeat[] = [];
	grid.times.forEach((sourceTime, index) => {
		const time = element.startTime + (sourceTime - element.trimStart) / rate;
		if (time < element.startTime || time >= end) return;
		beats.push({ time, isDownbeat: downbeats.has(index), elementId: element.id, trackId });
	});
	return beats;
}

export function getTimelineBeats(tracks: SceneTracks): TimelineBeat[] {
	const beats: TimelineBeat[] = [];
	for (const track of tracks.audio) {
		if (track.muted) continue;
		for (const element of track.elements) {
			beats.push(...getElementTimelineBeats({ element, trackId: track.id }));
		}
	}
	return beats.sort((a, b) => a.time - b.time);
}

export function getBeatSnapPoints({ tracks }: { tracks: SceneTracks }): SnapPoint[] {
	return getTimelineBeats(tracks).map((beat) => ({
		time: roundMediaTime({ time: beat.time }),
		type: "beat" as const,
		elementId: beat.elementId,
		trackId: beat.trackId,
	}));
}

export interface CutSnapPlan {
	updates: Array<{ trackId: string; elementId: string; patch: Partial<TimelineElement> }>;
	moved: number;
	skipped: number;
}

/**
 * Roll every cut on `track` (where one clip ends exactly where the next starts) to the
 * nearest beat within `maxShiftTicks`: the outgoing clip gets longer/shorter at its tail,
 * the incoming clip's head moves by the same amount. A cut moves only if both clips have
 * the media to do it (trim handles) and stay at least `minClipTicks` long.
 */
export function planSnapCutsToBeats({
	track,
	beats,
	maxShiftTicks,
	minClipTicks,
	frameTicks,
}: {
	track: TimelineTrack;
	beats: number[];
	maxShiftTicks: number;
	minClipTicks: number;
	frameTicks: number;
}): CutSnapPlan {
	const plan: CutSnapPlan = { updates: [], moved: 0, skipped: 0 };
	if (beats.length === 0) return plan;
	// Work on copies: a clip between two cuts is changed by both.
	const sorted = [...track.elements]
		.sort((a, b) => a.startTime - b.startTime)
		.map((element) => ({ ...element }) as TimelineElement);
	const changed = new Set<string>();
	for (let i = 0; i < sorted.length - 1; i++) {
		const a = sorted[i];
		const b = sorted[i + 1];
		const cut = a.startTime + a.duration;
		if (Math.abs(cut - b.startTime) > 1) continue;
		let nearest = beats[0];
		for (const beat of beats) if (Math.abs(beat - cut) < Math.abs(nearest - cut)) nearest = beat;
		// Cuts land on frame boundaries: the frame that contains the beat's attack.
		const target = Math.round(nearest / frameTicks) * frameTicks;
		const shift = target - cut;
		if (shift === 0) continue;
		if (Math.abs(shift) > maxShiftTicks) {
			plan.skipped++;
			continue;
		}
		const rateA = a.type === "video" || a.type === "audio" ? (a.retime?.rate ?? 1) : 1;
		const rateB = b.type === "video" || b.type === "audio" ? (b.retime?.rate ?? 1) : 1;
		const hasMedia = (element: TimelineElement) => element.type === "video" || element.type === "audio";
		// a's tail: extending needs trimEnd; b's head: moving earlier needs trimStart.
		const aSource = Math.round(shift * rateA);
		const bSource = Math.round(shift * rateB);
		const aOk =
			a.duration + shift >= minClipTicks && (!hasMedia(a) || a.trimEnd - aSource >= 0);
		const bOk =
			b.duration - shift >= minClipTicks && (!hasMedia(b) || b.trimStart + bSource >= 0);
		if (!aOk || !bOk) {
			plan.skipped++;
			continue;
		}
		a.duration = (a.duration + shift) as MediaTime;
		if (hasMedia(a)) a.trimEnd = (a.trimEnd - aSource) as MediaTime;
		b.startTime = (b.startTime + shift) as MediaTime;
		b.duration = (b.duration - shift) as MediaTime;
		if (hasMedia(b)) b.trimStart = (b.trimStart + bSource) as MediaTime;
		changed.add(a.id);
		changed.add(b.id);
		plan.moved++;
	}
	for (const element of sorted) {
		if (!changed.has(element.id)) continue;
		plan.updates.push({
			trackId: track.id,
			elementId: element.id,
			patch: {
				startTime: element.startTime,
				duration: element.duration,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
			},
		});
	}
	return plan;
}
