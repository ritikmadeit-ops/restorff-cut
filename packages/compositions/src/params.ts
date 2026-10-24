// Parse, validate and merge composition params. Pure functions: no DOM, no browser, no file IO.
import { EASINGS, FONTS } from "./types.ts";
import type { CompositionManifest, ParamSpec, ParamValues } from "./types.ts";

const PARAM_TYPES = new Set([
  "string", "text", "number", "color", "boolean", "enum", "easing", "font", "image", "list", "object",
]);
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY = /^[A-Za-z][A-Za-z0-9]*$/;

/** Find `<script type="application/json" id="params">…</script>` (attributes in any order) and return its text. */
export function extractParamsBlock(html: string): string | null {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = m[1] ?? "";
    if (/\bid\s*=\s*["']params["']/i.test(attrs) && /\btype\s*=\s*["']application\/json["']/i.test(attrs)) {
      return m[2] ?? "";
    }
  }
  return null;
}

/** Parse the manifest from a composition's HTML. Throws with a readable message when it is missing or not JSON. */
export function parseManifest(html: string): CompositionManifest {
  const block = extractParamsBlock(html);
  if (block == null) {
    throw new Error('no <script type="application/json" id="params"> block found (CONTRACT.md §2)');
  }
  try {
    return JSON.parse(block) as CompositionManifest;
  } catch (e) {
    throw new Error(`params block is not valid JSON: ${(e as Error).message}`);
  }
}

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

/** Validate one value against its spec. Returns error strings (empty = valid). */
export function validateValue(spec: ParamSpec, value: unknown, path: string): string[] {
  const errs: string[] = [];
  const bad = (msg: string) => errs.push(`${path}: ${msg}`);
  switch (spec.type) {
    case "string":
    case "text":
    case "image":
      if (typeof value !== "string") bad(`expected a string, got ${typeOf(value)}`);
      else if (spec.type === "image" && value.trim() === "") bad("image path is empty");
      else if ((spec.type === "string" || spec.type === "text") && spec.maxLength && value.length > spec.maxLength) {
        bad(`longer than ${spec.maxLength} characters (${value.length})`);
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) bad(`expected a number, got ${typeOf(value)}`);
      else {
        if (spec.min != null && value < spec.min) bad(`${value} is below the minimum ${spec.min}`);
        if (spec.max != null && value > spec.max) bad(`${value} is above the maximum ${spec.max}`);
      }
      break;
    case "color":
      if (typeof value !== "string" || !HEX.test(value)) bad(`expected a hex colour like #F6FF00, got ${JSON.stringify(value)}`);
      break;
    case "boolean":
      if (typeof value !== "boolean") bad(`expected true or false, got ${typeOf(value)}`);
      break;
    case "enum":
      if (typeof value !== "string" || !spec.options.includes(value)) {
        bad(`expected one of ${spec.options.join(" | ")}, got ${JSON.stringify(value)}`);
      }
      break;
    case "easing":
      if (typeof value !== "string" || !(EASINGS as readonly string[]).includes(value)) {
        bad(`expected an easing (${EASINGS.join(" | ")}), got ${JSON.stringify(value)}`);
      }
      break;
    case "font":
      if (typeof value !== "string" || !(FONTS as readonly string[]).includes(value)) {
        bad(`expected a bundled font (${FONTS.join(" | ")}), got ${JSON.stringify(value)}`);
      }
      break;
    case "list":
      if (!Array.isArray(value)) bad(`expected a list, got ${typeOf(value)}`);
      else {
        if (spec.minItems != null && value.length < spec.minItems) bad(`needs at least ${spec.minItems} items (has ${value.length})`);
        if (spec.maxItems != null && value.length > spec.maxItems) bad(`allows at most ${spec.maxItems} items (has ${value.length})`);
        value.forEach((item, i) => errs.push(...validateValue(spec.of, item, `${path}[${i}]`)));
      }
      break;
    case "object":
      if (typeOf(value) !== "object") bad(`expected an object, got ${typeOf(value)}`);
      else {
        const obj = value as Record<string, unknown>;
        for (const k of Object.keys(obj)) {
          if (!(k in spec.fields)) bad(`unknown field "${k}" (known: ${Object.keys(spec.fields).join(", ")})`);
        }
        for (const [k, fs] of Object.entries(spec.fields)) {
          if (obj[k] === undefined) {
            if (fs.default === undefined) bad(`missing field "${k}"`);
          } else errs.push(...validateValue(fs, obj[k], `${path}.${k}`));
        }
      }
      break;
    default:
      bad(`unknown param type ${JSON.stringify((spec as { type: unknown }).type)}`);
  }
  return errs;
}

function validateSpec(spec: ParamSpec, path: string, topLevel: boolean): string[] {
  const errs: string[] = [];
  if (!spec || typeof spec !== "object" || !PARAM_TYPES.has((spec as { type: string }).type)) {
    return [`${path}: type must be one of ${[...PARAM_TYPES].join(", ")}`];
  }
  if (spec.type === "enum" && (!Array.isArray(spec.options) || spec.options.length === 0)) {
    errs.push(`${path}: enum needs a non-empty "options" list`);
  }
  if (spec.type === "number" && spec.min != null && spec.max != null && spec.min > spec.max) {
    errs.push(`${path}: min ${spec.min} is above max ${spec.max}`);
  }
  if (spec.type === "list") {
    if (!spec.of) errs.push(`${path}: list needs "of" (the item spec)`);
    else errs.push(...validateSpec(spec.of, `${path}[]`, false));
  }
  if (spec.type === "object") {
    if (!spec.fields || typeof spec.fields !== "object") errs.push(`${path}: object needs "fields"`);
    else for (const [k, f] of Object.entries(spec.fields)) errs.push(...validateSpec(f, `${path}.${k}`, false));
  }
  if (topLevel && spec.default === undefined) errs.push(`${path}: top-level params need a "default"`);
  if (spec.default !== undefined && errs.length === 0) errs.push(...validateValue(spec, spec.default, `${path} (default)`));
  return errs;
}

/** Validate a whole manifest. Returns error strings (empty = valid). */
export function validateManifest(m: CompositionManifest): string[] {
  const errs: string[] = [];
  if (!m || typeof m !== "object") return ["manifest is not an object"];
  if (typeof m.name !== "string" || !NAME.test(m.name)) errs.push(`name: kebab-case id required, got ${JSON.stringify(m.name)}`);
  if (typeof m.title !== "string" || !m.title) errs.push("title: required");
  if (typeof m.description !== "string" || m.description.length < 10) errs.push("description: one or two sentences required");
  if (typeof m.duration !== "number" || !(m.duration > 0) || m.duration > 600) errs.push("duration: seconds, 0 < d <= 600");
  if (!Array.isArray(m.size) || m.size.length !== 2 || !m.size.every((n) => Number.isInteger(n) && n > 0 && n % 2 === 0)) {
    errs.push("size: [width, height], positive even integers (yuva420p needs even sizes)");
  }
  if (m.fps != null && (!Number.isInteger(m.fps) || m.fps < 1 || m.fps > 120)) errs.push("fps: integer 1..120");
  if (m.fit !== undefined && m.fit !== false && (typeof m.fit !== "number" || !(m.fit > 0) || m.fit > 600)) {
    errs.push("fit: seconds (0 < fit <= 600) or false");
  }
  // composition-v3: a library kit by name (kits/<name>.js); existence is checked when it renders (render.ts prepare)
  if (m.kit !== undefined && (typeof m.kit !== "string" || !NAME.test(m.kit))) errs.push(`kit: a library kit name (kebab-case), got ${JSON.stringify(m.kit)}`);
  if (!m.params || typeof m.params !== "object") errs.push("params: object required");
  else {
    for (const [k, spec] of Object.entries(m.params)) {
      if (!KEY.test(k)) errs.push(`params.${k}: keys are camelCase letters/digits`);
      errs.push(...validateSpec(spec, `params.${k}`, true));
    }
  }
  return errs;
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function fillDefaults(spec: ParamSpec, value: unknown): unknown {
  if (spec.type === "object" && typeOf(value) === "object") {
    const obj = { ...(value as Record<string, unknown>) };
    for (const [k, fs] of Object.entries(spec.fields)) {
      if (obj[k] === undefined && fs.default !== undefined) obj[k] = clone(fs.default);
      else if (obj[k] !== undefined) obj[k] = fillDefaults(fs, obj[k]);
    }
    return obj;
  }
  if (spec.type === "list" && Array.isArray(value)) return value.map((v) => fillDefaults(spec.of, v));
  return value;
}

/**
 * Manifest defaults, overlaid with `overrides` (whole-value replacement per top-level key; object fields that are
 * missing are filled from their defaults). Unknown keys are errors so a typo never silently does nothing.
 */
export function resolveParams(
  manifest: CompositionManifest,
  overrides: ParamValues = {},
): { values: ParamValues; errors: string[] } {
  const errors: string[] = [];
  const values: ParamValues = {};
  for (const [k, spec] of Object.entries(manifest.params)) values[k] = clone(spec.default);
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (k.startsWith("$")) continue; // "$comment", "$schema": allowed in props files, ignored
    const spec = manifest.params[k];
    if (!spec) {
      errors.push(`${k}: not a param of "${manifest.name}" (params: ${Object.keys(manifest.params).join(", ")})`);
      continue;
    }
    values[k] = clone(v);
  }
  for (const [k, spec] of Object.entries(manifest.params)) {
    values[k] = fillDefaults(spec, values[k]);
    errors.push(...validateValue(spec, values[k], k));
  }
  return { values, errors };
}

// ---------------------------------------------------------------- display text (CONTRACT.md §2c)

function holdsText(spec: ParamSpec): boolean {
  if (spec.type === "string" || spec.type === "text") return true;
  if (spec.type === "list") return holdsText(spec.of);
  if (spec.type === "object") return Object.values(spec.fields).some(holdsText);
  return false;
}

/** On-screen words or data: `display` when set, else any string/text param or list/object that holds one. */
export function isDisplay(spec: ParamSpec): boolean {
  return spec.display ?? holdsText(spec);
}

/** What an applied render shows when a display param is not given: "" for text, [] for a list; null = none possible. */
export function blankOf(spec: ParamSpec): unknown {
  if (spec.type === "string" || spec.type === "text") return "";
  if (spec.type === "list") return [];
  return null;
}

/** A display param an applied render cannot leave blank: `required`, or its blank value is invalid (minItems > 0). */
export function isRequired(spec: ParamSpec): boolean {
  if (spec.required) return true;
  const blank = blankOf(spec);
  return blank === null || validateValue(spec, blank, "x").length > 0;
}

/** The display params of a manifest: key → required. */
export function displayParams(manifest: CompositionManifest): Record<string, { required: boolean }> {
  const out: Record<string, { required: boolean }> = {};
  for (const [k, spec] of Object.entries(manifest.params)) if (isDisplay(spec)) out[k] = { required: isRequired(spec) };
  return out;
}

export interface AppliedResolution {
  values: ParamValues;
  errors: string[];
  /** Required display params the request did not give (or gave blank): render nothing, ask for these. */
  needs: string[];
  /** Optional display params the request did not give: rendered blank ("" / []), never the example copy. */
  blanked: string[];
}

/**
 * resolveParams for an APPLIED render (the editor service): display params never fall back to their example
 * defaults. Missing optional ones render blank; missing (or blank) required ones are listed in `needs`.
 */
export function resolveApplied(manifest: CompositionManifest, overrides: ParamValues = {}): AppliedResolution {
  const needs: string[] = [];
  const blanked: string[] = [];
  const given: ParamValues = {};
  for (const [k, v] of Object.entries(overrides ?? {})) if (!k.startsWith("$")) given[k] = v;
  const fill: ParamValues = {};
  const nonBlank = (v: unknown) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  for (const [k, spec] of Object.entries(manifest.params)) {
    if (!isDisplay(spec)) continue;
    const required = isRequired(spec) && !(spec.requiredUnless && nonBlank(given[spec.requiredUnless]));
    if (given[k] === null) delete given[k]; // null = "not given"
    const v = given[k];
    const blank = v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
    if (!blank) continue;
    if (required) needs.push(k);
    else if (v === undefined && blankOf(spec) !== null) {
      fill[k] = blankOf(spec);
      blanked.push(k);
    }
  }
  const r = resolveParams(manifest, { ...given, ...fill });
  // a required param that is missing is reported once, as a need, not again as a validation error
  const errors = r.errors.filter((e) => !needs.some((k) => e === k || e.startsWith(`${k}:`) || e.startsWith(`${k}[`)));
  return { values: r.values, errors, needs, blanked };
}

/** One line per needed param, for the error a caller (a person or a model) reads: what goes there. */
export function describeNeeds(manifest: CompositionManifest, needs: string[]): string[] {
  return needs.map((k) => {
    const spec = manifest.params[k];
    if (!spec) return k;
    const shape =
      spec.type === "list"
        ? spec.of.type === "object"
          ? `list of {${Object.entries(spec.of.fields).map(([f, s]) => (s.default === undefined ? f : `${f}?`)).join(", ")}}`
          : `list of ${spec.of.type}`
        : spec.type;
    const n = spec.type === "list" && spec.minItems ? `, at least ${spec.minItems}` : "";
    return `${k} (${shape}${n}): ${spec.description ?? spec.label ?? ""}`.trim();
  });
}

/** Turn a CLI `--set key=value` string into a typed override using the param's spec. */
export function coerceSet(manifest: CompositionManifest, assignment: string): [string, unknown] {
  const eq = assignment.indexOf("=");
  if (eq < 1) throw new Error(`--set expects key=value, got ${JSON.stringify(assignment)}`);
  const key = assignment.slice(0, eq).trim();
  const raw = assignment.slice(eq + 1);
  const spec = manifest.params[key];
  if (!spec) throw new Error(`--set ${key}: not a param (params: ${Object.keys(manifest.params).join(", ")})`);
  switch (spec.type) {
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) throw new Error(`--set ${key}: "${raw}" is not a number`);
      return [key, n];
    }
    case "boolean":
      if (/^(true|yes|on|1)$/i.test(raw)) return [key, true];
      if (/^(false|no|off|0)$/i.test(raw)) return [key, false];
      throw new Error(`--set ${key}: "${raw}" is not true/false`);
    case "list":
    case "object":
      try {
        return [key, JSON.parse(raw)];
      } catch {
        if (spec.type === "list" && spec.of.type !== "object") {
          return [key, raw.split("|").map((s) => (spec.of.type === "number" ? Number(s) : s.trim()))];
        }
        throw new Error(`--set ${key}: expected JSON (e.g. '[{"label":"Jan","value":3}]')`);
      }
    default:
      return [key, raw];
  }
}

/** Static checks for things that break determinism (CONTRACT.md §5). Returns warnings, not errors. */
export function lintComposition(html: string): string[] {
  const warn: string[] = [];
  const scriptAndStyle = html.replace(/<script\b[^>]*id\s*=\s*["']params["'][^>]*>[\s\S]*?<\/script\s*>/i, "");
  const rules: [RegExp, string][] = [
    [/\bDate\.now\s*\(|\bnew Date\s*\(/, "reads the wall clock (Date): use the `time` passed to render()"],
    [/\bperformance\.now\s*\(/, "reads performance.now(): use the `time` passed to render()"],
    [/\bMath\.random\s*\(/, "Math.random() is unseeded: use RC.random(seed)"],
    [/\brequestAnimationFrame\s*\(/, "requestAnimationFrame runs on real time: animate in render(time)"],
    [/\bset(?:Timeout|Interval)\s*\(/, "timers run on real time: animate in render(time)"],
    [/\bfetch\s*\(|XMLHttpRequest/, "network during render: pass data through params instead"],
    [/(^|[;{\s])transition\s*:/m, "CSS transitions run on real time: drive the property from render(time)"],
    [/<video\b|<audio\b/i, "media elements are not seeked by this renderer yet (DECISION.md, 'Revisit when')"],
    [/will-change\s*:/, "will-change freezes a layer's raster scale at its first frame, so pixels depend on frame order: remove it"],
    [/translate3d\s*\(|translateZ\s*\(/, "translate3d/translateZ promote a compositor layer whose raster timing made pixels differ run to run: use 2D translate (RC.set does) unless depth is needed"],
  ];
  for (const [re, msg] of rules) if (re.test(scriptAndStyle)) warn.push(msg);
  if (!/RC\.composition\s*\(/.test(html)) warn.push("never calls RC.composition({ build, render })");
  return warn;
}
