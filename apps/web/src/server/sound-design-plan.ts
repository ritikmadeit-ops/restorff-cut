/**
 * "Design the sound" v2 — the planner (sound-voice-v2 agent, 2026-10-20; recreations SUMMARY gap 7, paper-collage
 * REPORT §6.3, neon-grid G-8). Pure: no Node imports (the cue reader ./sound-design-cues.ts does the disk + ffmpeg).
 *
 * What changed from v1 (packages/timeline-ops/src/sound-design.ts, still the editor button's planner):
 *   - REAL cuts only. A clip that follows itself on its track (the explainer's 2 s paper loop) is a loop SEAM, not a
 *     cut; a texture overlay (opacity < 0.6, a blend mode, a texture/grain composition) has no cuts at all; a graphic
 *     composition over the video (its first frame covers < 90 %) or a small picture-in-picture "appears" (a pop or its
 *     cues), it does not cut; a split that carries on the same shot is not a cut. Every skipped edge is reported.
 *   - Hits land ON the cut: the default cut sounds (Whoosh hit, Swish hit, Paper slide) rise into a transient whose
 *     loudest moment is the sound's sync point, placed on the cut (0 ms); a whoosh still peaks on it.
 *   - Inside compositions: cues (manifest / render / frames, see ./sound-design-cues.ts) map kind → sound — typing →
 *     Typing burst, stamp → Stamp slam, marker → Marker scribble, paper → Paper slide, tape-stop → Tape stop, a scene
 *     cut → a cut sound, a beat word → Impact … — and a cue may name its own sound.
 *   - A text that comes in within 0.35 s after a cut (or on a cue) is covered by that cut's hit: no late pop.
 *   - A palette (auto from the timeline: paper · tech · clean) picks the cut sounds.
 * Kept from v1: a hit at 0.0 s (R4), a riser into the end of the hook + a hit there, the ≥ 0.25 s rule on where sounds
 * are heard (higher priority wins), SFX lanes reused before a new one, names "SFX <sound> · <why>" (R23), the light
 * duck with new keys only, and the `restorff.design` mark (server/sound-design.ts) so a re-run replaces any v1 or v2
 * design instead of stacking.
 */
import {
	type Author,
	isCaptionTrack,
	isMusicTrack,
	isSfxTrack,
	type Op,
	type Project,
	type SfxLibraryEntry,
	SOUND_DESIGN_VERSION,
	TICKS_PER_SECOND,
} from "@restorffcut/timeline-ops";

export const SOUND_DESIGN_PLANNER = "sound-design@2";

export type CueSource = "render" | "manifest" | "frames";

/** A composition cue on the timeline (timeline seconds). */
export interface TimelineCue {
	t: number;
	kind: string;
	label: string;
	source: CueSource;
	element: string;
	sound?: string;
	strength?: number;
}

export type DesignV2Kind = "hit" | "riser" | "cut" | "cue" | "pop" | "tick";
export type Palette = "clean" | "paper" | "tech";

export interface DesignV2Options {
	/** Minimum seconds between two SFX events (where they are heard). Default 0.25. */
	minGap?: number;
	hitAtStart?: boolean;
	riserIntoHook?: boolean;
	hookEnd?: number;
	/** v1 name kept: false = no sound on cuts. */
	whooshOnCuts?: boolean;
	popOnText?: boolean;
	captionTicks?: boolean;
	/** Sounds on composition cues. Default true. */
	cues?: boolean;
	duck?: boolean;
	duckDb?: number;
	author?: Author;
	/** Cut sounds: auto (default) reads the timeline; paper = Paper slide / Whoosh hit; tech + clean = Whoosh hit / Swish hit. */
	palette?: "auto" | Palette;
	/** Sound per kind (pack ids): hit, hook_hit, riser, cut, cut_alt, transition, pop, tick, or any cue kind (stamp, type…). */
	sounds?: Record<string, string>;
}

export interface PlannedSfxV2 {
	kind: DesignV2Kind;
	sound: string;
	name: string;
	t: number;
	event: number;
	dur: number;
	db: number;
	reason: string;
	/** cut · cue:manifest · cue:render · cue:frames · text · start · hook · caption */
	source: string;
	lane: string;
}

export interface SkippedEdge {
	t: number;
	reason: string;
	element: string;
}

export interface SoundDesignV2Plan {
	ops: Op[];
	placed: PlannedSfxV2[];
	dropped: Array<{ kind: DesignV2Kind; event: number; reason: string }>;
	counts: Record<DesignV2Kind, number>;
	summary: string;
	ducked: string[];
	hookEnd: number | null;
	notes: string[];
	palette: Palette;
	/**
	 * Real visible cuts (clip edges + scene cuts inside compositions); how many have a sound event within ±0.05 s
	 * (designed, or placed by hand: `by_hand` of them are covered only by a hand-placed SFX, which design never stacks on).
	 */
	cuts: { times: number[]; with_sound: number; by_hand: number; skipped: SkippedEdge[] };
	/** Texts whose pop was left out because a cut or a cue already sounds there. */
	covered_texts: Array<{ t: number; text: string; by: string }>;
}

const DEFAULTS: Record<string, string> = {
	hit: "impact",
	hook_hit: "sub-hit",
	riser: "riser-2s",
	transition: "whoosh-long",
	pop: "pop",
	tick: "tick",
};

const PALETTES: Record<Palette, { cut: string; cut_alt: string }> = {
	clean: { cut: "whoosh-hit", cut_alt: "swish-hit" },
	tech: { cut: "whoosh-hit", cut_alt: "swish-hit" },
	paper: { cut: "paper-slide", cut_alt: "whoosh-hit" },
};

/** Cue kind → [preferred pack ids…], priority class. Unknown kinds → a pop. (Exported for `composition contract`, composition-v3.) */
export const CUE_SOUNDS: Array<{ kinds: string[]; sounds: string[]; strong: boolean }> = [
	{ kinds: ["type", "typing", "keys", "keyboard", "code", "prompt", "terminal"], sounds: ["typing-burst", "typewriter"], strong: false },
	{ kinds: ["typewriter"], sounds: ["typewriter", "typing-burst"], strong: false },
	{ kinds: ["stamp", "seal", "slam", "verdict"], sounds: ["stamp-slam", "impact"], strong: true },
	{ kinds: ["marker", "scribble", "underline", "circle", "strike", "draw", "doodle", "pen", "highlight"], sounds: ["marker-scribble"], strong: false },
	{ kinds: ["paper", "slide", "card", "collage", "cutout", "page", "sheet"], sounds: ["paper-slide", "paper-rustle"], strong: false },
	{ kinds: ["tape-stop", "tape", "stop", "freeze", "brake", "power-down"], sounds: ["tape-stop"], strong: true },
	{ kinds: ["word", "beat-word", "beat", "punch", "impact", "hit", "big-word", "headline"], sounds: ["impact"], strong: true },
	{ kinds: ["boom"], sounds: ["boom", "impact"], strong: true },
	{ kinds: ["drop", "bass", "bass-drop"], sounds: ["bass-drop", "sub-hit"], strong: true },
	{ kinds: ["ignite", "flash", "glow", "light"], sounds: ["swish-hit", "pop"], strong: false },
	{ kinds: ["whoosh", "swipe", "transition", "whip", "zoom"], sounds: ["whoosh-short"], strong: false },
	{ kinds: ["riser", "build", "rise"], sounds: ["riser-1s"], strong: false },
	{ kinds: ["glitch", "error", "digital"], sounds: ["glitch"], strong: false },
	{ kinds: ["scratch", "rewind", "record"], sounds: ["record-scratch"], strong: true },
	{ kinds: ["shutter", "photo", "snap", "camera"], sounds: ["camera-shutter"], strong: false },
	{ kinds: ["tick", "count", "counter", "clock"], sounds: ["tick", "click"], strong: false },
	{ kinds: ["check", "success", "price", "offer", "ding", "done"], sounds: ["ding"], strong: false },
	{ kinds: ["click", "ui", "tap", "button"], sounds: ["click"], strong: false },
	{ kinds: ["pop", "appear", "text", "title", "in", "accent", "show"], sounds: ["pop"], strong: false },
];

const CUT_KINDS = new Set(["cut", "scene", "scene-cut"]);
const PRIORITY: Record<DesignV2Kind, number> = { hit: 100, riser: 90, cut: 75, cue: 66, pop: 60, tick: 10 };
const STRONG_CUE = 72;
const DUCK_SPAN: Partial<Record<DesignV2Kind, [number, number]>> = { hit: [0, 0.4], cut: [0.1, 0.15], cue: [0, 0.25], pop: [0, 0.1], riser: [0.5, 0] };
const DUCK_ATTACK = 0.03;
const DUCK_RELEASE = 0.2;
const EPSILON = 0.05;
/** A text that starts this soon after a cut (or a cue) is covered by its hit. */
const TEXT_COVER: [number, number] = [-0.05, 0.35];

type Scene = Project["scenes"][number];
type Track = Scene["tracks"]["overlay"][number] | Scene["tracks"]["main"] | Scene["tracks"]["audio"][number];
type Element = Track["elements"][number];
type CompositionTag = { name?: string; title?: string; props?: Record<string, unknown>; hash?: string; custom?: boolean };

const seconds = (ticks: number) => ticks / TICKS_PER_SECOND;
const endOf = (element: Element) => element.startTime + element.duration;
const round = (value: number) => Math.round(value * 1000) / 1000;
const isHidden = (element: Element) => "hidden" in element && (element as { hidden?: boolean }).hidden === true;
const compositionOf = (element: Element): CompositionTag | undefined => (element as { restorff?: { composition?: CompositionTag } }).restorff?.composition;
const tagOf = (thing: unknown) => ((thing as { restorff?: unknown }).restorff ?? {}) as { design?: string; role?: string; sfxDuckKeys?: string[] };

function shortName(name: string, max = 24): string {
	const clean = String(name ?? "").trim().replace(/\s+/g, " ");
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function activeScene(project: Project): Scene {
	return project.scenes.find((scene) => scene.id === project.currentSceneId) ?? project.scenes.find((scene) => scene.isMain) ?? project.scenes[0];
}

function projectEnd(scene: Scene): number {
	let end = 0;
	for (const track of [scene.tracks.main, ...scene.tracks.overlay]) for (const element of track.elements as Element[]) end = Math.max(end, seconds(endOf(element)));
	if (end === 0) for (const track of scene.tracks.audio) for (const element of track.elements as Element[]) end = Math.max(end, seconds(endOf(element)));
	return end;
}

/** Same picture source: the same media file, or the same composition render (hash, else name + props). */
export function sameSource(a: Element, b: Element): boolean {
	const ca = compositionOf(a);
	const cb = compositionOf(b);
	if (ca || cb) {
		if (!ca || !cb) return false;
		if (ca.hash && cb.hash) return ca.hash === cb.hash;
		return ca.name === cb.name && JSON.stringify(ca.props ?? {}) === JSON.stringify(cb.props ?? {});
	}
	const ma = (a as { mediaId?: string }).mediaId;
	const mb = (b as { mediaId?: string }).mediaId;
	return !!ma && ma === mb;
}

const param = (element: Element, key: string): unknown => (element.params as Record<string, unknown> | undefined)?.[key];

/** texture (no cuts) · full (its edges are cuts) · graphic (a composition drawn over the video) · pip (a small picture). */
export function classifyOverlay(element: Element, fullFrame: Record<string, boolean | null>): { kind: "texture" | "full" | "graphic" | "pip"; why: string } {
	const opacity = param(element, "opacity");
	if (typeof opacity === "number" && opacity < 0.6) return { kind: "texture", why: `a texture overlay (opacity ${opacity})` };
	const blend = param(element, "blendMode");
	if (typeof blend === "string" && blend !== "normal") return { kind: "texture", why: `a texture overlay (blend ${blend})` };
	const composition = compositionOf(element);
	if (composition) {
		const name = `${composition.name ?? ""} ${composition.title ?? ""}`.toLowerCase();
		if (/texture|grain|noise|vignette|light-leak|paper-bg/.test(name) || composition.props?.mode === "overlay") return { kind: "texture", why: `a texture overlay (${composition.name})` };
		const full = fullFrame[element.id];
		if (full === true) return { kind: "full", why: "a full-frame composition" };
		if (full === false) return { kind: "graphic", why: "a graphic over the video" };
		return composition.custom ? { kind: "full", why: "a custom composition (assumed full frame: no frames to read)" } : { kind: "graphic", why: "a library graphic (no frames to read)" };
	}
	const scale = param(element, "transform.scaleX");
	if (typeof scale === "number" && scale < 0.75) return { kind: "pip", why: `a picture-in-picture (scale ${scale})` };
	return { kind: "full", why: "B-roll" };
}

interface VisualCut {
	time: number;
	label: string;
	element: string;
	transition?: { type: string; seconds: number };
}

interface Appearance {
	time: number;
	label: string;
	element: string;
}

/** The cuts a viewer sees (clip edges), what only appears, and every edge skipped with why. */
export function findRealCuts(scene: Scene, end: number, fullFrame: Record<string, boolean | null>): { cuts: VisualCut[]; appears: Appearance[]; skipped: SkippedEdge[] } {
	const cuts: VisualCut[] = [];
	const appears: Appearance[] = [];
	const skipped: SkippedEdge[] = [];
	const sorted = (track: Track) => [...(track.elements as Element[])].filter((element) => !isHidden(element)).sort((a, b) => a.startTime - b.startTime);

	// main: every join is a cut, unless the same shot carries on (a split with nothing removed)
	const main = sorted(scene.tracks.main);
	main.forEach((element, index) => {
		const start = seconds(element.startTime);
		if (start <= EPSILON) return;
		const prev = main[index - 1];
		if (prev && Math.abs(seconds(endOf(prev)) - start) < EPSILON && sameSource(prev, element)) {
			const rate = (prev as { retime?: { rate?: number } }).retime?.rate || 1;
			const expected = prev.trimStart + prev.duration * rate;
			if (Math.abs(element.trimStart - expected) <= TICKS_PER_SECOND / 30) {
				skipped.push({ t: round(start), reason: `"${shortName(element.name)}" carries on the same shot (a split, nothing removed)`, element: element.id });
				return;
			}
		}
		const transition = (element as { transitionIn?: { type: string; duration: number } }).transitionIn;
		cuts.push({ time: start, label: `cut to ${shortName(element.name)}`, element: element.id, transition: transition ? { type: transition.type, seconds: seconds(transition.duration) } : undefined });
	});

	// overlays: by what the clip is
	for (const track of scene.tracks.overlay) {
		if (track.type !== "video") continue;
		const elements = sorted(track);
		elements.forEach((element, index) => {
			const start = seconds(element.startTime);
			const stop = seconds(endOf(element));
			const cls = classifyOverlay(element, fullFrame);
			const prev = elements[index - 1];
			const next = elements[index + 1];
			const seamIn = !!prev && Math.abs(seconds(endOf(prev)) - start) < EPSILON && sameSource(prev, element);
			const seamOut = !!next && Math.abs(seconds(next.startTime) - stop) < EPSILON && sameSource(element, next);
			if (cls.kind === "texture") {
				if (start > EPSILON) skipped.push({ t: round(start), reason: `${seamIn ? "loop seam of " : "start of "}"${shortName(element.name)}": ${cls.why}`, element: element.id });
				return;
			}
			if (seamIn) {
				skipped.push({ t: round(start), reason: `loop seam of "${shortName(element.name)}" (the same clip again: not a cut)`, element: element.id });
			} else if (start > EPSILON) {
				if (cls.kind === "full") {
					const transition = (element as { transitionIn?: { type: string; duration: number } }).transitionIn;
					cuts.push({ time: start, label: `cut to ${shortName(element.name)}`, element: element.id, transition: transition ? { type: transition.type, seconds: seconds(transition.duration) } : undefined });
				} else {
					appears.push({ time: start, label: `"${shortName(element.name, 18)}" appears`, element: element.id });
				}
			}
			if (cls.kind === "full" && !seamOut && stop < end - EPSILON && (!next || seconds(next.startTime) - stop > EPSILON)) {
				cuts.push({ time: stop, label: `back from ${shortName(element.name)}`, element: element.id });
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
	skipped.sort((a, b) => a.t - b.t);
	return { cuts: merged, appears, skipped };
}

/**
 * paper when the cut IS a collage (a PAPER lane, or ≥ 2 different collage pieces), tech for neon/code pieces, else
 * clean. (2026-10-20: one paper-form scene + a stamp made the neon-grid piece "paper" — a stamp alone is not a collage.)
 */
export function autoPalette(scene: Scene): Palette {
	const collage = new Set<string>();
	let paperLane = false;
	let tech = 0;
	for (const track of [scene.tracks.main, ...scene.tracks.overlay]) {
		if (/^PAPER\b/i.test(track.name ?? "")) paperLane = true;
		for (const element of track.elements as Element[]) {
			const composition = compositionOf(element);
			if (!composition) continue;
			const name = `${composition.name ?? ""} ${composition.title ?? ""}`.toLowerCase();
			const piece = /paper-texture|paper-cut|cutout|cut-out|halftone|thread-timeline|map-route|retro-tv|parallax|collage/.exec(name);
			if (piece) collage.add(piece[0]);
			if (/neon|grid|ui-world|prompt|glitch|terminal|code/.test(name)) tech += 1;
		}
	}
	if (paperLane || collage.size >= 2) return "paper";
	if (tech) return "tech";
	return "clean";
}

interface Candidate {
	kind: DesignV2Kind;
	sound: SfxLibraryEntry;
	event: number;
	t: number;
	reason: string;
	source: string;
	priority: number;
	group?: string;
}

function candidateAt(kind: DesignV2Kind, sound: SfxLibraryEntry, event: number, reason: string, source: string, priority = PRIORITY[kind], group?: string): Candidate {
	const t = Math.max(0, event - sound.sync_s);
	return { kind, sound, event: t + sound.sync_s, t, reason, source, priority, group };
}

function volumeAt(element: Element, time: number): number {
	const base = typeof element.params.volume === "number" ? (element.params.volume as number) : 0;
	const keys = (element.animations?.volume as { keys?: Array<{ time: number; value: number; segmentToNext?: string }> } | undefined)?.keys;
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

export function summarizeV2(counts: Record<DesignV2Kind, number>, skippedEdges: number): string {
	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
	if (!total) return "placed 0 SFX";
	const parts: string[] = [];
	if (counts.cut) parts.push(`${counts.cut} on cuts`);
	if (counts.cue) parts.push(`${counts.cue} on composition cues`);
	if (counts.pop) parts.push(`${counts.pop} pop${counts.pop === 1 ? "" : "s"}`);
	if (counts.riser) parts.push(`${counts.riser} riser${counts.riser === 1 ? "" : "s"}`);
	if (counts.hit) parts.push(`${counts.hit} hit${counts.hit === 1 ? "" : "s"}`);
	if (counts.tick) parts.push(`${counts.tick} tick${counts.tick === 1 ? "" : "s"}`);
	return `placed ${total} SFX: ${parts.join(", ")}${skippedEdges ? ` · ${skippedEdges} edge${skippedEdges === 1 ? "" : "s"} not cuts (loop seams, textures, splits) left silent` : ""}`;
}

export function planSoundDesignV2(project: Project, library: SfxLibraryEntry[], cues: TimelineCue[], fullFrame: Record<string, boolean | null>, options: DesignV2Options = {}): SoundDesignV2Plan {
	const minGap = options.minGap ?? 0.25;
	const author: Author = options.author ?? "claude";
	const scene = activeScene(project);
	const end = projectEnd(scene);
	const notes: string[] = [];
	const dropped: SoundDesignV2Plan["dropped"] = [];
	const counts: Record<DesignV2Kind, number> = { hit: 0, riser: 0, cut: 0, cue: 0, pop: 0, tick: 0 };
	const palette: Palette = options.palette && options.palette !== "auto" ? options.palette : autoPalette(scene);
	const prefer: Record<string, string> = { ...DEFAULTS, ...PALETTES[palette], ...(options.sounds ?? {}) };
	const empty = (why: string): SoundDesignV2Plan => ({ ops: [], placed: [], dropped, counts, summary: summarizeV2(counts, 0), ducked: [], hookEnd: null, notes: [...notes, why], palette, cuts: { times: [], with_sound: 0, by_hand: 0, skipped: [] }, covered_texts: [] });
	if (end <= 0) return empty("the timeline is empty: nothing to design");
	if (!library.length) return empty("the SFX library is empty");
	const byId = (id: string | undefined) => (id ? library.find((entry) => entry.id === id) : undefined);
	const byRole = (role: string) => library.find((entry) => entry.roles.includes(role));
	const pick = (preferred: string | undefined, role: string) => byId(preferred) ?? byRole(role);

	const { cuts, appears, skipped } = findRealCuts(scene, end, fullFrame);
	const useCues = options.cues !== false;
	// a texture overlay is silent, inside too (2026-10-20: the paper-collage timeline's 19 paper-texture copies each
	// "appeared" on their seam before this)
	const textures = new Set<string>();
	for (const track of scene.tracks.overlay) {
		if (track.type !== "video") continue;
		for (const element of track.elements as Element[]) if (classifyOverlay(element, fullFrame).kind === "texture") textures.add(element.id);
	}
	const audible = cues.filter((cue) => !textures.has(cue.element));
	if (useCues && audible.length < cues.length) notes.push(`${cues.length - audible.length} cue(s) inside texture overlays ignored`);
	const sceneCuts = useCues ? audible.filter((cue) => CUT_KINDS.has(cue.kind)) : [];
	const otherCues = useCues ? audible.filter((cue) => !CUT_KINDS.has(cue.kind)) : [];
	// frames-only accents are many on busy pieces: keep each clip's 3 strongest, and one "appear"
	const keptCues: TimelineCue[] = [];
	const byElement = new Map<string, TimelineCue[]>();
	for (const cue of otherCues) byElement.set(cue.element, [...(byElement.get(cue.element) ?? []), cue]);
	for (const list of byElement.values()) {
		const accents = list.filter((cue) => cue.source === "frames" && cue.kind === "accent").sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0)).slice(0, 3);
		const appear = list.filter((cue) => cue.source === "frames" && cue.kind === "appear").slice(0, 1);
		keptCues.push(...list.filter((cue) => !(cue.source === "frames" && (cue.kind === "accent" || cue.kind === "appear"))), ...accents, ...appear);
	}
	const elementsWithCues = new Set(audible.map((cue) => cue.element));
	const allCutTimes = [...cuts.map((cut) => cut.time), ...sceneCuts.map((cue) => cue.t)].sort((a, b) => a - b);

	// hook: the cut nearest 3.0 s within 2.0–4.5 s, else 3.0 s (v1's rule, over real cuts only)
	const autoHook = () => {
		if (end < 2.5) return null;
		const near = allCutTimes.filter((time) => time >= 2 && time <= 4.5).sort((a, b) => Math.abs(a - 3) - Math.abs(b - 3));
		return near.length ? near[0] : Math.min(3, end);
	};
	const hookEnd = options.riserIntoHook === false && options.hookEnd === undefined ? null : (options.hookEnd ?? autoHook());
	const candidates: Candidate[] = [];
	const missing = (what: string) => notes.push(`no "${what}" sound in the pack: skipped`);

	// 1. hits: frame 1 (R4) and the end of the hook, with the riser into it
	if (options.hitAtStart !== false) {
		const sound = pick(prefer.hit, "hit");
		if (sound) candidates.push(candidateAt("hit", sound, 0, "hook opens on a hit (R4)", "start"));
		else missing("hit");
	}
	if (hookEnd !== null && options.riserIntoHook !== false) {
		const hit = pick(prefer.hook_hit, "hit");
		if (hit && hookEnd > minGap) candidates.push(candidateAt("hit", hit, hookEnd, "end of the hook", "hook", PRIORITY.hit, "hook-end"));
		const risers = library.filter((entry) => entry.roles.includes("hook_riser") && entry.category === "riser" && entry.id !== "reverse-swell").sort((a, b) => b.sync_s - a.sync_s);
		const preferred = byId(prefer.riser);
		const ordered = preferred ? [preferred, ...risers.filter((entry) => entry.id !== preferred.id)] : risers;
		const riser = ordered.find((entry) => hookEnd - entry.sync_s >= minGap);
		if (riser) candidates.push(candidateAt("riser", riser, hookEnd, "builds into the end of the hook", "hook", PRIORITY.riser, "hook-end"));
		else if (ordered.length) notes.push(`the hook ends at ${hookEnd.toFixed(2)} s: too short for a riser`);
	}

	// 2. real cuts (clip edges) and scene cuts inside full-frame compositions: the hit lands ON the cut
	if (options.whooshOnCuts !== false) {
		const main = pick(prefer.cut, "cut");
		const alt = byId(prefer.cut_alt) ?? main;
		const long = pick(prefer.transition, "transition") ?? main;
		let alternate = false;
		const all: Array<{ time: number; label: string; source: string; transition?: { type: string; seconds: number }; sound?: string }> = [
			...cuts.map((cut) => ({ time: cut.time, label: cut.label, source: "cut", transition: cut.transition })),
			...sceneCuts.map((cue) => ({ time: cue.t, label: `scene cut inside ${cue.label}`, source: `cue:${cue.source}`, sound: cue.sound })),
		].sort((a, b) => a.time - b.time);
		for (const cut of all) {
			if (!main) {
				missing("cut");
				break;
			}
			let sound = byId(cut.sound) ?? (alternate && alt ? alt : main);
			let reason = cut.label;
			if (cut.transition && cut.transition.seconds >= 0.4 && long) {
				sound = long;
				reason = `${cut.transition.type} ${cut.label}`;
			} else if (!cut.sound) alternate = !alternate;
			candidates.push(candidateAt("cut", sound, cut.time, reason, cut.source));
		}
	}

	// 3. composition cues: kind → sound
	for (const cue of keptCues) {
		const row = CUE_SOUNDS.find((entry) => entry.kinds.includes(cue.kind)) ?? CUE_SOUNDS[CUE_SOUNDS.length - 1];
		const sound = byId(cue.sound) ?? byId(prefer[cue.kind]) ?? row.sounds.map((id) => byId(id)).find(Boolean) ?? pick(prefer.pop, "text_in");
		if (!sound) {
			missing(cue.kind);
			continue;
		}
		const light = row.kinds.includes("pop");
		candidates.push(candidateAt(light ? "pop" : "cue", sound, cue.t, `${cue.kind}: ${cue.label}`, `cue:${cue.source}`, light ? PRIORITY.pop : row.strong ? STRONG_CUE : PRIORITY.cue));
	}

	// 4. graphics / small pictures that appear without cues of their own: a pop
	const popSound = options.popOnText !== false ? pick(prefer.pop, "text_in") : undefined;
	for (const appear of appears) {
		if (elementsWithCues.has(appear.element) && useCues) continue;
		if (popSound) candidates.push(candidateAt("pop", popSound, appear.time, appear.label, "appear"));
	}

	// 5. text coming in — unless a cut or a cue already sounds there; 6. caption ticks (opt-in)
	const tick = options.captionTicks ? pick(prefer.tick, "caption_tick") : undefined;
	const covered: SoundDesignV2Plan["covered_texts"] = [];
	const coverTimes = [...allCutTimes.map((time) => ({ time, by: `the cut at ${time.toFixed(2)} s` })), ...keptCues.map((cue) => ({ time: cue.t, by: `the ${cue.kind} cue at ${cue.t.toFixed(2)} s` }))];
	for (const track of scene.tracks.overlay) {
		if (track.type !== "text" && track.type !== "graphic") continue;
		const captions = isCaptionTrack(track as never);
		for (const element of track.elements as Element[]) {
			if (isHidden(element)) continue;
			const at = seconds(element.startTime);
			const caption = captions || tagOf(element).role === "caption";
			const label = element.type === "text" ? String((element.params as Record<string, unknown>).content ?? element.name) : element.name;
			if (caption) {
				if (tick) candidates.push(candidateAt("tick", tick, at, `caption "${shortName(label, 16)}"`, "caption"));
				continue;
			}
			if (!popSound) continue;
			const cover = coverTimes.find((entry) => at - entry.time >= TEXT_COVER[0] && at - entry.time <= TEXT_COVER[1]);
			if (cover) {
				covered.push({ t: round(at), text: shortName(label, 30), by: cover.by });
				continue;
			}
			candidates.push(candidateAt("pop", popSound, at, `"${shortName(label, 18)}" in`, "text"));
		}
	}

	// 7. the 0.25 s rule on where sounds are heard, against each other and against SFX placed by hand
	const taken: number[] = [];
	const sfxLanes = scene.tracks.audio.filter((track) => isSfxTrack(track as never));
	for (const track of sfxLanes) {
		for (const element of track.elements as Element[]) {
			if (tagOf(element).design === SOUND_DESIGN_VERSION) continue;
			const url = (element as { sourceUrl?: string }).sourceUrl;
			const known = url ? library.find((entry) => entry.url === url) : undefined;
			taken.push(seconds(element.startTime) + (known?.sync_s ?? 0));
		}
	}
	const accepted: Candidate[] = [];
	for (const candidate of [...candidates].sort((a, b) => b.priority - a.priority || a.event - b.event)) {
		const others = accepted.filter((other) => !candidate.group || other.group !== candidate.group);
		const clash = [...taken, ...others.map((other) => other.event)].find((time) => Math.abs(time - candidate.event) < minGap - 1e-9);
		if (clash !== undefined) {
			dropped.push({ kind: candidate.kind, event: round(candidate.event), reason: `within ${minGap} s of another SFX at ${clash.toFixed(2)} s (${candidate.reason})` });
			continue;
		}
		if (candidate.t >= end - EPSILON) {
			dropped.push({ kind: candidate.kind, event: round(candidate.event), reason: "after the end of the cut" });
			continue;
		}
		accepted.push(candidate);
	}
	accepted.sort((a, b) => a.t - b.t || b.priority - a.priority);

	// 8. lanes: existing SFX tracks first, a new lane only when every one overlaps
	const ops: Op[] = [];
	const lanes = sfxLanes.map((track) => ({
		id: track.id,
		busy: (track.elements as Element[]).filter((element) => tagOf(element).design !== SOUND_DESIGN_VERSION).map((element) => [seconds(element.startTime), seconds(endOf(element))] as [number, number]),
	}));
	const placed: PlannedSfxV2[] = [];
	accepted.forEach((candidate, index) => {
		const dur = Math.min(candidate.sound.duration_s, Math.max(0, end - candidate.t));
		if (dur < 0.05) {
			dropped.push({ kind: candidate.kind, event: round(candidate.event), reason: "less than 0.05 s left before the end" });
			return;
		}
		const span: [number, number] = [candidate.t, candidate.t + dur];
		let lane = lanes.find((entry) => entry.busy.every(([a, b]) => span[1] <= a + 1e-6 || span[0] >= b - 1e-6));
		if (!lane) {
			const ref = `sfx-lane-${lanes.length + 1}`;
			ops.push({ op: "add_track", author, kind: "audio", name: lanes.length === 0 ? "SFX" : `SFX ${lanes.length + 1}`, ref, note: SOUND_DESIGN_VERSION } as Op);
			lane = { id: ref, busy: [] };
			lanes.push(lane);
		}
		lane.busy.push(span);
		const ref = `sfx-${index + 1}`;
		const name = `SFX ${candidate.sound.id} · ${candidate.reason}`;
		ops.push(
			{ op: "sfx", author, t: round(candidate.t), name, url: candidate.sound.url, dur: round(dur), track: lane.id, ref, note: SOUND_DESIGN_VERSION } as Op,
			{ op: "gain", author, el: ref, db: candidate.sound.default_db } as Op,
		);
		counts[candidate.kind] += 1;
		placed.push({ kind: candidate.kind, sound: candidate.sound.id, name, t: round(candidate.t), event: round(candidate.event), dur: round(dur), db: candidate.sound.default_db, reason: candidate.reason, source: candidate.source, lane: lane.id });
	});

	// 9. a light duck of the music under the louder SFX (new keys only; spans with keys, e.g. a voice duck, are kept)
	const ducked: string[] = [];
	if (options.duck !== false && placed.length) {
		const amount = Math.abs(options.duckDb ?? 3);
		const spans: Array<[number, number]> = [];
		for (const item of placed) {
			const around = DUCK_SPAN[item.kind];
			if (around) spans.push([Math.max(0, item.event - around[0]), item.event + around[1]]);
		}
		spans.sort((a, b) => a[0] - b[0]);
		const merged: Array<[number, number]> = [];
		for (const span of spans) {
			const last = merged[merged.length - 1];
			if (last && span[0] - last[1] < DUCK_ATTACK + DUCK_RELEASE) last[1] = Math.max(last[1], span[1]);
			else merged.push([...span]);
		}
		const music = scene.tracks.audio.filter((track) => isMusicTrack(track as never));
		if (!music.length) notes.push("no MUSIC track: nothing to duck");
		let left = 0;
		for (const track of music) {
			for (const element of track.elements as Element[]) {
				if (element.params.muted === true) continue;
				const start = seconds(element.startTime);
				const stop = seconds(endOf(element));
				const existing = ((element.animations?.volume as { keys?: Array<{ time: number }> } | undefined)?.keys ?? []).map((key) => seconds(element.startTime + key.time));
				let wrote = false;
				for (const [a, b] of merged) {
					const from = Math.max(start, a - DUCK_ATTACK);
					const to = Math.min(stop, b + DUCK_RELEASE);
					if (to - from < 0.05) continue;
					if (existing.some((time) => time >= from - 1e-6 && time <= to + 1e-6)) {
						left += 1;
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
						ops.push({ op: "keyframe", author, el: element.id, prop: "volume", t: round(time), value: Math.round(value * 100) / 100, note: SOUND_DESIGN_VERSION } as Op);
					}
					wrote = true;
				}
				if (wrote) ducked.push(element.id);
			}
		}
		if (left) notes.push(`${left} duck span(s) left alone: the music already has volume keys there (e.g. ducked under the voice)`);
	}

	// a cut "has a sound" when a designed SFX (not the riser's swell) or one placed by hand has its event within ±0.05 s
	const designedOn = (time: number) => placed.some((item) => item.kind !== "riser" && Math.abs(item.event - time) <= 0.05);
	const byHandOn = (time: number) => taken.some((event) => Math.abs(event - time) <= 0.05);
	const withSound = allCutTimes.filter((time) => designedOn(time) || byHandOn(time)).length;
	const byHand = allCutTimes.filter((time) => !designedOn(time) && byHandOn(time)).length;
	if (hookEnd !== null) notes.push(`hook ends at ${hookEnd.toFixed(2)} s`);
	notes.push(`palette ${palette}: cuts get ${prefer.cut} / ${prefer.cut_alt} (their hit on the cut)`);
	if (skipped.length) notes.push(`${skipped.length} clip edge(s) are not cuts and stay silent (loop seams, textures, splits): see cuts.skipped`);
	if (covered.length) notes.push(`${covered.length} text pop(s) left out: a cut or cue right before already hits there`);
	if (dropped.length) notes.push(`${dropped.length} SFX dropped by the ${minGap} s rule or the end of the cut`);
	return {
		ops,
		placed,
		dropped,
		counts,
		summary: summarizeV2(counts, skipped.length),
		ducked,
		hookEnd,
		notes,
		palette,
		cuts: { times: allCutTimes.map(round), with_sound: withSound, by_hand: byHand, skipped },
		covered_texts: covered,
	};
}
