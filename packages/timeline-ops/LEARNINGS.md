# @restorffcut/timeline-ops — LEARNINGS

Rules something paid for. Each carries its date, the incident and the cost; a rule with no incident is an opinion.

## 1. A fuzz test must prove it is not testing rejections (2026-10-20)
**Rule:** every random-ops test asserts how many ops actually applied (here: at least 40 %), not only that invariants
hold.
**Incident:** the first "300 random ops keep every invariant" test passed while only 34 of 300 ops applied — random
targets and times were mostly invalid, so it mostly tested the conflict path. **Cost:** one rewrite; would have shipped
false confidence.

## 2. Re-grep `apps/web` line numbers right before writing them (2026-10-20)
**Rule:** the skin agent edits `apps/web` at the same time; quote a file:line only after grepping it in the same step,
and say in the doc that lines move.
**Incident:** between the first read and writing MODEL.md, `MAIN_TRACK_NAME` changed from "Main Track" to "V1 A-ROLL",
`AddTrackCommand` gained a `name`, track names became the artboard's, and `build-subtitle-text-element.ts` shifted by
~40 lines. **Cost:** a second verification pass, a port of `getDefaultTrackName`, two test updates.

## 3. Port faithfully, then let a property test judge the spec (2026-10-20)
**Rule:** copy the editor's behaviour first, then test properties (continuity at a cut, source conservation); when a
property fails on the faithful port, it is an editor bug — record a divergence in PARITY.md, don't silently "fix" it.
**Incident:** "split keeps every animated value continuous" failed with NaN: the editor's `splitScalarChannelAtTime`
leaves a half without keys when the split is past the last key (PARITY D3). Reading also found the bezier-split
duplicate key (D2). **Cost:** none beyond the fix — this is the rule working.

## 4. Random cut points must leave one frame on each side (2026-10-20)
**Rule:** property tests that cut at random ticks keep ≥ 1 frame (4 000 ticks at 30 fps) on both sides.
**Incident:** "split then delete left == trim in" failed at a cut 909 ticks before the end: `trim` (like the editor's
resize) refuses clips shorter than a frame, `split` does not. **Cost:** one debugging round.

## 5. Node on Windows can't import `C:/…` specifiers (2026-10-20)
**Rule:** scratch scripts import by relative path or `file:///C:/…`; or run them with Bun.
**Incident:** `node example.ts` with `import … from "C:/data/…"` died with `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
**Cost:** one re-run.

## 6. Nothing per op may cost O(project) — an op pays for what it touched (2026-10-20, reducer-perf)
**Rule:** inside `apply`'s op loop, never clone, scan or re-check the whole project. Roll back with an undo log
(placed elements are copy-on-write, so only arrays and a few small containers change); find things through the live
index; check invariants on what the op touched. New handlers go through `ctx.state` (reducer.ts header lists the rules).
**Incident:** one `structuredClone(draft)` per op as the rollback snapshot + two full `checkInvariants` per op made a
batch O(n²): 2,702 huge-centred caption ops took 11 s, 10,002 took 198 s; captions on a 49 s clip ~20 s per MCP call,
a 10-minute talking head past the 120 s tool budget (mcp-cut, MEASURED). **Cost:** one agent-session rewrite.

## 7. Big self time in a function that calls natives: time the natives directly (2026-10-20, reducer-perf)
**Rule:** when a CPU profile puts most of the time in a function's *self* time and that function calls
`structuredClone`, `JSON.*`, `sort` or similar, time those calls directly on a realistic input before guessing.
**Incident:** `node --cpu-prof` showed 86 % self time in `runOne`; the culprit was `structuredClone`'s native
serialisation booked to its caller (3.5 ms/call × 2,702 ops ≈ 9.6 s of 12 s). **Cost:** none — caught by the rule.

## 8. Prove a rewrite equal against a frozen copy, and prove the proof can fail (2026-10-20, reducer-perf)
**Rule:** before rewriting for speed, freeze the old implementation under `test/reference/` (imports repointed only)
and compare byte-for-byte on every call the suite makes (`test/dual-apply.preload.ts`), plus fuzz and broken inputs
with the new code's self-check on. Then run a negative control: perturb the new result and see the harness fail.
**Incident:** the negative control (one extra warning on every new result) failed 100 of 121 tests — the 21 that
passed never call `apply`; without it, a preload that silently didn't intercept would have "proved" equality.
**Cost:** two minutes; it is what makes "532 of 532 identical" mean something.

## 9. Measure the output before calling a slowdown a bug (2026-10-20, reducer-perf)
**Rule:** if a batch still scales super-linearly after the fix, count what the batch must *report* first.
**Incident:** the 9,999-op autocut bench stayed above linear (587 ms): its 1,333 `ripple_delete`s must shift and list
889,111 elements in total (52 MB of result JSON) — quadratic by the op's meaning, not by the reducer. **Cost:** one
profiling round, which also found two real costs (element lookup from one end only, a WeakMap per element).
