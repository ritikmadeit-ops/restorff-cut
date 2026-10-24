---
id: video-types
title: Video types
summary: The shape and the tells of each kind of piece: ad and launch, product demo with a big cursor, explainer, talking head with cards, vertical social clip, music-driven edit, 3D piece, character or mascot.
read_when: After deciding the one thing, to take the right shape for the kind of piece being made.
aliases: types, ad, ads, launch, promo, explainer, tutorial, talking-head, vertical, social, reel, music-video, 3d, mascot, character, demo, cursor, product-demo
tools: storyboard, effects, composition, cutout, captions
related: story, pacing-retention, numbers, typography-layout, animation-runtimes
next: storyboard get | Lay the chosen shape out as beats: one row per beat with its line.
source: skills/hyperframes/references/types/{launch,explainer,vertical,music,3d,character}.md; references/{overlays,film}.md; .claude/skills/oversized-cursor/SKILL.md; docs/prompting/{product-launch,explainers,motion-graphics,code-and-prs}.mdx; docs/guides/{faceless-explainer,product-launch-video,motion-graphics,general-video}.mdx
---
# Video types

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/references/types/*.md, references/{overlays,film}.md, .claude/skills/oversized-cursor, docs/prompting/{product-launch,explainers,motion-graphics}.mdx, docs/guides/{faceless-explainer,product-launch-video,motion-graphics}.mdx @fa5dbd1; modified for RestorffCut.

## Ad, launch, promo
Shape: hook → tension → reveal → proof → payoff → claim → end card (`guide story`, "Beat shapes"), 15–45 s. What
people share is real people and real output: effects-heavy pieces drew about a tenth of the views of ones built on a
real result (the source's measurement on its own launches).
- **Real product, never a mockup**: the person's footage, product photos, screenshots, their recording. A missing
  shot is a labelled placeholder said in your reply; never an invented screen or a redrawn logo.
- Show the product big: rebuild only the piece the beat uses and show it at 1.6–2× its real size; text stays ≥ 36 px
  after any push. Never a small window in an empty frame; never product UI tilted into 3D.
- Containers morph instead of cutting (the button becomes the menu); pull back to reveal the result was playing
  inside the product, or zoom through until it fills the frame.
- **End card**: in the last 5–10 %, the mark carried in (wiped, typed, or a click fills it), lockup 15–30 % of the
  width, then the call to action held 1.5–3 s. Library: **Social CTA overlays**.
- Tells: typing into a prompt box as the opener; a feature list as three cards; a title over a dimmed screenshot; an
  invented dashboard; the logo docked in a corner.

## Product demo and the big cursor
The camera cycles between the window on its ground, one pane, and a punch-in on one control; moves take 0.4–0.6 s and
arrive at the control the cursor needs, then hold while the UI acts. A cursor is the cheapest strong motion: it
carries the eye, gives a cause to the next change, and wakes a static scene.
- **Big**: about 7 % of the frame width (≈ 75 px on 1080 wide), 4.6–5.5 % inside a small mock-up. One arrow shape,
  white body with a dark stroke or the reverse, constant for the piece; a soft drop shadow.
- **Enters from off-screen** (from below by default) in one decelerating glide, 0.4–0.9 s `snappy`/`power3.out`;
  never fades in at rest.
- The **tip** lands on the target's centre; a click is 0.84 scale in 0.1 s (`ease-in`) then back in 0.22 s
  (`gentle`), pivoting on the tip; the target reacts on the same frame (a press: scale 0.94).
- **The click ignites the next beat** on the same frame: a menu opens, typing starts, a card morphs. During beats it
  does not own it drifts aside (0.5–0.9 s), never freezes on top of the action, never wobbles.
- Exits physically: off the nearest edge with `ease-in` in 0.5–0.7 s, or, in the last 0.3 s before a cut, accelerating
  toward the next scene's first click point (the next scene continues the path at matched speed).
Draw it in a composition (an SVG arrow); `transform-origin` at the tip (about 21 % 14 % of a 24-unit arrow box).

## Explainer
One idea understood by the end; 30–90 s. The spine is one concrete example worked through, not a tour of facts.
- **Ground it first**: start where the viewer is (a person, a situation, the question they would ask: "why does cold
  brew taste smoother?"); the device enters inside that situation as the answer; return to the person at the end.
- Devices that explain: the object is the explanation (a thing whose working is the idea, toured with cut-aways); one
  diagram that grows, a part per beat, each appearing when it is named; continuous transformation (each step morphs
  out of the last); the worked example (one real input travels through every step).
- Shapes of information, each with its own picture: a number that lands; a myth struck through and the truth printed
  over it; before and after; many into few groups; a network densifying; one chosen out of many; steps in order; a
  real picture with the detail circled; a quote set as a poster; a chapter card. Pick the shape, then the picture.
- Narrated: the voice is the clock, about 19 words per scene, parts revealed as named. Not narrated: lines up to ~10
  words, each held 0.5 s + 0.3 s a word. Labels sit on the part they name, with a leader line; no legends.
- Check the logic of each step before animating it. End on the one idea in one line; no brand end card unless asked.
- Library: **Easing-curve explainer**, **Flowchart with travelling spark**, **Thread timeline**, the collage kit;
  `references build` makes an editable explainer from a reference folder.
- Tells: bullet slides; icons in circles; three cards in a row; the whole diagram at once; the narrator reading the
  screen word for word.

## Talking head with cards
Cards, lower thirds and split layouts over a person speaking: positions and timings in `guide typography-layout`,
"Cards over a talking head". The face is never under a card; cards land on the sentence they illustrate; B-roll cuts
on the sentence; punch-ins on emphasis; one big word behind the speaker per beat at most (`guide captions`).
Order of work: `transcribe` → `autocut` (silences, retakes, false starts) → `captions` → cards and effects on words →
sound → grade. A transcript's last word can end after the media: clamp anything you place to the clip's real end.

## Vertical social clip (9:16)
Made at 1080×1920 when the request or the platform says vertical; a landscape piece is recomposed, not squeezed.
- Frame 0 is the thumbnail and the hook: a face, the result, or one bold line already on screen.
- One subject, centred, stacked vertically; side-by-side panels and wide charts are rebuilt as a vertical sequence.
- Type larger than landscape (titles × 1.35); about 5 words a line for a claim; nothing below the floor.
- Faster: shots of 1–2 s, a new beat every 2–4 s, the payoff before the swipe. A loop from the last frame to the
  first is a choice (`music {loop: true}`), not a default.
- Platform UI covers the top and the bottom band: `guide typography-layout`, "Safe areas on 9:16".

## Music-driven edit
The song is the structure: sections become chapters; cut density follows energy (slower shots in verses, one picture
per strong beat in the chorus, a held image on a breakdown); the chorus returns to a home stage and escalates; the
ending rhymes with the opening. Each lyric line gets its own picture (1.4–4 s) showing what it means. Tells: one
treatment for more than ~6 s; a waveform as the main picture; every cut on every beat.

## 3D piece
Use 3D when the piece earns it: a product or object as the payoff, a simulation that explains. One hero object beats a
crowd; fly through or into it rather than orbiting it (one dive is worth ten turns). Warm key, cool rim, a dark
environment with two or three soft strips; turn the environment, not the object, so highlights sweep; a contact
shadow under it. Labels with real numbers and cut-aways turn a simulation into an explanation. How to build it:
`guide animation-runtimes`. Library: **Kinetic type on a 3D grid**, **Vertigo**, **Orbit**.

## Character or mascot
A character gives every transition a cause and the piece its jokes. Mood changes go through a take: anticipation, a
squash, the new face, a settle; never a snap. Offset the parts (head leads, arms follow), never both arms or both eyes
in unison. Contact sells it: feet on the ground, props in the hand, eyes on what they look at. Each action is one
read: lead the eye, play the action fast, hold the reaction; a caption that repeats the action is the classic failure.
Here, idle breath and blinks are acting, not wobble. Vector animation files come in through the lottie runtime.
