---
id: transitions
title: Transitions and seams
summary: A transition says how two shots relate; the transition op's kinds and lengths by energy; the vector law (cut mid-motion, same axis, direction and speed); zoom-through, cut-the-curve, whip, flash and other seams built in code; the budget and the faults.
read_when: Before putting anything on a cut, and when a render "feels like slides" or a seam jumps.
aliases: transition, seams, seam, cuts, whip, zoom-through, cut-the-curve, flash, crossfade, dissolve, match-cut
tools: timeline_ops, effects, composition
related: motion, pacing-retention, composition-authoring, qa-loop
next: timeline_ops reference | Read the transition op (a, b, kind, dur) before placing one.
source: skills/hyperframes/references/motion.md; .claude/skills/motion-doctrine/SKILL.md; .claude/skills/cut-the-curve/SKILL.md; .claude/skills/seam-craft/SKILL.md; docs/prompting/{transitions,motion,capstone}.mdx; skills/hyperframes-registry/references/discovery.md; skills/media-use/references/media-treatment-recipes.md
---
# Transitions and seams

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/references/motion.md, .claude/skills/{motion-doctrine,cut-the-curve,seam-craft}, docs/prompting/{transitions,motion,capstone}.mdx, skills/media-use/references/media-treatment-recipes.md @fa5dbd1; modified for RestorffCut.

## A transition is a sentence about two shots
A dissolve says "this continues"; a whip says "next point"; a flash says "something changed"; a hard cut on the
beat says "keep up". Pick **one default** for the piece plus **one or two accents** for topic changes and the climax;
never a different one on every seam. Hard cuts belong inside a scene (punch-ins, jump cuts on a talking head); between
beats at most about a third of the seams are plain hard cuts, unless a match, the beat grid or a persistent prop
carries continuity. Two different worlds never dissolve into each other. Every transition has a cause on screen.

## The transition op
`timeline_ops {op: "transition", a: <clip before the cut>, b: <clip after>, kind, dur?}` on two clips that touch on
the same track. Kinds and default lengths: `dissolve` 0.5 · `dip-black` 0.6 · `dip-white` 0.5 · `flash` 0.25 ·
`whip-left|right|up|down` 0.3 · `push-*` 0.4 · `slide-*` 0.4 · `zoom-in` 0.4 · `wipe-*` 0.5 · `iris` 0.6 · `glitch` 0.3
· `blur` 0.5 (aliases: crossfade, whip-pan, zoom-through, punch …; `cut`, `match`, `jump-cut` = nothing to write).
`effects list` shows them under Transitions; `revise "whip into the next shot"` places one by sentence.
| Energy of the piece | Kinds | Length |
| --- | --- | --- |
| Calm, premium | dissolve, blur, dip-black | 0.5–0.8 s |
| Medium | push, slide, whip, zoom-in, wipe | 0.3–0.5 s |
| High | whip, flash, glitch, zoom-in | 0.15–0.3 s |
Warm or nostalgic: a short dip or a light-leak style flash; cold or technical: wipe, glitch, iris; playful: iris,
push. Shader-type transitions (glitch, blur) at most twice in a video. Minimum 0.3 s except a flash or whip; the
sweet spot is 0.5 s; the transition is centred on the cut.

## The vector law
How shot A leaves decides how shot B enters: **same axis, same direction, matched speed, cut mid-motion on both
sides**. Settling to rest before the cut, or starting from rest after it, is a dead beat.
- Axis: x stays x, y stays y, depth stays depth.
- Direction never mirrors. In depth, direction is the sign of the scale change: growing = push (toward camera),
  shrinking = pull. A receding exit answered by a grow-from-small entry is the most common violation.
- Speed: mirrored eases (exit `ease-in`/`power4.in`, entry `snappy`/`power4.out`, same distance and duration) are the
  two halves of one curve, so velocity matches at the cut.
- **The current**: pick one dominant direction for the piece (default: left) and use it for ordinary seams. Other
  vectors mean something: up = elevation, a conclusion; push = deeper into the same thought; pull = arrival, something
  bigger lands; burst outward = leaving a world. Never ping-pong consecutive seams; a direction change needs a visible
  cause (a click, an impact) or a chapter boundary.
- **Carriers**: the strongest seams hand a concrete object across the cut at matched position and velocity (a
  cursor mid-path, a card that shrinks into the next layout, a word group). A dissolve has no carrier.

## Seams you build in code (inside a composition)
| Seam | Exit | Cut (instant) | Entry | Total |
| --- | --- | --- | --- | --- |
| Cut-the-curve (default between scenes) | travel 0 → −12 % of the frame (≈ −230 px at 1920), `ease-in`, opacity gone by 25–30 % of the travel | — | from +12 % to 0, `snappy`, ignites at opacity 0.35 mid-path | ≈ 0.6 s |
| Zoom-through (headlines only) | scale 1 → 1.2, blur 0 → 10 px, opacity 1 → 0.15 (opacity on its own linear tween), 0.2 s `ease-in` | in: scale 0.75 at 0.15 | 0.75 → 1, blur 10 → 0, 0.5 s `snappy` | ≈ 0.4 s |
| Inverse zoom-through (arrival, payoff) | scale 1 → 0.8, blur to 10 px, 0.2 s | in: scale 1.25 | 1.25 → 1, 0.5 s `snappy` | ≈ 0.7 s |
| Rack-focus blur cut (the one cut meant to be seen, at most once per ~8 s) | stays opaque, blur up to 8–12 px, `smooth` | swap at peak blur | blur down, scale ~1.06 → 1 | ≈ 0.5 s |
| Whip | a 0.13–0.3 s smear | — | arrives blurred, sharpens in ~0.13 s | ≈ 0.3 s |
| Colour flood | the hero stays; the whole ground changes colour in ~0.4 s `smooth` | — | — | 0.4 s |
| Object becomes the world | a card or button grows past the frame in 0.65 s `smooth`, its radius shrinking; around it blurs ~15 px and fades in 0.3 s | — | new content fades in while it still grows | ≈ 0.7 s |
| Iris from the click | — | — | `clip-path: circle()` opens from the clicked point in 0.15 s | 0.15 s |
| Dip cut | the outgoing frame darkens ~40 % for 3 frames, then a hard cut | — | — | 0.1 s |
Blur by size: 10 px on text-scale subjects (20 px smears letterforms into a glitch), 18–20 px on full-frame surfaces;
the same peak blur on both sides at the swap frame; blur the wrapper, never its children. Transform and opacity only.
`composition-example` has a three-line zoom-through chain with its numbers, rendered and looked at.

## Flash
One meaningful high-energy cut, a reveal, a before/after hand-off; never the default, never a looping strobe, never
more than one inside a 1 s window, never saturated red. Rise 0.035–0.055 s, recovery 0.24–0.38 s; the peak hides the
cut. Grade each side for its own subject first: the flash is not a correction.

## Faults
| Symptom | Cause | Fix |
| --- | --- | --- |
| A dip that reads as a jump cut | fade out, then fade in | the transition is the exit; no exit tween before a transition (except the last scene) |
| White or light flash at a seam in a full-frame composition | the two layers' opacities sum below 1 over a transparent page | paint an opaque ground on a full-frame piece (`opaque: true` in its params block) |
| Jump at a cut | outgoing and incoming states differ at the seam | look at stills at cut −0.1 / 0 / +0.1 s and match position and scale |
| The ease looks off at a hand-off | speeds don't match | mirror the ease (`ease-in` out, `snappy` in), same distance and duration |
| "It feels like slides" | every scene enters on its own from rest | something crosses the boundary (match cut, persistent prop, a carrier) and energy varies; cut a move mid-flight |
| A seam reopened after an edit | a change to a scene's first or last second, or a new voice take | look at that seam again |
Dwell 1.5–2.5 s on hero moments: the camera rests but the world keeps resolving.
