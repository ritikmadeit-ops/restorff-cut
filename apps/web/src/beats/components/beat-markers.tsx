"use client";

import type { AudioElement } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { getElementTimelineBeats } from "../timeline";

/**
 * Beat ticks drawn over a music clip on the timeline: downbeats bone and taller, other
 * beats fog. Pointer-transparent; they move and trim with the clip (beats are stored in
 * source time).
 */
export function BeatMarkers({
	element,
	pixelsPerSecond,
}: {
	element: AudioElement;
	pixelsPerSecond: number;
}) {
	if (!element.beats || element.beats.times.length === 0) return null;
	const beats = getElementTimelineBeats({ element, trackId: "" });
	// Skip drawing when beats would be closer than 3 px (zoomed far out).
	const spacing = (60 / Math.max(1, element.beats.bpm)) * pixelsPerSecond;
	const showAll = spacing >= 3;
	return (
		<div className="pointer-events-none absolute inset-0" aria-hidden>
			{beats.map((beat) => {
				if (!showAll && !beat.isDownbeat) return null;
				const left = ((beat.time - element.startTime) / TICKS_PER_SECOND) * pixelsPerSecond;
				return (
					<div
						key={beat.time}
						className="absolute bottom-0"
						style={{
							left: `${left}px`,
							width: "1px",
							height: beat.isDownbeat ? "100%" : "45%",
							background: beat.isDownbeat ? "rgba(237,235,230,0.75)" : "rgba(140,140,149,0.6)",
						}}
					/>
				);
			})}
		</div>
	);
}
