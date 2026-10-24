# LEARNINGS — @restorffcut/compositions

Each rule cost time on 2026-10-20. Rule first, then the incident.

## 1. Under Bun on Windows, drive Chromium over raw CDP — not Playwright's launch/connect
Playwright 1.63 `chromium.launch()` hung with no output for 90 s under Bun 1.2.18 on Windows; `connectOverCDP` failed
with `ws unexpected response 200 OK`. Both worked under Node 24. `src/cdp.ts` spawns the headless shell with
`--remote-debugging-port=0`, reads `DevTools listening on ws://…` from stderr and talks CDP over the runtime's
built-in `WebSocket` — works in Bun and Node, no npm dependency. Keep Playwright only for installing Chromium.

## 2. Determinism has three enemies: layer promotion, frame hand-out order, and shared raster caches
The determinism test failed with 4 tabs (two renders of big-word-punch hashed differently); 1 tab was identical
run to run. Differences were tiny (alpha ≤ 1/255, RGB ≤ 3/255) and always on the rotating, scaling, shadowed word.
Found and fixed in this order (each MEASURED by hashing every frame's decoded RGBA over 4–8 repeated renders):
1. **`will-change: transform`** froze the word layer's raster scale at its first frame → frames depended on which
   frames a tab drew first. Removed; `check` flags `will-change`.
2. **First-come-first-served frames** made each tab's history random. Now tab `k` draws frames `k, k+W, k+2W…`.
   4 runs then matched — but after big-word-punch was retimed, 2 of 8 runs differed again on one frame, with
   identical tab history.
3. **`translate3d()` in `RC.set`** promoted every moved element to its own compositor layer; Chrome re-rasters such a
   layer on its own schedule, so a frame captured mid-update could carry the previous raster. Per-tab browser contexts
   and one raster thread did NOT fix it (still 2 of 8). Switching `RC.set` to 2D `translate()` did: 8/8 identical
   with 4 tabs, 6/6 for ui-card-pop (which keeps real 3D tilt), and 5 more test passes. `check` flags
   `translate3d`/`translateZ`.
Kept as defence: each tab in its own browser context (no shared renderer caches) and `--num-raster-threads=1`
(cost: full-size big-word-punch 3.0 s vs 2.8 s). Still true: a **different** worker count may differ by ≤ 1/255 in a
couple of frames (in-process cache history), so `workers` is part of `inputHash`.

## 3. Test determinism with more than one tab and more than one run
The determinism test caught rule 2 only because it rendered with the default 4 tabs; a 1-tab render would have
passed and hidden it. The suite now renders twice with 4 tabs and twice with 3 tabs (with an image and 3D tilt).

## 4. Compare video frames by index, not timestamp
A PSNR check reported 22.7 dB on the punch frames; the side-by-side showed different moments. WebM stores ms
timestamps (frame 8 at 30 fps = 266.67 ms → 267 ms) so `overlay`/`psnr` paired frame 8 with frame 7. Re-time both
inputs with `setpts=N/30/TB` first: the real figure was 42.4 dB.

## 5. FFmpeg drops VP9 alpha unless you force libvpx
FFmpeg's native vp9 decoder ignores the alpha side data; `ffprobe` shows `yuv420p` even for an alpha WebM. Put
`-c:v libvpx-vp9` before `-i` (decode → `yuva420p`). `src/ffmpeg.ts` `decoderArgs()` does it for `.webm`.

## 6. Re-measure "known" facts from other projects before paying for them
HyperFrames captures with `optimizeForSpeed: false` because the fast path "crushes real alpha values". Here the fast
path gave pixel-identical RGBA on 4 real frames, a 50 % fill (alpha 128 both ways) and a gradient (256 alpha levels
both ways), and saves ~20 ms a frame. Default is fast; `RESTORFFCUT_CAPTURE=safe` reverts; a test re-checks each run.

## 7. VP9 `-deadline realtime -cpu-used 8` is the right default for overlays
`good`/`cpu-used 4` took 5.2 s for 90 frames, `realtime`/`cpu-used 8` 1.3 s, same composited PSNR (42.39 vs 42.42 dB),
18 % larger file. Lower CRF (24, 18) barely changed quality — the limit is 4:2:0 chroma and alpha residual, not
quantisation. Encode time had been half the render.

## 8. Overshoot easing on a long trip collides with neighbours: bounce in scale, travel without overshoot
`ui-card-pop` flew 1,440 px with `bouncy`; the ~10 % overshoot carried the card ~140 px past rest, over its caption
chip (SEEN at 0.57 s). Travel now uses `snappy`; the bounce lives in `scale`.

## 9. Overlapping tilted cards need room for both tilts
`headline-wall` stepped cards at 0.78 × height; neighbours tilted opposite ways hid the second line of each headline
(SEEN twice: 0.9 × was still not enough). Step = 0.94 × height + ½ × width × sin(fan).

## 10. Fit caption groups to one line before letting them wrap
`word-pop` at 96 px wrapped "COLD BREW / THAT", stranding a word (SEEN). Groups now shrink to fit the safe width
(down to 62 %), and only wrap below that.

## 11. Shell traps on this machine
- `py -I` hides user site-packages (fontTools lives there): use `py -P` to keep the cwd off `sys.path` instead.
- Git Bash does not convert `/c/...` paths that contain `[` `]` for native programs: rename such files first.
- A `sed` replacement containing `\` did not apply (README line stayed unchanged): use the Edit tool for anything
  with a backslash (restorff-apps/AGENTS.md rule 9).
- `bc` is not installed in Git Bash; use `time ( … )`.

## 12. `bun add` with Bun 1.2.18 rewrites a lockfile written by a newer Bun
It dropped `configVersion` and bumped `@types/bun` 1.3.13 → 1.4.3 as a side effect of adding one package. Diff
`bun.lock` (with `--strip-trailing-cr`) after every `bun add` and report the side effects.

## 13. A sample-size limit needs a units decision
"< 2 MB": headline-wall came out at 2,008,626 bytes — under 2 MiB, over 2,000,000. The `samples` command uses the
stricter decimal limit and steps CRF until it fits.

## 14. Untrusted composition code: sandbox at run time, not only by reading the source
A static check can be dodged (`window["fe" + "tch"]`, a URL built from parts), and the library renderer opens pages
as `file://` with `--allow-file-access-from-files`, so a custom page could have drawn any local file into the video
(`<img src="file:///…">`, a relative `src`). Custom pages are now loaded from a `data:` URL (origin `null`), every
request is blocked twice (blocked-URL list + Fetch interception) and Chromium sits behind a dead proxy with DNS off.
MEASURED 2026-10-20 with a live local server: fetch, XHR, WebSocket and two `<img>` reached nothing (0 hits) and every
attempt was recorded. `test/custom.test.ts` re-checks it with an obfuscated fetch on every run.

## 15. `RC.fitText` must measure an inline element
perspective-grid's title came out at the 80 px floor (SEEN on the contact sheet): `fitText` was given a block row
whose `scrollWidth` is the row's full width, so it always "overflowed". Fit an `inline-block` span inside the row.

## 16. A mask that clips one edge only also decides where an exit may go
kinetic-type's last frame still showed words (SEEN): each line clips only its bottom edge, and the exit moved words
up, out of the clip. Exit back through the clipped edge (down), or clip both edges.

## 17. Block networks by scheme, not with `*`: `*` also blocks `data:`
The warm-moody recreation's custom thumbnails refused to render ("image params fail to decode", call #59), and a probe
on 2026-10-20 showed both an inline `<img src="data:…">` and a `data:` image param "failed to load" (SEEN).
`Network.setBlockedURLs ["*"]` + `Fetch.enable "*"` catch `data:` too. Now one pattern per scheme that can leave the
page (`BLOCKED_SCHEMES`), and a paused `data:`/`blob:` request is continued; the live-server test still sees 0 hits.

## 18. Example props are display copy: an apply must never inherit them
The effects-library recreation applied Doodle Boil and Headline Wall without text: `effects apply` merged the
catalogue's `example` (the props file) under the caller's params, so "small batch" was scrawled across the speaker's
eyes and invented press headlines appeared (a claims problem). The manifest default of Doodle Boil's `word` was
already `""`: the leak was the props file. Rule: the catalogue's `example` carries no display params, `params` show no
copy, and an applied render either blanks optional words or answers `needs` (CONTRACT §2c). Mark the main word of
every new composition `"required": true`.

## 19. On Windows, send non-ASCII request bodies from a file, not a shell argument
`curl -d "$JSON"` from Git Bash turned `·` into `�` in four dev-server renders (SEEN in their contact sheets); the
same props sent with `--data-binary @body.json` arrived as U+00B7 (MEASURED from the answer's params). Windows
converts command-line arguments to the ANSI code page.

## 20. Never hand a composition's path to `bun` directly
A command line meant to render with `bun src/cli.ts render <file>` ran `bun <file>.html` instead: Bun serves an HTML
file (`url: http://localhost:3000/`) and the step hung until `timeout 200` ended it. Always go through the CLI.

## 21. Fit-to-duration needs each piece's clock split by meaning
"Compress the timeline" sounds like one switch, but UI World's panel slide must stay on real time (the clip's plate
keys are real seconds), its callouts follow the voice, and only the clips, tag and typing are choreography. So:
choreography on `time.t`; voice cues on `T` through `RC.cue` + `RC.since`; plate-key-matched and ambient motion on
`T`. Check every new piece with a 1 s render: every beat must still show.

## 22. A style is replicable only when its code holds no story (composition-v3, 2026-10-21)
The Sonnet replay of the neon-grid video had to read and rename all six sources (five timing constants in
`hook-hours`, a 19.55 in `paper-form`, `eighteenAt`, "[ ] A — HOT, 4 MIN"…) to make the same video for another
product. Rule: every on-screen word and every story time is a param with a neutral name; items time themselves from
the voice's `words` (CONTRACT §9f); camera and ambient motion stay relative to the clip. Enforced for the neon-grid
kit by `test/composition-v3.test.ts` (no on-screen word of either example product in a piece's code).

## 23. In an applied render, an OBJECT param that holds text is always required
`blankOf` has no blank for an object, so `isRequired` is true for `{text, at}`-style objects: an `effects apply` that
leaves one out answers `needs`. Found while designing the neon pieces (before shipping): optional words are a plain
`string` (blank = off) plus a numeric `…At` (-1 = from the voice); objects only for what the piece cannot do without
(`ruler`, `curve`, `dial`, `form`).

## 24. A `t0` piece's example props must be clip-local
The catalogue's `example` (the props file minus display params) is merged under an apply's params, so an example
`t0: 3.2` would shift every beat of another product's clip by 3.2 s. The neon pieces' props files carry `t0: 0` and
the voice words moved to the clip; plans with timeline times live in `examples/neon-grid/`. `composition write
{library}` fills `t0` from `t`; `effects apply` does not (README "The neon-grid kit", known failures).

## 25. `fitText` on a fixed-width box always shrinks
A box with `width` set reports `scrollWidth >= clientWidth`, so `RC.fitText(box, box width - padding)` "overflows" every
time and walks the font down 20 px (caught reading neon-form before its first render). Measure an inline-block span
inside the box and give the box the size it returns (same root cause as §15).

## 26. A "no story words in code" test must use on-screen strings only
The first version took every word of both voice-overs: 9 of 24 tests failed on "time", "min", "smooth", "out" — code
vocabulary (`render(time)`, `Math.min`, the `smooth` easing). Collect only the strings a piece draws (skip the voice's
word list, `word` anchors, caption `keys`, enum values) and keep an explicit, commented allowlist for real collisions.

## 27. The renderer has WebGL2 only; WebGL1 is null (scout, 2026-10-24)
With `src/cdp.ts`'s `--disable-gpu`, `getContext("webgl2")` gives ANGLE on SwiftShader and `getContext("webgl")` gives
**null** (MEASURED, probe page). GLSL ES 1.00 shaders still compile in a WebGL2 context, so old WebGL1 shader code
works once the context call asks for `webgl2`. Renders are deterministic (identical `framesHash` twice) but slow for
heavy fragment shaders: Paper's grain-gradient took 12–15 s per output second at 1080×1920. Put the cost in the
technique record.

## 28. A transition shader can paint opaque black over transparent input (scout, 2026-10-24)
gl-transitions' `burn` adds `vec4(…, 1.0)` to its inputs and `cube` draws an opaque black floor, so with a
transparent "from" picture (our cover-a-cut overlay) the first and last frames were solid black (SEEN): over a video
that blacks the picture out. Before offering a shader in overlay use, render it in that mode and look at frame 0 and
the last frame; `gl-transition` now refuses those ids outside `images` mode.

## 29. A child's `visibility: visible` beats a hidden parent (scout, 2026-10-24)
caption-fx hid inactive caption groups with `visibility: hidden` on the group; the redact and scramble styles set
`visibility: visible` on words inside it, so earlier groups stayed on screen under the current one (SEEN, overlapping
text). Hide whole groups with `display: none` (measure layout in `build` first, while they are displayed).

## 30. Compute "next item" fields in a second pass (scout, 2026-10-24)
caption-fx set each group's `end` from the next group's `start` inside the same loop that set `start`, so every group
but the last had `end = NaN` and never showed (SEEN: only the last group rendered; found with a debug overlay that
printed the groups into the frame). Two passes: first the item's own fields, then those that read neighbours.

## 31. A key word coloured for its box must stay light until the box is under it (hf-skills, 2026-10-24)
The worked example's key word was ink-dark from its first frame while its accent box was still sweeping in: on a dark
plate the word was invisible for ~0.3 s (SEEN on a contact sheet with `look --plate #3a3a40`; a sheet flattened on
white hid it). Mix the colour from light to dark only as the box covers it (`composition-example`). The Sonnet
client that read the playbook did this; the one without it did not hit the case. Look at alpha renders on a dark
plate, never on white.

## 32. A required list param still needs a non-empty default (hf-skills, 2026-10-24)
`"beats": {"type": "list", "minItems": 1, "required": true, "default": []}` is refused at validation ("needs at least
1 items"): every top-level param's default must itself be valid. Give one example item; an applied render blanks
display params the request did not send anyway.

## 33. A client reads the playbook its tool names, not the ones beside it (hf-skills, 2026-10-24)
In the Sonnet A/B (`tools/mcp-test` case `kinetic-type-guide`) the client read only `guide composition-authoring`
(named in the composition tool's description) and broke rules that live in `pacing-retention` and
`typography-layout` (last line held ~1 s, a full-frame gradient, a 28 px kicker). Put the few cross-topic checks that
fail most into the playbook each tool points at; don't rely on the client opening a second topic.

## 34. Copy a closed API by observing it, never by reading it: a black-box oracle (anim-runtime, 2026-10-24)
GSAP may not be shipped or read (DECISION.md), yet its exact behaviour decides whether 174 HyperFrames blocks look
right. Memory of "how GSAP works" was wrong four times in one session: `seek()` suppresses onUpdate too; from()/fromTo()
render lazily on the next tick; `steps(4)` at 0.2 is 0.25 (floor of p x (n+1), not p x n); `expo.in(0.5)` is 0.0234,
not 2^-5. Rule: install the real library in the scratchpad only, run the same tiny page against it and against ours
(`src/gsap-compat/README.md` "The oracle"), and pin the observed numbers in tests. Never open the library's source.

## 35. A child the playhead lands on exactly must still render (anim-runtime, 2026-10-24)
transitions-push showed scene B where GSAP showed scene A at t = 9.000 s: a `fromTo` starting at exactly 9 s puts its
start state back over an earlier `set()` the moment the playhead reaches it, and our "nothing changed at local time 0"
shortcut skipped it. A child whose start lies in (previous time, time] renders even at local time 0. Seek frames
land on whole-number times often (9 s = frame 270 at 30 fps), so exact-boundary cases are common, not rare.

## 36. Fit a rule to many observations, not to the one case in front of you (anim-runtime, 2026-10-24)
Four blocks (reddit-post, code-scroll, instagram-follow, tiktok-follow) ended ~227 px too low: GSAP reads CSS centring
`translate(-50%, -50%)` back as yPercent -50 and ours did not (we compared with `offsetHeight / 2` within 0.01 px). The
first fix — the exact border box — fixed those four and broke x-post, where real GSAP does NOT centre. Probing 30
heights (`oracle/probes/centring.js`, `centring2.js`) gave the rule that fits all of them: -50 % when
`round(offsetSize / 2) === round(-translation)`, the remainder kept in x/y (a 100.45 px box centres, a 100.5 px box,
offsetHeight 101, does not). Rule: when one case disagrees, probe a sweep and fit every point before changing code.

## 37. An SVG element's CSS transform-origin is an offset from its bbox corner in GSAP's maths (anim-runtime, 2026-10-24)
logo-outro's pieces (`transform-origin: center center` on SVG paths) scaled about the wrong point. Observed: GSAP reads
the computed origin in px (a 400x300 viewBox makes "center" 200px 150px) and adds it to the bbox corner, then writes
`transform-origin: 0px 0px` and folds the origin into the `transform` matrix. Probe `svgorigin.js` pins four cases.

## 38. WebGL 1 is available; a canvas that already has a WebGL 2 context returns null for "webgl" (anim-runtime, 2026-10-24)
MEASURED with the renderer's flags (library and network-blocked): on a fresh canvas `getContext("webgl")` and
`getContext("webgl2")` both give ANGLE on SwiftShader; asking the same canvas for "webgl" after "webgl2" gives null.
Section 27's "WebGL1 is null" came from a probe that asks for "webgl" only when "webgl2" failed (READ:
%TEMP%/restorffcut-scout/probe/webgl-probe.html, `if (!gl2) gl1 = ...`), so "webgl1: false" meant "not tried". Probe each
context type on its own canvas. Three.js r147 (WebGL1 fallback) and 0.184 both render (test/gsap-compat.test.ts).
