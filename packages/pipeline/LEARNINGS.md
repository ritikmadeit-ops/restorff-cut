# LEARNINGS — @restorffcut/pipeline

Rules learned the hard way, each with the incident that taught it. Newest last.

1. **Never use ffmpeg `fps=1` to pull "the frame at second N".** It outputs the last frame of each
   [N−0.5, N+0.5) window, so "t021.jpg" showed 20.47 s, not 20.0 s. Incident 2026-10-20: a caption looked 0.3 s early
   in the 1-fps contact frames; exact `-ss` crops at 19.9 / 20.0 / 20.2 / 20.3 s proved the captions were right. Use
   `select='isnan(prev_selected_t)+gte(t-prev_selected_t\,0.999)'` with `-fps_mode vfr` (cli.ts `extractFrames`).
2. **Words-per-chunk is not enough for captions: limit width too.** Incident 2026-10-20, first demo: at editor size 5
   (107 px on 1920) the 3-word chunk "continuously keep telling" overflowed both edges of the 1080 px frame; the Judge's
   OCR read it as CAP must findings ('tellir', 'ntinuously') and the frame confirmed it (SEEN). `captions.ts` now
   ends a chunk when the next word would pass 80 % of the frame width and shrinks a single long word.
3. **The reel is not raw footage.** `DeIGbZypIUb` is an already-edited output (largest word gap 0.24 s, burned-in
   captions and cards), so a 0.35 s silence threshold cuts nothing. To show the cutter working, plant known defects
   (pauses, an aborted take) into a copy and check the cutter finds exactly those — the Judge self-test's method.
4. **Judge `findings.json` keys findings by file** (`{"findings": {"master.mp4": [...]}}`), not a flat list. The
   first demo crashed counting them (`undefined is not a function`).
5. **Whisper word timings hide pauses and swallow retakes.** Planted test 2026-10-20: "This tool is · 1.2 s silence ·
   This tool is called" came back as "This tool is called", with "called" stretched over 4.58–6.38 s. The cutter
   kept the pause. Rule: clip words to the audio's measured silences before cutting (`silence.ts`); a retake Whisper
   swallowed is still invisible (open issue).
6. **An HTTP 500 from the dev server is not "server down".** Incident 2026-10-20: another agent's half-done edit
   500'd every route; the driver started a second `bun run dev` (it exited: port taken). Rule: any HTTP answer = up;
   wait for a failing server, start one only when nothing listens.
7. **A tool run must not write into another project's tree.** Incident 2026-10-20: `tvf run` without `--work` wrote a
   reel-derived analysis into `temporal-visual-flux/work/`. Rule: new TVF runs use `--work <job>/tvf`; existing
   analyses are only read.
