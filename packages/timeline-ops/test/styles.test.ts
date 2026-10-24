// Editing-style presets (styles.ts EDITING_STYLE_PRESETS): each expands against the Halcyon fixture, captions are
// restyled, pacing writes keys, unexpressible parts are recorded as pending, compositions land on a MOTION track and
// a second style replaces (never stacks) the first one's compositions.
import { describe, expect, test } from "bun:test";
import {
	BUILTIN_STYLES,
	EDITING_STYLE_PRESETS,
	MOTION_TRACK_NAME,
	type Op,
	type Project,
	type ScalarChannel,
	type StyleCompositionMedia,
	type TextElement,
	type TimelineElement,
} from "../src/index.ts";
import { fixtureProject, T, TRANSCRIPT } from "./fixture.ts";
import { el, run, scene } from "./helpers.ts";

const C = "claude" as const;

/** The fixture with captions on a CAPTIONS track and the A-roll split at 8 s and 14 s (two touching joins). */
function captioned(): Project {
	const result = run([
		{ op: "add_captions", author: C, words: TRANSCRIPT, max_words: 3 },
		{ op: "split", author: C, el: "el-aroll", t: 8, ref: "s2" },
		{ op: "split", author: C, el: "s2", t: 14, ref: "s3" },
	]);
	expect(result.ok).toBe(true);
	return result.project;
}

const style = (id: string, params?: Record<string, unknown>): Op => ({
	op: "apply_style",
	author: "user",
	preset_id: `restorff/style/${id}`,
	...(params ? { params } : {}),
});

describe("editing style presets", () => {
	test("the five picker styles exist, each registered as restorff/style/<id>", () => {
		expect(EDITING_STYLE_PRESETS.map((preset) => preset.id)).toEqual([
			"fast-ugc",
			"talking-head",
			"aesthetic-warm",
			"moody-captions",
			"paper-collage",
		]);
		for (const preset of EDITING_STYLE_PRESETS) {
			expect(typeof BUILTIN_STYLES[`restorff/style/${preset.id}`]).toBe("function");
			expect(preset.notes.length).toBeGreaterThan(0);
		}
	});

	for (const preset of EDITING_STYLE_PRESETS) {
		test(`${preset.id}: applies atomically to the fixture with no conflicts`, () => {
			const result = run([style(preset.id)], {}, captioned());
			expect(result.conflicts).toEqual([]);
			expect(result.ok).toBe(true);
			// every expanded op is authored by the preset
			for (const op of result.changes.applied) {
				if (op.op !== "apply_style") expect(op.author).toBe("preset");
			}
		});
	}

	test("captions take the style's font, size and position on every caption element", () => {
		const project = captioned();
		const result = run([style("moody-captions")], {}, project);
		const captions = scene(result.project).tracks.overlay.find((track) => track.name === "CAPTIONS");
		expect(captions?.elements.length).toBeGreaterThan(0);
		for (const element of captions?.elements as TextElement[]) {
			expect(element.params.fontFamily).toBe("Bebas Neue");
			expect(element.params.fontSize).toBe(13);
			expect(element.params["transform.positionY"]).toBe(0);
		}
	});

	test("fast-ugc: jump punch-ins alternate 1 / 1.12 every 1.5 s with step segments; whips and grade are real", () => {
		const result = run([style("fast-ugc")], {}, captioned());
		const first = el(result.project, "el-aroll");
		const channel = first.animations?.["transform.scaleX"] as ScalarChannel;
		expect(channel.keys.map((key) => key.value)).toEqual([1, 1.12, 1, 1.12, 1, 1.12]);
		expect(channel.keys.map((key) => key.time)).toEqual([0, 1.5 * T, 3 * T, 4.5 * T, 6 * T, 7.5 * T]);
		expect(channel.keys.slice(0, -1).every((key) => key.segmentToNext === "step")).toBe(true);
		const pending = result.changes.unsupported.map((record) => record.op);
		// media agent, 2026-10-20: whips are real transitions now (project v32 `transitionIn`), no longer pending.
		expect(pending.filter((op) => op === "transition")).toHaveLength(0);
		// grade agent, 2026-10-20: the punchy grade is the real restorff-grade effect now, not pending
		expect(pending).not.toContain("grade");
	});

	test("aesthetic-warm: a slow push from 1 to 1.08 across each clip, eased", () => {
		const result = run([style("aesthetic-warm")], {}, captioned());
		const first = el(result.project, "el-aroll");
		const channel = first.animations?.["transform.scaleY"] as ScalarChannel;
		expect(channel.keys.map((key) => key.value)).toEqual([1, 1.08]);
		expect(channel.keys[1]?.time).toBe(first.duration);
		expect(channel.keys[0]?.segmentToNext).toBe("bezier");
	});

	test("talking-head: punch-ins ease in and back out (pairs of 1 → 1.06 → 1)", () => {
		const result = run([style("talking-head")], {}, captioned());
		const first = el(result.project, "el-aroll");
		const values = (first.animations?.["transform.scaleX"] as ScalarChannel).keys.map((key) => key.value);
		expect(values[0]).toBe(1);
		expect(values.filter((v) => v === 1.06).length).toBeGreaterThan(0);
		expect(values.at(-1)).toBe(1);
	});

	test("paper-collage: no pacing keys, captions on a yellow tag", () => {
		const result = run([style("paper-collage")], {}, captioned());
		expect(el(result.project, "el-aroll").animations?.["transform.scaleX"]).toBeUndefined();
		const captions = scene(result.project).tracks.overlay.find((track) => track.name === "CAPTIONS");
		const first = captions?.elements[0] as TextElement;
		expect(first.params["background.enabled"]).toBe(true);
		expect(first.params["background.color"]).toBe("#F2D04B");
	});

	test("compositions passed in params land on a MOTION track on top, at their times, for their length", () => {
		const media: StyleCompositionMedia[] = [
			{ name: "paper-cut", media: "media-still", t: 0, dur: 3.5, title: "Paper cut" },
			{ name: "map-route", media: "media-broll", t: 4, dur: 4 },
		];
		const result = run([style("paper-collage", { compositions: media })], {}, captioned());
		expect(result.ok).toBe(true);
		const overlay = scene(result.project).tracks.overlay;
		expect(overlay[0]?.name).toBe(MOTION_TRACK_NAME);
		expect(overlay[0]?.type).toBe("video");
		const placed = overlay[0]?.elements ?? [];
		expect(placed.map((element) => [element.startTime, element.duration])).toEqual([
			[0, 3.5 * T],
			[4 * T, 4 * T],
		]);
		expect(placed.every((element) => element.restorff?.createdBy === "preset")).toBe(true);
	});

	test("a second style replaces the first one's compositions instead of stacking them", () => {
		const first = run(
			[style("fast-ugc", { compositions: [{ name: "big-word-punch", media: "media-broll", dur: 3 }] })],
			{},
			captioned(),
		);
		expect(first.ok).toBe(true);
		const second = run(
			[style("aesthetic-warm", { compositions: [{ name: "cover-story", media: "media-broll", dur: 4 }] })],
			{ seed: "second" },
			first.project,
		);
		expect(second.ok).toBe(true);
		const motion = scene(second.project).tracks.overlay.filter((track) => track.name.startsWith(MOTION_TRACK_NAME));
		expect(motion).toHaveLength(1);
		expect(motion[0]?.elements).toHaveLength(1);
		expect(motion[0]?.elements[0]?.name).toBe("cover-story");
		expect(motion[0]?.elements[0]?.duration).toBe(4 * T);
	});

	test("a user's own clip on the MOTION track is kept; the style's composition goes on a second track", () => {
		const base = run([style("fast-ugc", { compositions: [{ name: "big-word-punch", media: "media-broll", dur: 3 }] })], {}, captioned());
		const motionId = scene(base.project).tracks.overlay[0]?.id as string;
		const withUser = run(
			[{ op: "insert", author: "user", track: motionId, t: 5, media: "media-broll", in: 0, out: 2 }],
			{ seed: "user" },
			base.project,
		);
		expect(withUser.ok).toBe(true);
		const again = run(
			[style("moody-captions", { compositions: [{ name: "big-word-punch", media: "media-broll", t: 4, dur: 3 }] })],
			{ seed: "again" },
			withUser.project,
		);
		expect(again.ok).toBe(true);
		const motion = scene(again.project).tracks.overlay.filter((track) => track.name.startsWith(MOTION_TRACK_NAME));
		expect(motion.map((track) => track.elements.length).sort()).toEqual([1, 1]);
		const user = motion.flatMap((track) => track.elements as TimelineElement[]).find((element) => element.restorff?.createdBy === "user");
		expect(user?.startTime).toBe(5 * T);
	});

	test("a negative time places a composition before the end of the A-roll (an end card)", () => {
		const result = run(
			[
				style("fast-ugc", {
					compositions: [
						{ name: "big-word-punch", media: "media-broll", dur: 3 },
						{ name: "cta-social", media: "media-broll", dur: 3.5 },
					],
				}),
			],
			{},
			captioned(),
		);
		expect(result.ok).toBe(true);
		const placed = scene(result.project).tracks.overlay[0]?.elements ?? [];
		// fixture A-roll ends at 20 s; the preset says cta-social at -3.5
		expect(placed.map((element) => element.startTime)).toEqual([0, 16.5 * T]);
	});

	test("deterministic: same project + style + seed gives the same output", () => {
		const a = run([style("fast-ugc")], {}, captioned());
		const b = run([style("fast-ugc")], {}, captioned());
		expect(JSON.stringify(a.project)).toBe(JSON.stringify(b.project));
	});

	test("no captions in the project: the style still applies (captions skipped, not a conflict)", () => {
		const result = run([style("fast-ugc")], {}, fixtureProject());
		expect(result.ok).toBe(true);
		expect(result.changes.applied.some((op) => op.op === "set_caption_style")).toBe(false);
	});
});
