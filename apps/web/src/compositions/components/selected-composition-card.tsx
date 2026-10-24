"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { nudgeComposition } from "../api";
import { repairCustomRender } from "../custom-drop";
import { rerenderComposition } from "../drop";
import { type CompositionEntry, isCustomSource } from "../types";
import type { SelectedComposition } from "../use-selected-composition";
import { CodeDialog } from "./code-dialog";
import { ComposeDialog, describeChanges } from "./compose-dialog";

/**
 * Shown on top of the Effects panel when the selected clip is a rendered composition: change it by sentence
 * ("slower", "bigger", "make it red") and it re-renders in place; or open its params. A custom composition
 * (motion-code agent) opens its code instead ("Edit code"), carries a Kiln dot when Claude wrote it, and offers
 * "Re-render from code" when its video is missing on this machine.
 */
export function SelectedCompositionCard({
	selected,
	entry,
}: {
	selected: SelectedComposition;
	entry: CompositionEntry | undefined;
}) {
	const editor = useEditor();
	const [sentence, setSentence] = useState("");
	const [busy, setBusy] = useState(false);
	const [last, setLast] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const custom = isCustomSource(selected.source) ? selected.source : null;
	const title = custom ? (custom.title ?? "Custom composition") : (entry?.title ?? selected.source.name);
	const mediaId = (selected.element as { mediaId?: string }).mediaId;
	const missing = useEditor(
		(e) => !!custom && !!mediaId && !e.media.isLoadingMedia() && !e.media.getAssets().some((asset) => asset.id === mediaId),
	);

	const run = async () => {
		const said = sentence.trim();
		if (!said || busy) return;
		setBusy(true);
		try {
			const answer = await nudgeComposition({
				name: selected.source.name,
				props: selected.source.props,
				sentence: said,
				source: custom?.source,
			});
			if (!answer.changes.length) {
				setLast(`nothing to change${answer.skipped.length ? `: ${answer.skipped.join("; ")}` : ""}`);
				return;
			}
			const result = await rerenderComposition({ editor, ref: selected.ref, props: answer.props });
			const summary = describeChanges(answer.changes);
			setLast(summary);
			setSentence("");
			toast.success(result ? `${title} re-rendered` : "Same render: nothing changed", { description: summary });
		} catch (error) {
			setLast(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	const repair = async () => {
		setBusy(true);
		try {
			await repairCustomRender({ editor, ref: selected.ref });
			toast.success(`${title} re-rendered from its code`);
		} catch (error) {
			setLast(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="bg-surface border-line mb-4 flex flex-col gap-2.5 rounded-[14px] border p-3">
			<div className="flex flex-col gap-1">
				<div className="flex items-center justify-between gap-2">
					<span className="rc-label flex items-center gap-1.5">
						{custom?.author === "claude" && <span aria-hidden title="written by Claude" className="bg-kiln size-1.5 shrink-0 rounded-full" />}
						Selected
					</span>
					<span className="rc-mono shrink-0 text-[0.62rem] text-fog">
						{custom ? "code · " : ""}
						{selected.source.hash.slice(0, 6)}
					</span>
				</div>
				<span className="truncate text-[0.82rem] font-medium text-bone" title={title}>
					{title}
					{custom?.author === "claude" && <span className="text-kiln rc-mono ml-1.5 text-[0.62rem]">by Claude</span>}
				</span>
			</div>
			{missing && (
				<div className="flex items-center justify-between gap-2 rounded-[10px] border border-[#E8A33D]/60 px-2.5 py-2">
					<span className="rc-mono text-[0.66rem] text-[#E8A33D]">render missing on this machine</span>
					<button type="button" className="rc-pill h-7 shrink-0 px-2.5 text-[0.72rem]" disabled={busy} onClick={() => void repair()}>
						{busy ? "Rendering…" : "Re-render from code"}
					</button>
				</div>
			)}
			<input
				aria-label="Change it by sentence"
				className="bg-background border-line w-full rounded-[10px] border px-2.5 py-2 text-sm text-bone outline-none placeholder:text-[#5c5c64] focus:border-[#5a5a63]"
				placeholder={busy ? "re-rendering…" : "say it: slower, bigger, red"}
				value={sentence}
				disabled={busy}
				onChange={(event) => setSentence(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") void run();
				}}
			/>
			{last && <p className="rc-mono text-fog text-[0.66rem] leading-snug">{last}</p>}
			<div className="flex gap-2">
				<button
					type="button"
					className="rc-pill h-8 flex-1 px-2 text-[0.78rem]"
					disabled={busy || !sentence.trim()}
					onClick={() => void run()}
				>
					{busy ? "Rendering…" : "Change"}
				</button>
				<button
					type="button"
					className="rc-pill h-8 flex-1 px-2 text-[0.78rem]"
					disabled={busy || (!custom && !entry)}
					onClick={() => setOpen(true)}
				>
					{custom ? "Edit code" : "Params"}
				</button>
			</div>
			{custom && <CodeDialog open={open} onOpenChange={setOpen} selected={selected} />}
			{!custom && entry && (
				<ComposeDialog open={open} onOpenChange={setOpen} entry={entry} selected={selected} />
			)}
		</section>
	);
}
