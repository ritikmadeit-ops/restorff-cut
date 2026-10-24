# @restorffcut/timeline-ops — ops@1 and the pure reducer

**Version 0.1.0** (see [CHANGELOG.md](CHANGELOG.md)). Owner: the ops agent (BUILD-BRIEF §5). Worklog:
[../../docs/restorff/worklog/ops.md](../../docs/restorff/worklog/ops.md).

## What it is

The piece that lets Claude edit a RestorffCut timeline **without touching the editor's browser commands**
(BUILD-BRIEF B7, plan/05 §8):

```text
Claude ──ops@1──▶ gateway timeline_ops ──▶ apply(project, ops) ──▶ new project JSON ──▶ commit ──▶ editor pulls it
```

- `apply(project, ops, {seed})` is a **pure reducer** over the editor's real project JSON: it never mutates its input,
  uses no clock and no randomness (ids are derived from `seed`), and returns what every op did.
- ops@1 is the vocabulary of plan/06-mcp.md §5 as TypeScript types plus a dependency-free runtime validator.
- `cutFromTranscript(words, opts)` is the seed of the compiler (EDT-03): talking-head auto-cut → ops.

Files: [MODEL.md](MODEL.md) (the project JSON as it really is, with file:line), [PARITY.md](PARITY.md) (each editor
command → op → reducer → test), [LEARNINGS.md](LEARNINGS.md), `src/` (code), `test/` (tests and the fictional
Halcyon Cold Brew fixture).

## Setup

Nothing to install: no dependencies. Needs Bun 1.2.18 (tests) and/or Node 24 (runs the `.ts` files directly with type
stripping). The package is in the root workspace (`packages/*`); `bun install` has **not** been re-run, so the web app
cannot `import "@restorffcut/timeline-ops"` yet (see Open questions 2).

## Run it (from `restorffcut/packages/timeline-ops`)

| Step | Command | Expected (MEASURED 2026-10-20, reducer-perf) |
|---|---|---|
| 1. Tests | `bun test` | `140 pass` · `0 fail` · `Ran 140 tests across 10 files` (~2.5 s) |
| 2. Node smoke | `node --test test/smoke.node.ts` | `ℹ tests 3` · `ℹ pass 3` · `ℹ fail 0` |
| 3. Types | `node ../../node_modules/typescript/bin/tsc -p tsconfig.json` | no output, exit 0 |
| 4. Old vs new, whole suite | `bun test --preload ./test/dual-apply.preload.ts` | `140 pass` · `0 fail` and the line `dual-apply: 532 apply() calls so far, 532 byte-identical (old reducer vs new)` |
| 5. Speed | `bun bench/apply.bench.ts` | a table (see [Speed](#speed)); column `same` = `true` wherever the old reducer ran |

From the repo root: `bun test packages/timeline-ops` (same 140). If a test fails, the failure names the op and the
field; run that file alone (`bun test test/reducer.test.ts`). Step 4 fails a test whenever the new reducer's JSON
differs from the frozen pre-rewrite one (`test/reference/reducer-v0.ts`) on any `apply()` the suite makes. Steps 1 and
4 also run `test/equivalence.test.ts` (bench batches, every op kind, a random chain, broken inputs — old vs new).

## API

```ts
import { apply, validateOps, cutFromTranscript } from "@restorffcut/timeline-ops";

const result = apply(project, ops, {
  seed: "AD-014/commit-7f3a", // required; same project + ops + seed = same output, byte for byte
  sceneId: undefined,         // default: project.currentSceneId, else the main scene
  mode: "atomic",             // default; "best_effort" skips conflicting ops and continues
  snap: "none",               // default; "frame" rounds every op time to the project's frame grid
  at: undefined,              // ISO time to write to updatedAt; omitted = timestamps untouched
  styles: {},                 // extra apply_style presets
});
// result.project            the new project (the input is untouched)
// result.changes.ops        one entry per op: {index, op, author, status, summary, created?, updated?, removed?, details?}
//                           status: applied · noop · pending · conflict · invalid · skipped · rolled_back
// result.changes.unsupported ops the model can't express; each is also in project.metadata.restorff.pending
// result.changes.refs       `ref` aliases defined in the batch → ids
// result.changes.applied    the ops as applied, apply_style recorded expanded — what a commit should store
// result.conflicts          [{index, op, kind, message, target?}]  kind: invalid_op · missing_target · incompatible ·
//                           overlap · out_of_range · invariant · unknown_preset · duplicate_ref
// result.ok                 true when nothing conflicted
```

In `atomic` mode the first conflict aborts the batch: the project comes back unchanged, earlier ops are marked
`rolled_back`, later ones `skipped`. An invalid op (validator) always rejects the whole batch before anything runs.

## ops@1 reference

Times are **seconds** (numbers); the reducer converts with the editor's own rule, ticks = round-half-away-from-zero
(seconds × 120 000). `t` is timeline time; `in`/`out` are source times (seconds into the media file). Targets are ids,
`ref`s defined earlier in the batch, or `"main"` for the main track. Every op needs `author`: user · claude · compiler
· preset. Full types: `src/ops.ts`.

| Op | Fields | Lands in the model as | Status |
|---|---|---|---|
| `set_canvas` | `w, h, fps (29.97 or {numerator, denominator}), background` | `settings.canvasSize/fps/background` | native |
| `add_size_variant` | `aspect, reframe` | pending (`variant-compiler`) | recorded no-op |
| `import_media` | `blob_sha \| url, kind, duration, width, height, fps, has_audio, ref` | `metadata.restorff.media` manifest; the asset must be created in the media store with the same id | partial |
| `add_track` | `kind: video · audio · text · caption · overlay · effect, name, index, ref` | a track in its group (caption = text track "CAPTIONS" on top; overlay = graphic) | native |
| `remove_track` / `reorder_tracks` | `track` / `order: [ids…]` | track groups | native |
| `insert` | `track, t, media \| text \| shape, in, out, dur, name, params, style, ref` | a video/image/audio/text/graphic element with editor defaults | native |
| `move` / `trim` / `split` / `delete` / `ripple_delete` | `el, t, track` / `el, in, out` / `el, t, ref` / `el` / `el, scope` | element times and trims; split halves; ripple shift | native |
| `set` | `el \| track, prop, value` — `x y scale scale_x scale_y rotation opacity volume muted blend text font font_size color align weight name hidden speed source_audio` or any editor param key; track: `name muted hidden` | params / fields / retime / audio separation | native |
| `keyframe` | `el, prop (x y scale rotation opacity volume or a numeric param), t, value, ease, local` | `animations[path]` keys (element-relative ticks) | native; `crop` pending |
| `add_captions` | `words [{text,start,end}], track, style, max_words (1-3), gap, ref` | text elements "Caption N" on a caption track | native |
| `set_caption_style` | `track, style` | caption text params | native |
| `text_pop` | `t, text, style, dur, track, ref` | text element + scale/opacity pop keyframes | native |
| `transition` | `a, b, kind, dur` | `cut`/`match`: no-op; `fade`: opacity keyframes; any kind in `src/transitions.ts` (dissolve, dip-black, flash, whip-left, push, slide, zoom-in, wipe, iris, glitch, blur…): `transitionIn` on `b` (v32); unknown kinds pending | native |
| `gain` | `el, db` | `params.volume` (dB) | native |
| `duck` | `track, under, amount_db, attack_ms, release_ms, spans?` | linear volume keyframes on the ducked track's elements (under `spans` when given) | native |
| `beats` | `el, bpm, times (source s), downbeats?, source?` | beat grid on a music element (v32) | native |
| `snap_cuts` | `track?, max_shift?` | rolls cuts onto the nearest beat | native |
| `sfx` | `t, name, media \| url+dur, track, db, ref` | an audio element on an SFX track; by name only → pending (`gateway`) | partial |
| `normalize` | `lufs, true_peak` | sets `settings.loudness` (v32); the export masters to it and measures the encoded file | native |
| `grade` | `target (el \| track \| main \| all), preset \| params \| lut` | the `restorff-grade` effect (`src/grades.ts`): a look or a nudge on a clip's `effects`, every clip of a track, or a GRADE adjustment layer ("all"); `none` removes; an unknown look or a `lut` alone → pending | native (LUT: pending) |
| `apply_style` | `preset_id, params` | expands to ops (author `preset`), recorded expanded | native |
| `mark` | `t, note, color, dur` | a frame-rounded bookmark | native |

TextStyle keys: `font size color weight italic align uppercase letter_spacing line_height bg bg_color bg_radius
bg_padding_x bg_padding_y x y opacity` (size is the editor's unit: px = size × canvasHeight / 90; x/y are px from the
canvas centre).

## Example (real output, trimmed)

Ops in (against `test/fixture.ts`, seed `"AD-014/commit-7f3a"`):

```json
[
  { "op": "split", "author": "claude", "el": "el-aroll", "t": 8, "ref": "s02" },
  { "op": "keyframe", "author": "claude", "el": "s02", "prop": "scale", "t": 8, "value": 1 },
  { "op": "keyframe", "author": "claude", "el": "s02", "prop": "scale", "t": 9, "value": 1.15, "ease": "ease_in_out" },
  { "op": "normalize", "author": "claude", "lufs": -14, "true_peak": -1 }
]
```

`changes` out (keyframe ids shortened):

```json
{
  "ops": [
    { "index": "0", "op": "split", "status": "applied", "summary": "split at 960000 ticks: left el-aroll, right c67c8c3d-316a-4b5f-80dc-d897cb3180ea" },
    { "index": "1", "op": "keyframe", "status": "applied", "summary": "scale = 1 at 0 ticks into c67c8c3d-…" },
    { "index": "2", "op": "keyframe", "status": "applied", "summary": "scale = 1.15 at 120000 ticks into c67c8c3d-…" },
    { "index": "3", "op": "normalize", "status": "pending", "summary": "normalize to -14 LUFS / -1 dBTP recorded for the render" }
  ],
  "unsupported": [{ "index": "3", "op": "normalize", "pendingId": "e104f9e3-4d6d-4e8d-a2fb-99addd4c5de5", "honouredBy": "render" }],
  "refs": { "s02": "c67c8c3d-316a-4b5f-80dc-d897cb3180ea" }
}
```

The new right-hand element in the project out:

```json
{
  "id": "c67c8c3d-316a-4b5f-80dc-d897cb3180ea", "type": "video", "name": "S01 talking head (right)",
  "mediaId": "media-aroll", "startTime": 960000, "duration": 1440000, "trimStart": 960000, "trimEnd": 0,
  "sourceDuration": 2400000, "isSourceAudioEnabled": true, "hidden": false, "restorff": { "author": "claude" },
  "animations": {
    "transform.scaleX": { "keys": [
      { "id": "37e05c9f-…", "time": 0, "value": 1, "segmentToNext": "bezier", "tangentMode": "flat", "rightHandle": { "dt": 50400, "dv": 0 } },
      { "id": "f841131e-…", "time": 120000, "value": 1.15, "segmentToNext": "linear", "tangentMode": "flat", "leftHandle": { "dt": -50400, "dv": 0 } }
    ] },
    "transform.scaleY": { "keys": ["…same two keys…"] }
  }
}
```

## Talking-head auto-cut

```ts
const plan = cutFromTranscript(words, { clip: { el: "el-aroll", start: 0, in: 0, out: 20 } });
// options: silence (0.35 s), pad (0.05 s), retakeWindow (3 sentences), sentencePause (0.8 s), captions, author, refPrefix
apply(project, plan.ops, { seed });
```

It drops pauses longer than `silence` (keeping `pad` around words), drops the earlier take of a repeated sentence (same
words, or an aborted start the next sentence begins with), emits `trim`/`split`/`ripple_delete` from the clip's end
backwards, then `add_captions` with the kept words re-timed onto the cut timeline. `plan` also returns `kept`,
`removed` (with reasons), `retakes`, `words` and `stats`. On the fixture transcript (16 words, one retake): 20 s → 4.4 s
in 3 gap-free pieces, captions "Halcyon cold brew." · "Steeped for twenty" · "hours." · "Never bitter." · "Try it
today." (test/talking-head.test.ts).

## Compiler: storyboard → v0

EDT-03. A storyboard (Zeigarnik board) or a brief (Zeigarnik doc) plus its assets becomes ops@1 that build the first
editable timeline on the gateway's empty skeleton (TEXT · CAPTIONS · V2 B-ROLL · V1 A-ROLL · MUSIC · SFX, 9:16, 30 fps).
Files: `src/compilers/storyboard.ts`, `src/compilers/from-board.ts`, `test/compiler-storyboard.test.ts`. Owner: the
compiler agent; worklog `../../docs/restorff/worklog/compiler.md`. A port of evolve-agent's
`studio/clipgen/board_edit.py` (ffmpeg) to ops: same editing rules, an editable timeline instead of an MP4.

```ts
import { compileStoryboard, specFromBoard, specFromBrief, apply } from "@restorffcut/timeline-ops";

const spec = specFromBoard(boardExportJson, { brief: briefExportJson, style: "aesthetic-warm" }); // or specFromBrief(doc)
const { ops, report } = compileStoryboard(spec, assets, { seed: "AD-014" });                      // pure, no I/O
const result = apply(emptyProject(...), ops, { seed: "AD-014/compile" });                          // the v0 commit
```

**When to use it:** once per ad, to make v0 from the board and the generated media. Every later change is ordinary ops
(`timeline_ops`), a person in the editor, or a style / sentence (`resolveSentence`).

### Inputs

`specFromBoard(json, {brief?, style?, aspect?})` takes Zeigarnik's JSON export — `GET /api/boards/<id>/export?format=json`,
the MCP `boards {action: "export", format: "json"}` payload, or `GET /api/boards/<id>` — **not** the `boards get`
outline (it flattens cards to text; refused with an error). One beat per column, left to right; the column title
"S03 · Pour" gives id and title; shot cards give `visual` → shot, `words` → line, `duration`, `image` → asset ref.
Shot cards have no emphasis / effect / sound fields, so these are read from the text:

| Write on the board | Becomes |
|---|---|
| words `(sound only: the crack)` | no line; sound cue "the crack" (any other `(…)` is a direction, kept in `notes`) |
| words `*kettle*` | emphasis "kettle" (punch-in on that word) |
| a number in the words ("18 hours", "30 % off") | emphasis "18" / "30" |
| `SFX: whoosh` or `Sound: …` in visual / purpose | sound cue |
| `FX: Digital Zoom, whip` in visual / purpose, or a two-word EFFECTS.md name in the visual | effects |
| "slow push", "pull back", "pan left", "tilt up", "slow-motion", "whip" in the visual | camera move / 0.5× / whip |
| column or shot titled "End card" (or a purpose starting "CTA") | the end card; its line is the CTA |
| an open comment on the shot or column | `notes` |

`specFromBrief(json, {hook?: "H1", wordsPerSecond?: 2.6})`: the hook (H1 by default), one beat per sentence of
"Hold", the "CTA" as the end card, "Claims" as `spec.claims`; durations estimated from word counts. With
`specFromBoard(board, {brief})` the brief's CTA replaces the end card's text (the task: "end card = CTA from the brief").

The spec (`StoryboardSpec`) can also be written by hand:

```ts
{ title?, aspect?: "9:16", style?: "fast-ugc" | "talking-head" | "aesthetic-warm" | "moody-captions" | "paper-collage",
  cta?, hooks?, claims?, beats: [{ id: "S03", title?, shot?, line?, emphasis?: string[], effects?: string[],
  sound?, assets?: string[], duration?, kind?: "beat" | "end_card", cta? }] }
```

Assets (`StoryboardAsset[]`) — ids are media ids in the editor's media store:

```ts
{ id, kind: "image" | "video" | "voice" | "music" | "sfx", duration_s?, width?, height?,
  words?: [{ word, start, end }],   // seconds INTO the file: a voice, or a video that carries the dialogue
  beat?,                            // else matched by the beat's `assets` list or by id prefix "S03-…"
  effect?,                          // a rendered composition clip (EFFECTS.md slug) for a beat's effect
  sync_s?, db?, has_audio?, url?, blob_sha?, name?, tags? }
```

A voice attached to no beat is the shared VO: each beat's line is found in its words in order (number words match
digits: "eighteen" = "18"). A video with `words` is a talking-head beat: the clip itself is cut to its words on V1.

### What the ops do (defaults; every number is an option)

| Part | Rule |
|---|---|
| Cuts on the word | a voiced beat starts 0.08 s (`cutLead`) before its first word, frame-rounded; VO pieces keep 0.30 s head / tail (`head`, `tail`) but never cross a neighbouring word; `timing: "board"` (default) holds a beat to max(its voice, its duration hint), `"voice"` to its voice |
| Shots | first image/video of a beat on V1 A-ROLL (gap-free from 0); more visuals go on V2 B-ROLL, cut on the word nearest their share of the beat; a video shorter than its shot is slowed (≥ 0.5×) to fill; "slow-motion" plays at 0.5× |
| Camera | stills: push in / pull out (1 ↔ 1.07, or the style's push) or pan / tilt at 1.10, picked by the seeded PRNG unless named; the end card pushes in |
| Punch-ins | each emphasis word: scale × 1.15 (hold step) on its onset, held ≥ 0.6 s; "Digital Zoom" without emphasis punches the middle word |
| Captions | `add_captions` on CAPTIONS from the voice's own words (verbatim), 1-3 words, the style preset's caption style; not over the end card |
| Music | the bed from 0 to the end (repeated back to back if short), −10 dB, ducked 8 dB under the voice (80 / 300 ms), faded to −60 dB over the last 1.2 s |
| SFX | the beat's cue (its own sfx asset → any sfx asset whose name matches → `sfx.library` entry → a **pending** `sfx` by name for the gateway); a whoosh on every cut (sfx assets named whoosh / swish, or the library's whoosh-short / swish, alternating) at its sync point; ≥ 0.25 s apart, cue wins; extra SFX lanes when they overlap |
| Grade | the style preset's grade (or `grade`), plus beat effects like "grade-warm" → `grade` ops, applied as the `restorff-grade` effect (whole cut = a GRADE layer under the captions; a beat's grade = on its shot); only a look `grades.ts` does not know stays pending |
| Transitions | the style's join (fast-ugc: whip) or a beat's named transition ("whip", "Zoom Through Cut", "dissolve"…) → `transition` into that beat |
| End card | the CTA as a `text_pop` on TEXT over the end-card shot (a free packshot/logo image, else the last still again) |
| Also | a bookmark per beat ("S03 · Pour — "line""), `normalize` −14 LUFS / −1 dBTP, `gain −14` on a silent shot's own audio under VO |

`report`: per beat `{start, end, voice, visual, broll, punches, transitionIn, sfx, placed, skipped, warnings}`, plus
`counts`, `placed` (lines for a person), `skipped` (with reasons), `missing` (what ops@1 cannot say yet, with the
workaround), `pending`, `unusedAssets`, `notes`, and `validation` (`validateOps` of its own output).

### Run it (from `restorffcut/packages/timeline-ops`)

| Step | Command | Expected (MEASURED 2026-10-20) |
|---|---|---|
| Tests | `bun test test/compiler-storyboard.test.ts` | `9 pass` · `0 fail` · `Ran 9 tests across 1 file` |
| Example (Git Bash, plain Node 24) | the command below | first line `20 ops, valid: true \| duration 5.9 s` |

```bash
node --input-type=module -e '
import { compileStoryboard } from "./src/index.ts";
const spec = { title: "Halcyon demo", style: "talking-head", beats: [
  { id: "S01", title: "Hook", line: "Six a.m. and the kettle is still cold.", duration: 2.5 },
  { id: "S02", title: "End card", kind: "end_card", line: "First box 30 % off.", duration: 2.5 } ] };
const said = "Six a.m. and the kettle is still cold. First box thirty percent off.".split(" ");
const words = said.map((word, i) => ({ word, start: 0.4 + i * 0.38 + (i > 7 ? 0.35 : 0), end: 0.7 + i * 0.38 + (i > 7 ? 0.35 : 0) }));
const assets = [ { id: "S01-fridge", kind: "image" }, { id: "S02-can", kind: "image" },
  { id: "halcyon-vo", kind: "voice", duration_s: 6.5, words }, { id: "halcyon-bed", kind: "music", duration_s: 30 },
  { id: "whoosh-air", kind: "sfx", duration_s: 0.45, sync_s: 0.27 } ];
const { ops, report } = compileStoryboard(spec, assets, { seed: "AD-014" });
console.log(ops.length, "ops, valid:", report.validation.ok, "| duration", report.duration, "s");
console.log(report.placed.join("\n"));
'
```

Real output (2026-10-20), then the ops it made — add `for (const op of ops) console.log(JSON.stringify(op));` to the
command to print them (author fields and the word list trimmed here):

```text
20 ops, valid: true | duration 5.9 s
2 shot(s) on V1 A-ROLL, 0 b-roll on V2, 0 composition(s)
2 VO piece(s) on VOICE; 8 caption word(s)
4 camera keyframe(s), 0 punch-in(s), 0 transition(s)
music bed × 1, ducked under the voice, faded out
1 SFX placed, 0 pending
no grade
end card S02: "First box 30 % off."
```

```json
{"op":"add_track","kind":"audio","name":"VOICE","index":0,"ref":"sb-voice"}
{"op":"insert","track":"trk-main","t":0,"media":"S01-fridge","media_kind":"image","dur":3.4,"name":"S01 · Hook","ref":"sb-b0-v"}
{"op":"insert","track":"trk-main","t":3.4,"media":"S02-can","media_kind":"image","dur":2.5,"name":"S02 · End card","ref":"sb-b1-v"}
{"op":"keyframe","el":"sb-b0-v","prop":"scale","t":0,"value":1.07}
{"op":"keyframe","el":"sb-b0-v","prop":"scale","t":3.4,"value":1,"ease":"ease_in_out"}
{"op":"keyframe","el":"sb-b1-v","prop":"scale","t":3.4,"value":1}
{"op":"keyframe","el":"sb-b1-v","prop":"scale","t":5.9,"value":1.07,"ease":"ease_in_out"}
{"op":"insert","track":"sb-voice","t":0,"media":"halcyon-vo","media_kind":"audio","in":0.32,"out":3.575,"name":"S01 VO","ref":"sb-b0-vo"}
{"op":"insert","track":"sb-voice","t":3.265,"media":"halcyon-vo","media_kind":"audio","in":3.575,"out":5.91,"name":"S02 VO","ref":"sb-b1-vo"}
{"op":"add_captions","track":"trk-captions","words":["…8 words…"],"max_words":3,"style":{"font":"Inter","size":4.6,"weight":"bold","color":"#FFFFFF","bg":false,"align":"center","y":384}}
{"op":"text_pop","t":3.4,"text":"First box 30 % off.","dur":2.5,"track":"trk-text","style":{"size":4.2,"weight":"bold","color":"#FFFFFF","align":"center","y":307,"bg":true,"bg_color":"#111111","bg_radius":24},"ref":"sb-cta"}
{"op":"insert","track":"trk-music","t":0,"media":"halcyon-bed","media_kind":"audio","in":0,"out":5.9,"name":"Music bed","ref":"sb-music-1"}
{"op":"gain","el":"sb-music-1","db":-10}
{"op":"duck","track":"trk-music","under":"sb-voice","amount_db":8,"attack_ms":80,"release_ms":300,"spans":["…"]}
{"op":"keyframe","el":"sb-music-1","prop":"volume","t":4.7,"value":-18}
{"op":"keyframe","el":"sb-music-1","prop":"volume","t":5.9,"value":-60}
{"op":"sfx","t":3.13,"name":"SFX whoosh-air · cut to S02","media":"whoosh-air","dur":0.45,"track":"trk-sfx","db":-8,"ref":"sb-sfx-1"}
{"op":"mark","t":0,"note":"S01 · Hook — \"Six a.m. and the kettle is still cold.\"","dur":3.4}
{"op":"mark","t":3.4,"note":"S02 · End card — \"First box 30 % off.\"","dur":2.5}
{"op":"normalize","lufs":-14,"true_peak":-1}
```

Read it: S01 cuts at 0 and its VO starts 0.08 s before "Six"; S02 cuts at 3.4 s, 0.08 s before "First", with its VO
piece starting at 3.265 s (the 0.135 s breath before the word plays under S01's last frames). The style's
`badge-pills` composition is named in `report.notes` (it needs a render).

On the real storyboard (`brd_a63fb6184d10`, 12 shots) with the real brief and fake assets: 96 ops, apply() ok on the
gateway's `emptyProject()`, 0 conflicts, 34.13 s (MEASURED; worklog checkpoint 1).

### Known limits
- Name-only `sfx` is recorded as pending by the reducer (the gateway resolves sound names); so is a `grade` whose look
  `grades.ts` does not know. Effects that need a composition are placed only when a rendered clip is passed as an asset with `effect`.
- ops@1 gaps the compiler works around are listed in every `report.missing`: no per-word caption highlight, no
  placeholder on a video track, no beat id on elements (EDT-14 sync keys on names + bookmarks), no track role, no text
  wrap (the CTA uses `\n`, UNVERIFIED in the editor's renderer), no music loop, no punch-in centre (face box).
- UNVERIFIED in the browser editor: none of the compiled projects has been opened in RestorffCut yet.

## Speed

`apply` is near-linear in the number of ops (reducer-perf, 2026-10-20). MEASURED with `bun bench/apply.bench.ts
--old-max 10000` (Bun 1.2.18, owner's Windows machine; new = best of 3, old = one run of the frozen pre-rewrite
reducer; `same` = byte-identical JSON):

| batch (bench/batches.ts, Halcyon) | ops | new | old | same |
|---|---|---|---|---|
| captions: buildCaptionOps huge-centred, 10 ops/word | 602 / 2,702 / 10,002 | 22 ms / 59 ms / 169 ms | 0.59 s / 10.8 s / 179 s | true ×3 |
| inserts: n text inserts on ONE track | 600 / 2,700 / 10,000 | 7 ms / 34 ms / 122 ms | 0.84 s / 18.0 s / 255 s | true ×3 |
| autocut: split/split/ripple_delete chains + B-roll insert/move/split/delete | 600 / 2,700 / 9,999 | 12 ms / 88 ms / 610 ms | 0.28 s / 4.9 s / 90 s | true ×3 |

Autocut stays above linear by the ops' meaning, not the reducer: each `ripple_delete` shifts (and lists in
`changes.ops[i].updated`) every later piece, 889,111 shifts and 52 MB of result JSON at 9,999 ops.

How (details in the header of `src/reducer-state.ts`): the draft is cloned once per batch; an op that conflicts is
undone through an undo log plus a small per-op savepoint, not a per-op `structuredClone`; elements are found through a
live id index; overlaps through a per-track array sorted by start; the invariant list is kept as a multiset updated
from what each op touched, and the full `checkInvariants` runs only to word a conflict (same message, same order).
**Rules for new handlers** (reducer.ts header): never mutate a placed element (copy and replace it); change track
elements only through `ctx.state`; anything else changed in place must be in `savepoint()`.

Still O(track) per op (fine at today's sizes, listed so nobody is surprised): `insert`/`move` on the main track
(`mainTrackStart` scans it), `insert` of a media id that is not in the manifest (`resolveMedia` scans elements),
`set_caption_style` and `ripple_delete` (they touch every caption / every later element), removing from the middle
of a track (array splice), `apply_style` (its expander gets a clone of the project), a project whose media manifest
changes in the op (`import_media`: one full check). A project built in JS with one element/track object in two places
(JSON can't do that) falls back to full checks for the batch.

## Limits and known failures

- **Pending instructions vanish on a browser save:** they live in `metadata.restorff`, and the editor's
  `saveProject` rebuilds `metadata` field by field (MODEL §1, §8). Open question 1.
- The web app's tsconfig rejects `.ts` import paths (MEASURED: 24 × TS5097). Open question 2.
- `import_media` only records a manifest entry; nothing creates the asset in the editor's media store yet.
- Captions are placed at a fixed offset (no text measuring without a canvas); no per-word keyword highlight (one text
  element has one colour).
- `ripple_delete` with `scope: "all"` leaves elements that cross the cut on other tracks where they are (reported as
  `straddling`); if that makes an overlap, the op is refused.
- Keyframes: numbers only (no colour keyframes); `ease` applies to the segment into the key and needs an earlier key.
- No parity test runs the real browser commands yet (PARITY.md, top).
- Costs nothing to run: no network, no credits.

## Open questions (for the orchestrator / owner)

1. Where should pending instructions live so they survive the editor? Options: (a) the skin/editor owner keeps
   `metadata.restorff` in `services/storage/service.ts` saveProject/loadProject; (b) the commit layer stores them beside
   the snapshot (`vc_commits` meta) instead of inside it.
2. apps/web needs `"allowImportingTsExtensions": true` in its tsconfig (legal: it is `noEmit`) and a root `bun install`
   to link the workspace package before the editor can import it. Both are outside this agent's paths.
3. Should `trim` shift keyframes with the content on a left trim? The editor doesn't (D7); for Claude's punch-ins it would
   be friendlier. Kept editor behaviour for now.
4. Ripple across tracks: is "close the gap on every track" (with straddlers refused) the right default for the
   compiler, or should captions/b-roll be re-laid by ops instead? The talking-head compiler avoids the question by
   cutting first and captioning after.
