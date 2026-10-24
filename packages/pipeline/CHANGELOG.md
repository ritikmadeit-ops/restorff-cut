# Changelog — @restorffcut/pipeline

## 0.1.0 — 2026-10-20
- First version: `autocut` (TVF word timings → `cutFromTranscript` → width-aware 1–3-word captions → project + job
  folder), `render` (the editor's own export in headless Chromium over CDP, via `scripts/render/render.ts` and the
  dev-only `/render/[job]` route), `master` (two-pass loudnorm to −14 LUFS / ≤ −1 dBTP, re-measured on the encoded
  file), `gate` (Judge worker: ingest → analyze → captions → craft → findings), `demo` (all of it, timed), plus a
  sync check (planned words vs the words heard in the render) and exact-second frame extraction for looking.
- Silence-aware word clipping before the cut (`silence.ts`): pauses Whisper hid inside a stretched word are cut.
- New TVF runs write into `<job>/tvf` (`--work`), never into the TVF checkout.
- The render driver waits on a dev server that answers with errors instead of starting a second one.

## Next
- Retakes Whisper swallows (planted test: an aborted "This tool is" survives): re-transcribe each kept stretch, a
  forced aligner, or flag words too long for their text.
- Punch-in zooms on sentence boundaries (talking-head rhythm: the Judge's R1/R5/R6 "single 50 s shot" shoulds).
- Caption styles from the reels (word highlight, pop-in) once ops@1 has per-word colour or the editor has a caption
  animation; today one text element = one colour.
- Measure caption text width in the browser (the render page has a canvas) instead of the 0.55 em/char estimate.
- A second B-roll / music / SFX pass (the MUSIC/SFX checks R4, R12, R22, MIX need them).
- Run the timeline checks of EXPORT-GATE.md (SAFE, CAP-LEN, CAP exact) on project.json before rendering.
- A Linux/CI render path (headless GPU there is SwiftShader: measure `--gpu swiftshader` speed).
