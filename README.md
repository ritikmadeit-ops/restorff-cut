# RestorffCut — Restorff's video editor (the Edit stage)

A web video editor that **Claude can drive and a person can finish**: Claude builds the timeline through `ops@1`
(motion graphics, captions, cuts, effects, sound), the editor shows it in Restorff's screen skin, and a human editor can
open the same project by link. Owner, 2026-10-20: *"this will be an overall one in all package, a killer product"* —
the five reference reels behind that are in [`docs/restorff/BUILD-BRIEF.md`](docs/restorff/BUILD-BRIEF.md) §4.

**Part of Restorff, not a separate product** (owner, D12, 2026-10-14) — and kept swappable: Claude never drives this
editor's own commands; it emits `ops@1`, a pure reducer applies them, and the editor loads the result
(`../plan/05-architecture.md` §8). Any editor that can load our timelines could replace this one.

## What it's built from (decided 2026-10-20 — full reasoning in the build brief §2)
- **Core:** OpenCut's last full web editor, commit `238750c0` (2026-05-18, MIT). OpenCut itself replaced its web editor
  with a rewrite a week later, so this is the newest complete one: Next.js 16, React 19, and a **Rust engine compiled to
  WebAssembly** (6 crates: GPU compositor via `wgpu`'s WebGL2 backend, effects, masks, time) in `rust/`.
- **Ported from OpenCut-AI** (MIT): server-side commits, share links, frame-accurate review comments (wave 2).
- **Ours:** the Restorff skin (`docs/restorff/design/edit-artboard.png`), `ops@1` + reducer
  (`packages/timeline-ops`), code-built motion graphics (`packages/compositions`), the effect library (Rust shaders +
  compositions, `docs/restorff/EFFECTS.md`), the export gate (`docs/restorff/EXPORT-GATE.md`).
- Licences: `LICENSE` (MIT, upstream copyright kept, as MIT requires) and `NOTICE`.

## State (2026-10-20, building)
| Piece | Where | State |
|---|---|---|
| Editor core | `apps/web` | runs locally (`bun run dev`, port 8791); reskin + rebrand in progress (wave 1) |
| Rust/WASM engine | `rust/` | prebuilt `opencut-wasm` 0.2.10 from npm today; local build as `restorffcut-wasm` + new shaders in progress |
| `ops@1` reducer | `packages/timeline-ops` | in progress (wave 1) |
| Compositions (motion graphics as code) | `packages/compositions` | in progress (wave 1) |
| Server commits, sharing, review comments | port from OpenCut-AI | wave 2 |
| Claude's MCP tools (`timeline`, `timeline_ops`, `render`, `look`) | `../restorff/apps/gateway` | wave 2 |
Live status: [`docs/restorff/worklog/`](docs/restorff/worklog/) (one file per workstream) and `../STATUS.md`.

## Run it
Needs bun 1.2.18 (`npm install -g bun@1.2.18`, done 2026-10-20) and Node 24.
```
cd C:\data\code\overkill\restorff-apps\restorffcut
bun install
```
**Check:** `966 packages installed` (2026-10-20, ~98 s; `node_modules` is 1.5 GB).
```
copy apps\web\.env.example apps\web\.env.local
cd apps\web
bun run dev
```
**Check:** `Ready` and the local URL (port **8791** once the skin work lands; it was Next's default before). Open
`/projects`, create a project: the editor opens with preview, timeline and panels, and the console shows no errors
(checked 2026-10-20 on the base). `.env.local` is git-ignored; the editor itself needs no database (projects live in the
browser's IndexedDB/OPFS). Port 3000 and 8790 are used by other things on this machine.

## Sound is half the ad (owner rule, 2026-10-19)
Owner: *"video is 50% audio, so good music, perfect sync and soundeffects is a must."* The Edit stage must deliver:
1. **Music to picture:** the board's `music.hits` (studio boardsmith R21) become timeline markers; the music is cut or
   composed so each hit lands on its shot. Snap cuts to beats/hits within one frame.
2. **A designed sound on every shot:** voice, SFX, room tone, a music hit, or a written `silence` reason (R23). SFX come
   from a named library, placed on the visual event to the frame.
3. **Mix and master:** dialogue clear over music (-18 to -12 dB, ducked), master -14 LUFS integrated, true peak <= -1
   dBTP, no clipping.
4. **Sync check before export:** TVF `feel` (0.8.0) on the render — cuts on a sound hit >= chance + 10 points (cutcritic
   R22) and lip sync checked by ear. A failing sync blocks export, as a failing lint blocks a board.
5. **Feel check:** TVF `feel` per-section arc shown beside the timeline, so the editor sees where the cut goes flat.

## Git
This folder is a git checkout with OpenCut's full history (1,599 commits) on branch **`restorffcut`** (from
`238750c0`); `upstream` = OpenCut-app/OpenCut, `oca` = Ekaanth/OpenCut-AI. **Both push URLs are disabled** and nothing
is committed: creating Restorff's GitHub repo and the first commit are the owner's steps. `git status` shows all our work.

## Layout
```
apps/web/            the editor (Next.js) — skin, routes, UI
apps/desktop/        upstream's desktop scaffold (unused)
rust/                the engine: crates/{compositor,effects,gpu,masks,time,bridge} + wasm/ (→ WebAssembly)
packages/timeline-ops/   ops@1 + the pure reducer (ours)
packages/compositions/   motion graphics as code → alpha video (ours)
docs/restorff/       our docs: BUILD-BRIEF, design references, EFFECTS, EXPORT-GATE, REELS, RUST, worklog/
```

## Known failures and fixes
| Symptom | Cause | Fix |
|---|---|---|
| `Port 3000 is in use … using 3001` | another process on this machine owns 3000 | use port 8791 (`bun run dev` does once the skin lands) |
| `py ../doctor.py` ran for > 10 minutes | the doctor walked `node_modules` | fixed 2026-10-20 (it prunes skipped folders; now 0.5 s) |
