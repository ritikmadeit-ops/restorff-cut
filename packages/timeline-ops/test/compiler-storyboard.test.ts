/**
 * Storyboard compiler (EDT-03): a fictional Halcyon Cold Brew storyboard + fake assets → ops@1 → the gateway's empty
 * 9:16 skeleton. Cheap on purpose: no media, no network.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	apply,
	checkInvariants,
	compileStoryboard,
	specFromBoard,
	specFromBrief,
	validateOps,
	type Project,
	type StoryboardAsset,
	type StoryboardSpec,
	type TextElement,
	type TimelineTrack,
} from "../src/index.ts";

const T = 120_000;
const FRAME = 4_000; // ticks per frame at 30 fps

/** Same shape as restorff/apps/gateway/src/editor-skeleton.mjs emptyProject() (copied: this repo ships alone). */
function skeletonProject(): Project {
	const now = "2026-10-20T09:00:00.000Z";
	return {
		metadata: { id: "rc-ad014", name: "Halcyon Cold Brew / AD-014", duration: 0, createdAt: now, updatedAt: now, restorff: { opsVersion: "ops@1", pending: [], media: [] } },
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [
						{ id: "trk-text", name: "TEXT", type: "text", elements: [], hidden: false },
						{ id: "trk-captions", name: "CAPTIONS", type: "text", elements: [], hidden: false },
						{ id: "trk-broll", name: "V2 B-ROLL", type: "video", muted: false, hidden: false, elements: [] },
					],
					main: { id: "trk-main", name: "V1 A-ROLL", type: "video", muted: false, hidden: false, elements: [] },
					audio: [
						{ id: "trk-music", name: "MUSIC", type: "audio", muted: false, elements: [] },
						{ id: "trk-sfx", name: "SFX", type: "audio", muted: false, elements: [], restorff: { role: "sfx" } },
					],
				},
				bookmarks: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		currentSceneId: "scene-main",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			canvasSizeMode: "preset",
			background: { type: "color", color: "#000000" },
		},
		version: 32, // the gateway skeleton moved 31 → 32 on 2026-10-20
		timelineViewState: { zoomLevel: 1, scrollLeft: 0, playheadTime: 0 },
	} as Project;
}

/** Six beats, Halcyon Cold Brew (fictional). */
const SPEC: StoryboardSpec = {
	title: "Halcyon Cold Brew — 6-beat test",
	aspect: "9:16",
	style: "aesthetic-warm",
	cta: "First box 30 % off.",
	beats: [
		{ id: "S01", title: "Hook", shot: "A hand pulls a frosted can from the fridge at 6:02 a.m.", line: "Six a.m. and the kettle is still cold.", duration: 2.5 },
		{ id: "S02", title: "Crack", shot: "The tab cracks; slow-motion foam at the lip.", sound: "the crack", duration: 2 },
		{ id: "S03", title: "Pour", shot: "Pour over ice.", line: "Halcyon is steeped for 18 hours, so you don't have to.", emphasis: ["18"], duration: 3 },
		{ id: "S04", title: "First sip", shot: "Her face on the first sip.", line: "Smooth. No bitter edge.", emphasis: ["Smooth"], effects: ["Digital Zoom"], duration: 2.5 },
		{ id: "S05", title: "Desk", shot: "Desk at 9:40, the can beside a notebook.", line: "No queue. No machine to clean.", effects: ["whip", "checklist"], duration: 2.5 },
		{ id: "S06", title: "End card", kind: "end_card", shot: "The can, the wordmark, the offer.", line: "Halcyon Cold Brew. First box 30 % off.", duration: 2.5 },
	],
};

/** A synthetic VO of every line: 0.38 s a word, 0.35 s between lines (seconds in the voice file). */
function voWords(spec: StoryboardSpec) {
	const words: Array<{ word: string; start: number; end: number }> = [];
	let t = 0.4;
	for (const beat of spec.beats) {
		if (!beat.line) continue;
		for (const word of beat.line.split(/\s+/)) {
			words.push({ word, start: Math.round(t * 1000) / 1000, end: Math.round((t + 0.3) * 1000) / 1000 });
			t += 0.38;
		}
		t += 0.35;
	}
	return { words, duration: Math.round((t + 0.5) * 1000) / 1000 };
}

function halcyonAssets(spec: StoryboardSpec = SPEC): StoryboardAsset[] {
	const vo = voWords(spec);
	return [
		{ id: "S01-fridge", kind: "image", width: 1080, height: 1920 },
		{ id: "S02-crack", kind: "video", duration_s: 1.2, has_audio: true },
		{ id: "S03-pour", kind: "image" },
		{ id: "S03-label", kind: "image" },
		{ id: "S04-sip", kind: "image" },
		{ id: "S05-desk", kind: "image" },
		{ id: "S06-can", kind: "image" },
		{ id: "halcyon-vo", kind: "voice", duration_s: vo.duration, words: vo.words },
		{ id: "halcyon-bed", kind: "music", duration_s: 12 },
		{ id: "whoosh-air", kind: "sfx", duration_s: 0.45, sync_s: 0.27 },
		{ id: "can-crack", kind: "sfx", duration_s: 0.6 },
	];
}

const tracksOf = (project: Project): TimelineTrack[] => {
	const tracks = project.scenes[0].tracks;
	return [...tracks.overlay, tracks.main, ...tracks.audio];
};
const byName = (project: Project, name: string) => tracksOf(project).find((track) => track.name === name);

describe("storyboard compiler (compilers/storyboard.ts, EDT-03)", () => {
	const compiled = compileStoryboard(SPEC, halcyonAssets(), { seed: "AD-014" });

	test("a 6-beat Halcyon storyboard compiles to valid ops@1, every op authored by the compiler", () => {
		expect(validateOps(compiled.ops)).toEqual({ ok: true, errors: [] });
		expect(compiled.report.validation.ok).toBe(true);
		expect(new Set(compiled.ops.map((op) => op.author))).toEqual(new Set(["compiler"]));
		expect(compiled.report.beats.map((beat) => beat.id)).toEqual(["S01", "S02", "S03", "S04", "S05", "S06"]);
		expect(compiled.report.style).toBe("aesthetic-warm");
		// grade agent, 2026-10-20: the style's grade ("warm-morning") is a real look now, so it is placed, not pending;
		// the board's composition effect is still reported, not silently dropped
		expect(compiled.report.pending.map((entry) => entry.op)).not.toContain("grade");
		expect(compiled.report.placed.some((line) => line.startsWith('grade "warm-morning" on the whole cut'))).toBe(true);
		expect(compiled.report.skipped.some((entry) => entry.beat === "S05" && entry.what === "effect checklist")).toBe(true);
		expect(compiled.report.missing.map((entry) => entry.need)).toContain("beat link on elements");
	});

	test("apply() on the gateway's empty skeleton: elements on the expected tracks, no conflicts, invariants hold", () => {
		const result = apply(skeletonProject(), compiled.ops, { seed: "AD-014/compile" });
		expect(result.conflicts).toEqual([]);
		expect(result.ok).toBe(true);
		const project = result.project;
		expect(checkInvariants(project.scenes[0], project.metadata.restorff?.media ?? [])).toEqual([]);
		const main = byName(project, "V1 A-ROLL")?.elements.slice().sort((a, b) => a.startTime - b.startTime) ?? [];
		expect(main).toHaveLength(6);
		expect(main[0].startTime).toBe(0);
		for (let i = 1; i < main.length; i++) expect(main[i].startTime).toBe(main[i - 1].startTime + main[i - 1].duration); // gap-free
		expect(main.map((element) => element.name.slice(0, 3))).toEqual(["S01", "S02", "S03", "S04", "S05", "S06"]);
		expect(byName(project, "V2 B-ROLL")?.elements.map((element) => element.name)).toEqual(["S03 b-roll 1"]);
		expect(byName(project, "VOICE")?.elements).toHaveLength(5); // every beat with a line
		const captions = (byName(project, "CAPTIONS")?.elements ?? []) as TextElement[];
		expect(captions.length).toBeGreaterThan(5);
		for (const chunk of captions) {
			const words = String(chunk.params.content).split(" ").length;
			expect(words).toBeGreaterThanOrEqual(1);
			expect(words).toBeLessThanOrEqual(3);
		}
		const music = byName(project, "MUSIC")?.elements ?? [];
		expect(music.length).toBe(2); // the 12 s bed repeats to cover the cut
		expect(music.some((element) => element.animations?.volume)).toBe(true); // ducked + faded
		expect((byName(project, "SFX")?.elements ?? []).length).toBeGreaterThanOrEqual(3);
		const text = (byName(project, "TEXT")?.elements ?? []) as TextElement[];
		expect(text.map((element) => element.params.content)).toEqual(["First box 30 % off."]);
		expect(project.scenes[0].bookmarks).toHaveLength(6);
		expect(project.settings.loudness?.integratedLufs).toBe(-14);
		// grade agent, 2026-10-20: nothing pending; the grade is a GRADE adjustment layer over the whole cut
		expect(result.changes.unsupported.map((entry) => entry.op)).toEqual([]);
		const gradeLayer = byName(project, "GRADE")?.elements ?? [];
		expect(gradeLayer).toHaveLength(1);
		expect(gradeLayer[0]).toMatchObject({ type: "effect", effectType: "restorff-grade", startTime: 0, duration: project.metadata.duration });
		expect(gradeLayer[0].params.look).toBe("warm-morning");
		// S02 "slow-motion": the 1.2 s clip plays at half speed to fill its 2 s
		const crack = main[1] as { retime?: { rate: number }; duration: number };
		expect(crack.retime?.rate).toBe(0.5);
		expect(crack.duration).toBe(2 * T);
	});

	test("cuts on the word: each voiced beat starts 0.08 s before its first word (±1 frame)", () => {
		const words = compiled.report.words;
		const checked = compiled.report.beats.filter((entry) => entry.voice && entry.id !== "S01" && entry.kind !== "end_card");
		expect(checked.map((beat) => beat.id)).toEqual(["S03", "S04", "S05"]); // not a vacuous loop (LEARNINGS 1)
		for (const beat of checked) {
			const first = words.find((word) => word.start >= beat.start - 1e-9);
			expect(first).toBeDefined();
			const lead = Math.round(((first?.start ?? 0) - beat.start) * T);
			expect(Math.abs(lead - 0.08 * T)).toBeLessThanOrEqual(FRAME);
		}
		// emphasis "18" and "Smooth" become punch-ins on their words
		const s03 = compiled.report.beats.find((beat) => beat.id === "S03");
		const s04 = compiled.report.beats.find((beat) => beat.id === "S04");
		expect(s03?.punches.map((punch) => punch.word)).toEqual(["18"]);
		expect(s04?.punches.map((punch) => punch.word)).toEqual(["Smooth."]);
		// the cue "the crack" found its sfx asset and won over the cut whoosh at the same time
		expect(compiled.report.beats.find((beat) => beat.id === "S02")?.sfx[0]).toContain("can-crack");
	});

	test("the same seed gives the same ops; another seed is still valid", () => {
		const again = compileStoryboard(SPEC, halcyonAssets(), { seed: "AD-014" });
		expect(again.ops).toEqual(compiled.ops);
		const other = compileStoryboard(SPEC, halcyonAssets(), { seed: "AD-014-b" });
		expect(other.report.validation.ok).toBe(true);
		expect(apply(skeletonProject(), other.ops, { seed: "x" }).ok).toBe(true);
	});

	test("a missing shot leaves a gap + a TEXT placeholder; an unmatched cue becomes a pending sfx", () => {
		const assets = halcyonAssets().filter((asset) => asset.id !== "S04-sip" && asset.id !== "can-crack");
		const plan = compileStoryboard(SPEC, assets, { seed: "AD-014" });
		expect(plan.report.skipped.some((entry) => entry.beat === "S04" && entry.what === "shot")).toBe(true);
		expect(plan.report.pending.some((entry) => entry.op === "sfx" && entry.what.includes("the crack"))).toBe(true);
		const result = apply(skeletonProject(), plan.ops, { seed: "gap" });
		expect(result.ok).toBe(true);
		expect(byName(result.project, "V1 A-ROLL")?.elements).toHaveLength(5);
		const text = (byName(result.project, "TEXT")?.elements ?? []) as TextElement[];
		expect(text.some((element) => String(element.params.content).startsWith("S04 · no shot yet"))).toBe(true);
	});

	test("a talking-head beat: the dialogue clip itself is cut to its words on V1 (no VOICE track)", () => {
		const spec: StoryboardSpec = {
			title: "Halcyon talking head",
			beats: [{ id: "S01", title: "Founder", line: "We steep it for eighteen hours.", emphasis: ["18"] }],
		};
		const assets: StoryboardAsset[] = [
			{
				id: "S01-founder",
				kind: "video",
				duration_s: 6,
				words: [
					{ word: "We", start: 1.0, end: 1.2 },
					{ word: "steep", start: 1.25, end: 1.6 },
					{ word: "it", start: 1.65, end: 1.75 },
					{ word: "for", start: 1.8, end: 1.95 },
					{ word: "eighteen", start: 2.0, end: 2.5 },
					{ word: "hours.", start: 2.55, end: 3.0 },
				],
			},
		];
		const plan = compileStoryboard(spec, assets, { seed: "th", sfx: false, marks: false, normalize: false });
		expect(plan.ops.some((op) => op.op === "add_track")).toBe(false);
		const insert = plan.ops.find((op) => op.op === "insert");
		expect(insert).toMatchObject({ track: "trk-main", media: "S01-founder", in: 0.7, out: 3.3 });
		expect(plan.report.beats[0].punches.map((punch) => punch.word)).toEqual(["eighteen"]); // "18" matched by number word
		const result = apply(skeletonProject(), plan.ops, { seed: "th" });
		expect(result.ok).toBe(true);
		expect(byName(result.project, "CAPTIONS")?.elements.length).toBeGreaterThan(0);
	});

	test("the real gateway skeleton, when this repo sits next to restorff/", async () => {
		const url = new URL("../../../../restorff/apps/gateway/src/editor-skeleton.mjs", import.meta.url);
		if (!existsSync(fileURLToPath(url))) return; // the public repo ships without the gateway
		const gateway = (await import(url.href)) as { emptyProject: (args: Record<string, unknown>) => Project };
		const project = gateway.emptyProject({ id: "rc-test", name: "Halcyon", now: "2026-10-20T09:00:00.000Z" });
		const result = apply(project, compiled.ops, { seed: "AD-014/compile" });
		expect(result.conflicts).toEqual([]);
		expect(byName(result.project, "V1 A-ROLL")?.elements).toHaveLength(6);
	});
});

describe("Zeigarnik → spec (compilers/from-board.ts)", () => {
	const shot = (id: string, parent: string, content: Record<string, unknown>) => ({ id, type: "shot", x: 0, y: 0, w: 250, h: null, parent, order: 1, content });
	const column = (id: string, x: number, title: string) => ({ id, type: "column", x, y: 300, w: 280, h: null, parent: null, order: 0, content: { title } });
	const BOARD = {
		id: "brd_test",
		title: "Halcyon Cold Brew — storyboard",
		kind: "board",
		version: 3,
		cards: {
			c1: column("c1", 80, "S01 · Hook"),
			c2: column("c2", 390, "S02 · Crack"),
			c3: column("c3", 700, "S03 · End card"),
			s1: shot("s1", "c1", { shot: "S01", visual: "Close-up: a frosted can. FX: Digital Zoom", words: "Six a.m. and the *kettle* is still cold.", purpose: "Hook.", duration: 2.5 }),
			s2: shot("s2", "c2", { shot: "S02", visual: "The tab cracks; slow-motion foam.", words: "(sound only: the crack)", purpose: "Sensory proof.", duration: 2 }),
			s3: shot("s3", "c3", { shot: "S03", visual: "End card: the can, the offer.", words: "Halcyon Cold Brew. First box 30 % off.", purpose: "CTA.", duration: 2.5 }),
			note: { id: "note", type: "note", x: 80, y: 60, w: 560, h: null, parent: null, order: 0, content: { text: "brief" } },
		},
		links: {},
		blocks: {},
		comments: { m1: { id: "m1", target: "s2", parent: null, text: "Louder crack.", resolved: false } },
	};
	const BRIEF = {
		id: "doc_test",
		title: "Ad brief",
		kind: "doc",
		version: 1,
		cards: {},
		links: {},
		comments: {},
		blocks: {
			b1: { id: "b1", type: "heading", position: 1, content: { text: "Halcyon Cold Brew — brief", level: 1 } },
			b2: { id: "b2", type: "heading", position: 2, content: { text: "Hooks", level: 2 } },
			b3: { id: "b3", type: "quote", position: 3, content: { text: "Six a.m. and the kettle is still cold.", cite: "H1" } },
			b4: { id: "b4", type: "quote", position: 4, content: { text: "You don't have 18 hours. We did.", cite: "H2" } },
			b5: { id: "b5", type: "heading", position: 5, content: { text: "Hold", level: 2 } },
			b6: { id: "b6", type: "paragraph", position: 6, content: { text: "Smooth, no bitter edge. One can is two shots of espresso." } },
			b7: { id: "b7", type: "heading", position: 7, content: { text: "CTA", level: 2 } },
			b8: { id: "b8", type: "paragraph", position: 8, content: { text: "First box 30 % off." } },
			b9: { id: "b9", type: "heading", position: 9, content: { text: "Claims", level: 2 } },
			b10: { id: "b10", type: "table", position: 10, content: { header: true, rows: [["Claim", "Proof", "Status"], ["Steeped 18 hours", "Spec sheet", "on file"]] } },
		},
	};

	test("a storyboard export → beats with lines, cues, emphasis, effects, durations and the end card", () => {
		const spec = specFromBoard(BOARD);
		expect(spec.beats.map((beat) => [beat.id, beat.title, beat.kind, beat.duration])).toEqual([
			["S01", "Hook", "beat", 2.5],
			["S02", "Crack", "beat", 2],
			["S03", "End card", "end_card", 2.5],
		]);
		expect(spec.beats[0]).toMatchObject({ line: "Six a.m. and the kettle is still cold.", emphasis: ["kettle"], effects: ["Digital Zoom"] });
		expect(spec.beats[1].line).toBeUndefined();
		expect(spec.beats[1].sound).toBe("the crack");
		expect(spec.beats[1].notes).toContain("open comment: Louder crack.");
		expect(spec.beats[2]).toMatchObject({ cta: "Halcyon Cold Brew. First box 30 % off.", emphasis: ["30"] });
		expect(spec.source).toEqual({ kind: "board", id: "brd_test", version: 3, title: "Halcyon Cold Brew — storyboard" });
		// the MCP export payload and the REST {board} wrapper give the same spec; the outline is refused
		expect(specFromBoard({ board_id: "brd_test", format: "json", board: BOARD })).toEqual(spec);
		expect(specFromBoard({ board: BOARD })).toEqual(spec);
		expect(() => specFromBoard({ ...BOARD, cards: [{ id: "c1", type: "column", text: "S01 · Hook" }] })).toThrow(/outline/);
	});

	test("a brief doc → hook, one beat per hold sentence, the CTA as end card, claims; and it feeds the board's CTA", () => {
		const spec = specFromBrief(BRIEF, { hook: "H2" });
		expect(spec.beats.map((beat) => [beat.id, beat.line])).toEqual([
			["H2", "You don't have 18 hours. We did."],
			["B01", "Smooth, no bitter edge."],
			["B02", "One can is two shots of espresso."],
			["CTA", "First box 30 % off."],
		]);
		expect(spec.beats[3].kind).toBe("end_card");
		expect(spec.hooks?.map((hook) => hook.id)).toEqual(["H1", "H2"]);
		expect(spec.claims).toEqual([{ claim: "Steeped 18 hours", proof: "Spec sheet", status: "on file" }]);
		const merged = specFromBoard(BOARD, { brief: BRIEF });
		expect(merged.cta).toBe("First box 30 % off.");
		// a brief-only spec compiles too (no visuals: placeholders, reported)
		const plan = compileStoryboard(spec, [], { seed: "brief" });
		expect(plan.report.validation.ok).toBe(true);
		expect(apply(skeletonProject(), plan.ops, { seed: "brief" }).ok).toBe(true);
	});
});
