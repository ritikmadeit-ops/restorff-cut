# restorffcut — changelog

Newest first. Append-only. This file is the source of truth for the version.

## 0.5.0 — 2026-10-23 (UI fix round from docs/restorff/QA-2026-10-20.md, in progress)
- UI fixes, timeline (ui-fix-timeline, 2026-10-21/23; QA-2026-10-20 #1 #2 #3 #10 #20 #30): track labels now open
  beside their lanes (the label column re-syncs whenever either column resizes; measured 39.2 px off before, 0 px
  after), and the first visible lane is never half under the JUDGE row (the opening scroll stops at a lane start).
  Browsing no longer pushes "edit: no changes to the cut" commits: the change check ignores every timestamp, the
  thumbnail, the duration and the view state, and nothing is committed unless the cut differs from both the last
  synced copy and the base commit (commits 1 → 1 after clicks, seeks, scrolls, zoom and play). Clicking a judge
  marker selects the finding's clip on the lane it really sits on and never blanks the inspector; Esc closes only
  the card. Findings at the same spot are one marker with a count that opens a list, and the same finding posted
  under two ids is drawn once. The gate posts its findings as the comments API expects (201; an empty clean run
  sends nothing instead of a 400) and closes its own stale comments for rules it re-checked. Tests: bun test 509
  pass / 0 fail (28 new), tsc 0 errors. Untested: docs/restorff/worklog/ui-fix-timeline.md "Untested". Left for the
  owner: scratch project `861eb944…` can't be deleted (no endpoint).
- **Security pass** (security-pass agent, 2026-10-21/23; worklog docs/restorff/worklog/security-pass.md; restorff
  0.11.0 is the gateway half): server-side URL fetches go through `src/server/safe-fetch.ts` — `media import {url}`
  and `references add {url}` refuse loopback, private, link-local, CGNAT and metadata addresses (IPv4-mapped / NAT64 /
  6to4 forms checked as the IPv4 inside), resolve first and connect to the checked IP (no DNS rebinding), re-check
  every redirect (max 5), cap size and time (references had no time cap; now 120 s); dev allow-list
  `RESTORFFCUT_FETCH_ALLOW=host:port,…` (off by default, ignored in production). Saved styles, the repeat history and
  dismissals are per Restorff org: `X-Restorff-Org`, honoured only with the service token (malformed → 400), carried
  through MCP calls by an AsyncLocalStorage (`src/server/tenant.ts`); `styleOwner` → `org:<id>`; a signed-in session →
  its own library (was the project's owner); a service call without an org → `service:no-org` in dev, 400 in
  production; the old shared `service` rows moved once to `legacy:service-shared`. Library-audio `sourceUrl` fetches
  (also run by the server's headless render) refuse private IP literals and internal names (`src/lib/url-guard.ts`,
  `media/audio.ts` `fetchLibraryUrl`; review finding F1). New `scripts/mcp-standalone.ts`: the MCP endpoint alone on
  its own store, exits by itself. Tests: safe-fetch 46, org-scope 4, url-guard 23; whole suite 532/532; live
  `restorff/apps/gateway/scripts/security-pass-live.mjs` 21/21. **Still open before public:** a public host name that
  resolves to a private address can still reach the render's headless browser (fix: library audio via `safeFetch`, or
  limit the render browser's network). Each live run leaves two "security-pass live" projects and a render.
- **UI fixes, render** (ui-fix-render, 2026-10-21/23; QA-2026-10-20 #4 #5 #6 #7; worklog
  docs/restorff/worklog/ui-fix-render.md): Render final renders on RestorffCut's server by default: it commits the
  edits, uploads media the server lacks, renders and masters headless (POST /api/renders, polled with a progress bar;
  the tab stays responsive, worst stall 133 ms), runs the export gate there (POST /api/renders/:id/check) and offers
  the master for download on PASS or an owner override. A 52 s cut takes 36.7 s end to end (was ≈ 12 min with the tab
  frozen); "In this browser" stays as a fallback. Paused seeks show the right frame again (the compositor re-uploads a
  pooled video canvas when its frame changes; compositions were stuck on one frame). Library music beds and SFX play
  in the preview at the right time, and ducked beds no longer fail with createBuffer NotSupportedError (ticks were
  passed as seconds). #7 was the fixture's burned-in caption under ours (needs the clean Halcyon raw take). Tests: bun
  test 532/532. Open: no server-side cancel ("Stop waiting" only stops polling); progress readout stalls while the
  server prints nothing; the in-browser fallback render not re-run end to end.
- **UI fixes, panels** (ui-fix-panels, 2026-10-21/23; QA-2026-10-20 #8 #9 #12–#19 #21–#29; worklog
  docs/restorff/worklog/ui-fix-panels.md): saved styles store caption size as a ratio of the captions they're applied
  to (×1.35), capped inside the caption safe area; older fixed-size styles convert when the original size is known,
  otherwise are flagged with a one-click "Use ×1.35" fix (#8). "Tell Claude" sits in the transport row, clear of the
  picture at any aspect; its result is a proposal that changes nothing until Accept (#13, #29). Effects dialog: needed
  fields first as a form, Preview/Drop wait until filled, a server `needs` answer shows on the field instead of a raw
  422 (#9). Share dialog stays inside its card, lists review links with a working Revoke, switches visible when off
  (#12). The desktop-only screen switches live on resize (#14). Code view asks before dropping unsaved code, keeps
  Play and FIELDS/JSON on screen at 1440×900, no svg "NaN" errors on open (#15–17). Inspector shows only the rows that
  fit the element, no doubled "CUTOUT", transform reachable without scrolling (#18, #19). Full names on hover/wrap,
  clearer "asks remembered" line, Adjustment placeholder removed, settings spacing, toasts in skin colours, no
  hydration error in Kept clips, named icon buttons, projects page without commit 404s or black cards (#21–28). Not
  reproduced: #11. Tests: packages/styles 33/33 (4 new), apps/web 532/532.
- **MVP test harness `tools/mcp-test` 0.1.0** (mvp-harness, 2026-10-24; worklog docs/restorff/worklog/mvp-harness.md;
  plan/INBOX I-9/I-9a): `run.ts` runs Claude Code headless as the user's Claude with RestorffCut's MCP as its ONLY
  tools (`--tools "" --strict-mcp-config --allowedTools mcp__restorffcut --permission-mode dontAsk --setting-sources ""
  --disable-slash-commands`; checked from the startup event: 23 tools, subscription auth, no CLAUDE.md), one plain
  owner request per reel from `cases/` (five styles), inputs copied to clean folders, the stream and a per-call log
  in %TEMP%\restorffcut-mvp\<run-id>\, token never written. `score.py` measures the master and the reference with the
  same detectors (cuts, cuts on a sound hit, visual-change events calibrated to FINDINGS' eye counts, first change,
  longest no-change stretch, speech %, LUFS/true peak), runs the export gate and counts commits → SCORE.json/.md,
  "owner to watch". Pilot (effects-library, Opus): finished alone in 20 min, 123 calls / 48 commits, gate PASS,
  9 of 11 rows pass (29 % busier than the reel); stuck on composition images (media ids and local paths refused,
  no shell to make data: URLs) and two parallel effect calls that timed out.
- **mcp-test 0.1.1** (orchestrator, 2026-10-24): the scorer no longer crashes writing SCORE.json on a numpy bool; the
  dead-stretch bar is max(3 s, the reference's own longest stretch) because all five references fail a flat 3 s.
  All five cases run by a real Opus client: effects-library, neon-grid-type and paper-collage finished with gate
  PASS; warm-moody and explainer-overlay stopped and asked, because their inputs are the reel with graphics burned in
  (results: restorff-apps/STATUS.md "MVP test").
- **MCP: what the MVP test's real client hit** (mcp-gaps-mvp, 2026-10-24; worklog docs/restorff/worklog/mcp-gaps-mvp.md).
  Composition image params take the user's media: a media_id of the timeline, `media:<id>` (`#t=` = a video frame) or
  this server's `/api/projects/<tl>/media/<id>` URL, inlined server-side before the network-blocked render (stored
  props keep the id; `effects describe` rows say `accepts`). No server filesystem path in any MCP answer (errors
  included); the composition refusals say what to send instead. Timelines are per org: with `X-Restorff-Org` a caller
  lists and reads (timelines and renders by id) only its own — another org's is "not found"; no org = every timeline,
  as before; `GET /api/projects` lists a signed-in user's own. No call hangs past a client's 60 s cut: every call
  answers within 45 s (`RESTORFFCUT_MCP_ANSWER_S`), a call still running answers `status: "working"` and the same call
  collects it (never run twice); writes to one timeline queue in order, a queue past the budget answers
  `timeline_busy`. The pilot's "parallel" timeouts were the client's own 60 s cut on 60–120 s layered effects, not a
  lock. `scripts/mcp-call.ts --org`, both scripts follow "working"; `tools/mcp-test` 0.1.2 runs each client in a fresh
  org. Tests: apps/web 554/554 (12 new), tsc 0 errors. Open: the editor's Motion view re-render routes don't resolve
  media ids; REST reads by id not org-scoped; old `service`-owned projects invisible under an org.
- **Retention in the tool** (retention, 2026-10-24; worklog docs/restorff/worklog/retention.md; owner I-9a "high
  retention"): every render is measured for retention. The hook (first visual change) and each stretch with no visual
  change over 3 s are found on the master by the MVP scorer's own detectors, ported to TS (`packages/gate/src/retention.ts`
  + `apps/web/src/server/retention-measure.ts`; identical on all 9 calibration files, 276 events). The export gate adds
  HOOK (change within 1.0 s) and DEAD (no still stretch over 3.0 s, a marked end card excepted), both SHOULD, with
  time spans, Jump, and tiles in the gate sheet. `check` and `look` answer a retention map that names the move for each
  stretch. New MCP tool `retention`: map, and fix (ONE commit: an opening move in the first second, punch-ins with the
  face kept in place, word pops clear of the face and captions, an SFX on each; `dry_run`; never offered twice in a
  row). On the neon-grid run (branch `retention-live`) the fix took the hook from 2.73 s to 0.53 s and the longest still
  stretch from 7.67 s to 4.40 s (5 → 1 stretches over 3 s). CLI: `apps/web/scripts/retention.ts`. Tests: packages/gate
  67 (15 new), apps/web 554/554. Open: change inside constant motion isn't counted (detector limit); a 1.15 punch can
  crop dense layouts' edges (seen at 25.25 s on the taste-test screen); word pops untested in a render; every reference
  reel itself has 1–8 stretches over 3 s, so DEAD warns on them too (bars wait on the owner's piece types).
- **Scout** (wave 7, 2026-10-24; worklog docs/restorff/worklog/scout.md): `docs/restorff/SCOUT-2026-10-24.md`
  ranks the trending "animate/edit with Claude" tools (licences read from each LICENSE file) and answers "hypergen"
  (no such animation tool; the owner means HeyGen + HyperFrames). Three new library compositions, ported with credit:
  `gl-transition` (27 gl-transitions shaders, MIT; cover a cut in the brand colour or go picture to picture),
  `shader-bg` (Paper Shaders, Apache-2.0, in 40 looks from Remocn, MIT; brand palette), `caption-fx` (7 word-timed
  caption styles adapted from Remocn, MIT, no Remotion code). A CC0 UI-cue pack (28 sounds from uisfx) in
  `apps/web/public/sfx/cc0/` (not wired yet). 12 new fx-sync sources (disabled until converters exist). Licence
  copies and re-sync scripts in `third_party/`, NOTICE updated. Library 56 → 59; compositions tests 218/218. Finding:
  the renderer's headless Chromium gives WebGL2 only (WebGL1 is null). Open: the three ran through the CLI renderer
  only (not MCP or the editor); 32 of 40 background looks not looked at; gallery samples not made.
- **Playbooks over MCP** (hf-skills, wave 7, 2026-10-24; worklog docs/restorff/worklog/hf-skills.md):
  - **What it is:** a new read-only `guide` tool serves 16 craft playbooks one topic at a time.
    - The playbooks live in `packages/compositions/knowledge/`, adapted from HyperFrames' 106 agent-skill files and docs (Apache-2.0 @fa5dbd1), credited per file and in NOTICE.
    - Calls: `guide {}` returns the index (~6.9 K chars), `{topic}` one playbook (≤ 12 K), plus `{topic, section}` and `{query}`.
  - **Topics:** workflow, story, video-types, pacing-retention, motion, transitions, typography-layout, look-and-style, captions, sound, grade, numbers, qa-loop, composition-authoring, composition-example (a new worked composition, rendered and looked at) and animation-runtimes.
  - **Pointers:** the server instructions and the composition / effects / captions / sounds / look descriptions point to it.
  - **Sonnet A/B** (tools/mcp-test 0.1.4 `--deny-tools`, case kinetic-type-guide): the client read composition-authoring unprompted.
    - With the guide, its composition came out with the standard sentence-edit params and re-timeable scenes; without it, it did not.
    - Both passed the gate at −14 LUFS.
    - Both broke rules from playbooks they never opened (last line held ~1 s, a label under 36 px), so composition-authoring gained a "Checks that fail most" section (not re-tested).
  - **Tests:** 14 (apps/web) + 3 (packages/compositions).
  - **Open:** three/lottie/anime renders untested; the GSAP-compatible form renders at 4.6 s per output second (vs 0.7 for our helper form).
- **Director** (wave 7, I-10, 2026-10-24; worklog docs/restorff/worklog/director.md): every effect, transition,
  caption style, grade, sound and edit move now carries technique metadata.
  - **Schema and records:** the metadata covers purpose, beats it fits, energy, duration, placement, needs, pairs/avoid, reuse spacing, look family, cost, and why it holds attention.
    - It lives in the `packages/compositions` technique schema v1 plus `TECHNIQUES.md`: 145 built-in records covering all 62 FX rows, 25 transitions, 6 caption styles, 9 grades, 20 sounds, 13 edit moves and 5 styles.
    - Imports add a `<name>.technique.json` sidecar and are choosable at once.
  - **The `director` tool (new, MCP):**
    - `plan` splits the words into classified beats and picks a technique per beat by fixed rules: hook inside 1 s; a change every ~2 s but no busier than the reference + 15 %; no reuse inside spacing; energy rising to the payoff; CTA last; face-safe; one look per piece; a big-word punch; paired sounds.
    - Params are filled from the words, with one line of why per choice and its override.
    - `apply` makes it ONE commit.
    - `fill {render_id}` plans inside a render's still stretches.
    - `techniques` lists the catalogue.
  - **Live result:** on a Halcyon collage cut, hook 8.6 → 0.2 s, longest still 8.6 → 3.0 s, gate musts 4 → 1 (the one left is the base's transparent PNG). Pace overshot: 9.69 vs 7.30 per 10 s, because animated full-frame pieces add changes the planner doesn't predict.
  - **Weaker models:** a Sonnet run never called `director`. The next step is `references build` / `check` / `retention` pointing their `next` at it.
  - **Tests:** 32 director + 14 technique tests; apps/web 600/600 at 14:47.
- **Animation libraries offline, and our own GSAP-API runtime** (anim-runtime, wave 7, 2026-10-24; worklog
  docs/restorff/worklog/anim-runtime.md).
  - **How a composition asks for them:** compositions can now animate with the GSAP API, Three.js, lottie-web or Anime.js. A `<!-- rc-lib gsap three three-r147 lottie anime -->` marker makes the renderer inject them before any page script, offline, in library and network-blocked custom renders.
  - **Our `gsap`:** RestorffCut's own MIT, clean-room implementation of the GSAP 3 API subset HyperFrames blocks use (174/210 blocks, 237/238 components).
    - API covered: timelines, every position form, CSS/transform/SVG/attr/object tweens, keyframes, stagger, eases, GSAP's callback order, and gsap.utils with seeded random.
    - Plugins: CustomEase, MotionPath, Text, ScrambleText, DrawSVG, SplitText.
  - **Tested against real GSAP:** GSAP itself is never shipped or read; behaviour was matched against GSAP 3.14.2 as a black box. Of 110 comparable blocks, 95 render the same frames, 13 are close, and 2 differ only in raster detail.
  - **HyperFrames page protocol:** every page also speaks it (window.__timelines, hf-seek, __hfLottie, __hfAnime, __hf.buildReady, getVariables).
  - **Vendored (MIT, 2.0 MB):** three.js 0.184.0 and 0.147.0, lottie-web 5.12.2, Anime.js 4.5.0. WebGL 1/2 runs on SwiftShader (`--enable-unsafe-swiftshader`); WebGPU is not available headless (37 shader blocks wait).
  - **Render-hang fix:** server renders no longer hang when Windows' WMI stops answering. `scripts/render/render.ts` CPU accounting now times out after 10 s; four renders hung from 14:16, ../plan/LEARNINGS.md §21.
  - **Version and tests:** @restorffcut/compositions 0.3.0; 47 new tests (package 583/583; apps/web 596/596 in three runs, because Bun 1.2.18 crashes with "mprotect failed: 487" after 21 of 62 files in one process).
  - **Open:** Code view preview doesn't inject the libraries yet; no Three.js example composition.
- **fx-sync 0.1.0 — the internal "stay current" tool** (wave 7, owner I-11, 2026-10-24; worklog
  docs/restorff/worklog/fx-sync.md; runbook tools/fx-sync/README.md).
  - **What one command does:** `bun tools/fx-sync/fx-sync.ts run` takes upstream motion-graphics sources (HyperFrames first; scout's 12 more listed, disabled until converters exist) through a fixed sequence:
    1. fetches them;
    2. diffs them against `tools/fx-sync/manifest.json`;
    3. converts each item into a library composition;
    4. lints it (licence, third-party marks, network, determinism);
    5. test-renders it;
    6. registers what passes, with provenance and director technique metadata.
  - **Reports:** `docs/restorff/fx-sync/LAST-RUN.md`, plus a reviewer page `review.html` in %TEMP%.
  - **First run, 459 upstream items:**
    - **202 imported** (55 blocks, 147 components; +5.98 MB), each rendered and looked at.
    - **237 needs-fix:** baked-text 109, webgpu 38, third-party-mark 32, translate3d 29, video-element 8, clock 7, other 14.
    - **13 needs-runtime:** esm-three 6, d3 5, other 2.
    - 4 rejected, 3 themes folded into a `theme` param.
  - **New files:** `kits/hf-compat.js` (the HyperFrames page protocol), `fonts/gf/` (12 OFL families), `third_party/hyperframes/`, NOTICE lines.
  - **Fixed:** ffprobe output cut short in `packages/compositions/src/ffmpeg.ts`.
  - **Bug caught live:** the brand-copy rewrite had also renamed page code (`window.__hyperframes` → `__halcyon`), so no param reached any page while every test passed. Found by a live `effects apply` (count-up to 92 counted to 100); now pinned by a lint and a test.
  - **Caveat:** 191 of the 202 are 16:9 designs and render small or cropped in 9:16.
  - **Tests:** fx-sync 17, packages/compositions 467/467, apps/web 600/600.
- **mcp-test 0.1.3 + the re-runs** (orchestrator, 2026-10-24): SCORE.md pass flags are plain bools (numpy bools
  printed "True"/"False"). Re-ran neon-grid-type, paper-collage and effects-library on the fixed editor: all three gate
  PASS, 0 timeouts; neon-grid's hook 2.73 → 0.60 s and longest still stretch 7.67 → 4.0 s (it called `retention`
  itself); paper-collage's longest still 3.97 → 2.77 s. Still failing: speech % on the two voice-over cases
  (robotic local voice) and pace (busier than the references). Table: restorff-apps/STATUS.md "MVP test".

## 0.4.0 — 2026-10-20 (wave 5, in progress: a weaker model, one sentence per revision — BUILD-BRIEF §5f)
From the five recreations' gap list (`docs/restorff/recreations/SUMMARY.md`) and the owner's I-8 (*"even if you are
using a smaller version of Claude… Sonnet… it is still able to replicate"*).
- **Sonnet replicated an Opus video for another product** (sonnet-replay — the first test of the owner's I-8): given
  only the neon-grid run's saved records, an agent on **Sonnet** made a 36 s motion graphic for "Halcyon Nitro" over
  MCP — **65 calls / 20 commits** (Opus: 92 / 33), gate **PASS** (Opus: BLOCKED), speech 97.7 % (Opus 62.6 %), −14.0
  LUFS, 4 one-sentence revisions = 4 commits; 12 ✓ · 1 ✗ (30 fps) · 1 unverified on the Opus report's measures.
  Report: `docs/restorff/recreations/neon-grid-nitro/REPORT.md` — its "where Sonnet guessed" list (scene timing from a
  new VO, hard-coded times in composition code, no v1 sources saved, a lane that hid the stamp, cues and the kit only
  knowable from source) is the input for building I-8.
- **Revise never loses words; "take a pass" in one commit** (revise-safety): the Sonnet replay's destructive sentence
  "Change the beat 3 caption to 'and Claude uses'." now fixes only the differing word (Cloud → Claude) as a transcript
  edit + caption rebuild in one commit (live: words 268 → 268); a change that would delete caption words is refused
  with the words and the transcribe call (`allow_word_loss` overrides); a word guard (before/after, cut-aware) on every
  caption path — revise, storyboard `edit_row`, styles apply, captions, transcribe edit, autocut. **"Take a pass at
  editing this"** = transcribe + autocut + transitions **only on set-up changes** (another source file or a scene
  change; measured jump cuts 0.017–0.068 vs set-ups 0.101–0.194) + captions in **one commit** (live: 6.818 s cut, 8
  whips) with undo (new `history restore`) and alter calls. Editing styles list what they leave out (cover, word
  behind the head) with exact `cutout`/`effects` calls and start the mattes. One caption look per span (too-wide chunks
  split instead of shrinking; `captions {action: measure | unify}`; the oat sequence now ends with 0 mixed spans).
  Clips with no face box: captions in the top 15–30 % and the matte started; the gate's FACE rule also judges captions
  there. `scripts/mcpx.py` + `scripts/render-wait.sh` (no hard-coded paths). Found: the oat run's bad rewrite had been
  saved into the shared transcript as a "fix" (repaired on the scratch timeline); captions still avoid faces, not
  overlays (they can sit on a cover's masthead). apps/web 509, gate 52.
- **Composition versions, kits over MCP, and the neon-grid style as eight param-driven pieces** (composition-v3):
  every composition write, update, revise, revert and kit change records a version on the clip (hashes; texts once in
  a content-addressed store); `composition history` lists what changed (props a → b, source ± lines, kit, length) and
  `composition revert {version}` puts one back in one commit (live: v1 → v3 → revert = v1's render hash). `composition
  kit` sets a timeline's shared code and re-renders exactly the clips that include it, in one commit (live: two kit
  clips re-rendered, the third kept its hash). `composition write {library}` places a library piece. `composition
  contract` documents sound cues, scenes, text, opaque and kits. **Neon-grid kit** (neon-hook, neon-grid-ruler,
  neon-flow, neon-curve, neon-beats, neon-code, neon-form, neon-outro): every on-screen word and time is a param, timed
  from the voice-over's words; worked plans for two products (`examples/neon-grid/halcyon-cold-brew-18h.json`,
  `halcyon-nitro-12s.json`) — SEEN rendered both ways (EIGHTEEN HOURS / TWELVE SECONDS, NO SHORTCUTS / NO CREAM
  stamps). Library: 56. compositions tests 198, apps/web 509. Open: `effects apply comp:neon-*` doesn't fill `t0`; the
  Code view doesn't send the timeline kit.
- **Timing from the words** (timing-helper): a read-only MCP tool `plan` answers the exact calls to send for what the
  Sonnet replays did by hand. `plan scenes` cuts a voice-over into scenes on sentence ends (on story beats via
  `starts`, or balanced to a count/length) — on the neon-grid replay: 8.833 / 13.333 / 18.267 / 21.8 / 27.133 vs
  Sonnet's hand cuts 8.75 / 13.25 / 18.2 / 21.8 / 27.2. `plan effects` turns effect names into non-overlapping windows
  on spoken words with `effects apply` calls whose word + occurrence resolve exactly (packed into the replay's span it
  starts 10 of 17 effects where Sonnet did). `plan trim` drops silent head/tail and half-sentences (0.7 / 23.167 vs
  Sonnet's 0.74 / 23.18). Doc traps fixed: `timeline_ops` says `base_commit` is required and where it comes from;
  `effects describe` returns params as one list for every kind (`params_legacy` kept); a bare `timeline summary` over
  20,000 chars is compact (122 K → 37 K chars). New `scripts/mcp-run.ts` runs a list of MCP calls in one session (ids
  from earlier results, `@img:`/`@file:`, polls, scrubbed log, `--from` resume). apps/web tests 497.
- **Sonnet replay 3 — the 17 effects for "Halcyon Nitro"** (sonnet-replay-3; `recreations/effects-library-nitro/`):
  all 17 effects by name, gate PASS, −14.0 LUFS, 73 calls / 26 commits (Opus 119 / 42), **0 delete + re-apply fixes**
  (Opus 14) and no hand placement fixes (face-safe placement centred Digital Zoom by itself); key-word captions and the
  library TOC used. Guessed: caption zone vs. effect text, TOC compact windows, effect timing from the transcript.
- **Sonnet replay 2 — warm-moody for "Halcyon Oat Latte"** (sonnet-replay-2; `recreations/warm-moody-oat/REPORT.md`):
  made and gate PASS at −14.0 LUFS in 93 calls / 27 commits (Opus 164 / 44); autocut caught the retake with no gaps;
  storyboard rows carry spoken lines; moody 41.9 % darker. Still **1 of 6 sentences = 1 commit** ("take a pass" and
  "make it more aesthetic" aren't single moves). **Found a dangerous bug: `revise "change the beat N caption to …"`
  rewrote the whole beat and deleted ~2 s of words** (a caption fix must be a transcript edit, never a deletion);
  caption sizes ended mixed after several restyles; captions covered the face on clips with no face boxes.
- **Explainer build v2** (explainer-v2): `references build` makes the Paper collage explainer as beats {line, picture,
  tag} — each line bound to the pictures whose name, caption or tags share its subject (a line nothing matches says
  so and goes on paper, never a random picture); tags from the places, dates and subjects a line names; title tiles
  from the title answer (the number on the line that says it, "18 HOURS"). **Feel sets the pacing** (punchy ≈ 5 cuts /
  10 s … nostalgic 3) and a `length_s` answer stretches beats into more shots — MEASURED on renders: punchy **4.75**
  cuts / 10 s (the recreation: 3.19; the reel: 4.7 by FINDINGS), nostalgic 3.16; `length_s: 40` → 40.01 s. Richer
  collage: photo cut-outs with a thick outline in the references' accent (red kept), big cut-outs for transparent
  PNGs, drifting scraps, a map zoom, torn-hole pushes, two contrasting paper backgrounds, every text field set (no
  example text). The study card keeps a small recurring accent, reads grainy paper as textured, and finds cuts between
  similar shots (14/14 synthetic clips). All 23 shots of the punchy build looked at (SEEN). styles tests 29. Open: the
  browser Styles tab still uses the old plan; library pieces asked for (globe, torn-hole, retro-tv screen rect).
- **Captions over MCP, v2** (captions-v2): `captions` takes a size (editor units, "1.35x", "135%", "110px",
  "bigger"/"smaller"), a case (lower/sentence/upper), key words (`keys` or "auto", `key_color`, `key_scale`) and the
  new **key-word** style (heavy rounded lowercase, key word bigger in an accent colour on one baseline, no box,
  blur-in — the 17-effects reel's look), up to 5 words per chunk, and `t0`/`t1` to restyle one span; each chunk keeps
  its look through every rebuild. Zone `auto` (default) places each take's captions **clear of the face** (effects-v2's
  face model; SEEN: every caption above the head, eyes and mouth clear). Base, word and shadow layers always change
  together — `set_caption_style` / `apply_style` leave **no ghost copies** and remember the restyle.
  `transcribe {action: "edit", fixes}` fixes a word for good (live: cloud → Claude survived a rebuild);
  `transcribe {all}` / `autocut {all}` handle every clip in one call / one commit. Autocut finds a repeated sentence
  even when Whisper punctuated the takes differently (live: a 2.38 s retake found) and its tail cuts ripple (0 gaps;
  62.29 → 55.17 s). One Chromium text measurer shared with the gate. Fixed on the way: a blur at intensity 0 made
  export throw (blur-in now rests at 0.05). timeline-ops tests 158, apps/web 372. Open: the renderer should skip a
  0-intensity blur instead of throwing; CAP-LEN will flag 4–5-word chunks on ads.
- **The export gate judges each piece as what it is** (gate-v2; `@restorffcut/gate` 0.2.0): piece types (ad,
  talking_head, explainer, motion_graphic, brand_film — the owner's `metadata.restorff.piece` / `brief.piece` win over
  `check {piece}`, so Claude can't re-type an ad to drop R15; otherwise inferred and said) choose every rule's
  severity: R15 offer, R1, R4, R21 only on ads; SAFE follows the canvas (Reels zone on 9:16, title-safe elsewhere);
  FORMAT accepts the piece's aspects and never proposes flipping a 16:9; CAP-LEN 1–3 words on ads, 1–5 elsewhere.
  Rhythm counts **picture changes** (cuts, scenes inside compositions, applied effects, overlay beats), not clips; R3
  and R15 read text inside compositions. New rules **FACE** (an overlay covering ≥ 25 % of the face box ≥ 0.3 s) and
  **FLASH** (a picture on for 1–3 frames at a cut; a black flash is always a MUST). One text measurer shared with the
  caption builder. Findings name their real lane and carry an exact `fix_call`. Re-checked the recreations (before →
  after): explainer-overlay 1 must + 7 should → 2 FLASH musts (the fixture's slivers, real); neon-grid 1 + 12 → 1 (a
  real black frame at 23.80, SEEN); paper-collage 5 + 1 → **PASS**; effects-library 1 + 8 → 1 (a real 1-frame shot,
  SEEN). Planted FLASH + FACE fired and their `fix_call`s cleared them. gate tests 50. Owner decisions: confirm the
  per-piece table (EXPORT-GATE §2a); should an unbriefed vertical talking head default to "ad"; an owner-only way to
  save the piece type.
- **Composition library v2** (library-v2): every composition takes `speed`, and a clip shorter than a composition's
  natural length plays its whole choreography faster instead of cutting it off (fit-to-duration: clock rate =
  max(speed, fit / duration); `fit: false` / `--no-fit` opts out) — UI World now types in 0.92 s, Pullback reaches
  100 % in 0.98 s at speed 1. Applied compositions never show the example's words (missing optional text renders
  blank; missing required text answers `needs: [param]`; the gallery copy is `sample`). Custom compositions show
  `data:` images (≤ 4 MB each; the network stays blocked — a test proves 0 requests) and can share a per-timeline kit
  (`<!-- rc-kit -->`, in the hash only where included). **New library pieces** (each looked at as a contact sheet):
  glass-panel-kit (FX-29), waveform-collapse (FX-33), filmstrip-flash (FX-34), before-after-wipe (FX-36),
  easing-curve (FX-50), paper-form (FX-51), toc-list; float-thumbs takes real images; Headline Wall's wall layout
  follows the face box and honours anchor/offsetY. compositions tests 135 → 165. The Library view's rows for these
  were flipped to available at integration (**49 effects available**). By design, old recorded replays change: library
  applies without their main text now answer `needs`, and shorter durations play faster.
- **Effects can be changed, and they keep off the face** (effects-v2): `effects update {element_id, params}`
  re-renders all of an effect's layers in one commit (params merge over the ones set before; t / word / duration_s
  move it) and `effects remove {element_id}` takes away its layers, its person cut-out, its clip keys and the lanes it
  emptied (live: removing Glass Type + Digital Zoom left 0 elements behind); element_id can be any element of the
  effect. **Face-safe placement**: overlays and front layers are measured against the speaker's face box
  (`faces.json`) and moved off it; Digital Zoom centres on the face (46.1/64.2 — the recreation set 46/64 by hand);
  Cover Story, Frame Break and Glass Type use the real head top; dry runs report each overlay's box vs the face; a
  shared helper (`server/matte-face-span.ts` + `matte-placement.ts`) for captions. Person cut-outs cover only each
  person effect's span (the person video uploaded once per clip, then 0 bytes); transitions cut the person and its
  effect layers out of their window, so **Zoom Through blurs the speaker too** (SEEN, no ghost). Lanes reused in a
  fixed order (captions on top, MOTION, FX, footage, MOTION FRONT, V2 CUTOUT, MOTION BACK). New `look {kind: "clip"}`
  shows one scene from its layers' own renders in 0.3–3.5 s, no timeline render.
- **One sentence = one revision** (revise-v2): `revise` is composition-aware — size / speed / colour / ease / position
  / exit / length words go to the params of the compositions they name ("make the titles bigger" → **one commit**
  re-rendering two custom titles + a library type-on in 7.75 s, the counter untouched — the recreation needed 22),
  custom and library alike; code changes ("smoother transition", "loop the ending") come back with the exact
  composition get → update steps. Styles and grades scope to spans ("make the second half moody", "from 24 s", "the
  last 5 s", "beats 2-3", "after the hook"): the GRADE layer is split there and only those captions are restyled.
  Every clause is reported (applied / nothing_to_change / not_understood with what to send instead); `understood` is
  false whenever one was not done. `composition update` takes `element_ids[]` / `updates[]` as one commit and updates
  library compositions too (no more `not_custom`). Storyboard rows are **beats with their spoken line** (captions,
  voice-over, transcript, explainer script); `edit_row {caption}` rewrites the existing chunk with its word layer —
  never a second caption track — and records a transcript fix so a rebuild keeps the words. `history` reads as named
  versions (v1 cut → v2 titles bigger …; `history {action: name | tag}`), shows composition props before → after, and
  doesn't count approvals or gate fixes. apps/web tests 372. Open: the reducer's `grade {target: all}` fails once the
  GRADE layer is split (revise works around it; `timeline_ops` will hit it); moody captions overlapped a kinetic title
  at 13 s (SEEN).
- **Sound and voice v2** (sound-voice-v2): "Design the sound" works on **real** cuts — loop seams, texture overlays
  and graphics are no longer cuts — and lands a hit **on** each cut (new Whoosh hit / Swish hit / Paper slide: the
  transient is the sync point), plus sounds on cues inside compositions (manifest `cues`, else the composition's own
  frames: typing, stamps, scene cuts, beat words). MEASURED on a Halcyon test cut: cuts with a hit within ±0.05 s
  **1/6 → 6/6** (offsets −12…+2 ms), sounds on loop seams 3 → 0; on the paper-collage recreation (dry run) 18 seams
  skipped. Seven new code-made SFX (pack 1.1.0: whoosh-hit, swish-hit, marker-scribble, stamp-slam, tape-stop,
  typing-burst, paper-slide; the 20 old files byte-identical). `sounds place {items}` = many sounds in one commit.
  `music {loop: true}` = whole bars, no fades (MEASURED 4.00 bars) with a "snap the cut to N bars" hint.
  `voiceover {tighten: true}` cuts pauses > 0.35 s (speech share **54.6 % → 91.4 %**, timings within 8 ms);
  `fit_to {t0, t1} | {beat} | {element_id}` speeds the voice up to fit (≤ 1.4×) or refuses (`does_not_fit`); an
  overlapping line is refused with a fix instead of a silent VOICE 2 lane. `voices` lists natural-voice owner options.
  apps/web tests 354. **Not heard by a person**; the editor's own button still runs the v1 planner.
- **MCP is discoverable for a weaker model** (mcp-discover): `timeline_ops {action: "reference", op?}` lists every
  ops@1 op's fields, types, units, ranges and an example, generated from the validator (27 ops); `timeline_ops.ops` is
  a per-op `oneOf`; invalid ops name the right field (live: `"target" unknown field for trim — use "el"`, with
  `did_you_mean`, allowed, required) and point at the reference, never a repo file. `timeline summary` gives exact
  seconds (to the tick), `end`, transforms and keyframes; `timeline element` reads one element in full (74,522 → 4,168
  chars); `timeline get` comes in pages under the result cap (the 621,818-char timeline → 7 pages ≤ 64.7 k). Every MCP
  answer drops data: URLs and base64 (mime + sha256 + length), puts `commit_id` first, never answers a committed write
  with `result_too_large`, speaks seconds instead of ticks; `render` status at the top level; track names resolve to
  ids (ambiguous → listed). Nine misleading `next` hints fixed in `mcp/hints.ts` (one test each). `mcp-call list`
  prints the server instructions. apps/web tests 314. Untested: whether every real Claude client accepts the `oneOf`.

## 0.3.0 — 2026-10-20 (wave 4, in progress: everything a Claude does in the reels, reachable over MCP)
Owner, 2026-10-20: *"TEST IF WE CAN MAKE SUCH VIDEOS USING CLAUDE AND OUR RESTORFF CUT ; BASICALLY DEVELOP AND INCLUDE
EVERYTHING THAT CLAUDE DOES OR MAKE OR USES INTO OUR TOOL ITSELF"*. Plan and roster: BUILD-BRIEF §5d–§5e.
- **Reel recreations — a Claude made the videos through RestorffCut's MCP alone** (BUILD-BRIEF §5d step 3; reports
  in `docs/restorff/recreations/<style>/REPORT.md`, every MCP call in `calls.jsonl`): **neon-grid-type**
  (DeBhOJ6T1Ja): 38 s, 6 compositions written as code, 4 one-sentence revisions = 4 commits, −14.0 LUFS — 11 ✓ / 5 ✗,
  and `replay.ts` rebuilds the final from the saved compositions **bit-identically** (PSNR ∞). **warm-moody**
  (DeUUFJQu8cw): 49.1 s from nine raw clips, serif karaoke, whips, warm → moody (−41.6 % luma), words behind the head,
  gate PASS at −14.0 LUFS — 9 ✓ / 3 partial / 3 ✗ (only 1 of 6 sentences was one commit; "bigger captions"
  impossible). **paper-collage** (DePNgrmToh9): 37.5 s 16:9 explainer, 9 collage effects, v1 → v3, edit link +
  FCPXML — 7 ✓ / 3 partial / 5 ✗ (pacing 3.2 vs 4.7 cuts/10 s, 17 % of cuts on a hit vs 56 %, no word captions).
  **explainer-overlay** (DeIGbZypIUb): 49.6 s, autocut 3/3 planted defects, 22 overlays, matches the reel's length,
  speech share, beat rate, face-safe zone and loudness — 13 ✓ / 3 ⚠ / 2 ✗ (one sentence = 22 commits; ops@1
  undiscoverable over MCP). **effects-library** (Def9pj5TWtA): all 17 named effects by name in 16.6 s (the reel's
  pace), 8 layered behind the speaker, 12 of 17 pass their Accept bullets — 9 ✓ / 5 ✗ (an applied effect can't be
  changed; face box unused; a custom TOC list in `recreations/effects-library/compositions/`). Merged gap list:
  `docs/restorff/recreations/SUMMARY.md` → wave 5 (BUILD-BRIEF §5f).
  Common gaps (next build round): the gate's ad-only profile; revise/storyboard blind to captions, compositions and
  explainer beats; caption control over MCP; reading the timeline (no paging, no op reference); sound design blind to
  overlays; voice pacing; history versions; a 7.5 s clip failed the server matte.
- **The parity audit** (`docs/restorff/PARITY.md`): for each reference reel, everything Claude does, makes or uses,
  with RestorffCut's state in the UI and over MCP, a ranked gap list (G01 create + import over MCP was rank 1 and
  unowned → agent mcp-media; G14 references → mcp-references), owner items with free alternatives, and a recreation
  brief per reel. All five reels measure −14.1…−14.5 LUFS (our master: −14). No reel uses an avatar.
- **Person effects go behind the speaker over MCP** (effects-layers): `effects apply` reads each composition's
  `effect` recipe and builds it as one commit — clip → back render → the speaker's person cut-out (server matte, made
  or reused; new optional `wait_s`) → front render — filling matte frames, face box, clip stills, masthead offset and
  frame-break window, and keying the clip and its cut-out. SEEN in renders: Orbit's far card passes behind the head;
  Cover Story's HALCYON masthead under the hair; Green Screen's room replaced with the speaker in front (ragged
  shoulder fringes from the matte); Frame Break's hair breaking out of the frame; Vertigo and Glass Type now apply
  their compositions (shaders kept as `shader:` extras); `params.layer: "all"` keeps the single overlay. The editor's
  own drop places person effects the same way when the clip has a cut-out (track order SEEN at 1440). **Fix: server
  matte jobs on clips longer than ~7 s no longer fail in transfer** (1 MB CDP chunks; an 8 s clip now passes).
  apps/web tests 287, compositions 135. Untested: Couch Wall, Paper Cut, Headline Wall, Doodle Boil, UI World,
  Pullback; Green Screen's front layer took 51 s for 4 s (a ~10 s effect may pass the 180 s budget).
- **All 17 named effects + the paper-collage kit** (collage-fx; EDT-17, EDT-21): new compositions orbit, couch-wall,
  ui-world, frame-break, green-screen, vertigo, glass-type, cutout-outline, paper-texture, parallax-strip, triptych,
  halftone-push (library 29 → 41); extended cover-story (masthead behind the head), paper-cut (torn white edge from the
  person matte), doodle-boil (boiling body outline), headline-wall (wall layout), pullback-window. Effects that go
  behind the speaker render as a **back layer under the person cut-out and a front layer above it**; each manifest's new
  `effect` block records the layer order, inputs and the clip's keyframes. **Effects library: 42 ready · 6 partial ·
  14 coming** (was 24 · 16 · 22). Every effect looked at as a 6-frame contact sheet over a fictional stand-in (fixed:
  Orbit read as a pile, Green Screen washed the speaker lavender, Vertigo smudge, paper looked like wood, a 15 fps
  matte trailed hands → 30). compositions tests 135. Open: nothing reads the `effect` recipes yet (MCP places one
  overlay, so nothing passes behind the speaker) → agent effects-layers; not yet run on a real server matte.
- **Reference folders → style card → explainer, over MCP** (mcp-references; EDT-21, PARITY G14). `references`:
  `add` (a file or whole folder, URL, base64, a media-store id; 9 files in 637 ms; re-adding is a no-op); `study`
  (ffmpeg scene changes, samples and grain crops → the styles package's style card: palette with roles, mood, texture,
  pacing, motion, the footage / format / feel questions with suggested answers; contact sheets + a palette strip as
  images; ~3–4 s — the detected cuts were exactly the planted ones); `build` → the Paper collage explainer server-side
  as **one commit by claude whose message is the change note**, each later build on branch `explainer-v<n>` saying
  "What's new in vN". Live v1 → v6 on a Halcyon test timeline; v5 used collage-fx's new pieces by name (9 of
  FX-52…61; EDT-21 asks ≥ 4); SEEN in renders: the ROUTE letter tiles, the farm cut-out with a torn mustard outline,
  the map card, the retro TV, the thread timeline, the parallax strip. Pieces join the plan only if they render; a
  build that runs out of time commits nothing.
- **Voice-over and music over MCP** (voice-music) — free, offline: local voice-over with Windows' own voices (5 on
  this machine), word timings MEASURED against the audio (±12 ms in the take and in the export; fixed the old engine
  reporting times 1.378× late), takes at −16 LUFS on a VOICE track, words in the transcript store so `captions`
  follows (dry run: 9 chunks, verbatim); **five generated, seamlessly looping music beds we own** (warm, moody, upbeat,
  ambient, tense; 2.4 MB, −18 LUFS, exact beat grids). MCP `voiceover` {text, voice?, rate?, t?, beat?} and `music`
  {mood | track_id, t?, duration_s?, duck?} — one commit each; the bed loops under the cut, ducked under the spoken
  words (MEASURED ≈ 18 dB under the voice, duck depth 9.1–9.6 dB), faded; the mix masters to −14.0 LUFS / −1.6 dBTP.
  "Music beds" in the Sounds panel (SEEN at 1440). **Not yet heard by a person**; the Windows voices are robotic —
  natural voices and licensed music are owner options (`docs/restorff/worklog/voice-music.md`).
- **The ops reducer is near-linear** (reducer-perf; `@restorffcut/timeline-ops` 0.2.0): `apply` no longer clones the
  whole project per op (undo log + live index + incremental invariants), results byte-identical (532/532 calls in the
  whole suite, 19 equivalence tests against the frozen old reducer). MEASURED: 10,002 caption ops 179 s → 169 ms;
  2,702 → 59 ms; autocut 9,999 ops 90 s → 610 ms — long talking heads no longer risk the 120 s MCP tool budget.
  timeline-ops tests 140.
- **Talking head over MCP** (mcp-cut; EDT-11/12) — reel DeIGbZypIUb's workflow, server-side. `transcribe`: word
  timings with faster-whisper large-v3 (TVF) on the GPU, a background job cached per file hash; a **second listening
  pass** re-hears each stretch between pauses, so a restart Whisper merged into one phrase comes back. `autocut`:
  silences, retakes, false starts, dead head/tail → the cut list with reasons and times, one commit, captions rebuilt in
  the same commit. `captions`: the five styles verbatim inside the safe area, text **measured in headless Chromium with
  the real font** and laid out at the whole font sizes the editor stores (SEEN: highlight boxes sit exactly on their
  words after that fix), the same CAPTIONS / CAPTION WORDS / CAPTION SHADOW layers as the editor's tab. Routes
  `/api/transcripts/:project/:media`, `/api/transcripts/jobs/:job`. MEASURED on the 49.5 s reel: transcribe 24–38 s
  (272 words), autocut < 1 s, captions 5–10 s (98 chunks, 0 outside the safe area), render −14.0 LUFS. On planted raw
  footage: **53.7 → 49.6 s** (a false start + 1.42 s of silence + tail gone; Whisper alone missed the false start).
- **Person cut-out and reframe over MCP** (mcp-cutout; EDT-22, EDT-06 sizes) — the `cutout` tool: matte · status ·
  apply · reframe. The person matte now runs **server-side**: a background job in headless Chromium runs the editor's
  own MediaPipe segmentation (0.10.35) + VP9-alpha render, plus MediaPipe BlazeFace (Apache-2.0), cached by media
  sha256 → `person.webm` + `faces.json` (face box, 6 keypoints, person/head boxes per frame). 6 s 1080×1920 clip: ~20 s
  per job (segmentation ~50–74 fps, faces ~37–64 fps on the RTX 3060; half is the ~16 MB model download), cached calls
  35 ms. `apply`: text behind person, green screen, cover story, frame break — one commit by claude; `reframe` 4:5 /
  1:1 / 16:9 on its own branch, clips following the face. SEEN in pipeline renders: "ONE POUR." behind the head (hair
  over the letters); the face in frame at 1:1 and 16:9. `getFaceBoxes` / `faceAt` (`server/matte.ts`) is the shared
  face-box reader for captions and effects. The preset layout maths is shared with the editor; small preset text no
  longer clamps to size 5 (it oversized cover-story text). Untested: green screen / frame break renders, 4:5.
- **Interchange export** (interchange; EDT-19): a commit exports as an editable timeline for other editors — **FCPXML
  1.10** (Final Cut, Resolve) or **OpenTimelineIO** JSON: main track as the primary storyline, overlay/audio as lanes,
  every cut on the frame grid (rational, NTSC-exact), captions/text as titles, dissolves on the cut, comments and Judge
  findings as markers, media linked to the server or a local folder (`media_root`); what a format can't say
  (compositions → rendered alpha video, grade, effects, keyframes, masks) is listed per export. MCP `export` and
  `import_cuts` (an OTIO edited elsewhere → split/trim/move/delete in one commit; only clips the export listed can be
  deleted; re-import is a no-op). Live: FCPXML 7,999 B parsed by Python's XML reader; OTIO 48,622 B; round trip of 11
  clips, **worst error 0 frames**. Editor: Render final → "Export timeline (FCPXML / OTIO)" (SEEN, download works).
  Not yet opened in a real Final Cut/Resolve/Premiere; Premiere has no native FCPXML import.
- **A Claude can start from nothing over MCP** (mcp-media; PARITY G01 — the audit's rank-1 blocker — G09, G12):
  `timeline create {name, aspect, fps}` makes a timeline with Restorff's six lanes (9:16 or 16:9 → 1920×1080, SEEN);
  `media import` brings a file in by **URL, base64, server path or a signed upload URL** (`upload_needed` → `put_url`
  + a ready `curl -T`), probes it, stores it by sha256 (deduplicated: `already_imported`), and places it on a lane —
  one commit by Claude the editor pulls with the file (a 1.45 MB clip by URL: 109 ms; sha256 identical on download);
  `media list`. New **`sounds`** tool: list the 20-sound pack, place a sound on a time or a clip, and run **"Design the
  sound" on the server** (dry run planned 7 SFX; re-running replaces instead of stacking). Every timeline result now
  carries `editor_url`; `timeline share` returns a review link. SEEN in the editor at 1440: Claude's timeline with
  "Claude: sound: paper-rustle…", the media in the bin, the bed's waveform, the SFX lanes. apps/web tests 261 pass.
  Limits: `data_base64` ≤ ~700 KB (MCP body cap) — bigger files by URL/path/upload; a remote Claude needs
  `RESTORFFCUT_PUBLIC_URL` for the upload URL.
- **Review and revise over MCP** (mcp-review; EDT-13/14/16/19/20) — the reel DeUUFJQu8cw way. `revise`: one sentence
  → one commit by claude with the sentence as its change note (saved-style triggers first, then the command bar's
  planner; address a beat, element or time and only that changes; `dry_run` shows ops + chosen preset; what isn't
  understood comes back with example `timeline_ops` using real ids). Live: "make it moody" → `moody-captions`;
  "tighter cut, bigger captions" → 51 ops, −8.02 s, captions 1.35×; "change the beat 5 caption to …" → one text op;
  slowing the talking head is refused (it would drop words). `storyboard`: one row per beat over the whole runtime
  (time, shot, line, on-screen text, overlays/effects, sound cue; 11 beats / 20 s, no gaps); `edit_row` = one commit;
  `approve` recorded in project metadata, `stale` after later edits. `history`: v1…vN with author, change note, op
  summary. **Saved styles live on the server** (PGlite tables, `/api/styles`), the styles lab syncs with them; the
  `styles` tool lists/applies/saves/versions/suggests them; repeated asks from MCP and the command bar feed "save as a
  style?". apps/web tests 239 pass. Open: render doesn't wait for storyboard approval yet
  (`storyboardApproval(snapshot)` exported, unused); the editor's Storyboard view counts shots, MCP counts beats.
- **Effects by name over MCP** (mcp-effects; EDT-17) — the `effects` tool: `list` every effect from the reference
  reels with its status (the same 62 rows the editor's Effects → Library reads, plus every package composition, the
  24 transitions and the grade looks; new compositions appear with no code change — collage-fx's orbit, couch-wall
  and frame-break moved coming → partial live); `describe` (params, what it needs, the exact call); `apply` at a time,
  **on the onset of a spoken word** ("Chart Grow on 'doubled'") or on a clip, as one commit by Claude — compositions
  render onto MOTION, shaders become an FX layer, transitions and grades are ops@1; matte-needing effects answer
  `needs: person_matte` → `cutout`. Live over MCP, rendered and SEEN: Chart Grow from 2.35 s on "doubled", a 1.35×
  Digital Zoom on "eighteen", a whip at the 4 s cut, warm grade (MEASURED: mean RGB 125/131/126 → 131/139/127). Open:
  the Library view and the MCP catalogue disagree on 2–3 statuses; the FX layer's place (above footage vs. on top of
  captions) needs one rule.
- **Colour grade** (grade agent): a one-pass GPU colour grade, `restorff-grade` (exposure, contrast, saturation,
  temperature, tint, shadows/midtones/highlights, split toning, vignette, moving film grain, amount — every slider
  keyframable), with named looks (**warm morning, moody, clean, film, cool night, punchy, paper, black and white**)
  and nudges (warmer, cooler, brighter, darker, more/less contrast…) in one shared file,
  `packages/timeline-ops/src/grades.ts`. ops@1 `grade` is **applied for real** (a clip, a track, or the whole video as
  a GRADE layer under the captions; undoable) instead of recorded pending — the editing styles, the storyboard
  compiler, saved styles, the command bar's colour words and Claude over MCP all draw it; the inspector's Grade row
  opens a look picker with sliders (SEEN at 1440). Fast UGC's "whip on beats" now rolls cuts onto the beat grid and
  whips them. MEASURED/SEEN: moody −30 % mean luma (FX-39 asks ≥ 20 %), black and white has zero chroma, grain
  survives H.264. **Fixed an upstream bug that made every effect layer fail its frame** (Rust read
  `effect_pass_groups`, TS sends `effectPassGroups` → "Invalid frame descriptor"). `restorffcut-wasm` 0.5.0; cargo
  68 tests (10 on the real GPU, one checking every pixel against a CPU copy of the maths); timeline-ops 121.
- **Render, look and check over MCP** (mcp-render; EDT-06/08/09/18) — a Claude renders its own edit, looks at it,
  checks it and fixes it before the final. `render` turns a commit into a mastered MP4 on the server (job folder from
  the snapshot + the media store; a background bun worker runs the editor's own export headless, then −14 LUFS /
  −1 dBTP); it answers at once with a `render_id`, `render {render_id}` waits ≤ 25 s; browser-only media →
  `media_missing` with ids; same commit + quality → `repeated`. `look`: contact sheets (1/s, 7 frames) or stills at
  given times, ≤ 12 per call. `check`: the export gate on a render + its commit → PASS / BLOCKED / INCOMPLETE,
  findings posted as timeline comments (gone ones marked fixed), `next` = a look at the finding or render final.
  Routes `GET /api/renders?timeline_id=`, `/api/renders/:id`, `/api/renders/:id/file` (Range). **Live over MCP** on a
  Halcyon project: preview 9.9 s for 6 s → check BLOCKED (SAFE: the hook ran off both sides — SEEN in a still; R15
  no offer) → two fixes → PASS → final 12.1 s, PASS. Open: the gate measures text without the editor's measurer and
  underestimates bold capitals (SEEN: reported 69 px over, the box was out on both sides); the Judge's slow checks are
  listed as not run.
- **Polish** (polish agent): the Edit artboard's **judge finding card** — JUDGE-row markers are 14 px squares (must
  amber, should `#5A5A63`, selected neon with glow) that open a 360 px card: severity · rule · time · who raised it,
  the finding, the fix, and Jump / Apply fix / Resolve. Apply fix shows only when the finding carries a machine fix
  (`fix_ops`, ops@1, dry-run first, one undo; or LOUD via the gate's gain); SEEN at 1440: the end card moved 10.5 →
  9.0 s. The artboard's lanes (TEXT · CAPTIONS · V2 B-ROLL · MUSIC · SFX) now stay when empty. **Audio crossfades**
  under picture transitions, equal power over the transition window, preview and export — MEASURED on a headless
  render: the hard cut became A and B crossing ~3 dB down at the cut, full mix flat at −16.7 dB. The 4 failing web
  tests were test bugs, fixed: **`bun test` 206 pass, 0 fail**. Design question for the owner: an open must marker is
  amber here, neon on the artboard and in EXPORT-GATE §3 (one line to switch: `review/findings.ts`).
- **`scripts/mcp-call.ts`**: a CLI that drives `/api/mcp` exactly as a Claude client does (initialize → tools/list →
  tools/call; `--images <dir>` outside the repo). Live: 8 tools listed; `timeline list`, `styles resolve`, `look`
  (4 frames) answered.

## 0.2.0 — 2026-10-20 (wave 3, part 1: built, not yet tested — owner: *"testing and fixing can be done later"*)
Each line's detail, how to run it and what is untested: `docs/restorff/worklog/<agent>.md`. Roster: BUILD-BRIEF §5c.
- **Projects live on a server** (port): commits of project snapshots + ops, branches, conflicts (409 with what changed),
  share links (`/shared/<token>`, review player, comments that accept judge findings), media stored once by sha256 —
  on PGlite (Postgres in WebAssembly; `RESTORFFCUT_DB=postgres` for a real one), no Docker. API: `apps/web/README-RESTORFF.md`.
  Restorff's gateway builds timelines through it (live-checked: compile → Claude's commit → conflict → share).
- **Headless render** (pipeline): a job folder → the editor's own export in headless Chromium (4.5× real time on an
  RTX 3060) → master to −14 LUFS / −1 dBTP → the export gate; `autocut` and a one-command `demo`. `docs/restorff/PIPELINE.md`.
- **Export gate in the editor** (gate): Render final → render → checks (`packages/gate`, 23 tests; `/api/gate` measures
  the file with ffmpeg) → a gate sheet; Download final stays off until PASS, unless the owner records a written
  override (D13; never for claims, never for Claude). Findings become timeline markers. "Fix loudness" adds gain.
- **"Tell Claude…"** (bridge): a command bar over the preview; styles, "tighter cut", caption changes and composition
  nudges apply as one undoable change with a before/after wipe; Claude's own commits show as "Claude: <message>" with
  Keep / Restore. **Standalone MCP** at `/api/mcp` (timeline, timeline_ops, styles, media, look, render) — RestorffCut
  works with any Claude, no Restorff needed (EDT-10).
- **The Edit artboard, element by element** (design): header, kept-clips grid S01…, audio list, transport, the six
  inspector rows from real clip data, ruler, track labels and colours, JUDGE markers; new **Storyboard** view (EDT-14)
  and before/after **Compare**; projects page with 9:16 cards. Screenshots `docs/restorff/design/design-*-1440.png`.
- **Sound** (sounds): a built-in pack of 20 SFX we generate ourselves (`apps/web/public/sfx/`, measured peaks in its
  manifest), a Sounds panel (search, preview, drag, "+" at the playhead; Freesound with a key), and **"Design the
  sound"** — hits, riser, whooshes, pops ≥ 0.25 s apart, music ducked 3 dB, one undo (7 tests).
- **Media** (media): 24 transitions drawn by our own compositor (10 new WGSL shaders: dissolve, dip, flash, whip/push,
  slide, zoom-through, wipe, iris, glitch, blur) — a Transitions tab, a per-clip Transition tab, ops@1 `transition`;
  delivery presets (9:16 / 4:5 / 1:1 / 16:9 / review, explicit bitrates) in Settings → Delivery; **every export masters
  to −14 LUFS / −1 dBTP** (BS.1770-4 meter + true-peak limiter, measured on the encoded file: −14.1 LUFS / −1.4 dBTP on
  a test signal); beat detection on music (ticks, snapping, "Snap cuts to beats"; exact tempo at 92–150 BPM on click
  tracks); "Duck under voice" (−18…−12 dB). **Project format v32** (one additive migration; v31 still loads).
  `restorffcut-wasm` 0.4.0, 55 cargo tests; `timeline-ops` 98 tests.
- **Transcript → cut → captions in the editor** (captions; EDT-11/12): the CAPTIONS tab has Transcript (Whisper in the
  browser, word timings; sentence timings split and marked "approximate" when a model can't give words; cached per
  file), Cut ("Find dead air & retakes" → a list you can untick → one undo step, captions rebuilt after) and Captions
  (five styles: Word pop · highlight, Bold white, Serif box · karaoke, Mono label, Huge centred; kept in the safe area;
  an editor to change, split, merge, nudge or delete). The default word-timing model id is unverified (falls back to
  Whisper Small). 8 new caption tests.
- **Motion graphics, effects, styles in the editor** (compose; EDT-13/15/17): pick a composition, fill its fields; the
  server renders it to transparent video (cached by settings) and it lands on a MOTION track at the playhead; "slower,
  bigger, make it red" re-renders the selected one in place (undoable). **29 compositions** (21 new: phone mockup, paper
  cut, doodle boil, map route, retro TV, magazine cover, neon grid, stamp, counter, social end card…; each looked at as
  a contact sheet). Effects panel: Motion · Shaders · Library — all 62 effects listed (22 ready, 15 partial, 25 coming;
  only ready/partial have a button). The 5 editing styles now edit the open project in one undo step (whips and grades
  recorded only — no such effects yet; the picker says so). `/api/compositions` (5 routes) needs Node + Chromium +
  FFmpeg on the server. Compositions tests 67.
- **Person cutout + auto-reframe** (cutout; EDT-22, EDT-06 sizes): MediaPipe person segmentation in a Web Worker
  (15 fps, in-between frames interpolated, masks cached in the browser); "Cut out person" puts a transparent copy of
  the clip on a `V2 CUTOUT` track above it, frame-aligned (rendered to transparent WebM, since the mask system can't
  take per-frame images yet). Presets, one undo each: Text behind person, Green Screen, Cover Story, Frame Break.
  Auto-reframe builds 4:5, 1:1 and 16:9 from the 9:16 master, following the speaker. Library and models Apache-2.0;
  **MediaPipe pinned to 0.10.35** — 1.x sends usage data to Google (needs user consent; owner decides).
- **The timeline compiler** (compiler; EDT-03): `compileStoryboard(spec, assets, options)` → ops@1 + a report, and
  `specFromBoard` / `specFromBrief` read Zeigarnik's storyboard and brief exports. Cuts on the word (0.08 s before the
  first word), camera moves on stills, punch-ins on emphasis, 1–3-word captions, music under the voice, SFX at cues and
  on cuts (from the built-in pack's manifest), the style's grade, an end card with the CTA; a text placeholder where a
  shot is missing. On the real Zeigarnik storyboard: 96 valid ops, applied with 0 conflicts. The report lists what
  ops@1 can't say yet (caption highlight, placeholder shot, beat ids on elements, track roles, text wrap, music loop,
  face-centred punch-in, composition by name). 9 tests; timeline-ops 108.
- **Saved styles + explainer from references** (styles; EDT-20/21): `packages/styles` — an instruction or op pattern
  repeated 3× (wording normalised) drafts a saved style in the preset shape; saved styles are versioned, export/import
  as JSON, and apply as one undo step; project-bound edits ("tighter cut") are saved as the sentence and re-resolved.
  A style card (palette, mood, grain, pacing, motion + three questions) from a dropped folder of references → an
  explainer built on the Paper collage preset (paper-cut, map-route, retro-tv, thread-timeline, stamp, doodle-boil),
  listing what can't be built yet. UI: a Kiln "Save as style?" chip, a save sheet, "My styles", a Styles tab with the
  folder drop → card → Build. Styles are stored in this browser only (localStorage). 13 tests. At integration: a saved
  style's trigger sentence typed in the "Tell Claude…" bar now applies that style (one undo step, a toast) instead of
  being parsed.
- **Custom compositions — motion graphics written as code** (motion-code; EDT-15, reel DeBhOJ6T1Ja): Claude (MCP
  `composition`: contract · write · update · get) or a person (Effects → MOTION → Write it as code) writes a
  composition as one HTML/CSS/JS file; it is validated (no network APIs or outside URLs, seekable by time, ≤ 256 KB,
  errors with line numbers), rendered to alpha WebM with the network blocked in Chromium (`data:` origin + blocked
  requests + a dead proxy; 0 requests reached a live local server in the test), cached by hash, and placed on the
  MOTION track as one undo step or one commit as `claude`. The source travels in the clip (`restorff.composition =
  {custom: true, source, props, hash, …}`): Edit code reopens it in a Code view with a sandboxed live preview, typed
  props and inline errors; Save & re-render swaps it in place (SEEN at 1440: 5.0 s); a missing render is re-made from
  the code. Three worked examples (kinetic type, a perspective grid with a camera move, a growing chart; renders
  2.6–4.8 s at 540×960). Routes `/api/compositions/custom` (+ `/<hash>`, `/validate`, `/kit`, `/examples`); "faster,
  bigger" nudges work on custom ones. compositions 101 tests (34 new). The runtime change re-renders each cached
  library composition once.
- **The web app's own tests run again**: `bun test` in `apps/web` never instantiated the engine (wasm-pack's bundler
  output imports the `.wasm` as ESM, which Next's bundler handles and Bun's test runner doesn't) → 8 failures + 2
  errors, all from `wasm.__wbindgen_start is not a function`. A test preload (`apps/web/bunfig.toml` →
  `test-setup/wasm.ts`) instantiates it: **189 pass, 4 fail** (was 166 / 8 + 2 errors). The 4 left are in files
  unchanged since the base (`masks/__tests__/snap.test.ts` ×3: one needs a canvas; `placement` "batch time spans":
  the test passes 2.5 where integer ticks are required) — likely upstream's, not proven (the base wasn't re-run).
  Baseline the same day: timeline-ops 108, compositions 101, gate 23, styles 13, pipeline 6 — all pass;
  `bun run build` exit 0 (compiled in 12.1 s) with one warning: the standalone output can't copy a traced chunk named
  `[externals]_node:module_….js` for `/api/mcp` (a `:` is illegal in Windows file names) — build standalone/Docker
  images on Linux.
- `timeline-ops` gained sentence intents (bridge) and sound design (sounds). Fixed at integration: the command bar's
  caption matcher also caught the CAPTION WORDS / CAPTION SHADOW layers, so "bigger captions" would have scaled the
  text without its highlight boxes; it now skips those layers and, on word-by-word captions, points to the Captions tab. `bun run build` passed for the sounds
  agent; `tsc` 0 errors at 11:40.

## 0.1.0 — 2026-10-20
The editor exists. Owner, 2026-10-20: *"start building the restorff cut for me"* — decisions and reasoning in
`docs/restorff/BUILD-BRIEF.md`.
- **Base:** the last full web editor of the open-source project we build on (commit `238750c0`, 2026-05-18, MIT —
  credits in `NOTICE`), with its history, on local branch `restorffcut`. Rust engine in WebAssembly (compositor,
  effects, masks, time). bun 1.2.18; `bun install` 966 → fewer packages after the cleanup.
- **RestorffCut, everywhere:** every user-visible name, package (`@restorffcut/web`, `restorffcut`), storage key,
  title, manifest, icon, CI/Docker/wrangler name and the desktop scaffold renamed. Only `LICENSE` (MIT requires the
  original copyright line; ours added above it) and `NOTICE` keep the upstream names, plus the engine dependency until
  the local `restorffcut-wasm` build replaces it.
- **Removed:** the marketing home (`/` → `/projects`), blog, changelog, contributors, roadmap, sponsors, brand page,
  RSS, the beta welcome dialog, the feedback popover, Discord/GitHub links, react-scan, analytics, BotID and 16 unused
  dependencies. Privacy/terms rewritten minimal and marked DRAFT for the owner.
- **The Restorff skin** (the design canvas's Edit artboard): dark screen palette, Archivo (width 125) + JetBrains Mono,
  3.5 % grain, the header (wordmark, breadcrumb, commit line, Share with an editor, Render final), kept clips + audio
  panel, 9:16 preview with mono timecode, the SELECTED inspector + EDITING STYLE picker (Fast UGC · whip on beats,
  Talking head · clean, Aesthetic · warm magazine, Moody · huge captions, Paper collage), tracks named V1 A-ROLL ·
  V2 B-ROLL · TEXT · CAPTIONS · MUSIC · SFX, new projects 9:16, neon only on the selected clip. Dev server on port 8791.
  Checked in a browser at 1440 (project, imported clip + mp3, text, playback) and 390 (desktop-only page).
  Placeholders, each labelled in code: the commit line, Share, Editing style, the inspector's Author row.
- **Build fixed:** the base didn't pass `next build` (2 undefined helpers, 5 stale call styles, 2 test assertions).
  Now `bun run build` passes; `bun test` 166 pass, 8 fail — all 8 files import the WASM package, which bun's test runner
  can't load.
- **`packages/timeline-ops` 0.1.0 — `ops@1` and the pure reducer** (`plan/06-mcp.md` §5): all 25 ops, a validator,
  `apply(project, ops, {seed})` deterministic and non-mutating, `changes`/`conflicts`/`unsupported` reported (never
  dropped). Fully applied: canvas, tracks, elements, `set`, number keyframes, captions, `text_pop`, `gain`, `duck`,
  `apply_style`, `mark`; partly: `import_media` (no media list in the project), `transition` (cut, match, dip to black),
  `sfx` by name; recorded as pending: size variants, `normalize`, `grade`, crop keyframes, other transitions. The
  talking-head compiler seed `cutFromTranscript` (silences > 0.35 s and first takes out, 1–3-word captions). 64 bun
  tests + 3 node tests, `tsc` clean. `MODEL.md` (the project JSON as it really is), `PARITY.md` (all 40 editor commands).
  Found two editor keyframe bugs on split (read in source, not yet run).
- **The Rust engine builds from source, as `restorffcut-wasm` 0.3.0** (`rust/`): Rust 1.99.1 (GNU host — no MSVC
  here) + wasm32 + wasm-pack 0.15.0 (`docs/restorff/RUST.md`). The untouched source built byte-identical `.d.ts`/`.js`
  to the npm package; after our changes all 28 original exports are unchanged, plus `listEffectShaders()`. **Three new
  GPU effects**, one pass each, every parameter keyframeable: **Digital Zoom** (punch-in with motion blur + chromatic
  edge), **Vertigo** (dolly-zoom), **Glass Type** (frosted panel behind text); app definitions ready in
  `rust/web-effects/*.ts`. 34 cargo tests (11 existing + 23 new: parameter packing, WGSL→GLSL compile, real-GPU pixel
  renders on an RTX 3060). `.wasm` 2,986,767 B (1.1 MB gzipped). The app still uses the npm build until the switch
  (RUST.md §8).
- **Docs:** `docs/restorff/` — BUILD-BRIEF, EFFECTS (62 effects, each with a build path and acceptance check), REELS
  (EDT-11…22), EXPORT-GATE (21 checks, `finding@1`), design references, per-workstream worklogs.

## 0.0.2 — 2026-10-19
- README "Sound is half the ad": music to picture (board hit points as markers, cuts snapped to hits), a designed sound
  per shot, -14 LUFS / -1 dBTP master, TVF `feel` sync check (cuts on hits >= chance + 10) before export, per-section
  feel arc beside the timeline. Owner, 2026-10-19: "video is 50% audio". Still no code.

## 0.0.1 — 2026-10-14
- Renamed from `cutcritic/` to **RestorffCut** (owner, D12). It's now part of Restorff, not a separate product; built
  thin and swappable for a third-party AI editor. Still no code.

## 0.0.0 — 2026-10-14
- Repo created with its handoff files (`py ../doctor.py --new cutcritic`). No code.

## Next (ideas, not started)
- **Wave 4 integration items** (found by the agents, 2026-10-20): after a tighter cut the music bed and the GRADE
  layer keep their old length (runtime stays, storyboard ends in an empty row) — trim trailing layers to the cut;
  `render` final should wait for storyboard approval (EDT-14; `storyboardApproval` exists); one storyboard model for
  the editor view and MCP (beats); a saved style drafted from "bigger captions" stores an absolute size, not a ratio;
  the gate underestimates bold-caps width without the editor's text measurer; the Library view and the MCP effects
  catalogue disagree on 2–3 statuses; one rule for where an FX layer sits; mcp-review's 3 tables → a numbered migration;
the editor's CAPTIONS tab uses fractional font sizes (5.2, 3.8…) the editor rounds,
  so its highlight boxes likely drift (mcp-cut fixed this server-side only); the editor's Transcript tab doesn't read
  server transcripts yet (~10 lines in `transcription/transcript-store.ts`).
  ops@1 has no `music` op or music/voice track roles (beds are written as `sfx` then re-tagged); the master's gain drifts
  −0.7 dB across a 40 s render (MEASURED by voice-music, cause unconfirmed).
  `explainerPlan` sends `ease` to thread-timeline (no such param; the browser flow loses that beat — the server drops
  undeclared props); paper-texture at 1920×1080 × 4 s exceeds the composition service's 240 s cap (server renders it at
  half size); `effects-catalogue.test.ts:27` expects FX-03 partial, collage-fx made it ready (update after collage-fx lands).
- **The bulk test + fix pass** (owner deferred testing on 2026-10-20): every agent's "Untested" list in
  `docs/restorff/worklog/` (no dev-server restart needed: on 2026-10-20 the wasm it serves hashed identical to
  `restorffcut-wasm` 0.4.0, sha256 `15a4c4bc…` — Turbopack picked up the workspace package); audio crossfades at
  transitions; the 4 web-app test failures; empty TEXT/SFX lanes vanish after the first edit (the editor core drops
  empty overlay/audio tracks after every command — the artboard shows them); the artboard's large judge finding card;
  "bigger captions" from the command bar on word-by-word captions should rebuild them through the Captions tab's engine
  (today it declines with a pointer there).
- **Text wrap in ops@1** (a max width on text elements): SEEN 2026-10-20 in the first compiled v0 rendered headless —
  the compiler's placeholder text for missing shots ran off both edges of the 9:16 frame. Interim fix done the same day:
  the compiler breaks placeholders into lines itself (`wrapText`, 28 chars) — SEEN in the next render: three centred
  lines inside the frame, so the editor's renderer honours `\n`. Other long text (Claude's own `insert`) still can't wrap.
- Keep `metadata.restorff` (pending instructions) when the browser re-saves a project (`saveProject` rebuilds metadata
  field by field today — ops worklog).
- The web app imports `@restorffcut/timeline-ops` (tsconfig `allowImportingTsExtensions`), and can load a project the
  reducer produced.
- Parity tests: the same op through the reducer and through the browser command, JSON compared.
- Audio in `ops@1`: music hits as board markers, SFX bound to a visual event (beats, ducking and normalize exist since 0.2.0).
- Every quarter, check whether a third-party AI editor can load our timelines; if one can, prefer it to growing this.
