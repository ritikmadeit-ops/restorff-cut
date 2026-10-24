# vendor/ — animation libraries compositions can load offline

Third-party builds a composition asks for with a marker comment (`<!-- rc-lib three -->`, see `../src/libs.ts`). The
renderer injects them as init scripts before any page script: nothing is fetched at render time, so they work in the
network-blocked custom renderer. All MIT. NOTICE entries: `restorffcut/NOTICE` ("three.js", "lottie-web", "Anime.js").
GSAP is **not** here and never may be (not OSI open source; DECISION.md): `gsap` is our own `../src/gsap-compat/`.

| Marker | Files | Version | Licence | Bytes (MEASURED 2026-10-24) | Source |
|---|---|---|---|---|---|
| `three` | `three/three-0.184.0.min.js` | three.js 0.184.0 + 18 addons | MIT (`three/LICENSE`) | 840,268 | npm `three@0.184.0`, bundled by us (below) |
| `three-r147` | `three-r147/three-0.147.0.min.js`, `three-r147/three-0.147.0-examples.js` | three.js 0.147.0 | MIT (`three-r147/LICENSE`) | 607,784 + 130,219 | npm `three@0.147.0`: `build/three.min.js` unchanged; 8 `examples/js` files concatenated unchanged |
| `lottie` | `lottie/lottie-5.12.2.min.js` | lottie-web 5.12.2 | MIT (`lottie/LICENSE.md`) | 305,543 | npm `lottie-web@5.12.2` `build/player/lottie.min.js`, unchanged |
| `anime` | `anime/anime-4.5.0.umd.min.js` | Anime.js 4.5.0 | MIT (`anime/LICENSE.md`) | 118,043 | npm `animejs@4.5.0` `dist/bundles/anime.umd.min.js`, unchanged |
Total 2.0 MB (`du -sh vendor`).

**Why two Three.js builds.** HyperFrames blocks were written against both: 12 load the r147 UMD build plus
`examples/js` globals (`THREE.GLTFLoader`, `THREE.EffectComposer`…; those files were removed upstream in r148), 7 use
ES modules at r170–r184. `three` (0.184.0) is the default for new code; `three-r147` keeps the old blocks running.
One page may load only one of them (both set `window.THREE`; `libsIn()` reports it).

**WebGL in the renderer.** Chromium headless shell 153 with our `--disable-gpu` flags gives WebGL 1 and 2 on
ANGLE + SwiftShader (CPU): renderer string "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))" (MEASURED
2026-10-24). `cdp.ts` adds `--enable-unsafe-swiftshader` so this keeps working when Chromium drops the automatic
fallback. WebGPU (`navigator.gpu`) is **not** available headless — the 37 HyperFrames WebGPU shader blocks
(`lib/shaders.iife.js`) cannot render here yet.

**How each library follows the frame clock** (the runtime's `hf-protocol.js`; nothing may use its own clock):
| Library | Composition does | Runtime does each frame |
|---|---|---|
| Three.js | `window.addEventListener("hf-seek", e => { mesh.rotation.y = e.detail.time; renderer.render(scene, camera); })`; never `setAnimationLoop`/`Clock` | dispatches `hf-seek` (`waitUntil(promise)` is awaited before the capture) |
| lottie-web | `const a = lottie.loadAnimation({ container, renderer: "svg", loop, autoplay: false, animationData }); window.__hfLottie.push(a)` (data inline: no `path`) | `a.goToAndStop(frame, true)`, frame = t × fr (mod totalFrames when `loop`, else clamped) |
| Anime.js v4 | `window.__hfAnime.push(anime.animate(el, { …, autoplay: false }))` or a `createTimeline({ autoplay: false })` | `a.pause()` once, then `a.seek(t × 1000)` |

## Update a library (exact steps; run 2026-10-24 for the versions above)
Work in the session scratchpad, never in the repo:
```
mkdir vendor-build && cd vendor-build && echo '{"name":"vb","private":true}' > package.json
npm install three@0.184.0 lottie-web@5.12.2 animejs@4.5.0 --no-audit --no-fund
npm pack three@0.147.0
```
1. **three (bundle):** copy `three/build-entry.js` (in this folder: imports `* as CORE from "three"` and the 18
   addons, sets `globalThis.THREE = Object.assign({}, CORE)` with `THREE.addons = {…}`) into `vendor-build/`, then
   `bun build build-entry.js --minify --format=iife --target=browser --outfile out/three-<ver>.min.js`
   (a "wildcard sideEffects" warning is expected). Copy it and `node_modules/three/LICENSE` into `three/`.
2. **three-r147:** `tar -xzf three-0.147.0.tgz package/build/three.min.js package/LICENSE package/examples/js/...`;
   concatenate in this order (dependencies first): `shaders/CopyShader.js`, `shaders/LuminosityHighPassShader.js`,
   `postprocessing/EffectComposer.js`, `postprocessing/MaskPass.js`, `postprocessing/RenderPass.js`,
   `postprocessing/ShaderPass.js`, `postprocessing/UnrealBloomPass.js`, `loaders/GLTFLoader.js`.
3. **lottie / anime:** copy the file named in the table and the package's `LICENSE.md`.
4. Rename with the new version, update `../src/libs.ts` (`files`, `version`), this table (bytes: `ls -l`), NOTICE,
   `../CHANGELOG.md`.
5. Verify: `cd packages/compositions && bun test test/gsap-compat.test.ts` — the "Three.js (r184 and r147),
   lottie-web and Anime.js load offline and follow the seek" test renders each one in Chromium.

**Known failures.** `GLTFLoader` / `FontLoader` / `TTFLoader` cannot fetch files during a render: pass models and fonts
inline (`parse()` an ArrayBuffer/JSON decoded from a data: URL). r147's `DRACOLoader` is not vendored (it downloads
its decoder from gstatic). A block calling `renderer.setAnimationLoop` or `new THREE.Clock()` animates on real time:
rewrite it to draw in the `hf-seek` listener.
