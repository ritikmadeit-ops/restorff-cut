"use client";

/**
 * THE one timeline-toolbar button the cutout agent adds (mounted in timeline/components/timeline-toolbar.tsx):
 * shows the active delivery size; opens SIZE · PERSON · BEHIND THE PERSON.
 *
 * It also keeps the canvas size in step with the active scene when a reframe scene is entered through the generic
 * scene picker (the project has one canvas size; each reframe scene has its own).
 */
import { useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { UserSquareIcon } from "@hugeicons/core-free-icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";
import { canvasForScene } from "@/reframe/build";
import { activeSizeOf } from "@/reframe/state";
import { useCutoutJobs } from "../store";
import { PersonToolsPopover } from "./person-tools-popover";

export function PersonToolsButton() {
	const editor = useEditor();
	const sceneId = useEditor((current) => current.project.getActiveOrNull()?.currentSceneId ?? null);
	const size = useEditor((current) => {
		const project = current.project.getActiveOrNull();
		return project ? activeSizeOf(project) : "9:16";
	});
	const running = useCutoutJobs((state) => state.jobs.some((job) => job.status === "running"));

	useEffect(() => {
		if (!sceneId) return;
		const canvas = canvasForScene({ sceneId });
		const project = editor.project.getActiveOrNull();
		if (!canvas || !project) return;
		const current = project.settings.canvasSize;
		if (current.width !== canvas.width || current.height !== canvas.height) {
			void editor.project.updateSettings({ settings: { canvasSize: canvas }, pushHistory: false });
		}
	}, [editor, sceneId]);

	return (
		<Popover>
			<Tooltip delayDuration={200}>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							type="button"
							className={cn(
								"rc-mono inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 text-[11px] text-bone transition-colors hover:bg-raised",
								running ? "border-neon" : "border-outline",
							)}
							aria-label="Person cutout and delivery size"
						>
							<HugeiconsIcon icon={UserSquareIcon} className="size-3.5" />
							{size}
						</button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent>Cut out person · effects behind the person · size {size}</TooltipContent>
			</Tooltip>
			<PopoverContent side="top" align="start" sideOffset={8} className="max-h-[70vh] w-80 overflow-y-auto">
				<PersonToolsPopover />
			</PopoverContent>
		</Popover>
	);
}
