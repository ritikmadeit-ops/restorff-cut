"use client";

import { useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { cn } from "@/utils/ui";
import { ExplainerFlow } from "./explainer/explainer-flow";
import { MyStyles } from "./my-styles";
import { SaveStyleChip } from "./save-style-chip";

/**
 * The Styles tab of the left panel (styles agent, 2026-10-20):
 *   MY STYLES   saved styles from repeated instructions (EDT-20): versions, apply, edit, delete, Export/Import JSON
 *   EXPLAINER   a Paper collage explainer from dropped reference folders (EDT-21)
 * Registered with one entry each in components/editor/panels/assets/{assets-panel-store.tsx,index.tsx}.
 */
type View = "mine" | "explainer";

const VIEWS: Array<{ id: View; label: string }> = [
	{ id: "mine", label: "My styles" },
	{ id: "explainer", label: "Explainer" },
];

export function StylesLabView() {
	const [view, setView] = useState<View>("mine");
	return (
		<PanelView title="Styles">
			<div className="bg-surface border-line mb-4 grid grid-cols-2 gap-0.5 rounded-[12px] border p-0.5">
				{VIEWS.map((item) => (
					<button
						key={item.id}
						type="button"
						onClick={() => setView(item.id)}
						className={cn(
							"rc-mono cursor-pointer rounded-[10px] py-1.5 text-[0.68rem] uppercase tracking-[0.08em] transition-colors",
							view === item.id ? "bg-[#2a2a31] text-bone" : "text-fog hover:text-bone",
						)}
					>
						{item.label}
					</button>
				))}
			</div>
			{view === "mine" ? (
				<div className="flex flex-col gap-3 pb-6">
					<SaveStyleChip announce={false} />
					<MyStyles />
				</div>
			) : (
				<ExplainerFlow />
			)}
		</PanelView>
	);
}
