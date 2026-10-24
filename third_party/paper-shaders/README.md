# third_party/paper-shaders (+ Remocn looks)

| | |
|---|---|
| Upstream | https://github.com/paper-design/shaders (Apache-2.0, `LICENSE` and `NOTICE` here, copied unchanged) |
| Commit | `71be01576e8402c62ac76386bb4a7c59092e24c7` (pushed 2026-10-23) |
| Looks from | https://github.com/Remocn/remocn @ `7aebcbe6514ed9e54e3a4a6786f83f8425a4a9af` (MIT, `../remocn/LICENSE`): the preset objects in `registry/remocn/shader-{mesh-gradient,grain-gradient,warp,swirl}-<look>/index.tsx` (values only — no Remocn or Remotion code) |
| Taken by | scout agent, 2026-10-24 (`docs/restorff/SCOUT-2026-10-24.md` §3.6) |
| Used in | `packages/compositions/compositions/shader-bg/shader-bg.html` (the `PAPER` table between the `@paper-shaders` markers) |

## What was taken
- Fragment shaders of `mesh-gradient`, `grain-gradient`, `warp`, `swirl` (`packages/shaders/src/shaders/*.ts`), with the
  GLSL helpers they splice in (`shader-utils.ts`), the vertex shader (`vertex-shader.ts`), the fit map
  (`shader-sizing.ts`) and the 128×128 noise PNG (`get-shader-noise-texture.ts`) — GLSL text resolved from the TS
  template literals, otherwise unchanged.
- Each shader's `defaultPreset` params from `packages/shaders-react/src/shaders/<type>.tsx`.
- 36 named looks from Remocn + 4 Paper defaults = 40 (`look` param).
- Paper's `NOTICE` asks for "Powered by Paper Shaders: https://shaders.paper.design"; it is reproduced in the repo
  `NOTICE`.

## Update
1. Shallow sparse clones outside the repo (`%TEMP%\restorffcut-scout\` was used):
   `git clone --depth 1 --filter=blob:none --sparse https://github.com/paper-design/shaders.git paper-shaders` then
   `git sparse-checkout set packages/shaders/src packages/shaders-react/src`; and
   `git clone --depth 1 --filter=blob:none --sparse https://github.com/Remocn/remocn.git remocn` then
   `git sparse-checkout set registry/remocn`.
2. From `restorffcut/`: `bun third_party/paper-shaders/extract.ts <paper clone> <paper sha> <remocn clone> <remocn sha>`
   — prints `wrote 4 shaders, N looks …` and the look ids. It reads the files as text (nothing upstream is run) and
   fails on a template expression it cannot resolve.
3. If the look list changed, update the `look` enum in `shader-bg.html`'s params block to match the printed ids.
4. Render a contact sheet of new looks (`cli.ts render … --set look=<id>` then `cli.ts look`) and open it.
5. Update the commits here, in the composition header and in `NOTICE`.

## Next
- More types: `god-rays`, `metaballs`, `smoke-ring`, `voronoi`, `liquid-metal` (logo), `halftone-cmyk`, `paper-texture`
  (each needs its uniform names added — the host already maps numbers, colours, colour lists and the noise texture).
