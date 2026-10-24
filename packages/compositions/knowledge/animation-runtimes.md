---
id: animation-runtimes
title: Animation runtimes (timeline API, 3D, vector animation, generative)
summary: Which runtime to use inside a composition, how to include the GSAP-compatible timeline runtime, Three.js, lottie and Anime.js offline, the seek rules every one of them must follow, timeline-API habits that break seeking, and 3D and vector-animation craft.
read_when: Before writing a composition with many overlapping tweens, real 3D, a vector-animation file, or generative drawing; and before porting animation code from elsewhere.
aliases: runtimes, gsap, timeline-api, three, threejs, 3d, lottie, anime, animejs, canvas, webgl, generative, libraries, rc-lib
tools: composition, look
related: composition-authoring, composition-example, motion, video-types
next: composition contract | Check which libraries the live contract lists before including one.
source: skills/hyperframes/references/{runtimes,format,motion}.md; references/types/{3d,character}.md; skills/remotion-to-hyperframes/references/{lottie,timing,sequencing,transitions}.md; skills/hyperframes-registry/references/{templates,contributing}.md; docs/guides/{gsap-animation,frame-sources,vfx-chain}.mdx; docs/concepts/{determinism,frame-adapters}.mdx; docs/reference/lint-rules.mdx; docs/prompting/runtimes-and-3d.mdx; skills/hyperframes-cli/references/conventions.md
---
# Animation runtimes

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/references/{runtimes,format,types/3d,types/character}.md, skills/remotion-to-hyperframes/references/{lottie,timing}.md, docs/guides/{gsap-animation,frame-sources}.mdx, docs/concepts/{determinism,frame-adapters}.mdx, docs/reference/lint-rules.mdx, docs/prompting/runtimes-and-3d.mdx @fa5dbd1; modified for RestorffCut.

## Pick the runtime
| The piece | Use |
| --- | --- |
| Titles, cards, kinetic type, most overlays | `RC.progress` / `RC.tween` in `render(time)` (no library; works today) |
| Many overlapping tweens, staggers, labels; porting timeline-style code | the GSAP-compatible runtime (`<!-- rc-lib gsap -->`) |
| Real depth, light, a camera move through an object | Three.js (`<!-- rc-lib three -->`); CSS perspective reads flat |
| A vector-animation export (a character, an icon animation) | lottie-web (`<!-- rc-lib lottie -->`) |
| Existing anime code | Anime.js (`<!-- rc-lib anime -->`) |
| Particles, noise fields, hand-drawn boil | canvas 2D in `render(time)`, seeded |
**Status (2026-10-24 14:05, MEASURED):** `<!-- rc-lib gsap -->` works in a custom render: the timeline form below
validated, rendered with the network blocked (no request attempted) and the frames showed the tween at the right times.
It rendered at 4.6 s per second of output against 0.7 s for an RC-helper piece of the same kind (540×960), so prefer
`RC` helpers for simple pieces. `three`, `lottie` and `anime` are bundled but were not tried by this playbook's
author: an unknown name is refused with the list of available ones, and `composition contract` is the live truth.
All libraries are bundled with RestorffCut (MIT; our own GSAP-compatible runtime, GSAP itself is not shipped);
nothing is fetched, so never add a CDN `<script src>`: it is refused.

## How a library gets in
Put a marker comment in `<head>`: `<!-- rc-lib gsap -->` (several: `<!-- rc-lib gsap three -->`). The renderer
injects the library before any page script, in custom renders with the network blocked as in library renders. Then
`window.gsap` (with `CustomEase` and `MotionPathPlugin`), `window.THREE`, `window.lottie`, `window.anime` exist.

## The seek rules (every runtime)
Each frame is rendered on its own, in any order. So:
- **Draw from time alone.** The frame at `t` is identical whether reached from `t − 1/fps`, from the end, or twice.
  Never a `requestAnimationFrame` loop, a timer, `Date`, or state carried from the previous frame.
- **Simulate once, look up per frame**: physics, flocks and particles are computed in `build` into arrays (seeded),
  and `render` reads the state at `t`. A frame-to-frame accumulator with no closed form cannot be seeked.
- **Seed every random choice** (`RC.random(seed)`, or a hash of the element's index); `Math.random` is refused.
- **Measure layout once** in `build`, never inside an update callback.
- Library transitions and auto-play off: charts and maps are driven from your clock, not their own transitions.

## Timeline-style API (GSAP-compatible)
Inside `RC.composition`, build one **paused** timeline in `build` and seek it from `render`, so `speed` and fit reach
it:
```js
var tl;
RC.composition({
  build: function (RC) { /* make the DOM */ tl = gsap.timeline({ paused: true });
    tl.fromTo("#title", { opacity: 0, filter: "blur(8px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.18, ease: "power4.out" }, 0.4);
    tl.progress(0.0001, true); // render once, so frame-0 sets apply
  },
  render: function (time) { tl.totalTime(time.t, false); }, // false = callbacks fire
});
```
Not `tl.seek(time.t)`: `seek()` suppresses every event by default (real GSAP too, measured), so `onUpdate` drawing,
`onStart`/`onComplete` and `tl.call()` never fire. And a paused timeline that never rendered ignores a seek to 0, so a
`tl.set(…, 0)` is missing on frame 0. Test: `packages/compositions/test/gsap-compat.test.ts` "callbacks".
(Imported library pieces instead register `window.__timelines["<id>"] = tl` and the runtime seeks them; do one or the
other, not both, in your own code.) Habits that keep it seekable:
- **Absolute positions** in seconds (`tl.to(el, {...}, 2.4)`); resolve simultaneity in the plan.
- `fromTo` rather than `from` (a `from` records its start state once and drifts on seek-back); with several `fromTo`
  on one target, `immediateRender: false` on all but the earliest. Never CSS `opacity: 0` plus `from({opacity: 0})`.
- A `fromTo` revealing a hidden element puts `opacity: 1` (or `autoAlpha: 1`) in its destination. Set hidden start
  states in CSS or in `build` with `gsap.set`, not `tl.set(…, 0)`.
- Finite repeats only: `repeat: Math.max(0, Math.floor(total / cycle) - 1)`; never `repeat: -1`; keep every tween's
  whole span (repeats, yoyo, stagger) inside the clip.
- Transforms and opacity only; never tween `left/top/width/height/font-size` (they snap to pixels) and never set a CSS
  `transform` on an element the timeline transforms; centre with `xPercent: -50` in the tween, not
  `translate(-50%)` in CSS. Two timelines never animate the same property of one element.
- No `stagger: {from: "random"}` (use `start`, `center`, `end`); no relative `"+="` values mixed with another writer.
- Counters: tween a plain object and write the text in `onUpdate`; it never overshoots.
- A hit on a beat is an instant `tl.set`, not an eased tween.
Eases the source uses most: `power2.out`, `power3.out`, `power4.out`, `expo.out`, `power2.in`, `power3.in`,
`power2.inOut`, `sine.inOut`, `back.out(1.4–1.7)`, `elastic.out(1, 0.5)`, `steps(n)`, `none`; mapping to the RC
presets in `guide motion`. Spring → ease: damping 12 / stiffness 100 ≈ `back.out(1.4)` 0.7 s.

## Three.js
- Draw every frame from time: in `render(time)`, set the camera and object state from `time.t`, then call
  `renderer.render(scene, camera)`. A timeline can tween a plain state object that the draw reads.
- Renderer: `preserveDrawingBuffer: true` (UNVERIFIED for our capture; check the first render), pixel ratio 1, sized
  to `RC.width × RC.height`, ACES filmic tone mapping at exposure ~1.1, colour textures tagged sRGB; create it inside
  `try/catch` and fall back to a flat picture if WebGL is missing.
- Light: warm key, cool rim, a dark environment with two or three soft strips; turn the environment, not the object.
  Roughness ≥ ~0.45 and environment intensity ~0.5 on glossy metal (white streaks otherwise). Bloom only on the
  brightest points.
- One NaN pixel blacks a frame through bloom: clamp anything that can divide by zero (and clamp a cosine to [0, 1]
  before `pow(1 - cos, n)`).
- One hero object; fly into it rather than orbit it; product UI is never tilted into 3D. Heavy setup (big meshes,
  shader compiles) happens in `build` (it may be async: `build` can return a promise).
- Look at the dive and the payoff; a frame that takes long to draw slows every render, so profile the heaviest moment.

## Vector animation (lottie)
- The animation data goes **inline** (a `<script type="application/json">` block or a param), never a URL.
- `autoplay: false`, `loop` set explicitly; seek with `anim.goToAndStop(time.t * 1000, false)` (milliseconds) in
  `render`. A loop wraps at the animation's own length; there is no rate scaling: change `time.t` instead.
- Not supported by the web player: expressions, most effects, luma mattes, exotic blend modes. Seek the file as it is;
  never redraw it. A character's actions are timing anchors for the rest of the piece.

## Anime.js and canvas
Anime.js: `autoplay: false`, seek the instance from `render(time)` (`anim.seek(time.t * 1000)`), seeded random via
its own seeded generator or `RC.random`. Canvas 2D: clear and redraw from `time` every frame; a hand-drawn boil
redraws the outlines about 12 times a second with a jitter seeded by `Math.floor(time.T * 12)`, so the line lives while
the character holds still and every render matches.

## Porting animation code from elsewhere
Frames → seconds once, at authoring (`seconds = frame / fps`). Interpolations become tweens with absolute positions;
sequences become windows that show over `[start, start + duration)` (land the end state just before the end); a
crossfade between two pieces overlaps their windows by the transition's length (~0.5 s). Spring presets map as above;
cubic-out = `power3.out`; poly(N) = `powerN`. Fonts: only the bundled three; a missing face silently falls back and
shifts every line.
