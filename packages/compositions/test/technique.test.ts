// Technique records (director agent, 2026-10-24): every built-in and every sidecar validates; the validator catches the
// mistakes an import is likely to make; sidecars load and replace built-ins. Run: bun test test/technique.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesRef, normalizeTechnique, type TechniqueMeta, validateCatalogue, validateTechnique } from "../src/technique.ts";
import { BUILTIN_TECHNIQUES, countByKind, defaultLibraryDir, loadTechniques, readSidecars } from "../src/technique-registry.ts";

describe("built-in techniques", () => {
  test("every record validates, ids are unique", () => {
    const { errors } = validateCatalogue(BUILTIN_TECHNIQUES);
    expect(errors).toEqual([]);
  });

  test("pairs / avoid point at records that exist (or selectors)", () => {
    const { warnings } = validateCatalogue(BUILTIN_TECHNIQUES);
    expect(warnings).toEqual([]);
  });

  test("all 62 FX rows are covered", () => {
    const ids = new Set(BUILTIN_TECHNIQUES.map((t) => t.id));
    for (let n = 1; n <= 62; n++) expect(ids.has(`FX-${String(n).padStart(2, "0")}`)).toBe(true);
  });

  test("every kind is present, and there is a CTA, a hook and a sound for each purpose class the director needs", () => {
    const kinds = countByKind(BUILTIN_TECHNIQUES);
    for (const kind of ["effect", "transition", "caption-style", "grade", "sound", "edit-move", "style"]) expect(kinds[kind] ?? 0).toBeGreaterThan(0);
    const has = (purpose: string) => BUILTIN_TECHNIQUES.some((t) => (t.purpose as string[]).includes(purpose) && t.apply.via !== "manual");
    for (const purpose of ["hook", "emphasis", "pattern-interrupt", "transition", "list-steps", "number-data", "proof-social", "product-showcase", "comparison", "cta", "b-roll-replace", "explain-concept", "mood"]) {
      expect(has(purpose)).toBe(true);
    }
  });

  test("the reference grammar is in the data: big-word punch exists, CTAs sit on cta beats, overlays are never full-face", () => {
    const big = BUILTIN_TECHNIQUES.find((t) => t.id === "FX-22")!;
    expect(big.purpose).toContain("emphasis");
    expect(big.withCaptions).toBe("hide");
    for (const t of BUILTIN_TECHNIQUES.filter((x) => x.purpose[0] === "cta")) expect(t.beats).toContain("cta");
    // a person effect always declares the matte it needs
    for (const t of BUILTIN_TECHNIQUES.filter((x) => x.placement === "behind-person" && x.id !== "FX-17")) expect(t.needs).toContain("person_matte");
  });
});

describe("validateTechnique", () => {
  const good = (): TechniqueMeta => structuredClone(BUILTIN_TECHNIQUES.find((t) => t.id === "FX-10")!);

  test("a good record has no errors", () => {
    expect(validateTechnique(good())).toEqual([]);
  });

  test("names the field and the allowed values", () => {
    const bad = { ...good(), purpose: ["hooky"], energy: 7, placement: "middle", duration: { min: 3, max: 1 } } as unknown;
    const errs = validateTechnique(bad).join("\n");
    expect(errs).toContain("purpose");
    expect(errs).toContain("hook,");
    expect(errs).toContain("energy");
    expect(errs).toContain("placement");
    expect(errs).toContain("duration");
  });

  test("apply needs its target field", () => {
    expect(validateTechnique({ ...good(), apply: { via: "effects" } } as unknown).join()).toContain("apply.ref");
    expect(validateTechnique({ ...good(), apply: { via: "teleport" } } as unknown).join()).toContain("apply.via");
  });

  test("fill sources are checked", () => {
    expect(validateTechnique({ ...good(), fill: { bars: "vibes" } } as unknown).join()).toContain("fill.bars");
  });

  test("selectors match kind / purpose / beat", () => {
    const t = good();
    expect(matchesRef(t, "FX-10")).toBe(true);
    expect(matchesRef(t, "kind:effect")).toBe(true);
    expect(matchesRef(t, "purpose:number-data")).toBe(true);
    expect(matchesRef(t, "beat:number")).toBe(true);
    expect(matchesRef(t, "kind:sound")).toBe(false);
  });

  test("normalizeTechnique fills a sidecar's id and apply from its folder", () => {
    const t = normalizeTechnique({ kind: "effect", name: "Stat Slam", purpose: ["number-data"], beats: ["number"], retention: "A number that moves is read.", example: "We sold 40,000 cans." }, "stat-slam");
    expect(t.id).toBe("comp:stat-slam");
    expect(t.apply).toEqual({ via: "effects", ref: "comp:stat-slam" });
    expect(validateTechnique(t)).toEqual([]);
  });
});

describe("sidecars", () => {
  test("load, validate, replace a built-in, and report broken files without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "techniques-"));
    try {
      const write = (name: string, body: string) => {
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(join(dir, name, `${name}.technique.json`), body);
      };
      write("stat-slam", JSON.stringify({ kind: "effect", name: "Stat Slam", purpose: ["number-data", "emphasis"], beats: ["number"], energy: 4, duration: { min: 1, max: 3, ideal: 2 }, aspects: ["9:16"], placement: "face-safe", needs: ["numbers"], pairsWith: ["sfx:hit"], avoidWith: [], minSpacing: 10, withCaptions: "move", cost: { renderS: 20, basis: "estimate" }, retention: "A number that moves is read.", example: "We sold 40,000 cans.", fill: { value: "number" }, credit: "Adapted from HyperFrames blocks/stat-slam (Apache-2.0) @fa5dbd1; modified" }));
      write("big-word-punch", JSON.stringify({ id: "FX-22", kind: "effect", name: "Big-word punch (sidecar)", purpose: ["emphasis"], beats: ["number"], retention: "Sidecar replaces the built-in.", example: "FREE." }));
      write("broken", "{ not json");
      write("wrong", JSON.stringify({ kind: "effect", name: "Wrong", purpose: ["vibes"], beats: ["number"], retention: "x", example: "y" }));
      mkdirSync(join(dir, "no-sidecar"));
      const side = readSidecars(dir);
      expect(side.count).toBe(4);
      expect(side.records.map((r) => r.id).sort()).toEqual(["FX-22", "comp:stat-slam"]);
      expect(side.errors.length).toBe(2);
      const loaded = loadTechniques({ dir, fresh: true });
      expect(loaded.replaced).toEqual(["FX-22"]);
      expect(loaded.techniques.find((t) => t.id === "FX-22")!.name).toBe("Big-word punch (sidecar)");
      expect(loaded.techniques.find((t) => t.id === "comp:stat-slam")!.source).toBe("sidecar");
      expect(loaded.techniques.length).toBe(BUILTIN_TECHNIQUES.length + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every knowledge path a built-in links exists (hf-skills playbooks)", () => {
    const root = join(defaultLibraryDir(), "..");
    const paths = new Set(BUILTIN_TECHNIQUES.flatMap((t) => t.knowledge ?? []));
    expect(paths.size).toBeGreaterThan(0);
    for (const p of paths) expect(existsSync(join(root, p))).toBe(true);
  });

  test("the real library's sidecars (fx-sync imports) all validate", () => {
    const side = readSidecars(defaultLibraryDir());
    expect(side.errors).toEqual([]);
  });
});
