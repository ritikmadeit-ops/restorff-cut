import { type RefObject, useEffect } from "react";

/**
 * Re-runs `sync` whenever one of the observed boxes (or its first child, the scrolled content) changes size.
 *
 * Why (QA 2026-10-20 #1, ui-fix-timeline): the track-label column follows the tracks' vertical scroll only on wheel
 * and scroll events. On open, the tracks scroll to the bottom while the label column's header is still 2 px tall
 * (its height is measured a frame later), so the labels clamp short; when the header grows nothing scrolls, and the
 * labels stayed one lane off (MEASURED 54.4 vs 15.2 px) until the first wheel. Resizes now re-sync the followers.
 */
export function useFollowerResync({
	refs,
	sync,
}: {
	refs: Array<RefObject<HTMLElement | null>>;
	sync: () => void;
}): void {
	useEffect(() => {
		if (typeof ResizeObserver === "undefined") return;
		let frame: number | null = null;
		const observer = new ResizeObserver(() => {
			// One sync per frame, after the layout that triggered it.
			if (frame !== null) return;
			frame = requestAnimationFrame(() => {
				frame = null;
				sync();
			});
		});
		for (const ref of refs) {
			const el = ref.current;
			if (!el) continue;
			observer.observe(el);
			if (el.firstElementChild) observer.observe(el.firstElementChild);
		}
		return () => {
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
		};
		// refs are stable useRef objects; the observed nodes mount once with the timeline.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sync, ...refs]);
}
