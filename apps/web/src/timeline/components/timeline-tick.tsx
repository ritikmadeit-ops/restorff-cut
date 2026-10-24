"use client";

import type { FrameRate } from "restorffcut-wasm";
import { timelineTimeToSnappedPixels } from "@/timeline";
import { formatRulerLabel } from "@/timeline/ruler-utils";
import { formatShortTime } from "@/storyboard/labels";

interface TimelineTickProps {
	time: number;
	timeInSeconds: number;
	zoomLevel: number;
	fps: FrameRate;
	showLabel: boolean;
}

export function TimelineTick({
	time,
	timeInSeconds,
	zoomLevel,
	fps,
	showLabel,
}: TimelineTickProps) {
	const leftPosition = timelineTimeToSnappedPixels({ time, zoomLevel });

	if (showLabel) {
		// Artboard ruler: "0:00 0:05 0:10" (m:ss) on whole seconds; frame labels ("15f") between.
		const isWholeSecond = Math.abs(timeInSeconds - Math.round(timeInSeconds)) < 0.0001;
		const label = isWholeSecond
			? formatShortTime(Math.round(timeInSeconds))
			: formatRulerLabel({ timeInSeconds, fps });
		return (
			<span
				className="rc-mono text-fog absolute top-1 select-none text-[10px] leading-none"
				style={{ left: `${leftPosition}px` }}
			>
				{label}
			</span>
		);
	}

	return (
		<div
			className="absolute top-1.5 h-1.5 border-l border-[#34343b]"
			style={{ left: `${leftPosition}px` }}
		/>
	);
}
