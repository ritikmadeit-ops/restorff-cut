/**
 * Node smoke test: proves the package runs under plain Node 24 with type stripping (no Bun, no build step).
 * Run: node --test test/smoke.node.ts   (from packages/timeline-ops)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, checkInvariants, cutFromTranscript, secondsToTicks, validateOps } from "../src/index.ts";
import { fixtureProject, TRANSCRIPT } from "./fixture.ts";

test("seconds → ticks matches the editor's rust rule", () => {
	assert.equal(secondsToTicks(1.5), 180_000);
	assert.equal(secondsToTicks(-0.5 / 120_000), -1);
});

test("validate + apply a small batch, deterministically, without touching the input", () => {
	const ops = [
		{ op: "split", author: "claude", el: "el-aroll", t: 8, ref: "r" },
		{ op: "keyframe", author: "claude", el: "r", prop: "scale", t: 9, value: 1.15, ease: "ease_in_out" },
		{ op: "normalize", author: "claude", lufs: -14, true_peak: -1 },
	] as const;
	assert.equal(validateOps(ops).ok, true);
	const input = fixtureProject();
	const before = JSON.stringify(input);
	const first = apply(input, [...ops], { seed: "node" });
	const second = apply(input, [...ops], { seed: "node" });
	assert.equal(JSON.stringify(input), before);
	assert.equal(JSON.stringify(first), JSON.stringify(second));
	assert.equal(first.ok, true);
	assert.equal(first.changes.unsupported.length, 0); // normalize is applied natively since project v32 (media agent)
	assert.equal(first.project.scenes[0].tracks.main.elements.length, 2);
});

test("talking-head auto-cut applies cleanly", () => {
	const plan = cutFromTranscript(TRANSCRIPT, { clip: { el: "el-aroll", start: 0, in: 0, out: 20 } });
	const result = apply(fixtureProject(), plan.ops, { seed: "node-th" });
	assert.equal(result.ok, true);
	assert.equal(result.project.scenes[0].tracks.main.elements.length, 3);
	assert.deepEqual(checkInvariants(result.project.scenes[0], result.project.metadata.restorff?.media ?? []), []);
});
