// composition-v3 agent, 2026-10-21: library kits, cues computed from params, documented declarations, and the
// param-driven neon-grid kit (8 pieces): no story word lives in a piece's code, both products' plans resolve against
// every piece, and every piece renders both products without a page error.
// Run: cd packages/compositions && bun test test/composition-v3.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_DECLARATIONS, effectiveKit, KIT_MARKER, libraryKitOf, prepareCustom, validateCustom } from "../src/custom.ts";
import { findChrome } from "../src/cdp.ts";
import { listLibraryKits, readLibraryKit } from "../src/kits.ts";
import { LIBRARY_DIR, listLibrary } from "../src/library.ts";
import { extractParamsBlock, lintComposition, parseManifest, resolveApplied, resolveParams, validateManifest } from "../src/params.ts";
import { cleanCues, initScript, PKG_ROOT, prepare, render } from "../src/render.ts";
import { handle } from "../src/service.ts";
import type { ParamValues } from "../src/types.ts";

const PIECES = ["neon-hook", "neon-grid-ruler", "neon-flow", "neon-curve", "neon-beats", "neon-code", "neon-form", "neon-outro"];
const PLANS = ["halcyon-cold-brew-18h", "halcyon-nitro-12s"];
const EXAMPLES = join(PKG_ROOT, "examples", "neon-grid");
const OUT = join(PKG_ROOT, "out", "test-composition-v3");
interface Plan { product: string; words: Array<{ w: string; s: number; e: number }>; scenes: Array<{ piece: string; t: number; duration: number; props: ParamValues }> }
const plans: Plan[] = PLANS.map((p) => JSON.parse(readFileSync(join(EXAMPLES, `${p}.json`), "utf8")) as Plan);
const htmlOf = (name: string) => join(LIBRARY_DIR, name, `${name}.html`);
const sourceOf = (name: string) => readFileSync(htmlOf(name), "utf8");
/** The page's code: everything but the params block (whose defaults are example copy, CONTRACT §2c). */
const codeOf = (html: string) => html.replace(/<script\b[^>]*\bid\s*=\s*["']params["'][^>]*>[\s\S]*?<\/script\s*>/i, "");
const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
};
const hasChrome = (() => {
  try {
    return !!findChrome();
  } catch {
    return false;
  }
})();

describe("library kits", () => {
  test("neon-grid is a library kit; it only defines (no RC.composition), and the eight pieces name it", () => {
    const kit = readLibraryKit("neon-grid");
    expect(kit).not.toBeNull();
    expect(kit?.js).toContain("var KIT =");
    expect(/\bRC\.composition\s*\(/.test(kit?.js ?? "")).toBe(false);
    expect(listLibraryKits().map((k) => k.name)).toContain("neon-grid");
    expect(readLibraryKit("../neon-grid")).toBeNull();
    const users = listLibrary().filter((e) => parseManifest(readFileSync(e.html, "utf8")).kit === "neon-grid").map((e) => e.name).sort();
    expect(users).toEqual([...PIECES].sort());
    for (const name of PIECES) expect(sourceOf(name)).toContain(KIT_MARKER);
  });

  test("a library kit joins the render (after the runtime) and the hash only of the pieces that name it", () => {
    const neon = prepare({ composition: htmlOf("neon-hook"), out: join(OUT, "x.webm"), props: plans[0]?.scenes[0]?.props });
    const other = prepare({ composition: htmlOf("big-word-punch"), out: join(OUT, "y.webm") });
    expect(neon.kit?.sha).toBe(readLibraryKit("neon-grid")?.sha);
    expect(other.kit).toBeUndefined();
    const script = initScript(neon);
    expect(script.indexOf("var KIT =")).toBeGreaterThan(script.indexOf("RestorffCut composition runtime"));
    expect(initScript(other)).not.toContain("var KIT =");
    expect(validateManifest({ ...parseManifest(sourceOf("neon-hook")), kit: "../x" }).join()).toMatch(/kit: a library kit name/);
  });

  test("a library piece forked as custom code renders with its library kit when no kit is sent; a sent kit wins", () => {
    const src = sourceOf("neon-beats");
    expect(libraryKitOf(src)?.name).toBe("neon-grid");
    expect(effectiveKit(src, undefined).from).toBe("library:neon-grid");
    expect(effectiveKit(src, { js: "var KIT = {};" }).from).toBe("request");
    const v = validateCustom(src, { beats: [{ text: "SO" }] });
    expect(v.errors).toEqual([]);
    const { prep } = prepareCustom({ source: src, props: { beats: [{ text: "SO" }] }, width: 216, height: 384 });
    expect(prep.html).toContain("<script data-rc-kit>");
    expect(prep.html).not.toContain(KIT_MARKER);
    // without a params-block kit, the marker still needs one
    const bare = src.replace('"kit": "neon-grid",', "");
    expect(validateCustom(bare, {}).errors.join()).toMatch(/no kit was sent/);
  });
});

describe("cues and declarations", () => {
  test("cleanCues keeps valid cues (t or from_end), drops the rest, sorts, caps at 64", () => {
    const got = cleanCues([{ t: 1.23456, kind: "Stamp", label: "x" }, { from_end: 0.3, kind: "paper" }, { t: -1, kind: "pop" }, { t: 0.5 }, "no", { t: 0.2, kind: "type", sound: "typing-burst" }], 3);
    expect(got).toEqual([{ t: 0.2, kind: "type", sound: "typing-burst" }, { t: 1.235, kind: "stamp", label: "x" }, { from_end: 0.3, kind: "paper" }]);
    expect(cleanCues(Array.from({ length: 80 }, (_, i) => ({ t: i / 100, kind: "tick" })), 1)?.length).toBe(64);
    expect(cleanCues(null, 1)).toBeNull();
  });

  test("the contract documents cues, scenes, text, opaque and kits, and lists the library kits with their pieces", async () => {
    expect(Object.keys(CONTRACT_DECLARATIONS)).toEqual(["cues", "scenes", "text", "opaque", "kit"]);
    const c = (await handle("custom-contract", {})) as { declarations: unknown; library_kits: Array<{ name: string; used_by: string[] }>; contract: string };
    expect(c.declarations).toBe(CONTRACT_DECLARATIONS);
    expect(c.library_kits.find((k) => k.name === "neon-grid")?.used_by.sort()).toEqual([...PIECES].sort());
    expect(c.contract).toMatch(/window\.__rcCues/);
    expect(((await handle("library-kit", { name: "neon-grid" })) as { sha: string }).sha).toBe(readLibraryKit("neon-grid")?.sha as string);
    await expect(handle("library-kit", { name: "nope" })).rejects.toThrow(/no library kit/);
  });
});

describe("the neon-grid kit: every word and time is a param", () => {
  // every ON-SCREEN word of BOTH products (3+ letters): HALCYON, EIGHTEEN, CASCADE, SHORTCUTS, EXTRACTION, steep.js…
  // Skipped: the voice's word list and the `word` anchors (said, not drawn by code), caption `keys`, enum values.
  const NOT_SHOWN = new Set(["words", "word", "keys", "kind", "verdict", "tone", "shape", "pulseWord", "stampWord"]);
  const shown = (v: unknown, out: string[] = []): string[] => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => shown(x, out));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!NOT_SHOWN.has(k)) shown(x, out);
    return out;
  };
  const storyWords = [
    ...new Set(
      plans
        .flatMap((p) => [...p.scenes.flatMap((s) => shown(s.props)), p.product])
        .flatMap((s) => s.match(/[A-Za-z]{3,}/g) ?? [])
        .map((w) => w.toLowerCase()),
    ),
  ];
  // words that are also code vocabulary (allowed in code, listed so the exception is explicit): JS keywords and Math
  // in the code lines, render(time), the param names form / preview, "the" in cue labels, the easing names "smooth" /
  // "ease-in", Math.min, an `out` variable ("EASE · OUT", "4 MIN", "SMOOTH" are on screen in the plans)
  const CODE_WORDS = new Set(["const", "function", "return", "math", "exp", "tau", "time", "preview", "form", "the", "ease", "out", "min", "smooth"]);
  test("the on-screen word list is real (both products' words are in it)", () => {
    for (const w of ["halcyon", "eighteen", "hours", "twelve", "seconds", "extraction", "foam", "shortcuts", "cream", "steeped", "creamy", "strength", "creaminess"]) expect(storyWords).toContain(w);
  });

  for (const name of PIECES) {
    test(`${name}: no story word or display literal in its code`, () => {
      const code = codeOf(sourceOf(name)).replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const found = storyWords.filter((w) => !CODE_WORDS.has(w) && new RegExp(`\\b${w}\\b`, "i").test(code));
      expect(found).toEqual([]);
      // and no display text written as a literal: textContent / text: / big / mono / pill / fillText with letters
      const literal = /(?:textContent\s*=\s*|text:\s*|KIT\.(?:big|mono|pill)\([^,()]+,\s*|fillText\(\s*)["'][A-Za-z]/;
      expect(literal.exec(code)?.[0] ?? null).toBeNull();
    });
  }

  test("the kit itself carries no story word", () => {
    const js = (readLibraryKit("neon-grid")?.js ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const found = storyWords.filter((w) => !CODE_WORDS.has(w) && new RegExp(`\\b${w}\\b`, "i").test(js));
    // number words are the voice's ("eighteen" matches "18" in a cue): the kit's number table is allowed
    expect(found.filter((w) => !/^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|zero)$/.test(w))).toEqual([]);
  });

  for (const name of PIECES) {
    test(`${name}: manifest valid, speed declared, lint clean, both products' params resolve as an applied render`, () => {
      const html = sourceOf(name);
      const m = parseManifest(html);
      expect(validateManifest(m)).toEqual([]);
      expect(m.params.speed?.type).toBe("number");
      expect(m.params.t0?.type).toBe("number");
      expect(m.fit).toBe(false);
      expect(lintComposition(html)).toEqual([]);
      expect(extractParamsBlock(html)).not.toBeNull();
      for (const plan of plans) {
        const scene = plan.scenes.find((s) => s.piece === name);
        expect(scene).toBeDefined();
        const props = { ...scene?.props, t0: scene?.t, words: plan.words };
        expect(resolveParams(m, props).errors).toEqual([]);
        expect(resolveApplied(m, props).needs).toEqual([]);
      }
    });
  }

  test.skipIf(!hasChrome)("every piece renders both products (tiny, 10 fps) with no page error, and computes its cues from the params", async () => {
    mkdirSync(OUT, { recursive: true });
    for (const name of PIECES) {
      const hashes: string[] = [];
      for (const [i, plan] of plans.entries()) {
        const scene = plan.scenes.find((s) => s.piece === name) as Plan["scenes"][number];
        const out = join(OUT, `${name}-${i}.webm`);
        const r = await render({ composition: htmlOf(name), props: { ...scene.props, t0: scene.t, words: plan.words }, out, duration: scene.duration, width: 108, height: 192, fps: 10, workers: 2 });
        expect(r.frames).toBe(Math.round(scene.duration * 10));
        const side = JSON.parse(readFileSync(`${out}.json`, "utf8")) as { cues?: Array<{ t: number; kind: string }>; kit?: string };
        expect(side.kit).toBe("neon-grid");
        expect((side.cues ?? []).length).toBeGreaterThan(0);
        expect((side.cues ?? []).every((c) => c.t >= 0 && c.t <= scene.duration)).toBe(true);
        hashes.push(r.framesHash);
      }
      // same piece, two products: different pictures
      expect(hashes[0]).not.toBe(hashes[1]);
    }
  }, 240_000);

  test("the plans are the same eight pieces in the same order, only params and words differ", () => {
    expect(plans.map((p) => p.scenes.map((s) => s.piece))).toEqual([PIECES, PIECES]);
    expect(existsSync(join(EXAMPLES, "place.ts"))).toBe(true);
    expect(existsSync(join(EXAMPLES, "render.ts"))).toBe(true);
  });
});
