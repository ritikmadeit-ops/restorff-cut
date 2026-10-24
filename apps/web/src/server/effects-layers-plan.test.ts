// effects-layers agent, 2026-10-20: the pure half of layered effects (manifest recipe → renders, placement, keys, props).
import { describe, expect, test } from "bun:test";
import {
	boxOnCanvas,
	faceProp,
	frameBreakWindow,
	isLayered,
	layeredInputs,
	layerPlan,
	mastheadOffsetFor,
	matteInput,
	plateKeysFor,
	readRecipe,
	storableProps,
	wantsBackgroundStill,
} from "./effects-layers-plan";

// recipes as the collage-fx manifests write them (orbit, frame-break, vertigo, glass-type, doodle-boil, map-route)
const orbit = { effect: { fx: ["FX-01"], stack: ["plate", "self:back", "cutout", "self:front"], inputs: { cutout: "…", face: "…" } } };
const frameBreak = {
	effect: {
		fx: ["FX-04"],
		stack: ["plate", "self:back", "cutout", "self:front"],
		inputs: { cutout: "…", face: "optional" },
		plateKeys: [
			{ t: 0, scale: 1, y: 0 },
			{ t: 0.3, scale: 0.82, y: 0, ease: "ease_in_out" },
			{ t: 3.6667, scale: 0.82, y: 0, ease: "linear" },
			{ t: 3.9667, scale: 1, y: 0, ease: "ease_in_out" },
		],
		plateKeysOn: ["plate", "cutout"],
	},
};
const vertigo = { effect: { fx: ["FX-15"], stack: ["plate", "self", "cutout"], inputs: { cutout: "…", background: "a clean plate", "plate+matte": "…", face: "…" } } };
const glass = { effect: { fx: ["FX-17"], stack: ["plate", "self", "cutout"], inputs: { background: "a still", cutout: "…" } } };
const doodle = { effect: { fx: ["FX-14"], stack: ["plate", "self"], inputs: { matte: "…" } } };
const mapRoute = { effect: { fx: ["FX-54"], stack: ["plate", "self"], inputs: { places: "…" } } };

const image = { type: "image" };
const list = { type: "list", of: image };

describe("layered effects: the recipe", () => {
	test("readRecipe keeps stack, inputs and sorted plate keys; no self entry = no recipe", () => {
		const recipe = readRecipe(frameBreak);
		expect(recipe?.stack).toEqual(["plate", "self:back", "cutout", "self:front"]);
		expect(recipe?.plateKeys?.map((key) => key.t)).toEqual([0, 0.3, 3.6667, 3.9667]);
		expect(recipe?.plateKeys?.[1].ease).toBe("ease_in_out");
		expect(readRecipe({ effect: { stack: ["plate", "cutout"] } })).toBeNull();
		expect(readRecipe({})).toBeNull();
	});

	test("layerPlan: back under the cutout, front above it; a stack without cutout goes on top", () => {
		const plan = layerPlan(readRecipe(orbit)!);
		expect(plan.usesCutout).toBe(true);
		expect(plan.renders).toEqual([
			{ entry: "self:back", layer: "back", side: "below_cutout" },
			{ entry: "self:front", layer: "front", side: "above_cutout" },
		]);
		expect(layerPlan(readRecipe(vertigo)!).renders).toEqual([{ entry: "self", layer: null, side: "below_cutout" }]);
		expect(layerPlan(readRecipe(doodle)!).renders).toEqual([{ entry: "self", layer: null, side: "on_top" }]);
	});

	test("isLayered: person stacks, keys and matte inputs yes; a plain overlay recipe no", () => {
		expect(isLayered(readRecipe(orbit)!, {})).toBe(true);
		expect(isLayered(readRecipe(doodle)!, { matte: list })).toBe(true);
		expect(isLayered(readRecipe(doodle)!, {})).toBe(false);
		expect(isLayered(readRecipe(mapRoute)!, {})).toBe(false);
	});

	test("matte and still inputs: vertigo takes plate+matte (never a clip frame as its clean plate), glass-type a background still", () => {
		expect(matteInput(readRecipe(vertigo)!, { matte: list, plate: image, background: image })).toBe("plate+matte");
		expect(wantsBackgroundStill(readRecipe(vertigo)!, { background: image })).toBe(false);
		expect(wantsBackgroundStill(readRecipe(glass)!, { background: image })).toBe(true);
		expect(matteInput(readRecipe(doodle)!, { matte: list })).toBe("frames");
		expect(layeredInputs(readRecipe(orbit)!, { face: { type: "object" } })).toHaveLength(2);
	});
});

describe("layered effects: keys and props", () => {
	test("plate keys follow the length and frame-break's plateScale / at / shrink", () => {
		const recipe = readRecipe(frameBreak)!;
		const same = plateKeysFor({ recipe, name: "frame-break", duration: 4, defaultDuration: 4, props: {} });
		expect(same.keys.map((key) => key.t)).toEqual([0, 0.3, 3.6667, 3.9667]);
		const longer = plateKeysFor({ recipe, name: "frame-break", duration: 6, defaultDuration: 4, props: { plateScale: 0.7, at: 0, shrink: 0.3 } });
		expect(longer.keys.map((key) => key.t)).toEqual([0, 0.3, 5.6667, 5.9667]);
		expect(longer.keys.map((key) => key.scale)).toEqual([1, 0.7, 0.7, 1]);
		const ui = readRecipe({ effect: { stack: ["plate", "self"], inputs: {}, plateKeys: [{ t: 0, y: 0 }, { t: 0.35, y: 0.25, ease: "ease_out" }] } })!;
		expect(plateKeysFor({ recipe: ui, name: "ui-world", duration: 4, defaultDuration: 4, props: { split: 0.6 } }).keys[1].y).toBe(0.3);
	});

	test("face box: source fractions on the clip's rect → canvas centre + size", () => {
		const full = { left: 0, top: 0, width: 1080, height: 1920 };
		const face = boxOnCanvas([0.4, 0.3, 0.2, 0.1], full, { width: 1080, height: 1920 });
		expect(face.cx).toBeCloseTo(0.5, 6);
		expect(face.cy).toBeCloseTo(0.35, 6);
		expect(faceProp(face)).toEqual({ x: 0.5, y: 0.35, w: 0.2, h: 0.1 });
		// a clip scaled to half, centred: the box moves toward the centre and shrinks
		const half = boxOnCanvas([0.4, 0.3, 0.2, 0.1], { left: 270, top: 480, width: 540, height: 960 }, { width: 1080, height: 1920 });
		expect(half.cy).toBeCloseTo(0.425, 6);
		expect(half.width).toBeCloseTo(0.1, 6);
	});

	test("cover-story masthead: a lower head moves the masthead down; frame-break window: top under the head top, inside the shrunk clip", () => {
		const canvas = { width: 1080, height: 1920 };
		const high = mastheadOffsetFor({ headTop: 0.2, canvas, wordmark: "HALCYON", frameInset: 32 });
		const low = mastheadOffsetFor({ headTop: 0.45, canvas, wordmark: "HALCYON", frameInset: 32 });
		expect(low - high).toBe(480);
		const win = frameBreakWindow({ head: { left: 0.4, top: 0.4, width: 0.2, height: 0.12, cx: 0.5 }, plateScale: 0.82, plateY: 0, width: 0.6, height: 0.42 });
		const shrunkHeadTop = 0.5 + (0.4 - 0.5) * 0.82;
		expect(win.y - win.h / 2).toBeGreaterThan(shrunkHeadTop);
		expect(win.y + win.h / 2).toBeLessThanOrEqual(0.5 + 0.5 * 0.82);
	});

	test("pixel props are never stored or echoed", () => {
		const big = `data:image/png;base64,${"A".repeat(3000)}`;
		expect(storableProps({ matte: [big], matteFps: 30, plate: big, word: "STEEP", tiny: "data:image/gif;base64,R0lGOD" }, ["matte", "plate"])).toEqual({ matteFps: 30, word: "STEEP", tiny: "data:image/gif;base64,R0lGOD" });
	});
});
