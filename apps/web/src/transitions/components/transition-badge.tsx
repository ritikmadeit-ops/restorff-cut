"use client";

import type { TimelineElement } from "@/timeline";
import { getTransitionDefinition } from "../definitions";

/** A small bowtie on the head of a clip that has a transition into it. */
export function TransitionBadge({ element }: { element: TimelineElement }) {
	if (element.type !== "video" && element.type !== "image") return null;
	if (!element.transitionIn) return null;
	const definition = getTransitionDefinition(element.transitionIn.type);
	return (
		<div
			className="pointer-events-none absolute top-1 left-0 z-10 flex h-3.5 items-center rounded-r-[4px] bg-[#EDEBE6] px-1"
			title={definition?.name ?? element.transitionIn.type}
			aria-label={`Transition: ${definition?.name ?? element.transitionIn.type}`}
		>
			<svg width="10" height="8" viewBox="0 0 10 8" aria-hidden>
				<path d="M0 0 L5 4 L0 8 Z M10 0 L5 4 L10 8 Z" fill="#0C0C0E" />
			</svg>
		</div>
	);
}
