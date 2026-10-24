import { describe, expect, test } from "bun:test";
import {
	buildCaptionOps,
	CAPTION_STYLE_PRESETS,
	chunkWordGroups,
	cutFromTranscript,
	editChunkText,
	getCaptionStyle,
	mergeChunkWithNext,
	nudgeChunk,
	splitChunk,
	type MeasureText,
	type TextElement,
} from "../src/index.ts";
import { TRANSCRIPT } from "./fixture.ts";
import { run, scene } from "./helpers.ts";

/** Fake measure: every character is 0.55 em wide (em = size × 1920 / 90 px), plus letter spacing. */
const measure: MeasureText = (text, font) => text.length * (0.55 * (font.size * 1920) / 90 + font.letterSpacing);
const CANVAS = { width: 1080, height: 1920 };
const WORDS = [
	{ text: "Halcyon", start: 0.5, end: 0.9 },
	{ text: "cold", start: 0.95, end: 1.2 },
	{ text: "brew.", start: 1.25, end: 1.6 },
	{ text: "Steeped", start: 2.0, end: 2.4 },
	{ text: "twenty", start: 2.45, end: 2.8 },
	{ text: "hours.", start: 2.85, end: 3.3 },
];

describe("caption styles (captions.ts, EDT-12)", () => {
	const doc = chunkWordGroups(WORDS, { maxWords: 3 });

	test("at least five styles, each one applies cleanly through the reducer", () => {
		expect(CAPTION_STYLE_PRESETS.length).toBeGreaterThanOrEqual(5);
		for (const style of CAPTION_STYLE_PRESETS) {
			const chunks = chunkWordGroups(WORDS, { maxWords: style.maxWords });
			const build = buildCaptionOps({ chunks, style, canvas: CANVAS, measure });
			const result = run(build.ops, { mode: "atomic" });
			expect(result.conflicts).toEqual([]);
			expect(result.ok).toBe(true);
			const captions = scene(result.project).tracks.overlay.find((track) => track.name === "CAPTIONS");
			expect(captions?.restorff?.role).toBe("caption");
			expect(captions?.elements.length).toBe(chunks.length);
		}
	});

	test("every chunk stays inside the safe area (x 60-940, y 220-1500 on 1080×1920)", () => {
		for (const style of CAPTION_STYLE_PRESETS) {
			const chunks = chunkWordGroups([{ text: "Unbelievably-smooth-coldbrew", start: 0, end: 1 }], { maxWords: 1 });
			const build = buildCaptionOps({ chunks, style, canvas: CANVAS, measure });
			for (const chunk of build.chunks) {
				const left = chunk.x + 540 - chunk.width / 2;
				const right = chunk.x + 540 + chunk.width / 2;
				expect(left).toBeGreaterThanOrEqual(60 - 0.5);
				expect(right).toBeLessThanOrEqual(940 + 0.5);
				expect(chunk.y + 960).toBeGreaterThanOrEqual(220);
				expect(chunk.y + 960).toBeLessThanOrEqual(1500);
				expect(chunk.shrunk).toBe(true);
			}
		}
	});

	test("word-pop: one highlighted word element per word, on its own track above the captions", () => {
		const build = buildCaptionOps({ chunks: doc, style: getCaptionStyle("word-pop"), canvas: CANVAS, measure });
		const result = run(build.ops);
		const overlay = scene(result.project).tracks.overlay;
		expect(overlay.slice(0, 3).map((track) => track.name)).toEqual(["CAPTION WORDS", "CAPTIONS", "CAPTION SHADOW"]);
		const words = overlay[0].elements as TextElement[];
		expect(words.map((element) => element.params.content)).toEqual(WORDS.map((word) => word.text));
		expect(words.every((element) => element.params["background.enabled"] === true)).toBe(true);
		// words are placed left to right inside their chunk
		expect(Number(words[0].params["transform.positionX"])).toBeLessThan(Number(words[1].params["transform.positionX"]));
	});

	test("serif karaoke: the spoken prefix grows word by word, left-aligned", () => {
		const build = buildCaptionOps({ chunks: doc, style: getCaptionStyle("serif-box"), canvas: CANVAS, measure });
		const result = run(build.ops);
		const words = scene(result.project).tracks.overlay[0].elements as TextElement[];
		expect(words.slice(0, 3).map((element) => element.params.content)).toEqual([
			"Halcyon",
			"Halcyon cold",
			"Halcyon cold brew.",
		]);
		expect(words[0].params.textAlign).toBe("left");
	});

	test("arbitrary float word times (approximate timings, nudges) never make overlapping elements", () => {
		let t = 0.1234567;
		const words = Array.from({ length: 40 }, (_, i) => {
			const start = t;
			const end = start + 0.1 + ((i * 7919) % 13) / 37;
			t = end + ((i * 104729) % 5) / 31;
			return { text: `w${i}`, start, end };
		});
		for (const style of CAPTION_STYLE_PRESETS) {
			const chunks = nudgeChunk(chunkWordGroups(words, { maxWords: style.maxWords }), 3, 1 / 30);
			const result = run(buildCaptionOps({ chunks, style, canvas: CANVAS, measure }).ops);
			expect(result.conflicts).toEqual([]);
		}
	});

	test("caption document edits", () => {
		const merged = mergeChunkWithNext(doc, 0);
		expect(merged.length).toBe(1);
		expect(merged[0].words.length).toBe(6);
		const split = splitChunk(merged, 0, 2);
		expect(split.map((chunk) => chunk.words.length)).toEqual([2, 4]);
		expect(split[0].end).toBe(split[1].start);
		const edited = editChunkText(doc, 0, "Halcyon cold brew!");
		expect(edited[0].words[2]).toEqual({ text: "brew!", start: 1.25, end: 1.6 });
		const respaced = editChunkText(doc, 0, "Halcyon brew");
		expect(respaced[0].words.map((word) => word.text)).toEqual(["Halcyon", "brew"]);
		const nudged = nudgeChunk(doc, 1, -10);
		expect(nudged[1].start).toBe(doc[0].end);
	});
});

describe("auto-cut with regions kept back (talking-head keep)", () => {
	const clip = { el: "el-aroll", start: 0, in: 0, out: 20 };
	const full = cutFromTranscript(TRANSCRIPT, { clip, captions: false });

	test("candidates list every region, all applied by default", () => {
		expect(full.candidates.map((region) => region.reason)).toEqual(["head", "retake", "silence", "tail"]);
		expect(full.candidates.every((region) => region.applied)).toBe(true);
	});

	test("unticking the retake keeps it (and its words); the cut still applies", () => {
		const retake = full.candidates.findIndex((region) => region.reason === "retake");
		const plan = cutFromTranscript(TRANSCRIPT, { clip, captions: false, keep: [retake] });
		expect(plan.removed.map((region) => region.reason)).toEqual(["head", "silence", "tail"]);
		expect(plan.candidates[retake].applied).toBe(false);
		expect(plan.words.map((word) => word.text).join(" ").match(/Steeped/g)).toHaveLength(2);
		expect(plan.stats.keptSeconds).toBeGreaterThan(full.stats.keptSeconds);
		const result = run(plan.ops);
		expect(result.ok).toBe(true);
	});
});
