// EDT-20 (saved styles from repeats) and EDT-21 (style card + Paper collage explainer) on fictional Halcyon data.
import { describe, expect, test } from "bun:test";
import { apply, validateOps, type Op } from "@restorffcut/timeline-ops";
import {
	applyStyle,
	bindCompositions,
	detectRepeats,
	draftStyle,
	emptyLibrary,
	explainerPlan,
	exportLibrary,
	importLibrary,
	instructionKey,
	matchTrigger,
	planStyle,
	restoreVersion,
	saveStyle,
	styleCardFromReferences,
	validateStylePreset,
	COMPOSITION_PLACEHOLDER_PREFIX,
	type InstructionRecord,
} from "../src/index.ts";
import {
	estimateTextWidth,
	migrateLibrary,
	migrateSavedStyle,
	resolveCaptionSizeFlag,
	type SavedStyle,
} from "../src/index.ts";
import { biggerCaptions, collageReferences, project, projectWithCaptions } from "./fixture.ts";

const NOW = "2026-10-20T12:00:00.000Z";

const captionHistory = (): InstructionRecord[] => [
	biggerCaptions("bigger captions", "p1", 6.75),
	biggerCaptions("Bigger captions please", "p2", 6.5),
	biggerCaptions("make the captions bigger", "p3", 7),
];

describe("EDT-20 detectRepeats", () => {
	test("normalised wording: three phrasings are one instruction", () => {
		expect(instructionKey("bigger captions")).toBe(instructionKey("Make the captions bigger, please"));
		expect(instructionKey("tighter cut, bigger captions")).toBe(instructionKey("bigger captions and tighter cut"));
		expect(instructionKey("bigger captions")).not.toBe(instructionKey("smaller captions"));
	});

	test("fires at the threshold, not before", () => {
		const history = captionHistory();
		expect(detectRepeats(history.slice(0, 2))).toHaveLength(0);
		const suggestions = detectRepeats(history, { now: NOW });
		expect(suggestions).toHaveLength(1);
		const [s] = suggestions;
		expect(s?.pattern.kind).toBe("instruction");
		expect(s?.count).toBe(3);
		expect(s?.projects).toBe(3);
		expect(s?.examples).toContain("bigger captions");
		expect(detectRepeats(history, { threshold: 4 })).toHaveLength(0);
	});

	test("op patterns: different words, same ops", () => {
		const grade = (sentence: string, projectId: string): InstructionRecord => ({
			sentence,
			ops: [{ op: "grade", author: "user", target: "all", preset: "warm" }],
			projectId,
		});
		const history = [grade("warmer", "p1"), grade("golden please", "p2"), grade("give it a warm grade", "p3")];
		const suggestions = detectRepeats(history, { now: NOW });
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]?.pattern.kind).toBe("ops");
		expect(suggestions[0]?.pattern.key).toBe("ops:grade{preset=warm,target=all}");
		// counted by projects: all three on one project → not yet a habit across projects
		const sameProject = history.map((record) => ({ ...record, projectId: "p1" }));
		expect(detectRepeats(sameProject, { by: "projects" })).toHaveLength(0);
	});

	test("a saved or dismissed pattern is not suggested again", () => {
		const history = captionHistory();
		const [s] = detectRepeats(history, { now: NOW });
		if (!s) throw new Error("no suggestion");
		const saved = saveStyle(emptyLibrary(), s.draft_style, { now: NOW }).library;
		expect(detectRepeats(history, { library: saved })).toHaveLength(0);
		expect(detectRepeats(history, { dismissed: [s.pattern.key] })).toHaveLength(0);
	});
});

describe("EDT-20 draft, versions, apply", () => {
	test("the draft is a valid PRE-01 edit-style preset with a param per caption value", () => {
		const [s] = detectRepeats(captionHistory(), { now: NOW });
		const style = s?.draft_style;
		if (!style) throw new Error("no draft");
		expect(validateStylePreset(style)).toEqual([]);
		expect(style.kind).toBe("edit-style");
		expect(style.version).toBe("1.0.0");
		expect(style.triggers.length).toBeGreaterThanOrEqual(3);
		// QA #8: a ratio of the captions it is applied to, never an absolute size
		expect(style.steps).toEqual([{ kind: "op", op: { op: "set_caption_style", style: { scale: { $param: "caption_scale" } } }, each: "$captions" }]);
		expect(style.params.caption_scale?.default).toBe(1.4); // the latest run: 7 from 5
		expect(style.params.caption_size).toBeUndefined();
		expect(style.origin?.caption_size_before).toBe(5);
	});

	test("saving again bumps the version and keeps the old one; restore makes a new version", () => {
		const [s] = detectRepeats(captionHistory(), { now: NOW });
		if (!s) throw new Error("no draft");
		let lib = saveStyle(emptyLibrary(), s.draft_style, { now: NOW }).library;
		const same = saveStyle(lib, s.draft_style, { now: NOW });
		expect(same.changed).toBe(false);
		const edited = { ...s.draft_style, triggers: [...s.draft_style.triggers, "captions up a size"] };
		const second = saveStyle(lib, edited, { now: "2026-10-20T13:00:00.000Z", note: "added a trigger" });
		lib = second.library;
		expect(second.style.version).toBe("1.1.0");
		expect(lib.versions[edited.id]?.map((v) => v.version)).toEqual(["1.0.0"]);
		lib = restoreVersion(lib, edited.id, "1.0.0", { now: "2026-10-20T14:00:00.000Z" });
		expect(lib.styles[edited.id]?.version).toBe("1.2.0");
		expect(lib.styles[edited.id]?.triggers).toEqual(s.draft_style.triggers);
		expect(lib.versions[edited.id]?.map((v) => v.version)).toEqual(["1.0.0", "1.1.0"]);
		// export → import into an empty library keeps styles and versions
		const back = importLibrary(exportLibrary(lib));
		expect(back.problems).toEqual([]);
		expect(back.added).toEqual([edited.id]);
		expect(back.library.versions[edited.id]?.length).toBe(2);
		expect(matchTrigger(back.library, "captions bigger please")?.id).toBe(edited.id);
	});

	test("applyStyle on a 4th project: ops validate and apply with no conflicts", () => {
		const [s] = detectRepeats(captionHistory(), { now: NOW });
		if (!s) throw new Error("no draft");
		const p = projectWithCaptions(["Steeped", "cold", "brew"], 5);
		const ops = applyStyle(s.draft_style, p);
		expect(ops).toEqual([{ op: "set_caption_style", style: { size: 7 }, author: "preset", track: "trk-captions" }]);
		expect(validateOps(ops).ok).toBe(true);
		const result = apply(p, ops, { seed: "styles-test" });
		expect(result.conflicts).toEqual([]);
	});

	test("a clip-bound instruction is saved as a sentence and re-resolved: same op types on a new project", () => {
		const tighter = (projectId: string): InstructionRecord => ({
			sentence: "tighter cut",
			ops: [
				{ op: "split", author: "user", el: `clip-${projectId}`, t: 1.1 },
				{ op: "delete", author: "user", el: `clip-${projectId}` },
				{ op: "move", author: "user", el: `next-${projectId}`, t: 1 },
			],
			projectId,
		});
		const [s] = detectRepeats([tighter("p1"), tighter("p2"), tighter("p3")], { now: NOW });
		const style = s?.draft_style;
		if (!style) throw new Error("no draft");
		expect(style.steps).toEqual([{ kind: "sentence", sentence: "tighter cut" }]);
		const plan = planStyle(style, project());
		const kinds = new Set(plan.ops.map((op) => op.op));
		expect(kinds.has("split")).toBe(true);
		expect(kinds.has("delete")).toBe(true);
		expect(validateOps(plan.ops).ok).toBe(true);
		expect(apply(project(), plan.ops, { seed: "tighter" }).conflicts).toEqual([]);
	});

	test("draftStyle from a mixed sentence keeps clauses apart", () => {
		const ops: Op[] = [{ op: "set_caption_style", author: "user", track: "t1", style: { color: "#FFD60A" } }];
		const style = draftStyle({
			records: [
				{
					sentence: "tighter cut, yellow captions",
					ops,
					clauses: [
						{ text: "tighter cut", ops: [{ op: "delete", author: "user", el: "x" }] },
						{ text: "yellow captions", ops },
					],
				},
			],
		});
		expect(style.steps.map((step) => step.kind)).toEqual(["sentence", "op"]);
		expect(style.params.caption_color).toEqual({ type: "color", default: "#FFD60A", label: "Caption color" });
	});
});

/** QA 2026-10-20 #8: "Bigger captions" saved as an absolute 20 blew size-5 captions far past the frame. */
describe("saved caption sizes are ratios, inside the safe area (QA #8)", () => {
	const legacy = (): SavedStyle => ({
		id: "bigger-captions",
		kind: "edit-style",
		stage: "edit",
		version: "1.0.0",
		title: "Bigger captions",
		instructions: 'Saved after 3 repeats of "Bigger captions please". Applies the caption style.',
		licence: "private",
		visibility: "private",
		inputs: ["timeline"],
		outputs: { schema: "ops@1" },
		params: { caption_size: { type: "number", label: "Caption size", default: 20 } },
		checks: [],
		triggers: ["Bigger captions please", "make the captions bigger", "bigger captions"],
		steps: [{ kind: "op", op: { op: "set_caption_style", style: { size: { $param: "caption_size" } } }, each: "$captions" }],
		origin: { kind: "instruction", pattern: "instruction:big caption", count: 3, projects: 1, examples: ["Bigger captions please"] },
		created_at: NOW,
		updated_at: NOW,
	});
	const sizeOf = (ops: Op[]) => ops.flatMap((op) => (op.op === "set_caption_style" && typeof op.style.size === "number" ? [op.style.size] : []));

	test("the ratio follows the captions it is applied to", () => {
		const [s] = detectRepeats(captionHistory(), { now: NOW });
		if (!s) throw new Error("no draft");
		expect(sizeOf(applyStyle(s.draft_style, projectWithCaptions(["cold", "brew"], 3)))).toEqual([4]); // 3 × 1.4 = 4.2
		expect(sizeOf(applyStyle(s.draft_style, projectWithCaptions(["cold", "brew"], 5)))).toEqual([7]);
	});

	test("a size that would leave the safe area is capped, and a long caption is never shrunk below its size", () => {
		const [s] = detectRepeats(captionHistory(), { now: NOW });
		if (!s) throw new Error("no draft");
		const huge = applyStyle(s.draft_style, projectWithCaptions(["cold", "brewed"], 5), { params: { caption_scale: 2.5 } });
		const [size] = sizeOf(huge);
		expect(size).toBeLessThan(13); // 5 × 2.5 asked
		const font = { family: "Arial", size: size as number, weight: "bold" as const, italic: false, letterSpacing: 0 };
		expect(estimateTextWidth("brewed", font, 1920)).toBeLessThanOrEqual(880); // the 1080×1920 safe area is 880 px wide
		const long = planStyle(s.draft_style, project()); // "eighteen hours" at 5 has no room to grow
		expect(sizeOf(long.ops)).toEqual([5]);
		expect(long.notes.join(" ")).toContain("no room to grow");
	});

	test("a record without the before size keeps the clause as a sentence (relative on every project)", () => {
		const history = [biggerCaptions("bigger captions", "p1", 20, null), biggerCaptions("bigger captions", "p2", 20, null), biggerCaptions("bigger captions", "p3", 20, null)];
		const [s] = detectRepeats(history, { now: NOW });
		expect(s?.draft_style.steps).toEqual([{ kind: "sentence", sentence: "bigger captions" }]);
		expect(s?.draft_style.params).toEqual({});
	});

	test("migration: the saved-from size known → a ratio; unknown → flagged, skipped when applied, fixable", () => {
		const known = migrateSavedStyle({ ...legacy(), params: { caption_size: { type: "number", default: 17.55 } }, origin: { ...(legacy().origin as NonNullable<SavedStyle["origin"]>), caption_size_before: 13 } });
		expect(known.changed).toBe(true);
		expect(known.style.params.caption_scale?.default).toBe(1.35);
		expect(known.style.params.caption_size).toBeUndefined();
		expect(known.style.flags).toBeUndefined();

		const flagged = migrateSavedStyle(legacy());
		expect(flagged.changed).toBe(true);
		expect(flagged.style.flags?.[0]?.code).toBe("absolute_caption_size");
		expect(flagged.style.flags?.[0]?.size).toBe(20);
		expect(flagged.style.flags?.[0]?.suggested_scale).toBe(1.35); // what "bigger captions" means
		expect(migrateSavedStyle(flagged.style).changed).toBe(false); // idempotent

		// the unmigrated legacy style applied as is (e.g. from the server): the absolute 20 is NOT applied
		const plan = planStyle(legacy(), projectWithCaptions(["cold", "brew"], 5));
		expect(sizeOf(plan.ops)).toEqual([]);
		expect(plan.notes.join(" ")).toContain("caption size skipped");

		const fixed = resolveCaptionSizeFlag(flagged.style);
		expect(fixed.flags).toBeUndefined();
		expect(validateStylePreset(fixed)).toEqual([]);
		expect(sizeOf(applyStyle(fixed, projectWithCaptions(["cold", "brew"], 5)))).toEqual([7]); // 6.75 → whole units

		const lib = saveStyle(emptyLibrary(), legacy(), { now: NOW }).library;
		const migrated = migrateLibrary(lib);
		expect(migrated.changed).toBe(true);
		expect(migrated.library.styles["bigger-captions"]?.flags?.length).toBe(1);
		expect(migrateLibrary(migrated.library).changed).toBe(false);
	});
});

describe("EDT-21 style card", () => {
	const card = styleCardFromReferences(collageReferences());

	test("palette from synthetic pixels finds the paper, the brick red and the mustard", () => {
		const near = (hex: string, rgb: [number, number, number]) => {
			const n = Number.parseInt(hex.slice(1), 16);
			return Math.abs(((n >> 16) & 255) - rgb[0]) + Math.abs(((n >> 8) & 255) - rgb[1]) + Math.abs((n & 255) - rgb[2]) < 40;
		};
		const hexes = card.palette.map((c) => c.hex);
		expect(hexes.some((h) => near(h, [236, 226, 204]))).toBe(true);
		expect(hexes.some((h) => near(h, [200, 53, 43]))).toBe(true);
		expect(hexes.some((h) => near(h, [226, 184, 74]))).toBe(true);
		const paper = card.palette.find((c) => c.role === "paper");
		expect(paper && near(paper.hex, [236, 226, 204])).toBe(true);
		expect(card.palette.find((c) => c.role === "accent")).toBeDefined();
		expect(Math.abs(card.palette.reduce((sum, c) => sum + c.share, 0) - 1)).toBeLessThan(1e-9);
	});

	test("pacing, texture, type question and the three questions", () => {
		expect(card.pacing.shots).toBe(3);
		expect(card.pacing.avgShot).toBe(2);
		expect(card.pacing.label).toBe("medium");
		expect(card.texture.grain).toBeGreaterThan(0);
		expect(card.mood.label).toBe("warm");
		expect(card.type.guess).toBeNull();
		expect(card.questions.map((q) => q.id)).toEqual(["footage", "format", "feel"]);
		expect(card.questions[1]?.suggested).toBe("9:16");
		expect(card.references).toEqual({ images: 3, videos: 1, folders: ["Paper textures", "Map zoom"], frames: 15 });
	});

	test("explainerPlan validates, uses ≥ 4 collage effects, binds and applies with no conflicts", () => {
		const assets = [
			{ id: "media-pour", kind: "video" as const, name: "S03 pour", duration: 8 },
			{ id: "media-can", kind: "image" as const, name: "S07 can" },
			{ id: "media-farm", kind: "image" as const, name: "S02 farm" },
		];
		const plan = explainerPlan(
			card,
			{ footage: "mine", format: "9:16", feel: "nostalgic", topic: "How the farm-to-bottle route works", dates: [{ date: "2019", text: "First batch" }, { date: "2026", text: "12 cities" }] },
			assets,
			// the editor appends after what is on the main track (12 s of A-roll in the fixture)
			{ start: 12, canvas: { width: 1080, height: 1920 } },
		);
		expect(validateOps(plan.ops).ok).toBe(true);
		expect(plan.compositions.map((c) => c.name)).toEqual(["paper-cut", "map-route", "retro-tv", "thread-timeline", "stamp"]);
		const collage = plan.report.effects.filter((e) => /FX-(5[2-9]|6[01])/.test(e));
		expect(collage.length).toBeGreaterThanOrEqual(4);
		expect(plan.report.missing.some((m) => m.startsWith("FX-53"))).toBe(true);
		expect(plan.canvas).toBeNull();

		const bound = Object.fromEntries(plan.compositions.map((c) => [c.key, { media: `media-render-${c.key}`, dur: c.dur }]));
		const { ops, dropped } = bindCompositions(plan, bound);
		expect(dropped).toEqual([]);
		expect(ops.some((op) => op.op === "insert" && String(op.media).startsWith(COMPOSITION_PLACEHOLDER_PREFIX))).toBe(false);
		const result = apply(project(), ops, { seed: "explainer", mode: "best_effort" });
		expect(result.conflicts).toEqual([]);
		// a render that failed is dropped, not left as a placeholder
		const partial = bindCompositions(plan, { ...bound, [plan.compositions[1]?.key as string]: null });
		expect(partial.dropped).toEqual([plan.compositions[1]?.key]);
	});

	test("no footage and a missing composition: paper-only beats and a missing entry", () => {
		const plan = explainerPlan(card, { footage: "none", feel: "serious" }, [], { available: ["paper-cut", "stamp"] });
		expect(validateOps(plan.ops).ok).toBe(true);
		expect(plan.report.missing.some((m) => m.startsWith("map-route"))).toBe(true);
		expect(plan.ops.some((op) => op.op === "insert" && op.track === "main")).toBe(false);
		expect(validateStylePreset({}).length).toBeGreaterThan(0);
	});
});
