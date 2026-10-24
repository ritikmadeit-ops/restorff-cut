/**
 * timing-helper (2026-10-21): the plan tool's planners (scenes · effects · trim), one params shape for effects
 * describe, the compact summary default. Pure: no server, no files.
 * Run: cd apps/web && bun test src/server/__tests__/timing-helper.test.ts
 *
 * Words: the fictional Halcyon Nitro voice-over of the neon-grid-nitro replay (david-desktop, tightened), as the
 * timeline's transcript store holds it — Sonnet cut its scenes by hand at 8.75 / 13.25 / 18.2 / 21.8 / 27.2 / 36.0.
 */
import { describe, expect, test } from "bun:test";
import { apply, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import { paramRows, withParamRows } from "@/server/params-list";
import { compactSummaryView, COMPACT_PER_TRACK } from "@/server/timeline-read-compact";
import { emptyProject } from "@/server/timeline-skeleton";
import {
	anchorPenalty,
	cutBefore,
	type EffectAsk,
	findPhrase,
	MIN_PIECE_S,
	normalizeWords,
	type PlanWord,
	planEffects,
	planScenes,
	planTrim,
	startsSentence,
} from "@/server/timing-plan";
import type { ProjectSnapshot } from "@/sync/snapshot";

const VO: Array<[string, number, number]> = [
	["What", 0.72, 0.909], ["if", 0.909, 1.034], ["nitro", 1.034, 1.509], ["bubbles", 1.509, 1.904],
	["were", 1.904, 2.109], ["a", 2.109, 2.164], ["function", 2.164, 2.629], ["of", 2.629, 2.764],
	["time?", 2.764, 3.18], ["At", 3.38, 3.529], ["Halcyon,", 3.529, 4.22], ["the", 4.57, 4.664],
	["cascade", 4.664, 5.249], ["lasts", 5.249, 5.659], ["twelve", 5.659, 5.989], ["seconds.", 5.989, 6.63],
	["Not", 6.83, 7.058], ["six.", 7.058, 7.55], ["Not", 7.75, 7.998], ["twenty-four.", 7.998, 8.74],
	["Cold", 8.94, 9.283], ["brew,", 9.283, 9.65], ["nitrogen,", 9.75, 10.42], ["and", 10.53, 10.693],
	["a", 10.693, 10.758], ["pour.", 10.758, 11.12], ["That's", 11.32, 11.583], ["the", 11.583, 11.688],
	["whole", 11.688, 11.958], ["recipe.", 11.958, 13.36], ["Foam", 13.36, 13.688], ["climbs", 13.688, 14.112],
	["fast,", 14.112, 14.6], ["then", 14.8, 15.002], ["eases", 15.002, 15.387], ["out.", 15.387, 15.68],
	["Cascade", 15.88, 16.442], ["first,", 16.442, 16.94], ["creaminess", 17.14, 17.712], ["last.", 17.712, 18.17],
	["So", 18.37, 18.587], ["we", 18.587, 18.747], ["wrote", 18.747, 18.987], ["it", 18.987, 19.112],
	["down.", 19.112, 19.49], ["Creaminess,", 19.69, 20.42], ["as", 20.74, 20.936], ["a", 20.936, 21.001],
	["function", 21.001, 21.466], ["of", 21.466, 21.601], ["t.", 21.601, 21.811], ["Warm", 21.811, 22.116],
	["can,", 22.116, 22.63], ["a", 22.95, 23.041], ["minute", 23.041, 23.366], ["later?", 23.366, 23.74],
	["Flat.", 23.94, 24.34], ["Cold", 24.54, 24.876], ["can,", 24.876, 25.31], ["twelve", 25.51, 25.836],
	["seconds?", 25.836, 26.47], ["Creamy.", 26.67, 27.06], ["Every", 27.26, 27.581], ["bubble", 27.581, 27.905],
	["on", 27.905, 28.065], ["that", 28.065, 28.265], ["curve", 28.265, 28.525], ["is", 28.525, 28.68],
	["a", 28.68, 28.745], ["choice", 28.745, 29.1], ["we", 29.1, 29.245], ["made", 29.245, 29.495],
	["on", 29.495, 29.67], ["purpose.", 29.67, 30.21], ["Halcyon", 30.41, 30.975], ["Nitro", 30.975, 31.435],
	["Cold", 31.435, 31.77], ["Brew.", 31.77, 32.14], ["Creamy", 32.34, 32.68], ["without", 32.68, 33.049],
	["cream.", 33.049, 33.48],
];
const words: PlanWord[] = normalizeWords(VO).words;
/** On the frame grid to the tick (times keep 6 decimals: 8.833333). */
const onFrame = (seconds: number, fps = 30) => Math.abs(seconds * fps - Math.round(seconds * fps)) < 1e-4;

describe("words in", () => {
	test("the three shapes the tools answer, invalid items counted", () => {
		const got = normalizeWords([
			{ text: "Halcyon", start: 0.5, end: 0.9 },
			["cold", 0.1, 0.4],
			{ w: "brew.", s: 0.9, e: 1.2 },
			{ text: "bad" },
			"nope",
		]);
		expect(got.words.map((word) => word.text)).toEqual(["cold", "Halcyon", "brew."]);
		expect(got.dropped).toBe(2);
		expect(words).toHaveLength(81);
	});
});

describe("cut points", () => {
	test("lead_s before the next word, on the frame grid, after the last word", () => {
		const cut = cutBefore(8.74, 8.94, 0.1, 30); // twenty-four. → Cold
		expect(cut).toBeCloseTo(8.833, 3);
		expect(onFrame(cut)).toBe(true);
		expect(cut).toBeGreaterThanOrEqual(8.74);
		expect(cut).toBeLessThanOrEqual(8.94);
	});
	test("incident: a zero gap never puts the cut after the next word's onset (\"Foam\" fell into the scene before)", () => {
		const cut = cutBefore(13.36, 13.36, 0.1, 30); // recipe. → Foam, no gap
		expect(cut).toBeLessThanOrEqual(13.36);
		expect(cut).toBeCloseTo(13.333, 3);
	});
});

describe("plan scenes", () => {
	test("starts (the writer's beats) → a cut just before each, within 3 frames of Sonnet's hand cuts", () => {
		const plan = planScenes(words, { starts: ["Cold brew", "Foam climbs", "So we wrote", "Warm can", "Every bubble"], endS: 36 });
		const cuts = plan.scenes.slice(1).map((scene) => scene.t);
		expect(cuts).toEqual([8.833333, 13.333333, 18.266667, 21.8, 27.133333]);
		const sonnet = [8.75, 13.25, 18.2, 21.8, 27.2];
		cuts.forEach((cut, i) => expect(Math.abs(cut - sonnet[i])).toBeLessThanOrEqual(0.1));
		expect(plan.scenes.at(-1)?.end).toBe(36);
		expect(plan.scenes[1].line).toBe("Cold brew, nitrogen, and a pour. That's the whole recipe.");
		expect(plan.scenes[2].first_word?.text).toBe("Foam");
		for (const scene of plan.scenes.slice(1)) {
			expect(onFrame(scene.t)).toBe(true);
			expect(scene.first_word && scene.first_word.start >= scene.t).toBe(true);
		}
		// every word is in exactly one scene
		expect(plan.scenes.reduce((sum, scene) => sum + scene.words.length, 0)).toBe(81);
	});
	test("count → that many scenes, each cut on a sentence end, lengths near total / count", () => {
		const plan = planScenes(words, { count: 6, endS: 36 });
		expect(plan.scenes).toHaveLength(6);
		for (const scene of plan.scenes.slice(1)) expect(scene.cut).toStartWith("sentence end");
		for (const scene of plan.scenes) expect(scene.duration_s).toBeGreaterThan(3.5);
		expect(plan.scenes.reduce((sum, scene) => sum + scene.words.length, 0)).toBe(81);
	});
	test("default end = last word + 0.8 s on the frame grid; a phrase that is not said is noted", () => {
		const plan = planScenes(words, { starts: ["Cold brew", "never said here"] });
		expect(plan.end_s).toBeCloseTo(34.3, 3);
		expect(plan.scenes).toHaveLength(2);
		expect(plan.notes.join(" ")).toContain("never said here");
	});
});

// ─── effects ──────────────────────────────────────────────────────────────────────────────────────────────────

const comp = (name: string, natural = 4, extra: Partial<EffectAsk> = {}): EffectAsk => ({ asked: name, id: name, name, kind: "composition", natural_s: natural, compressible: true, ...extra });
const held = (win: { kind: string; t: number; end: number; cut?: { t: number } }) => (win.kind === "transition" && win.cut ? win.cut.t : win.end);

describe("plan effects", () => {
	test("windows in order, on word onsets, never overlapping, ~1 s, inside the span", () => {
		const asks = ["Orbit", "Couch Wall", "UI World", "Frame Break", "Checklist", "Chart Grow", "Paper Cut", "Glass Type"].map((name) => comp(name));
		const plan = planEffects(words, asks);
		expect(plan.fits).toBe(true);
		expect(plan.windows).toHaveLength(8);
		const onsets = new Set(words.map((word) => word.start));
		plan.windows.forEach((win, i) => {
			expect(win.word).not.toBeNull();
			expect(onsets.has(win.t)).toBe(true);
			expect(win.duration_s).toBeGreaterThanOrEqual(1 - 1e-9);
			if (i > 0) expect(win.t).toBeGreaterThanOrEqual(held(plan.windows[i - 1]) - 1e-9);
			expect(win.end).toBeLessThanOrEqual(plan.range.to + 1e-9);
		});
		// spread over the whole voice-over, not crammed at the start
		expect(plan.windows.at(-1)!.t).toBeGreaterThan(25);
	});
	test("each word argument resolves back to the planned word (findWord's occurrence rule)", () => {
		const plan = planEffects(words, ["A", "B", "C", "D", "E", "F"].map((name) => comp(name)));
		for (const win of plan.windows) expect(findPhrase(words, win.word!.arg, win.word!.occurrence)).toBe(win.word!.index);
	});
	test("natural length: a 6 s composition needs 1.5 s at most 4×; fit:false spans the plan", () => {
		const plan = planEffects(words, [comp("Pullback", 6), comp("Orbit"), comp("toc-list", 30, { compressible: false, span: true })]);
		expect(plan.windows[0].duration_s).toBeGreaterThanOrEqual(1.5);
		expect(plan.windows[0].why[0]).toContain("4×");
		expect(plan.spans).toHaveLength(1);
		expect(plan.spans[0].t).toBe(plan.windows[0].t);
		expect(plan.spans[0].end).toBe(plan.windows[1].end);
	});
	test("words a viewer does not hear as the moment are avoided unless they start a sentence", () => {
		const the = words.findIndex((word) => word.text === "the"); // "…Halcyon, the cascade" (after a 0.35 s pause)
		const of = words.findIndex((word) => word.text === "of"); // "function of time?"
		expect(startsSentence(words, 0)).toBe(true);
		expect(anchorPenalty(words, of)).toBeGreaterThan(0.4);
		expect(anchorPenalty(words, the)).toBeLessThan(0); // after a pause ≥ 0.3 s: a start
		const plan = planEffects(words, ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"].map((name) => comp(name)));
		const stops = plan.windows.filter((win) => /^(a|of|the|is|on|we|it|as|and)$/i.test(win.word!.arg) && !startsSentence(words, win.word!.index));
		expect(stops).toHaveLength(0);
	});
	test("a transition sits on an existing cut when the windows around it still fit (no split)", () => {
		const asks: EffectAsk[] = [comp("A"), comp("B"), { asked: "zoom", id: "FX-09", name: "Zoom Through Cut", kind: "transition", natural_s: 0.4 }, comp("C"), comp("D")];
		const plan = planEffects(words, asks, { cuts: [13.333] });
		const tr = plan.windows[2];
		expect(tr.cut).toEqual({ t: 13.333, split: false });
		expect(tr.t).toBeCloseTo(13.133, 3);
		// the next window may start on the cut (the new shot), not before it
		expect(plan.windows[3].t).toBeGreaterThanOrEqual(13.333 - 1e-9);
		expect(plan.windows[1].end).toBeLessThanOrEqual(tr.t + 1e-9);
	});
	test("no cut in reach → a split at a word boundary, never within 0.5 s of an existing cut (no sliver clip)", () => {
		const asks: EffectAsk[] = [comp("A"), { asked: "zoom", id: "FX-09", name: "Zoom Through Cut", kind: "transition", natural_s: 0.4 }, comp("B")];
		const plan = planEffects(words, asks, { cuts: [30.5] });
		const tr = plan.windows[1];
		expect(tr.cut?.split).toBe(true);
		expect(Math.abs((tr.cut?.t ?? 0) - 30.5)).toBeGreaterThanOrEqual(MIN_PIECE_S);
		const after = words.find((word) => word.start >= (tr.cut?.t ?? 0));
		expect(after && after.start - (tr.cut?.t ?? 0)).toBeLessThanOrEqual(0.1 + 1e-9);
	});
	test("a pinned word is kept; the runs around it are planned to fit; overlaps are reported, never hidden", () => {
		const asks = [comp("A"), comp("B"), comp("Vertigo", 1.6, { pinned: { word: "creaminess" } }), comp("C")];
		const plan = planEffects(words, asks);
		const pinned = plan.windows[2];
		expect(pinned.t).toBe(17.14);
		expect(plan.windows[1].end).toBeLessThanOrEqual(17.14 + 1e-9);
		expect(plan.fits).toBe(true);
		const tight = planEffects(words, [comp("A"), comp("B"), comp("C"), comp("D", 4, { pinned: { word: "time" } })]);
		expect(tight.fits).toBe(false);
		expect(tight.notes.join(" ")).toMatch(/do not fit|overlaps/);
	});
	test("hold-to-sentence shaders run to their sentence end when there is room; the picture end caps to_s", () => {
		const zoom: EffectAsk = { asked: "Digital Zoom", id: "FX-05", name: "Digital Zoom", kind: "shader", natural_s: 1.5, hold_to_sentence: true, pinned: { word: "cascade" } };
		const plan = planEffects(words, [zoom], { pictureEndS: 20 });
		expect(plan.range.to).toBe(20);
		expect(plan.windows[0].end).toBeCloseTo(6.633, 2); // "seconds." ends 6.63 → whole frames
		expect(plan.windows[0].why.join(" ")).toContain("sentence");
	});
	test("too many windows for the span: fits false with a fix in the note", () => {
		const plan = planEffects(words, Array.from({ length: 12 }, (_, i) => comp(`E${i}`)), { toS: 8 });
		expect(plan.fits).toBe(false);
		expect(plan.notes.join(" ")).toMatch(/to_s|do not fit/);
	});
});

// ─── trim ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("plan trim", () => {
	const take: PlanWord[] = normalizeWords([
		["out", 0, 0.12], ["the", 0.12, 0.2], ["dead", 0.2, 0.4], ["space.", 0.4, 0.62],
		["Halcyon", 1.4, 1.8], ["is", 1.8, 1.9], ["steeped", 1.9, 2.3], ["cold.", 2.3, 2.7],
		["Try", 2.9, 3.1], ["it.", 3.1, 3.4], ["The", 3.43, 3.5], ["more", 3.5, 3.7],
	]).words;
	test("whole sentences: the leading lower-case fragment and the words after the last . go with the silence", () => {
		const plan = planTrim(take, { duration: 4, fps: 30 });
		expect(plan?.first_word?.text).toBe("Halcyon");
		expect(plan?.last_word?.text).toBe("it.");
		expect(plan?.in).toBeCloseTo(1.3, 3); // 0.1 s pre-roll
		// the 0.2 s post-roll would reach "The" at 3.43: it stops one frame before
		expect(plan?.out).toBeLessThan(3.43);
		expect(plan?.out).toBeGreaterThanOrEqual(3.4);
		expect(plan?.notes.join(" ")).toContain("leading fragment");
		expect(plan?.notes.join(" ")).toContain("trailing fragment");
	});
	test("sentences: false keeps every word; from_word / to_word pick the phrase", () => {
		expect(planTrim(take, { duration: 4, sentences: false })?.first_word?.text).toBe("out");
		const plan = planTrim(take, { duration: 4, fromWord: "steeped", toWord: "cold" });
		expect(plan?.first_word?.text).toBe("steeped");
		expect(plan?.last_word?.text).toBe("cold.");
		expect(plan?.in).toBeGreaterThanOrEqual(1.9 - 0.1 - 1e-9);
	});
	test("a clip's window: only its own words", () => {
		const plan = planTrim(take, { duration: 4, window: { from: 1.3, to: 2.8 } });
		expect(plan?.first_word?.text).toBe("Halcyon");
		expect(plan?.last_word?.text).toBe("cold.");
	});
});

// ─── one params shape ─────────────────────────────────────────────────────────────────────────────────────────

describe("effects describe: params as one list for every kind", () => {
	test("composition {key: spec} → rows, legacy kept", () => {
		const described = { composition: "chart-grow", params: { title: { type: "string", default: "", label: "Title", description: "the headline", display: true, required: true }, speed: { type: "number", default: 1, min: 0.25, max: 4 } } };
		const out = withParamRows(described);
		expect(out.params).toEqual([
			{ name: "title", type: "string", default: "", label: "Title", description: "the headline", required: true, display: true },
			{ name: "speed", type: "number", default: 1, min: 0.25, max: 4 },
		]);
		expect(out.params_legacy).toBe(described.params);
	});
	test("shader [{key, …}] → rows with the reel preset", () => {
		const rows = paramRows({ effect_type: "restorff-digital-zoom", params: [{ key: "amount", label: "Amount", type: "number", default: 0, min: 0, max: 100 }], preset: { amount: 35 } });
		expect(rows).toEqual([{ name: "amount", type: "number", default: 0, label: "Amount", min: 0, max: 100, preset: 35 }]);
	});
	test("transition and grade prose → typed rows; a tool → []", () => {
		const transition = paramRows({ transition: "whip-left", directions: ["whip-left", "whip-right"], params: { kind: "optional…" } });
		expect(transition.map((row) => row.name)).toEqual(["kind", "direction", "track", "reach_s"]);
		expect(transition[1].options).toEqual(["left", "right"]);
		const grade = paramRows({ look: "film", sliders: [{ key: "exposure", label: "Exposure", min: -3, max: 3, default: 0 }], params: { look: "optional…" } });
		expect(grade.map((row) => row.name)).toEqual(["look", "target", "exposure"]);
		expect(grade[0].options).toContain("film");
		expect(paramRows({ tool: "captions", arguments: {}, why: "…" })).toEqual([]);
	});
});

// ─── compact summary ─────────────────────────────────────────────────────────────────────────────────────────

function textHeavy(count: number): ProjectSnapshot {
	const base = emptyProject({ id: "halcyon-timing", name: "Halcyon Cold Brew / timing fixture", now: "2026-10-21T00:00:00.000Z" }) as unknown as OpsProject;
	const ops: Array<Record<string, unknown>> = [];
	for (let i = 0; i < count; i++) ops.push({ op: "insert", author: "claude", track: "trk-text", t: i / 4, dur: 1 / 4, text: `Halcyon nitro word ${i} poured cold`, ref: `w${i}` });
	ops.push({ op: "insert", author: "claude", track: "trk-captions", t: 0.5, dur: 1, text: "Creamy without cream", ref: "cap" });
	const result = apply(base, ops as unknown as Op[], { seed: "timing-helper-fixture" });
	if (!result.ok) throw new Error(JSON.stringify(result.conflicts.slice(0, 3)));
	return result.project as unknown as ProjectSnapshot;
}

describe("timeline summary: compact default", () => {
	test("a big summary → every track's count + span + its first page; the rest on request", () => {
		const out = compactSummaryView(textHeavy(150));
		expect(out.compact).toBe(true);
		if (!out.compact) return;
		const text = out.summary.tracks.find((track) => track.name === "TEXT");
		expect(text?.count).toBe(150);
		expect(text?.elements).toHaveLength(COMPACT_PER_TRACK);
		expect(text?.more).toBe(150 - COMPACT_PER_TRACK);
		expect(text?.span?.from).toBe(0);
		expect(out.summary.page.total).toBe(151);
		expect(JSON.stringify(out.summary).length).toBeLessThan(out.full_chars / 3);
	});
	test("a small one is answered whole, as before", () => {
		const out = compactSummaryView(textHeavy(6));
		expect(out.compact).toBe(false);
		expect(out.summary?.tracks.find((track) => track.name === "TEXT")?.elements).toHaveLength(6);
	});
});
