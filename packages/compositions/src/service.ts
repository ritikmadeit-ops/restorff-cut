// The editor-facing service: one JSON request in, one JSON answer out (catalogue · render with a cache · nudge).
//
// apps/web's /api/compositions routes run it as a child process — `node packages/compositions/src/cli.ts api <verb>`
// with the request on stdin and the answer on stdout — so the web server never bundles the Chromium/FFmpeg code and
// a crashed render cannot take the web server down. Tests and other Node/Bun code can import these functions directly.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { listLibraryKits, readLibraryKit } from "./kits.ts";
import {
  CONTRACT_DECLARATIONS,
  CUSTOM_CONTRACT,
  CUSTOM_MAX_BYTES,
  CUSTOM_MAX_IMAGE_BYTES,
  CUSTOM_MAX_PROPS_BYTES,
  CUSTOM_MAX_SECONDS,
  customKit,
  KIT_MARKER,
  KIT_MAX_BYTES,
  listCustomExamples,
  nudgeCustom,
  renderCustomCached,
  validateCustom,
  validateKit,
  type CustomKitInput,
  type CustomRequest,
} from "./custom.ts";
import { nudge, type Change } from "./edits.ts";
import { listLibrary, type LibraryEntry } from "./library.ts";
import { blankOf, describeNeeds, isDisplay, isRequired, parseManifest, resolveApplied, resolveParams } from "./params.ts";
import { PKG_ROOT, prepare, rateFor, render } from "./render.ts";
import type { CompositionManifest, ParamSpec, ParamValues } from "./types.ts";

/** Where editor renders are cached, one `<inputHash>.webm` (+ `.webm.json` sidecar) per distinct input. Git-ignored. */
export const DEFAULT_CACHE_DIR = join(PKG_ROOT, "out", "editor-cache");

export function cacheDir(): string {
  return process.env.RESTORFFCUT_COMPOSITIONS_CACHE || DEFAULT_CACHE_DIR;
}

export interface CatalogueEntry {
  name: string;
  title: string;
  description: string;
  tags: string[];
  duration: number;
  size: [number, number];
  fps: number;
  /** Fit-to-duration: the natural length (s) a shorter render is compressed from; false = never (CONTRACT §3b). */
  fit: number | false;
  /**
   * The params as an APPLY sees them: a display param's `default` is its blank ("" / []) and it carries
   * `display: true` (+ `required: true` when an apply must send it). Its gallery copy is only in `sample`: `effects
   * describe` shows these specs to a model, and invented copy there (press headlines) invites copying it.
   */
  params: Record<string, ParamSpec>;
  /**
   * The example props an apply may start from (merged under what the caller sends): the props file WITHOUT its
   * display params (CONTRACT §2c). Fictional Halcyon content.
   */
  example: ParamValues;
  /** The full gallery example (display copy included): what `samples/<name>.webm` shows. Never merge it into an apply. */
  sample: ParamValues;
  /** Params that put words (or data) on screen: an apply that omits one gets "" / [], never the example copy. */
  display: string[];
  /** Display params an apply must send (else the render answers `needs`). */
  required: string[];
  /** True when `samples/<name>.webm` exists (the editor shows it as a looping preview). */
  hasSample: boolean;
  /** The manifest's `effect` block (layer recipe: stack, inputs, plate keys), when it has one. */
  effect?: unknown;
  /** Where an imported composition came from (fx-sync 2026-10-24): source, upstream, path, commit, licence, author. */
  provenance?: Record<string, unknown>;
}

/** A manifest's params as an apply sees them: display defaults blanked (the gallery copy lives only in `sample`). */
export function appliedParams(m: CompositionManifest): Record<string, ParamSpec> {
  const out: Record<string, ParamSpec> = {};
  for (const [k, spec] of Object.entries(m.params)) {
    if (!isDisplay(spec)) {
      out[k] = spec;
      continue;
    }
    const blank = blankOf(spec);
    // a non-blankable display param (an image, a number that is data) is required: no example value is shown either
    const { default: _example, ...rest } = spec;
    out[k] = {
      ...rest,
      ...(blank !== null ? { default: blank } : {}),
      display: true,
      ...(isRequired(spec) ? { required: true } : {}),
    } as ParamSpec;
  }
  return out;
}

/** Drop `$comment`-style keys: they are notes in a props file, never params. */
export function stripMeta(props: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const [k, v] of Object.entries(props)) if (!k.startsWith("$")) out[k] = v;
  return out;
}

export function catalogue(): CatalogueEntry[] {
  return listLibrary().map((e) => {
    const m = parseManifest(readFileSync(e.html, "utf8"));
    const sample = e.props ? stripMeta(JSON.parse(readFileSync(e.props, "utf8")) as ParamValues) : {};
    const display = Object.keys(m.params).filter((k) => isDisplay(m.params[k] as ParamSpec));
    // what an apply may inherit: never the example's on-screen words (Doodle Boil's "small batch" on a face, E-6)
    const example: ParamValues = {};
    for (const [k, v] of Object.entries(sample)) if (!display.includes(k)) example[k] = v;
    return {
      name: m.name,
      title: m.title,
      description: m.description,
      tags: m.tags ?? [],
      duration: m.duration,
      size: m.size,
      fps: m.fps ?? 30,
      fit: m.fit === false ? false : (m.fit ?? m.duration),
      params: appliedParams(m),
      example,
      sample,
      display,
      required: display.filter((k) => isRequired(m.params[k] as ParamSpec)),
      hasSample: existsSync(e.sample),
      // the layer recipe reaches the editor's drop and MCP effects apply (effects-layers agent, 2026-10-20)
      ...((m as { effect?: unknown }).effect ? { effect: (m as { effect?: unknown }).effect } : {}),
      // fx-sync imports carry their source and licence (tools/fx-sync; NOTICE)
      ...((m as { provenance?: Record<string, unknown> }).provenance ? { provenance: (m as { provenance?: Record<string, unknown> }).provenance } : {}),
    };
  });
}

/** A library entry by name. Names are kebab-case ids; anything else is refused (no paths from the network). */
export function entryFor(name: string): LibraryEntry {
  if (typeof name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error(`bad composition name "${name}"`);
  const e = listLibrary().find((x) => x.name === name);
  if (!e) throw new Error(`no composition "${name}" in the library`);
  return e;
}

/**
 * Image params that arrive from the editor may only be data:/http(s): URLs or relative paths that stay inside the
 * composition's own folder — never an absolute path or file: URL (the editor is a web page; it must not read the
 * server's disk through a param).
 */
export function checkImages(spec: ParamSpec, value: unknown, baseDir: string, path: string, errors: string[]): void {
  if (spec.type === "image") {
    if (typeof value !== "string" || /^(data:|https?:)/i.test(value)) return;
    if (/^file:/i.test(value) || isAbsolute(value)) {
      // mcp-gaps-mvp (2026-10-24): say what to send instead (a client with no shell can't make a data: URL)
      errors.push(
        `${path}: a file path can't be read by the render: import the file first (RestorffCut MCP: media import {path_hint | url | upload}) and send its media_id, or send a data: or https: URL`,
      );
      return;
    }
    const rel = relative(baseDir, resolve(baseDir, value));
    if (rel.startsWith("..") || isAbsolute(rel)) errors.push(`${path}: path leaves the composition folder`);
    return;
  }
  if (spec.type === "list" && Array.isArray(value)) {
    value.forEach((v, i) => checkImages(spec.of, v, baseDir, `${path}[${i}]`, errors));
    return;
  }
  if (spec.type === "object" && value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const fs = spec.fields[k];
      if (fs) checkImages(fs, v, baseDir, `${path}.${k}`, errors);
    }
  }
}

export interface RenderRequest {
  name: string;
  props?: ParamValues;
  /** Seconds; default = the composition's own duration. */
  duration?: number;
  /** Output size; default = the composition's size. The editor sends its canvas size (even integers). */
  width?: number;
  height?: number;
  fps?: number;
  workers?: number;
  /** Fit-to-duration (default true): a duration shorter than the composition's `fit` compresses its clock. */
  fit?: boolean;
}

/**
 * An applied render without the words it must show. The message says what to send (a model reads it); `details`
 * carries `{ needs: [keys], params: {key: spec} }` for code.
 */
export class NeedsError extends Error {
  readonly details: { needs: string[]; params: Record<string, ParamSpec> };
  constructor(name: string, m: CompositionManifest, needs: string[]) {
    super(
      `${name} needs: ${needs.join(", ")}. An applied composition never uses the example's on-screen words; send what goes on screen:\n  - ${describeNeeds(m, needs).join("\n  - ")}`,
    );
    const params = appliedParams(m);
    this.details = { needs, params: Object.fromEntries(needs.map((k) => [k, params[k] as ParamSpec])) };
  }
}

export interface RenderAnswer {
  name: string;
  /** The render's inputHash: same request → same hash → same file (the cache key). */
  hash: string;
  file: string;
  cached: boolean;
  duration: number;
  width: number;
  height: number;
  fps: number;
  frames: number;
  bytes: number;
  /** The validated params the render used (defaults filled in). */
  params: ParamValues;
  /** Display params the request did not send: rendered blank, never with the example copy. */
  blanked: string[];
  /** Natural length (s) the clock was fitted from; 0 = played as designed. */
  fit: number;
  /** Animation seconds per real second: max(speed, fit / duration). */
  rate: number;
  /** Wall time of this request in ms (≈ 0 on a cache hit). */
  ms: number;
}

/** Round a requested size to even integers (yuva420p) and keep it sane. */
function evenSize(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  const v = Math.round(n / 2) * 2;
  return Math.max(2, Math.min(v, 4096));
}

export async function renderCached(req: RenderRequest): Promise<RenderAnswer> {
  const t0 = performance.now();
  const e = entryFor(req.name);
  const given = stripMeta(req.props ?? {});
  const manifest = parseManifest(readFileSync(e.html, "utf8"));
  const baseDir = dirname(e.html);
  const errors: string[] = [];
  for (const [k, v] of Object.entries(given)) {
    const spec = manifest.params[k];
    if (spec) checkImages(spec, v, baseDir, k, errors);
  }
  if (errors.length) throw new Error(`${e.name}\n  - ${errors.join("\n  - ")}`);
  // an applied render: on-screen words come from the request only (CONTRACT §2c)
  const applied = resolveApplied(manifest, given);
  if (applied.needs.length) throw new NeedsError(e.name, manifest, applied.needs);
  const props: ParamValues = { ...given };
  for (const k of applied.blanked) props[k] = applied.values[k];

  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const base = {
    composition: e.html,
    props,
    propsDir: baseDir,
    duration: req.duration,
    fps: req.fps,
    width: evenSize(req.width),
    height: evenSize(req.height),
    workers: req.workers,
    fit: req.fit !== false,
    format: "webm" as const,
  };
  const prep = prepare({ ...base, out: join(dir, "check.webm") });
  const file = join(dir, `${prep.inputHash}.webm`);
  const answer = (cached: boolean, bytes: number): RenderAnswer => ({
    name: e.name,
    hash: prep.inputHash,
    file,
    cached,
    duration: prep.duration,
    width: prep.width,
    height: prep.height,
    fps: prep.fps,
    frames: prep.frames,
    bytes,
    params: prep.values,
    blanked: applied.blanked,
    fit: prep.fit,
    rate: +rateFor(prep.values, prep.fit, prep.duration).toFixed(4),
    ms: Math.round(performance.now() - t0),
  });
  if (existsSync(file) && existsSync(`${file}.json`)) return answer(true, statSync(file).size);

  // Render under a unique name, then rename into place: two requests for the same hash never write one file.
  const tmp = join(dir, `${prep.inputHash}.${process.pid}-${Date.now().toString(36)}.tmp.webm`);
  try {
    const r = await render({ ...base, out: tmp });
    renameSync(tmp, file);
    const side = JSON.parse(readFileSync(`${tmp}.json`, "utf8")) as Record<string, unknown>;
    writeFileSync(`${file}.json`, `${JSON.stringify({ ...side, out: file, sidecar: `${file}.json` }, null, 2)}\n`);
    rmSync(`${tmp}.json`, { force: true });
    return answer(false, r.bytes);
  } finally {
    rmSync(tmp, { force: true });
    rmSync(`${tmp}.json`, { force: true });
  }
}

export interface NudgeRequest {
  name: string;
  props?: ParamValues;
  sentence: string;
}

export interface NudgeAnswer {
  /** The props to render next: the request's props with every change applied. */
  props: ParamValues;
  changes: Change[];
  skipped: string[];
}

/** "slower, bigger and make it red" → new props (CONTRACT.md §4). Throws when nothing in the sentence maps to a param. */
export function nudgeRequest(req: NudgeRequest): NudgeAnswer {
  const e = entryFor(req.name);
  const m = parseManifest(readFileSync(e.html, "utf8"));
  const props = stripMeta(req.props ?? {});
  const { values, errors } = resolveParams(m, props);
  if (errors.length) throw new Error(`current props are invalid:\n  - ${errors.join("\n  - ")}`);
  const r = nudge(m, values, String(req.sentence ?? ""));
  const next: ParamValues = { ...props };
  for (const c of r.changes) next[c.key] = c.to;
  return { props: next, changes: r.changes, skipped: r.skipped };
}

export type ApiVerb =
  | "catalogue"
  | "render"
  | "nudge"
  | "custom-validate"
  | "custom-render"
  | "custom-nudge"
  | "custom-kit"
  | "custom-examples"
  | "custom-contract"
  | "kit-validate"
  | "library-kit"
  | "library-kits";

/** The timeline kit from a request body: `kit` as HTML text or `{ css?, js?, html? }`. */
function kitOf(body: Record<string, unknown>): CustomKitInput | undefined {
  const k = body.kit;
  if (typeof k === "string") return k;
  if (k && typeof k === "object" && !Array.isArray(k)) return k as CustomKitInput;
  return undefined;
}

/** Body fields of a custom request, from the editor or the MCP tool (`duration_s` is accepted as `duration`). */
function customRequest(body: Record<string, unknown>): CustomRequest {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    source: typeof body.source === "string" ? body.source : "",
    props: body.props && typeof body.props === "object" && !Array.isArray(body.props) ? (body.props as ParamValues) : {},
    duration: num(body.duration_s) ?? num(body.duration),
    width: num(body.width),
    height: num(body.height),
    fps: num(body.fps),
    workers: num(body.workers),
    kit: kitOf(body),
    fit: body.fit === false ? false : undefined,
  };
}

/** Dispatch one request. The CLI's `api` command wraps this: stdin JSON → `{ ok, result | error }` on stdout. */
export async function handle(verb: string, request: unknown): Promise<unknown> {
  const body = (request && typeof request === "object" ? request : {}) as Record<string, unknown>;
  switch (verb) {
    case "catalogue":
      return catalogue();
    case "render":
      return renderCached(body as unknown as RenderRequest);
    case "nudge":
      return nudgeRequest(body as unknown as NudgeRequest);
    case "custom-validate": {
      const v = validateCustom(body.source, body.props ?? {}, { kit: kitOf(body) });
      return { ok: v.ok, errors: v.errors, warnings: v.warnings, manifest: v.manifest, values: v.values, protocol: v.protocol, bytes: v.bytes };
    }
    case "custom-render":
      return renderCustomCached(customRequest(body));
    case "custom-nudge":
      return nudgeCustom({ source: String(body.source ?? ""), props: customRequest(body).props, sentence: String(body.sentence ?? ""), kit: kitOf(body) });
    case "kit-validate":
      return validateKit(body.kit);
    // composition-v3: library kits (kits/<name>.js), for MCP `composition kit {library_kit}` and the contract
    case "library-kit": {
      const k = readLibraryKit(String(body.name ?? ""));
      if (!k) throw new Error(`no library kit "${String(body.name ?? "")}" (kits: ${listLibraryKits().map((x) => x.name).join(", ") || "none"})`);
      return k;
    }
    case "library-kits":
      return listLibraryKits().map((k) => ({ name: k.name, bytes: k.bytes, sha: k.sha, description: k.description }));
    case "custom-kit":
      return customKit();
    case "custom-examples":
      return listCustomExamples();
    case "custom-contract": {
      const examples = listCustomExamples();
      const first = examples.find((e) => e.name === "kinetic-type") ?? examples[0];
      return {
        contract: CUSTOM_CONTRACT,
        limits: { maxBytes: CUSTOM_MAX_BYTES, maxSeconds: CUSTOM_MAX_SECONDS, kitMaxBytes: KIT_MAX_BYTES, imageMaxBytes: CUSTOM_MAX_IMAGE_BYTES, propsMaxBytes: CUSTOM_MAX_PROPS_BYTES },
        kit: { marker: KIT_MARKER, send: "kit: { css?, js?, html? } (or HTML text) with every custom-validate / custom-render / custom-nudge of the timeline" },
        declarations: CONTRACT_DECLARATIONS,
        library_kits: listLibraryKits().map((k) => ({
          name: k.name,
          bytes: k.bytes,
          description: k.description,
          used_by: listLibrary()
            .filter((e) => {
              try {
                return parseManifest(readFileSync(e.html, "utf8")).kit === k.name;
              } catch {
                return false;
              }
            })
            .map((e) => e.name),
        })),
        examples: examples.map((e) => ({ name: e.name, title: e.title, description: e.description, duration: e.duration, file: e.file })),
        example: first ? { name: first.name, source: first.source, props: first.props } : null,
      };
    }
    default:
      throw new Error(`unknown api verb "${verb}" (catalogue · render · nudge · custom-validate · custom-render · custom-nudge · custom-kit · custom-examples · custom-contract · kit-validate · library-kit · library-kits)`);
  }
}
