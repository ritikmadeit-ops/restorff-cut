# RestorffCut Rust engine — runbook (`restorffcut-wasm`)

Owner: the **rust** agent (BUILD-BRIEF §5: `rust/**` + the Rust toolchain in the user profile). Decision B3: Rust where
it pays (per-frame work: compositor, effects, masks, time) compiled to WebAssembly; React/TypeScript for the UI.
Last verified: 2026-10-20, Windows 11, Git Bash. Every command below was run on that date unless marked otherwise.

| | |
|---|---|
| Package | `restorffcut-wasm` **0.5.0** (crate `rust/wasm`, was upstream `opencut-wasm` 0.2.10); 0.4.0 = + 10 transition shaders, frame item `transition`, `listTransitionShaders()` (media agent, 2026-10-20, §6b); 0.5.0 = + the `restorff-grade` colour grade and the effect-layer (`sceneEffect`) fix (grade agent, 2026-10-20, §6c) |
| Crates | `rust/crates/{bridge,compositor,effects,gpu,masks,time}` + `rust/wasm` |
| Toolchain | rustc / cargo **1.99.1**, rustup 1.29.1, host `x86_64-pc-windows-gnu`, target `wasm32-unknown-unknown`; wasm-pack **0.15.0**; wasm-bindgen 0.2.116 and wasm-opt 117 (both fetched by wasm-pack); GNU binutils 2.47 (dlltool + as, host tests only) |
| Output | `bun run build:wasm` → `packages/restorffcut-wasm/` (what the app imports): `restorffcut_wasm_bg.wasm` **3,091,078 B** at 0.5.0 (0.4.0: 3,063,645 B; 0.3.0: 2,986,767 B in `rust/wasm/pkg/`) |
| Tests | **68 pass** on the host (0.3.0: 34; 0.4.0 adds 5 transition unit, 3 transition shader-validation, 9 transition GPU-render, 4 compositor frame tests; 0.5.0 adds 1 grade packing, 10 grade GPU-render, 2 scene-effect frame tests) |
| App status | **Not switched yet.** `apps/web` still imports the npm `opencut-wasm` 0.2.10. Switch = §8 (orchestrator, wave 2) |

## 1. Quick reference

```bash
# every shell: Rust is NOT on the system PATH (installed with --no-modify-path)
export PATH="$HOME/.cargo/bin:$PATH"
cd /c/data/code/overkill/restorff-apps/restorffcut

wasm-pack build rust/wasm --target bundler --out-dir pkg                    # build the pkg (13-22 s warm, ~2 min cold)
cargo test --no-fail-fast -p bridge -p time -p gpu -p effects -p masks -p compositor   # 34 tests
node --experimental-wasm-modules rust/wasm/scripts/smoke.mjs node_modules/opencut-wasm/opencut_wasm.js  # pkg smoke
```

Never run `cargo test` for the whole workspace without `-p`: the workspace also contains `apps/desktop` (a gpui app,
not ours, heavy native deps).

## 2. Toolchain (install from zero)

This machine has **no MSVC** (`where link.exe` finds only Git's coreutils `link.exe`) and no Visual Studio Build Tools,
so Rust uses the **GNU host**. Steps, in order:

1. **rustup + Rust + wasm target** (≈3 min, ~0.9 GB in `~/.rustup`):
   ```bash
   SP=<any scratch dir>
   curl -sSfL -o $SP/rustup-init.exe https://win.rustup.rs/x86_64
   $SP/rustup-init.exe -y --profile minimal --default-host x86_64-pc-windows-gnu --default-toolchain stable \
     --target wasm32-unknown-unknown --no-modify-path
   export PATH="$HOME/.cargo/bin:$PATH"
   rustc -Vv          # host: x86_64-pc-windows-gnu
   rustup target list --installed   # wasm32-unknown-unknown, x86_64-pc-windows-gnu
   ```
   `--no-modify-path` was deliberate (no registry change): every shell needs the `export PATH` line.
2. **wasm-pack** (prebuilt; the repo moved from `rustwasm` to `wasm-bindgen` on GitHub):
   ```bash
   curl -sSfL -o $SP/wp.tar.gz https://github.com/wasm-bindgen/wasm-pack/releases/download/v0.15.0/wasm-pack-v0.15.0-x86_64-pc-windows-msvc.tar.gz
   tar xzf $SP/wp.tar.gz -C $SP
   cp $SP/wasm-pack-v0.15.0-x86_64-pc-windows-msvc/wasm-pack.exe ~/.cargo/bin/
   wasm-pack --version   # wasm-pack 0.15.0
   ```
   The msvc build only needs `VCRUNTIME140.dll` (present in `C:\Windows\System32`). On first build wasm-pack downloads
   wasm-bindgen 0.2.116 (matching `Cargo.lock`) and wasm-opt into `%LOCALAPPDATA%\.wasm-pack` (22 MB).
3. **GNU binutils for host tests only** (the wasm build does not need this). Crates with `raw-dylib` (windows-result,
   windows-strings, libloading — pulled in by wgpu's native backends) need `dlltool` + `as` on the GNU host; see §11
   for why nothing else works.
   ```bash
   B=https://repo.msys2.org/mingw/mingw64
   mkdir -p $SP/dl ~/.cargo/binutils
   for p in mingw-w64-x86_64-binutils-2.47-4-any mingw-w64-x86_64-zlib-1.3.2-2-any mingw-w64-x86_64-zstd-1.5.7-2-any \
            mingw-w64-x86_64-libwinpthread-14.0.0.r98.g19f5121a2-1-any mingw-w64-x86_64-gettext-runtime-1.0-1-any \
            mingw-w64-x86_64-libiconv-1.19-1-any; do curl -sSfL -o $SP/dl/$p.pkg.tar.zst $B/$p.pkg.tar.zst; done
   py -m pip install --quiet --target $SP/pytools zstandard        # Python 3.13 has no zstd in the stdlib
   py -I rust/tools/extract_msys2_pkg.py "$SP/pytools" ~/.cargo/binutils \
     "bin/as.exe,bin/dlltool.exe,bin/libintl-8.dll,bin/libiconv-2.dll,bin/zlib1.dll,bin/libzstd.dll,bin/libwinpthread-1.dll" \
     $SP/dl/*.pkg.tar.zst                                            # prints 7 lines
   ~/.cargo/binutils/as.exe --version        # GNU assembler (GNU Binutils) 2.47.20260726
   ```
   (Package file names change when MSYS2 updates; list current ones with
   `curl -sSL https://repo.msys2.org/mingw/mingw64/ | grep -oE 'mingw-w64-x86_64-binutils-[0-9][^"]*\.pkg\.tar\.zst'`.)
   Then `~/.cargo/config.toml` (user-level, affects only the host target):
   ```toml
   [target.x86_64-pc-windows-gnu]
   rustflags = ["-C", "dlltool=C:/Users/assassin/.cargo/binutils/dlltool.exe"]
   ```
   The file on this machine carries a comment block with the reasons.
4. **Verify**: `cargo test -p time` (10 pass) proves the GNU host links proc-macros; the full §4 command proves the
   wgpu native backends link and start.

Disk after setup (2026-10-20): `~/.cargo` 1.4 GB (registry + binaries), `~/.rustup` 938 MB, repo `target/` 3.8 GB
(debug host + release wasm), `%LOCALAPPDATA%\.wasm-pack` 22 MB. `rm -rf target` is safe (next build is ~2 min cold).

## 3. Build

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd /c/data/code/overkill/restorff-apps/restorffcut
wasm-pack build rust/wasm --target bundler --out-dir pkg
```
- Output (`rust/wasm/pkg/`, generated, never edit): `restorffcut_wasm.js` (742 B entry), `restorffcut_wasm_bg.js`
  (109,413 B glue), `restorffcut_wasm_bg.wasm` (2,986,767 B), `restorffcut_wasm.d.ts` (4,427 B),
  `restorffcut_wasm_bg.wasm.d.ts`, `package.json` (`"name": "restorffcut-wasm"`, `"version": "0.3.0"`), `README.md`,
  `LICENSE` (MIT, copied from `rust/wasm/LICENSE` = root `LICENSE`), and a `.gitignore` containing `*`.
- `--out-dir` is relative to `rust/wasm` (verified: `--out-dir ../../target/x` lands in `restorffcut/target/x`).
- The build is reproducible: two builds produced byte-identical `.wasm`
  (sha256 `0b20eaf4d03973b66365517f6f1240ed352d31500a72da6c2be558074acfcf90` for this source).
- Success line: `[INFO]: :-) Done in 12.95s` (warm). Cold first build: 2 min 04 s.

## 4. Test (host)

```bash
cargo test --no-fail-fast -p bridge -p time -p gpu -p effects -p masks -p compositor
```
| Suite | Tests | Covers |
|---|---|---|
| `bridge` unit | 1 | upstream: `#[export]` name conversion |
| `time` unit | 10 | upstream: media time, frame rates, timecodes |
| `effects` unit (`src/uniforms.rs`) | 9 | buffer layout = WGSL (96 B, offsets 0/8/16/32); gaussian blur packs byte-identical to upstream and keeps upstream errors; packing + defaults for the 3 new effects; wrong shapes rejected; registry self-check |
| `effects` `tests/shader_validation.rs` | 5 | every shader parses + validates in naga and **translates to GLSL ES 3.00 (WebGL2)**; uniform struct sizes; bind groups (0,0)(0,1)(1,0); Restorff shaders use only `textureSampleLevel`; fullscreen vertex shader |
| `effects` `tests/gpu_render.rs` | 9 | renders 64x64 test images on the **real host GPU** (RTX 3060 via Vulkan here) and checks pixels: blur unchanged; zoom identity / punch-in / focal fixed / smear / chroma order; vertigo identity / centre kept / edge magnified / monotonic row; glass outside untouched incl. rounded corner / frost / lift / border |
| `gpu`, `masks`, `compositor` | 0 | upstream has none |

Total: **34 passed, 0 failed** (sum of the `test result` lines). Without a GPU adapter the 9 render tests print
`skipping GPU render test` and pass; run `cargo test -p effects --test gpu_render -- --nocapture` to see the adapter.
A mutation check (Vertigo's gain set to 0) made `vertigo_keeps_the_centre_and_magnifies_the_surroundings` fail, so the
render tests do bite.

## 5. Smoke-test the built pkg (Node, no GPU)

```bash
node --experimental-wasm-modules rust/wasm/scripts/smoke.mjs node_modules/opencut-wasm/opencut_wasm.js
```
Loads `rust/wasm/pkg` and (optional argument) a reference build, compares 6 pure exports (time / timecode) value by
value, checks `listEffectShaders()` and that no reference export is missing. Last line `SMOKE PASS`, exit 0. GPU
exports need a browser; §4's render tests cover the shaders instead.

## 6. Restorff effects (new in 0.3.0)

All three are single-pass fragment shaders in `rust/crates/effects/src/shaders/`, registered in
`rust/crates/effects/src/shaders.rs`, and run by the existing `applyEffectPasses` / compositor path — no new wasm
function is needed to use them. Every TS param is a number (or colour), so each is **keyframable** through the generic
path `effects.<effectId>.params.<key>` (`apps/web/src/animation/effect-param-channel.ts`); Rust only sees the
resolved uniforms per frame. Ready-to-copy TS definitions: `rust/web-effects/*.ts` (type-checked against the real
`apps/web` types, see §8 step 7). Reference: BUILD-BRIEF §4 reel `Def9pj5TWtA` ("Digital Zoom", "Vertigo", "Glass
Type"); `docs/restorff/EFFECTS.md` did not exist yet when these were written — reconcile names/params when it lands.

### Digital Zoom — shader `restorff-digital-zoom`, TS type `restorff-digital-zoom`
Punch-in toward a focal point; the focal point stays fixed and the sampled point never leaves the frame. Optional
radial smear (16 taps toward the focal point) and a red-out / blue-in chromatic split that grows toward the edges.
| Uniform | Kind | Default | Meaning | TS param (UI range) → uniform |
|---|---|---|---|---|
| `u_focal` | vec2 | 0.5, 0.5 | focal point, 0..1 frame fractions, top-left origin | `focusX`, `focusY` (0..100 %) / 100 |
| `u_zoom` | number | 1 | scale factor (≥ 1) | `amount` (0..300 %): 1 + amount/100 (100 = 2x) |
| `u_blur` | number | 0 | smear length 0..1 (1 = 25 % of the distance to the focal point) | `blur` (0..100) / 100 |
| `u_chroma` | number | 0 | split 0..1 (1 = ±3 % radial scale on red/blue) | `chroma` (0..100) / 100 |
Cost per pixel: 3 texture reads (blur 0) or 48 (blur > 0). Keyframe `amount` 0 → 100 over ~4 frames with `blur` up
during the move for the reel's punch-in.

### Vertigo — shader `restorff-vertigo`, TS type `restorff-vertigo`
Dolly-zoom illusion without a subject mask: inside the radius the frame is untouched; outside, the sampling rate falls
smoothly from 1 to 1/S over the feather band (S = 1 + 2·strength). The sampled distance is the analytic integral of
that rate, so the warp is continuous and monotonic (no seam, no ghosting, no fold-over — the render test checks the
row is monotonic) and never samples outside the frame.
| Uniform | Kind | Default | Meaning | TS param → uniform |
|---|---|---|---|---|
| `u_center` | vec2 | 0.5, 0.5 | subject centre, 0..1 | `centerX`, `centerY` (0..100) / 100 |
| `u_radius` | number | 0.25 | subject radius, fraction of the frame's short side | `radius` (0..100) / 100, default 25 |
| `u_strength` | number | 0 | 0..1 → background magnification 1x..3x | `strength` (0..100) / 100, default 50 |
| `u_feather` | number | 0.15 | transition band width, fraction of short side | `feather` (0..100) / 100, default 15 |
Cost: 1 texture read per pixel. Keyframe `strength` 0 → 100 (push) or 100 → 0 (pull) across the shot.

### Glass Type — shader `restorff-glass-panel`, TS type `restorff-glass-type`
Frosted-glass rounded panel meant to sit **behind text**: put the effect on an effect layer (scene effect) or on the
clip, on a track below the text. Blur = single-pass 48-tap Vogel disk with per-pixel rotation (reads as fine grain,
no second pass); then brightness lift toward white, tint mix, soft inner border. Pixels outside the rounded rect pass
through untouched (only 1 texture read there).
| Uniform | Kind | Default | Meaning | TS param → uniform |
|---|---|---|---|---|
| `u_rect` | vec4 | 0.1, 0.62, 0.8, 0.22 | x, y, w, h in 0..1 frame fractions | `x`,`y`,`width`,`height` (0..100 %) / 100 |
| `u_corner_radius` | number | 24 | px | `cornerRadius` (px at a 1080 px short side) × short/1080 |
| `u_blur` | number | 24 | frost radius px | `blur` "Frost" × short/1080 |
| `u_brightness` | number | 0.12 | lift 0..1 | `brightness` (0..100) / 100 |
| `u_border_width` | number | 1.5 | px | `borderWidth` (0..20) × short/1080 |
| `u_tint` | vec4 | 1,1,1,0.06 | sRGB r,g,b + strength | `tint` (colour param, converted with culori to sRGB 0..1) + `tintStrength`/100 |
| `u_border_opacity` | number | 0.35 | 0..1 | `borderOpacity` (0..100) / 100 |
| `u_softness` | number | 1 | edge anti-alias px | not a param: max(0.5, short/1080) |
Cost: 49 texture reads per pixel inside the panel, 1 outside. The text itself is a normal text element above it.

## 6b. Transitions (new in 0.4.0, media agent)

Two-input fragment shaders in `rust/crates/effects/src/shaders/transitions/*.wgsl`, registry + packing + pipeline in
`rust/crates/effects/src/transitions.rs` (`TRANSITION_SHADERS`, `TransitionPipeline`). Contract: group 0 = outgoing
frame + sampler, group 1 = incoming frame + sampler, group 2 = `TransitionUniforms` (48 B: resolution, progress, padding,
params0, params1 = 8 floats in `UniformSlot::Param(0..8)`); `fragment_main`; only `textureSampleLevel`; **progress 0
returns the outgoing frame exactly and progress 1 the incoming frame exactly** (`tests/transition_render.rs` checks all
ten). Ids: `restorff-transition-{dissolve,dip,flash,whip,slide,zoom,wipe,iris,glitch,blur}`.

The compositor (`rust/crates/compositor`) takes a frame item `{ "type": "transition", "shader", "progress",
"uniforms", "from": [layers], "to": [layers] }`: each side is composited over a copy of the scene so far, the shader
mixes the two, the mix replaces the scene (so letterbox bars show what is underneath, as without a transition).
`tests/transition_frame.rs` parses the TS JSON and renders it on the host GPU. TS side:
`apps/web/src/transitions/` (registry of 24 named transitions over the 10 shaders, placement, panel) and
`apps/web/src/services/renderer/{scene-builder,resolve}.ts` + `compositor/frame-descriptor.ts` (TransitionNode).

Add one: write the WGSL (copy `dissolve.wgsl`), add a `TransitionShaderSpec` to `TRANSITION_SHADERS`, bump the count in
`registry_is_consistent`, add the id to `rust/wasm/scripts/smoke.mjs`, run §4, `bun run build:wasm`, then add a
definition in `apps/web/src/transitions/definitions.ts` and its id in `packages/timeline-ops/src/transitions.ts`.

## 6c. Grade (new in 0.5.0, grade agent)

One-pass colour grade, shader `restorff-grade` (`rust/crates/effects/src/shaders/grade.wgsl`), TS type
`restorff-grade` (`apps/web/src/effects/definitions/grade.ts`). The sliders, their ranges, the named looks, the
nudges and the slider → uniform maths live in **one** place both the reducer and the app import:
`packages/timeline-ops/src/grades.ts`. Every slider is a number, so every slider is keyframable
(`effects.<id>.params.<key>`). Input/output: straight-alpha, sRGB-encoded (the compositor's convention); alpha passes
through. Every default is the identity (the GPU test checks it to ±1).

Order of operations: white balance (temperature, tint) and exposure in **linear** light with luminance-normalised gains
→ lift / gamma / gain (display space) → contrast as `x^k / (x^k + (1−x)^k)` (an S-curve that keeps 0 and 1, never
clips) → saturation around Rec.709 luma → split toning (a hue into the shadows, another into the highlights, chroma
only) → vignette (follows the frame shape) → grain (soft 2 px value-noise clumps at a 1080 px short side, seeded by
time, strongest in the midtones) → amount (mix with the untouched pixel).

| Uniform | Slot | Default | TS slider (UI range) → uniform |
|---|---|---|---|
| `u_exposure` | params0.x | 0 | `exposure` (−3…3 stops) as is |
| `u_contrast` | params0.y | 0 | `contrast` (−100…100) / 100; k = 2^(1.5·c) |
| `u_saturation` | params0.z | 1 | 1 + `saturation` (−100…100) / 100 |
| `u_temperature` | params0.w | 0 | `temperature` / 100 (r gain 1 + 0.3 t, b gain 1 − 0.3 t, normalised) |
| `u_tint` | params1.x | 0 | `tint` / 100 (+ = magenta: g gain 1 − 0.25 t) |
| `u_lift` | params1.y | 0 | `shadows` / 100 × 0.25 |
| `u_gamma` | params1.z | 1 | 2^(`midtones` / 100) |
| `u_gain` | params1.w | 1 | 1 + `highlights` / 100 × 0.5 |
| `u_vignette` | params2.x | 0 | `vignette` / 100 (+ darker edges, − lighter) |
| `u_grain` | params2.y | 0 | `grain` (0…100) / 100 |
| `u_grain_seed` | params2.z | 0 | the frame time in seconds (`resolveEffectPasses({ time })`) |
| `u_amount` | params2.w | 1 | `amount` (0…100) / 100 |
| `u_split` | params3 (vec4) | 0,0,0,0 | `shadowHue`/360, `shadowTint`/100, `highlightHue`/360, `highlightTint`/100 |

Cost: 1 texture read + 21 integer PCG hashes per pixel (grain: 4 cells × 5 + the seed), 3 `pow`s per channel. Looks (`GRADE_LOOKS`): warm morning, moody, clean, film, cool night,
punchy, paper, black and white; nudges (`GRADE_NUDGES`): warmer, cooler, brighter, darker, more/less contrast,
more/less colour, more grain. In a project a grade is an ordinary effect: on a clip (`effects`), or on a `GRADE`
effect track placed just above the topmost footage track (an adjustment layer: grades everything below it, never the
captions or text above). ops@1 `grade` writes both (`packages/timeline-ops/README.md`).

**Effect layers were broken upstream (fixed in 0.5.0).** `FrameItemDescriptor::SceneEffect` had
`#[serde(rename_all = "camelCase")]` on the enum, which renames the variant tags but not the fields of a struct
variant: Rust expected `effect_pass_groups`, TypeScript sends `effectPassGroups`, so every frame with an effect layer
failed ("Invalid frame descriptor: missing field `effect_pass_groups`") — any shader dropped from the Effects panel
too (it inserts an effect layer). Fixed with a field-level `rename` (+ the snake_case spelling as an alias);
`rust/crates/compositor/tests/scene_effect_frame.rs` parses both and renders a grade layer between two layers.

Verify (all run 2026-10-20):
```bash
export PATH="$HOME/.cargo/bin:$PATH"; cd /c/data/code/overkill/restorff-apps/restorffcut
cargo test --no-fail-fast -p effects --test grade_render      # 10 passed (identity, exposure stops, Rec.709 grey,
                                                              # white balance keeps luminance, lift/gamma/gain anchors,
                                                              # S-curve monotonic + unclipped, vignette, grain
                                                              # deterministic per seed, amount 0 + alpha, CPU reference)
cargo test -p compositor --test scene_effect_frame            # 2 passed
bun run build:wasm && node --experimental-wasm-modules rust/wasm/scripts/smoke.mjs   # SMOKE PASS (checks grade defaults)
```
A mutation (`SPLIT_RANGE` 0.3 → 0.33) made the CPU-reference test fail once it included a "pushed hard" look.
Measured on real footage (headless render, worklog `grade.md`): moody drops mean luma 30 %; warm morning moves U/V
toward orange; black and white gives U = V = 128.

## 7. Add an effect (step by step)

1. **Write the shader** `rust/crates/effects/src/shaders/<name>.wgsl`: copy the `VertexOutput`, `EffectUniforms`
   (all 7 fields, 96 bytes) and the three `@group/@binding` lines from `vertigo.wgsl`; write
   `@fragment fn fragment_main(input: VertexOutput) -> @location(0) vec4f`. Sample **only** with
   `textureSampleLevel(input_texture, input_sampler, uv, 0.0)` (see §11 "uniformity"). Read your values from
   `uniforms.params0..params3` (16 floats); `uniforms.resolution` is the pass size in px. Document the packing in a
   header comment.
2. **Register it** in `rust/crates/effects/src/shaders.rs`: a `pub const <NAME>_SHADER_ID: &str = "restorff-<name>";`,
   a `const <NAME>_UNIFORMS: &[UniformSpec]` (name `u_*`, kind `Number`/`Vec2`/`Vec4`, slot `UniformSlot::Param(i)`,
   default `Some(&[..])`), and an `EffectShaderSpec` entry in `EFFECT_SHADERS`. A vector must not straddle a vec4
   boundary (`i % 4 + len <= 4`) and floats must not overlap — the registry test enforces both.
3. **Export the id** from `rust/crates/effects/src/effects.rs` (`pub use shaders::{.., <NAME>_SHADER_ID}`) if Rust
   code needs it. Nothing to add in `rust/wasm`: `applyEffectPasses`, `renderFrame` and `listEffectShaders` are
   registry-driven.
4. **Tests**: add a packing test in `src/uniforms.rs` (`pack(<ID>, &[...])` → expected `params`), and a render test in
   `tests/gpu_render.rs` (identity at neutral params + one property check). Update the count in
   `builtin_registry_is_consistent` (`EFFECT_SHADERS.len()`) and the id list in `rust/wasm/scripts/smoke.mjs`.
5. **Run** §4 (all pass) → §3 → §5.
6. **TS definition**: add `rust/web-effects/<name>.ts` (copy `vertigo.ts`; params are what the user keyframes;
   `uniforms()` converts them; px values scale with `Math.min(width, height) / 1080`). Type-check it (§8 step 7).
   After the switch, it goes into `apps/web/src/effects/definitions/` and `definitions/index.ts`.
7. Write it up in §6 of this file and in `docs/restorff/worklog/rust.md`.

## 8. Switching the app to the local build (orchestrator, wave 2)

Not done by the rust agent (it may not edit `apps/web`, `packages/**`, root `package.json` or `bun.lock`), so **these
steps have not been run** except where a step says "verified". The pkg is API-compatible (§9), so the switch is a
rename plus a dependency change. **Recommended: option A**, because it keeps
B1's "builds with bun alone" (nobody without Rust is blocked).

**Option A — committed build output as a workspace package** (root `workspaces` already has `packages/*`):
1. Build into the workspace and drop wasm-pack's ignore-everything file:
   ```bash
   export PATH="$HOME/.cargo/bin:$PATH"
   wasm-pack build rust/wasm --target bundler --out-dir ../../packages/restorffcut-wasm
   rm packages/restorffcut-wasm/.gitignore
   ```
   (The same command into `../../target/x` was verified; `packages/` itself was not written by the rust agent.)
2. Root `package.json`: remove `"opencut-wasm": "^0.2.10"` from `dependencies`; set
   `"build:wasm": "wasm-pack build rust/wasm --target bundler --out-dir ../../packages/restorffcut-wasm && rm -f packages/restorffcut-wasm/.gitignore"`;
   point `dev:wasm` at the same out-dir; **delete `publish:wasm`** (it runs `npm publish` — outward-facing, BUILD-BRIEF
   B6 / §6 rule 9).
3. `apps/web/package.json`: replace `"opencut-wasm": "^0.2.10"` with `"restorffcut-wasm": "workspace:*"`.
4. Rename imports (the list changes as agents work — always grep, never trust a count):
   ```bash
   grep -rl "opencut-wasm" apps/web/src packages/*/src | xargs sed -i 's/opencut-wasm/restorffcut-wasm/g'
   grep -rn "opencut-wasm" apps/web/src packages/*/src     # must print nothing
   ```
   As of 2026-10-20 ~04:00 that matches **26 files in `apps/web/src`** (the brief's 27 included
   `preview/components/toolbar.tsx`, which now imports from `@/wasm` instead) **+ `packages/timeline-ops/src/time.ts`**:
   `app/projects/page.tsx`, `commands/media/add-media-asset.ts`, `components/editable-timecode.tsx`,
   `core/managers/project-manager.ts` (also a type-only `import("opencut-wasm").FrameRate`),
   `core/managers/renderer-manager.ts`, `export/index.ts`, `fps/defaults.ts`, `fps/utils.ts`,
   `project/components/project-info-dialog.tsx`, `project/types.ts`, `services/renderer/canvas-renderer.ts`,
   `services/renderer/compositor/wasm-compositor.ts`, `services/renderer/gpu-renderer.ts`,
   `services/renderer/scene-exporter.ts`, `timeline/bookmarks/utils.ts`, `timeline/components/timeline-ruler.tsx`,
   `timeline/components/timeline-tick.tsx`, `timeline/controllers/{drag-drop,element-interaction,keyframe-drag,playhead,resize,seek}-controller.ts`,
   `timeline/group-resize/types.ts`, `timeline/ruler-utils.ts`, `wasm/media-time.ts` (a doc comment).
5. `bun install` (rewrites `bun.lock`), then `rm -rf apps/web/.next` before the next `bun run dev` (Turbopack caches
   the old module).
6. Lint scope: `biome.json` `files.includes` is `"**"` with vcs disabled — add `"!**/rust/wasm/pkg"` and
   `"!**/packages/restorffcut-wasm"` so generated JS is not linted. (Biome is not installed in this checkout today.)
7. **Effects**: `cp rust/web-effects/*.ts apps/web/src/effects/definitions/` and register them in
   `apps/web/src/effects/definitions/index.ts`:
   ```ts
   import { digitalZoomEffectDefinition } from "./digital-zoom";
   import { glassTypeEffectDefinition } from "./glass-type";
   import { vertigoEffectDefinition } from "./vertigo";

   const defaultEffects = [
   	blurEffectDefinition,
   	digitalZoomEffectDefinition,
   	vertigoEffectDefinition,
   	glassTypeEffectDefinition,
   ];
   ```
   They were type-checked in place with `node_modules/.bin/tsc -p <scratch>/tsconfig.json` (TypeScript 6.0.3, exit 0)
   using: `strict`, `moduleResolution: "bundler"`, `paths: {"@/*": ["<repo>/apps/web/src/*"]}`, `files: [the 3]`
   (`baseUrl` is deprecated in TS 6 — leave it out). Run the app's own formatter on them after copying (lines > 80).
8. **Verify** in the browser at http://localhost:8791 (skin agent's server): the Effects tab lists Blur, Digital
   Zoom, Vertigo, Glass Type with live 160 px previews; add Digital Zoom to a clip, keyframe Amount 0 → 100, scrub;
   export a 3 s clip. In DevTools: `(await import("restorffcut-wasm")).listEffectShaders().map(s => s.id)` lists 4 ids.
   (Not yet done — needs the switch.)

**Option B — file dependency** (simpler, but every machine that runs `bun install` needs Rust + a built pkg, and
`rust/wasm/pkg` is gitignored): steps 2–8 of option A with `"restorffcut-wasm": "file:../../rust/wasm/pkg"` in
`apps/web/package.json` and the default `--out-dir pkg`. Not verified.

## 9. API diff vs npm `opencut-wasm` 0.2.10

Method: `diff` of `node_modules/opencut-wasm/opencut_wasm.d.ts` (names normalised `opencut_wasm` → `restorffcut_wasm`)
against `rust/wasm/pkg/restorffcut_wasm.d.ts`, same for the entry `.js` export list, plus the smoke test's export check.
- **Baseline** (untouched source built here, before any change): `.d.ts` and entry `.js` byte-identical to npm 0.2.10;
  `package.json` differs only by a trailing newline. So the npm package is exactly this source.
- **0.3.0**: all 28 upstream exports present with identical signatures (`TICKS_PER_SECOND`, `applyEffectPasses`,
  `applyMaskFeather`, `floorToFrame`, `formatTimecode`, `getCompositorCanvas`, `getLastFrameProfile`,
  `guessTimecodeFormat`, `initCompositor`, `initializeGpu`, `isFrameAligned`, `lastFrameTime`, `mediaTimeAdd`,
  `mediaTimeClamp`, `mediaTimeFromFrame`, `mediaTimeFromSeconds`, `mediaTimeMax`, `mediaTimeMin`, `mediaTimeSub`,
  `mediaTimeToFrame`, `mediaTimeToSeconds`, `parseTimecode`, `releaseTexture`, `renderFrame`, `resizeCompositor`,
  `roundToFrame`, `snappedSeekTime`, `uploadTexture`). **Added only**: `listEffectShaders(): EffectShaderInfo[]` and
  the interfaces `EffectShaderInfo { id; uniforms }`, `EffectUniformInfo { name; kind; defaultValue? }`.
- Behaviour change (internal): an unknown shader id now fails with `Unknown effect shader '<id>'` instead of
  `Missing uniform 'u_sigma' ...` (the registry is consulted before packing). Gaussian blur uniforms pack byte-identically.
- Files renamed: `opencut_wasm*.{js,d.ts,wasm}` → `restorffcut_wasm*`; the app imports the package name only, so no
  app code references these file names.

## 10. Sizes

| Build | `_bg.wasm` | gzip -9 |
|---|---|---|
| npm `opencut-wasm` 0.2.10 | 3,037,899 B | 1,104,724 B |
| upstream source built here (wasm-bindgen 0.2.116, wasm-opt 117) | 2,946,011 B | — |
| `restorffcut-wasm` 0.3.0 (3 effects + `listEffectShaders`) | 2,986,767 B | 1,096,192 B |
The three effects cost +40,756 B (+1.4 %) over the same toolchain's upstream build.

## 11. Known failures and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `error calling dlltool 'dlltool.exe': program not found` (compiling windows-result, windows-strings, libloading) | `raw-dylib` on `*-windows-gnu` needs dlltool; rustc only searches PATH | §2 step 3 (binutils + `~/.cargo/config.toml`) |
| `dlltool.exe: CreateProcess` | rust-mingw's own GNU dlltool (`lib/rustlib/x86_64-pc-windows-gnu/bin/self-contained/dlltool.exe`) has no `as.exe` beside it | use the MSYS2 binutils pair (§2 step 3) |
| Host test binaries exit `0xc0000005 STATUS_ACCESS_VIOLATION` before `main` (even with 0 tests) | dlltool was LLVM's (`llvm-ar.exe` renamed): any binary linking a wgpu native backend (dx12, vulkan or gles — bisected) crashes at load; linking with rust-lld did not help; a windows-sys-only probe was fine. Not root-caused | use GNU dlltool (§2 step 3); do not reintroduce llvm-dlltool |
| `cargo`/`wasm-pack`: command not found | Rust installed with `--no-modify-path` | `export PATH="$HOME/.cargo/bin:$PATH"` |
| `rust/wasm/pkg` appears untracked-but-ignored / missing from a commit | wasm-pack writes `pkg/.gitignore` = `*` | intended for `pkg/`; for option A delete it after each build (§8) |
| A shader works in tests but breaks Chrome's WebGPU path | naga does **not** enforce WGSL uniformity in fragment shaders (`DISABLE_UNIFORMITY_REQ_FOR_FRAGMENT_STAGE = true` in naga 29 `src/valid/analyzer.rs`), Tint does | only `textureSampleLevel`; the test `restorff_shaders_only_use_explicit_level_sampling` enforces it |
| A WGSL error takes down **all** GPU rendering | `EffectPipeline::new` compiles every registered shader inside `initializeGpu()`; a bad module panics there | `tests/shader_validation.rs` (naga + GLSL ES 3.00) must pass before any wasm build ships |
| `tsc` error TS5101 `baseUrl is deprecated` | TypeScript 6 | use absolute `paths` without `baseUrl` |

## 12. Learnings (rules, each from an incident on 2026-10-20)
1. **On a GNU Rust host, install GNU binutils' dlltool + as before testing anything that links wgpu.** Incident: 25 min
   lost to the llvm-dlltool route, which compiles but yields binaries that crash before main.
2. **Bisect native crashes with a throwaway crate in the scratchpad, by feature flag, before reading linker internals.**
   Incident: the dx12/vulkan/gles bisect found the scope in one 5-minute run.
3. **Never trust naga's validator for browser rules; encode them as tests.** Incident: a negative test expecting naga
   to reject non-uniform `textureSample` failed — naga disables that check for fragment shaders.
4. **Counts of importers drift while other agents work; switch steps use a grep, not a list.** Incident: the brief's
   27 files were 26 (+1 in `packages/timeline-ops`) two hours later.

## 13. For the orchestrator (files the rust agent may not edit)
- **CHANGELOG entry** to paste into `restorffcut/CHANGELOG.md` (the doctor FAILs until it exists: "code changed after
  the last CHANGELOG entry"):
  ```
  ## 0.0.3 — 2026-10-20
  - Rust engine builds from source on this machine (Rust 1.99.1 GNU host, wasm-pack 0.15.0) as `restorffcut-wasm`
    0.3.0 (was the prebuilt npm `opencut-wasm` 0.2.10; API identical plus `listEffectShaders`). Three new keyframable
    GPU effects: Digital Zoom, Vertigo, Glass Type (shaders + ready TS definitions in rust/web-effects/). 34 host tests
    incl. real-GPU render checks. App not switched yet: docs/restorff/RUST.md §8.
  ```
- **Next** (for the CHANGELOG "Next" list / STATUS): do the §8 switch and its browser check; reconcile with
  `docs/restorff/EFFECTS.md` when it lands (names, params, the other 14 effects); add the remaining reel effects as
  shaders (Zoom Through Cut, Pullback Reveal, Frame Break are single-pass candidates); a WebGL2-in-browser render test
  (headless Chromium) for the shaders; profile the glass and smear tap counts at 1080x1920 on an integrated GPU.
- Root `package.json` still has `publish:wasm` (`npm publish`) — remove it with the switch.
