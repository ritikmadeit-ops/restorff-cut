import { describe, expect, test } from "bun:test";
import { runTimelineChecks, TIMELINE_CHECKS } from "../src/index.ts";
import { cleanProject, DEFECT_MEDIA, defectProject } from "./fixtures.ts";

describe("timeline checks", () => {
	test("a clean project passes every check (FACE skipped: no face boxes)", () => {
		const run = runTimelineChecks(cleanProject());
		expect(run.findings).toEqual([]);
		expect(run.not_run).toEqual([]);
		expect(run.piece?.type).toBe("ad");
		expect(run.skipped.map((s) => s.rule)).toEqual(["FACE"]);
		expect(run.ran.sort()).toEqual([...TIMELINE_CHECKS].filter((r) => r !== "FACE").sort());
	});

	test("every planted defect is found (FACE and FLASH: test/v2.test.ts)", () => {
		const run = runTimelineChecks(defectProject(), { media: DEFECT_MEDIA });
		const rules = new Set(run.findings.map((f) => f.rule));
		for (const rule of TIMELINE_CHECKS) if (rule !== "FACE" && rule !== "FLASH") expect(rules.has(rule)).toBe(true);
		expect(run.not_run).toEqual([]);
	});

	test("findings are finding@1 shaped and pinned", () => {
		const run = runTimelineChecks(defectProject(), { media: DEFECT_MEDIA });
		const by = (rule: string) => run.findings.filter((f) => f.rule === rule);
		expect(by("SAFE")).toHaveLength(1);
		expect(by("SAFE")[0].element_id).toBe("top-text");
		expect(by("SAFE")[0].track).toBe("TEXT");
		expect(by("CAP-LEN")[0].element_id).toBe("cap-long");
		expect(by("CAP-LEN")[0].track).toBe("CAPTIONS");
		expect(by("R15")[0].severity).toBe("must");
		expect(by("R1")).toHaveLength(1);
		expect(by("R5").map((f) => f.element_id).sort()).toEqual(["S02", null].sort() as string[]);
		expect(by("R6")).toHaveLength(1);
		expect(by("R6")[0].t).toBe(10);
		expect(by("R23").map((f) => f.element_id)).toEqual(["S03"]);
		expect(by("R21")[0].t).toBe(5);
		const clean = by("CLEAN");
		expect(clean.map((f) => f.severity)).toEqual(["must", "must"]);
		expect(clean.find((f) => f.element_id === "S06")?.measure?.held_s).toBeCloseTo(0.6, 3);
		expect(clean.find((f) => f.element_id === null)?.t).toBe(9);
		expect(by("FORMAT")[0].measure?.fps).toBe(27);
		for (const f of run.findings) {
			expect(f.evidence).toBe("TIMELINE");
			expect(f.status).toBe("open");
			expect(f.id).toMatch(/^gate-/);
			expect(f.message.length).toBeGreaterThan(0);
			expect(f.fix.length).toBeGreaterThan(0);
		}
		expect(new Set(run.findings.map((f) => f.id)).size).toBe(run.findings.length);
	});

	test("offer:false skips R15", () => {
		const p = defectProject();
		p.metadata.restorff = { ...p.metadata.restorff, brief: { offer: false } };
		const run = runTimelineChecks(p);
		expect(run.findings.some((f) => f.rule === "R15")).toBe(false);
		expect(run.skipped.map((s) => s.rule)).toContain("R15");
	});

	test("the editor's exact text measurer replaces the estimate", () => {
		const run = runTimelineChecks(cleanProject(), {
			measureText: () => ({ left: -600, top: -20, width: 1200, height: 40 }),
		});
		expect(run.findings.filter((f) => f.rule === "SAFE").length).toBe(4);
		expect(run.findings.find((f) => f.rule === "SAFE")?.measure?.measured).toBe("canvas");
	});
});
