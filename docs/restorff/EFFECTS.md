# RestorffCut — effects catalogue (from the reference reels, 2026-10-20)

Every effect the owner's five reference reels show, described from the frames (SEEN), with how RestorffCut builds it.
Evidence and timings: `../../../spikes/s6-reference-reels/FINDINGS.md`. Requirements that use this file: EDT-17
(effects library), EDT-12 (captions), EDT-15 (compositions), EDT-22 (person matte) in `../../../plan/04-requirements.md`
and `REELS.md`. The reels are third-party and never ship; examples here use the fictional brand **Halcyon Cold Brew**.

## How to read an entry

- **Seen** — what the reel shows, with reel id and seconds, so anyone can open the same frames.
- **Layers** — bottom to top. `plate` = the source video; `subject` = the speaker cut out by the person matte.
- **Inputs** — what the effect needs from the user or from Claude (strings, numbers, images, a matte, word timings).
- **Params** — what the preset exposes, with defaults taken from the reel.
- **Build** — one or more of the three build paths below.
- **Accept** — the check that says it's done: render the Halcyon fixture with the effect and compare it side by side
  with the named reel seconds; every bullet must hold. (The reels are used for that internal comparison only.)

### The three build paths

| Code | Path | Use it for | Where it lives |
|---|---|---|---|
| **S** | **Shader / compositor** — per-pixel work in the Rust → WebAssembly `wgpu` compositor | anything that reads or rewrites video pixels: grades, blurs, keys, matte edges, refraction, halftone, paper texture | `rust/**` (rust agent); runs in the browser preview and the server render alike |
| **C** | **Composition** — HTML/CSS/JS with a seekable timeline (GSAP etc.), rendered frame-exact to an **alpha video** (WebM VP9 `yuva420p` or ProRes 4444), HyperFrames-style; placed on an overlay track | UI cards, type, charts, lists, maps, collage pieces, anything that is "design" rather than "pixels" | `packages/compositions/**` (compositions agent); server render via headless Chrome; preview as a live DOM layer (ASSUMPTION, to be proven) |
| **O** | **Timeline ops** — what the editor already has: transform keyframes (position, scale, rotation, opacity) with bezier easing and a graph editor, masks (rectangle, ellipse, split, cinematic bars, text, heart, star, diamond, freeform; feather, invert), the blur effect, retime/speed, text and subtitle elements, track order | moves, punch-ins, layering, cuts, simple wipes | `apps/web/src/{animation,masks,effects,retime,subtitles}` (read 2026-10-20) — driven through `ops@1` (B7) |

Most effects are a mix: e.g. Couch Wall = **C** (the wall) + **O** (track order) + the person matte.

### Platform capabilities the effects share (build once)

| Id | Capability | Needed by | Build |
|---|---|---|---|
| **M** | **Person matte** — a per-frame alpha of the speaker for every A-roll clip, cached as a matte track | 11 entries: FX-01, 02, 04, 08, 12, 13, 14, 15, 16, 17 (when letters pass behind), 43 | S (inference: a video segmentation model, server side, cached; ASSUMPTION which model) |
| **F** | **Face box** — per-frame face rectangle | caption placement, "never cover the face" check, zoom targets | S (detector, server side) |
| **W** | **Word timings** — the transcript with per-word start/end | captions, every "on the word" trigger | already in TVF (faster-whisper large-v3); RestorffCut import |
| **P** | **Planar track** — 4 corners of a held rectangle per frame | screen replacement (the held card in `Def9pj5TWtA`) | S (later; not in the first library) |
| **A** | **Alpha composition layer** — a track that holds a rendered composition with alpha and its source | every **C** effect | C + O |

---

## Status (2026-10-20, collage-fx agent; the same rows as `apps/web/src/compositions/effects-catalogue.ts`)

`ready` = renders today from the named composition, shader or editor feature; `partial` = part of the look; `coming`
= not built. Matte effects are compositions rendered as layers around the clip's person cutout (editor: Cut out
person; MCP: `cutout`): each composition's manifest has an `effect` block with the stack (bottom → top), the inputs and
any transform keys the clip needs. How to check one end to end over a fictional stand-in subject:
`packages/compositions/examples/collage-fx/stack.ts` (runbook: `worklog/collage-fx.md`).

**library-v2 (2026-10-21):** FX-29, 33, 34, 36, 50, 51 are now compositions in `packages/compositions` (rows below).
Their rows in `apps/web/src/compositions/effects-catalogue.ts` still say `coming`, so `effects list` shows them as
`partial` with `uses: composition …` (MEASURED over MCP) until that file's owner flips each row to `available` +
`comp("…")`. A table of contents list (no FX id, effects-library recreation) is `comp:toc-list`, `ready`.

| Id | Effect | Status | Built as |
|---|---|---|---|
| FX-01 | Orbit | ready | composition `orbit` |
| FX-02 | Couch Wall | ready | composition `couch-wall` |
| FX-03 | UI World | ready | composition `ui-world` |
| FX-04 | Frame Break | ready | composition `frame-break` |
| FX-05 | Digital Zoom | ready | shader `restorff-digital-zoom` |
| FX-06 | Phone Mockup | ready | composition `phone-mockup` |
| FX-07 | Checklist | ready | composition `checklist` |
| FX-08 | Headline Wall | ready | composition `headline-wall` |
| FX-09 | Zoom Through Cut | ready | editor: Transitions tab → Zoom through (zoom-in) |
| FX-10 | Chart Grow | ready | composition `chart-grow` |
| FX-11 | Pullback Reveal | ready | composition `pullback-window` |
| FX-12 | Green Screen | ready | composition `green-screen` |
| FX-13 | Paper Cut | ready | composition `paper-cut` |
| FX-14 | Doodle Boil | ready | composition `doodle-boil` |
| FX-15 | Vertigo | ready | composition `vertigo` |
| FX-16 | Cover Story | ready | composition `cover-story` |
| FX-17 | Glass Type | ready | composition `glass-type` |
| FX-18 | Word-chunk captions (clean) | ready | editor: Captions tab + Talking head style |
| FX-19 | Emphasis line with drawn underline | ready | composition `emphasis-underline` |
| FX-20 | Karaoke boxed captions | partial | composition `word-pop` |
| FX-21 | Mixed-type caption stack | ready | composition `caption-stack` |
| FX-22 | Big-word punch | ready | composition `big-word-punch` |
| FX-23 | Ignite-then-cool kinetic type | ready | composition `ignite-type` |
| FX-24 | Type-on title | ready | composition `type-on` |
| FX-25 | Strike-through | ready | composition `strike` |
| FX-26 | Rubber stamp | ready | composition `stamp` |
| FX-27 | UI card pop-in | ready | composition `ui-card-pop` |
| FX-28 | Badge pills | ready | composition `badge-pills` |
| FX-29 | Glass panel overlay grammar | ready (package) | composition `glass-panel-kit` (11 widgets) |
| FX-30 | Typed prompt box / chat | ready | composition `prompt-box` |
| FX-31 | Chips that tick | partial | composition `checklist` |
| FX-32 | Counter / flip-clock | ready | composition `counter` |
| FX-33 | Waveform with collapsing gaps | ready (package) | composition `waveform-collapse` (gaps from the real cut list) |
| FX-34 | Filmstrip + flash + scan | ready (package) | composition `filmstrip-flash` (real frames optional) |
| FX-35 | Social CTA overlays | ready | composition `cta-social` |
| FX-36 | Before/after wipe | ready (package) | composition `before-after-wipe` (a still of the before over the graded clip) |
| FX-37 | Grade by wipe | coming | — |
| FX-38 | Warm grade | ready | shader `restorff-grade` |
| FX-39 | Moody grade | partial | shader `restorff-grade` |
| FX-40 | Whip / blur transition | ready | editor: Transitions tab |
| FX-41 | Zoom-blur exit | coming | — |
| FX-42 | Floating thumbnails | ready | composition `float-thumbs` (`images`: real covers) |
| FX-43 | Text behind subject | coming | — |
| FX-44 | Collage grid | coming | — |
| FX-45 | Recursive picture-in-picture | coming | — |
| FX-46 | Storyboard document | coming | — |
| FX-47 | Comment thread card | coming | — |
| FX-48 | Kinetic type on a 3D grid | ready | composition `neon-grid` |
| FX-49 | Flowchart with travelling spark | ready | composition `flow-spark` |
| FX-50 | Easing-curve explainer | ready (package) | composition `easing-curve` |
| FX-51 | Paper form look | ready (package) | composition `paper-form` (sheet or card) |
| FX-52 | Paper cut-out with red outline | ready | composition `cutout-outline` |
| FX-53 | Old-paper and map backgrounds | ready | composition `paper-texture` |
| FX-54 | Map with route and city pins | ready | composition `map-route` |
| FX-55 | Retro TV frame | ready | composition `retro-tv` |
| FX-56 | Halftone portrait push-in | ready | composition `halftone-push` |
| FX-57 | Triptych panels | ready | composition `triptych` |
| FX-58 | Thread timeline with pinned cards | ready | composition `thread-timeline` |
| FX-59 | Label tags | partial | composition `map-route` |
| FX-60 | Letter tiles and cracking sign | partial | composition `paper-cut` |
| FX-61 | Side-scrolling parallax strip | ready | composition `parallax-strip` |
| FX-62 | Split-screen hook | coming | — |

42 ready · 6 partial · 14 coming (of 62). Was 24 · 16 · 22 before the collage-fx pass (MEASURED in the last checkpoint
commit's catalogue; the brief's 22 · 15 · 25 predates the grade agent). The S paths written below for
FX-12/13/14/15/17/52/53/56 were built as compositions instead (SVG filters and canvas in the page, no Rust): see each
composition's description.

---

## Part 1 — the 17 named effects in `Def9pj5TWtA`

Each demo lasts about 1 s inside a held card (FINDINGS.md §4 has the windows). Timings below are from the card crops
(6 fps; 30 fps for #11; 10 fps for #15).

### FX-01 · Orbit · `orbit`
- **Seen** (0.0–0.6 s): five or six phone-shaped reel thumbnails circle the speaker on a tilted ring; on the far side
  they pass **behind** him, on the near side **in front**. Small white line "and you can get the" + gold script
  "cool girl" with sparkle glints, top third.
- **Layers**: plate → ring back half (C) → subject (M) → ring front half (C) → caption.
- **Inputs**: 4–8 images (e.g. Halcyon's last eight product shots), the subject matte.
- **Params**: card count 6, ring radius 0.32 × frame width, tilt 15°, period 4 s per turn, card size 9 % of width,
  centre = face box centre, drop shadow on.
- **Build**: C renders the ring twice per frame (back half, front half) as two alpha layers; O stacks them around M.
- **Accept** (vs `Def9pj5TWtA` 0.0–0.6 s): within 1 s at least one card is hidden by the head/body and at least one
  overlaps it in front; no card touches the face box; cards keep 9:16; motion is continuous (no frame jumps).

### FX-02 · Couch Wall · `couch-wall`
- **Seen** (0.7–1.4 s): a grid of reel thumbnails with view counts (1.07M, 534K, 133K…) fills the wall **behind** him;
  he stays in front. Caption "selling a" + heavy "course" (white, heavy rounded sans).
- **Layers**: plate → wall grid (C) → subject (M) → caption.
- **Inputs**: 6–15 images with optional labels (Halcyon: "1.2M · cold-brew pour", …), matte.
- **Params**: rows 3, columns 3–4, gutter 1 %, tile build-in stagger 60 ms, perspective match (none / auto from 4 points).
- **Build**: C (grid with stagger) + O (track order) + M.
- **Accept** (vs 0.7–1.4 s): tiles appear one after another within 0.5 s; the subject's head and shoulders cover the
  tiles behind them with a clean edge (no halo wider than 3 px at 1080 p); tiles never cover the subject.

### FX-03 · UI World · `ui-world`
- **Seen** (1.5–2.4 s): the top half becomes a light chat app (Claude-style input box on cream); clip thumbnails
  **fly into the input box**, a yellow tag `RAW CLIPS` appears, the box types `/video-ed…`; heavy caps captions
  "DROP CLIPS", "TRIGGER THE" on the plate below.
- **Layers**: plate (bottom half, cropped) → UI panel (C) with flying thumbnails.
- **Inputs**: app chrome (our own, never a third-party brand), 3–6 thumbnails from the timeline, typed text, tag text.
- **Params**: split 50/50, typing speed 18 chars/s, fly path ease-out 0.35 s, tag colour.
- **Build**: C (UI + typing + fly-in) + O (crop/position the plate to the bottom half).
- **Accept** (vs 1.5–2.4 s): thumbnails land in the box one by one; the typed text appears character by character
  in sync with the voice; the plate's face stays fully visible.

### FX-04 · Frame Break · `frame-break`
- **Seen** (2.5–3.2 s): the picture shrinks into an inner reel frame (Instagram-style side icons and a username row),
  and his **hands and head break out past its border**.
- **Layers**: plate scaled down, masked to a rounded rect (O) → frame chrome (C) → subject from the same scaled plate,
  unmasked (M) so the parts outside the frame stay visible.
- **Inputs**: matte; chrome style (our own social-UI chrome; no real logos).
- **Params**: frame scale 0.62, corner radius 4 %, shrink time 0.3 s ease-in-out, chrome on/off.
- **Build**: O (scale + mask) + C (chrome) + M.
- **Accept** (vs 2.5–3.2 s): when a hand crosses the frame edge it is drawn over the border, not clipped; the
  background outside the frame is the dark surround, not the plate.

### FX-05 · Digital Zoom · `digital-zoom`
- **Seen** (3.3–4.2 s): a punch-in from medium to close-up on a beat; captions "or know anything about" → big
  "video" → "video **editing**" (second word yellow).
- **Layers**: plate with a scale step.
- **Inputs**: the word to punch on (W), face box (F) for the zoom centre.
- **Params**: scale 1.0 → 1.35, ramp 0 frames (cut) or 3 frames, centre = face box, hold until next sentence.
- **Build**: O (scale/position keyframes, step or 3-frame ease). Upscale filter in S if scale > 1.5.
- **Accept** (vs 3.3–4.2 s): the punch lands within ±1 frame of the word onset; the face stays inside the central
  60 % of the frame; no visible softness at 1.35×.

### FX-06 · Phone Mockup · `phone-mockup`
- **Seen** (4.3–5.2 s): a phone mockup floats beside his head, turned slightly, showing an assistant app: "Pause Ad 3,
  move the budget to Ad 1" and an **Approve** button that gets tapped (a touch dot).
- **Layers**: plate → device (C) with screen content.
- **Inputs**: screen content — a screenshot or a small UI spec (Halcyon: "Reorder: 2 cases of Oat Vanilla · Approve"),
  tap time (W).
- **Params**: side (left/right of face), rotateY 12°, scale 0.38 of frame height, float bob 2 % at 0.5 Hz, tap at word.
- **Build**: C (device + UI + tap) on an alpha layer.
- **Accept** (vs 4.3–5.2 s): device never overlaps the face box; the tap lands on a spoken word (±2 frames); the
  screen text is readable at phone size (≥ 2.2 % of frame height).

### FX-07 · Checklist · `checklist`
- **Seen** (5.3–6.1 s): a dark glass panel `• ALL YOU NEED TO DO   0 of 3`; row 1 types "Drop your clips", its circle
  fills yellow with a tick, the counter becomes `1 of 3`, a yellow progress bar grows; row 2 types "Trigger the skill".
- **Layers**: plate → panel (C).
- **Inputs**: title, 2–6 strings, tick times (W) — Halcyon: "Steep 18 hours", "Strain twice", "Pour over ice".
- **Params**: panel glass (blur 24 px, 55 % black), accent colour, counter on, typing speed.
- **Build**: C.
- **Accept** (vs 5.3–6.1 s): each row ticks on its spoken word (±2 frames); counter and bar match the ticked count;
  panel stays in the top 45 % of the frame.

### FX-08 · Headline Wall · `headline-wall`
- **Seen** (6.2–7.1 s): paper notes, headlines and post cards pin onto the wall **behind** him one by one ("Claude
  edits everyone's videos now", "Your next video editor is Claude", a search bar).
- **Layers**: plate → cards (C) → subject (M).
- **Inputs**: 4–10 short strings (or screenshots) — Halcyon: press-style lines the brand can prove; matte.
- **Params**: card styles (paper note / post card / search bar), pin-in 120 ms stagger, slight random rotation ±6°.
- **Build**: C + O (order) + M.
- **Accept** (vs 6.2–7.1 s): cards arrive one at a time; every card that overlaps the subject is hidden by them; claims
  pass the brand's claim matrix (RES-05) — no invented press quotes.

### FX-09 · Zoom Through Cut · `zoom-through`
- **Seen** (7.2–8.4 s): from a wide shot the camera rushes forward with a **radial zoom blur** through him and lands in
  the next shot (another room).
- **Layers**: transition between two clips.
- **Inputs**: the cut point.
- **Params**: duration 8 frames (4 out, 4 in), scale 1.0 → 2.2 → 1.0, radial blur strength 0.6, centre = face box.
- **Build**: S (radial blur) + O (scale ramp across the cut).
- **Accept** (vs 7.2–8.4 s): the blur is radial from the centre point; the two frames either side of the cut are
  both blurred; total length ≤ 0.35 s.

### FX-10 · Chart Grow · `chart-grow`
- **Seen** (8.5–9.3 s): axes `M T W T F S S` across the top of a close-up; a neon yellow-green line draws left to right
  with a glowing head, kinks up at F–S, and a `SCALE ↗` pill pops at the peak, timed to his rising hand.
- **Layers**: plate → chart (C).
- **Inputs**: a series (Halcyon: bottles sold Mon–Sun, 120 140 135 160 210 340 410), labels, a callout string.
- **Params**: line colour, glow, draw time 0.8 s, callout at the max point, grid on/off.
- **Build**: C (SVG path draw).
- **Accept** (vs 8.5–9.3 s): the line's head reaches the last point as the callout appears; the numbers plotted are the
  input numbers (NFR-04); the chart never crosses the face box.

### FX-11 · Pullback Reveal · `pullback-reveal`
- **Seen** (9.4–10.5 s): the shot is now inside an editor window (`test-slot.mp4 · Assistant`) on cream; a "Working on
  edit" panel ticks steps (`Transcribed 1 clip → Picked the take → Cut 3 shots → Captions added → Rendered 150 frames`);
  a render bar fills blue then green; a big serif counter runs 37 → 98 → 100 %. The pull-back move itself was not
  visible (it switches in one frame at 30 fps) — UNVERIFIED how it moves.
- **Layers**: plate scaled into a window (O) → window chrome, step list, bar, counter (C).
- **Inputs**: step strings, counter range, window title.
- **Params**: pull-back time 0.4 s ease-out (our choice, since the reel does not show it), window scale 0.55.
- **Build**: O + C.
- **Accept** (vs 9.4–10.5 s): steps tick in order; counter and bar reach 100 % together; the plate keeps playing
  (not a freeze frame) inside the window.

### FX-12 · Green Screen · `green-screen`
- **Seen** (10.6–11.5 s): he is keyed out of his room and placed over a purple-gradient scene with an app UI behind him
  (a focus timer `49:57`, a task list) and a serif line "you need **edits** / Everything else waits."
- **Layers**: background (image, video or C) → subject (M).
- **Inputs**: matte (no real green screen needed); a background.
- **Params**: edge feather 1.5 px, light wrap 0.2, colour match on/off.
- **Build**: S (matte composite, light wrap) + C (background scene).
- **Accept** (vs 10.6–11.5 s): no trace of the original room; hair edge without a halo wider than 3 px; the subject's
  colour roughly matches the new background (no grey cut-out look).

### FX-13 · Paper Cut · `paper-cut`
- **Seen** (11.6–12.4 s): he becomes a **torn-paper cut-out with a white edge** on grid paper with yellow and pink
  crayon scribbles and X marks; ransom-note letter tiles stamp in one by one "1 0 0 %", a red hand-drawn ellipse circles
  them.
- **Layers**: paper background (C) → subject with white torn border + drop shadow (S on M) → scribbles, tiles (C).
- **Inputs**: matte; a short string for the tiles ("100%").
- **Params**: border 12 px, tear noise 0.4, shadow 6 px 30 %, tile stagger 120 ms, palette.
- **Build**: S (dilate matte → torn border → shadow) + C (paper, scribbles, tiles).
- **Accept** (vs 11.6–12.4 s): the border is irregular (not a smooth stroke); tiles land one per ~0.12 s; the subject
  keeps moving (not a still).

### FX-14 · Doodle Boil · `doodle-boil`
- **Seen** (12.5–13.5 s): a white hand-drawn outline around his body that **jitters every frame** ("boil"); doodles draw
  on: a heart, a clapperboard that fills with pink hatching, a square.
- **Layers**: plate → outline (S on M) → doodles (C).
- **Inputs**: matte; doodle list (from a small built-in set).
- **Params**: outline 4 px white, boil = new noise every 2 frames (12 fps look), offset 3 px; doodle draw time 0.3 s.
- **Build**: S (matte edge + noise displacement) + C (doodles as SVG strokes).
- **Accept** (vs 12.5–13.5 s): the outline hugs the body within 6 px and visibly changes shape every 2 frames;
  doodles stay off the face box.

### FX-15 · Vertigo · `vertigo`
- **Seen** (13.6–14.6 s): a dolly-zoom — he stays the same size while the room behind (window, door frame, wall lamp)
  stretches and shifts over about 1 s. Caption "SUCK AT **DESIGN**".
- **Layers**: clean background plate scaling up (S/O) → subject at constant scale (M).
- **Inputs**: matte; a clean plate (the background with the person removed — inpainting, ASSUMPTION) or a real dolly
  shot.
- **Params**: background scale 1.0 → 1.4 over 1.0 s, ease in-out, anchor = subject centre.
- **Build**: S (inpaint + scale) + O. **Hardest in the list** — schedule last; until then, offer it only on clips shot
  with a real dolly-zoom.
- **Accept** (vs 13.6–14.6 s): subject height changes < 3 % over the move while the background scales ≥ 25 %; no
  ghost of the subject in the background.

### FX-16 · Cover Story · `cover-story`
- **Seen** (14.7–15.6 s): a huge Didone serif masthead "EDIT" builds letter by letter **behind his head** (his cap
  overlaps the letters); thin inset frame lines — a magazine cover. Same move in `DeUUFJQu8cw` 13.3–15.0 s with a
  dateline, barcode, cover lines and a round seal.
- **Layers**: plate → masthead + frame + cover lines (C) → subject (M).
- **Inputs**: masthead word (Halcyon: "STEEP"), optional dateline ("NO. 01 · OCTOBER 2026"), 1–3 cover lines.
- **Params**: masthead font (Didone), size = 90 % width, letter stagger 80 ms, overlap = subject covers 10–30 % of
  the letters, inset frame 3 %.
- **Build**: C + M.
- **Accept** (vs `Def9pj5TWtA` 14.7–15.6 s and `DeUUFJQu8cw` 13.3–15.0 s): letters appear one by one; the head
  overlaps the masthead; the masthead is still readable.

### FX-17 · Glass Type · `glass-type`
- **Seen** (15.7–16.5 s): big 3D extruded clear-glass letters "DESIGN" float on the wall behind him, refracting the room.
- **Layers**: plate → glass letters (C renders the letter shape and normals; S refracts the plate through them) →
  subject (M) if the letters pass behind him.
- **Inputs**: a word (Halcyon: "COLD"), the plate.
- **Params**: extrusion 8 %, refraction index 1.45, edge highlight, rotation drift 4°/s.
- **Build**: C (text geometry → normal + alpha pass) + S (refraction of the plate using that normal map).
- **Accept** (vs 15.7–16.5 s): the room is visibly bent through the letters (lines in the window frame shift where
  they pass behind glass); letters read correctly; no opaque fill.

---

## Part 2 — effects in the other four reels

### Captions and type

**FX-18 · Word-chunk captions (clean)** · `captions-clean` — `DeIGbZypIUb` throughout. White bold geometric sans,
sentence case with punctuation, ~3 % of frame height, one line just above the head (y ≈ 49 %), 1–5 words per chunk,
replaced on the phrase, soft shadow, no box, no highlight. **Inputs** W. **Build** O (text elements from the
transcript; the editor already builds caption text from transcription) + a chunker. **Accept**: words verbatim from the
transcript; each chunk on screen from its first word's start to the next chunk's start (±1 frame); never over the face.

**FX-19 · Emphasis line with drawn underline** · `emphasis-underline` — `DeIGbZypIUb` 11.3–12.3 s ("Not editing
anything.") and 32.4–33.9 s ("More specific. Better."). Lower third, ~5 % height, words appear one by one grey →
white, then a white underline draws under each key word left to right (~0.15 s each). **Inputs** the line, key words.
**Build** C. **Accept**: underlines start after their word appears and finish within 0.2 s; at most 4 words per line.

**FX-20 · Karaoke boxed captions** · `captions-karaoke-box` — `DeUUFJQu8cw` throughout. Serif, sentence case, on a
dark-green rectangular label box at chest height; unspoken words tinted sage, spoken words turn cream. **Inputs** W,
palette (from the footage). **Build** C (or O text with per-word colour keyframes). **Accept**: the colour change
follows each word's start (±1 frame); box width tracks the chunk.

**FX-21 · Mixed-type caption stack** · `caption-stack` — `DeUUFJQu8cw` 40.9–43.3 s. "BIGGER" (heavy sans caps on a
green box) jumps to the top, "captions." (italic serif, gold) wipes in under it, then "THAT'S JUST ONE MORE" (small
caps boxes, word by word) and "sentence." (italic serif on a bone box, larger). **Build** C. **Accept**: two typefaces,
three sizes, each block arrives on its word.

**FX-22 · Big-word punch** · `big-word` — `DeIGbZypIUb` 5.3–5.7 s ("FREE", blur-in then underline); `Def9pj5TWtA`
17.2 s ("26" big yellow), 21.6 s ("internet."); `DeBhOJ6T1Ja` 31.3–33.6 s (one huge word per beat on solid orange:
AND · THIS · IS · WHERE · GETS · CRAZY). **Inputs** the word (W). **Params** size 18–30 % of width, blur-in 0.15 s,
colour, underline on/off, background (plate / solid). **Build** C. **Accept**: appears on the word onset (±1 frame),
gone by the next phrase; one per sentence at most.

**FX-23 · Ignite-then-cool kinetic type** · `ignite-type` — `DeBhOJ6T1Ja` 3.3–5.4, 11.4–14.3, 93.0–94.3 s. Heavy
extended caps reveal left → right; each new word glows orange with bloom, then cools to white (or ice blue) over ~0.3 s.
**Build** C (+ S bloom if C's CSS glow is not enough). **Accept**: every word passes orange → white; bloom does not clip.

**FX-24 · Type-on title** · `type-on` — `DeIGbZypIUb` section titles ("Claude builds the edit", "02 Cut it"): white bold
sans, sentence case, top-left, letter by letter in ~0.3 s; also the condensed caps opener "HOW TO HAVE / CLAUDE EDIT
VIDEOS" (0–3.1 s). **Build** C. **Accept**: ≤ 0.35 s to finish; sits in the top-left safe area.

**FX-25 · Strike-through** · `strike` — `DeUUFJQu8cw` 2.9–5.3 s (red line across two app icons), 38.6–40.1 s ("open an
editing app" struck); `DeBhOJ6T1Ja` 5.4–7.8 s (orange X across a panel), 59.4 s (red hand-drawn line across a row).
**Inputs** target element. **Build** C. **Accept**: the line draws (not appears) in 0.2–0.4 s.

**FX-26 · Rubber stamp** · `stamp` — `DeUUFJQu8cw` 16.7–19.4 s ("BAD TAKE" twice), `DeBhOJ6T1Ja` 63.5 s ("NO
KEYFRAMES"), `DePNgrmToh9` 8.3 s ("GONE"). Red caps in a rough box, slams in with a 1.15 → 1.0 scale and slight rotation.
**Build** C. **Accept**: lands in ≤ 3 frames with an overshoot; ink texture visible.

### UI and data overlays

**FX-27 · UI card pop-in** · `ui-card` — `DeIGbZypIUb` 3.1–3.4 s (a white GitHub-style repo card scales and fades in
top-left with slight perspective), 12.4 s (a file card `IMG_2012.MOV` with a thumbnail and a `3:23 RAW` pill).
**Inputs** a screenshot or a card spec (title, thumbnail, pill). **Params** scale 0.92 → 1.0, 0.2 s ease-out, radius
16 px, shadow. **Build** C. **Accept**: never over the face; text legible at phone size.

**FX-28 · Badge pills** · `badges` — `DeIGbZypIUb` 4.7 s `OPEN SOURCE`, 5.0 s `APACHE-2.0`: dark pills, white mono caps,
pop in one per beat under a card. **Inputs** 1–4 strings. **Build** C. **Accept**: each pill on its word; mono caps.

**FX-29 · Glass panel + mono micro-labels + icon tiles (overlay grammar)** · `explainer-panel` — `DeIGbZypIUb`
6.4–49.5 s. Frosted dark glass (blur, ~60 % black, radius 16 px), mono uppercase labels (`ANIMATIONS`, `CLIPS`,
`INSTALLING`), white rounded app-icon tiles, one moving part per beat, 0.15 s fade between beats, top ~40 % of frame.
**Build** C (a kit, not one effect). **Accept**: a new beat every ~2 s (the reel: 25 in 49.5 s); nothing below the
speaker's eyebrows.

**FX-30 · Typed prompt box / chat** · `prompt-box` — `DeIGbZypIUb` 15.6–18.6 s (URL pill types, a chip flies into a
chat box, the box types), 24.9–30.3 s; `DeUUFJQu8cw` 5.4–10.4 s (a bone pill `TO CLAUDE` types "make it more aesthetic"
→ `• SENT` + spinner → `• DONE` ✓); `DeBhOJ6T1Ja` 16.6–31.0 s (mono prompt typed along a 3D grid). **Inputs** text,
states. **Build** C. **Accept**: typing in sync with the voice; our own chat chrome (no third-party logos).

**FX-31 · Chips that tick** · `chips-tick` — `DeIGbZypIUb` 30.7–32.3 s (four instruction chips pop in, then each gets
✓), 44.9–46.9 s (2 × 2 numbered chips). Same family as FX-07. **Build** C.

**FX-32 · Counter: count-down / flip-clock** · `counter` — `DeIGbZypIUb` 21.3–24.6 s (big `3:23 RAW` counts down,
accelerating, to `0:49` in ~2.4 s, label flips `RAW` → `CUT`, while tiles marked `MISTAKE`/`RETAKE` drop out); `DeUUFJQu8cw` 19.6–20.4 s
(split-flap green tiles `1:16` → `0:54`); `Def9pj5TWtA` #11 (serif 37 → 100 %). **Inputs** from/to (numbers or
durations — must be real, NFR-04). **Build** C. **Accept**: the end value equals the real measured value.

**FX-33 · Waveform with collapsing gaps** · `dead-space-collapse` — `DeIGbZypIUb` 8.7–9.6 s: a white waveform with gaps
labelled `DEAD`, the gaps close and the waveform becomes one block. **Inputs** the real cut list from EDT-11 (gap
positions). **Build** C. **Accept**: gap count and positions come from the actual cut list.

**FX-34 · Filmstrip + flash + scan** · `frame-check` — `DeIGbZypIUb` 34.1–39.4 s: a filmstrip builds, tiles flash white
in turn, a counter counts up to `1,484 FRAMES`, one tile gets `LOOKS OFF` → `✓ FIXED`. Doubles as the real UI of the self-check
(EDT-18). **Inputs** frames and findings from the self-check. **Build** C.

**FX-35 · Social CTA overlays** · `cta-social` — all five reels end on one: comment box typing a keyword, a DM-style
notification, a heart that fills, Follow → Following. **Build** C. Use only our own neutral UI — never a real
platform's logo or exact chrome in ads we ship.

### Looks and transitions

**FX-36 · Before/after wipe** · `before-after` — `DeUUFJQu8cw` 10.6–11.0 s: a slanted white divider with a round ‹›
handle sweeps left → right; mono `BEFORE` / `AFTER` labels; the after side is the new grade. **Inputs** two renders of
the same frames (before and after a style). **Build** S (split by an angled line) + C (handle, labels). Also a
**review tool**: the preview shows any style change this way before it's accepted (EDT-13). **Accept**: same frame
both sides; the divider moves at constant speed in ≤ 0.5 s.

**FX-37 · Grade by wipe** · `grade-wipe` — `DeUUFJQu8cw` 24.4–24.6 s: a horizontal line sweeps top → bottom and the
picture below it changes grade. **Build** S. Same machinery as FX-36.
**Status (grade agent, 2026-10-20): not yet.** The grade itself exists (FX-38); the wipe between two grades does not
(a masked second GRADE layer with a keyframed wipe would do it).

**FX-38 · Warm grade ("make it more aesthetic")** · `grade-warm` — `DeUUFJQu8cw` 10.6 s on: highlights to peach, warmer
skin, blacks lifted (soft contrast). **Build** S (curves + white balance, or a LUT). **Params** temperature +8, tint
+2, black lift 4 %, contrast −8 (starting values to tune against the reel — ASSUMPTION). **Accept**: mean hue of
the wall shifts toward orange; no clipped highlights.
**Status (grade agent, 2026-10-20): ready.** The `restorff-grade` shader, look **warm morning**
(`packages/timeline-ops/src/grades.ts`; RUST.md §6c): the Aesthetic style, "warm look" / "golden hour" in the command
bar, the inspector's Grade picker and the Effects Library row all apply it. MEASURED on a headless render of test
footage: U 124.5 → 120.4, V 130.5 → 134.0 (toward orange), YMAX unchanged (no new clipping). Not compared with the
reel's own frames side by side.

**FX-39 · Moody grade ("make it moody")** · `grade-moody` — `DeUUFJQu8cw` 24.4 s on: darker, cooler, desaturated, with
practical lights (lamp, candle) kept warm. **Build** S (exposure −0.6, saturation −30 %, cool shadows, a protected
warm-hue range). **Accept**: overall luma drops ≥ 20 %; lamp hue stays warm.
**Status (grade agent, 2026-10-20): partial.** Look **moody** (exposure −0.6, saturation −30, teal shadows, warm
highlights, vignette): MEASURED mean luma −30 % on test footage. No protected warm-hue range: lamps keep warmth only
through the warm highlight split tone (no lamp in the test footage, so UNVERIFIED).

**FX-40 · Whip / blur transition** · `whip` — `DeUUFJQu8cw` 7.6, 15.1, 22.3, 40.3, 43.4 s; `DePNgrmToh9` 15.0–21.8 s
(horizontal whip between screen recordings); `DeBhOJ6T1Ja` 16.6 s. 4–6 frames of heavy directional motion blur across
the cut. **Build** S (directional blur) + O (offset ramp). **Accept**: ≤ 0.2 s; blur direction consistent across the cut.
**Status (2026-10-20): ready.** Whip / push transitions by the media agent (RUST.md §6b, Transitions tab). The Fast UGC
style ("whip on beats", grade agent) rolls cuts onto the music's beat grid (`snap_cuts`) and whips only the cuts on a
beat, 0.2 s, alternating left / right; with no beat grid every cut whips. SEEN (headless render of test footage, 8
frames 1.85–2.08 s across a style whip): horizontal blur builds, the next shot slides in from the right in the same
direction, sharp again by 2.08 s. Not compared with the reel's own whips side by side.

**FX-41 · Zoom-blur exit** · `zoom-blur-out` — `DeBhOJ6T1Ja` 11.3 s, 52.3 s. Same shader as FX-09, one-sided.

### Layout and layering

**FX-42 · Floating thumbnails** · `float-thumbs` — `DeUUFJQu8cw` 11.4–13.1 s ("my best videos float in"): three
portrait thumbnails, slightly rotated, pop in one after another above his head and drift up. **Inputs** 2–5 images
(Halcyon: three earlier ads). **Build** C. **Accept**: none overlaps the face; drift ≤ 3 % of height per second.

**FX-43 · Text behind subject** · `text-behind` — `DeUUFJQu8cw` 0.3–2.8 s ("I DIDN'T / EDIT…" stack behind his head on
a flat green background), 25.4–26.7 s ("HUGE"), 38.6–40.1 s ("NEVER"). The general case of FX-16. **Build** C + M
(+ S to flatten the background to a colour when asked). **Accept**: the subject overlaps the word; word still readable.

**FX-44 · Collage grid** · `collage-grid` — `DeUUFJQu8cw` 27.1–28.5 s: nine portrait covers fly into a 3 × 3 grid with
the speaker's shot in the centre tile, then scatter. **Inputs** 8 images + the live clip. **Build** C + O (the live
clip placed into the centre cell). **Accept**: centre cell is the playing clip, not a still.

**FX-45 · Recursive picture-in-picture** · `droste` — `DeUUFJQu8cw` 20.6–22.1 s: the frame shrinks into a card that
contains itself, frames within frames. **Build** S (feedback/recursive sample of the previous composite) or O (3–4
nested scaled copies). **Accept**: ≥ 3 visible levels; motion continues in every level.

**FX-46 · Storyboard document** · `storyboard-doc` — `DeUUFJQu8cw` 31.9–35.2 s: a doc rises over the top half with one
row per beat (mono `01 0:00.0–0:02.8 2.8s ■ Talking head, wide`, the line in italic serif, a note, `EMPHASIS …`,
`SCORE drop 1 on 'Claude did.'`); the camera pushes in on one row. As an effect it is a C card; as a **feature** it is
EDT-14 (the real storyboard view).

**FX-47 · Comment thread card** · `comment-card` — `DeUUFJQu8cw` 36.0–38.2 s: "let's make sure this says…" → "On it.
I'll change the beat 23 caption…". C card; as a feature it is EDT-16.

### Motion design (full-screen compositions)

**FX-48 · Kinetic type on a 3D grid** · `neon-grid` — `DeBhOJ6T1Ja` 3.3–31.0 s and most of the reel: dark background,
fine perspective grid, a camera that dollies along the grid floor following a typing caret, wireframe 3D solids
(cube, pyramid, octahedron), extended caps for big words, mono for prompt text, one ember-orange accent with glow.
**Inputs** the script lines (W), accent colour. **Build** C (Three.js or CSS 3D in a composition), full frame.
**Accept**: camera moves are continuous (no jumps between lines); every spoken key word is on screen while it's said.

**FX-49 · Flowchart with travelling spark** · `flow-spark` — `DeBhOJ6T1Ja` 8.0–11.3 s and 33.7–36.9 s: three nodes,
a connector line, a spark travels it; a node gets an X and the path re-routes to a new node. **Inputs** node labels,
the route. **Build** C.

**FX-50 · Easing-curve explainer** · `curve-demo` — `DeBhOJ6T1Ja` 14.6–16.5 s and 66.6–78.6 s: a bezier curve with
handles and a dot riding it; a shape in a preview that changes with each instruction (smoother, colour, slower,
loop). **Build** C. Useful inside RestorffCut's own help, not only in ads.

**FX-51 · Paper form look** · `paper-form` — `DeBhOJ6T1Ja` 53.6–63.9 s and 82.0–87.6 s: a white "FORM 2-B" sheet with
mono boxes and arrows that type, a red hand-drawn strike, a stamp, tick-boxes. **Build** C. Shows that one piece may
switch looks mid-way when the preset declares both.

### Collage / explainer kit (`DePNgrmToh9`)

**FX-52 · Paper cut-out with red outline + drop shadow** · `cutout-red` — 0.0–2.1 s and 6.9–10.4 s: photo cut-outs
(train, rickshaw, buildings, coffee set, stamps, a goat, a ship) with a **thick red outline** and a soft drop shadow,
sliding and popping in and out with slight parallax. **Inputs** images with alpha (or a matte for each; S can cut
them out), outline colour. **Params** outline 10 px #C8352B (to tune), shadow 8 px 35 %, entrance slide 0.25 s with
6° rotation settle. **Build** S (outline from alpha: dilate + fill) + C (layout and motion). **Accept**: outline is even
around complex shapes; pieces move at different speeds (parallax).

**FX-53 · Old-paper and map backgrounds** · `paper-bg` — old paper with faint route lines and a label tag
("Bengaluru" + yellow tag), mustard textured paper (3.3–4.4 s). **Build** S (paper texture, gentle flicker as if
scanned) or C (image + CSS blend). **Accept**: texture visible but text on top stays readable.

**FX-54 · Map with route and city pins** · `map-route` — 2.1–3.3 s: a flat yellow-land / blue-sea map, a red dotted route
draws from MUMBAI to ROTTERDAM, black caps label tags pop at each end. **Inputs** two or more places (names +
coordinates), map style. **Build** C (SVG map + path draw). Halcyon example: farm → roastery → café. **Accept**: the
route draws in the direction of travel; labels never collide.

**FX-55 · Retro TV frame** · `retro-tv` — 3.3–4.4 s: a wooden 1950s TV set slides in from the right playing footage in
its screen; a label tag; colour chips. **Inputs** a clip for the screen. **Build** C (TV art with a screen hole) + O
(clip placed and masked into the screen) + S (scanlines/curvature optional). **Accept**: the clip plays inside the
screen with the corners masked.

**FX-56 · Halftone portrait push-in with a match-cut** · `halftone-push` — 4.4–6.8 s: a halftone black-and-white photo,
slow push-in to one eye; the iris becomes a spinning vinyl record. **Inputs** an image, a match object. **Build** S
(halftone) + O (push-in) + C (the match object). **Accept**: the push is smooth; the match object aligns with the eye
within 2 % of frame.

**FX-57 · Triptych panels** · `triptych` — 6.9–10.4 s: three stacked 16:9 panels, each its own mini-scene, on black,
with a mono boxed caption on the seams. **Build** O (three scaled tracks) + C (per-panel scenes). **Accept**: each panel
keeps 16:9; captions sit on a seam, never over a panel's subject.

**FX-58 · Thread timeline with pinned cards** · `thread-timeline` — 9.7–10.4 s: "c. 850" and "1650s" cards pinned on a
red thread with a legend tag. **Inputs** dated items. **Build** C.

**FX-59 · Label tags** · `label-tag` — throughout: small yellow tags with black mono caps ("THE LOUVRE · AUGUST 21,
1911"), cream torn-paper tags in Claude's v3. **Build** C. **Accept**: one tag per object; the date/fact comes from the
script's sources.

**FX-60 · Letter tiles and cracking sign** · `letter-tiles` — 11.2–12.2 s: a wooden sign zooms, cracks apart, and
becomes red/orange letter tiles over a town-silhouette strip. **Build** C (+ S for the crack). 

**FX-61 · Side-scrolling parallax strip** · `parallax-strip` — 12.2–14.1 s: a goat cut-out on a skateboard rides past
red post boxes and benches in front of a black town silhouette; layers move at different speeds. **Inputs** 3–6
cut-outs, a skyline. **Build** C. **Accept**: ≥ 3 depth layers at distinct speeds.

**FX-62 · Split-screen hook** · `split-hook` — 0.0–4.4 s: top half a 16:9 demo, bottom half the speaker, a title on the
seam ("Vox-Style / collage animations" in the reel). **Build** O (two tracks, cropped) + C (title). **Accept**: the
seam title never covers the speaker's face.

---

## Build order (proposal for the compositions, rust and ops agents)

1. **Platform first:** W (import word timings), A (alpha composition track), M (person matte) — 11 effects wait on M.
2. **Talking-head pack (M1/M2, no matte):** FX-18, 19, 22, 24, 05, 07, 10, 27, 28, 29, 30, 32, 33 — this is the
   `explainer-overlay` preset (the I-1 reel) and needs only W + A.
3. **Looks pack (S):** FX-38, 39, 36/37 (before/after is also the review tool), 40, 09/41.
4. **Matte pack:** FX-12, 16/43, 02, 08, 01, 04, 13, 14.
5. **Collage kit:** FX-52 → 54, 55, 57, 59, 61, then the rest.
6. **Last:** FX-15 Vertigo (needs inpainting), FX-17 Glass Type (refraction), FX-45 Droste, P (planar track).

## Rules for every effect
- One name, one look; a preset file per effect with its params, defaults, inputs and this file's acceptance bullets.
- Every number shown on screen is a real number the user gave or we measured (NFR-04); no invented press quotes
  (FX-08), no third-party logos or platform chrome in ads we ship (FX-03, FX-04, FX-35).
- Overlays respect the face box (F): nothing covers the eyes and mouth unless the preset says so.
- Every effect renders the same in the browser preview and the server render (EDT-06).
- Anything copied from HyperFrames keeps its Apache-2.0 notice (BUILD-BRIEF §6.7).
