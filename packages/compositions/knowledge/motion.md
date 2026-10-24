---
id: motion
title: Motion craft
summary: Why things move, eases by role, durations, overlap and stagger, springs, title entrances and holds, hero and secondary moves, sustained motion without wobble, and the defaults that look generated.
read_when: Before animating anything: a composition, keyframes on a clip, a title, a punch-in, a cursor.
aliases: easing, ease, eases, stagger, animation, springs, titles, kinetic, kinetic-type, holds, motion-craft
tools: composition, timeline_ops
related: transitions, typography-layout, composition-authoring, animation-runtimes, pacing-retention
next: composition contract | Read the live contract, then write the piece (guide composition-authoring).
source: skills/hyperframes/references/motion.md; references/types/character.md; .claude/skills/motion-doctrine/SKILL.md; .claude/skills/cut-the-curve/SKILL.md; .claude/skills/oversized-cursor/SKILL.md; docs/prompting/{motion,vocabulary}.mdx; docs/guides/claude-design-hyperframes.md; skills/remotion-to-hyperframes/references/timing.md
---
# Motion craft

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/references/motion.md, .claude/skills/{motion-doctrine,cut-the-curve}, docs/prompting/{motion,vocabulary}.mdx, docs/guides/claude-design-hyperframes.md, skills/remotion-to-hyperframes/references/timing.md @fa5dbd1; modified for RestorffCut.

## Every move makes a claim
Finish the sentence "this moves because …" or cut the move. Motion has four jobs: direct attention, carry
continuity, show change, express character. One motivated move beats four decorative ones. Chain moves so each is
launched by the last (click → squash → release → flight → impact → recoil → reveal); an effect starts **on** the
frame of its cause, never "shortly after". Reactions scale with mass: big things rebound slower, small ones snap.

## Ease by role
| Role | Ease (RC preset · timeline-style name) | Duration |
| --- | --- | --- |
| Arrival, landing | `snappy` · `expo.out` / `power4.out` | 0.3–0.5 s |
| A calm arrival | `gentle` · `power2.out` / `sine.out` | 0.4–0.6 s |
| Camera move, colour flood, on-screen move | `smooth` · `power2.inOut` | 0.4–0.8 s |
| Exit, zoom-through, push away | `ease-in` · `power3.in` / `power2.in` | 0.2–0.35 s |
| Overshoot on a pop | `bouncy` · `back.out(1.4–1.7)` | 0.3–0.5 s |
| Rotation, progress bars, constant speed | `linear` · `none` | as long as it runs |
Arrive slow, leave clean: long-tailed ease-outs on arrivals; landing takes longer than leaving; an exit is one smooth
motion, never slide, stop, then leave. Use at least 3 eases in a scene: the same `power2.out` at 0.5 s on everything
is the flat default that makes a video feel generated. Entrances that are too snappy read as glitches; slowing the
whole piece by about a second often fixes it. Never `.inOut` on an entry.

## Durations, overlap, stagger
- A fast move takes 0.3–0.6 s; a single entry stays under ~0.8 s (a longer build-up is a stagger, not one slow element).
- Exits are 40–50 % shorter than their entrances (never longer).
- **Overlap**: the next element starts when the previous is 30–50 % done. Fully sequential looks robotic; all at once
  looks cheap. No two elements share a start or end time; offsets irregular, each shorter than the animation it offsets.
- **Stagger**: letters 1 frame apart, words 60–120 ms, list items 40–80 ms; total stagger at most ~0.5 s (with 8+
  items tighten it). Stagger what arrives, not what was already there. Delay the supporting elements, never the focal one.
- Offset the first tween 0.1–0.3 s after a cut; a caption or title at exactly 0 s looks pre-existing.
- Similar elements share one ease and duration; no unique pair per element.

## Springs and overshoot
Name springs by damping ratio: 1.0 never bounces, 0.7–0.85 reads premium, 0.4–0.6 playful, under 0.3 a cartoon.
Position and size may bounce; **opacity and colour never do; a number never overshoots**. Nearest presets: `bouncy`
(one overshoot, ≈ `back.out(1.7)`), `springy` (damped spring), `elastic` (≈ `elastic.out(1, 0.5)`); `bounce` is a
ball drop, for objects only. No bounce on UI. Spring equivalents: damping 12 / stiffness 100 ≈ `back.out(1.4)` over
0.7 s; 8 / 200 ≈ `back.out(2)` over 0.6 s; overshoot-clamped ≈ `power3.out` 0.6 s.

## Titles
- A landed title is **dead still**; the motion moves on to the next element, the camera or the world behind.
- Vary entrances within a piece, never a fade-and-slide-up for each. Measured entrances that work:
  per word blur 6 px → 0 and opacity 0 → 1 in 0.13 s, 0.067 s apart, no travel · per word from light grey to ink,
  0.07–0.1 s apart · the whole line blurring in, 8 px → 0 in 0.13–0.2 s · per letter for a name, 0.1 s apart,
  opacity 0.3 → 1 with a slight blur · behind the speaker (`guide captions`) · one word rolling through options like a
  slot machine, about 0.1 s a roll · a **waterfall**: words rise from below, each starting before the last settles.
- Waterfall numbers: anchor words travel 60–80 px over 0.16–0.20 s, normal words 40–50 px over 0.13–0.16 s, light
  words and punctuation 30–48 px over 0.10–0.13 s; gaps shrink ×0.84 per word; opacity flips 0 → 1 at the start
  (no fade); ease `snappy`.
- Hold a line 0.5 s + 0.3 s a word (last line ≥ 2 s), then exit with a blur-out and fade of 0.13–0.25 s, word by
  word, or with the scene's move.
- Size: 4–9 % of the frame height, one or two lines; quiet lines 2.5–4 % against hero words that fill 60–90 % of the
  width. One highlighted word in the accent, and it carries meaning.

## One hero move per shot
One hero move per shot. Secondary moves travel 50–70 % as far and start 100–200 ms after it; everything else holds.
The camera is an actor: at most one continuous move per scene (a 4–8 % push, an orbit, a parallax), and it does not
decay to a dead stop at the end of the clip (ease over a window slightly longer than the clip). Depth planes move at
different rates (about 0.2× / 1× / 6×); occlusion sells depth more than blur.

## Sustained motion, not wobble
Breathing, floating, pulsing or glowing loops standing in for motion on titles and UI are banned: they read as "the
video is waiting". Between entry and exit every phase is owned by one of: **staged reveals** (hold content back, pay it
off on the voice's beats), **camera with intent** (establish wide → travel → arrive), **UI life** (progress advances,
counts tick, highlights step), **animated sequences** (a card files into a stack, an item is dragged), **cursor-led
action** (a big cursor walks the eye and its click ignites the next beat: `guide video-types`). A character's idle
breath or blink is acting, not wobble.

## Group slides: the nudge curve
Repositioning a composed group (to make room) is three tweens on one property, never one `power4.inOut` (it smacks
to a stop): ramp-in `ease-in` ~10 % of the distance in ~20 % of the time; burst `linear` ~65 % in ~18 %; tail
`snappy` ~25 % in ~62 % (tail ≥ 3× the ramp-in in time). Reveal new content during the burst.

## Motion blur and handmade feel
A fast move carries blur on its own ease, peaking at its fastest frame: 6–12 px on text-sized elements, 15–20 px
full-frame. `RC.set({blur})` is round, not directional: keep it at 4–8 px on the fastest 2–3 frames (ASSUMPTION: a
round blur above ~8 px on text reads as defocus, not speed). Handmade jitter: a seeded random per held pair of frames,
`RC.random(seed)()` with `seed = Math.floor(Math.round(time.T * RC.fps) / 2)` (quantise on the integer frame, not on
seconds); a drawn line that boils redraws about 12 times a second with a jitter seeded by `Math.floor(time.T * 12)`.

## When the person says …
| They say | Change |
| --- | --- |
| "too fast" | slow every zoom and pan to 0.7× of its speed, nothing else |
| "speed this up" | speed the content and shorten the beat by the same amount; later beats move up |
| "the titles move" | land them, then hold them dead still until they leave |
| "it feels like slides" | enter the next scene through an object on screen; cut a move mid-flight (`guide transitions`) |
| "it's busy" | remove a third of the motion; keep the moves that lead the eye |
In a composition, "slower / faster / bouncier / calmer / snappier" are param nudges (`speed`, `ease`): change props,
not code (`composition update {props}` or `revise`).

## Defaults that look generated
Breathing or floating loops on titles; titles that keep sliding or scaling after they land; a slow creeping scale on
a title late in a scene; bounce on UI; click rings; every scene entering the same way; every element fading and
sliding up; everything on one curve at once; idle sine loops filling time.
