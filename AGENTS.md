# AGENTS.md — restorffcut

The folder contract is **`../AGENTS.md`** (the phase, the owner's preferences, the handoff standard) — read it first.
Then **`docs/restorff/BUILD-BRIEF.md`**: what the owner asked for on 2026-10-20, the decisions, who owns which files,
and the rules every agent here follows. This file only adds what is specific to restorffcut.

## Rules specific to restorffcut
1. **No "OpenCut" or "CapCut" anywhere a person can see it, and none in our package or internal names** (owner,
   2026-10-20). The only exceptions: `LICENSE` (MIT requires the original copyright line) and `NOTICE`; and the
   `opencut-wasm` dependency until the local `restorffcut-wasm` build replaces it.
2. **The look is the design canvas's Edit artboard** (`docs/restorff/design/edit-artboard.png`; tokens in
   `../plan/11-design-brief.md` §3): screen palette, one neon `#F6FF00` isolate per view, Archivo / JetBrains Mono.
   Every UI change gets a real browser look at 1440 px.
3. **Claude edits through `ops@1` and commits, never through the editor's browser commands**
   (`../plan/05-architecture.md` §8). New edit features land in `packages/timeline-ops` first, then in the UI.
4. **Rust/WASM for per-frame work** (compositing, effects, masks, new effect shaders in `rust/crates/effects`);
   React/TypeScript for UI. Runbook: `docs/restorff/RUST.md`.
5. **Keep it swappable.** The owner expects to adopt a third-party AI editor one day (D12). Spend effort on the seam
   (ops → reducer → commits), the skin and the features the reels asked for.
6. **Licences kept:** MIT notices for OpenCut and OpenCut-AI; Apache-2.0 notices for anything taken from HyperFrames.
   Upstream's bundled models may be non-commercial (risk R13) — never ship them.
7. **No pushes** until the owner creates Restorff's GitHub repo; both remotes' push URLs are disabled. **Commits:
   only the orchestrator** makes local checkpoint commits (owner, 2026-10-20: "Yes, commit locally"), using the identity
   "Restorff build (local)". Agents never commit.
8. **Third-party reference media** (the owner's reels, `../spikes/s6-reference-reels/media/`) never ships and never
   goes into this repo.
9. **Not to be confused with `evolve-agent\studio\cutcritic`** — the private review agent whose logic became Restorff's
   Judge worker (`../restorff/workers/judge/`). This repo is the editor.
10. **The goal is the MVP** (owner, 2026-10-23, `../plan/INBOX.md` I-9/I-9a): a real Claude client plugged into
    RestorffCut makes *high-effort, high-retention, professional reels and ads with cool effects — viral edits*.
    Judge every change by whether it moves `tools/mcp-test` (a headless Claude with only our MCP) closer to the bar in
    `../STATUS.md` "MVP test". Re-run the cases after a fix round. A smaller model must get the same result (I-8).
11. **Know-how lives in the tool, not in the model's head** (I-8, I-10). Every new effect, style or technique ships
    with technique metadata: purpose, when to use it, spacing, placement, and the retention reason
    (`packages/compositions/src/technique.ts`, the director). Every craft rule a model needs ships as a playbook served
    over MCP (`packages/compositions/knowledge/`, hf-skills). Retention is measured on every render
    (HOOK/DEAD gate rules, the `retention` tool).
12. **Take freely from open source, the right way** (I-10; full rules in `docs/restorff/BUILD-BRIEF.md` §5g).
    Apache, MIT, BSD, ISC and OFL code and assets: adapt them, keep the LICENSE under `third_party/<source>/`, add a NOTICE
    entry and an "Adapted from …; modified" header. Never ship GPL, AGPL or MPL code, **GSAP**, or Remotion code; use
    our MIT GSAP-compatible runtime (`packages/compositions/src/gsap-compat/`). No third-party logos or brand names in
    shipped blocks.
13. **Stay current with `tools/fx-sync`** (I-11): it watches HyperFrames and the scout's sources, diffs, converts,
    lints (licence, marks, network, determinism), test-renders and registers new blocks, effects, styles and skills.
    Run it on a schedule; a human reviews its report before the orchestrator commits.

## Never finished, built for release
Every session may extend it; `CHANGELOG.md` keeps a "Next" list that never goes empty. No secrets, tokens, account ids,
client data or personal emails in files that ship.

## Before you finish
`CHANGELOG.md` for anything a user would notice · `LEARNINGS.md` for anything that cost time or money · your
`docs/restorff/worklog/<workstream>.md` · the folder's `../STATUS.md` and `../LOG.md` · `py ../doctor.py --repo
restorffcut` passes.
