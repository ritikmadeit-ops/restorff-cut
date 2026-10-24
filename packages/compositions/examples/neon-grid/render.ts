// neon-grid kit: render every scene of a product plan with the package renderer (no server), one contact sheet each.
//
//   bun packages/compositions/examples/neon-grid/render.ts <plan.json> [--size 540x960] [--count 8] [--only <piece>]
//
// A plan (halcyon-cold-brew-18h.json, halcyon-nitro-12s.json) lists scenes {piece, t, duration, props} plus the
// voice-over's `words` (timeline seconds). Each scene renders as the library composition `piece` with
// props = scene.props + {t0: t, words}, for `duration` seconds, into packages/compositions/out/neon-grid/<plan>/:
//   <n>-<piece>.webm (+ .json sidecar, with the sound cues the piece computed)   <n>-<piece>.png (contact sheet)
// and prints, per scene, the render time, the frames, the cue count and the sheet's frame times. Open the sheets
// before calling a scene done (CONTRACT.md §10 step 5). Same pieces + another plan = another product.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { contactSheet } from "../../src/ffmpeg.ts";
import { LIBRARY_DIR } from "../../src/library.ts";
import { PKG_ROOT, render } from "../../src/render.ts";
import type { ParamValues } from "../../src/types.ts";

interface Scene { piece: string; t: number; duration: number; props: ParamValues }
interface Plan { product: string; words: Array<{ w: string; s: number; e: number }>; scenes: Scene[] }

const args = process.argv.slice(2);
const file = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
if (!file) {
  console.error("usage: bun packages/compositions/examples/neon-grid/render.ts <plan.json> [--size 540x960] [--count 8] [--only <piece>]");
  process.exit(2);
}
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const [w, h] = (opt("size") ?? "540x960").split("x").map(Number);
const count = Number(opt("count") ?? 8);
const only = opt("only");
const plan = JSON.parse(readFileSync(resolve(file), "utf8")) as Plan;
const out = join(PKG_ROOT, "out", "neon-grid", basename(file, ".json"));
mkdirSync(out, { recursive: true });
const summary: Array<Record<string, unknown>> = [];
for (const [i, scene] of plan.scenes.entries()) {
  if (only && scene.piece !== only) continue;
  const name = `${String(i + 1).padStart(2, "0")}-${scene.piece}`;
  const props: ParamValues = { ...scene.props, t0: scene.t, words: plan.words };
  const webm = join(out, `${name}.webm`);
  const r = await render({ composition: join(LIBRARY_DIR, scene.piece, `${scene.piece}.html`), props, out: webm, duration: scene.duration, width: w, height: h, fps: 30 });
  const side = JSON.parse(readFileSync(`${webm}.json`, "utf8")) as { cues?: Array<{ t: number; kind: string; label?: string }> };
  const times = await contactSheet(webm, join(out, `${name}.png`), { count, frames: r.frames, fps: r.fps, width: r.width, height: r.height, tileWidth: 240 });
  const row = { scene: name, t: scene.t, duration: scene.duration, ms: r.ms.total, frames: r.frames, cues: side.cues?.length ?? 0, sheet: `${name}.png`, at: times.map((x) => +(x + scene.t).toFixed(2)) };
  summary.push({ ...row, cueList: side.cues ?? [] });
  console.log(`${name}: ${r.frames} frames in ${(r.ms.total / 1000).toFixed(1)} s, ${row.cues} cues, sheet ${name}.png at timeline ${row.at.join(" ")}`);
}
writeFileSync(join(out, "summary.json"), `${JSON.stringify({ product: plan.product, size: `${w}x${h}`, scenes: summary }, null, 2)}\n`);
console.log(`wrote ${out}`);
