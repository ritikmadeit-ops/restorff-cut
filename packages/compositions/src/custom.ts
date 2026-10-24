// Custom compositions: HTML/CSS/JS written in the product (by Claude or a person) instead of picked from the library.
//
// validateCustom → prepareCustom → renderCustom (network blocked in Chromium) → renderCustomCached (by hash). The
// source is untrusted text from a web page or an MCP client, so it is checked statically (no network APIs, no
// external URLs, the page protocol present, ≤ 256 KB) AND sandboxed at render time: the page is loaded from a data:
// URL (opaque origin: it cannot read the server's files), every request is blocked (Network.setBlockedURLs "*" +
// Fetch interception that fails whatever slips through) and Chromium runs behind a dead proxy with DNS off, so even
// code that builds a URL at run time reaches nothing. The source itself travels in the commit
// (element.restorff.composition.source), so anyone can reopen and change it. Runbook: README.md "Custom compositions".
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Browser, Page } from "./cdp.ts";
import { nudge, type Change } from "./edits.ts";
import { isKitName, readLibraryKit } from "./kits.ts";
import { hfProtocolScript, hfProtocolSha, LIBS, libScript, libsIn, libsSha } from "./libs.ts";
import { extractParamsBlock, resolveParams, validateManifest } from "./params.ts";
import { bundledFontData, fitFor, openPage, PKG_ROOT, rateFor, RENDERER_VERSION, renderWith, RUNTIME_PATH, type Prepared } from "./render.ts";
import type { CompositionManifest, ParamSpec, ParamValues, RenderResult } from "./types.ts";

/** Bump when anything that changes custom pixels changes outside the runtime/renderer versions (part of the hash). */
export const CUSTOM_VERSION = "2";
export const CUSTOM_MAX_BYTES = 256 * 1024;
/** The timeline kit (shared CSS/JS/markup every custom composition of a timeline may include): at most 128 KB. */
export const KIT_MAX_BYTES = 128 * 1024;
/** One data: image in props: at most 4 MB of URL text (≈ 3 MB of image). A 1080-px JPEG is ~200 KB. */
export const CUSTOM_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** All props of one custom render together: at most 16 MB of JSON. */
export const CUSTOM_MAX_PROPS_BYTES = 16 * 1024 * 1024;
/** Where a custom composition includes the timeline kit: this comment, in <head> (CONTRACT.md §9c). */
export const KIT_MARKER = "<!-- rc-kit -->";
export const CUSTOM_MAX_SECONDS = 60;
export const CUSTOM_DEFAULTS = { width: 1080, height: 1920, fps: 30, duration: 4 } as const;
export const EXAMPLES_DIR = join(PKG_ROOT, "examples", "custom");

/**
 * Flags for untrusted pages: every proxied request goes to a port nothing listens on (127.0.0.1:9, "discard"),
 * loopback included (`<-loopback>` removes the implicit bypass, so no request reaches the dev server or any local
 * service), and DNS resolves nothing.
 */
export const NO_NETWORK_FLAGS = [
  "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=<-loopback>",
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--no-pings",
];

// ---------------------------------------------------------------- validation

export interface CustomManifestView {
  name: string;
  title: string;
  description: string;
  duration: number;
  size: [number, number];
  fps: number;
  /** Fit-to-duration, opt-in for custom compositions: the natural length in seconds (CONTRACT.md §3b). */
  fit?: number | false;
  params: Record<string, ParamSpec>;
}

/**
 * The timeline kit: shared code a timeline's custom compositions include with `<!-- rc-kit -->` (written once, fixed
 * once, part of each including render's hash). A string is HTML (`<style>…</style><script>…</script>`, SVG defs…);
 * the object form is wrapped for you.
 */
export type CustomKitInput = string | { css?: string; js?: string; html?: string };

/** The kit as the HTML that replaces the marker, or null when none was sent. */
export function kitHtml(kit: CustomKitInput | null | undefined): string | null {
  if (kit == null) return null;
  if (typeof kit === "string") return kit.trim() ? kit : null;
  if (typeof kit !== "object" || Array.isArray(kit)) return null;
  const parts: string[] = [];
  if (typeof kit.html === "string" && kit.html.trim()) parts.push(kit.html);
  if (typeof kit.css === "string" && kit.css.trim()) parts.push(`<style data-rc-kit>\n${kit.css}\n</style>`);
  if (typeof kit.js === "string" && kit.js.trim()) parts.push(`<script data-rc-kit>\n${kit.js}\n</script>`);
  return parts.length ? parts.join("\n") : null;
}

/** Does this source include the timeline kit? */
export function usesKit(source: string): boolean {
  return source.includes(KIT_MARKER);
}

/**
 * The library kit a source's params block names (`"kit": "neon-grid"`, kits/<name>.js), as kit input, or undefined.
 * composition-v3: a source that includes the marker and is sent WITHOUT a kit falls back to it, so a library piece
 * forked as custom code renders unchanged; a kit that is sent (the timeline's) always wins.
 */
export function libraryKitOf(source: unknown): { name: string; kit: CustomKitInput } | undefined {
  if (typeof source !== "string" || !usesKit(source)) return undefined;
  const block = extractParamsBlock(source);
  if (block == null) return undefined;
  try {
    const raw = JSON.parse(block) as { kit?: unknown };
    if (!isKitName(raw?.kit)) return undefined;
    const k = readLibraryKit(raw.kit);
    return k ? { name: k.name, kit: { js: k.js, ...(k.css ? { css: k.css } : {}) } } : undefined;
  } catch {
    return undefined;
  }
}

/** The kit a request renders with: the one sent, else the params block's library kit (only for marker sources). */
export function effectiveKit(source: unknown, sent: CustomKitInput | null | undefined): { kit: CustomKitInput | null | undefined; from: "request" | `library:${string}` | null } {
  if (sent != null && kitHtml(sent) != null) return { kit: sent, from: "request" };
  const lib = libraryKitOf(source);
  return lib ? { kit: lib.kit, from: `library:${lib.name}` } : { kit: sent, from: null };
}

/** The page the renderer loads: the kit's HTML in place of the marker (first one; others removed). */
export function injectKit(source: string, kit: CustomKitInput | null | undefined): string {
  if (!usesKit(source)) return source;
  const html = kitHtml(kit) ?? "";
  const i = source.indexOf(KIT_MARKER);
  return source.slice(0, i) + html + source.slice(i + KIT_MARKER.length).split(KIT_MARKER).join("");
}

export interface CustomValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** The params block with defaults filled in (name/title/… are optional in a custom one), or null when absent. */
  manifest: CustomManifestView | null;
  /** The props the page will get: the params block's defaults overlaid with `props`, or `props` as-is without one. */
  values: ParamValues;
  /** "rc" = RC.composition({ build, render }); "hf" = the page sets window.__hf = { duration, seek } itself. */
  protocol: "rc" | "hf" | null;
  bytes: number;
}

interface Rule {
  re: RegExp;
  level: "error" | "warning";
  msg: string;
}

const NO_NET = "the render has no network: put data in props and inline images/fonts as data: URLs";
const RULES: Rule[] = [
  { re: /\bfetch\s*\(/, level: "error", msg: `fetch(): ${NO_NET}` },
  { re: /\bXMLHttpRequest\b/, level: "error", msg: `XMLHttpRequest: ${NO_NET}` },
  { re: /\bWebSocket\b/, level: "error", msg: `WebSocket: ${NO_NET}` },
  { re: /\bEventSource\b/, level: "error", msg: `EventSource: ${NO_NET}` },
  { re: /\bsendBeacon\b/, level: "error", msg: `sendBeacon: ${NO_NET}` },
  { re: /\bRTCPeerConnection\b|\bWebTransport\b/, level: "error", msg: `WebRTC/WebTransport: ${NO_NET}` },
  { re: /\bimport\s*\(/, level: "error", msg: `dynamic import(): ${NO_NET}; write the code inline` },
  { re: /\bimport\s+(?:[\w$*{][^;]*?\bfrom\s*)?["'`]/, level: "error", msg: `import statement: ${NO_NET}; write the code inline` },
  { re: /\bimportScripts\b|\bnew\s+(?:Shared)?Worker\s*\(/, level: "error", msg: "workers load other scripts: write the code inline" },
  { re: /@import\b/i, level: "error", msg: `CSS @import: ${NO_NET}` },
  { re: /<(?:iframe|frame|frameset|object|embed|base|link|portal|applet)\b/i, level: "error", msg: "<iframe>/<object>/<embed>/<base>/<link> load other documents: everything must be inline" },
  { re: /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i, level: "error", msg: "<meta http-equiv=refresh> navigates away" },
  { re: /\b(?:window|document|self|top|parent)\.location\b|\blocation\.(?:href\s*=(?!=)|assign\s*\(|replace\s*\()|\bwindow\.open\s*\(/, level: "error", msg: "navigation (location / window.open): a composition is one page" },
  { re: /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bdocument\.cookie\b/, level: "error", msg: "storage APIs are not available while rendering (the page has an opaque origin): keep state in variables" },
  { re: /<(?:video|audio)\b/i, level: "error", msg: "<video>/<audio> are not seeked by the renderer yet (CONTRACT.md §5.8)" },
  // Seekable by time (CONTRACT.md §5): the picture must depend on `time` only, so these are errors here.
  { re: /\bDate\.now\s*\(|\bnew\s+Date\s*\(/, level: "error", msg: "reads the wall clock (Date): draw from the `time` passed to render()" },
  { re: /\bperformance\.now\s*\(/, level: "error", msg: "reads performance.now(): draw from the `time` passed to render()" },
  { re: /\bMath\.random\s*\(/, level: "error", msg: "Math.random() is unseeded: use RC.random(seed) and expose the seed as a param" },
  { re: /\brequestAnimationFrame\s*\(/, level: "error", msg: "requestAnimationFrame runs on real time: animate in render(time)" },
  { re: /\bset(?:Timeout|Interval)\s*\(/, level: "error", msg: "timers run on real time: animate in render(time)" },
  { re: /(?:^|[;{\s"'])transition\s*:/m, level: "warning", msg: "CSS transition runs on real time: drive the property from render(time) (it will not animate in the render)" },
  { re: /will-change\s*:/, level: "warning", msg: "will-change freezes a layer's raster scale at its first frame (LEARNINGS.md §2): remove it" },
  { re: /translate3d\s*\(|translateZ\s*\(/, level: "warning", msg: "translate3d/translateZ promote a compositor layer whose pixels can differ run to run (LEARNINGS.md §2): prefer 2D translate + scale; rotateX/rotateY with perspective are fine" },
];

/** URL-carrying attributes. Allowed values: data:, #fragment, empty — and `…runtime.js` on <script src> (stripped). */
const URL_ATTR = /\s(src|href|srcset|poster|action|formaction|background|data|xlink:href|ping|manifest|codebase|cite|longdesc|lowsrc)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
/** The optional `<script src="…/runtime.js"></script>` preview line (the renderer injects the runtime itself). */
const runtimeScript = () => /<script\b[^>]*\ssrc\s*=\s*["']?[^"'\s>]*runtime\.js[^"'\s>]*["']?[^>]*>\s*<\/script\s*>/gi;
/** A URL with a scheme that loads something, or a protocol-relative one, at the start of a JS string. */
const STRING_URL = /["'`]\s*((?:https?|wss?|ftp|file|filesystem):[^"'`\s]*|\/\/[a-z0-9.-]+\.[a-z]{2,}[^"'`\s]*)/gi;
/** SVG/XML namespace URIs are identifiers, never loaded. */
const NAMESPACE_URL = /^https?:\/\/www\.w3\.org\//i;
const CSS_URL = /url\(\s*(["']?)([^"')]*)\1\s*\)/gi;

function allowedUrl(value: string): boolean {
  const v = value.trim();
  return v === "" || v.startsWith("#") || /^data:/i.test(v);
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Drop `$comment`-style keys: notes in a props file, never params. */
function stripMeta(props: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const [k, v] of Object.entries(props)) if (!k.startsWith("$")) out[k] = v;
  return out;
}

/** JSON with object keys sorted at every level: the same props in any order hash the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Every string inside a props value, with its path. */
function stringsIn(v: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof v === "string") out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => stringsIn(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) stringsIn(x, path ? `${path}.${k}` : k, out);
  return out;
}

/** Image values (by spec) that are not data: images, or are too big to carry. */
function nonDataImages(spec: ParamSpec, value: unknown, path: string, out: string[]): void {
  if (spec.type === "image") {
    if (typeof value !== "string" || value === "") return;
    if (!/^data:/i.test(value)) out.push(`${path}: images must be data: URLs in a custom composition (${NO_NET})`);
    else if (!/^data:image\//i.test(value)) out.push(`${path}: "${value.slice(0, 30)}…" is not an image (data:image/png|jpeg|webp|gif|svg+xml;base64,…)`);
    else if (value.length > CUSTOM_MAX_IMAGE_BYTES) {
      out.push(`${path}: the data: image is ${value.length} bytes; the limit is ${CUSTOM_MAX_IMAGE_BYTES} (4 MB). Scale it down: a 1080-px-wide JPEG is about 200 KB`);
    }
    return;
  }
  if (spec.type === "list" && Array.isArray(value)) value.forEach((x, i) => nonDataImages(spec.of, x, `${path}[${i}]`, out));
  if (spec.type === "object" && value && typeof value === "object") {
    for (const [k, x] of Object.entries(value as Record<string, unknown>)) {
      const f = spec.fields[k];
      if (f) nonDataImages(f, x, `${path}.${k}`, out);
    }
  }
}

/** The source with its params block removed: what the static rules scan (descriptions may say anything). */
function codeOf(source: string): string {
  return source.replace(/<script\b[^>]*\bid\s*=\s*["']params["'][^>]*>[\s\S]*?<\/script\s*>/i, "");
}

/** Line number (1-based) of an index into `text`. */
function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * The static rules over one piece of code (a composition without its params block, or the timeline kit): network and
 * navigation APIs, determinism hazards, external URLs in attributes, CSS url(…) and JS strings. `where` prefixes each
 * message ("line 12" or "kit line 3").
 */
function scanCode(code: string, where: string, errors: string[], warnings: string[]): void {
  for (const rule of RULES) {
    const m = rule.re.exec(code);
    if (m) (rule.level === "error" ? errors : warnings).push(`${where} ${lineAt(code, m.index)}: ${rule.msg}`);
  }

  // External URLs in HTML attributes (script/style bodies excluded: they are scanned as code below).
  const markup = code.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (all) => all.replace(/>[\s\S]*</, "><"));
  for (const tag of markup.matchAll(/<[a-zA-Z][^>]*>/g)) {
    for (const a of tag[0].matchAll(URL_ATTR)) {
      const attr = (a[1] ?? "").toLowerCase();
      const value = a[2] ?? a[3] ?? a[4] ?? "";
      if (attr === "src" && /^<script\b/i.test(tag[0]) && /runtime\.js(\?.*)?$/.test(value)) continue;
      if (!allowedUrl(value)) {
        errors.push(`${where} ${lineAt(code, code.indexOf(tag[0]))}: ${attr}="${value.slice(0, 80)}" loads from outside: ${NO_NET}`);
      }
    }
  }
  // URLs in CSS url(…) (style blocks, style attributes, strings) and at the start of JS strings (script bodies).
  for (const m of code.matchAll(CSS_URL)) {
    const value = m[2] ?? "";
    if (!allowedUrl(value)) errors.push(`${where} ${lineAt(code, m.index ?? 0)}: url(${value.slice(0, 80)}) loads from outside: ${NO_NET}`);
  }
  for (const s of code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const body = s[1] ?? "";
    const offset = (s.index ?? 0) + s[0].indexOf(body);
    for (const m of body.matchAll(STRING_URL)) {
      const value = m[1] ?? "";
      if (NAMESPACE_URL.test(value)) continue;
      errors.push(`${where} ${lineAt(code, offset + (m.index ?? 0))}: the URL "${value.slice(0, 80)}" cannot load: ${NO_NET}`);
    }
  }
}

/**
 * Check a timeline kit on its own (size + the same static rules as a composition). The object form's `js` is checked
 * as a script body, `css` as a style body. Never throws.
 */
export function validateKit(kit: unknown): { ok: boolean; errors: string[]; warnings: string[]; bytes: number } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (kit != null && typeof kit !== "string" && (typeof kit !== "object" || Array.isArray(kit))) {
    return { ok: false, errors: ["kit must be HTML text or { css?, js?, html? }"], warnings, bytes: 0 };
  }
  const html = kitHtml(kit as CustomKitInput | null | undefined);
  if (html == null) return { ok: false, errors: ["the kit is empty: send { css, js } or HTML"], warnings, bytes: 0 };
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > KIT_MAX_BYTES) errors.push(`the kit is ${bytes} bytes; the limit is ${KIT_MAX_BYTES} (128 KB)`);
  else scanCode(html, "kit line", errors, warnings);
  if (/\bRC\.composition\s*\(/.test(html)) errors.push("the kit calls RC.composition(): a kit only defines shared helpers and styles; each composition registers itself");
  return { ok: errors.length === 0, errors, warnings, bytes };
}

/**
 * Check a custom composition without a browser: size, page protocol, network and navigation APIs, external URLs,
 * determinism hazards, the optional params block, the props and — when the source includes it — the timeline kit.
 * Never throws.
 */
export function validateCustom(source: unknown, props: unknown = {}, opts: { kit?: unknown } = {}): CustomValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const empty: CustomValidation = { ok: false, errors, warnings, manifest: null, values: {}, protocol: null, bytes: 0 };
  if (typeof source !== "string" || !source.trim()) {
    errors.push("source is empty: send the composition's HTML");
    return empty;
  }
  const bytes = Buffer.byteLength(source, "utf8");
  empty.bytes = bytes;
  if (bytes > CUSTOM_MAX_BYTES) {
    errors.push(`source is ${bytes} bytes; the limit is ${CUSTOM_MAX_BYTES} (256 KB). Inline less: big images belong in props as data: URLs (each ≤ 4 MB), shared code in the timeline kit`);
    return empty;
  }
  if (props !== undefined && props !== null && (typeof props !== "object" || Array.isArray(props))) {
    errors.push("props must be a JSON object");
    return empty;
  }
  const propsBytes = props ? Buffer.byteLength(JSON.stringify(props), "utf8") : 0;
  if (propsBytes > CUSTOM_MAX_PROPS_BYTES) {
    errors.push(`props are ${propsBytes} bytes; the limit is ${CUSTOM_MAX_PROPS_BYTES} (16 MB): send fewer or smaller data: images`);
    return empty;
  }
  const code = codeOf(source);

  // The timeline kit: included with <!-- rc-kit --> (and then required), checked by the same rules. Not sent: the
  // library kit the params block names, when there is one (composition-v3).
  const kitIn = effectiveKit(source, opts.kit as CustomKitInput | null | undefined).kit;
  const kitCode = usesKit(source) ? kitHtml(kitIn) : null;
  if (usesKit(source)) {
    if (kitCode == null) {
      errors.push(`the source includes the timeline kit (${KIT_MARKER}) but no kit was sent: send the timeline's kit, or remove the marker and inline the code`);
    } else {
      const k = validateKit(kitIn);
      errors.push(...k.errors);
      warnings.push(...k.warnings);
    }
  }
  // what the protocol check sees: the kit may hold helpers, never the registration, so check the page with it inlined
  const pageCode = kitCode ? `${code}\n${kitCode}` : code;

  // The page protocol: seekable by time.
  const rc = /\bRC\.composition\s*\(/.test(code);
  // the HyperFrames protocol: its own window.__hf, or (anim-runtime, wave 7) a paused timeline registered on
  // window.__timelines, an `hf-seek` listener, or a Lottie / Anime.js instance pushed for the runtime to seek
  const hf = /\b(?:window\.)?__hf\s*=(?!=)/.test(code) || /__timelines\s*(?:\[|\.[A-Za-z_$])/.test(code) || /["']hf-seek["']/.test(code) || /__hf(?:Lottie|Anime)\b/.test(code);
  const libsAsked = libsIn(source);
  for (const u of libsAsked.unknown) errors.push(`<!-- rc-lib ${u} -->: unknown library; available: ${Object.keys(LIBS).join(", ")}`);
  let protocol: CustomValidation["protocol"] = null;
  if (rc) {
    protocol = "rc";
    if (!/\brender\s*(?::|\()/.test(pageCode)) errors.push("RC.composition({ … }) has no render(time, RC): the picture must be a function of time (CONTRACT.md §3)");
  } else if (hf) {
    protocol = "hf";
    if (/\b(?:window\.)?__hf\s*=(?!=)/.test(code) && !/\bseek\b/.test(pageCode)) errors.push("window.__hf needs seek(t): the renderer calls window.__hf.seek(frame / fps) for every frame");
  } else {
    errors.push("no page protocol: call RC.composition({ build, render }) (CONTRACT.md §1), set window.__hf = { duration, seek(t) }, or (HyperFrames) register a paused GSAP timeline on window.__timelines[id] with <!-- rc-lib gsap -->");
  }

  scanCode(code, "line", errors, warnings);

  // The optional params block; when present it types the props (and drives the editor's inspector).
  let manifest: CustomManifestView | null = null;
  let values: ParamValues = stripMeta((props as ParamValues | null) ?? {});
  const block = extractParamsBlock(source);
  if (block != null) {
    let raw: Partial<CompositionManifest> | null = null;
    try {
      raw = JSON.parse(block) as Partial<CompositionManifest>;
    } catch (e) {
      errors.push(`params block is not valid JSON: ${(e as Error).message}`);
    }
    if (raw && (typeof raw !== "object" || Array.isArray(raw))) {
      errors.push("params block must be a JSON object");
      raw = null;
    }
    if (raw) {
      const filled: CompositionManifest = {
        name: "custom",
        title: "Custom composition",
        description: "A custom composition written in the editor.",
        duration: CUSTOM_DEFAULTS.duration,
        size: [CUSTOM_DEFAULTS.width, CUSTOM_DEFAULTS.height],
        fps: CUSTOM_DEFAULTS.fps,
        ...raw,
        params: raw.params ?? {},
      };
      const problems = validateManifest(filled);
      errors.push(...problems.map((p) => `params block ${p}`));
      if (!problems.length) {
        manifest = {
          name: filled.name,
          title: filled.title,
          description: filled.description,
          duration: filled.duration,
          size: filled.size,
          fps: filled.fps ?? CUSTOM_DEFAULTS.fps,
          ...(filled.fit !== undefined ? { fit: filled.fit } : {}),
          params: filled.params,
        };
        const r = resolveParams(filled, values);
        errors.push(...r.errors.map((e) => `props ${e}`));
        values = r.values;
        const imgs: string[] = [];
        for (const [k, spec] of Object.entries(filled.params)) nonDataImages(spec, values[k], k, imgs);
        errors.push(...imgs);
      }
    }
  } else {
    warnings.push("no params block: props reach RC.params as they are; add one (CONTRACT.md §2) so the inspector shows typed fields and sentence edits work");
  }
  for (const [path, s] of stringsIn(values, "")) {
    if (/^\s*(?:https?|wss?|ftp|file|blob):/i.test(s) || /^\s*\/\/[a-z0-9.-]+\./i.test(s)) {
      errors.push(`props ${path}: "${s.slice(0, 80)}" is a URL; ${NO_NET}`);
    }
  }
  if (runtimeScript().test(source)) {
    warnings.push("the <script src=…runtime.js> line is ignored: the renderer injects the runtime itself");
  }
  return { ok: errors.length === 0, errors, warnings, manifest, values, protocol, bytes };
}

export class CustomInvalidError extends Error {
  readonly details: { errors: string[]; warnings: string[] };
  constructor(v: Pick<CustomValidation, "errors" | "warnings">) {
    super(`custom composition refused:\n  - ${v.errors.join("\n  - ")}`);
    this.details = { errors: v.errors, warnings: v.warnings };
  }
}

// ---------------------------------------------------------------- hash + prepare

export interface CustomRequest {
  source: string;
  props?: ParamValues;
  /** Seconds. Default: the params block's duration, else 4. At most 60. */
  duration?: number;
  /** Default: the params block's size, else 1080×1920. Rounded to even integers (yuva420p). */
  width?: number;
  height?: number;
  fps?: number;
  workers?: number;
  crf?: number;
  /** The timeline kit: used only when the source includes `<!-- rc-kit -->`, and then part of the hash. */
  kit?: CustomKitInput | null;
  /** Fit-to-duration (default true): applies when the params block declares `fit` (opt-in for custom code). */
  fit?: boolean;
}

export interface CustomHashInput {
  source: string;
  values: ParamValues;
  width: number;
  height: number;
  fps: number;
  duration: number;
  crf?: number;
  workers?: number;
  /** The kit HTML that replaced the marker (only when the source includes it). */
  kit?: string | null;
  /** Natural length the clock was fitted from (0 = none). */
  fit?: number;
}

/**
 * The cache key of a custom render: source, resolved props (key order ignored), size, fps, length, encoder, runtime,
 * and — only when used — the included kit and the fit (so a kit fix re-renders exactly the compositions that use it).
 */
export function customHash(i: CustomHashInput): string {
  return sha256(
    stable({
      kind: "custom",
      custom: CUSTOM_VERSION,
      source: sha256(i.source),
      values: i.values,
      width: i.width,
      height: i.height,
      fps: i.fps,
      duration: i.duration,
      format: "webm",
      crf: i.crf ?? 31,
      workers: i.workers ?? 4,
      kit: i.kit ? sha256(i.kit) : undefined,
      fit: i.fit ? i.fit : undefined,
      // every page gets the HyperFrames protocol; libraries (<!-- rc-lib … -->) join the hash only when used
      runtime: sha256(readFileSync(RUNTIME_PATH, "utf8") + hfProtocolSha()),
      libs: libsIn(i.source).libs.length ? libsSha(libsIn(i.source).libs) : undefined,
      renderer: RENDERER_VERSION,
    }),
  );
}

function evenSize(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(16, Math.min(Math.round(v / 2) * 2, 4096));
}

/** Validate and resolve a request into what the frame loop needs. Throws CustomInvalidError with every problem. */
export function prepareCustom(req: CustomRequest): { prep: Prepared; validation: CustomValidation } {
  const validation = validateCustom(req?.source, req?.props ?? {}, { kit: req?.kit });
  const m = validation.manifest;
  const width = evenSize(req.width, m?.size[0] ?? CUSTOM_DEFAULTS.width);
  const height = evenSize(req.height, m?.size[1] ?? CUSTOM_DEFAULTS.height);
  const fps = req.fps ?? m?.fps ?? CUSTOM_DEFAULTS.fps;
  const duration = req.duration ?? m?.duration ?? CUSTOM_DEFAULTS.duration;
  const errors = [...validation.errors];
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) errors.push(`fps ${fps}: integer 1..120`);
  if (typeof duration !== "number" || !(duration > 0) || duration > CUSTOM_MAX_SECONDS) {
    errors.push(`duration ${duration}: seconds, 0 < d <= ${CUSTOM_MAX_SECONDS}`);
  }
  if (errors.length) throw new CustomInvalidError({ errors, warnings: validation.warnings });
  const source = req.source;
  const crf = req.crf ?? 31;
  const frames = Math.round(duration * fps);
  const workers = Math.max(1, Math.min(req.workers ?? 4, 16, frames));
  const kitIn = effectiveKit(source, req.kit).kit;
  const kit = usesKit(source) ? kitHtml(kitIn) : null;
  // custom code opts in to fit-to-duration by declaring `fit` (recorded replays render bit-identically without it)
  const fit = m && typeof m.fit === "number" ? fitFor(m.fit, m.duration, duration, req.fit !== false) : 0;
  const inputHash = customHash({ source, values: validation.values, width, height, fps, duration, crf, workers, kit, fit });
  const manifest: CompositionManifest = m
    ? { ...m }
    : {
        name: "custom",
        title: "Custom composition",
        description: "A custom composition written in the editor.",
        duration,
        size: [width, height],
        fps,
        params: {},
      };
  const prep: Prepared = {
    html: injectKit(source, kitIn).replace(runtimeScript(), ""),
    htmlPath: `custom:${sha256(source).slice(0, 16)}`,
    manifest,
    values: validation.values,
    pageValues: validation.values,
    width,
    height,
    fps,
    duration,
    frames,
    format: "webm",
    crf,
    workers,
    fit,
    warnings: validation.warnings,
    inputHash,
    // <!-- rc-lib gsap three … -->: offline libraries injected after the runtime (libs.ts; anim-runtime, wave 7)
    ...(libsIn(source).libs.length ? { libs: libsIn(source).libs } : {}),
  };
  return { prep, validation };
}

// ---------------------------------------------------------------- render, network blocked

/**
 * Every URL scheme that can leave the page (or read the disk). `data:` (bytes already inside the page), `blob:` (made
 * by the page itself) and `about:` are not in it: blocking `*` also blocked `data:` images, so a custom composition
 * could not show a picture it carried (warm-moody recreation #59, SEEN 2026-10-20: "image failed to load: data:…").
 */
export const BLOCKED_SCHEMES = ["http", "https", "ws", "wss", "ftp", "file", "filesystem", "chrome", "chrome-extension", "chrome-untrusted", "devtools", "javascript"] as const;

/**
 * Block every request from a tab that could reach a network or a disk, and record what was attempted: the
 * blocked-URL list (one pattern per scheme), plus Fetch interception on the same schemes that fails anything that
 * still gets through (a paused request must be answered, so every pause is failed). Behind both sit the dead proxy
 * and DNS-off flags (NO_NETWORK_FLAGS).
 */
export async function blockNetwork(browser: Browser, page: Page, attempts: string[]): Promise<void> {
  const note = (url: unknown) => {
    const u = String(url ?? "");
    if (!u || /^(data|about|blob):/i.test(u)) return;
    if (!attempts.includes(u) && attempts.length < 50) attempts.push(u);
  };
  browser.on("Network.requestWillBeSent", page.sessionId, (p) => note((p.request as { url?: string } | undefined)?.url));
  browser.on("Network.webSocketCreated", page.sessionId, (p) => note(p.url));
  browser.on("Fetch.requestPaused", page.sessionId, (p) => {
    const url = String((p.request as { url?: string } | undefined)?.url ?? "");
    note(url);
    // a data:/blob: request that Fetch paused anyway carries no network: let it through; everything else fails
    if (/^(data|blob):/i.test(url)) void page.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
    else void page.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }).catch(() => {});
  });
  await page.send("Network.enable");
  await page.send("Network.setBlockedURLs", { urls: BLOCKED_SCHEMES.map((s) => `${s}:*`) });
  await page.send("Fetch.enable", { patterns: BLOCKED_SCHEMES.map((s) => ({ urlPattern: `${s}:*` })) });
}

/** A prepared custom page as a data: URL (opaque origin: no file:// access, nothing same-origin to reach). */
export function dataUrlOf(html: string): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`;
}

/** Open a prepared custom composition in a network-blocked tab. Exported for tests (it does not validate). */
export function openCustomPage(browser: Browser, prep: Prepared, attempts: string[]): Promise<Page> {
  return openPage(browser, prep, { url: dataUrlOf(prep.html), before: (page) => blockNetwork(browser, page, attempts) });
}

export interface CustomRenderResult extends RenderResult {
  validation: CustomValidation;
  /** URLs the page tried to load during the render (all were blocked). */
  blocked: string[];
}

/** Validate, then render frame by frame with the network blocked, to `out` (.webm). Writes the sidecar next to it. */
export async function renderCustom(
  req: CustomRequest & { out: string; chrome?: string; onProgress?: (done: number, total: number) => void },
): Promise<CustomRenderResult> {
  const t0 = performance.now();
  const { prep, validation } = prepareCustom(req);
  const blocked: string[] = [];
  const result = await renderWith(prep, { out: req.out, chrome: req.chrome, onProgress: req.onProgress }, {
    t0,
    open: (browser) => openCustomPage(browser, prep, blocked),
    launchFlags: NO_NETWORK_FLAGS,
    // `blocked` fills while rendering; the sidecar is serialised after the last frame.
    sidecar: {
      composition: prep.manifest.name,
      custom: true,
      source: prep.htmlPath,
      sourceSha256: sha256(req.source),
      ...(usesKit(req.source) ? { kitSha256: sha256(kitHtml(effectiveKit(req.source, req.kit).kit) ?? ""), kitFrom: effectiveKit(req.source, req.kit).from } : {}),
      network: "blocked",
      blocked,
    },
  });
  return { ...result, validation, blocked };
}

// ---------------------------------------------------------------- the editor service (cached by hash)

/** Custom renders live apart from library renders: <cache>/custom/<hash>.webm (+ .webm.json). */
export function customCacheDir(): string {
  return join(process.env.RESTORFFCUT_COMPOSITIONS_CACHE || join(PKG_ROOT, "out", "editor-cache"), "custom");
}

export interface CustomRenderAnswer {
  hash: string;
  file: string;
  cached: boolean;
  name: string;
  title: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  frames: number;
  bytes: number;
  params: ParamValues;
  /** Natural length the animation clock was fitted from (0 = none: no `fit` declared, or long enough). */
  fit: number;
  /** Animation seconds per real second: max(speed, fit / duration). */
  rate: number;
  /** True when the source included the timeline kit (its sha is in the hash and the sidecar). */
  kit: boolean;
  /** composition-v3: sha256 of the kit HTML it rendered with, and where that kit came from (sent, or a library kit). */
  kitSha?: string;
  kitFrom?: "request" | `library:${string}` | null;
  ms: number;
  report: {
    errors: string[];
    warnings: string[];
    protocol: CustomValidation["protocol"];
    sourceBytes: number;
    network: "blocked";
    /** URLs the page tried to load during the render (all blocked). */
    blocked: string[];
  };
}

export async function renderCustomCached(req: CustomRequest): Promise<CustomRenderAnswer> {
  const t0 = performance.now();
  const { prep, validation } = prepareCustom(req);
  const dir = customCacheDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${prep.inputHash}.webm`);
  const answer = (cached: boolean, bytes: number, blocked: string[]): CustomRenderAnswer => ({
    hash: prep.inputHash,
    file,
    cached,
    name: prep.manifest.name,
    title: prep.manifest.title,
    duration: prep.duration,
    width: prep.width,
    height: prep.height,
    fps: prep.fps,
    frames: prep.frames,
    bytes,
    params: prep.values,
    fit: prep.fit,
    rate: +rateFor(prep.values, prep.fit, prep.duration).toFixed(4),
    kit: usesKit(req.source),
    ...(usesKit(req.source)
      ? (() => {
          const eff = effectiveKit(req.source, req.kit);
          return { kitSha: sha256(kitHtml(eff.kit) ?? ""), kitFrom: eff.from };
        })()
      : {}),
    ms: Math.round(performance.now() - t0),
    report: { errors: [], warnings: validation.warnings, protocol: validation.protocol, sourceBytes: validation.bytes, network: "blocked", blocked },
  });
  if (existsSync(file) && existsSync(`${file}.json`)) {
    let blocked: string[] = [];
    try {
      blocked = (JSON.parse(readFileSync(`${file}.json`, "utf8")) as { blocked?: string[] }).blocked ?? [];
    } catch {
      /* an unreadable sidecar only loses the blocked list */
    }
    return answer(true, statSync(file).size, blocked);
  }
  // Render under a unique name, then rename into place: two requests for the same hash never write one file.
  const tmp = join(dir, `${prep.inputHash}.${process.pid}-${Date.now().toString(36)}.tmp.webm`);
  try {
    const r = await renderCustom({ ...req, out: tmp });
    renameSync(tmp, file);
    const side = JSON.parse(readFileSync(`${tmp}.json`, "utf8")) as Record<string, unknown>;
    writeFileSync(`${file}.json`, `${JSON.stringify({ ...side, out: file, sidecar: `${file}.json` }, null, 2)}\n`);
    rmSync(`${tmp}.json`, { force: true });
    return answer(false, r.bytes, r.blocked);
  } finally {
    rmSync(tmp, { force: true });
    rmSync(`${tmp}.json`, { force: true });
  }
}

export interface CustomNudgeAnswer {
  props: ParamValues;
  changes: Change[];
  skipped: string[];
}

/** "slower, bigger, make it red" on a custom composition: needs a params block with the standard params (CONTRACT §2). */
export function nudgeCustom(req: { source: string; props?: ParamValues; sentence: string; kit?: CustomKitInput | null }): CustomNudgeAnswer {
  // a sentence only reads the params block: a kit that was not sent along is not a reason to refuse
  const kit = req.kit ?? (typeof req.source === "string" && usesKit(req.source) ? "<!-- kit not sent: a nudge reads only the params block -->" : undefined);
  const v = validateCustom(req.source, req.props ?? {}, { kit });
  if (!v.manifest) throw new Error("this composition has no params block, so a sentence has nothing to change: edit its code or props");
  if (!v.ok) throw new CustomInvalidError(v);
  const manifest: CompositionManifest = { ...v.manifest };
  const r = nudge(manifest, v.values, String(req.sentence ?? ""));
  const next: ParamValues = { ...stripMeta(req.props ?? {}) };
  for (const c of r.changes) next[c.key] = c.to;
  return { props: next, changes: r.changes, skipped: r.skipped };
}

/** What the editor's live preview needs to run a composition in a sandboxed iframe exactly as the renderer does. */
export function customKit(): {
  runtime: string;
  fontData: Record<string, string>;
  renderer: string;
  /** Small offline libraries by marker name, for the preview to inline when the source says <!-- rc-lib name -->. */
  libs: Record<string, string>;
  limits: { maxBytes: number; maxSeconds: number; kitMaxBytes: number; imageMaxBytes: number; propsMaxBytes: number };
  defaults: typeof CUSTOM_DEFAULTS;
} {
  return {
    // the runtime plus the HyperFrames page protocol, as the renderer injects them (anim-runtime, wave 7)
    runtime: readFileSync(RUNTIME_PATH, "utf8") + hfProtocolScript(),
    fontData: bundledFontData(),
    renderer: RENDERER_VERSION,
    // the Three.js builds (0.6–0.8 MB) are left out of the kit answer; the renderer still injects them
    libs: { gsap: libScript(["gsap"]), lottie: libScript(["lottie"]), anime: libScript(["anime"]) },
    limits: { maxBytes: CUSTOM_MAX_BYTES, maxSeconds: CUSTOM_MAX_SECONDS, kitMaxBytes: KIT_MAX_BYTES, imageMaxBytes: CUSTOM_MAX_IMAGE_BYTES, propsMaxBytes: CUSTOM_MAX_PROPS_BYTES },
    defaults: CUSTOM_DEFAULTS,
  };
}

export interface CustomExample {
  name: string;
  title: string;
  description: string;
  duration: number;
  size: [number, number];
  /** Path relative to the package root. */
  file: string;
  source: string;
  props: ParamValues;
}

/** The worked examples in examples/custom/ (starters in the Code view, test inputs, documentation). */
export function listCustomExamples(): CustomExample[] {
  if (!existsSync(EXAMPLES_DIR)) return [];
  const out: CustomExample[] = [];
  for (const f of readdirSync(EXAMPLES_DIR).sort()) {
    if (!f.endsWith(".html")) continue;
    const source = readFileSync(join(EXAMPLES_DIR, f), "utf8");
    const propsFile = join(EXAMPLES_DIR, f.replace(/\.html$/, ".props.json"));
    const props = existsSync(propsFile) ? stripMeta(JSON.parse(readFileSync(propsFile, "utf8")) as ParamValues) : {};
    const v = validateCustom(source, props);
    out.push({
      name: v.manifest?.name ?? basename(f, ".html"),
      title: v.manifest?.title ?? basename(f, ".html"),
      description: v.manifest?.description ?? "",
      duration: v.manifest?.duration ?? CUSTOM_DEFAULTS.duration,
      size: v.manifest?.size ?? [CUSTOM_DEFAULTS.width, CUSTOM_DEFAULTS.height],
      file: `examples/custom/${f}`,
      source,
      props,
    });
  }
  return out;
}

/**
 * What a composition can DECLARE besides its params (composition-v3, CONTRACT.md §9d): sound cues, scene cuts,
 * on-screen text, opacity. Returned by `custom-contract` (MCP `composition contract`) so nobody has to read the source
 * of sound design or the export gate to find them. The cue kinds and their sounds come from the server (apps/web).
 */
export const CONTRACT_DECLARATIONS = {
  cues: {
    what: "Sound cues inside the composition: `sounds design` puts a sound on each one (typing, a stamp, an ignite, a beat word) instead of guessing from the picture.",
    static: "params block: \"cues\": [{\"t\": 0.4, \"kind\": \"stamp\", \"label\": \"the stamp lands\", \"sound\": \"stamp-slam\"}]. t = seconds of ANIMATION time from the clip's start (real time = t / speed), or \"from_end\": seconds before the clip's end (exits). For times that never change.",
    computed: "in build(): window.__rcCues = [{t, kind, label?, sound?}] with t = REAL seconds into the clip, computed from the params (a piece whose times are params must use this: its cues move with them). Push them once, in build, not in render. The renderer writes them into the render's sidecar as `cues`; sound design reads, first hit wins: the render's cues > the params block's cues > events measured in the frames.",
    fields: { t: "number >= 0 (or from_end instead)", from_end: "number >= 0: seconds before the clip's end", kind: "what happens: see cue_kinds (an unknown kind gets a light pop)", label: "optional, at most 60 characters, shown in the plan", sound: "optional pack sound id (sounds list): wins over the kind's default" },
    limit: 64,
  },
  scenes: {
    what: "Scene boundaries inside one composition, so the export gate counts picture changes (rhythm R1/R5/R6) instead of one long shot per clip.",
    how: "params block (or the clip's props): \"scenes\": [2.1, 4.5] = seconds from the composition's start where a new scene begins (objects with a numeric `t` work too). Undeclared, the gate measures cuts in the render's frames.",
    caution: "A PARAM named `scenes` is read the same way: give its items a numeric `t` (clip seconds), or call the param something else.",
  },
  text: {
    what: "The on-screen text, so the gate can check the hook text, safe areas and caption length.",
    how: "params block (or props): \"text\": [{\"content\": \"STEEPED, NOT RUSHED.\", \"t\": 5.6, \"t_end\": 8.1, \"role\": \"headline\" | \"label\" | \"caption\", \"box\": [x0, y0, x1, y1] (0..1 of the frame)}]. Undeclared, the gate reads the string params (list items with `at` / `t` / `start` are timed by them, in clip seconds).",
  },
  opaque: "params block: \"opaque\": true when the composition paints the whole frame (it is the picture, not an overlay); the gate and sound design then treat its edges as cuts.",
  kit: "params block: \"kit\": \"<library kit>\" (packages/compositions/kits/<name>.js) + <!-- rc-kit --> in <head>: the kit's code runs before the page's own scripts. A timeline kit that is set wins (MCP composition kit).",
} as const;

/** The contract in a few lines, for a Claude about to write one (MCP `composition contract`). */
export const CUSTOM_CONTRACT = [
  "A custom composition is ONE self-contained HTML file whose picture is a pure function of time. It renders frame by frame in headless Chromium to a transparent WebM (VP9 alpha) that sits on the MOTION track over the footage.",
  "Skeleton: <script type=\"application/json\" id=\"params\">{\"name\":\"kebab-id\",\"title\":\"…\",\"description\":\"…\",\"duration\":4,\"size\":[1080,1920],\"params\":{\"word\":{\"type\":\"string\",\"default\":\"STEEP\",\"description\":\"what it means\"}}}</script> then <div id=\"stage\"></div> and <script>RC.composition({ build: function (RC) { /* once: make DOM from RC.params */ }, render: function (time, RC) { /* every frame: set styles from time.t only */ } });</script>. The runtime is injected for you (do not load it).",
  "time = { T (real seconds since start), t (animation time = T × rate), left (animation seconds until the last frame: use for exits), p (T / duration), frame, rate }. rate = the speed param, raised to fit / duration when the params block declares \"fit\": <seconds every beat needs> and the clip is shorter (fit-to-duration). Anything timed to the voice uses T; its own little animation may use (T - at) × time.rate. Seek can happen in any order: render must depend on time and RC.params only.",
  "Helpers on RC: progress(t, start, dur, ease), tween(t, start, dur, from, to, ease), mix, clamp, ease(name, x), random(seed) (the only randomness), alpha(hex, a), mixColor, el(tag, attrs, children), set(node, {x, y, scale, rotate, rx, ry, opacity, blur, clip}), fitText(node, maxW, maxPx, minPx). Values: RC.params, RC.width, RC.height, RC.u (= min(w,h)/1080: draw on a 1080 grid), RC.safe {top,bottom,left,right}, RC.fps, RC.duration. Easings: linear smooth gentle snappy bouncy springy elastic bounce ease-in.",
  "Param types: string text number(min,max,step) color(#hex) boolean enum(options) easing font(Archivo | JetBrains Mono | Instrument Serif) image(data:image/… URL only, each ≤ 4 MB; they load and decode before frame 0) list(of) object(fields). Standard names make sentence edits work: speed, scale, ease, accent, anchor, offsetY, exit.",
  "Shared code (the timeline kit): helpers and styles several compositions of one timeline use are written ONCE as the timeline's kit ({css, js} or HTML, ≤ 128 KB, same rules) and included by putting <!-- rc-kit --> in <head>; the kit's code then runs before the page's scripts. Its sha is part of each including render's hash, so a kit fix re-renders exactly those clips. A source with the marker and no kit is refused, unless its params block names a library kit (\"kit\": \"neon-grid\"), which is then used.",
  "Declarations (besides params, all optional): \"cues\" (sound cues; or window.__rcCues = [{t, kind, label}] set in build when the times come from params), \"scenes\" (scene boundaries in seconds), \"text\" (the on-screen words the gate checks), \"opaque\": true (paints the whole frame). Formats: the contract answer's `declarations`.",
  "Make it replicable: put EVERY on-screen word and every story time in params (neutral names: lines[], keyword, numbers, a ruler {from, to, marks}…), never as literals in the code; time items from the voice-over's word timings (a `words` [{w, s, e}] param) so a new script re-times the piece without touching the code.",
  "Refused: fetch / XMLHttpRequest / WebSocket / import() / workers, any src/href/url() that is not data: or #, <iframe>/<link>/<object>, navigation, storage APIs, Date / performance.now / Math.random / requestAnimationFrame / timers, <video>/<audio>, more than 256 KB. The network is blocked while rendering anyway (data: and blob: still load). Warned: CSS transition, will-change, translate3d/translateZ.",
  "Look: transparent background (never paint the full frame unless it should cover the video); fonts Archivo (display: weight 800–900, font-stretch 125%, uppercase, letter-spacing .14em), JetBrains Mono (numbers, pills), Instrument Serif (editorial); palette screen #0C0C0E, bone #EDEBE6, fog #8C8C95, neon #F6FF00 = the one isolate per frame, kiln #C8553D = Claude's presence. Text over video needs a shadow, stroke or dark card. Keep text inside RC.safe. Fictional content only (Halcyon Cold Brew). Never \"Amazing!\".",
  "Also accepted (HyperFrames page protocol): a page that sets window.__hf = { duration, seek(t) } itself instead of calling RC.composition.",
  "Animation libraries, offline (no RC.composition needed): put <!-- rc-lib gsap --> (also three, three-r147, lottie, anime) in <head>; the global is there before your scripts (never a <script src>). GSAP API (our MIT compat: timelines, from/fromTo/set/call, every position form, stagger, keyframes, eases, gsap.utils with seeded random, CustomEase, MotionPath, SplitText, DrawSVG, Text): build var tl = gsap.timeline({ paused: true }) and register window.__timelines[\"id\"] = tl — the runtime seeks it every frame. Three.js: draw in window.addEventListener(\"hf-seek\", e => …e.detail.time…). Lottie: window.__hfLottie.push(lottie.loadAnimation({ …, autoplay: false, animationData })). Anime.js v4: window.__hfAnime.push(anime.animate(…, { autoplay: false })). No Math.random, clocks or timers here either.",
].join("\n");
