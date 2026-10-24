"use client";

/**
 * The judge finding card — design/edit-artboard.png, JUDGE row (DOM read 2026-10-20 from plan/design/
 * Restorff-design-canvas.html, artboard "6 · Edit"): a 360 px dialog, radius 16, #16161A, a 1.5 px neon ring and
 * `0 18px 44px rgba(0,0,0,.5)`, padding 14 16, gap 8. Mono 11 px heading "MUST · 0:26 · Restorff Sell + Restorff
 * Craft"; the finding in 14 px bold; a 36 px neon button whose label is the fix in plain words ("Move the end card to
 * 0:23"); a 13 px underlined text action.
 *
 * Opened by clicking a marker on the JUDGE row (review/timeline-markers.tsx). The card is the selected marker's,
 * so it carries the view's one neon isolate. Actions:
 * - **Apply fix** — only when the finding carries a machine fix the timeline can do: its `fix_ops` (ops@1) dry-run
 *   cleanly against the open scene (applied as ONE undo step through the ops bridge), or a LOUD finding with the
 *   gate's measured gain (the gate's own "Fix loudness"). Otherwise the fix is a line of text and no button.
 * - **Jump** — the playhead goes to the finding's time and its element is selected.
 * - **Resolve** — server comments through the comments API; local gate markers (`gate-local:*`) in the store.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { loudnessGain } from "@restorffcut/gate";
import type { Op } from "@restorffcut/timeline-ops";
import { commitTracks, conflictText, freshSeed, runOpsOnActiveScene } from "@/captions/ops-bridge";
import type { EditorCore } from "@/core";
import { registerCanceller } from "@/editor/cancel-interaction";
import { useEditor } from "@/editor/use-editor";
import { fixLoudness } from "@/gate/run";
import { useGateStore } from "@/gate/store";
import { syncEngine } from "@/sync/engine";
import { type RemoteComment, remote } from "@/sync/remote";
import { formatTimecode } from "@/sync/snapshot";
import { useSyncStore } from "@/sync/store";
import { mediaTimeFromSeconds } from "@/wasm";
import {
	type CardFinding,
	cardHeading,
	fixOpsOf,
	isLocalGateComment,
	messageAndFix,
	raisedBy,
	sentenceCase,
} from "./findings";
import { selectFindingElement } from "./select-finding";

const CARD_WIDTH_PX = 360;
const CARD_PAD_X_PX = 16;
const VIEWPORT_MARGIN_PX = 12;

type MachineFix =
	| { kind: "ops"; ops: Op[]; label: string }
	| { kind: "loudness"; label: string };

const time = (s: number) => formatTimecode(s);

/** The original finding@1 behind a comment: the gate's local report, or the comments API with `?finding=1`. */
async function loadFinding(comment: RemoteComment, projectId: string | null): Promise<CardFinding | null> {
	if (!comment.finding_id) return null;
	const local = useGateStore.getState().report?.findings.find((f) => f.id === comment.finding_id);
	if (local) return local as unknown as CardFinding;
	if (isLocalGateComment(comment.id) || !projectId) return null;
	const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/comments?finding=1`, {
		cache: "no-store",
		credentials: "same-origin",
	});
	if (!res.ok) return null;
	const data = (await res.json().catch(() => null)) as { comments?: Array<{ id: string; finding?: unknown }> } | null;
	const row = data?.comments?.find((c) => c.id === comment.id);
	return row?.finding && typeof row.finding === "object" ? (row.finding as CardFinding) : null;
}

/** Does this finding carry a fix the timeline can do right now? Dry-runs ops@1 on a snapshot (no edit). */
function findMachineFix(editor: EditorCore, comment: RemoteComment, finding: CardFinding | null, fix: string | null): MachineFix | null {
	const rawOps = fixOpsOf(finding);
	if (rawOps) {
		// The person pressing the button is the author of the edit.
		const ops = rawOps.map((op) => ({ ...op, author: "user" })) as unknown as Op[];
		try {
			const { result } = runOpsOnActiveScene({ editor, ops, seed: `fix-dry-run/${comment.id}` });
			const changed = result.changes.ops.some((change) => change.status === "applied");
			if (result.ok && result.conflicts.length === 0 && result.changes.unsupported.length === 0 && changed) {
				return { kind: "ops", ops, label: sentenceCase(fix ?? "Apply fix") };
			}
		} catch {
			return null;
		}
		return null;
	}
	if (comment.rule_id === "LOUD") {
		const measure = useGateStore.getState().measures?.loudness;
		const gain = measure ? loudnessGain(measure) : null;
		if (gain && Math.abs(gain.gain_db) >= 0.1) {
			const sign = gain.gain_db > 0 ? "+" : "−";
			return { kind: "loudness", label: `Fix loudness · ${sign}${Math.abs(gain.gain_db).toFixed(1)} dB` };
		}
	}
	return null;
}

function useAnchorRect(commentId: string, deps: unknown[]): DOMRect | null {
	const [rect, setRect] = useState<DOMRect | null>(null);
	const measure = useCallback(() => {
		// ui-fix-timeline: a stacked marker carries every member id in `data-review-marker-ids` (QA #10).
		const id = CSS.escape(commentId);
		const el =
			document.querySelector(`[data-review-marker-ids~="${id}"]`) ??
			document.querySelector(`[data-review-marker-id="${id}"]`);
		setRect(el ? el.getBoundingClientRect() : null);
	}, [commentId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the timeline zoom/scroll inputs change
	useLayoutEffect(measure, [measure, ...deps]);
	useEffect(() => {
		window.addEventListener("resize", measure);
		document.addEventListener("scroll", measure, true);
		return () => {
			window.removeEventListener("resize", measure);
			document.removeEventListener("scroll", measure, true);
		};
	}, [measure]);
	return rect;
}

export function FindingCard({
	comment,
	zoomLevel,
	alsoResolve = [],
}: {
	comment: RemoteComment;
	zoomLevel: number;
	/** Hidden duplicates of this finding (same rule, time and words under other ids): resolved with it. */
	alsoResolve?: string[];
}) {
	const editor = useEditor();
	const projectId = useSyncStore((s) => s.projectId);
	const select = useSyncStore((s) => s.selectComment);
	const gateReport = useGateStore((s) => s.report);
	const [finding, setFinding] = useState<CardFinding | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState<null | "apply" | "resolve">(null);
	const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
	const [applied, setApplied] = useState(false);
	const anchor = useAnchorRect(comment.id, [zoomLevel, comment.time_s]);

	useEffect(() => {
		let live = true;
		setLoaded(false);
		setFinding(null);
		setNote(null);
		setApplied(false);
		loadFinding(comment, projectId)
			.then((f) => live && setFinding(f))
			.catch(() => null)
			.finally(() => live && setLoaded(true));
		return () => {
			live = false;
		};
		// gateReport: a fresh gate run can bring the local finding behind this marker.
	}, [comment, projectId, gateReport]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") select(null);
		};
		window.addEventListener("keydown", onKey);
		// ui-fix-timeline (QA #2): Esc closes the card only. The editor's Esc runs registered cancellers instead of
		// "deselect all", so the clip the card selected stays in the inspector.
		const unregister = registerCanceller({ fn: () => select(null) });
		return () => {
			window.removeEventListener("keydown", onKey);
			unregister();
		};
	}, [select, comment.id]);

	const { message, fix } = messageAndFix(comment, finding);
	const machineFix = useMemo(
		() => (loaded && !applied && comment.status === "open" ? findMachineFix(editor, comment, finding, fix) : null),
		[loaded, applied, editor, comment, finding, fix],
	);
	const heading = `${cardHeading(comment, time)} · ${raisedBy(comment, finding)}`;

	const jump = () => {
		editor.playback.seek({ time: mediaTimeFromSeconds({ seconds: comment.time_s }) });
		// ui-fix-timeline (QA #2): the element on the lane it lives on now; a gone element leaves the selection alone.
		selectFindingElement(editor, comment);
	};

	const applyFix = async () => {
		if (!machineFix) return;
		setBusy("apply");
		setNote(null);
		try {
			if (machineFix.kind === "ops") {
				const run = runOpsOnActiveScene({
					editor,
					ops: machineFix.ops,
					seed: freshSeed(editor, `fix/${comment.finding_id ?? comment.id}`),
				});
				if (!run.result.ok || run.result.conflicts.length) {
					throw new Error(conflictText(run.result) || "the timeline refused the fix");
				}
				commitTracks({ editor, before: run.before, after: run.after });
				setApplied(true);
				setNote({ tone: "ok", text: "Applied as one undo step. Render final checks it again." });
			} else {
				setApplied(true);
				setNote({ tone: "ok", text: "Fixing loudness: the gate renders and checks again." });
				await fixLoudness(editor);
			}
		} catch (error) {
			setApplied(false);
			setNote({ tone: "error", text: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(null);
		}
	};

	const resolve = async () => {
		setBusy("resolve");
		setNote(null);
		try {
			const ids = [comment.id, ...alsoResolve];
			if (isLocalGateComment(comment.id) || !projectId) {
				const store = useSyncStore.getState();
				store.set({
					comments: store.comments.map((c) =>
						ids.includes(c.id) ? { ...c, status: "resolved", resolved_by: "you", resolved_at: new Date().toISOString() } : c,
					),
				});
			} else {
				await remote.updateComment(projectId, comment.id, { status: "resolved" });
				// The same finding under other ids (QA #10): resolve them too, or the next copy pops up open.
				for (const id of alsoResolve) {
					if (!isLocalGateComment(id)) await remote.updateComment(projectId, id, { status: "resolved" }).catch(() => null);
				}
				await syncEngine.loadComments();
			}
			select(null);
		} catch (error) {
			setNote({ tone: "error", text: error instanceof Error ? error.message : String(error) });
		} finally {
			setBusy(null);
		}
	};

	if (!anchor || typeof document === "undefined") return null;

	// Below the marker, which sits ~60 % from the card's left edge as on the artboard (marker 234 px into a 392 px
	// card); clamped to the viewport; above the marker when there is no room below.
	const outerWidth = CARD_WIDTH_PX + CARD_PAD_X_PX * 2;
	const left = Math.max(
		VIEWPORT_MARGIN_PX,
		Math.min(anchor.left + anchor.width / 2 - outerWidth * 0.6, window.innerWidth - outerWidth - VIEWPORT_MARGIN_PX),
	);
	const below = anchor.bottom + 8;
	const roomBelow = window.innerHeight - below - VIEWPORT_MARGIN_PX;
	const placeAbove = roomBelow < 150 && anchor.top > 200;

	return createPortal(
		<div
			role="dialog"
			aria-label="Judge finding"
			data-finding-card={comment.id}
			className="text-bone fixed z-[60] flex flex-col"
			style={{
				left,
				...(placeAbove ? { bottom: window.innerHeight - anchor.top + 8 } : { top: below }),
				width: CARD_WIDTH_PX,
				maxHeight: placeAbove ? anchor.top - VIEWPORT_MARGIN_PX - 8 : roomBelow,
				overflowY: "auto",
				boxSizing: "content-box",
				borderRadius: 16,
				background: "var(--rc-surface)",
				boxShadow: "0 0 0 1.5px var(--rc-neon), 0 18px 44px rgba(0, 0, 0, 0.5)",
				padding: `14px ${CARD_PAD_X_PX}px`,
				gap: 8,
				fontFamily: "var(--font-archivo), ui-sans-serif, sans-serif",
			}}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<div className="flex items-start gap-3">
				<span className="rc-mono text-neon min-w-0 flex-1 text-[11px] leading-[1.45]">{heading}</span>
				<button
					type="button"
					aria-label="Close the finding"
					className="text-fog hover:text-bone -mt-0.5 shrink-0 cursor-pointer text-[15px] leading-none"
					onClick={() => select(null)}
				>
					×
				</button>
			</div>

			<p className="text-[14px] leading-[1.4] font-bold">{message || "No description."}</p>

			{fix && !machineFix && (
				<p className="text-mist text-[13px] leading-[1.4]">
					<span className="rc-mono text-fog mr-1.5 text-[11px]">FIX</span>
					{sentenceCase(fix)}
				</p>
			)}

			<div className="flex flex-wrap items-center gap-[10px]">
				{machineFix && (
					<button
						type="button"
						aria-label={`Apply fix: ${machineFix.label}`}
						title="Apply fix"
						disabled={busy !== null}
						onClick={applyFix}
						className="bg-neon cursor-pointer rounded-[10px] px-[14px] text-[14px] font-bold text-[#0C0C0E] disabled:opacity-60"
						style={{ height: 36 }}
					>
						{busy === "apply" ? "Applying…" : machineFix.label}
					</button>
				)}
				<button
					type="button"
					onClick={jump}
					title={`Playhead to ${time(comment.time_s)}`}
					className="border-outline hover:border-bone cursor-pointer rounded-[10px] border px-[14px] text-[14px] font-semibold"
					style={{ height: 36 }}
				>
					Jump
				</button>
				{comment.status === "open" ? (
					<button
						type="button"
						disabled={busy !== null}
						onClick={resolve}
						className="text-bone cursor-pointer text-[13px] underline underline-offset-2 disabled:opacity-60"
					>
						{busy === "resolve" ? "Resolving…" : "Resolve"}
					</button>
				) : (
					<span className="rc-mono text-fog text-[11px]">
						resolved{comment.resolved_by ? ` · ${comment.resolved_by}` : ""}
					</span>
				)}
			</div>

			{note && (
				<p className={`text-[12px] leading-[1.4] ${note.tone === "error" ? "text-stale" : "text-mist"}`}>{note.text}</p>
			)}
		</div>,
		document.body,
	);
}
