# @restorffcut/compositions — motion graphics as code (v0.3.0)

**What it does.** A *composition* is a small HTML/CSS/JS file whose picture is a pure function of time. Claude writes
it, changes it by editing its params ("slower", "bigger", "make it red"), and this package renders it **frame by
frame** in headless Chromium to an **alpha video** (WebM VP9 or ProRes 4444) that drops onto an overlay track in the
RestorffCut editor above the talking head. The idea is the one in the owner's reference reels (HeyGen's HyperFrames);
the renderer is our own, compatible with HyperFrames' page protocol — why: [DECISION.md](DECISION.md).

**When to use it.** Captions, badges, big words, cards, lists, charts, titles: anything typographic or graphic that
sits over footage. Not for footage itself (no `<video>` inside a composition yet).

Read next: [CONTRACT.md](CONTRACT.md) (how to write one) · [LEARNINGS.md](LEARNINGS.md) (rules that cost time) ·
[CHANGELOG.md](CHANGELOG.md) (versions and the Next list) · worklog `../../docs/restorff/worklog/compositions.md`.

## Paths (all relative to `restorffcut/packages/compositions/`)
| Path | What |
|---|---|
| `src/cli.ts` | the CLI (all commands below) |
| `src/runtime.js` | the in-page runtime: clock, easing, helpers, `window.__hf` |
| `src/render.ts` · `src/cdp.ts` · `src/ffmpeg.ts` | renderer: Chromium over raw CDP → PNG → FFmpeg |
| `src/params.ts` · `src/edits.ts` · `src/types.ts` | params contract, sentence nudges, types |
| `compositions/<name>/` | the library (59 written here), each with example props (the gallery sample's copy, never merged into an apply: CONTRACT §2c) — **plus the compositions `tools/fx-sync` imports** (HyperFrames blocks and components; each manifest has `provenance` and `"kit": "hf-compat"`, a `<name>.technique.json` beside it; list and counts in `docs/restorff/fx-sync/LAST-RUN.md`; runbook `tools/fx-sync/README.md`) |
| `kits/hf-compat.js` | the HyperFrames page protocol for imported compositions (variables under their upstream ids, bindings, deferred scripts, clip windows, scale-to-fit, backdrop, themes); written by fx-sync |
| `fonts/gf/` | Google Fonts (OFL / Apache) localised for imported compositions: latin woff2 + licence texts + `fonts.json` (fx-sync owns this folder) |
| `kits/<name>.js` (+ `.css`) · `src/kits.ts` | library kits: shared code library compositions name in their params block (`"kit": "neon-grid"`; CONTRACT §9c.6) |
| `examples/neon-grid/` | the neon-grid kit's two product plans (Halcyon Cold Brew 18 h, Halcyon Nitro 12 s) + `render.ts` (local renders) + `place.ts` (places a plan on a timeline over MCP) |
| `src/service.ts` | the editor service (catalogue · cached render · nudge · custom-*) behind `cli.ts api` |
| `src/custom.ts` | custom compositions: validate, hash, network-blocked render, cache, nudge, contract (section "Custom compositions") |
| `examples/custom/` | three worked custom compositions + example props (Code view starters, test inputs) |
| `samples/` | rendered samples (`.webm` < 2 MB each, `.png` contact sheet, `.webm.json` sidecar, `samples.json` timings) |
| `fonts/` | Archivo, JetBrains Mono, Instrument Serif (OFL, licences beside them) |
| `src/gsap-compat/` | our MIT GSAP-API runtime (`gsap.js`), the HyperFrames page protocol (`hf-protocol.js`, every page), the black-box oracle (`oracle/`); runbook `README.md`, support table `STATUS.md` (section "Animation libraries") |
| `src/libs.ts` · `vendor/` | `<!-- rc-lib gsap three three-r147 lottie anime -->` markers → offline libraries injected before page scripts; Three.js 0.184.0 / 0.147.0, lottie-web 5.12.2, Anime.js 4.5.0 (MIT; `vendor/README.md`) |
| `test/` | `bun test` suites |

Environment overrides (optional): `RESTORFFCUT_CHROME` (Chromium/headless-shell executable), `RESTORFFCUT_FFMPEG`,
`RESTORFFCUT_FFPROBE`, `RESTORFFCUT_CAPTURE=safe` (slower capture path, see LEARNINGS §6).

## Setup (once per machine)
Run from `restorffcut/`:
```
bun install
bunx playwright@1.63.0 install --only-shell chromium
ffmpeg -version
```
1. `bun install` — installs this workspace package's only dependency, `playwright@1.63.0` (dev; used only to
   download/locate Chromium).
2. Chromium: skip if `%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1243` exists. The headless shell takes
   **271 MB** on disk (MEASURED). Check free space first; on this PC ask the owner if C: is short.
3. FFmpeg 6+ with `libvpx-vp9` and `prores_ks` on PATH (`ffmpeg -hide_banner -encoders | findstr "vp9 prores"`).

**Verify:** `bun packages/compositions/src/cli.ts list --json` lists 59 compositions (56 before the scout pieces of 2026-10-24); `cd packages/compositions` then
`bun test` prints `583 pass, 0 fail` across 9 files in about 60 s (MEASURED 2026-10-24 14:5x by anim-runtime after
`test/gsap-compat.test.ts`, with the other wave-7 suites; 218 across 8 files earlier that day by scout; 198 across 6 files on 2026-10-21 after
composition-v3; 165 across 5 files after library-v2, 135 before it).

## Commands (run from `restorffcut/`; every one below was run on 2026-10-20)
Render (the brief's form; props optional):
```
bun packages/compositions/src/cli.ts render packages/compositions/compositions/big-word-punch/big-word-punch.html --duration 3 --fps 30 --size 1080x1920 --out packages/compositions/out/big-word-punch.webm
```
Output: `wrote …\out\big-word-punch.webm (webm, 1080x1920, 90 frames @ 30 fps, 0.40 MB)`, a time line, and the sidecar
`packages/compositions/out/big-word-punch.webm.json`. (`out/` is git-ignored: put scratch renders there.)

With props and one-off overrides, as ProRes:
```
bun packages/compositions/src/cli.ts render packages/compositions/compositions/word-pop/word-pop.html --props packages/compositions/compositions/word-pop/word-pop.props.json --set style=box --set scale=1.15 --out packages/compositions/out/word-pop-box.mov
```
Look at what you rendered (always — never call a render good without opening this PNG):
```
bun packages/compositions/src/cli.ts look packages/compositions/out/word-pop-box.mov --count 6
bun packages/compositions/src/cli.ts look packages/compositions/out/big-word-punch.webm --from 0 --to 1 --count 8 --out packages/compositions/out/punch-entrance.png
```
One frame, fast, while writing a composition (`--plate none` = transparent PNG):
```
bun packages/compositions/src/cli.ts still packages/compositions/compositions/cover-story/cover-story.html --t 1.5 --out packages/compositions/out/cover-1.5.png
```
What can Claude change, and is it valid?
```
bun packages/compositions/src/cli.ts params packages/compositions/compositions/chart-grow/chart-grow.html
bun packages/compositions/src/cli.ts check packages/compositions/compositions/chart-grow/chart-grow.html --props packages/compositions/compositions/chart-grow/chart-grow.props.json
```
Edit by sentence (prints the changes and the new props; `--write` saves them into the props file):
```
bun packages/compositions/src/cli.ts nudge packages/compositions/compositions/big-word-punch/big-word-punch.html "slower, bigger and make it red" --props packages/compositions/compositions/big-word-punch/big-word-punch.props.json
```
Probe a render (codec, stored and decoded pixel format, alpha flag, exact frame count):
```
bun packages/compositions/src/cli.ts probe packages/compositions/out/big-word-punch.webm
```
Editor service (what the RestorffCut editor's `/api/compositions` routes call; JSON in on stdin, `{ok, result|error}`
out; renders cached by input hash in `out/editor-cache/`):
```
echo {} | node packages/compositions/src/cli.ts api catalogue
echo {"name":"stamp","props":{"text":"NO SUGAR"},"width":1080,"height":1920,"fps":30} | node packages/compositions/src/cli.ts api render
echo {"name":"stamp","props":{},"sentence":"bigger and slower"} | node packages/compositions/src/cli.ts api nudge
```
`render` is an **applied** render (CONTRACT §2c): display text comes only from the request. `{"name":"stamp"}`
answers `{ok:false, error:"stamp needs: text. …", details:{needs:["text"], …}}`; a `duration` shorter than the
composition's natural length fits its clock (answer: `fit`, `rate`; `"fit": false` plays it as designed). Send
bodies with non-ASCII text from a file on Windows (`curl --data-binary @body.json`): passed as a shell argument,
`·` arrived as `�` (LEARNINGS §19).
Rebuild every sample + contact sheet + `samples/samples.json` (renders sum to ~34 s; headline-wall renders up to
four times to fit 2 MB, so allow about a minute):
```
bun packages/compositions/src/cli.ts samples
```
Tests (from `packages/compositions/`): `bun test`. Typecheck: `bunx tsc -p packages/compositions/tsconfig.json`.

## Inputs and outputs
- **In:** a composition `.html` + optional props JSON (`{ "word": "FREE", "$comment": "…" }`; relative image paths
  resolve against the props file) + optional `--set key=value` (lists of objects take JSON; simple lists `a|b|c`).
- **Out:** `.webm` (VP9 `yuva420p`, `alpha_mode=1`, CRF 31, keyframe every second) · `.mov` (ProRes 4444
  `yuva444p10le`) · a folder of `frame_00000.png`… — plus a sidecar JSON next to it: params used, size, fps, frames,
  timings, `inputHash` (cache key), `framesHash`, Chromium version, lint warnings.
- The editor plays `.webm` alpha natively; decode it in FFmpeg with `-c:v libvpx-vp9` **before** `-i` or the alpha
  is dropped (LEARNINGS §5).

## Timings and sizes (MEASURED 2026-10-20, AMD Ryzen 5 5500, 12 threads, 4 tabs, Chromium 153 headless shell)
| Composition | Length | Frames | Render | Per output second | Sample |
|---|---|---|---|---|---|
| badge-pills | 3.5 s | 105 | 3.4 s | 0.97 s | 0.37 MB |
| big-word-punch | 3 s | 90 | 2.9 s | 0.96 s | 0.39 MB |
| chart-grow | 4 s | 120 | 3.8 s | 0.94 s | 0.43 MB |
| checklist | 4 s | 120 | 3.9 s | 0.96 s | 0.41 MB |
| cover-story | 4 s | 120 | 4.2 s | 1.06 s | 1.2 MB |
| headline-wall | 4 s | 120 | 6.8 s | 1.7 s | 1.62 MB (CRF 43, see below) |
| ui-card-pop | 3.5 s | 105 | 4.8 s | 1.37 s | 1.24 MB |
| word-pop | 4 s | 120 | 3.8 s | 0.95 s | 0.37 MB |
All at 1080×1920, 30 fps, final runtime (2D transforms, a context per tab, one raster thread). Source:
`samples/samples.json`; the time is the last (accepted) pass. Page load (fonts, build) is 0.2–0.3 s of each.
Tabs vs time for big-word-punch (measured before the isolation flags, which added ~0.2 s at 4 tabs): 1 tab 6.0 s,
2 tabs 4.0 s, 4 tabs 2.7 s, 8 tabs 2.5 s → default 4.
ProRes 4444: 4.2 s and 29.9 MB for the same 3 s. Samples are kept under 2,000,000 bytes by stepping CRF 31 → 35 → 39
→ 43; only headline-wall needed it (its push-in changes every pixel every frame). Production renders use CRF 31.

## The library (59; the first 8 looked at frame by frame, later ones as contact sheets; the 7 library-v2 pieces and the 8 neon-grid kit pieces at the end of the table; fictional Halcyon Cold Brew content)
| Name | Shows | Key params |
|---|---|---|
| `word-pop` | captions 1–3 words, active word in the accent (or on a neon box) | `words[{text,start,end}]`, `maxWords`, `style` |
| `badge-pills` | mono pills stacking in, one neon | `pills[]`, `highlight`, `style`, `align`, `direction` |
| `big-word-punch` | one huge word slams in, underline draws, kicker + sub line | `word`, `kicker`, `sub`, `shake` |
| `ui-card-pop` | screenshot card flies in tilted, lands with a pop, floats | `image`, `caption`, `width`, `tilt`, `from` |
| `checklist` | titled list ticking in | `title`, `items[]`, `start`, `interval`, `card` |
| `headline-wall` | press cards fan into a tilted wall, slow push-in; layout wall pins them around the face box | `headlines[{source,headline,date}]`, `layout`, `face`, `anchor`, `offsetY` |
| `chart-grow` | bars (or a line) grow with counting numbers | `bars[{label,value}]`, `style`, `suffix`, `highlight` |
| `cover-story` | magazine cover: frame, serif wordmark, "… · Edited by Claude", coverlines | `wordmark`, `issue`, `credit`, `coverlines[]` |
| `phone-mockup` | phone floats beside the face, assistant chat, a tap on Approve (FX-06) | `request`, `answer`, `action`, `tapAt`, `side` |
| `zoom-through-title` | title rushes out of radial streaks, flies through on exit (FX-09) | `title`, `kicker`, `streaks` |
| `paper-cut` | torn grid paper, crayon scribbles, ransom tiles, red ellipse, tag (FX-13/52/60) | `text`, `tag`, `note`, `layout` |
| `doodle-boil` | hand-drawn doodles that boil at 12 fps (FX-14) | `doodles[]`, `word`, `boilFps`, `wobble` |
| `map-route` | paper map, dotted route draws, pins + label tags (FX-54) | `places[{name,x,y}]`, `title`, `layout` |
| `retro-tv` | wooden TV over a paper wall; the screen is a hole for the footage below (FX-55) | `label`, `chips[]`, `screenY` |
| `magazine-cover` | Didone masthead, dateline, rotating seal, coverlines, barcode (FX-16 variant) | `masthead`, `seal`, `coverlines[{big,line}]` |
| `neon-grid` | full-frame grid floor, words ignite per beat, wireframe solids, typed prompt (FX-48) | `lines[]`, `prompt`, `beat` |
| `stamp` | red rubber stamp slams in with ink texture (FX-26) | `text`, `sub`, `rotate` |
| `strike` | drawn strike (line/cross/scribble) then the correction (FX-25) | `text`, `correction`, `strikeAt`, `style` |
| `type-on` | section title types on, top left (FX-24) | `title`, `chapter`, `font` |
| `emphasis-underline` | words grey → white, underlines under key words (FX-19) | `words[{text,at,key}]` |
| `counter` | counts to a real number; plain, split-flap or serif (FX-32) | `from`, `to`, `format`, `style`, `endLabel` |
| `prompt-box` | prompt pill types → SENT → DONE (FX-30) | `text`, `to`, `typeStart` |
| `ignite-type` | caps ignite ember-orange and cool to white word by word (FX-23) | `text`, `wordGap` |
| `flow-spark` | flowchart, spark travels, a node is crossed out and re-routed (FX-49) | `nodes[]`, `broken`, `reroute` |
| `thread-timeline` | dated cards pinned on a red thread (FX-58) | `items[{date,text}]`, `legend` |
| `cta-social` | neutral comment box, heart, Follow → Following (FX-35) | `keyword`, `handle` |
| `pullback-window` | shot pulls back into an editor window (hole), steps tick, counter to 100 % (FX-11) | `title`, `steps[]`, `from` |
| `caption-stack` | mixed-type caption blocks (FX-21) | `blocks[{text,style,at}]` |
| `float-thumbs` | portrait thumbnails (real stills or drawn) pop in above the head and drift up (FX-42) | `images[]`, `cards[{label,stat,color}]`, `style` |
| `glass-panel-kit` | the explainer overlay grammar: type-on title, frosted glass panel, mono labels, icon tiles, one moving part per beat (FX-29) | `widget` (11), `labels[]`, `times[]`, `titles[]`, `icon` |
| `waveform-collapse` | waveform with labelled dead gaps that close into one block (FX-33) | `gaps[{start,end}]`, `total`, `caption` |
| `filmstrip-flash` | sprocketed filmstrip builds, frames flash under a scan, count, a frame flagged then fixed, bar, done chip (FX-34) | `frames[]`, `count`, `flag`, `status`, `done` |
| `before-after-wipe` | slanted divider with a ‹› handle wipes a BEFORE still off the graded clip (FX-36) | `before`, `after`, `afterLook`, `stop`, `angle` |
| `easing-curve` | graph-editor panel: a bezier curve draws, handles, a dot rides with a read-out, tags, preview square (FX-50) | `curve`, `bezier[4]`, `xTicks[]`, `xMax`, `tags[{at,text}]` |
| `paper-form` | a paper form slides up, boxes type, a red strike and a tick (FX-51) | `rows[{label,boxes,mark,check}]`, `form`, `layout` |
| `toc-list` | numbered table of contents above the head, current item lights up, folds to a pill | `items[]`, `times[]`, `compact[[a,b]]`, `count`, `title` |
| `neon-hook` | neon-grid kit 1/8: a prompt types, big lines reveal and ignite, the keyword last with an underline | `prompt`, `lines[{text,at,word}]`, `keyword` |
| `neon-grid-ruler` | 2/8: camera glide on the 3D grid, kicker, the number ignites, a ruler strikes and keeps values | `kicker`, `lines[]`, `ruler{from,to,step,major,unit,marks[{value,kind}]}` |
| `neon-flow` | 3/8: vertical flowchart, a spark rides the connectors, bracket + typed sum-up | `heading`, `nodes[]`, `label` |
| `neon-curve` | 4/8: easing-curve panel, a dot rides with a read-out, tags on the curve | `title`, `tag`, `curve{label,note,shape,tau,end,unit,ticks}`, `marks[]`, `readout` |
| `neon-beats` | 5/8: one huge dark word per beat on the accent fill | `beats[]`, `arrow` |
| `neon-code` | 6/8: a code panel types with syntax colours, a preview counts up | `title`, `suffix`, `file`, `code[]`, `keyword`, `preview`, `previewValue` |
| `neon-form` | 7/8: paper look switch: typed boxes, red strike + X, red tick, a stamp slams | `form{title,subtitle,number}`, `rows[{label,cells[],verdict,check}]`, `stamp` |
| `neon-outro` | 8/8: dial sweep + counter, crane up to the end title, loops into `neon-hook` | `dial{count,major,unit,from,to}`, `kicker`, `lines[]`, `keyword`, `loop` |
| `gl-transition` | scout 2026-10-24 (gl-transitions, MIT): 27 shader transitions; cover a cut in the accent colour or an image, or picture A → B | `transition`, `mode` (cover/in/out/images), `accent`, `image`, `from`, `to`, `hold` |
| `shader-bg` | scout (Paper Shaders, Apache-2.0 + Remocn looks, MIT): full-frame animated mesh / grain / warp / swirl background, 40 looks, opaque | `look`, `colors[]` (brand palette), `seed`, `scale`, `opacity` |
| `caption-fx` | scout (Remocn, MIT): word-timed captions — highlight-box, karaoke, marker, redact, scramble, blur-in, bounce-in | `words[{text,start,end}]`, `style`, `keywords[]`, `maxWords`, `accent`, `font`, `size` |
The three scout pieces regenerate their upstream tables from `third_party/<source>/` (README there: commands, commit,
licence); render costs and caveats are in each `<name>.technique.json`.
The neon-grid pieces (library kit `neon-grid`) are built for replication: every on-screen word and time is a param,
every time is TIMELINE seconds with `t0` = the clip's start, and items with `at: -1` time themselves from the voice's
`words [{w, s, e}]` (CONTRACT §9f). Runbook below ("The neon-grid kit").
Every one takes `speed` (and fits its clock to a shorter `duration`, CONTRACT §3b) plus the standard params it makes
sense for: `scale`, `ease`, `accent`, `anchor`, `offsetY`, `exit` (CONTRACT §2). Applied renders never show the
example's words: missing text renders blank or the service answers `needs` (CONTRACT §2c).

## Add a composition
Follow CONTRACT.md §10. Short form: copy the closest starter folder → manifest first → `build`/`render` →
`check` (no warnings) → render → `look` (whole clip and the entrance window) → fix → props example →
`samples --only <name>` → `bun test`.

## Verify a render (checklist)
1. `probe x.webm` → `codec vp9`, `alphaMode true`, `decodedPixFmt yuva420p`, `frames` = round(duration × fps).
2. `look x.webm` and open the PNG: first/last frames empty when the design has an entrance/exit; no text cut off;
   nothing overlapping that shouldn't.
3. Sidecar `warnings` is empty.

## Known failures and fixes
| Symptom | Cause | Fix |
|---|---|---|
| `no Chromium found` | no Playwright browser installed | `bunx playwright@1.63.0 install --only-shell chromium`, or set `RESTORFFCUT_CHROME` |
| render hangs at start under Bun on Windows (old versions of this code) | Playwright's own launch/connect does not work under Bun 1.2.18 on Windows | this package uses `src/cdp.ts` instead; don't switch back to `chromium.launch()` |
| alpha missing when FFmpeg reads the `.webm` | FFmpeg's native vp9 decoder ignores the alpha plane | put `-c:v libvpx-vp9` before `-i` |
| frames compared against sources are off by one | WebM stores ms timestamps (266.67 → 267 ms) | compare by index: `setpts=N/FPS/TB` on both inputs |
| two renders differ by 1/255 in a few pixels | different `--workers` counts (raster history) | use the same worker count; the sidecar records it |
| two renders with the same settings differ | a composition uses `will-change` or `translate3d`/`translateZ` (layer promotion) | `check` warns; remove them (LEARNINGS §2) |
| faint ghost (alpha ≤ 6/255) on the last frame of a fast fade in `.webm` | VP9 alpha residual; CRF 18–31 all the same | invisible in motion; use `.mov` when exact alpha matters |
| `params block is not valid JSON` | trailing comma or comment in the manifest | JSON only; put notes in `description` |
| `image not found` | relative image path resolved against the wrong folder | paths in a props file resolve against that file's folder; defaults against the composition's |

## Custom compositions (code written in the product; EDT-15, motion-code agent 2026-10-20)
**What.** The library above is fixed files chosen by name. A *custom* composition is new HTML/CSS/JS that Claude (over
MCP) or a person (the editor's Code view) writes on the spot: it is validated, rendered to alpha WebM **with the
network blocked**, placed on the MOTION track, and its **source is stored in the clip**
(`element.restorff.composition = {custom: true, source, props, hash, width, height, fps, duration, name, title,
author}`), so it travels with every commit and can be reopened, changed, or re-rendered on another machine.
Code: `src/custom.ts`. Worked examples (fictional Halcyon content; also the Code view's starters and test inputs):
`examples/custom/` — `kinetic-type` (word-by-word rise, key word on a neon box), `perspective-grid` (CSS-perspective
grid with a title painted on it; the camera cranes up, banks and pushes through), `growth-chart` (an SVG line that
draws itself, value riding the tip, +212 % callout).

**How to write one.** Exactly as CONTRACT.md (`RC.composition({ build, render })`, `time.t`, `RC.u`, `RC.safe`, the
bundled fonts), with these differences:
| Rule | Why |
|---|---|
| One self-contained file, at most **256 KB** (262,144 bytes) | it is stored in the commit |
| The params block is **optional**, and inside it only `params` is required (`name`, `title`, `duration`, `size` default to `custom`, "Custom composition", 4 s, 1080×1920) | a person can start typing; with a block, props are typed, the inspector shows fields and sentence edits work |
| **Refused** (errors): `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `import`/`import()`, workers, `<iframe>`/`<link>`/`<object>`/`<embed>`/`<base>`, meta refresh, navigation, storage APIs, any `src`/`href`/`url()` that is not `data:` or `#…`, scheme URLs in JS strings (SVG namespaces excepted), `Date`, `performance.now`, `Math.random`, `requestAnimationFrame`, timers, `<video>`/`<audio>`; image params must be `data:` URLs; props may not contain URLs | no network and seekable by time; a relative `src` would read the server's disk |
| Warned: CSS `transition`, `will-change`, `translate3d`/`translateZ` | LEARNINGS §2 |
| A page that sets `window.__hf = { duration, seek(t) }` itself (the bare HyperFrames protocol) is accepted too | HyperFrames-compatible both ways |
| Length at most **60 s**; size rounded to even, 16…4096 | render cost; yuva420p |

**The sandbox (three layers, MEASURED with a live local server: 0 requests reached it; re-checked 2026-10-21 in
`test/library-v2.test.ts`, where the same page's `data:` images decode, 40×40).** (1) The page is loaded
from a `data:` URL, so its origin is `null`: no `file://` reads, nothing same-origin. (2) Per tab
`Network.setBlockedURLs ["*"]` plus `Fetch.enable "*"` that fails every paused request; every attempted URL is
recorded and returned as `report.blocked`. (3) Chromium runs with `--proxy-server=http://127.0.0.1:9
--proxy-bypass-list=<-loopback> --host-resolver-rules="MAP * ~NOTFOUND"` (`NO_NETWORK_FLAGS`), so even a URL built
at run time reaches nothing, loopback included. The static check (above) runs first and refuses before a browser
starts. Layer (2) blocks per scheme (`BLOCKED_SCHEMES`: http, https, ws, wss, ftp, file, filesystem, chrome*,
devtools, javascript) and lets `data:`/`blob:` through: blocking `*` also blocked `data:` images, so a custom
composition could not show a picture it carried (LEARNINGS §17).

**Library-v2 additions (2026-10-21).** Images: `data:image/…` params (≤ 4 MB each, props ≤ 16 MB) and inline
`data:` images now load. **Timeline kit** (CONTRACT §9c): shared CSS/JS written once per timeline, included with
`<!-- rc-kit -->`, sent as `kit` with `custom-validate` / `custom-render` / `custom-nudge` (`api kit-validate {kit}`
checks one alone), its sha in the hash only for the sources that include it. Fit-to-duration is opt-in here
(`"fit": <s>` in the params block). Answers gain `fit`, `rate` and `kit` (true when included). CLI:
```
bun packages/compositions/src/cli.ts custom my-scene.html --kit my-kit.json --size 540x960 --out packages/compositions/out/my-scene.webm
```
(`--kit` takes `.json` = `{css, js, html}`, `.html`, `.css` or `.js`.) Run 2026-10-21 with a two-line kit
(`out/library-v2/kit-demo/`): `wrote … (webm, 540x960, 30 frames @ 30 fps, 0.05 MB) — network blocked`,
`blocked requests: none attempted`, the kit's CSS and JS both visible in the frames (SEEN); the same file with
`--check` and no `--kit`: `REFUSED … error: the source includes the timeline kit (<!-- rc-kit -->) but no kit was
sent`.

**CLI** (run from `restorffcut/`; both commands were run on 2026-10-20):
```
bun packages/compositions/src/cli.ts custom packages/compositions/examples/custom/kinetic-type.html --props packages/compositions/examples/custom/kinetic-type.props.json --check
bun packages/compositions/src/cli.ts custom packages/compositions/examples/custom/kinetic-type.html --props packages/compositions/examples/custom/kinetic-type.props.json --size 540x960 --out packages/compositions/out/custom-examples/kinetic-type.webm
```
Output: `ok — 6733 bytes, protocol rc, 11 params`, then `wrote …\out\custom-examples\kinetic-type.webm (webm,
540x960, 120 frames @ 30 fps, 0.42 MB) — network blocked`, `time 2.6 s (load 0.3 s) = 0.66 s per second of output`,
`hash …`, `blocked requests: none attempted`. Then `look` it as usual. A refused file prints `REFUSED — …` and one
`error: line N: …` per problem, exit code 1.

**Editor service verbs** (same JSON-in/JSON-out contract as above; cache `out/editor-cache/custom/<hash>.webm`):
`custom-validate {source, props}` → `{ok, errors, warnings, manifest, values, protocol, bytes}` ·
`custom-render {source, props, duration_s, width, height, fps}` → `{hash, file, cached, name, title, duration, width,
height, fps, frames, bytes, params, ms, report}` (refusal: `{ok:false, error, details:{errors, warnings}}`) ·
`custom-nudge {source, props, sentence}` · `custom-kit` (runtime + base64 fonts for the preview) · `custom-examples`
· `custom-contract` (the short contract + one full example, for MCP).

**HTTP API** (apps/web, `src/app/api/compositions/custom/`; real calls on the dev server, 2026-10-20):
| Route | In → out |
|---|---|
| `POST /api/compositions/custom` | `{source, props?, duration_s?, width?, height?, fps?}` → `200 {hash, url, width, height, duration, fps, frames, bytes, cached, name, title, params, ms, report}`; refused → `422 {error, report: {errors, warnings}}` |
| `GET /api/compositions/custom/<hash>` | the WebM (`video/webm`, immutable); `404` when the cache lost it (re-render from the clip's source); `400` for a bad hash |
| `POST /api/compositions/custom/validate` | `{source, props?}` → `200 {ok, errors, warnings, manifest, values, protocol, bytes}` (no browser; what the Code view lists inline) |
| `GET /api/compositions/custom/kit` · `GET …/examples` | preview runtime + fonts · the three examples with source and props |
| `POST /api/compositions/nudge` | now also takes `{source, props, sentence}` for a custom composition |
Example: growth-chart, `duration_s: 3`, 540×960 → `200` in 4.7 s: `{"hash":"ef941b79…","cached":false,"name":
"growth-chart","title":"Growth chart","duration":3,"width":540,"height":960,"fps":30,"frames":90,"bytes":186859,
"ms":2770,"report":{"errors":[],"warnings":[],"protocol":"rc","sourceBytes":12571,"network":"blocked","blocked":[]},
"url":"/api/compositions/custom/ef941b79…"}`; the same request again: `cached: true` in 173 ms. With a `fetch(…)`
added: `422` `line 44: fetch(): the render has no network: …`.

**In the editor.** Effects tab → MOTION → **Write it as code** (starters: the three examples, or blank) opens the Code
view: a monospaced editor with line numbers, a live preview in a sandboxed iframe (`sandbox="allow-scripts"`,
inline-only CSP, the same runtime/fonts/config the renderer injects; play + time scrubber drive `window.__hf.seek`),
length, props as typed fields (when there is a params block) or JSON, problems listed inline (click a `line N:` one to
jump), and **Render & place** (MOTION track at the playhead, one undo step). Selecting a custom clip shows **Edit
code** (Kiln dot + "by Claude" when Claude wrote it); **Save & re-render** swaps the clip's video in place. A custom
clip whose video is missing in this browser shows "render missing" with **Re-render from code** (and a banner on top
of the Effects panel for all of them).

**MCP tool `composition`** (standalone endpoint `http://localhost:8791/api/mcp`; every result ends with `next`):
| Action | Arguments | Does |
|---|---|---|
| `contract` | — | the short contract, limits, the examples, and one full example source |
| `write` | `timeline_id, source, props?, duration_s?, t?, base_commit?, message?, branch?` | validate → render at the timeline's canvas size, network blocked → store the WebM in the project's media store → `import_media` + (`add_track` MOTION if no MOTION track has room) + `insert` at `t` → commit as `claude` with `restorff.composition` on the clip |
| `update` | `timeline_id, element_id, source? and/or props? (merged; null removes a key) and/or duration_s?` | re-render → swap the clip's video in place (same start and track) → commit |
| `get` | `timeline_id, element_id` | the stored source, props, hash, size, author (+ `versions {count, current}`, `kit`) |
| `write {library}` | `timeline_id, library, props, t, duration_s?` | composition-v3: a LIBRARY composition placed like a custom one (a `t0` param is filled from `t`; `needs` when a required on-screen param is missing) |
| `history` | `timeline_id, element_id` | composition-v3: every version (write, update, revise, revert, kit change) with what changed: props a → b, source +/− lines, kit, length |
| `revert` | `timeline_id, element_id, version (N or "previous")` | composition-v3: puts version N back (source, props exactly, length) in ONE commit, as a new version |
| `kit` | `timeline_id, kit {js, css?, html?} \| library_kit, dry_run?` | composition-v3: sets the timeline kit; re-renders exactly the clips whose source has `<!-- rc-kit -->`, ONE commit; alone = read it (code + which clips include it). `write` / `update` take `use_kit: true` |
The contract answer also carries `declarations` (cues, scenes, text, opaque, kit: CONTRACT §9d), `cue_kinds` (the
server's kind → sound table), `library_kits` (with the pieces that use them) and `mcp` (versions, kit, library rules).
Real run (2026-10-20, scratch project `motion-code-smoke-mvgbru5o`, fictional Halcyon): `write` with
`examples/custom/kinetic-type.html`, its props, `duration_s: 4, t: 2` → in 7.0 s `{commit_id: "63d31468…",
element_id: "1d939e99…", media_id: "34946281…", track: {name: "MOTION", created: true}, t: 2, duration_s: 4, title:
"Kinetic type", render: {cached: false, ms: 4882, frames: 120, size: "1080x1920", fps: 30, bytes: 847075}, report:
{warnings: [], network: "blocked", blocked: []}, next: {tool: "composition", arguments: {action: "update", …}}}`;
`update` with `props: {highlight: "HOURS"}` → new commit, new hash, 6.4 s; `timeline summary` lists the clip as
`{name: "Kinetic type", t: 2, dur: 4, composition: "kinetic-type", code: true, author: "claude"}`; opening
`/editor/motion-code-smoke-mvgbru5o` pulled both renders from the server and showed the clip (SEEN).

**Known failures and fixes.**
| Symptom | Cause | Fix |
|---|---|---|
| `REFUSED … loads from outside` for an image | a relative/http `src` | inline it as a `data:` URL (or pass it as an image param, data: only) |
| `no page protocol` | no `RC.composition(` and no `window.__hf =` | wrap the drawing in `RC.composition({ build, render })` |
| text tiny after `RC.fitText` | it measured a full-width block (scrollWidth = the row) | fit an inline-block span (perspective-grid's first render had this, SEEN) |
| preview fine, render shows nothing loaded | something loads at run time (blocked) | read `report.blocked`: those URLs were refused |
| a custom clip's video is missing after opening a project | the cache or the browser's media store lacks it | Effects → **Re-render from code**, or `POST /api/compositions/custom` with the clip's source |

## The neon-grid kit — replicate a style for another product (composition-v3, 2026-10-21)
**What.** The neon-grid recreation (Opus, `docs/restorff/recreations/neon-grid-type`) as eight library pieces whose
code holds no story: `neon-hook · neon-grid-ruler · neon-flow · neon-curve · neon-beats · neon-code · neon-form ·
neon-outro`, sharing the library kit `kits/neon-grid.js`. A new product = a new **plan** (JSON), not new code.

**A plan** (`examples/neon-grid/halcyon-cold-brew-18h.json`, `halcyon-nitro-12s.json`): `{product, script, voice,
duration, words: [{w, s, e}] (the voice-over's words, timeline seconds), scenes: [{piece, t, duration, props}]}`.
Each scene is placed with `props + {words, t0: t}`; any item without a time (`at` omitted or -1) lands on its own
first word in the voice (digits match number words: `"18 H"` → "eighteen"; cells of a form row may be said in any
order), or on `word` when the voice says something else (`{"text": "60 SEC", "word": "minute"}`). The only
explicit time in the Nitro plan is `dial.to: 30.0`.

**When.** A "defined as a function of time" explainer for any product: write the script, get its word timings
(`voiceover say` → transcript words), cut it into the eight beats, fill the props. To make one product's video
from scratch with a smaller model: copy a plan, change `product`, `script`, `words` and the props' words/numbers.

**Run** (from `restorffcut/`, dev server on :8791; every command below was run on 2026-10-21):
```
bun packages/compositions/examples/neon-grid/render.ts packages/compositions/examples/neon-grid/halcyon-nitro-12s.json
bun packages/compositions/examples/neon-grid/place.ts packages/compositions/examples/neon-grid/halcyon-nitro-12s.json
bun scripts/mcp-call.ts call render '{"timeline_id":"<id from place>","quality":"preview"}'
bun scripts/mcp-call.ts call render '{"render_id":"<render_id>","wait_s":25}'
bun scripts/mcp-call.ts call look '{"kind":"render","ref":"<render_id>","times":[2.9,6.4,11.6,17.5,18.9,21.4,26.3,33.2]}' --images <absolute folder outside the repo>
```
`render.ts` (no server): every scene at 540×960 into `out/neon-grid/<plan>/NN-<piece>.webm` + an 8-frame contact
sheet `NN-<piece>.png` + `summary.json` (cue list per scene); MEASURED 2.0–11.5 s per scene. `place.ts`: `timeline
create` (unless `--timeline <id>`), then one `composition write {library}` per scene (= one commit each), prints
element ids / hashes / render times and writes `out/neon-grid/<plan>/placed.json`; MEASURED 2 min per product at
1080×1920 (renders 4.3–23.8 s each). Open the sheets / look frames before calling it done.

**Verify.** Same 8 pieces, two products, different pictures: `cd packages/compositions && bun test
test/composition-v3.test.ts` renders every piece with both plans (tiny, 10 fps), checks the frames differ, the kit
was used and the cues came from the params; and fails a piece whose code contains an on-screen word of either
product. SEEN 2026-10-21: all 16 contact sheets and both full previews (worklog composition-v3).

**Change a piece's code for one video** (structure, not words): `composition get` → edit the source → `update
{source}`; it stays on the library kit (its params block names it) — or set `composition kit {library_kit:
"neon-grid"}` to share one kit across code clips.

**Known failures.** `effects apply comp:neon-*` does not fill `t0` from `t` (only `composition write {library}`
does): send `t0`, or every beat shifts by the clip's start. A piece whose clip is moved on the timeline keeps its old
`t0` until its next `composition update` (which re-syncs it). Captions inside the pieces are the voice's words
(`captions: true`), separate from the `captions` tool.

## Animation libraries: GSAP-API compat, Three.js, lottie-web, Anime.js (anim-runtime, wave 7, 2026-10-24)
**What.** A composition (library or custom) may animate with the GSAP API, Three.js, lottie-web or Anime.js instead
of `RC.composition`: it names the libraries with a marker comment and registers what it made; the runtime seeks it
every frame. Nothing loads from the network; GSAP itself is never shipped (DECISION.md): `gsap` is our own MIT
runtime. Details: `src/gsap-compat/README.md` (runbook), `src/gsap-compat/STATUS.md` (supported API, differences,
oracle results), `vendor/README.md` (versions, how each library follows the clock, how to update).

**When.** Importing HyperFrames blocks (fx-sync converts them to this form) and any composition Claude finds easier
to write as a GSAP timeline, a Three.js scene, a Lottie file or an Anime.js animation.

**How** (a complete custom composition; run 2026-10-24 as `test/gsap-compat.test.ts` "renders bit-identically"):
```html
<!doctype html><html><head><meta charset="utf-8"><!-- rc-lib gsap -->
<script type="application/json" id="params">{"duration": 1, "size": [160, 90], "params": {}}</script></head>
<body><div id="s" style="position:absolute;left:20px;top:20px;width:40px;height:40px;background:#F6FF00"></div>
<script>
  var tl = gsap.timeline({ paused: true });
  tl.fromTo("#s", { scale: 0, rotation: -40 }, { scale: 1, rotation: 0, duration: 0.6, ease: "back.out(2)" });
  window.__timelines = window.__timelines || {};
  window.__timelines.demo = tl;
</script></body></html>
```
| Marker | Page gets | The page registers | The runtime, each frame |
|---|---|---|---|
| `<!-- rc-lib gsap -->` | `gsap`, `CustomEase`, `MotionPathPlugin`, `TextPlugin`, `ScrambleTextPlugin`, `DrawSVGPlugin`, `SplitText` | `window.__timelines[id] = tl` (paused) | primes once, then `tl.totalTime(t − data-start, false)`; also our global timeline |
| `<!-- rc-lib three -->` / `three-r147` | `THREE` (0.184.0 + `THREE.addons`) / `THREE` (0.147.0 + examples/js globals) | an `hf-seek` listener that draws from `e.detail.time` | dispatches `hf-seek`; `e.detail.waitUntil(p)` is awaited |
| `<!-- rc-lib lottie -->` | `lottie` | `window.__hfLottie.push(lottie.loadAnimation({…, autoplay: false}))` | `goToAndStop(frame, true)` |
| `<!-- rc-lib anime -->` | `anime` (v4) | `window.__hfAnime.push(anime.animate(…, { autoplay: false }))` | `seek(ms)` |
`window.__hf.buildReady[key] = promise` delays frame 0; `window.__hyperframes.getVariables()` answers the params.

**Verify.** `cd packages/compositions && bun test test/gsap-compat.test.ts` → `47 pass, 0 fail` (~5–15 s; MEASURED
2026-10-24). Compare against real GSAP (scratchpad, black box): `src/gsap-compat/README.md` "The oracle".

**Costs.** Library bytes per tab: gsap 0.12 MB, three 0.84 MB, three-r147 0.74 MB, lottie 0.31 MB, anime 0.12 MB
(parsed once per tab). WebGL runs on SwiftShader (CPU): heavy 3D scenes cost seconds per output second.

**Known failures.** A file whose content sits inside `<template>` (a HyperFrames sub-composition) or registers its
timeline after the page has built answers `no composition registered` — flatten it / register synchronously.
Blur and glow inside elements GSAP would have promoted with `translate3d` look slightly different (we keep 2D
transforms for determinism, LEARNINGS §2). More in `src/gsap-compat/README.md`.

## Credits and licences
- Approach and page protocol from **HyperFrames** by HeyGen (Apache-2.0, Copyright 2026 HeyGen, Inc.,
  github.com/heygen-com/hyperframes). No HyperFrames code is included; if any is ever copied, add its LICENSE + a
  NOTICE here and mark the changed files.
- Fonts under the SIL Open Font License 1.1 (`fonts/OFL-*.txt`): Archivo (Omnibus-Type), JetBrains Mono
  (JetBrains), Instrument Serif (Instrument). Subset to Latin; woff2.
- All sample content (Halcyon Cold Brew, its products, the publications in headline-wall, the numbers) is fictional.
