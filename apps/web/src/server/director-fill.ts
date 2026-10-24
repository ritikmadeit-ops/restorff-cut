/**
 * The director's param filler (director agent, 2026-10-24): a technique's `fill` map (param → source) + the beat's
 * words → param values shaped to the composition's manifest (string · number · list of strings · list of objects ·
 * word timings in timeline or local seconds). Pure. Nothing is invented: a source with nothing behind it (no number in
 * the line, no product image) gives no value, and a required param left empty excludes the technique.
 */
import type { FillSource, TechniqueMeta } from "@restorffcut/compositions/technique";
import { type BeatFacts, cleanToken, isContent } from "./director-rules";

export interface FillWord {
  text: string;
  start: number;
  end: number;
}

/** The slice of a manifest param spec the filler reads (PackageEntry.params values). */
export interface ParamSpecLite {
  type?: unknown;
  required?: unknown;
  maxItems?: unknown;
  maxLength?: unknown;
  of?: { type?: unknown; fields?: Record<string, { type?: unknown; maxLength?: unknown }>; maxLength?: unknown };
}

export interface FillContext {
  beat: { t: number; end: number; words: FillWord[]; facts: BeatFacts };
  /** The event's start (timeline seconds): local times are measured from it. */
  at: number;
  product?: { name?: string; image?: string; brand?: string };
  cta?: { text?: string; keyword?: string };
  images: string[];
  places?: string[];
  /** The manifest's params (null for shaders / transitions / ops). */
  specs: Record<string, ParamSpecLite> | null;
}

export interface FillResult {
  params: Record<string, unknown>;
  /** Required params nothing could fill. */
  missing: string[];
  /** Param → source actually used (for the explanation). */
  from: Record<string, FillSource>;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const cut = (s: string, max: unknown) => {
  if (typeof max !== "number" || s.length <= max) return s;
  const words = s.split(/\s+/);
  let out = "";
  for (const w of words) {
    if ((out ? `${out} ${w}` : w).length > max) break;
    out = out ? `${out} ${w}` : w;
  }
  return out; // a single word longer than the slot is left out, never sliced ("nothing" must not become "not")
};
const capItems = <T>(list: T[], max: unknown) => (typeof max === "number" && max > 0 ? list.slice(0, max) : list);

/** The raw value of a source (before shaping), or undefined. */
function sourceValue(source: FillSource, c: FillContext): unknown {
  const f = c.beat.facts;
  const line = c.beat.words.map((w) => w.text).join(" ").trim();
  switch (source) {
    case "keyword":
      return f.keyword?.text;
    case "line":
      return line || undefined;
    case "headline":
      return f.headline || undefined;
    case "number":
      return f.numbers[0]?.value;
    case "number-text":
      return f.numbers[0]?.text;
    case "number-label": {
      const n = f.numbers[0];
      if (!n) return undefined;
      const after = c.beat.words.slice(n.index + 1, n.index + 4).map((w) => cleanToken(w.text)).filter(Boolean);
      const label = after.filter((w, i) => i === 0 || isContent(w)).slice(0, 3).join(" ");
      return label || undefined;
    }
    case "numbers":
      return f.numbers.length ? f.numbers : undefined;
    case "list-items":
      return f.items.length >= 2 ? f.items : undefined;
    case "product-name":
      return c.product?.name;
    case "product-image":
      return c.product?.image ?? c.images[0];
    case "brand":
      return c.product?.brand ?? c.product?.name;
    case "cta-text":
      return c.cta?.text ?? (line || undefined);
    case "cta-keyword":
      return c.cta?.keyword ?? (c.product?.brand ?? c.product?.name)?.split(/\s+/)[0]?.toUpperCase() ?? f.keyword?.text?.toUpperCase();
    case "places":
      return c.places && c.places.length >= 2 ? c.places : undefined;
    case "images":
      return c.images.length ? c.images : c.product?.image ? [c.product.image] : undefined;
    case "quote":
      return f.quote;
    case "before":
      return f.before;
    case "after":
      return f.after;
    case "words":
      return c.beat.words.length ? c.beat.words : undefined;
    case "beat-start":
      return r3(c.at);
  }
}

/** Shape a raw value to the param's spec. */
function shape(value: unknown, source: FillSource, spec: ParamSpecLite | undefined, c: FillContext, timelineSeconds: boolean): unknown {
  const type = spec?.type;
  if (value === undefined || value === null) return undefined;
  if (type === "number") {
    if (typeof value === "number") return value;
    const n = Number(String(value).replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && String(value).match(/\d/) ? n : undefined;
  }
  if (type === "string" || type === "text" || type === "image" || type === "enum") {
    if (Array.isArray(value)) {
      if (type === "image") return typeof value[0] === "string" ? value[0] : undefined;
      return cut(value.map((v) => (typeof v === "object" && v ? ((v as { text?: string }).text ?? "") : String(v))).join(", "), spec?.maxLength);
    }
    return cut(String(value), spec?.maxLength);
  }
  if (type === "list") {
    const of = spec?.of;
    const fields = of?.fields ?? null;
    const list = Array.isArray(value) ? value : [value];
    if (!fields) {
      // a list of strings (or images)
      const strings = list.map((v) => (typeof v === "object" && v ? ((v as { text?: string }).text ?? "") : String(v))).filter(Boolean);
      return capItems(strings.map((s) => cut(s, of?.maxLength)), spec?.maxItems);
    }
    const keys = Object.keys(fields);
    // word timings: {w,s,e} · {text,start,end} · {text,at,word?}
    if (source === "words") {
      const words = list as FillWord[];
      const t = (s: number) => r3(timelineSeconds ? s : Math.max(0, s - c.at));
      if (keys.includes("w") && keys.includes("s")) return words.map((w) => ({ w: w.text, s: t(w.start), e: t(w.end) }));
      if (keys.includes("start") && keys.includes("text")) return words.map((w) => ({ text: w.text, start: t(w.start), end: t(w.end) }));
      if (keys.includes("text")) {
        // one item per content word (emphasis lines, caption stacks, one-word beats), capped
        const maxLen = typeof fields.text?.maxLength === "number" ? (fields.text.maxLength as number) : 28;
        const picked = words.filter((w) => isContent(w.text) || words.length <= 6).slice(0, typeof spec?.maxItems === "number" ? (spec.maxItems as number) : 6);
        return picked.map((w) => ({
          text: cut(cleanToken(w.text) || w.text, maxLen),
          ...(keys.includes("at") ? { at: t(w.start) } : {}),
          ...(keys.includes("key") ? { key: isContent(w.text) } : {}),
        }));
      }
      return undefined;
    }
    // numbers → {label, value} bars; one bar is not a chart (a single number is a counter's job)
    if (source === "numbers" && keys.includes("value")) {
      const nums = list as Array<{ value: number; text: string }>;
      if (nums.length < 2) return undefined;
      return capItems(nums.map((n, i) => ({ ...(keys.includes("label") ? { label: cut(n.text || `#${i + 1}`, fields.label?.maxLength) } : {}), value: n.value })), spec?.maxItems);
    }
    // images → [{image}]
    if (source === "images" && keys.includes("image")) return capItems(list.map((image) => ({ image })), spec?.maxItems);
    // places → [{name}]
    if (source === "places" && keys.includes("name")) return capItems(list.map((name) => ({ name: String(name) })), spec?.maxItems);
    // strings → objects with the first text-like field; other fields with no default get the item's number
    // (thread-timeline's {date, text} refused items without a date: live run 2026-10-24 13:57)
    const textKey = ["text", "label", "title", "headline", "name", "date"].find((k) => keys.includes(k)) ?? keys.find((k) => fields[k]?.type === "string");
    if (!textKey) return undefined;
    const others = keys.filter((k) => k !== textKey && (fields[k] as { default?: unknown } | undefined)?.default === undefined);
    return capItems(
      list.map((v, i) => {
        const item: Record<string, unknown> = { [textKey]: cut(typeof v === "object" && v ? ((v as { text?: string }).text ?? "") : String(v), fields[textKey]?.maxLength) };
        for (const k of others) {
          const type = fields[k]?.type;
          if (type === "string" || type === "text") item[k] = String(i + 1).padStart(2, "0");
          else if (type === "number") item[k] = i + 1;
        }
        return item;
      }),
      spec?.maxItems,
    );
  }
  if (type === "object") return typeof value === "object" ? value : undefined;
  // no spec (shader / ops): pass through
  return value;
}

/** Fill a technique's params for one beat. */
export function fillParams(technique: TechniqueMeta, c: FillContext): FillResult {
  const params: Record<string, unknown> = { ...(technique.params ?? {}) };
  const from: Record<string, FillSource> = {};
  const specs = c.specs;
  const timelineSeconds = !!specs && "t0" in specs;
  for (const [key, source] of Object.entries(technique.fill ?? {})) {
    if (specs && !(key in specs)) continue; // the manifest dropped this param: never send an unknown key
    const raw = sourceValue(source, c);
    const value = shape(raw, source, specs?.[key], c, timelineSeconds);
    if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) continue;
    params[key] = value;
    from[key] = source;
  }
  const empty = (key: string) => params[key] === undefined || params[key] === "" || (Array.isArray(params[key]) && !(params[key] as unknown[]).length);
  const optional = new Set(technique.fillOptional ?? []);
  const missing = new Set<string>();
  // every fill key is the technique's content unless the record says it may stay empty
  for (const key of Object.keys(technique.fill ?? {})) if (!optional.has(key) && (!specs || key in specs) && empty(key)) missing.add(key);
  if (specs) for (const [key, spec] of Object.entries(specs)) if (spec?.required === true && empty(key)) missing.add(key);
  return { params, missing: [...missing], from };
}
