// mcp-effects agent, 2026-10-20: the effects catalogue (one list for the Library view and MCP) and the word finder.
import { describe, expect, test } from "bun:test";
import { EFFECTS_CATALOGUE } from "@/compositions/effects-catalogue";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { buildEffectsLibrary, countByStatus, findEffect, type PackageComposition } from "./effects-catalogue";
import { captionWords, findWord, sentenceEnd } from "./effects-words";

const pkg = (name: string, fx: string[] = []): PackageComposition => ({ name, title: name, description: `${name}. More.`, tags: [], duration: 4, fx });

describe("effects catalogue", () => {
	test("reads the Library view's 62 rows and keeps their status", () => {
		const library = buildEffectsLibrary(null);
		const rows = library.filter((effect) => effect.source === "catalogue");
		expect(rows.length).toBe(EFFECTS_CATALOGUE.length);
		const counts = countByStatus(rows);
		expect(counts.ready).toBe(EFFECTS_CATALOGUE.filter((row) => row.status === "available").length);
		expect(counts.coming).toBe(EFFECTS_CATALOGUE.filter((row) => row.status === "coming").length);
		for (const effect of rows) expect(["composition", "shader", "transition", "grade", "captions", "layout"]).toContain(effect.kind);
		// a row with M in its build path needs the person matte; a coming one is blocked by it
		const orbit = rows.find((effect) => effect.id === "FX-01");
		expect(orbit?.needs).toContain("person_matte");
	});

	test("picks up compositions from the package: by slug, by FX id, and as extras", () => {
		// FX-62 (split-hook) is still a coming row; FX-03 was the example until collage-fx made ui-world ready (2026-10-20)
		const library = buildEffectsLibrary([pkg("chart-grow"), pkg("split-hook"), pkg("grid-of-covers", ["FX-44"]), pkg("brand-new-thing")]);
		const splitHook = library.find((effect) => effect.id === "FX-62");
		expect(splitHook?.status).toBe("partial");
		expect(splitHook?.apply).toEqual({ kind: "composition", composition: "split-hook" });
		expect(library.find((effect) => effect.id === "FX-44")?.apply).toEqual({ kind: "composition", composition: "grid-of-covers" });
		expect(library.find((effect) => effect.id === "comp:brand-new-thing")?.status).toBe("ready");
		// a row pointing at a composition the package does not have is not offered as ready
		const checklist = library.find((effect) => effect.id === "FX-07");
		expect(checklist?.status).toBe("coming");
		expect(checklist?.warning).toContain("checklist");
	});

	test("finds effects by id, name, alias, transition and grade look — whole words only", () => {
		const library = buildEffectsLibrary(null);
		expect(findEffect(library, "FX 10").effect?.id).toBe("FX-10");
		expect(findEffect(library, "Chart Grow").effect?.id).toBe("FX-10");
		expect(findEffect(library, "punch in").effect?.id).toBe("FX-05");
		expect(findEffect(library, "crossfade").effect?.id).toBe("tr:dissolve");
		expect(findEffect(library, "moody").effect?.id).toBe("FX-39");
		expect(findEffect(library, "film").effect?.id).toBe("grade:film");
		expect(findEffect(library, "sparkle tornado").effect).toBeNull();
	});
});

describe("effects words", () => {
	const words = [
		{ text: "Sales", start: 2, end: 2.3 },
		{ text: "doubled", start: 2.35, end: 2.8 },
		{ text: "in", start: 2.85, end: 2.95 },
		{ text: "a", start: 3, end: 3.05 },
		{ text: "week.", start: 3.1, end: 3.5 },
		{ text: "Sales", start: 4, end: 4.3 },
		{ text: "doubled!", start: 4.35, end: 4.8 },
	];

	test("a word or phrase, its n-th time, a prefix, and the sentence end", () => {
		expect(findWord(words, "doubled")).toMatchObject({ found: true, start: 2.35, occurrences: 2 });
		expect(findWord(words, "Sales doubled", 2)).toMatchObject({ found: true, start: 4, end: 4.8 });
		expect(findWord(words, "double")).toMatchObject({ found: true, start: 2.35 });
		expect(findWord(words, "tripled").found).toBe(false);
		expect(sentenceEnd(words, 1)).toBe(3.5);
	});

	test("caption words come from restorff.caption.words, relative to the element", () => {
		const snapshot = {
			metadata: { id: "p", name: "Halcyon" },
			scenes: [
				{
					id: "s",
					isMain: true,
					tracks: {
						overlay: [
							{
								id: "cap",
								name: "CAPTIONS",
								type: "text",
								restorff: { role: "caption" },
								elements: [
									{ id: "c1", type: "text", startTime: 240_000, duration: 120_000, params: { content: "Sales doubled" }, restorff: { caption: { words: [{ text: "Sales", start: 0, end: 0.3 }, { text: "doubled", start: 0.35, end: 0.8 }] } } },
								],
							},
						],
						main: { id: "main", type: "video", elements: [] },
						audio: [],
					},
				},
			],
		} as unknown as ProjectSnapshot;
		expect(captionWords(snapshot)).toEqual([
			{ text: "Sales", start: 2, end: 2.3 },
			{ text: "doubled", start: 2.35, end: 2.8 },
		]);
	});
});
