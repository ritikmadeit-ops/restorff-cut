import { describe, expect, test } from "bun:test";
import { checkInvariants, cutFromTranscript, type TextElement } from "../src/index.ts";
import { TRANSCRIPT, T } from "./fixture.ts";
import { run, scene } from "./helpers.ts";

const CLIP = { el: "el-aroll", start: 0, in: 0, out: 20 };

describe("talking-head auto-cut (compilers/talking-head.ts, EDT-03 seed)", () => {
	const plan = cutFromTranscript(TRANSCRIPT, { clip: CLIP });

	test("finds the retake and every silence longer than 0.35 s", () => {
		expect(plan.retakes).toEqual([{ dropped: "Steeped for twenty hours.", keptAs: "Steeped for twenty hours." }]);
		expect(plan.removed).toEqual([
			{ start: 0, end: 0.45, reason: "head" },
			{ start: 1.55, end: 4.75, reason: "retake", detail: "Steeped for twenty hours." },
			{ start: 6.95, end: 7.35, reason: "silence" },
			{ start: 8.45, end: 20, reason: "tail" },
		]);
		// the 0.2 s pause between "hours." and "Never" is under the threshold, so it stays
		expect(plan.kept).toEqual([
			{ start: 0.45, end: 1.55 },
			{ start: 4.75, end: 6.95 },
			{ start: 7.35, end: 8.45 },
		]);
		expect(plan.stats).toEqual({ sourceSeconds: 20, keptSeconds: 4.4, removedSeconds: 15.6 });
	});

	test("emits cuts from the end backwards, every op authored by the compiler", () => {
		expect(plan.ops.map((op) => op.op)).toEqual([
			"trim",
			"split", "split", "ripple_delete",
			"split", "split", "ripple_delete",
			"split", "ripple_delete",
			"add_captions",
		]);
		expect(new Set(plan.ops.map((op) => op.author))).toEqual(new Set(["compiler"]));
	});

	test("applied to the Halcyon project: three gap-free A-roll pieces with exact source ranges", () => {
		const result = run(plan.ops);
		expect(result.ok).toBe(true);
		const main = scene(result.project).tracks.main.elements.slice().sort((a, b) => a.startTime - b.startTime);
		expect(main.map((e) => [e.startTime, e.duration, e.trimStart, e.trimEnd])).toEqual([
			[0, 132_000, 54_000, 2_214_000],
			[132_000, 264_000, 570_000, 1_566_000],
			[396_000, 132_000, 882_000, 1_386_000],
		]);
		// no kept piece shows any of the first take (source 2.4 s - 3.6 s)
		for (const piece of main) {
			const sourceStart = piece.trimStart;
			const sourceEnd = piece.trimStart + piece.duration;
			expect(sourceEnd <= 2.4 * T || sourceStart >= 3.6 * T).toBe(true);
		}
		expect(checkInvariants(scene(result.project), result.project.metadata.restorff?.media ?? [])).toEqual([]);
		// the music bed on its own track is untouched by the ripple
		expect(scene(result.project).tracks.audio[0].elements[0].startTime).toBe(0);
	});

	test("captions: 1-3-word chunks on the cut timeline, the retake said once", () => {
		const result = run(plan.ops);
		const captions = scene(result.project).tracks.overlay[0];
		expect(captions.restorff?.role).toBe("caption");
		const chunks = captions.elements as TextElement[];
		expect(chunks.map((c) => c.params.content)).toEqual([
			"Halcyon cold brew.",
			"Steeped for twenty",
			"hours.",
			"Never bitter.",
			"Try it today.",
		]);
		for (const chunk of chunks) {
			const words = String(chunk.params.content).split(" ").length;
			expect(words).toBeGreaterThanOrEqual(1);
			expect(words).toBeLessThanOrEqual(3);
		}
		// first caption starts on the first word (0.05 s after the cut, the pad); last ends inside the timeline
		expect(chunks[0].startTime).toBe(6_000);
		const last = chunks[chunks.length - 1];
		expect(last.startTime + last.duration).toBeLessThanOrEqual(528_000);
		for (let i = 1; i < chunks.length; i++) {
			expect(chunks[i].startTime).toBeGreaterThanOrEqual(chunks[i - 1].startTime + chunks[i - 1].duration);
		}
		const said = chunks.map((c) => c.params.content).join(" ");
		expect(said.match(/Steeped/g)).toHaveLength(1);
	});

	test("an aborted take (a sentence the next one starts with) is dropped too, and a clip placed later works", () => {
		// the b-roll clip sits at 5 s on V2 and shows source 0-3 s
		const words = [
			{ text: "Halcyon", start: 0.2, end: 0.45 },
			{ text: "is", start: 0.5, end: 0.6 },
			{ text: "Halcyon", start: 1.5, end: 1.8 },
			{ text: "is", start: 1.85, end: 2.0 },
			{ text: "smooth.", start: 2.05, end: 2.4 },
		];
		const later = cutFromTranscript(words, { clip: { el: "el-broll", start: 5, in: 0, out: 3 }, captions: false });
		expect(later.retakes.map((r) => r.dropped)).toEqual(["Halcyon is"]);
		expect(later.words.map((w) => [w.text, w.start])).toEqual([["Halcyon", 5.05], ["is", 5.4], ["smooth.", 5.6]]);
		const result = run(later.ops);
		expect(result.ok).toBe(true);
		const pieces = scene(result.project).tracks.overlay[1].elements;
		expect(pieces.map((e) => [e.startTime, e.duration, e.trimStart])).toEqual([[5 * T, 1 * T, 1.45 * T]]);
	});

	test("no captions when asked, and custom thresholds are honoured", () => {
		const loose = cutFromTranscript(TRANSCRIPT, { clip: CLIP, silence: 1.0, captions: false });
		expect(loose.ops.some((op) => op.op === "add_captions")).toBe(false);
		// with a 1.0 s threshold only the 1.2 s gap around the retake (and head/tail) is cut
		expect(loose.removed.map((r) => r.reason)).toEqual(["head", "retake", "tail"]);
	});
});
