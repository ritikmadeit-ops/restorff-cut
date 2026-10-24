import { describe, expect, test } from "bun:test";
import type { CheckRun, Finding } from "@restorffcut/gate";
import { type ExistingComment, gateCommentPayload, rulesChecked, toCommentFinding } from "@/gate/comment-payload";

// ui-fix-timeline, QA 2026-10-20 #30: the gate's comments POST answered 400 → "showing local markers".

function finding(id: string, patch: Partial<Finding> = {}): Finding {
	return {
		id,
		rule: "SAFE",
		severity: "must",
		status: "open",
		t: 0.2,
		t_end: 2.2,
		track: "TEXT",
		element_id: "el-1",
		evidence: "TIMELINE",
		message: "Headline leaves the safe area.",
		fix: "move it inside x 60–940",
		source: "gate:restorffcut@0.1.0",
		...patch,
	};
}

function run(ran: string[], notRun: string[] = []): CheckRun {
	return { findings: [], ran, not_run: notRun.map((rule) => ({ rule, why: "x" })), skipped: [] };
}

function comment(id: string, patch: Partial<ExistingComment> = {}): ExistingComment {
	return {
		id,
		finding_id: `gate-R5-${id}`,
		author: "gate:restorffcut@0.1.0",
		status: "open",
		rule_id: "R5",
		severity: "should",
		time_s: 21.09,
		time_end_s: 24.8,
		track_id: "trk-broll",
		track_name: "V2 B-ROLL",
		element_id: `el-${id}`,
		commit_id: "d7c4107",
		body: '"Type-on title" holds for 3.7 s. → cut "Type-on title" to 3 s',
		parent_id: null,
		...patch,
	};
}

describe("gateCommentPayload", () => {
	test("a clean run with nothing to close sends nothing (the API answers an empty import with 400)", () => {
		expect(gateCommentPayload({ findings: [], previous: [], existing: [], runs: [run(["SAFE", "R5"])] })).toBeNull();
	});

	test("findings go out as the API's finding@1, with the commit", () => {
		const body = gateCommentPayload({ findings: [finding("a")], previous: [], existing: [], commitId: "f46e074" });
		expect(body?.commit_id).toBe("f46e074");
		expect(body?.findings.map((f) => f.id)).toEqual(["a"]);
	});

	test("an open gate comment for a re-checked rule the run no longer finds is closed as fixed (QA #10's duplicate R5)", () => {
		const current = finding("gate-R5-new", { rule: "R5", severity: "should", t: 21.09, element_id: "el-new" });
		const body = gateCommentPayload({
			findings: [current],
			previous: [],
			existing: [comment("old"), comment("new", { finding_id: "gate-R5-new" })],
			runs: [run(["R5", "SAFE"])],
		});
		const closed = body?.findings.find((f) => f.id === "gate-R5-old");
		expect(closed?.status).toBe("fixed");
		expect(closed?.message).toBe('"Type-on title" holds for 3.7 s.');
		expect(closed?.fix).toBe('cut "Type-on title" to 3 s');
		expect(closed?.track).toBe("V2 B-ROLL");
		expect(body?.findings.filter((f) => f.id === "gate-R5-new")).toHaveLength(1);
	});

	test("comments of rules that did not run completely, other authors, replies and resolved ones are left alone", () => {
		const body = gateCommentPayload({
			findings: [finding("a")],
			previous: [],
			existing: [
				comment("clean", { rule_id: "CLEAN", finding_id: "gate-CLEAN-black0" }),
				comment("judge", { author: "judge:restorff-craft@1.0" }),
				comment("reply", { parent_id: "x" }),
				comment("done", { status: "resolved" }),
				comment("local", { finding_id: "gate-R5-local" }),
			].map((c) => (c.finding_id === "gate-R5-local" ? { ...c, id: "gate-local:gate-R5-local" } : c)),
			// CLEAN ran in the timeline half but its file half did not: not checked completely.
			runs: [run(["R5", "CLEAN"]), run([], ["LOUD", "CLEAN", "FORMAT"])],
		});
		expect(body?.findings.map((f) => f.id)).toEqual(["a"]);
	});

	test("without the runs no stale comment is closed", () => {
		const body = gateCommentPayload({ findings: [finding("a")], previous: [], existing: [comment("old")] });
		expect(body?.findings.map((f) => f.id)).toEqual(["a"]);
	});
});

describe("toCommentFinding", () => {
	test("a lane outside finding@1 becomes track null and stays readable as track_name", () => {
		const f = toCommentFinding(finding("m", { track: "MOTION" as Finding["track"] }));
		expect(f?.track).toBeNull();
		expect(f?.track_name).toBe("MOTION");
	});

	test("a bad severity is not sent; a bad time is clamped", () => {
		expect(toCommentFinding(finding("x", { severity: "could" as Finding["severity"] }))).toBeNull();
		const f = toCommentFinding(finding("t", { t: Number.NaN, t_end: Number.POSITIVE_INFINITY }));
		expect(f?.t).toBe(0);
		expect(f?.t_end).toBeNull();
	});
});

describe("rulesChecked", () => {
	test("ran in a half and not listed as not run in any", () => {
		expect([...rulesChecked([run(["SAFE", "CLEAN"]), run(["LOUD"], ["CLEAN"])])].sort()).toEqual(["LOUD", "SAFE"]);
	});
});
