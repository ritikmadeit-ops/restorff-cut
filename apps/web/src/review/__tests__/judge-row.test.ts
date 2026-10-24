import { describe, expect, test } from "bun:test";
import { clusterMarkers, dedupeMarkers, type RowComment, resolveFindingTarget } from "@/review/judge-row";

// ui-fix-timeline, QA 2026-10-20 #2 (inspector empties) and #10 (stacked / duplicate markers).

const tracks = [
	{ id: "trk-text", elements: [{ id: "el-endcard" }] },
	{ id: "trk-motion", elements: [{ id: "el-typeon" }] },
	{ id: "trk-broll", elements: [{ id: "el-kettle" }] },
];

describe("resolveFindingTarget", () => {
	test("the pinned lane when it holds the element", () => {
		expect(resolveFindingTarget(tracks, { track_id: "trk-broll", element_id: "el-kettle" })).toEqual({
			trackId: "trk-broll",
			elementId: "el-kettle",
		});
	});

	test("the lane the element lives on when the pin is wrong (R5 pinned to V2 B-ROLL, element on MOTION)", () => {
		expect(resolveFindingTarget(tracks, { track_id: "trk-broll", element_id: "el-typeon" })).toEqual({
			trackId: "trk-motion",
			elementId: "el-typeon",
		});
	});

	test("null for a gone element or no element (the selection is left alone)", () => {
		expect(resolveFindingTarget(tracks, { track_id: "trk-broll", element_id: "el-replaced" })).toBeNull();
		expect(resolveFindingTarget(tracks, { track_id: "trk-text", element_id: null })).toBeNull();
	});
});

function c(id: string, patch: Partial<RowComment> = {}): RowComment {
	return {
		id,
		time_s: 0,
		time_end_s: null,
		rule_id: "R3",
		severity: "should",
		status: "open",
		body: `${id} body`,
		created_at: "2026-10-20T12:00:00.000Z",
		...patch,
	};
}

describe("dedupeMarkers", () => {
	test("the same R5 under two ids is drawn once; the live copy wins and the other is listed to resolve with it", () => {
		const body = '"Type-on title" holds for 3.7 s. → cut "Type-on title" to 3 s';
		const stale = c("old", { rule_id: "R5", time_s: 21.09, time_end_s: 24.8, body, created_at: "2026-10-20T12:30:00.000Z" });
		const live = c("new", { rule_id: "R5", time_s: 21.09, time_end_s: 24.8, body, created_at: "2026-10-20T12:00:00.000Z" });
		const out = dedupeMarkers([stale, live], (m) => m.id === "new");
		expect(out).toHaveLength(1);
		expect(out[0].comment.id).toBe("new");
		expect(out[0].duplicateIds).toEqual(["old"]);
	});

	test("without liveness: open beats resolved, then the newest", () => {
		const a = c("a", { body: "same", status: "resolved", created_at: "2026-10-21T00:00:00.000Z" });
		const b = c("b", { body: "same", created_at: "2026-10-20T00:00:00.000Z" });
		const d = c("d", { body: "same", created_at: "2026-10-20T06:00:00.000Z" });
		const out = dedupeMarkers([a, b, d]);
		expect(out[0].comment.id).toBe("d");
		expect(out[0].duplicateIds).toEqual(["b", "a"]);
	});

	test("different rules, times or words at the same spot stay separate", () => {
		const out = dedupeMarkers([c("r3"), c("r1", { rule_id: "R1" }), c("r3b", { time_s: 0.5 }), c("r3c", { body: "other" })]);
		expect(out.map((d) => d.comment.id)).toEqual(["r3", "r1", "r3b", "r3c"]);
	});
});

describe("clusterMarkers", () => {
	const px = (m: RowComment) => m.time_s * 50;

	test("four findings at 0:00 are one marker, loudest first", () => {
		const items = [
			c("r3"),
			c("r1", { rule_id: "R1" }),
			c("r12", { rule_id: "R12", severity: "info" }),
			c("r4", { rule_id: "R4", severity: "must" }),
		];
		const clusters = clusterMarkers(items, px, 14);
		expect(clusters).toHaveLength(1);
		expect(clusters[0].members.map((m) => m.id)).toEqual(["r4", "r3", "r1", "r12"]);
		expect(clusters[0].key).toBe("r1 r12 r3 r4");
	});

	test("squares closer than their size merge; farther ones do not", () => {
		const items = [c("a", { time_s: 1 }), c("b", { time_s: 1.2 }), c("d", { time_s: 1.5 }), c("e", { time_s: 3 })];
		// 50 px/s: a 50, b 60 (overlaps a), d 75 (25 from a: separate), e 150.
		expect(clusterMarkers(items, px, 14).map((k) => k.members.map((m) => m.id).sort())).toEqual([["a", "b"], ["d"], ["e"]]);
	});

	test("resolved members sort after open ones", () => {
		const clusters = clusterMarkers([c("done", { status: "resolved", severity: "must" }), c("open", { severity: "info" })], px, 14);
		expect(clusters[0].members.map((m) => m.id)).toEqual(["open", "done"]);
	});
});
