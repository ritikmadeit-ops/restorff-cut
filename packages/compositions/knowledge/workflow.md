---
id: workflow
title: The work loop
summary: The order of work for any video (read, decide the one thing, plan, build in commits, render, look, check, fix) and which playbook to read for which job.
read_when: First, on any new video or any request bigger than one small edit.
aliases: start, start-here, loop, process, how, overview
tools: timeline, storyboard, plan, render, look, check, retention
related: story, pacing-retention, qa-loop, composition-authoring
next: timeline list | List your timelines (or create one) and read its summary.
source: skills/hyperframes/SKILL.md; skills/hyperframes/references/story.md; skills/hyperframes/references/review.md; skills/media-use/SKILL.md; docs/prompting/iterating.mdx; docs/prompting/anatomy.mdx
---
# The work loop

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/SKILL.md, references/story.md, references/review.md, skills/media-use/SKILL.md, docs/prompting/{iterating,anatomy}.mdx @fa5dbd1; modified for RestorffCut.

## Build what was asked
- No voice-over, no captions and no new aspect ratio unless the request or the source calls for them. A piece over
  about 15 s that tells something gets a music bed and sounds on its visible actions unless the person asked for
  silence or it is made to play muted (`guide sound`).
- A question, a hold or a loose idea gets an answer or a proposal, not an edit.
- **Library before code.** Before hand-writing a named effect, transition, caption style, chart or card, look for it:
  `effects list` (the 62 catalogue rows plus the package compositions, transitions, grades, shaders), `effects describe
  <name>`, `captions` styles, `sounds list`. Write a composition only when nothing fits (`guide composition-authoring`).
- **Show real things from their source**: the person's footage, the product's own screens, the brand's own logo file.
  Draw only what has no source. A screen you cannot get is a clearly labelled placeholder, said in your reply; never
  an invented dashboard or a redrawn logo.
- What the source does not say stays unsaid: no derived claims ("40 min to 2 min" is not "20x faster"), example
  numbers marked as illustrative.

## The loop
1. **Read.** `timeline list` → `timeline summary` (element ids, exact seconds, the head commit). No timeline:
   `timeline create {name, aspect}` → `media import` once per file. Talking head: `transcribe {all: true}` first.
2. **Decide the one thing**: what the viewer must understand or remember, in one line, and the length as a range
   (`guide story`). A piece over ~15 s that tells something: three storylines in words, pick one; the person picks
   unless they asked for no stops, then take your recommendation and name the other two in one line each.
3. **Plan before building.** `storyboard get` (rows = beats with their spoken line), `plan scenes` / `plan effects`
   (windows from the words, never times by hand). Write the plan's numbers down: the look as numbers, eases by role,
   the BANNED line (`guide look-and-style`). Keep it where the next turn finds it: a `timeline comment` at 0 s.
4. **Build in commits.** One sentence from the person = one commit with their sentence as the message. `dry_run: true`
   first on anything that touches many elements. Order: cut (autocut) → picture (effects, compositions, cutout) →
   captions → sound (voiceover, music, sounds design) → grade.
5. **Render, look, check.** `render {quality: "preview"}` → `render {render_id}` until done → `look` (contact
   sheets; stills at exact times) → `check` (the export gate; its retention map) → fix → render again
   (`guide qa-loop`). A composition can be looked at before any render: `look {kind: "clip", element_id}`.
6. **Deliver.** When `check` says PASS and no P0 note is open: `render {quality: "final"}`, `check` it, then a short
   delivery note (what you decided, what you measured versus only looked at, the weakest shot).

## What to read for which job
| The job | Playbook |
| --- | --- |
| Any new video; the order of work | `workflow` (this) |
| What the video says, its beats, the hook, copy | `story` |
| Ad, launch, explainer, talking head with cards, vertical social, music edit, 3D, mascot, product demo | `video-types` |
| Hook, rhythm, holds, dead stretches, length | `pacing-retention` |
| Eases, durations, stagger, titles, holds, springs | `motion` |
| Seams between shots and scenes | `transitions` |
| Sizes, safe areas, density, contrast, cards over footage | `typography-layout` |
| The look: palette, type, medium, banned defaults, named looks | `look-and-style` |
| Captions, key words, text behind the speaker | `captions` |
| Voice-over, music, sound effects, levels | `sound` |
| Colour: correction, polish, named looks on footage | `grade` |
| Numbers, charts, maps | `numbers` |
| Writing a motion graphic as code | `composition-authoring`, then `composition-example` |
| The timeline-style API, 3D, vector animation, generative | `animation-runtimes` |
| Looking at the render and fixing what is weak | `qa-loop` |
Which effect fits which beat, as data: the director's technique records (`TECHNIQUES.md`); these playbooks are the how.

## Rules that save the most time
- **Times come from the words** (`transcribe`, `plan`, the voice-over's word timings), never typed by hand.
- **Never describe a frame you have not looked at.** `look` first, then say what you saw.
- **Change one thing per pass** when a fix does not hold; add one element type per pass when building up.
- **Absolute targets** ("the word fills 70 % of the width") beat relative ones ("bigger").
- **Freeze what works**: say what a fix must not touch ("keep the framing") and keep it.
- **Ask once.** Only what only the person can answer (their screens, narrated or music only), bundled in one
  message; state every other assumption in one line (length range, aspect, voice or music).
- **Offer, never add silently**: scan once for concrete gaps (on-screen text with no voice, silent cuts, 10 s+ with no
  music, a colour cast) and offer the fixes in one ask.
