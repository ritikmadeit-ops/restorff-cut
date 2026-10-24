// Render a composition frame by frame: Chromium (seek → transparent PNG) → FFmpeg (VP9 alpha / ProRes 4444 / PNGs).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Browser, type Page } from "./cdp.ts";
import { encoderArgs, spawnEncoder } from "./ffmpeg.ts";
import { kitInitScript, readLibraryKit, type LibraryKit } from "./kits.ts";
import { hfProtocolScript, hfProtocolSha, libScript, libsIn, libsSha } from "./libs.ts";
import { lintComposition, parseManifest, resolveParams, validateManifest } from "./params.ts";
import type { CompositionManifest, OutputFormat, ParamSpec, ParamValues, RenderOptions, RenderResult } from "./types.ts";

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RUNTIME_PATH = join(PKG_ROOT, "src", "runtime.js");
export const FONTS_DIR = join(PKG_ROOT, "fonts");
const FONT_FILES = [
  "Archivo-Variable.woff2",
  "JetBrainsMono-Variable.woff2",
  "InstrumentSerif-Regular.woff2",
  "InstrumentSerif-Italic.woff2",
];
export const RENDERER_VERSION = "0.1.0";

let fontCache: Record<string, string> | null = null;
function fontData(): Record<string, string> {
  if (!fontCache) {
    fontCache = {};
    for (const f of FONT_FILES) fontCache[f] = readFileSync(join(FONTS_DIR, f)).toString("base64");
  }
  return fontCache;
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Replace every `image` value with a URL the page can load; relative paths resolve against `baseDir`. */
function resolveImages(spec: ParamSpec, value: unknown, baseDir: string, path: string, errors: string[]): unknown {
  if (spec.type === "image" && typeof value === "string") {
    if (/^(data:|https?:|file:)/i.test(value)) return value;
    const abs = isAbsolute(value) ? value : resolve(baseDir, value);
    if (!existsSync(abs)) {
      // mcp-gaps-mvp (2026-10-24): the message names the value sent and what is allowed, never the server's path
      const shown = value.length > 80 ? `${value.slice(0, 77)}...` : value;
      errors.push(
        /^[A-Za-z0-9][A-Za-z0-9_-]{7,}$/.test(value)
          ? `${path}: "${shown}" is not a file and not a media id of this timeline (media list shows them); an image takes a media_id, a data: or https: URL, or a file in the composition's own folder`
          : `${path}: image not found: "${shown}" (relative paths resolve inside the composition's own folder); an image takes a media_id, a data: or https: URL, or a file in that folder`,
      );
      return value;
    }
    return pathToFileURL(abs).href;
  }
  if (spec.type === "list" && Array.isArray(value)) {
    return value.map((v, i) => resolveImages(spec.of, v, baseDir, `${path}[${i}]`, errors));
  }
  if (spec.type === "object" && value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const fs = spec.fields[k];
      o[k] = fs ? resolveImages(fs, v, baseDir, `${path}.${k}`, errors) : v;
    }
    return o;
  }
  return value;
}

export interface Prepared {
  html: string;
  htmlPath: string;
  manifest: CompositionManifest;
  /** Validated params as written (paths unresolved): what goes in the sidecar and the hash. */
  values: ParamValues;
  /** Same, with image paths turned into file:// URLs: what the page receives. */
  pageValues: ParamValues;
  width: number;
  height: number;
  fps: number;
  duration: number;
  frames: number;
  format: OutputFormat;
  crf: number;
  /** Parallel tabs; frame i is always drawn by tab i % workers. */
  workers: number;
  /** Natural length (s) the animation clock is fitted from; 0 = none (CONTRACT.md §3b). Goes to the page config. */
  fit: number;
  warnings: string[];
  inputHash: string;
  /** A library kit the manifest names (composition-v3): run after the runtime, before the page's scripts. */
  kit?: LibraryKit;
  /** Animation libraries the page asks for with `<!-- rc-lib name -->` (libs.ts): injected after the runtime. */
  libs?: string[];
}

/**
 * Fit-to-duration: the natural length to fit from, or 0. `manifestFit` is the manifest's `fit` (number | false |
 * undefined → its `duration`); the clock is only ever compressed, never stretched, and `enabled: false` turns it off.
 */
export function fitFor(manifestFit: number | false | undefined, manifestDuration: number, duration: number, enabled = true): number {
  if (!enabled || manifestFit === false) return 0;
  const natural = typeof manifestFit === "number" ? manifestFit : manifestDuration;
  return natural > 0 && duration > 0 && natural > duration + 1e-9 ? natural : 0;
}

/** Animation seconds per real second for a render: max(speed, fit / duration) — runtime.js clockRate(), mirrored. */
export function rateFor(values: ParamValues, fit: number, duration: number): number {
  const s = typeof values.speed === "number" && values.speed > 0 ? values.speed : 1;
  return Math.max(s, fit > 0 && duration > 0 ? fit / duration : 0);
}

function formatFor(out: string, explicit?: OutputFormat): OutputFormat {
  if (explicit) return explicit;
  const ext = extname(out).toLowerCase();
  if (ext === ".webm") return "webm";
  if (ext === ".mov") return "mov";
  if (ext === "" || ext === ".png") return "png";
  throw new Error(`can't infer a format from "${out}": use .webm, .mov, a folder (PNG frames) or --format`);
}

/** Everything that can fail without a browser: manifest, params, size, images. Throws one error listing all problems. */
export function prepare(opts: RenderOptions): Prepared {
  const htmlPath = resolve(opts.composition);
  if (!existsSync(htmlPath)) throw new Error(`composition not found: ${htmlPath}`);
  const html = readFileSync(htmlPath, "utf8");
  const manifest = parseManifest(html);
  const problems = validateManifest(manifest).map((e) => `manifest ${e}`);
  const { values, errors } = problems.length ? { values: {}, errors: [] as string[] } : resolveParams(manifest, opts.props ?? {});
  problems.push(...errors);
  const width = opts.width ?? manifest.size?.[0];
  const height = opts.height ?? manifest.size?.[1];
  const fps = opts.fps ?? manifest.fps ?? 30;
  const duration = opts.duration ?? manifest.duration;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width % 2 || height % 2 || width < 2 || height < 2) {
    problems.push(`size ${width}x${height}: width and height must be positive even integers`);
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) problems.push(`fps ${fps}: integer 1..120`);
  if (!(duration > 0) || duration > 600) problems.push(`duration ${duration}: seconds, 0 < d <= 600`);
  // composition-v3: a library kit named in the manifest (kits/<name>.js)
  const kit = !problems.length && manifest.kit ? readLibraryKit(manifest.kit) : null;
  if (manifest.kit && !problems.length && !kit) problems.push(`kit "${manifest.kit}": no kits/${manifest.kit}.js in the package`);
  // anim-runtime (wave 7): <!-- rc-lib gsap three … --> markers name offline animation libraries (libs.ts)
  const { libs, unknown: unknownLibs } = libsIn(html);
  for (const u of unknownLibs) problems.push(`<!-- rc-lib ${u} -->: unknown library (gsap, three, three-r147, lottie, anime)`);
  const pageValues: ParamValues = {};
  if (!problems.length) {
    const baseDir = opts.propsDir ? resolve(opts.propsDir) : dirname(htmlPath);
    for (const [k, spec] of Object.entries(manifest.params)) {
      // Defaults resolve against the composition's folder; overrides against the props file's folder.
      const dir = opts.props && k in opts.props ? baseDir : dirname(htmlPath);
      pageValues[k] = resolveImages(spec, values[k], dir, k, problems);
    }
  }
  // the composition's folder/file, not the absolute path (errors reach MCP clients; mcp-gaps-mvp 2026-10-24)
  if (problems.length) throw new Error(`${basename(dirname(htmlPath))}/${basename(htmlPath)}\n  - ${problems.join("\n  - ")}`);
  const format = formatFor(opts.out, opts.format);
  const crf = opts.crf ?? 31;
  const frames = Math.round(duration * fps);
  // Bit-identical output needs the same worker count: each tab's raster depends (by <= 1/255) on the frames it drew
  // before (MEASURED 2026-10-20, LEARNINGS.md), so the count is part of the cache key.
  const workers = Math.max(1, Math.min(opts.workers ?? 4, 16, frames));
  const fit = fitFor(manifest.fit, manifest.duration, duration, opts.fit !== false);
  // every page also gets the HyperFrames page protocol (hf-protocol.js), so it is part of the runtime's hash
  const runtimeHash = sha256(readFileSync(RUNTIME_PATH, "utf8") + hfProtocolSha());
  const imageHashes = collectImageFiles(pageValues).map((p) => sha256(readFileSync(p)));
  // the kit's sha joins the hash only when the manifest names one: every other composition keeps its cached renders
  const inputHash = sha256(
    JSON.stringify({ html: sha256(html), values, width, height, fps, duration, format, crf, workers, fit, runtimeHash, imageHashes, RENDERER_VERSION, ...(kit ? { kit: kit.sha } : {}), ...(libs.length ? { libs: libsSha(libs) } : {}) }),
  );
  return { html, htmlPath, manifest, values, pageValues, width, height, fps, duration, frames, format, crf, workers, fit, warnings: lintComposition(html), inputHash, ...(kit ? { kit } : {}), ...(libs.length ? { libs } : {}) };
}

function collectImageFiles(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string" && v.startsWith("file:")) out.push(fileURLToPath(v));
  else if (Array.isArray(v)) v.forEach((x) => collectImageFiles(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectImageFiles(x, out));
  return out;
}

/** The script every page gets before its own: `window.__RC_CONFIG` (params, size, fps, duration, font bytes) + the runtime. */
export function initScript(prep: Pick<Prepared, "pageValues" | "width" | "height" | "fps" | "duration"> & { fit?: number; kit?: LibraryKit; libs?: string[] }): string {
  const config = {
    params: prep.pageValues,
    width: prep.width,
    height: prep.height,
    fps: prep.fps,
    duration: prep.duration,
    fit: prep.fit ?? 0,
    fontData: fontData(),
  };
  // a library kit runs right after the runtime, before any page script (composition-v3, CONTRACT.md §9c)
  // order: config, runtime, the HyperFrames page protocol, the libraries the page names (libs.ts), a library kit
  return `window.__RC_CONFIG = ${JSON.stringify(config)};\n${readFileSync(RUNTIME_PATH, "utf8")}${hfProtocolScript()}${prep.libs?.length ? libScript(prep.libs) : ""}${prep.kit ? kitInitScript(prep.kit) : ""}`;
}

/**
 * Sound cues a page computed from its params (composition-v3, CONTRACT.md §9d): `window.__rcCues = [{t, kind,
 * label?, sound?}]` set in build, `t` = real seconds into the clip (or `from_end`). Cleaned and capped at 64; null when
 * the page declared none. They go into the sidecar as `cues`, which sound design reads before the manifest's.
 */
export function cleanCues(raw: unknown, duration: number): Array<Record<string, unknown>> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const kind = typeof c.kind === "string" ? c.kind.trim().toLowerCase().slice(0, 32) : "";
    const t = typeof c.t === "number" && Number.isFinite(c.t) && c.t >= 0 && c.t <= duration + 1e-6 ? Math.round(c.t * 1000) / 1000 : undefined;
    const fromEnd = typeof c.from_end === "number" && Number.isFinite(c.from_end) && c.from_end >= 0 ? Math.round(c.from_end * 1000) / 1000 : undefined;
    if (!kind || (t === undefined && fromEnd === undefined)) continue;
    out.push({ ...(t !== undefined ? { t } : { from_end: fromEnd }), kind, ...(typeof c.label === "string" ? { label: c.label.slice(0, 60) } : {}), ...(typeof c.sound === "string" ? { sound: c.sound.slice(0, 60) } : {}) });
    if (out.length >= 64) break;
  }
  out.sort((a, b) => ((a.t as number | undefined) ?? duration) - ((b.t as number | undefined) ?? duration));
  return out;
}

/** The bundled fonts as base64, by file name (what `__RC_CONFIG.fontData` carries). */
export function bundledFontData(): Record<string, string> {
  return { ...fontData() };
}

/**
 * Open a composition in a new tab, runtime + config injected, and wait until it is built. Exported for tests/tools.
 * `how.url` replaces the file URL (custom.ts navigates to a data: URL); `how.before` runs on the blank tab first
 * (custom.ts blocks the network there).
 */
export async function openPage(
  browser: Browser,
  prep: Prepared,
  how: { url?: string; before?: (page: Page) => Promise<void> } = {},
): Promise<Page> {
  const page = await browser.newPage(prep.width, prep.height);
  if (how.before) await how.before(page);
  await page.addInitScript(initScript(prep));
  await page.navigate(how.url ?? pathToFileURL(prep.htmlPath).href);
  const ready = await page.evaluate<{ ok: boolean; errors: string[] }>(
    "window.RC ? window.RC.ready : Promise.resolve({ ok: false, errors: ['runtime did not load'] })",
    true,
  );
  if (!ready?.ok) throw new Error(`composition failed to build:\n  - ${(ready?.errors ?? ["unknown"]).join("\n  - ")}`);
  return page;
}

async function seekAndCapture(page: Page, frame: number, fps: number): Promise<Buffer> {
  // t = frame / fps, computed in the page from integers: the same double every run. A seek may return a Promise (an
  // hf-seek listener called waitUntil, e.g. a WebGL draw): awaited before the capture (anim-runtime, wave 7).
  await page.evaluate(`window.__hf.seek(${frame} / ${fps})`, true);
  return page.screenshotPng();
}

function pad(n: number): string {
  return String(n).padStart(5, "0");
}

export async function render(opts: RenderOptions): Promise<RenderResult> {
  const t0 = performance.now();
  const prep = prepare(opts);
  return renderWith(prep, opts, {
    t0,
    open: (browser) => openPage(browser, prep),
    sidecar: { composition: prep.manifest.name, source: prep.htmlPath },
  });
}

/** How renderWith opens each tab, what it adds to the sidecar, and any extra Chromium flags. */
export interface RenderHow {
  open: (browser: Browser) => Promise<Page>;
  /** First keys of the sidecar JSON (render() writes `composition` and `source`). */
  sidecar: Record<string, unknown>;
  launchFlags?: string[];
  /** Called once after the frames are written, before the browser closes (custom.ts reads blocked requests). */
  after?: (pages: Page[]) => Promise<void>;
  t0?: number;
}

/** The frame loop + encoder for an already prepared render. render() and custom.ts both use it. */
export async function renderWith(
  prep: Prepared,
  opts: Pick<RenderOptions, "out" | "keepFrames" | "onProgress" | "chrome">,
  how: RenderHow,
): Promise<RenderResult> {
  const t0 = how.t0 ?? performance.now();
  const out = resolve(opts.out);
  if (prep.format === "png") mkdirSync(out, { recursive: true });
  else mkdirSync(dirname(out), { recursive: true });
  if (opts.keepFrames) mkdirSync(resolve(opts.keepFrames), { recursive: true });

  const browser = await Browser.launch({ executable: opts.chrome, extraFlags: how.launchFlags });
  let tLoad = 0;
  let pngBytes = 0;
  let cues: Array<Record<string, unknown>> | null = null;
  const frameHashes: string[] = new Array(prep.frames);
  try {
    const pages = await Promise.all(Array.from({ length: prep.workers }, () => how.open(browser)));
    tLoad = performance.now() - t0;

    const encoder = prep.format === "png" ? null : spawnEncoder(encoderArgs(prep.format, prep.fps, out, prep.crf));
    const ready = new Map<number, Buffer>();
    let nextWrite = 0;
    let chain: Promise<void> = Promise.resolve();

    const write = async (buf: Buffer, i: number) => {
      frameHashes[i] = sha256(buf);
      pngBytes += buf.length;
      if (opts.keepFrames) writeFileSync(join(resolve(opts.keepFrames), `frame_${pad(i)}.png`), buf);
      if (!encoder) writeFileSync(join(out, `frame_${pad(i)}.png`), buf);
      else if (!encoder.stdin.write(buf)) await new Promise<void>((r) => encoder.stdin.once("drain", () => r()));
      opts.onProgress?.(i + 1, prep.frames);
    };
    const flush = async () => {
      while (ready.has(nextWrite)) {
        const buf = ready.get(nextWrite)!;
        ready.delete(nextWrite);
        await write(buf, nextWrite);
        nextWrite++;
      }
    };
    // Fixed assignment: worker k renders frames k, k+W, k+2W… so every tab sees the same seek history every run.
    const worker = async (page: Page, k: number) => {
      for (let i = k; i < prep.frames; i += pages.length) {
        ready.set(i, await seekAndCapture(page, i, prep.fps));
        chain = chain.then(flush);
        await chain; // back-pressure: workers never run far ahead of the encoder
      }
    };
    await Promise.all(pages.map(worker));
    await chain;
    for (const page of pages) {
      const errs = await page.evaluate<string[]>("window.RC.errors.slice()");
      if (errs?.length) throw new Error(`composition errors during render:\n  - ${errs.join("\n  - ")}`);
    }
    // sound cues the page computed from its params in build (CONTRACT.md §9d); every tab built the same list
    if (pages[0]) cues = cleanCues(await pages[0].evaluate<unknown>("window.__rcCues || null").catch(() => null), prep.duration);
    if (how.after) await how.after(pages);
    if (encoder) {
      encoder.stdin.end();
      await encoder.done;
    }
    if (nextWrite !== prep.frames) throw new Error(`wrote ${nextWrite} of ${prep.frames} frames`);
  } finally {
    await browser.close();
  }

  const total = performance.now() - t0;
  const bytes = prep.format === "png" ? pngBytes : statSync(out).size;
  const sidecar = prep.format === "png" ? join(out, "render.json") : `${out}.json`;
  const framesHash = sha256(frameHashes.join(""));
  const result: RenderResult = {
    out,
    format: prep.format,
    frames: prep.frames,
    fps: prep.fps,
    duration: prep.duration,
    width: prep.width,
    height: prep.height,
    ms: { total: Math.round(total), load: Math.round(tLoad), capture: Math.round(total - tLoad) },
    secondsPerSecond: +(total / 1000 / prep.duration).toFixed(2),
    workers: prep.workers,
    bytes,
    inputHash: prep.inputHash,
    framesHash,
    fit: prep.fit,
    rate: +rateFor(prep.values, prep.fit, prep.duration).toFixed(4),
    params: prep.values,
    sidecar,
  };
  writeFileSync(
    sidecar,
    `${JSON.stringify(
      {
        ...how.sidecar,
        renderer: `@restorffcut/compositions ${RENDERER_VERSION}`,
        chrome: browser.version,
        ...result,
        crf: prep.format === "webm" ? prep.crf : undefined,
        warnings: prep.warnings,
        ...(prep.kit ? { kit: prep.kit.name, kitSha256: prep.kit.sha } : {}),
        ...(cues ? { cues } : {}),
        renderedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return result;
}

/** Render one moment to a PNG — fast feedback while writing a composition. `plate` = "#RRGGBB" background or none. */
export async function renderStill(opts: RenderOptions & { t: number; plate?: string }): Promise<{ out: string; ms: number }> {
  const t0 = performance.now();
  const prep = prepare({ ...opts, out: opts.out.endsWith(".png") ? opts.out : `${opts.out}.png`, format: "png" });
  const browser = await Browser.launch({ executable: opts.chrome });
  try {
    const page = await openPage(browser, prep);
    if (opts.plate) {
      const n = Number.parseInt(opts.plate.replace("#", ""), 16);
      await page.setBackground({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 });
    }
    await page.evaluate(`window.__hf.seek(${Number(opts.t)})`, true);
    const buf = await page.screenshotPng();
    const errs = await page.evaluate<string[]>("window.RC.errors.slice()");
    if (errs?.length) throw new Error(`composition errors:\n  - ${errs.join("\n  - ")}`);
    const out = resolve(opts.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, buf);
    return { out, ms: Math.round(performance.now() - t0) };
  } finally {
    await browser.close();
  }
}
