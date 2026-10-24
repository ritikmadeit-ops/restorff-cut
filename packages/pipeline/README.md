# @restorffcut/pipeline — talking head in, gated MP4 out

**Version 0.1.0** ([CHANGELOG.md](CHANGELOG.md)). Owner: the pipeline agent. Runbook with every command, measured
timings and known failures: **[../../docs/restorff/PIPELINE.md](../../docs/restorff/PIPELINE.md)**. Lessons:
[LEARNINGS.md](LEARNINGS.md). Worklog: [../../docs/restorff/worklog/pipeline.md](../../docs/restorff/worklog/pipeline.md).

```text
video ─TVF─▶ word timings ─cutFromTranscript + captions─▶ ops@1 ─apply─▶ project.json ─▶ job folder
   ─▶ /render/<job> in headless Chromium (the editor's own export: wasm compositor + WebCodecs H.264/AAC) ─▶ render.mp4
   ─▶ ffmpeg two-pass loudnorm (−14 LUFS, ≤ −1 dBTP, re-measured) ─▶ master.mp4
   ─▶ Judge worker (ingest · analyze · captions · craft · findings) ─▶ findings.json (gate PASS / BLOCKED / INCOMPLETE)
```

One command (from the repo root, the dev server on :8791 running or startable):

```text
bun packages/pipeline/src/cli.ts demo <video> --out <job-dir outside the repo>
```

Steps one at a time: `autocut`, `render`, `master`, `gate` (see PIPELINE.md §3). Tests: `bun test packages/pipeline`.

## Files
| File | What |
|---|---|
| `src/cli.ts` | the CLI (`autocut · render · master · gate · demo`) |
| `src/paths.ts` | every path / program and its env override (PY, TVF, Judge, dev URL, ffmpeg) |
| `src/tvf.ts` | reuse a TVF analysis of the same file, else `python -m tvf run` |
| `src/autocut.ts` | probe → transcript → ops@1 → project + job folder |
| `src/captions.ts` | width-aware 1–3-word caption chunks |
| `src/silence.ts` | ffmpeg silencedetect + clip words to measured silences (Whisper hides pauses inside words) |
| `src/master.ts` | loudness mastering + ebur128 measure |
| `src/gate.ts` | the Judge worker run, with a brief made from the kept transcript |
| `src/sync.ts` | planned words vs words heard in the render (offset, clipped words) |
| `../../scripts/render/render.ts`, `cdp.ts` | the headless driver (raw CDP; Playwright hangs under Bun on Windows) |
| `../../apps/web/src/app/(render)/` | the dev-only render page `/render/[job]` and the job file route `/api/render-jobs/...` |

Job folders hold test media: they must be outside the repo (`autocut` refuses a path inside it).
