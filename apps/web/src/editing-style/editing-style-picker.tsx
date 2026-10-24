"use client";

import { useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";
import { applyEditingStyle } from "./apply";
import { EDITING_STYLES, getEditingStyle, useEditingStyleStore } from "./store";

/**
 * EDITING STYLE section of the inspector. Picking a style applies it to the open project (one undo step): see
 * ./apply.ts and packages/timeline-ops/src/styles.ts.
 */
export function EditingStylePicker() {
	const editor = useEditor();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const projectId = useEditor((e) => e.project.getActiveOrNull()?.metadata.id);
	const styleId = useEditingStyleStore((s) => (projectId ? s.styleByProject[projectId] : undefined));
	const report = useEditingStyleStore((s) => (projectId ? s.reportByProject[projectId] : undefined));
	const setStyle = useEditingStyleStore((s) => s.setStyle);
	const setReport = useEditingStyleStore((s) => s.setReport);
	const current = getEditingStyle({ id: styleId });

	const pick = async (id: string) => {
		setOpen(false);
		if (!projectId || busy) return;
		const label = getEditingStyle({ id }).label;
		const toastId = toast.loading(`Applying ${label}…`);
		setBusy("starting…");
		try {
			const result = await applyEditingStyle({
				editor,
				styleId: id,
				onStep: (step) => {
					setBusy(step);
					toast.loading(`Applying ${label}: ${step}`, { id: toastId });
				},
			});
			setStyle({ projectId, styleId: id });
			setReport({ projectId, report: result });
			toast.success(`${label} applied`, {
				id: toastId,
				description: [
					`${result.applied} edits`,
					result.compositions.length ? `added ${result.compositions.join(", ")}` : null,
					...result.pending,
				]
					.filter(Boolean)
					.join(" · "),
			});
		} catch (error) {
			toast.error(`Couldn't apply ${label}`, {
				id: toastId,
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(null);
		}
	};

	return (
		<section className="flex flex-col gap-3 px-5 pt-5 pb-6">
			<div className="flex items-center justify-between">
				<h2 className="rc-label">Editing style</h2>
				<span className="rc-mono text-[0.65rem] text-[#5c5c64]" title="Picking a style edits the cut (undo: Ctrl+Z)">
					{busy ? "applying" : report ? "applied" : "pick to apply"}
				</span>
			</div>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						disabled={!projectId || !!busy}
						className="bg-surface flex w-full cursor-pointer items-center justify-between gap-3 rounded-[14px] border px-3.5 py-3 text-left text-[0.95rem] font-medium text-bone transition-colors hover:border-[#4a4a52] disabled:cursor-default disabled:opacity-60"
					>
						<span className="truncate">{busy ? `${current.label} · ${busy}` : current.label}</span>
						<HugeiconsIcon
							icon={ArrowDown01Icon}
							className={cn("text-fog size-4 shrink-0 transition-transform", open && "rotate-180")}
						/>
					</button>
				</PopoverTrigger>
				<PopoverContent
					align="end"
					className="bg-card w-[var(--radix-popover-trigger-width)] min-w-64 rounded-[14px] p-1.5"
				>
					<ul className="flex flex-col">
						{EDITING_STYLES.map((style) => {
							const isActive = style.id === current.id && !!report;
							return (
								<li key={style.id}>
									<button
										type="button"
										onClick={() => void pick(style.id)}
										className={cn(
											"flex w-full cursor-pointer items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left hover:bg-accent",
											isActive && "bg-accent",
										)}
									>
										<span className="mt-0.5 size-4 shrink-0">
											{isActive && <HugeiconsIcon icon={Tick02Icon} className="size-4" />}
										</span>
										<span className="flex min-w-0 flex-col gap-0.5">
											<span className="text-sm font-medium text-bone">{style.label}</span>
											<span className="text-fog text-xs">{style.hint}</span>
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</PopoverContent>
			</Popover>
			{report && report.styleId === current.id && (
				<div className="flex flex-col gap-1">
					<p className="rc-mono text-fog text-[0.68rem] leading-relaxed">
						{report.applied} edits
						{report.compositions.length ? ` · ${report.compositions.join(", ")}` : ""}
					</p>
					{[...report.pending, ...report.notes].map((line) => (
						<p key={line} className="text-[0.7rem] leading-snug text-[#5c5c64]">
							{line}
						</p>
					))}
				</div>
			)}
		</section>
	);
}
