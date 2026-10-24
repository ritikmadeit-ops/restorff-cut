/**
 * The director's rules (director agent, 2026-10-24; owner I-10: "make it knowledgeable enough to when to use those
 * features … to make the video more retention worthy"). Pure data + pure functions: style profiles, the beat
 * classifier, the energy curve. The planner is ./director-plan.ts; the technique records are
 * packages/compositions/src/techniques-builtin.ts (+ sidecars); the long-form playbooks are
 * packages/compositions/knowledge/ (hf-skills agent). Runbook: docs/restorff/worklog/director.md.
 *
 * Numbers come from spikes/s6-reference-reels/FINDINGS.md (SEEN / MEASURED) and the retention calibration in
 * docs/restorff/worklog/retention.md (score.py's detector on the five reference reels: first change 0.07–0.67 s,
 * 4.81–7.35 visual events per 10 s). Where a profile number is a judgement it says ASSUMPTION.
 */
import type { Aspect, BeatType, Look, Purpose } from "@restorffcut/compositions/technique";

export const DIRECTOR_PLANNER = "director@1";

/** The hard rules every plan keeps (shown in answers; the planner and its tests enforce them). */
export const RULES = [
  "HOOK: something changes on screen inside the first 1.0 s (the retention gate's HOOK bar; references 0.07–0.67 s).",
  "RHYTHM: a visual change about every interval_s of the style (1.0–2.6 s) and never a still stretch over max_gap_s (≤ 3.0 s, the DEAD bar) — but no busier than the reference (MVP runs ran 29–51 % busier than their reels).",
  "SPACING: a technique is not reused inside its minSpacing.",
  "ESCALATE: energy rises toward the payoff (the last third), the hook starts high, the CTA settles.",
  "CTA: the last beat carries the ask (every reference reel ends on one).",
  "FACE: overlays go face-safe or behind the person; full-frame cutaways only where the style allows them.",
  "CAPTIONS: never fight them — techniques that are the text (big word, kinetic type) are rationed when captions are on.",
  "PUNCH: at least one big-word punch per piece (every reference reel has one).",
  "SOUND: visual events get a sound from their pairs (cuts on a sound hit: 56 % in the collage reel vs 42 % chance).",
];

export type PieceType = "ad" | "reel" | "explainer" | "brand-film" | "motion-graphic";

export interface StyleProfile {
  id: string;
  label: string;
  /** Reference reel (REELS.md id) the numbers come from, if any. */
  reel?: string;
  /** Target seconds between visual changes. */
  intervalS: number;
  /** Longest still stretch allowed (the DEAD bar is 3.0 s). */
  maxGapS: number;
  /** The reference's visual events per 10 s (retention calibration), or null when there is no reference. */
  refEventsPer10s: number | null;
  /** Base energy 1–5 (the curve escalates from here). */
  energy: number;
  /** Technique ids this style reaches for first (+3 in the score). */
  prefer: string[];
  /** Ids or selectors it never uses. */
  avoid: string[];
  /** Transitions for existing cuts, in rotation (empty = hard cuts). */
  transitions: string[];
  /** Caption style recommended when the timeline has none. */
  captions: string;
  /** Grade look applied when none is on (null = leave the grade alone). */
  grade: string | null;
  /** Look families it keeps to (techniques with another `look` only when in prefer); null = any look. */
  looks: Look[] | null;
  /** The face is never covered (no full-frame cutaways on footage). */
  faceNeverCovered: boolean;
  /** Share of runtime full-frame cutaways may take on footage (0..1). */
  maxCutawayShare: number;
  /** Sound on: every visual event (all) · only energy ≥ 4 and transitions (big) · none. */
  sound: "all" | "big" | "none";
  /** Interrupt moves the gap filler may use, in order of preference. */
  interrupts: string[];
  /** Hook moves (first second), in order of preference. */
  hooks: string[];
  /** CTA techniques, in order of preference. */
  ctas: string[];
  notes: string;
}

const COMMON_INTERRUPTS = ["move:punch-in", "move:word-pop", "FX-05"];

export const STYLE_PROFILES: Record<string, StyleProfile> = {
  "explainer-overlay": {
    id: "explainer-overlay",
    label: "Explainer overlay (locked talking head, animations above the head)",
    reel: "DeIGbZypIUb",
    intervalS: 2.0, // 25 overlay beats in 49.5 s (FINDINGS §1)
    maxGapS: 3.0,
    refEventsPer10s: 6.46,
    energy: 3,
    prefer: ["FX-24", "FX-29", "FX-27", "FX-28", "FX-22", "FX-32", "FX-19", "FX-30", "FX-07", "FX-31", "FX-35", "comp:toc-list"],
    avoid: ["kind:transition", "FX-05", "move:punch-in", "kind:grade"], // no transitions, punch-ins or grade in the reel (SEEN)
    transitions: [],
    captions: "FX-18",
    grade: null,
    looks: ["glass", "ui", "clean"],
    faceNeverCovered: true,
    maxCutawayShare: 0,
    sound: "big",
    interrupts: ["FX-24", "move:word-pop", "FX-28"],
    hooks: ["FX-22", "FX-24", "move:word-pop"],
    ctas: ["FX-35"],
    notes: "The top ~40 % is the animation zone; the face and body are never covered; one moving part per beat; ≤ 0.15 s fades.",
  },
  "neon-grid-type": {
    id: "neon-grid-type",
    label: "Neon grid kinetic type (motion graphics as code)",
    reel: "DeBhOJ6T1Ja",
    intervalS: 2.4, // events 5.42 / 10 s in the reference; scenes change 2.1 / 10 s and move inside
    maxGapS: 3.0,
    refEventsPer10s: 5.42,
    energy: 4,
    prefer: ["comp:neon-hook", "comp:neon-beats", "comp:neon-code", "comp:neon-flow", "comp:neon-curve", "comp:neon-grid-ruler", "comp:neon-form", "comp:neon-outro", "FX-48", "FX-23", "FX-49", "FX-50", "FX-51", "FX-22", "tr:flash", "FX-40", "tr:glitch"],
    avoid: ["kind:grade", "FX-20"],
    transitions: ["FX-40", "tr:flash", "FX-09", "tr:whip-right"],
    captions: "cap:key-word",
    grade: null,
    looks: ["neon", "clean"],
    faceNeverCovered: false,
    maxCutawayShare: 1,
    sound: "all",
    interrupts: ["move:punch-in", "comp:neon-beats", "FX-22"],
    hooks: ["comp:neon-hook", "FX-23", "FX-22", "move:punch-in"],
    ctas: ["comp:neon-outro", "FX-35"],
    notes: "Dark grid, one ember accent, words ignite then cool; one deliberate look switch to paper is allowed (FX-51 / neon-form).",
  },
  "paper-collage": {
    id: "paper-collage",
    label: "Paper collage explainer",
    reel: "DePNgrmToh9",
    intervalS: 2.1, // 4.7 cuts / 10 s (FINDINGS §5)
    maxGapS: 3.0,
    refEventsPer10s: 7.3,
    energy: 3,
    prefer: ["FX-52", "FX-53", "FX-54", "FX-55", "FX-56", "FX-57", "FX-58", "FX-61", "FX-26", "FX-25", "FX-40", "sfx:paper", "sfx:marker", "sfx:stamp"],
    avoid: ["tr:glitch"],
    transitions: ["FX-40", "tr:push-left", "tr:slide-left", "tr:whip-right"],
    captions: "cap:mono-label",
    grade: "grade:paper",
    looks: ["paper", "retro", "photo", "clean"],
    faceNeverCovered: false,
    maxCutawayShare: 0.75,
    sound: "all", // 56 % of cuts on a sound hit vs 41.7 % chance (MEASURED)
    interrupts: ["move:punch-in", "FX-26", "move:word-pop"],
    hooks: ["FX-56", "FX-22", "move:punch-in"],
    ctas: ["FX-35"],
    notes: "Red-outlined cut-outs with drop shadows on old paper; mono caps captions on a black box over the speaker, serif in scenes.",
  },
  "effects-library": {
    id: "effects-library",
    label: "Effects library (a new named effect every second)",
    reel: "Def9pj5TWtA",
    intervalS: 1.0, // 17 demos in 16.6 s (FINDINGS §4)
    maxGapS: 2.0,
    refEventsPer10s: 7.35,
    energy: 5,
    prefer: ["FX-01", "FX-02", "FX-03", "FX-04", "FX-05", "FX-06", "FX-07", "FX-08", "FX-09", "FX-10", "FX-11", "FX-12", "FX-13", "FX-14", "FX-15", "FX-16", "FX-17", "comp:toc-list"],
    avoid: [],
    transitions: ["FX-09", "FX-40"],
    captions: "cap:key-word",
    grade: null,
    looks: null,
    faceNeverCovered: false,
    maxCutawayShare: 0.5,
    sound: "all",
    interrupts: ["FX-05", "move:punch-in", "move:word-pop"],
    hooks: ["FX-04", "FX-22", "move:punch-in"],
    ctas: ["FX-35"],
    notes: "≈ 1 s per effect while the names are read, then a locked talking head for the CTA; key word bigger and yellow in captions.",
  },
  "warm-moody": {
    id: "warm-moody",
    label: "Warm editorial → moody (style by sentence)",
    reel: "DeUUFJQu8cw",
    intervalS: 2.1, // events 4.81 / 10 s; set-up cuts 1.9 / 10 s (FINDINGS §2, retention calibration)
    maxGapS: 3.0,
    refEventsPer10s: 4.81,
    energy: 2,
    prefer: ["FX-30", "FX-42", "FX-16", "FX-36", "FX-25", "FX-26", "FX-32", "FX-21", "FX-43", "FX-40", "tr:blur", "comp:magazine-cover"],
    avoid: ["tr:glitch", "tr:flash"],
    transitions: ["FX-40", "tr:blur"],
    captions: "FX-20",
    grade: "FX-38",
    looks: ["editorial", "ui", "clean", "photo"],
    faceNeverCovered: true,
    maxCutawayShare: 0.15,
    sound: "big",
    interrupts: ["move:punch-in", "move:word-pop", "FX-30"],
    hooks: ["FX-43", "FX-21", "FX-22", "move:punch-in"],
    ctas: ["FX-35"],
    notes: "Bottle green + bone + ochre from the footage; serif karaoke captions; whips on set-up changes; big serif word behind the head.",
  },
  ad: {
    id: "ad",
    label: "Product ad (default for piece type ad)",
    intervalS: 2.0, // ASSUMPTION: the middle of the references' 1.4–2.1 s between events
    maxGapS: 3.0,
    refEventsPer10s: null,
    energy: 3,
    prefer: ["FX-22", "FX-32", "FX-10", "FX-27", "FX-06", "FX-07", "FX-28", "FX-26", "FX-35", "move:punch-in"],
    avoid: [],
    transitions: ["FX-40", "FX-09"],
    captions: "cap:word-pop",
    grade: null,
    looks: ["ui", "clean", "editorial", "photo"],
    faceNeverCovered: true,
    maxCutawayShare: 0.3,
    sound: "all",
    interrupts: COMMON_INTERRUPTS,
    hooks: ["FX-22", "move:punch-in", "FX-04"],
    ctas: ["FX-35"],
    notes: "Hook, problem, product, proof with numbers, CTA; the product on screen long enough to recognise.",
  },
  "fast-ugc": {
    id: "fast-ugc",
    label: "Fast UGC",
    intervalS: 1.5, // ASSUMPTION: the fast end of the references
    maxGapS: 2.5,
    refEventsPer10s: null,
    energy: 4,
    prefer: ["move:punch-in", "FX-22", "FX-40", "FX-26", "tr:flash", "FX-32", "FX-35"],
    avoid: ["tr:dissolve", "tr:iris", "tr:dip-black"],
    transitions: ["FX-40", "tr:whip-right", "tr:flash"],
    captions: "cap:word-pop",
    grade: "grade:punchy",
    looks: ["ui", "clean", "editorial"],
    faceNeverCovered: true,
    maxCutawayShare: 0.25,
    sound: "all",
    interrupts: ["move:punch-in", "move:word-pop", "FX-05"],
    hooks: ["move:punch-in", "FX-22", "FX-04"],
    ctas: ["FX-35"],
    notes: "Whips on the beat, punch-ins on key words, word-pop captions.",
  },
  "talking-head": {
    id: "talking-head",
    label: "Talking head (clean)",
    intervalS: 2.5, // ASSUMPTION
    maxGapS: 3.0,
    refEventsPer10s: null,
    energy: 2,
    prefer: ["move:punch-in", "FX-19", "FX-24", "FX-22", "FX-35"],
    avoid: ["tr:glitch", "tr:flash", "FX-04"],
    transitions: [],
    captions: "FX-18",
    grade: null,
    looks: ["ui", "clean", "glass"],
    faceNeverCovered: true,
    maxCutawayShare: 0,
    sound: "big",
    interrupts: ["move:punch-in", "FX-24", "move:word-pop"],
    hooks: ["move:punch-in", "FX-22"],
    ctas: ["FX-35"],
    notes: "The face and the argument lead; few, quiet moves.",
  },
};

/** Other names people and saved styles use for a profile. */
const STYLE_ALIASES: Record<string, string> = {
  explainer: "explainer-overlay",
  "explainer-overlay": "explainer-overlay",
  neon: "neon-grid-type",
  "neon-grid": "neon-grid-type",
  "motion-graphic": "neon-grid-type",
  collage: "paper-collage",
  "vox-collage": "paper-collage",
  "effects-library": "effects-library",
  effects: "effects-library",
  "aesthetic-warm": "warm-moody",
  "moody-captions": "warm-moody",
  aesthetic: "warm-moody",
  moody: "warm-moody",
  warm: "warm-moody",
  ugc: "fast-ugc",
  fast: "fast-ugc",
  viral: "fast-ugc",
  clean: "talking-head",
};

/** A profile by id, alias or apply_style id ("restorff/style/fast-ugc"); else by piece type. */
export function resolveStyle(style: string | undefined, piece: PieceType | undefined): { profile: StyleProfile; matched: string } {
  const key = (style ?? "").toLowerCase().trim().replace(/^restorff\/style\//, "").replace(/[\s_]+/g, "-");
  if (key && STYLE_PROFILES[key]) return { profile: STYLE_PROFILES[key], matched: key };
  if (key && STYLE_ALIASES[key]) return { profile: STYLE_PROFILES[STYLE_ALIASES[key]], matched: `${key} → ${STYLE_ALIASES[key]}` };
  const byPiece: Record<PieceType, string> = { ad: "ad", reel: "fast-ugc", explainer: "explainer-overlay", "brand-film": "warm-moody", "motion-graphic": "neon-grid-type" };
  const id = byPiece[piece ?? "ad"] ?? "ad";
  return { profile: STYLE_PROFILES[id], matched: key ? `unknown style "${style}" → ${id} (piece ${piece ?? "ad"})` : `piece ${piece ?? "ad"} → ${id}` };
}

// ─── beat classification ─────────────────────────────────────────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000, half: 0.5, double: 2, twice: 2, triple: 3,
};
const NUMBER_WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "i");

const RE = {
  list: /\b(\d+|two|three|four|five|six|seven|ten)\s+(things|steps|ways|reasons|tips|tricks|secrets|mistakes|rules|effects|ingredients|hacks)\b/i,
  steps: /\b(first(ly)?|second(ly)?|third(ly)?|step\s*\d+|next|then|finally|lastly|after that)\b/i,
  cta: /\b(follow|comment|subscribe|link in (the )?bio|shop now|order|buy|get yours|try (it|halcyon)|download|sign up|tap|click|dm me|save this|share this|grab (one|yours))\b/i,
  comparison: /\b(vs\.?|versus|instead of|rather than|unlike|compared (to|with)|before and after|old way|new way|than)\b/i,
  proof: /\b(reviews?|customers?|people (say|love|said)|rated|stars|sold out|loved by|results?|proven|studies|clinically|award|everyone|thousands|millions|views)\b/i,
  problem: /\b(tired of|sick of|hate|struggle|problem|annoying|wast(e|ing)|never works|can'?t|cannot|mistake|wrong|bad|bitter|expensive)\b/i,
  reveal: /\b(here'?s (the|how|why|what)|the secret|turns out|actually|the answer|the result|introducing|meet|guess what|that'?s why|this is)\b/i,
  explain: /\b(how|because|works?|means|so that|which is|why|the reason|made (from|with|by))\b/i,
  story: /\b(i was|when i|we were|years ago|back in|one day|started|used to|in \d{4})\b/i,
  quote: /["“”]/,
};

export interface BeatFacts {
  type: BeatType;
  why: string;
  /** Numbers in the line, as values, and as written. */
  numbers: Array<{ value: number; text: string; index: number }>;
  /** The beat's strongest word (as said, without punctuation) and its word index in the beat. */
  keyword: { text: string; index: number } | null;
  /** List items when the line enumerates (≥ 2). */
  items: string[];
  /** The line in ≤ 5 words. */
  headline: string;
  /** comparison: before / after sides. */
  before?: string;
  after?: string;
  /** Quoted words. */
  quote?: string;
}

const STOP = new Set(
  "a an the and or but so of to in on at for by with from as is are was were be been it its it's this that these those we our you your i my me he she they them his her their not no do does did just very too than then there here what why how when who like really um uh okay ok yeah".split(" "),
);
const FILLER_START = new Set("so and but okay ok now well like just basically honestly".split(" "));
/** Long words that make poor punch words. */
const WEAK = new Set("nothing something everything anything really actually people things thing about would could should there their these those every always never maybe going".split(" "));

export const cleanToken = (text: string) => text.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, "");
export const isContent = (text: string) => {
  const w = cleanToken(text).toLowerCase();
  if (!w) return false;
  if (/\d/.test(w)) return true;
  return w.length >= 4 && !STOP.has(w);
};

/** "40,000" · "$4" · "92%" · "3.5" · "12k" → values; plus number words ("twelve hours"). */
export function numbersIn(words: string[]): Array<{ value: number; text: string; index: number }> {
  const out: Array<{ value: number; text: string; index: number }> = [];
  words.forEach((raw, index) => {
    const w = cleanToken(raw);
    const m = /^\$?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(k|m|%)?$/i.exec(w);
    if (m) {
      let value = Number(m[1].replace(/,/g, ""));
      const suffix = (m[2] ?? "").toLowerCase();
      if (suffix === "k") value *= 1000;
      if (suffix === "m") value *= 1_000_000;
      out.push({ value, text: w, index });
      return;
    }
    const word = w.toLowerCase();
    if (word in NUMBER_WORDS && !(word === "half" && out.length)) out.push({ value: NUMBER_WORDS[word], text: w, index });
  });
  return out;
}

/** ≤ 5 words, filler and trailing punctuation off. */
export function headlineOf(words: string[], max = 5): string {
  // "Then three things happen: we grind…" → the part before the colon is the headline
  const colonAt = words.findIndex((w) => /:$/.test(w.trim()));
  if (colonAt >= 1 && colonAt < 7) words = words.slice(0, colonAt + 1);
  const list = words.map(cleanToken).filter(Boolean);
  while (list.length > 1 && FILLER_START.has(list[0].toLowerCase())) list.shift();
  if (list.length <= max) return list.join(" ");
  // keep the run of `max` words with the most content words (ties: earliest)
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i + max <= list.length; i++) {
    const score = list.slice(i, i + max).filter(isContent).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return list.slice(best, best + max).join(" ");
}

/** Items of an enumeration: split on commas / "and" / "then" after the cue, 1–5 words each. */
export function itemsOf(line: string): string[] {
  // the enumeration starts after a colon ("All you need: ice, a glass, one pour") or after the cue word
  const colon = line.indexOf(":");
  const body =
    colon >= 0 && colon < line.length - 3
      ? line.slice(colon + 1)
      : line.replace(/^.*?\b(things|steps|ways|reasons|tips|need to do|need)\b[:,]?/i, (m) => (m.length < line.length * 0.6 ? "" : m));
  const itemWord = (w: string) => /\d/.test(w) || (w.length >= 3 && !STOP.has(w.toLowerCase()));
  const parts = body
    .split(/,(?!\d{3}\b)|;|:|\band then\b|\bthen\b|\band\b|\bplus\b/i)
    .map((part) => part.replace(/^\s*(first(ly)?|second(ly)?|third(ly)?|next|finally|lastly|step \d+)\s*/i, "").trim())
    .map((part) => part.split(/\s+/).map(cleanToken).filter(Boolean))
    .filter((ws) => ws.length >= 1 && ws.length <= 6 && ws.some(itemWord))
    .map((ws) => ws.slice(0, 5).join(" "));
  return parts.length >= 2 ? parts.slice(0, 6) : [];
}

function keywordOf(words: string[], numbers: BeatFacts["numbers"]): BeatFacts["keyword"] {
  if (numbers.length) return { text: numbers[0].text, index: numbers[0].index };
  // a word written in caps (the transcript keeps "FREE"), else a capitalised word that does not start the line
  for (let i = 0; i < words.length; i++) {
    const w = cleanToken(words[i]);
    if (w.length >= 2 && w === w.toUpperCase() && /\p{L}/u.test(w) && w !== "I") return { text: w, index: i };
  }
  for (let i = 1; i < words.length; i++) {
    const w = cleanToken(words[i]);
    if (/^\p{Lu}\p{Ll}+/u.test(w) && !STOP.has(w.toLowerCase())) return { text: w, index: i };
  }
  let best: BeatFacts["keyword"] = null;
  words.forEach((raw, index) => {
    const w = cleanToken(raw);
    if (!isContent(w) || WEAK.has(w.toLowerCase())) return;
    if (!best || w.length > best.text.length) best = { text: w, index };
  });
  return best;
}

function comparisonSides(line: string): { before?: string; after?: string } {
  const clean = (s: string) => s.split(/\s+/).map(cleanToken).filter(Boolean).slice(0, 4).join(" ");
  let m = /\b(?:not|no more)\s+(.+?)[,:;.]\s*(?:but\s+)?(.+)$/i.exec(line);
  if (m) return { before: clean(m[1]), after: clean(m[2]) };
  m = /(.+?)\binstead of\b(.+)$/i.exec(line);
  if (m) return { before: clean(m[2]), after: clean(m[1]) };
  m = /(.+?)\b(?:vs\.?|versus)\b(.+)$/i.exec(line);
  if (m) return { before: clean(m[1]), after: clean(m[2]) };
  return {};
}

/** Classify one beat. `position`: 0..1 through the piece; `first` / `last` beat flags; `product` words. */
export function classifyBeat(words: string[], o: { first: boolean; last: boolean; position: number; product?: string[] }): BeatFacts {
  const line = words.join(" ");
  const numbers = numbersIn(words);
  const lower = line.toLowerCase();
  const product = (o.product ?? []).map((p) => p.toLowerCase()).filter((p) => p.length >= 3);
  const items = itemsOf(line);
  const sides = comparisonSides(line);
  const quote = RE.quote.test(line) ? (/["“](.+?)["”]/.exec(line)?.[1] ?? undefined) : undefined;
  const facts = (type: BeatType, why: string): BeatFacts => ({
    type,
    why,
    numbers,
    keyword: keywordOf(words, numbers),
    items,
    headline: headlineOf(words),
    ...(sides.before ? sides : {}),
    ...(quote ? { quote } : {}),
  });
  if (o.first) return facts("hook", "the opening line");
  if (RE.cta.test(line) && (o.last || o.position >= 0.75)) return facts("cta", `asks for an action ("${RE.cta.exec(line)?.[0]}") near the end`);
  if (o.last) return facts("cta", "the last beat carries the ask");
  if (RE.list.test(line)) return facts("list", `announces a list ("${RE.list.exec(line)?.[0]}")`);
  if (items.length >= 3) return facts("list", `enumerates ${items.length} items`);
  if (RE.steps.test(line)) return facts("steps", `a step cue ("${RE.steps.exec(line)?.[0]}")`);
  if (numbers.some((n) => /\d/.test(n.text)) || (numbers.length && NUMBER_WORD_RE.test(line) && /\b(percent|hours?|minutes?|days?|cups?|cans?|times|x|dollars?|people|customers|views)\b/i.test(line))) {
    return facts("number", `a number ("${numbers[0].text}")`);
  }
  if ((sides.before && sides.after) || /\b(vs\.?|versus|instead of|rather than|unlike|compared (to|with)|before and after|old way|new way)\b/i.test(line)) {
    return facts("comparison", sides.before ? `old vs new ("${sides.before}" → "${sides.after}")` : `compares ("${RE.comparison.exec(line)?.[0]}")`);
  }
  if (RE.proof.test(line)) return facts("proof", `social proof ("${RE.proof.exec(line)?.[0]}")`);
  if (product.some((p) => lower.includes(p))) return facts("product", "names the product");
  if (quote) return facts("quote", "quotes someone");
  if (RE.reveal.test(line) && o.position >= 0.4) return facts("reveal", `a payoff ("${RE.reveal.exec(line)?.[0]}")`);
  if (RE.problem.test(line)) return facts("problem", `names a pain ("${RE.problem.exec(line)?.[0]}")`);
  if (RE.reveal.test(line)) return facts("reveal", `a turn ("${RE.reveal.exec(line)?.[0]}")`);
  if (RE.story.test(line)) return facts("story", `a story beat ("${RE.story.exec(line)?.[0]}")`);
  if (RE.explain.test(line)) return facts("explain", `explains ("${RE.explain.exec(line)?.[0]}")`);
  if (words.filter(isContent).length <= 1) return facts("bridge", "a connective line");
  return facts("claim", "a statement");
}

/** What a beat type wants from a technique: purpose → weight. */
export const BEAT_WANTS: Record<BeatType, Partial<Record<Purpose, number>>> = {
  hook: { hook: 3, "pattern-interrupt": 1.5, emphasis: 1.5 },
  problem: { emphasis: 2, "pattern-interrupt": 1.5, comparison: 1 },
  claim: { emphasis: 2, "pattern-interrupt": 1.5, "b-roll-replace": 1 },
  number: { "number-data": 3, emphasis: 1.5, "proof-social": 1 },
  list: { "list-steps": 3, "explain-concept": 1 },
  steps: { "list-steps": 3, "explain-concept": 1.5 },
  proof: { "proof-social": 3, "number-data": 1, emphasis: 1 },
  product: { "product-showcase": 3, "b-roll-replace": 1.5, emphasis: 1 },
  comparison: { comparison: 3, emphasis: 1 },
  explain: { "explain-concept": 3, "b-roll-replace": 1.5, "list-steps": 0.5 },
  story: { "b-roll-replace": 2, mood: 2, "pattern-interrupt": 1 },
  reveal: { emphasis: 2.5, "pattern-interrupt": 2, hook: 1 },
  quote: { "proof-social": 2, emphasis: 2 },
  cta: { cta: 4 },
  bridge: { "pattern-interrupt": 2, transition: 1.5 },
};

/** Beat types that always get their own technique (others only when the rhythm asks). */
export const STRONG_BEATS = new Set<BeatType>(["hook", "number", "list", "steps", "proof", "product", "comparison", "reveal", "cta"]);

/** Target energy at `position` (0..1) for a style's base energy: hook high, a dip, then rising to the payoff, CTA settles. */
export function energyAt(base: number, position: number, type: BeatType): number {
  const clamp = (v: number) => Math.max(1, Math.min(5, v));
  if (type === "hook") return clamp(base + 1);
  if (type === "cta") return clamp(base);
  return clamp(base - 0.6 + 1.6 * Math.min(1, position / 0.9));
}

/** Canvas size → aspect name. */
export function aspectOf(width: number, height: number): Aspect {
  const r = width / Math.max(1, height);
  if (r < 0.65) return "9:16";
  if (r < 0.9) return "4:5";
  if (r < 1.3) return "1:1";
  return "16:9";
}
