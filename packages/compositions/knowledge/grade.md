---
id: grade
title: Grade and looks on footage
summary: Classify the request (correct, polish, stylise, hide, reveal), translate vague feedback conservatively, the grade op's looks, nudges and params, tested starting points for people, products, screen recordings and memories, and how to verify before and after.
read_when: When footage looks dark, flat, dull or off-colour, when the person asks for a look ("make it moody", "more premium", "old home video"), or before a final render of footage.
aliases: color, colour, color-grading, colour-grading, lut, looks, treatment, moody, warm, film, polish, exposure
tools: timeline_ops, revise, styles, look, effects
related: look-and-style, qa-loop, transitions
next: timeline_ops reference | Read the grade op: target, preset (look or nudge) and params.
source: skills/media-use/references/{media-treatments,media-treatment-recipes,grading}.md; docs/prompting/{color-grading,generated-artwork}.mdx; docs/guides/{color-grading,media-effects,remove-background}.mdx; docs/reference/color-grading.mdx
---
# Grade and looks on footage

Adapted from HyperFrames skills (Apache-2.0) skills/media-use/references/{media-treatments,media-treatment-recipes,grading}.md, docs/prompting/{color-grading,generated-artwork}.mdx, docs/guides/{color-grading,media-effects,remove-background}.mdx @fa5dbd1; modified for RestorffCut.

## Classify the request first
Pick the smallest lane that satisfies it; it names the primary reason for the change, not a one-feature limit.
| The person says | Lane |
| --- | --- |
| too dark, flat, too warm, too many shadows | correction |
| polished, premium, warm, cinematic, "fit the topic" | a look (preset) or a custom grade |
| retro, print, VHS, glitch, camcorder | a stylised look or effect |
| obscure the whole shot | privacy blur / pixelate on that clip |
| hide one face, plate or screen region | a separate cropped or masked layer first; a whole-clip effect does not isolate a region |
| draw attention without changing the pixels | framing, a punch-in, motion |
| reveal, focus, de-blur | a short keyframed change of the grade or effect |
Do not add a stylised effect when correction solves the complaint; do not change colour when the request is only about
time; do not add an overlay when the shot alone says it. **Match strength to intent**: correction and polish stay
restrained; a named bold look (VHS, glitch, print) must read unmistakably (half-strength reads as a mistake).

## Vague feedback, conservatively
| Feedback | First action | Add only if the frames justify it | Never infer |
| --- | --- | --- | --- |
| "too many shadows and a bit boring" | lift shadows, protect highlights; then compare one restrained look | mild contrast or saturation | retro texture, grain, a palette effect |
| "make the product feel premium" | protect product colour and labels; compare the product starting point below | a light vignette on lifestyle footage | a cinematic look or crushed blacks |
| "make it feel like an old home video" | compare a film-memory grade against the source | grain, a faint flicker | that every old-video request means VHS |
| "keep the brand colours exact" | leave UI and logo pixels unchanged; use framing and motion | an exposure-only correction | any look or palette |
| "hide this face" | say a whole-clip effect hides the whole clip; isolate the region first | whole-clip blur only if they accept that | tracking that was not done |
At most two candidates when more than one lane fits; choose from before/after frames you looked at.

## The grade op
`timeline_ops {op: "grade", target, preset?, params?}`: one real GPU pass. `target` = an element id, a track id,
`"main"` or `"all"` (`"all"` = a GRADE layer under the captions, so text and graphics keep their colours).
- Looks (`preset`): `warm-morning`, `moody`, `clean`, `film`, `cool-night`, `punchy`, `paper`, `mono` (black and white),
  or `"none"` to remove.
- Nudges (`preset`, added to the current values): `warmer`/`cooler` (temperature ±15), `brighter`/`darker` (exposure
  ±0.25), `more-contrast`/`less-contrast` (±15), `more-saturation`/`less-saturation` (±15), `more-grain` (+20).
- Params: `exposure` (stops, −3…3), `contrast`, `saturation`, `temperature`, `tint`, `shadows` (lift), `midtones`
  (gamma), `highlights` (gain), `vignette` (all −100…100), `grain`, `shadowTint`, `highlightTint` (0…100),
  `shadowHue`, `highlightHue` (degrees: 0 red, 30 orange, 200 teal, 220 blue), `amount` (0…100, the whole grade's
  strength).
A sentence works too: `revise "make the second half moody"`, `styles resolve "warmer"`. Correct first (exposure,
balance), then style; grade by subject, not by position (a person and a product in one frame want different lanes:
split them into layers or favour the one the shot is about).

## Starting points (then tune only what the frames justify)
The source's tested ranges, translated to our scale (ASSUMPTION: their −1…1 adjustments × 100 ≈ our −100…100 params;
the curves differ, so judge on frames, not numbers).
- **People, natural** (talking head, interview): `exposure` −0.06…0.14 stops, `contrast` −5…8, `highlights` −18…−4,
  `shadows` 4…18, `temperature` −5…10, `tint` −3…5, `saturation` −4…6, `vignette` 0…5, grain 0. Reject anything that
  makes skin implausible, loses highlight detail, or flattens or desaturates dark skin.
- **Product, clean**: `exposure` 0.01, `contrast` 6, `highlights` −10, `shadows` 4, `saturation` 2–5; temperature and
  tint 0 unless the frames show a cast; no grain or vignette on catalogue shots (≤ 4 on lifestyle). Reject a result that
  clips white packaging, muddies a black product, shifts a known brand colour or hides texture. If the source is
  already right, leave the pixels alone and polish with framing; say that was the decision.
- **Screen recordings, UI, slides**: **no grade.** Global colour moves brand colours, status colours, charts and small
  text together. Polish with crop, scale, pacing, cursor emphasis and graphics around the screen.
- **Warm memory, flashback**: `film` or `paper` at `amount` 50–75, `vignette` 8–16, `grain` 8–16 at the gentle end; a
  faint exposure flicker within ±0.03 stops over 0.45–0.8 s segments is acceptable, never a strobe. Not the default
  meaning of "cinematic".
- **Moody / night**: `moody` or `cool-night`, then pull `amount` down until faces still read.
- **Punchy social**: `punchy`; watch skin (the first cut of this look turned skin red-orange: SEEN 2026-10-20).

## Hide, reveal, flash
- Redaction: a constant, generous pixelation or blur at about half strength; a fixed region only holds if the subject
  barely moves (about 5 px).
- A reveal or focus pull: keyframe the effect or `amount` from strong to neutral over 0.3–0.6 s, then leave the shot
  at its correct grade.
- A flash between two shots: `guide transitions`, "Flash"; grade each side for its own subject first.

## Generated pictures
When a picture is generated for a piece: generate it on a flat magenta ground and key that colour out (not the
people matte), ask for "minimal, negative space", keep moving parts as code layers, and generate in greyscale when the
colour will be applied in the composition.

## Verify before and after
1. Look at three moments of the shot before grading (start, middle, end: `look` stills or a contact sheet).
2. Apply one candidate (a dry run first on `"all"`), render a preview, look at the **same** three moments.
3. Keep it only when it is clearly better; otherwise leave the source as it was. Judge bloom, grain and skin at full
   size, not on a tiny contact sheet.
4. Report the clips graded, the lane, the look or params used, and the frames you actually checked. Never claim
   visual quality from a command succeeding.
Source with nothing to lose (already graded, low-light noise, intentional colour) is a reason to do less. Footage in a
log or HDR profile needs its camera's conversion first; the grade here assumes standard-range video.
