// Unit tests for the pure parts of the pipeline (no media, no browser, no Python). Fictional copy: Halcyon Cold Brew.
// Run: bun test packages/pipeline (from the repo root) or `bun test` here.
import { describe, expect, test } from "bun:test";
import { apply, cutFromTranscript, type TimedWord } from "@restorffcut/timeline-ops";
import { chunkCaptions, estimateWidthPx } from "../src/captions.ts";
import { scriptFromWords } from "../src/gate.ts";

const W = (text: string, start: number, end: number): TimedWord => ({ text, start, end });

const WORDS: TimedWord[] = [
	W("Halcyon", 0.5, 0.8),
	W("cold", 0.85, 1.1),
	W("brew.", 1.15, 1.5),
	W("Steeped", 2.4, 2.6),
	W("for", 2.65, 2.8),
	W("twenty", 2.85, 3.1),
	W("hours.", 3.15, 3.6),
	W("Unbelievably", 3.8, 4.4),
	W("smooth", 4.45, 4.7),
	W("everything", 4.75, 5.2),
	W("considered.", 5.25, 5.9),
];

describe("chunkCaptions", () => {
	const layout = { canvasHeight: 1920, size: 4.5, maxWidthPx: 864 };

	test("never more than 3 words, never wider than the box at the chosen size", () => {
		const chunks = chunkCaptions(WORDS, layout);
		for (const c of chunks) {
			expect(c.words.length).toBeGreaterThanOrEqual(1);
			expect(c.words.length).toBeLessThanOrEqual(3);
			expect(estimateWidthPx(c.text, c.size, layout)).toBeLessThanOrEqual(864);
		}
	});

	test("breaks after punctuation and keeps every word once, in order", () => {
		const chunks = chunkCaptions(WORDS, layout);
		expect(chunks.map((c) => c.text).join(" ")).toBe(WORDS.map((w) => w.text).join(" "));
		// "Halcyon cold brew." is 18 chars ≈ 1010 px at size 4.5: too wide, so the width rule splits it
		expect(chunks[0].text).toBe("Halcyon cold");
		expect(chunks[1].text).toBe("brew.");
	});

	test("a long 3-word run is split by width, not overflowed", () => {
		const chunks = chunkCaptions(WORDS, layout);
		const long = chunks.find((c) => c.text.startsWith("Unbelievably"));
		expect(long?.text).not.toBe("Unbelievably smooth everything");
	});

	test("short gaps are bridged, chunks never overlap", () => {
		const chunks = chunkCaptions(WORDS, layout);
		for (let i = 0; i < chunks.length - 1; i++) expect(chunks[i].end).toBeLessThanOrEqual(chunks[i + 1].start);
	});
});

describe("captions through the reducer", () => {
	test("one add_captions op per chunk lands one caption element each on one CAPTIONS track", () => {
		const T = 120000;
		const project = {
			metadata: { id: "p", name: "Halcyon", duration: 0, createdAt: "x", updatedAt: "x", restorff: { opsVersion: "ops@1", pending: [], media: [] } },
			scenes: [
				{
					id: "s", name: "Main scene", isMain: true, bookmarks: [], createdAt: "x", updatedAt: "x",
					tracks: { overlay: [], main: { id: "m", name: "V1 A-ROLL", type: "video", muted: false, hidden: false, elements: [] }, audio: [] },
				},
			],
			currentSceneId: "s",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 }, background: { type: "color", color: "#000000" } },
			version: 31,
		};
		const setup = apply(project as never, [
			{ op: "import_media", author: "compiler", kind: "video", name: "halcyon.mp4", url: "job:media/halcyon.mp4", duration: 8, width: 1080, height: 1920, fps: 30, has_audio: true, ref: "src" },
			{ op: "insert", author: "compiler", track: "main", t: 0, media: "src", in: 0, out: 8, ref: "aroll" },
		], { seed: "t/setup" });
		expect(setup.ok).toBe(true);
		const plan = cutFromTranscript(WORDS, { clip: { el: setup.changes.refs.aroll, start: 0, in: 0, out: 8 }, captions: false });
		const chunks = chunkCaptions(plan.words, { canvasHeight: 1920, size: 4.5, maxWidthPx: 864 });
		const ops = [
			...plan.ops,
			...chunks.map((c, i) => ({
				op: "add_captions" as const, author: "compiler" as const, words: c.words, max_words: 3,
				style: { size: c.size, y: 540 }, ...(i === 0 ? { ref: "cap" } : { track: "cap" }),
			})),
		];
		const r = apply(setup.project, ops, { seed: "t/cut", snap: "frame" });
		expect(r.ok).toBe(true);
		const tracks = r.project.scenes[0].tracks;
		const captions = tracks.overlay.filter((t) => t.name === "CAPTIONS");
		expect(captions.length).toBe(1);
		expect(captions[0].elements.length).toBe(chunks.length);
		// dead air (0.9 s and 0.2+ s pauses > 0.35 s) is gone: the cut is shorter than the 8 s source
		const end = Math.max(...tracks.main.elements.map((e) => e.startTime + e.duration));
		expect(end / T).toBeLessThan(6);
	});
});

describe("scriptFromWords", () => {
	test("hook = first sentence, cta = last, offer false", () => {
		const s = scriptFromWords(WORDS, { w: 1080, h: 1920 });
		expect(s.hooks[0].copy).toBe("Halcyon cold brew.");
		expect(s.cta.copy).toEqual(["Unbelievably smooth everything considered."]);
		expect(s.hold.copy).toEqual(["Steeped for twenty hours."]);
		expect(s.offer).toBe(false);
	});
});
