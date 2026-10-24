---
id: typography-layout
title: Type, layout and legibility
summary: Type sizes and floors, safe areas on 9:16, the density contract (one focal element), what survives video compression, text over footage, cards and picture-in-picture over a talking head, fitting text, and the layouts that look generated.
read_when: Before placing any text or card, and when a frame looks empty, crowded, unreadable or cut off.
aliases: typography, type, layout, text, legibility, safe-area, safe-areas, cards, lower-third, overlays, contrast, fonts
tools: composition, timeline_ops, captions, effects
related: look-and-style, captions, motion, video-types
next: composition contract | The live contract lists the bundled fonts, RC.safe and RC.fitText.
source: skills/hyperframes/references/{overlays,captions,look,spec}.md; references/types/{vertical,launch}.md; docs/prompting/{visual-specs,design-systems,overlays-and-lower-thirds}.mdx; docs/guides/{claude-design-hyperframes,open-design-hyperframes}.md; skills/hyperframes-registry/references/placeholder-material.md; skills/slideshow/references/standalone-harness.md; skills/hyperframes-cli/references/lint-validate-inspect.md
---
# Type, layout and legibility

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/references/{overlays,captions,look,spec,types/vertical,types/launch}.md, docs/prompting/{visual-specs,design-systems,overlays-and-lower-thirds}.mdx, docs/guides/{claude-design-hyperframes,open-design-hyperframes}.md, skills/hyperframes-registry/references/placeholder-material.md @fa5dbd1; modified for RestorffCut.

## Sizes
All sizes on the 1080 grid (`RC.u` = short side / 1080; multiply every px by it).
- **Floor: 36 px** for anything meant to be read (our contract; the source's own floor is 28 px = 2.6 % of the short
  side). Labels ≥ 36, body ≥ 40, headlines ≥ 60, titles 4–9 % of the frame height (77–173 px on 1920).
- **Display type** about 1/10 of the frame width per character height or more; hero words fill 60–90 % of the width.
- Weight contrast carries hierarchy (900 against 400–500), not five sizes. Numbers in `font-variant-numeric:
  tabular-nums` so a count does not jitter.
- Portrait type is landscape × 1.3 (titles × 1.35, stats × 1.4); padding drops from 40–64 px to 24–36 px.
- Too many words: cut words, never shrink type below the floor. A vertical claim takes about 5 English words a line.
- Bundled faces resolve by name and load before frame 0: **Archivo** (display: 800–900, `font-stretch: 125%`,
  uppercase, tracking .14em for labels), **JetBrains Mono** (numbers, pills, chrome), **Instrument Serif** (editorial).
  Any other face is UNVERIFIED in a render (a `data:` `@font-face` inside the 256 KB limit may arrive after frame 0).

## Safe areas on 9:16
`RC.safe` (and the captions tool) keep text inside: top 11 %, bottom 21 %, left 6 %, right 12 % on 1080×1920 (211 /
403 / 65 / 130 px). Feed apps draw over more than that on some placements: keep every word and the product inside the
band from ~170 px to ~1330 px when the piece is for a feed with a bottom UI, nothing under the right-hand action rail,
only texture below 1330 px (ASSUMPTION from the source's measurements; check the placement it is for). Decoration
(frames, glows, full-bleed pictures) may cross the safe lines; text never does.

## The density contract
- **One focal element** at display scale, at least two supporting elements on their own cues, persistent chrome only
  if the look has it. The hero of a shot fills at least **40 %** of the frame's height or width: a small object in the
  middle of an empty frame is never a shot (push in, crop, or give it a world).
- Asymmetric (about 60/40) beats centred; at least 3 depth layers (ground, subject, foreground detail); at least 3
  distinct layout postures across a piece.
- A frame complete at t = 0 is a poster, not a shot: stage it. Exception: information cards (on screen in ~2.5 s,
  then held).

## What survives video compression
- Full-screen linear gradients on dark grounds band under H.264: use a radial gradient, a solid, or a solid plus a
  local glow.
- An accent at 5 % opacity disappears: 15–25 % for atmosphere, full saturation for the focal element.
- A 1 px border or a 6 % shadow from a web page vanishes: scale borders, shadows and opacities up for video. Hairlines
  that must read: at least 2 px at 1080.
- Pure #000 / #FFF grounds look cheap and clip; use near values (#0C0C0E, #EDEBE6).

## Text over footage
Every text over video needs a shadow, a stroke or a dark card. Recipes that hold:
- Caption-style stroke: 2–3 px dark stroke with `paint-order: stroke fill`, plus `0 4px 12px rgba(0,0,0,.5)`.
- A scrim sized to the text (30–40 % black), never a full-width bar.
- Bright scenes (brightness over ~180 of 255 behind the text): near-black opaque type, not white.
- Glass over bright footage goes white on white: a dark base `rgba(15,16,22,.78)` and a scrim behind it
  (`rgba(0,0,0,.55)` fading from the top, `.72` at the bottom). Smoke the glass until white text holds at least 3:1
  against its brightest area. `backdrop-filter` is costly in renders; a flat dark card often reads better.
- Text over a busy 3D or picture ground: a radial scrim on the text container (light .88 at 30 %, .6 at 65 %, 0 at 100 %
  on a light look; the dark mirror on a dark one).
Contrast: 4.5:1 for normal text, 3:1 for large (24 px+, or 19 px bold).

## Cards over a talking head
Positions on 1080×1920 (portrait) and 1920×1080:
| Layout | Portrait (x, y, w × h) | Landscape |
| --- | --- | --- |
| Split, video beside / below the card | video 0, 960, 1080 × 960 | video 960, 0, 960 × 1080 |
| Stack, video above | video 0, 0, 1080 × 844 | 14, 14, 1892 × 548 |
| Picture-in-picture of a 9:16 source | 738, 28, 312 × 555 | 1644, 28, 248 × 440 |
| Picture-in-picture of a 16:9 source | 690, 28, 360 × 203 | 1432, 28, 460 × 258 |
Card zones: a lower third is the bottom 30 % (keep above the caption line); a side panel the right 42 % (landscape)
or bottom 40 % (portrait). Cards fade in over 0.4 s (`gentle`) and out over 0.35 s (`ease-in`); re-frame the video
(0.5–0.7 s) only in a gap between cards. A static card goes dead after about 8 s; past 15 s it needs a staged reveal.
Density to start from: one card per 6–8 s under a minute, 8–12 s up to 3 min. The face is never under a card
(`cutout matte` gives the face box; effects place off it by default). Size a picture rectangle to its source's aspect.

## Fitting text
Measure in `build`, never in `render`. `RC.fitText(node, maxW, maxPx, minPx)` on an **inline-block** span (a block
measures the whole row). When a word scales up for emphasis, fit to `maxW / emphasisScale`. Centre with flex or
`text-align`, never `left: 50%; transform: translateX(-50%)` on something you also transform (it clips at the edges
and fights the animation). `overflow: visible` on text containers (hidden clips scaled words and glows). A span you
transform needs `display: inline-block`.

## Colour discipline
One ground plus one ink, and **one accent per frame** where the accent is the meaning (the key word, the number a
count lands on, the stroke being drawn). Emphasis by inversion, scale or density, never a third hue. Stand-in content
(a box where a screenshot goes) carries no hue: ink at 72 % (subject), 45 % (support), 18 % (media fill, skeleton
lines), 8 % (recessed plates), 14 % for 1 px hairlines; text never below the 72 % step. Shadows achromatic and
diffuse (`0 Npx 3Npx rgba(0,0,0,.18)`), never a coloured glow standing in for an accent.

## Layouts that look generated
Three cards in a row; KPI grids; a title over a dimmed screenshot; everything centred; corner labels, frame borders,
corner brackets and HUD readouts as decoration; numbered "01 / 02" labels and small mono caps everywhere; a left
accent stripe on every card; identical card grids; a logo docked in a corner; a small window floating in an empty
canvas; product UI tilted into 3D.
