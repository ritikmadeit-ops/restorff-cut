/**
 * revise-v2 agent, 2026-10-20: the pure planners behind one-sentence revisions — spans, compositions, honest
 * accounting, beats with lines, caption chunks rewritten in place, version names and composition diffs. Fictional data
 * (Halcyon Cold Brew). Run: cd apps/web && bun test src/server/__tests__/revise-v2.test.ts
 */
import { describe, expect, test } from "bun:test";
import { apply, type Op, type Project } from "@restorffcut/timeline-ops";
import { emptyLibrary } from "@restorffcut/styles";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { captionLayers, planChunkRebuild } from "../storyboard-captions";
import { classify, compositionDiff, listCompositions, manifestOf, nudgeComposition, nudgeWords, pickCompositions, sourceLineDiff } from "../storyboard-compositions";
import { gradeLayerPieces, milestoneOf, planRevision } from "../storyboard-revise";
import { buildStoryboard } from "../storyboard-rows";
import { parseScope, resolveSpan, splitSentence } from "../storyboard-scope";
import { captionFixesOf } from "../storyboard-transcripts";
import { commitKind } from "../storyboard-versions";

const T = 120_000;

const KINETIC = `<!doctype html><html><head><script type="application/json" id="params">${JSON.stringify({
	name: "kinetic-type",
	title: "Kinetic type",
	description: "words one per beat",
	duration: 3,
	size: [1080, 1920],
	tags: ["kinetic", "type", "words"],
	params: {
		lines: { type: "list", default: ["COLD"] },
		accent: { type: "color", default: "#F6FF00" },
		ease: { type: "easing", default: "snappy" },
		scale: { type: "number", default: 1, min: 0.5, max: 2, step: 0.01 },
		speed: { type: "number", default: 1, min: 0.25, max: 4, step: 0.01 },
	},
})}</script></head><body><div id="stage"></div>
<script>RC.composition({ build: function () {}, render: function () {} });</script></body></html>`;

const TYPE_ON = manifestOf(
	`<script type="application/json" id="params">${JSON.stringify({ name: "type-on", title: "Type-on title", tags: ["title", "chapter", "type"], params: { title: { type: "text" }, scale: { type: "number", default: 1, min: 0.5, max: 2, step: 0.01 }, accent: { type: "color", default: "#F6FF00" } } })}</script>`,
);
const COUNTER = manifestOf(
	`<script type="application/json" id="params">${JSON.stringify({ name: "counter", title: "Counter", tags: ["number", "counter", "stat"], description: "a number counts up under a title", params: { to: { type: "number" }, scale: { type: "number", default: 1, min: 0.5, max: 2, step: 0.01 }, accent: { type: "color", default: "#F6FF00" } } })}</script>`,
);

/**
 * 12 s: A-roll 0–12, a voice-over-free talking head with LAYERED captions (base + words, tagged like the captions
 * tool tags them), a custom kinetic title (2–4 s), a library type-on title (5–7 s), a counter (8–10 s), a GRADE layer.
 */
function halcyon(): Project {
	const caption = (id: string, start: number, end: number, text: string) => ({
		id,
		type: "text",
		name: `Caption ${id}`,
		startTime: start * T,
		duration: (end - start) * T,
		trimStart: 0,
		trimEnd: 0,
		params: { content: text, fontSize: 5, color: "#FFFFFF", fontWeight: "bold", "transform.positionY": 54 },
		restorff: {
			captionLayer: "base",
			role: "caption",
			caption: { style: "word-pop", words: text.split(" ").map((word, i, all) => ({ text: word, start: ((end - start) * i) / all.length, end: ((end - start) * (i + 1)) / all.length })) },
		},
	});
	const word = (id: string, start: number, end: number, text: string) => ({ id, type: "text", name: `w ${text}`, startTime: start * T, duration: (end - start) * T, trimStart: 0, trimEnd: 0, params: { content: text, fontSize: 5, "background.enabled": true }, restorff: { captionLayer: "words" } });
	const motion = (id: string, start: number, dur: number, composition: Record<string, unknown>) => ({ id, type: "video", name: String(composition.title ?? composition.name), mediaId: `m-${id}`, startTime: start * T, duration: dur * T, trimStart: 0, trimEnd: 0, sourceDuration: dur * T, params: {}, restorff: { composition } });
	const project = {
		metadata: { id: "proj-halcyon-v2", name: "Halcyon Cold Brew / AD-032", duration: 12 * T, createdAt: "2026-10-20T09:00:00.000Z", updatedAt: "2026-10-20T09:00:00.000Z", restorff: { opsVersion: "ops@1", pending: [], media: [] } },
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [
						{
							id: "trk-motion",
							name: "MOTION",
							type: "video",
							hidden: false,
							muted: false,
							elements: [
								motion("k1", 2, 2, { custom: true, name: "kinetic-type", title: "Kinetic type", source: KINETIC, props: { lines: ["NEVER", "BITTER"] }, hash: "h1", duration: 2 }),
								motion("t1", 5, 2, { name: "type-on", props: { title: "Grind coarse" }, hash: "h2", duration: 2 }),
								motion("c1", 8, 2, { name: "counter", props: { to: 18 }, hash: "h3", duration: 2 }),
							],
						},
						{ id: "trk-text", name: "TEXT", type: "text", hidden: false, elements: [] },
						{ id: "trk-words", name: "CAPTION WORDS", type: "text", hidden: false, restorff: { captionLayer: "words" }, elements: [word("w1", 0.5, 1.0, "Halcyon"), word("w2", 1.0, 1.5, "cold"), word("w5", 6.0, 6.6, "Never")] },
						{
							id: "trk-captions",
							name: "CAPTIONS",
							type: "text",
							hidden: false,
							restorff: { captionLayer: "base" },
							elements: [caption("cap1", 0.5, 1.5, "Halcyon cold"), caption("cap2", 1.5, 2.4, "brew, slow."), caption("cap3", 6.0, 7.2, "Never bitter."), caption("cap4", 9.0, 10.5, "Try it today.")],
						},
					],
					main: {
						id: "trk-main",
						name: "V1 A-ROLL",
						type: "video",
						hidden: false,
						muted: false,
						elements: [{ id: "aroll", type: "video", name: "S01 talking head", mediaId: "media-aroll", startTime: 0, duration: 12 * T, trimStart: 0, trimEnd: 8 * T, sourceDuration: 20 * T, isSourceAudioEnabled: true, hidden: false, params: { volume: 0, muted: false } }],
					},
					audio: [],
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
	// a real GRADE layer, made by the reducer
	const graded = apply(project, [{ op: "grade", author: "claude", target: "all", preset: "warm-morning" }], { seed: "grade", mode: "atomic" });
	expect(graded.conflicts).toEqual([]);
	return graded.project;
}

const snap = (project: Project) => project as unknown as ProjectSnapshot;
const comps = (project: Project) => listCompositions(snap(project), { "type-on": TYPE_ON, counter: COUNTER });
const plan = (project: Project, sentence: string, address?: { beat?: number; element_id?: string; t?: number }) =>
	planRevision({ sentence, snapshot: snap(project), library: emptyLibrary(), compositions: comps(project), address, timelineId: "tl" });
const applyOk = (project: Project, ops: Op[]) => {
	const result = apply(project, ops, { seed: "test", mode: "atomic" });
	expect(result.conflicts).toEqual([]);
	return result.project;
};

describe("clauses and spans", () => {
	test("quotes are protected: a comma inside them never splits a clause", () => {
		const split = splitSentence('Make it warmer, and change the beat 3 caption to "Estate to roastery, to bottling"');
		expect(split.clauses).toEqual(["make it warmer", "change the beat 3 caption to ⟦q0⟧"]);
		expect(split.quotes).toEqual(["Estate to roastery, to bottling"]);
		expect(splitSentence("cooler between 10 and 20 s").clauses).toEqual(["cooler from 10 s to 20 s"]);
		expect(splitSentence("warmer at 24.6 s").clauses).toEqual(["warmer at 24.6 s"]);
	});
	test("span words: halves, from, beats, the last N s, this section", () => {
		expect(parseScope("make the second half moody").scope).toMatchObject({ kind: "fraction", from: 0.5, to: 1 });
		expect(parseScope("make the second half moody").rest).toBe("make moody");
		expect(parseScope("moody from 24.6 s to the end").scope).toMatchObject({ kind: "seconds", from: 24.6, to: null });
		expect(parseScope("beats 3-5 tighter").scope).toMatchObject({ kind: "beats", from: 3, to: 5 });
		expect(parseScope("the last 10 s cooler").scope).toMatchObject({ kind: "tail", seconds: 10 });
		expect(parseScope("slow this section down").scope).toMatchObject({ kind: "this" });
		const board = buildStoryboard(snap(halcyon()));
		const half = resolveSpan({ kind: "fraction", from: 0.5, to: 1, words: "the second half" }, board);
		expect(typeof half).not.toBe("string");
		if (typeof half !== "string") {
			expect(half.end).toBe(12);
			// no beat edge within reach of 6 s here: the half stays exact
			expect(half.start).toBe(6);
		}
		expect(typeof resolveSpan({ kind: "this", words: "this section" }, board)).toBe("string");
	});
});

describe("storyboard rows are beats", () => {
	test("layered captions (captionLayer base) give every beat its line; the word layer is not read as captions", () => {
		const board = buildStoryboard(snap(halcyon()));
		const lines = board.rows.map((row) => row.line).filter(Boolean);
		expect(lines).toContain("Halcyon cold brew, slow.");
		expect(board.rows.flatMap((row) => row.caption_ids).sort()).toEqual(["cap1", "cap2", "cap3", "cap4"]);
		expect(board.rows.every((row) => row.line_from === null || row.line_from === "captions")).toBe(true);
		const title = board.rows.find((row) => row.overlays.some((o) => o.element_id === "k1"));
		expect(title?.on_screen).toEqual(expect.arrayContaining(["NEVER", "BITTER"]));
	});
	test("voice-over words and transcript words give lines where there are no captions", () => {
		const project = halcyon();
		const scene = project.scenes[0] as unknown as { tracks: { overlay: Array<{ id: string; elements: unknown[] }>; audio: unknown[] } };
		for (const track of scene.tracks.overlay) if (track.id === "trk-captions" || track.id === "trk-words") track.elements = [];
		scene.tracks.audio.push({
			id: "trk-voice",
			name: "VOICE",
			type: "audio",
			muted: false,
			restorff: { role: "voice" },
			elements: [{ id: "vo", type: "audio", name: "VO", mediaId: "m-vo", startTime: 0.3 * T, duration: 3 * T, trimStart: 0, trimEnd: 0, params: {}, restorff: { voice: { words: [{ text: "Steeped", start: 0.1, end: 0.5 }, { text: "slow.", start: 0.5, end: 0.9 }, { text: "Never", start: 1.6, end: 1.9 }, { text: "bitter.", start: 1.9, end: 2.3 }] } } }],
		});
		const board = buildStoryboard(snap(project), { words: [{ text: "Try", start: 9, end: 9.3 }, { text: "it.", start: 9.3, end: 9.6 }] });
		const lines = board.rows.filter((row) => row.line).map((row) => `${row.line_from}:${row.line}`);
		expect(lines).toEqual(["voice:Steeped slow.", "voice:Never bitter.", "transcript:Try it."]);
		expect(board.rows.every((row) => !row.sound_cue.includes("VO"))).toBe(true);
	});
});

describe("compositions", () => {
	test("title / card / chart from name, title and tags; the counter is not a title", () => {
		const list = comps(halcyon());
		expect(classify(list.find((t) => t.element_id === "k1")!).has("title")).toBe(true);
		expect(classify(list.find((t) => t.element_id === "t1")!).has("title")).toBe(true);
		expect(classify(list.find((t) => t.element_id === "c1")!).has("title")).toBe(false);
		expect(pickCompositions("make the counter orange", list)?.targets.map((t) => t.element_id)).toEqual(["c1"]);
	});
	test("nudges use the contract's steps and clamp to the param's range", () => {
		const k1 = comps(halcyon()).find((t) => t.element_id === "k1")!;
		const bigger = nudgeComposition(k1, nudgeWords("bigger")!);
		expect(bigger.changes).toEqual([{ key: "scale", from: 1, to: 1.15, because: "bigger" }]);
		const slower = nudgeComposition({ ...k1, props: { ...k1.props, speed: 0.3 } }, nudgeWords("much slower")!);
		expect(slower.props.speed).toBe(0.25);
		expect(nudgeWords("make the big words smaller".replace("big words", " "))?.size).toBe(0.87);
	});
});

describe("revise planner v2", () => {
	test("make the titles bigger: every title composition in ONE plan, no ops, the counter untouched", () => {
		const p = plan(halcyon(), "make the titles bigger");
		expect(p.understood).toBe(true);
		expect(p.ops).toEqual([]);
		expect(p.compositions.map((c) => c.element_id).sort()).toEqual(["k1", "t1"]);
		expect(p.compositions.every((c) => c.props.scale === 1.15)).toBe(true);
		expect(p.milestone).toBe("titles bigger");
	});
	test("make the second half moody: the GRADE layer split at the span, only that span's captions restyled", () => {
		const project = halcyon();
		const p = plan(project, "make the second half moody");
		expect(p.understood).toBe(true);
		expect(p.scope?.kind).toBe("span");
		const layer = gradeLayerPieces(snap(project));
		expect(layer.length).toBe(1);
		expect(p.ops[0]).toMatchObject({ op: "split", el: layer[0]?.id });
		expect(p.ops.some((op) => op.op === "grade" && (op as { preset?: string }).preset === "moody")).toBe(true);
		// tool-built captions (layered here): rebuilt with the moody look recorded in the span's chunks only
		// (revise-safety 2026-10-21: before, chunk by chunk with p.caption_changes — wide chunks shrank to mixed sizes)
		const start = p.scope?.start ?? 0;
		expect(p.caption_changes).toEqual([]);
		expect(p.caption_looks).toEqual([expect.objectContaining({ span: { t0: start, t1: p.scope?.end }, restyle: expect.objectContaining({ font: "Bebas Neue" }) })]);
		expect(start).toBeGreaterThan(1.5); // cap1 (0.5–1.5 s) is outside the span
		expect(p.milestone).toBe("moody second half");
		const after = applyOk(project, p.ops);
		expect(gradeLayerPieces(snap(after)).length).toBe(2);
		// a whole-video grade afterwards grades every piece (the reducer's "grade all" would refuse the overlap)
		const warmer = plan(after, "warmer");
		expect(warmer.ops.length).toBe(2);
		applyOk(after, warmer.ops);
		// a whole-video style folds the layer back into one piece first
		const aesthetic = plan(after, "make it aesthetic");
		expect(aesthetic.ops[0]).toMatchObject({ op: "delete" });
		applyOk(after, aesthetic.ops);
	});
	test("honest: a clause nobody understood is never dropped, and understood is false", () => {
		const p = plan(halcyon(), "make it warmer and add some sparkle to the logo");
		expect(p.understood).toBe(false);
		expect(p.ops.some((op) => op.op === "grade")).toBe(true);
		expect(p.not_understood.map((n) => n.clause)).toEqual(["add some sparkle to the logo"]);
		expect(p.not_understood[0]?.send.steps?.[0]?.tool).toBe("effects");
		expect(p.clause_report.map((c) => c.status)).toEqual(["applied", "not_understood"]);
	});
	test("a span word nobody can place is reported, not ignored", () => {
		const p = plan(halcyon(), "make it moody after the second chorus");
		expect(p.understood).toBe(false);
		expect(p.ops).toEqual([]);
		const hook = plan(halcyon(), "make it moody after the hook");
		expect(hook.understood).toBe(true);
		expect(hook.scope?.label).toContain("after the first beat");
	});
	test("the recreation's lost clause: warmer AND the beat caption, both done", () => {
		const project = halcyon();
		const board = buildStoryboard(snap(project));
		const beat = board.rows.findIndex((row) => row.caption_ids.includes("cap3")) + 1;
		const p = plan(project, `Make it warmer, and change the beat ${beat} caption to "Never bitter, never burnt."`);
		expect(p.understood).toBe(true);
		expect(p.ops.some((op) => op.op === "grade")).toBe(true);
		// layered caption: the existing chunk is rewritten (rebuilt on its own layers), nothing is inserted
		expect(p.caption_changes).toEqual([{ id: "cap3", text: "Never bitter, never burnt." }]);
		expect(p.ops.some((op) => op.op === "insert" || op.op === "add_captions")).toBe(false);
	});
	test("addressed to a composition: speed and colour go to its params; structural asks get the get → update recipe", () => {
		const project = halcyon();
		const slow = plan(project, "Slow this section down.", { element_id: "k1" });
		expect(slow.compositions).toEqual([expect.objectContaining({ element_id: "k1", props: { speed: 0.8 } })]);
		expect(slow.ops).toEqual([]);
		const colour = plan(project, "Change the colour.", { element_id: "k1" });
		expect(colour.understood).toBe(false);
		expect(colour.not_understood[0]?.why).toContain("accent");
		const smoother = plan(project, "Make this transition smoother.", { element_id: "k1" });
		expect(smoother.not_understood[0]?.send.tool).toBe("composition");
		expect(smoother.not_understood[0]?.send.steps?.map((s) => s.arguments.action)).toEqual(["get", "update"]);
		const loop = plan(project, "Make the ending seamlessly loop into the beginning.", { element_id: "k1" });
		expect(loop.not_understood[0]?.send.steps?.[1]?.arguments.element_id).toBe("k1");
	});
	test("bigger captions on layered captions rebuild every chunk with its word layer (no set_caption_style ghost)", () => {
		const p = plan(halcyon(), "make the captions bigger and yellow");
		expect(p.understood).toBe(true);
		expect(p.ops).toEqual([]);
		// revise-safety (2026-10-21): two look changes (bigger, then yellow via the carried subject) over every chunk,
		// rebuilt in one go with the word layer — before: 8 per-chunk rebuilds in p.caption_changes
		expect(p.caption_changes).toEqual([]);
		expect(p.caption_looks.length).toBe(2);
		expect(p.caption_looks[0]?.overrides?.size).toEqual({ relative: 1.35 });
		expect(p.caption_looks.some((look) => look.restyle?.color)).toBe(true);
	});
	test("version names", () => {
		expect(milestoneOf("give it a warm morning look")).toBe("warm morning look");
		expect(milestoneOf("Make the titles bigger.")).toBe("titles bigger");
	});
});

describe("caption chunks rewritten in place", () => {
	test("a chunk's three layers are deleted and built again on the SAME tracks, tagged like the captions tool", async () => {
		const project = halcyon();
		expect(captionLayers(snap(project))?.base.id).toBe("trk-captions");
		const rebuild = await planChunkRebuild(snap(project), [{ id: "cap3", text: "Never bitter, never burnt." }], { measureMethod: "estimate" });
		if ("error" in rebuild) throw new Error(rebuild.error);
		expect(rebuild.ops.filter((op) => op.op === "delete").map((op) => (op as { el: string }).el)).toEqual(["cap3", "w5"]);
		const tracks = new Set(rebuild.ops.filter((op) => op.op === "insert").map((op) => (op as { track: string }).track));
		expect([...tracks].sort()).toEqual(["trk-captions", "trk-words"]);
		expect(rebuild.ops.some((op) => op.op === "add_track")).toBe(false);
		const after = applyOk(project, rebuild.ops);
		const overlay = (after.scenes[0] as unknown as { tracks: { overlay: Array<{ name: string }> } }).tracks.overlay;
		expect(overlay.filter((track) => track.name === "CAPTIONS").length).toBe(1);
		expect(rebuild.tags.find((tag) => (tag.restorff as { captionLayer?: string }).captionLayer === "base")?.restorff).toMatchObject({ role: "caption", caption: { style: "word-pop" } });
	});
	test("the person's words become one transcript fix per run of neighbouring chunks", () => {
		const project = halcyon();
		const fixes = captionFixesOf(snap(project), [], [
			{ id: "cap1", text: "Halcyon" },
			{ id: "cap2", text: "cold brew, slowly." },
		]);
		expect(fixes).toEqual([{ start: 0.5, from: "Halcyon cold brew, slow.", to: "Halcyon cold brew, slowly." }]);
	});
});

describe("history", () => {
	test("composition diffs: props a → b (defaults for props never stored) and source lines", () => {
		const before = halcyon();
		const after = JSON.parse(JSON.stringify(before)) as Project;
		const motion = (after.scenes[0] as unknown as { tracks: { overlay: Array<{ elements: Array<{ id: string; restorff: { composition: Record<string, unknown> } }> }> } }).tracks.overlay[0];
		const k1 = motion?.elements.find((element) => element.id === "k1");
		const t1 = motion?.elements.find((element) => element.id === "t1");
		if (!k1 || !t1) throw new Error("fixture");
		k1.restorff.composition = { ...k1.restorff.composition, props: { lines: ["NEVER", "BITTER"], scale: 1.15 }, source: `${KINETIC}\n<!-- calmer exit -->`, hash: "h1b" };
		t1.restorff.composition = { ...t1.restorff.composition, props: { title: "Grind coarse", accent: "#FF5A1F" }, hash: "h2b" };
		const diff = compositionDiff(snap(before), snap(after), { "type-on": TYPE_ON });
		expect(diff.find((d) => d.element_id === "k1")).toMatchObject({ change: "updated", props: ["scale: 1 → 1.15"], source: expect.stringContaining("+1") });
		expect(diff.find((d) => d.element_id === "t1")?.props).toEqual(["accent: #F6FF00 → #FF5A1F"]);
		expect(sourceLineDiff("a\nb", "a\nc\nd")).toEqual({ added: 2, removed: 1 });
	});
	test("approvals and gate fixes are not versions", () => {
		expect(commitKind("storyboard approved: 5 beats, 18 s", 0)).toBe("approval");
		expect(commitKind("Gate fix (SAFE): move the 9 on-screen lines up", 9)).toBe("gate_fix");
		expect(commitKind("Fix: caption shadow layer to size 3 like the text (gate SAFE x6)", 6)).toBe("gate_fix");
		expect(commitKind("make the titles bigger", 3)).toBe("edit");
	});
});
