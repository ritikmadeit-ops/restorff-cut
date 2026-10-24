// Black-box probe runner (anim-runtime, 2026-10-24): runs the same page code against REAL GSAP and against our
// gsap-compat in Chromium and prints both answers (SAME / DIFF). Real GSAP is only ever loaded from a folder OUTSIDE
// this repository (installed with `npm install gsap@3.14.2` in a scratch folder) and is never read, copied or shipped.
//   GSAP_ORACLE_DIR=<scratch folder with node_modules/gsap> bun src/gsap-compat/oracle/probe.ts src/gsap-compat/oracle/probes/semantics.js [--only name] [--real-only]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../cdp.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const COMPAT = resolve(HERE, "..", "gsap.js");
const REPO = resolve(HERE, "..", "..", "..", "..", "..");

function gsapDir(): string {
  const dir = process.env.GSAP_ORACLE_DIR;
  if (!dir) throw new Error("set GSAP_ORACLE_DIR to a scratch folder (outside the repo) where `npm install gsap@3.14.2` ran");
  const abs = resolve(dir);
  if (abs.toLowerCase().startsWith(REPO.toLowerCase())) throw new Error(`GSAP_ORACLE_DIR is inside the repository (${abs}): GSAP must never be in the repo`);
  return abs;
}

let realLib: string | null = null;
/** The page-side library: real GSAP (+ CustomEase, MotionPathPlugin, registered) or our compat. */
export function libSource(which: "real" | "compat"): string {
  if (which === "compat") return readFileSync(COMPAT, "utf8");
  if (!realLib) {
    realLib = ["gsap.min.js", "CustomEase.min.js", "MotionPathPlugin.min.js", "TextPlugin.min.js", "DrawSVGPlugin.min.js", "SplitText.min.js", "ScrambleTextPlugin.min.js"]
      .map((f) => readFileSync(join(gsapDir(), "node_modules", "gsap", "dist", f), "utf8"))
      .join("\n;\n") + "\n;window.gsap && window.gsap.registerPlugin(window.CustomEase, window.MotionPathPlugin, window.TextPlugin, window.DrawSVGPlugin, window.SplitText, window.ScrambleTextPlugin);";
  }
  return realLib;
}

interface Probe { name: string; html?: string; code: string }

async function runOne(browser: Browser, which: "real" | "compat", p: Probe): Promise<unknown> {
  const page = await browser.newPage(800, 600);
  await page.addInitScript(libSource(which));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head><body>${p.html ?? ""}</body></html>`;
  await page.navigate(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  try {
    return await page.evaluate(`(async () => { ${p.code} })()`, true);
  } catch (e) {
    return `ERROR ${(e as Error).message.slice(0, 300)}`;
  } finally {
    await browser.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
  }
}

if (import.meta.main) {
  const file = resolve(process.argv[2]!);
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const realOnly = process.argv.includes("--real-only");
  const probes: Probe[] = (await import(file)).default;
  const browser = await Browser.launch();
  let same = 0;
  let diff = 0;
  try {
    for (const p of probes) {
      if (only && p.name !== only) continue;
      const real = await runOne(browser, "real", p);
      const compat = realOnly ? null : await runOne(browser, "compat", p);
      const a = JSON.stringify(real);
      const b = JSON.stringify(compat);
      if (!realOnly && a === b) {
        same++;
        console.log(`SAME  ${p.name}: ${a.slice(0, 300)}`);
      } else {
        diff++;
        console.log(`${realOnly ? "REAL" : "DIFF"}  ${p.name}\n  real:   ${a}\n${realOnly ? "" : `  compat: ${b}\n`}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${same} same, ${diff} different`);
}
