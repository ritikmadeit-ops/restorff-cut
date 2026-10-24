/**
 * "Design the sound" — the owner's rule as a pure planner (sounds agent, 2026-10-20).
 *
 * Owner, 2026-10-19: *"video is 50% audio, so good music, perfect sync and soundeffects is a must."* README "Sound is
 * half the ad" item 2: a designed sound on every shot (R23), SFX from a named library placed on the visual event.
 *
 * `designSound(project, library)` reads the open scene and returns ops@1 (`add_track`, `sfx`, `gain`, `keyframe`) that
 * the reducer applies like any other batch:
 *   - a HIT at 0.0 s (EXPORT-GATE R4) and another where the hook ends (the riser resolves into it);
 *   - a RISER whose peak lands on the end of the hook;
 *   - a WHOOSH on every cut and transition between shots (main track, and B-roll in / out), its peak on the cut;
 *   - a POP on every text / graphic coming in (captions excluded);
 *   - optionally (off by default) a TICK on every caption chunk change;
 *   - never two SFX events closer than `minGap` (0.25 s): higher priority wins (hit > riser > whoosh > pop > tick);
 *   - every SFX element NAMED "SFX <sound> · <why>" so the timeline check R23 can see what covers a shot;
 *   - the music ducked lightly (default 3 dB) under the louder SFX, with new volume keys only — spans where the music
 *     already has volume keys (e.g. ducked under the voice) are left alone.
 * Re-running: `withoutPreviousDesign(project)` removes the elements and duck keys a previous run made (marked by
 * `markDesign` after apply), so a second press replaces the design instead of stacking it.
 *
 * The library is passed in (apps/web/public/sfx/manifest.json in the editor), so this file stays pure: no fetch, no
 * filesystem, no apps/web imports. Tests: test/sound-design.test.ts.
 */
import type { Author, Project, ScalarChannel, Scene, TimelineElement, TimelineTrack } from "./model.ts";
import type { ApplyResult } from "./reducer.ts";
import type { AddTrackOp, GainOp, KeyframeOp, Op, SfxOp } from "./ops.ts";
import { TICKS_PER_SECOND } from "./time.ts";

export const SOUND_DESIGN_VERSION = "sound-design@1";

/** One sound of a library (the fields of manifest.json's `sounds[]` the planner needs). */
export interface SfxLibraryEntry {
	id: string;
	name: string;
	url: string;
	duration_s: number;
	category: string;
	roles: string[];
	/** Seconds into the file where its event is (peak of a whoosh / riser, attack of a hit / pop). */
	sync_s: number;
	/** Suggested element volume, dB. */
	default_db: number;
	tags?: string[];
}

export type DesignKind = "hit" | "riser" | "whoosh" | "pop" | "tick";

export interface SoundDesignOptions {
	/** Minimum seconds between two SFX events. Default 0.25. */
	minGap?: number;
	hitAtStart?: boolean;
	whooshOnCuts?: boolean;
	popOnText?: boolean;
	riserIntoHook?: boolean;
	/** Where the hook ends, seconds. Default: the cut nearest 3.0 s within 2.0–4.5 s, else 3.0 s. */
	hookEnd?: number;
	/** A tick on every caption chunk. Default false (it gets busy fast). */
	captionTicks?: boolean;
	/** Duck the music lightly under the SFX. Default true. */
	duck?: boolean;
	/** How far to duck, dB. Default 3. */
	duckDb?: number;
	author?: Author;
	/** Preferred sound per kind (library ids); defaults below. */
	sounds?: Partial<Record<DesignKind | "hook_hit" | "cut_alt" | "transition", string>>;
}

export interface PlannedSfx {
	kind: DesignKind;
	sound: string;
	/** Element name, e.g. "SFX whoosh-short · cut to S04 pour". */
	name: string;
	/** Element start, timeline seconds. */
	t: number;
	/** Where the sound's event lands, timeline seconds. */
	event: number;
	dur: number;
	db: number;
	reason: string;
	/** Track id, or the ref of a lane this plan adds. */
	lane: string;
}

export interface DroppedSfx {
	kind: DesignKind;
	event: number;
	reason: string;
}

export interface SoundDesignPlan {
	ops: Op[];
	placed: PlannedSfx[];
	dropped: DroppedSfx[];
	counts: Record<DesignKind, number>;
	/** "placed 14 SFX: 6 whoosh, 5 pop, 1 riser, 2 hits" */
	summary: string;
	/** Music element ids that get duck keys. */
	ducked: string[];
	hookEnd: number | null;
	notes: string[];
}

const DEFAULT_SOUNDS: Record<DesignKind | "hook_hit" | "cut_alt" | "transition", string> = {
	hit: "impact",
	hook_hit: "sub-hit",
	riser: "riser-2s",
	whoosh: "whoosh-short",
	cut_alt: "swish",
	transition: "whoosh-long",
	pop: "pop",
	tick: "tick",
};

const PRIORITY: Record<DesignKind, number> = { hit: 100, riser: 90, whoosh: 70, pop: 60, tick: 10 };

/** Seconds of music to duck around each kind's event: [before, after]. Ticks are too small to duck for. */
const DUCK_SPAN: Partial<Record<DesignKind, [number, number]>> = {
	hit: [0, 0.4],
	whoosh: [0.1, 0.15],
	pop: [0, 0.1],
	riser: [0.5, 0],
};
const DUCK_ATTACK = 0.03;
const DUCK_RELEASE = 0.2;

const EPSILON = 0.05;

// ---------------------------------------------------------------- reading the timeline

const seconds = (ticks: number) => ticks / TICKS_PER_SECOND;
const endOf = (element: TimelineElement) => element.startTime + element.duration;

type DesignTag = { design?: string; sfxDuckKeys?: string[]; role?: string };
const tagOf = (thing: { restorff?: unknown }): DesignTag => (thing.restorff ?? {}) as DesignTag;

function activeScene(project: Project): Scene {
	return project.scenes.find((scene) => scene.id === project.currentSceneId) ?? project.scenes.find((scene) => scene.isMain) ?? project.scenes[0];
}

function allTracks(scene: Scene): TimelineTrack[] {
	return [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio];
}

export function isSfxTrack(track: TimelineTrack): boolean {
	return track.type === "audio" && (track.restorff?.role === "sfx" || /^SFX\b/i.test(track.name));
}

export function isMusicTrack(track: TimelineTrack): boolean {
	return track.type === "audio" && (track.restorff?.role === "music" || /^MUSIC\b/i.test(track.name));
}

export function isCaptionTrack(track: TimelineTrack): boolean {
	return track.type === "text" && (track.restorff?.role === "caption" || /CAPTION/i.test(track.name));
}

function isHidden(element: TimelineElement): boolean {
	return "hidden" in element && element.hidden === true;
}

function shortName(name: string, max = 24): string {
	const clean = name.trim().replace(/\s+/g, " ");
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

interface VisualCut {
	time: number;
	label: string;
	transition?: { type: string; seconds: number };
}

/** Every visual cut after 0 s: main-track joins, B-roll in and out. */
function findCuts(scene: Scene, end: number): VisualCut[] {
	const cuts: VisualCut[] = [];
	const visual = [scene.tracks.main, ...scene.tracks.overlay.filter((track) => track.type === "video")];
	for (const track of visual) {
		const elements = [...track.elements].filter((element) => !isHidden(element)).sort((a, b) => a.startTime - b.startTime);
		elements.forEach((element, index) => {
			const start = seconds(element.startTime);
			const transition = (element as { transitionIn?: { type: string; duration: number } }).transitionIn;
			if (start > EPSILON) {
				cuts.push({
					time: start,
					label: `cut to ${shortName(element.name)}`,
					transition: transition ? { type: transition.type, seconds: seconds(transition.duration) } : undefined,
				});
			}
			// a B-roll that ends with nothing after it on its track cuts back to what is underneath
			if (track !== scene.tracks.main) {
				const next = elements[index + 1];
				const out = seconds(endOf(element));
				if (out < end - EPSILON && (!next || seconds(next.startTime) - out > EPSILON)) {
					cuts.push({ time: out, label: `back from ${shortName(element.name)}` });
				}
			}
		});
	}
	cuts.sort((a, b) => a.time - b.time);
	const merged: VisualCut[] = [];
	for (const cut of cuts) {
		const last = merged[merged.length - 1];
		if (last && cut.time - last.time < EPSILON) {
			if (!last.transition && cut.transition) last.transition = cut.transition;
			continue;
		}
		merged.push({ ...cut });
	}
	return merged;
}

function projectEnd(scene: Scene): number {
	let end = 0;
	const visual = [scene.tracks.main, ...scene.tracks.overlay];
	for (const track of visual) for (const element of track.elements) end = Math.max(end, seconds(endOf(element)));
	if (end === 0) for (const track of scene.tracks.audio) for (const element of track.elements) end = Math.max(end, seconds(endOf(element)));
	return end;
}

function autoHookEnd(cuts: VisualCut[], end: number): number | null {
	if (end < 2.5) return null;
	const near = cuts.filter((cut) => cut.time >= 2 && cut.time <= 4.5).sort((a, b) => Math.abs(a.time - 3) - Math.abs(b.time - 3));
	if (near.length) return near[0].time;
	return Math.min(3, end);
}

// ---------------------------------------------------------------- previous runs

/** Element ids and duck keys a previous "Design the sound" left (see markDesign). */
export function previousDesign(project: Project): { elements: string[]; duckKeys: number } {
	const scene = activeScene(project);
	const elements: string[] = [];
	let duckKeys = 0;
	for (const track of allTracks(scene)) {
		for (const element of track.elements) {
			const tag = tagOf(element);
			if (tag.design === SOUND_DESIGN_VERSION) elements.push(element.id);
			duckKeys += tag.sfxDuckKeys?.length ?? 0;
		}
	}
	return { elements, duckKeys };
}

/**
 * A copy of the project without what a previous run placed: its SFX elements and the volume keys it added to the
 * music. Everything else is untouched.
 */
export function withoutPreviousDesign(project: Project): Project {
	const next = structuredClone(project);
	const scene = activeScene(next);
	const strip = <T extends TimelineTrack>(track: T): T => {
		const elements = (track.elements as TimelineElement[])
			.filter((element) => tagOf(element).design !== SOUND_DESIGN_VERSION)
			.map((element) => {
				const tag = tagOf(element);
				if (!tag.sfxDuckKeys?.length) return element;
				const drop = new Set(tag.sfxDuckKeys);
				const animations = { ...(element.animations ?? {}) };
				const channel = animations.volume as ScalarChannel | undefined;
				if (channel?.keys) {
					const keys = channel.keys.filter((key) => !drop.has(key.id));
					if (keys.length) animations.volume = { ...channel, keys };
					else delete animations.volume;
				}
				const { sfxDuckKeys: _keys, ...restorff } = tag;
				const cleaned = { ...element, restorff: Object.keys(restorff).length ? restorff : undefined } as TimelineElement & {
					restorff?: unknown;
				};
				if (Object.keys(animations).length) cleaned.animations = animations;
				else delete cleaned.animations;
				if (cleaned.restorff === undefined) delete cleaned.restorff;
				return cleaned as TimelineElement;
			});
		return { ...track, elements } as T;
	};
	scene.tracks = {
		overlay: scene.tracks.overlay.map(strip),
		main: strip(scene.tracks.main),
		// lanes a previous run added go too, once they are empty
		audio: scene.tracks.audio
			.map(strip)
			.filter((track) => !(tagOf(track).design === SOUND_DESIGN_VERSION && track.elements.length === 0)),
	};
	return next;
}

/**
 * After `apply(project, plan.ops)`: mark the SFX elements this plan created (restorff.design) and record the volume
 * keys it added to the music (restorff.sfxDuckKeys), so the next run can replace them. Mutates and returns
 * `result.project`.
 */
export function markDesign(result: ApplyResult): Project {
	const created = new Set<string>();
	const lanes = new Set<string>();
	const keysByElement = new Map<string, string[]>();
	for (const change of result.changes.ops) {
		if (change.status !== "applied") continue;
		if (change.op === "sfx") for (const id of change.created?.elements ?? []) created.add(id);
		if (change.op === "add_track") for (const id of change.created?.tracks ?? []) lanes.add(id);
		if (change.op === "keyframe") {
			const element = change.updated?.[0];
			if (element) keysByElement.set(element, [...(keysByElement.get(element) ?? []), ...(change.created?.keyframes ?? [])]);
		}
	}
	const scene = activeScene(result.project);
	for (const track of allTracks(scene)) {
		if (lanes.has(track.id)) {
			(track as { restorff?: unknown }).restorff = { ...tagOf(track), role: "sfx", design: SOUND_DESIGN_VERSION };
		}
		for (const element of track.elements as Array<{ id: string; restorff?: unknown }>) {
			if (created.has(element.id)) element.restorff = { ...tagOf(element), design: SOUND_DESIGN_VERSION };
			const keys = keysByElement.get(element.id);
			if (keys?.length) {
				const tag = tagOf(element);
				element.restorff = { ...tag, sfxDuckKeys: [...(tag.sfxDuckKeys ?? []), ...keys] };
			}
		}
	}
	return result.project;
}

// ---------------------------------------------------------------- the plan

interface Candidate {
	kind: DesignKind;
	sound: SfxLibraryEntry;
	/** The time the 0.25 s rule is checked at: where the sound is heard (its event), never its silent start. */
	spacingAt: number;
	event: number;
	t: number;
	reason: string;
	/**
	 * Sounds that make ONE gesture (the riser and the hit it resolves into) share a group and may share an event;
	 * the 0.25 s rule applies between gestures. (2026-10-20: spacing a riser on its near-silent start blocked a cut
	 * whoosh 1.8 s before the hook's end — caught on the real manifest.)
	 */
	group?: string;
}

function pickSound(library: SfxLibraryEntry[], preferred: string, role: string): SfxLibraryEntry | undefined {
	return library.find((entry) => entry.id === preferred) ?? library.find((entry) => entry.roles.includes(role));
}

function candidateAt(kind: DesignKind, sound: SfxLibraryEntry, event: number, reason: string, group?: string): Candidate {
	const t = Math.max(0, event - sound.sync_s);
	return { kind, sound, event: t + sound.sync_s, t, spacingAt: t + sound.sync_s, reason, group };
}

/** Linear read of a music element's volume (dB) at a timeline time: its keys if it has any, else its static level. */
function volumeAt(element: TimelineElement, time: number): number {
	const base = typeof element.params.volume === "number" ? element.params.volume : 0;
	const channel = element.animations?.volume as ScalarChannel | undefined;
	const keys = channel?.keys;
	if (!keys?.length) return base;
	const local = time * TICKS_PER_SECOND - element.startTime;
	if (local <= keys[0].time) return keys[0].value;
	for (let i = 0; i < keys.length - 1; i++) {
		const a = keys[i];
		const b = keys[i + 1];
		if (local >= a.time && local <= b.time) {
			if (a.segmentToNext === "step" || b.time === a.time) return a.value;
			return a.value + ((local - a.time) / (b.time - a.time)) * (b.value - a.value);
		}
	}
	return keys[keys.length - 1].value;
}

function plural(count: number, word: string): string {
	if (count === 1) return `1 ${word}`;
	return `${count} ${word === "whoosh" ? "whoosh" : `${word}s`}`;
}

export function summarize(counts: Record<DesignKind, number>): string {
	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
	if (!total) return "placed 0 SFX";
	const order: DesignKind[] = ["whoosh", "pop", "riser", "hit", "tick"];
	const parts = order.filter((kind) => counts[kind] > 0).map((kind) => plural(counts[kind], kind));
	return `placed ${total} SFX: ${parts.join(", ")}`;
}

export function designSound(project: Project, library: SfxLibraryEntry[], options: SoundDesignOptions = {}): SoundDesignPlan {
	const minGap = options.minGap ?? 0.25;
	const author: Author = options.author ?? "user";
	const prefer = { ...DEFAULT_SOUNDS, ...(options.sounds ?? {}) };
	const scene = activeScene(project);
	const end = projectEnd(scene);
	const notes: string[] = [];
	const dropped: DroppedSfx[] = [];
	const counts: Record<DesignKind, number> = { hit: 0, riser: 0, whoosh: 0, pop: 0, tick: 0 };
	const empty = (why: string): SoundDesignPlan => ({
		ops: [],
		placed: [],
		dropped,
		counts,
		summary: summarize(counts),
		ducked: [],
		hookEnd: null,
		notes: [...notes, why],
	});
	if (end <= 0) return empty("the timeline is empty: nothing to design");
	if (!library.length) return empty("the SFX library is empty");

	const cuts = findCuts(scene, end);
	const hookEnd = options.riserIntoHook === false && options.hookEnd === undefined ? null : (options.hookEnd ?? autoHookEnd(cuts, end));
	const candidates: Candidate[] = [];
	const want = (kind: DesignKind, preferred: string, role: string) => {
		const sound = pickSound(library, preferred, role);
		if (!sound) notes.push(`no "${role}" sound in the library: ${kind} skipped`);
		return sound;
	};

	// 1. hits: frame 1 (R4) and the end of the hook
	if (options.hitAtStart !== false) {
		const sound = want("hit", prefer.hit, "hit");
		if (sound) candidates.push(candidateAt("hit", sound, 0, "hook opens on a hit (R4)"));
	}
	if (hookEnd !== null && options.riserIntoHook !== false) {
		const hit = want("hit", prefer.hook_hit, "hit");
		if (hit && hookEnd > minGap) candidates.push(candidateAt("hit", hit, hookEnd, "end of the hook", "hook-end"));
		// 2. the riser: the longest hook riser whose start leaves room after the opening hit
		const risers = library
			.filter((entry) => entry.roles.includes("hook_riser") && entry.category === "riser" && entry.id !== "reverse-swell")
			.sort((a, b) => b.sync_s - a.sync_s);
		const preferred = library.find((entry) => entry.id === prefer.riser);
		const ordered = preferred ? [preferred, ...risers.filter((entry) => entry.id !== preferred.id)] : risers;
		const riser = ordered.find((entry) => hookEnd - entry.sync_s >= minGap);
		if (riser) candidates.push(candidateAt("riser", riser, hookEnd, "builds into the end of the hook", "hook-end"));
		else if (ordered.length) notes.push(`the hook ends at ${hookEnd.toFixed(2)} s: too short for a riser`);
	}

	// 3. whooshes on cuts and transitions
	if (options.whooshOnCuts !== false) {
		const main = want("whoosh", prefer.whoosh, "cut");
		const alt = pickSound(library, prefer.cut_alt, "cut") ?? main;
		const long = pickSound(library, prefer.transition, "transition") ?? main;
		let alternate = false;
		for (const cut of cuts) {
			if (!main) break;
			let sound = main;
			let reason = cut.label;
			if (cut.transition) {
				sound = cut.transition.seconds >= 0.4 && long ? long : main;
				reason = `${cut.transition.type} ${cut.label}`;
			} else {
				sound = alternate && alt ? alt : main;
				alternate = !alternate;
			}
			candidates.push(candidateAt("whoosh", sound, cut.time, reason));
		}
	}

	// 4. pops on text / graphics coming in; 5. ticks on caption chunks (opt-in)
	const pop = options.popOnText !== false ? want("pop", prefer.pop, "text_in") : undefined;
	const tick = options.captionTicks ? want("tick", prefer.tick, "caption_tick") : undefined;
	for (const track of scene.tracks.overlay) {
		if (track.type !== "text" && track.type !== "graphic") continue;
		const captions = isCaptionTrack(track);
		for (const element of track.elements) {
			if (isHidden(element)) continue;
			const at = seconds(element.startTime);
			const caption = captions || tagOf(element).role === "caption";
			if (caption) {
				if (tick) candidates.push(candidateAt("tick", tick, at, `caption "${shortName(String(element.params.content ?? element.name), 16)}"`));
			} else if (pop) {
				const label = element.type === "text" ? String(element.params.content ?? element.name) : element.name;
				candidates.push(candidateAt("pop", pop, at, `"${shortName(label, 18)}" in`));
			}
		}
	}

	// 6. the 0.25 s rule, against each other and against SFX already on the timeline (not from a previous run)
	const taken: number[] = [];
	const sfxLanes = scene.tracks.audio.filter(isSfxTrack);
	for (const track of sfxLanes) {
		for (const element of track.elements) {
			if (tagOf(element).design === SOUND_DESIGN_VERSION) continue;
			const url = (element as { sourceUrl?: string }).sourceUrl;
			const known = url ? library.find((entry) => entry.url === url) : undefined;
			taken.push(seconds(element.startTime) + (known?.sync_s ?? 0));
		}
	}
	const accepted: Candidate[] = [];
	const ranked = [...candidates].sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind] || a.spacingAt - b.spacingAt);
	for (const candidate of ranked) {
		const others = accepted.filter((other) => !candidate.group || other.group !== candidate.group);
		const clash = [...taken, ...others.map((other) => other.spacingAt)].find(
			(time) => Math.abs(time - candidate.spacingAt) < minGap - 1e-9,
		);
		if (clash !== undefined) {
			dropped.push({
				kind: candidate.kind,
				event: candidate.event,
				reason: `within ${minGap} s of another SFX at ${clash.toFixed(2)} s (${candidate.reason})`,
			});
			continue;
		}
		if (candidate.t >= end - EPSILON) {
			dropped.push({ kind: candidate.kind, event: candidate.event, reason: "after the end of the cut" });
			continue;
		}
		accepted.push(candidate);
	}
	accepted.sort((a, b) => a.t - b.t || PRIORITY[b.kind] - PRIORITY[a.kind]);

	// 7. lanes: existing SFX tracks first, a new lane only when every one overlaps
	const ops: Op[] = [];
	const lanes = sfxLanes.map((track) => ({
		id: track.id,
		busy: track.elements
			.filter((element) => tagOf(element).design !== SOUND_DESIGN_VERSION)
			.map((element) => [seconds(element.startTime), seconds(endOf(element))] as [number, number]),
	}));
	const placed: PlannedSfx[] = [];
	accepted.forEach((candidate, index) => {
		const dur = Math.min(candidate.sound.duration_s, Math.max(0, end - candidate.t));
		if (dur < 0.05) {
			dropped.push({ kind: candidate.kind, event: candidate.event, reason: "less than 0.05 s left before the end" });
			return;
		}
		const span: [number, number] = [candidate.t, candidate.t + dur];
		let lane = lanes.find((candidateLane) => candidateLane.busy.every(([a, b]) => span[1] <= a + 1e-6 || span[0] >= b - 1e-6));
		if (!lane) {
			const ref = `sfx-lane-${lanes.length + 1}`;
			const name = lanes.length === 0 ? "SFX" : `SFX ${lanes.length + 1}`;
			const add: AddTrackOp = { op: "add_track", author, kind: "audio", name, ref, note: SOUND_DESIGN_VERSION };
			ops.push(add);
			lane = { id: ref, busy: [] };
			lanes.push(lane);
		}
		lane.busy.push(span);
		const ref = `sfx-${index + 1}`;
		const name = `SFX ${candidate.sound.id} · ${candidate.reason}`;
		const sfx: SfxOp = {
			op: "sfx",
			author,
			t: round(candidate.t),
			name,
			url: candidate.sound.url,
			dur: round(dur),
			track: lane.id,
			ref,
			note: SOUND_DESIGN_VERSION,
		};
		const level: GainOp = { op: "gain", author, el: ref, db: candidate.sound.default_db };
		ops.push(sfx, level);
		counts[candidate.kind] += 1;
		placed.push({
			kind: candidate.kind,
			sound: candidate.sound.id,
			name,
			t: round(candidate.t),
			event: round(candidate.event),
			dur: round(dur),
			db: candidate.sound.default_db,
			reason: candidate.reason,
			lane: lane.id,
		});
	});

	// 8. a light duck of the music under the louder SFX
	const ducked: string[] = [];
	if (options.duck !== false && placed.length) {
		const amount = Math.abs(options.duckDb ?? 3);
		const spans: Array<[number, number]> = [];
		for (const item of placed) {
			const around = DUCK_SPAN[item.kind];
			if (!around) continue;
			spans.push([Math.max(0, item.event - around[0]), item.event + around[1]]);
		}
		spans.sort((a, b) => a[0] - b[0]);
		const merged: Array<[number, number]> = [];
		for (const span of spans) {
			const last = merged[merged.length - 1];
			if (last && span[0] - last[1] < DUCK_ATTACK + DUCK_RELEASE) last[1] = Math.max(last[1], span[1]);
			else merged.push([...span]);
		}
		const music = scene.tracks.audio.filter(isMusicTrack);
		if (!music.length) notes.push("no MUSIC track: nothing to duck");
		let skipped = 0;
		for (const track of music) {
			for (const element of track.elements) {
				if (element.params.muted === true) continue;
				const start = seconds(element.startTime);
				const stop = seconds(endOf(element));
				const existing = ((element.animations?.volume as ScalarChannel | undefined)?.keys ?? []).map(
					(key) => seconds(element.startTime + key.time),
				);
				let wrote = false;
				for (const [a, b] of merged) {
					const from = Math.max(start, a - DUCK_ATTACK);
					const to = Math.min(stop, b + DUCK_RELEASE);
					if (to - from < 0.05) continue;
					if (existing.some((time) => time >= from - 1e-6 && time <= to + 1e-6)) {
						skipped += 1;
						continue;
					}
					const points: Array<[number, number]> = [
						[from, volumeAt(element, from)],
						[Math.min(to, Math.max(from, a)), volumeAt(element, a) - amount],
						[Math.max(from, Math.min(to, b)), volumeAt(element, b) - amount],
						[to, volumeAt(element, to)],
					];
					let last = -1;
					for (const [time, value] of points) {
						if (time <= last + 1e-6) continue;
						last = time;
						const key: KeyframeOp = {
							op: "keyframe",
							author,
							el: element.id,
							prop: "volume",
							t: round(time),
							value: Math.round(value * 100) / 100,
							note: SOUND_DESIGN_VERSION,
						};
						ops.push(key);
					}
					wrote = true;
				}
				if (wrote) ducked.push(element.id);
			}
		}
		if (skipped) notes.push(`${skipped} duck span(s) left alone: the music already has volume keys there (e.g. ducked under the voice)`);
	}

	if (hookEnd !== null) notes.push(`hook ends at ${hookEnd.toFixed(2)} s`);
	if (dropped.length) notes.push(`${dropped.length} SFX dropped by the ${minGap} s rule or the end of the cut`);
	return { ops, placed, dropped, counts, summary: summarize(counts), ducked, hookEnd, notes };
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}
