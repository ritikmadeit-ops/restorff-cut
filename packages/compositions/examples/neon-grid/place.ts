// neon-grid kit: place every scene of a product plan on a RestorffCut timeline over MCP, the way a Claude would.
//
//   bun packages/compositions/examples/neon-grid/place.ts <plan.json> [--timeline <id>] [--name "<timeline name>"]
//
// Needs the dev server (default http://localhost:8791, or $RESTORFFCUT_URL) — it talks to /api/mcp through
// scripts/mcp-call.ts. Without --timeline it first makes one (`timeline create`, 9:16). Then, per scene, ONE call:
//   composition write {timeline_id, library: <piece>, t, duration_s, props: {...scene.props, words}}
// (t0 is filled from t by the server). It prints each clip's element id, hash and render time, writes
// packages/compositions/out/neon-grid/<plan>/placed.json, and ends with the calls that render and look at the result.
// Same eight pieces + another plan = the same video for another product: only the plan changes.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { PKG_ROOT } from "../../src/render.ts";

interface Scene { piece: string; t: number; duration: number; props: Record<string, unknown> }
interface Plan { product: string; duration: number; words: Array<{ w: string; s: number; e: number }>; scenes: Scene[] }

const args = process.argv.slice(2);
const file = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
if (!file) {
  console.error('usage: bun packages/compositions/examples/neon-grid/place.ts <plan.json> [--timeline <id>] [--name "<name>"]');
  process.exit(2);
}
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const REPO = resolve(PKG_ROOT, "..", "..");
const plan = JSON.parse(readFileSync(resolve(file), "utf8")) as Plan;
const out = join(PKG_ROOT, "out", "neon-grid", basename(file, ".json"));
mkdirSync(out, { recursive: true });

/** One MCP tool call through scripts/mcp-call.ts (args via a file: the props are long). */
function call(tool: string, body: Record<string, unknown>, label: string): Record<string, unknown> {
  const argsFile = join(out, `args-${label}.json`);
  writeFileSync(argsFile, JSON.stringify(body));
  const r = spawnSync("bun", [join(REPO, "scripts", "mcp-call.ts"), "call", tool, `@${argsFile}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const text = (r.stdout ?? "").trim();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON: reported below */
  }
  if (r.status !== 0) {
    console.error(`${label}: ${tool} failed (exit ${r.status}): ${text.slice(0, 1200) || (r.stderr ?? "").slice(-1200)}`);
    process.exit(1);
  }
  return parsed;
}

let timelineId = opt("timeline");
if (!timelineId) {
  const made = call("timeline", { action: "create", name: opt("name") ?? `${plan.product} — neon-grid kit`, aspect: "9:16" }, "create");
  timelineId = String(made.timeline_id ?? made.id ?? (made.timeline as { id?: string } | undefined)?.id ?? "");
  if (!timelineId) {
    console.error(`timeline create gave no id: ${JSON.stringify(made).slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`timeline ${timelineId} (new)`);
}
const placed: Array<Record<string, unknown>> = [];
for (const [i, scene] of plan.scenes.entries()) {
  const label = `${String(i + 1).padStart(2, "0")}-${scene.piece}`;
  const t0 = Date.now();
  const r = call("composition", { action: "write", timeline_id: timelineId, library: scene.piece, t: scene.t, duration_s: scene.duration, props: { ...scene.props, words: plan.words }, message: `${plan.product}: ${scene.piece} at ${scene.t} s` }, label);
  const row = { scene: label, t: scene.t, duration_s: r.duration_s, element_id: r.element_id, commit_id: r.commit_id, hash: String(r.hash ?? "").slice(0, 12), t0: r.t0, render_ms: (r.render as { ms?: number } | undefined)?.ms, wall_ms: Date.now() - t0 };
  placed.push(row);
  console.log(`${label}: element ${row.element_id} · commit ${String(row.commit_id).slice(0, 8)} · hash ${row.hash} · render ${row.render_ms} ms · ${row.wall_ms} ms`);
}
writeFileSync(join(out, "placed.json"), `${JSON.stringify({ product: plan.product, timeline_id: timelineId, placed }, null, 2)}\n`);
console.log(`wrote ${join(out, "placed.json")}`);
console.log("next:");
console.log(`  bun scripts/mcp-call.ts call render '{"timeline_id":"${timelineId}","quality":"preview"}'`);
console.log(`  bun scripts/mcp-call.ts call look '{"kind":"timeline","ref":"${timelineId}","times":[1.5,6,11,17,20.6,22.8,27,35]}' --images <absolute folder outside the repo>`);
