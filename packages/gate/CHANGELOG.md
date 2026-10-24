# Changelog — @restorffcut/gate

## 0.1.0 - 2026-10-20
- First version: timeline checks SAFE, CAP-LEN, R3, R15, R1/R5/R6, R12, R23, R4, R21, CLEAN, FORMAT; ffmpeg parsers
  (ebur128 true peak, blackdetect, freezedetect, ffprobe) and file findings LOUD, CLEAN, FORMAT; pinning, merging,
  gate state (PASS / BLOCKED / INCOMPLETE), D13 owner overrides, "fixed" lifecycle. 23 bun tests.

## Next (ideas, not started)
- SAFE on keyframed transforms (check the box at every key, not only the base transform).
- R22 cut-on-sound from the timeline (cuts vs SFX onsets and beat grids), MIX from duck keyframes.
- CAP (captions verbatim) once the captions agent stores the transcript on the project.
- Validate emitted findings against `restorff/workers/judge/schemas/finding.schema.json` in the tests.
- Merge with the Judge worker's `findings.json` when both ran on one render.
