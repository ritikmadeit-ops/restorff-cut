import { describe, expect, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import {
	crossfadeAutomation,
	crossfadeGainAt,
	planAudioCrossfades,
} from "@/transitions/audio-crossfade";

const T = 120_000;

function clip(id: string, start: number, dur: number, trimStart: number, trimEnd: number, extra: object = {}) {
	return {
		id,
		type: "video",
		name: id,
		mediaId: `m-${id}`,
		startTime: start * T,
		duration: dur * T,
		trimStart: trimStart * T,
		trimEnd: trimEnd * T,
		hidden: false,
		params: {},
		...extra,
	};
}

function tracks(elements: object[]): SceneTracks {
	return {
		overlay: [],
		main: { id: "trk-main", name: "V1 A-ROLL", type: "video", muted: false, hidden: false, elements },
		audio: [],
	} as unknown as SceneTracks;
}

const dissolve = (seconds: number) => ({ transitionIn: { type: "dissolve", duration: seconds * T } });
const all = () => true;

describe("audio crossfades under transitions", () => {
	test("both handles: an overlapping equal-power crossfade over the whole window", () => {
		// A 0-3 s (1 s tail handle), B 3-6 s (1 s head handle), 1 s dissolve → window 2.5-3.5 s.
		const plan = planAudioCrossfades({
			tracks: tracks([clip("a", 0, 3, 0, 1), clip("b", 3, 3, 1, 0, dissolve(1))]),
			isAudible: all,
		});
		expect(plan.get("a")).toEqual({ extendBefore: 0, extendAfter: 0.5, fadeIn: null, fadeOut: { start: 2.5, end: 3.5 } });
		expect(plan.get("b")).toEqual({ extendBefore: 0.5, extendAfter: 0, fadeIn: { start: 2.5, end: 3.5 }, fadeOut: null });
		const a = plan.get("a")!;
		const b = plan.get("b")!;
		for (const t of [2.5, 2.75, 3, 3.25, 3.5]) {
			// Equal power: the two gains' squares sum to 1 everywhere in the window.
			expect(crossfadeGainAt(a, t) ** 2 + crossfadeGainAt(b, t) ** 2).toBeCloseTo(1, 6);
		}
		expect(crossfadeGainAt(a, 3)).toBeCloseTo(Math.SQRT1_2, 6);
		expect(crossfadeGainAt(a, 2.4)).toBe(1);
		expect(crossfadeGainAt(b, 3.6)).toBe(1);
		expect(crossfadeGainAt(b, 2.4)).toBe(0);
	});

	test("no handles: each side fades inside itself (out before the cut, in after it), never a hard edge", () => {
		const plan = planAudioCrossfades({
			tracks: tracks([clip("a", 0, 3, 0, 0), clip("b", 3, 3, 0, 0, dissolve(1))]),
			isAudible: all,
		});
		expect(plan.get("a")).toMatchObject({ extendAfter: 0, fadeOut: { start: 2.5, end: 3 } });
		expect(plan.get("b")).toMatchObject({ extendBefore: 0, fadeIn: { start: 3, end: 3.5 } });
		expect(crossfadeGainAt(plan.get("a"), 3)).toBeCloseTo(0, 9);
		expect(crossfadeGainAt(plan.get("b"), 3)).toBeCloseTo(0, 9);
	});

	test("a short handle extends only as far as the media goes", () => {
		const plan = planAudioCrossfades({
			tracks: tracks([clip("a", 0, 3, 0, 0.2), clip("b", 3, 3, 0.1, 0, dissolve(1))]),
			isAudible: all,
		});
		expect(plan.get("a")?.extendAfter).toBeCloseTo(0.2, 9);
		expect(plan.get("a")?.fadeOut?.end).toBeCloseTo(3.2, 9);
		expect(plan.get("b")?.extendBefore).toBeCloseTo(0.1, 9);
		expect(plan.get("b")?.fadeIn?.start).toBeCloseTo(2.9, 9);
	});

	test("nothing when a side has no audio, when there is no outgoing clip, or on a cut", () => {
		const meeting = [clip("a", 0, 3, 0, 1), clip("b", 3, 3, 1, 0, dissolve(1))];
		expect(planAudioCrossfades({ tracks: tracks(meeting), isAudible: (id) => id !== "a" }).size).toBe(0);
		expect(planAudioCrossfades({ tracks: tracks([clip("b", 0, 3, 1, 0, dissolve(1))]), isAudible: all }).size).toBe(0);
		expect(planAudioCrossfades({ tracks: tracks([clip("a", 0, 3, 0, 1), clip("b", 3, 3, 1, 0)]), isAudible: all }).size).toBe(0);
	});

	test("a retimed clip is not extended into its handles but still fades", () => {
		const plan = planAudioCrossfades({
			tracks: tracks([clip("a", 0, 3, 0, 1, { retime: { rate: 2 } }), clip("b", 3, 3, 1, 0, dissolve(1))]),
			isAudible: all,
		});
		expect(plan.get("a")).toMatchObject({ extendAfter: 0, fadeOut: { start: 2.5, end: 3 } });
		expect(plan.get("b")).toMatchObject({ extendBefore: 0.5 });
	});

	test("a clip between two transitions fades in and out; automation points follow the curve", () => {
		const plan = planAudioCrossfades({
			tracks: tracks([
				clip("a", 0, 3, 0, 1),
				clip("b", 3, 3, 1, 1, dissolve(1)),
				clip("c", 6, 3, 1, 0, dissolve(0.5)),
			]),
			isAudible: all,
		});
		const b = plan.get("b")!;
		expect(b).toEqual({
			extendBefore: 0.5,
			extendAfter: 0.25,
			fadeIn: { start: 2.5, end: 3.5 },
			fadeOut: { start: 5.75, end: 6.25 },
		});
		const points = crossfadeAutomation(b, 2.5, 4);
		expect(points[0]).toEqual({ t: 2.5, gain: 0 });
		expect(points.at(-1)).toEqual({ t: 6.25, gain: expect.closeTo(0, 9) });
		expect(points.every((p, i) => i === 0 || p.t > points[i - 1].t)).toBe(true);
	});
});
