// grade agent, 2026-10-20: which grade colours a clip (its own effect, the GRADE layer above it) and what the
// inspector's Grade row prints; plus the editor's Grade effect definition against the shared grades.ts.
import { describe, expect, test } from "bun:test";
import { gradeEffectParams, lookParams, NEUTRAL_GRADE } from "@restorffcut/timeline-ops";
import { gradeEffectDefinition } from "@/effects/definitions/grade";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { clipGrade, gradeRowValue, timelineGrade } from "../target";

const T = 120_000;

function clip(id: string, start: number, duration: number, effects: unknown[] = []): TimelineElement {
	return {
		id,
		type: "video",
		name: id,
		mediaId: "media-aroll",
		startTime: start * T,
		duration: duration * T,
		trimStart: 0,
		trimEnd: 0,
		params: {},
		effects,
	} as unknown as TimelineElement;
}

function tracks({ layerOn = true, clipEffects = [] as unknown[] } = {}): SceneTracks {
	const main = { id: "trk-main", name: "V1 A-ROLL", type: "video", muted: false, hidden: false, elements: [clip("a", 0, 10, clipEffects)] };
	const grade = {
		id: "trk-grade",
		name: "GRADE",
		type: "effect",
		hidden: false,
		elements: [
			{
				id: "layer",
				type: "effect",
				name: "Grade · film",
				effectType: "restorff-grade",
				startTime: 0,
				duration: 10 * T,
				trimStart: 0,
				trimEnd: 0,
				params: gradeEffectParams(lookParams("film"), "film"),
			},
		],
	};
	const text = { id: "trk-text", name: "TEXT", type: "text", hidden: false, elements: [] };
	return { overlay: layerOn ? [text, grade] : [text], main, audio: [] } as unknown as SceneTracks;
}

describe("grade sources", () => {
	test("a clip under the GRADE layer reads 'film · timeline'; its own grade comes first", () => {
		const scene = tracks();
		const main = scene.main as TimelineTrack;
		const element = main.elements[0] as TimelineElement;
		expect(timelineGrade(scene, element, main)?.label).toBe("film");
		expect(gradeRowValue(scene, element, main)).toEqual({ text: "film · timeline", graded: true });

		const own = { id: "fx1", type: "restorff-grade", enabled: true, params: gradeEffectParams(lookParams("warm-morning"), "warm-morning") };
		const both = tracks({ clipEffects: [own] });
		const graded = both.main.elements[0] as TimelineElement;
		expect(clipGrade(graded, both.main as TimelineTrack)).toMatchObject({ scope: "clip", effectId: "fx1", label: "warm morning" });
		expect(gradeRowValue(both, graded, both.main as TimelineTrack).text).toBe("warm morning + film · timeline");
	});

	test("no layer, no effect: none; a layer only colours what is below it and overlaps in time", () => {
		const bare = tracks({ layerOn: false });
		expect(gradeRowValue(bare, bare.main.elements[0] as TimelineElement, bare.main as TimelineTrack)).toEqual({ text: "none", graded: false });
		const scene = tracks();
		const later = clip("late", 12, 2);
		expect(timelineGrade(scene, later, scene.main as TimelineTrack)).toBeNull();
		// TEXT sits above the GRADE layer: not graded by it
		const textTrack = scene.overlay[0] as TimelineTrack;
		expect(timelineGrade(scene, clip("t", 1, 1), textTrack)).toBeNull();
	});
});

describe("Grade effect definition", () => {
	test("one keyframable number param per grades.ts slider, defaults = identity uniforms", () => {
		expect(gradeEffectDefinition.type).toBe("restorff-grade");
		const keys = gradeEffectDefinition.params.map((param) => param.key);
		expect(keys).toEqual(Object.keys(NEUTRAL_GRADE));
		expect(gradeEffectDefinition.params.every((param) => param.type === "number")).toBe(true);
		const defaults = Object.fromEntries(gradeEffectDefinition.params.map((param) => [param.key, param.default]));
		const uniforms = gradeEffectDefinition.renderer.passes[0]?.uniforms({ effectParams: defaults, width: 1080, height: 1920, time: 2.5 });
		expect(uniforms).toMatchObject({ u_exposure: 0, u_saturation: 1, u_gamma: 1, u_gain: 1, u_amount: 1, u_grain_seed: 2.5 });
	});
});
