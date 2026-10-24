"use client";

import { useEffect, useState } from "react";
import {
	editChunkText,
	mergeChunkWithNext,
	nudgeChunk,
	nudgeChunkEdge,
	removeChunk,
	splitChunk,
	type CaptionDocChunk,
} from "@restorffcut/timeline-ops";
import { cn } from "@/utils/ui";
import { IconButton, Mono, formatTime } from "./kit";

/** Nudge step: about one frame at 30 fps. */
const STEP = 1 / 30;

/**
 * The caption editor: one row per chunk — edit the words, merge with the next, split in two, nudge the chunk or its
 * edges, delete. Every change hands a new caption document to `onChange` (the view rebuilds the captions from it, one
 * undo step per change).
 */
export function CaptionList({
	doc,
	activeTime,
	onChange,
	onSeek,
	disabled,
}: {
	doc: CaptionDocChunk[];
	activeTime: number;
	onChange: (doc: CaptionDocChunk[]) => void;
	onSeek: (seconds: number) => void;
	disabled?: boolean;
}) {
	return (
		<div className="flex flex-col gap-1">
			{doc.map((chunk, index) => (
				<CaptionRow
					key={`${index}-${chunk.start.toFixed(3)}`}
					chunk={chunk}
					index={index}
					last={index === doc.length - 1}
					active={activeTime >= chunk.start && activeTime < chunk.end}
					disabled={disabled}
					onSeek={onSeek}
					onText={(text) => onChange(editChunkText(doc, index, text))}
					onMerge={() => onChange(mergeChunkWithNext(doc, index))}
					onSplit={() => onChange(splitChunk(doc, index))}
					onNudge={(delta) => onChange(nudgeChunk(doc, index, delta))}
					onEdge={(edge, delta) => onChange(nudgeChunkEdge(doc, index, edge, delta))}
					onDelete={() => onChange(removeChunk(doc, index))}
				/>
			))}
		</div>
	);
}

function CaptionRow({
	chunk,
	index,
	last,
	active,
	disabled,
	onSeek,
	onText,
	onMerge,
	onSplit,
	onNudge,
	onEdge,
	onDelete,
}: {
	chunk: CaptionDocChunk;
	index: number;
	last: boolean;
	active: boolean;
	disabled?: boolean;
	onSeek: (seconds: number) => void;
	onText: (text: string) => void;
	onMerge: () => void;
	onSplit: () => void;
	onNudge: (delta: number) => void;
	onEdge: (edge: "start" | "end", delta: number) => void;
	onDelete: () => void;
}) {
	const text = chunk.words.map((word) => word.text).join(" ");
	const [draft, setDraft] = useState(text);
	useEffect(() => setDraft(text), [text]);
	const commit = () => {
		if (draft.trim() !== text) onText(draft);
	};

	return (
		<div
			className={cn(
				"group border-line rounded-[10px] border px-2 py-1.5 transition-colors",
				active ? "border-bone/50 bg-surface" : "hover:bg-surface",
			)}
		>
			<div className="flex items-center justify-between gap-1">
				<button type="button" className="cursor-pointer" onClick={() => onSeek(chunk.start)}>
					<Mono className={active ? "text-bone" : "text-fog"}>
						{String(index + 1).padStart(2, "0")} · {formatTime(chunk.start)}–{formatTime(chunk.end)}
					</Mono>
				</button>
				<div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
					<IconButton disabled={disabled} title="Start earlier" onClick={() => onEdge("start", -STEP)}>
						⇤
					</IconButton>
					<IconButton disabled={disabled} title="Earlier (1 frame)" onClick={() => onNudge(-STEP)}>
						‹
					</IconButton>
					<IconButton disabled={disabled} title="Later (1 frame)" onClick={() => onNudge(STEP)}>
						›
					</IconButton>
					<IconButton disabled={disabled} title="End later" onClick={() => onEdge("end", STEP)}>
						⇥
					</IconButton>
					<IconButton disabled={disabled || chunk.words.length < 2} title="Split in two" onClick={onSplit}>
						✂
					</IconButton>
					<IconButton disabled={disabled || last} title="Merge with the next" onClick={onMerge}>
						⤓
					</IconButton>
					<IconButton disabled={disabled} title="Delete" onClick={onDelete}>
						×
					</IconButton>
				</div>
			</div>
			<input
				className="text-bone mt-1 w-full bg-transparent text-[0.8rem] outline-none focus:underline focus:decoration-[#F6FF00] focus:underline-offset-4"
				value={draft}
				disabled={disabled}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") (event.target as HTMLInputElement).blur();
					if (event.key === "Escape") {
						setDraft(text);
						(event.target as HTMLInputElement).blur();
					}
					event.stopPropagation();
				}}
			/>
		</div>
	);
}
