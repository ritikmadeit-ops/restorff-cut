// Sentence → param edits ("slower", "bigger", "bouncier", "make it red"). Claude can always edit values directly;
// this keeps the common nudges consistent (same step sizes, clamped to each param's min/max). CONTRACT.md §4.
import type { CompositionManifest, EasingName, ParamSpec, ParamValues } from "./types.ts";

export const COLOR_NAMES: Record<string, string> = {
  neon: "#F6FF00",
  yellow: "#F6FF00",
  bone: "#EDEBE6",
  white: "#FFFFFF",
  black: "#0C0C0E",
  screen: "#0C0C0E",
  kiln: "#C8553D",
  rust: "#C8553D",
  red: "#E5484D",
  orange: "#E8A33D",
  amber: "#E8A33D",
  green: "#3DD68C",
  blue: "#4C8DFF",
  purple: "#8E6CFF",
  pink: "#FF5FA2",
  grey: "#8C8C95",
  gray: "#8C8C95",
  fog: "#8C8C95",
};

/** Bounciness ladder used by "bouncier" / "less bouncy". */
const LADDER: EasingName[] = ["smooth", "snappy", "bouncy", "springy", "elastic"];

export interface Change {
  key: string;
  from: unknown;
  to: unknown;
  because: string;
}
export interface NudgeResult {
  values: ParamValues;
  changes: Change[];
  /** Rules that matched the sentence but this composition has no such param. */
  skipped: string[];
}

function clampToSpec(spec: ParamSpec, n: number): number {
  if (spec.type !== "number") return n;
  let v = n;
  if (spec.min != null) v = Math.max(spec.min, v);
  if (spec.max != null) v = Math.min(spec.max, v);
  const step = spec.step ?? 0.01;
  return +(Math.round(v / step) * step).toFixed(4);
}

/**
 * Apply every rule the sentence triggers. Throws when nothing matched, so a caller never believes a no-op
 * happened ("edit the params directly" is the answer then).
 */
export function nudge(manifest: CompositionManifest, current: ParamValues, sentence: string): NudgeResult {
  const s = ` ${sentence.toLowerCase().replace(/[^a-z0-9#\s-]/g, " ")} `;
  const values: ParamValues = JSON.parse(JSON.stringify(current));
  const changes: Change[] = [];
  const skipped: string[] = [];
  const specs = manifest.params;

  const setNum = (key: string, factor: number, because: string) => {
    const spec = specs[key];
    if (!spec || spec.type !== "number") return void skipped.push(`${because}: no "${key}" param`);
    const from = values[key] as number;
    const to = clampToSpec(spec, from * factor);
    if (to !== from) changes.push({ key, from, to, because });
    else skipped.push(`${because}: "${key}" already at its limit (${from})`);
    values[key] = to;
  };
  const setVal = (key: string, to: unknown, because: string) => {
    const spec = specs[key];
    if (!spec) return void skipped.push(`${because}: no "${key}" param`);
    if (spec.type === "enum" && !spec.options.includes(String(to))) return void skipped.push(`${because}: "${key}" has no option ${to}`);
    const from = values[key];
    if (from !== to) changes.push({ key, from, to, because });
    values[key] = to;
  };

  // speed — "slower" stretches every motion (time is multiplied by speed; see CONTRACT.md §3)
  if (/\bmuch slower\b|\bway slower\b/.test(s)) setNum("speed", 0.6, "much slower");
  else if (/\bslower\b|\bslow (it )?down\b|\bless rushed\b/.test(s)) setNum("speed", 0.8, "slower");
  if (/\bmuch faster\b|\bway faster\b/.test(s)) setNum("speed", 1.6, "much faster");
  else if (/\bfaster\b|\bquicker\b|\bspeed (it )?up\b/.test(s)) setNum("speed", 1.25, "faster");

  // size
  if (/\bmuch (bigger|larger)\b|\bhuge\b/.test(s)) setNum("scale", 1.35, "much bigger");
  else if (/\b(bigger|larger)\b/.test(s)) setNum("scale", 1.15, "bigger");
  if (/\bmuch smaller\b|\btiny\b/.test(s)) setNum("scale", 0.7, "much smaller");
  else if (/\bsmaller\b/.test(s)) setNum("scale", 0.87, "smaller");

  // motion character
  if (/\bless bouncy\b|\bless bounce\b|\bcalmer\b|\bsmoother\b|\bsubtler\b|\bmore subtle\b/.test(s)) {
    setVal("ease", "smooth", "calmer");
  } else if (/\bbouncier\b|\bmore bounce\b|\bmore playful\b|\bspringier\b/.test(s)) {
    const cur = values.ease as EasingName;
    const i = LADDER.indexOf(cur);
    setVal("ease", i < 0 ? "bouncy" : LADDER[Math.min(LADDER.length - 1, Math.max(i + 1, 2))], "bouncier");
  } else if (/\bsnappier\b|\bpunchier\b|\bsharper\b|\bmore punch\b/.test(s)) {
    setVal("ease", "snappy", "snappier");
  }

  // position
  const up = /\bmove (it |this |them )?up\b|\bhigher\b|\btowards? the top\b/.test(s);
  const down = /\bmove (it |this |them )?down\b|\blower\b|\btowards? the bottom\b/.test(s);
  if (up || down) {
    if (specs.offsetY?.type === "number") {
      const step = Math.round((manifest.size[1] * 0.04) / 10) * 10;
      const spec = specs.offsetY;
      const from = values.offsetY as number;
      const to = clampToSpec(spec, from + (up ? -step : step));
      if (to !== from) changes.push({ key: "offsetY", from, to, because: up ? "move up" : "move down" });
      values.offsetY = to;
    } else if (specs.anchor?.type === "enum") {
      const order = ["top", "center", "bottom"].filter((o) => (specs.anchor as { options: string[] }).options.includes(o));
      const i = order.indexOf(String(values.anchor));
      const j = Math.max(0, Math.min(order.length - 1, i + (up ? -1 : 1)));
      setVal("anchor", order[j], up ? "move up" : "move down");
    } else skipped.push(`${up ? "move up" : "move down"}: no offsetY or anchor param`);
  }

  // colour: a hex code anywhere, or a colour name after colour/accent/"make it"/"in"
  const hex = s.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/);
  const named = s.match(new RegExp(`\\b(?:colou?r|accent|highlight|make it|in|to)\\s+(?:to\\s+|=\\s*)?(${Object.keys(COLOR_NAMES).join("|")})\\b`));
  const colour = hex ? hex[0].toUpperCase() : named ? COLOR_NAMES[named[1] as string] : undefined;
  if (colour) setVal("accent", colour, `colour ${hex ? hex[0] : named?.[1]}`);

  // exit
  if (/\bno exit\b|\bstay on screen\b|\bdon t animate out\b|\bhold at the end\b/.test(s)) setVal("exit", false, "no exit");
  else if (/\banimate (it )?out\b|\bwith an exit\b/.test(s)) setVal("exit", true, "animate out");

  if (!changes.length && !skipped.length) {
    throw new Error(
      `no nudge rule matched "${sentence}". Rules: slower/faster, bigger/smaller, bouncier/calmer/snappier, ` +
        "move up/down, colour <name|#hex>, no exit. Otherwise edit the params directly (bun src/cli.ts params <file>).",
    );
  }
  return { values, changes, skipped };
}
