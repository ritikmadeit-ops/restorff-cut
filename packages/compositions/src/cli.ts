#!/usr/bin/env bun
// RestorffCut compositions CLI. Run from the restorffcut folder:  bun packages/compositions/src/cli.ts <command> …
// Full runbook: packages/compositions/README.md.
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { renderCustom, validateCustom, type CustomKitInput } from "./custom.ts";
import { nudge } from "./edits.ts";
import { contactSheet, probe } from "./ffmpeg.ts";
import { LIBRARY_DIR, listLibrary, SAMPLES_DIR } from "./library.ts";
import { coerceSet, lintComposition, parseManifest, resolveParams, validateManifest } from "./params.ts";
import { PKG_ROOT, prepare, render, renderStill } from "./render.ts";
import { handle } from "./service.ts";
import type { OutputFormat, ParamSpec, ParamValues, RenderOptions } from "./types.ts";

const USAGE = `RestorffCut compositions — motion graphics as code, rendered to alpha video.

  render <composition.html> [props] [--duration 3] [--fps 30] [--size 1080x1920] [--out file.webm|file.mov|dir/]
         [--format webm|mov|png] [--workers 4] [--crf 31] [--keep-frames dir] [--chrome exe] [--no-fit] [--json]
         (a --duration shorter than the composition's natural length compresses its clock; --no-fit plays it as designed)
  still  <composition.html> --t 1.2 [props] [--out frame.png] [--plate #3a3a40|none] [--size WxH] [--duration 1]
  look   <video.webm|.mov> [--out sheet.png] [--count 6] [--plate #3a3a40] [--from 0 --to 1]   contact sheet to look at
  probe  <video>                                   codec, pixel format, alpha flag, frame count, duration
  check  <composition.html> [props]                validate the manifest + params, lint for determinism hazards
  params <composition.html> [--json]               what Claude may change, with types, ranges and meanings
  nudge  <composition.html> "<sentence>" [--props file.json] [--write]   e.g. "slower and bigger", "make it red"
  list   [--json]                                  the starter library
  samples [--only word-pop,checklist] [--workers 4]  render every library composition to samples/
  custom <file.html> [props] [--check] [--duration 4] [--fps 30] [--size 540x960] [--kit kit.html|.json|.css|.js]
         [--out file.webm] [--json]
         a CUSTOM composition (untrusted code): validate, then render with the network blocked (README "Custom")
  api    catalogue|render|nudge|custom-validate|custom-render|custom-nudge|custom-kit|custom-examples|custom-contract|kit-validate
                                                   editor service: JSON request on stdin, JSON answer on stdout

  props:  --props file.json   and/or   --set key=value (repeatable; lists/objects take JSON, simple lists take a|b|c)
`;

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
  sets: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: {}, sets: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] as string;
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      const isBool = next === undefined || next.startsWith("--");
      if (key === "set") {
        if (isBool) throw new Error("--set needs key=value");
        a.sets.push(next as string);
        i++;
      } else if (isBool) a.flags[key] = true;
      else {
        a.flags[key] = next as string;
        i++;
      }
    } else a._.push(t);
  }
  return a;
}

function str(a: Args, k: string): string | undefined {
  const v = a.flags[k];
  return typeof v === "string" ? v : undefined;
}
function numFlag(a: Args, k: string): number | undefined {
  const v = str(a, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${k} expects a number, got "${v}"`);
  return n;
}

/** Props from --props file.json overlaid with --set key=value. */
function loadProps(a: Args, html: string): { props: ParamValues; propsDir?: string; propsFile?: string } {
  const manifest = parseManifest(readFileSync(html, "utf8"));
  let props: ParamValues = {};
  let propsDir: string | undefined;
  const file = str(a, "props");
  if (file) {
    const p = resolve(file);
    if (!existsSync(p)) throw new Error(`props file not found: ${p}`);
    props = JSON.parse(readFileSync(p, "utf8")) as ParamValues;
    propsDir = dirname(p);
  }
  for (const s of a.sets) {
    const [k, v] = coerceSet(manifest, s);
    props[k] = v;
  }
  return { props, propsDir, propsFile: file ? resolve(file) : undefined };
}

function sizeFlag(a: Args): { width?: number; height?: number } {
  const s = str(a, "size");
  if (!s) return {};
  const m = s.match(/^(\d+)x(\d+)$/i);
  if (!m) throw new Error(`--size expects WIDTHxHEIGHT like 1080x1920, got "${s}"`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

function requireHtml(a: Args): string {
  const f = a._[1];
  if (!f) throw new Error(`missing <composition.html>\n\n${USAGE}`);
  const p = resolve(f);
  if (!existsSync(p)) throw new Error(`not found: ${p}`);
  return p;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function progressPrinter(label: string) {
  let last = -1;
  return (done: number, total: number) => {
    const pct = Math.floor((done / total) * 10);
    if (pct !== last) {
      last = pct;
      process.stderr.write(`\r${label} ${done}/${total} frames`);
      if (done === total) process.stderr.write("\n");
    }
  };
}

function describe(spec: ParamSpec): string {
  switch (spec.type) {
    case "number":
      return `number${spec.min != null || spec.max != null ? ` ${spec.min ?? ""}..${spec.max ?? ""}` : ""}${spec.unit ? ` ${spec.unit}` : ""}`;
    case "enum":
      return `enum ${spec.options.join("|")}`;
    case "list":
      return `list of ${describe(spec.of)}${spec.maxItems ? ` (max ${spec.maxItems})` : ""}`;
    case "object":
      return `{ ${Object.entries(spec.fields).map(([k, f]) => `${k}: ${describe(f)}`).join(", ")} }`;
    default:
      return spec.type;
  }
}

async function cmdRender(a: Args) {
  const html = requireHtml(a);
  const { props, propsDir } = loadProps(a, html);
  const manifest = parseManifest(readFileSync(html, "utf8"));
  const out = str(a, "out") ?? `${manifest.name}.${str(a, "format") === "mov" ? "mov" : "webm"}`;
  const opts: RenderOptions = {
    composition: html,
    out,
    props,
    propsDir,
    duration: numFlag(a, "duration"),
    fps: numFlag(a, "fps"),
    ...sizeFlag(a),
    format: str(a, "format") as OutputFormat | undefined,
    workers: numFlag(a, "workers"),
    crf: numFlag(a, "crf"),
    keepFrames: str(a, "keep-frames"),
    chrome: str(a, "chrome"),
    fit: !a.flags["no-fit"],
    onProgress: a.flags.json ? undefined : progressPrinter(manifest.name),
  };
  const r = await render(opts);
  if (a.flags.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`wrote ${r.out} (${r.format}, ${r.width}x${r.height}, ${r.frames} frames @ ${r.fps} fps, ${mb(r.bytes)})`);
    if (r.fit) console.log(`fit to ${r.duration} s: natural length ${r.fit} s, clock rate ${r.rate} (--no-fit plays it as designed)`);
    console.log(`time ${(r.ms.total / 1000).toFixed(1)} s (load ${(r.ms.load / 1000).toFixed(1)} s) = ${r.secondsPerSecond} s per second of output`);
    console.log(`sidecar ${r.sidecar}`);
  }
}

async function cmdStill(a: Args) {
  const html = requireHtml(a);
  const { props, propsDir } = loadProps(a, html);
  const t = numFlag(a, "t") ?? 0;
  const manifest = parseManifest(readFileSync(html, "utf8"));
  const out = str(a, "out") ?? `${manifest.name}-t${t}.png`;
  const plateFlag = str(a, "plate") ?? "#3a3a40";
  const r = await renderStill({
    composition: html,
    out,
    props,
    propsDir,
    t,
    plate: plateFlag === "none" ? undefined : plateFlag,
    duration: numFlag(a, "duration"),
    ...sizeFlag(a),
    chrome: str(a, "chrome"),
    fit: !a.flags["no-fit"],
  });
  console.log(`wrote ${r.out} (t=${t}s, ${r.ms} ms)`);
}

async function cmdLook(a: Args) {
  const file = a._[1];
  if (!file) throw new Error("missing <video>");
  const info = await probe(resolve(file));
  const out = str(a, "out") ?? resolve(dirname(file), `${basename(file).replace(/\.[^.]+$/, "")}.sheet.png`);
  const times = await contactSheet(resolve(file), out, {
    count: numFlag(a, "count") ?? 6,
    plate: str(a, "plate"),
    from: numFlag(a, "from"),
    to: numFlag(a, "to"),
    frames: info.frames,
    fps: info.fps,
    width: info.width,
    height: info.height,
  });
  console.log(`wrote ${out} — frames at ${times.map((t) => `${t}s`).join(", ")}`);
}

async function cmdProbe(a: Args) {
  const file = a._[1];
  if (!file) throw new Error("missing <video>");
  console.log(JSON.stringify(await probe(resolve(file)), null, 2));
}

function cmdCheck(a: Args) {
  const html = requireHtml(a);
  const { props, propsDir } = loadProps(a, html);
  const src = readFileSync(html, "utf8");
  const manifest = parseManifest(src);
  const errs = validateManifest(manifest).map((e) => `manifest ${e}`);
  if (!errs.length) {
    try {
      prepare({ composition: html, out: "check.webm", props, propsDir });
    } catch (e) {
      errs.push(...String((e as Error).message).split("\n").slice(1).map((l) => l.replace(/^\s*-\s*/, "")));
    }
  }
  const warns = lintComposition(src);
  for (const w of warns) console.log(`WARN ${w}`);
  for (const e of errs) console.log(`FAIL ${e}`);
  if (errs.length) process.exitCode = 1;
  else console.log(`OK ${manifest.name}: ${Object.keys(manifest.params).length} params, ${manifest.duration}s, ${manifest.size.join("x")}${warns.length ? `, ${warns.length} warning(s)` : ""}`);
}

function cmdParams(a: Args) {
  const html = requireHtml(a);
  const m = parseManifest(readFileSync(html, "utf8"));
  if (a.flags.json) return void console.log(JSON.stringify(m, null, 2));
  console.log(`${m.name} — ${m.title}\n${m.description}\nduration ${m.duration}s · size ${m.size.join("x")} · fps ${m.fps ?? 30}\n`);
  for (const [k, spec] of Object.entries(m.params)) {
    console.log(`  ${k.padEnd(14)} ${describe(spec)}`);
    console.log(`  ${"".padEnd(14)} default ${JSON.stringify(spec.default)}`);
    if (spec.description) console.log(`  ${"".padEnd(14)} ${spec.description}`);
  }
}

function cmdNudge(a: Args) {
  const html = requireHtml(a);
  const sentence = a._[2];
  if (!sentence) throw new Error('missing "<sentence>", e.g. "slower and bigger"');
  const m = parseManifest(readFileSync(html, "utf8"));
  const { props, propsFile } = loadProps(a, html);
  const { values, errors } = resolveParams(m, props);
  if (errors.length) throw new Error(`current props are invalid:\n  - ${errors.join("\n  - ")}`);
  const r = nudge(m, values, sentence);
  for (const c of r.changes) console.log(`${c.key}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}  (${c.because})`);
  for (const s of r.skipped) console.log(`skipped: ${s}`);
  // Only write keys that differ from the defaults, plus everything the props file already had.
  const next: ParamValues = { ...props };
  for (const c of r.changes) next[c.key] = c.to;
  if (a.flags.write) {
    if (!propsFile) throw new Error("--write needs --props file.json");
    writeFileSync(propsFile, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`updated ${propsFile}`);
  } else console.log(JSON.stringify(next, null, 2));
}

function cmdList(a: Args) {
  const lib = listLibrary();
  if (a.flags.json) return void console.log(JSON.stringify(lib, null, 2));
  for (const e of lib) {
    const sample = existsSync(e.sample) ? `sample ${mb(statSync(e.sample).size)}` : "no sample yet";
    console.log(`${e.name.padEnd(16)} ${e.duration}s ${e.size.join("x").padEnd(10)} ${sample}\n${"".padEnd(16)} ${e.description}`);
  }
}

async function cmdSamples(a: Args) {
  const only = str(a, "only")?.split(",").map((s) => s.trim());
  const lib = listLibrary().filter((e) => !only || only.includes(e.name));
  if (!lib.length) throw new Error(`no compositions matched in ${LIBRARY_DIR}`);
  const rows: Record<string, unknown>[] = [];
  for (const e of lib) {
    const props = e.props ? (JSON.parse(readFileSync(e.props, "utf8")) as ParamValues) : {};
    const out = join(SAMPLES_DIR, `${e.name}.webm`);
    // samples are committed: keep each under 2 MB by stepping the VP9 CRF up (31, 35, 39, 43)
    let r: Awaited<ReturnType<typeof render>> | undefined;
    for (let crf = 31; crf <= 43; crf += 4) {
      r = await render({
        composition: e.html,
        out,
        props,
        propsDir: e.props ? dirname(e.props) : undefined,
        workers: numFlag(a, "workers"),
        crf,
        onProgress: progressPrinter(`${e.name} crf ${crf}`),
      });
      if (r.bytes < 2_000_000) break; // decimal 2 MB, the stricter reading
    }
    if (!r) throw new Error("unreachable");
    // committed sidecars carry package-relative paths, not this machine's
    const rel = (p: string) => relative(PKG_ROOT, p).split(sep).join("/");
    const side = JSON.parse(readFileSync(r.sidecar, "utf8")) as Record<string, unknown>;
    Object.assign(side, { source: rel(String(side.source)), out: rel(String(side.out)), sidecar: rel(String(side.sidecar)) });
    writeFileSync(r.sidecar, `${JSON.stringify(side, null, 2)}\n`);
    const sheet = join(SAMPLES_DIR, `${e.name}.png`);
    await contactSheet(out, sheet, { count: 6, frames: r.frames, fps: r.fps, width: r.width, height: r.height, tileWidth: 240 });
    rows.push({
      name: e.name,
      size: `${r.width}x${r.height}`,
      seconds: r.duration,
      frames: r.frames,
      renderSeconds: +(r.ms.total / 1000).toFixed(1),
      loadSeconds: +(r.ms.load / 1000).toFixed(1),
      secondsPerSecond: r.secondsPerSecond,
      mb: +(r.bytes / 1024 / 1024).toFixed(2),
      crf: (side.crf as number | undefined) ?? null,
    });
  }
  console.log("\n| composition | size | s | frames | render s | load s | s per s | MB |\n|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.name} | ${r.size} | ${r.seconds} | ${r.frames} | ${r.renderSeconds} | ${r.loadSeconds} | ${r.secondsPerSecond} | ${r.mb} |`);
  }
  const summary = join(SAMPLES_DIR, "samples.json");
  const prev = existsSync(summary) ? (JSON.parse(readFileSync(summary, "utf8")) as { rows: Record<string, unknown>[] }).rows : [];
  const merged = [...prev.filter((p) => !rows.some((r) => r.name === p.name)), ...rows].sort((x, y) => String(x.name).localeCompare(String(y.name)));
  const d = new Date(); // local date, not UTC: the logs are dated in local time
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  writeFileSync(summary, `${JSON.stringify({ measuredOn: today, workers: numFlag(a, "workers") ?? 4, rows: merged }, null, 2)}\n`);
}

/** `api <verb>`: one JSON request on stdin → `{ "ok": true, "result": … }` or `{ "ok": false, "error": "…" }` on stdout. */
async function cmdApi(a: Args) {
  const verb = a._[1] ?? "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  try {
    const result = await handle(verb, raw ? JSON.parse(raw) : {});
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (e) {
    const details = (e as { details?: unknown }).details;
    process.stdout.write(`${JSON.stringify({ ok: false, error: (e as Error).message, ...(details ? { details } : {}) })}\n`);
    process.exitCode = 1;
  }
}

/** `custom <file.html>`: the same path the editor and the MCP tool use — validate, then render network-blocked. */
async function cmdCustom(a: Args) {
  const html = requireHtml(a);
  const source = readFileSync(html, "utf8");
  let props: ParamValues = {};
  const file = str(a, "props");
  if (file) props = JSON.parse(readFileSync(resolve(file), "utf8")) as ParamValues;
  let manifest: ReturnType<typeof parseManifest> | null = null;
  try {
    manifest = parseManifest(source);
  } catch {
    manifest = null; // no params block: --set values are JSON or plain strings
  }
  for (const s of a.sets) {
    if (manifest) {
      const [k, v] = coerceSet(manifest, s);
      props[k] = v;
    } else {
      const eq = s.indexOf("=");
      if (eq < 1) throw new Error(`--set expects key=value, got ${JSON.stringify(s)}`);
      const raw = s.slice(eq + 1);
      try {
        props[s.slice(0, eq)] = JSON.parse(raw);
      } catch {
        props[s.slice(0, eq)] = raw;
      }
    }
  }
  // --kit file: the timeline kit (.html = HTML; .json = { css?, js?, html? }; .css / .js = that part)
  const kitFile = str(a, "kit");
  let kit: CustomKitInput | undefined;
  if (kitFile) {
    const text = readFileSync(resolve(kitFile), "utf8");
    kit = /\.json$/i.test(kitFile) ? (JSON.parse(text) as CustomKitInput) : /\.css$/i.test(kitFile) ? { css: text } : /\.js$/i.test(kitFile) ? { js: text } : text;
  }
  const v = validateCustom(source, props, { kit });
  const print = (label: string, list: string[]) => list.forEach((m) => console.log(`${label} ${m}`));
  if (a.flags.check || !v.ok) {
    if (a.flags.json) console.log(JSON.stringify({ ok: v.ok, errors: v.errors, warnings: v.warnings, protocol: v.protocol, bytes: v.bytes }, null, 2));
    else {
      console.log(`${v.ok ? "ok" : "REFUSED"} — ${v.bytes} bytes, protocol ${v.protocol ?? "none"}, ${v.manifest ? `${Object.keys(v.manifest.params).length} params` : "no params block"}`);
      print("error:", v.errors);
      print("warning:", v.warnings);
    }
    if (!v.ok) process.exitCode = 1;
    return;
  }
  const out = str(a, "out") ?? `${v.manifest?.name ?? "custom"}.webm`;
  const r = await renderCustom({
    source,
    props,
    out,
    duration: numFlag(a, "duration"),
    fps: numFlag(a, "fps"),
    ...sizeFlag(a),
    workers: numFlag(a, "workers"),
    chrome: str(a, "chrome"),
    kit,
    fit: !a.flags["no-fit"],
    onProgress: a.flags.json ? undefined : progressPrinter(v.manifest?.name ?? "custom"),
  });
  if (a.flags.json) console.log(JSON.stringify({ ...r, validation: undefined, warnings: v.warnings }, null, 2));
  else {
    console.log(`wrote ${r.out} (webm, ${r.width}x${r.height}, ${r.frames} frames @ ${r.fps} fps, ${mb(r.bytes)}) — network blocked`);
    console.log(`time ${(r.ms.total / 1000).toFixed(1)} s (load ${(r.ms.load / 1000).toFixed(1)} s) = ${r.secondsPerSecond} s per second of output`);
    console.log(`hash ${r.inputHash}`);
    console.log(`blocked requests: ${r.blocked.length ? r.blocked.join(", ") : "none attempted"}`);
    print("warning:", v.warnings);
    console.log(`sidecar ${r.sidecar}`);
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  switch (cmd) {
    case "api":
      return cmdApi(a);
    case "render":
      return cmdRender(a);
    case "still":
      return cmdStill(a);
    case "look":
      return cmdLook(a);
    case "probe":
      return cmdProbe(a);
    case "check":
      return cmdCheck(a);
    case "params":
      return cmdParams(a);
    case "nudge":
      return cmdNudge(a);
    case "list":
      return cmdList(a);
    case "samples":
      return cmdSamples(a);
    case "custom":
      return cmdCustom(a);
    default:
      console.log(USAGE);
      if (cmd && cmd !== "help") process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
