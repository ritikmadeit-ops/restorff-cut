// Custom compositions: static validation (pure, fast) + the sandboxed render (real Chromium + FFmpeg; skipped when no
// Chromium is installed). Renders are tiny (270×480, 1 s at 10 fps).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, findChrome } from "../src/cdp.ts";
import {
  CUSTOM_MAX_BYTES,
  CustomInvalidError,
  customHash,
  listCustomExamples,
  NO_NETWORK_FLAGS,
  nudgeCustom,
  openCustomPage,
  prepareCustom,
  renderCustom,
  renderCustomCached,
  validateCustom,
} from "../src/custom.ts";
import { probe } from "../src/ffmpeg.ts";

/** A minimal valid custom composition; `extra` goes inside the page script, `head` into <head>. */
function page({ extra = "", head = "", params = true }: { extra?: string; head?: string; params?: boolean } = {}): string {
  const block = params
    ? `<script type="application/json" id="params">{"params":{"word":{"type":"string","default":"STEEP"},"accent":{"type":"color","default":"#F6FF00"},"speed":{"type":"number","default":1,"min":0.25,"max":4},"img":{"type":"image","default":"data:image/png;base64,iVBORw0KGgo="}}}</script>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8">${block}${head}</head><body><div id="stage"></div>
<script>${extra}
RC.composition({ build: function (RC) { document.getElementById("stage").appendChild(RC.el("div", { id: "w", text: String(RC.params.word || "X"), style: { position: "absolute", left: "10px", top: "10px", color: "#EDEBE6", fontSize: "40px" } })); },
  render: function (time, RC) { RC.set(document.getElementById("w"), { opacity: RC.progress(time.t, 0, 0.5, "smooth") }); } });
</script></body></html>`;
}

const hasError = (v: { errors: string[] }, re: RegExp) => v.errors.some((e) => re.test(e));

describe("validateCustom", () => {
  test("the worked examples validate with no errors and no warnings", () => {
    const ex = listCustomExamples();
    expect(ex.map((e) => e.name).sort()).toEqual(["growth-chart", "kinetic-type", "perspective-grid"]);
    for (const e of ex) {
      const v = validateCustom(e.source, e.props);
      expect({ name: e.name, errors: v.errors, warnings: v.warnings }).toEqual({ name: e.name, errors: [], warnings: [] });
      expect(v.protocol).toBe("rc");
      expect(v.manifest?.name).toBe(e.name);
    }
  });

  test("a minimal page is valid and fills defaults from its params block", () => {
    const v = validateCustom(page(), { word: "COLD" });
    expect(v.ok).toBe(true);
    expect(v.values).toEqual({ word: "COLD", accent: "#F6FF00", speed: 1, img: "data:image/png;base64,iVBORw0KGgo=" });
    expect(v.manifest?.name).toBe("custom"); // name/title/duration/size are optional in a custom params block
  });

  test("without a params block props pass through, with a warning", () => {
    const v = validateCustom(page({ params: false }), { word: "COLD", $comment: "dropped" });
    expect(v.ok).toBe(true);
    expect(v.values).toEqual({ word: "COLD" });
    expect(v.warnings.join(" ")).toMatch(/no params block/);
  });

  test.each([
    ["fetch", 'fetch("/x");', /fetch\(\)/],
    ["XMLHttpRequest", "var x = new XMLHttpRequest();", /XMLHttpRequest/],
    ["WebSocket", 'var s = new WebSocket("ws://a");', /WebSocket/],
    ["dynamic import", 'import("./a.js");', /dynamic import/],
    ["sendBeacon", 'navigator.sendBeacon("/a");', /sendBeacon/],
    ["a string URL", 'var u = "https://cdn.example.com/a.png";', /cannot load/],
    ["navigation", 'window.location = "x";', /navigation/],
    ["storage", 'localStorage.setItem("a", "b");', /storage/],
    ["the wall clock", "var d = Date.now();", /wall clock/],
    ["Math.random", "var r = Math.random();", /Math\.random/],
    ["requestAnimationFrame", "requestAnimationFrame(function () {});", /requestAnimationFrame/],
    ["timers", "setTimeout(function () {}, 10);", /timers/],
  ])("refuses %s", (_name, extra, re) => {
    const v = validateCustom(page({ extra }));
    expect(v.ok).toBe(false);
    expect(hasError(v, re)).toBe(true);
  });

  test.each([
    ["an external script", '<script src="https://cdn.example.com/gsap.js"></script>', /src="https:\/\/cdn/],
    ["a stylesheet link", '<link rel="stylesheet" href="https://fonts.example.com/a.css">', /<link>/],
    ["a relative image (would read the server's disk)", '<img src="../../secret.png">', /src="..\/..\/secret.png"/],
    ["a CSS url()", "<style>#stage { background: url(https://x.example.com/a.png); }</style>", /url\(https/],
    ["CSS @import", "<style>@import 'x.css';</style>", /@import/],
    ["an iframe", '<iframe src="data:text/html,hi"></iframe>', /<iframe>/],
  ])("refuses %s", (_name, head, re) => {
    const v = validateCustom(page({ head }));
    expect(v.ok).toBe(false);
    expect(hasError(v, re)).toBe(true);
  });

  test("allows data: URLs, #fragments, SVG namespaces and the optional runtime.js line (warned)", () => {
    const head =
      '<script src="../../src/runtime.js"></script><img src="data:image/png;base64,iVBORw0KGgo="><style>#stage { background: url("data:image/png;base64,AA=="); }</style>';
    const extra = 'var ns = "http://www.w3.org/2000/svg"; var f = "url(#fill)";';
    const v = validateCustom(page({ head, extra }));
    expect(v.errors).toEqual([]);
    expect(v.warnings.join(" ")).toMatch(/runtime\.js/);
  });

  test("needs the page protocol, and render() when it uses RC.composition", () => {
    expect(hasError(validateCustom("<html><body><p>hi</p></body></html>"), /no page protocol/)).toBe(true);
    expect(hasError(validateCustom("<script>RC.composition({ build: function () {} });</script>"), /no render/)).toBe(true);
    const hf = validateCustom("<script>window.__hf = { duration: 2, seek: function (t) { document.body.style.opacity = String(t / 2); } };</script>");
    expect(hf.ok).toBe(true);
    expect(hf.protocol).toBe("hf");
  });

  test("refuses more than 256 KB", () => {
    const big = page({ extra: `var pad = "${"a".repeat(CUSTOM_MAX_BYTES)}";` });
    const v = validateCustom(big);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/limit is 262144/);
  });

  test("checks props against the params block: unknown keys, types, URLs, non-data images", () => {
    expect(hasError(validateCustom(page(), { wrod: "x" }), /wrod: not a param/)).toBe(true);
    expect(hasError(validateCustom(page(), { speed: 9 }), /above the maximum/)).toBe(true);
    expect(hasError(validateCustom(page(), { word: "https://evil.example.com/" }), /is a URL/)).toBe(true);
    expect(hasError(validateCustom(page(), { img: "C:/Users/x/secret.png" }), /data: URLs/)).toBe(true);
    expect(validateCustom(page(), { img: "data:image/png;base64,AA==" }).ok).toBe(true);
    expect(hasError(validateCustom(page(), []), /JSON object/)).toBe(true);
  });

  test("a broken params block is an error, not a crash", () => {
    const src = page().replace('{"params":', '{"params": ,');
    expect(hasError(validateCustom(src), /not valid JSON/)).toBe(true);
  });
});

describe("customHash / prepareCustom / nudgeCustom", () => {
  const base = { source: page(), values: { a: 1, b: { c: 2, d: 3 } }, width: 540, height: 960, fps: 30, duration: 2 };

  test("same input, same hash — whatever the key order", () => {
    expect(customHash(base)).toBe(customHash({ ...base, values: { b: { d: 3, c: 2 }, a: 1 } }));
    expect(customHash(base)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("source, props, size, fps and length all change the hash", () => {
    const h = customHash(base);
    for (const v of [
      { ...base, source: `${base.source} ` },
      { ...base, values: { a: 2, b: { c: 2, d: 3 } } },
      { ...base, width: 542 },
      { ...base, fps: 24 },
      { ...base, duration: 2.5 },
    ]) expect(customHash(v)).not.toBe(h);
  });

  test("defaults, even sizes, and refusal with details", () => {
    const { prep } = prepareCustom({ source: page(), width: 541, height: 961 });
    expect([prep.width, prep.height, prep.fps, prep.duration, prep.frames]).toEqual([542, 962, 30, 4, 120]);
    expect(prep.html).not.toMatch(/runtime\.js/);
    try {
      prepareCustom({ source: page({ extra: "fetch('/x');" }), duration: 120 });
      throw new Error("should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(CustomInvalidError);
      const d = (e as CustomInvalidError).details;
      expect(d.errors.some((m) => /fetch/.test(m))).toBe(true);
      expect(d.errors.some((m) => /duration 120/.test(m))).toBe(true);
    }
  });

  test("a sentence changes the standard params of a custom composition", () => {
    const r = nudgeCustom({ source: page(), props: { word: "COLD" }, sentence: "faster and make it red" });
    expect(r.props.word).toBe("COLD");
    expect(r.props.speed).toBe(1.25);
    expect(typeof r.props.accent).toBe("string");
    expect(r.props.accent).not.toBe("#F6FF00");
    expect(() => nudgeCustom({ source: page({ params: false }), sentence: "faster" })).toThrow(/no params block/);
  });
});

let haveChrome = true;
try {
  findChrome();
} catch {
  haveChrome = false;
}
const tmp = mkdtempSync(join(tmpdir(), "restorffcut-custom-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const T = 90_000;
const tiny = { width: 270, height: 480, fps: 10, duration: 1, workers: 2 };

describe.skipIf(!haveChrome)("sandboxed render (Chromium + FFmpeg)", () => {
  test("the network is blocked: a live local server sees no request, and every attempt is reported", async () => {
    let hits = 0;
    const server = Bun.serve({ port: 0, fetch: () => (hits++, new Response("leak")) });
    const url = `http://127.0.0.1:${server.port}`;
    // Built from parts so it reaches the page (the static check would refuse it): this tests the runtime layer.
    const extra = `window.__probe = []; var F = window["fe" + "tch"];
      F("${url}/fetch").then(function () { __probe.push("fetch ok"); }, function () { __probe.push("fetch blocked"); });
      var W = window["Web" + "Socket"]; var s = new W("${url.replace("http", "ws")}/ws"); s.onopen = function () { __probe.push("ws open"); };
      var i = new Image(); i.src = "${url}/img.png"; var j = new Image(); j.src = "file:///C:/Windows/win.ini";`;
    const { prep } = prepareCustom({ source: page(), ...tiny });
    prep.html = page({ extra });
    const browser = await Browser.launch({ extraFlags: NO_NETWORK_FLAGS });
    const attempts: string[] = [];
    try {
      const p = await openCustomPage(browser, prep, attempts);
      for (let k = 0; k < 20 && attempts.length < 4; k++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 300));
      const probeResult = await p.evaluate<string>("JSON.stringify(window.__probe)");
      expect(probeResult).not.toMatch(/fetch ok|ws open/);
      expect(await p.evaluate<string>("location.protocol")).toBe("data:");
    } finally {
      await browser.close();
      server.stop(true);
    }
    expect(hits).toBe(0);
    expect(attempts).toEqual(expect.arrayContaining([`${url}/fetch`, `${url}/img.png`, "file:///C:/Windows/win.ini"]));
  }, T);

  test("renders an example to VP9 alpha with the right frame count", async () => {
    const ex = listCustomExamples().find((e) => e.name === "kinetic-type");
    if (!ex) throw new Error("kinetic-type example missing");
    const r = await renderCustom({ source: ex.source, props: ex.props, ...tiny, out: join(tmp, "k.webm") });
    expect(r.frames).toBe(10);
    expect(r.blocked).toEqual([]);
    const info = await probe(r.out);
    expect(info.codec).toBe("vp9");
    expect(info.alphaMode).toBe(true);
    expect(info.frames).toBe(10);
  }, T);

  test("a bare window.__hf page (HyperFrames protocol) renders too", async () => {
    const src = `<!doctype html><html><body><div id="b" style="position:absolute;left:0;top:0;width:100px;height:100px;background:#F6FF00"></div>
      <script>window.__hf = { duration: 1, seek: function (t) { document.getElementById("b").style.opacity = String(t); } };</script></body></html>`;
    const r = await renderCustom({ source: src, ...tiny, out: join(tmp, "hf.webm") });
    expect(r.frames).toBe(10);
    expect(r.validation.protocol).toBe("hf");
  }, T);

  test("cached by hash: the second identical request does not render", async () => {
    const prev = process.env.RESTORFFCUT_COMPOSITIONS_CACHE;
    process.env.RESTORFFCUT_COMPOSITIONS_CACHE = join(tmp, "cache");
    try {
      const a = await renderCustomCached({ source: page(), props: { word: "COLD" }, ...tiny });
      const b = await renderCustomCached({ source: page(), props: { word: "COLD" }, ...tiny });
      expect(a.cached).toBe(false);
      expect(b.cached).toBe(true);
      expect(b.hash).toBe(a.hash);
      expect(b.file).toBe(a.file);
      expect(b.report.network).toBe("blocked");
    } finally {
      if (prev === undefined) delete process.env.RESTORFFCUT_COMPOSITIONS_CACHE;
      else process.env.RESTORFFCUT_COMPOSITIONS_CACHE = prev;
    }
  }, T);
});
