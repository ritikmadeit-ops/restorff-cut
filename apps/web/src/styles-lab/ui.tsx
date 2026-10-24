"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import { detectRepeats, type RepeatSuggestion, type StyleStep } from "@restorffcut/styles";
import { cn } from "@/utils/ui";
import { useStylesLabStore } from "./store";

/** Mono uppercase label (artboard labels), optionally Kiln (Claude) or neon (the one thing waiting on you). */
export function Label({ children, tone = "mist", className }: { children: ReactNode; tone?: "mist" | "fog" | "kiln" | "neon" | "stale"; className?: string }) {
	return (
		<span
			className={cn(
				"font-mono text-[10px] tracking-[.14em] uppercase",
				tone === "mist" && "text-mist",
				tone === "fog" && "text-fog",
				tone === "kiln" && "text-kiln",
				tone === "neon" && "text-neon",
				tone === "stale" && "text-stale",
				className,
			)}
		>
			{children}
		</span>
	);
}

/** Claude's presence: a small Kiln dot. */
export function KilnDot({ className }: { className?: string }) {
	return <span aria-hidden className={cn("bg-kiln inline-block size-2 shrink-0 rounded-full", className)} />;
}

/** Small pill button; `isolate` = the neon one per view. */
export function Pill({
	children,
	onClick,
	isolate = false,
	tone,
	disabled = false,
	title,
	type = "button",
	className,
}: {
	children: ReactNode;
	onClick?: () => void;
	isolate?: boolean;
	tone?: "kiln" | "danger";
	disabled?: boolean;
	title?: string;
	type?: "button" | "submit";
	className?: string;
}) {
	return (
		<button
			type={type}
			title={title}
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"h-7 shrink-0 cursor-pointer rounded-full border px-3 text-[12px] whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-40",
				isolate
					? "border-neon text-neon hover:bg-neon hover:text-ground"
					: tone === "kiln"
						? "border-kiln/70 text-bone hover:bg-kiln/20"
						: tone === "danger"
							? "border-[#e5484d]/60 text-[#e5484d] hover:bg-[#e5484d]/10"
							: "border-outline text-bone hover:bg-raised",
				className,
			)}
		>
			{children}
		</button>
	);
}

/** Suggestions from the command history (EDT-20), recomputed when the history or the library changes. */
export function useRepeatSuggestions(): RepeatSuggestion[] {
	const history = useStylesLabStore((s) => s.history);
	const library = useStylesLabStore((s) => s.library);
	return useMemo(() => {
		try {
			return detectRepeats(history, { library });
		} catch {
			return [];
		}
	}, [history, library]);
}

/** A template step in plain words. */
export function describeStep(step: StyleStep): string {
	if (step.kind === "sentence") return `“${step.sentence}” — worked out again on each project`;
	const op = step.op;
	switch (op.op) {
		case "set_caption_style":
			return "caption style on every caption track";
		case "apply_style":
			return `editing style ${String(op.preset_id).split("/").pop()}`;
		case "grade":
			return typeof op.preset === "string" ? `grade: ${op.preset.replace(/-/g, " ")}` : "grade";
		case "normalize":
			return "loudness target";
		case "set_canvas":
			return "canvas";
		case "snap_cuts":
			return "cuts snapped to the beat";
		default:
			return String(op.op).replace(/_/g, " ");
	}
}

export function shortDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
	} catch {
		return iso.slice(0, 10);
	}
}
