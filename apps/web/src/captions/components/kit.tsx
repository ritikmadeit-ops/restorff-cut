"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/utils/ui";

/** Restorff skin bits for the captions / cut / transcript views (screen palette, Archivo labels, mono numbers). */

export function formatTime(seconds: number): string {
	const safe = Math.max(0, seconds);
	const minutes = Math.floor(safe / 60);
	const rest = safe - minutes * 60;
	return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

export function formatSeconds(seconds: number): string {
	return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
	return (
		<div className="mb-2 flex items-center justify-between gap-2">
			<h3 className="rc-label text-fog">{children}</h3>
			{right}
		</div>
	);
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
	return <span className={cn("rc-mono text-[0.7rem]", className)}>{children}</span>;
}

/** The one isolate per view: the action waiting on you. */
export function NeonButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			type="button"
			className={cn(
				"bg-neon text-[#0C0C0E] flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-[999px] px-4 text-[0.8rem] font-bold tracking-[-0.01em] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40",
				className,
			)}
			{...rest}
		>
			{children}
		</button>
	);
}

export function PillButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			type="button"
			className={cn(
				"border-line text-bone hover:bg-surface flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-[999px] border px-3 text-[0.74rem] font-semibold transition-colors disabled:cursor-default disabled:opacity-40",
				className,
			)}
			{...rest}
		>
			{children}
		</button>
	);
}

export function IconButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			type="button"
			className={cn(
				"rc-mono text-fog hover:text-bone hover:bg-[#2a2a31] flex size-6 cursor-pointer items-center justify-center rounded-[6px] text-[0.72rem] transition-colors disabled:cursor-default disabled:opacity-30",
				className,
			)}
			{...rest}
		>
			{children}
		</button>
	);
}

export function Segmented<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T;
	options: Array<{ id: T; label: string }>;
	onChange: (value: T) => void;
}) {
	return (
		// ui-fix-panels (QA #21): each option as wide as its word (equal thirds cut "TRANSCRIPT" to "TRANSCRI")
		<div className="bg-surface border-line flex gap-0.5 rounded-[12px] border p-0.5">
			{options.map((item) => (
				<button
					key={item.id}
					type="button"
					title={item.label}
					aria-pressed={value === item.id}
					onClick={() => onChange(item.id)}
					className={cn(
						"rc-mono min-w-0 flex-auto cursor-pointer rounded-[10px] px-1.5 py-1.5 text-[0.64rem] whitespace-nowrap uppercase tracking-[0.05em] transition-colors",
						value === item.id ? "bg-[#2a2a31] text-bone" : "text-fog hover:text-bone",
					)}
				>
					{item.label}
				</button>
			))}
		</div>
	);
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "stale"; children: ReactNode }) {
	return (
		<p
			className={cn(
				"rounded-[10px] border px-3 py-2 text-[0.72rem] leading-snug",
				tone === "error" && "border-[#e5484d]/40 text-[#ff8a8e]",
				tone === "stale" && "border-stale/40 text-stale",
				tone === "info" && "border-line text-fog",
			)}
		>
			{children}
		</p>
	);
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
	return <div className={cn("bg-surface border-line rounded-[14px] border p-3", className)}>{children}</div>;
}
