"use client";

import { listStyles } from "@restorffcut/styles";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { useApplySaved } from "./my-styles";
import { SaveStyleChip } from "./save-style-chip";
import { SaveStyleSheet } from "./save-style-sheet";
import { useStylesLabStore } from "./store";
import { Pill, useRepeatSuggestions } from "./ui";

/**
 * Under the EDITING STYLE picker (inspector): the "Save as style?" chip when Claude noticed a repeat, and the saved
 * styles with Apply (EDT-20: "saved styles appear in the EDITING STYLE picker"). Also mounts the save sheet (once).
 * Mounted with one line in components/editor/panels/properties/index.tsx (PlacedEditingStyle).
 */
export function SavedStylesSection() {
	const library = useStylesLabStore((s) => s.library);
	const suggestions = useRepeatSuggestions();
	const { apply, busy } = useApplySaved();
	const setActiveTab = useAssetsPanelStore((s) => s.setActiveTab);
	const styles = listStyles(library);
	const shown = styles.slice(0, 4);

	if (!styles.length && !suggestions.length) return <SaveStyleSheet />;
	return (
		<section className="flex flex-col gap-2.5 !pt-0">
			<SaveStyleChip />
			{shown.length > 0 && (
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center justify-between">
						<h2 className="rc-label">My styles</h2>
						<button type="button" onClick={() => setActiveTab("styles")} className="rc-mono text-fog hover:text-bone cursor-pointer text-[0.62rem]">
							{styles.length > shown.length ? `all ${styles.length} →` : "manage →"}
						</button>
					</div>
					<ul className="flex flex-col gap-1">
						{shown.map((style) => (
							<li key={style.id} className="flex items-center gap-2">
								{/* ui-fix-panels (QA #21): the full name on hover, two lines before it cuts ("Bigger capti…") */}
								<span
									className="text-bone line-clamp-2 min-w-0 flex-1 text-[0.82rem] leading-snug break-words"
									title={`${style.title} — say “${style.triggers.join("” · “")}”`}
								>
									{style.title}
									{style.flags?.length ? (
										<span className="text-stale ml-1.5 text-[0.7rem]" title={style.flags.map((flag) => flag.message).join(" ")}>
											· check size
										</span>
									) : null}
								</span>
								<span className="rc-mono text-fog text-[0.62rem]">v{style.version}</span>
								<Pill onClick={() => void apply(style)} disabled={Boolean(busy)} className="h-6 px-2.5 text-[11px]">
									{busy === style.id ? "…" : "Apply"}
								</Pill>
							</li>
						))}
					</ul>
				</div>
			)}
			<SaveStyleSheet />
		</section>
	);
}
