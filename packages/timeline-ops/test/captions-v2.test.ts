/**
 * captions-v2 (2026-10-20, docs/restorff/worklog/captions-v2.md): per-chunk looks, the key-word style, ≤ 5-word
 * chunks, whole font sizes, caption lanes kept in place, set_caption_style restyling every caption layer, and the
 * autocut fixes (punctuation-blind retakes, ripple tails).
 */
import { describe, expect, test } from "bun:test";
import {
	buildCaptionOps,
	CAPTION_STYLE_PRESETS,
	chunkWordGroups,
	cutFromTranscript,
	getCaptionStyle,
	pickKeyWords,
	resolveCaptionLook,
	type CaptionDocChunk,
	type MeasureText,
	type Project,
	type TextElement,
	type TimelineTrack,
} from "../src/index.ts";
import { T } from "./fixture.ts";
import { run, scene } from "./helpers.ts";

const measure: MeasureText = (text, font) => text.length * (0.55 * (font.size * 1920) / 90 + font.letterSpacing);
const CANVAS = { width: 1080, height: 1920 };
const WORDS = [
	{ text: "Claude", start: 0.5, end: 0.9 },
	{ text: "edits", start: 0.95, end: 1.2 },
	{ text: "videos", start: 1.25, end: 1.6 },
	{ text: "now,", start: 1.65, end: 1.9 },
	{ text: "really", start: 1.95, end: 2.3 },
	{ text: "fast.", start: 2.35, end: 2.7 },
];

const overlay = (project: Project) => scene(project).tracks.overlay;
const byName = (project: Project, name: string) => overlay(project).find((track) => track.name === name) as TimelineTrack;
const texts = (track: TimelineTrack) => (track.elements as TextElement[]).map((element) => String(element.params.content));
const num = (element: TextElement, key: string) => Number(element.params[key]);

describe("captions-v2: chunks, looks, key words", () => {
	test("chunks hold up to 5 words (still break on punctuation)", () => {
		const five = chunkWordGroups(
			[1, 2, 3, 4, 5, 6].map((i) => ({ text: `w${i}`, start: i * 0.3, end: i * 0.3 + 0.25 })),
			{ maxWords: 5 },
		);
		expect(five.map((chunk) => chunk.words.length)).toEqual([5, 1]);
		expect(chunkWordGroups(WORDS, { maxWords: 9 }).map((chunk) => chunk.words.length)).toEqual([4, 2]);
	});

	test("automatic key words: one telling word per chunk, never a function word; a list matches case/punctuation-blind", () => {
		expect(pickKeyWords(["just", "so", "you"], "auto")).toEqual([false, false, false]);
		expect(pickKeyWords(["I'm", "not", "editing"], "auto")).toEqual([false, false, true]);
		expect(pickKeyWords(["only", "20", "hours"], "auto")).toEqual([false, true, false]);
		expect(pickKeyWords(["Claude", "edits", "videos"], ["claude"])).toEqual([true, false, false]);
		expect(pickKeyWords(["cold", "brew.", "now"], ["Cold Brew"])).toEqual([true, true, false]);
	});

	test("a look resolves over the style: size, scale, case, accent, anchor, words per chunk", () => {
		const pop = getCaptionStyle("word-pop");
		expect(resolveCaptionLook(pop)).toBe(pop);
		const big = resolveCaptionLook(pop, { scale: 1.35 });
		expect(big.base.size).toBeCloseTo((pop.base.size ?? 5) * 1.35, 6);
		expect(resolveCaptionLook(pop, { size: 7, scale: 2 }).base.size).toBe(7);
		const accent = resolveCaptionLook(pop, { key_color: "#FF00AA" });
		expect(accent.highlight.kind === "word-box" && accent.highlight.bg_color).toBe("#FF00AA");
		const keyed = resolveCaptionLook(pop, { style: "key-word", keys: ["claude"], case: "upper", anchor: 0.2, max_words: 9 });
		expect(keyed.id).toBe("key-word");
		expect(keyed.highlight.kind === "key-word" && keyed.highlight.keys).toEqual(["claude"]);
		expect(keyed.case).toBe("upper");
		expect(keyed.anchor).toBe(0.2);
		expect(keyed.maxWords).toBe(5);
	});

	test("key-word style: a hidden carrier per chunk, lowercase runs on their own lanes, the key word bigger in yellow on the same baseline", () => {
		const style = getCaptionStyle("key-word");
		const doc = chunkWordGroups(WORDS, { maxWords: style.maxWords });
		const build = buildCaptionOps({ chunks: doc, style, canvas: CANVAS, measure, wholeSizes: true });
		const result = run(build.ops);
		expect(result.conflicts).toEqual([]);
		const project = result.project;
		const base = byName(project, "CAPTIONS").elements as TextElement[];
		expect(base.length).toBe(doc.length);
		expect(base.every((element) => num(element, "opacity") === 0)).toBe(true);
		expect(texts(byName(project, "CAPTIONS"))).toEqual(["claude edits videos", "now", "really fast"]);
		// chunk 1: "claude" and "videos" score 6 each → the first is the key word; "now" / "really fast" have none
		expect(build.chunks.map((chunk) => chunk.keys)).toEqual([["claude"], [], []]);
		const lanes = overlay(project).filter((track) => /^CAPTION WORDS/.test(track.name));
		expect(lanes.length).toBe(build.tracks.wordSlots?.length ?? -1);
		const runs = lanes.flatMap((track) => track.elements as TextElement[]).filter((element) => element.startTime === base[0].startTime);
		const key = runs.find((element) => element.params.color === "#FFD60A") as TextElement;
		const plain = runs.find((element) => element.params.color === "#FFFFFF") as TextElement;
		expect(key).toBeDefined();
		expect(plain).toBeDefined();
		expect(num(key, "fontSize")).toBeGreaterThan(num(plain, "fontSize"));
		expect(Number.isInteger(num(key, "fontSize")) && Number.isInteger(num(plain, "fontSize"))).toBe(true);
		// the bigger word is lifted so both share a baseline
		expect(num(key, "transform.positionY")).toBeLessThan(num(plain, "transform.positionY"));
		// every run of a chunk lies inside the safe area, left to right
		for (const layout of build.chunks) {
			expect(layout.x + 540 - layout.width / 2).toBeGreaterThanOrEqual(60 - 0.5);
			expect(layout.x + 540 + layout.width / 2).toBeLessThanOrEqual(940 + 0.5);
		}
		// shadows exist per run, and the blur-in is reported for the caller (ops@1 can't add effects)
		expect(overlay(project).some((track) => track.name === "CAPTION SHADOW")).toBe(true);
		expect((build.blurIn ?? []).length).toBeGreaterThan(0);
	});

	test("one span restyled: only its chunks change size / style; the others keep the build's look", () => {
		const style = getCaptionStyle("word-pop");
		const plain = chunkWordGroups(WORDS, { maxWords: 3 });
		const before = buildCaptionOps({ chunks: plain, style, canvas: CANVAS, measure, wholeSizes: true }).chunks.map((chunk) => chunk.size);
		const doc: CaptionDocChunk[] = plain.map((chunk, i) => (i === 1 ? { ...chunk, look: { scale: 1.35 } } : chunk));
		const build = buildCaptionOps({ chunks: doc, style, canvas: CANVAS, measure, wholeSizes: true });
		const result = run(build.ops);
		expect(result.ok).toBe(true);
		const sizes = (byName(result.project, "CAPTIONS").elements as TextElement[]).map((element) => num(element, "fontSize"));
		expect(sizes[0]).toBe(before[0]);
		expect(sizes[1]).toBe(7); // "now," at 5.2 × 1.35 = 7.02 → 7 (whole units; it fits)
		expect(sizes[2]).toBe(before[2]);
		// the highlight words of the bigger chunk are the bigger size too
		const words = byName(result.project, "CAPTION WORDS").elements as TextElement[];
		const inSpan = words.filter((element) => element.startTime >= doc[1].start * T - 1 && element.startTime < doc[1].end * T);
		expect(inSpan.every((element) => num(element, "fontSize") === 7)).toBe(true);
	});

	test("a span in another style adds that style's lanes; trackIndex keeps the caption lanes where they were", () => {
		const style = getCaptionStyle("bold-white");
		const doc: CaptionDocChunk[] = chunkWordGroups(WORDS, { maxWords: 3 }).map((chunk, i) => (i === 0 ? { ...chunk, look: { style: "serif-box" } } : chunk));
		const build = buildCaptionOps({ chunks: doc, style, canvas: CANVAS, measure, trackIndex: 1 });
		const result = run(build.ops);
		expect(result.ok).toBe(true);
		// the fixture's TEXT track stays on top; the captions go under it
		expect(overlay(result.project)[0].name).toBe("TEXT");
		expect(overlay(result.project).slice(1, 4).map((track) => track.name)).toEqual(["CAPTION WORDS", "CAPTIONS", "CAPTION SHADOW"]);
		const karaoke = byName(result.project, "CAPTION WORDS").elements as TextElement[];
		expect(karaoke.length).toBe(3); // only the serif-box chunk has karaoke words
		expect(String(karaoke[2].params.content)).toBe("Claude edits videos");
	});

	test("case and punctuation: lower + stripped in key-word, upper from a look on any style", () => {
		const style = getCaptionStyle("bold-white");
		const doc: CaptionDocChunk[] = chunkWordGroups(WORDS, { maxWords: 3 }).map((chunk) => ({ ...chunk, look: { case: "upper" } }));
		const build = buildCaptionOps({ chunks: doc, style, canvas: CANVAS, measure });
		expect(build.chunks.map((chunk) => chunk.text)).toEqual(["CLAUDE EDITS VIDEOS", "NOW,", "REALLY FAST."]);
	});

	test("every preset still lays out inside the safe area with whole sizes", () => {
		for (const style of CAPTION_STYLE_PRESETS) {
			const doc = chunkWordGroups([{ text: "Unbelievably-smooth-coldbrew", start: 0, end: 1 }], { maxWords: 1 });
			const build = buildCaptionOps({ chunks: doc, style, canvas: CANVAS, measure, wholeSizes: true });
			for (const chunk of build.chunks) {
				expect(Number.isInteger(chunk.size)).toBe(true);
				expect(chunk.x + 540 + chunk.width / 2).toBeLessThanOrEqual(940 + 0.5);
			}
			expect(run(build.ops).ok).toBe(true);
		}
	});
});

describe("captions-v2: set_caption_style restyles every caption layer (no ghosts)", () => {
	const layered = (styleId: string) => {
		const style = getCaptionStyle(styleId);
		const doc = chunkWordGroups(WORDS, { maxWords: 3 });
		const build = buildCaptionOps({ chunks: doc, style, canvas: CANVAS, measure, wholeSizes: true });
		const first = run(build.ops);
		expect(first.ok).toBe(true);
		const base = byName(first.project, "CAPTIONS");
		return { project: first.project, baseId: base.id };
	};

	test("bigger: the highlight words and the shadow scale with the chunk, offsets included", () => {
		const { project, baseId } = layered("word-pop");
		const beforeBase = byName(project, "CAPTIONS").elements[0] as TextElement;
		const beforeWord = byName(project, "CAPTION WORDS").elements[0] as TextElement;
		const beforeShadow = byName(project, "CAPTION SHADOW").elements[0] as TextElement;
		const result = run([{ op: "set_caption_style", author: "claude", track: baseId, style: { size: 7 } }], {}, project);
		expect(result.ok).toBe(true);
		const k = 7 / num(beforeBase, "fontSize");
		const base = byName(result.project, "CAPTIONS").elements[0] as TextElement;
		const word = byName(result.project, "CAPTION WORDS").elements[0] as TextElement;
		const shadow = byName(result.project, "CAPTION SHADOW").elements[0] as TextElement;
		expect(num(base, "fontSize")).toBe(7);
		expect(num(word, "fontSize")).toBe(7);
		expect(num(shadow, "fontSize")).toBe(7);
		const dx = num(beforeWord, "transform.positionX") - num(beforeBase, "transform.positionX");
		expect(num(word, "transform.positionX")).toBeCloseTo(num(base, "transform.positionX") + dx * k, 0);
		const dy = num(beforeShadow, "transform.positionY") - num(beforeBase, "transform.positionY");
		expect(num(shadow, "transform.positionY")).toBeCloseTo(num(base, "transform.positionY") + dy * k, 0);
		const change = result.changes.ops[0];
		expect((change.details as { caption_layers?: { followed: number } }).caption_layers?.followed).toBeGreaterThan(0);
	});

	test("moved up: every layer moves with the chunk", () => {
		const { project, baseId } = layered("serif-box");
		const result = run([{ op: "set_caption_style", author: "claude", track: baseId, style: { y: -400 } }], {}, project);
		expect(result.ok).toBe(true);
		const ys = (track: string) => (byName(result.project, track).elements as TextElement[]).map((element) => num(element, "transform.positionY"));
		expect(new Set(ys("CAPTIONS"))).toEqual(new Set([-400]));
		expect(new Set(ys("CAPTION WORDS"))).toEqual(new Set([-400]));
	});

	test("a new font: the measured word layer is removed (never left offset), a whole-chunk shadow follows the font", () => {
		const { project, baseId } = layered("word-pop");
		const result = run([{ op: "set_caption_style", author: "preset", track: baseId, style: { font: "Inter", size: 6 } }], {}, project);
		expect(result.ok).toBe(true);
		expect(byName(result.project, "CAPTION WORDS").elements.length).toBe(0);
		const shadows = byName(result.project, "CAPTION SHADOW").elements as TextElement[];
		expect(shadows.length).toBe(3);
		expect(shadows.every((element) => element.params.fontFamily === "Inter" && num(element, "fontSize") === 6)).toBe(true);
		const details = result.changes.ops[0].details as { caption_layers: { removed: number; why: string } };
		expect(details.caption_layers.removed).toBeGreaterThan(0);
		expect(details.caption_layers.why).toMatch(/measuring/);
	});

	test("key-word captions given a new font show their (formerly hidden) chunk text instead of vanishing", () => {
		const { project, baseId } = layered("key-word");
		const result = run([{ op: "set_caption_style", author: "preset", track: baseId, style: { font: "Inter" } }], {}, project);
		expect(result.ok).toBe(true);
		const base = byName(result.project, "CAPTIONS").elements as TextElement[];
		expect(base.every((element) => num(element, "opacity") === 1)).toBe(true);
		const wordLanes = overlay(result.project).filter((track) => /^CAPTION WORDS/.test(track.name));
		expect(wordLanes.every((track) => track.elements.length === 0)).toBe(true);
		// a shadow that stays is a whole-chunk copy in the new font (single-run chunks); per-run shadows are gone
		const shadows = overlay(result.project)
			.filter((track) => /^CAPTION SHADOW/.test(track.name))
			.flatMap((track) => track.elements as TextElement[]);
		for (const shadow of shadows) {
			expect(shadow.params.fontFamily).toBe("Inter");
			expect(base.some((element) => element.params.content === shadow.params.content && element.startTime === shadow.startTime)).toBe(true);
		}
	});

	test("a restyle is remembered in the chunk's look (so a rebuild draws it the same way, never undoes it)", () => {
		const { project, baseId } = layered("key-word");
		// the server / editor tag every chunk with its caption document entry
		const base = byName(project, "CAPTIONS");
		for (const element of base.elements) (element as { restorff?: Record<string, unknown> }).restorff = { ...(element.restorff ?? {}), caption: { style: "key-word", words: [], look: { scale: 1.35 } } };
		const result = run([{ op: "set_caption_style", author: "preset", track: baseId, style: { font: "Instrument Serif", size: 6, bg: true, bg_color: "#2F3B2C", y: 384 } }], {}, project);
		expect(result.ok).toBe(true);
		const look = (byName(result.project, "CAPTIONS").elements[0].restorff as { caption: { look: Record<string, unknown> } }).caption.look;
		expect(look.text).toEqual({ font: "Instrument Serif", bg: true, bg_color: "#2F3B2C" });
		expect(look.size).toBe(6);
		// its key-word runs were removed (new font), so a rebuild draws it without them — the restyle stays as seen
		expect(look.highlight).toBe("none");
		expect(look.blur_in).toBe(false);
		expect(resolveCaptionLook(getCaptionStyle("key-word"), look as never).highlight.kind).toBe("none");
		expect(look.scale).toBeUndefined();
		expect(look.line).toBeCloseTo((384 + 960 - 220) / 1280, 4);
		// and the look resolves to that text style
		const resolved = resolveCaptionLook(getCaptionStyle("key-word"), look as never);
		expect(resolved.base.font).toBe("Instrument Serif");
		expect(resolved.anchor).toBeCloseTo((384 + 960 - 220) / 1280, 4);
	});

	test("an editing style (apply_style) leaves no word or shadow element where the old layout put it", () => {
		const { project } = layered("serif-box");
		const result = run([{ op: "apply_style", author: "claude", preset_id: "restorff/style/fast-ugc" }], {}, project);
		expect(result.ok).toBe(true);
		const base = byName(result.project, "CAPTIONS").elements as TextElement[];
		const words = byName(result.project, "CAPTION WORDS").elements as TextElement[];
		// fast-ugc changes the font → the karaoke layer is removed; whatever stays sits on its chunk
		for (const element of words) {
			const chunk = base.find((candidate) => candidate.startTime <= element.startTime && candidate.startTime + candidate.duration >= element.startTime + element.duration);
			expect(chunk).toBeDefined();
			expect(num(element, "transform.positionY")).toBe(num(chunk as TextElement, "transform.positionY"));
		}
		expect(words.length).toBe(0);
	});
});

describe("captions-v2: autocut finds retakes punctuated differently, and tail cuts ripple", () => {
	// warm-moody c03 (large-v3 words, MEASURED): the sentence said twice, Whisper put a full stop in the first take only
	const C03 = "And also cut out the dead space just so you know this entire video. I'm not editing anything just so you know this entire video I'm not editing anything. I'm giving it this raw video"
		.split(" ")
		.map((text, i) => ({ text, start: i * 0.2, end: i * 0.2 + 0.18 }));

	test("the repeated sentence is found although its two takes are punctuated differently; the last take stays", () => {
		const plan = cutFromTranscript(C03, { clip: { el: "el-aroll", start: 0, in: 0, out: 20 }, captions: false });
		expect(plan.retakes.map((retake) => retake.dropped)).toEqual(["just so you know this entire video. I'm not editing anything"]);
		expect(plan.retakes[0].keptAs).toBe("just so you know this entire video I'm not editing anything.");
		const said = plan.words.map((word) => word.text).join(" ");
		expect(said.match(/just so you know/g)).toHaveLength(1);
		expect(said).toContain("dead space just so you know this entire video I'm not editing anything. I'm giving it");
		// the pads stop at the dropped take: the cut runs from its first word's start to its last word's end
		const retake = plan.removed.find((region) => region.reason === "retake");
		expect(retake?.start).toBeCloseTo(C03[7].start, 3);
		expect(retake?.end).toBeCloseTo(C03[17].end, 3);
	});

	test("repeats: false (and keep_retakes, retakeWindow 0) leave it in", () => {
		expect(cutFromTranscript(C03, { clip: { el: "el-aroll", start: 0, in: 0, out: 20 }, captions: false, repeats: false }).retakes).toEqual([]);
		expect(cutFromTranscript(C03, { clip: { el: "el-aroll", start: 0, in: 0, out: 20 }, captions: false, retakeWindow: 0 }).retakes).toEqual([]);
	});

	test("short repeats only count at a phrase start", () => {
		const words = "we go again and again and again today".split(" ").map((text, i) => ({ text, start: i * 0.2, end: i * 0.2 + 0.18 }));
		expect(cutFromTranscript(words, { clip: { el: "el-aroll", start: 0, in: 0, out: 20 }, captions: false }).retakes).toEqual([]);
	});

	test("rippleTail: the clip after a cut clip closes up — no gap on the track", () => {
		const words = [
			{ text: "Halcyon", start: 0.5, end: 0.9 },
			{ text: "cold", start: 0.95, end: 1.2 },
			{ text: "brew.", start: 1.25, end: 1.6 },
		];
		const placeNext = run([{ op: "insert", author: "user", track: "main", t: 20, media: "media-broll", in: 0, out: 4, ref: "next" }]);
		expect(placeNext.ok).toBe(true);
		const nextId = placeNext.changes.refs.next;
		const plan = cutFromTranscript(words, { clip: { el: "el-aroll", start: 0, in: 0, out: 20 }, captions: false, rippleTail: true });
		expect(plan.ops.map((op) => op.op)).toEqual(["split", "ripple_delete", "split", "ripple_delete"]);
		const result = run(plan.ops, { seed: "test-ripple" }, placeNext.project);
		expect(result.ok).toBe(true);
		const main = scene(result.project).tracks.main.elements.slice().sort((a, b) => a.startTime - b.startTime);
		expect(main.length).toBe(2);
		expect(main[1].id).toBe(nextId);
		expect(main[1].startTime).toBe(main[0].startTime + main[0].duration);
		// the old way (trim) leaves the gap
		const trimmed = run(cutFromTranscript(words, { clip: { el: "el-aroll", start: 0, in: 0, out: 20 }, captions: false }).ops, { seed: "test-trim" }, placeNext.project);
		const old = scene(trimmed.project).tracks.main.elements.slice().sort((a, b) => a.startTime - b.startTime);
		expect(old[1].startTime - (old[0].startTime + old[0].duration)).toBeGreaterThan(T);
	});
});
