# gsap-compat — GSAP-API animation runtime for compositions (0.1.0, MIT)

**What.** Our own implementation of the part of the GSAP 3 API that HyperFrames blocks (and Claude, by habit) write:
timelines, tweens, eases, stagger, keyframes, `gsap.utils`, CustomEase and MotionPath, plus small TextPlugin,
ScrambleTextPlugin, DrawSVGPlugin and SplitText. It lets a composition written for GSAP run in RestorffCut's
renderer — sandboxed, network-blocked, one seek per frame — **without shipping GSAP** (not OSI open source:
`../../DECISION.md`). Supported API, survey counts and every known difference: [STATUS.md](STATUS.md).

**Clean room.** Written from GSAP's public documentation and from black-box observation of real GSAP's *outputs*
(style strings, numbers, callback logs) in a scratchpad browser. GSAP's source code was never opened, read or copied —
the four `gsap-3.14.2.min.js` files inside the HyperFrames clone were excluded from every grep. Keep it that way: when
behaviour is unclear, **probe it** (below), never read GSAP. "GSAP" is a trademark of its owner; no affiliation.

**Deterministic.** No ticker, no clock, no `requestAnimationFrame`. Every render is a function of the target time:
children render in start order (later starts win), a tween's start values are fixed once, as if the timeline had
been played forward from 0. Same seek → same frame (tested with 4 tabs). Randomness is seeded per composition.

## Files
| File | What |
|---|---|
| `gsap.js` | the runtime (plain ES2015, 2,349 lines, 115 KB). Exposes `window.gsap`, `CustomEase`, `MotionPathPlugin`, `TextPlugin`, `ScrambleTextPlugin`, `DrawSVGPlugin`, `SplitText`, `EasePack` |
| `hf-protocol.js` | the HyperFrames page protocol, injected into **every** page: seeks `window.__timelines[id]`, dispatches `hf-seek`, seeks `window.__hfLottie` / `window.__hfAnime`, awaits `window.__hf.buildReady`, answers `window.__hyperframes.getVariables()` |
| `STATUS.md` | the live support table (fx-sync reads it) |
| `../libs.ts` | the library loader: marker parsing (`<!-- rc-lib gsap three … -->`), file list, init script, hash |
| `../../vendor/` | Three.js 0.184.0 / 0.147.0, lottie-web 5.12.2, Anime.js 4.5.0 (`vendor/README.md`) |
| `../../test/gsap-compat.test.ts` | 47 tests: timeline maths, positions, eases, stagger, keyframes, callbacks, determinism, seeded random, utils, libs, CSS/transform strings, the protocol, Three/lottie/Anime, bit-identical renders |

## Use it in a composition
```html
<!doctype html><html><head><meta charset="utf-8"><!-- rc-lib gsap -->
<script type="application/json" id="params">{"duration": 3, "size": [1080, 1920], "params": {}}</script>
</head><body>
<div id="word" style="position:absolute;left:120px;top:800px;font:900 160px Archivo;color:#F6FF00">COLD</div>
<script>
  var tl = gsap.timeline({ paused: true });
  tl.from("#word", { y: 120, opacity: 0, duration: 0.6, ease: "back.out(1.7)" })
    .to("#word", { scale: 1.1, duration: 0.3, yoyo: true, repeat: 1, ease: "power2.inOut" }, ">0.4");
  window.__timelines = window.__timelines || {};
  window.__timelines.word = tl;          // the runtime seeks it every frame
</script></body></html>
```
Rules: create timelines `{ paused: true }` and register them; never call `play()` and expect motion; no
`Math.random` (use `gsap.utils.random`, seeded); no `onUpdate` that reads the clock. A page that also registers
`RC.composition({ build, render })` drives its timelines itself (or calls `RC.hf.seek(time.t)` from `render`).

## Verify (run 2026-10-24 14:3x; all passed)
From `restorffcut/packages/compositions/`:
```
bun test test/gsap-compat.test.ts
bun test
```
1. `47 pass, 0 fail` in 5–15 s (needs Chromium: `bunx playwright@1.63.0 install --only-shell chromium`).
2. The whole package: `583 pass, 0 fail` across 9 files in about 60 s (MEASURED 2026-10-24 14:5x, with the other
   wave-7 suites).

## The oracle (compare with real GSAP, black box) — GSAP stays outside the repo
The harness is in `oracle/` (ours, no GSAP in it). Real GSAP is installed in a **scratch folder outside the repo**,
only to observe its outputs; `probe.ts` refuses a `GSAP_ORACLE_DIR` inside the repo. Steps (Git Bash; `SP` = any
scratch folder, e.g. the session scratchpad; `$SP/hyperframes` = a HyperFrames clone, e.g. fx-sync's sparse clone at
fa5dbd1 — how to fetch one: `tools/fx-sync/README.md`):
```
mkdir -p $SP/gsap-oracle && cd $SP/gsap-oracle && echo '{"name":"oracle","private":true}' > package.json
npm install gsap@3.14.2 --no-audit --no-fund
cd <restorffcut>/packages/compositions
GSAP_ORACLE_DIR=$SP/gsap-oracle bun src/gsap-compat/oracle/probe.ts src/gsap-compat/oracle/probes/semantics.js
GSAP_ORACLE_DIR=$SP/gsap-oracle HF_BLOCKS_DIR=$SP/hyperframes/registry/blocks bun src/gsap-compat/oracle/blocks.ts $SP/oracle-out --list src/gsap-compat/oracle/eligible-blocks.txt --times 6
py -I src/gsap-compat/oracle/survey.py $SP/hyperframes $SP/survey.json
```
- `probe.ts` — runs `{ name, html, code }` probes in Chromium twice, once with real GSAP (`gsap.min.js` +
  `CustomEase.min.js` + `MotionPathPlugin.min.js` as an init script) and once with `gsap.js`; prints `SAME`/`DIFF`
  with both JSON answers (`--only name`, `--real-only`). Probe files (`oracle/probes/`): `semantics.js` (43),
  `semantics2.js` (26), `semantics3.js` (15), `setedge.js` (5), `svgorigin.js`, `csstest.js`, `expo.js`.
- `blocks.ts` — renders HyperFrames blocks through our runtime + `hf-protocol.js` with each library, seeking every
  frame at 30 fps (as the renderer does), captures 6 frames at ½ scale and compares in-page (mean abs diff, PSNR,
  % of pixels off by > 24/255). Status: **match** = PSNR ≥ 40 dB and < 0.1 % pixels off on every frame; **close** =
  ≥ 26 dB and < 3 %; else **broken**. `--eval "<js>"` prints an expression per sample frame (debugging). Look at the
  PNG pairs of every non-match before deciding why. `eligible-blocks.txt` = the 114 GSAP blocks with no Three.js,
  WebGL, WebGPU, d3, Lottie, nested composition, `Math.random`, clock or timer (from `survey.py`'s output).
- `survey.py` — counts the GSAP API surface over the clone (methods, positions, eases, stagger, vars keys, plugins,
  other runtimes); its 2026-10-24 counts are in `docs/restorff/worklog/anim-runtime.md`.
How to add a feature: probe real GSAP with a tiny page first, implement, re-probe until `SAME`, then pin the observed
values in `test/gsap-compat.test.ts` (as the existing tests do, marked "GSAP 3.14.2").

## Known failures and fixes
| Symptom | Cause | Fix |
|---|---|---|
| `no composition registered` for a HyperFrames file | its content is inside `<template>` (a sub-composition the HF compositor mounts) or it registers after the page has built | flatten the template (fx-sync does), register the timeline synchronously |
| a blur/glow looks slightly weaker than in HyperFrames' own render | GSAP writes `translate3d` mid-tween (a compositor layer rasterises filters differently); we always write 2D (LEARNINGS §2) | expected; "close" in the oracle |
| element ends 50 % of its height too low | its CSS centring `translate(-50%, -50%)` was not read as yPercent −50 | GSAP itself only does it when round(offsetHeight / 2) === round(-translateY) (observed; LEARNINGS §36): ours follows the same rule, so such a block looks the same in both; fix the block (use yPercent: -50) if it should be centred |
| `<!-- rc-lib x -->: unknown library` | a typo, or a library not vendored | names: gsap, three, three-r147, lottie, anime |
| GSAP code that plays on its own (`gsap.to` outside a timeline) moves in the render | expected: our global timeline follows the frame time | register a paused timeline instead if it should start later |
