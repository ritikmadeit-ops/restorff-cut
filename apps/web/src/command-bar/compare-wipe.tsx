"use client";

/**
 * A minimal before/after wipe (FX-36 in the reel: the edit sweeps across the frame). The design agent's compare
 * component did not exist when this was written (apps/web/src/compare/** — swap it in when it lands). Drag or use
 * the arrow keys; it sweeps once on mount so the change is seen without touching it.
 */
import { useEffect, useRef, useState } from "react";

export function CompareWipe({ before, after, height = 260 }: { before: string | null; after: string | null; height?: number }) {
	const [pos, setPos] = useState(100);
	const boxRef = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);

	useEffect(() => {
		if (!before || !after) return;
		let raf = 0;
		const start = performance.now();
		const tick = (now: number) => {
			const k = Math.min(1, (now - start) / 1100);
			const eased = 1 - (1 - k) ** 3;
			setPos(100 - 50 * eased);
			if (k < 1) raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [before, after]);

	if (!before && !after) {
		return <div className="text-[var(--rc-fog)] font-mono text-[11px]">no frame to compare (empty timeline?)</div>;
	}
	if (!before || !after) {
		const only = (after ?? before) as string;
		return (
			<div className="flex flex-col items-center gap-1">
				<img src={only} alt={after ? "after" : "before"} style={{ height }} className="rounded-[10px] border border-[var(--rc-outline)]" />
				<span className="font-mono text-[10px] tracking-[.14em] text-[var(--rc-fog)] uppercase">{after ? "after" : "before"} only</span>
			</div>
		);
	}

	const setFromClientX = (clientX: number) => {
		const rect = boxRef.current?.getBoundingClientRect();
		if (!rect) return;
		setPos(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)));
	};

	return (
		<div
			ref={boxRef}
			role="slider"
			tabIndex={0}
			aria-label="Before and after"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(pos)}
			className="relative mx-auto w-fit cursor-ew-resize touch-none select-none overflow-hidden rounded-[10px] border border-[var(--rc-outline)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--rc-fog)]"
			style={{ height }}
			onPointerDown={(event) => {
				dragging.current = true;
				(event.target as HTMLElement).setPointerCapture?.(event.pointerId);
				setFromClientX(event.clientX);
			}}
			onPointerMove={(event) => dragging.current && setFromClientX(event.clientX)}
			onPointerUp={() => {
				dragging.current = false;
			}}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft") setPos((p) => Math.max(0, p - 5));
				if (event.key === "ArrowRight") setPos((p) => Math.min(100, p + 5));
			}}
		>
			<img src={after} alt="after" draggable={false} className="block h-full w-auto" />
			<img
				src={before}
				alt="before"
				draggable={false}
				className="absolute inset-0 block h-full w-auto"
				style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
			/>
			<div className="absolute top-0 bottom-0 w-px bg-[var(--rc-bone)]" style={{ left: `${pos}%` }} />
			<span className="absolute top-1.5 left-1.5 rounded-full bg-black/60 px-1.5 py-0.5 font-mono text-[9px] tracking-[.14em] text-[var(--rc-bone)] uppercase">
				before
			</span>
			<span className="absolute top-1.5 right-1.5 rounded-full bg-black/60 px-1.5 py-0.5 font-mono text-[9px] tracking-[.14em] text-[var(--rc-bone)] uppercase">
				after
			</span>
		</div>
	);
}
