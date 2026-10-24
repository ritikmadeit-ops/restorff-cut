# third_party/gl-transitions

| | |
|---|---|
| Upstream | https://github.com/gl-transitions/gl-transitions |
| Commit | `66a975917ab01a738408c81eb74fd329935e1c72` (2026-10-21) |
| Licence | MIT (`LICENSE` here, copied unchanged). Each shader also names its author and licence in its own header; the 27 used are all MIT. Two upstream files are BSD (`InvertedPageCurl.glsl` BSD-3, `StereoViewer.glsl` BSD-2) and are not used. |
| Taken by | scout agent, 2026-10-24 (`docs/restorff/SCOUT-2026-10-24.md` §3.2) |
| Used in | `packages/compositions/compositions/gl-transition/gl-transition.html` (the `GLT` table between the `@gl-transitions` markers: our id → upstream file, author, licence, GLSL source unchanged) |

## What was taken
27 files from `transitions/`, unchanged, wrapped by our own WebGL2 host (modes cover / in / out / images, timing,
textures). Ids: `wipe-soft` (directionalwipe), `circle-open` (circleopen), `star-wipe` (StarWipe), `heart`, `pinwheel`,
`clock-wipe` (Radial), `window-slice` (windowslice), `squares-wipe` (squareswire), `random-squares` (randomsquares),
`polka-dots` (PolkaDotsCurtain), `melt-bars` (DoomScreenTransition), `zoom-circles` (ZoomInCircles), `noise-dissolve`
(perlin), `wind`, `film-burn` (FilmBurn), `tv-static` (TVStatic), `burn`, `cross-zoom` (CrossZoom), `cube`, `pixelize`,
`glitch-memories` (GlitchMemories), `dreamy` (Dreamy), `cross-warp` (crosswarp), `ripple`, `swirl` (Swirl),
`linear-blur` (LinearBlur), `water-drop` (WaterDrop). The full list with authors is `PICK` in `extract.ts`.

## Update (re-run when upstream changes)
1. Shallow sparse clone outside the repo (`%TEMP%\restorffcut-scout\` was used):
   `git clone --depth 1 --filter=blob:none --sparse https://github.com/gl-transitions/gl-transitions.git` then
   `git sparse-checkout set transitions`.
2. From `restorffcut/`: `bun third_party/gl-transitions/extract.ts <path to the clone> <commit sha>` — prints
   `wrote 27 transitions @ <sha> into …gl-transition.html`. It refuses a file whose licence line is not MIT/BSD.
3. Render a contact sheet of every id you added (see `docs/restorff/worklog/scout.md` for the loop) and set its
   `cover` flag in `PICK` from what you see: `true` only if its first and last frames are transparent in cover mode.
4. Update the commit in this README, in the composition's header comment, and in `NOTICE`.

## Next
- The crate `crates/gl-transitions` ships WGSL versions (`wgsl()` accessor): port the best into
  `rust/crates/effects/src/shaders/transitions/` as real two-clip transitions (rust owner).
