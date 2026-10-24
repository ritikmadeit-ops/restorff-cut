/**
 * The director's planner (director agent, 2026-10-24). Pure and deterministic for a seed: words + what is on the
 * timeline + a style profile + the technique catalogue in, beats and the techniques per beat out — with params filled
 * from the words, times on word starts (frame grid), and one line per choice saying why and how to change it.
 *
 *   1. beats       words → phrases (sentence ends, pauses ≥ 0.35 s, commas once a beat is long enough, a hard cap
 *                  of ~1.6 × the style's interval) → each classified (hook, number, list, proof, product, cta, …)
 *   2. per beat    strong beats always, others when the rhythm asks: candidates = the catalogue filtered by what is
 *                  applicable now (library status, needs, aspect, face, spacing, avoid), scored by what the beat wants,
 *                  the style's preferences, the energy curve, novelty and render cost; ties broken by the seed
 *   3. cuts        the style's transitions rotate onto existing cuts that have no event near them
 *   4. hook        a change inside the first 1.0 s (the style's hook moves) if the first beat did not give one
 *   5. gaps        no still stretch over max_gap_s: interrupts (punch-in, word pop, …) on content words
 *   6. CTA, punch  the last beat carries a CTA technique; at least one big-word punch in the piece
 *   7. pace cap    no busier than the reference (+15 %): optional interrupts go first
 *   8. sound       each visual event gets its paired sound (style density), risers into big reveals
 * Runbook: docs/restorff/worklog/director.md. Rules text: ./director-rules.ts RULES.
 */
import type { Aspect, BeatType, TechniqueMeta, TechniqueNeed } from "@restorffcut/compositions/technique";
import { matchesRef } from "@restorffcut/compositions/technique";
import { type FillResult, fillParams, type FillWord, type ParamSpecLite } from "./director-fill";
import { BEAT_WANTS, type BeatFacts, classifyBeat, cleanToken, DIRECTOR_PLANNER, energyAt, isContent, STRONG_BEATS, type StyleProfile } from "./director-rules";

// ─── input / output ──────────────────────────────────────────────────────────────────────────────────────────

export interface DirectorClip {
  id: string;
  start: number;
  end: number;
  kind: "footage" | "composition" | "image" | "other";
  /** The clip has scale/position keyframes already (never punched). */
  keyed: boolean;
}

export interface DirectorInput {
  words: FillWord[];
  /** Main-track pictures (the base picture over time). */
  clips: DirectorClip[];
  /** Existing cuts on the main track (seconds). */
  cuts: number[];
  /** Where the picture ends (seconds). */
  durationS: number;
  aspect: Aspect;
  fps: number;
  /** A caption track with captions exists. */
  captions: boolean;
  /** Person matte effects allowed (the matte exists or the caller accepts the wait). */
  matte: boolean;
  /** Still images usable as params (media ids or data: URLs). */
  images: string[];
  product?: { name?: string; image?: string; brand?: string };
  cta?: { text?: string; keyword?: string };
  places?: string[];
  /** Visual changes already on the timeline besides cuts (overlay / effect starts). */
  existing: Array<{ t: number; end: number; what: string }>;
  /** A grade is already on. */
  graded: boolean;
  techniques: TechniqueMeta[];
  /** Can it be applied today (library status, the SFX pack)? */
  available: (t: TechniqueMeta) => boolean;
  /** The manifest params of a composition technique (null for shaders, transitions, ops). */
  specs: (t: TechniqueMeta) => Record<string, ParamSpecLite> | null;
}

export interface Override {
  beat: number;
  use?: string;
  skip?: boolean;
  params?: Record<string, unknown>;
}

export interface DirectorOptions {
  profile: StyleProfile;
  /** Base energy 1–5 (default: the style's). */
  energy?: number;
  seed: string;
  from?: number;
  to?: number;
  /** Fill mode: plan only inside these [start, end] stretches (a render's still stretches). */
  windows?: Array<[number, number]>;
  overrides?: Override[];
  avoid?: string[];
  only?: string[];
  /** Apply the style's grade when none is on (default true). */
  grade?: boolean;
  /** Sound pass on (default true). */
  sound?: boolean;
}

export interface PlannedBeat {
  n: number;
  t: number;
  end: number;
  line: string;
  type: BeatType;
  why: string;
  energy_target: number;
  keyword: string | null;
  numbers: string[];
  items: string[];
}

export type EventRole = "beat" | "hook" | "interrupt" | "transition" | "cta" | "punch" | "grade" | "sound";

export interface PlannedEvent {
  n: number;
  role: EventRole;
  beat: number | null;
  t: number;
  end: number;
  duration_s: number;
  id: string;
  name: string;
  kind: TechniqueMeta["kind"];
  apply: TechniqueMeta["apply"];
  placement: TechniqueMeta["placement"];
  energy: number;
  params: Record<string, unknown>;
  /** Word the event lands on. */
  word: string | null;
  why: string;
  /** Other good choices for this slot (ids). */
  alternatives: string[];
  /** Override that swaps it: {beat, use}. */
  change: string;
  score?: number;
}

export interface DirectorPlan {
  planner: typeof DIRECTOR_PLANNER;
  style: { id: string; label: string; reel: string | null; interval_s: number; max_gap_s: number; ref_events_per_10s: number | null; energy: number };
  seed: string;
  span: { from: number; to: number; windows?: Array<[number, number]> };
  beats: PlannedBeat[];
  /** Visual events, time order. */
  events: PlannedEvent[];
  sounds: PlannedEvent[];
  recommendations: Array<{ id: string; name: string; why: string; how: string }>;
  predicted: { first_change_s: number | null; longest_gap_s: number; gap_at: [number, number] | null; changes: number; events_per_10s: number; ref_events_per_10s: number | null; big_word_punch: boolean; cta: boolean };
  notes: string[];
}

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const onFrame = (t: number, fps: number) => r3(Math.floor(t * fps + 1e-6) / fps);

/** FNV-1a → mulberry32: a deterministic [0, 1) stream per key. */
export function seeded(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VISUAL_KINDS = new Set<TechniqueMeta["kind"]>(["effect", "edit-move", "transition"]);
const BIG_WORD = new Set(["FX-22", "FX-23", "FX-21", "FX-43", "comp:neon-beats", "comp:neon-hook", "move:word-pop", "comp:word-pop"]);

interface Beat extends PlannedBeat {
  words: FillWord[];
  facts: BeatFacts;
  firstIndex: number;
}

/**
 * Word hygiene: a TTS or ASR transcript can repeat one written token for each spoken part ("1,700" said as "one
 * thousand seven hundred" → four "1,700" words, MEASURED on the local voice 2026-10-24): consecutive identical tokens
 * become one word spanning them.
 */
export function collapseRepeats(words: FillWord[]): FillWord[] {
  const out: FillWord[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (prev && prev.text === w.text && w.start - prev.end < 0.25 && /\d/.test(w.text)) prev.end = Math.max(prev.end, w.end);
    else out.push({ ...w });
  }
  return out;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const LIST_OPEN = /:$|\b(\d+|two|three|four|five|six|seven|ten)\s+(things|steps|ways|reasons|tips|tricks|secrets|mistakes|rules|ingredients|hacks)\b/i;

/** Words → beats (phrases), classified. */
export function beatsOf(rawWords: FillWord[], profile: StyleProfile, o: { durationS: number; product?: string[] }): Beat[] {
  const words = collapseRepeats(rawWords);
  const maxLen = Math.max(2.2, profile.intervalS * 1.6);
  const minLen = Math.min(0.9, profile.intervalS * 0.6);
  const groups: Array<{ words: FillWord[]; first: number }> = [];
  let cur: FillWord[] = [];
  let first = 0;
  /** Words left until the sentence ends (inclusive of the one that ends it). */
  const toSentenceEnd = (i: number) => {
    for (let k = i; k < words.length; k++) if (SENTENCE_END.test(words[k].text.trim())) return k - i + 1;
    return words.length - i;
  };
  words.forEach((w, i) => {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const len = prev.end - cur[0].start;
      const sentence = SENTENCE_END.test(prev.text.trim());
      const pause = w.start - prev.end >= 0.35;
      // an announced list ("three things happen: …", "All you need: …") stays one beat to its sentence end
      const listOpen = LIST_OPEN.test(cur.map((x) => x.text).join(" ")) && len < maxLen * 2;
      // a comma ends a beat only once it is long (lists stay one beat: "ice, a glass, and one pour")
      const comma = !listOpen && /[,;]$/.test(prev.text.trim()) && len >= Math.max(minLen, profile.intervalS);
      // a long sentence breaks before a content word, never leaving its last one or two words alone
      const tooLong = !listOpen && w.end - cur[0].start > maxLen && len >= minLen && isContent(w.text) && toSentenceEnd(i) > 2;
      if (sentence || pause || comma || tooLong) {
        groups.push({ words: cur, first });
        cur = [];
      }
    }
    if (!cur.length) first = i;
    cur.push(w);
  });
  if (cur.length) groups.push({ words: cur, first });
  // merge slivers (< 0.6 s) into the beat before
  const merged: typeof groups = [];
  for (const g of groups) {
    const len = g.words[g.words.length - 1].end - g.words[0].start;
    if (merged.length >= 1 && len < 0.6) merged[merged.length - 1].words.push(...g.words);
    else merged.push({ words: [...g.words], first: g.first });
  }
  const total = Math.max(o.durationS, words.length ? words[words.length - 1].end : 0, 0.001);
  return merged.map((g, i) => {
    const t = g.words[0].start;
    const end = g.words[g.words.length - 1].end;
    const facts = classifyBeat(
      g.words.map((w) => w.text),
      { first: i === 0, last: i === merged.length - 1 && merged.length > 1, position: (t + end) / 2 / total, product: o.product },
    );
    return {
      n: i + 1,
      t: r3(t),
      end: r3(end),
      line: g.words.map((w) => w.text).join(" "),
      type: facts.type,
      why: facts.why,
      energy_target: 0,
      keyword: facts.keyword?.text ?? null,
      numbers: facts.numbers.map((n) => n.text),
      items: facts.items,
      words: g.words,
      facts,
      firstIndex: g.first,
    };
  });
}

// ─── the planner ─────────────────────────────────────────────────────────────────────────────────────────────

export function planDirector(rawInput: DirectorInput, options: DirectorOptions): DirectorPlan {
  const input: DirectorInput = { ...rawInput, words: collapseRepeats(rawInput.words) };
  const p = options.profile;
  const base = Math.max(1, Math.min(5, options.energy ?? p.energy));
  const fps = input.fps > 0 ? input.fps : 30;
  const lastWordEnd = input.words.length ? input.words[input.words.length - 1].end : 0;
  const duration = Math.max(input.durationS, lastWordEnd);
  const from = Math.max(0, options.from ?? 0);
  const to = Math.min(duration, options.to ?? duration);
  const windows = options.windows?.length ? options.windows.map(([a, b]) => [Math.max(from, a), Math.min(to, b)] as [number, number]).filter(([a, b]) => b > a) : null;
  const inSpan = (t: number) => t >= from - 1e-6 && t <= to + 1e-6 && (!windows || windows.some(([a, b]) => t >= a - 1e-6 && t <= b + 1e-6));
  const notes: string[] = [];
  const productWords = [input.product?.name, input.product?.brand].filter((v): v is string => !!v).flatMap((v) => v.split(/\s+/));

  const allBeats = beatsOf(input.words, p, { durationS: duration, product: productWords });
  for (const b of allBeats) b.energy_target = r3(energyAt(base, (b.t + b.end) / 2 / Math.max(duration, 0.001), b.type));
  const beats = allBeats.filter((b) => inSpan(b.t) || inSpan(b.end) || (windows ? windows.some(([a, c]) => b.t <= a && b.end >= c) : false));

  const byId = new Map(input.techniques.map((t) => [t.id, t]));
  const overrides = new Map((options.overrides ?? []).map((o) => [o.beat, o]));
  const avoidRefs = [...p.avoid, ...(options.avoid ?? [])];
  /** Every id the style names itself: explicitly allowed whatever its look family. */
  const named = new Set([...p.prefer, ...p.hooks, ...p.interrupts, ...p.transitions, ...p.ctas, ...(p.grade ? [p.grade] : [])]);
  const onlyRefs = options.only?.length ? options.only : null;
  const events: PlannedEvent[] = [];
  let cutawayS = 0;

  const clipAt = (t: number) => input.clips.find((c) => c.start <= t + 1e-6 && t < c.end - 1e-6) ?? null;
  const onFootage = (t: number) => clipAt(t)?.kind === "footage";
  const cutNear = (t: number, reach = 0.4) => input.cuts.find((c) => Math.abs(c - t) <= reach) ?? null;
  const findTech = (ref: string) => byId.get(ref) ?? input.techniques.find((t) => t.name.toLowerCase() === ref.toLowerCase()) ?? null;

  const needsOk = (t: TechniqueMeta, beat: Beat | null, at: number): TechniqueNeed | null => {
    for (const need of t.needs) {
      const ok = (() => {
        switch (need) {
          case "person_matte":
          case "face_box":
            return input.matte;
          case "words":
            return input.words.length > 0;
          case "images":
          case "product_image":
            return input.images.length > 0 || !!input.product?.image;
          case "numbers":
            return !!beat?.facts.numbers.length;
          case "list_items":
            return (beat?.facts.items.length ?? 0) >= 2;
          case "places":
            return (input.places?.length ?? 0) >= 2;
          case "two_clips":
            return cutNear(at) !== null;
          case "clip":
            return !!clipAt(at);
          case "two_renders":
            return input.images.length >= 2;
          case "quote":
            return !!beat?.facts.quote;
          default:
            return false; // clean_plate, cut_list, self_check, logo, music: not supplied to the director
        }
      })();
      if (!ok) return need;
    }
    return null;
  };

  const overlapping = (t: number, end: number) => events.filter((e) => e.t < end + 0.25 && e.end > t - 0.25);
  const conflicts = (tech: TechniqueMeta, t: number, end: number) =>
    overlapping(t, end).some((e) => {
      const other = byId.get(e.id);
      return tech.avoidWith.some((ref) => (other ? matchesRef(other, ref) : ref === e.id)) || (other?.avoidWith ?? []).some((ref) => matchesRef(tech, ref)) || e.id === tech.id;
    });

  /** Why a technique cannot go at t (null = it can). */
  const blocked = (tech: TechniqueMeta, beat: Beat | null, t: number, end: number, forced = false): string | null => {
    if (!VISUAL_KINDS.has(tech.kind)) return "not a visual event";
    if (tech.apply.via === "manual") return "knowledge only (manual)";
    if (!input.available(tech)) return "not applicable today (library status)";
    if (forced) return null;
    if (avoidRefs.some((ref) => matchesRef(tech, ref))) return `the style avoids it`;
    if (onlyRefs && !onlyRefs.some((ref) => matchesRef(tech, ref))) return "not in only";
    if (tech.aspects.length && !tech.aspects.includes(input.aspect)) return `not made for ${input.aspect}`;
    if (p.looks && tech.look && !p.looks.includes(tech.look) && !named.has(tech.id)) return `${tech.look} look in a ${p.looks.join("/")} piece`;
    const need = needsOk(tech, beat, t);
    if (need) return `needs ${need}`;
    if (tech.placement === "full-frame" && onFootage(t)) {
      if (p.faceNeverCovered) return "full-frame would cover the face (style keeps the face on screen)";
      if (cutawayS + (end - t) > p.maxCutawayShare * Math.max(duration, 1)) return "full-frame cutaway budget used";
    }
    if (tech.id === "move:punch-in" && (clipAt(t)?.keyed ?? true)) return "the picture has its own camera keys (or there is none)";
    const near = events.find((e) => e.id === tech.id && Math.abs(e.t - t) < tech.minSpacing);
    if (near) return `used at ${near.t} s (spacing ${tech.minSpacing} s)`;
    if (conflicts(tech, t, end)) return "clashes with an event next to it";
    return null;
  };

  /** Its ideal length, shorter when the room is (never under its min), never past the span's end. */
  const lengthFor = (tech: TechniqueMeta, t: number, room: number) => {
    const ideal = tech.duration.ideal ?? (tech.duration.min + tech.duration.max) / 2;
    const d = Math.max(tech.duration.min, Math.min(tech.duration.max, Math.min(ideal, room)));
    return r3(Math.max(0.1, Math.min(d, to - t)));
  };

  const scoreOf = (tech: TechniqueMeta, beat: Beat, rng: () => number): number => {
    const wants = BEAT_WANTS[beat.type] ?? {};
    let s = 0;
    tech.purpose.forEach((purpose, i) => {
      s += (wants[purpose] ?? 0) * (i === 0 ? 1 : 0.6);
    });
    const at = tech.beats.indexOf(beat.type);
    s += at === 0 ? 2 : at > 0 ? 1.2 : -1.5;
    if (p.prefer.includes(tech.id)) s += 2.5;
    s -= 0.8 * Math.abs(tech.energy - beat.energy_target);
    const used = events.filter((e) => e.id === tech.id).length;
    s -= 1.5 * used;
    const prev = events.filter((e) => VISUAL_KINDS.has(e.kind)).at(-1);
    if (prev && prev.kind === tech.kind && prev.placement === tech.placement) s -= 0.4;
    s -= tech.cost.renderS / 40;
    if (input.captions && tech.withCaptions === "hide" && !["hook", "number", "reveal", "cta"].includes(beat.type)) s -= 1.2;
    if (tech.kind === "edit-move") s -= 0.5; // a beat deserves a picture of its idea first; moves are the rhythm's job
    return s + rng() * 0.25;
  };

  const fill = (tech: TechniqueMeta, beat: Beat, at: number): FillResult =>
    fillParams(tech, { beat: { t: beat.t, end: beat.end, words: beat.words, facts: beat.facts }, at, product: input.product, cta: input.cta, images: input.images, places: input.places, specs: input.specs(tech) });

  const anchorOf = (tech: TechniqueMeta, beat: Beat): { t: number; word: string | null } => {
    // emphasis-type techniques land on the keyword; the rest on the beat's first word
    const kw = beat.facts.keyword;
    const onKeyword = kw && (tech.purpose[0] === "emphasis" || tech.purpose[0] === "number-data") && beat.words[kw.index];
    const w = onKeyword ? beat.words[kw.index] : beat.words[0];
    return { t: onFrame(Math.max(from, w.start), fps), word: cleanToken(w.text) || null };
  };

  const push = (tech: TechniqueMeta, o: { role: EventRole; beat: Beat | null; t: number; end: number; word: string | null; params: Record<string, unknown>; why: string; alternatives?: string[]; score?: number }) => {
    if (tech.placement === "full-frame") {
      // a cutaway that starts or ends a few frames off its picture's edge flashes the picture under it (the gate's
      // FLASH rule: live run 2026-10-24, "halcyon-farm.jpg on screen for 3 frames at 0:00.00" under a hook at 0.1 s)
      const under = clipAt(o.t);
      const startEdge = under ? under.start : 0;
      if (o.t - startEdge < 0.35) o = { ...o, t: startEdge };
      const after = clipAt(Math.max(o.t, o.end - 0.01));
      const endEdge = after ? after.end : duration;
      if (endEdge > o.end && endEdge - o.end < 0.35) o = { ...o, end: endEdge };
    }
    const ev: PlannedEvent = {
      n: 0,
      role: o.role,
      beat: o.beat?.n ?? null,
      t: r3(o.t),
      end: r3(o.end),
      duration_s: r3(o.end - o.t),
      id: tech.id,
      name: tech.name,
      kind: tech.kind,
      apply: tech.apply,
      placement: tech.placement,
      energy: tech.energy,
      params: o.params,
      word: o.word,
      why: o.why,
      alternatives: o.alternatives ?? [],
      change: o.beat ? `overrides: [{beat: ${o.beat.n}, use: "<id>"}] swaps it; [{beat: ${o.beat.n}, skip: true}] drops it` : `avoid: ["${tech.id}"] drops it`,
      ...(o.score !== undefined ? { score: r3(o.score) } : {}),
    };
    events.push(ev);
    events.sort((a, b) => a.t - b.t);
    if (tech.placement === "full-frame" && onFootage(o.t)) cutawayS += o.end - o.t;
    return ev;
  };

  /**
   * Every visual change point: cuts, what is already on the timeline, planned events. Anything that appears also
   * changes the frame when it leaves (an overlay's exit, a punch-in's release): the retention measurer counts both
   * (live run 2026-10-24: planned 6.65 / 10 s counting starts only, measured 10.2). A transition is one change.
   */
  const changes = (exclude?: PlannedEvent): number[] => {
    const pts = [
      ...input.cuts,
      ...input.existing.flatMap((e) => [e.t, e.end]),
      ...events.filter((e) => e !== exclude && VISUAL_KINDS.has(e.kind)).flatMap((e) => (e.kind === "transition" ? [r3(e.t + e.duration_s / 2)] : [e.t, e.end])),
    ];
    // two changes closer than 0.25 s read as one (the measurer needs calm frames between events)
    const sorted = [...new Set(pts.map(r3))].filter((t) => t >= 0 && t <= duration).sort((a, b) => a - b);
    return sorted.filter((t, i) => i === 0 || t - sorted[i - 1] >= 0.25);
  };
  /** The still stretches over max_gap_s inside the span (a CTA card holding the end is not still). */
  const gapsOver = (pts: number[]): Array<[number, number]> => {
    const all = [from, ...pts.filter((c) => c > from && c < to), to];
    const out: Array<[number, number]> = [];
    for (let i = 0; i + 1 < all.length; i++) {
      const [a, b] = [all[i], all[i + 1]];
      if (b - a <= p.maxGapS + 1e-6 || !inSpan((a + b) / 2)) continue;
      if (events.some((e) => e.role === "cta" && e.t <= a + 1e-6 && e.end >= b - 0.05)) continue;
      out.push([a, b]);
    }
    return out;
  };
  /** Take an event out (returns a function that puts it back). */
  const takeOut = (e: PlannedEvent | undefined) => {
    if (!e) return () => {};
    events.splice(events.indexOf(e), 1);
    return () => {
      events.push(e);
      events.sort((a, b) => a.t - b.t);
    };
  };
  const lastChangeBefore = (t: number) => changes().filter((c) => c <= t + 1e-6).at(-1) ?? null;

  // ── 2. a technique per beat ───────────────────────────────────────────────────────────────────────────────
  const visualPool = input.techniques.filter((t) => VISUAL_KINDS.has(t.kind) && t.kind !== "transition");
  for (const beat of beats) {
    const ov = overrides.get(beat.n);
    if (ov?.skip) continue;
    const rng = seeded(`${options.seed}:${beat.n}`);
    const lastChange = lastChangeBefore(beat.t);
    const since = lastChange === null ? Number.POSITIVE_INFINITY : beat.t - lastChange;
    const wanted = !!ov?.use || STRONG_BEATS.has(beat.type) || since >= p.intervalS * 0.8 || !!windows;
    if (!wanted) continue;
    const nextBeat = allBeats.find((b) => b.n === beat.n + 1);
    const room = (nextBeat ? nextBeat.end : duration) - beat.t;
    if (ov?.use) {
      const tech = findTech(ov.use);
      if (!tech) {
        notes.push(`beat ${beat.n}: override "${ov.use}" is not in the catalogue; planned normally`);
      } else {
        const a = anchorOf(tech, beat);
        const end = a.t + lengthFor(tech, a.t, room);
        const why = blocked(tech, beat, a.t, end, true);
        if (why) notes.push(`beat ${beat.n}: override ${tech.id} cannot be applied (${why}); planned normally`);
        else {
          const filled = fill(tech, beat, a.t);
          push(tech, { role: tech.purpose.includes("cta") ? "cta" : "beat", beat, t: a.t, end, word: a.word, params: { ...filled.params, ...(ov.params ?? {}) }, why: `Beat ${beat.n} (${beat.type}): ${tech.name} — your override.` });
          continue;
        }
      }
    }
    const scored: Array<{ tech: TechniqueMeta; s: number; t: number; end: number; word: string | null; filled: FillResult }> = [];
    const wants = BEAT_WANTS[beat.type] ?? {};
    for (const tech of visualPool) {
      // it must fit the beat: the beat type is listed, or one of its purposes is something the beat wants;
      // a CTA technique only ever closes (every reference reel ends on the ask, none asks mid-way)
      if (tech.purpose[0] === "cta" && beat.type !== "cta") continue;
      if (!tech.beats.includes(beat.type) && !tech.purpose.some((purpose) => (wants[purpose] ?? 0) > 0)) continue;
      const a = anchorOf(tech, beat);
      const end = a.t + lengthFor(tech, a.t, room);
      if (blocked(tech, beat, a.t, end)) continue;
      const filled = fill(tech, beat, a.t);
      if (filled.missing.length) continue;
      scored.push({ tech, s: scoreOf(tech, beat, rng), t: a.t, end, word: a.word, filled });
    }
    scored.sort((x, y) => y.s - x.s || (x.tech.id < y.tech.id ? -1 : 1));
    const best = scored[0];
    if (!best) {
      notes.push(`beat ${beat.n} (${beat.type}): nothing applicable`);
      continue;
    }
    const fromWhat = Object.entries(best.filled.from).map(([k, src]) => `${k} ← ${src}`).join(", ");
    push(best.tech, {
      role: best.tech.purpose.includes("cta") ? "cta" : beat.n === 1 ? "hook" : "beat",
      beat,
      t: best.t,
      end: best.end,
      word: best.word,
      params: { ...best.filled.params, ...(ov?.params ?? {}) },
      why: `Beat ${beat.n} "${beat.facts.headline}" (${beat.type}: ${beat.why}): ${best.tech.name} — ${best.tech.retention} Energy ${best.tech.energy} vs curve ${beat.energy_target}${Number.isFinite(since) ? `; ${r3(since)} s after the last change` : ""}${fromWhat ? `; ${fromWhat}` : ""}.`,
      alternatives: scored.slice(1, 4).map((x) => x.tech.id),
      score: best.s,
    });
  }

  // ── 3. transitions on existing cuts ───────────────────────────────────────────────────────────────────────
  if (p.transitions.length) {
    let turn = 0;
    for (const cut of input.cuts) {
      if (!inSpan(cut) || cut <= 0.05 || cut >= duration - 0.05) continue;
      if (events.some((e) => Math.abs(e.t - cut) < 0.3 && VISUAL_KINDS.has(e.kind))) continue;
      for (let k = 0; k < p.transitions.length; k++) {
        const tech = byId.get(p.transitions[(turn + k) % p.transitions.length]);
        if (!tech) continue;
        const len = tech.duration.ideal ?? tech.duration.min;
        const t = r3(cut - len / 2);
        if (blocked(tech, null, cut, t + len)) continue;
        push(tech, { role: "transition", beat: null, t, end: t + len, word: null, params: { duration_s: r3(len) }, why: `Cut at ${r3(cut)} s: ${tech.name} — ${tech.retention}` });
        turn = (turn + k + 1) % p.transitions.length;
        break;
      }
    }
  }

  const visual = () => events.filter((e) => VISUAL_KINDS.has(e.kind));
  const beatAt = (t: number): Beat | null => allBeats.find((b) => b.t <= t + 1e-6 && t <= b.end + 0.35) ?? allBeats.find((b) => b.t >= t) ?? null;
  const wordNear = (ideal: number, lo: number, hi: number, reach = 0.6): FillWord | null => {
    const near = input.words.filter((w) => w.start > lo && w.start < hi && Math.abs(w.start - ideal) <= reach);
    if (!near.length) return null;
    return near.sort((a, b) => Math.abs(a.start - ideal) + (isContent(a.text) ? 0 : 0.5) - (Math.abs(b.start - ideal) + (isContent(b.text) ? 0 : 0.5)))[0];
  };
  const placeMove = (pool: string[], role: EventRole, at: number, why: string, lo: number, hi: number): PlannedEvent | null => {
    const w = wordNear(at, lo, hi);
    const t = onFrame(w ? w.start : at, fps);
    const beat = beatAt(t);
    for (const id of pool) {
      const tech = byId.get(id);
      if (!tech) continue;
      const end = t + lengthFor(tech, t, Math.min(p.intervalS, hi - t));
      if (blocked(tech, beat, t, end)) continue;
      const filled = beat ? fill(tech, { ...beat, facts: { ...beat.facts, keyword: w ? { text: cleanToken(w.text), index: Math.max(0, beat.words.indexOf(w)) } : beat.facts.keyword } }, t) : { params: { ...(tech.params ?? {}) }, missing: [], from: {} };
      if (filled.missing.length) continue;
      return push(tech, { role, beat, t, end, word: w ? cleanToken(w.text) : null, params: filled.params, why: `${why}: ${tech.name}${w ? ` on "${cleanToken(w.text)}"` : ""} — ${tech.retention}` });
    }
    return null;
  };

  // ── 4. hook inside the first second ───────────────────────────────────────────────────────────────────────
  if (from < 1.0 && inSpan(0.5)) {
    const first = changes()[0];
    if (first === undefined || first > 1.0) {
      const placed = placeMove(p.hooks, "hook", Math.min(0.5, input.words[0]?.start ?? 0.3), "Hook (nothing changes in the first second)", -0.01, 1.0);
      if (!placed) notes.push("no hook move could be placed inside the first second");
    }
  }

  // ── 6a. the last beat carries the ask ─────────────────────────────────────────────────────────────────────
  const lastBeat = allBeats.at(-1);
  if (lastBeat && allBeats.length > 1 && inSpan(lastBeat.t) && !overrides.get(lastBeat.n)?.skip && !overrides.get(lastBeat.n)?.use) {
    const current = events.find((e) => e.beat === lastBeat.n && VISUAL_KINDS.has(e.kind));
    const isCta = current && byId.get(current.id)?.purpose.includes("cta");
    if (!isCta) {
      const putBack = takeOut(current);
      let placed = false;
      for (const id of p.ctas) {
        const tech = byId.get(id);
        if (!tech) continue;
        const t = onFrame(Math.max(lastBeat.t, duration - (tech.duration.ideal ?? tech.duration.max)), fps);
        const end = Math.max(Math.min(duration, t + tech.duration.max), Math.min(duration, t + tech.duration.min));
        if (blocked(tech, lastBeat, t, end)) continue;
        const filled = fill(tech, lastBeat, t);
        if (filled.missing.length) continue;
        push(tech, { role: "cta", beat: lastBeat, t, end, word: lastBeat.words[0] ? cleanToken(lastBeat.words[0].text) : null, params: filled.params, why: `Beat ${lastBeat.n} "${lastBeat.facts.headline}" (the end): ${tech.name} — ${tech.retention}`, alternatives: current ? [current.id] : [] });
        placed = true;
        break;
      }
      if (!placed) {
        putBack();
        notes.push(`no CTA technique fits the last beat (${p.ctas.join(", ")}: give cta {keyword} or check their status)`);
      }
    }
  }

  // ── 5. no still stretch over max_gap_s ────────────────────────────────────────────────────────────────────
  const fallbackInterrupts = input.techniques
    .filter((t) => t.purpose.includes("pattern-interrupt") && t.cost.renderS <= 20 && VISUAL_KINDS.has(t.kind) && t.kind !== "transition" && !p.interrupts.includes(t.id))
    .map((t) => t.id)
    .sort();
  const unfillable = new Set<string>();
  for (let guard = 0; guard < 200; guard++) {
    const gap = gapsOver(changes()).find(([a, b]) => !unfillable.has(`${r3(a)}-${r3(b)}`));
    if (!gap) break;
    const [a, b] = gap;
    const at = a + Math.min(p.intervalS, (b - a) / 2);
    const label = `Still from ${r3(a)} to ${r3(b)} s`;
    if (placeMove(p.interrupts, "interrupt", at, label, a + 0.3, b - 0.3)) continue;
    if (placeMove(fallbackInterrupts, "interrupt", at, label, a + 0.3, b - 0.3)) continue;
    unfillable.add(`${r3(a)}-${r3(b)}`);
    notes.push(`still stretch ${r3(a)}–${r3(b)} s: no interrupt fits (spacing, needs or keyed pictures); add a cut there`);
  }

  // ── 6b. at least one big-word punch ───────────────────────────────────────────────────────────────────────
  if (!windows && !visual().some((e) => BIG_WORD.has(e.id))) {
    const target = [...beats].filter((b) => b.facts.keyword && b.type !== "cta").sort((x, y) => (["number", "reveal", "hook"].includes(y.type) ? 1 : 0) - (["number", "reveal", "hook"].includes(x.type) ? 1 : 0) || y.energy_target - x.energy_target)[0];
    if (target?.facts.keyword) {
      const w = target.words[target.facts.keyword.index];
      const t = onFrame(w.start, fps);
      const clash = events.find((e) => VISUAL_KINDS.has(e.kind) && e.beat === target.n && e.role !== "cta" && e.role !== "transition");
      const putBack = takeOut(clash);
      let placed = false;
      for (const id of ["FX-22", "move:word-pop"]) {
        const tech = byId.get(id);
        if (!tech) continue;
        const end = t + lengthFor(tech, t, 1.5);
        if (blocked(tech, target, t, end)) continue;
        const filled = fill(tech, target, t);
        if (filled.missing.length) continue;
        push(tech, { role: "punch", beat: target, t, end, word: cleanToken(w.text), params: filled.params, why: `Big-word punch on "${cleanToken(w.text)}" (beat ${target.n}, ${target.type}): every reference reel has at least one — ${tech.retention}`, alternatives: clash ? [clash.id] : [] });
        placed = true;
        break;
      }
      if (!placed) {
        putBack();
        notes.push("no big-word punch could be placed (FX-22 / move:word-pop blocked)");
      }
    }
  }

  // ── 7. pace cap: no busier than the reference + 15 % ──────────────────────────────────────────────────────
  if (p.refEventsPer10s) {
    const span = windows ? windows.reduce((s, [a, b]) => s + (b - a), 0) : to - from;
    const cap = Math.ceil((p.refEventsPer10s * 1.15 * span) / 10);
    const counted = () => changes().filter((c) => inSpan(c)).length;
    const before = gapsOver(changes()).length;
    // drop order: interrupts, techniques on weak beats, transitions, then strong beats (lowest score first);
    // never the hook, the CTA, the big-word punch or the grade
    const rank = (e: PlannedEvent) => {
      if (e.role === "interrupt") return 0;
      if (e.role === "beat" && !STRONG_BEATS.has(allBeats.find((b) => b.n === e.beat)?.type ?? "bridge")) return 1;
      if (e.role === "transition") return 2;
      return 3;
    };
    const removable = () => events.filter((e) => e.role === "interrupt" || e.role === "beat" || e.role === "transition").sort((x, y) => rank(x) - rank(y) || (x.score ?? -1) - (y.score ?? -1) || x.t - y.t);
    let guard = 0;
    while (counted() > cap && guard++ < 80) {
      // drop one only if it opens no new still stretch over the bar
      const victim = removable().find((e) => gapsOver(changes(e)).length <= before);
      if (!victim) break;
      takeOut(victim);
      notes.push(`pace cap (${p.refEventsPer10s} events / 10 s in the reference, +15 %): dropped ${victim.name} at ${victim.t} s`);
    }
    if (counted() > cap) notes.push(`pace cap: still ${counted()} changes vs a cap of ${cap}; dropping more would open a still stretch over ${p.maxGapS} s`);
  }

  // ── grade (whole piece) ───────────────────────────────────────────────────────────────────────────────────
  const gradeEvents: PlannedEvent[] = [];
  if (p.grade && options.grade !== false && !input.graded && !windows) {
    const tech = byId.get(p.grade);
    if (tech && input.available(tech)) {
      gradeEvents.push({ n: 0, role: "grade", beat: null, t: 0, end: r3(duration), duration_s: r3(duration), id: tech.id, name: tech.name, kind: tech.kind, apply: tech.apply, placement: tech.placement, energy: tech.energy, params: {}, word: null, why: `The ${p.label} look: ${tech.name} — ${tech.retention}`, alternatives: [], change: 'grade: false leaves the grade alone' });
    }
  }

  // ── 8. sound ──────────────────────────────────────────────────────────────────────────────────────────────
  const sounds: PlannedEvent[] = [];
  if (options.sound !== false && p.sound !== "none") {
    const soundUse = new Map<string, number>();
    const lastSoundAt = () => sounds.at(-1)?.t ?? Number.NEGATIVE_INFINITY;
    const soundFor = (e: PlannedEvent): TechniqueMeta | null => {
      const tech = byId.get(e.id);
      const candidates = [
        ...(tech?.pairsWith ?? []).filter((ref) => ref.startsWith("sfx:")),
        ...(e.kind === "transition" ? ["sfx:whoosh"] : []),
        ...(e.id === "move:punch-in" || e.id === "FX-05" ? ["sfx:whoosh"] : []),
        ...(e.energy >= 4 ? ["sfx:hit"] : []),
        "sfx:pop",
      ];
      for (const ref of candidates) {
        const s = byId.get(ref);
        if (!s || s.kind !== "sound" || s.apply.via !== "sounds" || !input.available(s)) continue;
        const last = soundUse.get(s.id);
        if (last !== undefined && e.t - last < s.minSpacing) continue;
        return s;
      }
      return null;
    };
    for (const e of visual()) {
      if (p.sound === "big" && !(e.kind === "transition" || e.energy >= 4 || e.role === "hook" || e.role === "cta")) continue;
      if (e.t - lastSoundAt() < 0.45) continue;
      const s = soundFor(e);
      if (!s) continue;
      const at = e.kind === "transition" ? r3(e.t + e.duration_s / 2) : e.t;
      sounds.push({ n: 0, role: "sound", beat: e.beat, t: at, end: r3(at + (s.duration.ideal ?? s.duration.max)), duration_s: r3(s.duration.ideal ?? s.duration.max), id: s.id, name: s.name, kind: s.kind, apply: s.apply, placement: s.placement, energy: s.energy, params: {}, word: e.word, why: `${s.name} on ${e.name} at ${at} s — ${s.retention}`, alternatives: [], change: `sound: false drops every sound; avoid: ["${s.id}"] drops this one` });
      soundUse.set(s.id, at);
    }
    // a full-frame cutaway's exit is a hard cut too: a swish on it (cuts on a sound hit: 84.6 % in the collage
    // reference vs 44 % on the live v3, whose unsounded cuts were mostly cutaway exits)
    const exitSound = byId.get("sfx:whoosh");
    if (exitSound && input.available(exitSound) && p.sound === "all") {
      for (const e of visual()) {
        if (e.placement !== "full-frame" || e.end >= duration - 0.3) continue;
        if (sounds.some((s) => Math.abs(s.t - e.end) < 0.45)) continue;
        if (input.cuts.some((c) => Math.abs(c - e.end) < 0.05) && events.some((o) => o.kind === "transition" && Math.abs(o.t + o.duration_s / 2 - e.end) < 0.05)) continue;
        sounds.push({ n: 0, role: "sound", beat: e.beat, t: e.end, end: r3(e.end + (exitSound.duration.ideal ?? 0.45)), duration_s: exitSound.duration.ideal ?? 0.45, id: exitSound.id, name: exitSound.name, kind: exitSound.kind, apply: exitSound.apply, placement: exitSound.placement, energy: exitSound.energy, params: {}, word: null, why: `${exitSound.name} on ${e.name}'s exit at ${e.end} s — the cutaway leaving is a cut the ear should hear`, alternatives: [], change: `sound: false drops every sound` });
      }
      sounds.sort((a, b) => a.t - b.t);
    }
    // risers into big reveals (≤ 1 per 10 s), on their own lane
    const riser = byId.get("sfx:riser");
    if (riser && input.available(riser) && p.sound === "all") {
      let lastRiser = Number.NEGATIVE_INFINITY;
      for (const e of visual()) {
        const beat = allBeats.find((b) => b.n === e.beat);
        if (!beat || !["reveal", "number"].includes(beat.type) || e.energy < 4 || e.t < 1.5 || e.t - lastRiser < 10) continue;
        if (sounds.some((s) => s.t > e.t - 1.0 && s.t < e.t - 0.05)) continue;
        sounds.push({ n: 0, role: "sound", beat: e.beat, t: e.t, end: e.t, duration_s: riser.duration.ideal ?? 1, id: riser.id, name: riser.name, kind: riser.kind, apply: riser.apply, placement: riser.placement, energy: riser.energy, params: {}, word: e.word, why: `${riser.name}: builds for 1 s and peaks on "${e.word ?? e.name}" at ${e.t} s — ${riser.retention}`, alternatives: [], change: `avoid: ["sfx:riser"] drops it` });
        lastRiser = e.t;
      }
    }
    sounds.sort((a, b) => a.t - b.t);
  }

  // ── recommendations: captions, the style, manual moves that fit ───────────────────────────────────────────
  const recommendations: DirectorPlan["recommendations"] = [];
  if (!input.captions && input.words.length) {
    const cap = byId.get(p.captions);
    if (cap && cap.apply.via === "captions") recommendations.push({ id: cap.id, name: cap.name, why: `No captions yet: speech fills 89–99 % of a reel and captions change every 1–5 words in every reference. ${cap.retention}`, how: `captions {timeline_id, all: true, style: "${cap.apply.style}"}` });
  }
  const manualFits = new Map<string, { t: TechniqueMeta; beats: number[] }>();
  for (const beat of beats) {
    for (const t of input.techniques) {
      if (t.apply.via !== "manual" || !VISUAL_KINDS.has(t.kind) || t.beats[0] !== beat.type) continue;
      const entry = manualFits.get(t.id) ?? { t, beats: [] };
      entry.beats.push(beat.n);
      manualFits.set(t.id, entry);
    }
  }
  for (const { t, beats: on } of [...manualFits.values()].slice(0, 3)) {
    if (t.apply.via === "manual") recommendations.push({ id: t.id, name: t.name, why: `Fits beat${on.length > 1 ? "s" : ""} ${on.slice(0, 4).join(", ")}: ${t.retention}`, how: t.apply.why });
  }

  // ── number the events, predict ────────────────────────────────────────────────────────────────────────────
  const finalEvents = [...gradeEvents, ...events].sort((a, b) => a.t - b.t || (a.role === "grade" ? -1 : 1));
  finalEvents.forEach((e, i) => {
    e.n = i + 1;
  });
  sounds.forEach((s, i) => {
    s.n = i + 1;
  });
  const pts = changes();
  const inside = pts.filter((c) => inSpan(c));
  const all = [from, ...pts.filter((c) => c > from && c < to), to];
  let longest = 0;
  let gapAt: [number, number] | null = null;
  for (let i = 0; i + 1 < all.length; i++) {
    const [a, b] = [all[i], all[i + 1]];
    if (events.some((e) => e.role === "cta" && e.t <= a + 1e-6 && e.end >= b - 0.05)) continue;
    if (b - a > longest) {
      longest = b - a;
      gapAt = [r3(a), r3(b)];
    }
  }
  const spanS = windows ? windows.reduce((s, [a, b]) => s + (b - a), 0) : to - from;
  return {
    planner: DIRECTOR_PLANNER,
    style: { id: p.id, label: p.label, reel: p.reel ?? null, interval_s: p.intervalS, max_gap_s: p.maxGapS, ref_events_per_10s: p.refEventsPer10s, energy: base },
    seed: options.seed,
    span: { from: r3(from), to: r3(to), ...(windows ? { windows: windows.map(([a, b]) => [r3(a), r3(b)] as [number, number]) } : {}) },
    beats: beats.map(({ words: _w, facts: _f, firstIndex: _i, ...rest }) => rest),
    events: finalEvents,
    sounds,
    recommendations,
    predicted: {
      first_change_s: pts.length ? pts[0] : null,
      longest_gap_s: r3(longest),
      gap_at: gapAt,
      changes: inside.length,
      events_per_10s: spanS > 0 ? r3((inside.length / spanS) * 10) : 0,
      ref_events_per_10s: p.refEventsPer10s,
      big_word_punch: events.some((e) => BIG_WORD.has(e.id)),
      cta: events.some((e) => e.role === "cta"),
    },
    notes,
  };
}
