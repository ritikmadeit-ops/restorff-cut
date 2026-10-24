---
id: composition-authoring
title: Writing a composition
summary: When to write code instead of using the library, the contract (one HTML file, a params block, build once, render from time), time and fit, params that make a piece editable and replicable, layout on the 1080 grid, the sandbox rules, declarations, the timeline kit, and the look-fix loop for a composition.
read_when: Before writing or changing a custom composition (composition write / update with source).
aliases: composition, compositions, custom, custom-composition, authoring, code, motion-graphics, html, contract, rc
tools: composition, look, render, effects
related: composition-example, animation-runtimes, motion, typography-layout, transitions, qa-loop
next: composition contract | Read the live contract (API, limits, cue kinds, one full example), then write.
source: skills/hyperframes/SKILL.md (contract, keep it editable); references/{format,runtimes,motion}.md; skills/hyperframes-registry/references/{component-quality-bar,contributing,placeholder-material}.md; docs/concepts/{determinism,variables}.mdx; docs/reference/lint-rules.mdx; docs/prompting/{rules-and-anti-patterns,variables-and-templating,specification-dial}.mdx; docs/guides/{claude-design-send-to-hyperframes,performance,troubleshooting}.md
---
# Writing a composition

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/{SKILL.md,references/format.md,references/runtimes.md}, skills/hyperframes-registry/references/{component-quality-bar,contributing}.md, docs/concepts/{determinism,variables}.mdx, docs/reference/lint-rules.mdx, docs/prompting/{rules-and-anti-patterns,variables-and-templating}.mdx @fa5dbd1; modified for RestorffCut's composition contract (packages/compositions/CONTRACT.md).

## Library first, code second
`effects list` and `composition write {library: "<name>", props}` cover the named pieces (kinetic type, charts,
counters, checklists, stamps, phone mock-ups, the neon-grid kit …). Write code when nothing fits, or when the piece
must carry this brand's own idea. A library piece forked as code (`composition get` → `update {source}`) becomes
custom and keeps rendering the same.

## The contract in ten lines
`composition contract` is the live truth (API, limits, cue kinds, one full example). In short:
1. **One self-contained HTML file**, at most 256 KB, whose picture is a **pure function of time**. It renders frame
   by frame in headless Chromium with the **network blocked** to a transparent WebM on the MOTION track.
2. Optional params block `<script type="application/json" id="params">{name, title, description, duration, size,
   fit?, params: {…}}</script>`; with it, props are typed, the editor shows fields, sentence edits work.
3. `RC.composition({ build(RC) { … }, render(time, RC) { … } })`. The runtime is injected for you: never load it.
4. `build` runs once, after the bundled fonts load: make the DOM from `RC.params`, **measure and lay out here**.
5. `render` runs every frame, in any order, any number of times: set transforms, opacity, colours from `time` and
   `RC.params` only. Never read layout, never keep state between frames.
6. `time = {T, t, left, p, frame, rate}`: `T` real seconds since the clip starts; `t` = animation time (`T × rate`,
   for choreography); `left` = animation seconds to the last frame (for exits); `p` = T / duration.
7. Helpers: `RC.progress(t, start, dur, ease)`, `RC.tween(t, start, dur, from, to, ease)`, `RC.mix`, `RC.clamp`,
   `RC.set(node, {x, y, scale, sx, sy, rotate, rx, ry, skew, opacity, blur, clip})`, `RC.el(tag, attrs, children)`,
   `RC.fitText`, `RC.random(seed)` (returns a seeded generator), `RC.mixColor`, `RC.alpha`, `RC.since(T, at)`,
   `RC.cue(at)`. Easings: `linear smooth gentle snappy bouncy springy elastic bounce ease-in` (`guide motion`).
8. Values: `RC.width`, `RC.height`, `RC.u` (short side / 1080: multiply every px), `RC.safe {top, bottom, left,
   right}`, `RC.fps`, `RC.duration`, `RC.rate`.
9. Bundled faces only: Archivo, JetBrains Mono, Instrument Serif. Transparent background unless the piece is meant to
   cover the video (then declare `"opaque": true`).
10. Also accepted: a page that sets `window.__hf = {duration, seek(t)}` itself; and a timeline-style animation built
   with the GSAP-compatible runtime (`guide animation-runtimes`).
A complete worked piece with its numbers, rendered and looked at: `guide composition-example`.

## Time, exits and fit
- Choreography on `time.t`, so the `speed` param and fit-to-duration reach it. Anything synced to the voice on
  `time.T`: put the spoken time in a param and use `RC.since(time.T, RC.cue(at))` for the little animation that starts
  there.
- Exits on `time.left`: `RC.progress(0.45 - time.left, 0, 0.3, "ease-in")` finishes exactly on the last frame at any
  length.
- Declare `"fit": <seconds every beat needs>` when the piece must still play every beat in a shorter clip; the clock
  then runs faster (`rate = max(speed, fit / duration)`). Never stretched: a longer clip holds the end.
- Render once at a short length (`duration_s` 1–2): every beat must still happen.

## Params make it editable and replicable
- **Every on-screen word and every story time is a param** with a neutral name (`lines[]`, `keyword`, `beats[{text,
  at}]`, `value`, `label`), never a literal in the code. Time items from the voice's word timings (a `words` [{w, s, e}]
  param, or one `at` per item) so a new script re-times the piece without touching the code.
- Write each param's `description` as what the slot **means** ("the one word the viewer must remember"), mark the
  main word `"required": true`, generic UI words `"display": false`. Defaults are example copy; an applied render
  blanks display params the request did not send.
- Standard names make sentences work everywhere: `speed` (always declare it), `scale`, `ease`, `accent`, `anchor`,
  `offsetY`, `exit`. "Slower", "bigger", "bouncier", "make it red", "no exit" are then `composition update {props}` or
  `revise`, never a code change.
- Types: string, text, number (min, max, step), color, boolean, enum, easing, font, image (`data:` only, ≤ 4 MB, or a
  timeline media id the server inlines), list (of), object (fields). Every top-level param needs a valid default.
- Colour from params (`accent`, plus `ground` / `ink` when the look needs them), so the piece can be re-branded.

## Layout on the 1080 grid
Multiply sizes by `RC.u`; keep text inside `RC.safe`; text at least 36 px on the grid. Fit with `RC.fitText(node, maxW,
maxPx, minPx)` on an inline-block span, or step the font size down in `build` until the widest word fits. Centre with
`text-align` or flex, never `left: 50%; translateX(-50%)` on something you transform. A transformed span needs
`display: inline-block`. `overflow: visible` on text containers. Sizes, safe areas, contrast: `guide
typography-layout`.

## Determinism and the sandbox
Refused (the piece is not rendered): `fetch`, XHR, WebSocket, `import()`, workers, iframes, `<link>`, any `src` /
`href` / `url()` that is not `data:` or `#…`, storage APIs, `Date`, `performance.now`, `Math.random`,
`requestAnimationFrame`, timers, `<video>` / `<audio>`, over 256 KB. Warned: CSS `transition`, `will-change`,
`translate3d` / `translateZ` (they make pixels depend on frame order). So:
- Randomness only from `RC.random(seed)` with the seed a param; scatter derived from the element's index.
- Images as `data:` params or timeline media ids; nothing loads at run time.
- CSS `@keyframes` run on the seeked clock (the runtime pauses and seeks them), but prefer `render`.
- Never tween `left/top/width/height/font-size/letter-spacing` per frame: they snap to whole pixels and stutter;
  animate transforms and opacity.
- Heavy per-frame work slows every render: large `backdrop-filter` and `blur` areas, many shadowed movers, big
  `clip-path` stacks. Pictures at most ~2× their size on screen.

## Declarations (read by sound design and the export gate)
In the params block, or computed in `build`:
- `cues`: sound cues. Fixed: `"cues": [{"t": 0.4, "kind": "stamp", "label": "…"}]` (animation seconds). From params:
  `window.__rcCues = [{t, kind, label}]` in `build`, `t` in real seconds into the clip. `sounds design` puts a sound
  on each (kinds: type, stamp, marker, paper, word, impact, whoosh, riser, tick, check, pop …; list in the contract).
- `scenes`: `[2.1, 4.5]` seconds where a new scene starts inside the piece (the gate counts them as picture changes).
- `text`: the on-screen words with their windows and roles, for the gate's hook, safe-area and length checks.
- `opaque: true` when the piece paints the whole frame.

## The timeline kit
Helpers and styles shared by several compositions of one timeline are written once: `composition {action: "kit",
timeline_id, kit: {js, css?}}` (or `library_kit`); a source includes it with `<!-- rc-kit -->` in `<head>` (`write` /
`update` with `use_kit: true` adds it). Changing the kit re-renders exactly the clips that include it, in one commit.

## Checks that fail most (from other playbooks)
Clients that read only this playbook missed these (Sonnet A/B, 2026-10-24); check each before you render:
- The **last line** is fully on screen at least **2 s**; an end card or lockup holds **1.5–3 s**. In a short piece,
  shorten the middle, not the ending (`pacing-retention`).
- Every line holds **0.5 s + 0.3 s a word** once landed; the hook moves by **1.0 s** and frame 0 is not empty.
- No **full-frame linear gradient on a dark ground** (it bands in H.264): a solid, a radial, or a solid plus a local
  glow (`typography-layout`).
- Text stays inside `RC.safe` at every frame, including during punch-ins and scale-ups.
- One accent per frame; text ≥ 36 px on the grid; a landed title stays still (`motion`).

## Place it, look at it, fix it
1. `composition write {timeline_id, source, props, duration_s, t}` → the clip lands on MOTION (one commit; `t` = where
   it starts, from `plan scenes` or the spoken word).
2. **Look before rendering the whole timeline**: `look {kind: "clip", timeline_id, element_id, times: [the entrance,
   the key moment, the exit]}`; over the clip under it by default (`over: "none"` for alone over black).
3. Fix with `composition update {element_id, props}` (or `source`); several clips in one commit with `element_ids` or
   `updates`. `composition history` / `revert` for earlier versions.
4. Then render a preview of the timeline, `look`, `check` (`guide qa-loop`).
Reject your own piece if its markup lacks the subject its name promises, if frames show the promised event never
happening, or if the same timestamp reached by two seek orders looks different.

## Faults
| Symptom | Cause | Fix |
| --- | --- | --- |
| `REFUSED … loads from outside` | a relative or http `src` | a `data:` image param, or a timeline media id |
| `no page protocol` | no `RC.composition(` and no `window.__hf =` | wrap the drawing in `RC.composition({build, render})` |
| A list param refused at its default | a list with `minItems` and an empty default | give the default one example item |
| Text tiny after `RC.fitText` | it measured a full-width block | fit an inline-block span |
| Jitter or drift between renders | layout read in `render`, or state kept between frames | measure in `build`; compute from `time` only |
| A word stays visible after its exit | its hidden state was never set at the end time | set `visibility: hidden` (or opacity 0) for `time` past its window |
| Dark ink vanishes over footage | a word coloured for its box before the box arrives | switch the colour only once the box is under it |
| Empty frame at an internal seam | the next line starts from opacity 0 | let it ignite at ~15 % (`composition-example`) |
