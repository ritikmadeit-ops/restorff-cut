/**
 * Benchmark: apply() (src/reducer.ts) against the frozen pre-rewrite reducer (test/reference/reducer-v0.ts).
 *
 * Run from packages/timeline-ops:
 *   bun bench/apply.bench.ts                         new + old at 600 and 2700, new only at 10000
 *   bun bench/apply.bench.ts --old-max 10000         also time the old reducer at 10000 (minutes)
 *   bun bench/apply.bench.ts --sizes 600 --kinds captions --impl new --repeat 5
 *   node bench/apply.bench.ts                        same under Node 24 (type stripping)
 *
 * Prints one row per (batch kind, size): ops, applied ok, ms new (best of --repeat), ms old (one run), speed-up,
 * and "same" = whether the two results are byte-identical JSON (project + changes + conflicts + ok).
 */
import { apply } from "../src/reducer.ts";
import { apply as applyReference } from "../test/reference/reducer-v0.ts";
import { BATCH_KINDS, type BatchKind, buildBatch } from "./batches.ts";

function arg(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const sizes = arg("sizes", "600,2700,10000").split(",").map(Number);
const kinds = arg("kinds", BATCH_KINDS.join(",")).split(",") as BatchKind[];
const impl = arg("impl", "both");
const repeat = Math.max(1, Number(arg("repeat", "3")));
const oldMax = Number(arg("old-max", "2700"));
const SEED = "halcyon-bench";

function time<T>(fn: () => T): { ms: number; value: T } {
	const start = performance.now();
	const value = fn();
	return { ms: performance.now() - start, value };
}

const rows: string[] = [];
const header = "kind      ops     ok     new ms     old ms   speed-up  same";
console.log(header);
for (const kind of kinds) {
	for (const size of sizes) {
		const batch = buildBatch(kind, size);
		let newMs = Number.NaN;
		let newJson: string | undefined;
		let ok = "-";
		if (impl !== "old") {
			const runs: number[] = [];
			for (let r = 0; r < repeat; r++) {
				const { ms, value } = time(() => apply(batch.project, batch.ops, { seed: SEED }));
				runs.push(ms);
				if (r === 0) {
					newJson = JSON.stringify(value);
					ok = String(value.ok);
				}
			}
			newMs = Math.min(...runs);
		}
		let oldMs = Number.NaN;
		let oldJson: string | undefined;
		if (impl !== "new" && size <= oldMax) {
			const { ms, value } = time(() => applyReference(batch.project, batch.ops, { seed: SEED }));
			oldMs = ms;
			oldJson = JSON.stringify(value);
			if (ok === "-") ok = String(value.ok);
		}
		const same = newJson !== undefined && oldJson !== undefined ? String(newJson === oldJson) : "-";
		const speedUp = Number.isFinite(newMs) && Number.isFinite(oldMs) ? `${(oldMs / newMs).toFixed(0)}x` : "-";
		const fmt = (ms: number) => (Number.isFinite(ms) ? ms.toFixed(1) : "-");
		const row = `${kind.padEnd(9)} ${String(batch.ops.length).padStart(5)} ${ok.padStart(6)} ${fmt(newMs).padStart(10)} ${fmt(oldMs).padStart(10)} ${speedUp.padStart(10)}  ${same}`;
		rows.push(row);
		console.log(row);
	}
}
