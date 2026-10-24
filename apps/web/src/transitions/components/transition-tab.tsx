"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Section, SectionContent } from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import type { ImageElement, VideoElement } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { getTransitionDefinition, TRANSITIONS } from "../definitions";
import { removeClipTransition, setClipTransition } from "../apply";
import { findOutgoingClip, isThroughEdit, maxTransitionDuration } from "../timeline";

/** Properties tab for a video/image clip: the transition on the cut into it. */
export function TransitionTab({
	element,
	trackId,
}: {
	element: VideoElement | ImageElement;
	trackId: string;
}) {
	const editor = useEditor();
	const track = useEditor((e) =>
		[...e.scenes.getActiveScene().tracks.overlay, e.scenes.getActiveScene().tracks.main].find(
			(candidate) => candidate.id === trackId,
		),
	);
	const current = element.transitionIn;
	const definition = current ? getTransitionDefinition(current.type) : null;
	const outgoing = track ? findOutgoingClip({ track, incoming: element }) : null;
	const limitSeconds = maxTransitionDuration({ incoming: element, outgoing }) / TICKS_PER_SECOND;
	const [seconds, setSeconds] = useState(
		current ? current.duration / TICKS_PER_SECOND : 0.4,
	);
	useEffect(() => {
		if (current) setSeconds(current.duration / TICKS_PER_SECOND);
	}, [current]);

	const target = { trackId, elementId: element.id };
	const apply = (type: string, durationSeconds: number) => {
		const result = setClipTransition({ editor, target, type, durationSeconds });
		if (!result.ok) toast.error(result.error);
	};

	const handleSeconds = (outgoing && element.type === "video" && outgoing.type === "video" ? element.trimStart : 0) / TICKS_PER_SECOND;

	return (
		<Section sectionKey={`${element.id}:transition`}>
			<SectionContent className="flex flex-col gap-3 pt-4">
				<p className="text-fog text-[0.72rem] leading-snug">
					{outgoing
						? isThroughEdit(outgoing, element)
							? "The clip before this one continues the same shot (a split): a dissolve or push will barely show; a dip or flash will."
							: `Transition from “${outgoing.name}” into this clip, centred on the cut.`
						: "No clip ends where this one starts: the transition comes from what is underneath (e.g. a fade in from black)."}
				</p>
				<label className="flex flex-col gap-1">
					<span className="rc-label text-fog text-[0.62rem]">Type</span>
					<select
						value={current?.type ?? ""}
						onChange={(event) => {
							if (!event.target.value) {
								removeClipTransition({ editor, target });
								return;
							}
							const next = getTransitionDefinition(event.target.value);
							apply(event.target.value, current ? seconds : (next?.defaultDurationSeconds ?? seconds));
						}}
						className="bg-surface border-line text-bone rounded-[10px] border px-2 py-1.5 text-[0.75rem]"
					>
						<option value="">None (cut)</option>
						{TRANSITIONS.map((option) => (
							<option key={option.id} value={option.id}>
								{option.name}
							</option>
						))}
					</select>
				</label>
				{current && definition && (
					<>
						<label className="flex flex-col gap-1">
							<span className="rc-label text-fog text-[0.62rem]">
								Length · max {limitSeconds.toFixed(2)} s
							</span>
							<input
								type="number"
								min={0.04}
								max={Math.max(0.04, limitSeconds)}
								step={0.04}
								value={Number(seconds.toFixed(2))}
								onChange={(event) => setSeconds(Number(event.target.value))}
								onBlur={() => apply(current.type, seconds)}
								onKeyDown={(event) => {
									if (event.key === "Enter") apply(current.type, seconds);
								}}
								className="bg-surface border-line text-bone rc-mono rounded-[10px] border px-2 py-1.5 text-[0.75rem]"
							/>
						</label>
						<p className="rc-mono text-fog text-[0.62rem]">{definition.hint}</p>
						{element.type === "video" && handleSeconds < seconds / 2 && outgoing && (
							<p className="rc-mono text-[0.62rem] text-[#E8A33D]">
								only {handleSeconds.toFixed(2)} s of media before this clip's in-point: its first frame holds
								for the rest
							</p>
						)}
						<button
							type="button"
							className="rc-pill self-start"
							onClick={() => removeClipTransition({ editor, target })}
						>
							Remove transition
						</button>
					</>
				)}
			</SectionContent>
		</Section>
	);
}
