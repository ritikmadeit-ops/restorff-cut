/**
 * mcp-review agent, 2026-10-20: the pure parts behind MCP revise / storyboard / saved-styles sync. Fictional data
 * (Halcyon Cold Brew). Run: cd apps/web && bun test src/server/__tests__/review.test.ts
 */
import { describe, expect, test } from "bun:test";
import { apply, resolveSentence, type Op, type Project } from "@restorffcut/timeline-ops";
import { emptyLibrary, saveStyle, type SavedStyle } from "@restorffcut/styles";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { buildStoryboard, rowAt, storyboardApproval } from "../storyboard-rows";
import { distributeWords, parseAddress, parseTextChange, planRevision } from "../storyboard-revise";
import { compareSemver, mergeHistory, mergeLibraries } from "../styles-store-merge";

const T = 120_000;

/** A 12 s talking head with a B-roll cut-in at 5–7 s, captions with two pauses, a title pop, a music bed. */
function halcyon(): Project {
	const video = (id: string, name: string, media: string, start: number, dur: number) => ({
		id,
		type: "video",
		name,
		mediaId: media,
		startTime: start * T,
		duration: dur * T,
		trimStart: 0,
		trimEnd: (20 - dur) * T,
		sourceDuration: 20 * T,
		isSourceAudioEnabled: true,
		hidden: false,
		params: { "transform.positionX": 0, "transform.positionY": 0, "transform.scaleX": 1, "transform.scaleY": 1, "transform.rotate": 0, opacity: 1, blendMode: "normal", volume: 0, muted: false },
	});
	const caption = (id: string, start: number, end: number, text: string) => ({
		id,
		type: "text",
		name: text,
		startTime: start * T,
		duration: (end - start) * T,
		trimStart: 0,
		trimEnd: 0,
		params: { content: text, fontSize: 5, color: "#ffffff", fontWeight: "bold" },
		restorff: { role: "caption" },
	});
	return {
		metadata: {
			id: "proj-halcyon-review",
			name: "Halcyon Cold Brew / AD-031",
			duration: 12 * T,
			createdAt: "2026-10-20T09:00:00.000Z",
			updatedAt: "2026-10-20T09:00:00.000Z",
			restorff: {
				opsVersion: "ops@1",
				pending: [],
				media: [
					{ id: "media-aroll", kind: "video", name: "halcyon-aroll.mp4", duration: 20 * T, width: 1080, height: 1920, fps: 30, hasAudio: true, author: "user" },
					{ id: "media-broll", kind: "video", name: "halcyon-pour.mp4", duration: 20 * T, width: 1080, height: 1920, fps: 30, hasAudio: false, author: "user" },
				],
			},
		},
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [
						{ id: "trk-text", name: "TEXT", type: "text", hidden: false, elements: [{ ...caption("pop-1", 0.3, 1.8, "COLD. BREWED."), restorff: { role: "text_pop" } }] },
						{
							id: "trk-captions",
							name: "CAPTIONS",
							type: "text",
							hidden: false,
							restorff: { role: "caption" },
							elements: [
								caption("c1", 0.5, 1.5, "Halcyon cold brew."),
								caption("c2", 2.5, 3.4, "Steeped for"),
								caption("c3", 3.4, 4.0, "twenty hours."),
								caption("c4", 5.2, 6.4, "Never bitter."),
								caption("c5", 8.0, 9.0, "Try it today."),
							],
						},
						{ id: "trk-broll", name: "V2 B-ROLL", type: "video", hidden: false, muted: false, elements: [video("el-broll", "S04 pour", "media-broll", 5, 2)] },
					],
					main: { id: "trk-main", name: "V1 A-ROLL", type: "video", hidden: false, muted: false, elements: [video("el-aroll", "S01 talking head", "media-aroll", 0, 12)] },
					audio: [{ id: "trk-music", name: "MUSIC", type: "audio", muted: false, elements: [{ id: "el-music", type: "audio", sourceType: "upload", name: "Halcyon bed", mediaId: "media-music", startTime: 0, duration: 12 * T, trimStart: 0, trimEnd: 0, sourceDuration: 60 * T, params: { volume: -6, muted: false } }] }],
				},
				bookmarks: [],
				createdAt: "2026-10-20T09:00:00.000Z",
				updatedAt: "2026-10-20T09:00:00.000Z",
			},
		],
		currentSceneId: "scene-main",
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 }, canvasSizeMode: "preset", background: { type: "color", color: "#000000" } },
		version: 31,
		timelineViewState: { zoomLevel: 1, scrollLeft: 0, playheadTime: 0 },
	} as unknown as Project;
}

const snap = (project: Project) => project as unknown as ProjectSnapshot;
const applyOk = (project: Project, ops: Op[]) => {
	const result = apply(project, ops, { seed: "test", mode: "atomic" });
	expect(result.conflicts).toEqual([]);
	return result.project;
};

function style(id: string, version: string, updated: string, triggers = ["halcyon house look"]): SavedStyle {
	return {
		id,
		kind: "edit-style",
		stage: "edit",
		version,
		title: id,
		instructions: "test",
		licence: "private",
		visibility: "private",
		inputs: ["timeline"],
		outputs: { schema: "ops@1" },
		params: {},
		checks: [],
		triggers,
		steps: [{ kind: "op", op: { op: "grade", target: "all", preset: "warm-morning" } }],
		origin: null,
		created_at: "2026-10-20T08:00:00.000Z",
		updated_at: updated,
	};
}

describe("storyboard rows", () => {
	test("rows partition the runtime: no gaps, no overlaps, every caption in exactly one row", () => {
		const board = buildStoryboard(snap(halcyon()));
		expect(board.rows.length).toBeGreaterThan(3);
		expect(board.rows[0]?.start).toBe(0);
		expect(board.rows[board.rows.length - 1]?.end).toBe(12);
		for (let i = 1; i < board.rows.length; i++) expect(board.rows[i]?.start).toBe(board.rows[i - 1]?.end as number);
		const ids = board.rows.flatMap((row) => row.caption_ids).sort();
		expect(ids).toEqual(["c1", "c2", "c3", "c4", "c5"]);
	});
	test("a B-roll cut-in is its own row with the A-roll under it; the title is emphasis; the bed is a sound cue", () => {
		const board = buildStoryboard(snap(halcyon()));
		const cutIn = rowAt(board, 5.5);
		expect(cutIn?.shot.role).toBe("B-ROLL");
		expect(cutIn?.shot.under?.element_id).toBe("el-aroll");
		expect(board.rows[0]?.emphasis).toEqual(["COLD. BREWED."]);
		expect(board.rows[0]?.sound_cue).toContain("Halcyon bed");
		expect(board.rows[0]?.line).toBe("Halcyon cold brew.");
	});
	test("approval goes stale when the storyboard changes", () => {
		const project = halcyon();
		const board = buildStoryboard(snap(project));
		(project.metadata as unknown as { restorff: Record<string, unknown> }).restorff.storyboard = {
			approved: true, approved_at: "2026-10-20T09:00:00.000Z", approved_by: "claude", commit: "x", hash: board.hash, rows: board.rows.length,
		};
		expect(storyboardApproval(snap(project)).status).toBe("approved");
		const edited = applyOk(project, [{ op: "set", author: "claude", el: "c4", prop: "text", value: "Never burnt." }]);
		expect(storyboardApproval(snap(edited)).status).toBe("stale");
	});
});

describe("revise planner", () => {
	test("nothing addressed: exactly the command bar's ops", () => {
		const project = halcyon();
		const plan = planRevision({ sentence: "tighter cut, bigger captions", snapshot: snap(project), library: emptyLibrary() });
		const intent = resolveSentence("tighter cut, bigger captions", { project, author: "claude" });
		expect(plan.ops).toEqual(intent.ops);
		expect(plan.understood).toBe(true);
		applyOk(project, plan.ops);
	});
	test("make it moody picks the built-in preset", () => {
		const plan = planRevision({ sentence: "make it moody", snapshot: snap(halcyon()), library: emptyLibrary() });
		expect(plan.preset).toMatchObject({ kind: "builtin", id: "moody-captions" });
	});
	test("change the beat N caption: only that beat's captions change", () => {
		const project = halcyon();
		const board = buildStoryboard(snap(project));
		const beat = board.rows.findIndex((row) => row.caption_ids.includes("c4")) + 1;
		const plan = planRevision({ sentence: `change the beat ${beat} caption to "Never bitter. Never burnt."`, snapshot: snap(project), library: emptyLibrary() });
		expect(plan.ops).toEqual([{ op: "set", author: "claude", el: "c4", prop: "text", value: "Never bitter. Never burnt." }]);
		applyOk(project, plan.ops);
	});
	test("bigger captions on one beat touches only that beat's caption clips", () => {
		const project = halcyon();
		const plan = planRevision({ sentence: "bigger captions", snapshot: snap(project), library: emptyLibrary(), address: { t: 2.6 } });
		const touched = new Set(plan.ops.map((op) => (op as { el?: string }).el));
		expect([...touched].sort()).toEqual(["c2", "c3"]);
		applyOk(project, plan.ops);
	});
	test("slow down a B-roll beat keeps its length (trim then speed)", () => {
		const project = halcyon();
		const plan = planRevision({ sentence: "slow this section down", snapshot: snap(project), library: emptyLibrary(), address: { t: 5.5 } });
		expect(plan.ops.map((op) => op.op)).toContain("trim");
		const after = applyOk(project, plan.ops);
		const broll = after.scenes[0]?.tracks.overlay.find((track) => track.id === "trk-broll");
		const total = (broll?.elements ?? []).reduce((sum, el) => sum + el.duration, 0);
		expect(total).toBe(2 * T);
	});
	test("slowing the talking head is refused with a hint", () => {
		const plan = planRevision({ sentence: "slow this down", snapshot: snap(halcyon()), library: emptyLibrary(), address: { t: 0.8 } });
		expect(plan.ops).toEqual([]);
		expect(plan.not_understood[0]?.send.tool).toBe("timeline_ops");
	});
	test("tighter on one beat removes pauses inside it only", () => {
		const project = halcyon();
		const board = buildStoryboard(snap(project));
		const whole = planRevision({ sentence: "tighter cut", snapshot: snap(project), library: emptyLibrary() });
		const scoped = planRevision({ sentence: "tighter cut", snapshot: snap(project), library: emptyLibrary(), address: { beat: board.rows.length } });
		expect(scoped.ops.length).toBeLessThan(whole.ops.length);
		if (scoped.ops.length) applyOk(project, scoped.ops);
	});
	test("make the ending loop: not understood, with raw ops to send", () => {
		const plan = planRevision({ sentence: "make the ending loop", snapshot: snap(halcyon()), library: emptyLibrary() });
		expect(plan.scope?.label).toContain("last");
		expect(plan.ops).toEqual([]);
		expect(plan.not_understood[0]?.send.example_ops[0]).toMatchObject({ op: "insert" });
	});
	test("a saved style's trigger wins first, the rest still resolves", () => {
		const library = saveStyle(emptyLibrary(), style("halcyon-house-look", "1.0.0", "2026-10-20T08:00:00.000Z")).library;
		const project = halcyon();
		const plan = planRevision({ sentence: "halcyon house look, captions at the top", snapshot: snap(project), library });
		expect(plan.preset).toMatchObject({ kind: "saved", id: "halcyon-house-look" });
		expect(plan.ops[0]).toMatchObject({ op: "apply_style", preset_id: "restorff/user/halcyon-house-look" });
		expect(plan.ops.some((op) => op.op === "set_caption_style")).toBe(true);
		const result = apply(project, plan.ops, { seed: "t", mode: "atomic", styles: plan.styles });
		expect(result.conflicts).toEqual([]);
	});
	test("address words and text changes parse", () => {
		expect(parseAddress("change the beat 23 caption").address.beat).toBe(23);
		expect(parseAddress("warmer at 12.5 s").address.t).toBe(12.5);
		expect(parseTextChange("change the caption to 'cold brew, no compromise'")?.text).toBe("cold brew, no compromise");
		expect(parseTextChange("move the captions to the top")).toBeNull();
		expect(distributeWords(["Steeped for twenty", "hours."], "Steeped twenty hours, never rushed.")).toEqual(["Steeped twenty hours, never", "rushed."]);
	});
});

describe("saved-styles merge", () => {
	test("higher version wins, the loser is kept as an older version", () => {
		const server = { format: "restorffcut-styles@1", styles: { a: style("a", "1.1.0", "2026-10-20T09:00:00.000Z") }, versions: {}, dismissed: [] };
		const browser = { format: "restorffcut-styles@1", styles: { a: style("a", "1.0.0", "2026-10-20T08:00:00.000Z"), b: style("b", "1.0.0", "2026-10-20T08:00:00.000Z", ["b"]) }, versions: {}, dismissed: ["x"] };
		const merged = mergeLibraries(server, browser);
		expect(merged.library.styles.a?.version).toBe("1.1.0");
		expect(merged.library.versions.a?.map((v) => v.version)).toEqual(["1.0.0"]);
		expect(merged.taken).toEqual(["b"]);
		expect(merged.library.dismissed).toEqual(["x"]);
	});
	test("a tombstone drops a style unless it was saved after the delete", () => {
		const browser = { styles: { a: style("a", "1.0.0", "2026-10-20T08:00:00.000Z"), b: style("b", "1.0.0", "2026-10-20T10:00:00.000Z", ["b"]) } };
		const merged = mergeLibraries({}, browser, { a: "2026-10-20T09:00:00.000Z", b: "2026-10-20T09:00:00.000Z" });
		expect(Object.keys(merged.library.styles)).toEqual(["b"]);
		expect(merged.dropped).toEqual(["a"]);
	});
	test("semver and history", () => {
		expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
		expect(compareSemver("x", "0.0.0")).toBe(0);
		const r = { sentence: "bigger captions", ops: [], at: "2026-10-20T09:00:00.000Z", projectId: "p" };
		expect(mergeHistory([r], [r, { ...r, at: "2026-10-20T09:01:00.000Z" }]).length).toBe(2);
	});
});
