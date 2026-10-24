---
id: numbers
title: Numbers, charts and maps
summary: One number at a time, made physical; count-ups that never overshoot; charts built in reading order with one series highlighted; maps on real pictures; and the tells of a data video.
read_when: Whenever a number, a statistic, a chart, a comparison or a map is on screen.
aliases: data, chart, charts, stats, statistics, counter, count-up, graph, map, maps, number, kpi
tools: effects, composition, plan
related: motion, typography-layout, story, composition-authoring
next: effects describe | Look at the library first: effects describe "Chart Grow" (or "Counter / flip-clock").
source: skills/hyperframes/references/types/data.md; references/film.md; docs/prompting/{data-and-maps,motion,anatomy,examples}.mdx; skills/remotion-to-hyperframes/references/timing.md; .claude/skills/changelog-video/references/visualization-registry.md
---
# Numbers, charts and maps

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/references/{types/data,film}.md, docs/prompting/{data-and-maps,motion,anatomy,examples}.mdx, skills/remotion-to-hyperframes/references/timing.md, .claude/skills/changelog-video/references/visualization-registry.md @fa5dbd1; modified for RestorffCut.

## One number at a time
- A number is **earned** by the scene before it, then made physical: a count that becomes a stack of cans, a share
  that becomes a crowd, 18 hours that becomes a clock face sweeping.
- The number is the biggest thing on screen. Tabular figures (`font-variant-numeric: tabular-nums`) so a count-up
  does not jitter; JetBrains Mono or Archivo 900 for the digits.
- A count-up runs **1.2–1.6 s**, then holds, and lands on a downbeat or a hard stop. Ease out (`gentle`/`smooth`;
  `power3.out` in the timeline style), and a number **never overshoots** (no `bouncy` on a value; the box around it
  may bounce). Write the copy as "counts up to $4.2M", not "$0 → $4.2M".
- Real data only, from the source, rounded the same way everywhere, with a small source line on screen when the
  claim needs it. One params block (or the timeline kit) drives every figure so the numbers agree.
- An end pulse: +16 px overshoot of the **container** finishing on the last frame of the beat, or a three-frame flare
  as the one accent.

## The library first
`effects list` → the data rows: **Chart Grow** (bars or a line that grow to the given values), **Counter /
flip-clock**, **Checklist** (ticks on the words), **Badge pills**, **Chips that tick**, **Waveform with collapsing
gaps**, **Easing-curve explainer**, the **Map with route and city pins**; `effects describe <name>` lists their params;
`effects apply <name> {word: "doubled"}` lands it on the spoken word. Write a chart as a composition only when none
fits (`guide composition-authoring`); say which you chose.

## Charts as pictures
- Build in reading order: the frame and axis, a reference line, then the data drawing in, then **one annotation on
  the point that matters**. Annotate on the mark; no legends.
- Highlight one series in the accent, grey the rest (ink at 45 %). A chart with one thing to say says it in its title.
- Fix the scale up front: a new value never rescales the axis mid-shot.
- Bars grow from their base (`scaleY` from 0 with the origin at the bottom, 0.6 s `snappy`, +0.15 s each); a line
  draws itself (SVG `stroke-dashoffset` from the full length to 0 over ~1 s `gentle`, the value riding the tip).
  Labels count up while the next bar grows. Name which bar overtakes and when, in the plan.
- Flat fills only: a light-to-dark gradient in a bar makes the tallest bar palest exactly where the eye compares.
- The same object carries across beats: a bar becomes the ground of the next scene, a line becomes the road the camera
  follows. The camera can dive into the one value that matters while the rest falls away.
- Encoding: colour for a region map, size for bubbles, equal tiles for equal weight, arcs for flows.

## Comparisons
Before/after: the new side moves calmly while the old side churns; never mock a named competitor. Library: **Before/
after wipe**. A comparison holds long enough to read both sides (0.5 s + 0.3 s per word on each) before the wipe.

## Maps and real places
A real place is shown on a real picture of it (a photo, a satellite still the person supplies); vector outlines read
as a diagram and lose the place. Compositions render with the network blocked, so a map is an image param
(`data:` image or a timeline media id), never live tiles. Draw borders, pins and labels as SVG on top, and animate
them only while the camera holds. A route with a vehicle is a journey, not just an arc. End on the settled map. Credit
the imagery on screen in small type on a soft dark backing when its licence asks. A point you guess on an image misses
by 16–24 % of the frame: look at a still with a grid and correct it.

## When there is nothing to chart
Visualise rather than list, in this order: a faithful picture of the real thing; an honest analogue that shows the
behaviour (speed, waiting, steeping); real output; and only last a checklist of at most 6 rows. Never fake a
dashboard for something you cannot show honestly.

## Tells of a data video
A grid of KPI cards; a dashboard; a pie chart; every number counting up at once; numbers with no source; a legend;
gradient bars; the axis rescaling mid-shot; a count that overshoots and settles back.
