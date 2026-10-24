// @restorffcut/compositions — the technique registry: built-ins + one sidecar per composition folder, read at run
// time (director agent, 2026-10-24). A composition fx-sync imports becomes choosable the moment
// `compositions/<name>/<name>.technique.json` exists — no code change, no restart (a 10 s cache).
// Schema + validator: ./technique.ts. Prose: ../TECHNIQUES.md.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTechnique, type TechniqueMeta, validateTechnique } from "./technique.ts";
import { BUILTIN_TECHNIQUES } from "./techniques-builtin.ts";

export * from "./technique.ts";
export { BUILTIN_TECHNIQUES } from "./techniques-builtin.ts";

/** packages/compositions/compositions (override with `dir`: the web app passes its own COMPOSITIONS_DIR). */
export function defaultLibraryDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "compositions");
}

export interface LoadedTechniques {
  techniques: TechniqueMeta[];
  /** Sidecars read (valid or not). */
  sidecars: number;
  /** One line per sidecar that failed validation (it is left out) — "<file>: <problem>". */
  errors: string[];
  /** Ids a sidecar replaced (a sidecar for an existing composition wins over the built-in record). */
  replaced: string[];
  dir: string;
}

const TTL_MS = 10_000;
const cache = new Map<string, { at: number; value: LoadedTechniques }>();

/** Every sidecar `<dir>/<name>/<name>.technique.json`, validated. */
export function readSidecars(dir: string): { records: TechniqueMeta[]; errors: string[]; count: number } {
  const records: TechniqueMeta[] = [];
  const errors: string[] = [];
  let count = 0;
  if (!existsSync(dir)) return { records, errors, count };
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, `${name}.technique.json`);
    if (!existsSync(file)) continue;
    count++;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      errors.push(`${name}/${name}.technique.json: not JSON (${(error as Error).message})`);
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${name}/${name}.technique.json: one record object expected`);
      continue;
    }
    const record = { ...normalizeTechnique(raw as Partial<TechniqueMeta> & Record<string, unknown>, name), source: "sidecar" as const };
    const problems = validateTechnique(record);
    if (problems.length) {
      errors.push(`${name}/${name}.technique.json: ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? ` (+${problems.length - 4} more)` : ""}`);
      continue;
    }
    records.push(record);
  }
  return { records, errors, count };
}

/** Built-ins + sidecars (sidecars replace a built-in with the same id). Cached 10 s per dir; `fresh` skips the cache. */
export function loadTechniques(options: { dir?: string; fresh?: boolean } = {}): LoadedTechniques {
  const dir = options.dir ?? defaultLibraryDir();
  const hit = cache.get(dir);
  if (!options.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const side = readSidecars(dir);
  const byId = new Map<string, TechniqueMeta>(BUILTIN_TECHNIQUES.map((t) => [t.id, t]));
  const replaced: string[] = [];
  for (const record of side.records) {
    if (byId.has(record.id)) replaced.push(record.id);
    byId.set(record.id, record);
  }
  const value: LoadedTechniques = { techniques: [...byId.values()], sidecars: side.count, errors: side.errors, replaced, dir };
  cache.set(dir, { at: Date.now(), value });
  return value;
}

/** Counts by kind (for answers and docs). */
export function countByKind(list: TechniqueMeta[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of list) out[t.kind] = (out[t.kind] ?? 0) + 1;
  return out;
}
