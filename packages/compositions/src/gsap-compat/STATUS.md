# gsap-compat — STATUS (read by fx-sync; kept current by anim-runtime)

Last update: 2026-10-24 15:05 IST. **Done for wave 7.** Semantic probes (same page, real GSAP 3.14.2 vs ours):
80 of 99 answers identical, every other one explained under "Differences". Block oracle: of the 110 comparable
GSAP blocks, **95 render the same frames, 13 close, 2 differ by the metric but look the same** (section at the end).

## How a composition gets it (the include form, agreed with fx-sync 13:40)
A marker comment anywhere in the HTML (in `<head>` by convention), one or more names per marker:
```
<!-- rc-lib gsap -->
<!-- rc-lib gsap three -->
```
The renderer (`src/libs.ts`, `src/render.ts initScript`) injects each named library **before any page script**,
right after the runtime and `hf-protocol.js`, before a library kit — in library renders (file://) and custom renders
(data: URL, network blocked) alike. Drop the upstream `<script src="https://cdn.jsdelivr.net/npm/gsap@…">` and plugin
tags and any `import … from "gsap"`: the globals are already there. `gsap.registerPlugin(...)` accepts anything.
An unknown name is a render error (`<!-- rc-lib foo -->: unknown library`).

| Name | Gives the page | Version / licence |
|---|---|---|
| `gsap` | `window.gsap` + `CustomEase`, `MotionPathPlugin`, `TextPlugin`, `ScrambleTextPlugin`, `DrawSVGPlugin`, `SplitText`, `EasePack` | gsap-compat 0.1.0 (this folder), MIT, clean-room |
| `three` | `window.THREE` + `THREE.addons.{RoomEnvironment, BufferGeometryUtils, RoundedBoxGeometry, TextGeometry, FontLoader, Font, GLTFLoader, EffectComposer, RenderPass, ShaderPass, OutputPass, BokehPass, UnrealBloomPass, Line2, LineGeometry, LineMaterial, LineSegments2, LineSegmentsGeometry}` | three.js 0.184.0, MIT |
| `three-r147` | `window.THREE` (r147) + `THREE.GLTFLoader`, `EffectComposer`, `Pass`, `FullScreenQuad`, `RenderPass`, `ShaderPass`, `MaskPass`, `ClearMaskPass`, `UnrealBloomPass`, `CopyShader`, `LuminosityHighPassShader` | three.js 0.147.0, MIT |
| `lottie` | `window.lottie` | lottie-web 5.12.2, MIT |
| `anime` | `window.anime` (v4 UMD: `anime.animate`, `anime.createTimeline`, …) | Anime.js 4.5.0, MIT |
`three` and `three-r147` on one page is an error (both set `window.THREE`). ESM blocks (`import * as THREE from "three"`,
`three/addons/…`) need their imports rewritten to the globals (`const { RoomEnvironment } = THREE.addons;`).

## The HyperFrames page protocol (every page, no marker needed) — `hf-protocol.js`
| Page does | Runtime does each frame |
|---|---|
| `window.__timelines[id] = tl` (paused GSAP timeline) | `tl.pause()`; first time `tl.progress(0.0001, true)` (prime); then `tl.totalTime(t − data-start of [data-composition-id=id], false)` — HyperFrames' own order |
| `gsap.to/from/set/delayedCall` outside a timeline | our global timeline is seeked to `t` too (deterministic; real GSAP would play these on a clock) |
| `window.addEventListener("hf-seek", e => draw(e.detail.time))` | dispatches `hf-seek` with `{time, waitUntil(promise)}`; a waited promise is awaited before the capture |
| `window.__hfLottie.push(anim)` (lottie, `autoplay:false`) | `anim.goToAndStop(t × fps mod totalFrames if loop, else clamped, true)` |
| `window.__hfAnime.push(a)` (Anime.js, `autoplay:false`) | `a.pause()` once, `a.seek(t × 1000)` |
| `window.__hf.buildReady[key] = promise` | awaited before frame 0 |
| `window.__hyperframes.getVariables()` | declared defaults (`data-composition-variables`) overlaid with the resolved params; writable (fx-sync's kit replaces it) |
**Who drives it:** the runtime calls `RC.hf.seek(time.t)` only when the page registered **no** `RC.composition`. A page
with `RC.composition` (e.g. fx-sync's `hf-compat` kit) drives its own timelines, or calls `RC.hf.seek(time.t)` from
`render()` and returns the result. The custom-composition validator accepts `window.__timelines[`, `"hf-seek"`,
`__hfLottie`, `__hfAnime` as a page protocol. Nested compositions (`data-composition-src`) are NOT mounted: flatten them.
Clip visibility windows (`data-start`/`data-duration`) are NOT applied here (fx-sync's kit owns them).

## Supported GSAP API (survey counts: blocks units/occurrences, from `docs/restorff/worklog/anim-runtime.md`)
| Area | Supported |
|---|---|
| Tweens | `gsap.to/from/fromTo/set`, `tl.to/from/fromTo/set` (legacy `to(t, dur, vars)` too), returns: `gsap.*` → Tween, `tl.*` → the timeline (chaining) |
| Timeline | `gsap.timeline({paused, defaults, repeat, yoyo, repeatDelay, delay, onStart/onUpdate/onComplete/onRepeat/onReverseComplete, data, id})`; `add` (tween, timeline, label, function, array), `addLabel`, `removeLabel`, `call(fn, params, pos)`, `addPause(pos, fn)`, `getChildren`, `getTweensOf`, `clear`, `remove`, `kill`, `invalidate`, `shiftChildren`, `labels`, `currentLabel/nextLabel/previousLabel`, `recent`, `tweenTo/tweenFromTo`, `getById` |
| Time | `duration`, `totalDuration`, `time`, `totalTime`, `progress`, `totalProgress`, `seek(number or "label±=n")`, `startTime`, `endTime`, `delay`, `timeScale`, `repeat`, `repeatDelay`, `yoyo`, `iteration`, `pause/play/resume/paused/reverse/reversed/restart/isActive`, `eventCallback(type[, fn, params])`, `then` |
| Position parameter | number, omitted (= end of timeline), `"+=n"`/`"-=n"` (from the end), `"<"`, `">"`, `"<n"`, `">-n"`, `"<+=n"`, `"label"`, `"label+=n"`, unknown label (created at the end), `"-=25%"` (of the inserted child), `"<50%"`/`">25%"` (of the recent child) — all 19 observed cases equal |
| Callbacks | onStart, onUpdate, onComplete, onRepeat, onReverseComplete (+Params, callbackScope); order as GSAP (tween s→u→r→c; timeline TS → children → TU → TC); `seek()` suppresses all (default), `totalTime/time/progress` fire; `call()` fires crossing either way |
| CSS | any CSS property (inline value read first, then computed), px default unit, unit conversion (%, vw, vh, em, rem), **autoRound** (px values rounded to integers, as GSAP; `autoRound:false` off), colours (rgb/hex/hsl/named; hsl ends interpolate in HSL), complex strings (`filter`, `clipPath`, `boxShadow`, gradients; `none` → zeros), discrete values (end at p>0; `display:"none"` at the end), CSS variables `"--x"`, `autoAlpha`, `zIndex` (rounded) |
| Transforms | x, y (px or any unit, kept), z, xPercent, yPercent, rotation/rotate/rotationZ, rotationX/Y, skewX/Y, scale, scaleX/Y (`scale` wins), transformPerspective, transformOrigin (keywords → %), svgOrigin; same string order as GSAP; existing CSS transforms parsed (a translate of exactly −50 % of the box becomes xPercent/yPercent −50, as GSAP); CSS `translate/rotate/scale` properties folded in and reset to `none`; **2D `translate()` while tweening** (GSAP uses `translate3d` mid-tween; we never do: LEARNINGS §2) |
| SVG | transforms written as the `transform` attribute `matrix(…)` with GSAP's bbox-relative origin; `attr: {}` (numbers, colours, path `d`, points); CSS props on SVG (`strokeDashoffset`, `fill`, …) |
| Objects | plain objects/arrays/Three.js objects: numbers (6-decimal rounding, as GSAP), numeric strings → numbers, unit strings, colour strings, getter/setter functions; DOM properties (`textContent`, `innerText` with `snap`) |
| Values | relative `+=`/`-=`/`*=`, function-based `(i, target, targets)`, `"random(a, b, step)"` / `"random([…])"` (seeded), `startAt`, `snap`, `roundProps`, `modifiers` |
| Keyframes | array of vars (durations default to duration ÷ n or 0.5; ease "none"), percent object (`"50%": {…}`, `easeEach`, default power1.inOut, outer `ease` warps time), `{x: [0, 100, 50]}` arrays |
| Stagger | number (negative = from the end), `{each, amount, from: "start"/"center"/"end"/"edges"/"random"/index/[x, y], grid: [rows, cols]/"auto", axis, ease, repeat, yoyo, per-element callbacks}`, function — all 12 non-random observed cases equal |
| Eases | none/linear, power0–4, quad/cubic/quart/quint/strong, sine, expo, circ, back(s), elastic(a, p), bounce, steps(n) — each `.in/.out/.inOut`, bare name = `.out`, legacy `Power2.easeOut`, functions, `gsap.parseEase`, `registerEase`, `CustomEase.create` |
| Overwrite | `true` kills earlier tweens of the same targets (as GSAP); `"auto"` = forward-order rendering lets the later tween win |
| gsap.* | `getProperty` (+unit, getter form), `quickSetter`, `quickTo` (immediate), `parseEase`, `registerEase`, `registerPlugin`, `registerEffect`/`effects`, `defaults`, `config`, `getTweensOf`, `killTweensOf`, `isTweening`, `getById`, `delayedCall`, `exportRoot`, `globalTimeline`, `context` (minimal), `matchMedia` (minimal), `ticker` (stub: never ticks), `version` ("3.14.2"), `compat` |
| gsap.utils | toArray, selector, clamp, mapRange, normalize, interpolate (numbers, colours, strings, objects, arrays, series), wrap, wrapYoyo, snap (number/array/{values, radius}), random (seeded; arrays; returnFunction), shuffle (seeded), distribute, getUnit, unitize, pipe, splitColor, checkPrefix |
| Plugins | **CustomEase** (used by 3 units), **MotionPathPlugin** (1: `path` selector/element/data/points, `align`, `alignOrigin`, `autoRotate`, `start/end`, `offsetX/Y`), then (0 uses in the clone, written for code Claude writes): TextPlugin, ScrambleTextPlugin (seeded, frame-deterministic), DrawSVGPlugin, SplitText (chars/words/lines) |
| Not supported | MorphSVG, Flip, Physics2D/PhysicsProps, Inertia, ScrollTrigger/ScrollSmoother/Observer/Draggable (no scrolling or input in a render), CustomWiggle/CustomBounce, `yoyoEase`, `repeatRefresh`, `lazy` |

**Seeded randomness:** `utils.random`, `utils.shuffle`, stagger `from:"random"`, `"random(…)"` use mulberry32 seeded
from the params' `seed` (number), else a hash of the first `[data-composition-id]`. The same composition gives the
same sequence every render (real GSAP's are unseeded, so these never match it frame for frame).

## Differences from real GSAP (observed; kept on purpose or not worth the cost)
1. **Seek order independence.** Children render in start order every seek, later starts win. Real GSAP renders
   backwards seeks in reverse order, so two tweens animating the **same property at the same time** can differ after a
   backwards seek (probe `overlap-order`: 1.5 s after seeking back from 3 s → GSAP 75, us 87.5, both 87.5 going forward).
   A tween's start value is the earlier tween's value at its exact start time (GSAP: at the first rendered frame), and
   `overwrite: "auto"` cuts the earlier tween off from the later one's start on (GSAP kills it for good).
2. `translate()` instead of `translate3d()` mid-tween (determinism, LEARNINGS §2): sub-pixel raster differences, and
   blur/glow filters inside such an element rasterise slightly differently (lt-neon-border).
3. `expo` eases: fitted to 201 black-box samples (GSAP's curve is not 2^(10(p−1))); max error 0.0003 of the travel.
4. `CustomEase`: exact Bézier solve; GSAP's values differ by ≤ 0.0003.
5. Sparse percent keyframes (a property in only some keys) interpolate differently; full keys are equal.
6. Last-digit rounding in a few matrices/rotations (`10.0001deg` vs `10deg`, `-0.1953` vs `-0.19530000000000314`);
   DrawSVG's dash offset `0` vs `0.001`; MotionPath positions within 1 px; inline-style property order in `cssText`.
7. from()/fromTo() write their start state at once; GSAP writes it on its next tick ("lazy"). Equal by the first seek.
8. Random values (stagger `from:"random"`, `utils.random`, `"random(…)"`, ScrambleText) are seeded here, unseeded in
   GSAP: never equal frame for frame, by design.

## Block-level oracle (real GSAP 3.14.2 vs ours, 2026-10-24 run5 on the final code)
How: `oracle/blocks.ts` renders each block through our runtime + `hf-protocol.js` twice (real GSAP / ours), seeking
every frame at 30 fps like the renderer, and compares 6 frames per block (½ scale). **match** = PSNR ≥ 40 dB and
< 0.1 % pixels off by > 24/255 on every frame; **close** = ≥ 26 dB and < 3 %. Blocks: the 114 GSAP blocks with no
Three.js / WebGL / WebGPU / d3 / Lottie / nested composition / Math.random / clock / timer (`oracle/eligible-blocks.txt`).
| Result | Count | Blocks |
|---|---|---|
| match | 95 | everything not listed below (incl. the 25 carousel-* blocks, whose images are missing from the clone in both runs) |
| close | 13 | app-showcase, camera-dolly-zoom, hw-path-text, logo-outro, lt-color-block, lt-kicker-name, mk-clone-wall-transition, mk-placeholder-grid, news-ticker, slack-notification-ad, us-map-hex, vpn-youtube-spot, yt-prism-title |
| broken by the metric | 2 | claude-exchange (one frame mid-scroll: text 1 px apart, SEEN otherwise identical), lt-neon-border (blur glow slightly weaker, SEEN) — both from GSAP's mid-tween `translate3d` (Differences 2) |
| not comparable | 4 | code-snippet-dark-2026, code-snippet-dark-modern, thread-message-stack (content inside `<template>`: build nothing standalone, either library), ui-3d-reveal (throws with REAL GSAP: `Cannot read properties of null (reading 'appendChild')`; ours builds) |
"close" pairs looked at (SEEN): mk-placeholder-grid, lt-neon-border, notification-cascade (now match), claude-exchange,
slack-notification-ad (now close): same picture, differences in anti-aliasing of shadows, gradients and text edges.
Fixed because of this oracle (each a real bug): a child entered at exactly its start must render (transitions-push);
CSS centring rule (reddit-post, x-post, code-scroll, instagram-follow, tiktok-follow); SVG CSS transform-origin
(logo-outro); expo curve (notification-cascade, slack-notification-ad); scale vs scaleX/Y; overwrite "auto";
immediateRender on `to()`; DrawSVG `fromTo`. Run history: run1 63 match / 14 close / 37 broken (25 were the harness
failing on missing images, 4 not comparable) → run5 95 / 13 / 6.
