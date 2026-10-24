/**
 * The picture as the viewer sees it changing (gate-v2, 2026-10-20) — what R1 / R5 / R6 count and FLASH reads, instead
 * of "clips" (the old shotMap counted any top-most clip as a shot: a transparent table-of-contents overlay hid 17
 * effects; 8 scenes inside 6 compositions were 6 shots; 2 s paper-texture loops were "shots").
 *
 * - The BASE picture at time t is the top-most element that covers the frame: anything on the main track; an overlay
 *   video/image only when it is opaque (no alpha in the media, opacity 1, normal blend, scale ≥ 0.98); a composition
 *   only when it is opaque (declared, or measured on its own render); never a person cut-out.
 * - A CUT is a change of base element — except a continuation (the same media continuing frame-exact with the same
 *   framing: a split that changes nothing), unless the second part carries a transition.
 * - A SCENE is a scene boundary inside a composition that is the base picture (declared `scenes`, or the server's
 *   frame diff of the composition's own render).
 * - An EFFECT is the start of an applied effect (`element.restorff.effect`; its layers count once).
 * - A BEAT (only where the piece's profile counts them: talking heads, explainers) is an overlay entering: a
 *   composition, a text pop, a picture-in-picture, or a scene inside an overlay composition.
 * Pure; ticks in, seconds out.
 */
import { compositionFacts, localToTimeline, storedComposition, type ManifestLike } from "./compositions.ts";
import { elEnd, elStart, hasMoveAnimation, ticksToSeconds, videoElements, type PlacedElement } from "./project.ts";
import type { CompositionFacts, GateElement, GateScene, GateTrack, MediaInfo } from "./types.ts";

export type ChangeKind = "cut" | "scene" | "effect" | "transition" | "beat";

export interface Change {
	t: number;
	kind: ChangeKind;
	el: GateElement;
	track: GateTrack;
	isMain: boolean;
	what: string;
}

export interface BaseRun {
	t: number;
	t_end: number;
	el: GateElement;
	track: GateTrack;
	isMain: boolean;
}

export interface PictureShot {
	t: number;
	t_end: number;
	/** The base element under the shot (or the element whose change opened it when there is no base). */
	el: GateElement;
	track: GateTrack;
	isMain: boolean;
	/** The shot has a camera move: a transform keyframe on its base, or its base is an (animated) composition. */
	moving: boolean;
	/** What opened the shot. */
	opened: ChangeKind | "start";
}

export interface ChangeMap {
	runtime: number;
	base: BaseRun[];
	changes: Change[];
	shots: PictureShot[];
	counts: Record<ChangeKind, number>;
	/** Base runs that last 1..maxFrames frames between other pictures (timeline FLASH). */
	flashes: Array<BaseRun & { frames: number }>;
}

export interface ChangeOptions {
	fps: number;
	beats: boolean;
	media?: Record<string, MediaInfo>;
	compositions?: Record<string, CompositionFacts>;
	libraryManifests?: Record<string, ManifestLike>;
	maxFlashFrames?: number;
}

function num(v: unknown, d: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : d;
}

function tag(el: GateElement): Record<string, unknown> {
	return (el.restorff ?? {}) as Record<string, unknown>;
}

export function isCutout(el: GateElement): boolean {
	return Boolean(tag(el).cutout);
}

export function effectOf(el: GateElement): { id?: string; name?: string; side?: string } | null {
	const e = tag(el).effect;
	return e && typeof e === "object" ? (e as { id?: string; name?: string; side?: string }) : null;
}

/** Does this placed picture element hide everything under it? */
export function covers(p: PlacedElement, opts: Pick<ChangeOptions, "media" | "compositions" | "libraryManifests">): boolean {
	if (p.isMain) return true;
	const el = p.el;
	if (isCutout(el)) return false;
	const params = el.params ?? {};
	if (num(params.opacity, 1) < 0.99) return false;
	if (typeof params.blendMode === "string" && params.blendMode !== "normal") return false;
	if (Math.abs(num(params["transform.scaleX"], 1)) < 0.98 || Math.abs(num(params["transform.scaleY"], 1)) < 0.98) return false;
	if (storedComposition(el)) {
		const facts = compositionFacts(el, opts.compositions, opts.libraryManifests?.[String(storedComposition(el)?.name ?? "")]);
		return facts?.opaque === true;
	}
	const info = opts.media?.[el.mediaId ?? ""];
	if (info?.alpha === true) return false;
	if (info?.alpha === false) return true;
	// ASSUMPTION: an overlay video of unknown alpha covers the frame; an overlay image of unknown alpha does not
	// (PNG cut-outs and plates are common; a full-frame still belongs on the main track).
	return el.type === "video";
}

const sourceAt = (el: GateElement, t: number) => ((el.trimStart ?? 0) + (t - elStart(el)) * 120_000 * (el.retime?.rate || 1)) / 120_000;

function sameFraming(a: GateElement, b: GateElement): boolean {
	const keys = ["transform.scaleX", "transform.scaleY", "transform.positionX", "transform.positionY", "transform.rotate"];
	return keys.every((k) => Math.abs(num(a.params?.[k], k.includes("scale") ? 1 : 0) - num(b.params?.[k], k.includes("scale") ? 1 : 0)) < 1e-3);
}

/** b continues a frame-exact from where a ends (a split that changes nothing on screen). */
export function continues(a: GateElement, b: GateElement, fps: number): boolean {
	if (!a.mediaId || a.mediaId !== b.mediaId || a.type !== b.type) return false;
	if ((b as { transitionIn?: unknown }).transitionIn) return false;
	if (Math.abs(elEnd(a) - elStart(b)) > 1 / fps) return false;
	if ((a.retime?.rate || 1) !== (b.retime?.rate || 1)) return false;
	const endA = sourceAt(a, elEnd(a));
	const startB = ticksToSeconds(b.trimStart ?? 0);
	return Math.abs(endA - startB) <= 1.5 / fps && sameFraming(a, b);
}

/** Base runs: at every moment, the top-most covering picture element. */
export function baseRuns(scene: GateScene, runtime: number, opts: ChangeOptions): BaseRun[] {
	const vids = videoElements(scene).filter((p) => covers(p, opts));
	const points = new Set<number>([0, runtime]);
	for (const { el } of vids) {
		points.add(Math.max(0, Math.min(runtime, elStart(el))));
		points.add(Math.max(0, Math.min(runtime, elEnd(el))));
	}
	const sorted = [...points].sort((a, b) => a - b);
	const runs: BaseRun[] = [];
	for (let i = 0; i < sorted.length - 1; i++) {
		const a = sorted[i];
		const b = sorted[i + 1];
		if (b - a <= 1e-9) continue;
		const mid = (a + b) / 2;
		let top: PlacedElement | null = null;
		for (const v of vids) if (elStart(v.el) <= mid && mid < elEnd(v.el) && (!top || v.order < top.order)) top = v;
		if (!top) continue;
		const last = runs[runs.length - 1];
		if (last && last.el.id === top.el.id && Math.abs(last.t_end - a) < 1e-9) last.t_end = b;
		else runs.push({ t: a, t_end: b, el: top.el, track: top.track, isMain: top.isMain });
	}
	return runs;
}

const KIND_RANK: Record<ChangeKind, number> = { cut: 0, scene: 1, effect: 2, transition: 3, beat: 4 };

export function changeMap(scene: GateScene, runtime: number, opts: ChangeOptions): ChangeMap {
	const fps = opts.fps || 30;
	const frame = 1 / fps;
	const base = baseRuns(scene, runtime, opts);
	const raw: Change[] = [];

	// cuts (base changes), transitions on continuations
	for (let i = 1; i < base.length; i++) {
		const prev = base[i - 1];
		const run = base[i];
		const adjacent = Math.abs(prev.t_end - run.t) < 1e-6;
		if (adjacent && continues(prev.el, run.el, fps)) continue;
		raw.push({ t: run.t, kind: "cut", el: run.el, track: run.track, isMain: run.isMain, what: `cut to ${run.el.name ?? run.el.id}` });
	}
	if (base.length && base[0].t > 1e-6) {
		const first = base[0];
		raw.push({ t: first.t, kind: "cut", el: first.el, track: first.track, isMain: first.isMain, what: `picture starts: ${first.el.name ?? first.el.id}` });
	}
	for (const { el, track, isMain } of videoElements(scene)) {
		const tr = (el as { transitionIn?: { type?: string } }).transitionIn;
		if (tr && elStart(el) > 1e-6) raw.push({ t: elStart(el), kind: "transition", el, track, isMain, what: `${tr.type ?? "transition"} into ${el.name ?? el.id}` });
	}

	// scenes inside compositions: on the base picture always; inside overlays only where beats count
	const placed = videoElements(scene);
	const coveringIds = new Set(placed.filter((p) => covers(p, opts)).map((p) => p.el.id));
	for (const p of placed) {
		const comp = storedComposition(p.el);
		if (!comp) continue;
		const facts = compositionFacts(p.el, opts.compositions, opts.libraryManifests?.[String(comp.name ?? "")]);
		if (!facts?.scenes?.length) continue;
		const isBase = coveringIds.has(p.el.id);
		if (!isBase && !opts.beats) continue;
		for (const local of facts.scenes) {
			const t = localToTimeline(p.el, local);
			if (t === null) continue;
			// a scene of a base composition counts only while that composition is the base picture
			if (isBase && !base.some((r) => r.el.id === p.el.id && r.t <= t && t < r.t_end)) continue;
			raw.push({ t, kind: isBase ? "scene" : "beat", el: p.el, track: p.track, isMain: p.isMain, what: `scene in ${facts.name}` });
		}
	}

	// effects (all layers of one effect count once)
	const allPlaced: PlacedElement[] = [];
	scene.tracks.overlay.forEach((track, order) => {
		if (track.hidden) return;
		for (const el of track.elements) if (!el.hidden) allPlaced.push({ track, el, order, isMain: false });
	});
	if (scene.tracks.main && !scene.tracks.main.hidden) for (const el of scene.tracks.main.elements) allPlaced.push({ track: scene.tracks.main, el, order: scene.tracks.overlay.length, isMain: true });
	for (const p of allPlaced) {
		const fx = effectOf(p.el);
		if (!fx) continue;
		raw.push({ t: elStart(p.el), kind: "effect", el: p.el, track: p.track, isMain: p.isMain, what: `effect ${fx.name ?? fx.id ?? p.el.name ?? ""}`.trim() });
	}

	// beats: overlays entering (profile-dependent)
	if (opts.beats) {
		for (const p of allPlaced) {
			if (p.isMain || coveringIds.has(p.el.id) || effectOf(p.el) || isCutout(p.el)) continue;
			const role = tag(p.el).role;
			const isPop = p.el.type === "text" && role === "text_pop";
			const isOverlayPicture = (p.el.type === "video" || p.el.type === "image") && p.track.type === "video";
			if (!isPop && !isOverlayPicture) continue;
			raw.push({ t: elStart(p.el), kind: "beat", el: p.el, track: p.track, isMain: false, what: `${p.el.name ?? p.el.id} enters` });
		}
	}

	// merge changes within 2 frames (the strongest kind wins), drop t = 0 and ≥ runtime
	const sortedRaw = raw.filter((c) => c.t > frame / 2 && c.t < runtime - frame / 2).sort((a, b) => a.t - b.t || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
	const changes: Change[] = [];
	for (const c of sortedRaw) {
		const last = changes[changes.length - 1];
		if (last && c.t - last.t < 2 * frame + 1e-9) {
			if (KIND_RANK[c.kind] < KIND_RANK[last.kind]) changes[changes.length - 1] = { ...c, t: last.t };
			continue;
		}
		changes.push(c);
	}

	// shots: intervals between changes
	const bounds = [0, ...changes.map((c) => c.t), runtime];
	const shots: PictureShot[] = [];
	const baseAt = (t: number) => base.find((r) => r.t <= t + 1e-9 && t < r.t_end - 1e-9) ?? null;
	for (let i = 0; i < bounds.length - 1; i++) {
		const t = bounds[i];
		const t_end = bounds[i + 1];
		if (t_end - t <= 1e-9) continue;
		const opener = i === 0 ? null : changes[i - 1];
		const under = baseAt((t + t_end) / 2) ?? baseAt(t);
		const el = under?.el ?? opener?.el;
		if (!el) continue;
		const track = under?.track ?? (opener as Change).track;
		const moving = Boolean(under && (hasMoveAnimation(under.el) || storedComposition(under.el)));
		shots.push({ t, t_end, el, track, isMain: under?.isMain ?? opener?.isMain ?? true, moving, opened: opener?.kind ?? "start" });
	}

	// timeline flashes: a base run of 1..max frames between other pictures, not a continuation, not marked as designed
	const maxF = opts.maxFlashFrames ?? 3;
	const flashes: ChangeMap["flashes"] = [];
	for (let i = 0; i < base.length; i++) {
		const run = base[i];
		const frames = Math.round((run.t_end - run.t) * fps);
		if (frames < 1 || frames > maxF) continue;
		const prev = base[i - 1];
		const next = base[i + 1];
		if (!prev && !next) continue;
		const designed = Boolean(tag(run.el).flash || tag(run.el).intentional);
		if (designed) continue;
		if (prev && Math.abs(prev.t_end - run.t) < 1e-6 && continues(prev.el, run.el, fps)) continue;
		if (next && Math.abs(run.t_end - next.t) < 1e-6 && continues(run.el, next.el, fps)) continue;
		flashes.push({ ...run, frames });
	}

	const counts: Record<ChangeKind, number> = { cut: 0, scene: 0, effect: 0, transition: 0, beat: 0 };
	for (const c of changes) counts[c.kind]++;
	return { runtime, base, changes, shots, counts, flashes };
}
