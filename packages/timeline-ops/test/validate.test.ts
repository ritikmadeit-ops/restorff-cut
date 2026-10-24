import { describe, expect, test } from "bun:test";
import { assertOps, OP_NAMES, validateOp, validateOps } from "../src/index.ts";

/** One valid example per op name — the validator must accept every one of them. */
const VALID: Record<string, object> = {
	set_canvas: { w: 1080, h: 1920, fps: 30 },
	add_size_variant: { aspect: "4:5", reframe: "auto" },
	import_media: { kind: "video", blob_sha: "sha-1", duration: 12.5 },
	add_track: { kind: "caption" },
	remove_track: { track: "trk-1" },
	reorder_tracks: { order: ["a", "main", "b"] },
	insert: { track: "main", t: 0, media: "m-1", in: 0, out: 2 },
	move: { el: "e-1", t: 3 },
	trim: { el: "e-1", in: 0.5 },
	split: { el: "e-1", t: 1.2 },
	delete: { el: "e-1" },
	ripple_delete: { el: "e-1", scope: "all" },
	set: { el: "e-1", prop: "opacity", value: 0.5 },
	keyframe: { el: "e-1", prop: "scale", t: 1, value: 1.1, ease: "ease_in_out" },
	add_captions: { words: [{ text: "Halcyon", start: 0, end: 0.4 }] },
	set_caption_style: { style: { size: 6, weight: "bold" } },
	text_pop: { t: 1, text: "COLD" },
	transition: { a: "e-1", b: "e-2", kind: "whip", dur: 0.2 },
	gain: { el: "e-1", db: -6 },
	duck: { track: "music", under: "vo", amount_db: 12, attack_ms: 80, release_ms: 250 },
	sfx: { t: 1, name: "whoosh" },
	normalize: { lufs: -14, true_peak: -1 },
	grade: { target: "all", preset: "warm" },
	apply_style: { preset_id: "restorff/bold-captions" },
	mark: { t: 2, note: "hook" },
	beats: { el: "music", bpm: 120, times: [0.5, 1, 1.5, 2], downbeats: [0] },
	snap_cuts: { track: "main", max_shift: 0.2 },
};

describe("validator", () => {
	test("accepts a valid example of every op in ops@1", () => {
		expect(Object.keys(VALID).sort()).toEqual([...OP_NAMES].sort());
		for (const [op, fields] of Object.entries(VALID)) {
			expect(validateOp({ op, author: "claude", ...fields })).toEqual([]);
		}
	});

	test("requires author and a known op name", () => {
		expect(validateOp({ op: "split", el: "e", t: 1 })[0]).toMatchObject({ path: "author", message: "is required" });
		expect(validateOp({ op: "explode", author: "claude" })[0].path).toBe("op");
		expect(validateOp({ op: "delete", author: "robot", el: "e" })[0].path).toBe("author");
	});

	test("rejects unknown fields, wrong types, bad ranges and impossible combinations", () => {
		const cases: Array<[object, string]> = [
			[{ op: "delete", el: "e", colour: "red" }, "colour"],
			[{ op: "split", el: "e", t: "1.2" }, "t"],
			[{ op: "split", el: "e", t: -1 }, "t"],
			[{ op: "gain", el: "e", db: 40 }, "db"],
			[{ op: "insert", track: "main", t: 0 }, ""],
			[{ op: "insert", track: "main", t: 0, text: "a", shape: "star" }, ""],
			[{ op: "trim", el: "e", in: 3, out: 2 }, ""],
			[{ op: "set", prop: "x", value: 1 }, ""],
			[{ op: "add_captions", words: [{ text: "a", start: 1, end: 0.5 }] }, "words"],
			[{ op: "add_captions", words: [{ text: "a", start: 0, end: 1 }], max_words: 4 }, "max_words"],
			[{ op: "set_caption_style", style: { glow: true } }, "style"],
			[{ op: "set_canvas", w: 1080 }, ""],
			[{ op: "sfx", t: 1, name: "pop", url: "https://example.invalid/pop.wav" }, ""],
			[{ op: "normalize", lufs: -14, true_peak: 2 }, "true_peak"],
			[{ op: "grade", target: "all" }, ""],
			[{ op: "import_media", kind: "video" }, ""],
		];
		for (const [op, path] of cases) {
			const errors = validateOp({ author: "claude", ...op });
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0].path).toBe(path);
		}
	});

	test("validateOps reports every bad op with its index; assertOps throws a readable list", () => {
		const result = validateOps([
			{ op: "delete", author: "user", el: "e" },
			{ op: "delete", author: "user" },
			"nope",
		]);
		expect(result.ok).toBe(false);
		expect(result.errors.map((e) => e.index)).toEqual([1, 2]);
		expect(validateOps({}).ok).toBe(false);
		expect(() => assertOps([{ op: "delete", author: "user" }])).toThrow(/op\[0\]\.el: is required/);
	});
});
