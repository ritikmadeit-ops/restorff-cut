/**
 * Retention over MCP and in the gate — the server glue (agent retention, 2026-10-24).
 *
 *   endCardOf(snapshot)         the end card the timeline marks (DEAD skips a still tail inside it)
 *   retentionOfRender(row)      the measured map of a finished render (cached; ./retention-measure.ts)
 *   planForRender(...)          the moves the fix would place on that render's commit (./retention-plan.ts), with the
 *                               words, the base pictures, face boxes, caption boxes and the SFX pack resolved
 *   retentionView(...)          the short map `check` / `look` / `retention map` answer: hook, still stretches with a
 *                               concrete `next` each ("punch-in on "eighteen" at 9.40 s …"), rates, the fix call
 *   retentionFix(...)           the ONE commit: moves → ops@1 → pushCommit (author claude); dry_run reduces locally
 *
 * Runbook + measured before/after: docs/restorff/worklog/retention.md.
 */
import path from "node:path";
import {
	apply as applyOps,
	isSfxTrack,
	type Op,
	type Project as OpsProject,
} from "@restorffcut/timeline-ops";
import {
	baseRuns,
	type CompositionFacts,
	type GateProject,
	type GateScene,
	type MediaInfo,
	pickScene,
	RETENTION_BARS,
	type RetentionMap,
	runtimeOf,
	textBox,
} from "@restorffcut/gate";
import { resolveMediaDir } from "@/lib/db/store";
import type { ProjectSnapshot, SnapshotElement } from "@/sync/snapshot";
import type { Actor } from "./auth";
import { timelineWords } from "./effects";
import { HttpError } from "./http";
import { faceSpanOnCanvas } from "./matte-face-span";
import { keepOutOf, safeBandFor } from "./matte-placement";
import { listProjectMedia } from "./media";
import { getCommit, getProjectHead, pushCommit } from "./projects";
import { compositionFacts, type MediaRef } from "./renders-check-media";
import { measureRetention } from "./retention-measure";
import { describeMove, type PlanBase, planRetention, type PlannedMove, type RetentionPlan, type RetentionPlanOptions, retentionOps, type SoundLite } from "./retention-plan";
import type { RenderRow } from "./renders-store";
import { findSound, loadSfxPackFromDisk } from "./sound-design";

const TICKS = 120_000;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Commit messages of the fix start with this (check stops pointing at the fix once the head is one). */
export const RETENTION_FIX_PREFIX = "retention fix";

// ─── end card ────────────────────────────────────────────────────────────────────────────────────────────────

const END_CARD = /\bend[- ]?card\b|\bpackshot\b/i;

interface Scene {
	tracks?: { overlay?: Array<{ elements?: SnapshotElement[]; type?: string }>; main?: { elements?: SnapshotElement[] }; audio?: Array<{ elements?: SnapshotElement[] }> };
	bookmarks?: unknown;
	[k: string]: unknown;
}

function sceneOf(snapshot: ProjectSnapshot): Scene | null {
	return (pickScene(snapshot as unknown as GateProject) as unknown as Scene | null) ?? null;
}

/**
 * The end card the timeline marks: an element whose restorff role / kind is end_card (or `end_card: true`), whose name
 * or composition name says "end card" / "packshot", or a marker (bookmark) whose note says "end card". ASSUMPTION: an
 * "outro" alone is not an end card. Seconds.
 */
export function endCardOf(snapshot: ProjectSnapshot): { t: number; t_end: number; why: string } | null {
	const scene = sceneOf(snapshot);
	if (!scene?.tracks) return null;
	let best: { t: number; t_end: number; why: string } | null = null;
	const consider = (t: number, t_end: number, why: string) => {
		if (!best || t_end > best.t_end || (t_end === best.t_end && t < best.t)) best = { t: r2(t), t_end: r2(t_end), why };
	};
	const tracks = [...(scene.tracks.overlay ?? []), scene.tracks.main ?? { elements: [] }];
	for (const track of tracks) {
		for (const el of track.elements ?? []) {
			const rf = (el.restorff ?? {}) as { role?: string; kind?: string; end_card?: boolean; composition?: { name?: string } };
			const name = `${el.name ?? ""} ${rf.composition?.name ?? ""}`;
			const marked = rf.role === "end_card" || rf.kind === "end_card" || rf.end_card === true;
			if (marked || END_CARD.test(name)) consider(el.startTime / TICKS, (el.startTime + el.duration) / TICKS, marked ? `element "${el.name ?? el.id}" is marked end_card` : `element "${el.name ?? el.id}" is named an end card`);
		}
	}
	const marks = (scene.bookmarks ?? (snapshot as { bookmarks?: unknown }).bookmarks) as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(marks)) {
		for (const m of marks) {
			const note = String(m.note ?? m.label ?? m.name ?? "");
			if (!END_CARD.test(note)) continue;
			const t = Number(m.time ?? m.t ?? 0);
			const dur = Number(m.duration ?? m.dur ?? 0);
			const ticks = t > 10_000 ? TICKS : 1; // bookmarks are stored in ticks; ops-made ones may be seconds
			consider(t / ticks, (t + (dur || 0)) / ticks || t / ticks, `the marker "${note.slice(0, 40)}"`);
		}
	}
	return best;
}

// ─── measure ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface RenderRetention {
	map: RetentionMap;
	ms: number;
	cached: boolean;
}

export async function retentionOfRender(row: RenderRow, signal?: AbortSignal): Promise<RenderRetention> {
	if (row.status !== "done" || !row.file) throw new Error(`render ${row.render_id} is ${row.status}, not done`);
	const got = await measureRetention(row.file, { signal });
	return { map: got.map, ms: got.ms, cached: got.cached };
}

// ─── plan ────────────────────────────────────────────────────────────────────────────────────────────────────

const has = (el: SnapshotElement, path: string) => {
	const ch = (el.animations as Record<string, { keys?: unknown[] } | undefined> | undefined)?.[path];
	return Array.isArray(ch?.keys) && ch.keys.length > 0;
};
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function planBase(el: SnapshotElement): PlanBase {
	const p = el.params ?? {};
	const rf = (el.restorff ?? {}) as { composition?: unknown };
	return {
		id: el.id,
		name: el.name ?? el.id,
		type: el.type,
		start: el.startTime / TICKS,
		end: (el.startTime + el.duration) / TICKS,
		composition: Boolean(rf.composition),
		keyed: ["transform.scaleX", "transform.scaleY", "transform.positionX", "transform.positionY"].some((k) => has(el, k)),
		scale: num(p["transform.scaleX"], 1),
		x: num(p["transform.positionX"], 0),
		y: num(p["transform.positionY"], 0),
	};
}

async function mediaRefs(projectId: string): Promise<{ refs: Map<string, MediaRef>; media: Record<string, MediaInfo> }> {
	const refs = new Map<string, MediaRef>();
	const media: Record<string, MediaInfo> = {};
	const dir = resolveMediaDir();
	for (const m of await listProjectMedia(projectId).catch(() => [])) {
		const meta = (m.meta ?? {}) as Record<string, unknown>;
		media[m.media_id] = { duration: typeof meta.duration === "number" ? meta.duration : undefined, width: typeof meta.width === "number" ? meta.width : undefined, height: typeof meta.height === "number" ? meta.height : undefined };
		refs.set(m.media_id, { media_id: m.media_id, hash: m.hash, file: path.join(dir, m.hash.slice(0, 2), m.hash), mime: m.mime });
	}
	return { refs, media };
}

/** The base picture (top-most element covering the frame) as a function of time; overlays of unknown cover count. */
async function baseFinder(projectId: string, snapshot: ProjectSnapshot): Promise<(t: number) => PlanBase | null> {
	const project = snapshot as unknown as GateProject;
	const scene = pickScene(project) as GateScene | null;
	if (!scene) return () => null;
	const { refs, media } = await mediaRefs(projectId);
	let facts: Record<string, CompositionFacts> = {};
	try {
		facts = (await compositionFacts(scene, refs)).facts;
	} catch {
		facts = {};
	}
	const fps = num((snapshot.settings as { fps?: { numerator?: number; denominator?: number } } | undefined)?.fps?.numerator, 30) / num((snapshot.settings as { fps?: { denominator?: number } } | undefined)?.fps?.denominator, 1);
	const runs = baseRuns(scene, runtimeOf(scene), { fps, beats: false, media, compositions: facts });
	// a composition whose cover is unknown (no render measured) still counts when nothing else covers: ASSUMPTION
	const visual = [...scene.tracks.overlay, scene.tracks.main].filter((tr) => tr && tr.type === "video" && !tr.hidden);
	return (t: number) => {
		const run = runs.find((r) => r.t <= t && t < r.t_end);
		if (run) return planBase(run.el as unknown as SnapshotElement);
		for (const tr of visual) {
			const el = tr.elements.find((e) => !e.hidden && e.startTime / TICKS <= t && t < (e.startTime + e.duration) / TICKS && (e.type === "video" || e.type === "image"));
			if (el && !String((el.restorff as { role?: string } | undefined)?.role ?? "").includes("cutout")) return planBase(el as unknown as SnapshotElement);
		}
		return null;
	};
}

const SOUND_IDS = { punch: "whoosh-short", pop: "pop", hook: "whoosh-hit" } as const;

async function packSounds(): Promise<{ punch: SoundLite | null; pop: SoundLite | null; hook: SoundLite | null }> {
	try {
		const pack = await loadSfxPackFromDisk();
		const pick = (id: string) => {
			const s = findSound(pack, id);
			return s ? { id: s.id, url: s.url, duration_s: s.duration_s, sync_s: s.sync_s, default_db: s.default_db } : null;
		};
		return { punch: pick(SOUND_IDS.punch), pop: pick(SOUND_IDS.pop), hook: pick(SOUND_IDS.hook) };
	} catch {
		return { punch: null, pop: null, hook: null };
	}
}

function canvasOf(snapshot: ProjectSnapshot) {
	const s = snapshot.settings as { canvasSize?: { width: number; height: number }; fps?: { numerator: number; denominator: number } | number } | undefined;
	const fps = typeof s?.fps === "number" ? s.fps : s?.fps?.denominator ? s.fps.numerator / s.fps.denominator : 30;
	return { width: s?.canvasSize?.width ?? 1080, height: s?.canvasSize?.height ?? 1920, fps };
}

/** Text boxes (captions + text) on screen over [a, b): canvas px rects. */
function textBoxesOver(snapshot: ProjectSnapshot, a: number, b: number, canvas: { width: number; height: number }) {
	const scene = sceneOf(snapshot);
	const out: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
	for (const track of scene?.tracks?.overlay ?? []) {
		if (track.type !== "text") continue;
		for (const el of track.elements ?? []) {
			if (el.hidden || el.type !== "text") continue;
			const s = el.startTime / TICKS;
			const e = (el.startTime + el.duration) / TICKS;
			if (e <= a || s >= b) continue;
			try {
				out.push(textBox(el as never, canvas));
			} catch {
				/* skip a box we cannot read */
			}
		}
	}
	return out;
}

/** Where a word pop goes: a band clear of the face keep-out and the text on screen, inside the safe band. */
function popPlacement(word: string, avoid: Array<{ x0: number; y0: number; x1: number; y1: number }>, canvas: { width: number; height: number }): { y: number; size: number } | null {
	const H = canvas.height;
	const W = canvas.width;
	const letters = Math.max(1, word.length);
	let size = 8;
	const widthOf = (sz: number) => letters * ((sz * H) / 90) * 0.6;
	if (widthOf(size) > 0.8 * W) size = Math.max(4, (0.8 * W) / (letters * (H / 90) * 0.6));
	const w = widthOf(size);
	const h = ((size * H) / 90) * 1.25;
	const band = safeBandFor(canvas);
	for (const f of [-0.22, -0.3, -0.14, 0.12, 0.2, -0.06]) {
		const cy = H / 2 + f * H;
		const box = { x0: W / 2 - w / 2, x1: W / 2 + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
		if (box.y0 < band.top * H || box.y1 > band.bottom * H) continue;
		if (avoid.some((r) => r.x0 < box.x1 && r.x1 > box.x0 && r.y0 < box.y1 && r.y1 > box.y0)) continue;
		return { y: f * H, size: Math.round(size * 10) / 10 };
	}
	return null;
}

export interface PlanContext {
	plan: RetentionPlan;
	ops: Array<Record<string, unknown>>;
	notes: string[];
	words_source: string;
	end_card: { t: number; t_end: number; why: string } | null;
}

/** The fix on `snapshot` (the commit the render shows): moves + ops. */
export async function planForSnapshot(projectId: string, snapshot: ProjectSnapshot, map: RetentionMap, options: RetentionPlanOptions = {}): Promise<PlanContext> {
	const canvas = canvasOf(snapshot);
	const [{ words, source }, baseAt, sounds] = await Promise.all([timelineWords(projectId, snapshot).catch(() => ({ words: [], source: "none" as const })), baseFinder(projectId, snapshot), packSounds()]);
	const endCard = endCardOf(snapshot);
	const plan = planRetention({ map, words, baseAt, endCard, fps: canvas.fps, options });
	const elements: Record<string, PlanBase> = {};
	const faces: Record<number, { x: number; y: number } | null> = {};
	const popPlace: Record<number, { y: number; size: number } | null> = {};
	const findEl = (id: string): SnapshotElement | null => {
		const scene = sceneOf(snapshot);
		for (const tr of [...(scene?.tracks?.overlay ?? []), scene?.tracks?.main ?? { elements: [] }]) {
			const el = tr.elements?.find((e) => e.id === id);
			if (el) return el;
		}
		return null;
	};
	for (let i = 0; i < plan.moves.length; i++) {
		const m = plan.moves[i];
		const el = findEl(m.element_id);
		if (el) elements[m.element_id] = planBase(el);
		if (m.kind === "punch_in" && el && el.type === "video" && !elements[m.element_id]?.composition) {
			const got = await faceSpanOnCanvas({ projectId, snapshot, from: m.t, to: Math.max(m.t + 0.2, m.until ?? m.t + 1), clip: el }).catch(() => null);
			faces[i] = got?.ok ? { x: (got.span.face.left + got.span.face.width / 2 - 0.5) * canvas.width, y: (got.span.face.top + got.span.face.height / 2 - 0.5) * canvas.height } : null;
		}
		if (m.kind === "word_pop" && m.word) {
			const until = m.t + (m.dur ?? 1);
			const avoid = textBoxesOver(snapshot, m.t, until, canvas);
			if (el && el.type === "video" && !elements[m.element_id]?.composition) {
				const got = await faceSpanOnCanvas({ projectId, snapshot, from: m.t, to: until, clip: el }).catch(() => null);
				if (got?.ok) {
					const k = keepOutOf(got.span, canvas);
					avoid.push({ x0: k.left * canvas.width, y0: k.top * canvas.height, x1: (k.left + k.width) * canvas.width, y1: (k.top + k.height) * canvas.height });
				}
			}
			popPlace[i] = popPlacement(m.word.text.replace(/[^\p{L}\p{N}'%$-]/gu, ""), avoid, canvas);
		}
	}
	// one SFX lane free over every sound window, else a new one
	const scene = sceneOf(snapshot);
	const audio = (scene?.tracks?.audio ?? []) as Array<{ id: string; name?: string; type: string; elements?: SnapshotElement[]; restorff?: { role?: string } }>;
	const windows = plan.moves.filter((m) => m.kind !== "punch_out").map((m) => [m.t - 0.3, m.t + 0.5] as const);
	const free = audio.filter((tr) => isSfxTrack(tr as never)).find((tr) => (tr.elements ?? []).every((e) => windows.every(([a, b]) => (e.startTime + e.duration) / TICKS <= a || e.startTime / TICKS >= b)));
	const sfxCount = audio.filter((tr) => isSfxTrack(tr as never)).length;
	const built = retentionOps(plan, { elements, faces, popPlace, sounds, sfxLane: free?.id ?? null, sfxLaneName: sfxCount ? `SFX ${sfxCount + 1}` : "SFX" });
	return { plan, ops: built.ops, notes: built.notes, words_source: source, end_card: endCard };
}

// ─── the short map (check / look / retention map) ────────────────────────────────────────────────────────────

export interface RetentionViewOptions {
	timelineId: string;
	renderId: string;
	commit: string;
	head?: string | null;
	plan?: RetentionPlan | null;
	/** The head is already a retention fix: point at a render / the owner instead of the fix again. */
	headIsFix?: boolean;
}

export function fixCall(o: { timelineId: string; renderId: string; head?: string | null }) {
	return { tool: "retention", arguments: { action: "fix", timeline_id: o.timelineId, render_id: o.renderId, ...(o.head ? { base_commit: o.head } : {}) } };
}

/** The retention map in a few lines, with a concrete next per finding. */
export function retentionView(map: RetentionMap, o: RetentionViewOptions) {
	const bars = RETENTION_BARS;
	const movesIn = (a: number, b: number) => (o.plan?.moves ?? []).filter((m) => m.t >= a - 1e-6 && m.t <= b + 1e-6 && m.kind !== "punch_out");
	const hookLate = map.first_change_s === null || map.first_change_s > bars.hook_s + 1e-9;
	const hookMove = (o.plan?.moves ?? []).find((m) => m.for === "hook");
	const still = map.stretches
		.filter((s) => s.dur > bars.dead_s + 1e-9 && !(s.t === 0 && hookLate))
		.map((s) => {
			const moves = movesIn(s.t, s.t_end);
			const skipped = (o.plan?.skipped ?? []).find((k) => k.t >= s.t - 1e-6 && k.t <= s.t_end && /end card/.test(k.why));
			const moving = (s.moving_pct ?? 0) >= 50;
			const placed = moves.length ? `${moves.map(describeMove).join(", ")} (retention fix places them)` : "a b-roll cut, a punch-in on a spoken word or an effect on a word every ~2 s";
			return {
				t: s.t,
				t_end: s.t_end,
				dur: s.dur,
				...(s.moving_pct !== undefined ? { moving_pct: s.moving_pct } : {}),
				...(skipped
					? { end_card: true, next: `${skipped.why}; nothing to do` }
					: moving
						? { next: `the picture keeps drifting here (${s.moving_pct} % of frames move a little), so a punch-in is seen but not counted as a change: cut inside it (b-roll, a new scene, a composition that lands on a still frame)${moves.length ? `; retention fix would still place ${moves.map(describeMove).join(", ")}` : ""}` }
						: { next: placed }),
			};
		});
	const fix = fixCall({ timelineId: o.timelineId, renderId: o.renderId, head: o.head });
	const failing = hookLate || still.some((s) => !("end_card" in s));
	return {
		measured_on: { render_id: o.renderId, commit: o.commit },
		hook: {
			first_change_s: map.first_change_s,
			bar_s: bars.hook_s,
			ok: !hookLate,
			...(hookLate ? { next: hookMove ? `${describeMove(hookMove)}: the open move inside the first second (retention fix)` : "open on a move in the first second: a punch-in on the first word, a word pop or an effect" } : {}),
		},
		longest_still_s: map.longest?.dur ?? null,
		longest_at: map.longest ? [map.longest.t, map.longest.t_end] : null,
		still_over_3s: still,
		events_per_10s: map.events_per_10s,
		windows_per_10s: map.windows.map((w) => w.per_10s),
		cuts_per_10s: map.cuts_per_10s,
		cuts_on_hit_pct: map.cuts_on_hit_pct,
		...(o.plan ? { fix_would_place: o.plan.moves.length, predicted_after_fix: { first_change_s: o.plan.predicted.first_change_s, longest_still_s: o.plan.predicted.longest_s } } : {}),
		...(failing
			? o.headIsFix
				? { note: "This render is already of a retention fix: what is left needs a hand-made change (a b-roll cut, a new scene, an effect) or the owner's call; the fix is not offered again, so a client cannot loop on it." }
				: { fix }
			: {}),
		bars: { hook_s: bars.hook_s, dead_s: bars.dead_s, severity: "should (the owner has not set per-piece bars yet)" },
	};
}

// ─── the fix ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface FixInput {
	timelineId: string;
	branch?: string;
	baseCommit?: string;
	render: RenderRow;
	options?: RetentionPlanOptions;
	message?: string;
	dryRun?: boolean;
	signal?: AbortSignal;
}

export type FixAnswer =
	| { ok: true; dry_run: boolean; commit_id?: string; branch: string; head_before: string; plan: RetentionPlan; ops: Array<Record<string, unknown>>; notes: string[]; message: string; map: RetentionMap; words_source: string; end_card: PlanContext["end_card"]; changes?: string[] }
	| { ok: false; code: string; message: string; extra?: Record<string, unknown> };

export async function retentionFix(input: FixInput, actor: Actor): Promise<FixAnswer> {
	const head = await getProjectHead(input.timelineId, input.branch);
	if (input.baseCommit && input.baseCommit !== head.head.id && !head.head.id.startsWith(input.baseCommit)) {
		return { ok: false, code: "conflict", message: `base_commit ${input.baseCommit.slice(0, 12)} is not the head (${head.head.id.slice(0, 12)}): the timeline moved. Render the head, check it, then fix.`, extra: { head: head.head.id } };
	}
	if (input.render.commit !== head.head.id) {
		return { ok: false, code: "stale_render", message: `Render ${input.render.render_id} shows commit ${input.render.commit.slice(0, 12)}, the head is ${head.head.id.slice(0, 12)}: its times may not match. Render the head (preview), then fix with that render.`, extra: { head: head.head.id } };
	}
	const snapshot = head.snapshot ?? ((await getCommit(input.timelineId, head.head.id, { snapshot: true })).snapshot as ProjectSnapshot | null);
	if (!snapshot) return { ok: false, code: "no_snapshot", message: "The head commit has no snapshot." };
	const { map } = await retentionOfRender(input.render, input.signal);
	const ctx = await planForSnapshot(input.timelineId, snapshot, map, input.options);
	const message = (input.message?.trim() || `${RETENTION_FIX_PREFIX}: ${summaryLine(ctx.plan)}`).slice(0, 300);
	const base = { branch: head.branch, head_before: head.head.id, plan: ctx.plan, ops: ctx.ops, notes: ctx.notes, message, map, words_source: ctx.words_source, end_card: ctx.end_card };
	if (!ctx.ops.length) return { ok: true, dry_run: Boolean(input.dryRun), ...base };
	if (input.dryRun) {
		const result = applyOps(snapshot as unknown as OpsProject, ctx.ops as unknown as Op[], { seed: `${input.timelineId}/${head.head.id}/retention-dry-run`, mode: "atomic" });
		if (!result.ok) return { ok: false, code: "ops_conflict", message: "The reducer refused the moves (nothing committed).", extra: { conflicts: result.conflicts.slice(0, 10), ops: ctx.ops } };
		return { ok: true, dry_run: true, ...base, changes: result.changes.ops.map((c) => c.summary ?? c.op) };
	}
	try {
		const pushed = await pushCommit(input.timelineId, { base_commit: head.head.id, branch: head.branch, author: "claude", ops: ctx.ops, message }, actor);
		if (!pushed.ok) return { ok: false, code: "conflict", message: `The timeline moved while fixing: its head is ${pushed.conflict.head.id}. Nothing was committed.`, extra: { head: pushed.conflict.head.id } };
		const changes = ((pushed.changes as { ops?: Array<{ summary?: string; op?: string }> } | undefined)?.ops ?? []).map((c) => c.summary ?? c.op ?? "");
		return { ok: true, dry_run: false, commit_id: pushed.commit.id, ...base, changes };
	} catch (error) {
		if (error instanceof HttpError && error.status === 422) {
			return { ok: false, code: "ops_conflict", message: "The reducer refused the moves (nothing committed).", extra: { conflicts: error.extra?.conflicts, ops: ctx.ops } };
		}
		throw error;
	}
}

export function summaryLine(plan: RetentionPlan): string {
	const hook = plan.moves.find((m) => m.for === "hook");
	const fill = plan.moves.filter((m) => m.for === "dead" && m.kind !== "punch_out").length;
	const stretches = plan.targets.stretches.filter((s) => s.moves).length;
	return [hook ? `open move at ${hook.t.toFixed(2)} s` : null, fill ? `${fill} move${fill === 1 ? "" : "s"} in ${stretches} still stretch${stretches === 1 ? "" : "es"}` : null].filter(Boolean).join(" + ") || "nothing to place";
}

export type { PlannedMove };
