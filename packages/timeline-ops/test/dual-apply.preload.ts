/**
 * Opt-in preload: run the WHOLE existing test suite through the old and the new reducer at once.
 *
 *   bun test --preload ./test/dual-apply.preload.ts        (from packages/timeline-ops)
 *
 * Every apply() any test makes (directly, through test/helpers.ts, or inside src — sound-design, compilers…) runs the
 * frozen pre-rewrite reducer (test/reference/reducer-v0.ts) AND the new one (with its incremental-state self-check)
 * on the same input, and throws — failing that test — unless the two results are byte-identical JSON (or both throw
 * the same message). The new result is what the test then sees. At exit it prints how many calls were compared.
 * test/equivalence.test.ts covers the bench batches, fuzz and broken projects in the normal `bun test` run.
 */
import { afterAll, mock } from "bun:test";
import * as real from "../src/reducer.ts";
import { apply as referenceApply } from "./reference/reducer-v0.ts";

const tally = { calls: 0, same: 0 };
const newApply = real.applyWithSelfCheck;

function outcome(run: () => unknown): { json?: string; error?: string; value?: unknown; thrown?: unknown } {
	try {
		const value = run();
		return { json: JSON.stringify(value), value };
	} catch (thrown) {
		return { error: thrown instanceof Error ? thrown.message : String(thrown), thrown };
	}
}

function firstDifference(a: string, b: string): string {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return `at char ${i}: old …${a.slice(Math.max(0, i - 80), i + 80)}… new …${b.slice(Math.max(0, i - 80), i + 80)}…`;
}

const dualApply: typeof real.apply = (project, ops, options) => {
	tally.calls++;
	const before = JSON.stringify(project);
	const old = outcome(() => referenceApply(project, ops, options));
	const now = outcome(() => newApply(project, ops, options));
	if (JSON.stringify(project) !== before) throw new Error("dual-apply: an apply() mutated its input project");
	if (old.error !== undefined || now.error !== undefined) {
		if (old.error !== now.error) throw new Error(`dual-apply: old threw ${JSON.stringify(old.error)}, new threw ${JSON.stringify(now.error)}`);
		throw now.thrown;
	}
	if (old.json !== now.json) throw new Error(`dual-apply: results differ ${firstDifference(old.json ?? "", now.json ?? "")}`);
	tally.same++;
	return now.value as ReturnType<typeof real.apply>;
};

mock.module("../src/reducer.ts", () => ({ ...real, apply: dualApply }));

// a preload's afterAll runs once per test file: print the running total each time (the last line is the suite's)
afterAll(() => {
	console.log(`dual-apply: ${tally.calls} apply() calls so far, ${tally.same} byte-identical (old reducer vs new)`);
});
