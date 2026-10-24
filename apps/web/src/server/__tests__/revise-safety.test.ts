/**
 * revise-safety agent, 2026-10-21: never lose words, "take a pass", honest styles, one caption look per span.
 * Reproduces the warm-moody-oat Sonnet run (docs/restorff/recreations/warm-moody-oat/REPORT.md): beat 3 held nine
 * plain caption chunks (two words each, the word layer removed by an editing style) and "Change the beat 3 caption to
 * 'and Claude uses'." rewrote it to three words — six chunks deleted, 15 spoken words gone, reported as a success.
 * Fictional data (Halcyon). Run: cd apps/web && bun test src/server/__tests__/revise-safety.test.ts
 */
import { describe, expect, test } from "bun:test";
import { apply, getCaptionStyle, type Op, type Project } from "@restorffcut/timeline-ops";
import { emptyLibrary } from "@restorffcut/styles";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { captionWords, guardSnapshots, measureCaptionSpans, planWordFix, simulateFixes, wordGuard } from "../caption-words";
import { applyLookChanges } from "../captions-rebuild";
import { activeEditingStyle, parseFirstPass } from "../revise-first-pass";
import { stylePiecesLeftOut } from "../revise-pieces";
import { buildStoryboard } from "../storyboard-rows";
import { captionTextPlan, parseWordSwap, planRevision, resolveScope, textChangeOps } from "../storyboard-revise";
import { rechunk, splitChunk } from "../transcripts-timeline";

const T = 120_000;

/** Lines as the oat run's storyboard showed them (call 047), 2 words per chunk, serif look recorded by a restyle. */
const LINES: Array<{ start: number; end: number; text: string }> = [
	{ start: 0, end: 3.06, text: "Claude can fully edit videos now, and it's what's editing this video right now." },
	{ start: 3.1, end: 4.44, text: "This tool is called HyperFrames." },
	{ start: 4.46, end: 7.72, text: "It's open source and free to use, and Cloud uses it to build the animations and put" },
	{ start: 7.74, end: 8.5, text: "all the clips together." },
];

function chunksOf(line: { start: number; end: number; text: string }, size = 6) {
	const words = line.text.split(" ");
	const step = (line.end - line.start) / words.length;
	const out: Array<Record<string, unknown>> = [];
	for (let i = 0; i < words.length; i += 2) {
		const group = words.slice(i, i + 2);
		const start = line.start + i * step;
		const end = Math.min(line.end, start + group.length * step);
		out.push({
			id: `cap-${line.start}-${i}`,
			type: "text",
			name: `Caption ${i}`,
			startTime: Math.round(start * T),
			duration: Math.round((end - start) * T),
			trimStart: 0,
			trimEnd: 0,
			params: { content: group.join(" "), fontSize: size, fontFamily: "Instrument Serif", color: "#F4E9DA", "transform.positionY": -300 },
			restorff: {
				captionLayer: "base",
				role: "caption",
				caption: {
					style: "serif-box",
					words: group.map((text, k) => ({ text, start: k * step, end: (k + 1) * step })),
					look: { highlight: "none", blur_in: false, text: { font: "Instrument Serif" }, size },
				},
			},
		});
	}
	return out;
}

function oat(sizes?: (index: number) => number): Project {
	let n = 0;
	const captions = LINES.flatMap((line) => chunksOf(line).map((chunk) => ({ ...chunk, params: { ...(chunk.params as object), fontSize: sizes ? sizes(n++) : 6 } })));
	return {
		metadata: {
			id: "proj-halcyon-oat",
			name: "Halcyon Oat Latte / founder reel",
			duration: 9 * T,
			createdAt: "2026-10-21T09:00:00.000Z",
			updatedAt: "2026-10-21T09:00:00.000Z",
			restorff: { opsVersion: "ops@1", pending: [], media: [{ id: "media-a", kind: "video", name: "halcyon-oat-a.mp4", duration: 20 * T, width: 1080, height: 1920, fps: 30, hasAudio: true, author: "user" }] },
		},
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [{ id: "trk-captions", name: "CAPTIONS", type: "text", hidden: false, restorff: { captionLayer: "base", role: "caption" }, elements: captions }],
					main: {
						id: "trk-main",
						name: "V1 A-ROLL",
						type: "video",
						hidden: false,
						muted: false,
						elements: [
							{
								id: "clip-a",
								type: "video",
								name: "halcyon-oat-a",
								mediaId: "media-a",
								startTime: 0,
								duration: 9 * T,
								trimStart: 0,
								trimEnd: 11 * T,
								sourceDuration: 20 * T,
								isSourceAudioEnabled: true,
								hidden: false,
								params: { "transform.positionX": 0, "transform.positionY": 0, "transform.scaleX": 1, "transform.scaleY": 1, "transform.rotate": 0, opacity: 1, blendMode: "normal", volume: 0, muted: false },
							},
						],
					},
					audio: [],
				},
				bookmarks: [],
			},
		],
		currentSceneId: "scene-main",
		settings: { fps: 30, canvasSize: { width: 1080, height: 1920 }, background: { type: "color", color: "#000000" } },
		version: 32,
	} as unknown as Project;
}

const snap = (project: Project) => project as unknown as ProjectSnapshot;

function beatWith(project: Project, word: string): number {
	const board = buildStoryboard(snap(project));
	const index = board.rows.findIndex((row) => (row.line ?? "").includes(word));
	return index + 1;
}

function applyOk(project: Project, ops: Op[]): Project {
	const result = apply(project, ops, { seed: "revise-safety", at: "2026-10-21T10:00:00.000Z" });
	if (!result.ok) throw new Error(JSON.stringify(result.conflicts));
	return result.project;
}

describe("never lose words (the warm-moody-oat case)", () => {
	test("'Change the beat 3 caption to 'and Claude uses'' is ONE word fix (Cloud → Claude), no chunk deleted", () => {
		const project = oat();
		const beat = beatWith(project, "Cloud");
		expect(beat).toBeGreaterThan(0);
		const plan = planRevision({ sentence: `Change the beat ${beat} caption to 'and Claude uses'.`, snapshot: snap(project), library: emptyLibrary() });
		expect(plan.understood).toBe(true);
		expect(plan.word_fixes.map((fix) => [fix.from, fix.to])).toEqual([["Cloud", "Claude"]]);
		expect(plan.ops.filter((op) => op.op === "delete")).toEqual([]);
		// without a transcript under it, the same fix is done in place: one chunk, its other word kept
		const fallback = plan.word_fixes[0]?.fallback;
		expect(fallback?.ops).toEqual([expect.objectContaining({ op: "set", prop: "text", value: "Claude uses" })]);
		const after = applyOk(project, fallback?.ops ?? []);
		const guard = guardSnapshots(snap(project), snap(after), { fixes: plan.word_fixes });
		expect(guard.lost).toEqual([]);
		expect(guard.before).toBe(guard.after);
	});

	test("the old rewrite (3 set text + 6 delete) loses 15 words — the word guard refuses it", () => {
		const project = oat();
		const beat = beatWith(project, "Cloud");
		const board = buildStoryboard(snap(project));
		const scope = resolveScope(snap(project), board, { beat }, "arguments");
		if (!scope || typeof scope === "string") throw new Error("no scope");
		const made = textChangeOps(snap(project), scope, { target: "caption", text: "and Claude uses", rest: "" });
		if ("error" in made) throw new Error(made.error);
		expect(made.ops.filter((op) => op.op === "delete").length).toBe(6);
		const after = applyOk(project, made.ops);
		const guard = guardSnapshots(snap(project), snap(after));
		expect(guard.ok).toBe(false);
		expect(guard.before - guard.after).toBe(14);
		expect(guard.lost.length).toBeGreaterThanOrEqual(14);
		expect(guard.lost.map((word) => word.text)).toContain("source");
	});

	test("a shorter line with little in common is refused: what it would delete + the transcribe edit call", () => {
		const project = oat();
		const beat = beatWith(project, "Cloud");
		const plan = planRevision({ sentence: `change the beat ${beat} caption to "cold brew rules"`, snapshot: snap(project), library: emptyLibrary(), timelineId: "tl-oat" });
		expect(plan.understood).toBe(false);
		expect(plan.ops).toEqual([]);
		expect(plan.word_loss_refused[0]?.would_delete.length).toBeGreaterThan(10);
		const miss = plan.not_understood[0];
		expect(miss?.why).toContain("refused");
		expect(miss?.send.steps?.[0]).toMatchObject({ tool: "transcribe", arguments: { timeline_id: "tl-oat", action: "edit", rebuild_captions: true } });
		// the person said so: allow_word_loss lets the rewrite through (and deletes on purpose)
		const allowed = planRevision({ sentence: `change the beat ${beat} caption to "cold brew rules"`, snapshot: snap(project), library: emptyLibrary(), allowWordLoss: true });
		expect(allowed.ops.some((op) => op.op === "delete")).toBe(true);
	});

	test("a longer rewrite loses nothing and keeps the old path; the guard agrees", () => {
		const project = oat();
		const beat = beatWith(project, "together");
		const plan = planRevision({ sentence: `change the beat ${beat} caption to "all the clips together, every single one."`, snapshot: snap(project), library: emptyLibrary() });
		expect(plan.word_loss_refused).toEqual([]);
		expect(plan.understood).toBe(true);
	});

	test("'change Cloud to Claude' / quoted swaps fix every occurrence", () => {
		expect(parseWordSwap(`change "Cloud" to "Claude"`)).toEqual({ from: "Cloud", to: "Claude", quoted: true });
		expect(parseWordSwap(`"cloud" should be "Claude"`)?.to).toBe("Claude");
		expect(parseWordSwap("replace Cloud with Claude")).toEqual({ from: "Cloud", to: "Claude", quoted: false });
		expect(parseWordSwap("change the captions to yellow")).toBeNull();
		expect(parseWordSwap("change it to serif")).toBeNull();
		const project = oat();
		const plan = planRevision({ sentence: `change "Cloud" to "Claude"`, snapshot: snap(project), library: emptyLibrary() });
		expect(plan.word_fixes.map((fix) => fix.from)).toEqual(["Cloud"]);
		expect(plan.understood).toBe(true);
		const none = planRevision({ sentence: `change "Clod" to "Claude"`, snapshot: snap(project), library: emptyLibrary() });
		expect(none.understood).toBe(false);
		expect(none.not_understood[0]?.why).toContain("Cloud");
	});

	test("word fixes: merges, drops inside the window, a one-word text", () => {
		const words = captionWords(snap(oat()));
		const hyper = words.filter((word) => word.start >= 3.1 && word.start < 4.44);
		const merged = planWordFix(
			hyper.map((word) => ({ ...word })).flatMap((word) => (word.text === "HyperFrames." ? [{ ...word, text: "hyper" }, { ...word, text: "frames." }] : [word])),
			"called HyperFrames.",
		);
		expect(merged.kind).toBe("fix");
		if (merged.kind === "fix") expect(merged.fixes.map((fix) => [fix.from, fix.to])).toEqual([["hyper frames.", "HyperFrames."]]);
		const beat = words.filter((word) => word.start >= 4.46 && word.start < 7.72);
		const one = planWordFix(beat, "Claude");
		expect(one.kind === "fix" && one.fixes[0]?.from).toBe("Cloud");
		expect(planWordFix(beat, "and Cloud uses").kind).toBe("same");
	});

	test("the guard: fixes and cut footage are explained, anything else is lost", () => {
		const before = [
			{ text: "and", start: 1, end: 1.2, chunk_id: "a" },
			{ text: "Cloud", start: 1.2, end: 1.5, chunk_id: "a" },
			{ text: "uses", start: 1.5, end: 1.8, chunk_id: "b" },
			{ text: "it", start: 1.8, end: 2, chunk_id: "b" },
		];
		const after = [
			{ text: "and", start: 1, end: 1.2, chunk_id: "x" },
			{ text: "Claude", start: 1.2, end: 1.5, chunk_id: "x" },
			{ text: "uses", start: 1.5, end: 1.8, chunk_id: "y" },
		];
		expect(wordGuard({ before, after, fixes: [{ from: "Cloud", to: "Claude" }] }).lost).toEqual([{ text: "it", t: 1.8 }]);
		expect(wordGuard({ before, after, fixes: [{ from: "Cloud", to: "Claude" }], survives: (t) => t < 1.8 }).ok).toBe(true);
		expect(wordGuard({ before, after, fixes: [{ from: "Cloud", to: "Claude" }], exclude: ["b"] }).lost).toEqual([{ text: "uses", t: 1.5 }].slice(0, 0));
		expect(simulateFixes(before, [{ from: "Cloud uses", to: "Claude uses" }]).map((word) => word.text)).toEqual(["and", "Claude", "uses", "it"]);
	});
});

describe("one caption look per span", () => {
	test("measure: sizes by span, the odd chunks and why", () => {
		const project = oat((i) => (i === 3 || i === 9 ? 4 : 6));
		const report = measureCaptionSpans(snap(project));
		expect(report.spans.length).toBe(1);
		expect(report.mixed_spans).toBe(1);
		expect(report.spans[0]?.size).toBe(6);
		expect(report.spans[0]?.sizes).toEqual({ "6": report.chunks - 2, "4": 2 });
		expect(report.spans[0]?.odd[0]?.why).toContain("shrunk");
		const even = measureCaptionSpans(snap(oat()));
		expect(even.mixed_spans).toBe(0);
	});

	test("a word with no chunk takes its neighbours' look (not the style default)", () => {
		const look = { size: 12, text: { font: "Bebas Neue" } };
		const existing = [{ start: 0, end: 1, words: [{ text: "cold", start: 0, end: 1 }], look }];
		const chunks = rechunk({ words: [{ text: "cold", start: 0.1, end: 0.9 }, { text: "brew", start: 1.4, end: 1.9 }], existing, style: getCaptionStyle("serif-box") });
		expect(chunks.every((chunk) => chunk.look?.size === 12)).toBe(true);
	});

	test("bigger captions on tool-built plain captions = a relative look change per chunk (no absolute set_caption_style)", () => {
		const project = oat((i) => (i < 8 ? 6 : 13));
		const plan = planRevision({ sentence: "bigger captions", snapshot: snap(project), library: emptyLibrary() });
		expect(plan.ops.some((op) => op.op === "set_caption_style")).toBe(false);
		expect(plan.caption_looks).toEqual([{ overrides: { size: { relative: 1.35 } }, span: null }]);
		const doc = [
			{ start: 0, end: 1, words: [{ text: "a", start: 0, end: 1 }], look: { size: 6 } },
			{ start: 5, end: 6, words: [{ text: "b", start: 5, end: 6 }], look: { size: 13 } },
		];
		const next = applyLookChanges(doc, plan.caption_looks[0] ?? {}, { width: 1080, height: 1920 });
		expect(next.map((chunk) => chunk.look?.size)).toEqual([8.1, 17.55]);
	});

	test("a too-wide chunk splits in two at its size", () => {
		const parts = splitChunk({ start: 0, end: 2, words: [{ text: "steeped", start: 0, end: 0.5 }, { text: "eighteen,", start: 0.5, end: 1 }, { text: "never", start: 1, end: 1.5 }, { text: "bitter", start: 1.5, end: 2 }], look: { size: 9 } });
		expect(parts.map((part) => part.words.map((word) => word.text).join(" "))).toEqual(["steeped eighteen,", "never bitter"]);
		expect(parts.every((part) => part.look?.size === 9)).toBe(true);
	});

	test("the reducer records a set fontSize / fontFamily on a tool-built chunk in its look", () => {
		const project = oat();
		const id = String((project.scenes[0]?.tracks.overlay[0]?.elements[0] as { id: string }).id);
		const after = applyOk(project, [
			{ op: "set", author: "claude", el: id, prop: "fontSize", value: 13 },
			{ op: "set", author: "claude", el: id, prop: "fontFamily", value: "Bebas Neue" },
		] as Op[]);
		const tag = (after.scenes[0]?.tracks.overlay[0]?.elements[0] as { restorff?: { caption?: { look?: { size?: number; text?: { font?: string } } } } }).restorff?.caption?.look;
		expect(tag?.size).toBe(13);
		expect(tag?.text?.font).toBe("Bebas Neue");
	});
});

describe("take a pass + honest styles", () => {
	test("first-pass sentences", () => {
		expect(parseFirstPass("Take a pass at editing this.")).toEqual({ captionStyle: null, transition: null, unknown: [] });
		expect(parseFirstPass("do a first pass with serif captions and dissolves")).toEqual({ captionStyle: "serif-box", transition: "dissolve", unknown: [] });
		expect(parseFirstPass("edit this for me, no transitions")?.transition).toBe("none");
		expect(parseFirstPass("can you edit this with key-word captions")?.captionStyle).toBe("key-word");
		expect(parseFirstPass("make a rough cut")).not.toBeNull();
		expect(parseFirstPass("make it moody")).toBeNull();
		expect(parseFirstPass("edit this caption to 'cold brew'")).toBeNull();
		expect(parseFirstPass("change the beat 3 caption to 'and Claude uses'")).toBeNull();
	});

	test("the active editing style is read from the captions' font", () => {
		expect(activeEditingStyle(snap(oat()))).toBe("aesthetic-warm");
	});

	test("'make it more aesthetic' applies the style AND lists the cover + the word behind the head with exact cutout calls", () => {
		const project = oat();
		const plan = planRevision({ sentence: "Make it more aesthetic.", snapshot: snap(project), library: emptyLibrary(), timelineId: "tl-oat" });
		expect(plan.ops.some((op) => op.op === "apply_style")).toBe(true);
		expect(plan.clause_report[0]?.status).toBe("applied");
		expect(plan.left_out.map((piece) => piece.send.steps?.[0]?.arguments.preset)).toEqual(["cover_story", "text_behind_person"]);
		expect(plan.not_understood.length).toBe(2);
		expect(plan.matte_clips).toEqual(["clip-a"]);
		const cover = plan.left_out[0]?.send.steps?.[0]?.arguments;
		expect(cover).toMatchObject({ action: "cutout" === "cutout" ? "apply" : "", element_id: "clip-a", text: "HALCYON" });
		// other styles: their declared compositions, as effects apply calls
		const moody = stylePiecesLeftOut("moody-captions", snap(project), "tl-oat", "make it moody");
		expect(moody[0]?.send.steps?.[0]).toMatchObject({ tool: "effects", arguments: { action: "apply", name: "comp:big-word-punch" } });
	});

	test("captionTextPlan says 'same' when nothing differs", () => {
		const project = oat();
		const board = buildStoryboard(snap(project));
		const beat = beatWith(project, "together");
		const scope = resolveScope(snap(project), board, { beat }, "arguments");
		if (!scope || typeof scope === "string") throw new Error("no scope");
		expect(captionTextPlan(snap(project), scope, "all the clips together.", "c", "tl").kind).toBe("same");
	});
});
