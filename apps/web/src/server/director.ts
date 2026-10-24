/**
 * The director, I/O half (director agent, 2026-10-24). Reads a timeline (words, main-track pictures, cuts, captions,
 * grade, overlays already there), the technique catalogue (built-ins + sidecars, read live), the effects library
 * (status) and the SFX pack, runs the pure planner (./director-plan.ts) and, on apply, makes ONE commit:
 *
 *   effects-path techniques  → server/effects.ts applyEffect, chained with its `collect` hook (no commit each)
 *   punch-in / word pop      → ops@1 keyframes / text_pop, reduced locally on the chained snapshot
 *   sounds                   → ops@1 sfx + gain on free SFX lanes (a new lane when none is free)
 *   → pushCommit once (author claude), base = the head the plan was made on.
 *
 * `fill` reads a finished render's retention map (still stretches over the bar, a late first change) and plans only
 * inside those stretches. Runbook: docs/restorff/worklog/director.md. MCP: ../mcp/director.ts.
 */
import { join } from "node:path";
import { loadTechniques, type TechniqueMeta } from "@restorffcut/compositions/techniques";
import { apply as applyOps, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import { COMPOSITIONS_DIR } from "@/app/api/compositions/_lib/service";
import type { ProjectSnapshot, SnapshotElement, SnapshotTrack } from "@/sync/snapshot";
import type { Actor } from "./auth";
import { applyEffect, loadLibrary, type PackageEntry, timelineWords } from "./effects";
import { findEffect, type LibraryEffect } from "./effects-catalogue";
import { activeScene, captionWords } from "./effects-words";
import type { ParamSpecLite } from "./director-fill";
import { type DirectorClip, type DirectorInput, type DirectorPlan, type Override, type PlannedEvent, planDirector } from "./director-plan";
import { aspectOf, type PieceType, resolveStyle, type StyleProfile } from "./director-rules";
import { safeBandFor } from "./matte-placement";
import { getProjectHead, pushCommit } from "./projects";
import type { RenderRow } from "./renders-store";
import { retentionOfRender } from "./retention";
import { findSound, loadSfxPackFromDisk, type SfxPack } from "./sound-design";

const TICKS = 120_000;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
export const DIRECTOR_PREFIX = "director";

export interface DirectorRequest {
  timelineId: string;
  branch?: string;
  baseCommit?: string;
  style?: string;
  piece?: PieceType;
  energy?: number;
  seed?: string;
  from?: number;
  to?: number;
  windows?: Array<[number, number]>;
  product?: { name?: string; image?: string; brand?: string };
  cta?: { text?: string; keyword?: string };
  images?: string[];
  places?: string[];
  matte?: boolean;
  overrides?: Override[];
  avoid?: string[];
  only?: string[];
  grade?: boolean;
  sound?: boolean;
  message?: string;
  dryRun: boolean;
  signal?: AbortSignal;
}

interface Head {
  branch: string;
  headId: string;
  snapshot: ProjectSnapshot;
}

export interface DirectorContext {
  head: Head;
  profile: StyleProfile;
  matched: string;
  input: DirectorInput;
  library: LibraryEffect[];
  entries: PackageEntry[];
  pack: SfxPack | null;
  techniques: { count: number; sidecars: number; errors: string[] };
  words_source: string;
  canvas: { width: number; height: number; fps: number };
}

// ─── reading the timeline ────────────────────────────────────────────────────────────────────────────────────

function canvasOf(snapshot: ProjectSnapshot) {
  const s = snapshot.settings as { canvasSize?: { width: number; height: number }; fps?: { numerator: number; denominator: number } | number } | undefined;
  const fps = typeof s?.fps === "number" ? s.fps : s?.fps?.denominator ? s.fps.numerator / s.fps.denominator : 30;
  return { width: s?.canvasSize?.width ?? 1080, height: s?.canvasSize?.height ?? 1920, fps: fps > 0 ? fps : 30 };
}

const keyedPaths = ["transform.scaleX", "transform.scaleY", "transform.positionX", "transform.positionY"];
const isKeyed = (el: SnapshotElement) => keyedPaths.some((k) => {
  const ch = (el.animations as Record<string, { keys?: unknown[] } | undefined> | undefined)?.[k];
  return Array.isArray(ch?.keys) && ch.keys.length > 0;
});

function mainClips(snapshot: ProjectSnapshot): DirectorClip[] {
  const main = activeScene(snapshot)?.tracks?.main;
  return [...(main?.elements ?? [])]
    .filter((el) => (el.type === "video" || el.type === "image") && !el.hidden)
    .sort((a, b) => a.startTime - b.startTime)
    .map((el) => ({
      id: el.id,
      start: r3(el.startTime / TICKS),
      end: r3((el.startTime + el.duration) / TICKS),
      kind: (el.restorff as { composition?: unknown } | undefined)?.composition ? "composition" : el.type === "image" ? "image" : "footage",
      keyed: isKeyed(el),
    }));
}

function cutsOf(clips: DirectorClip[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < clips.length; i++) if (Math.abs(clips[i].end - clips[i + 1].start) < 0.002) out.push(clips[i + 1].start);
  return out;
}

function allTracks(snapshot: ProjectSnapshot): SnapshotTrack[] {
  const tracks = activeScene(snapshot)?.tracks;
  return tracks ? [...(tracks.overlay ?? []), ...(tracks.main ? [tracks.main] : []), ...(tracks.audio ?? [])] : [];
}

function pictureEnd(snapshot: ProjectSnapshot): number {
  let end = 0;
  for (const track of allTracks(snapshot)) {
    if (track.type === "audio" || track.type === "effect") continue;
    for (const el of track.elements ?? []) end = Math.max(end, el.startTime + el.duration);
  }
  return r3(end / TICKS);
}

/** Overlay elements already on the timeline (not text: captions and pops are not counted as picture changes). */
function existingChanges(snapshot: ProjectSnapshot): Array<{ t: number; end: number; what: string }> {
  const out: Array<{ t: number; end: number; what: string }> = [];
  for (const track of activeScene(snapshot)?.tracks?.overlay ?? []) {
    if (track.type === "text" || track.hidden) continue;
    for (const el of track.elements ?? []) {
      if (el.hidden) continue;
      if (String((el.restorff as { role?: string } | undefined)?.role ?? "").includes("cutout")) continue;
      out.push({ t: r3(el.startTime / TICKS), end: r3((el.startTime + el.duration) / TICKS), what: el.name ?? el.type });
    }
  }
  return out;
}

function isGraded(snapshot: ProjectSnapshot): boolean {
  for (const track of allTracks(snapshot)) {
    if ((track.name ?? "").toUpperCase().startsWith("GRADE")) return true;
    for (const el of track.elements ?? []) {
      if ((el as { effectType?: string }).effectType === "restorff-grade") return true;
      const fx = (el as { effects?: Array<{ type?: string }> }).effects;
      if (Array.isArray(fx) && fx.some((f) => f?.type === "restorff-grade")) return true;
    }
  }
  return false;
}

/** The library effect a technique applies through, if any. */
function libraryEffectOf(t: TechniqueMeta, library: LibraryEffect[]): LibraryEffect | null {
  if (t.apply.via !== "effects") return null;
  const found = findEffect(library, t.apply.ref);
  return found.effect;
}

function specsOf(effect: LibraryEffect | null, entries: PackageEntry[]): Record<string, ParamSpecLite> | null {
  if (!effect || effect.apply?.kind !== "composition") return null;
  const name = effect.apply.composition;
  const entry = entries.find((e) => e.name === name);
  if (!entry) return null;
  const required = new Set(((entry as { required?: unknown }).required as string[] | undefined) ?? []);
  const out: Record<string, ParamSpecLite> = {};
  for (const [key, spec] of Object.entries(entry.params ?? {})) {
    const s = spec as ParamSpecLite & { minItems?: unknown };
    out[key] = { ...s, required: s.required === true || required.has(key) || (typeof s.minItems === "number" && s.minItems > 0) };
  }
  return out;
}

export async function directorContext(req: DirectorRequest): Promise<DirectorContext> {
  const loaded = await getProjectHead(req.timelineId, req.branch);
  if (!loaded.snapshot) throw new Error(`The head commit ${loaded.head.id} has no snapshot to read.`);
  const head: Head = { branch: loaded.branch, headId: loaded.head.id, snapshot: loaded.snapshot };
  const canvas = canvasOf(head.snapshot);
  const [{ words, source }, { library, entries }, pack] = await Promise.all([
    timelineWords(req.timelineId, head.snapshot).catch(() => ({ words: [], source: "none" as const })),
    loadLibrary(),
    loadSfxPackFromDisk().catch(() => null),
  ]);
  const loadedTech = loadTechniques({ dir: join(COMPOSITIONS_DIR, "compositions") });
  const { profile, matched } = resolveStyle(req.style, req.piece);
  const clips = mainClips(head.snapshot);
  const effectFor = new Map<string, LibraryEffect | null>();
  const effectOf = (t: TechniqueMeta) => {
    if (!effectFor.has(t.id)) effectFor.set(t.id, libraryEffectOf(t, library));
    return effectFor.get(t.id) ?? null;
  };
  const available = (t: TechniqueMeta): boolean => {
    switch (t.apply.via) {
      case "effects": {
        const e = effectOf(t);
        return !!e && e.status !== "coming" && !!e.apply && e.apply.kind !== "tool";
      }
      case "ops":
        return t.apply.op === "punch-in" || t.apply.op === "text_pop";
      case "sounds":
        return !!pack && !!findSound(pack, t.apply.sound);
      default:
        return false;
    }
  };
  // bare media ids → the media URL form composition params resolve in any call scope (server/composition-media.ts)
  const asRef = (id: string) => (/^[A-Za-z0-9_-]{6,}$/.test(id) ? `/api/projects/${req.timelineId}/media/${id}` : id);
  const images = [...(req.images ?? []), ...(req.product?.image ? [req.product.image] : [])].map(asRef);
  if (req.product?.image) req = { ...req, product: { ...req.product, image: asRef(req.product.image) } };
  const input: DirectorInput = {
    words: words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
    clips,
    cuts: cutsOf(clips),
    durationS: pictureEnd(head.snapshot),
    aspect: aspectOf(canvas.width, canvas.height),
    fps: canvas.fps,
    captions: captionWords(head.snapshot).length > 0,
    matte: req.matte === true,
    images: [...new Set(images)],
    ...(req.product ? { product: req.product } : {}),
    ...(req.cta ? { cta: req.cta } : {}),
    ...(req.places?.length ? { places: req.places } : {}),
    existing: existingChanges(head.snapshot),
    graded: isGraded(head.snapshot),
    techniques: loadedTech.techniques,
    available,
    specs: (t) => specsOf(effectOf(t), entries),
  };
  return {
    head,
    profile,
    matched,
    input,
    library,
    entries,
    pack,
    techniques: { count: loadedTech.techniques.length, sidecars: loadedTech.sidecars, errors: loadedTech.errors },
    words_source: source,
    canvas,
  };
}

export function planFor(ctx: DirectorContext, req: DirectorRequest): DirectorPlan {
  return planDirector(ctx.input, {
    profile: ctx.profile,
    seed: req.seed ?? `${req.timelineId}:${ctx.head.headId}`,
    ...(req.energy !== undefined ? { energy: req.energy } : {}),
    ...(req.from !== undefined ? { from: req.from } : {}),
    ...(req.to !== undefined ? { to: req.to } : {}),
    ...(req.windows?.length ? { windows: req.windows } : {}),
    ...(req.overrides?.length ? { overrides: req.overrides } : {}),
    ...(req.avoid?.length ? { avoid: req.avoid } : {}),
    ...(req.only?.length ? { only: req.only } : {}),
    ...(req.grade === false ? { grade: false } : {}),
    ...(req.sound === false ? { sound: false } : {}),
  });
}

// ─── applying: ONE commit ────────────────────────────────────────────────────────────────────────────────────

export interface AppliedStep {
  n: number;
  id: string;
  name: string;
  t: number;
  ok: boolean;
  how: string;
  error?: string;
}

function findElement(snapshot: ProjectSnapshot, id: string): SnapshotElement | null {
  for (const track of allTracks(snapshot)) {
    const el = (track.elements ?? []).find((e) => e.id === id);
    if (el) return el;
  }
  return null;
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** A punch-in as keyframes on the base clip: own scale at its start, × factor at t (hold), back at the end (hold). */
function punchOps(snapshot: ProjectSnapshot, clips: DirectorClip[], e: PlannedEvent): Array<Record<string, unknown>> | string {
  const clip = clips.find((c) => c.start <= e.t + 1e-6 && e.t < c.end - 1e-6);
  if (!clip) return "no picture on the main track at that time";
  if (clip.keyed) return "the picture has its own camera keys";
  const el = findElement(snapshot, clip.id);
  if (!el) return "the picture is gone";
  const scale = num((el.params ?? {})["transform.scaleX"], 1);
  const factor = num(e.params.factor, 1.15);
  const release = Math.min(e.end, clip.end - 0.35);
  if (release <= e.t + 0.2) return "too close to the end of its picture";
  const key = (t: number, value: number, ease?: string) => ({ op: "keyframe", author: "claude", el: clip.id, prop: "scale", t: r3(t), value: Math.round(value * 10000) / 10000, ...(ease ? { ease } : {}) });
  return [key(clip.start, scale), key(e.t, scale * factor, "hold"), key(release, scale, "hold")];
}

/** A word pop: the spoken word as a text pop in the upper band (the explainer reel's animation zone), inside the safe area. */
function popOps(e: PlannedEvent, canvas: { width: number; height: number }): Array<Record<string, unknown>> | string {
  const text = String(e.params.text ?? e.word ?? "").replace(/[^\p{L}\p{N}'%$-]/gu, "").toUpperCase();
  if (!text) return "no word to pop";
  const band = safeBandFor(canvas);
  const y = Math.round((Math.max(band.top + 0.08, 0.2) - 0.5) * canvas.height);
  return [{ op: "text_pop", author: "claude", t: e.t, text, dur: r3(e.duration_s), style: { size: 8, weight: "bold", color: "#ffffff", align: "center", uppercase: true, y } }];
}

/** SFX ops for the planned sounds on free SFX lanes (greedy; new lanes when none is free). */
function soundOps(snapshot: ProjectSnapshot, sounds: PlannedEvent[], pack: SfxPack | null): { ops: Array<Record<string, unknown>>; notes: string[] } {
  const ops: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  if (!pack || !sounds.length) return { ops, notes };
  const audio = activeScene(snapshot)?.tracks?.audio ?? [];
  const busy = new Map<string, Array<[number, number]>>();
  const lanes: string[] = [];
  for (const track of audio) {
    const name = (track.name ?? "").toUpperCase();
    if (!name.startsWith("SFX") && (track.restorff as { role?: string } | undefined)?.role !== "sfx") continue;
    lanes.push(track.id);
    busy.set(track.id, (track.elements ?? []).map((el) => [el.startTime / TICKS, (el.startTime + el.duration) / TICKS] as [number, number]));
  }
  let added = 0;
  sounds.forEach((s, i) => {
    if (s.apply.via !== "sounds") return;
    const sound = findSound(pack, s.apply.sound);
    if (!sound) {
      notes.push(`sound ${s.apply.sound} is not in the pack: left out`);
      return;
    }
    const t = Math.max(0, r3(s.t - sound.sync_s));
    const span: [number, number] = [t, t + sound.duration_s];
    let lane = lanes.find((id) => (busy.get(id) ?? []).every(([a, b]) => b <= span[0] + 1e-6 || a >= span[1] - 1e-6));
    if (!lane) {
      added++;
      lane = `director-sfx-lane-${added}`;
      ops.push({ op: "add_track", author: "claude", kind: "audio", name: `SFX ${lanes.length + 1}`, ref: lane });
      lanes.push(lane);
      busy.set(lane, []);
    }
    busy.get(lane)?.push(span);
    const ref = `director-sfx-${i + 1}`;
    ops.push({ op: "sfx", author: "claude", t, name: `SFX ${sound.id} · director`, url: sound.url, dur: sound.duration_s, track: lane, ref });
    ops.push({ op: "gain", author: "claude", el: ref, db: Math.round((sound.default_db - 2) * 10) / 10 });
  });
  return { ops, notes };
}

export interface ApplyAnswer {
  ok: boolean;
  commit_id?: string;
  head_before: string;
  branch: string;
  message: string;
  steps: AppliedStep[];
  ops_count: number;
  notes: string[];
  code?: string;
  error?: string;
}

/** Apply a plan in ONE commit. Effects first (time order), then moves, then sounds on the final picture. */
export async function applyPlan(ctx: DirectorContext, req: DirectorRequest, plan: DirectorPlan, actor: Actor): Promise<ApplyAnswer> {
  const head0 = ctx.head;
  if (req.baseCommit && req.baseCommit !== head0.headId && !head0.headId.startsWith(req.baseCommit)) {
    return { ok: false, code: "conflict", error: `base_commit ${req.baseCommit.slice(0, 12)} is not the head (${head0.headId.slice(0, 12)}).`, head_before: head0.headId, branch: head0.branch, message: "", steps: [], ops_count: 0, notes: [] };
  }
  let snapshot = head0.snapshot;
  const allOps: unknown[] = [];
  const steps: AppliedStep[] = [];
  const notes: string[] = [];
  let pending = 0;
  const collect = (c: { snapshot: ProjectSnapshot; ops: unknown[]; message: string }) => {
    snapshot = c.snapshot;
    allOps.push(...c.ops);
    pending++;
    return `pending-${pending}`;
  };
  const reduceLocal = (ops: Array<Record<string, unknown>>, label: string): string | null => {
    const result = applyOps(snapshot as unknown as OpsProject, ops as unknown as Op[], { seed: `${req.timelineId}/${head0.headId}/director/${label}`, at: new Date().toISOString() });
    if (!result.ok) return `the reducer refused it: ${JSON.stringify(result.conflicts.slice(0, 2)).slice(0, 200)}`;
    snapshot = result.project as unknown as ProjectSnapshot;
    allOps.push(...result.changes.applied);
    return null;
  };

  for (const e of plan.events) {
    if (req.signal?.aborted) {
      notes.push("stopped: the call was cancelled; nothing was committed");
      return { ok: false, code: "aborted", error: "cancelled", head_before: head0.headId, branch: head0.branch, message: "", steps, ops_count: 0, notes };
    }
    if (e.apply.via === "effects") {
      const effect = findEffect(ctx.library, e.apply.ref).effect;
      if (!effect) {
        steps.push({ n: e.n, id: e.id, name: e.name, t: e.t, ok: false, how: "effects apply", error: "not in the effects library" });
        continue;
      }
      const isTransition = effect.apply?.kind === "transition";
      const isGrade = effect.apply?.kind === "grade";
      const params = Object.fromEntries(Object.entries(e.params).filter(([k]) => k !== "duration_s"));
      const result = await applyEffect(
        {
          effect,
          entries: ctx.entries,
          timelineId: req.timelineId,
          branch: head0.branch,
          ...(isGrade ? {} : { t: isTransition ? r3(e.t + e.duration_s / 2) : e.t, durationS: e.duration_s }),
          params,
          message: `director: ${e.name} at ${e.t} s`,
          dryRun: false,
          head: { branch: head0.branch, headId: head0.headId, snapshot },
          collect,
          waitS: 0,
          ...(req.signal ? { signal: req.signal } : {}),
        },
        ctx.library,
        actor,
      );
      if (result.isError) {
        const err = (result.payload.error as { message?: string } | undefined)?.message ?? "refused";
        steps.push({ n: e.n, id: e.id, name: e.name, t: e.t, ok: false, how: "effects apply", error: err.slice(0, 240) });
      } else if (result.payload.status === "needs" || result.payload.status === "use_tool") {
        steps.push({ n: e.n, id: e.id, name: e.name, t: e.t, ok: false, how: "effects apply", error: String(result.payload.message ?? result.payload.status).slice(0, 240) });
      } else {
        steps.push({ n: e.n, id: e.id, name: e.name, t: e.t, ok: true, how: `effects apply (${effect.apply?.kind})` });
      }
      continue;
    }
    if (e.apply.via === "ops") {
      const built = e.apply.op === "punch-in" ? punchOps(snapshot, ctx.input.clips, e) : popOps(e, ctx.canvas);
      if (typeof built === "string") {
        steps.push({ n: e.n, id: e.id, name: e.name, t: e.t, ok: false, how: `ops ${e.apply.op}`, error: built });
        continue;
      }
      const refused = reduceLocal(built, `${e.n}`);
      steps.push({ n: e.n, id: e.id, name: e.name, t: e.t, ok: !refused, how: `ops ${e.apply.op}`, ...(refused ? { error: refused } : {}) });
      continue;
    }
    steps.push({ n: e.n, id: e.id, name: e.name, t: e.t, ok: false, how: e.apply.via, error: "not applied by the director (see recommendations)" });
  }
  // sounds go on the final picture; a sound whose visual event failed is dropped
  const failedAt = new Set(steps.filter((s) => !s.ok).map((s) => s.t));
  const sounds = plan.sounds.filter((s) => !plan.events.some((e) => failedAt.has(e.t) && Math.abs(e.t - s.t) < 0.4 && !steps.some((st) => st.ok && Math.abs(st.t - s.t) < 0.4)));
  const built = soundOps(snapshot, sounds, ctx.pack);
  notes.push(...built.notes);
  if (built.ops.length) {
    const refused = reduceLocal(built.ops, "sounds");
    if (refused) notes.push(`sounds left out: ${refused}`);
    else steps.push({ n: 0, id: "sounds", name: `${sounds.length} sounds`, t: 0, ok: true, how: "ops sfx + gain" });
  }
  const applied = steps.filter((s) => s.ok).length;
  if (!allOps.length) {
    return { ok: false, code: "nothing_applied", error: "No step could be applied: nothing was committed.", head_before: head0.headId, branch: head0.branch, message: "", steps, ops_count: 0, notes };
  }
  const visualOk = steps.filter((s) => s.ok && s.id !== "sounds").length;
  const message = (req.message?.trim() || `${DIRECTOR_PREFIX}: ${ctx.profile.id} — ${visualOk} techniques${sounds.length ? ` + ${sounds.length} sounds` : ""} on ${plan.beats.length} beats`).slice(0, 300);
  const pushed = await pushCommit(req.timelineId, { base_commit: head0.headId, branch: head0.branch, author: "claude", snapshot, ops: allOps, message }, actor);
  if (!pushed.ok) {
    return { ok: false, code: "conflict", error: `The timeline moved while directing: its head is ${pushed.conflict.head.id}. Nothing was committed.`, head_before: head0.headId, branch: head0.branch, message, steps, ops_count: allOps.length, notes };
  }
  if (applied < steps.length) notes.push(`${steps.length - applied} of ${steps.length} steps were not applied (see steps[].error); the rest are in the commit`);
  return { ok: true, commit_id: pushed.commit.id, head_before: head0.headId, branch: head0.branch, message, steps, ops_count: allOps.length, notes };
}

// ─── fill from a render's retention map ──────────────────────────────────────────────────────────────────────

export async function windowsFromRender(row: RenderRow, signal?: AbortSignal): Promise<{ windows: Array<[number, number]>; map: { first_change_s: number | null; longest_s: number | null; over_bar: number; events_per_10s: number } }> {
  const { map } = await retentionOfRender(row, signal);
  const raw: Array<[number, number]> = map.over_bar.map((s) => [s.t, s.t_end] as [number, number]);
  if (map.first_change_s === null || map.first_change_s > 1.0) raw.push([0, Math.min(map.duration_s, Math.max(1.0, map.first_change_s ?? 1.0))]);
  // merge overlapping / repeated stretches (a late hook IS the first stretch: live dry run 14:1x listed [0, 8.6] twice)
  const windows: Array<[number, number]> = [];
  for (const [a, b] of raw.sort((x, y) => x[0] - y[0])) {
    const last = windows[windows.length - 1];
    if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b);
    else windows.push([a, b]);
  }
  return {
    windows,
    map: { first_change_s: map.first_change_s, longest_s: map.longest?.dur ?? null, over_bar: map.over_bar.length, events_per_10s: map.events_per_10s },
  };
}
