// @restorffcut/compositions — the composition contract as types. Prose version: ../CONTRACT.md.

/** Easing presets every composition can name in an `easing` param. Implemented in runtime.js (EASE). */
export const EASINGS = [
  "linear",
  "smooth", // in-out cubic: calm, symmetric
  "gentle", // out-sine: soft landing
  "snappy", // out-expo: fast start, hard settle
  "bouncy", // out-back: overshoots once
  "springy", // damped spring: overshoots, settles in ~2 wobbles
  "elastic", // out-elastic: rubber band
  "bounce", // out-bounce: ball drop
  "ease-in", // in-cubic: for exits
] as const;
export type EasingName = (typeof EASINGS)[number];

/** Font families bundled in ../fonts (OFL). Always loaded before frame 0. */
export const FONTS = ["Archivo", "JetBrains Mono", "Instrument Serif"] as const;
export type FontName = (typeof FONTS)[number];

export type ParamType =
  | "string"
  | "text"
  | "number"
  | "color"
  | "boolean"
  | "enum"
  | "easing"
  | "font"
  | "image"
  | "list"
  | "object";

interface ParamBase<T> {
  type: ParamType;
  /** Short human label ("Accent colour"). */
  label?: string;
  /** What the slot MEANS, written for Claude ("the word the viewer must remember"), not where it sits. */
  description?: string;
  /** Required on top-level params; optional inside list items / object fields. */
  default?: T;
  /**
   * On-screen words or data. Inferred for `string`/`text` params and lists/objects that hold them; set `false` for a
   * string that is never shown, `true` for a number that is (a count the viewer reads). Its `default` is EXAMPLE copy:
   * only the gallery sample uses it. An applied render (service `render`) gets "" / [] instead, or answers
   * `needs: [key]` when the param is `required` (CONTRACT.md §2c). Top-level params only.
   */
  display?: boolean;
  /** A display param an applied render cannot do without: missing → `needs: [key]` (lists with minItems > 0 always are). */
  required?: boolean;
  /** `required` only while this other param is blank (float-thumbs: cards are needed unless images are sent). */
  requiredUnless?: string;
}
export interface StringParam extends ParamBase<string> {
  type: "string" | "text";
  maxLength?: number;
}
export interface NumberParam extends ParamBase<number> {
  type: "number";
  min?: number;
  max?: number;
  step?: number;
  /** Display unit only: "s", "px", "x", "%". */
  unit?: string;
}
export interface ColorParam extends ParamBase<string> {
  type: "color";
}
export interface BooleanParam extends ParamBase<boolean> {
  type: "boolean";
}
export interface EnumParam extends ParamBase<string> {
  type: "enum";
  options: string[];
}
export interface EasingParam extends ParamBase<EasingName> {
  type: "easing";
}
export interface FontParam extends ParamBase<FontName> {
  type: "font";
}
/** Path relative to the props file (or the composition file), an absolute path, or a data:/http(s): URL. */
export interface ImageParam extends ParamBase<string> {
  type: "image";
}
export interface ListParam extends ParamBase<unknown[]> {
  type: "list";
  of: ParamSpec;
  minItems?: number;
  maxItems?: number;
}
export interface ObjectParam extends ParamBase<Record<string, unknown>> {
  type: "object";
  fields: Record<string, ParamSpec>;
}
export type ParamSpec =
  | StringParam
  | NumberParam
  | ColorParam
  | BooleanParam
  | EnumParam
  | EasingParam
  | FontParam
  | ImageParam
  | ListParam
  | ObjectParam;

export type ParamValues = Record<string, unknown>;

/** The JSON inside `<script type="application/json" id="params">` of every composition. */
export interface CompositionManifest {
  /** kebab-case id, unique in the library ("word-pop"). */
  name: string;
  title: string;
  /** One or two sentences: what it shows and when to use it. Read by Claude to pick a composition. */
  description: string;
  /** Default length in seconds (the CLI's --duration overrides). */
  duration: number;
  /** Default [width, height] in px (the CLI's --size overrides). */
  size: [number, number];
  /** Default frame rate (the CLI's --fps overrides). */
  fps?: number;
  /**
   * Fit-to-duration (CONTRACT.md §3b): the shortest length in seconds, at speed 1, in which every beat still happens.
   * A render asked for less runs the animation clock at fit / duration (so typing types and ticks tick in a 1 s
   * window). Default: `duration`. `false` = never compress (a piece whose every beat is timed to the voice).
   */
  fit?: number | false;
  tags?: string[];
  /**
   * A library kit (kits/<name>.js) this composition uses (composition-v3, CONTRACT.md §9c): the renderer runs it after
   * the runtime, before the page's scripts, and its sha joins the render hash. Keep `<!-- rc-kit -->` in <head> too.
   */
  kit?: string;
  params: Record<string, ParamSpec>;
}

export type OutputFormat = "webm" | "mov" | "png";

export interface RenderOptions {
  /** Path to the composition .html file. */
  composition: string;
  /** Output path: .webm (VP9 alpha), .mov (ProRes 4444) or a directory (PNG sequence). */
  out: string;
  /** Overrides on top of the manifest defaults (already merged with a props file by the CLI). */
  props?: ParamValues;
  /** Directory that relative image paths in `props` resolve against (the props file's folder). */
  propsDir?: string;
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
  format?: OutputFormat;
  /** Parallel browser tabs capturing frames (default 4). Frame i is always drawn by tab i % workers. */
  workers?: number;
  /** VP9 constant-quality value, lower = better/larger (default 31). */
  crf?: number;
  /** Also write the PNG frames here (debugging). */
  keepFrames?: string;
  /** Called after each frame is encoded. */
  onProgress?: (done: number, total: number) => void;
  /** Chromium executable; default: env RESTORFFCUT_CHROME, else Playwright's chromium-headless-shell. */
  chrome?: string;
  /** Fit-to-duration (default true): a duration shorter than the manifest's `fit` compresses the animation clock. */
  fit?: boolean;
}

export interface RenderResult {
  out: string;
  format: OutputFormat;
  frames: number;
  fps: number;
  duration: number;
  width: number;
  height: number;
  /** Wall time in ms: total, and the share spent loading the page (fonts, images, build). */
  ms: { total: number; load: number; capture: number };
  /** Wall-clock seconds of rendering per second of output. */
  secondsPerSecond: number;
  /** Tabs used. Same count → bit-identical frames; another count may differ by <= 1/255 in a few pixels. */
  workers: number;
  bytes: number;
  /** sha256 of the composition file + resolved params + size/fps/duration: a cache key. */
  inputHash: string;
  /** sha256 over every captured frame's PNG hash: equal across runs when rendering is deterministic. */
  framesHash: string;
  /** Natural length (s) the clock was fitted from; 0 = no fit (the duration was long enough, or fit is off). */
  fit: number;
  /** Animation seconds per real second: max(speed, fit / duration). 1 = as designed. */
  rate: number;
  params: ParamValues;
  /** Path of the JSON sidecar written next to the output. */
  sidecar: string;
}
