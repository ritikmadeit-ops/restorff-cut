// @restorffcut/compositions — public API. See README.md (runbook) and CONTRACT.md (how to write a composition).
export { render, renderStill, prepare, RENDERER_VERSION, PKG_ROOT, RUNTIME_PATH, FONTS_DIR } from "./render.ts";
export { parseManifest, validateManifest, resolveParams, validateValue, coerceSet, lintComposition, extractParamsBlock } from "./params.ts";
export { nudge, COLOR_NAMES } from "./edits.ts";
export { listLibrary, LIBRARY_DIR, SAMPLES_DIR } from "./library.ts";
export { probe, frameMd5, alphaStats, contactSheet, encoderArgs } from "./ffmpeg.ts";
export { Browser, findChrome } from "./cdp.ts";
export * from "./types.ts";
export {
  validateCustom,
  customHash,
  prepareCustom,
  renderCustom,
  renderCustomCached,
  nudgeCustom,
  customKit,
  listCustomExamples,
  blockNetwork,
  openCustomPage,
  CustomInvalidError,
  CUSTOM_CONTRACT,
  CUSTOM_MAX_BYTES,
  CUSTOM_MAX_SECONDS,
  NO_NETWORK_FLAGS,
} from "./custom.ts";
export type { CustomValidation, CustomRequest, CustomRenderAnswer, CustomRenderResult, CustomExample } from "./custom.ts";
