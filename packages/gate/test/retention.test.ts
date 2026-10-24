/**
 * Retention (2026-10-24): the measurer's maths (score.py 0.1.1's detectors) and the HOOK / DEAD rules. Pure: diffs,
 * PCM and maps are made here. The ffmpeg half is tested on synthetic clips in apps/web
 * (src/server/__tests__/retention.test.ts).
 * Run: cd packages/gate && bun test test/retention.test.ts
 */
import { describe, expect, test } from "bun:test";
import { audioOnsets, cutsOnHit, eventWindows, retentionFindings, retentionMap, stretchesOf, visualEvents } from "../src/retention.ts";

const FPS = 15;
/** Per-frame diffs: `base` everywhere, `spikes` (seconds → size) at the frame that enters that time. */
function diffs(seconds: number, spikes: Record<number, number>, base = 0.5): number[] {
	const out = new Array(Math.round(seconds * FPS) - 1).fill(base);
	for (const [t, v] of Object.entries(spikes)) out[Math.round(Number(t) * FPS) - 1] = v;
	return out;
}

describe("visual-change events (score.py visual_events)", () => {
	test("a spike after calm frames is an event at (i + 1) / fps; the floor is 2.0 grey levels", () => {
		const { events, detector } = visualEvents(diffs(10, { 2: 30, 6: 30 }), []);
		expect(events).toEqual([2, 6]);
		expect(detector.threshold).toBe(2);
		expect(detector.diff_events).toBe(2);
	});
	test("a rise right after another (fewer than 4 calm frames) is the same event", () => {
		const d = diffs(10, { 2: 30 });
		d[Math.round(2.2 * FPS) - 1] = 30; // 3 frames later
		expect(visualEvents(d, []).events).toEqual([2]);
	});
	test("continuous motion over the threshold hides a spike inside it (the detector's known blind spot)", () => {
		const d = diffs(10, {}, 0.5);
		for (let i = 30; i < 90; i++) d[i] = 3; // 2.0–6.0 s keeps moving over the 2.0 floor
		d[60] = 25; // a punch-in at ~4.07 s
		const { events } = visualEvents(d, []);
		expect(events.length).toBe(1); // only the start of the motion
		expect(events[0]).toBeCloseTo(31 / 15, 3);
	});
	test("scene cuts merge with frame events closer than 0.2 s; the threshold adapts (median + 3 MAD)", () => {
		const d = diffs(10, { 3: 40 }, 5); // a busy handheld file: median 5 → threshold 5 + 3·0 = 5
		const { events, detector } = visualEvents(d, [2.98, 7.5]);
		expect(events).toEqual([2.98, 7.5]);
		expect(detector.threshold).toBe(5);
	});
});

describe("stretches, onsets, cuts on a hit", () => {
	test("stretches run 0 → first change → … → end, rounded to 0.01 s", () => {
		expect(stretchesOf([2.733, 6], 10)).toEqual([
			{ t: 0, t_end: 2.73, dur: 2.73 },
			{ t: 2.73, t_end: 6, dur: 3.27 },
			{ t: 6, t_end: 10, dur: 4 },
		]);
	});
	test("a burst after silence is an onset (≥ 6 dB over the 8 hops before)", () => {
		const sr = 11025;
		const pcm = new Int16Array(sr * 3);
		for (let i = Math.round(1.5 * sr); i < Math.round(1.7 * sr); i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / sr));
		for (let i = 0; i < pcm.length; i++) pcm[i] += i % 7; // a little noise floor so log10 is finite everywhere
		const onsets = audioOnsets(pcm, sr, 256);
		expect(onsets.length).toBe(1);
		expect(Math.abs(onsets[0] - 1.5)).toBeLessThan(0.05);
	});
	test("a cut within ±0.10 s of an onset is on a hit; chance = the share of time near an onset", () => {
		const got = cutsOnHit([1.0, 3.0], [1.05], 10);
		expect(got.hits).toBe(1);
		expect(got.pct).toBe(50);
		expect(got.chance).toBeGreaterThan(1.9);
		expect(got.chance).toBeLessThan(2.2);
	});
	test("events per 10 s in 10 s windows", () => {
		expect(eventWindows([1, 2, 12], 15)).toEqual([
			{ t: 0, t_end: 10, events: 2, per_10s: 2 },
			{ t: 10, t_end: 15, events: 1, per_10s: 2 },
		]);
	});
});

describe("the map and HOOK / DEAD", () => {
	const late = retentionMap({ duration: 12, diffs: diffs(12, { 2.6: 30, 3.4: 30, 9.4: 30 }), cuts: [], onsets: [] });

	test("the map: first change, longest stretch, stretches over the bar, moving share", () => {
		expect(late.first_change_s).toBe(2.6);
		expect(late.longest).toEqual({ t: 3.4, t_end: 9.4, dur: 6, moving_pct: 0 });
		expect(late.over_bar.map((s) => [s.t, s.t_end])).toEqual([[3.4, 9.4]]);
		expect(late.events_per_10s).toBe(2.5);
	});
	test("a late hook and a still stretch: HOOK + DEAD, both SHOULD, with times, evidence and the fix call", () => {
		const fixCall = { tool: "retention", arguments: { action: "fix", render_id: "rtest01" } };
		const run = retentionFindings(late, { fixCall });
		expect(run.ran).toEqual(["HOOK", "DEAD"]);
		const hook = run.findings.find((f) => f.rule === "HOOK");
		const dead = run.findings.filter((f) => f.rule === "DEAD");
		expect(hook).toMatchObject({ severity: "should", t: 0, t_end: 2.6, evidence: "MEASURED", fix_call: fixCall });
		expect(dead.map((f) => [f.t, f.t_end])).toEqual([[3.4, 9.4]]);
		expect(dead[0].measure?.still_s).toBe(6);
	});
	test("an opening stretch over 3 s is reported once, as HOOK", () => {
		const map = retentionMap({ duration: 8, diffs: diffs(8, { 4: 30, 6: 30 }), cuts: [], onsets: null });
		const run = retentionFindings(map);
		expect(run.findings.map((f) => f.rule)).toEqual(["HOOK"]);
		expect(run.skipped.some((s) => s.rule === "DEAD" && /HOOK/.test(s.why))).toBe(true);
	});
	test("a still tail inside the marked end card is skipped; the same tail unmarked is DEAD", () => {
		const map = retentionMap({ duration: 12, diffs: diffs(12, { 0.4: 30, 2: 30, 4: 30, 6: 30, 7.6: 30 }), cuts: [], onsets: [] });
		expect(retentionFindings(map).findings.map((f) => [f.rule, f.t])).toEqual([["DEAD", 7.6]]);
		const marked = retentionFindings(map, { endCard: { t: 7.4, t_end: 12, why: "element End card" } });
		expect(marked.findings).toEqual([]);
		expect(marked.skipped[0].why).toMatch(/end card/);
	});
	test("a lively file: no findings", () => {
		const map = retentionMap({ duration: 10, diffs: diffs(10, { 0.4: 30, 2.4: 30, 4.4: 30, 6.4: 30, 8.4: 30 }), cuts: [], onsets: [] });
		expect(retentionFindings(map).findings).toEqual([]);
	});
	test("no map (not measured): both rules skipped, nothing invented", () => {
		const run = retentionFindings(null);
		expect(run.findings).toEqual([]);
		expect(run.skipped.map((s) => s.rule)).toEqual(["HOOK", "DEAD"]);
	});
	test("a stretch that keeps moving says so (moving_pct) and asks for a cut", () => {
		const d = diffs(20, { 0.4: 30 }, 0.5);
		for (let i = 180; i < 270; i++) d[i] = 3; // 12.07-18 s drifts over the 2.0 floor; most of the file is calm
		const map = retentionMap({ duration: 20, diffs: d, cuts: [], onsets: [] });
		const dead = retentionFindings(map).findings.find((f) => f.rule === "DEAD" && f.t > 12);
		expect(dead?.measure?.moving_pct).toBeGreaterThanOrEqual(50);
		expect(dead?.fix).toMatch(/cut inside it/);
	});
});
