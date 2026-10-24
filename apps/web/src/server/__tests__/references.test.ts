/**
 * mcp-references (2026-10-20): the pure parts of the reference study and the explainer versions — tile times for a
 * clip's contact sheet, and "What's new in vN" (beats aligned by kind, props, the ops diff). Fictional Halcyon data.
 */
import { describe, expect, test } from "bun:test";
import { blankDisplayDefaults, whatsNew } from "@/server/references-build";
import { clipTileTimes, cutsFromScores, parseSceneScores } from "@/server/references-frames";
import type { VersionSummary } from "@/server/references-store";

const beat = (index: number, kind: string, visual: string, line: string, start: number) => ({ index, kind, start, end: start + 4, line, visual });

function summary(feel: string, withDoodle: boolean): VersionSummary {
	const beats = [
		beat(0, "title", 'paper sheet, "ROUTE" in letter tiles', "how the farm-to-bottle route works", 0),
		beat(1, "map", "map route FARM → ROASTERY", "Here's the route", 4),
		...(withDoodle ? [beat(2, "doodle", "doodles boil around the frame", "Made by hand", 8)] : []),
		beat(withDoodle ? 3 : 2, "stamp", 'stamp "SMALL BATCH"', "That's the whole story", withDoodle ? 12 : 8),
	];
	const ease = feel === "playful" ? "bouncy" : "gentle";
	return {
		topic: "how the farm-to-bottle route works",
		answers: { footage: "mine", format: "16:9", feel },
		canvas: { width: 1920, height: 1080 },
		duration: withDoodle ? 16 : 12,
		start: 0,
		beats,
		compositions: [
			{ key: "beat1-paper-cut", name: "paper-cut", props: { ease }, rendered: true },
			{ key: "beat2-map-route", name: "map-route", props: { ease }, rendered: true },
			...(withDoodle ? [{ key: "beat3-doodle-boil", name: "doodle-boil", props: {}, rendered: true }] : []),
		],
		effects: ["FX-54 map", ...(withDoodle ? ["FX-14 doodle boil"] : [])],
		assets: ["farm"],
		op_signatures: ['{"op":"insert","t":0}', '{"op":"text_pop","t":0.25}', ...(withDoodle ? ['{"op":"insert","t":8}'] : [])],
	};
}

describe("references: What's new in vN", () => {
	test("one beat taken out reads as one removal, not a cascade of changed beats", () => {
		const lines = whatsNew(summary("playful", true), summary("nostalgic", false));
		expect(lines).toContain("Feel: playful → nostalgic");
		expect(lines.filter((line) => line.startsWith("Beat"))).toEqual(['Beat 3 of the last version removed: doodles boil around the frame ("Made by hand")']);
		expect(lines).toContain("Compositions removed: doodle-boil");
		expect(lines.some((line) => line.startsWith("paper-cut: ease bouncy → gentle"))).toBe(true);
		expect(lines.at(-1)).toBe("Ops: 2 plan ops (was 3): 0 new, 1 gone, 2 unchanged; gone: insert 1");
	});

	test("a composition that did not render is not 'added' (it is not on the timeline)", () => {
		const prev = summary("playful", true);
		const next = summary("playful", true);
		next.compositions.push({ key: "paper-texture", name: "paper-texture", props: {}, rendered: false });
		expect(whatsNew(prev, next).some((line) => line.includes("paper-texture"))).toBe(false);
		next.compositions[next.compositions.length - 1] = { key: "paper-texture", name: "paper-texture", props: {}, rendered: true };
		expect(whatsNew(prev, next)).toContain("Compositions added: paper-texture");
	});

	test("the same plan says so", () => {
		const lines = whatsNew(summary("playful", true), summary("playful", true));
		expect(lines[0]).toStartWith("Same answers and the same plan");
		expect(lines.at(-1)).toBe("Ops: 3 plan ops (was 3): 0 new, 0 gone, 3 unchanged");
	});
});

describe("references: contact sheet tiles", () => {
	test("first frame after each cut plus evenly spaced frames, deduplicated", () => {
		expect(clipTileTimes(6, [1.5, 3, 4.5])).toEqual([0.05, 0.75, 1.6, 2.25, 3.1, 3.75, 4.6, 5.25]);
	});
	test("many cuts are thinned to at most 8 tiles", () => {
		const cuts = Array.from({ length: 30 }, (_, i) => i + 1);
		expect(clipTileTimes(32, cuts).length).toBe(8);
	});
});

// explainer-v2 (2026-10-20): scene scores per frame → cuts. Numbers are the MEASURED ffmpeg scores of the recreation's
// synthetic clips (worklog explainer-v2.md): a 2 s cut between two paper scenes scored 0.281 among frames ≤ 0.01.
describe("references: scene cuts from per-frame scores", () => {
	const at25 = (scores: number[]) => scores.map((score, i) => ({ t: i / 25, score }));
	test("a quiet-neighbourhood spike under 0.3 is a cut; the frames right after a cut merge into it", () => {
		const scores = new Array(150).fill(0.003);
		scores[50] = 0.281; // 2 s
		scores[100] = 0.477; // 4 s
		scores[101] = 0.195;
		scores[102] = 0.082;
		expect(cutsFromScores(at25(scores))).toEqual([2, 4]);
	});
	test("a small object jumping (0.076) and a slow zoom are not cuts; two similar framings (0.118) are", () => {
		const jumps = new Array(150).fill(0);
		for (const i of [25, 50, 75, 100, 125]) jumps[i] = 0.076;
		expect(cutsFromScores(at25(jumps))).toEqual([]);
		const zoom = Array.from({ length: 125 }, () => 0.002);
		expect(cutsFromScores(at25(zoom))).toEqual([]);
		const similar = new Array(200).fill(0);
		similar[100] = 0.118;
		expect(cutsFromScores(at25(similar))).toEqual([4]);
	});
	test("parses ffmpeg metadata=print output", () => {
		const out = ["[Parsed_metadata_2 @ 0x1] frame:50   pts:100  pts_time:2", "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.281000", "[Parsed_metadata_2 @ 0x1] frame:51   pts:102  pts_time:2.04", "[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.009"].join("\n");
		expect(parseSceneScores(out)).toEqual([
			{ t: 2, score: 0.281 },
			{ t: 2.04, score: 0.009 },
		]);
	});
});

describe("references: no example display text leaks", () => {
	test("string params the plan left unset are blanked; set ones and non-text params are kept", () => {
		const props: Record<string, unknown> = { caption: "BOTTLING · DAY 5", scroll: 0.8 };
		const blanked = blankDisplayDefaults(props, { caption: { type: "string", default: "delivered cold" }, key: { type: "string", default: "every morning" }, scroll: { type: "number", default: 0.5 }, paper: { type: "color", default: "#EFE6D2" } });
		expect(blanked).toEqual(["key"]);
		expect(props).toEqual({ caption: "BOTTLING · DAY 5", scroll: 0.8, key: "" });
	});
});
