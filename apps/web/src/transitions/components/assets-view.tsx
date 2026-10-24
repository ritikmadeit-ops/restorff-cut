"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	TRANSITION_CATEGORY_LABELS,
	TRANSITIONS,
	type TransitionCategory,
	type TransitionDefinition,
} from "../definitions";
import { pickTransitionTarget, setClipTransition } from "../apply";

/**
 * The Transitions tab (media agent, 2026-10-20). Click a transition: it goes on the cut
 * INTO the selected clip, or — with nothing selected — on the main-track cut nearest the
 * playhead. Rendered by the wasm compositor; the clip's own "Transition" properties tab
 * changes its length or removes it.
 */
export function TransitionsView() {
	const editor = useEditor();
	const [query, setQuery] = useState("");

	const groups = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const matches = TRANSITIONS.filter(
			(definition) =>
				!needle ||
				definition.name.toLowerCase().includes(needle) ||
				definition.keywords.some((keyword) => keyword.includes(needle)),
		);
		const byCategory = new Map<TransitionCategory, TransitionDefinition[]>();
		for (const definition of matches) {
			const list = byCategory.get(definition.category) ?? [];
			list.push(definition);
			byCategory.set(definition.category, list);
		}
		return [...byCategory.entries()];
	}, [query]);

	const apply = (definition: TransitionDefinition) => {
		const target = pickTransitionTarget(editor);
		if (!target) {
			toast.error("Select a clip, or put the playhead near a cut on the main track");
			return;
		}
		const result = setClipTransition({ editor, target, type: definition.id });
		if (!result.ok) {
			toast.error(result.error);
			return;
		}
		toast.success(
			`${definition.name} · ${(result.duration / TICKS_PER_SECOND).toFixed(2)} s on the cut`,
		);
	};

	return (
		<PanelView title="Transitions">
			<p className="text-fog mb-3 text-[0.72rem] leading-snug">
				Goes on the cut into the selected clip (or the main-track cut nearest the playhead), centred on the cut.
				Half plays before it, half after — clips with spare media at their ends use it; others hold a frame.
			</p>
			<input
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				placeholder="Search transitions"
				className="bg-surface border-line text-bone placeholder:text-fog mb-4 w-full rounded-[10px] border px-3 py-1.5 text-[0.75rem] outline-none"
			/>
			<div className="flex flex-col gap-5 pb-6">
				{groups.map(([category, definitions]) => (
					<section key={category} className="flex flex-col gap-2">
						<h3 className="rc-label text-fog text-[0.62rem]">
							{TRANSITION_CATEGORY_LABELS[category]}
						</h3>
						<div className="grid grid-cols-2 gap-2">
							{definitions.map((definition) => (
								<button
									key={definition.id}
									type="button"
									onClick={() => apply(definition)}
									title={definition.hint}
									className={cn(
										"bg-surface border-line hover:border-bone/40 group flex cursor-pointer flex-col items-start gap-1 rounded-[12px] border p-2 text-left transition-colors",
									)}
								>
									<TransitionGlyph definition={definition} />
									<span className="text-bone text-[0.72rem] leading-tight">{definition.name}</span>
									<span className="rc-mono text-fog text-[0.6rem]">
										{definition.defaultDurationSeconds.toFixed(2)} s
									</span>
								</button>
							))}
						</div>
					</section>
				))}
				{groups.length === 0 && <p className="rc-mono text-fog text-[0.7rem]">no match</p>}
			</div>
		</PanelView>
	);
}

/** A two-tone tile hinting at the move (A = bone, B = fog). */
function TransitionGlyph({ definition }: { definition: TransitionDefinition }) {
	const direction = definition.uniforms.u_direction;
	const vector = Array.isArray(direction) ? direction : [0, 0];
	const arrow =
		vector[0] < 0 ? "←" : vector[0] > 0 ? "→" : vector[1] < 0 ? "↑" : vector[1] > 0 ? "↓" : "";
	const background =
		definition.category === "dissolve"
			? "linear-gradient(90deg, #EDEBE6 0%, #8C8C95 100%)"
			: definition.category === "dip"
				? `linear-gradient(90deg, #EDEBE6 0%, ${definition.id === "dip-black" ? "#0C0C0E" : "#FFFFFF"} 50%, #8C8C95 100%)`
				: definition.category === "wipe"
					? "linear-gradient(90deg, #8C8C95 0 45%, #EDEBE6 55% 100%)"
					: "linear-gradient(90deg, #EDEBE6 0 50%, #8C8C95 50% 100%)";
	return (
		<div
			className="relative flex h-10 w-full items-center justify-center overflow-hidden rounded-[8px] opacity-80 group-hover:opacity-100"
			style={{ background }}
		>
			{arrow && <span className="text-[#0C0C0E] text-base font-bold">{arrow}</span>}
		</div>
	);
}
