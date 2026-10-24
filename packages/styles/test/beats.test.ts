/**
 * explainer-v2 (2026-10-20): beats as {line, picture, tag}, feel → pacing, the v2 plan, and the study card's accent /
 * grain / cues. Fictional Halcyon data only (the paper-collage recreation's script and pictures).
 */
import { describe, expect, test } from "bun:test";
import { apply, validateOps } from "@restorffcut/timeline-ops";
import {
	beatLengths,
	bindBeats,
	bindCompositions,
	cuesFromNames,
	explainerPlanV2,
	grainBands,
	type PaletteColor,
	type PictureAsset,
	type PixelFrame,
	recoverSaturated,
	resolveStills,
	scriptOf,
	sentencesOf,
	stem,
	styleCardFromReferences,
	type StyleCard,
} from "../src/index.ts";
import { project } from "./fixture.ts";

const LINES = [
	"How Halcyon gets from farm to bottle",
	"It starts on one estate, 1,400 metres up",
	"Picked by hand, then roasted light",
	"Steeped cold for 18 hours",
	"Bottled the same week",
	"Poured at the cafe on day 5",
	"Farm to bottle in five days",
];
const PLACES = ["Halcyon Estate", "Roastery", "Bottling", "Cafe"];
const DATES = [
	{ date: "Day 1", text: "Picked" },
	{ date: "Day 3", text: "Roasted" },
	{ date: "Day 4", text: "Steeped 18 h" },
	{ date: "Day 5", text: "Bottled" },
];
const PICTURES: PictureAsset[] = [
	{ id: "m-farm", kind: "image", name: "halcyon-farm.jpg", width: 1920, height: 1080 },
	{ id: "m-roast", kind: "image", name: "halcyon-roastery.jpg", width: 1920, height: 1080 },
	{ id: "m-bottle", kind: "image", name: "halcyon-bottle.png", width: 800, height: 1200, alpha: true },
	{ id: "m-cafe", kind: "image", name: "halcyon-cafe.jpg", width: 1920, height: 1080 },
	{ id: "m-pour", kind: "video", name: "halcyon-pour.mp4", duration: 5, width: 1920, height: 1080 },
];

function card(): StyleCard {
	const color = (hex: string, share: number, saturation: number, hue: number, luma: number, role: PaletteColor["role"]): PaletteColor => {
		const n = Number.parseInt(hex.slice(1), 16);
		return { hex, rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], share, saturation, hue, luma, role };
	};
	return {
		schema: "style-card@1",
		references: { images: 7, videos: 5, folders: ["Map zoom", "Paper depth"], frames: 55 },
		palette: [
			color("#38667B", 0.3, 0.37, 199, 0.37, "tone"),
			color("#BEB497", 0.23, 0.25, 45, 0.7, "paper"),
			color("#232624", 0.13, 0.04, 140, 0.14, "ink"),
			color("#AC7724", 0.06, 0.65, 37, 0.5, "tone"),
			color("#C14033", 0.01, 0.58, 5, 0.33, "accent"),
		],
		mood: { temperature: 0.05, label: "warm", brightness: 0.5, contrast: 0.2, saturation: 0.3 },
		type: { guess: null, question: "", options: [] },
		motion: { energy: 0.03, label: "gentle movement" },
		texture: { grain: 2.07, label: "textured paper (fine grain)", paper: true },
		pacing: { avgShot: 2.41, cutsPer10s: 2.1, shots: 10, measuredSeconds: 24.1, label: "medium" },
		notes: [],
		questions: [{ id: "format", ask: "", options: [], suggested: "16:9" }],
		cues: ["map", "globe", "zoom", "torn-hole", "halftone", "parallax", "scraps", "cut-outs", "paper"],
	};
}

describe("explainer-v2: beats bound to pictures by subject", () => {
	const bound = bindBeats(
		LINES.map((line) => ({ line })),
		PICTURES,
		{ places: PLACES, dates: DATES },
	);

	test("stems match across word forms", () => {
		expect(stem("bottled")).toBe(stem("Bottling"));
		expect(stem("bottle")).toBe(stem("bottled"));
		expect(stem("café")).toBe("cafe");
		expect(stem("roasted")).toBe("roast");
	});

	test("every line leads with the picture of its subject (the recreation paired them by position)", () => {
		const lead = bound.map((beat) => beat.pictures[0]?.id ?? null);
		expect(lead).toEqual(["m-farm", "m-farm", "m-farm", "m-pour", "m-bottle", "m-cafe", "m-farm"]);
		// "Poured at the cafe on day 5": the cafe first, the pour clip second — never the farm
		expect(bound[5]?.pictures.map((p) => p.id)).toEqual(["m-cafe", "m-pour"]);
		// "Picked by hand, then roasted light": both subjects get a cut-out
		expect(bound[2]?.pictures.map((p) => p.id).sort()).toEqual(["m-farm", "m-roast"]);
		expect(bound[5]?.pictures[0]?.why).toContain("cafe");
	});

	test("tags come from places, dates and subjects — never the topic", () => {
		expect(bound.map((beat) => beat.tag)).toEqual([
			"HALCYON ESTATE → BOTTLING",
			"HALCYON ESTATE",
			"DAY 1 PICKED · DAY 3 ROASTED",
			"DAY 4 · STEEPED 18 H",
			"BOTTLING · DAY 5",
			"CAFE · DAY 5",
			"HALCYON ESTATE → BOTTLING",
		]);
		for (const beat of bound) expect(beat.tag).not.toContain("HOW HALCYON");
	});

	test("a line nothing matches says so instead of taking the next picture", () => {
		const [beat] = bindBeats([{ line: "Then the van leaves at dawn" }], PICTURES, { places: PLACES });
		expect(beat?.pictures).toEqual([]);
		expect(beat?.unmatched).toContain("no picture");
		const [named] = bindBeats([{ line: "Then the van leaves at dawn", picture: "halcyon-cafe" }], PICTURES);
		expect(named?.pictures[0]?.id).toBe("m-cafe");
		expect(named?.explicit).toBe(true);
	});

	test("captions count like names", () => {
		const pics: PictureAsset[] = [
			{ id: "a", kind: "image", name: "IMG_0412.jpg", caption: "the roaster at work" },
			{ id: "b", kind: "image", name: "IMG_0413.jpg", caption: "rows on the estate" },
		];
		const [beat] = bindBeats([{ line: "Roasted light, the same day" }], pics);
		expect(beat?.pictures[0]?.id).toBe("a");
	});

	test("the script comes from beats, else the narration's sentences, else the answers (said so)", () => {
		expect(scriptOf({ beats: ["One", { line: "Two", tag: "x" }] }).beats).toEqual([{ line: "One" }, { line: "Two", tag: "x" }]);
		expect(sentencesOf("Here's how Halcyon gets from farm to bottle. It starts on one estate. Done.")).toEqual(["Here's how Halcyon gets from farm to bottle.", "It starts on one estate. Done."]);
		const made = scriptOf({ title: "Farm to bottle", places: ["Halcyon Estate"], verdict: "Five days" });
		expect(made.source).toBe("made");
		expect(made.notes[0]).toContain("no beats or narration");
	});
});

describe("explainer-v2: feel drives pacing", () => {
	test("punchy cuts ~5 times per 10 s, nostalgic ~3; length_s adds shots, not slower cuts", () => {
		const punchy = beatLengths(LINES, "punchy");
		const nostalgic = beatLengths(LINES, "nostalgic");
		expect(punchy.plannedCutsPer10s).toBeGreaterThanOrEqual(4.7);
		expect(nostalgic.plannedCutsPer10s).toBeLessThanOrEqual(3.4);
		expect(nostalgic.totalS).toBeGreaterThan(punchy.totalS);
		const long = beatLengths(LINES, "punchy", 40);
		expect(Math.abs(long.totalS - 40)).toBeLessThan(0.5);
		expect(long.plannedCutsPer10s).toBeGreaterThanOrEqual(4.7);
		expect(long.shots.reduce((a, b) => a + b, 0)).toBeGreaterThan(punchy.shots.reduce((a, b) => a + b, 0));
		const short = beatLengths(LINES, "punchy", 8);
		expect(short.notes[0]).toContain("shorter than the script reads");
	});
});

describe("explainer-v2: the plan", () => {
	const answers = { footage: "mine" as const, format: "16:9" as const, feel: "punchy" as const, length_s: 40, beats: LINES, places: PLACES, dates: DATES, number: "18", verdict: "Five days", topic: "how Halcyon's farm-to-bottle route works" };
	const plan = explainerPlanV2(card(), answers, PICTURES, { start: 12, canvas: { width: 1920, height: 1080 }, author: "claude" });

	test("validates, hits the pace, binds and applies with no conflicts (and with failed renders)", () => {
		expect(validateOps(plan.ops).ok).toBe(true);
		expect(plan.pacing.planned_cuts_per_10s).toBeGreaterThanOrEqual(4.7);
		const bound = Object.fromEntries(plan.compositions.map((c) => [c.key, { media: `media-render-${c.key}`, dur: c.dur }]));
		expect(apply(project(), bindCompositions(plan, bound).ops, { seed: "v2", mode: "best_effort" }).conflicts).toEqual([]);
		// the paper ground and the map fail: the ground falls back to the beat's picture, the map's keyframes go too
		const failed = Object.fromEntries(plan.compositions.filter((c) => c.key === "paper-ground" || c.name === "map-route").map((c) => [c.key, null]));
		const partial = bindCompositions(plan, { ...bound, ...failed });
		expect(partial.dropped).toContain("paper-ground");
		expect(apply(project(), partial.ops, { seed: "v2b", mode: "best_effort" }).conflicts).toEqual([]);
	});

	test("every photo shot shows a picture its beat's line is about", () => {
		for (const shot of plan.shots) {
			if (shot.main !== "picture") continue;
			const ids = plan.binding[shot.beat]?.pictures.map((p) => p.id) ?? [];
			expect(ids).toContain(shot.picture as string);
		}
	});

	test("title tiles from the title / beat 1, not the number; the number sits on its own line", () => {
		const title = plan.compositions.find((c) => c.key.endsWith("-paper-cut") && c.beat === 0);
		expect(title?.props.text).toBe("HALCYON");
		const tiles = plan.compositions.find((c) => c.key.endsWith("number-tiles"));
		expect(tiles?.props.text).toBe("18 HOURS");
		expect(tiles?.beat).toBe(3);
	});

	test("cut-outs: several pictures, a thick outline in the card's accent; scraps; display text explicit", () => {
		const cutouts = plan.compositions.filter((c) => c.title === "Cut-outs with outline");
		expect(cutouts.length).toBeGreaterThan(0);
		for (const c of cutouts) {
			expect(c.props.outline).toBe("#C14033");
			expect(c.props.outlineWidth as number).toBeGreaterThanOrEqual(20);
		}
		expect(cutouts.some((c) => (c.props.pieces as unknown[]).length >= 2)).toBe(true);
		expect(plan.compositions.some((c) => c.key.startsWith("scraps-"))).toBe(true);
		// text inside pieces is set explicitly — to "" where the TAGS / TEXT tracks already say it (no example text, no
		// tag printed twice)
		const parallax = plan.compositions.find((c) => c.name === "parallax-strip");
		expect(parallax?.props.caption).toBe("");
		expect(parallax?.props.key).toBe("");
		expect(parallax?.props.hero).toBe("still:m-bottle");
		const halftone = plan.compositions.find((c) => c.name === "halftone-push");
		expect(halftone?.props.match).toBe("none");
		expect(halftone?.props.label).toBe("");
		// a cut-out PNG is never full frame on the main track: it is a hero cut-out
		expect(plan.ops.some((op) => op.op === "insert" && op.track === "main" && op.media === "m-bottle")).toBe(false);
		expect(plan.compositions.some((c) => c.title === "Hero cut-out")).toBe(true);
		expect(plan.compositions.some((c) => c.key.endsWith("torn-hole"))).toBe(true);
		expect(plan.compositions.some((c) => c.name === "map-route")).toBe(true);
		expect(plan.report.effects.filter((e) => /FX-(5[2-9]|6[01])/.test(e)).length).toBeGreaterThanOrEqual(6);
	});

	test("still placeholders resolve to data: URLs", () => {
		const { value, unresolved } = resolveStills({ pieces: [{ image: "still:m-farm" }, { image: "still:nope" }] }, (id) => (id === "m-farm" ? "data:image/jpeg;base64,AA" : null));
		expect((value as { pieces: Array<{ image: string }> }).pieces[0]?.image).toBe("data:image/jpeg;base64,AA");
		expect(unresolved).toEqual(["nope"]);
	});
});

describe("explainer-v2: study card accent, grain, cues", () => {
	const frame = (w: number, h: number, fill: (x: number, y: number) => [number, number, number]): PixelFrame => {
		const data = new Uint8ClampedArray(w * h * 4);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const [r, g, b] = fill(x, y);
				data.set([r, g, b, 255], (y * w + x) * 4);
			}
		}
		return { width: w, height: h, data };
	};
	let seed = 3;
	const noise = () => {
		seed = (seed * 9301 + 49297) % 233280;
		return seed / 233280 - 0.5;
	};
	const cream: [number, number, number] = [236, 226, 204];
	const mustard: [number, number, number] = [217, 168, 48];
	const red: [number, number, number] = [200, 55, 45];

	test("a red outline on every sheet beats a full-frame mustard paper for the accent", () => {
		const outlined = (base: [number, number, number]) => frame(64, 36, (x, y) => (x < 2 || y < 2 || x > 61 || y > 33 ? red : base));
		const refs = [
			{ name: "paper-mustard.png", folder: "Paper depth", kind: "image" as const, width: 1280, height: 720, frames: [frame(64, 36, () => mustard)] },
			...[1, 2, 3, 4].map((i) => ({ name: `cutout-${i}.png`, folder: "Paper depth", kind: "image" as const, width: 1280, height: 720, frames: [outlined(cream)] })),
		];
		const c = styleCardFromReferences(refs);
		const accent = c.palette.find((color) => color.role === "accent");
		expect(accent?.hue ?? 99).toBeLessThan(15);
	});

	test("a small saturated colour k-means merged away comes back", () => {
		const frames = [frame(64, 36, (x) => (x < 1 ? red : mustard)), frame(64, 36, () => cream)];
		const palette = recoverSaturated(frames, [
			{ hex: "#D9A830", rgb: mustard, share: 0.5, luma: 0.67, saturation: 0.69, hue: 43, role: "tone" },
			{ hex: "#ECE2CC", rgb: cream, share: 0.5, luma: 0.89, saturation: 0.4, hue: 41, role: "paper" },
		]);
		expect(palette.some((color) => color.hue < 15 && color.saturation > 0.4)).toBe(true);
		expect(Math.abs(palette.reduce((sum, color) => sum + color.share, 0) - 1)).toBeLessThan(1e-9);
	});

	test("grain: flat colour 0, blurred paper noise textured", () => {
		expect(grainBands(frame(64, 64, () => cream))?.grain).toBe(0);
		const raw = Array.from({ length: 64 * 64 }, () => noise() * 40);
		const blurred = frame(64, 64, (x, y) => {
			let s = 0;
			let n = 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const xx = Math.min(63, Math.max(0, x + dx));
				const yy = Math.min(63, Math.max(0, y + dy));
				s += raw[yy * 64 + xx] as number;
				n++;
			}
			const v = s / n;
			return [cream[0] + v, cream[1] + v, cream[2] + v];
		});
		expect(grainBands(blurred)?.grain ?? 0).toBeGreaterThan(0.6);
	});

	test("cues from file and folder names", () => {
		expect(cuesFromNames([{ name: "torn-hole.mp4", folder: "Paper depth" }, { name: "globe.png", folder: "Map zoom" }])).toEqual(["map", "globe", "zoom", "torn-hole", "parallax", "paper"]);
	});
});
