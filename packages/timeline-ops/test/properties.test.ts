import { describe, expect, test } from "bun:test";
import { scalarValueAt } from "../src/animation.ts";
import {
	checkInvariants,
	roundTicksToFrame,
	secondsToTicks,
	ticksPerFrame,
	ticksToSeconds,
	type Op,
	type ScalarChannel,
	type TimelineElement,
} from "../src/index.ts";
import { ticksToFrameRound } from "../src/time.ts";
import { fixtureProject, prng, T } from "./fixture.ts";
import { el, run, scene, shape } from "./helpers.ts";

const C = "claude" as const;
const sec = (ticks: number) => ticks / T;

/** A-roll with three animated channels: linear x, eased scale (bezier), and a step opacity. */
const ANIMATE: Op[] = [
	{ op: "keyframe", author: C, el: "el-aroll", prop: "x", t: 1, value: -200 },
	{ op: "keyframe", author: C, el: "el-aroll", prop: "x", t: 9, value: 200 },
	{ op: "keyframe", author: C, el: "el-aroll", prop: "scale", t: 2, value: 1 },
	{ op: "keyframe", author: C, el: "el-aroll", prop: "scale", t: 12, value: 1.3, ease: "ease_in_out" },
	{ op: "keyframe", author: C, el: "el-aroll", prop: "opacity", t: 0, value: 1 },
	{ op: "keyframe", author: C, el: "el-aroll", prop: "opacity", t: 15, value: 0.5, ease: "hold" },
];

describe("time conversion (exact port of rust/crates/time)", () => {
	test("rust's own cases", () => {
		expect(secondsToTicks(1.5)).toBe(180_000);
		expect(ticksToSeconds(180_000)).toBe(1.5);
		const fps30 = { numerator: 30, denominator: 1 };
		expect(ticksToFrameRound(secondsToTicks(1.26), fps30)).toBe(38);
		expect(roundTicksToFrame(secondsToTicks(1.26), fps30)).toBe(152_000);
		expect(ticksToFrameRound(4000 * 5 + 1, fps30)).toBe(5);
		expect(ticksToFrameRound(4000 * 5 + 2000, fps30)).toBe(6);
		expect(ticksPerFrame({ numerator: 30000, denominator: 1001 })).toBe(4004);
		expect(ticksPerFrame({ numerator: 24000, denominator: 1001 })).toBe(5005);
		expect(ticksPerFrame({ numerator: 7, denominator: 3 })).toBeNull();
		expect(() => secondsToTicks(Number.NaN)).toThrow();
	});

	test("ticks → seconds → ticks is the identity for 10 000 random tick counts", () => {
		const random = prng(7);
		for (let i = 0; i < 10_000; i++) {
			const ticks = Math.floor(random() * 2 ** 40) - 2 ** 39;
			expect(secondsToTicks(sec(ticks))).toBe(ticks);
		}
	});

	test("halves round away from zero, never to -0", () => {
		expect(secondsToTicks(0.5 / T)).toBe(1);
		expect(secondsToTicks(-0.5 / T)).toBe(-1);
		expect(Object.is(secondsToTicks(-0.1 / T), 0)).toBe(true);
	});
});

describe("split / delete / trim algebra", () => {
	test("split at t then delete the right part == trim out to t (animations included, ids aside)", () => {
		const random = prng(11);
		for (let i = 0; i < 40; i++) {
			const cut = 4000 + Math.floor(random() * (20 * T - 8000)); // leaves >= 1 frame (4000 ticks) each side
			const viaSplit = run([...ANIMATE, { op: "split", author: C, el: "el-aroll", t: sec(cut), ref: "r" }, { op: "delete", author: C, el: "r" }]);
			const viaTrim = run([...ANIMATE, { op: "trim", author: C, el: "el-aroll", out: sec(cut) }]);
			expect(viaSplit.ok && viaTrim.ok).toBe(true);
			expect(shape(el(viaSplit.project, "el-aroll"))).toEqual(shape(el(viaTrim.project, "el-aroll")));
		}
	});

	test("split at t then delete the left part == trim in to t (timing and trims)", () => {
		const random = prng(12);
		for (let i = 0; i < 40; i++) {
			// inside the b-roll [5 s, 8 s), leaving >= 1 frame each side: trim refuses sub-frame clips (compute-resize.ts)
			const cut = 5 * T + 4000 + Math.floor(random() * (3 * T - 8000));
			const viaSplit = run([{ op: "split", author: C, el: "el-broll", t: sec(cut), ref: "r" }, { op: "delete", author: C, el: "el-broll" }]);
			const right = el(viaSplit.project, viaSplit.changes.refs.r);
			const viaTrim = el(run([{ op: "trim", author: C, el: "el-broll", in: sec(cut - 5 * T) }]).project, "el-broll");
			for (const field of ["startTime", "duration", "trimStart", "trimEnd", "sourceDuration"] as const) {
				expect(right[field]).toBe(viaTrim[field]);
			}
		}
	});

	test("split conserves the source: both halves still add up, also when retimed", () => {
		const random = prng(13);
		for (const speed of [1, 1.5, 0.75]) {
			for (let i = 0; i < 20; i++) {
				const base = run([{ op: "set", author: C, el: "el-broll", prop: "speed", value: speed }]).project;
				const original = el(base, "el-broll");
				const cut = original.startTime + 1 + Math.floor(random() * (original.duration - 2));
				const result = run([{ op: "split", author: C, el: "el-broll", t: sec(cut), ref: "r" }], {}, base);
				const left = el(result.project, "el-broll");
				const right = el(result.project, result.changes.refs.r);
				expect(left.duration + right.duration).toBe(original.duration);
				expect(left.trimStart).toBe(original.trimStart);
				expect(right.trimEnd).toBe(original.trimEnd);
				const leftSpan = left.trimEnd - original.trimEnd;
				const rightSpan = right.trimStart - original.trimStart;
				expect(leftSpan + rightSpan).toBe(Math.round(original.duration * speed));
			}
		}
	});

	test("split keeps every animated value continuous at the cut", () => {
		const animated = run(ANIMATE).project;
		const original = el(animated, "el-aroll");
		const random = prng(14);
		for (let i = 0; i < 30; i++) {
			const cut = 1 + Math.floor(random() * (20 * T - 2));
			const result = run([{ op: "split", author: C, el: "el-aroll", t: sec(cut), ref: "r" }], {}, animated);
			const left = el(result.project, "el-aroll");
			const right = el(result.project, result.changes.refs.r);
			for (const path of ["transform.positionX", "transform.scaleX", "opacity"]) {
				const expected = scalarValueAt(original.animations?.[path] as ScalarChannel, cut, Number.NaN);
				const fromLeft = scalarValueAt(left.animations?.[path] as ScalarChannel, cut, Number.NaN);
				const fromRight = scalarValueAt(right.animations?.[path] as ScalarChannel, 0, Number.NaN);
				expect(fromLeft).toBeCloseTo(expected, 6);
				expect(fromRight).toBeCloseTo(expected, 6);
			}
		}
	});

	test("ripple_delete shortens the track by exactly the deleted length and leaves no gap", () => {
		const random = prng(15);
		for (let i = 0; i < 20; i++) {
			const a = 1 + Math.floor(random() * (9 * T));
			const b = a + 1 + Math.floor(random() * (9 * T));
			const result = run([
				{ op: "split", author: C, el: "el-aroll", t: sec(a), ref: "mid" },
				{ op: "split", author: C, el: "mid", t: sec(b), ref: "tail" },
				{ op: "ripple_delete", author: C, el: "mid" },
			]);
			const main = scene(result.project).tracks.main.elements;
			expect(main.reduce((sum, e) => sum + e.duration, 0)).toBe(20 * T - (b - a));
			const tail = el(result.project, result.changes.refs.tail);
			expect(tail.startTime).toBe(a);
		}
	});
});

describe("random batches keep every invariant", () => {
	test("30 random batches (best effort) never leave an overlap, a bad trim or a stray keyframe", () => {
		const random = prng(99);
		let project = fixtureProject();
		let applied = 0;
		let rejected = 0;
		let total = 0;
		const pick = <V>(items: V[]): V => items[Math.floor(random() * items.length)];
		const elements = (): TimelineElement[] =>
			[...scene(project).tracks.overlay, scene(project).tracks.main, ...scene(project).tracks.audio].flatMap(
				(track): TimelineElement[] => track.elements,
			);
		const round2 = (value: number) => Math.round(value * 100) / 100;
		for (let round = 0; round < 30; round++) {
			// each batch works on one element drawn from the project as it is now, so times land inside it
			const element = pick(elements());
			const start = sec(element.startTime);
			const length = sec(element.duration);
			const inside = round2(start + 0.1 + random() * Math.max(0, length - 0.2));
			const sourceIn = sec(element.trimStart);
			const ops: Op[] = [];
			for (let i = 0; i < 10; i++) {
				const kind = pick(["split", "trim", "move", "keyframe", "insert", "delete", "ripple_delete", "set", "keyframe", "split"]);
				if (kind === "split") ops.push({ op: "split", author: C, el: element.id, t: inside });
				if (kind === "trim") ops.push({ op: "trim", author: C, el: element.id, in: round2(sourceIn + random() * length * 0.3), out: round2(sourceIn + length * (0.5 + random() * 0.5)) });
				if (kind === "move") ops.push({ op: "move", author: C, el: element.id, t: round2(random() * 20) });
				if (kind === "keyframe") ops.push({ op: "keyframe", author: C, el: element.id, prop: element.type === "audio" ? "volume" : pick(["x", "opacity", "scale"]), t: inside, value: random() });
				if (kind === "insert") ops.push({ op: "insert", author: C, track: "trk-text", t: round2(random() * 20), text: "Halcyon", dur: round2(0.5 + random() * 2) });
				if (kind === "delete" && random() < 0.3) ops.push({ op: "delete", author: C, el: element.id });
				if (kind === "ripple_delete" && random() < 0.3) ops.push({ op: "ripple_delete", author: C, el: element.id, scope: pick(["track", "all"] as const) });
				if (kind === "set" && (element.type === "video" || element.type === "audio")) ops.push({ op: "set", author: C, el: element.id, prop: "speed", value: pick([0.5, 1, 2]) });
			}
			const result = run(ops, { mode: "best_effort", seed: `fuzz-${round}` }, project);
			project = result.project;
			total += ops.length;
			applied += result.changes.ops.filter((change) => change.status === "applied").length;
			rejected += result.conflicts.length;
			expect(checkInvariants(scene(project), project.metadata.restorff?.media ?? [])).toEqual([]);
		}
		// not vacuous: a good share of random ops land, the rest are refused by name (overlap, out_of_range…)
		expect(applied).toBeGreaterThan(total * 0.4);
		expect(applied + rejected).toBe(total);
	});
});
