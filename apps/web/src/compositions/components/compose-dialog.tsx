"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";
import { CompositionApiError, nudgeComposition, renderComposition, sampleUrl } from "../api";
import { dropComposition, projectCanvas, rerenderComposition } from "../drop";
import type { CompositionEntry, NudgeChange, ParamValues } from "../types";
import type { SelectedComposition } from "../use-selected-composition";
import { missingHint, ParamField } from "./param-field";

export const CHECKER =
	"repeating-conic-gradient(#1d1d22 0% 25%, #141418 0% 50%) 50% / 18px 18px";

export function describeChanges(changes: NudgeChange[]): string {
	return changes
		.map((change) => `${change.key} ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`)
		.join(" · ");
}

/**
 * Fill a composition's params and drop it at the playhead — or, with `selected`, edit the selected composition clip
 * and re-render it in place. A sentence ("slower, bigger, make it red") nudges the form through the package's rules.
 */
export function ComposeDialog({
	open,
	onOpenChange,
	entry,
	selected,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	entry: CompositionEntry;
	selected?: SelectedComposition | null;
}) {
	const editor = useEditor();
	const initial = useMemo<ParamValues>(
		() => ({ ...(selected ? selected.source.props : entry.example) }),
		[entry, selected],
	);
	const [props, setProps] = useState<ParamValues>(initial);
	const [sentence, setSentence] = useState("");
	const [lastChanges, setLastChanges] = useState<string | null>(null);
	const [busy, setBusy] = useState<null | "nudge" | "preview" | "drop">(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setProps(initial);
		setSentence("");
		setLastChanges(null);
		setServerNeeds({});
		setTouched(new Set());
		setPreviewUrl(selected ? `/api/compositions/file/${selected.source.hash}` : null);
	}, [open, initial, selected]);

	const valueOf = (key: string) => (key in props ? props[key] : entry.params[key]?.default);

	// ui-fix-panels (QA #9): what a render needs, as a form — required fields first, a hint per empty one, Preview and
	// Drop disabled until they are filled, and a server `needs` answer shown on the fields instead of a raw 422 toast
	const [serverNeeds, setServerNeeds] = useState<Record<string, string>>({});
	const [touched, setTouched] = useState<Set<string>>(new Set());
	const requiredKeys = useMemo(
		() => Object.keys(entry.params).filter((key) => entry.params[key]?.required || entry.required?.includes(key)),
		[entry],
	);
	const missing: Record<string, string> = {};
	for (const key of requiredKeys) {
		const spec = entry.params[key];
		const hint = spec ? missingHint(spec, valueOf(key), key) : null;
		if (hint) missing[key] = hint;
	}
	const missingCount = Object.keys(missing).length;
	const orderedKeys = [...requiredKeys, ...Object.keys(entry.params).filter((key) => !requiredKeys.includes(key))];
	const fieldError = (key: string) => serverNeeds[key] ?? (touched.has(key) ? missing[key] : undefined);
	const takeNeeds = (error: unknown): boolean => {
		const needs = error instanceof CompositionApiError ? error.report?.needs : undefined;
		if (!needs?.length) return false;
		const next: Record<string, string> = {};
		for (const key of needs) {
			const spec = entry.params[key];
			next[key] = (spec && missingHint(spec, valueOf(key), key)) ?? `${spec?.label ?? key} is needed`;
		}
		setServerNeeds(next);
		return true;
	};

	const runNudge = async () => {
		if (!sentence.trim()) return;
		setBusy("nudge");
		try {
			const answer = await nudgeComposition({ name: entry.name, props, sentence });
			setProps(answer.props);
			setLastChanges(
				answer.changes.length
					? describeChanges(answer.changes)
					: `nothing changed${answer.skipped.length ? `: ${answer.skipped.join("; ")}` : ""}`,
			);
			setSentence("");
		} catch (error) {
			setLastChanges(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(null);
		}
	};

	const runPreview = async () => {
		if (missingCount) {
			setTouched(new Set(requiredKeys));
			return;
		}
		setBusy("preview");
		try {
			const answer = await renderComposition({ name: entry.name, props, ...projectCanvas({ editor }) });
			setPreviewUrl(answer.url);
		} catch (error) {
			if (!takeNeeds(error))
				toast.error(`Couldn't render ${entry.title}`, {
					description: error instanceof Error ? error.message : String(error),
				});
		} finally {
			setBusy(null);
		}
	};

	const runDrop = async () => {
		if (missingCount) {
			setTouched(new Set(requiredKeys));
			return;
		}
		setBusy("drop");
		try {
			if (selected) {
				const result = await rerenderComposition({ editor, ref: selected.ref, props });
				toast.success(result ? `${entry.title} re-rendered in place` : "Same render: nothing changed");
			} else {
				const result = await dropComposition({ editor, entry, props });
				// person effects land in layers around the clip's cutout (effects-layers agent, drop-layered.ts)
				toast.success(result.layers ? `${entry.title} placed around the person cutout` : `${entry.title} dropped on MOTION`, {
					description: result.layers
						? result.layers.join(" · ")
						: (result.note ?? `${result.answer.duration} s · ${result.answer.cached ? "from cache" : `rendered in ${(result.answer.ms / 1000).toFixed(1)} s`}`),
				});
			}
			onOpenChange(false);
		} catch (error) {
			if (!takeNeeds(error))
				toast.error(`Couldn't place ${entry.title}`, {
					description: error instanceof Error ? error.message : String(error),
				});
		} finally {
			setBusy(null);
		}
	};

	const video = previewUrl ?? (entry.hasSample ? sampleUrl({ name: entry.name }) : null);
	const canvas = open ? projectCanvas({ editor }) : null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[880px] gap-0 overflow-hidden p-0">
				<div className="grid max-h-[86vh] grid-cols-[minmax(0,300px)_1fr]">
					<div className="border-line flex flex-col gap-3 border-r p-5">
						<div
							className="relative aspect-[9/16] w-full overflow-hidden rounded-[14px] border border-line"
							style={{ background: CHECKER }}
						>
							{video ? (
								<video
									key={video}
									src={video}
									className="absolute inset-0 size-full object-contain"
									autoPlay
									loop
									muted
									playsInline
								/>
							) : (
								<div className="text-fog absolute inset-0 grid place-items-center px-6 text-center text-xs leading-relaxed">
									{missingCount
										? "No sample for this one yet. Fill in what goes on screen, then Preview render."
										: "No sample yet: Preview render draws yours."}
								</div>
							)}
							<span className="rc-mono absolute top-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[0.62rem] text-bone">
								{previewUrl ? "your render" : "sample"}
							</span>
						</div>
						<p className="rc-mono text-fog text-[0.7rem] leading-relaxed">
							{entry.duration} s · renders at{" "}
							{canvas ? `${canvas.width}×${canvas.height} · ${canvas.fps} fps` : "the canvas size"} · WebM
							with alpha · cached by params
						</p>
					</div>
					<div className="flex min-h-0 flex-col">
						<div className="border-line flex flex-col gap-1.5 border-b px-6 pt-5 pb-4 pr-14">
							<span className="rc-label">{selected ? "Edit composition" : "Motion graphic"}</span>
							<DialogTitle className="rc-display text-xl leading-tight">{entry.title}</DialogTitle>
							<DialogDescription className="text-fog text-[0.82rem] leading-snug">
								{entry.description}
							</DialogDescription>
						</div>
						<div className="border-line flex flex-col gap-2 border-b px-6 py-4">
							<label htmlFor="rc-compose-sentence" className="rc-label">
								Say a change
							</label>
							<div className="flex gap-2">
								<input
									id="rc-compose-sentence"
									className="bg-background border-line w-full rounded-[10px] border px-3 py-2 text-sm text-bone outline-none placeholder:text-[#5c5c64] focus:border-[#5a5a63]"
									placeholder="slower, bigger, make it red"
									value={sentence}
									onChange={(event) => setSentence(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") void runNudge();
									}}
								/>
								<button
									type="button"
									className="rc-pill h-auto shrink-0 px-3 text-sm"
									disabled={busy !== null || !sentence.trim()}
									onClick={() => void runNudge()}
								>
									{busy === "nudge" ? "…" : "Apply"}
								</button>
							</div>
							{lastChanges && <p className="rc-mono text-fog text-[0.7rem]">{lastChanges}</p>}
						</div>
						<div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
							{requiredKeys.length > 0 && (
								<p className="rc-label -mb-1">
									What goes on screen{missingCount ? ` · ${missingCount} to fill` : " · ready"}
								</p>
							)}
							{orderedKeys.map((key, index) => {
								const spec = entry.params[key];
								if (!spec) return null;
								return (
									<div key={key} className={cn(index === requiredKeys.length && index > 0 && "border-line border-t pt-4")}>
										{index === requiredKeys.length && index > 0 && <p className="rc-label mb-3">Look and timing</p>}
										<ParamField
											name={key}
											spec={spec}
											value={valueOf(key)}
											required={requiredKeys.includes(key)}
											error={fieldError(key)}
											onChange={(value) => {
												setProps((current) => ({ ...current, [key]: value }));
												setTouched((current) => new Set(current).add(key));
												setServerNeeds(({ [key]: _gone, ...rest }) => rest);
											}}
										/>
									</div>
								);
							})}
						</div>
						<div className="border-line flex items-center justify-end gap-3 border-t px-6 py-4">
							{missingCount > 0 && (
								<p className="text-fog mr-auto text-[0.75rem] leading-snug">
									{Object.values(missing)[0]?.replace(/^./, (c) => c.toUpperCase())}
									{missingCount > 1 ? ` (+${missingCount - 1} more)` : ""} to preview.
								</p>
							)}
							<button
								type="button"
								className="rc-pill text-sm disabled:cursor-default disabled:opacity-40"
								disabled={busy !== null || missingCount > 0}
								title={missingCount ? "Fill the needed fields first" : undefined}
								onClick={() => void runPreview()}
							>
								{busy === "preview" ? "Rendering…" : "Preview render"}
							</button>
							<button
								type="button"
								className={cn(
									"inline-flex h-10 cursor-pointer items-center rounded-[14px] bg-neon px-5 text-sm font-semibold text-[#0c0c0e] disabled:cursor-default disabled:opacity-60",
								)}
								disabled={busy !== null || missingCount > 0}
								onClick={() => void runDrop()}
							>
								{busy === "drop"
									? "Rendering…"
									: selected
										? "Re-render in place"
										: "Drop at playhead"}
							</button>
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
