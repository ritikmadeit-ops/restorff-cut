# DECISION — how RestorffCut renders compositions (2026-10-20)

**Decision: (c) our own minimal renderer, built on HyperFrames' ideas and compatible with its page contract.
No HyperFrames code is copied.** HyperFrames stays the reference implementation and a drop-in upgrade path.

## What HyperFrames is (READ from its source, cloned 2026-10-20 into the session scratchpad)
| Fact | Value | Source |
|---|---|---|
| Repo | `github.com/heygen-com/hyperframes`, HEAD `7d47194e` (2026-10-19) | `git clone --depth 1` |
| Licence | **Apache-2.0 — verified** from the repo's `LICENSE` file (full Apache 2.0 text; appendix line "Copyright 2026 HeyGen, Inc."). No root `NOTICE` file. `@hyperframes/cli` package.json says `Apache-2.0`; `core`/`engine`/`producer` package.json have no `license` field (the root LICENSE covers them). | `LICENSE`, `packages/*/package.json` |
| npm | CLI is published as **`hyperframes` 0.8.178, 21.9 MB unpacked**, plus deps `puppeteer-core`, `@puppeteer/browsers`, `sharp`, `esbuild`, `fontkit`, `hono`, … and it downloads its own `chrome-headless-shell`. Libraries: `@hyperframes/engine` 1.4 MB, `@hyperframes/producer` 2.7 MB, `@hyperframes/core` 3.9 MB (unpacked). | `npm view` 2026-10-20 |
| Repo size | 1.5 GB shallow clone (613 MB `.git`, 618 MB `packages/`, 107 MB `registry/` of 210 blocks) | `du -sh` |
| How it renders | Puppeteer opens the HTML in `chrome-headless-shell`; the engine reads `window.__hf.duration`, calls `window.__hf.seek(t)` per frame (`t = frame / fps`, never a clock), captures, pipes to FFmpeg. On **Linux** it uses `HeadlessExperimental.beginFrame` (atomic frame capture, `--deterministic-mode`); **elsewhere (Windows) it falls back to seek + `Page.captureScreenshot`**. | `packages/engine/README.md`, `src/types.ts` (`HfProtocol`), `src/services/browserManager.ts` |
| Authoring | HTML with `data-composition-id`, `data-start`/`data-duration`, `class="clip"`; animation is usually a **paused GSAP timeline** registered at `window.__timelines[id]`; the runtime also seeks CSS animations, WAAPI, Lottie, Three.js, Anime.js. | `docs/concepts/compositions.mdx`, `frame-adapters.mdx`, `skills/hyperframes-core/SKILL.md` |
| Parameters | Typed `data-composition-variables` JSON on the root (`string`, `number`, `color`, `boolean`, `enum`, `font`, `image`), overrides injected as `window.__hfVariables` before page scripts; `label`/`description` written for people **and agents**. | `docs/concepts/variables.mdx` |
| Alpha output | `--format webm` → `libvpx-vp9`, `yuva420p`, **`-auto-alt-ref 0`** (alpha + alt-ref is unsupported) and `-metadata:s:v:0 alpha_mode=1`; `--format mov` → `prores_ks` profile 4444, `yuva444p10le`. Transparent capture via `Emulation.setDefaultBackgroundColorOverride {a:0}` and **`optimizeForSpeed: false`** ("`true` crushes real alpha values"). | `src/services/chunkEncoder.ts`, `screenshotService.ts` |

## Options weighed
| Option | For | Against |
|---|---|---|
| (a) depend on `hyperframes` | Feature-rich (audio, video-in-composition, shaders, Lambda) | 21.9 MB CLI + puppeteer + sharp + esbuild + its own Chrome download; GSAP is its idiomatic animation layer and **GSAP is not OSI open source** ("Standard 'no charge' license", `npm view gsap license`) — a risk for an MIT fork and its users; most of the surface (audio mixing, HDR, distributed render) is unused by an overlay renderer; Windows path is its screenshot fallback anyway |
| (b) vendor parts | Proven code | Engine is 3 MB of TS tied to `@hyperframes/core`/`parsers`; untangling costs more than writing the small part we need; NOTICE + change-marking overhead |
| **(c) own minimal renderer** | renderer core 763 lines (`cdp.ts` 293, `render.ts` 292, `ffmpeg.ts` 178), page runtime 355, CLI 354 (counted 2026-10-20); **zero runtime npm dependencies** (Chromium over raw CDP with the built-in `WebSocket`, FFmpeg already on PATH); deterministic by construction; params block designed for sentence edits | We maintain it; no audio/video-inside-composition yet (not needed for overlays) |

## Why (c), concretely
1. **Fastest working path on this machine (MEASURED).** Playwright `chromium.launch()` **hangs under Bun 1.2.18 on
   Windows** (no output in 90 s), and Playwright's `connectOverCDP` fails under Bun (`ws unexpected response 200 OK`);
   both work under Node. A 120-line CDP client on the runtime's built-in `WebSocket` works under **both** Bun and
   Node and captured a 1080x1920 transparent PNG in 83–100 ms. Puppeteer (HyperFrames' choice) uses the same `ws`
   transport, so (a) would most likely hit the same Bun failure (ASSUMPTION — not run).
2. **Fewest heavy dependencies.** Playwright is kept as a dev dependency only to *locate and install* Chromium
   (`chromium-headless-shell` 1243 was already installed for Playwright 1.63.0, so nothing was downloaded).
3. **Licence-clean.** Our runtime ships its own easing/tween helpers, so compositions never need GSAP.
4. **Compatible both ways.** Every composition exposes `window.__hf = { duration, seek(t) }` — the exact `HfProtocol`
   the HyperFrames engine renders — so if we ever need HyperFrames' extras (audio, Lambda) our compositions should
   render there unchanged (UNVERIFIED until tried). Our `params` types mirror its variable types.

## Taken from HyperFrames as ideas (not code)
`window.__hf` seek protocol · `t = frame / fps` integer frame clock · VP9-alpha flags (`-auto-alt-ref 0`,
`alpha_mode=1`) and ProRes 4444 flags · transparent capture via `setDefaultBackgroundColorOverride` · its
compositor flags (`--run-all-compositor-stages-before-draw`, `--disable-checker-imaging`, …) · typed parameter
declarations with descriptions written for agents · the determinism rules (no clock, no unseeded random, no
mid-render fetch, finite length). Credit is in `README.md`.

Where we measured differently: HyperFrames captures with `optimizeForSpeed: false` because the fast path "crushes
real alpha values"; on Chromium 153 + our flags the fast path gave pixel-identical RGBA, so we use it (25 % faster)
and `test/render.test.ts` re-checks the equality every run. If code is ever copied from HyperFrames, add its Apache-2.0
`LICENSE` + a `NOTICE` here and mark the changed files (BUILD-BRIEF §6 rule 7).

## Revisit when
- We need audio or `<video>` inside a composition → try rendering our compositions with `npx hyperframes render`.
- Bun fixes Playwright on Windows → consider swapping the CDP client for Playwright.
- Linux render workers → BeginFrame capture (atomic frames, faster) is worth adding.
