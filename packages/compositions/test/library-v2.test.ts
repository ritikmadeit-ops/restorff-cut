// library-v2 (wave 5, 2026-10-20): fit-to-duration + speed everywhere, no example display text in applied renders,
// data: images in custom renders (network still blocked), the timeline kit, the promoted library pieces, Headline
// Wall's face box. Pure tests first; render tests (real Chromium + FFmpeg, tiny sizes) skip without Chromium.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Browser, findChrome } from "../src/cdp.ts";
import {
  CUSTOM_MAX_IMAGE_BYTES,
  injectKit,
  KIT_MARKER,
  NO_NETWORK_FLAGS,
  openCustomPage,
  prepareCustom,
  renderCustom,
  validateCustom,
  validateKit,
} from "../src/custom.ts";
import { probe } from "../src/ffmpeg.ts";
import { LIBRARY_DIR, listLibrary } from "../src/library.ts";
import { parseManifest, resolveApplied } from "../src/params.ts";
import { fitFor, openPage, prepare, rateFor, render } from "../src/render.ts";
import { catalogue, NeedsError, renderCached } from "../src/service.ts";
import type { CompositionManifest, NumberParam } from "../src/types.ts";

const NEW = ["glass-panel-kit", "waveform-collapse", "filmstrip-flash", "before-after-wipe", "easing-curve", "paper-form", "toc-list"];
const LIB = listLibrary();
const html = (name: string) => join(LIBRARY_DIR, name, `${name}.html`);
const manifest = (name: string): CompositionManifest => parseManifest(readFileSync(html(name), "utf8"));
const exampleOf = (name: string) => JSON.parse(readFileSync(join(LIBRARY_DIR, name, `${name}.props.json`), "utf8")) as Record<string, unknown>;

// a solid-colour PNG as a data: URL (no files, no network)
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i] as number;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function pngDataUrl(w: number, h: number, rgb: [number, number, number]): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}
const KILN = pngDataUrl(40, 40, [200, 85, 61]);

/** A custom page: an inline data: <img>, an image param, and (optionally) the timeline kit. */
function customPage({ extra = "", kit = false }: { extra?: string; kit?: boolean } = {}): string {
  return `<!doctype html><html><head><meta charset="utf-8">${kit ? KIT_MARKER : ""}
<script type="application/json" id="params">{"params":{"pic":{"type":"image","default":"${KILN}"},"word":{"type":"string","default":"STEEP"}}}</script></head>
<body><div id="stage"></div><img id="inline" src="${KILN}" style="position:absolute;left:60px;top:0;width:40px;height:40px">
<script>${extra}
RC.composition({ build: function (RC) { document.getElementById("stage").appendChild(RC.el("img", { id: "param", src: RC.params.pic, style: { position: "absolute", left: "0", top: "0", width: "40px", height: "40px" } }));
  var w = RC.el("div", { id: "w", text: ${kit ? "kitWord(RC.params.word)" : "RC.params.word"}, style: { position: "absolute", left: "10px", top: "60px", color: "#EDEBE6", fontSize: "30px" } });
  document.getElementById("stage").appendChild(w); },
  render: function (time, RC) { RC.set(document.getElementById("w"), { opacity: RC.progress(time.t, 0, 0.3, "smooth") }); } });
</script></body></html>`;
}

describe("speed and fit-to-duration (pure)", () => {
  test("every library composition declares the standard speed param (number 0.25-4, default 1)", () => {
    expect(LIB.length).toBeGreaterThanOrEqual(48);
    for (const e of LIB) {
      const s = manifest(e.name).params.speed as NumberParam | undefined;
      expect({ name: e.name, type: s?.type, default: s?.default, min: s?.min, max: s?.max }).toEqual({ name: e.name, type: "number", default: 1, min: 0.25, max: 4 });
    }
  });

  test("the promoted pieces are in the library", () => {
    const names = LIB.map((e) => e.name);
    for (const n of [...NEW, "float-thumbs"]) expect(names).toContain(n);
  });

  test("fitFor compresses only, honours fit: false and the switch; rateFor = max(speed, fit / duration)", () => {
    expect(fitFor(undefined, 4, 0.92)).toBe(4);
    expect(fitFor(undefined, 4, 4)).toBe(0);
    expect(fitFor(undefined, 4, 6)).toBe(0);
    expect(fitFor(3, 4, 1)).toBe(3);
    expect(fitFor(false, 4, 1)).toBe(0);
    expect(fitFor(undefined, 4, 1, false)).toBe(0);
    expect(rateFor({ speed: 1 }, 4, 1)).toBe(4);
    expect(rateFor({ speed: 1.8 }, 4, 1)).toBe(4);
    expect(rateFor({ speed: 0.8 }, 0, 1)).toBe(0.8);
    expect(rateFor({ speed: 4 }, 2, 1)).toBe(4);
  });

  test("a render shorter than the natural length is fitted, and the fit is part of the hash", () => {
    const base = { composition: html("ui-world"), out: "x.webm", width: 270, height: 480 };
    const short = prepare({ ...base, duration: 0.92 });
    const off = prepare({ ...base, duration: 0.92, fit: false });
    const full = prepare({ ...base });
    expect(short.fit).toBe(4);
    expect(off.fit).toBe(0);
    expect(full.fit).toBe(0);
    expect(short.inputHash).not.toBe(off.inputHash);
    // captions on the voice never compress
    expect(prepare({ composition: html("word-pop"), out: "x.webm", duration: 1 }).fit).toBe(0);
  });
});

describe("example display text never reaches an applied render (pure)", () => {
  test("optional display params render blank, required ones are asked for", () => {
    const db = resolveApplied(manifest("doodle-boil"), {});
    expect(db.needs).toEqual([]);
    expect(db.values.word).toBe("");
    expect(resolveApplied(manifest("headline-wall"), {}).needs).toEqual(["headlines"]);
    expect(resolveApplied(manifest("stamp"), {}).needs).toEqual(["text"]);
    expect(resolveApplied(manifest("stamp"), { text: "" }).needs).toEqual(["text"]);
    const st = resolveApplied(manifest("stamp"), { text: "NO SUGAR" });
    expect(st.needs).toEqual([]);
    expect(st.values.sub).toBe("");
    // generic UI words are not display copy
    const ph = resolveApplied(manifest("phone-mockup"), { request: "Reorder", answer: "Ready" });
    expect(ph.needs).toEqual([]);
    expect(ph.values.action).toBe("Approve");
    expect(ph.values.appName).toBe("");
    // float-thumbs: cards are needed unless images are sent
    expect(resolveApplied(manifest("float-thumbs"), {}).needs).toEqual(["cards"]);
    expect(resolveApplied(manifest("float-thumbs"), { images: [KILN] }).needs).toEqual([]);
    // numbers that are data: counter.to must be sent
    expect(resolveApplied(manifest("counter"), {}).needs).toContain("to");
  });

  test("the catalogue's example (what effects apply merges) has no display params; the sample keeps them", () => {
    const cat = catalogue();
    for (const e of cat) {
      for (const k of e.display) expect({ name: e.name, key: k, inExample: k in e.example }).toEqual({ name: e.name, key: k, inExample: false });
      const spec = e.params[e.display[0] ?? ""] as { default?: unknown; example?: unknown; display?: boolean } | undefined;
      if (spec && (spec.default === "" || Array.isArray(spec.default))) expect(spec.display).toBe(true);
    }
    const db = cat.find((e) => e.name === "doodle-boil");
    expect(db?.example.word).toBeUndefined();
    expect(db?.sample.word).toBe("small batch");
    const hw = cat.find((e) => e.name === "headline-wall");
    expect(hw?.required).toContain("headlines");
    expect((hw?.params.headlines as { default?: unknown }).default).toEqual([]);
    // no invented copy anywhere in what `effects describe` shows a model: only `sample` (the gallery) carries it
    expect(JSON.stringify(hw?.params)).not.toMatch(/GRINDSTONE/);
    expect(JSON.stringify(hw?.sample)).toMatch(/GRINDSTONE/);
    expect((cat.find((e) => e.name === "counter")?.params.to as { default?: unknown }).default).toBeUndefined();
    expect(hw?.fit).toBe(4);
    expect(cat.find((e) => e.name === "word-pop")?.fit).toBe(false);
  });

  test("the service answers needs before any browser starts", async () => {
    let err: unknown = null;
    try {
      await renderCached({ name: "headline-wall", props: { layout: "wall" } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NeedsError);
    expect((err as NeedsError).details.needs).toEqual(["headlines"]);
    expect((err as Error).message).toMatch(/headlines \(list of \{source, headline, date\?, kind\?\}, at least 1\)/);
  });
});

describe("timeline kit and data: images (pure)", () => {
  test("a source that includes the kit needs one; the kit obeys the same rules", () => {
    expect(validateCustom(customPage({ kit: true })).errors.join()).toMatch(/rc-kit/);
    expect(validateCustom(customPage({ kit: true }), {}, { kit: { js: "function kitWord(w) { return w + '!'; }" } }).ok).toBe(true);
    const bad = validateCustom(customPage({ kit: true }), {}, { kit: { js: "function kitWord(w) { fetch('x'); return w; }" } });
    expect(bad.errors.some((e) => /^kit line \d+: fetch/.test(e))).toBe(true);
    expect(validateKit({ js: "RC.composition({ render: function () {} })" }).ok).toBe(false);
    expect(validateKit("x".repeat(129 * 1024)).ok).toBe(false);
    expect(injectKit(`<head>${KIT_MARKER}</head>`, { css: ".k{}" })).toBe("<head><style data-rc-kit>\n.k{}\n</style></head>");
  });

  test("the kit is in the hash only for sources that include it", () => {
    const tiny = { width: 270, height: 480, fps: 10, duration: 1 };
    const a = prepareCustom({ source: customPage({ kit: true }), kit: { js: "function kitWord(w) { return w; }" }, ...tiny }).prep.inputHash;
    const b = prepareCustom({ source: customPage({ kit: true }), kit: { js: "function kitWord(w) { return w + '.'; }" }, ...tiny }).prep.inputHash;
    expect(a).not.toBe(b);
    const c = prepareCustom({ source: customPage(), kit: { js: "var x = 1;" }, ...tiny }).prep.inputHash;
    const d = prepareCustom({ source: customPage(), kit: { js: "var x = 2;" }, ...tiny }).prep.inputHash;
    expect(c).toBe(d);
  });

  test("image params: data:image only, at most 4 MB each", () => {
    expect(validateCustom(customPage(), { pic: "data:text/plain;base64,aGk=" }).errors.join()).toMatch(/not an image/);
    const big = `data:image/png;base64,${"A".repeat(CUSTOM_MAX_IMAGE_BYTES)}`;
    expect(validateCustom(customPage(), { pic: big }).errors.join()).toMatch(/limit is 4194304/);
    expect(validateCustom(customPage(), { pic: KILN }).ok).toBe(true);
  });
});

let haveChrome = true;
try {
  findChrome();
} catch {
  haveChrome = false;
}
const T = 120_000;
const tmp = mkdtempSync(join(tmpdir(), "restorffcut-library-v2-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!haveChrome)("library-v2 renders (Chromium + FFmpeg)", () => {
  test("UI World in a 0.92 s window still types (fitted clock); without the fit it never does", async () => {
    const base = { composition: html("ui-world"), out: join(tmp, "uw.webm"), width: 270, height: 480, duration: 0.92 };
    const browser = await Browser.launch();
    try {
      const typedAt = async (fit: boolean) => {
        const page = await openPage(browser, prepare({ ...base, fit }));
        await page.evaluate("window.__hf.seek(0.85)");
        return page.evaluate<{ n: number; rate: number }>("({ n: UW.typed.firstChild.textContent.length, rate: RC.rate })");
      };
      const on = await typedAt(true);
      const off = await typedAt(false);
      expect(on.rate).toBeCloseTo(4 / 0.92, 5);
      expect(on.n).toBeGreaterThan(10);
      expect(off.rate).toBe(1);
      expect(off.n).toBe(0);
    } finally {
      await browser.close();
    }
  }, T);

  test("data: images load in a custom render while the network stays blocked", async () => {
    let hits = 0;
    const server = Bun.serve({ port: 0, fetch: () => (hits++, new Response("leak")) });
    const url = `http://127.0.0.1:${server.port}`;
    try {
      // built from parts so it reaches the page (the static check would refuse it): the runtime layer is under test
      const extra = `var I = window["Ima" + "ge"]; var j = new I(); j.src = "${url}" + "/leak.png";`;
      const { prep } = prepareCustom({ source: customPage(), width: 270, height: 480, fps: 10, duration: 0.5, workers: 1 });
      prep.html = customPage({ extra });
      const browser = await Browser.launch({ extraFlags: NO_NETWORK_FLAGS });
      const attempts: string[] = [];
      try {
        const page = await openCustomPage(browser, prep, attempts);
        for (let k = 0; k < 20 && !attempts.length; k++) await new Promise((r) => setTimeout(r, 100));
        const imgs = await page.evaluate<{ inline: number; param: number; errors: string[] }>(
          "({ inline: document.getElementById('inline').naturalWidth, param: document.getElementById('param').naturalWidth, errors: RC.errors.slice() })",
        );
        expect(imgs).toEqual({ inline: 40, param: 40, errors: [] });
      } finally {
        await browser.close();
      }
      expect(attempts).toContain(`${url}/leak.png`);
      // and the whole render goes through (it failed with "image failed to load: data:…" before)
      const r = await renderCustom({ source: customPage(), props: { pic: KILN }, width: 270, height: 480, fps: 10, duration: 0.5, workers: 1, out: join(tmp, "data-img.webm") });
      expect(r.frames).toBe(5);
      expect(r.blocked).toEqual([]);
    } finally {
      server.stop(true);
    }
    expect(hits).toBe(0);
  }, T);

  test("a custom composition renders with the timeline kit's code", async () => {
    const r = await renderCustom({
      source: customPage({ kit: true }),
      kit: { js: "function kitWord(w) { return w + ' KIT'; }", css: "#w { letter-spacing: .1em; }" },
      width: 270, height: 480, fps: 10, duration: 0.5, workers: 1, out: join(tmp, "kit.webm"),
    });
    expect(r.frames).toBe(5);
    const side = JSON.parse(readFileSync(`${r.out}.json`, "utf8")) as { kitSha256?: string };
    expect(side.kitSha256).toMatch(/^[0-9a-f]{64}$/);
  }, T);

  for (const name of [...NEW, "float-thumbs"]) {
    test(`${name}: renders its example in a short window (fitted), VP9 alpha, no page errors`, async () => {
      const props = exampleOf(name);
      if (name === "float-thumbs") props.images = [KILN, KILN];
      const r = await render({ composition: html(name), props, propsDir: join(LIBRARY_DIR, name), width: 270, height: 480, fps: 10, duration: 0.6, workers: 2, out: join(tmp, `${name}.webm`) });
      expect(r.frames).toBe(6);
      if (manifest(name).fit === false) {
        // toc-list: its items are voice cues over a whole video, so it never compresses
        expect(r.fit).toBe(0);
        expect(r.rate).toBe(1);
      } else {
        expect(r.fit).toBeGreaterThan(0.6);
        expect(r.rate).toBeGreaterThan(1);
      }
      const info = await probe(r.out);
      expect(info.alphaMode).toBe(true);
    }, T);
  }

  test("the service renders an applied composition with blank optional display params", async () => {
    const prev = process.env.RESTORFFCUT_COMPOSITIONS_CACHE;
    process.env.RESTORFFCUT_COMPOSITIONS_CACHE = join(tmp, "cache");
    try {
      const req = { name: "toc-list", props: { items: ["Grind", "Steep", "Bottle"] }, width: 270, height: 480, fps: 10, duration: 1 };
      const a = await renderCached(req);
      expect(a.blanked).toEqual(expect.arrayContaining(["count", "title", "subtitle"]));
      expect(a.params.title).toBe("");
      expect(a.cached).toBe(false);
      expect((await renderCached(req)).cached).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.RESTORFFCUT_COMPOSITIONS_CACHE;
      else process.env.RESTORFFCUT_COMPOSITIONS_CACHE = prev;
    }
  }, T);

  test("Headline Wall (layout wall) follows the face box down; the default face keeps the old layout", async () => {
    const browser = await Browser.launch();
    try {
      const ys = async (props: Record<string, unknown>) => {
        const prep = prepare({ composition: html("headline-wall"), out: join(tmp, "hw.webm"), width: 270, height: 480, props: { layout: "wall", ...props } });
        const page = await openPage(browser, prep);
        return page.evaluate<number[]>("W.cards.map(function (c) { return c.y; })");
      };
      const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
      const base = await ys({});
      const low = await ys({ face: { x: 0.5, y: 0.64, w: 0.3, h: 0.18 } });
      const off = await ys({ offsetY: 300 });
      expect(mean(low) - mean(base)).toBeGreaterThan(0.25 * 480);
      expect(mean(off) - mean(base)).toBeGreaterThan(0.2 * 300 * (270 / 1080) * 0.9);
      const bottom = await ys({ anchor: "bottom" });
      expect(Math.max(...bottom)).toBeGreaterThan(Math.max(...base));
    } finally {
      await browser.close();
    }
  }, T);
});
