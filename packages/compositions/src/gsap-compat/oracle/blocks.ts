// Block oracle (anim-runtime, 2026-10-24): render HyperFrames blocks with REAL GSAP (loaded from GSAP_ORACLE_DIR, a
// scratch folder outside the repo; never read, never shipped) and with our gsap-compat, through the same runtime +
// hf-protocol driver, seeking every frame at 30 fps as the renderer does; compare 6 frames per block.
//   GSAP_ORACLE_DIR=<scratch> HF_BLOCKS_DIR=<hyperframes clone>/registry/blocks \
//   bun src/gsap-compat/oracle/blocks.ts <out-dir outside the repo> --list src/gsap-compat/oracle/eligible-blocks.txt [--only a,b] [--times 6] [--eval "<js>"]
// Output: one line per block (match / close / broken, min PSNR, max % pixels off by > 24/255), <out>/results.json,
// and a real/compat PNG pair per sample frame (look at every non-match).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Browser, type Page } from "../../cdp.ts";
import { NO_NETWORK_FLAGS } from "../../custom.ts";
import { libScript } from "../../libs.ts";
import { initScript } from "../../render.ts";
import { libSource } from "./probe.ts";

const HF = process.env.HF_BLOCKS_DIR ?? "";
if (!HF || !existsSync(HF)) throw new Error("set HF_BLOCKS_DIR to a HyperFrames clone's registry/blocks folder (outside the repo)");
const SCALE = 0.5;
const FPS = 30;

function arg(name: string, d?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : d;
}

interface BlockInfo { name: string; html: string; width: number; height: number; duration: number }
function blockInfo(name: string): BlockInfo | null {
  const html = join(HF, name, `${name}.html`);
  if (!existsSync(html)) return null;
  const src = readFileSync(html, "utf8");
  const root = src.match(/<[^>]*data-composition-id="[^"]*"[^>]*>/);
  const tag = root ? root[0] : "";
  const num = (attr: string, d: number) => { const m = tag.match(new RegExp(`${attr}="([\\d.]+)"`)); return m ? parseFloat(m[1]!) : d; };
  let width = num("data-width", 1920), height = num("data-height", 1080);
  width = Math.round(width / 2) * 2; height = Math.round(height / 2) * 2;
  return { name, html, width, height, duration: num("data-duration", 5) };
}

async function openBlock(browser: Browser, b: BlockInfo, which: "real" | "compat"): Promise<Page> {
  const page = await browser.newPage(b.width, b.height);
  await page.send("Network.enable");
  await page.send("Network.setBlockedURLs", { urls: ["http:*", "https:*", "ws:*", "wss:*"] });
  const base = initScript({ pageValues: {}, width: b.width, height: b.height, fps: FPS, duration: b.duration });
  const lib = which === "real" ? libSource("real") : libScript(["gsap"]);
  await page.addInitScript(base + "\n;" + lib);
  await page.navigate(pathToFileURL(b.html).href, 30000);
  const ready = await page.evaluate<{ ok: boolean; errors: string[] }>("window.RC ? window.RC.ready : { ok: false, errors: ['no runtime'] }", true);
  // the sparse clone has no carousel image assets: a missing image is the same for both variants, not a failure
  const real = (ready?.errors ?? []).filter((e) => !/image failed to load/.test(e));
  await page.evaluate("window.RC && window.RC.errors.splice(0, window.RC.errors.length)");
  if (!ready || real.length) throw new Error(`build failed: ${real.join(" | ").slice(0, 400)}`);
  return page;
}

async function shot(page: Page, b: BlockInfo): Promise<string> {
  const r = (await page.send("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { x: 0, y: 0, width: b.width, height: b.height, scale: SCALE } })) as { data: string };
  return r.data;
}

const COMPARE = `async (a, b) => {
  const load = (d) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = "data:image/png;base64," + d; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const w = ia.width, h = ia.height;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.clearRect(0, 0, w, h); x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, w, h).data;
  x.clearRect(0, 0, w, h); x.drawImage(ib, 0, 0); const db = x.getImageData(0, 0, w, h).data;
  let sum = 0, sq = 0, big = 0, n = 0;
  for (let i = 0; i < da.length; i += 4) {
    let px = 0;
    for (let k = 0; k < 3; k++) { const d = Math.abs(da[i + k] - db[i + k]); sum += d; sq += d * d; if (d > px) px = d; }
    n += 3; if (px > 24) big++;
  }
  const mse = sq / n;
  return { mad: sum / n, psnr: mse ? 10 * Math.log10(255 * 255 / mse) : 99, bigPct: 100 * big / (da.length / 4) };
}`;

async function main() {
  const out = process.argv[2]!;
  mkdirSync(out, { recursive: true });
  const listFile = arg("--list");
  let names: string[] = listFile ? readFileSync(listFile, "utf8").split(/\s+/).filter(Boolean) : [];
  const only = arg("--only");
  if (only) names = only.split(",");
  const max = Number(arg("--max", "999"));
  const nTimes = Number(arg("--times", "6"));
  names = names.slice(0, max);
  const browser = await Browser.launch({ extraFlags: NO_NETWORK_FLAGS });
  const cmpPage = await browser.newPage(64, 64);
  await cmpPage.navigate("data:text/html,<p>cmp</p>");
  const results: unknown[] = [];
  try {
    for (const name of names) {
      const b = blockInfo(name);
      if (!b) { results.push({ name, status: "skip", why: "no html" }); continue; }
      const frames = Math.round(b.duration * FPS);
      const sampleFrames = Array.from({ length: nTimes }, (_, i) => Math.min(frames - 1, Math.round(((i + 0.5) / nTimes) * frames)));
      const shots: Record<string, string[]> = { real: [], compat: [] };
      const errs: Record<string, string> = {};
      const t0 = performance.now();
      for (const which of ["real", "compat"] as const) {
        let page: Page | null = null;
        try {
          page = await openBlock(browser, b, which);
          // seek every frame in order (as the renderer does), capture at the sample frames
          for (let f = 0; f <= sampleFrames[sampleFrames.length - 1]!; f++) {
            await page.evaluate(`window.__hf.seek(${f} / ${FPS})`, true);
            if (sampleFrames.includes(f)) {
              shots[which]!.push(await shot(page, b));
              const ev = arg("--eval");
              if (ev) console.log(`  ${which} f${f}: ${JSON.stringify(await page.evaluate(ev)).slice(0, 1500)}`);
            }
          }
          const pe = await page.evaluate<string[]>("window.RC.errors.slice(0, 5)");
          if (pe?.length) errs[which] = pe.join(" | ").slice(0, 300);
        } catch (e) {
          errs[which] = String((e as Error).message).slice(0, 300);
        } finally {
          if (page) await browser.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
        }
      }
      const per: Array<{ t: number; mad: number; psnr: number; bigPct: number }> = [];
      if (shots.real!.length === sampleFrames.length && shots.compat!.length === sampleFrames.length) {
        for (let i = 0; i < sampleFrames.length; i++) {
          const m = await cmpPage.evaluate<{ mad: number; psnr: number; bigPct: number }>(`(${COMPARE})(${JSON.stringify(shots.real![i])}, ${JSON.stringify(shots.compat![i])})`, true);
          per.push({ t: +(sampleFrames[i]! / FPS).toFixed(3), mad: +m.mad.toFixed(3), psnr: +m.psnr.toFixed(1), bigPct: +m.bigPct.toFixed(2) });
          writeFileSync(join(out, `${name}-${i}-real.png`), Buffer.from(shots.real![i]!, "base64"));
          writeFileSync(join(out, `${name}-${i}-compat.png`), Buffer.from(shots.compat![i]!, "base64"));
        }
      }
      const minPsnr = per.length ? Math.min(...per.map((p) => p.psnr)) : 0;
      const maxBig = per.length ? Math.max(...per.map((p) => p.bigPct)) : 100;
      const status = !per.length ? "broken" : minPsnr >= 40 && maxBig < 0.1 ? "match" : minPsnr >= 26 && maxBig < 3 ? "close" : "broken";
      const row = { name, status, minPsnr, maxBigPct: maxBig, duration: b.duration, size: `${b.width}x${b.height}`, per, errors: errs, ms: Math.round(performance.now() - t0) };
      results.push(row);
      console.log(`${status.padEnd(6)} ${name.padEnd(36)} minPSNR ${String(minPsnr).padStart(5)} dB  maxBig ${String(maxBig).padStart(6)} %  ${Object.keys(errs).length ? "ERR " + JSON.stringify(errs).slice(0, 200) : ""}`);
      writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 1));
    }
  } finally {
    await browser.close();
  }
}
await main();
