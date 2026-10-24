// Integration tests: real Chromium + FFmpeg. Skipped (not failed) when no Chromium is installed, so the root
// `bun test` stays green on machines without one. Renders are small (540x960, low fps) to keep this under a minute.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, findChrome } from "../src/cdp.ts";
import { alphaStats, frameMd5, probe } from "../src/ffmpeg.ts";
import { LIBRARY_DIR } from "../src/library.ts";
import { openPage, prepare, render } from "../src/render.ts";

let haveChrome = true;
try {
  findChrome();
} catch {
  haveChrome = false;
}
const T = 90_000;
const tmp = mkdtempSync(join(tmpdir(), "restorffcut-compositions-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const BWP = join(LIBRARY_DIR, "big-word-punch", "big-word-punch.html");
const small = { width: 540, height: 960 };

describe.skipIf(!haveChrome)("render (Chromium + FFmpeg)", () => {
  test("deterministic: the same composition twice gives identical frames", async () => {
    const a = await render({ composition: BWP, out: join(tmp, "a.webm"), duration: 1, fps: 12, workers: 4, ...small });
    const b = await render({ composition: BWP, out: join(tmp, "b.webm"), duration: 1, fps: 12, workers: 4, ...small });
    expect(a.framesHash).toBe(b.framesHash); // captured PNGs, byte for byte
    expect(a.inputHash).toBe(b.inputHash);
    const ma = await frameMd5(a.out); // decoded output, RGBA incl. alpha
    const mb = await frameMd5(b.out);
    expect(ma.length).toBe(12);
    expect(ma).toEqual(mb);
  }, T);

  test("deterministic with an image, 3D tilt and 3 tabs", async () => {
    const html = join(LIBRARY_DIR, "ui-card-pop", "ui-card-pop.html");
    const opts = { composition: html, duration: 1.2, fps: 10, workers: 3, ...small };
    const a = await render({ ...opts, out: join(tmp, "c1.webm") });
    const b = await render({ ...opts, out: join(tmp, "c2.webm") });
    expect(a.framesHash).toBe(b.framesHash);
    expect(await frameMd5(a.out)).toEqual(await frameMd5(b.out));
  }, T);

  test("webm: VP9 with a real alpha channel, exact frame count and duration", async () => {
    const r = await render({ composition: BWP, out: join(tmp, "alpha.webm"), duration: 1.5, fps: 30, ...small });
    const p = await probe(r.out);
    expect(p.codec).toBe("vp9");
    expect(p.alphaMode).toBe(true); // alpha_mode=1 tag
    expect(p.decodedPixFmt).toBe("yuva420p"); // decoded with libvpx, the alpha plane is there
    expect(p.frames).toBe(45);
    expect(r.frames).toBe(45);
    expect(p.duration).toBeCloseTo(1.5, 2);
    expect([p.width, p.height]).toEqual([540, 960]);
    const mid = await alphaStats(r.out, 1.0); // word and underline on screen
    expect(mid.min).toBe(0); // transparent background
    expect(mid.max).toBeGreaterThan(240); // opaque text
    const first = await alphaStats(r.out, 0); // nothing on screen yet
    expect(first.max).toBeLessThan(8);
    expect(existsSync(r.sidecar)).toBe(true);
  }, T);

  test("frame count is round(duration * fps) for awkward values", async () => {
    const r = await render({ composition: BWP, out: join(tmp, "odd.webm"), duration: 2.25, fps: 24, ...small, width: 270, height: 480 });
    expect(r.frames).toBe(54);
    expect((await probe(r.out)).frames).toBe(54);
  }, T);

  test("mov: ProRes 4444 with alpha", async () => {
    const r = await render({ composition: BWP, out: join(tmp, "alpha.mov"), duration: 0.5, fps: 12, ...small });
    const p = await probe(r.out);
    expect(p.codec).toBe("prores");
    expect(p.profile).toMatch(/4444/);
    expect(p.decodedPixFmt).toMatch(/^yuva444p/);
    expect(p.frames).toBe(6);
  }, T);

  test("png: a numbered frame sequence", async () => {
    const dir = join(tmp, "frames");
    const r = await render({ composition: BWP, out: dir, format: "png", duration: 0.5, fps: 10, ...small });
    expect(r.frames).toBe(5);
    expect(readdirSync(dir).filter((f) => f.endsWith(".png")).sort()).toEqual([
      "frame_00000.png", "frame_00001.png", "frame_00002.png", "frame_00003.png", "frame_00004.png",
    ]);
  }, T);

  test("fast capture (optimizeForSpeed) gives the same pixels as safe capture", async () => {
    // HyperFrames reports the fast path crushes alpha; it did not here (DECISION.md). This guards a Chromium update.
    const fast = join(tmp, "fast");
    const safe = join(tmp, "safe");
    const opts = { composition: BWP, format: "png" as const, duration: 1, fps: 6, ...small };
    await render({ ...opts, out: fast });
    process.env.RESTORFFCUT_CAPTURE = "safe";
    try {
      await render({ ...opts, out: safe });
    } finally {
      delete process.env.RESTORFFCUT_CAPTURE;
    }
    expect(await frameMd5(join(fast, "frame_%05d.png"))).toEqual(await frameMd5(join(safe, "frame_%05d.png")));
  }, T);

  test("chart-grow: the numbers on screen end exactly at the input values (bars and line)", async () => {
    const html = join(LIBRARY_DIR, "chart-grow", "chart-grow.html");
    const browser = await Browser.launch();
    try {
      for (const style of ["bars", "line"]) {
        const prep = prepare({ composition: html, out: join(tmp, "x.webm"), props: { style, callout: "10x" }, ...small });
        const page = await openPage(browser, prep);
        await page.evaluate(`window.__hf.seek(${prep.duration - 0.6})`); // after the build, before the exit
        const texts = await page.evaluate<string[]>("Array.from(document.querySelectorAll('.val')).map((e) => e.textContent)");
        expect(texts).toEqual(["1.2k", "2.9k", "4.1k", "7.8k", "12.4k"]);
        expect(await page.evaluate<string[]>("window.RC.errors.slice()")).toEqual([]);
      }
    } finally {
      await browser.close();
    }
  }, T);

  test("bad params fail before a browser starts, listing every problem", async () => {
    await expect(render({ composition: BWP, out: join(tmp, "x.webm"), props: { speed: 99, accnet: "#fff" } })).rejects.toThrow(
      /speed: 99 is above the maximum[\s\S]*accnet: not a param|accnet: not a param[\s\S]*speed: 99/,
    );
  }, T);

  test("a composition that throws in render() fails the render with the page error", async () => {
    const bad = join(tmp, "bad.html");
    writeFileSync(
      bad,
      `<!doctype html><html><head><script type="application/json" id="params">` +
        `{"name":"bad","title":"Bad","description":"Throws on purpose.","duration":0.5,"size":[64,64],"params":{}}` +
        `</script></head><body><script>RC.composition({ render: function (t) { if (t.T > 0.2) throw new Error("boom"); } });</script></body></html>`,
    );
    await expect(render({ composition: bad, out: join(tmp, "bad.webm"), fps: 10 })).rejects.toThrow(/boom/);
  }, T);
});
