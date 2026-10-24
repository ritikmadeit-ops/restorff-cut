import { describe, expect, test } from "bun:test";
import {
	buildReport,
	fixedSince,
	mergeFindings,
	OverrideError,
	pinFindings,
	runTimelineChecks,
	validateOverride,
	type CheckRun,
	type Finding,
	type GateOverride,
} from "../src/index.ts";
import { cleanProject, DEFECT_MEDIA, defectProject } from "./fixtures.ts";

const loud: Finding = {
	id: "gate-LOUD-master",
	rule: "LOUD",
	severity: "must",
	status: "open",
	t: 0,
	t_end: 12,
	track: "MASTER",
	element_id: null,
	evidence: "MEASURED",
	message: "Loudness is off",
	fix: "apply +19.0 dB",
	source: "gate:test",
};
const fileRun = (findings: Finding[], not_run: CheckRun["not_run"] = []): CheckRun => ({
	findings,
	ran: ["LOUD", "CLEAN", "FORMAT"],
	not_run,
	skipped: [],
});
const owner = (rule: string, t: number | null = null): GateOverride => ({
	rule,
	reason: "Client signed off on this mix level for the test cell.",
	by: "user:local-owner",
	at: "2026-10-20T00:00:00.000Z",
	t,
});

describe("gate state", () => {
	test("clean timeline + clean file = PASS", () => {
		const r = buildReport([runTimelineChecks(cleanProject()), fileRun([])]);
		expect(r.state).toBe("PASS");
	});
	test("a must blocks; the owner's override unblocks it and is recorded", () => {
		const blocked = buildReport([runTimelineChecks(cleanProject()), fileRun([loud])]);
		expect(blocked.state).toBe("BLOCKED");
		expect(blocked.blocking.map((f) => f.rule)).toEqual(["LOUD"]);
		const passed = buildReport([runTimelineChecks(cleanProject()), fileRun([loud])], [owner("LOUD")]);
		expect(passed.state).toBe("PASS");
		expect(passed.findings[0].status).toBe("dismissed");
		expect(passed.findings[0].dismissed_reason).toContain("signed off");
		expect(passed.applied_overrides).toHaveLength(1);
	});
	test("a check that did not run makes the gate INCOMPLETE, never PASS", () => {
		const r = buildReport([runTimelineChecks(cleanProject()), fileRun([], [{ rule: "LOUD", why: "ffmpeg missing" }])]);
		expect(r.state).toBe("INCOMPLETE");
	});
	test("defect project: BLOCKED, worst first", () => {
		const r = buildReport([runTimelineChecks(defectProject(), { media: DEFECT_MEDIA })]);
		expect(r.state).toBe("BLOCKED");
		const sev = r.findings.map((f) => f.severity);
		expect(sev.indexOf("should")).toBeGreaterThan(sev.lastIndexOf("must"));
	});
});

describe("D13 overrides", () => {
	test("claims can never be overridden", () => {
		expect(() => validateOverride(owner("CLAIM"), true)).toThrow(OverrideError);
	});
	test("Claude can never override", () => {
		expect(() => validateOverride({ ...owner("LOUD"), by: "claude:session-1" }, true)).toThrow(OverrideError);
	});
	test("only the owner, and only with a written reason", () => {
		expect(() => validateOverride(owner("LOUD"), false)).toThrow(OverrideError);
		expect(() => validateOverride({ ...owner("LOUD"), reason: "ok" }, true)).toThrow(OverrideError);
		expect(validateOverride(owner("R15"), true).rule).toBe("R15");
	});
	test("an override with t only matches findings within 0.5 s", () => {
		const r = buildReport([runTimelineChecks(defectProject(), { media: DEFECT_MEDIA })], [owner("CLEAN", 9)]);
		const clean = r.findings.filter((f) => f.rule === "CLEAN");
		expect(clean.filter((f) => f.status === "dismissed").map((f) => f.t)).toEqual([9]);
	});
});

describe("merge, pin, lifecycle", () => {
	test("timeline + file findings of one rule within 0.5 s merge", () => {
		const tl: Finding = { ...loud, id: "a", rule: "CLEAN", t: 9, t_end: 9.5, evidence: "TIMELINE", element_id: null, severity: "must" };
		const file: Finding = { ...loud, id: "b", rule: "CLEAN", t: 9.03, t_end: 9.5, track: null, severity: "must" };
		expect(mergeFindings([tl], [file])).toHaveLength(1);
	});
	test("a file finding is pinned to the shot under it", () => {
		const f: Finding = { ...loud, id: "c", rule: "CLEAN", t: 5.4, t_end: 6, track: null };
		const [pinned] = pinFindings([f], defectProject());
		expect(pinned.track).toBe("V1 A-ROLL");
		expect(pinned.element_id).toBe("S02");
	});
	test("gone findings become fixed", () => {
		const gone = fixedSince([loud], []);
		expect(gone[0].status).toBe("fixed");
		expect(gone[0].resolved_by).toBe("re-measure");
	});
});
