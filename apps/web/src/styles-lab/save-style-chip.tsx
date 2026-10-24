"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { useStylesLabStore } from "./store";
import { KilnDot, Label, Pill, useRepeatSuggestions } from "./ui";

/** Pattern keys already announced with a toast in this page's life (the chip itself stays until saved/dismissed). */
const announced = new Set<string>();

/**
 * "Save as style?" (EDT-20): Claude noticed an instruction or op pattern repeated ≥ 3 times in the command history.
 * Kiln = Claude suggesting. One toast per new pattern; the chip stays until the person saves or dismisses it.
 */
export function SaveStyleChip({ announce = true }: { announce?: boolean }) {
	const suggestions = useRepeatSuggestions();
	const openSheet = useStylesLabStore((s) => s.openSheet);
	const dismiss = useStylesLabStore((s) => s.dismiss);
	const top = suggestions[0];

	useEffect(() => {
		if (!announce || !top || announced.has(top.pattern.key)) return;
		announced.add(top.pattern.key);
		toast(`Claude noticed: “${top.pattern.label}” ×${top.count}`, {
			description: "Save it as a style you can reuse with one sentence?",
			action: { label: "Save as style…", onClick: () => openSheet({ draft: top.draft_style, pattern: top.pattern.key }) },
		});
	}, [announce, openSheet, top]);

	if (!top) return null;
	return (
		<div className="border-kiln/60 bg-ground/60 flex flex-col gap-2 rounded-[14px] border px-3 py-2.5">
			<div className="flex items-center gap-2">
				<KilnDot />
				<Label tone="kiln">Save as style?</Label>
				<span className="rc-mono text-fog ml-auto text-[0.65rem]">
					×{top.count}
					{top.projects > 1 ? ` · ${top.projects} projects` : ""}
				</span>
			</div>
			<p className="text-bone text-[0.8rem] leading-snug">
				You keep asking for “{top.pattern.label}”
				{top.pattern.kind === "ops" && top.examples.length > 1 ? ` (and ${top.examples.length - 1} other wording${top.examples.length > 2 ? "s" : ""})` : ""}.
			</p>
			<div className="flex items-center gap-2">
				<Pill tone="kiln" onClick={() => openSheet({ draft: top.draft_style, pattern: top.pattern.key })}>
					Save as style…
				</Pill>
				<button
					type="button"
					onClick={() => dismiss(top.pattern.key)}
					className="text-fog hover:text-bone cursor-pointer text-[0.72rem]"
					title="Never suggest this one again"
				>
					Dismiss
				</button>
				{suggestions.length > 1 && <span className="text-fog ml-auto text-[0.68rem]">+{suggestions.length - 1} more</span>}
			</div>
		</div>
	);
}
