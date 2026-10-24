// collage-fx (2026-10-20): the `effect` blocks the named effects carry, and matte compositions render deterministically.
// Render tests are small (108x192 / 270x480, low fps) and skipped without Chromium, like render.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "../src/cdp.ts";
import { alphaStats } from "../src/ffmpeg.ts";
import { listLibrary, LIBRARY_DIR } from "../src/library.ts";
import { parseManifest } from "../src/params.ts";
import { PKG_ROOT, render } from "../src/render.ts";

interface Key { t: number; scale?: number; x?: number; y?: number; ease?: string }
interface Effect { fx: string[]; stack: string[]; inputs?: Record<string, string>; plateKeys?: Key[]; plateKeysOn?: string[] }

const STACK = new Set(["plate", "cutout", "self", "self:back", "self:front"]);
const EASES = new Set(["linear", "hold", "ease_in", "ease_out", "ease_in_out"]);
const withEffect = listLibrary()
  .map((e) => ({ e, m: parseManifest(readFileSync(e.html, "utf8")) as ReturnType<typeof parseManifest> & { effect?: Effect } }))
  .filter((x) => x.m.effect);

describe("effect blocks (the editor recipe for each named effect)", () => {
  test("the 17 named effects and the collage kit that are compositions carry one", () => {
    const names = withEffect.map((x) => x.m.name);
    for (const n of ["orbit", "couch-wall", "ui-world", "frame-break", "headline-wall", "pullback-window", "green-screen", "paper-cut", "doodle-boil", "vertigo", "cover-story", "glass-type",
      "cutout-outline", "paper-texture", "parallax-strip", "triptych", "halftone-push", "map-route", "retro-tv"]) {
      expect(names).toContain(n);
    }
  });

  for (const { m } of withEffect) {
    test(`${m.name}: stack, layers, fx ids and plate keys are valid`, () => {
      const fx = m.effect as Effect;
      expect(fx.fx.length).toBeGreaterThan(0);
      for (const id of fx.fx) expect(id).toMatch(/^FX-\d\d$/);
      expect(fx.stack.some((s) => s.startsWith("self"))).toBe(true);
      for (const s of fx.stack) expect(STACK.has(s)).toBe(true);
      // a split stack needs the layer param, with both halves
      if (fx.stack.some((s) => s.includes(":"))) {
        const layer = m.params.layer as { type: string; options?: string[] } | undefined;
        expect(layer?.type).toBe("enum");
        expect(layer?.options).toEqual(expect.arrayContaining(["all", "back", "front"]));
      }
      if (fx.stack.includes("cutout")) expect(Object.keys(fx.inputs ?? {})).toContain("cutout");
      const keys = fx.plateKeys ?? [];
      keys.forEach((k, i) => { if (i > 0) expect(k.t).toBeGreaterThanOrEqual(keys[i - 1]?.t ?? 0); });
      for (const k of keys) if (k.ease) expect(EASES.has(k.ease)).toBe(true);
      for (const on of fx.plateKeysOn ?? []) expect(["plate", "cutout"]).toContain(on);
      if (keys.length) expect(fx.stack).toContain("plate");
    });
  }
});

let haveChrome = true;
try {
  findChrome();
} catch {
  haveChrome = false;
}
const T = 90_000;
const tmp = mkdtempSync(join(tmpdir(), "restorffcut-collage-fx-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const STAND_IN = join(PKG_ROOT, "examples", "collage-fx", "stand-in.html");

describe.skipIf(!haveChrome)("matte compositions (Chromium + FFmpeg)", () => {
  test("paper-cut with matte frames: SVG torn edge renders, same pixels twice", async () => {
    const dir = join(tmp, "matte");
    await render({ composition: STAND_IN, out: dir, format: "png", props: { layer: "cutout" }, width: 108, height: 192, fps: 10, duration: 0.6 });
    const matte = readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => join(dir, f));
    expect(matte.length).toBe(6);
    const opts = {
      composition: join(LIBRARY_DIR, "paper-cut", "paper-cut.html"),
      props: { layout: "full", layer: "back", matte, matteFps: 10 },
      width: 108, height: 192, fps: 10, duration: 0.6, workers: 3,
    };
    const a = await render({ ...opts, out: join(tmp, "pc-a.webm") });
    const b = await render({ ...opts, out: join(tmp, "pc-b.webm") });
    expect(a.framesHash).toBe(b.framesHash);
    expect((await alphaStats(a.out, 0.3)).max).toBeGreaterThan(240); // the paper is opaque
  }, T);

  test("orbit: layer back and layer front each carry cards", async () => {
    const base = { composition: join(LIBRARY_DIR, "orbit", "orbit.html"), width: 270, height: 480, fps: 10, duration: 1.5 };
    const back = await render({ ...base, props: { layer: "back" }, out: join(tmp, "orbit-back.webm") });
    const front = await render({ ...base, props: { layer: "front" }, out: join(tmp, "orbit-front.webm") });
    expect((await alphaStats(back.out, 1.0)).max).toBeGreaterThan(200);
    expect((await alphaStats(front.out, 1.0)).max).toBeGreaterThan(200);
  }, T);
});
