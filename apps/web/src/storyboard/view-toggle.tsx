"use client";

import { useStoryboardStore } from "./store";
import { cn } from "@/utils/ui";

/**
 * "Edit · Storyboard" segmented switch and a "Compare" toggle, in the timeline
 * toolbar. Storyboard swaps the centre preview for the shot grid; Compare lays
 * the before/after wipe over the preview. Mono 11 px, quiet outline: neither is
 * the view's isolate, so no neon here.
 */
export function StoryboardViewToggle() {
	const view = useStoryboardStore((s) => s.view);
	const compare = useStoryboardStore((s) => s.compare);
	const setView = useStoryboardStore((s) => s.setView);
	const toggleCompare = useStoryboardStore((s) => s.toggleCompare);

	const segment = (active: boolean) =>
		cn(
			"rc-mono h-[26px] px-2.5 text-[11px] uppercase tracking-[0.08em] transition-colors",
			active ? "bg-raised text-bone" : "text-mist hover:text-bone",
		);

	return (
		<div className="flex items-center gap-2">
			<div
				role="tablist"
				aria-label="Centre view"
				className="border-outline flex overflow-hidden rounded-[8px] border"
			>
				<button
					type="button"
					role="tab"
					aria-selected={view === "edit"}
					className={segment(view === "edit")}
					onClick={() => setView("edit")}
				>
					Edit
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={view === "storyboard"}
					className={segment(view === "storyboard")}
					onClick={() => setView("storyboard")}
					title="Every shot as a card: frame, time, the words over it (S)"
				>
					Storyboard
				</button>
			</div>
			<button
				type="button"
				aria-pressed={compare}
				onClick={toggleCompare}
				title="Before / after wipe at the playhead"
				className={cn(
					"border-outline rounded-[8px] border",
					segment(compare),
				)}
			>
				Compare
			</button>
		</div>
	);
}
