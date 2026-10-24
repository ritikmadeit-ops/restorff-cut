# Learnings — @restorffcut/gate

1. **Black frames are also frozen frames.** ffmpeg's `freezedetect` reports a black span as a freeze too (seen
   2026-10-20 on the test clip: `freeze_start: 0 … freeze_end: 1` beside `black_start:0 black_end:1`). Rule: drop
   holds that sit inside a black span, or one defect shows twice.
2. **A check that did not run is never a pass.** If ffprobe/ffmpeg fail, the rule goes to `not_run` and the gate is
   INCOMPLETE (Judge LEARNINGS 13). Only the owner can waive it, with a reason.
3. **A −30 dBFS sine measures −33.0 LUFS integrated, −29.3 dBTP** (ffmpeg 8.1 ebur128, 1 kHz, mono AAC). The fix
   is +19 dB — inside the editor's +20 dB volume cap, so "Fix loudness" can reach −14 without a limiter here; a
   louder-peaked mix will be capped by the true peak (`loudnessGain(...).limited`).
4. **A gate written for one piece type blocks every other kind** (gate-v2, 2026-10-20). Five recreations, five false
   BLOCKs: R15 asked a motion graphic for a price, FORMAT told a 16:9 explainer to be 1080x1920 and its `next` proposed
   the canvas flip. Rule: every rule's severity comes from the piece's profile (`piece.ts`), a skipped rule says why,
   and no fix ever changes orientation with `set_canvas`.
5. **Count what the viewer sees change, not clips.** A transparent table-of-contents overlay on top made 17 effects
   one 16.6 s "shot"; 2 s paper-texture loops made "shots" too. Rule: only an element that covers the frame (main
   track, opaque media, an opaque composition) is the picture; scenes inside it and applied effects are changes.
6. **Mean luma differences are tiny on dark motion graphics.** The neon hook's scene change peaks at 3.8 over a 0.45
   median (32-column frames); a 14 threshold found 3 of the 8 scenes. Rule: thresholds relative to the local median
   (≥ 5×) with a low floor (2.5), MEASURED per look before trusting them.
7. **A same-camera sliver hides in whole-frame differences.** The explainer fixture's 2-frame slivers moved the whole
   frame by 5.8 against a median of 2 (overlays typing at the same moment) but the face box by 26.5 against 5.5.
   Padding the face box 15 % dropped it under the bar (22.6 vs 23.1). Rule: at cuts on a clip with face boxes, test
   the exact face box.
8. **A fix call must be exact to the tick.** The FLASH fix trimmed to `out: 3.0667` and the reducer refused it: 3.0667 s
   is 4 ticks past the next clip at 3.066667 s. Rule: seconds in generated ops keep 6 decimals.
9. **A black frame is never "designed".** The neon paper form's frame 0 is empty: a 1-frame black flash that
   `blackdetect` (≥ 0.08 s) never sees, and that the composition's own render shows too. Rule: the designed-flash
   filter never excuses a black (mean luma < 12) flash; a black flash is a MUST on every piece.
