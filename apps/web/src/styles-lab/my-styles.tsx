"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { exportLibrary, listStyles, resolveCaptionSizeFlag, type SavedStyle } from "@restorffcut/styles";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";
import { applySavedStyle } from "./apply-saved";
import { downloadText } from "./storage";
import { useStylesLabStore } from "./store";
import { describeStep, Label, Pill, shortDate } from "./ui";

/** Apply a saved style with progress toasts; returns false when nothing could run. */
export function useApplySaved(): { apply: (style: SavedStyle) => Promise<void>; busy: string | null } {
	const editor = useEditor();
	const [busy, setBusy] = useState<string | null>(null);
	const apply = useCallback(
		async (style: SavedStyle) => {
			if (busy) return;
			if (!editor.project.getActiveOrNull()) {
				toast.error("Open a project first");
				return;
			}
			setBusy(style.id);
			const toastId = toast.loading(`Applying ${style.title}…`);
			try {
				const report = await applySavedStyle({ editor, style, onStep: (step) => toast.loading(`${style.title}: ${step}`, { id: toastId }) });
				const lines = [
					report.applied ? `${report.applied} edits` : null,
					report.compositions.length ? `added ${report.compositions.join(", ")}` : null,
					...report.pending,
					...report.notes.slice(0, 2),
					report.unresolved.length ? `not done here (ask your Claude): ${report.unresolved.map((u) => `“${u}”`).join(", ")}` : null,
					report.skipped.length ? `skipped ${report.skipped.length}: ${report.skipped[0]}` : null,
				].filter(Boolean);
				if (report.committed) toast.success(`${report.title} v${report.version} applied · Ctrl+Z undoes it`, { id: toastId, description: lines.join(" · ") });
				else toast(`${report.title}: nothing to change on this timeline`, { id: toastId, description: lines.join(" · ") || undefined });
			} catch (error) {
				toast.error(`Couldn't apply ${style.title}`, { id: toastId, description: error instanceof Error ? error.message : String(error) });
			} finally {
				setBusy(null);
			}
		},
		[busy, editor],
	);
	return { apply, busy };
}

/** Stable empty list: a zustand v5 selector must not return a new [] per call (render loop). */
const NO_VERSIONS: SavedStyle[] = [];

function StyleRow({ style, onApply, busy }: { style: SavedStyle; onApply: () => void; busy: boolean }) {
	const versions = useStylesLabStore((s) => s.library.versions[style.id] ?? NO_VERSIONS);
	const remove = useStylesLabStore((s) => s.remove);
	const restore = useStylesLabStore((s) => s.restore);
	const openSheet = useStylesLabStore((s) => s.openSheet);
	const [open, setOpen] = useState(false);
	const [confirm, setConfirm] = useState(false);

	const save = useStylesLabStore((s) => s.save);
	const sizeFlag = style.flags?.find((flag) => flag.code === "absolute_caption_size");

	return (
		<li className="bg-surface border-outline flex flex-col gap-2 rounded-[14px] border px-3 py-2.5">
			<div className="flex items-start gap-2">
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
					title={`${style.title} — ${style.instructions}`}
					className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left"
				>
					{/* ui-fix-panels (QA #21): the whole name, on two lines if it needs them, instead of "Halcyon ho…" */}
					<span className="text-bone line-clamp-2 text-[0.88rem] font-medium break-words">{style.title}</span>
					<span className="rc-mono text-fog text-[0.66rem]">
						v{style.version} · {style.triggers.length} trigger{style.triggers.length === 1 ? "" : "s"} · {shortDate(style.updated_at)}
						{versions.length ? ` · ${versions.length} older` : ""}
					</span>
				</button>
				<Pill onClick={onApply} disabled={busy}>
					{busy ? "Applying…" : "Apply"}
				</Pill>
			</div>
			<p className="text-mist line-clamp-2 text-[0.74rem] break-words" title={style.triggers.join(" · ")}>
				“{style.triggers[0]}”
			</p>
			{sizeFlag && (
				// ui-fix-panels (QA #8): a style saved with a fixed caption size is flagged, not guessed
				<div className="border-stale/40 flex flex-col gap-1.5 rounded-[10px] border px-2.5 py-2">
					<span className="text-stale text-[0.72rem] leading-snug">{sizeFlag.message}</span>
					{sizeFlag.suggested_scale ? (
						<Pill
							className="self-start"
							onClick={() => {
								const fixed = resolveCaptionSizeFlag(style, sizeFlag.suggested_scale);
								const saved = save({ style: fixed, note: `caption size as ×${sizeFlag.suggested_scale} (was a fixed ${sizeFlag.size})` });
								toast.success(`“${saved.title}” now makes captions ×${sizeFlag.suggested_scale} · v${saved.version}`);
							}}
						>
							Use ×{sizeFlag.suggested_scale}
						</Pill>
					) : null}
				</div>
			)}
			{open && (
				<div className="flex flex-col gap-2 border-t border-hairline pt-2">
					<ul className="flex flex-col gap-0.5">
						{style.steps.map((step, index) => (
							<li key={`${step.kind}-${index}`} className="text-fog text-[0.72rem] leading-snug">
								· {describeStep(step)}
							</li>
						))}
					</ul>
					{style.triggers.length > 1 && <p className="text-fog text-[0.7rem]">Also: {style.triggers.slice(1).map((t) => `“${t}”`).join(" · ")}</p>}
					{versions.length > 0 && (
						<div className="flex flex-col gap-1">
							<Label tone="fog">Older versions</Label>
							{[...versions].reverse().map((old) => (
								<div key={old.version} className="flex items-center gap-2">
									<span className="rc-mono text-mist text-[0.68rem]">v{old.version}</span>
									<span className="text-fog min-w-0 flex-1 truncate text-[0.68rem]">{old.note ?? shortDate(old.updated_at)}</span>
									<button
										type="button"
										className="text-fog hover:text-bone cursor-pointer text-[0.68rem]"
										onClick={() => {
											restore({ id: style.id, version: old.version });
											toast.success(`Restored v${old.version} as a new version`);
										}}
									>
										Restore
									</button>
								</div>
							))}
						</div>
					)}
					<div className="flex items-center gap-2">
						<Pill onClick={() => openSheet({ draft: style, editing: true })}>Edit…</Pill>
						{confirm ? (
							<>
								<Pill
									tone="danger"
									onClick={() => {
										remove(style.id);
										toast(`Deleted “${style.title}” and its versions`);
									}}
								>
									Delete for good
								</Pill>
								<Pill onClick={() => setConfirm(false)}>Keep</Pill>
							</>
						) : (
							<button type="button" onClick={() => setConfirm(true)} className="text-fog hover:text-bone ml-auto cursor-pointer text-[0.72rem]">
								Delete
							</button>
						)}
					</div>
				</div>
			)}
		</li>
	);
}

/** "My styles": saved styles (versions, apply, edit, delete) + Export / Import JSON. */
export function MyStyles({ limit }: { limit?: number }) {
	const library = useStylesLabStore((s) => s.library);
	const importJson = useStylesLabStore((s) => s.importJson);
	const historyCount = useStylesLabStore((s) => s.history.length);
	const clearHistory = useStylesLabStore((s) => s.clearHistory);
	const { apply, busy } = useApplySaved();
	const fileRef = useRef<HTMLInputElement>(null);
	const styles = listStyles(library);
	const shown = limit ? styles.slice(0, limit) : styles;

	const onImport = async (file: File | undefined) => {
		if (!file) return;
		try {
			const result = importJson(await file.text());
			const parts = [
				result.added.length ? `${result.added.length} added` : null,
				result.updated.length ? `${result.updated.length} new version${result.updated.length === 1 ? "" : "s"}` : null,
				result.unchanged.length ? `${result.unchanged.length} unchanged` : null,
			].filter(Boolean);
			if (result.problems.length) toast.error("Some styles were not imported", { description: result.problems.slice(0, 3).join(" · ") });
			else toast.success(`Imported: ${parts.join(", ") || "nothing new"}`);
		} catch (error) {
			toast.error("Couldn't read that file", { description: error instanceof Error ? error.message : String(error) });
		}
	};

	return (
		<div className="flex flex-col gap-3">
			{shown.length === 0 ? (
				<p className="text-fog text-[0.75rem] leading-snug">
					No saved styles yet. Tell Claude the same thing a few times (“bigger captions”, “tighter cut”) and it offers to save it as a style.
				</p>
			) : (
				<ul className="flex flex-col gap-2">
					{shown.map((style) => (
						<StyleRow key={style.id} style={style} busy={busy === style.id} onApply={() => void apply(style)} />
					))}
				</ul>
			)}
			{!limit && (
				<div className={cn("flex flex-wrap items-center gap-2", shown.length && "border-t border-hairline pt-3")}>
					<Pill
						disabled={!styles.length}
						onClick={() => downloadText({ text: exportLibrary(library), filename: `restorffcut-styles-${new Date().toISOString().slice(0, 10)}.json` })}
					>
						Export JSON
					</Pill>
					<Pill onClick={() => fileRef.current?.click()}>Import JSON</Pill>
					<input
						ref={fileRef}
						type="file"
						accept="application/json,.json"
						className="hidden"
						onChange={(event) => {
							void onImport(event.target.files?.[0]);
							event.target.value = "";
						}}
					/>
					{/* ui-fix-panels (QA #22): "11 said forget" read as a typo; say what the number is and what Forget does */}
					<span
						className="rc-mono text-fog basis-full text-[0.62rem] leading-relaxed"
						title="Every sentence you type in Tell Claude is remembered (in this browser) so RestorffCut can notice a repeat and offer to save it as a style. Forgetting clears that list; saved styles stay."
					>
						{historyCount === 1 ? "1 ask remembered" : `${historyCount} asks remembered`} to spot repeats
						{historyCount ? (
							<>
								{" · "}
								<button type="button" onClick={clearHistory} className="hover:text-bone cursor-pointer underline underline-offset-2">
									Forget them
								</button>
							</>
						) : null}
					</span>
				</div>
			)}
		</div>
	);
}
