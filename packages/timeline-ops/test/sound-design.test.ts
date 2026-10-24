/**
 * "Design the sound" (src/sound-design.ts) on the fictional Halcyon Cold Brew fixture: A-roll split at 3.0 s
 * (the hook's end), B-roll 5–8 s, two text pops, music bed at −6 dB, an empty SFX track.
 */
import { describe, expect, test } from "bun:test";
import {
	apply,
	designSound,
	markDesign,
	previousDesign,
	withoutPreviousDesign,
	type Op,
	type Project,
	type ScalarChannel,
	type SfxLibraryEntry,
	type TimelineElement,
} from "../src/index.ts";
import { fixtureProject } from "./fixture.ts";
import { allTracks, el, scene } from "./helpers.ts";

/** The fields of apps/web/public/sfx/manifest.json the planner reads (values as built 2026-10-20). */
const LIBRARY: SfxLibraryEntry[] = [
	{ id: "whoosh-short", name: "Whoosh short", url: "/sfx/whoosh-short.wav", duration_s: 0.45, category: "whoosh", roles: ["cut", "transition"], sync_s: 0.267, default_db: -5.5 },
	{ id: "swish", name: "Swish", url: "/sfx/swish.wav", duration_s: 0.3, category: "whoosh", roles: ["cut"], sync_s: 0.127, default_db: -5 },
	{ id: "whoosh-long", name: "Whoosh long", url: "/sfx/whoosh-long.wav", duration_s: 1, category: "whoosh", roles: ["transition", "cut"], sync_s: 0.567, default_db: -8.5 },
	{ id: "riser-1s", name: "Riser 1 s", url: "/sfx/riser-1s.wav", duration_s: 1, category: "riser", roles: ["hook_riser"], sync_s: 0.975, default_db: -6 },
	{ id: "riser-2s", name: "Riser 2 s", url: "/sfx/riser-2s.wav", duration_s: 2, category: "riser", roles: ["hook_riser"], sync_s: 1.941, default_db: -9 },
	{ id: "impact", name: "Impact", url: "/sfx/impact.wav", duration_s: 0.9, category: "hit", roles: ["hit"], sync_s: 0, default_db: -4 },
	{ id: "sub-hit", name: "Sub hit", url: "/sfx/sub-hit.wav", duration_s: 1, category: "hit", roles: ["hit"], sync_s: 0, default_db: -6.5 },
	{ id: "pop", name: "Pop", url: "/sfx/pop.wav", duration_s: 0.12, category: "ui", roles: ["text_in"], sync_s: 0, default_db: -2.5 },
	{ id: "tick", name: "Tick", url: "/sfx/tick.wav", duration_s: 0.05, category: "ui", roles: ["caption_tick"], sync_s: 0, default_db: -3.5 },
];

function edited(): Project {
	const ops: Op[] = [
		{ op: "split", author: "user", el: "el-aroll", t: 3 },
		{ op: "text_pop", author: "user", t: 3.1, text: "COLD BREW" },
		{ op: "text_pop", author: "user", t: 6, text: "20 HOURS" },
	];
	const result = apply(fixtureProject(), ops, { seed: "sound-design-fixture" });
	expect(result.ok).toBe(true);
	return result.project;
}

function designed(project: Project, options = {}) {
	const plan = designSound(project, LIBRARY, options);
	const result = apply(project, plan.ops, { seed: "sound-design" });
	return { plan, result };
}

describe("designSound", () => {
	test("hit on frame 1, riser into the hook, hit at the hook's end, whoosh on every cut, pop on text", () => {
		const { plan, result } = designed(edited());
		expect(result.ok).toBe(true);
		expect(result.conflicts).toEqual([]);
		expect(plan.hookEnd).toBe(3);
		// cuts at 3.0 (hook end → the sub-hit wins it), 5.0 (B-roll in), 8.0 (B-roll out); pops at 3.1 (too close) and 6.0
		expect(plan.counts).toEqual({ hit: 2, riser: 1, whoosh: 2, pop: 1, tick: 0 });
		expect(plan.summary).toBe("placed 6 SFX: 2 whoosh, 1 pop, 1 riser, 2 hits");
		const opening = plan.placed.find((item) => item.event === 0);
		expect(opening?.sound).toBe("impact");
		const riser = plan.placed.find((item) => item.kind === "riser");
		expect(riser?.t).toBeCloseTo(3 - 1.941, 3);
		expect(riser && riser.t + 1.941).toBeCloseTo(3, 3);
		// whoosh peaks land on the cuts
		for (const cut of [5, 8]) {
			const whoosh = plan.placed.find((item) => item.kind === "whoosh" && Math.abs(item.event - cut) < 1e-6);
			expect(whoosh).toBeDefined();
		}
		expect(plan.dropped.map((item) => item.kind).sort()).toEqual(["pop", "whoosh"]);
	});

	test("never two SFX events closer than 0.25 s, every element named and placed as library audio", () => {
		const { plan, result } = designed(edited());
		const events = plan.placed.filter((item) => item.kind !== "riser").map((item) => item.event).sort((a, b) => a - b);
		for (let i = 1; i < events.length; i++) expect(events[i] - events[i - 1]).toBeGreaterThanOrEqual(0.25);
		const sfx = allTracks(result.project)
			.flatMap((track): TimelineElement[] => track.elements)
			.filter((element) => element.restorff?.role === "sfx");
		expect(sfx.length).toBe(6);
		for (const element of sfx) {
			expect(element.name.startsWith("SFX ")).toBe(true);
			expect(element.type === "audio" && element.sourceType === "library").toBe(true);
			expect(typeof element.params.volume).toBe("number");
		}
	});

	test("the music is ducked lightly with new volume keys under the louder SFX", () => {
		const { plan, result } = designed(edited());
		expect(plan.ducked).toEqual(["el-music"]);
		const music = el(result.project, "el-music");
		const keys = (music.animations?.volume as ScalarChannel).keys;
		expect(keys.length).toBeGreaterThan(4);
		const lowest = Math.min(...keys.map((key) => key.value));
		expect(lowest).toBeCloseTo(-9, 5); // −6 dB bed, 3 dB duck
		expect(Math.max(...keys.map((key) => key.value))).toBeCloseTo(-6, 5);
	});

	test("a second run replaces the first instead of stacking", () => {
		const start = edited();
		const first = designed(start);
		const marked = markDesign(first.result);
		expect(previousDesign(marked).elements.length).toBe(6);
		const cleaned = withoutPreviousDesign(marked);
		expect(previousDesign(cleaned)).toEqual({ elements: [], duckKeys: 0 });
		// the reducer stamps the last author on elements it touched (the ducked music); that stamp may stay
		const untouched = (project: Project) =>
			JSON.parse(JSON.stringify(scene(project).tracks, (key, value) => (key === "restorff" && Object.keys(value).join() === "author" ? undefined : value)));
		expect(untouched(cleaned)).toEqual(untouched(start));
		const second = designed(cleaned);
		expect(second.plan.summary).toBe(first.plan.summary);
	});

	test("caption ticks are off by default and respect the 0.25 s rule when on", () => {
		const words = [
			{ text: "Cold", start: 10, end: 10.3 },
			{ text: "brew,", start: 10.35, end: 10.7 },
			{ text: "steeped", start: 11.6, end: 12 },
			{ text: "slow.", start: 12.05, end: 12.5 },
		];
		const captioned = apply(edited(), [{ op: "add_captions", author: "user", words, max_words: 1, gap: 0.3 }], { seed: "caps" });
		expect(captioned.ok).toBe(true);
		expect(designSound(captioned.project, LIBRARY).counts.tick).toBe(0);
		const on = designSound(captioned.project, LIBRARY, { captionTicks: true });
		// chunks at 10.0, 10.35, 11.6, 12.05: all ≥ 0.25 s apart
		expect(on.counts.tick).toBe(4);
		const result = apply(captioned.project, on.ops, { seed: "ticks" });
		expect(result.ok).toBe(true);
	});

	test("a riser's quiet start does not block a cut inside the hook (incident 2026-10-20)", () => {
		// riser-2s into a 3.0 s hook starts at 1.059 s; the cut at 1.2 s must still get its whoosh
		const project = apply(edited(), [{ op: "split", author: "user", el: "el-aroll", t: 1.2 }], { seed: "cut-in-hook" }).project;
		const plan = designSound(project, LIBRARY);
		expect(plan.placed.some((item) => item.kind === "whoosh" && Math.abs(item.event - 1.2) < 1e-6)).toBe(true);
		expect(plan.placed.some((item) => item.kind === "riser")).toBe(true);
		expect(plan.counts.hit).toBe(2);
	});

	test("an empty timeline plans nothing and says why", () => {
		const project = fixtureProject();
		const tracks = scene(project).tracks;
		tracks.main.elements = [];
		for (const track of [...tracks.overlay, ...tracks.audio]) track.elements = [];
		const plan = designSound(project, LIBRARY);
		expect(plan.ops).toEqual([]);
		expect(plan.summary).toBe("placed 0 SFX");
		expect(plan.notes.join(" ")).toContain("empty");
	});
});
