# third_party/uisfx — CC0 UI cues

| | |
|---|---|
| Upstream | https://github.com/romainsimon/uisfx (code MIT `LICENSE`; audio CC0-1.0 `LICENSE-AUDIO`, both copied unchanged from `packages/uisfx/` and the repo root) |
| Commit | `9950fe66f993a6660dab9c2651dcbcd899ffd83b` (HEAD on 2026-10-24, committed 2026-09-08) |
| Taken by | scout agent, 2026-10-24 (`docs/restorff/SCOUT-2026-10-24.md` §3.9) |
| Output | `apps/web/public/sfx/cc0/` — 28 WAVs (48 kHz mono 16-bit, ≤ −1 dBTP) + `manifest.json` (pack `uisfx-cinematic-cc0`, schema `restorff-sfx-pack@1`, the core pack's fields + `source`), 2,383,386 bytes |

## What was taken
Audio only (no uisfx code): 28 cues of the `cinematic` personality — success, complete, error, warning, notification,
send, receive, mention, level-up, achievement, reward, streak, badge, purchase, add-to-cart, checkout, coupon, unlock,
lock, toggle-on, toggle-off, swipe, open, close, expand, snap, drop, copy. Picked because the core pack
(`apps/web/public/sfx/manifest.json`, 27 synthesized sounds) has no sound for these on-screen UI events. Ids are
`ui-<cue>`. **Not auditioned** (scout cannot listen): the personality was chosen by name; waveforms were looked at
(28 non-silent chime-like cues, none clipped).

## Rebuild
From `restorffcut/`: `bun third_party/uisfx/build-cc0-pack.ts` (ffmpeg on PATH). Downloads the 28 `.ogg` files from
raw.githubusercontent.com at the pinned commit into `%TEMP%\restorffcut-scout\uisfx-cache\` (no account), then
gain → WAV → measure → manifest. Ends with `PASS: every file <= -1 dBTP, pack < 3 MB` (MEASURED 2026-10-24: 28 sounds,
2.27 MB, 24.81 s). To use another personality, change `PERSONALITY` (arcade, dreamy, glass, mechanical, minimal,
organic, rubber, scifi, soft, studio, zen).

## Not wired yet (sounds owner)
Nothing reads `public/sfx/cc0/manifest.json` today: `apps/web/src/sounds/library.ts` loads only `/sfx/manifest.json`,
and `apps/web/src/server/sound-design-plan.ts` `CUE_SOUNDS` maps cue kinds to core ids. To use it: load both
manifests (same schema), and map cue kinds such as `success`, `check`, `done`, `send`, `notification`, `purchase` to
`ui-*` ids. `apps/web/src/sounds/pack/build-pack.ts` only deletes stale `.wav` files at the top level of `public/sfx`,
so it never touches `cc0/`.
