# CONTRACT — how a RestorffCut composition is written (v1, 2026-10-20)

A **composition** is one HTML file that draws a motion graphic as a pure function of time. Claude writes it, edits it
by changing its **params** (not its code), and the renderer turns it into an **alpha video** for the editor's overlay
track. Types for everything below: `src/types.ts`. Working examples: `compositions/*/`.

## 1. File layout
```
compositions/<name>/<name>.html          the composition (name = kebab-case, unique)
compositions/<name>/<name>.props.json    example props (fictional content only: Halcyon Cold Brew)
compositions/<name>/assets/…             images it needs by default (fictional, with their source if generated)
```
A composition can live anywhere (a project folder); the library folder is only where the starters live.

Skeleton (copy from `compositions/big-word-punch/big-word-punch.html`):
```html
<!doctype html><html><head><meta charset="utf-8">
<script src="../../src/runtime.js"></script>          <!-- optional: lets the file preview on its own in a browser -->
<script type="application/json" id="params"> { …manifest, §2… } </script>
<style> #stage { position: absolute; inset: 0; } … </style>
</head><body><div id="stage"></div>
<script>
  RC.composition({
    build: function (RC) { /* once: make DOM from RC.params, measure, position */ },
    render: function (time, RC) { /* every frame: set styles from `time` only */ },
  });
</script></body></html>
```
The renderer always injects the runtime itself (before any page script), so the `<script src>` line is only for
standalone preview. Body and page background are forced transparent: never paint a full-frame background unless the
design is meant to cover the video.

## 2. The params block (the manifest)
`<script type="application/json" id="params">` holds:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | kebab-case id |
| `title` | yes | human name |
| `description` | yes | 1–2 sentences: what it shows and **when to use it** (Claude reads this to pick one) |
| `duration` | yes | default seconds (CLI `--duration` overrides) |
| `size` | yes | default `[width, height]`, even integers (CLI `--size` overrides) |
| `fps` | no | default 30 |
| `fit` | no | fit-to-duration (§3b): seconds every beat needs at speed 1 (default `duration`), or `false` |
| `tags` | no | words for search |
| `params` | yes | `{ key: spec }`, camelCase keys |

Param spec: `{ "type", "default", "label", "description", … }`. Write `description` as **what the slot means**
("the one word the viewer must remember"), not where it sits. Every top-level param needs a valid `default`.
Optional on top-level specs (§2c): `display` (true/false), `required` (true), `requiredUnless` (another param's key).

| type | value | extra fields |
|---|---|---|
| `string`, `text` | string | `maxLength` |
| `number` | number | `min`, `max`, `step`, `unit` (display only) |
| `color` | `#RGB`, `#RRGGBB` or `#RRGGBBAA` | |
| `boolean` | true / false | |
| `enum` | one of `options` | `options` (required) |
| `easing` | one of the presets in §3 | |
| `font` | `Archivo` · `JetBrains Mono` · `Instrument Serif` | |
| `image` | path (relative to the props file, else to the composition), absolute path, `data:` or `http(s):` URL | |
| `list` | array | `of` (item spec, required), `minItems`, `maxItems` |
| `object` | object | `fields` (`{ key: spec }`; a field without `default` is required) |

Validation (`bun packages/compositions/src/cli.ts check <file> [--props f]`) rejects: unknown keys (typos never
silently do nothing), wrong types, out-of-range numbers, non-hex colours, unknown enum/easing/font values, list
length violations, missing object fields. Keys starting with `$` in a props file (`$comment`) are ignored.

### Standard params — use these exact names so sentence edits work everywhere
| Name | Spec | Sentence |
|---|---|---|
| `speed` | number 0.25–4, default 1 — **every composition declares it** (`test/library-v2.test.ts` checks) | slower / faster |
| `scale` | number 0.5–2, default 1 | bigger / smaller |
| `ease` | easing | bouncier / calmer / snappier |
| `accent` | color, default `#F6FF00` | "make it red", "accent #00FF88" |
| `anchor` | enum `top` · `center` · `bottom` | move up / down (when there is no `offsetY`) |
| `offsetY` | number px on the 1080 grid, negative = up | move up / down (±4 % of the height per step) |
| `exit` | boolean, default true | "no exit", "stay on screen" |

`speed` is on every composition; declare the others where they make sense. In a piece timed to the voice, `speed`
reaches only the animation each cue starts (a pop, a draw: `RC.since`), never the cue times themselves (§3).

### 2c. Display text: the example copy never reaches an applied render (library-v2, gap 17)
A param is **display** when it puts words (or data) on screen: every `string`/`text` param and every list/object
holding one, unless its spec says `"display": false` (generic UI words: "Approve", "BEFORE"); `"display": true` marks a
non-text one (a number the viewer reads: `counter.to`; an example picture: `ui-card-pop.image`). Its `default` and
the props file's value are **example copy** (fictional Halcyon): only the gallery sample and the CLI use them.
An **applied** render (the editor service `render`, i.e. the editor's drop and MCP `effects apply`):
| The request… | Result |
|---|---|
| omits an optional display param | it renders blank: `""` / `[]` (the answer lists it in `blanked`) |
| omits (or blanks) a required one: `"required": true`, a list with `minItems > 0`, or a display image/number | nothing renders; `NeedsError`: `{ok:false, error:"<name> needs: headlines. … - headlines (list of {source, headline, date?, kind?}, at least 1): <description>", details:{needs:[…], params:{…}}}` |
| sends the param | its value is used |
`"requiredUnless": "images"` (float-thumbs `cards`) = required only while that other param is blank. The catalogue
(`api catalogue`) shows the apply view: `example` = the props file **without** display params (what `effects apply`
merges under the caller's params), `sample` = the full gallery props, `display` / `required` key lists, and `params`
with display defaults blanked and no copy in them (a model reading `effects describe` must not see invented
headlines to copy). Mark the main word of a new composition `"required": true`.

## 3. Time
`render(time, RC)` receives, in seconds:

| Field | Meaning |
|---|---|
| `T` | real time since the overlay starts, 0 … duration. Use it for anything synced to audio (captions) and for ambient real-time motion (a running clock, matte frames, a 12 fps boil). |
| `t` | animation time = `T × rate`. Use it for the choreography: entrances, typing, ticks, draws. |
| `left` | animation time remaining until the **last frame** = `(duration − 1/fps − T) × rate`, never negative. Use it for exits so they finish exactly on the last frame. |
| `p` | `T / duration` |
| `frame` | frame index |
| `rate` | animation seconds per real second = `max(speed, fit / duration)` (§3b); `RC.rate` too |

The renderer seeks frame `i` to `T = i / fps` (integers, never a clock). Frames: `round(duration × fps)`.
`seek()` can be called in any order and repeatedly: `render` must depend on `time` and `RC.params` only.

Easing presets (`RC.EASE`, `RC.progress(t, start, dur, ease)`): `linear`, `smooth` (in-out cubic), `gentle`
(out-sine), `snappy` (out-expo), `bouncy` (out-back, one overshoot), `springy` (damped spring), `elastic`,
`bounce` (ball drop), `ease-in` (for exits).

Helpers on `RC`: `progress`, `tween(t, start, dur, from, to, ease)`, `mix`, `clamp`, `ease(name, x)`,
`random(seed)` (seeded PRNG: the only randomness allowed), `alpha(hex, a)`, `mixColor`, `el(tag, attrs, children)`,
`set(node, { x, y, z, scale, sx, sy, rotate, rx, ry, skew, opacity, blur, clip })`, `fitText(node, maxW, maxPx,
minPx)`, `since(T, at)` (animation seconds since a voice cue = `(T − at) × rate`), `cue(at)` / `cues([…])` (the
real time of a cue param: a cue that falls after the last frame of a fitted render was timed for the natural length
and is fitted with the clock, `at / fit`; cues inside the window stay on the voice). Values: `RC.params`, `RC.width`,
`RC.height`, `RC.u`, `RC.safe`, `RC.fps`, `RC.duration`, `RC.rate`, `RC.fit` (= rate / speed, 1 = not fitted).

### 3b. Fit-to-duration (library-v2, gap 17)
A render asked for a `duration` shorter than the composition's natural length (`fit`, default `duration`) runs the
animation clock faster so **every beat still happens**: `rate = max(speed, fit / duration)`. UI World (natural 4 s)
in a 0.92 s window runs at 4.35×: clips land, the tag pops, the command types (it never typed before, effects-library
recreation). Only compressed, never stretched: a longer duration holds the end as before. `fit: false` in the
manifest (word-pop, paper-texture, toc-list: everything is timed to the voice or ambient) or `fit: false` in the
request / `--no-fit` on the CLI turns it off. The fit used is in the hash, the sidecar and every answer (`fit`,
`rate`). What to put on which clock: choreography on `t` (and `left` for exits); cue params timed to the voice on
`T` via `RC.cue` + `RC.since`; plate-key-matched motion (UI World's panel, Frame Break's shrink) and ambient motion on
`T`. Set `fit` lower than `duration` when the end of a piece is a hold (beats done by `fit` seconds).

## 4. Editing by sentence
Change **params**, never the HTML, when the request is about speed, size, colour, motion character, position or
content. `bun packages/compositions/src/cli.ts nudge <file> "<sentence>" --props <props.json> --write` applies the
common nudges with fixed step sizes, clamped to each param's range (`src/edits.ts`):

| Sentence contains | Change |
|---|---|
| slower / much slower | `speed` × 0.8 / × 0.6 |
| faster / much faster | `speed` × 1.25 / × 1.6 |
| bigger / much bigger | `scale` × 1.15 / × 1.35 |
| smaller / much smaller | `scale` × 0.87 / × 0.7 |
| bouncier | `ease` one step up `smooth → snappy → bouncy → springy → elastic` (at least `bouncy`) |
| calmer / smoother / less bouncy / subtler | `ease` = `smooth` |
| snappier / punchier | `ease` = `snappy` |
| move up / move down | `offsetY` ∓ 4 % of the height, else `anchor` one step |
| colour/accent/make it/in/to + a colour name, or a `#hex` | `accent` |
| no exit / stay on screen | `exit` = false |

It reports rules that matched but have no param (`skipped`) and throws when nothing matched — then edit the values
directly (`params <file>` lists them with meanings). Change the HTML only when the structure must change.

## 5. Determinism rules (`check` lints these; the renderer depends on them)
1. No clocks: no `Date`, `performance.now()`, `requestAnimationFrame`, `setTimeout`/`setInterval`.
2. No `Math.random()`: use `RC.random(seed)` and expose the seed as a param.
3. No network during render: data comes in params; images load before frame 0 (the runtime decodes every `<img>`).
4. No CSS `transition` (it runs on real time). CSS `@keyframes` animations are allowed: the runtime pauses them and
   sets `currentTime = t` on every seek, so they behave as if they all started at t = 0.
5. **No `will-change`, no `translate3d`/`translateZ`**: both promote compositor layers whose raster Chrome updates on
   its own schedule, so pixels depended on frame order and timing (MEASURED; LEARNINGS.md §2). `RC.set` writes 2D
   transforms unless you pass `z`. Real 3D (`rx`/`ry` with `perspective`, as in ui-card-pop) tested deterministic.
6. Do layout in `build` (after fonts load), not in `render`; `render` only sets transforms, opacity, colours, sizes.
7. Fonts: only the bundled families (§2 `font`); they are loaded from bytes before frame 0.
8. `<video>`/`<audio>` inside a composition are not supported yet.

Same input + same worker count → bit-identical frames (tested). A different worker count may change a few pixels by
at most 1/255 (raster history; LEARNINGS.md §2).

## 6. Size, units, safe areas
- Draw on a **1080 grid**: multiply px sizes by `RC.u = min(width, height) / 1080` (CSS: `calc(Npx * var(--u))`), so
  1080×1920, 1920×1080 and 1080×1080 all work.
- Safe areas (`RC.safe`, CSS `--safe-top/-bottom/-left/-right`), ASSUMPTION from common 9:16 feed layouts:
  portrait (h/w > 1.5) top 11 %, bottom 21 %, left 6 %, right 12 % (1080×1920 → 211 / 403 / 65 / 130 px);
  otherwise 5 % of the short side on every edge. Keep text inside them; decoration (frames, glows) may cross.
- Width and height must be even (yuva420p).

## 7. Brand defaults (Restorff screen palette)
`--screen #0C0C0E`, `--screen-2 #16161A`, `--screen-3 #222228`, `--bone #EDEBE6`, `--fog #8C8C95`,
**`--neon #F6FF00` = the one isolate per frame**, `--stale #E8A33D` (status only), `--kiln #C8553D` (Claude's
presence). Type: Archivo expanded 800–900 uppercase tracked .14em for labels and display (`font-stretch: 125%`),
JetBrains Mono for pills, numbers and credits, Instrument Serif for editorial moments. Over video, every text needs a
shadow, stroke or dark card for legibility. Never "Amazing!". Fictional content only (Halcyon Cold Brew).

## 8. Output
| `--out` | Format | Use |
|---|---|---|
| `x.webm` | VP9, `yuva420p`, `alpha_mode=1`, keyframe every second, CRF 31 | default; what the editor's overlay track plays |
| `x.mov` | ProRes 4444, `yuva444p10le` | exact alpha, hand-off to other editors (~10 MB per second at 1080×1920) |
| `dir/` | PNG frames `frame_00000.png` … | debugging, other pipelines |

Every render writes a JSON **sidecar** (`x.webm.json`): composition, params used, size, fps, frames, timings,
`inputHash` (cache key: same hash → same output), `framesHash`, Chromium version, lint warnings.

## 9. HyperFrames compatibility
The runtime exposes `window.__hf = { duration, seek(t) }`, the page protocol HyperFrames' engine renders
(Apache-2.0, `github.com/heygen-com/hyperframes`). Our compositions should therefore render there too
(UNVERIFIED until tried). Our param types mirror its `data-composition-variables` types.

## 9b. Custom compositions (written in the product, not in this folder)
The same contract, written on the spot by Claude (MCP `composition`) or a person (the editor's Code view), stored
in the clip itself and rendered with the network blocked. Differences: one file ≤ 256 KB; the params block is
optional (only `params` required inside it); network APIs, external `src`/`href`/`url()`, clocks, `Math.random`,
timers and `<video>`/`<audio>` are errors, not warnings; image params are `data:image/…` only, at most 4 MB each
(props at most 16 MB) — and they **load**: the render blocks every network/disk scheme but not `data:`/`blob:`
(library-v2; before, `data:` images failed to decode); a bare `window.__hf = { duration, seek }` page is accepted.
Fit-to-duration is opt-in for custom code: declare `"fit": <seconds>` in the params block (recorded replays stay
bit-identical without it). Full rules, API and examples: README.md "Custom compositions"; code `src/custom.ts`;
examples `examples/custom/`.

## 9c. The timeline kit (shared code for a timeline's custom compositions; library-v2, gap 12b)
Several custom compositions of one timeline often share helpers and styles (the neon-grid recreation pasted a 13 KB
kit into 6 files: one fix = 6 calls, 6 commits, 6 re-renders). Instead:
1. Write the shared code once as the timeline's **kit**: `{ css?, js?, html? }` (or HTML text), at most 128 KB,
   checked by the same rules as a composition (no network, no clocks, no `RC.composition` — a kit only defines).
2. A composition includes it by putting `<!-- rc-kit -->` in its `<head>`; the kit's HTML (`<style data-rc-kit>`,
   `<script data-rc-kit>`, any SVG defs) replaces the marker, so its code runs before the page's own scripts.
3. Send the kit with every `custom-validate` / `custom-render` / `custom-nudge` of that timeline (`kit` field; CLI
   `custom --kit kit.json|.html|.css|.js`; `api kit-validate {kit}` checks one alone). A source with the marker and no
   kit is refused; a kit sent to a source without the marker is ignored.
4. The kit's sha is part of the render hash **only** for sources that include it (and in the sidecar as
   `kitSha256`), so a kit fix re-renders exactly those clips and leaves the rest cached.
5. **Over MCP** (composition-v3, 2026-10-21; built and run live): `composition {action: "kit", timeline_id, kit:
   {js, css?, html?}}` (or `library_kit: "neon-grid"`) stores the kit on the timeline (`metadata.restorff.kit` holds
   its sha; the code lives once in the server's composition store) and re-renders **exactly** the custom clips whose
   source has the marker, all in **one commit**; `dry_run: true` lists them first; `{action: "kit"}` alone reads it.
   `write` / `update` take `use_kit: true` (the server puts the marker into `<head>`). Every re-render of a marker
   source (update, revise, revert) uses the timeline's kit.
6. **Library kits**: shared code for LIBRARY compositions lives in `kits/<name>.js` (+ optional `kits/<name>.css`). A
   library composition names it in its params block (`"kit": "neon-grid"`) and keeps `<!-- rc-kit -->` in `<head>`;
   the renderer runs it right after the runtime, before the page's scripts, and its sha joins that piece's hash only
   (`src/kits.ts`, `render.ts` `prepare`/`initScript`). A custom source that includes the marker, names a library kit
   and is sent **without** a kit renders with that library kit, so a library piece forked as code (`composition get`
   → `update {source}`) renders unchanged; a sent kit (the timeline's) always wins. Service verbs `library-kit
   {name}`, `library-kits`.

## 9d. Declarations: cues, scenes, text, opaque (composition-v3; read by sound design and the export gate)
Besides `params`, a params block may declare (all optional; the validator ignores unknown top-level keys):

| Field | Format | Who reads it |
|---|---|---|
| `cues` | `[{"t": 0.4, "kind": "stamp", "label": "the stamp lands", "sound": "stamp-slam"}]`; `t` = **animation** seconds from the clip's start (real = t / speed) or `"from_end": s`; `sound` (a pack id) wins over the kind's default | `sounds design` (apps/web `server/sound-design-cues.ts`) |
| computed cues | in `build()`: `window.__rcCues = [{t, kind, label?, sound?}]`, `t` = **real** seconds into the clip, computed from the params; push once (build, not render). The renderer writes them into the sidecar as `cues` (`render.ts` `cleanCues`: valid ones, sorted, at most 64) | sound design reads, first hit wins: the render's cues > the params block's > events measured in the frames |
| `scenes` | `[2.1, 4.5]` (seconds from the clip's start where a scene begins; objects with a numeric `t` work too) | the export gate counts them as picture changes (`packages/gate` `compositionFacts`) |
| `text` | `[{"content", "t"?, "t_end"?, "role": "headline" \| "label" \| "caption", "box"?: [x0, y0, x1, y1] (0..1)}]` | the gate's text checks (hook text, safe area, length) |
| `opaque` | `true` when the piece paints the whole frame | the gate; sound design treats its edges as cuts |
| `kit` | a library kit name (§9c.6) | the renderer |

Cue **kinds** and their default sounds are the server's table (`server/sound-design-plan.ts` `CUE_SOUNDS`): `type`,
`stamp`, `marker`/`strike`/`draw`, `paper`, `word`/`impact`, `ignite`, `whoosh`, `riser`, `tick`, `check`, `pop`… —
MCP `composition contract` returns it as `cue_kinds`, with these formats as `declarations` (no source reading
needed). **Caution:** the gate reads a PARAM named `scenes` (or `text`) the same way — give its items a numeric `t`,
or name the param something else.

## 9e. Versions (composition-v3)
Every render of a composition clip — `composition write` / `update`, `revise`, `revert`, a kit change — appends a
version to `element.restorff.composition.versions[]`: `{v, at, note, kind, source_sha?, props_sha, kit_sha?, hash,
duration}` (at most 100 per clip). The texts live once each in a content-addressed store (apps/web
`server/composition-versions.ts`, table `rc_composition_store`: sha256 → body); the clip holds hashes. MCP
`composition {action: "history", element_id}` lists them with what changed (props a → b, source +/− lines, kit,
length); `{action: "revert", element_id, version: N | "previous"}` puts N back — its source, its props exactly, its
length — in **one commit**, recorded as a new version. A clip made before versions were kept counts as v1.

## 9f. Make a piece replicable (composition-v3; the neon-grid kit is the worked example)
A style another product can reuse needs **no story in the code**: every on-screen word and every story time is a
param with a neutral name (`lines[]`, `keyword`, `nodes[]`, `beats[]`, `ruler {from, to, marks}`, `curve {…}`,
`dial {count, unit}`), and items time themselves from the voice: a `words` param `[{w, s, e}]` (timeline seconds) +
`t0` (where the clip starts) — an item with `at: -1` lands on its `word`, else on its own first word (digits match
number words), searched in order after the item before; else on the piece's default. Camera / ambient motion stays
relative to the clip (`time.t`); voice beats use `t0 + time.T`. Cues are computed from the same times (§9d).
`test/composition-v3.test.ts` fails a piece whose code contains an on-screen word of either example product.

## 9g. Animation libraries and the HyperFrames page protocol (anim-runtime, wave 7, 2026-10-24)
Instead of `RC.composition`, a page may animate with the GSAP API (our MIT compat), Three.js, lottie-web or Anime.js:
1. Name them with a marker in `<head>`: `<!-- rc-lib gsap -->` (also `three`, `three-r147`, `lottie`, `anime`; several
   per marker). The renderer injects each library before any page script; never load them with `<script src>`.
2. Register what you built — a paused GSAP timeline on `window.__timelines[id]`, an `hf-seek` listener (Three.js,
   canvas), a Lottie instance on `window.__hfLottie`, an Anime.js animation on `window.__hfAnime` — and the runtime
   seeks it every frame (`src/gsap-compat/hf-protocol.js`). Heavy setup registers a promise on
   `window.__hf.buildReady[key]`; `window.__hyperframes.getVariables()` returns the params.
3. The §5 rules still hold: no clocks, no `Math.random` (use `gsap.utils.random`, seeded per composition), no network.
4. A page that registers `RC.composition` drives its own timelines (or calls `RC.hf.seek(time.t)` from `render`).
Supported API and known differences from GSAP: `src/gsap-compat/STATUS.md`; README "Animation libraries".

## 10. Adding a composition — checklist
1. Copy the closest starter folder; rename the folder, file and `name`.
2. Write the manifest first: params with meanings, standard names from §2 (`speed` always), `"required": true` on
   the main word (§2c), `"display": false` on generic UI words, `fit` when the end is a hold or everything is on
   the voice (§3b).
3. `build` makes DOM from params; `render` animates from `time`; exits use `time.left`. Render once at a short
   duration (`--duration 1`): every beat must still happen.
4. `check` passes with no warnings.
5. Render, then **look**: `look <out.webm>` and `look <out.webm> --from 0 --to 1 --count 8` for the entrance;
   open the PNGs. Fix what looks off: overlaps, cut-off text, unreadable sizes (< 36 px on the 1080 grid), a frame
   where an animation jumps.
6. Write the example props file (fictional content).
7. `samples --only <name>` to add its sample; `bun test` (the library test picks it up automatically).
