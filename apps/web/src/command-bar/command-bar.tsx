"use client";

/**
 * The "Tell Claude…" pill over the preview (reel DeUUFJQu8cw: one typed sentence and the whole edit changes, shown as
 * a before/after wipe). Mounted with one line in preview/components/index.tsx (PreviewPanel).
 *
 *  - A sentence the editor understands by itself (style, "tighter cut", captions, grade words, a nudge for the selected
 *    composition) is resolved by @restorffcut/timeline-ops resolveSentence → ops@1 → applied as one undo step →
 *    before/after wipe → Accept (keep) / Discard (undo).
 *  - Anything else goes to the person's own Claude (bring-your-own-Claude: Restorff never runs Claude). We build a
 *    ready prompt with the timeline id and head commit, copy it, and say how to send it. Claude edits through MCP
 *    (`/api/mcp` → timeline_ops); its commit arrives through the sync engine and shows here as "Claude: <message>".
 *  - It never claims to have understood what it did not: "Not understood here — ask your Claude".
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolveSentence, type IntentPlan, type Project as OpsProject } from "@restorffcut/timeline-ops";
import { toast } from "sonner";
import { commitProposal, type PlanApplyReport, type PlanProposal, prepareProposal } from "@/claude/apply-plan";
import { captureFrame } from "@/claude/frame";
import { buildClaudePrompt, claudeCodeSetup, mcpUrl } from "@/claude/prompt";
import { useRemoteCommits } from "@/claude/use-claude-commits";
import { useSelectedComposition } from "@/compositions/use-selected-composition";
import { useEditor } from "@/editor/use-editor";
import { recordInstruction } from "@/styles-lab/history"; // styles agent: EDT-20 repeat detection
import { matchTrigger, projectCaptionSize } from "@restorffcut/styles";
import { applySavedStyle } from "@/styles-lab/apply-saved";
import { useStylesLabStore } from "@/styles-lab/store";
import { useStoryboardStore } from "@/storyboard/store";
import { syncEngine } from "@/sync/engine";
import { authorLabel, useSyncStore } from "@/sync/store";
import { cn } from "@/utils/ui";
import { CompareWipe } from "./compare-wipe";

type Phase =
	| { kind: "idle" }
	| { kind: "working"; sentence: string; step: string }
	| {
			kind: "result";
			sentence: string;
			plan: IntentPlan;
			report: PlanApplyReport | null;
			/** The edit worked out but NOT on the timeline until Accept (ui-fix-panels, QA #29). */
			proposal: PlanProposal | null;
			before: string | null;
			after: string | null;
			/** Reasons per clause that was not understood. */
			reasons: string[];
	  };

/**
 * Where the bar sits (ui-fix-panels, QA #13: it used to float over the top of the picture, covering a 16:9 frame).
 *   dock  the pill sits in the transport row, left of prev/play/next — clear of the picture for every canvas shape;
 *         its cards open upward, beside the picture when there is room (tall canvases), over it only while open.
 *   top   a panel too narrow for the dock: the pill above the picture, as before.
 */
interface BarPlacement {
	mode: "dock" | "top";
	/** dock: px from the panel's left and bottom; the pill's width. */
	left: number;
	bottom: number;
	pillWidth: number;
	/**
	 * dock: the cards are a popover in fixed (viewport) coordinates, so a short preview panel does not clip them: they
	 * open up from the pill when there is room, else down over the timeline. `anchor` = the pill's top (up) or bottom
	 * (down) and its left edge, in viewport px.
	 */
	direction: "up" | "down";
	anchorX: number;
	anchorY: number;
	/** The cards: width and the most height they may take. */
	cardWidth: number;
	cardMaxHeight: number;
	/** Height of the before/after wipe so it fits the card. */
	wipeHeight: number;
}

const TOP_PLACEMENT: BarPlacement = {
	mode: "top",
	left: 0,
	bottom: 0,
	pillWidth: 460,
	direction: "down",
	anchorX: 0,
	anchorY: 0,
	cardWidth: 460,
	cardMaxHeight: 560,
	wipeHeight: 260,
};

function useBarPlacement(rootRef: React.RefObject<HTMLDivElement | null>, aspect: number): BarPlacement {
	const [placement, setPlacement] = useState<BarPlacement>(TOP_PLACEMENT);
	useEffect(() => {
		const panel = rootRef.current?.parentElement;
		if (!panel) return;
		const measure = () => {
			const box = panel.getBoundingClientRect();
			const back = panel.querySelector<HTMLElement>('button[aria-label="Back 1 frame"]');
			const picture = panel.querySelector<HTMLElement>("canvas")?.getBoundingClientRect();
			if (!back || !box.width) {
				setPlacement(TOP_PLACEMENT);
				return;
			}
			const transport = back.getBoundingClientRect();
			const left = 22;
			const slot = transport.left - box.left - left - 18;
			if (slot < 190) {
				setPlacement({ ...TOP_PLACEMENT, pillWidth: Math.min(460, box.width - 32), cardWidth: Math.min(460, box.width - 32) });
				return;
			}
			const pillHeight = 36;
			const bottom = Math.max(8, box.bottom - (transport.top + transport.height / 2) - pillHeight / 2);
			const pillTop = box.bottom - bottom - pillHeight;
			const pillBottom = pillTop + pillHeight;
			// up from the pill when that has room (below the app header), else down over the timeline
			const roomAbove = pillTop - 76;
			const roomBelow = window.innerHeight - pillBottom - 12;
			const direction: "up" | "down" = roomAbove >= 380 || roomAbove >= roomBelow ? "up" : "down";
			const cardMaxHeight = Math.max(160, direction === "up" ? roomAbove : roomBelow);
			// up: beside the picture when it leaves room (a tall canvas), else as wide as is comfortable
			const side = picture && picture.width ? picture.left - box.left - left - 14 : 0;
			const cardWidth = direction === "up" && side >= 300 ? Math.min(440, side) : Math.min(460, box.width - 2 * left);
			const wipeByWidth = (cardWidth - 28) / Math.max(0.1, aspect);
			const wipeHeight = Math.round(Math.max(120, Math.min(260, wipeByWidth, cardMaxHeight - 150)));
			setPlacement({
				mode: "dock",
				left,
				bottom,
				pillWidth: Math.min(340, slot),
				direction,
				anchorX: box.left + left,
				anchorY: direction === "up" ? pillTop - 8 : pillBottom + 8,
				cardWidth,
				cardMaxHeight,
				wipeHeight,
			});
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(panel);
		const canvas = panel.querySelector("canvas");
		if (canvas) observer.observe(canvas);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [rootRef, aspect]);
	return placement;
}

const EXAMPLES = ["make it moody", "tighter cut, bigger captions", "captions at the top", "make it aesthetic", "warmer"];
const COMPOSITION_EXAMPLES = ["slower", "bigger", "make it red"];

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

function Label({ children, tone = "fog" }: { children: ReactNode; tone?: "fog" | "kiln" | "neon" | "stale" }) {
	return (
		<span
			className={cn(
				"font-mono text-[10px] tracking-[.14em] uppercase",
				tone === "fog" && "text-[var(--rc-fog)]",
				tone === "kiln" && "text-[var(--rc-kiln)]",
				tone === "neon" && "text-[var(--rc-neon)]",
				tone === "stale" && "text-[var(--rc-stale)]",
			)}
		>
			{children}
		</span>
	);
}

function Pill({
	children,
	onClick,
	isolate = false,
	disabled = false,
}: {
	children: ReactNode;
	onClick: () => void;
	isolate?: boolean;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"h-7 rounded-full border px-3 text-[12px] transition-colors disabled:opacity-40",
				isolate
					? "border-[var(--rc-neon)] text-[var(--rc-neon)] hover:bg-[var(--rc-neon)] hover:text-[var(--rc-ground)]"
					: "border-[var(--rc-outline)] text-[var(--rc-bone)] hover:bg-[var(--rc-raised)]",
			)}
		>
			{children}
		</button>
	);
}

export function CommandBar() {
	const editor = useEditor();
	const project = useEditor((e) => e.project.getActiveOrNull());
	const selected = useSelectedComposition();
	const syncStatus = useSyncStore((s) => s.status);
	const head = useSyncStore((s) => s.head);
	const { latest, dismiss } = useRemoteCommits(editor);
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const [copied, setCopied] = useState(false);
	const [restoring, setRestoring] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const origin = typeof window === "undefined" ? "http://localhost:8791" : window.location.origin;

	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	const submit = useCallback(
		async (raw: string) => {
			const sentence = raw.trim();
			if (!sentence || !project || phase.kind === "working") return;
			setCopied(false);
			// A saved style's trigger sentence (EDT-20) applies that style as one undo step instead of being parsed.
			const saved = matchTrigger(useStylesLabStore.getState().library, sentence);
			if (saved) {
				setPhase({ kind: "working", sentence, step: `applying your style "${saved.title}"…` });
				try {
					const report = await applySavedStyle({ editor, style: saved, onStep: (step) => setPhase({ kind: "working", sentence, step }) });
					toast.success(`Applied your style "${report.title}" v${report.version}`, {
						description: [...report.notes, ...report.unresolved.map((u) => `ask your Claude: ${u}`)].join(" · ") || "Undo with Ctrl+Z.",
					});
				} catch (error) {
					toast.error(`Your style "${saved.title}" failed`, { description: error instanceof Error ? error.message : String(error) });
				}
				setPhase({ kind: "idle" });
				setText("");
				return;
			}
			const scene = editor.scenes.getActiveScene();
			const opsProject = { ...project, currentSceneId: scene.id, scenes: editor.scenes.getScenes() } as unknown as OpsProject;
			const plan = resolveSentence(sentence, { project: opsProject, compositionSelected: Boolean(selected) });
			// styles agent (EDT-20); ui-fix-panels (QA #8): with the caption size before, so a saved style stores a ratio
			recordInstruction({ sentence, ops: plan.ops, clauses: plan.clauses, projectId: project.metadata.id, captionSizeBefore: projectCaptionSize(opsProject) });
			const reasons = plan.clauses.filter((clause) => !clause.kinds.length && clause.reason).map((clause) => `"${clause.text}": ${clause.reason}`);
			if (!plan.matched) {
				setPhase({ kind: "result", sentence, plan, report: null, proposal: null, before: null, after: null, reasons });
				return;
			}
			setPhase({ kind: "working", sentence, step: "drawing the before…" });
			try {
				const before = await captureFrame({ editor });
				// ui-fix-panels (QA #29): worked out on a snapshot; the timeline is untouched until Accept
				const proposal = await prepareProposal({
					editor,
					plan,
					composition: selected ? { ref: selected.ref, source: selected.source } : null,
					onStep: (step) => setPhase({ kind: "working", sentence, step }),
				});
				const after = proposal.after ? await captureFrame({ editor, tracks: proposal.after, extraAssets: proposal.assets }) : null;
				// the compositor is shared with the live preview: draw the timeline as it IS again, so the preview does not
				// show the un-accepted "after" (seen 2026-10-23: the picture went black and white before Accept)
				if (proposal.after) await captureFrame({ editor, width: 2 });
				setPhase({ kind: "result", sentence, plan, report: proposal.report, proposal: proposal.after ? proposal : null, before: proposal.after ? before : null, after, reasons });
			} catch (error) {
				toast.error("That edit failed", { description: error instanceof Error ? error.message : String(error) });
				setPhase({ kind: "result", sentence, plan: { ...plan, matched: false, unmatched: [sentence] }, report: null, proposal: null, before: null, after: null, reasons });
			}
		},
		[editor, phase.kind, project, selected],
	);

	const close = () => {
		setPhase({ kind: "idle" });
		setOpen(false);
		setText("");
		setCopied(false);
	};

	// a proposal was never applied: Discard just drops it (QA #29)
	const discard = () => close();

	const accept = () => {
		if (phase.kind === "result" && phase.proposal) {
			try {
				const made = commitProposal({ editor, proposal: phase.proposal });
				if (made) toast.success("Applied", { description: `${phase.proposal.report.label || phase.sentence} · Ctrl+Z undoes it` });
			} catch (error) {
				toast.error("Couldn't apply that edit", { description: error instanceof Error ? error.message : String(error) });
			}
		}
		close();
	};

	const unmatched = phase.kind === "result" ? (phase.report?.unmatched ?? phase.plan.unmatched) : [];
	const didSomething = phase.kind === "result" && Boolean(phase.proposal);
	const rootRef = useRef<HTMLDivElement>(null);
	const canvasSize = project?.settings.canvasSize;
	const measured = useBarPlacement(rootRef, canvasSize ? canvasSize.width / Math.max(1, canvasSize.height) : 9 / 16);
	// the storyboard covers the picture and the transport and keeps a 56 px strip at its top for the bar
	const storyboard = useStoryboardStore((s) => s.view) === "storyboard";
	const placement = storyboard ? TOP_PLACEMENT : measured;
	const prompt = useMemo(() => {
		if (phase.kind !== "result" || !project || !unmatched.length) return "";
		return buildClaudePrompt({
			sentence: phase.sentence,
			projectId: project.metadata.id,
			projectName: project.metadata.name,
			head: head?.id ?? null,
			origin,
			alsoDone: didSomething ? phase.report?.label || undefined : undefined,
		});
	}, [didSomething, head?.id, origin, phase, project, unmatched.length]);

	if (!project) return null;
	const serverless = syncStatus === "unlinked" || syncStatus === "off" || syncStatus === "offline" || syncStatus === "error";

	const docked = placement.mode === "dock";
	return (
		<div
			ref={rootRef}
			className={cn(
				"pointer-events-none absolute z-30 flex flex-col items-stretch gap-2",
				docked ? "flex-col-reverse items-start" : "top-3 left-1/2 w-[min(460px,calc(100%-32px))] -translate-x-1/2",
			)}
			style={docked ? { left: placement.left, bottom: placement.bottom, width: placement.pillWidth } : undefined}
		>
			{/* the pill */}
			<form
				className={cn(
					"pointer-events-auto flex h-9 items-center gap-2 rounded-full border bg-[var(--rc-surface)]/90 pr-1.5 pl-3 backdrop-blur",
					open ? "border-[var(--rc-fog)]" : "border-[var(--rc-outline)] hover:border-[var(--rc-fog)]",
					!docked && "w-full",
				)}
				style={docked ? { width: placement.pillWidth, maxWidth: "100%" } : undefined}
				onSubmit={(event) => {
					event.preventDefault();
					void submit(text);
				}}
				onClick={() => setOpen(true)}
			>
				<span aria-hidden className="size-2 shrink-0 rounded-full bg-[var(--rc-kiln)]" title="Claude" />
				<input
					ref={inputRef}
					value={text}
					onChange={(event) => setText(event.target.value)}
					onFocus={() => setOpen(true)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							close(); // a pending proposal was never applied: Esc drops it (ui-fix-panels, QA #29)
							inputRef.current?.blur();
						}
					}}
					placeholder={selected ? `Tell Claude… (selected: ${selected.source.name})` : "Tell Claude…"}
					aria-label="Tell Claude what to change"
					className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-[var(--rc-bone)] outline-none placeholder:text-[var(--rc-fog)]"
					disabled={phase.kind === "working"}
				/>
				{open && text.trim() ? (
					<button type="submit" className="h-6 rounded-full bg-[var(--rc-bone)] px-2.5 text-[11px] font-semibold text-[var(--rc-ground)]">
						Go ↵
					</button>
				) : null}
			</form>

			<CardsHost docked={docked} placement={placement}>
			{/* examples */}
			{open && phase.kind === "idle" && !text.trim() ? (
				<div className="pointer-events-auto flex w-full flex-wrap gap-1.5 rounded-[14px] border border-[var(--rc-outline)] bg-[var(--rc-surface)]/95 p-2 backdrop-blur">
					{(selected ? [...COMPOSITION_EXAMPLES, ...EXAMPLES] : EXAMPLES).map((example) => (
						<button
							key={example}
							type="button"
							onClick={() => {
								setText(example);
								void submit(example);
							}}
							className="rounded-full border border-[var(--rc-outline)] px-2.5 py-1 text-[11px] text-[var(--rc-mist)] hover:bg-[var(--rc-raised)] hover:text-[var(--rc-bone)]"
						>
							{example}
						</button>
					))}
					<button type="button" onClick={close} className="ml-auto px-1 font-mono text-[10px] text-[var(--rc-fog)] hover:text-[var(--rc-bone)]">
						esc
					</button>
				</div>
			) : null}

			{/* working */}
			{phase.kind === "working" ? (
				<div className="pointer-events-auto w-full rounded-[14px] border border-[var(--rc-outline)] bg-[var(--rc-surface)]/95 px-3 py-2 backdrop-blur">
					<Label>working</Label>
					<div className="mt-0.5 text-[12px] text-[var(--rc-mist)]">{phase.step}</div>
				</div>
			) : null}

			{/* result: done here, and/or ask your Claude */}
			{phase.kind === "result" ? (
				<div style={docked ? { maxHeight: placement.cardMaxHeight } : undefined} className="pointer-events-auto flex max-h-[70vh] w-full flex-col gap-3 overflow-auto rounded-[16px] border border-[var(--rc-outline)] bg-[var(--rc-surface)]/95 p-3 backdrop-blur">
					{phase.report ? (
						<section className="flex flex-col gap-2">
							<div className="flex items-baseline justify-between gap-2">
								<Label tone={didSomething ? "stale" : "fog"}>{didSomething ? "proposal · not applied yet" : "nothing changed"}</Label>
								<span className="font-mono text-[10px] text-[var(--rc-fog)]">
									{phase.report.applied ? `${phase.report.applied} ops` : ""}
									{phase.report.nudged.length ? ` · ${phase.report.nudged.length} params` : ""}
								</span>
							</div>
							<div className="text-[13px] text-[var(--rc-bone)]">{phase.report.label || phase.sentence}</div>
							{didSomething ? <CompareWipe before={phase.before} after={phase.after} height={placement.wipeHeight} /> : null}
							{phase.report.compositions.length ? (
								<div className="text-[11px] text-[var(--rc-mist)]">added {phase.report.compositions.join(", ")}</div>
							) : null}
							{phase.report.nudged.length ? <div className="font-mono text-[10px] text-[var(--rc-mist)]">{phase.report.nudged.join(" · ")}</div> : null}
							{[...phase.report.pending, ...phase.report.notes].length ? (
								<ul className="flex flex-col gap-0.5 text-[11px] text-[var(--rc-fog)]">
									{[...new Set([...phase.report.pending, ...phase.report.notes])].slice(0, 5).map((note) => (
										<li key={note}>· {note}</li>
									))}
								</ul>
							) : null}
							{phase.report.skipped.length ? (
								<div className="text-[11px] text-[var(--rc-stale)]">
									skipped {phase.report.skipped.length}: {phase.report.skipped.slice(0, 2).join(" · ")}
								</div>
							) : null}
							{didSomething ? (
								<div className="flex gap-2">
									<Pill isolate onClick={accept}>Accept</Pill>
									<Pill onClick={discard}>Discard</Pill>
								</div>
							) : null}
						</section>
					) : null}

					{unmatched.length ? (
						<section className={cn("flex flex-col gap-2", phase.report && "border-t border-[var(--rc-hairline)] pt-3")}>
							<div className="flex items-center gap-2">
								<span aria-hidden className="size-2 rounded-full bg-[var(--rc-kiln)]" />
								<Label tone="kiln">not understood here — ask your Claude</Label>
							</div>
							<div className="text-[12px] text-[var(--rc-mist)]">
								{phase.report ? (
									<>
										Not done: <span className="text-[var(--rc-bone)]">{unmatched.map((clause) => `"${clause}"`).join(", ")}</span>.
									</>
								) : (
									<>The editor can't do this by itself. Your own Claude can, through RestorffCut's MCP.</>
								)}
							</div>
							{phase.reasons.length ? <div className="font-mono text-[10px] text-[var(--rc-fog)]">{phase.reasons.slice(0, 3).join(" · ")}</div> : null}
							{serverless ? (
								<div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--rc-stale)]/40 px-2 py-1.5 text-[11px] text-[var(--rc-stale)]">
									This project has no server copy yet, so Claude can't see it.
									<Pill
										onClick={async () => {
											const ok = await syncEngine.link();
											if (ok) toast.success("Version history started: Claude can see this project now");
										}}
									>
										Start version history
									</Pill>
								</div>
							) : null}
							<textarea
								readOnly
								value={prompt}
								rows={6}
								onFocus={(event) => event.currentTarget.select()}
								className="w-full resize-none rounded-[10px] border border-[var(--rc-outline)] bg-[var(--rc-ground)] p-2 font-mono text-[10.5px] leading-snug text-[var(--rc-mist)] outline-none"
							/>
							<div className="flex flex-wrap items-center gap-2">
								<Pill
									isolate={!copied && !didSomething /* one neon per view: Accept has it while a proposal waits */}
									onClick={async () => {
										const ok = await copyText(prompt);
										setCopied(ok);
										if (!ok) toast.error("Couldn't copy: select the text and copy it yourself");
									}}
								>
									{copied ? "Copied ✓" : "Copy prompt for your Claude"}
								</Pill>
								<Pill
									onClick={async () => {
										const ok = await copyText(claudeCodeSetup(origin));
										toast(ok ? "Copied the Claude Code setup line" : "Couldn't copy", { description: claudeCodeSetup(origin) });
									}}
								>
									Copy MCP setup
								</Pill>
								<Pill onClick={close}>{didSomething ? "Close (drops the proposal)" : "Close"}</Pill>
							</div>
							<div className="text-[11px] leading-snug text-[var(--rc-fog)]">
								{copied ? "Sent nowhere yet: paste it into your Claude. " : "How to send it: "}
								Claude Desktop, Claude Code or claude.ai with RestorffCut added as an MCP server (
								<span className="font-mono text-[var(--rc-mist)]">{mcpUrl(origin)}</span>). Claude calls{" "}
								<span className="font-mono">timeline_ops</span>; its commit appears here as “Claude: …” with a before/after.
							</div>
						</section>
					) : null}
				</div>
			) : null}

			{/* a commit that arrived from Claude (or a preset / the compiler) */}
			{latest && phase.kind === "idle" ? (
				<div className="pointer-events-auto flex w-full flex-col gap-2 rounded-[16px] border border-[var(--rc-kiln)]/60 bg-[var(--rc-surface)]/95 p-3 backdrop-blur">
					<div className="flex items-center gap-2">
						<span aria-hidden className="size-2 rounded-full bg-[var(--rc-kiln)]" />
						<Label tone="kiln">{authorLabel(latest.commit.author)}</Label>
						<span className="ml-auto font-mono text-[10px] text-[var(--rc-fog)]">
							commit {latest.commit.id.slice(0, 7)}
							{latest.count > 1 ? ` · +${latest.count - 1} more` : ""}
						</span>
					</div>
					<div className="text-[13px] text-[var(--rc-bone)]">
						{authorLabel(latest.commit.author)}: {latest.commit.message}
					</div>
					<CompareWipe before={latest.before} after={latest.after} height={placement.wipeHeight} />
					<div className="flex gap-2">
						<Pill onClick={dismiss}>Keep</Pill>
						{latest.commit.parents[0] ? (
							<Pill
								disabled={restoring}
								onClick={async () => {
									setRestoring(true);
									try {
										await syncEngine.restore(latest.commit.parents[0] as string);
										dismiss();
									} catch (error) {
										toast.error("Couldn't restore", { description: error instanceof Error ? error.message : String(error) });
									} finally {
										setRestoring(false);
									}
								}}
							>
								{restoring ? "Restoring…" : "Restore previous"}
							</Pill>
						) : null}
					</div>
				</div>
			) : null}
			</CardsHost>
		</div>
	);
}

/**
 * The bar's cards (examples, working, result, Claude's commit). Docked: a popover in viewport coordinates, portalled
 * to <body> so a short preview panel can't clip it, opening up from the pill or down over the timeline (QA #13).
 */
function CardsHost({ docked, placement, children }: { docked: boolean; placement: BarPlacement; children: ReactNode }) {
	if (!docked || typeof document === "undefined") return <>{children}</>;
	const style: React.CSSProperties =
		placement.direction === "up"
			? { left: placement.anchorX, bottom: window.innerHeight - placement.anchorY, width: placement.cardWidth, maxHeight: placement.cardMaxHeight }
			: { left: placement.anchorX, top: placement.anchorY, width: placement.cardWidth, maxHeight: placement.cardMaxHeight };
	return createPortal(
		<div
			className={cn("pointer-events-none fixed z-40 flex items-stretch gap-2", placement.direction === "up" ? "flex-col-reverse" : "flex-col")}
			style={style}
		>
			{children}
		</div>,
		document.body,
	);
}
