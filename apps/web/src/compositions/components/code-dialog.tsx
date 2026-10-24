"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";
import {
	BLANK_CUSTOM_SOURCE,
	type CustomExample,
	type CustomKit,
	CustomRefusedError,
	type CustomValidation,
	fetchCustomExamples,
	fetchCustomKit,
	validateCustomSource,
} from "../custom-api";
import { dropCustomComposition, rerenderCustomComposition } from "../custom-drop";
import { projectCanvas } from "../drop";
import { type CustomCompositionSource, isCustomSource, type ParamValues } from "../types";
import type { SelectedComposition } from "../use-selected-composition";
import { CodePreview, type PreviewStatus } from "./code-preview";
import { ParamField } from "./param-field";

/**
 * The Code view (motion-code agent, 2026-10-20; EDT-15, reel DeBhOJ6T1Ja "prompt → code → render"): write a
 * composition as HTML/CSS/JS, see it live in a sandboxed preview, set its props, and Render & place it on the MOTION
 * track — or, opened on a selected custom clip ("Edit code"), save and re-render it in place. The code is stored in
 * the clip (restorff.composition.source), so it travels with the commit.
 */
export interface CodeDraft {
	source: string;
	props: ParamValues;
	duration: number;
}

const PREVIEW_W = 300;
const LINE_H = 18;

function useDebounced<T>(value: T, ms: number): T {
	const [v, setV] = useState(value);
	useEffect(() => {
		const id = setTimeout(() => setV(value), ms);
		return () => clearTimeout(id);
	}, [value, ms]);
	return v;
}

function parseProps(text: string): { props: ParamValues | null; error: string | null } {
	if (!text.trim()) return { props: {}, error: null };
	try {
		const value = JSON.parse(text) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return { props: null, error: "props must be a JSON object" };
		return { props: value as ParamValues, error: null };
	} catch (error) {
		return { props: null, error: `props JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Defaults of the params block in the source (`<script type="application/json" id="params">`), read in the browser
 * so the live preview never runs with a param missing (ui-fix-panels, QA #17: growth-chart's props have no `scale`,
 * so the first preview drew `u = NaN` → 44 svg "NaN" console errors per open until the server's defaults arrived).
 */
export function defaultsFromSource(source: string): ParamValues {
	const match = /<script[^>]*id=["']params["'][^>]*>([\s\S]*?)<\/script>/i.exec(source);
	if (!match?.[1]) return {};
	try {
		const block = JSON.parse(match[1]) as { params?: Record<string, { default?: unknown }> };
		const out: ParamValues = {};
		for (const [key, spec] of Object.entries(block.params ?? {})) if (spec && spec.default !== undefined) out[key] = spec.default;
		return out;
	} catch {
		return {};
	}
}

function lineOf(message: string): number | null {
	const m = /^line (\d+):/.exec(message);
	return m ? Number(m[1]) : null;
}

export function CodeDialog({
	open,
	onOpenChange,
	selected,
	initial,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** A selected custom clip: the dialog edits it and "Save & re-render" swaps it in place. */
	selected?: SelectedComposition | null;
	/** A starting draft for a new composition (else the first example, or the blank starter). */
	initial?: CodeDraft | null;
}) {
	const editor = useEditor();
	const editing: CustomCompositionSource | null = selected && isCustomSource(selected.source) ? selected.source : null;
	const [source, setSource] = useState("");
	const [propsText, setPropsText] = useState("{}");
	const [duration, setDuration] = useState(4);
	const [t, setT] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [kit, setKit] = useState<CustomKit | null>(null);
	const [examples, setExamples] = useState<CustomExample[]>([]);
	const [validation, setValidation] = useState<CustomValidation | null>(null);
	const [preview, setPreview] = useState<PreviewStatus>({ state: "loading", errors: [] });
	const [renderErrors, setRenderErrors] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [propsView, setPropsView] = useState<"fields" | "json">("fields");
	const codeRef = useRef<HTMLTextAreaElement>(null);
	const gutterRef = useRef<HTMLDivElement>(null);
	const canvas = open ? projectCanvas({ editor }) : { width: 1080, height: 1920, fps: 30 };
	// QA #16: the preview gets the height left after transport, length, the props switch and ~110 px of fields
	// a callback ref: the dialog content mounts after `open` turns true (portal), so an effect on `open` saw no node
	const [sideNode, sideRef] = useState<HTMLDivElement | null>(null);
	const [sideHeight, setSideHeight] = useState(0);
	useEffect(() => {
		if (!sideNode) return;
		const observer = new ResizeObserver(() => setSideHeight(sideNode.clientHeight));
		observer.observe(sideNode);
		setSideHeight(sideNode.clientHeight);
		return () => observer.disconnect();
	}, [sideNode]);
	const previewWidth = Math.round(
		Math.max(140, Math.min(PREVIEW_W, sideHeight ? ((sideHeight - 270) * canvas.width) / canvas.height : PREVIEW_W)),
	);

	// ui-fix-panels (QA #15): what was loaded, so closing with changes asks first instead of dropping the code
	const [baseline, setBaseline] = useState<{ source: string; propsText: string; duration: number } | null>(null);
	const [confirmClose, setConfirmClose] = useState(false);
	const load = useCallback((draft: CodeDraft) => {
		const text = JSON.stringify(draft.props ?? {}, null, 2);
		setBaseline({ source: draft.source, propsText: text, duration: draft.duration });
		setConfirmClose(false);
		setSource(draft.source);
		setPropsText(text);
		setDuration(draft.duration);
		setT(Math.min(draft.duration * 0.6, draft.duration));
		setRenderErrors([]);
	}, []);

	// open → reset to the clip being edited, the given draft, or the first example
	useEffect(() => {
		if (!open) return;
		setPlaying(false);
		setValidation(null);
		fetchCustomKit().then(setKit).catch((error) => setRenderErrors([`preview runtime: ${error instanceof Error ? error.message : String(error)}`]));
		if (editing) load({ source: editing.source, props: editing.props, duration: editing.duration });
		else if (initial) load(initial);
		else load({ source: BLANK_CUSTOM_SOURCE, props: {}, duration: 3 });
		fetchCustomExamples()
			.then((list) => {
				setExamples(list);
				if (!editing && !initial && list[0]) load({ source: list[0].source, props: list[0].props, duration: list[0].duration });
			})
			.catch(() => setExamples([]));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const parsed = useMemo(() => parseProps(propsText), [propsText]);
	const props = parsed.props;
	const debouncedSource = useDebounced(source, 450);
	const debouncedPropsText = useDebounced(propsText, 450);
	const previewProps = useMemo(() => {
		const p = parseProps(debouncedPropsText).props ?? {};
		// the page gets defaults filled in, as the renderer gives it — from the source itself first (QA #17), then the
		// server's resolved values when they are back
		const validated = validation?.ok || validation?.manifest ? (validation?.values ?? {}) : {};
		return { ...validated, ...defaultsFromSource(debouncedSource), ...p };
	}, [debouncedPropsText, debouncedSource, validation]);

	// validate while typing (server: no browser, ~0.3 s)
	useEffect(() => {
		if (!open || !debouncedSource) return;
		const p = parseProps(debouncedPropsText).props;
		if (!p) return;
		let alive = true;
		validateCustomSource({ source: debouncedSource, props: p })
			.then((v) => alive && setValidation(v))
			.catch((error) =>
				alive && setValidation({ ok: false, errors: [error instanceof Error ? error.message : String(error)], warnings: [], manifest: null, values: {}, protocol: null, bytes: 0 }),
			);
		return () => {
			alive = false;
		};
	}, [open, debouncedSource, debouncedPropsText]);

	// play: advance t in real time (the preview only; the render seeks frame by frame)
	useEffect(() => {
		if (!playing) return;
		let raf = 0;
		let last = performance.now();
		const tick = (now: number) => {
			const dt = (now - last) / 1000;
			last = now;
			setT((current) => (current + dt >= duration ? 0 : current + dt));
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [playing, duration]);

	const jumpTo = (line: number) => {
		const area = codeRef.current;
		if (!area) return;
		let offset = 0;
		for (let i = 1; i < line; i++) {
			const next = area.value.indexOf("\n", offset);
			if (next < 0) break;
			offset = next + 1;
		}
		area.focus();
		area.setSelectionRange(offset, area.value.indexOf("\n", offset) < 0 ? area.value.length : area.value.indexOf("\n", offset));
		area.scrollTop = Math.max(0, (line - 4) * LINE_H);
	};

	const setProp = (key: string, value: unknown) => {
		const next = { ...(props ?? {}), [key]: value };
		setPropsText(JSON.stringify(next, null, 2));
	};

	const problems = [
		...(parsed.error ? [{ level: "error" as const, text: parsed.error }] : []),
		...(validation?.errors ?? []).map((text) => ({ level: "error" as const, text })),
		...renderErrors.map((text) => ({ level: "error" as const, text })),
		...(preview.state === "failed" ? preview.errors.map((text) => ({ level: "error" as const, text: `preview: ${text}` })) : []),
		...(validation?.warnings ?? []).map((text) => ({ level: "warning" as const, text })),
	];
	const canRender = !busy && !!props && !!validation?.ok && duration > 0 && duration <= (kit?.limits.maxSeconds ?? 60);
	const lines = Math.max(1, source.split("\n").length);

	const run = async () => {
		if (!props || !canRender) return;
		setBusy(true);
		setRenderErrors([]);
		try {
			if (editing && selected) {
				const result = await rerenderCustomComposition({ editor, ref: selected.ref, source, props, duration });
				toast.success(result ? `${result.answer.title} re-rendered in place` : "Same code and props: nothing to re-render", {
					description: result ? `${result.answer.duration} s · network blocked · ${result.answer.cached ? "from cache" : `rendered in ${(result.answer.ms / 1000).toFixed(1)} s`}` : undefined,
				});
			} else {
				const result = await dropCustomComposition({ editor, source, props, duration });
				toast.success(`${result.answer.title} placed on MOTION`, {
					description: `${result.answer.duration} s at the playhead · network blocked · ${result.answer.cached ? "from cache" : `rendered in ${(result.answer.ms / 1000).toFixed(1)} s`}`,
				});
			}
			onOpenChange(false);
		} catch (error) {
			const report = error instanceof CustomRefusedError ? error.report : null;
			setRenderErrors(report?.errors.length ? report.errors : [error instanceof Error ? error.message : String(error)]);
		} finally {
			setBusy(false);
		}
	};

	const dirty = !!baseline && (source !== baseline.source || propsText !== baseline.propsText || duration !== baseline.duration);
	const [pendingLoad, setPendingLoad] = useState<CodeDraft | null>(null);
	const requestOpenChange = (next: boolean) => {
		if (!next && dirty && !busy) {
			setPendingLoad(null);
			setConfirmClose(true);
			return;
		}
		setConfirmClose(false);
		onOpenChange(next);
	};
	/** A starter chip replaces the code too: ask first when there are changes. */
	const requestLoad = (draft: CodeDraft) => {
		if (dirty) {
			setPendingLoad(draft);
			setConfirmClose(true);
			return;
		}
		load(draft);
	};

	const title = validation?.manifest?.title ?? editing?.title ?? "Custom composition";
	const params = validation?.manifest?.params ?? null;

	return (
		<Dialog open={open} onOpenChange={requestOpenChange}>
			<DialogContent className="max-w-[1180px] gap-0 overflow-hidden p-0">
				<div className="flex max-h-[90vh] min-h-[640px] flex-col">
					<div className="border-line flex flex-wrap items-end justify-between gap-3 border-b px-6 pt-5 pb-4 pr-14">
						<div className="flex min-w-0 flex-col gap-1.5">
							<span className="rc-label flex items-center gap-2">
								{editing?.author === "claude" && <span aria-hidden className="bg-kiln size-2 rounded-full" />}
								{editing ? (editing.author === "claude" ? "Edit code · written by Claude" : "Edit code") : "Motion · code"}
							</span>
							<DialogTitle className="rc-display truncate text-xl leading-tight">{title}</DialogTitle>
							<DialogDescription className="text-fog text-[0.8rem] leading-snug">
								HTML/CSS/JS whose picture is a function of time. It renders frame by frame with the network blocked and
								lands on the MOTION track; the code is saved in the clip, so anyone can reopen it.
							</DialogDescription>
						</div>
						{!editing && (
							<div className="flex flex-wrap gap-1.5">
								{examples.map((example) => (
									<button
										key={example.name}
										type="button"
										title={example.description}
										className="rc-pill h-7 px-2.5 text-[0.72rem]"
										onClick={() => requestLoad({ source: example.source, props: example.props, duration: example.duration })}
									>
										{example.title}
									</button>
								))}
								<button
									type="button"
									className="rc-pill h-7 px-2.5 text-[0.72rem]"
									onClick={() => requestLoad({ source: BLANK_CUSTOM_SOURCE, props: {}, duration: 3 })}
								>
									Blank
								</button>
							</div>
						)}
					</div>

					<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px] grid-rows-[minmax(0,1fr)]">
						<div className="border-line flex min-h-0 flex-col border-r">
							<div className="relative flex min-h-0 flex-1 overflow-hidden bg-[#0c0c0e]">
								<div
									ref={gutterRef}
									aria-hidden
									className="rc-mono pointer-events-none w-11 shrink-0 overflow-hidden py-3 pr-2 text-right text-[0.68rem] text-[#4a4a52] select-none"
									style={{ lineHeight: `${LINE_H}px` }}
								>
									{Array.from({ length: lines }, (_, i) => (
										<div key={i}>{i + 1}</div>
									))}
								</div>
								<textarea
									ref={codeRef}
									aria-label="Composition code"
									spellCheck={false}
									wrap="off"
									value={source}
									onChange={(event) => setSource(event.target.value)}
									onScroll={(event) => {
										if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
									}}
									onKeyDown={(event) => {
										if (event.key !== "Tab") return;
										event.preventDefault();
										const area = event.currentTarget;
										const { selectionStart: s, selectionEnd: e } = area;
										const next = `${area.value.slice(0, s)}  ${area.value.slice(e)}`;
										setSource(next);
										requestAnimationFrame(() => area.setSelectionRange(s + 2, s + 2));
									}}
									className="rc-mono text-bone min-h-0 flex-1 resize-none bg-transparent py-3 pr-4 text-[0.74rem] outline-none"
									style={{ lineHeight: `${LINE_H}px`, tabSize: 2 }}
								/>
							</div>
							<div className="border-line scrollbar-thin flex max-h-[150px] min-h-[44px] flex-col gap-1 overflow-y-auto border-t px-4 py-2.5">
								{problems.length === 0 ? (
									<p className="rc-mono text-fog text-[0.68rem]">
										{validation ? `no problems · ${validation.bytes.toLocaleString()} of ${(kit?.limits.maxBytes ?? 262144).toLocaleString()} bytes · protocol ${validation.protocol === "hf" ? "window.__hf" : "RC.composition"}` : "checking…"}
									</p>
								) : (
									problems.map((problem, i) => {
										const line = lineOf(problem.text);
										return (
											<button
												key={`${i}-${problem.text}`}
												type="button"
												disabled={line === null}
												onClick={() => line !== null && jumpTo(line)}
												className={cn(
													"rc-mono text-left text-[0.68rem] leading-snug enabled:cursor-pointer enabled:hover:underline",
													problem.level === "error" ? "text-[#e5484d]" : "text-[#E8A33D]",
												)}
											>
												{problem.level === "error" ? "✕ " : "! "}
												{problem.text}
											</button>
										);
									})
								)}
							</div>
						</div>

						{/* ui-fix-panels (QA #16): preview, transport, length and the FIELDS/JSON switch stay in view; the preview
						    is sized to the height there is (1440×900: Play and FIELDS/JSON were below the pane); only props scroll */}
						<div ref={sideRef} className="flex h-full min-h-0 flex-col overflow-hidden">
						<div className="flex shrink-0 flex-col gap-3 px-5 pt-5 pb-3 [&>*]:shrink-0">
							<div className="flex justify-center">
								<CodePreview
									source={debouncedSource}
									props={previewProps}
									kit={kit}
									canvas={canvas}
									duration={duration}
									t={t}
									boxWidth={previewWidth}
									onStatus={setPreview}
								/>
							</div>
							<div className="flex items-center gap-2">
								<button
									type="button"
									aria-label={playing ? "Pause" : "Play"}
									className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-[#EDEBE6] text-[0.7rem] text-[#0c0c0e]"
									onClick={() => setPlaying((p) => !p)}
								>
									{playing ? "❚❚" : "▶"}
								</button>
								<input
									aria-label="Time"
									type="range"
									min={0}
									max={duration}
									step={1 / canvas.fps}
									value={Math.min(t, duration)}
									onChange={(event) => {
										setPlaying(false);
										setT(Number(event.target.value));
									}}
									className="min-w-0 flex-1 accent-[#EDEBE6]"
								/>
								<span className="rc-mono text-fog w-[92px] shrink-0 text-right text-[0.66rem]">
									{t.toFixed(2)} / {duration.toFixed(2)}
								</span>
							</div>
							<label className="flex items-center justify-between gap-2">
								<span className="rc-label">Length</span>
								<span className="flex items-center gap-1.5">
									<input
										type="number"
										min={0.5}
										max={kit?.limits.maxSeconds ?? 60}
										step={0.1}
										value={duration}
										onChange={(event) => {
											const v = Number(event.target.value);
											if (Number.isFinite(v) && v > 0) setDuration(v);
										}}
										className="bg-background border-line rc-mono w-20 rounded-[8px] border px-2 py-1 text-right text-[0.74rem] text-bone outline-none"
									/>
									<span className="rc-mono text-fog text-[0.66rem]">s</span>
								</span>
							</label>
							<div className="flex items-center justify-between">
								<span className="rc-label">Props</span>
								{params && (
									<div className="bg-surface border-line flex gap-0.5 rounded-[10px] border p-0.5">
										{(["fields", "json"] as const).map((view) => (
											<button
												key={view}
												type="button"
												onClick={() => setPropsView(view)}
												className={cn(
													"rc-mono cursor-pointer rounded-[8px] px-2 py-0.5 text-[0.62rem] uppercase",
													propsView === view ? "bg-[#2a2a31] text-bone" : "text-fog",
												)}
											>
												{view}
											</button>
										))}
									</div>
								)}
							</div>
						</div>
						<div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto border-line border-t px-5 pt-3 pb-5">
							{params && propsView === "fields" && props ? (
								<div className="flex flex-col gap-3.5">
									{Object.entries(params).map(([key, spec]) => (
										<ParamField
											key={key}
											name={key}
											spec={spec}
											value={key in props ? props[key] : spec.default}
											onChange={(value) => setProp(key, value)}
										/>
									))}
								</div>
							) : (
								<textarea
									aria-label="Props JSON"
									spellCheck={false}
									value={propsText}
									onChange={(event) => setPropsText(event.target.value)}
									className={cn(
										"rc-mono bg-background min-h-[160px] resize-y rounded-[10px] border px-2.5 py-2 text-[0.7rem] text-bone outline-none",
										parsed.error ? "border-[#e5484d]" : "border-line focus:border-[#5a5a63]",
									)}
								/>
							)}
						</div>
						</div>
					</div>

					{confirmClose ? (
						<div role="alertdialog" aria-label="Unsaved code" className="border-line flex items-center justify-between gap-3 border-t bg-[var(--rc-raised)] px-6 py-4">
							<p className="text-bone text-[0.85rem]">
								{pendingLoad ? "Load the starter and drop your code changes?" : "Close and drop your code changes?"}
								<span className="text-fog ml-2 text-[0.75rem]">They are not saved anywhere until you render.</span>
							</p>
							<div className="flex shrink-0 gap-2">
								<button type="button" className="rc-pill h-9 text-sm" onClick={() => setConfirmClose(false)}>
									Keep editing
								</button>
								<button
									type="button"
									className="rc-pill h-9 border-[#e5484d]/60 text-sm text-[#e5484d]"
									onClick={() => {
										setConfirmClose(false);
										if (pendingLoad) {
											load(pendingLoad);
											setPendingLoad(null);
										} else onOpenChange(false);
									}}
								>
									{pendingLoad ? "Drop and load" : "Drop and close"}
								</button>
							</div>
						</div>
					) : (
					<div className="border-line flex items-center justify-between gap-3 border-t px-6 py-4">
						<p className="rc-mono text-fog text-[0.66rem] leading-relaxed">
							renders at {canvas.width}×{canvas.height} · {canvas.fps} fps · network blocked · WebM with alpha · cached by
							hash
						</p>
						<button
							type="button"
							className="inline-flex h-10 shrink-0 cursor-pointer items-center rounded-[14px] bg-neon px-5 text-sm font-semibold text-[#0c0c0e] disabled:cursor-default disabled:opacity-50"
							disabled={!canRender}
							onClick={() => void run()}
						>
							{busy ? "Rendering…" : editing ? "Save & re-render" : "Render & place"}
						</button>
					</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
