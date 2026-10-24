---
id: qa-loop
title: Look, check, fix (the QA loop)
summary: Render a preview, look at the frames that matter, run the export gate and the retention map, describe each beat as a stranger would, write ranked notes in one format, fix text then timing then detail, and write the delivery note.
read_when: After every build pass and before you reply or render final; when a fix does not hold.
aliases: qa, review, check, look, verify, quality, critique, self-check, feedback
tools: render, look, check, retention, timeline_ops, revise, history
related: workflow, pacing-retention, typography-layout, story
next: render | Render a preview of the head: render {timeline_id, quality: "preview"}.
source: skills/hyperframes/references/review.md; references/motion.md ("Seeing motion"); skills/hyperframes-cli/references/lint-validate-inspect.md; skills/hyperframes-registry/references/component-quality-bar.md; docs/prompting/{iterating,recreating-references}.mdx; docs/guides/{export-and-share,motion-graphics}.mdx; skills/media-use/references/media-treatments.md
---
# Look, check, fix

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/references/{review,motion}.md, skills/hyperframes-cli/references/lint-validate-inspect.md, skills/hyperframes-registry/references/component-quality-bar.md, docs/prompting/{iterating,recreating-references}.mdx, docs/guides/{export-and-share,motion-graphics}.mdx @fa5dbd1; modified for RestorffCut.

You built the timeline, so you know what happens; the viewer sees it once, at full speed, often on a phone, often
muted. `check` catches what is broken; this pass catches what is weak. Look as a harsh motion director, not a proud
author. A build can pass every check and still read as sparse frames or a slideshow.

## 1. Measure, then look
1. `render {timeline_id, quality: "preview"}` → `render {render_id}` until `status: done` (send the same call again
   when it answers `working`).
2. `look {kind: "render", ref: render_id}`: contact sheets, one image per second (7 frames each). The first page also
   answers the **retention map**: the hook (first visual change, bar 1.0 s) and every still stretch over 3 s.
3. `check {render_id}`: the export gate (text in safe areas, sizes, flash frames, faces, loudness, rhythm); findings
   become timeline comments. A warning is a question: fix it, or keep it on purpose and say why.
4. Stills where it matters: `look {kind: "render", ref, times: [...]}` (up to 12 per call, exact seek):
   - each scene just after it starts (+0.3 s) and at its middle;
   - around every cut: −0.2, −0.1, 0, +0.1, +0.2 s (a jump at a cut shows here and nowhere else);
   - the hero move and the payoff: 6–8 stills across it;
   - the first frame (the thumbnail) and the last second.
5. Before any render, a composition or an applied effect can be looked at alone: `look {kind: "clip", timeline_id,
   element_id, times}` (shader layers, captions and grades are not drawn there).
Trust the numbers over your eye where they disagree: a clipped label or a 0.6 s line looks fine on a contact sheet.

## 2. What to look for
First, describe each beat's frame in one sentence as a stranger would, naming every object. An object you would have
to explain ("those bars are cans") is a P0. Then read the beat frames in order: do they tell a story a stranger
follows, each causing the next? Compare each with its storyboard row; what does not match is a note. Then name every
default the frames show (`guide look-and-style`, "Banned by default") and fix those first.
| Question | What it catches |
| --- | --- |
| Does it read as what it is? | a shape that reads as another object; a material that reads as plastic; a product that reads as a mock-up |
| Does the subject separate? | subject and ground too close in value; two focal points; nowhere for the eye to go |
| Framing and contact | crops; text at an edge or under platform UI; collisions at a seam; things floating that should touch; a face under a card or caption |
| Timing for a first-time viewer | a line shorter than its words; something that pops on with no move; a jump at a cut; everything moving at once on one curve |
| Tells | the generated-video defaults (`guide story`, `guide motion`) |
| The pictures alone | with the words covered, do the beat frames still tell it? |
| Small screen | can every line be read in a 432×768 still? |

## 3. Notes and fixes
One line per problem: `t=4.2s · where · problem → exact change · what stays`. Rank them:
- **P0** breaks the read or the contract: unreadable, wrong, broken, a tell in the hero shot.
- **P1** weakens it: a dead stretch, a soft payoff, a seam that jumps.
- **P2** polish.
Fix every P0 and the P1s worth their time: **text first, then timing, then detail**. Then render and look at only
what you changed, once; a second pass only while a P0 is open. When a fix does not hold, look at the frames either
side of the problem, list every difference, and change only the line that causes it. Change **one variable per
pass**; add one element type per pass. When stuck, strip back to what works and re-layer. A piece that feels busy:
remove a third of the motion and keep the moves that lead the eye. Use absolute targets ("the word fills 70 % of
the width") and a freeze clause ("don't touch the framing"). `history` lists versions; a fix that made it worse goes
back with `history` restore or `composition revert`.
Never score the piece out of 10: a score finds nothing to fix.

## 4. Sound, which you cannot hear
`check` measures loudness (−14 LUFS ± 1, ≤ −1 dBTP) and where sound is. Look for: a hit where the picture hits; the
voice clear of the loudest music; no silent stretch you did not choose; the music ending on purpose. Say in the
delivery note that sound was measured, not heard.

## 5. Matching a reference
`references study` gives the grammar (palette, pacing, texture, motion). Match the grammar, never the content. A
transcribed spec (duration, camera path, per-element times, overlaps, sampled colours) gets about 75 % of the way in
one pass; distilled constants 80–90 %; text alone tops out near 90 %. Mark what you measured apart from what you
guessed.

## 6. The final pass
Check the first and last seconds, the most complex transition, the duration, the size, and that audio is present.
Overlays: first and last frames clear. Then the **delivery note**, short, in your reply:
- the creative calls you made, and the storylines you did not build;
- what you measured and what you only looked at; what nobody checked (sound was measured, not heard);
- the weakest shot, and what you would change with more time;
- the warnings you kept on purpose, and why.
Never describe a frame you have not looked at; never report quality from a command succeeding.
