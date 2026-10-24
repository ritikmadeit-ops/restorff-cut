/**
 * The retention fix, planned (agent retention, 2026-10-24). Pure: a measured retention map + what is on the timeline
 * in, the moves and their ops@1 out. The I/O half (head, render, words, faces, caption boxes, commit) is
 * ./retention.ts; the measurer is ./retention-measure.ts + packages/gate/src/retention.ts.
 *
 * What it places (one commit, author claude):
 *   - the OPEN MOVE: when nothing changes in the first `hook_s` (1.0 s), a punch-in on the first spoken word inside
 *     the first second (else at 0.5 s);
 *   - FILL: every stretch longer than `dead_s` (3.0 s) that is not the marked end card gets a move about every
 *     `spacing_s` (2.0 s), each snapped to the start of a spoken word near it (content words first);
 *   - each move is a PUNCH (a scale step on the base picture — the top-most picture covering the frame — held, then
 *     released at the next move or after `hold_max_s`; on a clip with a face box the position moves with it so the face
 *     stays where it was: punch-ins never push the face off frame) or, on footage, every other move a WORD POP (the
 *     spoken word as a big text pop, placed in a band clear of the face box and of the captions and text on screen,
 *     inside the safe area);
 *   - an SFX on every punch-in and word pop (the restorff-core pack: whoosh-short / pop / whoosh-hit), its event on the
 *     move, on a free SFX lane (a new one when none is free).
 * A base that already has transform keyframes is never punched (its camera move would be overwritten): it gets a word
 * pop, or the move is skipped with the reason.
 */
import type { RetentionMap } from "@restorffcut/gate";

export const RETENTION_FIX = "retention-fix@1";

export interface PlanWord {
	text: string;
	start: number;
	end: number;
}

/** The picture a move lands on (the base picture at t). Seconds; canvas px from the centre. */
export interface PlanBase {
	id: string;
	name: string;
	type: string;
	start: number;
	end: number;
	/** A composition (motion graphic) rather than footage. */
	composition: boolean;
	/** The element already has scale / position keyframes: no punch on it. */
	keyed: boolean;
	scale: number;
	x: number;
	y: number;
}

export type MoveKind = "punch_in" | "punch_out" | "word_pop";

export interface PlannedMove {
	kind: MoveKind;
	/** Seconds (on the frame grid). */
	t: number;
	for: "hook" | "dead";
	/** The measured stretch it breaks: [start, end] seconds. */
	stretch: [number, number];
	element_id: string;
	element_name: string;
	word?: PlanWord;
	/** punch_in: the scale factor over the element's own scale. */
	factor?: number;
	/** A punch-in released by a later punch_out of the same element at this time (filled by the planner). */
	until?: number;
	/** word_pop: seconds on screen. */
	dur?: number;
	why: string;
}

export interface RetentionPlanOptions {
	bars?: { hook_s?: number; dead_s?: number };
	/** Target seconds between moves inside a dead stretch (default 2.0: under the 3.0 s bar with room for a miss). */
	spacing_s?: number;
	/** Punch-in factor (default 1.15: MEASURED 2026-10-24, a 1.12 zoom of the darkest neon-grid frame changes it by 3.2 grey levels, the detector's floor is 2.0). */
	punch?: number;
	/** Longest a punch-in holds before it is released (default 2.5 s). */
	hold_max_s?: number;
	/** "auto" (punches on motion graphics, punches + word pops on footage), or the moves allowed. */
	moves?: "auto" | Array<"punch" | "word">;
}

export interface PlanInput {
	map: RetentionMap;
	words: PlanWord[];
	baseAt: (t: number) => PlanBase | null;
	endCard: { t: number; t_end: number; why: string } | null;
	fps: number;
	options?: RetentionPlanOptions;
}

export interface RetentionPlan {
	planner: typeof RETENTION_FIX;
	moves: PlannedMove[];
	skipped: Array<{ t: number; why: string }>;
	/** What the map would look like with the moves (each move = one visual change; the detector decides on the render). */
	predicted: { first_change_s: number | null; longest_s: number; over_bar: Array<{ t: number; t_end: number; dur: number }> };
	targets: { hook: boolean; stretches: Array<{ t: number; t_end: number; dur: number; moves: number }> };
}

const STOP = new Set(
	"a an the and or but so of to in on at for by with from as is are was were be been it its it's this that these those we our you your i my me he she they them his her their not no do does did just very too than then there here what why how when who".split(" "),
);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clean = (text: string) => text.replace(/[^\p{L}\p{N}'%$-]/gu, "");

/** A word worth landing on: a number, or a word of 4+ letters that is not a stop word. */
export function isContentWord(text: string): boolean {
	const w = clean(text).toLowerCase();
	if (!w) return false;
	if (/\d/.test(w)) return true;
	return w.length >= 4 && !STOP.has(w);
}

function onFrame(t: number, fps: number): number {
	return r3(Math.round(t * fps) / fps);
}

/** The word to land a move on near `ideal` inside (lo, hi): content words first, then any word, nearest first. */
export function snapToWord(words: PlanWord[], ideal: number, lo: number, hi: number, reach = 0.6): PlanWord | null {
	const near = words.filter((w) => w.start > lo && w.start < hi && Math.abs(w.start - ideal) <= reach);
	if (!near.length) return null;
	const score = (w: PlanWord) => Math.abs(w.start - ideal) + (isContentWord(w.text) ? 0 : 0.5);
	return near.sort((a, b) => score(a) - score(b))[0];
}

function stretchesOf(points: number[], duration: number) {
	const pts = [0, ...points.filter((p) => p > 0 && p < duration), duration].sort((a, b) => a - b);
	const out: Array<{ t: number; t_end: number; dur: number }> = [];
	for (let i = 0; i + 1 < pts.length; i++) out.push({ t: r3(pts[i]), t_end: r3(pts[i + 1]), dur: r3(pts[i + 1] - pts[i]) });
	return out;
}

/** The moves (pure). */
export function planRetention(input: PlanInput): RetentionPlan {
	const o = input.options ?? {};
	const hookBar = o.bars?.hook_s ?? 1.0;
	const deadBar = o.bars?.dead_s ?? 3.0;
	const spacing = o.spacing_s ?? 2.0;
	const factor = o.punch ?? 1.15;
	const holdMax = o.hold_max_s ?? 2.5;
	const allow = o.moves && o.moves !== "auto" ? new Set(o.moves) : null;
	const fps = input.fps || 30;
	const frame = 1 / fps;
	const { map } = input;
	const duration = map.duration_s;
	const skipped: RetentionPlan["skipped"] = [];

	// 1. where moves go
	const points: Array<{ t: number; for: "hook" | "dead"; stretch: [number, number]; word: PlanWord | null }> = [];
	const first = map.first_change_s;
	const hook = first === null || first > hookBar + 1e-9;
	if (hook) {
		const word = input.words.find((w) => w.start >= 0.1 && w.start <= hookBar - 0.15) ?? null;
		points.push({ t: onFrame(word ? word.start : Math.min(0.5, hookBar / 2), fps), for: "hook", stretch: [0, first ?? duration], word });
	}
	const placed = () => [...map.events, ...points.map((p) => p.t)].sort((a, b) => a - b);
	const targets: RetentionPlan["targets"] = { hook, stretches: [] };
	for (const s of stretchesOf(placed(), duration)) {
		if (s.dur <= deadBar + 1e-9) continue;
		const isTail = s.t_end >= duration - 0.05;
		if (isTail && input.endCard && s.t >= input.endCard.t - 0.05) {
			skipped.push({ t: s.t, why: `${s.t.toFixed(2)}–${s.t_end.toFixed(2)} s is the marked end card (${input.endCard.why}): left still` });
			continue;
		}
		const n = Math.max(1, Math.ceil(s.dur / spacing) - 1);
		let last = s.t;
		let added = 0;
		for (let k = 1; k <= n; k++) {
			const ideal = s.t + (k * s.dur) / (n + 1);
			const lo = Math.max(last + 0.45, s.t + 0.4);
			const hi = s.t_end - 0.4;
			if (lo >= hi) break;
			const word = snapToWord(input.words, ideal, lo, hi);
			const t = onFrame(word ? word.start : Math.min(hi, Math.max(lo, ideal)), fps);
			points.push({ t, for: "dead", stretch: [s.t, s.t_end], word });
			last = t;
			added++;
		}
		targets.stretches.push({ ...s, moves: added });
	}
	points.sort((a, b) => a.t - b.t);

	// 2. what each move is
	const moves: PlannedMove[] = [];
	const zoomed = new Map<string, PlannedMove>(); // element id → its open punch-in
	let footageTurn = 0;
	const release = (pin: PlannedMove, at: number, why: string, word?: PlanWord | null) => {
		pin.until = at;
		moves.push({ kind: "punch_out", t: at, for: pin.for, stretch: pin.stretch, element_id: pin.element_id, element_name: pin.element_name, ...(word ? { word } : {}), why });
		zoomed.delete(pin.element_id);
	};
	const ends = new Map<string, number>(); // element id → its end (s)
	// When a held punch-in lets go: after hold_max_s, but never within 0.35 s of the picture's own end (a release a few
	// frames before a cut shows the unzoomed picture for 1–3 frames: a FLASH) — then it holds to the end. null = hold.
	const releaseTime = (pin: PlannedMove): number | null => {
		const end = ends.get(pin.element_id) ?? duration;
		const latest = Math.min(pin.t + holdMax, end);
		return end - latest < 0.35 ? null : onFrame(latest, fps);
	};
	for (const p of points) {
		// a punch held too long is released first (it is a change of its own) — unless this move comes soon after on the
		// same picture: then this move is the release (a release one frame before a new punch-in would flash)
		const base = input.baseAt(p.t + frame / 2);
		for (const pin of [...zoomed.values()]) {
			const at = releaseTime(pin);
			const end = ends.get(pin.element_id) ?? duration;
			if (at === null) {
				if (p.t >= end - 1e-6) {
					pin.until = end;
					zoomed.delete(pin.element_id);
				}
				continue;
			}
			if (p.t <= at + 1e-6) continue;
			if (base?.id === pin.element_id && p.t - at < 0.6) continue;
			release(pin, at, `release the punch-in after ${r3(at - pin.t)} s`);
		}
		if (!base) {
			skipped.push({ t: p.t, why: "no picture covers the frame here (only overlays): nothing to punch" });
			continue;
		}
		ends.set(base.id, base.end);
		const wordOk = !!p.word && (!allow || allow.has("word"));
		const punchOk = !base.keyed && (!allow || allow.has("punch")) && base.type !== "text" && base.end - p.t >= 0.5 && p.t - base.start >= 0.15;
		let kind: MoveKind | null;
		const open = zoomed.get(base.id);
		if (allow && !allow.has("punch")) kind = wordOk ? "word_pop" : null;
		else if (allow && !allow.has("word")) kind = punchOk ? (open ? "punch_out" : "punch_in") : null;
		else if (!base.composition && wordOk && footageTurn % 2 === 1) kind = "word_pop";
		else if (punchOk) kind = open ? "punch_out" : "punch_in";
		else kind = wordOk ? "word_pop" : null;
		if (!base.composition) footageTurn++;
		if (!kind) {
			skipped.push({ t: p.t, why: base.keyed ? `${base.name} has its own camera move (keyframes) and no word is spoken here` : "no move allowed here" });
			continue;
		}
		const on = p.word ? ` on "${clean(p.word.text)}"` : "";
		const where = p.for === "hook" ? "the open move inside the first second" : `breaks the ${r3(p.stretch[1] - p.stretch[0])} s still stretch ${p.stretch[0]}–${p.stretch[1]} s`;
		if (kind === "punch_out" && open) {
			release(open, p.t, `punch back out${on}: ${where}`, p.word);
			continue;
		}
		const move: PlannedMove = {
			kind,
			t: p.t,
			for: p.for,
			stretch: p.stretch,
			element_id: base.id,
			element_name: base.name,
			...(p.word ? { word: p.word } : {}),
			why: `${kind === "word_pop" ? "word pop" : "punch-in"}${on}: ${where}`,
		};
		if (kind === "punch_in") {
			move.factor = factor;
			zoomed.set(base.id, move);
		} else {
			const next = points.find((q) => q.t > p.t + 1e-6);
			move.dur = r3(Math.max(0.6, Math.min(1.2, (next ? next.t : p.t + 1.2) - p.t - 0.1)));
		}
		moves.push(move);
	}
	for (const pin of [...zoomed.values()]) {
		const at = releaseTime(pin);
		if (at !== null && at - pin.t >= 0.6) release(pin, at, `release the punch-in after ${r3(at - pin.t)} s`);
		else pin.until = ends.get(pin.element_id) ?? duration;
	}
	moves.sort((a, b) => a.t - b.t || (a.kind === "punch_out" ? -1 : 1));

	const after = stretchesOf([...map.events, ...moves.map((m) => m.t)], duration);
	const longest = after.reduce((m, s) => Math.max(m, s.dur), 0);
	const firstAfter = [...map.events, ...moves.map((m) => m.t)].filter((t) => t > 0).sort((a, b) => a - b)[0] ?? null;
	return {
		planner: RETENTION_FIX,
		moves,
		skipped,
		predicted: {
			first_change_s: firstAfter === null ? null : r3(firstAfter),
			longest_s: r3(longest),
			over_bar: after.filter((s) => s.dur > deadBar + 1e-9 && !(input.endCard && s.t_end >= duration - 0.05 && s.t >= input.endCard.t - 0.05)),
		},
		targets,
	};
}

// ─── ops ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SoundLite {
	id: string;
	url: string;
	duration_s: number;
	sync_s: number;
	default_db: number;
}

export interface OpsContext {
	/** Element start / own transform, by id (the base pictures the moves land on). */
	elements: Record<string, PlanBase>;
	/** Face centre on the canvas (px from the centre) for a punch-in, by move index; absent = zoom about the centre. */
	faces?: Record<number, { x: number; y: number } | null>;
	/** Word pops: the y (canvas px from the centre) and font size chosen clear of the face and the captions, by move index; null = no clear band. */
	popPlace?: Record<number, { y: number; size: number } | null>;
	/** Sounds by role: punch (on a punch-in), pop (on a word pop), hook (the open move). Absent = no SFX. */
	sounds?: { punch?: SoundLite | null; pop?: SoundLite | null; hook?: SoundLite | null };
	/** A free SFX lane id, or null (then one is added). */
	sfxLane?: string | null;
	sfxLaneName?: string;
}

/** ops@1 for the plan, in one batch: keyframes per element in time order, text pops, SFX. */
export function retentionOps(plan: RetentionPlan, ctx: OpsContext): { ops: Array<Record<string, unknown>>; notes: string[] } {
	const ops: Array<Record<string, unknown>> = [];
	const notes: string[] = [];
	const author = "claude";
	const byElement = new Map<string, Array<{ move: PlannedMove; index: number }>>();
	plan.moves.forEach((move, index) => {
		if (move.kind === "word_pop") return;
		const list = byElement.get(move.element_id) ?? [];
		list.push({ move, index });
		byElement.set(move.element_id, list);
	});
	for (const [id, list] of byElement) {
		const el = ctx.elements[id];
		if (!el) continue;
		list.sort((a, b) => a.move.t - b.move.t);
		const faced = list.some(({ move, index }) => move.kind === "punch_in" && ctx.faces?.[index]);
		const key = (prop: string, t: number, value: number, ease?: string) => ops.push({ op: "keyframe", author, el: id, prop, t: r3(t), value: Math.round(value * 10000) / 10000, ...(ease ? { ease } : {}) });
		key("scale", el.start, el.scale);
		if (faced) {
			key("x", el.start, el.x);
			key("y", el.start, el.y);
		}
		let face: { x: number; y: number } | null = null;
		for (const { move, index } of list) {
			if (move.kind === "punch_in") {
				const k = move.factor ?? 1.15;
				face = ctx.faces?.[index] ?? null;
				key("scale", move.t, el.scale * k, "hold");
				if (faced) {
					// scaling about the element's centre moves the face from f to p + k (f − p): shift back by (1 − k)(f − p)
					key("x", move.t, face ? el.x + (1 - k) * (face.x - el.x) : el.x, "hold");
					key("y", move.t, face ? el.y + (1 - k) * (face.y - el.y) : el.y, "hold");
				}
			} else {
				key("scale", move.t, el.scale, "hold");
				if (faced) {
					key("x", move.t, el.x, "hold");
					key("y", move.t, el.y, "hold");
				}
			}
		}
	}
	plan.moves.forEach((move, index) => {
		if (move.kind !== "word_pop" || !move.word) return;
		const place = ctx.popPlace?.[index];
		if (place === null) {
			notes.push(`no band clear of the face and the captions at ${move.t} s: the word pop "${clean(move.word.text)}" was left out`);
			return;
		}
		ops.push({
			op: "text_pop",
			author,
			t: move.t,
			text: clean(move.word.text).toUpperCase(),
			dur: move.dur ?? 1,
			style: { size: place?.size ?? 8, weight: "bold", color: "#ffffff", align: "center", uppercase: true, ...(place ? { y: Math.round(place.y) } : {}) },
		});
	});
	// SFX: one lane for all of them (they are ≥ 0.45 s apart; the pack's punch and pop sounds are ≤ 0.45 s)
	const sounds = ctx.sounds ?? {};
	const sfx: Array<{ sound: SoundLite; at: number; name: string }> = [];
	plan.moves.forEach((move) => {
		const sound = move.kind === "punch_in" ? (move.for === "hook" ? (sounds.hook ?? sounds.punch) : sounds.punch) : move.kind === "word_pop" ? sounds.pop : null;
		if (sound) sfx.push({ sound, at: move.t, name: `SFX ${sound.id} · retention ${move.kind === "word_pop" ? "word pop" : "punch-in"}` });
	});
	if (sfx.length) {
		let lane = ctx.sfxLane ?? null;
		if (!lane) {
			ops.push({ op: "add_track", author, kind: "audio", name: ctx.sfxLaneName ?? "SFX", ref: "retention-sfx" });
			lane = "retention-sfx";
		}
		let lastEnd = -1;
		sfx.forEach(({ sound, at, name }, i) => {
			const t = Math.max(0, r3(at - sound.sync_s));
			if (t < lastEnd - 1e-6) {
				notes.push(`${name} at ${at} s would overlap the sound before it: left out`);
				return;
			}
			ops.push({ op: "sfx", author, t, name, url: sound.url, dur: sound.duration_s, track: lane, ref: `retention-sfx-${i}` });
			ops.push({ op: "gain", author, el: `retention-sfx-${i}`, db: Math.round((sound.default_db - 2) * 10) / 10 });
			lastEnd = t + sound.duration_s;
		});
	}
	return { ops, notes };
}

/** One line per move, for answers and commit messages: `punch-in on "eighteen" at 9.40 s`. */
export function describeMove(move: PlannedMove): string {
	const name = move.kind === "punch_in" ? "punch-in" : move.kind === "punch_out" ? "punch back out" : "word pop";
	return `${name}${move.word ? ` on "${clean(move.word.text)}"` : ""} at ${move.t.toFixed(2)} s`;
}
