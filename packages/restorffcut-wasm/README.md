# restorffcut-wasm

RestorffCut's per-frame engine (compositor, effects, masks, media time) compiled to WebAssembly. Used by the
RestorffCut web app (`apps/web`). MIT; upstream credits are in `LICENSE` and the repo's `NOTICE`.

## Build

From the repo root (toolchain setup and every known failure: `docs/restorff/RUST.md`):

```bash
export PATH="$HOME/.cargo/bin:$PATH"
wasm-pack build rust/wasm --target bundler --out-dir pkg
```

Output: `rust/wasm/pkg/` (`restorffcut_wasm.js`, `restorffcut_wasm_bg.wasm`, `restorffcut_wasm.d.ts`, `package.json`
named `restorffcut-wasm`). This folder is generated; do not edit it.

## Usage

```ts
import { formatTimecode, listEffectShaders, mediaTimeFromSeconds } from "restorffcut-wasm";

const ticks = mediaTimeFromSeconds({ seconds: 1.5 });
const label = formatTimecode({ time: ticks });
const shaders = listEffectShaders(); // [{ id: "gaussian-blur", uniforms: [...] }, { id: "restorff-digital-zoom", ... }]
```

All exports are typed in the generated `restorffcut_wasm.d.ts`.

## Source

Functions are implemented in Rust under [`rust/crates/`](../crates/). Effects (shader ids, uniforms, WGSL) are
registered in `rust/crates/effects/src/shaders.rs`.

## Using the local build in apps/web

See `docs/restorff/RUST.md`, section "Switching the app to the local build".
