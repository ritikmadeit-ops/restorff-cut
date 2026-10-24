---
id: pacing-retention
title: Pacing and retention
summary: The hook and frame 0, something new every 2-4 s, no still stretch over 3 s, reading time for every line, shot lengths by genre, the pause before the payoff, cutting to music, and length by type.
read_when: When planning the timing of any piece, and whenever check or look reports a late hook or a still stretch.
aliases: retention, pace, pacing, rhythm, timing, hook-timing, dead-stretch, holds, length, reading-time
tools: retention, plan, check, look, timeline_ops, effects
related: story, motion, captions, sound, qa-loop
next: retention map | Measure a render: the hook and every still stretch, each with the move that breaks it.
source: skills/hyperframes/references/{film,story,spec,motion,captions}.md; references/types/vertical.md; .claude/skills/motion-doctrine/SKILL.md; skills/hyperframes-cli/references/lint-validate-inspect.md; docs/guides/claude-design-hyperframes.md; docs/prompting/{music-and-slideshows,anatomy}.mdx; docs/reference/speed-ramps.mdx
---
# Pacing and retention

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/references/{film,story,spec,motion,captions,types/vertical}.md, .claude/skills/motion-doctrine, skills/hyperframes-cli/references/lint-validate-inspect.md, docs/guides/claude-design-hyperframes.md, docs/prompting/{music-and-slideshows,anatomy}.mdx @fa5dbd1; modified for RestorffCut.

## The bars RestorffCut measures
`check` and the first page of `look` contact sheets answer a **retention map**; `retention {action: "map"}` measures
any render:
- **Hook**: the first visual change by **1.0 s**. Frame 0 is the thumbnail: a face, the result or one bold line
  already on screen; never black, never a logo alone.
- **No still stretch over 3.0 s** (outside the final hold and deliberate holds). Each stretch comes back with the move
  that breaks it; `retention {action: "fix", render_id}` places those moves (punch-ins, word pops, SFX) in ONE commit.
  Then render a preview and check again.
A fix from `retention fix` is a floor, not a design. Prefer a move with a cause: a reveal on the spoken word, a cut on
the sentence, a staged UI step. A punch-in on nothing reads as a tic.

## Something new every 2–4 s
- Across the whole video something new arrives every 2–4 s; with music, a new layout on every bar.
- **Vertical social**: shots of 1–2 s, a new beat every 2–4 s, the payoff before the swipe. The viewer decides in
  about a second; many watch muted, so the picture carries the hook without sound.
- **Montage** cuts every 0.13–0.8 s; a **demo** holds one framing 7–10 s while the UI acts; shots average 1.8–3 s with
  motion inside them. Contrast speeds: fast process, normal-speed payoff.
- **Pause before the payoff**: hold 0.3–0.75 s between the action and its result (the dramatic comma). A cut that
  jumps straight from action to result loses it.
- Any single treatment goes stale after about 6 s: lengthen a section with a new treatment or a hold, never by slowing
  tweens.
- A scene that finishes entering with seconds left is a planning bug: add story (a staged reveal, the camera
  travelling, the UI doing what the voice says), not wobble. Pause anywhere: something meaningful should be mid-flight.

## Reading time
Every line must be on screen long enough to read, at least **0.5 s + 0.3 s per word**; a one- or two-word chapter line
may hold 0.4 s; the video's last line at least **2 s**. Per scene, by the amount of text:
| Text in the scene | Minimum scene |
| --- | --- |
| none | 1.5–2 s |
| 1–3 words | 2–3 s |
| 4–10 words | 3–4 s |
| 11–20 words | 4–6 s |
| 21–35 words | 6–8 s |
| more | split the scene |
The last readable element finishes entering by **50 %** of its scene. Too many words: cut words, never shrink type.
An information card (a stat over a talking head) has its information on screen within about **2.5 s**, then holds:
any paused frame reads as a finished poster.

## The voice sets the length
- Speech runs about **2.2 words a second** (our local voices similar; `voiceover` returns the real timings). Keep a
  scene to about 19 spoken words (9 s); at most two scenes may reach 26 words (12 s). 30 s ≈ 65–70 words.
- A voice-over longer than its pictures makes the pictures pad with idle drift: trim the script, never stretch the
  motion. `voiceover {tighten: true}` cuts pauses over 0.35 s; `fit_to {t0, t1}` speeds a line into its span or refuses.
- Reveal each piece **when the voice names it**, across the back half of the scene. Everything on screen in the first
  quarter, then frozen, reads as a slideshow. `plan scenes` and `plan effects` turn the words into windows.

## Length by type
| Type | Length | Scenes |
| --- | --- | --- |
| Social clip 9:16 | 10–15 s (an ad 15–45 s) | 5–7 |
| Teaser | 15–25 s | 7–10 |
| Launch / feature | 20–45 s (sweet spot 30–90 s for a full launch) | per the beat table in `story` |
| Explainer | 30–90 s | 10–18 |
| Cinematic / brand film | 45–90 s | 7–12, longer holds |
Scene rhythm examples: explainer `3-3-4-3.5-4-5-3.5-4-3.5-4-4-3.5` s; cinematic `8-7-8-10-9-10-8` s. Ceiling about 5 s per
scene unless there is a reason. State what the tail does: a 12 s slot with 5 s of content is a dead hold. End on
purpose: the CTA or the last line lands and holds 1.5–3 s.

## Cutting to music
- With music and no voice, the **music is the clock**: land the payoff and the mark on strong beats; cuts follow
  meaningful changes (phrases, drops, energy), not every drum. `music` puts beats on the bed; `timeline_ops snap_cuts`
  moves cuts onto the nearest beat (`max_shift` 0.2 s).
- Rhythmic sections: one picture per strong beat. Calm sections: flow by phrase, one slow push (scale 1.0 → 1.08).
- A move that must land on a hit starts **40–190 ms early**; a reaction starts 0–45 ms after; the hit itself is an
  instant change (no ease on a hit). A word meant to be read holds at least one beat.
- Beat times from the index, never accumulated: frames per beat = fps × 60 / BPM; beat n at round(n × that). Adding a
  rounded beat repeatedly drifts (2 frames in 32 beats at 128 BPM, 30 fps).
- On calm music the beat tracker invents a metronome (often double tempo): trust beats only on rhythmic stretches.

## Pattern interrupts with a cause
In order of preference: a reveal on the spoken word; a cut on the sentence; a punch-in on emphasis (two `timeline_ops
keyframe` ops on the clip's `scale`, 1.0 → 1.08–1.15 over 0.2–0.4 s, then hold; or a hard punch: a split with the
second piece scaled); a key word on the accent
(`captions {style: "key-word"}`); a named effect on its beat (`effects apply` with `word: "…"`); a whoosh or pop on a
visible action (`guide sound`). Never two interrupts on the same frame; never the same one on every beat.

## Speed changes
ops@1 has no clip-speed or speed-ramp op today (checked 2026-10-24: no speed field in `timeline_ops reference`); the
director lists speed ramps as knowledge only. Get the same effect by cutting: trim the process into shorter pieces
(fast), keep the payoff whole (normal speed). Inside a composition, ramp its own clock: map `time.T` through an ease
before using it. When a ramp op lands: interpolate speed on a log scale (0.5 → 2 passes 1 at the midpoint), clamp
0.1–10; hero = normal → 0.4 on the moment → normal.
