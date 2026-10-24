"use client";

import { useRef } from "react";
import { sampleUrl } from "../api";
import type { CompositionEntry } from "../types";
import { CHECKER } from "./compose-dialog";

/** The composition library as 9:16 tiles: a still of the sample, playing on hover. Click opens the compose dialog. */
export function MotionGrid({
	entries,
	onPick,
}: {
	entries: CompositionEntry[];
	onPick: (entry: CompositionEntry) => void;
}) {
	return (
		<div className="grid grid-cols-2 gap-x-2.5 gap-y-3">
			{entries.map((entry) => (
				<MotionTile key={entry.name} entry={entry} onPick={onPick} />
			))}
		</div>
	);
}

function MotionTile({
	entry,
	onPick,
}: {
	entry: CompositionEntry;
	onPick: (entry: CompositionEntry) => void;
}) {
	const videoRef = useRef<HTMLVideoElement>(null);
	return (
		<button
			type="button"
			className="group flex cursor-pointer flex-col gap-1.5 text-left"
			title={entry.description}
			onClick={() => onPick(entry)}
			onMouseEnter={() => void videoRef.current?.play().catch(() => {})}
			onMouseLeave={() => {
				const video = videoRef.current;
				if (!video) return;
				video.pause();
				video.currentTime = Math.min(video.duration || 0, entry.duration * 0.55);
			}}
		>
			<div
				className="border-line relative aspect-[9/16] w-full overflow-hidden rounded-[12px] border transition-colors group-hover:border-[#5a5a63]"
				style={{ background: CHECKER }}
			>
				{entry.hasSample && (
					<video
						ref={videoRef}
						src={sampleUrl({ name: entry.name })}
						className="absolute inset-0 size-full object-contain"
						muted
						loop
						playsInline
						preload="metadata"
						onLoadedMetadata={(event) => {
							event.currentTarget.currentTime = entry.duration * 0.55;
						}}
					/>
				)}
				<span className="rc-mono absolute right-1.5 bottom-1.5 rounded-full bg-black/60 px-1.5 text-[0.6rem] text-bone">
					{entry.duration}s
				</span>
			</div>
			<span className="truncate text-[0.78rem] font-medium text-bone">{entry.title}</span>
		</button>
	);
}
