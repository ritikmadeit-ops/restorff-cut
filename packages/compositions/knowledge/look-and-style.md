---
id: look-and-style
title: The look and named styles
summary: Where a look comes from (brand, reference, the subject's own world), the look as numbers, the defaults banned by name, a look built from one medium, re-brandable params, and thirteen named looks with their palettes.
read_when: Before the first scene of a new piece, when the person names a style ("like a protest poster", "risograph"), or when a render looks generic.
aliases: look, style, styles, palette, colour, color, brand, design, presets, named-looks, banned, defaults, aesthetic
tools: composition, references, styles, timeline_ops
related: typography-layout, story, grade, motion
next: references study | When the person gave reference media, study it first: palette, pacing, texture, motion.
source: skills/hyperframes/references/{look,spec,story}.md; skills/hyperframes/assets/frame-presets/*/FRAME.md; docs/prompting/{design-systems,examples,storyboards}.mdx; docs/guides/{claude-design-hyperframes,open-design-hyperframes}.md
---
# The look and named styles

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/references/{look,spec,story}.md, skills/hyperframes/assets/frame-presets/*/FRAME.md, docs/prompting/{design-systems,examples,storyboards}.mdx, docs/guides/{claude-design-hyperframes,open-design-hyperframes}.md @fa5dbd1; modified for RestorffCut.

## Where the look comes from
Left alone, the same brief comes out with the same look every time, and banning that look only moves it to the next
default. Outside input breaks it, in this order: the brand's own material (its palette, faces, product, packaging),
a reference the person gave (`references add` → `references study`: palette, pacing, texture, motion), the subject's
own world (its era, its materials, where it would be shown). Settle it before the first scene, as numbers.
- **Brand values are strict**: quote hex values, faces and weights exactly; never round or invent them. Sizes,
  spacing, borders and decoration are yours to scale for video.
- **A reference gives its grammar, never its content**: shot lengths, how titles enter and leave, the transitions,
  palette roles, type scale and weight. Write the grammar down, marking what you measured apart from what you guessed.
- No brand and no reference: take the look from the subject (Halcyon Cold Brew: cold water, glass, slow time, dark
  roast, ice), not from a generic "premium dark".

## The look as numbers
Write the LOOK line before building: ground (hex, texture and its %), ink, ONE accent and where it may appear;
display face, weight, size in px, tracking; body face the same; the medium (paper and ink, photographs, product
footage, glass, clay, 3D studio) with its numbers; light and depth (shadow offset, blur and opacity; grain %;
vignette %). Then a BANNED line: the defaults below plus anything this piece must not become.

## Banned by default
Each is banned unless the brand's own material or the person's reference uses it, and then only as they use it:
- a black or dark navy void as the ground, with small elements floating in its middle;
- glow, bloom, neon, lens flares, glowing orbs and rings; floating particles as decoration;
- purple or blue gradients, mesh gradients, glass cards; purple on dark;
- a cream paper ground with a serif display, italic accent words, numbered "01 / 02" labels, small mono caps labels,
  pill chips;
- everything centred; everything fading in at once; every element fading and sliding up;
- text that moves while it is read; titles that keep drifting after they land;
- corner labels, frame borders, corner brackets, HUD readouts as decoration;
- three cards in a row, KPI grids, a title over a dimmed screenshot; the logo docked in a corner;
- emoji standing in for icons; filler claims ("10x faster", "AI-powered"); invented brand colours.
RestorffCut's own defaults (CONTRACT §7: screen #0C0C0E, bone #EDEBE6, neon #F6FF00 as the one isolate per frame,
Archivo / JetBrains Mono / Instrument Serif) are a brand: use them for RestorffCut's own pieces and as the fallback
for a demo, not as every brand's look. After the first render, name every default it used anyway, add each to the
BANNED line, and fix them first.

## A look built from one medium
A look holds together when it is the rules of one medium, not a palette. A risograph look is five parts and nothing
else: **paper** (one flat colour with a fibre noise, no gradients), **ink A** (every word that must be read and every
structural line), **ink B** (one fluorescent accent, one focus per frame), **overprint** (where inks overlap a third
colour appears, the B plate 3 px off register), **halftone** (every gradient is dots). Motion comes from the same
medium: the frame is printed plate by plate, not faded in. Write any look this way: its parts, what each may carry,
and how the medium moves (paper is cut and lifted, ink is printed, glass refracts, clay is pressed, film flickers).
A physical medium carries a piece further than effects.

## Make it re-brandable
Every colour and face a composition uses comes from params: `accent` (the standard name sentence edits use), plus
`ground`, `ink` as needed. Several compositions on one timeline share palette and helpers through the timeline kit
(`composition kit`), so one change re-renders them all in one commit.

## Named looks
Use one when the person names it (or names something close), or for a deck-like explainer. Never as the fallback for
a piece with a brand. Faces are mapped to our three bundled ones; the source's own faces are not bundled.
| Look | Ground / ink / accent | Type and rules |
| --- | --- | --- |
| catalogue-yellow (museum catalogue) | parchment #E9E5DB / indigo #1B2566 / solar yellow #F1EE2E blooms, ember #E26B4A | Instrument Serif display, hairlines, slow blooms of yellow |
| blockframe (loud neobrutalist) | off-white #FFFDF5 / black / candy pink #FE90E8, sky #C0F7FE, green #99E885, yellow #F7CB46 | Archivo 900 caps, 4 px black borders, hard 8 px offset shadows, tilted stickers |
| blue-professional (consulting restraint) | cream #FDFAE7 / ink #111111 / one cobalt #1E2BFA | Archivo 600–700, tinted cards at 4–8 % cobalt, no outlines |
| bold-poster (vintage editorial poster) | white / dark #1C1410 / tomato red #D8000F | tilted heavy display, double borders, red planes |
| broadside (protest poster) | ink-black #111111 or fire-orange #E85D26 as the whole ground / cream #F0ECE5 | giant lowercase Archivo 900 at ~13 % of the width, −4 % tracking; mono chrome in caps; flat, no radius, no shadow; one register per frame; 45–55 % empty |
| capsule (friendly editorial) | cream #F5F5F0 / ink #1A1A1A / coral #E85D4E, lime #C4D94E, sky #8BB4F7 … | every container a pill, serif display |
| cartesian (quiet catalogue) | warm stone #EDE8E0 / #1A1A1A / taupe #8A8178 | serif display, taupe hairline grid, compass rings |
| cobalt-grid (two-colour risograph) | paper #F0EBDE / cobalt ink #1F2BE0 | graph-paper grid at 10 % ink; two colours only |
| code-editorial (developer brand book) | warm paper #FAF9F5 / ink #141413 / scarce terracotta #CC785C; dark code surface #181715 | serif display, mono code |
| coral (bold magazine) | coral #E85D5D, ink #1A1A1A, cream #F5F0E8 planes at hard edges | condensed caps as architecture, giant numerals |
| creative-mode (sparse neobrutalist) | cream #EFE9D9 / ink #0F0F0F / rationed green #1F8A4C, pink #F06CA8, orange #E85A1F | Archivo 900 caps, 4 px ink borders, one big claim, vast cream |
| picture-book | cream #F5F0E6 / charcoal #2D2D2D outlines / sunny pastels (turquoise #7ECDC0, butter #FDE68A, coral #F8635F) | rounded friendly type, hand-drawn ornaments |
| editorial-forest (literary) | green #2E4A2A / cream #EFE7D4 / pink #E89CB1 | serif display, mono chrome, flat paper |
Each look's failure mode is the generic card deck (rounded, soft-shadowed, multi-accent): if a frame could belong to
any brand, it has failed. Each also has a frame test: squint (exactly one display moment dominates at 3–6× everything
else), silence (declarative frames 45–55 % empty), restraint (one register per frame, one accent).

## Self-check before you render
Score the look 1–5 on philosophy (one idea), hierarchy (one focal), detail (materials, numbers), function (reads at
phone size) and innovation (not the default); fix anything under 3. Never present that score to the person as a
quality grade: it is a checklist, not a verdict.
