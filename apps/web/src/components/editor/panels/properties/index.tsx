"use client";

import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditor } from "@/editor/use-editor";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { usePropertiesStore } from "./stores/properties-store";
import { getPropertiesConfig } from "./registry";
import { cn } from "@/utils/ui";
import { EmptyView } from "./empty-view";
import { SelectedSummary, selectedLabel } from "./selected-summary";
import { EditingStylePicker } from "@/editing-style/editing-style-picker";
import { SavedStylesSection } from "@/styles-lab/picker-section"; // styles agent: EDT-20 under EDITING STYLE
import { SaveStyleSheet } from "@/styles-lab/save-style-sheet"; // ui-fix-panels (QA #19)

/**
 * The right-hand inspector, styled like design/edit-artboard.png:
 * "SELECTED · <clip> · <track>" with label/value rows (mono values), then
 * EDITING STYLE, then the full property tabs for the selected clip.
 */
export function PropertiesPanel() {
	const editor = useEditor();
	useEditor((e) => e.scenes.getActiveSceneOrNull());
	useEditor((e) => e.media.getAssets());
	const { selectedElements } = useElementSelection();
	const { activeTabPerType, setActiveTab } = usePropertiesStore();

	const elementWithTrack =
		selectedElements.length === 1
			? editor.timeline.getElementsWithTracks({ elements: selectedElements })[0]
			: undefined;

	// ui-fix-timeline (QA 2026-10-20 #2): a selection that matches no element (a lane/element pair that is gone)
	// shows the empty inspector instead of a blank panel that stayed blank until reload.
	if (!elementWithTrack) {
		return (
			<div className="panel bg-background flex h-full flex-col overflow-hidden">
				<ScrollArea className="flex-1 scrollbar-hidden">
					<EmptyView count={selectedElements.length === 1 ? 0 : selectedElements.length} />
					<PlacedEditingStyle />
				</ScrollArea>
			</div>
		);
	}

	const mediaAssets = editor.media.getAssets();

	const { element, track } = elementWithTrack;
	const config = getPropertiesConfig({ element, mediaAssets });
	const visibleTabs = config.tabs;

	const storedTabId = activeTabPerType[element.type];
	const isStoredTabVisible = visibleTabs.some((t) => t.id === storedTabId);
	const activeTabId = isStoredTabVisible ? storedTabId : config.defaultTab;
	const activeTab =
		visibleTabs.find((t) => t.id === activeTabId) ?? visibleTabs[0];

	if (!activeTab) return null;

	return (
		<div className="panel bg-background flex h-full flex-col overflow-hidden">
			{/* keyed by clip so a new selection starts at the top of the inspector */}
			<ScrollArea key={element.id} className="flex-1 scrollbar-hidden">
				{/* Artboard inspector: padding 18, gap 14 between label and rows. */}
				<section className="flex flex-col gap-3.5 px-[18px] pt-[18px]">
					<h2 className="rc-label break-words">
						{selectedLabel({ element, track })}
					</h2>
					<SelectedSummary element={element} track={track} />
				</section>

				{/* ui-fix-panels (QA #19): with a clip selected its own controls (transform first) come right after the rows;
				    the project-wide EDITING STYLE moves below them, folded to one line */}
				<div className="mt-3.5 border-t">
					<TooltipProvider delayDuration={0}>
						<div className="flex items-center gap-1 px-4 pt-3 pb-1">
							{visibleTabs.map((tab) => (
								<Tooltip key={tab.id}>
									<TooltipTrigger asChild>
										<Button
											variant={tab.id === activeTab.id ? "secondary" : "ghost"}
											size="icon"
											onClick={() =>
												setActiveTab({
													elementType: element.type,
													tabId: tab.id,
												})
											}
											aria-label={tab.label}
											className={cn(
												"h-8 w-8 shrink-0 rounded-[10px]",
												tab.id !== activeTab.id && "text-muted-foreground",
											)}
										>
											{tab.icon}
										</Button>
									</TooltipTrigger>
									<TooltipContent side="bottom">{tab.label}</TooltipContent>
								</Tooltip>
							))}
							<span className="rc-label ml-auto truncate pl-2 text-[0.625rem]">
								{activeTab.label}
							</span>
						</div>
					</TooltipProvider>
					{activeTab.content({ trackId: track.id })}
				</div>
				<FoldedEditingStyle />
			</ScrollArea>
		</div>
	);
}

/**
 * EDITING STYLE where the artboard has it: right under the rows, 6 px extra
 * space, 18 px side padding. The picker itself (behaviour, list) is the compose
 * agent's (`editing-style/**`); only its placement is set here.
 */
function FoldedEditingStyle() {
	const [open, setOpen] = useState(false);
	return (
		<div className="border-t">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className="rc-label hover:text-bone flex w-full cursor-pointer items-center justify-between px-[18px] py-3 text-left"
			>
				<span>Editing style · my styles</span>
				<span aria-hidden className={cn("transition-transform", open && "rotate-180")}>
					⌄
				</span>
			</button>
			{/* folded, the save sheet still has to be mounted once (SavedStylesSection mounts it when open) */}
			{open ? <PlacedEditingStyle /> : <SaveStyleSheet />}
		</div>
	);
}

function PlacedEditingStyle() {
	return (
		<div className="mt-1.5 [&>section]:gap-3.5 [&>section]:px-[18px] [&>section]:pt-[14px] [&>section]:pb-5">
			<EditingStylePicker />
			<SavedStylesSection />
		</div>
	);
}
