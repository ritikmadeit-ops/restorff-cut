import { describe, expect, test } from "bun:test";
import { initialTracksScrollTop } from "@/timeline/hooks/use-initial-scroll-bottom";

// ui-fix-timeline, QA 2026-10-20 #20: the initial scroll stops where a lane starts, so the top-most visible lane is
// whole under the sticky ruler / JUDGE row.

describe("initialTracksScrollTop", () => {
	test("no overflow → 0", () => {
		expect(initialTracksScrollTop({ maxScrollTop: 0, laneStops: [0, 32] })).toBe(0);
		expect(initialTracksScrollTop({ maxScrollTop: -4 })).toBe(0);
	});

	test("without stops: the exact bottom (upstream behaviour)", () => {
		expect(initialTracksScrollTop({ maxScrollTop: 54.4 })).toBe(54.4);
	});

	test("six artboard lanes 12 px too tall → stays at 0, TEXT whole under JUDGE", () => {
		// TEXT 26 · CAPTIONS 22 · B-ROLL 30 · A-ROLL 30 · MUSIC 22 · SFX 18, gap 6.
		expect(initialTracksScrollTop({ maxScrollTop: 12, laneStops: [0, 32, 60, 96, 132, 160] })).toBe(0);
	});

	test("snaps down to the last lane start that fits", () => {
		expect(initialTracksScrollTop({ maxScrollTop: 72, laneStops: [0, 32, 60, 96] })).toBe(60);
		expect(initialTracksScrollTop({ maxScrollTop: 96, laneStops: [0, 32, 60, 96] })).toBe(96);
	});
});
