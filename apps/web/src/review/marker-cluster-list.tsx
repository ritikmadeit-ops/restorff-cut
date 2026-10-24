"use client";

/**
 * The list a stacked JUDGE-row marker opens (QA 2026-10-20 #10, ui-fix-timeline agent): one row per finding at that
 * spot, loudest first — a 10 px swatch in the marker's colour, `SEVERITY · RULE · m:ss`, the finding's sentence.
 * Picking a row opens that finding's card (review/finding-card.tsx), anchored to the same marker.
 *
 * Skin: the finding card's surface (#16161A, radius 16, the 18 px shadow) with a hairline ring instead of the neon
 * one — the list is not the isolate; the finding you pick is.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { registerCanceller } from "@/editor/cancel-interaction";
import type { RemoteComment } from "@/sync/remote";
import { formatTimecode } from "@/sync/snapshot";
import { cardHeading, judgeMarkerStyle, messageAndFix } from "./findings";

const LIST_WIDTH_PX = 320;
const VIEWPORT_MARGIN_PX = 12;

export function MarkerClusterList({
	anchorKey,
	members,
	onPick,
	onClose,
}: {
	/** The cluster button's `data-review-cluster` value. */
	anchorKey: string;
	members: RemoteComment[];
	onPick: (id: string) => void;
	onClose: () => void;
}) {
	const [rect, setRect] = useState<DOMRect | null>(null);
	const measure = useCallback(() => {
		const el = document.querySelector(`[data-review-cluster="${CSS.escape(anchorKey)}"]`);
		setRect(el ? el.getBoundingClientRect() : null);
	}, [anchorKey]);
	useLayoutEffect(measure, [measure]);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		const onDown = (e: MouseEvent) => {
			const target = e.target as Element | null;
			if (target?.closest("[data-review-cluster-list]") || target?.closest(`[data-review-cluster]`)) return;
			onClose();
		};
		window.addEventListener("resize", measure);
		document.addEventListener("scroll", measure, true);
		window.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onDown, true);
		// Esc closes the list only, not the clip selection (the editor runs cancellers before "deselect all").
		const unregister = registerCanceller({ fn: onClose });
		return () => {
			window.removeEventListener("resize", measure);
			document.removeEventListener("scroll", measure, true);
			window.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onDown, true);
			unregister();
		};
	}, [measure, onClose]);

	if (!rect || typeof document === "undefined") return null;

	const left = Math.max(
		VIEWPORT_MARGIN_PX,
		Math.min(rect.left + rect.width / 2 - 24, window.innerWidth - LIST_WIDTH_PX - VIEWPORT_MARGIN_PX),
	);
	const below = rect.bottom + 8;
	const roomBelow = window.innerHeight - below - VIEWPORT_MARGIN_PX;
	const roomAbove = rect.top - 8 - VIEWPORT_MARGIN_PX;
	// Header ≈ 36 px + ≈ 56 px a row: open upward when the rows do not fit below and there is more room above
	// (the JUDGE row sits low on a 1440×900 screen).
	const needed = 36 + members.length * 56;
	const placeAbove = roomBelow < needed && roomAbove > roomBelow;
	const time = (s: number) => formatTimecode(s, true);

	return createPortal(
		<div
			role="dialog"
			aria-label={`${members.length} findings at ${formatTimecode(members[0]?.time_s ?? 0, true)}`}
			data-review-cluster-list={anchorKey}
			className="text-bone fixed z-[60] flex flex-col"
			style={{
				left,
				...(placeAbove ? { bottom: window.innerHeight - rect.top + 8 } : { top: below }),
				width: LIST_WIDTH_PX,
				maxHeight: placeAbove ? roomAbove : roomBelow,
				overflowY: "auto",
				borderRadius: 16,
				background: "var(--rc-surface)",
				boxShadow: "0 0 0 1px var(--rc-outline, #3A3A42), 0 18px 44px rgba(0, 0, 0, 0.5)",
				padding: "12px 8px 8px",
				fontFamily: "var(--font-archivo), ui-sans-serif, sans-serif",
			}}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<div className="flex items-center gap-3 px-2 pb-2">
				<span className="rc-label min-w-0 flex-1 text-[11px]">
					{members.length} findings here
				</span>
				<button
					type="button"
					aria-label="Close the list"
					className="text-fog hover:text-bone shrink-0 cursor-pointer text-[15px] leading-none"
					onClick={onClose}
				>
					×
				</button>
			</div>
			<ul className="flex flex-col gap-0.5">
				{members.map((comment) => {
					const look = judgeMarkerStyle(comment, false);
					const { message } = messageAndFix(comment, null);
					return (
						<li key={comment.id}>
							<button
								type="button"
								data-review-cluster-item={comment.id}
								onClick={() => onPick(comment.id)}
								className="hover:bg-[var(--rc-raised,#222228)] flex w-full cursor-pointer items-start gap-2.5 rounded-[10px] px-2 py-2 text-left"
							>
								<span
									aria-hidden
									className="mt-[3px] shrink-0"
									style={{
										width: 10,
										height: 10,
										borderRadius: 3,
										boxSizing: "border-box",
										background: look.background,
										border: look.border,
										opacity: look.opacity,
									}}
								/>
								<span className="flex min-w-0 flex-col gap-1">
									<span className="rc-mono text-mist text-[11px] leading-none">
										{cardHeading(comment, time)}
										{comment.status === "resolved" ? " · resolved" : ""}
									</span>
									<span className="line-clamp-2 text-[13px] leading-[1.35]">{message || comment.body}</span>
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</div>,
		document.body,
	);
}
