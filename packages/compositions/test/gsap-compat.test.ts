// gsap-compat (anim-runtime, wave 7): timeline maths, position parameter, eases, stagger, keyframes, callbacks and
// determinism without a browser; then CSS/transform output, the HyperFrames protocol, the offline libraries (Three.js,
// lottie-web, Anime.js) and bit-identical renders in real Chromium (skipped when none is installed).
// Expected numbers marked "GSAP 3.14.2" were observed from real GSAP as a black box (scratchpad oracle, never shipped).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, findChrome, type Page } from "../src/cdp.ts";
import { NO_NETWORK_FLAGS, openCustomPage, prepareCustom, renderCustom, validateCustom } from "../src/custom.ts";
import { libScript, libsIn, LIBS, libraryList } from "../src/libs.ts";
import { PKG_ROOT } from "../src/render.ts";

const GSAP_JS = readFileSync(join(PKG_ROOT, "src", "gsap-compat", "gsap.js"), "utf8");
// biome-ignore lint/suspicious/noExplicitAny: the page-side API is untyped JavaScript
type Any = any;
/** A fresh compat instance in a sandbox object (no DOM): what plain-object tweens need. */
function load(params?: Record<string, unknown>): Any {
  const win: Any = { __RC_CONFIG: params ? { params } : undefined };
  new Function("window", GSAP_JS)(win);
  return win.gsap;
}
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

describe("timelines (no DOM)", () => {
  test("position parameter: every form gives GSAP 3.14.2's start time", () => {
    const gsap = load();
    const tl = gsap.timeline({ paused: true });
    const at: string[] = [];
    const add = (pos?: unknown) => {
      const tw = gsap.to({ v: 0 }, { v: 1, duration: 1 });
      tl.add(tw, pos);
      at.push(`${String(pos)}=${tw.startTime()}`);
    };
    add(); add(); add("+=0.5"); add("-=0.25"); add("<"); add(">"); add("<0.2"); add(">-0.3"); add("<+=0.4");
    tl.addLabel("L", 1.5);
    add("L"); add("L+=0.5"); add("L-=0.5"); add("M"); add("-=25%"); add("<50%"); add(">25%");
    tl.to({}, { duration: 2 }, 0.1);
    at.push(`dur=${tl.duration()}`);
    add(">"); add();
    expect(at).toEqual(["undefined=0", "undefined=1", "+=0.5=2.5", "-=0.25=3.25", "<=3.25", ">=4.25", "<0.2=4.45", ">-0.3=5.15", "<+=0.4=5.55", "L=1.5", "L+=0.5=2", "L-=0.5=1", "M=6.55", "-=25%=7.3", "<50%=7.8", ">25%=9.05", "dur=10.05", ">=2.1", "undefined=10.05"]);
  });

  test("tl.to() chains (returns the timeline), defaults apply, durations add up", () => {
    const gsap = load();
    const tl = gsap.timeline({ paused: true, defaults: { duration: 2, ease: "none" } });
    const o = { v: 0 };
    expect(tl.to(o, { v: 1 })).toBe(tl);
    tl.seek(1);
    expect([tl.duration(), o.v]).toEqual([2, 0.5]);
    const tl2 = gsap.timeline({ paused: true });
    tl2.to({}, { duration: 1 }).to({}, { duration: 0.5, delay: 0.5 }).addLabel("end", 10);
    expect(tl2.duration()).toBe(2); // labels never extend a timeline
  });

  test("repeat, yoyo and repeatDelay (GSAP 3.14.2 values)", () => {
    const gsap = load();
    const o = { v: 0 };
    const tl = gsap.timeline({ paused: true });
    tl.to(o, { v: 10, duration: 1, ease: "none", repeat: 2, yoyo: true, repeatDelay: 0.5 });
    const got = [tl.duration()];
    for (const t of [0.5, 1, 1.25, 1.75, 2.5, 3, 3.5, 4, 5]) { tl.seek(t); got.push(o.v); }
    expect(got).toEqual([4, 5, 10, 10, 7.5, 0, 0, 5, 10, 10]);
    const o2 = { v: 0 };
    const tl2 = gsap.timeline({ paused: true, repeat: 1, yoyo: true });
    tl2.to(o2, { v: 10, duration: 1, ease: "none" });
    tl2.seek(1.5);
    expect([tl2.duration(), tl2.totalDuration(), o2.v, tl2.time(), tl2.progress(), tl2.totalTime()]).toEqual([1, 2, 5, 0.5, 0.5, 1.5]);
  });

  test("nested timelines, delay and timeScale", () => {
    const gsap = load();
    const o = { v: 0 };
    const root = gsap.timeline({ paused: true });
    const ch = gsap.timeline({ delay: 0.5 });
    ch.to(o, { v: 10, duration: 1, ease: "none" });
    root.add(ch, 1);
    root.seek(2);
    expect([ch.startTime(), root.duration(), o.v]).toEqual([1.5, 2.5, 5]);
    const o2 = { v: 0 };
    const tl = gsap.timeline({ paused: true });
    const tw = gsap.to(o2, { v: 10, duration: 2, ease: "none" });
    tw.timeScale(2);
    tl.add(tw, 0);
    tl.seek(0.5);
    expect([tl.duration(), o2.v]).toEqual([1, 5]);
  });

  test("relative and function-based values; later tweens start where earlier ones ended", () => {
    const gsap = load();
    const o = { v: 10 };
    const tl = gsap.timeline({ paused: true });
    tl.to(o, { v: "+=5", duration: 1, ease: "none" }).to(o, { v: "-=2", duration: 1, ease: "none" });
    tl.seek(0.5);
    const a = o.v;
    tl.seek(2);
    expect([a, o.v]).toEqual([12.5, 13]);
    const objs = [{ v: 0 }, { v: 0 }, { v: 0 }];
    const tl2 = gsap.timeline({ paused: true });
    tl2.to(objs, { v: (i: number, _t: unknown, l: unknown[]) => i * 10 + l.length, duration: 1 });
    tl2.seek(1);
    expect(objs.map((x) => x.v)).toEqual([3, 13, 23]);
    const p = { v: 0 };
    const tl3 = gsap.timeline({ paused: true });
    tl3.to(p, { v: 100, duration: 1, ease: "none" }, 0).to(p, { v: 200, duration: 1, ease: "none" }, 2);
    tl3.seek(2.5);
    const s1 = p.v;
    tl3.seek(0.5);
    const s2 = p.v;
    tl3.seek(1.5);
    expect([s1, s2, p.v]).toEqual([150, 50, 100]);
  });

  test("plain-object values: 6-decimal rounding, numeric strings become numbers, units and colours kept", () => {
    const gsap = load();
    const o = { v: 0 };
    const tl = gsap.timeline({ paused: true });
    tl.to(o, { v: 1, duration: 3, ease: "power2.out" });
    tl.seek(1);
    expect(o.v).toBe(0.703704); // GSAP 3.14.2
    const s: Record<string, unknown> = { v: "10px", w: "5", c: "#ff0000", n: "abc" };
    const tl2 = gsap.timeline({ paused: true });
    tl2.to(s, { v: "20px", w: "15", c: "#0000ff", n: "xyz", duration: 1, ease: "none" });
    tl2.seek(0.5);
    expect(s).toEqual({ v: "15px", w: 10, c: "rgba(128,0,128,1)", n: "xyz" });
  });

  test("callbacks: order, suppressEvents, call() in both directions (GSAP 3.14.2 logs)", () => {
    const gsap = load();
    const log: string[] = [];
    const tl = gsap.timeline({ paused: true, onUpdate: () => log.push("tlU"), onComplete: () => log.push("tlC") });
    tl.to({ v: 0 }, { v: 1, duration: 1, onUpdate: () => log.push("u"), onStart: () => log.push("s"), onComplete: () => log.push("c") });
    tl.call(() => log.push("call"), null, 0.5);
    for (const [label, fn] of [
      ["seek0.7", () => tl.seek(0.7)], ["seek0.8,false", () => tl.seek(0.8, false)], ["seek0.2,false", () => tl.seek(0.2, false)],
      ["seek1,false", () => tl.seek(1, false)], ["seek1.5,false", () => tl.seek(1.5, false)], ["time0.9", () => tl.time(0.9)],
      ["totalTime0.3", () => tl.totalTime(0.3)], ["progress1", () => tl.progress(1)],
    ] as const) { log.push(`|${label}`); fn(); }
    expect(log.join(" ")).toBe("|seek0.7 |seek0.8,false u tlU |seek0.2,false call u tlU |seek1,false u c call tlU tlC |seek1.5,false |time0.9 u tlU |totalTime0.3 call u tlU |progress1 u c call tlU tlC");
    const log2: string[] = [];
    const t2 = gsap.timeline({ paused: true, onStart: () => log2.push("TS"), onUpdate: () => log2.push("TU"), onComplete: () => log2.push("TC") });
    t2.to({ v: 0 }, { v: 1, duration: 1, onStart: () => log2.push("s1"), onUpdate: () => log2.push("u1"), onComplete: () => log2.push("c1") });
    t2.to({ v: 0 }, { v: 1, duration: 1, onStart: () => log2.push("s2"), onUpdate: () => log2.push("u2"), onComplete: () => log2.push("c2") });
    t2.seek(1.5, false); log2.push("|"); t2.seek(3, false);
    expect(log2.join(" ")).toBe("TS s1 u1 c1 s2 u2 TU | u2 c2 TU TC");
  });

  test("zero-duration children at their exact time (GSAP 3.14.2)", () => {
    const gsap = load();
    const log: string[] = [];
    const tl = gsap.timeline({ paused: true });
    tl.call((a: string) => log.push(`A${a}`), ["x"], 1);
    tl.to({}, { duration: 2 }, 0);
    tl.seek(1.5, false); log.push("|"); tl.seek(0.5, false); log.push("|"); tl.seek(1, false); log.push("|"); tl.seek(1, false); log.push("|"); tl.seek(0, false);
    expect(log.join(" ")).toBe("Ax | Ax | Ax | |");
    const log2: string[] = [];
    const t0 = gsap.timeline({ paused: true });
    t0.call(() => log2.push("c0"), null, 0);
    t0.to({}, { duration: 1 }, 0);
    t0.seek(0, false); log2.push("|"); t0.seek(0.5, false); log2.push("|"); t0.seek(0, false);
    expect(log2.join(" ")).toBe("| c0 | c0");
  });

  test("keyframes: arrays, percentages (easeEach power1.inOut) and value lists (GSAP 3.14.2)", () => {
    const gsap = load();
    const o = { x: 0, y: 0 };
    const tl = gsap.timeline({ paused: true });
    tl.to(o, { keyframes: [{ x: 100, duration: 1, ease: "none" }, { y: 50, duration: 0.5, ease: "none" }] });
    tl.seek(1.25);
    expect([tl.duration(), o.x, o.y]).toEqual([1.5, 100, 25]);
    const p = { x: 0 };
    const t2 = gsap.timeline({ paused: true });
    t2.to(p, { keyframes: { "0%": { x: 0 }, "100%": { x: 100 } }, duration: 1, ease: "none" });
    t2.seek(0.25);
    expect(p.x).toBe(12.5);
    const q = { x: 0 };
    const t3 = gsap.timeline({ paused: true });
    t3.to(q, { keyframes: [{ x: 100 }, { x: 0 }], duration: 2 });
    t3.seek(0.25);
    expect([t3.duration(), q.x]).toEqual([2, 25]);
    const s = { s: 1 };
    const t4 = gsap.timeline({ paused: true });
    t4.to(s, { keyframes: [{ s: 0.88, duration: 0.08, ease: "power2.in" }, { s: 1, duration: 0.14, ease: "back.out(1.7)" }] });
    t4.seek(0.15);
    expect([t4.duration(), s.s.toFixed(4)]).toEqual([0.22, "1.0105"]);
  });
});

describe("eases (GSAP 3.14.2 values at p = 0, .1, .25, .5, .75, .9, 1)", () => {
  const gsap = load();
  const P = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  const want: Record<string, number[]> = {
    none: [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1],
    "power1.in": [0, 0.01, 0.0625, 0.25, 0.5625, 0.81, 1],
    "power1.out": [0, 0.19, 0.4375, 0.75, 0.9375, 0.99, 1],
    "power1.inOut": [0, 0.02, 0.125, 0.5, 0.875, 0.98, 1],
    "power2.out": [0, 0.271, 0.578125, 0.875, 0.984375, 0.999, 1],
    "power3.out": [0, 0.3439, 0.683594, 0.9375, 0.996094, 0.9999, 1],
    "power4.inOut": [0, 0.00016, 0.015625, 0.5, 0.984375, 0.99984, 1],
    "sine.in": [0, 0.012312, 0.07612, 0.292893, 0.617317, 0.843566, 1],
    "sine.inOut": [0, 0.024472, 0.146447, 0.5, 0.853553, 0.975528, 1],
    "circ.out": [0, 0.43589, 0.661438, 0.866025, 0.968246, 0.994987, 1],
    "back.out": [0, 0.408828, 0.81741, 1.087697, 1.064137, 1.014314, 1],
    "back.inOut": [0, -0.023225, -0.043849, 0.5, 1.043849, 1.023225, 1],
    "back.out(2.4)": [0, 0.4654, 0.915625, 1.175, 1.096875, 1.0206, 1],
    "elastic.out": [0, 1.25, 0.911612, 1.015625, 1.005524, 0.998047, 1],
    "elastic.inOut": [0, 0.000339, 0.011969, 0.5, 0.988031, 0.999661, 1],
    "elastic.out(1.2, 0.4)": [0, 1.331662, 1.042084, 1.020729, 0.993503, 1.001296, 1],
    "bounce.out": [0, 0.075625, 0.472656, 0.765625, 0.972656, 0.988125, 1],
    "bounce.inOut": [0, 0.03, 0.117188, 0.5, 0.882813, 0.97, 1],
    "steps(4)": [0, 0, 0.25, 0.5, 0.75, 1, 1],
    "steps(5)": [0, 0, 0.2, 0.6, 0.8, 1, 1],
    "Power2.easeOut": [0, 0.271, 0.578125, 0.875, 0.984375, 0.999, 1],
    power2: [0, 0.271, 0.578125, 0.875, 0.984375, 0.999, 1],
    "strong.inOut": [0, 0.00016, 0.015625, 0.5, 0.984375, 0.99984, 1],
  };
  for (const [name, values] of Object.entries(want)) {
    test(name, () => {
      const f = gsap.parseEase(name);
      for (let i = 0; i < P.length; i++) expect(Math.abs(r6(f(P[i])) - values[i]!)).toBeLessThan(2e-6);
    });
  }
  test("expo (fitted to GSAP 3.14.2 samples) within 0.0003", () => {
    const want: Record<string, number[]> = {
      "expo.in": [0, 0.000196, 0.001564, 0.023438, 0.177077, 0.503144, 1],
      "expo.out": [0, 0.496856, 0.822923, 0.976563, 0.998436, 0.999804, 1],
      "expo.inOut": [0, 0.000416, 0.011719, 0.5, 0.988281, 0.999584, 1],
    };
    for (const [name, values] of Object.entries(want)) {
      const f = gsap.parseEase(name);
      for (let i = 0; i < P.length; i++) expect(Math.abs(f(P[i]) - values[i]!)).toBeLessThan(3e-4);
    }
  });
  test("CustomEase within 0.0005 of GSAP 3.14.2", () => {
    const w = new Function("window", GSAP_JS);
    const win: Any = {};
    w(win);
    const e = win.CustomEase.create("t1", "M0,0 C0.25,0 0.2,1 1,1");
    const real = [0.06646, 0.51289, 0.80605, 0.94194, 0.99433];
    [0.1, 0.3, 0.5, 0.7, 0.9].forEach((p, i) => expect(Math.abs(e(p) - real[i]!)).toBeLessThan(5e-4));
    expect(win.gsap.parseEase("t1")).toBe(e);
  });
});

describe("stagger (GSAP 3.14.2 delays)", () => {
  const run = (n: number, cfg: unknown) => {
    const gsap = load();
    const o = Array.from({ length: n }, () => ({ v: 0 }));
    const tl = gsap.timeline({ paused: true });
    tl.to(o, { v: 1, duration: 1, ease: "none", stagger: cfg });
    tl.seek(0.5);
    return `${tl.duration().toFixed(3)} ${o.map((x) => (0.5 - x.v).toFixed(3)).join(",")}`;
  };
  test("number, negative, each from center, amount from edges, ease", () => {
    expect(run(5, 0.2)).toBe("1.800 0.000,0.200,0.400,0.500,0.500");
    expect(run(5, -0.2)).toBe("1.800 0.500,0.500,0.400,0.200,0.000");
    expect(run(5, { each: 0.2, from: "center" })).toBe("1.800 0.500,0.400,0.000,0.400,0.500");
    expect(run(5, { amount: 1, from: "edges" })).toBe("2.000 0.000,0.500,0.500,0.500,0.000");
    expect(run(5, { amount: 0.8, ease: "power2.in" })).toBe("1.800 0.000,0.013,0.100,0.338,0.500");
    expect(run(5, { each: 0.1, from: 2 })).toBe("1.400 0.400,0.200,0.000,0.200,0.400");
  });
  test("grids: from start/end/center/edges/index/ratio, axis", () => {
    expect(run(6, { each: 0.1, grid: [2, 3], from: "start" })).toBe("1.300 0.000,0.119,0.250,0.119,0.192,0.300");
    expect(run(6, { each: 0.1, grid: [2, 3], from: "end" })).toBe("1.300 0.300,0.192,0.119,0.250,0.119,0.000");
    expect(run(9, { each: 0.1, grid: [3, 3], from: "center" })).toBe("1.300 0.300,0.212,0.300,0.212,0.000,0.212,0.300,0.212,0.300");
    expect(run(6, { amount: 0.5, grid: [2, 3], from: "center" })).toBe("1.500 0.500,0.000,0.500,0.500,0.000,0.500");
    expect(run(6, { each: 0.1, grid: [2, 3], from: "center", axis: "x" })).toBe("1.300 0.300,0.000,0.300,0.300,0.000,0.300");
    expect(run(6, { each: 0.1, grid: [2, 3], from: 0 })).toBe("1.300 0.000,0.134,0.268,0.134,0.190,0.300");
    expect(run(6, { each: 0.1, grid: [2, 3], from: "edges" })).toBe("1.300 0.000,0.300,0.000,0.000,0.300,0.000");
  });
  test("stagger repeat/yoyo per element", () => {
    const gsap = load();
    const o = Array.from({ length: 5 }, () => ({ v: 0 }));
    const tl = gsap.timeline({ paused: true });
    tl.to(o, { v: 1, duration: 1, ease: "none", stagger: { each: 0.2, repeat: 1, yoyo: true } });
    tl.seek(1.5);
    expect([tl.duration(), o.map((x) => x.v.toFixed(3)).join(",")]).toEqual([2.8, "0.500,0.700,0.900,0.900,0.700"]);
  });
});

describe("determinism and seeded randomness (no DOM)", () => {
  test("the same seek gives the same values whatever was seeked before", () => {
    const build = () => {
      const gsap = load();
      const objs = Array.from({ length: 8 }, () => ({ x: 0, y: 0, c: "#000000" }));
      const tl = gsap.timeline({ paused: true });
      tl.to(objs, { x: 100, duration: 1, ease: "back.out(1.7)", stagger: { each: 0.1, from: "center" } })
        .to(objs, { y: "+=50", c: "#f6ff00", duration: 0.8, ease: "elastic.out(1, 0.4)", stagger: 0.05 }, "<0.3")
        .to(objs, { keyframes: { x: [100, 40, 120] }, duration: 1 }, ">")
        .call(() => {}, null, 1.2);
      return { tl, objs };
    };
    const a = build(), b = build();
    a.tl.seek(1.7);
    for (const t of [2.9, 0.4, 3.1, 1.1, 2.2]) b.tl.seek(t);
    b.tl.seek(1.7);
    expect(JSON.stringify(b.objs)).toBe(JSON.stringify(a.objs));
  });
  test("utils.random / shuffle / stagger from:'random' repeat per seed and differ across seeds", () => {
    const seq = (seed: number) => {
      const g = load({ seed });
      return [g.utils.random(0, 100, 1), g.utils.random(0, 1), g.utils.shuffle([1, 2, 3, 4, 5]).join(""), g.utils.random(["a", "b", "c"])].join("|");
    };
    expect(seq(7)).toBe(seq(7));
    expect(seq(7)).not.toBe(seq(8));
  });
  test("utils match GSAP 3.14.2", () => {
    const u = load().utils;
    expect([u.interpolate(0, 100, 0.25), u.interpolate("#ff0000", "#0000ff", 0.5), u.interpolate({ a: 0, b: "10px" }, { a: 10, b: "20px" }, 0.5), u.interpolate([0, 10, 50], 0.75), u.clamp(0, 10, 12), u.clamp(0, 10)(-3), u.mapRange(0, 10, 100, 200, 5), u.wrap(0, 5, 7), u.wrap([1, 2, 3], 4), u.snap(5, 12), u.snap([0, 10, 25], 18), u.normalize(10, 20, 15), u.getUnit("20px"), u.unitize((v: number) => v * 2, "px")("5px"), u.wrapYoyo(0, 10, 13), u.pipe((v: number) => v + 1, (v: number) => v * 2)(3), u.distribute({ base: 0, amount: 1, from: "center" })(0, null, [1, 2, 3, 4, 5])])
      .toEqual([25, "rgba(128,0,128,1)", { a: 5, b: "15px" }, 30, 10, 0, 150, 2, 2, 10, 25, 0.5, "px", "10px", 7, 8, 1]);
  });
});

describe("libraries (libs.ts)", () => {
  test("markers name libraries; unknown names and two Three.js builds are reported", () => {
    expect(libsIn("<!-- rc-lib gsap -->\n<!--rc-lib three, lottie --><!-- rc-lib gsap -->").libs).toEqual(["gsap", "three", "lottie"]);
    expect(libsIn("<!-- rc-lib gsapp -->").unknown).toEqual(["gsapp"]);
    expect(libsIn("<!-- rc-lib three three-r147 -->").unknown.join(" ")).toMatch(/pick one/);
    expect(libsIn("<p>no markers</p>").libs).toEqual([]);
  });
  test("every library file exists, carries no network URL loads and has a licence beside it", () => {
    for (const lib of libraryList()) expect(lib.bytes).toBeGreaterThan(1000);
    for (const name of Object.keys(LIBS)) {
      const src = libScript([name]);
      expect(src).not.toMatch(/cdn\.jsdelivr|unpkg\.com|cdnjs\.cloudflare/);
    }
  });
  test("a custom composition with <!-- rc-lib gsap --> and window.__timelines validates (protocol hf)", () => {
    const v = validateCustom(`<!doctype html><html><head><!-- rc-lib gsap --></head><body><div id="a"></div><script>var tl = gsap.timeline({ paused: true }); tl.to("#a", { x: 10, duration: 1 }); window.__timelines = window.__timelines || {}; window.__timelines.demo = tl;</script></body></html>`);
    expect(v.errors).toEqual([]);
    expect(v.protocol).toBe("hf");
    expect(validateCustom(`<html><head><!-- rc-lib nope --></head><body><script>window.__timelines = {}; window.__timelines.a = 1;</script></body></html>`).errors.join(" ")).toMatch(/unknown library/);
  });
});

// ---------------------------------------------------------------- real Chromium
let chrome: string | null = null;
try { chrome = findChrome(); } catch { chrome = null; }
const tmp = mkdtempSync(join(tmpdir(), "rc-gsap-compat-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A HyperFrames-style custom page: the body + a timeline script; libraries by marker. */
function hfPage(body: string, script: string, libs = "gsap", size = "160x90"): string {
  const [w, h] = size.split("x");
  return `<!doctype html><html><head><meta charset="utf-8"><!-- rc-lib ${libs} -->
<script type="application/json" id="params">{"duration":1,"size":[${w},${h}],"params":{}}</script>
<style>html,body{margin:0}</style></head><body>${body}<script>${script}</script></body></html>`;
}
async function withPage<T>(source: string, fn: (p: Page) => Promise<T>): Promise<T> {
  const { prep } = prepareCustom({ source, duration: 1, fps: 10 });
  const browser = await Browser.launch({ extraFlags: NO_NETWORK_FLAGS });
  try {
    const page = await openCustomPage(browser, prep, []);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

describe.skipIf(!chrome)("in Chromium", () => {
  test("CSS and transform output matches GSAP 3.14.2's strings", async () => {
    const src = hfPage(
      `<div id="a" style="position:absolute;left:10px;top:10px;width:100px;height:50px;background:red"></div><div id="b" style="width:40px;height:40px"></div><div id="c" style="width:40px;height:40px"></div><div id="d" style="width:40px;height:40px"></div><div id="e" style="width:40px;height:40px"></div><div id="w" style="position:absolute;width:200px;height:100px;transform:translate(-50%,-50%)"></div>`,
      `gsap.set("#b", { x: 10, y: 20, rotation: 30, scale: 2 }); gsap.set("#w", { scale: 2 });
       var tl = gsap.timeline({ paused: true });
       tl.to("#a", { autoAlpha: 0, duration: 1, ease: "none" }, 0);
       tl.to("#c", { filter: "blur(10px)", clipPath: "inset(0% 0% 50% 0%)", backgroundColor: "#0000ff", duration: 1, ease: "none" }, 0);
       tl.to("#d", { width: "110.5px", letterSpacing: "2px", duration: 1, ease: "none" }, 0);
       tl.to("#e", { display: "none", duration: 1 }, 0);
       window.__timelines.t = tl;`,
    );
    const got = await withPage(src, async (p) => {
      await p.evaluate("window.__hf.seek(0.5)", true);
      return p.evaluate<string[]>(`["a","b","c","d","e","w"].map(function (id) { var s = document.getElementById(id).style; return [s.transform, s.opacity, s.visibility, s.filter, s.clipPath, s.backgroundColor, s.width, s.letterSpacing, s.display].join("|"); })`);
    });
    // the same page with real GSAP 3.14.2 gives exactly these strings (scratchpad oracle, 2026-10-24)
    expect(got).toEqual([
      "|0.5|inherit|||red|100px||", // autoAlpha mid-tween
      "translate(10px, 20px) rotate(30deg) scale(2, 2)||||||40px||",
      "|||blur(5px)|inset(0% 0% 25%)|rgba(0, 0, 128, 0.5)|40px||", // "none" and transparent start from zero
      "||||||75px|1px|", // autoRound: px values are whole pixels mid-tween
      "||||||40px||block", // display:"none" waits for the end
      "translate(-50%, -50%) scale(2, 2)||||||200px||", // CSS centring read back as xPercent/yPercent -50
    ]);
  }, 30000);

  test("the HyperFrames protocol: timelines offset by data-start, hf-seek waitUntil, buildReady, getVariables", async () => {
    const src = hfPage(
      `<div data-composition-id="root"><div id="a"></div><div data-composition-id="sub" data-start="0.4"><div id="b"></div></div></div><canvas id="cv" width="8" height="8"></canvas>`,
      `var t1 = gsap.timeline({ paused: true }); t1.to("#a", { x: 100, duration: 1, ease: "none" });
       var t2 = gsap.timeline({ paused: true }); t2.to("#b", { x: 100, duration: 1, ease: "none" });
       window.__timelines.root = t1; window.__timelines.sub = t2;
       window.__hf.buildReady.slow = new Promise(function (r) { Promise.resolve().then(function () { window.__built = true; r(); }); });
       window.__seen = [];
       window.addEventListener("hf-seek", function (e) { var t = e.detail.time; e.detail.waitUntil(Promise.resolve().then(function () { window.__seen.push(t); })); });
       window.__vars = window.__hyperframes.getVariables();`,
    );
    const got = await withPage(src, async (p) => {
      await p.evaluate("window.__hf.seek(0.6)", true);
      return p.evaluate<unknown[]>(`[document.getElementById("a").style.transform, document.getElementById("b").style.transform, window.__built === true, window.__seen.slice(-1)[0], typeof window.__vars]`);
    });
    expect(got).toEqual(["translate(60px, 0px)", "translate(20px, 0px)", true, 0.6, "object"]);
  }, 30000);

  test("Three.js (r184 and r147), lottie-web and Anime.js load offline and follow the seek", async () => {
    const three = hfPage(
      `<canvas id="c" width="64" height="64"></canvas>`,
      `var r = new THREE.WebGLRenderer({ canvas: document.getElementById("c"), preserveDrawingBuffer: true, alpha: true });
       var scene = new THREE.Scene(); var cam = new THREE.PerspectiveCamera(50, 1, 0.1, 10); cam.position.z = 3;
       var box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshNormalMaterial()); scene.add(box);
       var fx = typeof THREE.addons === "object" ? Object.keys(THREE.addons).length : (THREE.EffectComposer ? 1 : 0);
       window.addEventListener("hf-seek", function (e) { box.rotation.y = e.detail.time * 3; r.render(scene, cam); window.__px = (function () { var gl = r.getContext(); var b = new Uint8Array(4); gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return Array.from(b); })(); window.__fx = fx; });`,
      "three",
      "64x64",
    );
    for (const variant of [three, three.replace("rc-lib three", "rc-lib three-r147")]) {
      const got = await withPage(variant, async (p) => {
        await p.evaluate("window.__hf.seek(0.2)", true);
        const a = await p.evaluate<number[]>("window.__px");
        await p.evaluate("window.__hf.seek(0.7)", true);
        const b = await p.evaluate<number[]>("window.__px");
        return { a, b, fx: await p.evaluate<number>("window.__fx"), webgl: await p.evaluate<boolean>("!!document.createElement('canvas').getContext('webgl2')") };
      });
      expect(got.webgl).toBe(true);
      expect(got.fx).toBeGreaterThan(0);
      expect(got.a[3]).toBe(255); // the cube covers the centre
      expect(got.a.join()).not.toBe(got.b.join()); // and turns with the seek
    }
    // lottie: a 30-frame shape layer moving right; seeked through window.__hfLottie
    const anim = { v: "5.7.0", fr: 30, ip: 0, op: 30, w: 64, h: 64, layers: [{ ty: 4, ip: 0, op: 30, st: 0, ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 1, k: [{ t: 0, s: [10, 32, 0], e: [54, 32, 0], i: { x: [1], y: [1] }, o: { x: [0], y: [0] } }, { t: 30, s: [54, 32, 0] }] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } }, shapes: [{ ty: "rc", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [10, 10] }, r: { a: 0, k: 0 } }, { ty: "fl", c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 } }] }] };
    const lot = hfPage(`<div id="l" style="width:64px;height:64px"></div>`, `var a = lottie.loadAnimation({ container: document.getElementById("l"), renderer: "svg", loop: false, autoplay: false, animationData: ${JSON.stringify(anim)} }); window.__hfLottie.push(a);`, "lottie", "64x64");
    const lx = await withPage(lot, async (p) => {
      await p.evaluate("window.__hf.seek(0.1)", true);
      const a = await p.evaluate<number>("window.__hfLottie[0].currentFrame");
      await p.evaluate("window.__hf.seek(0.8)", true);
      return [a, await p.evaluate<number>("window.__hfLottie[0].currentFrame")];
    });
    expect(lx).toEqual([3, 24]);
    const ani = hfPage(`<div id="n" style="width:10px;height:10px"></div>`, `window.__hfAnime.push(anime.animate("#n", { translateX: 100, duration: 1000, ease: "linear", autoplay: false }));`, "anime", "64x64");
    const ax = await withPage(ani, async (p) => {
      await p.evaluate("window.__hf.seek(0.25)", true);
      return p.evaluate<string>(`document.getElementById("n").style.transform`);
    });
    expect(ax).toMatch(/translateX\(25px\)/);
  }, 60000);

  test("a GSAP composition renders bit-identically twice (4 tabs) and changes over time", async () => {
    const src = hfPage(
      `<div id="s" style="position:absolute;left:20px;top:20px;width:40px;height:40px;background:#F6FF00"></div><div class="d" style="position:absolute;top:70px;width:8px;height:8px;background:#C8553D"></div><div class="d" style="position:absolute;top:70px;left:20px;width:8px;height:8px;background:#C8553D"></div>`,
      `var tl = gsap.timeline({ paused: true });
       tl.fromTo("#s", { scale: 0, rotation: -40 }, { scale: 1, rotation: 0, duration: 0.6, ease: "back.out(2)" })
         .to(".d", { x: 120, stagger: 0.1, duration: 0.5, ease: "power3.inOut" }, "<0.2")
         .to("#s", { filter: "blur(2px)", opacity: 0.4, duration: 0.3 }, ">");
       window.__timelines.demo = tl;`,
    );
    const a = await renderCustom({ source: src, duration: 1, fps: 10, out: join(tmp, "a.webm") });
    const b = await renderCustom({ source: src, duration: 1, fps: 10, out: join(tmp, "b.webm") });
    expect(a.framesHash).toBe(b.framesHash);
    expect(a.blocked).toEqual([]);
    expect(a.frames).toBe(10);
    // WebGL on SwiftShader is deterministic too: a Three.js scene drawn from hf-seek, twice, 4 tabs
    const three = hfPage(
      `<canvas id="c" width="64" height="64"></canvas>`,
      `var r = new THREE.WebGLRenderer({ canvas: document.getElementById("c"), alpha: true, antialias: true });
       var scene = new THREE.Scene(); var cam = new THREE.PerspectiveCamera(50, 1, 0.1, 10); cam.position.z = 3;
       var box = new THREE.Mesh(new THREE.TorusKnotGeometry(0.6, 0.2, 64, 8), new THREE.MeshNormalMaterial()); scene.add(box);
       window.addEventListener("hf-seek", function (e) { box.rotation.set(e.detail.time * 2, e.detail.time * 3, 0); r.render(scene, cam); });`,
      "three",
      "64x64",
    );
    const c = await renderCustom({ source: three, duration: 1, fps: 10, out: join(tmp, "c.webm") });
    const d = await renderCustom({ source: three, duration: 1, fps: 10, out: join(tmp, "d.webm") });
    expect(c.framesHash).toBe(d.framesHash);
    expect(c.blocked).toEqual([]);
  }, 90000);
});
