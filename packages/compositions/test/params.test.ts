// Unit tests: manifest parsing/validation, param merging, --set coercion, sentence nudges, determinism lint.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { nudge } from "../src/edits.ts";
import { listLibrary } from "../src/library.ts";
import {
  coerceSet,
  extractParamsBlock,
  lintComposition,
  parseManifest,
  resolveParams,
  validateManifest,
} from "../src/params.ts";
import type { CompositionManifest } from "../src/types.ts";

const LIB = listLibrary();
const manifestOf = (name: string): CompositionManifest => {
  const e = LIB.find((x) => x.name === name);
  if (!e) throw new Error(`no ${name} in library`);
  return parseManifest(readFileSync(e.html, "utf8"));
};

describe("starter library", () => {
  test("has the eight starter compositions (new ones are checked by the loop below)", () => {
    const names = LIB.map((e) => e.name);
    for (const n of ["badge-pills", "big-word-punch", "chart-grow", "checklist", "cover-story", "headline-wall", "ui-card-pop", "word-pop"]) {
      expect(names).toContain(n);
    }
  });

  for (const e of LIB) {
    test(`${e.name}: manifest valid, example props resolve, no determinism warnings`, () => {
      const html = readFileSync(e.html, "utf8");
      const m = parseManifest(html);
      expect(validateManifest(m)).toEqual([]);
      expect(m.name).toBe(e.name);
      const props = e.props ? JSON.parse(readFileSync(e.props, "utf8")) : {};
      expect(resolveParams(m, props).errors).toEqual([]);
      expect(lintComposition(html)).toEqual([]);
    });
  }
});

describe("params block", () => {
  test("found whatever the attribute order", () => {
    const html = `<script id='params' type="application/json">{"a":1}</script><script>x()</script>`;
    expect(extractParamsBlock(html)).toBe(`{"a":1}`);
  });
  test("missing block is a clear error", () => {
    expect(() => parseManifest("<html></html>")).toThrow(/id="params"/);
  });
  test("invalid JSON is a clear error", () => {
    expect(() => parseManifest(`<script type="application/json" id="params">{nope}</script>`)).toThrow(/not valid JSON/);
  });
});

describe("validateManifest", () => {
  const good = manifestOf("big-word-punch");
  test("rejects odd sizes (yuva420p needs even)", () => {
    expect(validateManifest({ ...good, size: [1081, 1920] }).join()).toMatch(/even/);
  });
  test("rejects a default outside its range", () => {
    const m = { ...good, params: { ...good.params, scale: { type: "number" as const, default: 5, min: 0.5, max: 2 } } };
    expect(validateManifest(m).join()).toMatch(/above the maximum/);
  });
  test("rejects an enum default that is not an option", () => {
    const m = { ...good, params: { ...good.params, anchor: { type: "enum" as const, options: ["top"], default: "middle" } } };
    expect(validateManifest(m).join()).toMatch(/expected one of top/);
  });
  test("top-level params need a default", () => {
    const m = { ...good, params: { x: { type: "string" as const } } };
    expect(validateManifest(m).join()).toMatch(/need a "default"/);
  });
});

describe("resolveParams", () => {
  const m = manifestOf("big-word-punch");
  test("defaults when no overrides", () => {
    const r = resolveParams(m, {});
    expect(r.errors).toEqual([]);
    expect(r.values.word).toBe("FREE");
    expect(r.values.speed).toBe(1);
  });
  test("overrides replace defaults; $comment ignored", () => {
    const r = resolveParams(m, { $comment: "x", word: "ZERO", scale: 1.2 });
    expect(r.errors).toEqual([]);
    expect(r.values.word).toBe("ZERO");
    expect(r.values.scale).toBe(1.2);
  });
  test("unknown keys are errors (typos never silently do nothing)", () => {
    expect(resolveParams(m, { accnet: "#FF0000" }).errors.join()).toMatch(/accnet: not a param/);
  });
  test("type, range, colour and easing errors", () => {
    const errs = resolveParams(m, { scale: "big", speed: 9, accent: "red", ease: "wobbly" }).errors.join("\n");
    expect(errs).toMatch(/scale: expected a number/);
    expect(errs).toMatch(/speed: 9 is above the maximum 4/);
    expect(errs).toMatch(/accent: expected a hex colour/);
    expect(errs).toMatch(/ease: expected an easing/);
  });
  test("list of objects: missing required field, unknown field, optional default filled", () => {
    const wp = manifestOf("word-pop");
    expect(resolveParams(wp, { words: [{ text: "Hi", start: 0 }] }).errors.join()).toMatch(/missing field "end"/);
    expect(resolveParams(wp, { words: [{ text: "Hi", start: 0, end: 1, x: 1 }] }).errors.join()).toMatch(/unknown field "x"/);
    const hw = manifestOf("headline-wall");
    const r = resolveParams(hw, { headlines: [{ source: "A", headline: "B" }] });
    expect(r.errors).toEqual([]);
    expect((r.values.headlines as { date: string }[])[0]?.date).toBe("");
  });
  test("list length limits", () => {
    const bp = manifestOf("badge-pills");
    expect(resolveParams(bp, { pills: [] }).errors.join()).toMatch(/at least 1/);
    expect(resolveParams(bp, { pills: ["a", "b", "c", "d", "e", "f", "g"] }).errors.join()).toMatch(/at most 6/);
  });
});

describe("coerceSet (--set key=value)", () => {
  const m = manifestOf("chart-grow");
  test("number, boolean, string, enum", () => {
    expect(coerceSet(m, "decimals=2")).toEqual(["decimals", 2]);
    expect(coerceSet(m, "card=false")).toEqual(["card", false]);
    expect(coerceSet(m, "title=SALES")).toEqual(["title", "SALES"]);
    expect(coerceSet(m, "style=line")).toEqual(["style", "line"]);
  });
  test("JSON lists of objects", () => {
    expect(coerceSet(m, 'bars=[{"label":"A","value":1}]')).toEqual(["bars", [{ label: "A", value: 1 }]]);
  });
  test("a|b|c shorthand for simple lists", () => {
    expect(coerceSet(manifestOf("badge-pills"), "pills=ONE|TWO")).toEqual(["pills", ["ONE", "TWO"]]);
  });
  test("errors name the problem", () => {
    expect(() => coerceSet(m, "decimals=two")).toThrow(/not a number/);
    expect(() => coerceSet(m, "nope=1")).toThrow(/not a param/);
    expect(() => coerceSet(m, "decimals")).toThrow(/key=value/);
  });
});

describe("nudge (sentence → params)", () => {
  const m = manifestOf("big-word-punch");
  const base = resolveParams(m, {}).values;
  test("slower and bigger", () => {
    const r = nudge(m, base, "Make it slower and bigger");
    expect(r.values.speed).toBe(0.8);
    expect(r.values.scale).toBe(1.15);
    expect(r.changes.map((c) => c.key).sort()).toEqual(["scale", "speed"]);
  });
  test("much faster clamps to the declared max", () => {
    const r = nudge(m, { ...base, speed: 3.5 }, "much faster");
    expect(r.values.speed).toBe(4);
  });
  test("bouncier climbs the easing ladder; calmer goes back to smooth", () => {
    expect(nudge(m, base, "bouncier").values.ease).toBe("bouncy");
    expect(nudge(m, { ...base, ease: "bouncy" }, "bouncier").values.ease).toBe("springy");
    expect(nudge(m, { ...base, ease: "elastic" }, "calmer please").values.ease).toBe("smooth");
  });
  test("colour by name or hex", () => {
    expect(nudge(m, base, "change the colour to red").values.accent).toBe("#E5484D");
    expect(nudge(m, base, "accent #00ff88").values.accent).toBe("#00FF88");
  });
  test("move up uses offsetY when declared", () => {
    expect(nudge(m, base, "move it up").values.offsetY).toBe(-80);
  });
  test("move up falls back to anchor when there is no offsetY", () => {
    const cs = manifestOf("cover-story");
    const r = nudge(cs, resolveParams(cs, {}).values, "move it up");
    expect(r.skipped.join()).toMatch(/no offsetY or anchor/);
  });
  test("a rule for a param the composition lacks is reported, not silently dropped", () => {
    // every library composition has `speed` since library-v2, so take one away to keep testing the rule
    const full = manifestOf("word-pop");
    const { speed: _speed, ...rest } = full.params;
    const wp: CompositionManifest = { ...full, params: rest };
    const r = nudge(wp, resolveParams(wp, {}).values, "slower");
    expect(r.skipped.join()).toMatch(/no "speed" param/);
  });
  test("an unknown sentence throws", () => {
    expect(() => nudge(m, base, "make it pop more emotionally")).toThrow(/no nudge rule matched/);
  });
});

describe("lintComposition", () => {
  test("flags clocks, unseeded random, timers, transitions, fetch", () => {
    const html = `<script>RC.composition({render(){ Date.now(); Math.random(); setTimeout(f, 1); fetch("x"); }})</script><style>.a{transition: opacity 1s}</style>`;
    const w = lintComposition(html).join("\n");
    expect(w).toMatch(/wall clock/);
    expect(w).toMatch(/Math.random/);
    expect(w).toMatch(/timers/);
    expect(w).toMatch(/network/);
    expect(w).toMatch(/CSS transitions/);
  });
  test("flags a composition that never registers", () => {
    expect(lintComposition("<div></div>").join()).toMatch(/never calls RC.composition/);
  });
});
