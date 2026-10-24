import { type RefObject, useLayoutEffect, useRef } from "react";

interface UseInitialScrollBottomProps {
	tracksScrollRef: RefObject<HTMLDivElement | null>;
	trackLabelsScrollRef: RefObject<HTMLDivElement | null>;
	onAfterScroll?: () => void;
	/** Defers the scroll until there is at least one track to measure against. */
	isReady: boolean;
	/**
	 * Scroll positions where a lane starts at the top of the viewport (0 first). The initial scroll snaps DOWN to
	 * the last stop that fits, so the top-most visible lane is whole and its label is never half under the sticky
	 * ruler / JUDGE row (QA 2026-10-20 #20). Omitted → the exact bottom, as upstream.
	 */
	getLaneStops?: () => number[];
}

/**
 * The initial vertical scroll: as far down as the lanes go, snapped back to a lane boundary.
 * Pure; exported for tests (timeline/__tests__/initial-scroll.test.ts).
 */
export function initialTracksScrollTop({
	maxScrollTop,
	laneStops,
}: {
	maxScrollTop: number;
	laneStops?: number[];
}): number {
	if (!(maxScrollTop > 0)) return 0;
	if (!laneStops || laneStops.length === 0) return maxScrollTop;
	let best = 0;
	for (const stop of laneStops) {
		if (stop <= maxScrollTop + 0.5 && stop > best) best = stop;
	}
	return Math.min(best, maxScrollTop);
}

/**
 * Scrolls the timeline tracks viewport down once on mount (to the last lane boundary that fits).
 * useLayoutEffect runs synchronously after React commits the DOM but before
 * the browser paints, so the initial scroll position is never visible.
 *
 * The label column may not be able to follow yet (its header height is measured a frame later, QA #1): the
 * timeline re-syncs it whenever either column resizes (timeline/components/index.tsx, useFollowerResync).
 */
export function useInitialScrollBottom({
	tracksScrollRef,
	trackLabelsScrollRef,
	onAfterScroll,
	isReady,
	getLaneStops,
}: UseInitialScrollBottomProps): void {
	const hasScrolledRef = useRef(false);

	useLayoutEffect(() => {
		if (!isReady || hasScrolledRef.current) return;

		const viewport = tracksScrollRef.current;
		if (!viewport) return;

		const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
		if (maxScrollTop <= 0) return;

		const scrollTop = initialTracksScrollTop({
			maxScrollTop,
			laneStops: getLaneStops?.(),
		});
		viewport.scrollTop = scrollTop;

		if (trackLabelsScrollRef.current) {
			// Follow what the tracks actually took (the browser may round), not the request.
			trackLabelsScrollRef.current.scrollTop = viewport.scrollTop;
		}

		onAfterScroll?.();
		hasScrolledRef.current = true;
	}, [isReady, tracksScrollRef, trackLabelsScrollRef, onAfterScroll, getLaneStops]);
}
