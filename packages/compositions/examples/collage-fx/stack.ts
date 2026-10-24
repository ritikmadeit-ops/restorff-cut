// collage-fx stack check: render an effect the way the editor stacks it, over a fictional stand-in subject.
//
//   bun packages/compositions/examples/collage-fx/stack.ts <composition> [--size 540x960] [--sheet <png>|none]
//
// Reads the composition's manifest `effect` block (the production recipe: which tracks, in which order, and the
// transform keys the clip and its cutout get) plus this folder's stack.json (fixture extras: matte frames, stills,
// sample props). Renders, in packages/compositions/out/collage-fx/:
//   stand-in/<hash>.webm             the stand-in plate / cutout (cached by input hash), matte PNG frames, stills
//   <name>[.<layer>].webm            each layer of the effect (alpha WebM, the editor's format)
//   <name>.stack.webm                everything composited bottom to top (what the editor's preview should show)
// and a 6-frame contact sheet of the composite (default samples/<name>.png). Look at it before calling it done.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contactSheet, probe, run } from "../../src/ffmpeg.ts";
import { LIBRARY_DIR, SAMPLES_DIR } from "../../src/library.ts";
import { parseManifest } from "../../src/params.ts";
import { prepare, render, renderStill, PKG_ROOT } from "../../src/render.ts";
import type { ParamValues } from "../../src/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STAND_IN = join(HERE, "stand-in.html");
const OUT = join(PKG_ROOT, "out", "collage-fx");
const FFMPEG = process.env.RESTORFFCUT_FFMPEG ?? "ffmpeg";

interface Key { t: number; scale?: number; x?: number; y?: number; ease?: string }
interface Effect { fx?: string[]; stack: string[]; plateKeys?: Key[]; plateKeysOn?: string[]; inputs?: Record<string, string>; props?: ParamValues }
interface Fixture {
  duration?: number;
  props?: ParamValues;
  /** Pass the stand-in's cutout as matte frames: props.matte = [png…], props.matteFps. */
  matte?: boolean;
  matteFps?: number;
  /** Matte frame size as a fraction of the output (0.5 = 270x480 for 540x960). */
  matteScale?: number;
  /** param → a still of the stand-in: { layer, t } (e.g. a clean plate for vertigo). */
  stills?: Record<string, { layer: string; t: number; list?: boolean }>;
  hands?: number[][];
  /** Override the manifest's stack for the sample (e.g. show an overlay over the plate). */
  stack?: string[];
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function renderCachedTo(opts: Omit<Parameters<typeof render>[0], "out">, dir: string, ext = "webm"): Promise<string> {
  const prep = prepare({ ...opts, out: join(dir, `x.${ext === "png" ? "png" : ext}`), format: ext === "png" ? "png" : undefined });
  const out = join(dir, ext === "png" ? prep.inputHash.slice(0, 16) : `${prep.inputHash.slice(0, 16)}.${ext}`);
  if (existsSync(ext === "png" ? join(out, "render.json") : `${out}.json`)) return out;
  await render({ ...opts, out, format: ext === "png" ? "png" : undefined });
  return out;
}

async function main() {
  const name = process.argv[2];
  if (!name || name.startsWith("--")) throw new Error("usage: stack.ts <composition> [--size 540x960] [--sheet <png>|none]");
  const html = join(LIBRARY_DIR, name, `${name}.html`);
  const manifest = parseManifest(readFileSync(html, "utf8")) as ReturnType<typeof parseManifest> & { effect?: Effect };
  const effect = manifest.effect;
  if (!effect?.stack?.length) throw new Error(`${name}: no "effect.stack" in its manifest`);
  const fixtures = JSON.parse(readFileSync(join(HERE, "stack.json"), "utf8")) as Record<string, Fixture>;
  const fx: Fixture = fixtures[name] ?? {};
  const [W, H] = (flag("size") ?? "540x960").split("x").map(Number);
  const fps = 30;
  const duration = fx.duration ?? manifest.duration;
  const si = join(OUT, "stand-in");
  mkdirSync(si, { recursive: true });

  const keysFor = (track: string) => (effect.plateKeysOn ?? ["plate", "cutout"]).includes(track) ? effect.plateKeys ?? [] : [];
  const standIn = (layer: string, track: string) => ({
    composition: STAND_IN, width: W, height: H, fps, duration,
    props: { layer, keys: keysFor(track), ...(fx.hands ? { hands: fx.hands } : {}) },
  });

  // example props + fixture props (+ matte frames, stills)
  const propsFile = join(LIBRARY_DIR, name, `${name}.props.json`);
  const example = existsSync(propsFile) ? (JSON.parse(readFileSync(propsFile, "utf8")) as ParamValues) : {};
  const props: ParamValues = { ...example, ...(effect.props ?? {}), ...(fx.props ?? {}) };
  for (const k of Object.keys(props)) if (k.startsWith("$")) delete props[k];
  if (fx.matte) {
    const ms = fx.matteScale ?? 0.5;
    const mfps = fx.matteFps ?? 15;
    const dir = await renderCachedTo(
      { ...standIn("cutout", "cutout"), width: Math.round((W * ms) / 2) * 2, height: Math.round((H * ms) / 2) * 2, fps: mfps },
      si, "png",
    );
    props.matte = readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => join(dir, f));
    props.matteFps = mfps;
  }
  for (const [param, s] of Object.entries(fx.stills ?? {})) {
    const out = join(si, `still-${s.layer}-${s.t}-${W}x${H}-${(effect.plateKeys ?? []).length}.png`);
    if (!existsSync(out)) await renderStill({ ...standIn(s.layer, "plate"), props: { layer: s.layer }, out, t: s.t });
    props[param] = s.list ? [out] : out;
  }

  // render every layer of the stack
  const inputs: string[] = [];
  const stack = fx.stack ?? effect.stack;
  for (const entry of stack) {
    if (entry === "plate" || entry === "cutout") {
      inputs.push(await renderCachedTo(standIn(entry, entry), si));
      continue;
    }
    const layer = entry.includes(":") ? entry.split(":")[1] : null;
    const p = layer ? { ...props, layer } : props;
    const out = join(OUT, `${name}${layer ? `.${layer}` : ""}.webm`);
    const t0 = performance.now();
    const r = await render({ composition: html, out, props: p, propsDir: dirname(propsFile), width: W, height: H, fps, duration });
    console.log(`${entry}: ${r.frames} frames, ${(r.bytes / 1e6).toFixed(2)} MB, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    inputs.push(out);
  }

  // composite bottom → top
  const composite = join(OUT, `${name}.stack.webm`);
  const args = ["-y", "-v", "error"];
  for (const f of inputs) args.push("-c:v", "libvpx-vp9", "-i", f);
  // WebM stores ms timestamps: re-time every input by frame index or overlay pairs neighbours (LEARNINGS §4)
  let graph = `color=c=0x0C0C0E:s=${W}x${H}:r=${fps}:d=${duration},setpts=N/${fps}/TB[b0]`;
  inputs.forEach((_, i) => {
    graph += `;[${i}:v]setpts=N/${fps}/TB[i${i}];[b${i}][i${i}]overlay=format=auto:eof_action=repeat[b${i + 1}]`;
  });
  graph += `;[b${inputs.length}]format=yuv420p[v]`;
  args.push("-filter_complex", graph, "-map", "[v]", "-frames:v", String(Math.round(duration * fps)),
    "-c:v", "libvpx-vp9", "-b:v", "0", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-an");
  // samples stay under 2,000,000 bytes (the package's rule): step the CRF up like `cli.ts samples` does
  let crf = 36;
  for (; crf <= 60; crf += 6) {
    const r = await run(FFMPEG, [...args, "-crf", String(crf), composite]);
    if (r.code !== 0) throw new Error(`ffmpeg composite failed: ${r.stderr.slice(-800)}`);
    if (statSync(composite).size < 2_000_000) break;
  }
  const info = await probe(composite);
  console.log(`stack ${stack.join(" → ")}: ${composite} (${info.frames} frames, ${(statSync(composite).size / 1e6).toFixed(2)} MB, crf ${Math.min(crf, 60)})`);
  const sheetFlag = flag("sheet");
  if (sheetFlag !== "none") {
    const sheet = resolve(sheetFlag ?? join(SAMPLES_DIR, `${name}.png`));
    const times = await contactSheet(composite, sheet, { count: 6, frames: info.frames, fps, width: W, height: H, tileWidth: 240 });
    console.log(`sheet ${sheet} — frames at ${times.map((t) => `${t}s`).join(", ")}`);
  }
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
