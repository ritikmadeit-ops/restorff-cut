// @restorffcut/compositions — the built-in technique records (director agent, 2026-10-24). Schema: ./technique.ts.
//
// Every effect in apps/web/src/compositions/effects-catalogue.ts (FX-01 … FX-62), the package compositions no FX row
// points at (comp:<name>), the transitions (tr:<kind>) and grade looks (grade:<look>) the effects library lists by
// those ids, the caption styles (the captions tool's ids), sound moves (the restorff-core SFX pack in
// apps/web/public/sfx), edit moves and the built-in editing styles (packages/timeline-ops styles.ts).
//
// Grounding (MEASURED unless marked): spikes/s6-reference-reels/FINDINGS.md — speech fills 89–99 % of a reel; captions
// change every 1–5 words; ≥ 1 big-word punch per reel; overlays never cover the face; every reel ends on a CTA; 2–10
// visual beats per 10 s by style. Retention calibration (docs/restorff/worklog/retention.md): the reference reels run
// 4.8–7.4 visual events per 10 s, first change 0.07–0.67 s. Where a record cites a reel it uses REELS.md ids.
// Status (ready / coming) is NOT kept here: the director reads it from the effects library at run time, so a row that
// lands later becomes choosable with no change here. Imports add sidecars instead (TECHNIQUES.md).
import type { BeatType, FillSource, Look, Placement, Purpose, TechniqueApply, TechniqueKind, TechniqueMeta, TechniqueNeed } from "./technique.ts";

type Energy = TechniqueMeta["energy"];

const R = {
  explainer: "DeIGbZypIUb",
  warm: "DeUUFJQu8cw",
  neon: "DeBhOJ6T1Ja",
  named: "Def9pj5TWtA",
  collage: "DePNgrmToh9",
} as const;

interface Spec {
  name: string;
  purpose: Purpose[];
  beats: BeatType[];
  energy: Energy;
  /** [min, ideal, max] seconds. */
  dur?: [number, number, number];
  placement?: Placement;
  needs?: TechniqueNeed[];
  pairs?: string[];
  avoid?: string[];
  spacing?: number;
  captions?: TechniqueMeta["withCaptions"];
  renderS?: number;
  measured?: boolean;
  retention: string;
  example: string;
  apply?: TechniqueApply;
  fill?: Record<string, FillSource>;
  params?: Record<string, number | string | boolean>;
  evidence?: string[];
  aspects?: TechniqueMeta["aspects"];
  notes?: string;
  knowledge?: string[];
}

const DEFAULTS: Record<TechniqueKind, { dur: [number, number, number]; placement: Placement; spacing: number; captions: TechniqueMeta["withCaptions"]; renderS: number }> = {
  effect: { dur: [1, 1.5, 3], placement: "face-safe", spacing: 8, captions: "keep", renderS: 15 },
  transition: { dur: [0.2, 0.3, 0.5], placement: "cut", spacing: 4, captions: "keep", renderS: 0 },
  "caption-style": { dur: [3, 60, 120], placement: "caption-zone", spacing: 120, captions: "keep", renderS: 0 },
  grade: { dur: [3, 60, 120], placement: "clip", spacing: 120, captions: "keep", renderS: 0 },
  sound: { dur: [0.1, 0.5, 2], placement: "audio", spacing: 1, captions: "keep", renderS: 0 },
  "edit-move": { dur: [0.5, 1.5, 3], placement: "clip", spacing: 3, captions: "keep", renderS: 0 },
  style: { dur: [3, 60, 120], placement: "clip", spacing: 120, captions: "keep", renderS: 0 },
};

function rec(id: string, kind: TechniqueKind, s: Spec): TechniqueMeta {
  const d = DEFAULTS[kind];
  const [min, ideal, max] = s.dur ?? d.dur;
  return {
    id,
    kind,
    name: s.name,
    purpose: s.purpose,
    beats: s.beats,
    energy: s.energy,
    duration: { min, max, ideal },
    aspects: s.aspects ?? [],
    placement: s.placement ?? d.placement,
    needs: s.needs ?? (kind === "transition" ? ["two_clips"] : kind === "caption-style" ? ["words"] : []),
    pairsWith: s.pairs ?? [],
    avoidWith: s.avoid ?? [],
    minSpacing: s.spacing ?? d.spacing,
    withCaptions: s.captions ?? d.captions,
    cost: { renderS: s.renderS ?? d.renderS, basis: s.measured ? "measured" : "estimate" },
    retention: s.retention,
    example: s.example,
    apply: s.apply ?? { via: "effects", ref: id },
    ...(s.fill ? { fill: s.fill } : {}),
    ...(s.params ? { params: s.params } : {}),
    ...(s.evidence ? { evidence: s.evidence } : {}),
    ...(s.notes ? { notes: s.notes } : {}),
    ...(s.knowledge ? { knowledge: s.knowledge } : {}),
    source: "builtin",
  };
}

const fx = (id: string, s: Spec) => rec(id, "effect", s);
const PERSON: TechniqueNeed[] = ["person_matte"];
/** Layered person effects render the matte layer 46–57 s per pass (MEASURED, mcp-gaps-mvp worklog: Paper Cut). */
const LAYERED_S = 50;

// ─── the 62 FX rows ──────────────────────────────────────────────────────────────────────────────────────────

const FX_ROWS: TechniqueMeta[] = [
  fx("FX-01", { name: "Orbit", purpose: ["proof-social", "pattern-interrupt"], beats: ["proof", "product", "claim"], energy: 4, dur: [1, 1.5, 2.5], placement: "behind-person", needs: [...PERSON, "list_items"], spacing: 30, renderS: LAYERED_S, pairs: ["sfx:whoosh"], retention: "Cards passing behind the speaker add depth the eye follows, and the face never leaves.", example: "Thousands of people already switched to Halcyon.", fill: { cards: "list-items" }, evidence: [R.named] }),
  fx("FX-02", { name: "Couch Wall", purpose: ["proof-social"], beats: ["proof", "claim"], energy: 3, dur: [1, 1.5, 3], placement: "behind-person", needs: [...PERSON, "list_items"], spacing: 30, renderS: LAYERED_S, retention: "A wall of results building behind the speaker reads as proof at a glance.", example: "Our videos have pulled over two million views.", fill: { tiles: "list-items", word: "keyword" }, evidence: [R.named] }),
  fx("FX-03", { name: "UI World", purpose: ["explain-concept", "b-roll-replace"], beats: ["steps", "explain", "product"], energy: 3, dur: [1.5, 2, 4], placement: "overlay", spacing: 20, captions: "move", retention: "The idea acted out in an app on the top half: the viewer watches it happen instead of hearing it.", example: "Just drop your clips in and type what you want.", fill: { text: "line", title: "headline" }, evidence: [R.named] }),
  fx("FX-04", { name: "Frame Break", purpose: ["pattern-interrupt", "hook"], beats: ["hook", "reveal"], energy: 5, dur: [1, 1.5, 2.5], placement: "behind-person", needs: PERSON, spacing: 40, renderS: LAYERED_S, pairs: ["sfx:hit"], retention: "The speaker breaking out of his own frame is a physical surprise: the strongest single interrupt we have.", example: "Stop scrolling: this changes how you make coffee.", evidence: [R.named] }),
  fx("FX-05", { name: "Digital Zoom", purpose: ["emphasis", "pattern-interrupt"], beats: ["claim", "reveal", "problem", "hook", "number"], energy: 3, dur: [0.8, 1.5, 2.5], placement: "clip", spacing: 3, renderS: 0, pairs: ["sfx:whoosh"], avoid: ["move:punch-in"], retention: "A punch-in on the word re-frames the face: a cut the viewer feels without losing the speaker.", example: "And this is the part nobody tells you.", evidence: [R.named], notes: "Optional smear and chroma split; keep it under ~1.35x so dense layouts are not cropped (retention worklog: a 1.15 punch crops 7.5 % per side)." }),
  fx("FX-06", { name: "Phone Mockup", purpose: ["product-showcase", "explain-concept"], beats: ["product", "steps"], energy: 3, dur: [1.5, 2, 4], placement: "face-safe", spacing: 20, captions: "move", retention: "A phone beside the head shows the product doing the job while the speaker keeps talking.", example: "Open the app and reorder in one tap.", fill: { request: "line", answer: "headline", appName: "product-name" }, evidence: [R.named] }),
  fx("FX-07", { name: "Checklist", purpose: ["list-steps"], beats: ["list", "steps"], energy: 3, dur: [2, 3, 4], placement: "face-safe", needs: ["list_items"], spacing: 15, captions: "move", pairs: ["sfx:tick"], retention: "Rows that tick as they are said give the viewer a progress bar to finish.", example: "All you need to do: drop your clips, trigger the skill, post.", fill: { items: "list-items", title: "headline" }, evidence: [R.named, R.explainer] }),
  fx("FX-08", { name: "Headline Wall", purpose: ["proof-social"], beats: ["proof", "claim"], energy: 4, dur: [1, 1.5, 3], placement: "behind-person", needs: [...PERSON, "list_items"], spacing: 30, renderS: LAYERED_S, retention: "Press and posts pinning up behind the speaker turn a claim into something other people said.", example: "Everyone is talking about cold brew at home.", fill: { headlines: "list-items" }, evidence: [R.named] }),
  rec("FX-09", "transition", { name: "Zoom Through Cut", purpose: ["transition", "pattern-interrupt"], beats: ["bridge", "reveal", "hook"], energy: 4, dur: [0.3, 0.35, 0.4], needs: ["two_clips"], spacing: 10, pairs: ["sfx:whoosh-hit", "comp:zoom-through-title"], retention: "The camera rushes through one shot into the next: momentum carried across the cut.", example: "Now watch what happens next.", evidence: [R.named], notes: "Keep it at or under 0.35 s (EFFECTS.md FX-09)." }),
  fx("FX-10", { name: "Chart Grow", purpose: ["number-data", "proof-social"], beats: ["number", "proof", "comparison"], energy: 3, dur: [1.5, 2.5, 4], placement: "face-safe", needs: ["numbers"], spacing: 12, captions: "move", pairs: ["sfx:riser"], retention: "A bar that grows makes a number feel earned instead of claimed.", example: "Sales went from 2,000 to 40,000 cans in six months.", fill: { bars: "numbers", title: "headline" }, evidence: [R.named] }),
  fx("FX-11", { name: "Pullback Reveal", purpose: ["explain-concept", "pattern-interrupt"], beats: ["steps", "reveal", "explain"], energy: 4, dur: [1.5, 2, 4.5], placement: "full-frame", spacing: 30, pairs: ["sfx:whoosh"], retention: "Pulling back to reveal the shot is inside an app answers 'how' in one move; the clip keeps playing in the window.", example: "Here's what's happening behind the scenes.", fill: { steps: "list-items", title: "headline" }, evidence: [R.named] }),
  fx("FX-12", { name: "Green Screen", purpose: ["mood", "pattern-interrupt"], beats: ["story", "explain", "reveal"], energy: 3, dur: [1, 2, 4], placement: "behind-person", needs: PERSON, spacing: 30, renderS: LAYERED_S, retention: "A new world behind the speaker changes the whole frame while the face stays: a scene change with no cut.", example: "Imagine your mornings without the queue.", fill: { headline: "headline" }, evidence: [R.named] }),
  fx("FX-13", { name: "Paper Cut", purpose: ["pattern-interrupt", "emphasis"], beats: ["reveal", "hook", "number"], energy: 4, dur: [1, 1.5, 3], placement: "behind-person", needs: PERSON, spacing: 30, renderS: LAYERED_S, measured: true, pairs: ["sfx:paper"], retention: "The speaker turning into a paper cut-out is a texture switch the eye cannot ignore.", example: "One hundred percent made by hand.", fill: { text: "keyword" }, evidence: [R.named] }),
  fx("FX-14", { name: "Doodle Boil", purpose: ["mood", "emphasis"], beats: ["story", "claim", "reveal"], energy: 3, dur: [1, 2, 4], placement: "overlay", needs: PERSON, spacing: 30, renderS: LAYERED_S, measured: true, pairs: ["sfx:marker"], retention: "Hand-drawn lines that boil every two frames keep the frame alive on a still talking head.", example: "This is the fun part.", fill: { word: "keyword" }, evidence: [R.named] }),
  fx("FX-15", { name: "Vertigo", purpose: ["hook", "mood"], beats: ["hook", "reveal", "story"], energy: 4, dur: [1, 1.2, 1.6], placement: "behind-person", needs: PERSON, spacing: 40, renderS: LAYERED_S, pairs: ["sfx:riser"], avoid: ["shader:restorff-vertigo"], retention: "A dolly-zoom makes the room move while the speaker does not: unease that makes people watch the next line.", example: "And then everything changed.", evidence: [R.named] }),
  fx("FX-16", { name: "Cover Story", purpose: ["hook", "emphasis", "product-showcase"], beats: ["hook", "product", "reveal"], energy: 4, dur: [1.5, 2, 4], placement: "behind-person", needs: PERSON, spacing: 40, renderS: LAYERED_S, retention: "A magazine masthead building behind the head frames the speaker as the story.", example: "Halcyon is the cold brew everyone is copying.", fill: { wordmark: "keyword", coverlines: "list-items" }, evidence: [R.named, R.warm] }),
  fx("FX-17", { name: "Glass Type", purpose: ["emphasis", "mood"], beats: ["claim", "product", "reveal"], energy: 3, dur: [1, 1.5, 3], placement: "behind-person", spacing: 30, renderS: 25, retention: "Refracting glass letters are a premium look that rewards a second look.", example: "Pure design, nothing else.", fill: { word: "keyword" }, evidence: [R.named] }),
  rec("FX-18", "caption-style", { name: "Word-chunk captions (clean)", purpose: ["mood"], beats: ["claim", "explain", "story", "bridge"], energy: 2, apply: { via: "captions", style: "bold-white" }, retention: "Small clean captions above the head, 1–5 words per chunk: the viewer reads along without the face being covered.", example: "Captions on every word, nothing fancy.", evidence: [R.explainer] }),
  fx("FX-19", { name: "Emphasis line with drawn underline", purpose: ["emphasis"], beats: ["claim", "reveal", "problem"], energy: 3, dur: [1.2, 1.8, 3], placement: "lower-third", needs: ["words"], spacing: 10, captions: "move", pairs: ["sfx:marker"], retention: "The punchline gets its own big line, word by word, underlined: the viewer reads it twice.", example: "Not editing anything.", fill: { words: "words" }, evidence: [R.explainer] }),
  rec("FX-20", "caption-style", { name: "Karaoke boxed captions", purpose: ["mood", "emphasis"], beats: ["claim", "story", "explain", "product"], energy: 2, apply: { via: "captions", style: "serif-box" }, retention: "Unspoken words tinted, spoken words lit: the eye is pulled forward word by word.", example: "Make it more aesthetic.", evidence: [R.warm] }),
  fx("FX-21", { name: "Mixed-type caption stack", purpose: ["emphasis"], beats: ["claim", "reveal", "hook"], energy: 4, dur: [1.5, 2.5, 3.5], placement: "face-safe", needs: ["words"], spacing: 15, captions: "hide", retention: "Heavy caps, italic serif and boxed small caps in one stack make one line feel designed, not subtitled.", example: "Bigger captions. That's just one more sentence.", fill: { blocks: "words" }, evidence: [R.warm] }),
  fx("FX-22", { name: "Big-word punch", purpose: ["emphasis", "hook", "number-data"], beats: ["hook", "number", "reveal", "claim", "cta"], energy: 4, dur: [0.8, 1.2, 1.6], placement: "face-safe", needs: ["words"], spacing: 8, captions: "hide", pairs: ["sfx:hit"], retention: "One huge word on the beat is the line the viewer remembers; every reference reel has at least one.", example: "And it's completely FREE.", fill: { word: "keyword" }, evidence: [R.explainer, R.named, R.neon] }),
  fx("FX-23", { name: "Ignite-then-cool kinetic type", purpose: ["emphasis", "hook", "mood"], beats: ["hook", "claim", "reveal"], energy: 4, dur: [1.2, 2, 3], placement: "face-safe", needs: ["words"], spacing: 10, captions: "hide", pairs: ["sfx:hit"], retention: "Words that flare orange and cool to white give each word its own moment of light.", example: "This is Halcyon Nitro.", fill: { text: "headline" }, evidence: [R.neon] }),
  fx("FX-24", { name: "Type-on title", purpose: ["list-steps", "pattern-interrupt"], beats: ["steps", "list", "bridge", "explain"], energy: 2, dur: [1, 1.8, 2.5], placement: "overlay", spacing: 4, pairs: ["sfx:typing"], retention: "A section title typing on every ~2 s tells the viewer where they are and that more is coming (22 titles in 49.5 s in the explainer reel).", example: "Step two: brew it cold.", fill: { title: "headline" }, evidence: [R.explainer] }),
  fx("FX-25", { name: "Strike-through", purpose: ["comparison", "emphasis"], beats: ["comparison", "problem", "reveal"], energy: 3, dur: [1, 1.5, 3], placement: "face-safe", spacing: 12, captions: "move", pairs: ["sfx:marker"], retention: "Crossing out the old way and writing the new one is a before/after in one second.", example: "Not hot coffee poured over ice: cold brew.", fill: { text: "before", correction: "after" }, evidence: [R.warm, R.neon] }),
  fx("FX-26", { name: "Rubber stamp", purpose: ["emphasis", "proof-social"], beats: ["reveal", "proof", "claim", "problem"], energy: 5, dur: [0.8, 1.2, 2], placement: "face-safe", spacing: 12, pairs: ["sfx:stamp"], retention: "A stamp slam is a verdict: loud, physical, final.", example: "No sugar. Approved.", fill: { text: "keyword" }, evidence: [R.warm, R.neon, R.collage] }),
  fx("FX-27", { name: "UI card pop-in", purpose: ["proof-social", "product-showcase", "b-roll-replace"], beats: ["proof", "product", "explain"], energy: 3, dur: [1, 1.5, 3], placement: "face-safe", needs: ["images"], spacing: 6, pairs: ["sfx:pop"], retention: "A screenshot card that lands with a pop shows the thing being talked about, above the head.", example: "Here's the review that made us cry.", fill: { image: "images", caption: "headline" }, evidence: [R.explainer] }),
  fx("FX-28", { name: "Badge pills", purpose: ["list-steps", "proof-social"], beats: ["list", "proof", "claim"], energy: 2, dur: [1, 2, 3.5], placement: "face-safe", needs: ["list_items"], spacing: 8, pairs: ["sfx:pop"], retention: "Short facts as pills, one per beat, are read in a glance and add up to a claim.", example: "It's organic, fair trade and ready in ten seconds.", fill: { pills: "list-items" }, evidence: [R.explainer] }),
  fx("FX-29", { name: "Glass panel overlay grammar", purpose: ["explain-concept"], beats: ["explain", "steps", "bridge"], energy: 2, dur: [1.5, 2, 3], placement: "overlay", spacing: 4, retention: "One frosted panel with one moving part per beat keeps the explanation visual every ~2 s.", example: "Claude builds the edit for you.", fill: { titles: "headline" }, evidence: [R.explainer] }),
  fx("FX-30", { name: "Typed prompt box / chat", purpose: ["explain-concept", "product-showcase"], beats: ["steps", "explain", "product"], energy: 3, dur: [1.5, 2.5, 4], placement: "face-safe", needs: ["words"], spacing: 10, captions: "move", pairs: ["sfx:typing"], retention: "Watching text type and a request go SENT → DONE is a tiny story with an ending.", example: "Then you just type: make it more aesthetic.", fill: { text: "line" }, evidence: [R.explainer, R.warm, R.neon] }),
  fx("FX-31", { name: "Chips that tick", purpose: ["list-steps"], beats: ["list", "steps"], energy: 3, dur: [2, 3, 4], placement: "face-safe", needs: ["list_items"], spacing: 15, captions: "move", pairs: ["sfx:tick"], avoid: ["FX-07"], retention: "Each chip ticking as it is said closes a small loop the viewer wants closed.", example: "Captions on every word, cut it to thirty seconds, done.", fill: { items: "list-items" }, evidence: [R.explainer] }),
  fx("FX-32", { name: "Counter / flip-clock", purpose: ["number-data"], beats: ["number", "proof"], energy: 4, dur: [1.2, 2, 3], placement: "face-safe", needs: ["numbers"], spacing: 10, captions: "move", pairs: ["sfx:tick"], retention: "A count running to the real figure holds the eye until it lands.", example: "We cut it from three minutes to forty-nine seconds.", fill: { to: "number", label: "number-label" }, evidence: [R.explainer, R.warm, R.named] }),
  fx("FX-33", { name: "Waveform with collapsing gaps", purpose: ["explain-concept", "number-data"], beats: ["explain", "steps"], energy: 3, dur: [1, 1.5, 2], placement: "overlay", needs: ["cut_list"], spacing: 30, retention: "Dead space collapsing into one block shows an edit happening.", example: "It cuts out all the dead space.", evidence: [R.explainer] }),
  fx("FX-34", { name: "Filmstrip + flash + scan", purpose: ["explain-concept", "proof-social"], beats: ["explain", "proof"], energy: 3, dur: [1.5, 2.5, 5], placement: "overlay", needs: ["self_check"], spacing: 30, pairs: ["sfx:camera"], retention: "Frames flashing and a counter running read as thoroughness.", example: "It checks every single frame before it renders.", evidence: [R.explainer] }),
  fx("FX-35", { name: "Social CTA overlays", purpose: ["cta"], beats: ["cta"], energy: 3, dur: [2.5, 3.5, 4.5], placement: "face-safe", spacing: 60, captions: "move", pairs: ["sfx:pop", "sfx:ding"], retention: "Every reference reel ends on a comment-to-DM ask; a typed keyword and a Follow flip make the ask an action.", example: "Comment HALCYON and I'll send you the recipe.", fill: { keyword: "cta-keyword", prompt: "cta-text" }, evidence: [R.explainer, R.warm, R.neon, R.named, R.collage] }),
  fx("FX-36", { name: "Before/after wipe", purpose: ["comparison", "proof-social"], beats: ["comparison", "proof", "reveal"], energy: 3, dur: [1.2, 2, 3], placement: "full-frame", needs: ["two_renders"], spacing: 20, pairs: ["sfx:whoosh"], retention: "A divider sweeping across shows the change instead of describing it.", example: "Here's before, and here's after.", fill: { before: "before", after: "after" }, evidence: [R.warm] }),
  rec("FX-37", "grade", { name: "Grade by wipe", purpose: ["mood", "comparison"], beats: ["comparison", "reveal"], energy: 2, retention: "A grade sweeping on mid-shot makes the mood change visible as an event.", example: "Make it moody.", evidence: [R.warm] }),
  rec("FX-38", "grade", { name: "Warm grade", purpose: ["mood"], beats: ["story", "product", "claim"], energy: 1, retention: "Golden light and lifted blacks read as aesthetic, calm and premium for the whole piece.", example: "Make it more aesthetic.", evidence: [R.warm] }),
  rec("FX-39", "grade", { name: "Moody grade", purpose: ["mood"], beats: ["story", "problem", "reveal"], energy: 2, retention: "Darker, cooler, practical lights kept warm: tension without a word.", example: "Make it moody.", evidence: [R.warm] }),
  rec("FX-40", "transition", { name: "Whip / blur transition", purpose: ["transition", "pattern-interrupt"], beats: ["bridge", "hook", "reveal", "story"], energy: 4, dur: [0.15, 0.25, 0.35], needs: ["two_clips"], spacing: 4, pairs: ["sfx:whoosh"], retention: "A 0.2 s blur carries the eye across a set-up change instead of a jolt (whips at 7.7, 15.1, 22.3 s in the warm reel).", example: "Okay, next location.", evidence: [R.warm, R.collage, R.neon] }),
  rec("FX-41", "transition", { name: "Zoom-blur exit", purpose: ["transition"], beats: ["bridge", "reveal"], energy: 4, dur: [0.2, 0.3, 0.4], spacing: 8, retention: "A one-sided zoom blur ends a scene with speed.", example: "And that's the first part.", evidence: [R.neon] }),
  fx("FX-42", { name: "Floating thumbnails", purpose: ["proof-social"], beats: ["proof", "claim"], energy: 3, dur: [1.2, 1.8, 3.5], placement: "face-safe", needs: ["list_items"], spacing: 15, pairs: ["sfx:pop"], retention: "Cards popping above the head and drifting up show 'many' without a number.", example: "My best videos float in.", fill: { cards: "list-items", images: "images" }, evidence: [R.warm] }),
  fx("FX-43", { name: "Text behind subject", purpose: ["emphasis", "hook"], beats: ["hook", "reveal", "claim"], energy: 4, dur: [1, 1.5, 3], placement: "behind-person", needs: PERSON, spacing: 15, captions: "hide", renderS: LAYERED_S, retention: "A giant word behind the head is type with depth: the face stays in front.", example: "NEVER open an editing app again.", fill: { text: "keyword" }, evidence: [R.warm] }),
  fx("FX-44", { name: "Collage grid", purpose: ["proof-social"], beats: ["proof"], energy: 4, dur: [1, 1.5, 3], placement: "full-frame", needs: ["images", "clip"], spacing: 30, retention: "Nine covers flying into a grid around the live shot say 'everyone is doing this'.", example: "Lots of people are doing this.", evidence: [R.warm] }),
  fx("FX-45", { name: "Recursive picture-in-picture", purpose: ["pattern-interrupt"], beats: ["reveal", "explain"], energy: 4, dur: [1, 1.5, 2.5], placement: "full-frame", spacing: 40, retention: "Frames inside frames are a puzzle the eye resolves.", example: "What you're seeing now was made by it.", evidence: [R.warm] }),
  fx("FX-46", { name: "Storyboard document", purpose: ["explain-concept"], beats: ["explain"], energy: 2, dur: [2, 3, 4], placement: "overlay", spacing: 60, apply: { via: "manual", why: "As a feature it is the storyboard view (storyboard tool), not an overlay." }, retention: "Showing the plan proves there is one.", example: "Before rendering, it gives me a storyboard.", evidence: [R.warm] }),
  fx("FX-47", { name: "Comment thread card", purpose: ["proof-social"], beats: ["proof"], energy: 2, dur: [2, 2.5, 3], placement: "overlay", spacing: 60, apply: { via: "manual", why: "As a feature it is review comments, not an overlay." }, retention: "A conversation on screen is social proof in motion.", example: "I asked it to change the caption.", evidence: [R.warm] }),
  fx("FX-48", { name: "Kinetic type on a 3D grid", purpose: ["hook", "explain-concept", "b-roll-replace"], beats: ["hook", "explain", "claim"], energy: 4, dur: [2, 3, 5], placement: "full-frame", spacing: 15, captions: "hide", renderS: 25, retention: "A camera gliding over a lit grid makes words feel like a place.", example: "What if I told you this was all code?", fill: { lines: "headline", prompt: "line" }, evidence: [R.neon] }),
  fx("FX-49", { name: "Flowchart with travelling spark", purpose: ["explain-concept", "list-steps"], beats: ["explain", "steps"], energy: 3, dur: [2, 3, 4], placement: "face-safe", needs: ["list_items"], spacing: 20, retention: "A spark travelling node to node shows a process moving.", example: "Beans, then cold water, then twelve hours.", fill: { nodes: "list-items" }, evidence: [R.neon] }),
  fx("FX-50", { name: "Easing-curve explainer", purpose: ["explain-concept", "number-data"], beats: ["explain", "number"], energy: 3, dur: [3, 4, 6], placement: "full-frame", spacing: 30, captions: "hide", retention: "A dot riding a curve makes 'slow then fast' visible.", example: "It starts slow, then it climbs fast.", fill: { title: "headline" }, evidence: [R.neon] }),
  fx("FX-51", { name: "Paper form look", purpose: ["comparison", "pattern-interrupt"], beats: ["comparison", "problem"], energy: 3, dur: [3, 4, 6], placement: "full-frame", needs: ["list_items"], spacing: 30, captions: "hide", pairs: ["sfx:marker", "sfx:stamp"], retention: "A look switch to paper mid-piece resets attention; the red strike says which way wins.", example: "The old way: grind, boil, wait, burn. The new way: one jar.", fill: { form: "headline", rows: "list-items" }, evidence: [R.neon] }),
  fx("FX-52", { name: "Paper cut-out with red outline", purpose: ["product-showcase", "b-roll-replace"], beats: ["product", "story", "explain"], energy: 3, dur: [1.5, 2.5, 4], placement: "full-frame", needs: ["images"], spacing: 8, pairs: ["sfx:paper"], retention: "Cut-out objects sliding in with parallax make a still photo move.", example: "It all started with one bottle.", fill: { pieces: "images" }, evidence: [R.collage] }),
  fx("FX-53", { name: "Old-paper and map backgrounds", purpose: ["mood"], beats: ["story", "explain"], energy: 1, dur: [2, 4, 8], placement: "full-frame", spacing: 30, retention: "A paper texture says 'story' before a word is read.", example: "Back in 1952…", evidence: [R.collage] }),
  fx("FX-54", { name: "Map with route and city pins", purpose: ["explain-concept", "b-roll-replace"], beats: ["story", "explain"], energy: 3, dur: [2, 3, 4.5], placement: "full-frame", needs: ["places"], spacing: 20, pairs: ["sfx:marker"], retention: "A route drawing between pins turns geography into motion.", example: "From Bengaluru to Rotterdam in one box.", fill: { places: "places", title: "headline" }, evidence: [R.collage] }),
  fx("FX-55", { name: "Retro TV frame", purpose: ["b-roll-replace", "pattern-interrupt"], beats: ["story", "proof"], energy: 3, dur: [2, 3, 4], placement: "full-frame", needs: ["clip"], spacing: 30, retention: "Footage inside a wooden TV reads as archive: a change of era in one frame.", example: "This is how they used to do it.", fill: { label: "headline" }, evidence: [R.collage] }),
  fx("FX-56", { name: "Halftone portrait push-in", purpose: ["hook", "mood", "pattern-interrupt"], beats: ["hook", "story", "reveal"], energy: 4, dur: [2, 3, 4], placement: "full-frame", needs: ["images"], spacing: 30, retention: "A slow push into a halftone eye that becomes a record is a match cut people rewind.", example: "Without animating a single frame.", fill: { image: "images", label: "keyword" }, evidence: [R.collage] }),
  fx("FX-57", { name: "Triptych panels", purpose: ["comparison", "list-steps"], beats: ["comparison", "list"], energy: 3, dur: [2.5, 3.5, 4.5], placement: "full-frame", needs: ["list_items"], spacing: 30, pairs: ["sfx:paper"], retention: "Three panels sliding in give three ideas one screen.", example: "1952, 850 and the 1650s.", fill: { panels: "list-items" }, evidence: [R.collage] }),
  fx("FX-58", { name: "Thread timeline with pinned cards", purpose: ["list-steps", "explain-concept"], beats: ["steps", "story", "list"], energy: 3, dur: [2.5, 3.5, 4.5], placement: "full-frame", needs: ["list_items"], spacing: 30, retention: "Cards pinned along a red thread make history a sequence the viewer follows.", example: "First the goat, then the moka pot, then the cup.", fill: { items: "list-items" }, evidence: [R.collage] }),
  fx("FX-59", { name: "Label tags", purpose: ["emphasis"], beats: ["story", "explain"], energy: 2, dur: [1, 1.5, 3], placement: "overlay", spacing: 6, apply: { via: "manual", why: "No stand-alone tag preset yet: tags live inside Map route and Paper cut." }, retention: "A yellow tag names what is on screen so the viewer never wonders.", example: "The same box.", evidence: [R.collage] }),
  fx("FX-60", { name: "Letter tiles and cracking sign", purpose: ["emphasis", "pattern-interrupt"], beats: ["reveal", "claim"], energy: 4, dur: [1, 1.5, 3], placement: "behind-person", needs: PERSON, spacing: 30, renderS: LAYERED_S, retention: "Ransom-note tiles stamping in spell the word with texture.", example: "It's all about TASTE.", fill: { text: "keyword" }, evidence: [R.collage] }),
  fx("FX-61", { name: "Side-scrolling parallax strip", purpose: ["b-roll-replace", "mood"], beats: ["story", "product", "bridge"], energy: 3, dur: [2, 3, 4], placement: "full-frame", spacing: 30, retention: "Five layers scrolling at five speeds is depth from flat paper.", example: "Inside a real video editor.", fill: { hero: "product-image", caption: "headline" }, evidence: [R.collage] }),
  fx("FX-62", { name: "Split-screen hook", purpose: ["hook", "comparison"], beats: ["hook", "comparison"], energy: 4, dur: [2, 3, 4.5], placement: "full-frame", needs: ["clip"], spacing: 60, retention: "Two things on screen from frame 0 asks the viewer to compare them.", example: "Vox-style collage animations, inside a real editor.", evidence: [R.collage] }),
];

// ─── package compositions no FX row points at ────────────────────────────────────────────────────────────────

const comp = (name: string, s: Spec) => rec(`comp:${name}`, "effect", { ...s, apply: s.apply ?? { via: "effects", ref: `comp:${name}` } });

const COMPOSITIONS: TechniqueMeta[] = [
  comp("magazine-cover", { name: "Magazine cover", purpose: ["hook", "product-showcase"], beats: ["hook", "product", "reveal"], energy: 4, dur: [2, 3, 4.5], placement: "overlay", spacing: 40, captions: "hide", retention: "A full newsstand cover over the shot makes the brand the headline.", example: "Halcyon is this summer's cover story.", fill: { masthead: "brand", coverlines: "list-items" }, evidence: [R.warm] }),
  comp("neon-beats", { name: "Neon one-word beats", purpose: ["emphasis", "pattern-interrupt"], beats: ["reveal", "hook", "claim"], energy: 5, dur: [1, 1.5, 2.5], placement: "full-frame", spacing: 20, captions: "hide", pairs: ["sfx:hit"], retention: "One huge word per beat on solid colour, hard cut each time: the fastest legible rhythm we have.", example: "And this is where it gets crazy.", fill: { beats: "words", words: "words", t0: "beat-start" }, evidence: [R.neon] }),
  comp("neon-code", { name: "Neon code panel", purpose: ["explain-concept"], beats: ["explain", "steps"], energy: 3, dur: [1.5, 2.1, 3], placement: "full-frame", spacing: 20, captions: "hide", pairs: ["sfx:typing"], retention: "Code typing beside a preview shows the mechanism, not a claim about it.", example: "It writes the animation itself as code.", fill: { title: "headline", code: "line", words: "words", t0: "beat-start" }, evidence: [R.neon] }),
  comp("neon-curve", { name: "Neon easing curve", purpose: ["explain-concept", "number-data"], beats: ["explain", "number"], energy: 3, dur: [3, 4.5, 6], placement: "full-frame", spacing: 25, captions: "hide", retention: "The curve draws itself and a dot rides it: rate made visible.", example: "It climbs fast, then eases off.", fill: { title: "headline", words: "words", t0: "beat-start" }, evidence: [R.neon] }),
  comp("neon-flow", { name: "Neon flowchart", purpose: ["explain-concept", "list-steps"], beats: ["steps", "explain", "list"], energy: 3, dur: [2.5, 3.5, 4.75], placement: "full-frame", needs: ["list_items"], spacing: 20, captions: "hide", retention: "Nodes popping as they are said with a spark riding the path: a process you can follow.", example: "Prompt, then code, then render, then video.", fill: { nodes: "list-items", words: "words", t0: "beat-start" }, evidence: [R.neon] }),
  comp("neon-form", { name: "Neon to paper form switch", purpose: ["comparison", "pattern-interrupt"], beats: ["comparison", "problem"], energy: 4, dur: [3, 4.5, 6.1], placement: "full-frame", needs: ["list_items"], spacing: 30, captions: "hide", pairs: ["sfx:stamp"], retention: "A look switch from neon to paper resets attention and the stamp delivers the verdict.", example: "The shortcut versus the real way.", fill: { rows: "list-items", words: "words", t0: "beat-start" }, evidence: [R.neon] }),
  comp("neon-grid-ruler", { name: "Neon grid ruler", purpose: ["number-data", "comparison"], beats: ["number", "comparison"], energy: 4, dur: [3, 4.5, 6.1], placement: "full-frame", needs: ["numbers"], spacing: 25, captions: "hide", retention: "A ruler striking the wrong values and keeping the right one turns a number into a decision.", example: "Not four hours, not eight: eighteen.", fill: { lines: "headline", words: "words", t0: "beat-start" }, evidence: [R.neon] }),
  comp("neon-hook", { name: "Neon hook opener", purpose: ["hook"], beats: ["hook"], energy: 5, dur: [1.5, 2.5, 3.2], placement: "full-frame", spacing: 120, captions: "hide", pairs: ["sfx:riser", "sfx:hit"], retention: "A prompt typing then a big line igniting puts motion and a question on screen from frame 0.", example: "What if I told you this coffee was brewed by code?", fill: { lines: "headline", prompt: "line", words: "words", t0: "beat-start" }, evidence: [R.neon] }),
  comp("neon-outro", { name: "Neon outro / loop", purpose: ["cta"], beats: ["cta"], energy: 3, dur: [3, 5, 8.1], placement: "full-frame", spacing: 120, captions: "hide", retention: "An end title that lands back on the opening shot loops the video: the replay counts as a view.", example: "Pretty insane. Follow for part two.", fill: { lines: "cta-text", words: "words", t0: "beat-start" }, evidence: [R.neon] }),
  comp("toc-list", { name: "Table of contents list", purpose: ["list-steps"], beats: ["list", "steps", "hook"], energy: 2, dur: [6, 12, 30], placement: "overlay", needs: ["list_items"], spacing: 120, retention: "A numbered list with the current item lit is an open loop: the viewer stays to see the last item light up.", example: "Seventeen effects you can make.", fill: { items: "list-items", title: "headline" }, evidence: [R.named] }),
  comp("word-pop", { name: "Word-pop caption overlay", purpose: ["emphasis"], beats: ["hook", "claim"], energy: 4, dur: [1.5, 3, 4], placement: "caption-zone", needs: ["words"], spacing: 20, captions: "hide", retention: "Spoken words popped one by one in the accent: the hook line read in the voice's rhythm.", example: "Wait for it.", fill: { words: "words" }, evidence: [R.named] }),
  comp("zoom-through-title", { name: "Zoom-through title", purpose: ["transition", "hook", "list-steps"], beats: ["bridge", "hook", "steps"], energy: 4, dur: [1.2, 1.8, 2.6], placement: "overlay", spacing: 15, captions: "hide", pairs: ["FX-09", "sfx:whoosh-hit"], retention: "A title rushing out of speed streaks marks a new chapter with momentum.", example: "Part two: the recipe.", fill: { title: "headline" }, evidence: [R.named] }),
];

// ─── transitions (tr:<kind>; whip-left and zoom-in are FX-40 / FX-09) ────────────────────────────────────────

const tr = (kind: string, s: Omit<Spec, "apply">) => rec(`tr:${kind}`, "transition", { ...s, apply: { via: "effects", ref: `tr:${kind}` } });
const WHIP = (dir: string) => tr(`whip-${dir}`, { name: `Whip ${dir}`, purpose: ["transition", "pattern-interrupt"], beats: ["bridge", "hook", "reveal", "story"], energy: 4, dur: [0.15, 0.25, 0.35], spacing: 4, pairs: ["sfx:whoosh"], avoid: ["FX-40"], retention: "A whip in a new direction carries the eye and varies the rhythm.", example: "Next up.", evidence: [R.warm, R.collage] });

const TRANSITIONS: TechniqueMeta[] = [
  tr("dissolve", { name: "Dissolve", purpose: ["transition", "mood"], beats: ["story", "bridge"], energy: 1, dur: [0.3, 0.5, 0.8], spacing: 6, retention: "A soft blend says 'time passes' without a jolt.", example: "Hours later…" }),
  tr("dip-black", { name: "Dip to black", purpose: ["transition", "mood"], beats: ["bridge", "reveal"], energy: 1, dur: [0.4, 0.6, 0.8], spacing: 15, retention: "A dip to black is a chapter break: a breath before the next section.", example: "And that was only the start." }),
  tr("dip-white", { name: "Dip to white", purpose: ["transition", "emphasis"], beats: ["reveal", "bridge"], energy: 2, dur: [0.3, 0.5, 0.7], spacing: 15, retention: "A white dip lifts the frame like a flash of memory.", example: "Then it clicked." }),
  tr("flash", { name: "Flash", purpose: ["pattern-interrupt", "transition"], beats: ["reveal", "hook", "number"], energy: 5, dur: [0.15, 0.25, 0.3], spacing: 8, pairs: ["sfx:hit"], retention: "A white frame on the beat is the loudest cut: use it for the payoff.", example: "Boom: forty thousand cans.", evidence: [R.neon] }),
  WHIP("right"),
  WHIP("up"),
  WHIP("down"),
  ...["left", "right", "up", "down"].map((dir) => tr(`push-${dir}`, { name: `Push ${dir}`, purpose: ["transition", "list-steps"], beats: ["steps", "list", "bridge"], energy: 3, dur: [0.3, 0.4, 0.5], spacing: 4, pairs: ["sfx:whoosh"], retention: "One shot pushing the next off-screen reads as 'next item'.", example: "Second thing." })),
  ...["left", "right", "up", "down"].map((dir) => tr(`slide-${dir}`, { name: `Slide ${dir}`, purpose: ["transition"], beats: ["bridge", "steps"], energy: 2, dur: [0.3, 0.4, 0.5], spacing: 4, pairs: ["sfx:paper"], retention: "A slide is a page turn: calm movement across a cut.", example: "Moving on." })),
  ...["left", "right", "up", "down"].map((dir) => tr(`wipe-${dir}`, { name: `Wipe ${dir}`, purpose: ["transition", "comparison"], beats: ["comparison", "bridge"], energy: 2, dur: [0.4, 0.5, 0.6], spacing: 6, retention: "A hard-edged wipe reveals the new shot like a before/after.", example: "Now compare that with this." })),
  tr("iris", { name: "Iris", purpose: ["transition", "mood"], beats: ["bridge", "story"], energy: 2, dur: [0.5, 0.6, 0.8], spacing: 20, retention: "A closing circle is a retro full stop.", example: "That's all, folks." }),
  tr("glitch", { name: "Glitch", purpose: ["pattern-interrupt", "transition"], beats: ["hook", "reveal", "problem"], energy: 5, dur: [0.2, 0.3, 0.4], spacing: 10, pairs: ["sfx:glitch"], retention: "A digital stutter breaks the flow on purpose: the brain checks what happened.", example: "But something was off." }),
  tr("blur", { name: "Blur", purpose: ["transition", "mood"], beats: ["bridge", "story"], energy: 2, dur: [0.3, 0.5, 0.6], spacing: 6, pairs: ["sfx:whoosh"], retention: "A blur through the cut softens a location change (the warm reel's set-up changes).", example: "Different room, same idea.", evidence: [R.warm] }),
];

// ─── grade looks (grade:<look>; warm-morning and moody are FX-38 / FX-39) ─────────────────────────────────────

const grade = (look: string, s: Omit<Spec, "apply">) => rec(`grade:${look}`, "grade", { ...s, apply: { via: "effects", ref: `grade:${look}` } });
const GRADES: TechniqueMeta[] = [
  grade("clean", { name: "Grade · clean", purpose: ["mood"], beats: ["product", "explain", "claim"], energy: 1, retention: "Neutral, bright and true colour: the product looks like itself.", example: "Keep it clean and simple." }),
  grade("film", { name: "Grade · film", purpose: ["mood"], beats: ["story"], energy: 2, retention: "Film grain and soft contrast make footage feel remembered.", example: "Give it a film look." }),
  grade("cool-night", { name: "Grade · cool night", purpose: ["mood"], beats: ["story", "problem"], energy: 2, retention: "Blue night tones set a late, quiet mood.", example: "Make it feel like night." }),
  grade("punchy", { name: "Grade · punchy", purpose: ["mood"], beats: ["hook", "product", "claim"], energy: 3, retention: "Saturated, contrasty colour reads as energy on a small screen.", example: "Make it pop." }),
  grade("paper", { name: "Grade · paper", purpose: ["mood"], beats: ["story", "explain"], energy: 1, retention: "Warm, matte paper tones tie footage to a collage look.", example: "Match the paper collage." }),
  grade("mono", { name: "Grade · mono", purpose: ["mood"], beats: ["story", "quote"], energy: 2, retention: "Black and white strips the frame to the face and the words.", example: "Black and white for this part." }),
];

// ─── shaders no FX row applies (shader:<type>) ────────────────────────────────────────────────────────────────

const SHADERS: TechniqueMeta[] = [
  rec("shader:restorff-vertigo", "edit-move", { name: "Quick vertigo (no mask)", purpose: ["hook", "pattern-interrupt"], beats: ["hook", "reveal"], energy: 4, dur: [0.8, 1.2, 1.6], placement: "clip", spacing: 30, avoid: ["FX-15"], pairs: ["sfx:riser"], apply: { via: "effects", ref: "shader:restorff-vertigo" }, retention: "A dolly-zoom look on the whole frame with no matte: unease in one second.", example: "And then everything changed." }),
  rec("shader:restorff-blur", "edit-move", { name: "Focus blur", purpose: ["mood", "transition"], beats: ["bridge", "story"], energy: 1, dur: [0.5, 1, 2], placement: "clip", spacing: 15, apply: { via: "effects", ref: "shader:restorff-blur" }, retention: "A soft blur behind text gives words the frame for a moment.", example: "Let that sink in." }),
  rec("shader:restorff-glass-type", "effect", { name: "Frosted glass panel", purpose: ["mood", "explain-concept"], beats: ["explain", "claim"], energy: 2, dur: [1, 2, 3], placement: "overlay", spacing: 20, apply: { via: "effects", ref: "shader:restorff-glass-type" }, retention: "A frosted panel separates text from busy footage.", example: "Here's the one thing to remember." }),
];

// ─── caption styles (the captions tool's ids; bold-white and serif-box are FX-18 / FX-20) ──────────────────────

const cap = (style: string, s: Omit<Spec, "apply">) => rec(`cap:${style}`, "caption-style", { ...s, apply: { via: "captions", style } });
const CAPTIONS: TechniqueMeta[] = [
  cap("word-pop", { name: "Captions · word pop", purpose: ["emphasis", "hook"], beats: ["hook", "claim", "reveal"], energy: 4, retention: "1–3 bold words at a time with the spoken one popped: the fastest-reading caption, made for sound-off viewing.", example: "Make it viral, fast captions.", evidence: [R.named] }),
  cap("mono-label", { name: "Captions · mono label", purpose: ["mood"], beats: ["explain", "story"], energy: 3, retention: "Mono caps on a black box read as editorial and stay legible on any footage.", example: "Paper collage captions.", evidence: [R.collage] }),
  cap("huge-centred", { name: "Captions · huge centred", purpose: ["emphasis"], beats: ["hook", "reveal"], energy: 4, retention: "Huge centred words make the caption the picture; for short, loud pieces.", example: "Huge captions.", evidence: [R.warm] }),
  cap("key-word", { name: "Captions · key word", purpose: ["emphasis"], beats: ["claim", "number", "product"], energy: 3, retention: "The key word bigger and in the accent tells the eye which word matters (the effects reel's lowercase captions).", example: "Highlight the key words.", evidence: [R.named] }),
];

// ─── sound moves (the restorff-core SFX pack, apps/web/public/sfx/manifest.json) ─────────────────────────────

const sfx = (id: string, sound: string, s: Omit<Spec, "apply">) => rec(`sfx:${id}`, "sound", { ...s, apply: { via: "sounds", sound } });
const SOUNDS: TechniqueMeta[] = [
  sfx("whoosh", "whoosh-short", { name: "Whoosh", purpose: ["transition"], beats: ["bridge", "hook", "reveal", "story"], energy: 3, dur: [0.3, 0.45, 0.5], spacing: 0.8, pairs: ["kind:transition"], retention: "Sound on the cut tells the ear the picture moved: cuts on a sound hit run 56 % in the collage reel vs 42 % chance.", example: "(any whip or push)", evidence: [R.collage] }),
  sfx("whoosh-hit", "whoosh-hit", { name: "Whoosh hit", purpose: ["transition", "emphasis"], beats: ["reveal", "hook"], energy: 4, dur: [0.4, 0.55, 0.6], spacing: 2, pairs: ["FX-09", "comp:zoom-through-title"], retention: "A whoosh that lands on a knock gives a transition a destination.", example: "(a zoom-through)" }),
  sfx("hit", "impact", { name: "Impact hit", purpose: ["emphasis"], beats: ["reveal", "number", "hook"], energy: 4, dur: [0.5, 0.9, 1], spacing: 3, pairs: ["FX-22", "FX-23", "tr:flash"], retention: "A low hit on the punch word makes the viewer feel the beat, not just see it.", example: "(a big-word punch)" }),
  sfx("sub-hit", "sub-hit", { name: "Sub hit", purpose: ["emphasis", "hook"], beats: ["hook", "reveal"], energy: 4, dur: [0.6, 1, 1], spacing: 6, retention: "A sub thump on frame 0 is a hook for the ear.", example: "(the opening frame)" }),
  sfx("pop", "pop", { name: "Pop", purpose: ["emphasis"], beats: ["proof", "list", "product", "claim"], energy: 2, dur: [0.1, 0.12, 0.2], spacing: 0.5, pairs: ["FX-27", "FX-28", "FX-42", "move:word-pop"], retention: "A pop on every card that lands makes UI feel tactile.", example: "(a card pop-in)" }),
  sfx("riser", "riser-1s", { name: "Riser into the reveal", purpose: ["emphasis", "pattern-interrupt"], beats: ["reveal", "number"], energy: 4, dur: [0.8, 1, 2], spacing: 8, notes: "Ends on the reveal word (sync = its peak).", retention: "A riser builds tension the reveal releases: the ear waits for the payoff.", example: "And the result was…" }),
  sfx("stamp", "stamp-slam", { name: "Stamp slam", purpose: ["emphasis"], beats: ["reveal", "proof"], energy: 5, dur: [0.4, 0.6, 0.6], spacing: 3, pairs: ["FX-26", "comp:neon-form"], retention: "The stamp's thud is what makes it a verdict.", example: "(a rubber stamp)" }),
  sfx("typing", "typing-burst", { name: "Typing burst", purpose: ["explain-concept"], beats: ["steps", "explain"], energy: 2, dur: [0.5, 1, 1], spacing: 2, pairs: ["FX-30", "FX-24", "comp:neon-code"], retention: "Keys under typed text make it feel live.", example: "(a prompt box typing)" }),
  sfx("tick", "tick", { name: "Tick", purpose: ["list-steps", "number-data"], beats: ["list", "steps", "number"], energy: 2, dur: [0.05, 0.05, 0.1], spacing: 0.3, pairs: ["FX-07", "FX-31", "FX-32"], retention: "A tick per item or per count step is the sound of progress.", example: "(a checklist row ticking)" }),
  sfx("paper", "paper-slide", { name: "Paper slide", purpose: ["transition"], beats: ["story", "bridge"], energy: 2, dur: [0.4, 0.6, 0.6], spacing: 0.8, pairs: ["FX-52", "FX-57", "kind:transition"], retention: "Paper sounds on paper pieces keep the collage world physical (the collage reel adds paper and marker sounds on the tags).", example: "(a cut-out sliding in)", evidence: [R.collage] }),
  sfx("marker", "marker-scribble", { name: "Marker scribble", purpose: ["emphasis"], beats: ["comparison", "claim"], energy: 2, dur: [0.5, 0.85, 0.85], spacing: 2, pairs: ["FX-19", "FX-25", "FX-54"], retention: "A pen sound on a drawn line makes the strike or underline land.", example: "(a strike-through)", evidence: [R.collage] }),
  sfx("camera", "camera-shutter", { name: "Camera shutter", purpose: ["pattern-interrupt"], beats: ["proof", "reveal"], energy: 3, dur: [0.3, 0.35, 0.35], spacing: 4, pairs: ["FX-34"], retention: "A shutter is a freeze-frame for the ear.", example: "(a frame flash)" }),
  sfx("scratch", "record-scratch", { name: "Record scratch", purpose: ["pattern-interrupt"], beats: ["problem", "reveal"], energy: 4, dur: [0.4, 0.55, 0.55], spacing: 20, retention: "A scratch stops the story to say 'wait': a comic pattern interrupt.", example: "Wait, what?" }),
  sfx("drop", "bass-drop", { name: "Bass drop", purpose: ["emphasis"], beats: ["reveal", "product"], energy: 5, dur: [1, 1.6, 1.6], spacing: 15, retention: "A drop on the payoff marks the peak of the piece.", example: "Introducing Halcyon Nitro." }),
  sfx("ding", "ding", { name: "Ding", purpose: ["proof-social", "cta"], beats: ["proof", "cta", "number"], energy: 2, dur: [0.6, 1.4, 1.4], spacing: 8, pairs: ["FX-35"], retention: "A bell on a price or a result is a reward sound.", example: "Only four dollars." }),
  sfx("glitch", "glitch", { name: "Glitch", purpose: ["pattern-interrupt", "transition"], beats: ["hook", "problem"], energy: 4, dur: [0.3, 0.5, 0.5], spacing: 6, pairs: ["tr:glitch"], retention: "A digital stutter in the sound matches a glitch cut.", example: "(a glitch transition)" }),
  sfx("tape-stop", "tape-stop", { name: "Tape stop", purpose: ["pattern-interrupt"], beats: ["problem", "bridge"], energy: 3, dur: [0.5, 0.8, 0.8], spacing: 20, retention: "Everything winding down is a stop sign before a turn in the story.", example: "But then it all stopped." }),
  sfx("swell", "reverse-swell", { name: "Reverse swell", purpose: ["transition", "emphasis"], beats: ["reveal", "bridge"], energy: 3, dur: [0.6, 0.9, 0.9], spacing: 6, notes: "Ends on the cut it leads into (sync = its peak).", retention: "A reverse swell sucks the ear into the next shot.", example: "(into a reveal)" }),
  rec("sfx:duck", "sound", { name: "Duck the music under the voice", purpose: ["mood"], beats: ["claim", "explain", "story"], energy: 1, dur: [3, 60, 120], spacing: 120, apply: { via: "manual", why: "The music tool ducks its bed under the voice when it places it (music {duck}); ducking an existing bed is the duck op." }, retention: "Voice always on top: speech fills 89–99 % of a reel, so the words must win.", example: "Put some music under it." }),
  rec("sfx:silence-drop", "sound", { name: "Silence drop before the payoff", purpose: ["emphasis", "pattern-interrupt"], beats: ["reveal"], energy: 4, dur: [0.3, 0.4, 0.6], spacing: 30, apply: { via: "manual", why: "Needs a music bed: cut its gain to zero for 0.3–0.5 s right before the reveal word (gain keyframes on the music clip)." }, retention: "Pulling the music out for a beat makes the next word land in silence.", example: "And the answer is… nothing." }),
];

// ─── edit moves ──────────────────────────────────────────────────────────────────────────────────────────────

const move = (id: string, s: Spec) => rec(`move:${id}`, "edit-move", s);
const MOVES: TechniqueMeta[] = [
  move("punch-in", { name: "Punch-in (scale step on the clip)", purpose: ["pattern-interrupt", "emphasis", "hook"], beats: ["hook", "claim", "problem", "reveal", "number", "bridge"], energy: 3, dur: [0.8, 1.6, 2.5], spacing: 3, pairs: ["sfx:whoosh"], avoid: ["FX-05"], apply: { via: "ops", op: "punch-in" }, params: { factor: 1.15 }, retention: "A 1.15 scale step held to the next move is a visible change on a still talking head (the retention fix's move: neon-grid hook 2.73 → 0.53 s).", example: "Here's the thing.", evidence: ["retention worklog 2026-10-24"], notes: "Face kept in place when a face box exists; a base with its own transform keys is never punched; dense layouts lose 7.5 % per side." }),
  move("word-pop", { name: "Word pop (spoken word as a text pop)", purpose: ["emphasis", "pattern-interrupt"], beats: ["claim", "number", "reveal", "problem"], energy: 3, dur: [0.6, 0.9, 1.2], placement: "face-safe", spacing: 3, captions: "move", pairs: ["sfx:pop"], apply: { via: "ops", op: "text_pop" }, retention: "The spoken word popped big for under a second is a cheap interrupt that also says it twice.", example: "It takes TWELVE hours.", fill: { text: "keyword" }, evidence: ["retention worklog 2026-10-24"] }),
  move("jump-cut", { name: "Jump cut (dead air and retakes out)", purpose: ["pattern-interrupt"], beats: ["bridge", "claim"], energy: 2, dur: [0.1, 0.1, 0.1], spacing: 0, apply: { via: "manual", why: "autocut makes these from the transcript (silence, retakes, false starts) in one commit; run it before the director." }, retention: "Speech fills 89–99 % of every reference reel: dead air is the first thing viewers skip.", example: "Cut out the dead space.", evidence: [R.explainer, R.collage] }),
  move("j-cut", { name: "J-cut (sound leads the picture)", purpose: ["transition"], beats: ["bridge", "story"], energy: 2, dur: [0.2, 0.4, 0.8], placement: "cut", spacing: 6, apply: { via: "manual", why: "Trim the outgoing clip's video earlier than its audio (two trims on split A/V); no one-op move yet." }, retention: "Hearing the next scene first pulls the viewer across the cut.", example: "(a scene change mid-sentence)" }),
  move("l-cut", { name: "L-cut (sound trails the picture)", purpose: ["transition"], beats: ["bridge", "story", "product"], energy: 2, dur: [0.2, 0.4, 0.8], placement: "cut", spacing: 6, apply: { via: "manual", why: "Keep the outgoing audio under the next shot (split A/V, trim); no one-op move yet." }, retention: "The voice continuing over a cutaway keeps the thought going while the picture changes.", example: "(b-roll under a sentence)" }),
  move("speed-ramp", { name: "Speed ramp", purpose: ["pattern-interrupt", "emphasis"], beats: ["reveal", "product"], energy: 4, dur: [0.5, 1, 2], spacing: 15, apply: { via: "manual", why: "No retime op in ops@1 yet; on footage with motion only." }, retention: "Slow to fast on motion makes a moment feel engineered.", example: "Watch the pour." }),
  move("freeze", { name: "Freeze frame", purpose: ["emphasis", "pattern-interrupt"], beats: ["reveal", "problem", "hook"], energy: 3, dur: [0.5, 1, 2], spacing: 20, pairs: ["sfx:camera", "sfx:scratch"], apply: { via: "manual", why: "No freeze op in ops@1 yet (an image still from look + insert works by hand)." }, retention: "Stopping the picture on a face or a mess says 'look at this'.", example: "Yep, that's me." }),
  move("match-cut", { name: "Match cut", purpose: ["transition", "pattern-interrupt"], beats: ["bridge", "reveal"], energy: 3, dur: [0.1, 0.1, 0.1], placement: "cut", spacing: 20, apply: { via: "manual", why: "Needs two shots whose shapes line up; a human or a model looking at frames picks them." }, retention: "A shape that carries across a cut feels clever; viewers rewind for it (the collage reel's eye → record).", example: "From the eye to the record.", evidence: [R.collage] }),
  move("split-screen", { name: "Split screen", purpose: ["comparison", "hook"], beats: ["comparison", "hook"], energy: 3, dur: [2, 3, 5], placement: "full-frame", needs: ["two_clips"], spacing: 30, apply: { via: "manual", why: "FX-62 is not built; two cropped tracks by hand (set crop + position)." }, retention: "Two pictures at once start a comparison in the viewer's head.", example: "Left is ours, right is theirs.", evidence: [R.collage] }),
  move("b-roll", { name: "B-roll cutaway", purpose: ["b-roll-replace", "product-showcase"], beats: ["product", "story", "explain", "proof"], energy: 2, dur: [1, 2, 4], placement: "full-frame", needs: ["images"], spacing: 6, apply: { via: "manual", why: "Needs b-roll media: media import + insert on V2 over the line it illustrates." }, retention: "Showing what is said, while the voice continues, doubles the information per second.", example: "Here's how we make it." }),
  move("retention-fix", { name: "Retention fix (after a render)", purpose: ["pattern-interrupt", "hook"], beats: ["bridge", "hook"], energy: 3, dur: [0.5, 1, 2.5], spacing: 0, apply: { via: "manual", why: "director fill (or the retention tool) reads a render's retention map and fills its still stretches." }, retention: "Measured: a first change after 1 s and stretches over 3 s are where viewers leave.", example: "(after render → check)", evidence: ["retention worklog 2026-10-24"] }),
];

// ─── editing styles (packages/timeline-ops styles.ts built-ins; saved styles in packages/styles) ──────────────

const style = (id: string, s: Omit<Spec, "apply">) => rec(`style:${id}`, "style", { ...s, apply: { via: "style", preset: id } });
const STYLES: TechniqueMeta[] = [
  style("fast-ugc", { name: "Fast UGC", purpose: ["mood", "pattern-interrupt"], beats: ["hook", "claim", "product"], energy: 4, retention: "Tight cuts, whips on the beat and popping captions: the pace of native short-form ads.", example: "Make it fast and punchy." }),
  style("talking-head", { name: "Talking head (clean)", purpose: ["mood"], beats: ["explain", "claim"], energy: 2, retention: "Clean captions and few moves keep the face and the argument in charge.", example: "Keep it clean and professional." }),
  style("aesthetic-warm", { name: "Aesthetic warm", purpose: ["mood"], beats: ["story", "product"], energy: 2, retention: "Warm grade, serif karaoke captions and floating thumbnails: the editorial look of the warm reel.", example: "Make it more aesthetic.", evidence: [R.warm] }),
  style("moody-captions", { name: "Moody captions", purpose: ["mood", "emphasis"], beats: ["story", "problem", "reveal"], energy: 3, retention: "Moody grade, captions scaled up and huge words behind the head.", example: "Make it moody.", evidence: [R.warm] }),
  style("paper-collage", { name: "Paper collage", purpose: ["mood", "b-roll-replace"], beats: ["story", "explain"], energy: 3, retention: "Paper textures, red-outlined cut-outs and mono label captions: an explainer that feels handmade.", example: "Make it a paper collage explainer.", evidence: [R.collage] }),
];

// ─── look families (one piece keeps one look) and fills that may stay empty ─────────────────────────────────

const family = (look: Look, ids: string[]) => Object.fromEntries(ids.map((id) => [id, look])) as Record<string, Look>;
const LOOK_OF: Record<string, Look> = {
  ...family("neon", ["FX-23", "FX-48", "FX-49", "FX-50", "comp:neon-beats", "comp:neon-code", "comp:neon-curve", "comp:neon-flow", "comp:neon-form", "comp:neon-grid-ruler", "comp:neon-hook", "comp:neon-outro", "tr:glitch"]),
  ...family("paper", ["FX-13", "FX-14", "FX-51", "FX-52", "FX-53", "FX-54", "FX-57", "FX-58", "FX-59", "FX-60", "FX-61", "grade:paper"]),
  ...family("glass", ["FX-17", "FX-29", "shader:restorff-glass-type"]),
  ...family("editorial", ["FX-16", "FX-20", "FX-21", "FX-43", "comp:magazine-cover", "FX-38", "FX-39"]),
  ...family("ui", ["FX-03", "FX-06", "FX-07", "FX-11", "FX-27", "FX-28", "FX-30", "FX-31", "FX-33", "FX-34", "FX-35", "FX-42", "comp:toc-list"]),
  ...family("retro", ["FX-55", "FX-56", "tr:iris"]),
};
const OPTIONAL_FILLS: Record<string, string[]> = {
  "FX-02": ["word"],
  "FX-03": ["title"],
  "FX-06": ["appName"],
  "FX-07": ["title"],
  "FX-10": ["title"],
  "FX-11": ["title"],
  "FX-12": ["headline"],
  "FX-16": ["coverlines"],
  "FX-25": ["correction"],
  "FX-27": ["caption"],
  "FX-35": ["prompt"],
  "FX-42": ["images"],
  "FX-48": ["prompt"],
  "FX-54": ["title"],
  "FX-56": ["label"],
  "FX-61": ["hero", "caption"],
  "comp:magazine-cover": ["coverlines"],
  "comp:neon-hook": ["prompt"],
  "comp:toc-list": ["title"],
};

/**
 * The prose playbooks (hf-skills agent, packages/compositions/knowledge/, served by MCP `guide {topic}`; mapping from
 * its worklog Decision 8): by kind, else by main purpose. Records link them; the playbooks hold the prose.
 */
const KNOWLEDGE_BY_KIND: Partial<Record<TechniqueKind, string>> = {
  transition: "knowledge/transitions.md",
  "caption-style": "knowledge/captions.md",
  grade: "knowledge/grade.md",
  sound: "knowledge/sound.md",
  "edit-move": "knowledge/pacing-retention.md",
  style: "knowledge/look-and-style.md",
};
const KNOWLEDGE_BY_PURPOSE: Partial<Record<Purpose, string>> = {
  "number-data": "knowledge/numbers.md",
  hook: "knowledge/pacing-retention.md",
  "pattern-interrupt": "knowledge/pacing-retention.md",
  emphasis: "knowledge/motion.md",
  "explain-concept": "knowledge/video-types.md",
  cta: "knowledge/story.md",
};
const knowledgeOf = (t: TechniqueMeta): string[] => {
  const main = t.purpose[0];
  const paths = [KNOWLEDGE_BY_KIND[t.kind], main ? KNOWLEDGE_BY_PURPOSE[main] : undefined].filter((p): p is string => !!p);
  return [...new Set([...(t.knowledge ?? []), ...paths])];
};

/** Every built-in record. */
export const BUILTIN_TECHNIQUES: TechniqueMeta[] = [...FX_ROWS, ...COMPOSITIONS, ...TRANSITIONS, ...GRADES, ...SHADERS, ...CAPTIONS, ...SOUNDS, ...MOVES, ...STYLES].map((t) => {
  const knowledge = knowledgeOf(t);
  return {
    ...t,
    ...(LOOK_OF[t.id] ? { look: LOOK_OF[t.id] } : {}),
    ...(OPTIONAL_FILLS[t.id] ? { fillOptional: OPTIONAL_FILLS[t.id] } : {}),
    ...(knowledge.length ? { knowledge } : {}),
  };
});
