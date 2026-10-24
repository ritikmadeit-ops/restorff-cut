---
id: story
title: Story, beats and the plan
summary: The one thing, three storylines then one, the hook, the beat shapes, worlds, copy rules, the spec (adjectives as numbers), the storyboard, and the tells of a generated film.
read_when: Before building any piece over about 15 s that tells something (ad, launch, explainer, recap); skip it for captions on footage or a one-line motion piece.
aliases: storyline, structure, beats, script, copy, plan, spec, storyboard, hook-writing
tools: storyboard, plan, timeline
related: video-types, pacing-retention, look-and-style, workflow
next: storyboard get | Read (or build) the storyboard: one row per beat with its line.
source: skills/hyperframes/references/story.md; references/spec.md; references/storyboard.md; references/storyboard-format.md; docs/prompting/{anatomy,storyboards,capstone,examples}.mdx; skills/figma/SKILL.md
---
# Story, beats and the plan

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/references/{story,spec,storyboard,storyboard-format}.md, docs/prompting/{anatomy,storyboards,capstone,examples}.mdx @fa5dbd1; modified for RestorffCut.

## The one thing
Most weak videos are good motion around no story: a feature list, three cards in a row, a logo. Before anything:
- **What it is**, one line: "You can now …" for a launch; the one idea for an explainer; for an ad, the one reason to
  buy ("Halcyon steeps 18 hours, so it is never bitter").
- **The one thing to remember**, in the viewer's words, not the slogan.
- **One viewer doing one real task**, from the need to the result. One real piece of data (a number, a photo, a
  sentence) travels from the hook to the payoff.
- Keep **facts** (what it does, real numbers, real labels) apart from **creative choices** (angle, tone, look). Every
  claim on screen traces to the source or the person's words; use their copy verbatim.

## Three storylines, then one
Write three that are three different films, each with its own **world** (where it happens, what it looks like), its
own **device** (what the story is) and its own **form** (how the camera and cuts carry it). Make one the bold one you
would not have picked first. Each: a name; device and form; two sentences of what the viewer sees and feels; the first
two seconds exactly; the beats in one line (`hook → … → end card`); the look in one line; the sound in one line.
Words only: build nothing before one is picked. Recommend one, first, with a one-clause reason.

Devices: a moment in someone's day · a character does the work · the feature as the hook (working on something
recognisable in the first half second) · the result first, then pull back to where it came from · one object across
places · life before and after · type carries the argument · a number lands · a question with the input inside it ·
the object is the explanation.
Forms: one continuous take · object-to-object chain (each shot ends on the thing that opens the next) · an endless
zoom · a flight through one world · cut on the beat · match cuts (one shape holds while everything changes) · split
screen collapsing to one · one frame that rebuilds itself. Three plain cut-between-scenes pitches have not tried the forms.

## The hook
The first two seconds are the densest of the video, and frame 0 is the thumbnail: never black, never a logo alone.
Open on the product working on something recognisable, a real moment that creates the need, a question with the input
in it, or a sentence whose last word becomes the picture. Then let the old way fail on screen (the wait, the bitter
sip, the wrong result) before the relief. Typing into an empty prompt box as the opener is a generated-video tell.

## Beat shapes
Ad (15–45 s): hook → problem → solution → proof → CTA. A launch of about 35 s, scaled to the length:
| Beat | Share | Job |
| --- | --- | --- |
| Hook | ~8 % | the world and the need, or the product already working |
| Tension | ~12 % | the old way failing on screen |
| Reveal | ~8 % | the product named, about 20–30 % in |
| Proof | ~40 % | the real task as 3–6 verbs (pour, wait, taste), one each |
| Payoff | ~20 % | the biggest visual moment, once, 60–80 % in |
| Claim | ~8 % | the one thing, in one line |
| End card | ~8 % | the mark carried in, name and CTA land and hold 2–3 s |
The process runs fast; the payoff plays at normal speed. A length in the request is a range, never padded.
Name one **spectacle beat** per piece; an unnamed burst gets dropped. Plant a motif early and bring it back denser.

## Worlds and the brand
Visit several worlds, each with its own ground, light and scale, never one dark canvas with small things floating in
it. Enter each through an object already on screen. Keep one home stage, one carrier the eye follows, the palette and
type constant. The mark lands **once**, with weight, usually on the end card, carried in rather than faded in; before
that the brand lives inside the product and the story, never docked small in a corner. The accent is rationed: one
highlighted word, the payoff, the end card.

## Copy and voice
- Titles: at most 6 words a line (an explainer's about 10), one line on screen at a time, no trailing periods on
  titles, each held 0.5 s + 0.3 s a word, the last line at least 2 s.
- Show, don't list: no bullet slides, no three cards in a row.
- Real numbers only. The first line is never "Introducing", "Meet" or the logo. Never "unlock", "seamless",
  "supercharge", "game-changer", "revolutionize", "effortless", "in seconds" (unless measured), "Amazing!".
- Read the lines alone: a stranger gets the pitch. Watch the pictures alone: they tell the same story.
- With a voice-over the screen never repeats the spoken sentence word for word (captions excepted).
- Simultaneity is decided in the plan: "fades out by 4.2 s; at 4.2 s the price stamps in", never two things "at 4 s".

## The spec: adjectives become numbers
Defaults live in adjectives. Before the first scene write, in your plan (and a `timeline comment` at 0 s):
```
GOAL    what the viewer feels or does at the end
OUTPUT  W x H, fps, length range
LOOK    ground hex + texture %, ink, ONE accent and where it may appear; display face, weight, size px, tracking
MOTION  eases by role (enter, move, exit, camera); springs as damping; durations and staggers in frames
SHOTS   one line per shot: seconds, the one hero move, what the viewer reads (with its window), the sound, the hand-off
BANNED  the defaults (guide look-and-style) + what this video must not become
QA      the frames to check and what each must show
```
Words into numbers: premium = a material with numbers (satin paper 2 % grain, a 0.55 contact shadow); modern = a
camera and a type system (a 30-frame push on one ease, display at 9 % of the height, −2 % tracking); clean = a grid
and a ration (96 px margins, the accent on one word per shot); dynamic = cuts on the beat, a layout change every 4
beats, one hero move per shot; playful = springs at damping 0.45–0.6 on position and scale only; cinematic = a lens and
a light (35 mm framing, key from upper left, rim from behind, 6 % vignette).

## The storyboard
`storyboard get` shows one row per beat with its spoken line; change a row with `edit_row`; record the person's yes
with `approve` before rendering. Per row, carry two things the build and the review both check:
- **reads**: what the viewer must understand, in order, each with its window ("the bottle lands (0.4–1.2 s); '18
  hours' lands (1.2–2.6 s)"); windows never overlap and each is long enough for its words.
- **sound**: the bed, the effects on visible actions, or silence ("bed enters strong; pour; whoosh on the cut").
Storyboard frames are **states**, not slides: match elements across rows by name, then size and position, and tween
between them. A still that stays a still for 3 s reads as a slideshow.

## Tells of a generated video
A dark void with small things floating in it · glow and particles as decoration · everything fading and sliding up ·
three cards in a row · the docked logo · every scene entering the same way · side-by-side panels standing in for a
scene · titles that keep drifting after they land · breathing or floating loops on titles and UI. When a render shows
one, name it, take the replacement from the subject, the brand or the medium, and add it to the BANNED line.
