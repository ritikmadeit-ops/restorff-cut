// @restorffcut/compositions — technique metadata: WHEN to use an effect, style or editing move, for retention.
//
// One record per thing the director (apps/web/src/server/director*.ts) can choose: a library effect, a transition,
// a caption style, a grade, a sound move or an edit move. The planner reads these at run time (built-ins in
// ./techniques-*.ts + one `<name>.technique.json` sidecar per composition folder), so a composition imported by
// fx-sync becomes choosable the moment its sidecar exists. Prose: ../TECHNIQUES.md. Schema version below; changes are
// ADDITIVE (new optional fields, new enum values) — fx-sync writes this shape on every import.
//
// Field casing: camelCase keys (like the composition manifest); enum values kebab-case except `needs`, which reuses
// the effects library's snake_case EffectNeed names (apps/web/src/server/effects-catalogue.ts) plus a few more.

export const TECHNIQUE_SCHEMA_VERSION = 1;

/** What sort of thing it is. */
export const TECHNIQUE_KINDS = ["effect", "transition", "caption-style", "grade", "sound", "edit-move", "style"] as const;
export type TechniqueKind = (typeof TECHNIQUE_KINDS)[number];

/** The job it does for the viewer. A technique may do several. */
export const PURPOSES = [
  "hook", // the first 1 s: something moves, a question opens
  "emphasis", // one word / claim lands harder
  "pattern-interrupt", // a visual change that resets attention (the 1.5–3 s rhythm)
  "transition", // carries the eye across a cut
  "list-steps", // shows items / steps as they are said
  "number-data", // makes a number or chart readable
  "proof-social", // reviews, counts, press, before/after: why believe it
  "product-showcase", // the product on screen, held long enough to recognise
  "comparison", // A vs B, before vs after, old vs new
  "cta", // the ask at the end
  "b-roll-replace", // cuts away from the talking head to a picture of the idea
  "explain-concept", // a diagram / mechanism the words alone would not carry
  "mood", // tone, warmth, energy of the whole piece
] as const;
export type Purpose = (typeof PURPOSES)[number];

/** Beat types the director classifies each line into (one per beat). */
export const BEAT_TYPES = [
  "hook", // opening line: a question, a bold claim, a "stop scrolling"
  "problem", // the pain / the before
  "claim", // a statement of value or fact without a number
  "number", // a line built on a number (price, %, count, time)
  "list", // "three things", "first … second …"
  "steps", // how-to sequence ("then", "next", "step 2")
  "proof", // testimonial, reviews, results, "people say"
  "product", // the product named / shown
  "comparison", // vs, instead of, before/after, unlike
  "explain", // how it works, why
  "story", // narrative / personal moment
  "reveal", // the payoff / twist / answer
  "quote", // someone else's words
  "cta", // follow, comment, buy, link, try
  "bridge", // filler / connective line
] as const;
export type BeatType = (typeof BEAT_TYPES)[number];

export const ASPECTS = ["9:16", "4:5", "1:1", "16:9"] as const;
export type Aspect = (typeof ASPECTS)[number];

/** Where it sits in the frame. */
export const PLACEMENTS = [
  "full-frame", // replaces the picture (a cutaway): the face leaves the screen for its duration
  "overlay", // over the picture, must keep to the face-safe zone
  "lower-third", // a band in the lower third (captions' neighbourhood)
  "behind-person", // under the person cutout: the face stays in front
  "face-safe", // placed by the face box: anywhere the face is not
  "clip", // acts on the clip itself (zoom, grade, speed): no new layer
  "cut", // lives at a cut between two clips (transitions)
  "audio", // sound only
  "caption-zone", // IS the captions (caption styles)
] as const;
export type Placement = (typeof PLACEMENTS)[number];

/** What it needs to be the real thing. snake_case = the effects library's EffectNeed + a few more. */
export const TECHNIQUE_NEEDS = [
  "person_matte",
  "face_box",
  "words",
  "images",
  "product_image",
  "numbers",
  "list_items",
  "places",
  "two_clips",
  "clip",
  "clean_plate",
  "cut_list",
  "self_check",
  "two_renders",
  "quote",
  "logo",
  "music",
] as const;
export type TechniqueNeed = (typeof TECHNIQUE_NEEDS)[number];

/** Where a param's value comes from when the director fills it from the beat. */
export const FILL_SOURCES = [
  "keyword", // the beat's strongest word (a number, a capitalised/emphasised word, else the longest content word)
  "line", // the whole spoken line of the beat
  "headline", // the line shortened to <= 5 words
  "number", // the first number in the line, as a number
  "number-text", // the first number as written ("$4", "92%")
  "number-label", // the words after the number ("cups a day")
  "numbers", // every number in the line (list of numbers)
  "list-items", // the items of a list / steps beat (list of strings)
  "product-name",
  "product-image", // a media id or data: URL of the product still
  "brand",
  "cta-text", // the CTA line ("Follow for part 2", "Comment HALCYON")
  "cta-keyword", // the single word to comment / search
  "places", // place names in the line
  "images", // image media ids the timeline has
  "quote", // the quoted words
  "before", // comparison: the "before"/old side
  "after", // comparison: the "after"/new side
  "words", // the beat's word timings, shaped to the param ({w,s,e} · {text,start,end} · {text,at}), timeline seconds
  "beat-start", // the beat's start in timeline seconds (a composition's t0)
] as const;
export type FillSource = (typeof FILL_SOURCES)[number];

/** Look families (a technique's `look`; a style's allowed families). */
export const LOOKS = ["neon", "paper", "glass", "editorial", "ui", "clean", "photo", "retro"] as const;
export type Look = (typeof LOOKS)[number];

/** How the director makes it happen. The planner turns this into `effects apply` / `timeline_ops` / tool calls. */
export type TechniqueApply =
  /** `effects apply` with this library id or name (FX-05, comp:neon-hook, tr:whip-left, grade:moody, shader:…). */
  | { via: "effects"; ref: string }
  /** The captions tool with a style id (mcp/cut.ts styles). */
  | { via: "captions"; style: string }
  /** A sound from the SFX pack placed at the beat (sounds tool / ops). */
  | { via: "sounds"; sound: string }
  /** A timeline op the planner writes itself (ops@1 kind), e.g. "speed", "freeze", "ducking". */
  | { via: "ops"; op: string }
  /** A saved / built-in style preset (packages/styles). */
  | { via: "style"; preset: string }
  /** Knowledge only today: the planner can recommend it in its explanation, never apply it. */
  | { via: "manual"; why: string };

export interface TechniqueDuration {
  /** Seconds. */
  min: number;
  max: number;
  /** What it usually runs at; default (min + max) / 2. */
  ideal?: number;
}

export interface TechniqueMeta {
  /** Unique. The effects library id where one exists (FX-05, comp:<name>, tr:<kind>, grade:<look>, shader:<type>);
   * else a namespaced id: move:<slug>, cap:<style>, sfx:<slug>, style:<preset>. A sidecar may omit it (→ comp:<folder>). */
  id: string;
  kind: TechniqueKind;
  /** Human name. */
  name: string;
  /** At least one. The first is its main job. */
  purpose: Purpose[];
  /** Beat types it fits, best first. */
  beats: BeatType[];
  /** 1 calm … 5 loud. The director escalates energy toward the payoff. */
  energy: 1 | 2 | 3 | 4 | 5;
  duration: TechniqueDuration;
  /** Aspect ratios it works in (empty = all). */
  aspects: Aspect[];
  placement: Placement;
  /** What it needs; a need the timeline cannot supply excludes it (person_matte, product_image, numbers…). */
  needs: TechniqueNeed[];
  /** Ids (or `kind:` / `purpose:` selectors, e.g. "kind:sound", "purpose:emphasis") it combines well with. */
  pairsWith: string[];
  /** Ids or selectors never to put on the same beat / overlapping it. */
  avoidWith: string[];
  /** Seconds before the same technique may be used again (0 = any time). */
  minSpacing: number;
  /** What the captions do while it plays: keep (no conflict), move (into the face-safe/other zone), hide (it IS the text). */
  withCaptions: "keep" | "move" | "hide";
  /** Wall-clock render cost for one typical use, in seconds. `basis` says whether it was measured. */
  cost: { renderS: number; basis: "measured" | "estimate" };
  /** One line: why it holds attention. */
  retention: string;
  /** A spoken sentence that should trigger it. */
  example: string;
  /** How the director applies it. */
  apply: TechniqueApply;
  /** Param key → where the director fills it from (only for `effects` composition refs). */
  fill?: Record<string, FillSource>;
  /** Fill keys that may stay empty. Every other fill key is required: nothing behind it = the technique is not chosen
   * (an applied composition shows "" / [] for an empty display param, never its example copy). */
  fillOptional?: string[];
  /** Look family (neon · paper · glass · editorial · ui · clean · photo · retro): a style keeps to its families, so
   * one piece keeps one look (a declared look switch is the exception). Empty = fits any look. */
  look?: (typeof LOOKS)[number];
  /** Fixed param values the director passes (e.g. a transition's duration, a shader amount). */
  params?: Record<string, number | string | boolean>;
  /** Evidence: reference reel ids (REELS.md) or "FINDINGS §…" lines it is grounded in. */
  evidence?: string[];
  /** Where guidance was adapted from, e.g. "HyperFrames skills/… (Apache-2.0) @fa5dbd1; adapted". */
  credit?: string;
  /** Prose playbooks (hf-skills, packages/compositions/knowledge/…) that explain it at length. */
  knowledge?: string[];
  /** Free text: gotchas, the one thing not to do. */
  notes?: string;
  /** Where the record came from (set by the loader). */
  source?: "builtin" | "sidecar";
}

// ─── validation ──────────────────────────────────────────────────────────────────────────────────────────────

const ID = /^(FX-\d{2}|[a-z]+:[a-z0-9][a-z0-9:._-]*)$/;
const SELECTOR = /^(kind|purpose|beat):[a-z-]+$/;

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

function allOf<T extends string>(list: readonly T[], value: unknown, path: string, errs: string[], { nonEmpty = false } = {}): void {
  if (!Array.isArray(value)) {
    errs.push(`${path}: array required`);
    return;
  }
  if (nonEmpty && value.length === 0) errs.push(`${path}: at least one`);
  for (const v of value) if (!oneOf(list, v)) errs.push(`${path}: "${String(v)}" is not one of ${list.join(", ")}`);
}

function isRefOrSelector(value: unknown): boolean {
  return typeof value === "string" && (ID.test(value) || SELECTOR.test(value));
}

/** Every problem with one record, as readable lines (empty = valid). */
export function validateTechnique(t: unknown): string[] {
  const errs: string[] = [];
  if (!t || typeof t !== "object") return ["technique: object required"];
  const r = t as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "?";
  const p = (k: string) => `${id}.${k}`;
  if (typeof r.id !== "string" || !ID.test(r.id)) errs.push(`id: FX-NN or a namespaced id (comp:…, move:…), got ${JSON.stringify(r.id)}`);
  if (!oneOf(TECHNIQUE_KINDS, r.kind)) errs.push(`${p("kind")}: one of ${TECHNIQUE_KINDS.join(", ")}`);
  if (typeof r.name !== "string" || !r.name) errs.push(`${p("name")}: required`);
  allOf(PURPOSES, r.purpose, p("purpose"), errs, { nonEmpty: true });
  allOf(BEAT_TYPES, r.beats, p("beats"), errs, { nonEmpty: true });
  if (!Number.isInteger(r.energy) || (r.energy as number) < 1 || (r.energy as number) > 5) errs.push(`${p("energy")}: integer 1..5`);
  const d = r.duration as TechniqueDuration | undefined;
  if (!d || typeof d !== "object" || typeof d.min !== "number" || typeof d.max !== "number" || d.min < 0 || d.max < d.min || d.max > 120) {
    errs.push(`${p("duration")}: {min, max} seconds, 0 <= min <= max <= 120`);
  } else if (d.ideal !== undefined && (typeof d.ideal !== "number" || d.ideal < d.min || d.ideal > d.max)) {
    errs.push(`${p("duration.ideal")}: between min and max`);
  }
  allOf(ASPECTS, r.aspects, p("aspects"), errs);
  if (!oneOf(PLACEMENTS, r.placement)) errs.push(`${p("placement")}: one of ${PLACEMENTS.join(", ")}`);
  allOf(TECHNIQUE_NEEDS, r.needs, p("needs"), errs);
  for (const key of ["pairsWith", "avoidWith"] as const) {
    const list = r[key];
    if (!Array.isArray(list)) errs.push(`${p(key)}: array of ids or selectors (kind:…, purpose:…, beat:…)`);
    else for (const v of list) if (!isRefOrSelector(v)) errs.push(`${p(key)}: "${String(v)}" is not an id or selector`);
  }
  if (typeof r.minSpacing !== "number" || r.minSpacing < 0 || r.minSpacing > 600) errs.push(`${p("minSpacing")}: seconds, 0..600`);
  if (!oneOf(["keep", "move", "hide"] as const, r.withCaptions)) errs.push(`${p("withCaptions")}: keep | move | hide`);
  const cost = r.cost as { renderS?: unknown; basis?: unknown } | undefined;
  if (!cost || typeof cost.renderS !== "number" || cost.renderS < 0 || !oneOf(["measured", "estimate"] as const, cost.basis)) {
    errs.push(`${p("cost")}: {renderS: seconds >= 0, basis: measured | estimate}`);
  }
  if (typeof r.retention !== "string" || r.retention.length < 10) errs.push(`${p("retention")}: one line, why it holds attention`);
  if (typeof r.example !== "string" || r.example.length < 5) errs.push(`${p("example")}: a sentence that triggers it`);
  errs.push(...validateApply(r.apply, p("apply")));
  if (r.fill !== undefined) {
    if (!r.fill || typeof r.fill !== "object") errs.push(`${p("fill")}: object param → source`);
    else for (const [k, v] of Object.entries(r.fill)) if (!oneOf(FILL_SOURCES, v)) errs.push(`${p(`fill.${k}`)}: one of ${FILL_SOURCES.join(", ")}`);
  }
  if (r.params !== undefined && (!r.params || typeof r.params !== "object")) errs.push(`${p("params")}: object`);
  if (r.fillOptional !== undefined) {
    if (!Array.isArray(r.fillOptional) || !(r.fillOptional as unknown[]).every((v) => typeof v === "string")) errs.push(`${p("fillOptional")}: array of fill keys`);
    else for (const k of r.fillOptional as string[]) if (!r.fill || !(k in (r.fill as object))) errs.push(`${p("fillOptional")}: "${k}" is not a fill key`);
  }
  if (r.look !== undefined && !oneOf(LOOKS, r.look)) errs.push(`${p("look")}: one of ${LOOKS.join(", ")}`);
  for (const key of ["evidence", "knowledge"] as const) {
    if (r[key] !== undefined && (!Array.isArray(r[key]) || !(r[key] as unknown[]).every((v) => typeof v === "string"))) errs.push(`${p(key)}: array of strings`);
  }
  if (r.credit !== undefined && typeof r.credit !== "string") errs.push(`${p("credit")}: string`);
  return errs;
}

function validateApply(a: unknown, path: string): string[] {
  if (!a || typeof a !== "object") return [`${path}: {via: effects|captions|sounds|ops|style|manual, …}`];
  const r = a as Record<string, unknown>;
  const need = (k: string) => (typeof r[k] === "string" && r[k] ? [] : [`${path}.${k}: required for via ${String(r.via)}`]);
  switch (r.via) {
    case "effects":
      return need("ref");
    case "captions":
      return need("style");
    case "sounds":
      return need("sound");
    case "ops":
      return need("op");
    case "style":
      return need("preset");
    case "manual":
      return need("why");
    default:
      return [`${path}.via: effects | captions | sounds | ops | style | manual`];
  }
}

/** Validate a whole catalogue: per-record errors + duplicate ids + pairs/avoid refs that point nowhere (warnings). */
export function validateCatalogue(list: TechniqueMeta[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const t of list) {
    errors.push(...validateTechnique(t));
    if (ids.has(t.id)) errors.push(`${t.id}: duplicate id`);
    ids.add(t.id);
  }
  for (const t of list) {
    for (const ref of [...(t.pairsWith ?? []), ...(t.avoidWith ?? [])]) {
      if (!SELECTOR.test(ref) && !ids.has(ref)) warnings.push(`${t.id}: pairs/avoid "${ref}" is not in the catalogue`);
    }
  }
  return { errors, warnings };
}

/** Does `ref` (an id or a kind:/purpose:/beat: selector) match technique t? */
export function matchesRef(t: TechniqueMeta, ref: string): boolean {
  if (ref === t.id) return true;
  if (!SELECTOR.test(ref)) return false;
  const [axis, value = ""] = ref.split(":");
  if (axis === "kind") return t.kind === value;
  if (axis === "purpose") return (t.purpose as string[]).includes(value);
  if (axis === "beat") return (t.beats as string[]).includes(value);
  return false;
}

/** Fill the optional bits a sidecar may leave out (id from the folder, empty arrays, keep captions, estimate cost). */
export function normalizeTechnique(raw: Partial<TechniqueMeta> & Record<string, unknown>, folder?: string): TechniqueMeta {
  const id = raw.id ?? (folder ? `comp:${folder}` : "");
  return {
    ...raw,
    id,
    kind: raw.kind ?? "effect",
    name: raw.name ?? folder ?? id,
    purpose: raw.purpose ?? [],
    beats: raw.beats ?? [],
    energy: raw.energy ?? 3,
    duration: raw.duration ?? { min: 1, max: 4 },
    aspects: raw.aspects ?? [],
    placement: raw.placement ?? "overlay",
    needs: raw.needs ?? [],
    pairsWith: raw.pairsWith ?? [],
    avoidWith: raw.avoidWith ?? [],
    minSpacing: raw.minSpacing ?? 8,
    withCaptions: raw.withCaptions ?? "keep",
    cost: raw.cost ?? { renderS: 20, basis: "estimate" },
    retention: raw.retention ?? "",
    example: raw.example ?? "",
    apply: raw.apply ?? (folder ? { via: "effects", ref: `comp:${folder}` } : { via: "manual", why: "no apply given" }),
  } as TechniqueMeta;
}
