# @restorffcut/gate — the export gate

**What it does.** Makes bad work hard to ship without blocking good work. Every check in `docs/restorff/EXPORT-GATE.md`
that can be read from the project JSON runs here as a pure function and returns `finding@1` objects; the file checks
(loudness, black/held frames, flash frames, format) are measured by ffmpeg on the encoded render and parsed here.
`buildReport` combines both into a gate state: **BLOCKED** (an open MUST), **INCOMPLETE** (a check did not run — never
a pass), **PASS**.

Since 0.2.0 (gate-v2, 2026-10-20) the rules follow the **piece type** (ad · talking_head · explainer · motion_graphic ·
brand_film; EXPORT-GATE §2a), rhythm counts **picture changes** (cuts of the base picture, scenes inside compositions,
effects, overlay beats) instead of clips, R3 / R15 read **text inside compositions**, **FACE** and **FLASH** exist,
findings name their **real lane** (`track_name`, `track_id`) and carry an exact **`fix_call`**.

**When to use it.** Every Render final in the editor (wired: `apps/web/src/gate/run.ts`), every MCP `check`
(`apps/web/src/server/renders-check.ts`, with the measurements in `renders-check-media.ts`), and anywhere else a cut is
about to leave — it imports under plain Node 24 (erasable TypeScript, no build step).

## Checks

| Id | Half | Severity (ad · other pieces: §2a) | Reads |
|---|---|---|---|
| SAFE | timeline | must | text boxes vs the canvas's zone: Reels x 60–940, y 220–1500 on 9:16 (scaled); title-safe 5 % elsewhere; `measureText` from the server = the caption builder's Chromium measurer |
| CAP-LEN | timeline | should | base caption chunks: 1–3 words on an ad, 1–5 elsewhere |
| R3 | timeline | should (info / off) | a non-caption text ≤ 7 words by 0.3 s (1.0 s on a motion graphic), timeline text or composition text |
| R15 | timeline | must on ads only | last 6 s: the brief's price + reason + CTA (exact), else patterns; skipped on non-ads (unless the brief has an offer) and with `offer: false` |
| R1 R5 R6 | timeline | should | picture changes (`changes.ts`): ad = CRAFT bars; other pieces = bars from the reels (piece.ts) |
| R12 | timeline | should (info on talking heads / explainers) | MUSIC coverage ≥ 90 % (or silence reasons) |
| R23 | timeline | should | every shot overlaps a non-music sound, a beat, or a silence reason |
| R4, R21 | timeline | should on ads only | an SFX / downbeat at 0.0 s; board music hits on a cut or beat |
| CLEAN | both | must/should | gaps; clips shorter than their slot; file blackdetect / freezedetect (holds = should on explainers, motion graphics, brand films unless a stall) |
| FORMAT | both | must | the brief's deliver, else the canvas in one of the piece's aspects (short side ≥ 720); fps; the file matches the canvas; H.264 + AAC |
| FACE | timeline | should | overlays (text, compositions by alpha grid, pictures) over the matte's face box ≥ 25 % for ≥ 0.3 s; skipped without a matte |
| FLASH | both | must (should on motion graphics / brand films; black = must) | timeline: a base-picture run of 1–3 frames; file: `detectFlashes` over frame changes near cuts (whole frame + inside the face box), designed flashes filtered |
| LOUD | file | must | `ebur128=peak=true`: −14 LUFS ±1, true peak ≤ −1 dBTP |

Not here (need a transcript, OCR, a person or a judge): MIX, R22, CAP, R18, FIRST, CLIP, LIP, TAIL, CLAIM.

## Commands (run from `packages/gate`)

```text
bun test                      # 50 tests (2026-10-20): planted defects, piece types, composition scenes/text, FACE, FLASH, lanes, fix calls, D13, parsers
node ../../node_modules/typescript/bin/tsc -p tsconfig.json     # typecheck (no output = clean)
node --input-type=module -e "import('./src/index.ts').then(m=>console.log(Object.keys(m).length))"   # Node 24 import (64 exports)
```

Over MCP (dev server on 8791; from the repo root; read-only with `comments:false`):

```text
bun scripts/mcp-call.ts call check '{"timeline_id":"<id>","comments":false}'
bun scripts/mcp-call.ts call check '{"render_id":"<rid>","piece":"explainer","comments":false}'
```

The answer: `state`, `piece {type, source, why}`, `picture_changes {cut, scene, effect, transition, beat, shots}`,
`findings[] {rule, severity, status, t, track (real lane), lane, track_id, element_id, message, fix, fix_call}`,
`measured {text, compositions, media_with_faces, flash}`, `next` (= the first blocker's `fix_call`). First check of a
timeline measures each composition's render (~1–4 s each, 4 at a time), cached in `apps/web/.data/gate/compositions/`.

## API (src/index.ts)

- `runTimelineChecks(project, {measureText?, measureMethod?, media?, piece?, platform?, compositions?, faces?, hints?, sceneId?, commit?, source?}) → CheckRun` (+ `piece`, `changes`)
- Pieces: `PROFILES`, `decidePiece`, `inferPiece`, `normalizePiece`, `safeZoneFor`, `aspectName`, `nearestStandard`
- Picture: `changeMap`, `baseRuns`, `covers`, `continues`; compositions: `compositionFacts`, `manifestFromSource`, `localToTimeline`, `alphaCoverage`, `alphaBox`
- FACE / FLASH: `faceOnCanvas`, `boxCoverage`, `detectFlashes`, `filterDesignedFlashes`
- File: `parseEbur128 / parseBlackdetect / parseFreezedetect / parseFfprobe`, `fileFindings(measures, expect, {piece?})`, `loudnessGain`
- Report: `pinFindings(findings, project, sceneId?, {media, compositions})`, `mergeFindings`, `buildReport`, `fixedSince`, `toSchemaFinding` (drops the gate-v2 additions), `laneOf`, `fitOps`
- D13: `validateOverride(o, isOwner)` — CLAIM never; `by` starting claude/judge/worker/compiler/gate never; owner only; reason ≥ 12 characters.

## Project fields the gate reads (all optional)

`metadata.restorff`: `piece` (string or `{type, set_by, at}`), `platform`, `brief {offer, price, reason, cta, deliver,
fps, dramatic_open, piece, platform}`, `overrides[]`, `silences[]`, `board.music.hits[]`. Elements: `restorff.silence`
(R23), `restorff.dramatic` (R1), `restorff.flash` (a designed flash), `restorff.cutout`, `restorff.effect`,
`restorff.composition {name, props, source?, scenes?, text?, opaque?}`, audio `beats`.

## Known limits

- `evidence: "TIMELINE"` is what the first gate brief asked for; the canonical enum is MEASURED · SEEN · READ —
  `toSchemaFinding` maps it to READ.
- SAFE reads a text element's base transform (keyframed text not followed); FACE follows clip keyframes linearly
  (the editor eases with beziers), ignores rotation, and assumes "contain" fit.
- The non-ad rhythm bars, the title-safe zone, the scene / flash thresholds and the CLEAN-hold relaxation are
  ASSUMPTIONs set on the five recreations (numbers in `docs/restorff/worklog/gate-v2.md`).
- Composition text without a declared `text` is timed at the element's start.
