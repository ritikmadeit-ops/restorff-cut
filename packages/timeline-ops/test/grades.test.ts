// The colour grade (grade agent, 2026-10-20): looks and nudges in ./src/grades.ts, ops@1 `grade` applied for real
// (clip effects, track, GRADE adjustment layer), the editing styles' grades and "whip on beats", and the sentence
// resolver's colour words. Fixture: Halcyon Cold Brew (fictional).
import { describe, expect, test } from "bun:test";
import {
	applyGradeNudge,
	GRADE_EFFECT_TYPE,
	GRADE_LOOKS,
	GRADE_NUDGES,
	GRADE_PARAM_SPECS,
	gradeLabel,
	gradeUniforms,
	lookParams,
	NEUTRAL_GRADE,
	type Op,
	type Project,
	resolveGradeName,
	resolveSentence,
	type TimelineElement,
	type VideoElement,
} from "../src/index.ts";
import { T } from "./fixture.ts";
import { el, run, scene } from "./helpers.ts";

const C = "claude" as const;

type WithEffects = TimelineElement & { effects?: Array<{ id: string; type: string; params: Record<string, unknown>; enabled: boolean }> };
const gradeOf = (element: TimelineElement) => (element as WithEffects).effects?.find((effect) => effect.type === GRADE_EFFECT_TYPE);
const gradeTrack = (project: Project) => scene(project).tracks.overlay.find((track) => track.name === "GRADE");

describe("grades.ts", () => {
	test("every look and nudge stays inside each param's range; neutral is the identity", () => {
		expect(GRADE_LOOKS.map((look) => look.id)).toEqual(["warm-morning", "moody", "clean", "film", "cool-night", "punchy", "paper", "mono"]);
		for (const look of GRADE_LOOKS) {
			for (const [key, value] of Object.entries(look.params)) {
				const spec = GRADE_PARAM_SPECS.find((candidate) => candidate.key === key);
				expect(spec).toBeDefined();
				expect(value).toBeGreaterThanOrEqual(spec?.min as number);
				expect(value).toBeLessThanOrEqual(spec?.max as number);
			}
		}
		for (const nudge of GRADE_NUDGES) for (const key of Object.keys(nudge.delta)) expect(NEUTRAL_GRADE).toHaveProperty(key);
		// the shader's identity (Rust registry defaults): exposure 0, contrast 0, saturation 1, … amount 1
		expect(gradeUniforms(NEUTRAL_GRADE)).toEqual({
			u_exposure: 0,
			u_contrast: 0,
			u_saturation: 1,
			u_temperature: 0,
			u_tint: 0,
			u_lift: 0,
			u_gamma: 1,
			u_gain: 1,
			u_vignette: 0,
			u_grain: 0,
			u_grain_seed: 0,
			u_amount: 1,
			u_split: [0, 0, 0, 0],
		});
	});

	test("names and aliases resolve to looks, nudges or none", () => {
		expect(resolveGradeName("warm")).toMatchObject({ kind: "look", look: { id: "warm-morning" } });
		expect(resolveGradeName("Warm Morning")).toMatchObject({ kind: "look", look: { id: "warm-morning" } });
		expect(resolveGradeName("B&W")).toMatchObject({ kind: "look", look: { id: "mono" } });
		expect(resolveGradeName("cool_night")).toMatchObject({ kind: "look", look: { id: "cool-night" } });
		expect(resolveGradeName("warmer")).toMatchObject({ kind: "nudge", nudge: { id: "warmer" } });
		expect(resolveGradeName("more contrast")).toMatchObject({ kind: "nudge", nudge: { id: "more-contrast" } });
		expect(resolveGradeName("none")).toEqual({ kind: "none" });
		expect(resolveGradeName("teal-and-orange-2049")).toBeNull();
	});

	test("nudges are relative and clamp; labels say what a person sees", () => {
		const warm = lookParams("warm-morning");
		expect(applyGradeNudge(warm, "warmer").temperature).toBe(warm.temperature + 15);
		expect(applyGradeNudge({ ...NEUTRAL_GRADE, temperature: 95 }, "warmer").temperature).toBe(100);
		expect(gradeLabel({ ...warm, look: "warm-morning" })).toBe("warm morning");
		expect(gradeLabel({ ...warm, amount: 60, look: "warm-morning" })).toBe("warm morning · 60 %");
		expect(gradeLabel({ ...applyGradeNudge(warm, "warmer"), look: "warm-morning" })).toBe("warm morning · edited");
		expect(gradeLabel({ ...NEUTRAL_GRADE, contrast: 12, look: "custom" })).toBe("custom");
		expect(gradeLabel({ ...NEUTRAL_GRADE })).toBe("none");
	});
});

describe("ops@1 grade (applied, not pending)", () => {
	test("on a clip: one restorff-grade effect in its effects, replaced (not stacked) by the next look", () => {
		const first = run([{ op: "grade", author: C, target: "el-aroll", preset: "moody" }]);
		expect(first.ok).toBe(true);
		expect(first.changes.unsupported).toEqual([]);
		const effect = gradeOf(el(first.project, "el-aroll"));
		expect(effect).toMatchObject({ type: "restorff-grade", enabled: true, params: { look: "moody", exposure: -0.6, saturation: -30 } });
		expect(first.changes.ops[0]?.summary).toContain("moody");
		const second = run([{ op: "grade", author: C, target: "el-aroll", preset: "warm morning" }], {}, first.project);
		const effects = (el(second.project, "el-aroll") as WithEffects).effects ?? [];
		expect(effects.filter((candidate) => candidate.type === GRADE_EFFECT_TYPE)).toHaveLength(1);
		expect(effects[0]?.id).toBe(effect?.id as string);
		expect(effects[0]?.params.look).toBe("warm-morning");
	});

	test("a nudge moves the current grade; params override; none removes it", () => {
		const graded = run([
			{ op: "grade", author: C, target: "el-aroll", preset: "warm-morning" },
			{ op: "grade", author: C, target: "el-aroll", preset: "warmer" },
			{ op: "grade", author: C, target: "el-aroll", params: { amount: 60, grain: 10 } },
		]);
		expect(graded.ok).toBe(true);
		const params = gradeOf(el(graded.project, "el-aroll"))?.params ?? {};
		expect(params.temperature).toBe(lookParams("warm-morning").temperature + 15);
		expect(params.amount).toBe(60);
		expect(params.grain).toBe(10);
		expect(params.look).toBe("warm-morning");
		const removed = run([{ op: "grade", author: C, target: "el-aroll", preset: "none" }], {}, graded.project);
		expect(gradeOf(el(removed.project, "el-aroll"))).toBeUndefined();
		const again = run([{ op: "grade", author: C, target: "el-aroll", preset: "none" }], {}, removed.project);
		expect(again.changes.ops[0]?.status).toBe("noop");
	});

	test("on a track: every video/image clip of it", () => {
		const result = run([{ op: "grade", author: C, target: "trk-broll", preset: "film" }]);
		expect(result.ok).toBe(true);
		expect(gradeOf(el(result.project, "el-broll"))?.params.look).toBe("film");
		expect(gradeOf(el(result.project, "el-aroll"))).toBeUndefined();
		const main = run([{ op: "grade", author: C, target: "main", preset: "clean" }]);
		expect(gradeOf(el(main.project, "el-aroll"))?.params.look).toBe("clean");
		const text = run([{ op: "grade", author: C, target: "trk-text", preset: "clean" }]);
		expect(text.ok).toBe(false);
		expect(text.conflicts[0]?.kind).toBe("incompatible");
	});

	test('"all": a GRADE adjustment layer above the footage, below TEXT, spanning the timeline; re-grading updates it', () => {
		const result = run([{ op: "grade", author: C, target: "all", preset: "cool night" }]);
		expect(result.ok).toBe(true);
		const overlay = scene(result.project).tracks.overlay;
		expect(overlay.map((track) => track.name)).toEqual(["TEXT", "GRADE", "V2 B-ROLL"]);
		const layer = gradeTrack(result.project);
		expect(layer?.type).toBe("effect");
		expect(layer?.restorff?.role).toBe("grade");
		expect(layer?.elements).toHaveLength(1);
		expect(layer?.elements[0]).toMatchObject({ type: "effect", effectType: "restorff-grade", startTime: 0, duration: 20 * T });
		expect(layer?.elements[0]?.params.look).toBe("cool-night");
		const id = layer?.elements[0]?.id;
		const nudged = run([{ op: "grade", author: C, target: "all", preset: "darker" }], {}, result.project);
		const after = gradeTrack(nudged.project);
		expect(after?.elements).toHaveLength(1);
		expect(after?.elements[0]?.id).toBe(id as string);
		expect(after?.elements[0]?.params.exposure).toBe(lookParams("cool-night").exposure - 0.25);
		const off = run([{ op: "grade", author: C, target: "all", preset: "none" }], {}, nudged.project);
		expect(gradeTrack(off.project)).toBeUndefined();
	});

	test("unknown looks and LUTs stay pending; old pending grade entries stay readable", () => {
		const unknown = run([{ op: "grade", author: C, target: "all", preset: "teal-and-orange-2049" }]);
		expect(unknown.ok).toBe(true);
		expect(unknown.changes.unsupported.map((record) => record.op)).toEqual(["grade"]);
		const lut = run([{ op: "grade", author: C, target: "el-aroll", lut: "halcyon.cube" }]);
		expect(lut.changes.ops[0]?.status).toBe("pending");
		// a project saved before the grade existed carries a pending grade instruction: it loads and edits as before
		const old = structuredClone(unknown.project);
		old.metadata.restorff?.pending.push({
			id: "pending-old",
			op: { op: "grade", author: "preset", target: "all", preset: "warm" },
			author: "preset",
			reason: "the editor has no colour grade or LUT",
			honouredBy: "editor",
		});
		const next = run([{ op: "grade", author: C, target: "all", preset: "warm" }], {}, old);
		expect(next.ok).toBe(true);
		expect(next.project.metadata.restorff?.pending.map((entry) => entry.id)).toContain("pending-old");
		expect(gradeTrack(next.project)?.elements[0]?.params.look).toBe("warm-morning");
	});

	test("validation: params must be known grade sliders inside their ranges", () => {
		const bad = run([{ op: "grade", author: C, target: "all", params: { exposure: 9 } } as Op]);
		expect(bad.ok).toBe(false);
		expect(bad.conflicts[0]?.kind).toBe("invalid_op");
		const unknownKey = run([{ op: "grade", author: C, target: "all", params: { sparkle: 1 } } as Op]);
		expect(unknownKey.conflicts[0]?.message).toContain("unknown grade param");
		const empty = run([{ op: "grade", author: C, target: "all" } as Op]);
		expect(empty.conflicts[0]?.message).toContain("needs preset, params or lut");
	});
});

describe("editing styles: grades and whip on beats", () => {
	const split: Op[] = [
		{ op: "split", author: C, el: "el-aroll", t: 8, ref: "s2" },
		{ op: "split", author: C, el: "s2", t: 14, ref: "s3" },
	];
	const style = (id: string): Op => ({ op: "apply_style", author: "user", preset_id: `restorff/style/${id}` });
	const mainClips = (project: Project) =>
		[...scene(project).tracks.main.elements].sort((a, b) => a.startTime - b.startTime) as VideoElement[];

	test("every style with a grade lands a real look on the GRADE layer", () => {
		for (const [id, look] of [
			["fast-ugc", "punchy"],
			["talking-head", "clean"],
			["aesthetic-warm", "warm-morning"],
			["moody-captions", "moody"],
			["paper-collage", "paper"],
		] as const) {
			const result = run([...split, style(id)]);
			expect(result.ok).toBe(true);
			expect(result.changes.unsupported).toEqual([]);
			expect(gradeTrack(result.project)?.elements[0]?.params.look).toBe(look);
		}
	});

	test("no beat grid: every join whips, alternating left / right", () => {
		const result = run([...split, style("fast-ugc")]);
		const clips = mainClips(result.project);
		expect(clips.map((clip) => clip.transitionIn?.type ?? null)).toEqual([null, "whip-left", "whip-right"]);
		expect(result.changes.applied.some((op) => op.op === "snap_cuts")).toBe(false);
	});

	test("with a beat grid: cuts roll onto the beat first, and only cuts on a beat whip", () => {
		const beats: Op = { op: "beats", author: C, el: "el-music", bpm: 120, times: [1, 2, 3, 8.1, 12], source: "manual" };
		const result = run([...split, beats, style("fast-ugc")]);
		expect(result.ok).toBe(true);
		const snap = result.changes.ops.find((change) => change.op === "snap_cuts");
		expect(snap?.status).toBe("applied");
		const clips = mainClips(result.project);
		// the cut at 8 s rolled to the beat at 8.1 s and whips; the cut at 14 s has no beat within 0.2 s: a plain cut
		expect(clips[1]?.startTime).toBe(8.1 * T);
		expect(clips.map((clip) => clip.transitionIn?.type ?? null)).toEqual([null, "whip-left", null]);
	});
});

describe("sentence → grade (command bar words)", () => {
	test('"make it warmer" is a relative nudge on the GRADE layer; "cool night look" a look', () => {
		const project = run([]).project;
		const plan = resolveSentence("make it warmer", { project });
		expect(plan.ops).toEqual([{ op: "grade", author: "user", target: "all", preset: "warmer" }]);
		expect(plan.notes.join(" ")).not.toContain("not drawn");
		const applied = run(plan.ops, {}, project);
		expect(applied.changes.unsupported).toEqual([]);
		expect(gradeTrack(applied.project)?.elements[0]?.params.temperature).toBe(15);
		expect(resolveSentence("give it a cool night look", { project }).ops[0]).toMatchObject({ preset: "cool-night" });
		expect(resolveSentence("black and white", { project }).ops[0]).toMatchObject({ preset: "mono" });
		expect(resolveSentence("more contrast", { project }).ops[0]).toMatchObject({ preset: "more-contrast" });
	});
});
