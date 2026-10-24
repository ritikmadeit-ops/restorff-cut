import { describe, expect, test } from "bun:test";
import { cutChanged, type ProjectSnapshot, snapshotFingerprint, stripForCommit } from "@/sync/snapshot";

// ui-fix-timeline, QA 2026-10-20 #3: browsing pushed "edit: no changes to the cut" commits. The phantom commit
// 07a8480 differed from its parent 28cb786 in scenes.0.updatedAt, metadata.updatedAt and timelineViewState only.

function project(): ProjectSnapshot {
	return {
		metadata: {
			id: "p1",
			name: "Halcyon Cold Brew / AD-014",
			duration: 1_440_000,
			createdAt: "2026-10-20T12:00:00.000Z",
			updatedAt: "2026-10-20T12:18:48.864Z",
			restorff: { brand: "Halcyon Cold Brew" },
		},
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [{ id: "trk-text", name: "TEXT", type: "text", elements: [{ id: "el-1", type: "text", startTime: 0, duration: 240_000, params: { content: "ONE POUR." } }] }],
					main: { id: "trk-main", name: "V1 A-ROLL", type: "video", elements: [] },
					audio: [],
				},
				bookmarks: [],
				createdAt: "2026-10-20T12:00:00.000Z",
				updatedAt: "2026-10-20T12:18:48.864Z",
			},
		],
		currentSceneId: "scene-main",
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 } },
		version: 32,
		timelineViewState: { zoomLevel: 1, scrollLeft: 0, playheadTime: 0 },
	};
}

describe("snapshotFingerprint ignores what changes without an edit", () => {
	test("the 07a8480 diff (scene + project save times, dropped view state) is the same cut", () => {
		const parent = project();
		const browsed = project();
		browsed.scenes[0].updatedAt = "2026-10-20T18:41:45.374Z";
		browsed.metadata.updatedAt = "2026-10-20T18:41:46.182Z";
		delete browsed.timelineViewState;
		expect(snapshotFingerprint(browsed)).toBe(snapshotFingerprint(parent));
	});

	test("thumbnail, duration, creation times and scroll/zoom do not count", () => {
		const a = project();
		const b = project();
		b.metadata.thumbnail = "data:image/jpeg;base64,AAAA";
		b.metadata.duration = 1_500_000;
		b.metadata.createdAt = "2026-10-21T00:00:00.000Z";
		b.scenes[0].createdAt = "2026-10-21T00:00:00.000Z";
		b.timelineViewState = { zoomLevel: 3, scrollLeft: 900, playheadTime: 4 };
		expect(snapshotFingerprint(b)).toBe(snapshotFingerprint(a));
	});

	test("a real edit changes it: a moved element, a renamed project, a muted track, restorff metadata", () => {
		const base = snapshotFingerprint(project());
		const moved = project();
		(moved.scenes[0].tracks!.overlay![0].elements[0] as { startTime: number }).startTime = 12_000;
		const renamed = project();
		renamed.metadata.name = "Halcyon Cold Brew / AD-015";
		const muted = project();
		muted.scenes[0].tracks!.main!.muted = true;
		const meta = project();
		meta.metadata.restorff = { brand: "Halcyon Cold Brew", overrides: [{ rule: "R5" }] };
		for (const edited of [moved, renamed, muted, meta]) expect(snapshotFingerprint(edited)).not.toBe(base);
	});

	test("stripForCommit + fingerprint: the committed copy equals the local cut", () => {
		const local = project();
		local.metadata.thumbnail = "data:image/jpeg;base64,AAAA";
		expect(snapshotFingerprint(stripForCommit(local))).toBe(snapshotFingerprint(local));
	});
});

describe("cutChanged", () => {
	test("unchanged when it matches the synced fingerprint", () => {
		const local = project();
		expect(cutChanged({ local, syncedFingerprint: snapshotFingerprint(local), baseFingerprint: null })).toBe(false);
	});

	test("unchanged when it matches the base commit although the synced fingerprint is stale (older hash)", () => {
		const local = project();
		const base = project();
		base.timelineViewState = undefined;
		expect(
			cutChanged({ local, syncedFingerprint: "0000stale00000", baseFingerprint: snapshotFingerprint(base) }),
		).toBe(false);
	});

	test("changed only when it differs from both", () => {
		const local = project();
		(local.scenes[0].tracks!.overlay![0].elements[0] as { duration: number }).duration = 120_000;
		const base = snapshotFingerprint(project());
		expect(cutChanged({ local, syncedFingerprint: base, baseFingerprint: base })).toBe(true);
		expect(cutChanged({ local, syncedFingerprint: null, baseFingerprint: null })).toBe(true);
	});
});
