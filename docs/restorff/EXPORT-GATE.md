# RestorffCut export gate — what must pass before a final render leaves

**Why.** Owner, 2026-10-11: *"it should be really hard for us to push any bad ad, any generic ad … We won't make
slop."* Owner, 2026-10-19: *"video is 50% audio, so good music, perfect sync and soundeffects is a must."* RestorffCut's
README ("Sound is half the ad", item 4): *"A failing sync blocks export, as a failing lint blocks a board."* So
**Render final** and **Deliver** are gated: every check below runs, and an open **MUST** finding blocks the file from
leaving. Preview renders are never blocked; they show the same findings as markers.

**Where the rules come from.** The studio's review agent cutcritic 1.5.0 (copied 2026-10-20 as Restorff's Judge worker,
`../../../restorff/workers/judge/`), the studio craft bar (CRAFT rules R1–R25, of which R21–R24 are the sound and
desire rules), and `../../README.md` "Sound is half the ad". The Judge stage that consumes these findings:
`../../../restorff/workers/judge/WORKFLOW.md`.

**Status.** File checks: **BUILT** in the Judge worker (`judge.py findings`, verified 2026-10-20 by a planted-defect
self-test, 34/34). Timeline checks, pinning and the MCP `check`: **BUILT** in `packages/gate` (0.2.0, gate-v2,
2026-10-20: piece types §2a, what compositions declare §2b, FACE + FLASH, real lane names, an exact `fix_call` on every
finding; runbook `packages/gate/README.md`, worklog `worklog/gate-v2.md`). The editor's gate sheet: built, not yet seen
in a browser. ASSUMPTION / UNVERIFIED marked inline.

---

## 1. Two sources, and which wins

| Source | When | How exact | Who runs it |
|---|---|---|---|
| **Timeline checks** | on every commit, and again before a final render is started (seconds, no render needed) | **exact**: element times, text strings, tracks, gains, boxes are in the project JSON | RestorffCut (a pure function over the project snapshot, beside the `ops@1` reducer) |
| **File checks** | on the encoded final (and each preview) | measured: loudness, peaks, held/black frames, sync, transcript, OCR | the Judge worker (`measure` → `findings.json`) |

Rules: **loudness, true peak and format are only ever judged on the encoded file** (the mix is not the master: the
studio's `finalize` lesson). **Text is judged from the timeline** when the cut was built in RestorffCut — OCR misread a
planted caption typo for 2 s and read "$4.99" five different ways in the self-test (Judge LEARNINGS 14); OCR is the
backstop for imported MP4s only. When both sources report the same rule within ±0.5 s, they merge into one finding.

## 2. The checks

Severity: **must** blocks Render final / Deliver while `open` or `candidate`; **should** goes into the verdict's
fixes; **info** is context. Track is where the marker is pinned (§3).

| Id | Check | Threshold | Source | Severity | Track | Fix text (template) |
|---|---|---|---|---|---|---|
| **LOUD** | integrated loudness + true peak of the encoded master | −14 LUFS ±1, true peak ≤ −1 dBTP | file (`ebur128=peak=true`) | must | MASTER | "apply {gain:+.1f} dB, then a true-peak limiter at −1 dBTP; re-measure on the encoded file" |
| **MIX** | dialogue over music: music level under the voice while the voice plays | music −18 to −12 dB under the voice; **must** if music is above −6 dB re voice | file (demucs split) + timeline (a `duck` on MUSIC under the voice track; gains) | should / must | MUSIC | "duck the music under the voice ({amount} dB, attack 50 ms, release 250 ms)" (ASSUMPTION: duck defaults) |
| **R22** | cut-on-sound sync | share of cuts within ±0.15 s of a sound hit ≥ chance + 10 points; chance = 1 − e^(−rate·0.3), rate = hits per second (TVF `feel`, READ in code) | file (TVF `feel`, hits from the music stem) or timeline (cut times vs MUSIC/SFX element onsets and beat markers) | **must** (owner: a failing sync blocks export) | MUSIC, plus one **info** marker per cut that misses a hit | "snap the cut to the nearest hit within one frame, or put an SFX on the cut" |
| **R4** | a sound hit on frame 1 | an SFX or music downbeat starts at 0.0 s | timeline (an SFX/MUSIC element at t = 0); a file cannot show it (TVF is blind in the first 0.25 s, Judge LEARNINGS 15) | should | SFX | "start the hook on a hit: an SFX or a downbeat at 0.0 s" |
| **R21** | music hits the board's moments | every board `music.hits` marker has a cut or a music hit within one frame | timeline | should | MUSIC | "move the music so its {what} lands on {shot}" |
| **R23** | a designed sound on every shot | every video element overlaps voice, an SFX, a music hit, room tone, or carries a `silence` reason | timeline | should | SFX | "add an SFX for {shot} (named, on the visual event), or write why it is silent" |
| **CAP** | captions verbatim to the voice | every caption word is in the transcript or the approved copy (label and end-card words exempt) | timeline text vs transcript (exact); file OCR (candidates) | must (`candidate` from OCR until confirmed on a full-res frame) | CAPTIONS | "fix the caption text: '{read}' → '{expected}'" |
| **CAP-LEN** | caption chunk length | ad: 1–3 words per chunk (R18); other pieces 1–5 (the reels run 1–5, PARITY §8.1/8.2). Checked on the base CAPTIONS layer only (word and shadow layers repeat it) | timeline | should | CAPTIONS | `captions {words_per_chunk}` |
| **SAFE** | captions and text inside the platform safe area | 9:16 on reels / tiktok / shorts (the 9:16 default): x 60–940, y 220–1500 on 1080x1920, scaled (ASSUMPTION, UNVERIFIED against today's overlays). Every other canvas or platform (16:9, 1:1, 4:5; feed, youtube, broadcast): title-safe, 5 % in from each edge (ASSUMPTION: the 90 % convention). Platform from `brief.platform` / `metadata.restorff.platform`. Boxes measured with the caption builder's own Chromium measurer (one measurer, §2c) | timeline (element boxes) | must | CAPTIONS or TEXT | `timeline_ops set` scale / position that puts the measured box inside |
| **R18** | captions never over a face or the product | — | Claude looks at each caption's frame (SEEN); FACE (below) measures it when a matte exists | should | CAPTIONS | "move the caption off the {face/label} at {t}" |
| **R15** | the offer on screen | in the last 6 s: a text element (or text inside a composition) with the brief's **verified** price (exact string match), a reason to act now, and a CTA; skipped when the brief says `offer: false`, and on every piece that is not an ad (§2a) unless the brief carries a verified offer | timeline (exact); file OCR on the caption band (candidate) | **must** on an ad (a veto in the Judge stage) | TEXT | `text_pop` of the brief's verified strings; with no verified offer: ask the owner, never invent one |
| **R3** | a hook headline for sound-off viewing | on screen by 0.3 s (1.0 s on a motion graphic), ≤ 7 words, separate from the captions; text inside compositions counts (§2b) | timeline (TEXT element start and word count); file OCR by 0.6 s | should (info on a motion graphic, off on a brand film) | TEXT | `timeline_ops` move / set content, or `composition get` → update |
| **FACE** | no overlay over the speaker's face | an overlay covers ≥ 25 % of the face box for ≥ 0.3 s. Face box: the person matte's (`server/matte.ts getFaceBoxes`), mapped through the clip's transform and its keyframes. Overlay box: measured text box; a composition's or alpha picture's visible pixels (an alpha grid of its own render); a picture's media size. Not an overlay: a person cut-out drawn above it, a layer behind the cut-out, a layer covering ≥ 60 % of the frame (a frame treatment: pullback, zoom). Skipped (not INCOMPLETE) with no matte | timeline + matte | should | the overlay's lane | `timeline_ops set transform.positionY` clear of the face; captions: `captions {zone}` that misses it |
| **FLASH** | no flash frames | a picture on screen for 1–3 frames at a cut. Timeline (exact): a base-picture run of 1–3 frames between other pictures, not a frame-exact continuation, not marked `restorff.flash`. File (measured, `candidate`): two big frame changes 1–3 frames apart with steady pictures around them, near a timeline cut — over the whole frame (≥ max(6, 3.5 × local median), 64 px grey frames) and, at cuts on a clip with face boxes, inside the face box (≥ max(10, 3 × local median); a same-camera sliver barely moves the whole frame). A flash inside a transition window or a composition's own animation is designed; a **black** flash frame never is | timeline + file | must (should on a motion graphic / brand film); a black frame is must on every piece | the clip's lane | timeline: `delete` the sliver + `trim` the shot before it over the gap (to the tick); file: `look` at the frames |
| **HOOK** (2026-10-24) | something changes on screen in the first second | the first visual change ≤ 1.0 s. Visual change = tools/mcp-test/score.py's detector, shared (packages/gate `retention.ts` + `apps/web/src/server/retention-measure.ts`): mean absolute change of consecutive grey frames at 135×240, 15 fps; an event is a rise over median + 3 MAD (floor 2.0 grey levels) after ≥ 4 calm frames, merged with ffmpeg scene cuts > 0.3 (events < 0.2 s apart are one) | file (the master) | should on every piece (the owner has not set per-piece bars) | the base picture at 0 | `retention {action: fix}`: a punch-in on the first spoken word inside the first second |
| **DEAD** (2026-10-24) | no dead stretches | no stretch longer than 3.0 s without a visual change (same detector). Skipped: a still tail that starts inside the end card the timeline marks (an element with `restorff.role`/`kind` `end_card` or `end_card: true`, a name or composition name with "end card" / "packshot", or a marker whose note says "end card"; ASSUMPTION: "outro" alone is not one); an opening stretch HOOK already reports. A stretch where ≥ 50 % of frames move a little (`moving_pct`) is said so: the detector counts a change only after calm frames, so a punch-in inside constant motion is not counted — cut instead | file (the master) | should on every piece | the base picture at t | `retention {action: fix}`: a move about every 2 s (punch-ins on the base picture, face kept in place; word pops clear of the face and the captions on footage; an SFX on each), one commit |
| **FIRST** | the first frame and the product | R2: the element at 0.0 s is a thumb-stop (its board `purpose` is `stop`); R14: the product is on screen by 3.0 s (an element whose board purpose is `product` or whose asset is a product shot starts ≤ 3.0 s) | timeline metadata + Claude looks at frame 0 and 0–3 s (SEEN) | should | V2 B-ROLL / V1 A-ROLL | "open on {thumb-stop}; bring the product in by 3 s" |
| **CLIP** | clip words | each A-roll clip says its scripted line verbatim, **and** the whole cut is transcribed every cycle (a trim can clip a word at a splice — studio incident) | file (transcript of the render) + timeline (which clip covers which line) | must, `candidate` until heard (speech recognition misspells brand words) | V1 A-ROLL | "re-voice or re-cut '{line}': brief '{expected}' → heard '{spoken}'; if it is an ASR spelling, add an alias and dismiss" |
| **LIP** | lip sync on dialogue | checked by ear — no instrument; Claude cannot hear the render in most hosts | a person ticks it in the gate (ASSUMPTION) | must, `candidate` until ticked, for cuts with on-camera dialogue | V1 A-ROLL | "watch {clip} with sound: does the mouth match?" |
| **CLEAN** | black and held frames | 0 black; held frames < 0.2 s each and < 0.5 s in total; a hold ≥ 1.5 s is a stall | file (`blackdetect` 0.08 s, `freezedetect` 0.2 s) + timeline (gaps on the video tracks; a clip shorter than its slot = cloned padding) | black: must · held: should, **must** if a stall or ≥ 0.5 s in total (on an explainer, motion graphic or brand film a hold is a should unless a stall: a beat that lands and holds is their grammar, ASSUMPTION) | the base picture at t | `timeline_ops move` (gap) / a keyframe push-in (held) / `look` (file) |
| **R1 R5 R6** | rhythm, counted in **picture changes**, not clips: cuts of the base picture (the top-most element that covers the frame), scenes inside a composition that is the picture (§2b), applied effects (their layers once), and on talking heads / explainers overlay beats (a composition, picture or text pop entering) | per piece (§2a). Ad (CRAFT): R1 ≥ 3 shots start in 0–3 s (or a marked dramatic single shot); R5 median ≤ 2.2 s, longest ≤ 3.5 s unless it moves; R6 ≥ 4 per 10 s | timeline (exact element starts + composition scenes) + file (scene scores, TVF shots) | should | the base picture at t (its real lane) | R5: a keyframe push-in; R6: a punch-in split; else `look` |
| **R12** | a music bed | MUSIC elements cover ≥ 90 % of the runtime, or the gap carries a `silence` reason | timeline (exact) + file (demucs) | should | MUSIC | "run the bed under {span}, or write why it is silent" |
| **TAIL** | dead air at the end | ≤ 1.5 s after the last spoken word | file (transcript) | should | the element at t | "end on the CTA; spread the air through the read" |
| **FORMAT** | delivery format | the brief's `deliver` when it says one; else the canvas is the delivery and must be one of the piece's aspect ratios (§2a) with a short side ≥ 720 px; the brief's fps (else a standard rate); H.264 + AAC; the file must match the canvas. A deliberate 16:9 is never told to become 1080x1920 | timeline + file (ffprobe) | must | MASTER | same orientation: `set_canvas` to the brief's / nearest standard size; an orientation change: `cutout reframe {size}` (4:5 · 1:1 · 16:9) or ask the owner — never `set_canvas` across orientations |
| **CLAIM** | claims within the brand's matrix | every spoken and on-screen claim is in the claim matrix | the Claim compliance judge (veto); the worker supplies timed words and text (SPEC) | must | V1 A-ROLL or TEXT | "replace '{claim}' with an allowed claim from the matrix" |

**The gate's state** (`findings.json` → `gate`, built today):
- **BLOCKED** — any `must` is `open` or `candidate`. Render final is disabled; the button reads "N fixes before export"
  and jumps to the first must marker.
- **INCOMPLETE** — nothing blocks, but a check did not run (it is named in `not_run`). Never treated as a pass (Judge
  LEARNINGS 13): Render final waits for the missing measurement.
- **PASS** — every check ran and no must is open. Render final and Deliver are enabled.

**Override (D13, answered by the owner 2026-10-20: "Owner, with a written reason").** The project owner may override
a must with a written reason (≥ 12 characters), recorded on the finding (`status: dismissed`, `dismissed_reason`,
`resolved_by`) and in `metadata.restorff.overrides`; claims (CLAIM) never; Claude never — there is no override over MCP
(`check` has none; `validateOverride` refuses a `by` starting claude / judge / worker / compiler / gate).

## 2a. Piece types choose the rule set (gate-v2)

The recreations (`recreations/SUMMARY.md` gap 5) showed a gate written for vertical ads blocking good explainers and
motion graphics. Each timeline is judged as one piece; one table (`packages/gate/src/piece.ts` PROFILES) holds it.

**Who decides.** `metadata.restorff.piece` (the owner's setting; a string or `{type, set_by, at}`) → `brief.piece` → the
`check {piece}` argument (that check only) → inferred. Owner-set wins over the argument, so a Claude cannot re-type an
ad to drop R15 (D13); a brief with a verified offer keeps R15 a must on any piece. Every result says the piece, its
source and why (`piece: {type, source, why, ignored?}`).

**Inference** (in order): the brief carries a verified offer → ad · an offer (a price and a CTA) is on screen in the
last 6 s → ad · compositions are the picture for ≥ 60 % of the runtime and camera video < 30 % → motion graphic · a
landscape canvas with reference folders, compositions or a voice → explainer · camera video with speech ≥ 50 % → talking
head · landscape otherwise → brand film · else → ad (the gate's default). ASSUMPTION: an unbriefed vertical talking
head is not judged as an ad; the result says how to change that.

| Rule | ad | talking_head | explainer | motion_graphic | brand_film |
|---|---|---|---|---|---|
| R15 offer · R1 hook cuts · R4 frame-1 hit · R21 board hits | must · should · should · should | skipped (ad rules) | skipped | skipped | skipped |
| R3 headline | should, by 0.3 s | should, 0.3 s | should, 0.3 s | info, 1.0 s | skipped |
| R5 longest still stretch · R5 median | 3.5 s · 2.2 s | 8 s · — | 6 s · — | 10 s · — | 8 s · — |
| R6 changes per 10 s (what counts) | 4 (cuts, scenes, effects) | 2 (+ overlay beats) | 3 (+ overlay beats) | 1.5 (a window that keeps moving passes) | 1 (moving passes) |
| R12 music bed | should | info | info | should | should |
| CAP-LEN words per chunk | 1–3 | 1–5 | 1–5 | 1–5 | 1–5 |
| FLASH | must | must | must | should (black: must) | should (black: must) |
| CLEAN held frames | CRAFT bar | CRAFT bar | should unless a stall | should unless a stall | should unless a stall |
| FORMAT aspects | 9:16 4:5 1:1 16:9 | same | 16:9 9:16 1:1 4:5 | 9:16 16:9 1:1 4:5 | + 2.39:1, 1.85:1 |
| SAFE · CAP-LEN · R23 · CLEAN black · FACE | the same on every piece: must · should · should · must · should | | | | |

The non-ad rhythm bars are ASSUMPTIONs set from the reels' MEASURED pacing (PARITY §8: overlay beats 5.1 / 10 s,
1.9 cuts / 10 s, 2.1 scenes / 10 s, 4.7 cuts / 10 s, ~10 effects / 10 s) — about two thirds of each reel's rate.

## 2b. What a composition declares (contract for packages/compositions; gate-v2 ↔ library-v2)

A composition is one clip on a MOTION lane; the gate reads what is inside it:

| Field (manifest JSON block, or the element's props / `restorff.composition`) | Meaning | Undeclared, the gate uses |
|---|---|---|
| `scenes: [2.1, 4.5]` | scene boundaries, seconds from the composition's start | a frame diff of the composition's own render (32-column frames, alpha-premultiplied luma; a change ≥ max(2.5, 5 × local median), merged within 0.3 s), cached per media hash in `<apps/web>/.data/gate/compositions/` |
| `text: [{content, t?, t_end?, role?, box?}]` | on-screen text (role headline · label · caption), local seconds, box 0..1 of the canvas | the manifest's `string` / `text` params (and lists of them, string fields of list objects, timed by their `at`) merged with the props, timed at the element's start (ASSUMPTION); without a manifest, display-like prop keys |
| `opaque: true` | it paints the whole frame (it is the picture) | its own render: ≥ 97 % of the alpha grid solid in every sampled frame |
| — | its own fast motion (slams, slides) | measured spans, so a flash it makes by design is not a FLASH |

Declared values win over measured ones. Library manifests are read by the server from `packages/compositions`.

## 2c. One text measurer (gate-v2 ↔ captions-v2)

`check` measures every text element with captions-v2's `prepareTextMeasure` (`apps/web/src/server/transcripts-measure.ts`:
headless Chromium, the real font as the editor loads it, the editor's box — lines × line height, alignment, background
padding × fontSize / 15) and the `captions` builder reports its safe area with the same box (`textBoxOf`) and the gate's
`textBox`, so the builder and the gate agree. Without Chromium both fall back to 0.55 em per character and say so
(`measured.text` in the `check` answer).

## 3. Pinning: every finding becomes a marker on the timeline

A finding (`finding@1`, §4) carries `t`, `t_end`, `track`, `rule`, `severity`, `message` and `fix`. RestorffCut turns it
into a **review comment** pinned to the timeline (the comment model already carries `time_s`, `track_id`,
`element_id`, author, thread, resolved — `../../../plan/05-architecture.md` §3) and draws a marker on the ruler/track.

1. **Resolve the track.** A finding measured on a rendered file often has `track: null` (pixels don't say which track
   made them). RestorffCut fills it by rule, then hit-tests its timeline at `t` for `element_id`:

   | Rule | Track |
   |---|---|
   | LOUD, FORMAT | MASTER (a marker across the ruler, no element) |
   | MIX, R12, R21, R22 | MUSIC |
   | R4, R23 | SFX |
   | CAP, CAP-LEN, R18, SAFE (caption) | CAPTIONS — the caption element at `t` |
   | R3, R15, SAFE (text) | TEXT |
   | CLIP, LIP, CLAIM (spoken), BRIEF | V1 A-ROLL — the clip at `t` |
   | CLEAN, R1, R5, R6, TAIL, FIRST, FLASH | the **base picture** at `t`: the top-most element that covers the frame (a transparent overlay — a paper texture, a table of contents — is not it) |

   `track` stays the finding@1 lane (the schema's enum; the comments store validates it). gate-v2 adds the REAL lane:
   `track_id` and `track_name` (e.g. "MOTION", "PAPER"); `check` shows `track` = the real name (`lane` = the finding@1
   lane) and comments are pinned to `track_id`. `toSchemaFinding` drops the additions for strict consumers.

2. **Draw it.** A span marker from `t` to `t_end` (a tick when `t_end` is null) on that track. In the Restorff skin
   (`../../../plan/11-design-brief.md` §3; ASSUMPTION for the mapping): an open **must** is the view's one neon
   `#F6FF00` isolate ("the thing waiting on you"); **should** is a bone `#EDEBE6` outline; **info** is a fog `#8C8C95`
   tick; a finding raised by one of Claude's judges carries a Kiln `#C8553D` dot. The label is mono:
   `R5 · 0:08 · S16 holds for 3.8 s` and the comment body is `message → fix`.
3. **The verdict's top three fixes** (Judge WORKFLOW §3) are the same findings, ranked; "Send the 3 fixes to the editor"
   (the judge artboard) shares the comment thread links.
4. **Lifecycle.** A new render is re-measured; findings are matched to the previous ones by rule within ±0.5 s:
   gone → `fixed` (set by the re-measure, never by hand); still there → stays open; new → added. A finding on a render
   whose commit is no longer the head is shown **stale** (`#E8A33D`, plan/05 §6). `dismissed` needs a reason and an
   author (`resolved_by`).
5. **Not an edit.** Markers and comments never change the cut; only `ops@1` commits do. (ASSUMPTION: findings are
   comments, not `mark` ops, so dismissing one does not create a commit.)

## 4. Finding schema (machine-readable)

Canonical file: `../../../restorff/workers/judge/schemas/finding.schema.json` (and `findings.schema.json` for the file
`judge.py findings` writes). The Judge worker's self-test validates real output against it and checks that the copy
below matches the file; if they ever differ, the file wins.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://restorff.ai/schemas/finding@1.json",
  "title": "finding@1",
  "description": "One defect or note about a rendered cut, pinned to a time (and, once RestorffCut resolves it, a track and an element). Written by the Judge worker (MEASURED) or by a judge preset run in the user's Claude (SEEN / READ). Becomes a marker and a review comment on the RestorffCut timeline. Spec: restorffcut/docs/restorff/EXPORT-GATE.md.",
  "type": "object",
  "required": ["id", "rule", "severity", "status", "t", "t_end", "track", "evidence", "message", "fix", "source"],
  "additionalProperties": false,
  "properties": {
    "id": {"type": "string", "minLength": 1, "description": "Stable within a render: <file stem>-<rule>-<nn>."},
    "rule": {"type": "string", "pattern": "^(R[0-9]{1,2}|LOUD|CLEAN|CAP|BRIEF|MIX|TAIL|FORMAT|CLAIM|SAFE|LIP|CLIP|[A-Z][A-Z0-9_-]{1,15})$",
             "description": "A CRAFT rule (R1-R25) or a gate check id (EXPORT-GATE.md, table of checks)."},
    "severity": {"enum": ["must", "should", "info"],
                 "description": "must = blocks Render final / Deliver while open or candidate; should = a fix the verdict weighs; info = context (e.g. each cut that misses a hit)."},
    "status": {"enum": ["open", "candidate", "confirmed", "dismissed", "fixed"],
               "description": "candidate = measured by an instrument that can misread (OCR, speech recognition) and must be confirmed by a look or a listen; dismissed needs dismissed_reason; fixed is set by a re-measure, never by hand."},
    "t": {"type": "number", "minimum": 0, "description": "Seconds from the start of the render."},
    "t_end": {"type": ["number", "null"], "minimum": 0, "description": "End of the span, or null for an instant."},
    "track": {"enum": ["TEXT", "CAPTIONS", "V2 B-ROLL", "V1 A-ROLL", "MUSIC", "SFX", "MASTER", null],
              "description": "null when the finding came from a rendered file and the track is not knowable from pixels; RestorffCut resolves it by hit-testing its timeline at t (EXPORT-GATE.md 'Pinning')."},
    "element_id": {"type": ["string", "null"], "description": "The timeline element under the finding, filled by RestorffCut."},
    "measure": {"type": "object", "description": "The measured values behind the finding, with their units in the key names."},
    "target": {"type": "string", "description": "The threshold the measure was held to, in words."},
    "evidence": {"enum": ["MEASURED", "SEEN", "READ"]},
    "message": {"type": "string", "minLength": 1, "description": "What is wrong, in one plain sentence with the number."},
    "fix": {"type": "string", "minLength": 1, "description": "Exactly what to do instead."},
    "source": {"type": "string", "description": "worker:judge@<version>, judge:<preset id>@<version>, or claude:<session>."},
    "file": {"type": "string", "description": "The rendered file (or render id) the finding was measured on."},
    "render_id": {"type": ["string", "null"]},
    "commit": {"type": ["string", "null"], "description": "The timeline commit the render was made from."},
    "judges": {"type": "array", "items": {"type": "string"}, "description": "Every judge that raised it, after merging (+-0.5 s, same rule)."},
    "frames": {"type": "array", "items": {"type": "string"}, "description": "Evidence images (frame paths or URLs)."},
    "dismissed_reason": {"type": ["string", "null"]},
    "resolved_by": {"type": ["string", "null"], "description": "user:<id> | claude | re-measure"}
  },
  "allOf": [
    {"if": {"properties": {"status": {"const": "dismissed"}}},
     "then": {"required": ["dismissed_reason"], "properties": {"dismissed_reason": {"type": "string", "minLength": 3}}}}
  ]
}
```

A finding as the worker writes it (fictional job; the shape is real, from the 2026-10-20 self-test):

```json
{
 "id": "ad014-c2-CLEAN-03", "rule": "CLEAN", "severity": "must", "status": "open",
 "t": 5.37, "t_end": 6.0, "track": null, "element_id": null,
 "measure": {"frozen_s": 0.63, "frozen_total_s": 0.63},
 "target": "no held frames >= 0.2 s (total < 0.5 s)", "evidence": "MEASURED",
 "message": "picture held still for 0.63 s",
 "fix": "the clip is shorter than its slot and is padded with cloned frames: trim the slot to the clip, extend the clip, or add a camera move",
 "source": "worker:judge@0.1.0", "file": "ad014-c2.mp4"
}
```
After pinning, RestorffCut sets `"track": "V2 B-ROLL", "element_id": "<the S08 element>"` and draws a neon span from
0:05.37 to 0:06.00 on V2.

## 5. How to verify

- File checks: `cd ../../../restorff/workers/judge` then `"C:\Program Files\Python313\python.exe" judge.py selftest --media`
  — builds a 10 s cut with planted defects (held tail, quiet master, caption typo, clicks on every cut, an offer card)
  and must end `34/34 passed`; it includes validating `findings.json` against the schema above. Add `--speech` (38/38,
  ~40 s, Windows) for the transcript, script-check and music-vs-voice path on a synthetic voice with planted deviations.
- On a real render: the runbook `../../../restorff/workers/judge/README.md` §2, then `judge.py findings <job>`.
- Timeline checks: `cd packages/gate && bun test` (50 tests, 2026-10-20: a planted defect per check, piece types,
  composition scenes / text, FACE, FLASH, lanes, fix calls).
- Over MCP on a render: `bun scripts/mcp-call.ts call check '{"timeline_id":"<id>","comments":false}'` (read-only; the
  answer carries `piece`, `picture_changes`, `measured` and every finding's `fix_call`). gate-v2 MEASURED before → after
  on the four recreation timelines and a planted FACE + FLASH timeline: `worklog/gate-v2.md`.

**Every finding carries `fix_call`** `{tool, arguments, does}`: the exact call that fixes it (ops@1 with element ids and
values; `timeline_id` and `base_commit` = the head filled by the server), or a `look` at the exact frames when only
eyes can decide (measured candidates). `check`'s `next` is the first blocker's `fix_call`.
