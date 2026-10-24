---
id: composition-example
title: A worked composition (three-beat kinetic type)
summary: A complete custom composition that validates and renders today (three lines, per-word blur-in, key word on an accent box, zoom-through seams, sound cues from params), with its props, the call that places it, and the three faults found by looking at it.
read_when: When writing your first custom composition, or a kinetic-type piece; copy it and change the params, not the structure.
aliases: example, worked-example, kinetic-example, sample, template, starter
tools: composition, look
related: composition-authoring, motion, transitions, animation-runtimes
next: composition write | Place it: composition write {timeline_id, source, props, duration_s, t}.
source: patterns from skills/hyperframes/references/motion.md (title entrances, holds); .claude/skills/cut-the-curve/SKILL.md (zoom-through numbers); skills/hyperframes/references/captions.md (start after 0 s, hard kill); the code is RestorffCut's own (hf-skills agent, 2026-10-24)
---
# A worked composition: three-beat kinetic type

Adapted from HyperFrames skills (Apache-2.0) skills/hyperframes/references/{motion,captions}.md and .claude/skills/cut-the-curve (the numbers) @fa5dbd1; modified. The code below is written for RestorffCut's contract.

## What it shows
- **Params carry every word and every time** (`beats[{text, at}]`, `highlight`, `accent`, `speed`, `scale`): a new
  script re-times it without touching the code.
- **Layout once, in `build`**: one word per row at display size; the font steps down until the widest word fits 92 %
  of the safe width (never below 64 px on the grid).
- **Entrance**: each word blurs in, 8 px → 0 and opacity 0 → 1 in 0.16 s, 0.07 s apart, no travel (a landed title
  stays still). The first word ignites at 15 % so the seam has no empty frame.
- **Key word**: its accent box sweeps in 0.25 s after the word lands; the word turns dark only once the box is under
  it (dark ink over footage would vanish otherwise).
- **Seams: zoom-through.** The outgoing line grows 1 → 1.2 while blurring 0 → 10 px and fading to 0.15 in its last
  0.2 s (`ease-in`); the incoming line starts at scale 0.75 and keeps growing to 1 over 0.5 s (`snappy`): same
  direction, matched speed, never both lines visible.
- **Voice sync**: each line starts at `RC.cue(at)`; its animation runs on `RC.since(time.T, at)`, so `speed` changes
  the motion, never the cue times.
- **Sound cues computed from params** in `build` (`window.__rcCues`): a whoosh 0.1 s before each zoom-through, an
  impact when the last line lands. `sounds design` places them.
- The last line holds 2.0 s (the video's last line needs at least 2 s).

## The source
```html
<!doctype html>
<html><head><meta charset="utf-8">
<script type="application/json" id="params">
{
  "name": "three-beat-type",
  "title": "Three-beat kinetic type",
  "description": "Short lines, one beat each, one word per row at display size: words blur in one by one, the key word lands on the accent, each line leaves through a zoom-through into the next. For the sentence the viewer must remember.",
  "duration": 5.4,
  "size": [1080, 1920],
  "params": {
    "beats": { "type": "list", "minItems": 1, "maxItems": 4, "required": true,
      "of": { "type": "object", "fields": {
        "text": { "type": "string", "maxLength": 28, "description": "the line, 1-4 words" },
        "at": { "type": "number", "min": 0, "max": 60, "description": "seconds into the clip where the line starts (put it on the spoken word)" } } },
      "default": [{ "text": "STEEPED, NOT RUSHED.", "at": 0.2 }], "description": "the lines in order, each with its start time" },
    "highlight": { "type": "string", "default": "", "maxLength": 16, "description": "the one word that lands on the accent box" },
    "accent": { "type": "color", "default": "#F6FF00", "description": "the key word's box" },
    "speed": { "type": "number", "default": 1, "min": 0.25, "max": 4, "description": "motion speed" },
    "scale": { "type": "number", "default": 1, "min": 0.5, "max": 2, "description": "size" }
  }
}
</script>
<style>
  #stage { position: absolute; inset: 0; }
  .beat { position: absolute; left: 0; right: 0; text-align: center; transform-origin: 50% 50%; }
  .w { display: table; margin: 0 auto; position: relative; line-height: 1; font-family: "Archivo", sans-serif;
       font-weight: 900; font-stretch: 125%; text-transform: uppercase; color: #EDEBE6;
       text-shadow: 0 4px 24px rgba(0,0,0,.55); }
  .w i { position: absolute; inset: 2% -6% 6%; z-index: -1; border-radius: .08em; transform-origin: 0% 50%; }
</style></head>
<body><div id="stage"></div>
<script>
  var K = { beats: [] };
  function norm(s) { return String(s).toUpperCase().replace(/[^A-Z0-9]/g, ""); }
  RC.composition({
    build: function (RC) {
      var P = RC.params, maxW = RC.width - RC.safe.left - RC.safe.right;
      P.beats.forEach(function (b, i) {
        var row = RC.el("div", { class: "beat" });
        var words = String(b.text).split(/\s+/).filter(Boolean).map(function (txt) {
          var w = RC.el("span", { class: "w", text: txt });
          if (P.highlight && norm(txt) === norm(P.highlight)) w.appendChild(RC.el("i", { style: { background: P.accent } }));
          row.appendChild(w);
          return w;
        });
        document.getElementById("stage").appendChild(row);
        // one word per row at display size: shrink until the widest word fits the safe width (layout once, in build)
        var size = 300 * RC.u * P.scale;
        row.style.fontSize = size + "px";
        while (size > 64 * RC.u && words.some(function (w) { return w.offsetWidth > maxW * 0.92; })) {
          size -= 6; row.style.fontSize = size + "px";
        }
        row.style.top = (RC.height - row.offsetHeight) / 2 + "px";
        var next = P.beats[i + 1];
        K.beats.push({ row: row, words: words, at: RC.cue(b.at || 0), end: next ? RC.cue(next.at) : null });
      });
      // sound cues, real seconds into the clip: a whoosh on each zoom-through, an impact on the last line
      window.__rcCues = K.beats.map(function (b, i) {
        return b.end != null ? { t: Math.max(0, b.end - 0.1), kind: "whoosh", label: "zoom-through " + (i + 1) }
                             : { t: b.at + 0.05, kind: "impact", label: "last line lands" };
      });
    },
    render: function (time, RC) {
      var T = time.T;
      K.beats.forEach(function (b) {
        var since = RC.since(T, b.at);                 // animation seconds since this line's cue
        var visible = since >= 0 && (b.end == null || T < b.end);
        b.row.style.visibility = visible ? "visible" : "hidden";
        if (!visible) return;
        // entrance: each word blurs in, 0.07 s apart, no travel (a landed title stays still);
        // the first word ignites at 15 % so the seam has no empty frame
        b.words.forEach(function (w, j) {
          var p = RC.progress(since, j * 0.07, 0.16, "snappy"), floor = j === 0 ? 0.15 : 0;
          RC.set(w, { opacity: floor + (1 - floor) * p, blur: (1 - p) * 8 });
          var box = w.querySelector("i");
          if (!box) return;
          var s = RC.progress(since, 0.25 + j * 0.07, 0.3, "snappy");   // the box sweeps in after its word lands
          RC.set(box, { sx: s });
          w.style.color = RC.mixColor("#EDEBE6", "#0C0C0E", RC.clamp((s - 0.6) / 0.3, 0, 1));
          w.style.textShadow = s > 0.75 ? "none" : "";
        });
        // exit: zoom-through toward camera in the last 0.2 s (scale x1.2, blur to 10 px, opacity to 0.15);
        // the next line arrives small (0.75) and keeps growing to 1: same direction, matched speed
        var out = b.end == null ? 0 : RC.progress(T, b.end - 0.2, 0.2, "ease-in");
        var arrive = RC.progress(since, 0, 0.5, "snappy");
        RC.set(b.row, { scale: (0.75 + 0.25 * arrive) * (1 + 0.2 * out), blur: out * 10, opacity: 1 - 0.85 * out });
      });
    },
  });
</script>
</body></html>
```

## Props and the call
```json
{ "beats": [ { "text": "COLD WATER.", "at": 0.2 }, { "text": "EIGHTEEN HOURS.", "at": 1.8 },
             { "text": "STEEPED, NOT RUSHED.", "at": 3.4 } ], "highlight": "EIGHTEEN" }
```
`composition write {timeline_id, source: <the file>, props: <above>, duration_s: 5.4, t: <where the first word is
said>}` → the clip on MOTION, one commit. With a voice-over, set each `at` to the spoken word's start minus the clip's
`t` (from `transcribe` or the `voiceover` answer). Then `look {kind: "clip", element_id, times: [0.3, 1.75, 2.3,
3.6, 5.2]}`.

## Measured (2026-10-24, the renderer's CLI, 540×960)
`custom --check` → `ok — 5267 bytes, protocol rc, 5 params`; the render → 162 frames at 30 fps in 3.7 s, network
blocked, no requests attempted; sidecar cues `whoosh 1.7 s, whoosh 3.3 s, impact 3.45 s`. Contact sheets on a dark
plate (SEEN): words stacked at display size, the seam at 1.8 s shows the next line already igniting, the key word dark
on its box, the last line still from 3.6 s to the end.
**Three faults the first renders had, each found only by looking** (keep them in mind for your own pieces):
1. One line per beat at 150 px: the type filled ~50 % of a 9:16 frame's width and a sliver of its height → stacked one
   word per row and fitted to the width.
2. The key word was dark from its first frame, before the box reached it: invisible over dark footage → colour
   switches only once the box covers it.
3. A blank frame at every seam (the next line started from opacity 0 exactly as the last one hid) → the first word
   ignites at 15 %.
A first version with an empty default for `beats` was refused (`needs at least 1 items`): every top-level param needs a
valid default, even a required display list.
