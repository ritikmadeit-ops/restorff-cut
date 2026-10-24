/**
 * captions-v2 agent, 2026-10-20: the pure parts behind MCP transcribe {edit} / captions (looks, spans, sizes,
 * face-aware zones, one text box for builder and gate). Fictional data (Halcyon Cold Brew).
 * Run: cd apps/web && bun test src/server/__tests__/captions-v2.test.ts
 */
import { describe, expect, test } from "bun:test";
import { textBox as gateTextBox, type GateElement } from "@restorffcut/gate";
import { buildCaptionOps, getCaptionStyle, type CaptionDocChunk, type MeasureText } from "@restorffcut/timeline-ops";
import { parseCaptionSize } from "@/mcp/cut";
import { applyTranscriptEdits, type TranscriptEdit } from "../transcripts";
import { textBoxOf } from "../transcripts-measure";
import { applyOverrides, carryTimelineFixes, rechunk, type ReadChunk } from "../transcripts-timeline";
import { placeClearOf } from "../transcripts-zones";

const at = "2026-10-20T19:00:00.000Z";
const words = (text: string, step = 0.3) => text.split(" ").map((word, i) => ({ text: word, start: r3(i * step), end: r3(i * step + step - 0.05) }));
const r3 = (value: number) => Math.round(value * 1000) / 1000;

describe("transcript word fixes", () => {
	const said = words("Halcyon is brewed with Cloud, and Cloud tastes great.");

	test("a fix matches ignoring case and punctuation, keeps the punctuation, and every occurrence by default", () => {
		const fixed = applyTranscriptEdits(said, [{ from: "cloud", to: "Claude", created_at: at }]);
		expect(fixed.words.map((word) => word.text).join(" ")).toBe("Halcyon is brewed with Claude, and Claude tastes great.");
		expect(fixed.report[0].matched).toEqual([said[4].start, said[6].start]);
		// times are kept for a one-word fix
		expect(fixed.words[4].start).toBe(said[4].start);
		expect(fixed.words[4].end).toBe(said[4].end);
	});

	test("source_t limits a fix to the nearest occurrence (within 2 s)", () => {
		const one = applyTranscriptEdits(said, [{ from: "Cloud", to: "Claude", source_t: said[6].start + 0.1, created_at: at }]);
		expect(one.words.map((word) => word.text).join(" ")).toBe("Halcyon is brewed with Cloud, and Claude tastes great.");
		const far = applyTranscriptEdits(said, [{ from: "Cloud", to: "Claude", source_t: 40, created_at: at }]);
		expect(far.report[0].matched).toEqual([]);
	});

	test("several words become one (times joined), one word becomes several (split by letters), \"\" deletes", () => {
		const hyper = words("This tool is called hyper frames.");
		const joined = applyTranscriptEdits(hyper, [{ from: "hyper frames", to: "HyperFrames", created_at: at }]);
		expect(joined.words.map((word) => word.text)).toEqual(["This", "tool", "is", "called", "HyperFrames."]);
		expect(joined.words[4].start).toBe(hyper[4].start);
		expect(joined.words[4].end).toBe(hyper[5].end);
		const split = applyTranscriptEdits(said, [{ from: "Halcyon", to: "Halcyon Cold Brew", created_at: at }]);
		expect(split.words.slice(0, 3).map((word) => word.text)).toEqual(["Halcyon", "Cold", "Brew"]);
		expect(split.words[2].end).toBeCloseTo(said[0].end, 3);
		const gone = applyTranscriptEdits(said, [{ from: "great.", to: "", created_at: at }]);
		expect(gone.words.length).toBe(said.length - 1);
	});

	test("fixes apply in order (a later fix can build on an earlier one)", () => {
		const edits: TranscriptEdit[] = [
			{ from: "Cloud", to: "Claude", created_at: at },
			{ from: "Claude tastes", to: "Claude really tastes", created_at: at },
		];
		expect(applyTranscriptEdits(said, edits).words.map((word) => word.text).join(" ")).toBe("Halcyon is brewed with Claude, and Claude really tastes great.");
	});
});

describe("caption looks across a rebuild", () => {
	const style = getCaptionStyle("word-pop");
	const transcript = words("Halcyon cold brew is steeped for twenty hours and never bitter");

	test("a span restyle changes only the words inside it; a look change always starts a new chunk", () => {
		const doc = rechunk({ words: transcript, existing: [], overrides: { size: { relative: 1.35 } }, span: { t0: 0.9, t1: 2.1 }, style });
		const looks = doc.map((chunk) => [chunk.words.map((word) => word.text).join(" "), chunk.look?.scale ?? 1]);
		// a word is in the span when its middle is: "is" (1.025 s) … "twenty" (1.925 s)
		expect(looks).toEqual([
			["Halcyon cold brew", 1],
			["is steeped for", 1.35],
			["twenty", 1.35],
			["hours and never", 1],
			["bitter", 1],
		]);
	});

	test("a rebuild keeps each word's look from the chunk it was in; relative sizes compound; style resets the look (not the zone)", () => {
		const first = rechunk({ words: transcript, existing: [], overrides: { size: { relative: 1.35 }, zone: "bottom" }, span: { t0: 0.9, t1: 2.1 }, style });
		const again = rechunk({ words: transcript, existing: first, style });
		expect(again.map((chunk) => chunk.look?.scale ?? 1)).toEqual(first.map((chunk) => chunk.look?.scale ?? 1));
		const bigger = rechunk({ words: transcript, existing: first, overrides: { size: { relative: 1.35 } }, span: { t0: 0.9, t1: 2.1 }, style });
		expect(bigger[1].look?.scale).toBeCloseTo(1.8225, 4);
		const restyled = applyOverrides({ scale: 1.35, zone: "bottom", case: "upper" }, { style: "key-word" });
		expect(restyled).toEqual({ style: "key-word", zone: "bottom" });
		expect(applyOverrides({ size: 6 }, { size: { relative: 1.5 } }).size).toBe(9);
		expect(applyOverrides({ scale: 2 }, { size: { absolute: 7 } })).toEqual({ size: 7 });
	});

	test("words per chunk up to 5 from a look", () => {
		const five = rechunk({ words: transcript, existing: [], overrides: { max_words: 5 }, style });
		expect(five.map((chunk) => chunk.words.length)).toEqual([5, 5, 1]);
	});

	test("text a person changed on the timeline survives a rebuild from the transcript", () => {
		const existing: ReadChunk[] = [{ start: 0, end: 0.85, words: [{ text: "Halcyon", start: 0, end: 0.25 }, { text: "Claude", start: 0.3, end: 0.55 }, { text: "brew", start: 0.6, end: 0.85 }], edited: true }];
		const carried = carryTimelineFixes(transcript, existing);
		expect(carried.carried).toBe(1);
		expect(carried.words.slice(0, 3).map((word) => word.text)).toEqual(["Halcyon", "Claude", "brew"]);
	});
});

describe("caption size argument", () => {
	test("numbers are editor units; x / % relative; px converted; words", () => {
		expect(parseCaptionSize(6, 1920)).toEqual({ absolute: 6 });
		expect(parseCaptionSize("1.35x", 1920)).toEqual({ relative: 1.35 });
		expect(parseCaptionSize("135%", 1920)).toEqual({ relative: 1.35 });
		expect(parseCaptionSize("128px", 1920)).toEqual({ absolute: 6 });
		expect(parseCaptionSize("bigger", 1920)).toEqual({ relative: 1.35 });
		expect(parseCaptionSize("smaller", 1920)).toEqual({ relative: 0.75 });
		expect(parseCaptionSize(0.2, 1920)).toHaveProperty("error");
		expect(parseCaptionSize("huge-ish", 1920)).toHaveProperty("error");
	});
});

describe("face-aware zone", () => {
	const area = { top: 220, bottom: 1500 };
	const face = { x0: 340, x1: 650, y0: 1075, y1: 1382, frames: 40 };

	test("a line that misses the face stays; one over the mouth moves to the nearest clear line inside the safe area", () => {
		expect(placeClearOf(face, { halfHeight: 60, halfWidth: 300, cx: 500 }, area, 400)).toEqual({ y: 400, where: "style", overlap: 0 });
		const moved = placeClearOf(face, { halfHeight: 60, halfWidth: 300, cx: 500 }, area, 1116);
		expect(moved.where).toBe("above"); // below the chin there is no room before y 1500
		expect(moved.y + 60).toBeLessThanOrEqual(face.y0 - 0.1 * (face.y1 - face.y0));
		expect(moved.y - 60).toBeGreaterThanOrEqual(area.top);
	});

	test("a high face sends the caption below the chin; no face = the style line; nothing fits = least overlap", () => {
		const high = { x0: 340, x1: 650, y0: 500, y1: 800, frames: 10 };
		expect(placeClearOf(high, { halfHeight: 60, halfWidth: 300, cx: 500 }, area, 700).where).toBe("below");
		expect(placeClearOf(null, { halfHeight: 60, halfWidth: 300, cx: 500 }, area, 700).where).toBe("style");
		const huge = { x0: 0, x1: 1080, y0: 200, y1: 1600, frames: 10 };
		expect(placeClearOf(huge, { halfHeight: 60, halfWidth: 300, cx: 500 }, area, 700).where).toBe("least-overlap");
	});
});

describe("one text box for the caption builder and the gate", () => {
	const measure: MeasureText = (text, font) => text.length * ((0.5 * font.size * 1920) / 90) + font.letterSpacing * text.length;

	test("textBoxOf = the editor's box: lines × line height, aligned, background padding × size / 15", () => {
		const box = textBoxOf({ content: "Halcyon cold", fontSize: 6, textAlign: "center", "background.enabled": true, "background.color": "#1E3A2B", "background.paddingX": 30, "background.paddingY": 42 }, 1920, measure);
		const width = measure("Halcyon cold", { family: "Arial", size: 6, weight: "normal", italic: false, letterSpacing: 0 });
		expect(box.width).toBeCloseTo(width + 2 * 30 * (6 / 15), 6);
		expect(box.height).toBeCloseTo(1.2 * 128 + 2 * 42 * (6 / 15), 6);
		const left = textBoxOf({ content: "Halcyon", fontSize: 5, textAlign: "left" }, 1920, measure);
		expect(left.left).toBe(0);
	});

	test("every caption element the builder places reads inside the gate's safe area with the shared measure", () => {
		const chunks: CaptionDocChunk[] = [{ start: 0, end: 1.2, words: words("Halcyon cold brew") }];
		for (const id of ["word-pop", "serif-box", "key-word", "mono-label"]) {
			const build = buildCaptionOps({ chunks, style: getCaptionStyle(id), canvas: { width: 1080, height: 1920 }, measure, wholeSizes: true });
			for (const op of build.ops) {
				if (op.op !== "insert" || !op.style) continue;
				const style = op.style;
				const params: Record<string, unknown> = {
					content: op.text,
					fontFamily: style.font,
					fontSize: style.size,
					fontWeight: style.weight,
					textAlign: style.align,
					letterSpacing: style.letter_spacing ?? 0,
					"background.enabled": style.bg === true,
					"background.color": style.bg_color,
					"background.paddingX": style.bg_padding_x,
					"background.paddingY": style.bg_padding_y,
					"transform.positionX": style.x,
					"transform.positionY": style.y,
				};
				const box = gateTextBox({ id: "x", type: "text", startTime: 0, duration: 1, params } as GateElement, { width: 1080, height: 1920 }, (el) => textBoxOf(el.params ?? {}, 1920, measure));
				expect(box.x0).toBeGreaterThanOrEqual(60 - 0.5);
				expect(box.x1).toBeLessThanOrEqual(940 + 0.5);
				expect(box.y0).toBeGreaterThanOrEqual(220 - 0.5);
				expect(box.y1).toBeLessThanOrEqual(1500 + 0.5);
			}
		}
	});
});
