# PIPELINE — talking head in, gated MP4 out (runbook)

**What it does.** Raw talking-head footage → TVF word timings → `cutFromTranscript` (dead air and retakes out) →
width-aware 1–3-word captions → a RestorffCut project (ops@1, `apply`) → MP4 rendered by **the editor's own export**
in headless Chromium → loudness master (−14 LUFS, ≤ −1 dBTP, measured on the encoded file) → Restorff's Judge worker
→ `findings.json` with the export gate state. Unattended, one command. Spike S2 (headless render) + the talking-head
compiler (EDT-03, EDT-11/12).

**Code:** `packages/pipeline/` (CLI, v0.1.0 — README, CHANGELOG with "Next", LEARNINGS there), `scripts/render/`
(headless driver), `apps/web/src/app/(render)/` (dev-only render page and job file route). Worklog:
[worklog/pipeline.md](worklog/pipeline.md).

**When to use it.** To turn a talking-head clip into a captioned, mastered, judged cut without opening the editor;
to measure headless render speed; as the template for the compiler → render → judge loop Restorff runs.

---

## 1. Setup (this machine; each item has an env override in `packages/pipeline/src/paths.ts`)

| Need | Default | Override | Check |
|---|---|---|---|
| Bun 1.2.18 | on PATH | — | `bun --version` |
| RestorffCut dev server | `http://localhost:8791` (skin agent's `bun run dev` in `apps/web`) | `RESTORFFCUT_DEV_URL` | `curl http://localhost:8791/api/render-jobs` → JSON with `root` |
| Chromium | newest `%LOCALAPPDATA%\ms-playwright\chromium-<rev>\chrome-win64\chrome.exe` (1243 = Chrome 153.0.8010.12 here) | `RESTORFFCUT_CHROME` | the render log prints `Chrome/153…` |
| ffmpeg / ffprobe | on PATH (8.1.1 full build) | `FFMPEG`, `FFPROBE` | `ffmpeg -version` |
| Python | `C:\Program Files\Python313\python.exe` | `RESTORFF_PY` | — |
| TVF | `C:\data\code\temporal-visual-flux` (read: its `work/` analyses; new runs write into the job folder) | `RESTORFF_TVF_DIR` | `PY -m tvf doctor` |
| Judge worker | `..\restorff\workers\judge` | `RESTORFF_JUDGE_DIR` | `PY judge.py doctor` → every row `[ok]` |
| Render jobs root (server side) | `%TEMP%\restorffcut-jobs` (here `C:\Users\assassin\AppData\Local\Temp\restorffcut-jobs`) | `RESTORFFCUT_JOBS_DIR` on the dev server | `GET /api/render-jobs` |

No `bun install` was needed: `@restorffcut/timeline-ops` resolves through the root `node_modules` link. The new
package's `package.json` names that dependency (`workspace:*`); `bun.lock` was not touched (the orchestrator's next
`bun install` records it).

## 2. One command

```text
cd C:\data\code\overkill\restorff-apps\restorffcut
bun packages/pipeline/src/cli.ts demo <video> --out <job-dir OUTSIDE the repo> [--quality final|preview] [--gpu hw|swiftshader|default] [--quick] [--caption-y 540] [--silence 0.35]
```

Real example (MEASURED 2026-10-20, owner-approved local test input; the job folder is in the session scratchpad):

```text
bun packages/pipeline/src/cli.ts demo ../spikes/s6-reference-reels/media/DeIGbZypIUb.mp4 --out C:\Users\assassin\AppData\Local\Temp\claude\c--data-code-overkill\bfafbaad-45e5-4554-a6fd-d2fdbba7d508\scratchpad\pipeline\deig-demo2
```

Prints each step and its time, ends with `{"jobDir": …, "demo": "<job>/demo.json"}`. Exit 0 = every step ran (a
BLOCKED gate is a result, not a failure); 1 = a step failed (message on stderr).

## 3. The steps one at a time (same order as `demo`)

| # | Command | Input → output | Verify |
|---|---|---|---|
| 1 | `bun packages/pipeline/src/cli.ts autocut <video> --out <job>` | video → `<job>/job.json`, `project.json`, `media/source.<ext>` (hard link), `cut.json` (kept / removed with reasons / retakes / caption chunks), `ops.json` (every op, = a commit), `words.json`, `tvf/` (only when TVF had to run) | prints input → output seconds, cuts, retakes, caption chunks; `cut.json` `removed[].reason` ∈ head · silence · retake · tail |
| 2 | `bun packages/pipeline/src/cli.ts render <job> [--quality final] [--gpu hw]` (or `bun scripts/render/render.ts <job> --out <file>`) | job → `<job>/render.mp4` + `<job>/render.json` (timings, CPU, browser env, console) | log line `… s of video in … s`; `ffprobe` shows h264 1080x1920 30 fps + aac |
| 3 | `bun packages/pipeline/src/cli.ts master <job>/render.mp4 --out <job>/master.mp4` | → `master.mp4` (video copied, audio loudnorm + AAC 48 kHz) | JSON `after.integratedLufs` within −14 ±1, `after.truePeakDbtp` ≤ −1, `ok: true` |
| 4 | `bun packages/pipeline/src/cli.ts gate <job> [--quick]` | master → `<job>/brief/script.json` (from the kept transcript, `offer: false`), `<job>/judge/gate/…` (the Judge's whole job: metrics, captions OCR, CRAFT.md), `<job>/findings.json` | prints `GATE: PASS / BLOCKED / INCOMPLETE` and every finding |
| 5 | (in `demo`) sync check + frames | → `demo.json` `sync` (planned words vs words heard in the render: matched, median / p90 / max offset, missing words and whether near a cut), `<job>/look/t000.jpg …` one frame per exact second (540 px wide) | open several frames: captions on screen, inside the frame, off the face |

How the render works (S2): `render.ts` asks the server for its jobs root (`GET /api/render-jobs`), writes a pointer
file `<root>/<job>.path` holding the job folder's absolute path (so jobs can live anywhere), launches Chromium
`--headless=new` over raw CDP (`scripts/render/cdp.ts`), opens `/render/<job>`. The page
(`app/(render)/render/[job]/render-job.tsx`) fetches `job.json`, `project.json` and the media from
`/api/render-jobs/<job>/…`, puts them straight into `EditorCore` (`project.setActiveProject`,
`scenes.initializeScenes`, `media.setAssets`; autosave paused, so nothing goes to IndexedDB), and exposes
`window.__restorffcutRender = { state, ready, progress, info, env(), start(), result, chunk() }`. `start()` calls
`editor.project.export()` — the same call the Export button makes (wasm compositor + mediabunny WebCodecs). The driver
polls `progress`, then reads the MP4 back in 4 MB base64 chunks. Nothing in `services/renderer` or `export` was
changed. If the dev server is down, the driver starts `bun run dev` in `apps/web` in the background (never a second
one; never kills anything).

## 4. Measured (2026-10-20, this machine: 12 logical cores, RTX 3060, Windows 11)

**The real reel** `DeIGbZypIUb.mp4` (job `deig-demo2`):

| Step | Result | Time |
|---|---|---|
| autocut | 49.50 s → **49.37 s**: 0 silence cuts, 0 retakes (the reel is already an edited output — largest word gap 0.24 s), 0.13 s tail trimmed; **112 caption chunks**; TVF reused (272 words, faster-whisper large-v3 CUDA) | 0.3 s |
| render | 1481 frames, h264 High 1080x1920 30 fps ~4.4 Mbps + AAC; **11.0 s for 49.4 s = 0.22 s wall per output second (4.5× real time)**; Chromium tree CPU 19.7 s = 1.76 cores busy (14.7 % of 12) | 17.5 s incl. launch 0.6 s, page 0.9 s, editor load 0.3 s, transfer 1.6 s |
| master | source −14.5 LUFS / −0.1 dBTP; editor render **−14.1 LUFS / +0.2 dBTP** (true peak over 0); master **−14.1 LUFS / −1.4 dBTP**, 1 pass | 4.0 s |
| gate | **BLOCKED** — 2 must (BRIEF: speech-recognition disagreements on identical audio: the source transcript heard "what what" at 29.6 s and no "it" at 26.7 s), 4 should (R1, R5 ×2, R6: one 50 s shot); not run: R22 (no cuts to sync) | 94 s (full analyze: Whisper + demucs on the render) |
| sync | **271/272** planned words heard; offset median **0.02 s**, p90 0.04 s, max 0.08 s; the one "missing" word is the ASR "what what" above | — |
| total | | **117 s** |

The first run (`deig-demo`, captions at size 5 with words-per-chunk only) was BLOCKED by 3 more **real** musts: CAP
"caption word 'tellir' / 'ntinuously' / 'everythil'" — 3-word captions overflowed the frame (SEEN at 40.9 s:
"continuously keep telling" cut off on both sides). Fixed by width-aware chunks (`captions.ts`); in `deig-demo2` the
same moment shows "continuously" alone, inside the frame (SEEN, `look/t041.jpg`).

**Planted raw footage** (`scratchpad\pipeline\inputs\deig-raw-planted.mp4` = the reel + pauses of 1.0, 1.2 and
1.5 s with silenced audio + an aborted take "This tool is", 53.68 s; manifest `deig-raw-planted.json` beside it):

| Run | Cut | Notes |
|---|---|---|
| `planted-demo` (transcript only) | 53.67 → 51.30 s, 2 cuts (pauses 1 and 3) | **missed pause 2 and the retake**: Whisper merged both takes into "This tool is called" and stretched "called" over 4.58–6.38 s (READ). TVF ran 21 s. Render 9.5 s for 51.3 s (0.19 s/s, 1.81 cores). Master −14.5 → −14.1 LUFS, −0.2 → −1.4 dBTP. Gate BLOCKED: 5 BRIEF musts, all ASR spellings ("hyper frames"/"hyperframes", "gonna"/"going to" ×3, "scale"/"skill"); sync 263/269 words. Total 95 s |
| `planted-cut-check` (+ `silence.ts`) | **53.67 → 50.07 s, 3 cuts** — all three planted pauses (silences 3.06–4.07, 4.53–5.73, 16.89–18.40 s; 4 words clipped) | the aborted take stays: Whisper never transcribed it, so no transcript rule can see it (open issue) |
| `planted-demo3` (full demo, + `silence.ts`) | 53.67 → **50.07 s, 3 cuts**, 108 caption chunks | render **13.8 s for 50.1 s (0.28 s/s**, 1.76 cores; other agents were recompiling the dev server meanwhile); master −14.5 → **−14.1 LUFS**, −0.2 → **−1.4 dBTP**; gate **BLOCKED** 6 must, all BRIEF ASR disagreements ("hyper frames"/"hyperframes", "gonna"/"going to" ×3, "scale"/"skill", an extra "it"), 4 should (R1, R5 ×2, R6); sync 262/269 words, offset −0.08 s before the first cut and −0.12 s after the last (no drift at cuts: a bias between the two Whisper runs). Total **91 s** |

S2's open questions, answered on this machine:
- **WebGL2 / the wgpu compositor headless:** works with `--headless=new --use-angle=d3d11 --ignore-gpu-blocklist`
  on the real GPU (`ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 … Direct3D11)`); `initializeGpu()` succeeded (effects
  available). WebGPU is exposed too. SwiftShader (`--gpu swiftshader`) is wired but NOT measured.
- **WebCodecs H.264 headless:** works — `VideoEncoder.isConfigSupported(avc1.640033, 1080x1920)` true, also with
  `prefer-hardware`; AAC encode, VP9 and AAC decode all true (Playwright's Chromium 1243 is a Chrome-for-Testing
  build, proprietary codecs included).
- **Speed:** 0.19–0.22 s wall per output second at 1080x1920 30 fps (0.28 while the dev server was recompiling),
  1.7–1.8 cores of the Chromium process tree.

## 5. Costs and limits
- No credits, no network beyond localhost. Disk: ~120 MB per job (render 29 MB, master 29 MB, the Judge's TVF pass
  ~60 MB); the source is hard-linked, not copied.
- Captions: Arial bold, editor size 4.5 (96 px on 1920), white on a `#0C0C0E` box, centred 540 px below the frame
  centre (1500 px) — chosen for this reel (face at ~900–1400 px, its own burned-in captions at ~960 px). Other footage
  may need `--caption-y`. Width is estimated (0.55 em per character), not measured.
- One A-roll clip per job, one scene; no B-roll, music or SFX yet, so MUSIC/SFX checks (R4, R12, R22, MIX) can't pass.
- The render page and route are dev-only (`NODE_ENV !== "production"`, or `RESTORFFCUT_RENDER_ROUTE=1`).

## 6. Known failures and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `dev server answers but fails (HTTP 500: … Module not found …)` | another agent's half-finished edit broke the dev compile (2026-10-20: `registry.tsx` → missing `@/beats/components/music-tab`); every route 500s | the driver waits up to 10 min and never starts a second server; if it gives up, re-run `render` once the dev server compiles |
| A pause survives the cut although the audio is silent | Whisper stretched a word over it (LEARNINGS 5) | `silence.ts` clips words to measured silences; check `cut.json` `silences` / `wordsClippedToSilence` |
| A retake survives | Whisper merged the two takes into one (LEARNINGS 5) | open issue: cut it by hand (ops `split` + `ripple_delete`) |
| `render page not ready (state absent)` | first visit compiles the route (can take a minute), or the dev server restarted | re-run; the driver waits 300 s |
| Render hangs or the page state goes back to `loading` (UNVERIFIED — not seen yet) | another agent's edit triggers Fast Refresh in the dev server: `[Fast Refresh] rebuilding` WAS logged during a render on 2026-10-20 and that run still finished | re-run the render step |
| `GET …/api/render-jobs: HTTP 404` | the dev server is a production build, or an older checkout without `app/(render)` | run the dev server from this tree |
| `no render job "<job>"` (404) | the pointer file is missing or points at a moved folder | re-run `render` (it rewrites `<root>/<job>.path`) |
| `export failed: …` | the editor's exporter threw; `<job>/render.json` has the page console and `render-page.png` the page | read `render.json` → `console` |
| Gate CAP must "word … is in neither the voice nor the copy" | a caption overflowed the frame (OCR reads a clipped word) — or an OCR misread | open the frame at that time; if clipped, lower `--caption-size` or the width budget |
| Gate BRIEF must on identical audio | speech recognition heard the render differently from the source | listen; dismiss with a reason (gate rule: `candidate` until heard) |
| `refusing to write a job inside the repo` | `--out` points into the repo | use a folder outside it (scratchpad) |
| 1-fps frames look ~0.5 s late | ffmpeg `fps=1` samples window ends | the pipeline's `look/` uses exact-second `select` (LEARNINGS 1) |
