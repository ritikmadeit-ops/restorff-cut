# @restorffcut/timeline-ops — changelog

Newest first. Append-only. This file is the source of truth for the version.

## 0.2.0 — 2026-10-20 (reducer-perf)
- `apply` is near-linear in the batch size, results byte-identical. One clone per batch; a conflicting op is undone
  through an undo log + a small per-op savepoint (was a structuredClone of the whole project per op); elements and
  overlaps found through a live index; the invariant list kept as a multiset updated from what each op touched, the
  full check only to word a conflict (same message, same order). MEASURED (`bun bench/apply.bench.ts`): huge-centred
  captions 2,702 ops 10.8 s → 59 ms, 10,002 ops 179 s → 169 ms; 10,000 inserts on one track 255 s → 122 ms; autocut
  9,999 ops 90 s → 610 ms (its output alone is 889k element shifts).
- New `src/reducer-state.ts`; `src/scene.ts` checkInvariants split into exported parts (same list);
  `applyWithSelfCheck` (tests only). Handler rules in the `reducer.ts` header and README.
- Proof: `test/equivalence.test.ts` (19 tests) and `bun test --preload ./test/dual-apply.preload.ts` (whole suite:
  532/532 apply() calls identical) against the frozen old reducer in `test/reference/`. Tests: 140 with `bun test`.
- (Between 0.1.0 and this, other agents added sentence intents, sound design, captions, transitions, the storyboard
  compiler and grades — recorded in the repo's CHANGELOG.md 0.2.0/0.3.0.)

## 0.1.0 — 2026-10-20
- ops@1 as TypeScript types (`src/ops.ts`, all 25 ops of plan/06 §5) and a dependency-free runtime validator
  (`src/validate.ts`).
- Pure reducer `apply(project, ops, {seed})` over the editor's project JSON (version 31): deterministic ids, no clock,
  input never mutated, atomic or best-effort batches, invariants checked after every op, `changes` per op,
  `changes.unsupported` + `metadata.restorff.pending` for what the model can't express.
- Exact seconds↔ticks (120 000/s) and frame maths ported from `rust/crates/time`; keyframe upsert/split/clamp ported
  from `apps/web/src/animation` (two editor bugs found: PARITY D2, D3; D3 fixed in the reducer).
- Track names follow the editor's artboard naming (`timeline/tracks.ts getDefaultTrackName`).
- Talking-head auto-cut compiler seed `cutFromTranscript` (EDT-03): silences > 0.35 s, retakes, 1-3-word captions.
- Tests: 64 with `bun test`, 3 with `node --test test/smoke.node.ts`; MODEL.md, PARITY.md, README.md.

## Next (ideas, not started)
- Parity harness: run each browser command and the reducer on the same project in headless Chromium, diff the JSON.
- `metadata.restorff` survives a browser save (needs the apps/web owner) — or move pending instructions into the commit.
- ops@2 candidates: `unmark`, `unkeyframe`, `mask`, `effect`, `duplicate`, scene ops, colour keyframes.
- `grade` → a real effect once the rust agent ships a colour/LUT shader; then move it from pending to native.
- Variant compiler for `add_size_variant` (4:5 / 1:1 / 16:9 with reframe keyframes).
- Talking-head compiler: filler-word removal ("um", "you know"), punch-ins on emphasis, keyword-highlight captions.
- Caption wrapping/placement by measuring text (needs a canvas or a font-metrics table).
