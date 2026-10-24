/**
 * Storyboard compiler (EDT-03) — a storyboard (or a brief) plus its assets → ops@1 that build the v0 timeline a person
 * opens and changes in RestorffCut. Ported from evolve-agent's ffmpeg compiler (studio/clipgen/board_edit.py) to ops:
 * the editing decisions are the same, the output is an editable timeline instead of an MP4.
 *
 *   compileStoryboard(spec, assets, options) -> { ops, report }
 *
 * Pure and deterministic: no I/O, no clock, no Math.random. The only choice left to chance (which camera move a still
 * gets) comes from a PRNG seeded with `options.seed`, so the same spec + assets + seed always give the same ops.
 *
 * What the ops build, on the gateway's empty skeleton (TEXT · CAPTIONS · V2 B-ROLL · V1 A-ROLL · MUSIC · SFX):
 *   - one shot per beat on V1 A-ROLL, cut ON THE WORD: a beat starts `cutLead` (0.08 s) before its line's first word;
 *     extra shots of a beat go on V2 B-ROLL, cut on the word nearest their share of the beat;
 *   - the voice: one piece per beat on a VOICE track (0.30 s head / tail, never past the neighbouring words), or the
 *     beat's own dialogue clip on V1 when the video carries the words;
 *   - camera moves on stills (push in, pull out, pan, tilt — chosen by the seed unless the beat names one), punch-ins
 *     on emphasis words (a hard scale step on the word onset, held ~0.6 s);
 *   - 1-3-word captions from the voice's word timings (verbatim), styled by the editing-style preset;
 *   - the music bed from 0 to the end (repeated if short), set to `music.db`, ducked under the voice, faded out;
 *   - SFX on each beat's sound cue and a whoosh on every cut (≥ 0.25 s apart, cue wins);
 *   - the style preset's grade (a look from ../grades.ts, applied by the reducer as the `restorff-grade` effect on a
 *     GRADE layer; an unknown look name stays pending);
 *   - an end card: the CTA as text over the end-card shot; a bookmark per beat; the −14 LUFS loudness target.
 * Anything it cannot express goes into `report.skipped` (with the reason) and `report.missing` (ops@1 gaps).
 * Runbook: ../../README.md "Compiler: storyboard → v0". Worklog: docs/restorff/worklog/compiler.md.
 */
import type { Author } from "../model.ts";
import type { Ease, Op, TextStyle, TimedWord } from "../ops.ts";
import type { SfxLibraryEntry } from "../sound-design.ts";
import { getEditingStylePreset, type EditingStylePreset } from "../styles.ts";
import {
	floatToFrameRate,
	roundHalfAwayFromZero,
	roundTicksToFrame,
	secondsToTicks,
	ticksPerFrame,
	TICKS_PER_SECOND,
} from "../time.ts";
import { resolveTransitionKind, TRANSITION_KINDS } from "../transitions.ts";
import { resolveGradeName } from "../grades.ts";
import { validateOps, type ValidationResult } from "../validate.ts";

export const STORYBOARD_COMPILER_VERSION = "storyboard@1";

// ---------------------------------------------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------------------------------------------

/** One word of a voice / dialogue file, seconds INTO THAT FILE (e.g. from TVF / faster-whisper). */
export interface StoryboardAssetWord {
	word: string;
	start: number;
	end: number;
}

export type StoryboardAssetKind = "image" | "video" | "voice" | "music" | "sfx";

export interface StoryboardAsset {
	/** The media id in the editor's media store (or, with `importMedia`, the ref the import defines). */
	id: string;
	kind: StoryboardAssetKind;
	/** Seconds. Needed for video, voice, music and sfx (a voice without it and without words is skipped). */
	duration_s?: number;
	width?: number;
	height?: number;
	/** Word timings: a voice file, or a video whose own audio carries the beat's dialogue. */
	words?: StoryboardAssetWord[];
	name?: string;
	/** The beat this asset belongs to (else matched by id prefix "S03-…" or the beat's `assets` list). */
	beat?: string;
	/** A rendered composition clip (alpha video) implementing this effect (EFFECTS.md slug, e.g. "checklist"). */
	effect?: string;
	/** SFX: seconds into the file where its event is (a whoosh's peak). Default 0 for cues, 0.02 for whooshes. */
	sync_s?: number;
	/** SFX / music element level, dB. */
	db?: number;
	/** Video: false when it has no audio stream (then no ambience gain is written). */
	has_audio?: boolean;
	/** Optional, for `importMedia`: where the asset lives. */
	url?: string;
	blob_sha?: string;
	tags?: string[];
}

export interface StoryboardBeat {
	/** "S01" */
	id: string;
	/** "Hook" */
	title?: string;
	/** What we see. Camera words in it ("slow push", "pan left", "slow-motion") count as effects. */
	shot?: string;
	/** The VO / dialogue, verbatim. Empty or absent = no words in this beat. */
	line?: string;
	/** Words to punch in on (each is found in the voice's word timings). */
	emphasis?: string[];
	/** EFFECTS.md names or slugs ("Digital Zoom", "whip", "grade-warm", "big-word", "checklist"…). */
	effects?: string[];
	/** A sound cue ("the crack"): an sfx asset, a library sound, or a pending sfx for the gateway. */
	sound?: string;
	/** Asset ids (or urls) this beat uses, in order: the first visual is the A-roll, the rest B-roll. */
	assets?: string[];
	/** Duration hint, seconds (the board's). */
	duration?: number;
	kind?: "beat" | "end_card";
	/** End card text (default: the spec's CTA, else the beat's line). */
	cta?: string;
	/** Free notes kept in the report (open comments, purpose). */
	notes?: string[];
}

export interface StoryboardSpec {
	title?: string;
	/** "9:16" (default) · "4:5" · "1:1" · "16:9". */
	aspect?: string;
	/** Editing-style preset id ("fast-ugc", "talking-head", "aesthetic-warm", "moody-captions", "paper-collage"). */
	style?: string | null;
	beats: StoryboardBeat[];
	/** The brief's call to action (the end card's text). */
	cta?: string;
	hooks?: Array<{ id: string; text: string }>;
	claims?: Array<{ claim: string; proof: string; status: string }>;
	source?: { kind: "board" | "brief" | "manual"; id?: string; version?: number; title?: string };
	notes?: string[];
}

/** Track ids the ops write to. Defaults are the gateway skeleton's (restorff/apps/gateway/src/editor-skeleton.mjs). */
export interface StoryboardTracks {
	text: string;
	captions: string;
	broll: string;
	main: string;
	music: string;
	sfx: string;
	/** An existing voice track; when absent the ops add one named VOICE at the top of the audio group. */
	voice?: string;
}

export const SKELETON_TRACKS: Readonly<StoryboardTracks> = {
	text: "trk-text",
	captions: "trk-captions",
	broll: "trk-broll",
	main: "trk-main",
	music: "trk-music",
	sfx: "trk-sfx",
};

export interface StoryboardCompileOptions {
	/** Seeds the camera-move choice. Default: the spec's title, else "storyboard". */
	seed?: string;
	/** Author on every op. Default "compiler". */
	author?: Author;
	/** Frame grid for cuts. Default 30. */
	fps?: number;
	/** Canvas px (pan distances, end-card text size). Default from `spec.aspect` (9:16 → 1080×1920). */
	canvas?: { width: number; height: number };
	tracks?: Partial<StoryboardTracks>;
	/** "board" (default): a beat lasts max(its voice, its duration hint). "voice": as long as its voice only. */
	timing?: "board" | "voice";
	/** Seconds kept before a line's first word / after its last (never past a neighbouring word). Default 0.30 / 0.30. */
	head?: number;
	tail?: number;
	/** The cut lands this long before the beat's first word. Default 0.08. */
	cutLead?: number;
	/** Shortest beat, seconds. Default 0.8. */
	minBeat?: number;
	/** A beat with no voice and no duration hint. Default 2.5. */
	defaultBeat?: number;
	/** Still camera moves: push / pull scale (default 1.07, or the style's push), pan / tilt scale (default 1.10). */
	push?: number;
	pan?: number;
	/** Punch-in scale on an emphasis word (default 1.15, or the style's punch scale) and its shortest hold (0.6 s). */
	punch?: number;
	punchHold?: number;
	/** Captions from the voice words. `overEndCard: false` (default) leaves the end card to its CTA text. */
	captions?: boolean | { maxWords?: number; style?: TextStyle; overEndCard?: boolean };
	/** dB on every voice piece (default 0 = untouched). */
	voiceDb?: number;
	/** dB on a silent-shot video's own audio while a voice plays (default −14; null = leave it). */
	ambienceDb?: number | null;
	music?: { db?: number; duckDb?: number; attackMs?: number; releaseMs?: number; fadeOut?: number } | false;
	sfx?: { db?: number; onCuts?: boolean; minGap?: number; library?: SfxLibraryEntry[] } | false;
	/** Grade preset name; default the style preset's grade; null = none. */
	grade?: string | null;
	endCard?: { duration?: number; style?: TextStyle } | false;
	/** A bookmark per beat (default true). */
	marks?: boolean;
	/** Loudness target for the export (default −14 LUFS / −1 dBTP); false = none. */
	normalize?: { lufs: number; true_peak: number } | false;
	/** Emit import_media for assets that carry url or blob_sha, and use the refs (default false: insert by id). */
	importMedia?: boolean;
	/** Emit set_canvas (w, h, fps). Default: only when `spec.aspect` is not 9:16. */
	setCanvas?: boolean;
	/** Prefix of every ref the ops define (unique per batch). Default "sb". */
	refPrefix?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------------------------------------------

export interface StoryboardBeatPlacement {
	id: string;
	title?: string;
	kind: "beat" | "end_card";
	/** Timeline seconds. */
	start: number;
	end: number;
	duration: number;
	line?: string;
	voice?: { asset: string; source: "beat" | "shared" | "dialogue"; in: number; out: number; at: number; words: number };
	visual?: { asset: string; kind: "image" | "video"; move: string; speed?: number; from?: number; to?: number };
	broll: Array<{ asset: string; start: number; end: number; move: string }>;
	punches: Array<{ word: string; at: number; until: number }>;
	transitionIn?: string;
	sfx: string[];
	placed: string[];
	skipped: Array<{ what: string; reason: string }>;
	warnings: string[];
}

export interface StoryboardCompileReport {
	compiler: string;
	title?: string;
	seed: string;
	style: string | null;
	/** Timeline seconds. */
	duration: number;
	fps: number;
	canvas: { width: number; height: number };
	tracks: StoryboardTracks & { added: string[] };
	beats: StoryboardBeatPlacement[];
	/** The caption words as placed (timeline seconds). */
	words: TimedWord[];
	counts: Record<string, number>;
	/** One line per thing placed, for a person. */
	placed: string[];
	skipped: Array<{ beat?: string; what: string; reason: string }>;
	/** What ops@1 cannot say yet (for the ops owner), with the workaround used. */
	missing: Array<{ need: string; why: string; workaround: string }>;
	/** Ops the reducer will store as pending instructions (not drawn yet). */
	pending: Array<{ op: string; what: string; honouredBy: string }>;
	unusedAssets: string[];
	notes: string[];
	validation: ValidationResult;
}

export interface StoryboardCompileResult {
	ops: Op[];
	report: StoryboardCompileReport;
}

// ---------------------------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------------------------

const ASPECTS: Record<string, { width: number; height: number }> = {
	"9:16": { width: 1080, height: 1920 },
	"4:5": { width: 1080, height: 1350 },
	"1:1": { width: 1080, height: 1080 },
	"16:9": { width: 1920, height: 1080 },
};

const NUMBER_WORDS: Record<string, string> = {
	zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
	ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16",
	seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50",
	sixty: "60", seventy: "70", eighty: "80", ninety: "90", hundred: "100",
};

/** Lower-case, letters and digits only, number words as digits ("Eighteen," → "18"). */
export function normToken(token: string): string {
	const bare = token.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]/g, "");
	return NUMBER_WORDS[bare] ?? bare;
}

function lineTokens(text: string | undefined): string[] {
	return (text ?? "").split(/[\s\-–—/]+/).map(normToken).filter(Boolean);
}

function hashString(text: string): number {
	let hash = 2166136261 >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash >>> 0;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ticks = (seconds: number) => secondsToTicks(seconds);
const sec = (value: number) => value / TICKS_PER_SECOND;
const r2 = (value: number) => Math.round(value * 100) / 100;
const r3 = (value: number) => Math.round(value * 1000) / 1000;
const r4 = (value: number) => Math.round(value * 10000) / 10000;
const slug = (name: string) =>
	name
		.toLowerCase()
		.replace(/^fx-?\d+\s*[·:\-]?\s*/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

function mergeSpans(spans: Array<[number, number]>, bridge: number): Array<[number, number]> {
	const merged: Array<[number, number]> = [];
	for (const span of [...spans].sort((x, y) => x[0] - y[0])) {
		const last = merged[merged.length - 1];
		if (last && span[0] - last[1] < bridge) last[1] = Math.max(last[1], span[1]);
		else merged.push([span[0], span[1]]);
	}
	return merged;
}

/**
 * Break a CTA into lines: one sentence per line; a sentence longer than `width` + 4 characters is split into balanced
 * lines. A token with no letters or digits ("%", "—") stays with the word before it, so "30 %" never splits.
 */
export function wrapText(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const sentence of text.trim().split(/(?<=[.!?])\s+/)) {
		const words: string[] = [];
		for (const token of sentence.split(/\s+/).filter(Boolean)) {
			if (words.length && !/[\p{L}\p{N}]/u.test(token)) words[words.length - 1] += ` ${token}`;
			else words.push(token);
		}
		const length = words.join(" ").length;
		if (!length) continue;
		if (length <= width + 4) {
			lines.push(words.join(" "));
			continue;
		}
		const target = length / Math.ceil(length / width);
		let current = "";
		for (const word of words) {
			current = current ? `${current} ${word}` : word;
			if (current.length >= target) {
				lines.push(current);
				current = "";
			}
		}
		if (current) lines.push(current);
	}
	return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// Effects: EFFECTS.md names → what the compiler does with them
// ---------------------------------------------------------------------------------------------------------------

export type CameraMove = "none" | "push-in" | "pull-out" | "pan-left" | "pan-right" | "tilt-up" | "tilt-down";

type EffectAction =
	| { kind: "move"; move: CameraMove; name: string }
	| { kind: "punch"; name: string }
	| { kind: "slowmo"; name: string }
	| { kind: "big-word"; name: string }
	| { kind: "grade"; grade: string; name: string }
	| { kind: "captions"; name: string }
	| { kind: "transition"; transition: string; name: string }
	| { kind: "unsupported"; name: string; why: string }
	| { kind: "composition"; slug: string; name: string };

const TRANSITION_WORDS: Record<string, string> = {
	"zoom-through": "zoom-in",
	"zoom-through-cut": "zoom-in",
	"zoom-blur-out": "zoom-in",
	whip: "whip",
	"whip-pan": "whip",
	"whip-transition": "whip",
	"whip-blur": "whip",
};

export function classifyEffect(name: string): EffectAction {
	const s = slug(name);
	if (/^(static|hold|locked|locked-off|no-move)$/.test(s)) return { kind: "move", move: "none", name };
	if (s === "pullback-reveal") return { kind: "composition", slug: s, name };
	if (/^(push|push-in|slow-push|slow-push-in|ken-burns|zoom-in|camera-push)$/.test(s)) return { kind: "move", move: "push-in", name };
	if (/^(pull|pull-out|pull-back|slow-pull|zoom-out)$/.test(s)) return { kind: "move", move: "pull-out", name };
	if (/^(pan-left|pan-right|tilt-up|tilt-down)$/.test(s)) return { kind: "move", move: s as CameraMove, name };
	if (/^(digital-zoom|punch|punch-in|punch-ins|jump-zoom)$/.test(s)) return { kind: "punch", name };
	if (/^slow-?mo(tion)?$/.test(s)) return { kind: "slowmo", name };
	if (/^(big-word|big-word-punch|text-pop|headline-pop)$/.test(s)) return { kind: "big-word", name };
	if (/^handheld/.test(s)) return { kind: "unsupported", name, why: "no wiggle / noise keyframes in ops@1" };
	if (/(^|-)grade($|-)|^(warm|moody|punchy|film|film-look|black-and-white|b-w|paper|warm-morning|cool-night|clean-look|mono|golden-hour)$/.test(s)) {
		const grade = s.replace(/^grade-/, "").replace(/-grade$/, "") || s;
		return { kind: "grade", grade, name };
	}
	if (/caption|karaoke/.test(s)) return { kind: "captions", name };
	const mapped = TRANSITION_WORDS[s] ?? s;
	const transition = resolveTransitionKind(mapped);
	if (transition) return { kind: "transition", transition: mapped, name };
	return { kind: "composition", slug: s, name };
}

/** Camera / speed words in a shot description ("Slow push on the can", "slow-motion foam"). */
function effectsInShot(shot: string | undefined): string[] {
	const text = (shot ?? "").toLowerCase();
	const found: string[] = [];
	if (/\bslow[- ]?mo(tion)?\b/.test(text)) found.push("slow-motion");
	if (/\b(slow )?push(es)?[- ]in\b|\bslow push\b|\bpushes in\b/.test(text)) found.push("push-in");
	if (/\bpull(s)?[- ](back|out)\b/.test(text)) found.push("pull-out");
	const pan = /\bpan(s)?[- ](left|right)\b/.exec(text);
	if (pan) found.push(`pan-${pan[2]}`);
	const tilt = /\btilt(s)?[- ](up|down)\b/.exec(text);
	if (tilt) found.push(`tilt-${tilt[2]}`);
	if (/\bwhip\b/.test(text)) found.push("whip");
	return found;
}

// ---------------------------------------------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------------------------------------------

interface VoicePiece {
	asset: StoryboardAsset;
	source: "beat" | "shared" | "dialogue";
	/** Source ticks: the piece with its full head and tail. */
	inT: number;
	outT: number;
	/** Source ticks of the first word's onset. */
	firstT: number;
	words: StoryboardAssetWord[];
}

interface Plan {
	index: number;
	beat: StoryboardBeat;
	kind: "beat" | "end_card";
	synthetic: boolean;
	attached: StoryboardAsset[];
	visuals: StoryboardAsset[];
	compositions: StoryboardAsset[];
	dialogue: StoryboardAsset | null;
	piece: VoicePiece | null;
	actions: EffectAction[];
	start: number;
	end: number;
	/** Voice placement (ticks): timeline start, source in / out. */
	voiceAt: number;
	voiceIn: number;
	voiceOut: number;
	/** The beat's words on the timeline (ticks). */
	words: Array<{ text: string; start: number; end: number }>;
	report: StoryboardBeatPlacement;
}

interface Placed {
	ref: string;
	asset: StoryboardAsset;
	layer: "main" | "broll";
	kind: "image" | "video";
	start: number;
	end: number;
	move: CameraMove;
	windows: Array<[number, number]>;
}

const SEPARATOR = /^[-_. :/]/;

function belongsTo(asset: StoryboardAsset, beat: StoryboardBeat): boolean {
	const beatId = beat.id.toLowerCase();
	if (asset.beat !== undefined) return asset.beat.toLowerCase() === beatId;
	const id = asset.id.toLowerCase();
	return id === beatId || (id.startsWith(beatId) && SEPARATOR.test(id.slice(beatId.length)));
}

function isEndCardBeat(beat: StoryboardBeat): boolean {
	if (beat.kind) return beat.kind === "end_card";
	return /\bend[- ]?card\b|\bpackshot\b|\boutro\b/i.test(`${beat.title ?? ""} ${beat.shot ?? ""}`);
}

/** Align a line to a voice's words from `from`: the index range [first, last] it covers, or null. */
function alignLine(line: string[], words: string[], from: number): { first: number; last: number; matched: number } | null {
	if (!line.length || from >= words.length) return null;
	const WINDOW = 8;
	const hits: Array<{ token: number; word: number }> = [];
	let pointer = from;
	line.forEach((token, t) => {
		for (let j = pointer; j < Math.min(words.length, pointer + WINDOW); j++) {
			if (words[j] === token) {
				hits.push({ token: t, word: j });
				pointer = j + 1;
				return;
			}
		}
	});
	if (!hits.length) {
		// no anchor at all: take as many words as the line has
		return { first: from, last: Math.min(words.length - 1, from + line.length - 1), matched: 0 };
	}
	const firstHit = hits[0];
	const lastHit = hits[hits.length - 1];
	const first = Math.max(from, firstHit.word - firstHit.token);
	const last = Math.min(words.length - 1, lastHit.word + (line.length - 1 - lastHit.token));
	return { first, last, matched: hits.length };
}

export function compileStoryboard(
	spec: StoryboardSpec,
	assets: readonly StoryboardAsset[],
	options: StoryboardCompileOptions = {},
): StoryboardCompileResult {
	const author: Author = options.author ?? "compiler";
	const prefix = options.refPrefix ?? "sb";
	const seed = options.seed ?? spec.title ?? "storyboard";
	const random = mulberry32(hashString(seed));
	const fpsValue = options.fps ?? 30;
	const fpsRate = floatToFrameRate(fpsValue);
	const frame = ticksPerFrame(fpsRate) ?? 4000;
	const aspect = spec.aspect ?? "9:16";
	const canvas = options.canvas ?? ASPECTS[aspect] ?? ASPECTS["9:16"];
	const tracks: StoryboardTracks = { ...SKELETON_TRACKS, ...(options.tracks ?? {}) };
	const timing = options.timing ?? "board";
	const head = ticks(options.head ?? 0.3);
	const tail = ticks(options.tail ?? 0.3);
	const cutLead = ticks(options.cutLead ?? 0.08);
	const minBeat = ticks(options.minBeat ?? 0.8);
	const defaultBeat = ticks(options.defaultBeat ?? 2.5);
	const punchHold = ticks(options.punchHold ?? 0.6);
	const ceilFrame = (value: number) => Math.ceil(value / frame) * frame;
	const floorFrame = (value: number) => Math.floor(value / frame) * frame;
	const roundFrame = (value: number) => roundTicksToFrame(value, fpsRate);

	const notes: string[] = [];
	const skipped: StoryboardCompileReport["skipped"] = [];
	const missing = new Map<string, { need: string; why: string; workaround: string }>();
	const pendingList: StoryboardCompileReport["pending"] = [];
	const addMissing = (need: string, why: string, workaround: string) => {
		if (!missing.has(need)) missing.set(need, { need, why, workaround });
	};

	// ---- style preset
	let preset: EditingStylePreset | null = null;
	if (spec.style) {
		preset = getEditingStylePreset(spec.style) ?? null;
		if (!preset) notes.push(`style "${spec.style}" is not an editing-style preset: compiled without one`);
	}
	for (const composition of preset?.compositions ?? []) {
		if (!assets.some((asset) => asset.effect && slug(asset.effect) === slug(composition.name))) {
			notes.push(`style "${preset?.id}" adds the composition "${composition.name}" at ${composition.at} s: render it (packages/compositions) and pass the clip as an asset with effect "${composition.name}" and beat set`);
		}
	}
	const presetPush = preset?.pacing.kind === "push" ? preset.pacing.scale : undefined;
	const presetPunch = preset && (preset.pacing.kind === "jump" || preset.pacing.kind === "punch") ? preset.pacing.scale : undefined;
	const push = options.push ?? presetPush ?? 1.07;
	const pan = options.pan ?? 1.1;
	const punch = options.punch ?? (presetPunch !== undefined ? Math.max(presetPunch, 1.08) : 1.15);

	// ---- beats (+ a synthetic end card when the brief has a CTA and the board has none)
	const endCardOptions = options.endCard === false ? null : (options.endCard ?? {});
	const beats: Array<{ beat: StoryboardBeat; synthetic: boolean }> = spec.beats.map((beat) => ({ beat, synthetic: false }));
	let endIndex = -1;
	beats.forEach((entry, i) => {
		if (isEndCardBeat(entry.beat)) endIndex = i;
	});
	if (endIndex < 0 && spec.cta?.trim() && endCardOptions) {
		beats.push({
			beat: { id: "END", title: "End card", kind: "end_card", cta: spec.cta, duration: endCardOptions.duration ?? 2.5 },
			synthetic: true,
		});
		endIndex = beats.length - 1;
		notes.push("no end-card beat on the board: one was added for the brief's CTA");
	}

	// ---- assets per beat
	const usedAssets = new Set<string>();
	const attachedIds = new Set<string>();
	const attachedFor = beats.map(({ beat }) => {
		const list: StoryboardAsset[] = [];
		const add = (asset: StoryboardAsset | undefined) => {
			if (asset && !list.includes(asset)) list.push(asset);
		};
		for (const ref of beat.assets ?? []) {
			const asset = assets.find((candidate) => candidate.id === ref || candidate.url === ref);
			if (asset) add(asset);
			else skipped.push({ beat: beat.id, what: `asset "${ref}"`, reason: "not in the assets list" });
		}
		for (const asset of assets) if (belongsTo(asset, beat)) add(asset);
		for (const asset of list) attachedIds.add(asset.id);
		return list;
	});
	const free = (kind: StoryboardAssetKind) => assets.filter((asset) => asset.kind === kind && !attachedIds.has(asset.id));
	const sharedVoices = free("voice").filter((asset) => asset.words?.length);
	const sharedVoice = sharedVoices[0] ?? null;
	if (sharedVoices.length > 1) notes.push(`${sharedVoices.length} unattached voice files: only "${sharedVoice?.id}" is used as the VO`);
	const music = free("music")[0] ?? assets.find((asset) => asset.kind === "music") ?? null;
	const sfxPool = assets.filter((asset) => asset.kind === "sfx");

	// ---- plans + voice pieces
	const sortedWords = (asset: StoryboardAsset) =>
		(asset.words ?? []).filter((word) => word.word.trim() && word.end > word.start).slice().sort((a, b) => a.start - b.start);
	const pieceFrom = (asset: StoryboardAsset, words: StoryboardAssetWord[], i0: number, i1: number, source: VoicePiece["source"], bounded: boolean): VoicePiece => {
		const first = words[i0];
		const last = words[i1];
		const duration = asset.duration_s !== undefined ? ticks(asset.duration_s) : undefined;
		let lo = 0;
		let hi = duration ?? ticks(last.end) + tail;
		if (bounded) {
			if (i0 > 0) lo = Math.ceil((ticks(words[i0 - 1].end) + ticks(first.start)) / 2);
			if (i1 < words.length - 1) hi = Math.min(hi, Math.floor((ticks(last.end) + ticks(words[i1 + 1].start)) / 2));
		}
		return {
			asset,
			source,
			inT: Math.max(lo, ticks(first.start) - head),
			outT: Math.min(hi, ticks(last.end) + tail),
			firstT: ticks(first.start),
			words: words.slice(i0, i1 + 1),
		};
	};

	const sharedWords = sharedVoice ? sortedWords(sharedVoice) : [];
	const sharedNorm = sharedWords.map((word) => normToken(word.word));
	let sharedCursor = 0;

	const plans: Plan[] = beats.map(({ beat, synthetic }, index) => {
		const attached = attachedFor[index];
		const kind: Plan["kind"] = index === endIndex ? "end_card" : "beat";
		const effectNames = [...(beat.effects ?? []), ...effectsInShot(beat.shot)];
		const actions = effectNames.map(classifyEffect);
		const compositions = attached.filter((asset) => asset.effect && (asset.kind === "video" || asset.kind === "image"));
		const visuals = attached.filter((asset) => (asset.kind === "image" || asset.kind === "video") && !asset.effect);
		const dialogue = visuals.find((asset) => asset.kind === "video" && asset.words?.length) ?? null;
		const report: StoryboardBeatPlacement = {
			id: beat.id,
			title: beat.title,
			kind,
			start: 0,
			end: 0,
			duration: 0,
			line: beat.line,
			broll: [],
			punches: [],
			sfx: [],
			placed: [],
			skipped: [],
			warnings: [],
		};
		let piece: VoicePiece | null = null;
		const lineToks = lineTokens(beat.line);
		if (dialogue) {
			const words = sortedWords(dialogue);
			piece = pieceFrom(dialogue, words, 0, words.length - 1, "dialogue", false);
		} else {
			const ownVoice = attached.find((asset) => asset.kind === "voice");
			if (ownVoice) {
				const words = sortedWords(ownVoice);
				if (words.length) piece = pieceFrom(ownVoice, words, 0, words.length - 1, "beat", false);
				else if (ownVoice.duration_s !== undefined) {
					piece = { asset: ownVoice, source: "beat", inT: 0, outT: ticks(ownVoice.duration_s), firstT: 0, words: [] };
					report.warnings.push(`voice "${ownVoice.id}" has no word timings: no captions or punch-ins for this beat`);
				} else {
					report.skipped.push({ what: `voice "${ownVoice.id}"`, reason: "no word timings and no duration_s" });
				}
			} else if (sharedVoice && lineToks.length) {
				const aligned = alignLine(lineToks, sharedNorm, sharedCursor);
				if (aligned) {
					piece = pieceFrom(sharedVoice, sharedWords, aligned.first, aligned.last, "shared", true);
					sharedCursor = aligned.last + 1;
					if (aligned.matched < Math.ceil(lineToks.length / 2)) {
						report.warnings.push(`only ${aligned.matched}/${lineToks.length} words of the line found in "${sharedVoice.id}": timing is approximate`);
					}
				} else {
					report.skipped.push({ what: "voice", reason: `the line was not found in "${sharedVoice.id}" (its words ran out)` });
				}
			} else if (lineToks.length && !sharedVoice) {
				report.skipped.push({ what: "voice", reason: "the beat has a line but no voice asset: no VO, captions or punch-ins" });
			}
		}
		if (piece) usedAssets.add(piece.asset.id);
		return {
			index,
			beat,
			kind,
			synthetic,
			attached,
			visuals,
			compositions,
			dialogue,
			piece,
			actions,
			start: 0,
			end: 0,
			voiceAt: 0,
			voiceIn: 0,
			voiceOut: 0,
			words: [],
			report,
		};
	});
	if (sharedVoice && sharedCursor < sharedWords.length) {
		notes.push(`${sharedWords.length - sharedCursor} word(s) at the end of "${sharedVoice.id}" match no beat and are not used`);
	}

	// ---- timing: cuts on the word
	let cut = 0;
	let voiceFree = 0;
	plans.forEach((plan, i) => {
		plan.start = cut;
		const next = plans[i + 1];
		const hint = plan.beat.duration !== undefined && plan.beat.duration > 0 ? ticks(plan.beat.duration) : undefined;
		let end = cut + minBeat;
		const piece = plan.piece;
		if (piece) {
			const onset = piece.firstT - piece.inT;
			let at: number;
			let headUsed: number;
			if (piece.source === "dialogue") {
				at = cut;
				headUsed = onset;
			} else {
				const word = cut + cutLead;
				at = Math.max(word - onset, voiceFree, 0);
				headUsed = Math.max(0, Math.min(onset, word - at));
			}
			plan.voiceAt = at;
			plan.voiceIn = piece.firstT - headUsed;
			plan.voiceOut = piece.outT;
			const voiceEnd = at + (plan.voiceOut - plan.voiceIn);
			voiceFree = Math.max(voiceFree, voiceEnd);
			let candidate = voiceEnd;
			if (next?.piece && next.piece.source !== "dialogue") candidate = voiceEnd + (next.piece.firstT - next.piece.inT) - cutLead;
			end = Math.max(end, candidate);
			if (timing === "board" && hint !== undefined) end = Math.max(end, cut + hint);
			let endT = ceilFrame(end);
			if (piece.source === "dialogue" && piece.asset.duration_s !== undefined) {
				const mediaEnd = at + ticks(piece.asset.duration_s) - plan.voiceIn;
				if (endT > mediaEnd) endT = Math.max(cut + frame, floorFrame(mediaEnd));
			}
			plan.end = endT;
		} else {
			const estimate = plan.beat.line?.trim() ? ticks(lineTokens(plan.beat.line).length / 2.6 + 0.4) : undefined;
			end = Math.max(end, cut + (hint ?? estimate ?? defaultBeat));
			plan.end = ceilFrame(end);
		}
		cut = plan.end;
	});
	const total = plans.length ? plans[plans.length - 1].end : 0;

	// ---- words on the timeline
	for (const plan of plans) {
		const piece = plan.piece;
		if (!piece) continue;
		const limit = piece.source === "dialogue" ? plan.end : plan.voiceAt + (plan.voiceOut - plan.voiceIn);
		for (const word of piece.words) {
			const start = plan.voiceAt + (ticks(word.start) - plan.voiceIn);
			const end = Math.min(limit, plan.voiceAt + (ticks(word.end) - plan.voiceIn));
			if (start >= 0 && end > start && start < limit) plan.words.push({ text: word.word.trim(), start, end });
		}
	}

	// ---- op buckets (emitted in a fixed order at the end)
	const canvasOps: Op[] = [];
	const importOps: Op[] = [];
	const trackOps: Op[] = [];
	const mainOps: Op[] = [];
	const brollOps: Op[] = [];
	const motionOps: Op[] = [];
	const voiceOps: Op[] = [];
	const speedOps: Op[] = [];
	const cameraOps: Op[] = [];
	const transitionOps: Op[] = [];
	const textOps: Op[] = [];
	const captionOps: Op[] = [];
	const musicOps: Op[] = [];
	const sfxOps: Op[] = [];
	const gradeOps: Op[] = [];
	const markOps: Op[] = [];
	const tailOps: Op[] = [];
	const addedTracks: string[] = [];

	if (options.setCanvas || (spec.aspect && spec.aspect !== "9:16")) {
		canvasOps.push({ op: "set_canvas", author, w: canvas.width, h: canvas.height, fps: fpsValue });
	}

	// media ids (import_media refs when asked)
	const mediaRef = new Map<string, string>();
	const mediaOf = (asset: StoryboardAsset) => {
		usedAssets.add(asset.id);
		if (!options.importMedia || !(asset.url || asset.blob_sha)) return asset.id;
		const known = mediaRef.get(asset.id);
		if (known) return known;
		const ref = `${prefix}-media-${mediaRef.size + 1}`;
		mediaRef.set(asset.id, ref);
		const kind = asset.kind === "image" ? "image" : asset.kind === "video" ? "video" : "audio";
		importOps.push({
			op: "import_media",
			author,
			kind,
			...(asset.blob_sha ? { blob_sha: asset.blob_sha } : { url: asset.url as string }),
			name: asset.name ?? asset.id,
			...(asset.duration_s !== undefined && kind !== "image" ? { duration: asset.duration_s } : {}),
			...(asset.width ? { width: asset.width } : {}),
			...(asset.height ? { height: asset.height } : {}),
			...(asset.kind === "video" && asset.has_audio !== undefined ? { has_audio: asset.has_audio } : {}),
			ref,
		});
		return ref;
	};

	// lanes: an existing track first, extra tracks added when every lane is busy
	const lane = (base: string | null, kind: "text" | "audio" | "video", name: string, index?: number) => {
		const lanes: Array<{ id: string; busy: Array<[number, number]> }> = base ? [{ id: base, busy: [] }] : [];
		return (start: number, end: number): string => {
			let found = lanes.find((candidate) => candidate.busy.every(([a, b]) => end <= a || start >= b));
			if (!found) {
				const ref = `${prefix}-${name.toLowerCase()}-lane-${lanes.length + 1}`;
				const trackName = lanes.length === 0 ? name : `${name} ${lanes.length + 1}`;
				trackOps.push({ op: "add_track", author, kind, name: trackName, ref, ...(index !== undefined ? { index } : {}) });
				addedTracks.push(trackName);
				found = { id: ref, busy: [] };
				lanes.push(found);
			}
			found.busy.push([start, end]);
			return found.id;
		};
	};
	const motionLane = lane(null, "video", "MOTION", 2);
	const textLane = lane(tracks.text, "text", "TEXT", 0);
	const sfxLane = lane(tracks.sfx, "audio", "SFX");

	// ---- the voice track
	const hasVoTrack = plans.some((plan) => plan.piece && plan.piece.source !== "dialogue");
	let voiceTrack = tracks.voice ?? null;
	if (hasVoTrack && !voiceTrack) {
		voiceTrack = `${prefix}-voice`;
		trackOps.push({ op: "add_track", author, kind: "audio", name: "VOICE", index: 0, ref: voiceTrack });
		addedTracks.push("VOICE");
		addMissing(
			"add_track role",
			"add_track has no role (voice / music / sfx), so planners that read roles (sound-design) cannot tell the VO track apart",
			"the track is named VOICE and sits at the top of the audio group",
		);
	}

	// ---- visuals
	const placed: Placed[] = [];
	const mainByPlan = new Map<number, Placed>();
	let lastStill: StoryboardAsset | null = null;
	let previousMove: CameraMove | null = null;
	const firstMainPlan = plans.find((plan) => plan.dialogue || plan.visuals.length || plan.kind === "end_card");

	const pickMove = (plan: Plan, asset: StoryboardAsset): CameraMove => {
		const explicit = plan.actions.find((action) => action.kind === "move");
		if (explicit && explicit.kind === "move") return explicit.move;
		if (asset.kind === "video") return "none";
		if (plan.kind === "end_card") return "push-in";
		const choices: CameraMove[] = ["push-in", "push-in", "pull-out", "pan-left", "pan-right"];
		let move = choices[Math.floor(random() * choices.length)];
		if (move === previousMove) move = choices[(choices.indexOf(move) + 2) % choices.length];
		previousMove = move;
		return move;
	};

	/** Place an image / video over [start, end) ticks on a track. Returns where it really ends. */
	const placeVisual = (
		plan: Plan,
		asset: StoryboardAsset,
		trackId: string,
		ref: string,
		name: string,
		start: number,
		end: number,
		bucket: Op[],
		slowmo: boolean,
	): { end: number; speed?: number; from?: number; to?: number } | null => {
		const duration = end - start;
		const media = mediaOf(asset);
		if (asset.kind === "image") {
			bucket.push({ op: "insert", author, track: trackId, t: sec(start), media, media_kind: "image", dur: sec(duration), name, ref });
			return { end };
		}
		const available = asset.duration_s !== undefined ? ticks(asset.duration_s) : undefined;
		const rate = slowmo ? 0.5 : 1;
		const span = roundHalfAwayFromZero(duration * rate);
		const insert = (out: number) =>
			bucket.push({ op: "insert", author, track: trackId, t: sec(start), media, media_kind: "video", in: 0, out: sec(out), name, ref });
		if (available === undefined) {
			plan.report.warnings.push(`video "${asset.id}" has no duration_s: assumed long enough`);
		}
		if (available === undefined || available >= span) {
			insert(span);
			if (rate !== 1) {
				const exact = span / duration;
				if (roundHalfAwayFromZero(span / exact) === duration) {
					speedOps.push({ op: "set", author, el: ref, prop: "speed", value: exact });
					return { end, speed: exact, from: 0, to: sec(span) };
				}
			}
			return { end, from: 0, to: sec(span) };
		}
		// shorter than the shot: slow it to fill (never below half speed), else let it run short
		const fill = available / duration;
		if (fill >= 0.5 && roundHalfAwayFromZero(available / fill) === duration) {
			insert(available);
			speedOps.push({ op: "set", author, el: ref, prop: "speed", value: fill });
			plan.report.warnings.push(`"${asset.id}" is ${r2(sec(available))} s for a ${r2(sec(duration))} s shot: slowed to ${r3(fill)}×`);
			return { end, speed: fill, from: 0, to: sec(available) };
		}
		insert(available);
		plan.report.warnings.push(`"${asset.id}" is ${r2(sec(available))} s for a ${r2(sec(duration))} s shot: it runs short (gap on the track)`);
		return { end: start + available, from: 0, to: sec(available) };
	};

	for (const plan of plans) {
		const beat = plan.beat;
		const label = `${beat.id}${beat.title ? ` · ${beat.title}` : ""}`;
		const slowmo = plan.actions.some((action) => action.kind === "slowmo");
		const stretchBack = plan === firstMainPlan && plan.start > 0;
		const start = stretchBack ? 0 : plan.start;
		const end = plan.end;
		if (stretchBack) {
			for (const earlier of plans.filter((candidate) => candidate.end <= plan.start)) {
				earlier.report.warnings.push(`no shot: ${beat.id}'s shot is stretched back over it (the main track starts at 0:00)`);
			}
		}
		let mainAsset: StoryboardAsset | null = plan.dialogue ?? plan.visuals[0] ?? null;
		let reused = false;
		if (!mainAsset && plan.kind === "end_card") {
			mainAsset =
				assets.find((asset) => asset.kind === "image" && !attachedIds.has(asset.id) && /end-?card|packshot|logo|product/i.test(`${asset.id} ${asset.name ?? ""} ${(asset.tags ?? []).join(" ")}`)) ??
				lastStill;
			reused = mainAsset !== null && mainAsset === lastStill;
		}
		if (!mainAsset) {
			const reason = "no image or video for this beat";
			plan.report.skipped.push({ what: "shot", reason });
			skipped.push({ beat: beat.id, what: "shot", reason });
			addMissing(
				"placeholder on a video track",
				"ops@1 cannot put a slate or a solid colour on V1 / V2 (insert shape only goes on graphic tracks)",
				"a gap on V1 A-ROLL (the background shows) and a text placeholder on TEXT naming the missing shot",
			);
			const placeholderTrack = textLane(plan.start, plan.end);
			textOps.push({
				op: "insert",
				author,
				track: placeholderTrack,
				t: sec(plan.start),
				// ops@1 has no text wrap: break it ourselves (SEEN 2026-10-20: one long line ran off both frame edges)
				text: wrapText(`${beat.id} · no shot yet${beat.shot ? `: ${beat.shot.slice(0, 60)}` : ""}`, 28).join("\n"),
				dur: sec(plan.end - plan.start),
				name: `${beat.id} placeholder`,
				style: { size: 2.6, color: "#8C8C95", align: "center", y: 0 },
				ref: `${prefix}-b${plan.index}-placeholder`,
			});
			continue;
		}
		const ref = `${prefix}-b${plan.index}-v`;
		if (plan.dialogue && mainAsset === plan.dialogue) {
			const lead = plan.start - start;
			const sourceIn = Math.max(0, plan.voiceIn - lead);
			if (plan.voiceIn - lead < 0) plan.report.warnings.push("stretched back past the start of the dialogue clip: its sound may sit early");
			mainOps.push({
				op: "insert",
				author,
				track: tracks.main,
				t: sec(start),
				media: mediaOf(mainAsset),
				media_kind: "video",
				in: sec(sourceIn),
				out: sec(sourceIn + (end - start)),
				name: label,
				ref,
			});
			if (options.voiceDb) speedOps.push({ op: "gain", author, el: ref, db: options.voiceDb });
			plan.report.visual = { asset: mainAsset.id, kind: "video", move: "none", from: r3(sec(sourceIn)), to: r3(sec(sourceIn + end - start)) };
			const item: Placed = { ref, asset: mainAsset, layer: "main", kind: "video", start, end, move: pickMove(plan, mainAsset), windows: [] };
			if (plan.actions.some((action) => action.kind === "move")) plan.report.visual.move = item.move;
			placed.push(item);
			mainByPlan.set(plan.index, item);
			plan.report.placed.push(`dialogue "${mainAsset.id}" on V1 A-ROLL`);
			continue;
		}
		// B-roll split points: extra visuals take the rest of the beat, cut on a word
		const extras = plan.visuals.filter((asset) => asset !== mainAsset);
		const cuts: number[] = [];
		const span = end - plan.start;
		for (let j = 1; j <= extras.length; j++) {
			const target = plan.start + Math.round((span * j) / (extras.length + 1));
			const candidates = plan.words
				.map((word) => roundFrame(word.start - cutLead))
				.filter((time) => time > plan.start + minBeat / 2 && time < end - minBeat / 2 && (!cuts.length || time > cuts[cuts.length - 1] + frame));
			const best = candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
			cuts.push(best ?? roundFrame(target));
		}
		const move = pickMove(plan, mainAsset);
		const result = placeVisual(plan, mainAsset, tracks.main, ref, reused ? `${label} (holds ${mainAsset.id})` : label, start, end, mainOps, slowmo && mainAsset.kind === "video");
		if (!result) continue;
		const item: Placed = { ref, asset: mainAsset, layer: "main", kind: mainAsset.kind === "video" ? "video" : "image", start, end: result.end, move, windows: [] };
		placed.push(item);
		mainByPlan.set(plan.index, item);
		plan.report.visual = { asset: mainAsset.id, kind: item.kind, move, ...(result.speed !== undefined ? { speed: r4(result.speed) } : {}), ...(result.from !== undefined ? { from: r3(result.from), to: r3(result.to ?? 0) } : {}) };
		plan.report.placed.push(`${item.kind} "${mainAsset.id}" on V1 A-ROLL${move !== "none" ? ` (${move})` : ""}${reused ? " — reused: no end-card image" : ""}`);
		if (reused) plan.report.warnings.push(`no end-card image: holds "${mainAsset.id}" again`);
		if (mainAsset.kind === "image") lastStill = mainAsset;
		const ambience = (asset: StoryboardAsset, el: string) => {
			if (asset.kind === "video" && options.ambienceDb !== null && asset.has_audio !== false && !asset.words?.length && plan.piece) {
				speedOps.push({ op: "gain", author, el, db: options.ambienceDb ?? -14 });
			}
		};
		ambience(mainAsset, ref);
		extras.forEach((asset, j) => {
			const from = cuts[j];
			const to = j + 1 < cuts.length ? cuts[j + 1] : end;
			if (!(to - from >= frame)) {
				plan.report.skipped.push({ what: `b-roll "${asset.id}"`, reason: "no room left in the beat" });
				return;
			}
			const brollRef = `${prefix}-b${plan.index}-r${j + 1}`;
			const brollMove = pickMove(plan, asset);
			const placedBroll = placeVisual(plan, asset, tracks.broll, brollRef, `${beat.id} b-roll ${j + 1}`, from, to, brollOps, slowmo && asset.kind === "video");
			if (!placedBroll) return;
			placed.push({ ref: brollRef, asset, layer: "broll", kind: asset.kind === "video" ? "video" : "image", start: from, end: placedBroll.end, move: brollMove, windows: [] });
			ambience(asset, brollRef);
			plan.report.broll.push({ asset: asset.id, start: r3(sec(from)), end: r3(sec(placedBroll.end)), move: brollMove });
			plan.report.placed.push(`b-roll "${asset.id}" on V2 B-ROLL at ${r2(sec(from))} s`);
			if (asset.kind === "image") lastStill = asset;
		});
	}

	// ---- compositions (rendered clips) and effects that need one
	for (const plan of plans) {
		for (const action of plan.actions) {
			if (action.kind !== "composition") continue;
			const clip =
				plan.compositions.find((asset) => slug(asset.effect ?? "") === action.slug) ??
				assets.find((asset) => asset.effect && slug(asset.effect) === action.slug && !attachedIds.has(asset.id));
			if (!clip) {
				const reason = `"${action.name}" needs a rendered composition (packages/compositions): render it and pass the clip as an asset with effect "${action.slug}"`;
				plan.report.skipped.push({ what: `effect ${action.name}`, reason });
				skipped.push({ beat: plan.beat.id, what: `effect ${action.name}`, reason });
				addMissing(
					"composition by name",
					"no op renders a composition from its name and props; insert needs an already rendered media id",
					"effects are placed only when a rendered clip is passed as an asset with `effect`",
				);
				continue;
			}
			const length = clip.duration_s !== undefined ? Math.min(ticks(clip.duration_s), plan.end - plan.start) : plan.end - plan.start;
			const trackId = motionLane(plan.start, plan.start + length);
			const ref = `${prefix}-b${plan.index}-fx-${action.slug}`;
			motionOps.push({
				op: "insert",
				author,
				track: trackId,
				t: sec(plan.start),
				media: mediaOf(clip),
				media_kind: clip.kind === "image" ? "image" : "video",
				...(clip.kind === "image" ? { dur: sec(length) } : { in: 0, out: sec(length) }),
				name: `${plan.beat.id} ${action.name}`,
				ref,
			});
			plan.report.placed.push(`composition "${clip.id}" (${action.name}) on MOTION`);
		}
		plan.compositions.forEach((asset, k) => {
			if (!plan.actions.some((action) => action.kind === "composition" && slug(asset.effect ?? "") === action.slug)) {
				// a clip attached to the beat without the effect named: still place it
				const length = asset.duration_s !== undefined ? Math.min(ticks(asset.duration_s), plan.end - plan.start) : plan.end - plan.start;
				const trackId = motionLane(plan.start, plan.start + length);
				motionOps.push({
					op: "insert",
					author,
					track: trackId,
					t: sec(plan.start),
					media: mediaOf(asset),
					media_kind: asset.kind === "image" ? "image" : "video",
					...(asset.kind === "image" ? { dur: sec(length) } : { in: 0, out: sec(length) }),
					name: `${plan.beat.id} ${asset.effect}`,
					ref: `${prefix}-b${plan.index}-clip-${k + 1}`,
				});
				plan.report.placed.push(`composition "${asset.id}" (${asset.effect}) on MOTION`);
			}
		});
		for (const action of plan.actions) {
			if (action.kind === "unsupported") {
				plan.report.skipped.push({ what: `effect ${action.name}`, reason: action.why });
				addMissing(`effect ${slug(action.name)}`, action.why, "skipped");
			}
		}
	}

	// ---- voice pieces
	for (const plan of plans) {
		const piece = plan.piece;
		if (!piece) continue;
		const at = sec(plan.voiceAt);
		plan.report.voice = {
			asset: piece.asset.id,
			source: piece.source,
			in: r3(sec(plan.voiceIn)),
			out: r3(sec(plan.voiceOut)),
			at: r3(at),
			words: plan.words.length,
		};
		if (piece.source === "dialogue") continue;
		const ref = `${prefix}-b${plan.index}-vo`;
		voiceOps.push({
			op: "insert",
			author,
			track: voiceTrack as string,
			t: at,
			media: mediaOf(piece.asset),
			media_kind: "audio",
			in: sec(plan.voiceIn),
			out: sec(plan.voiceOut),
			name: `${plan.beat.id} VO`,
			ref,
		});
		if (options.voiceDb) voiceOps.push({ op: "gain", author, el: ref, db: options.voiceDb });
		plan.report.placed.push(`VO "${piece.asset.id}" ${r2(sec(plan.voiceIn))}–${r2(sec(plan.voiceOut))} s at ${r2(at)} s`);
	}

	// ---- punch-ins on emphasis words, camera moves
	const visibleAt = (time: number): Placed | undefined => {
		const covering = placed.filter((item) => item.start <= time && time < item.end);
		return covering.find((item) => item.layer === "broll") ?? covering[0];
	};
	for (const plan of plans) {
		const terms = (plan.beat.emphasis ?? []).map((term) => lineTokens(term)[0]).filter(Boolean);
		const wantsPunch = plan.actions.some((action) => action.kind === "punch");
		if (wantsPunch && !terms.length && plan.words.length) {
			const middle = (plan.start + plan.end) / 2;
			const word = plan.words.slice().sort((a, b) => Math.abs(a.start - middle) - Math.abs(b.start - middle))[0];
			terms.push(normToken(word.text));
		}
		if (!terms.length) continue;
		if (!plan.words.length) {
			plan.report.skipped.push({ what: "punch-ins", reason: "no word timings for this beat" });
			continue;
		}
		const used = new Set<number>();
		for (const term of terms) {
			const index = plan.words.findIndex((word, i) => !used.has(i) && normToken(word.text) === term);
			if (index < 0) {
				plan.report.skipped.push({ what: `punch-in "${term}"`, reason: "the word is not heard in this beat's voice" });
				continue;
			}
			used.add(index);
			const word = plan.words[index];
			const on = roundFrame(word.start);
			const item = visibleAt(on);
			if (!item || on >= item.end - frame) {
				plan.report.skipped.push({ what: `punch-in "${word.text}"`, reason: "no shot on screen at that word" });
				continue;
			}
			const off = Math.min(item.end, Math.max(roundFrame(word.end + ticks(0.2)), on + punchHold));
			item.windows.push([Math.max(on, item.start), off]);
			plan.report.punches.push({ word: word.text, at: r3(sec(on)), until: r3(sec(off)) });
		}
		if (plan.report.punches.length) {
			addMissing(
				"punch-in centre",
				"keyframe scale zooms about the element's centre; there is no anchor / zoom-centre prop to punch towards a face box (FX-05)",
				"centred punch-ins",
			);
		}
	}
	const dx = Math.round(((pan - 1) * canvas.width) / 2 * 0.85);
	const dy = Math.round(((pan - 1) * canvas.height) / 2 * 0.85);
	for (const item of placed) {
		const s = item.start;
		const e = item.end;
		const move = item.move;
		const key =(prop: string, t: number, value: number, ease?: Ease) =>
			cameraOps.push({ op: "keyframe", author, el: item.ref, prop, t: sec(t), value: r4(value), ...(ease ? { ease } : {}) });
		let s0 = 1;
		let s1 = 1;
		if (move === "push-in") s1 = push;
		else if (move === "pull-out") s0 = push;
		else if (move !== "none") {
			s0 = pan;
			s1 = pan;
		}
		const moving = s0 !== s1;
		const base = (t: number) => s0 + ((s1 - s0) * (t - s)) / Math.max(1, e - s);
		const windows = mergeSpans(item.windows, 1).filter(([on]) => on < e - frame);
		if (!windows.length) {
			if (moving) {
				key("scale", s, s0);
				key("scale", e, s1, "ease_in_out");
			} else if (s0 !== 1) key("scale", s, s0);
		} else {
			let last = -1;
			const at = (t: number, value: number, ease?: Ease) => {
				if (t <= last || t > e) return;
				key("scale", t, value, ease);
				last = t;
			};
			at(s, windows[0][0] <= s + frame ? base(s) * punch : base(s));
			for (const [on, off] of windows) {
				if (on > s + frame) {
					if (moving && on - frame > last) at(on - frame, base(on - frame), "linear");
					at(on, base(on) * punch, "hold");
				}
				if (off < e) {
					if (moving && off - frame > last) at(off - frame, base(off - frame) * punch, "linear");
					at(off, base(off), "hold");
				}
			}
			if (moving && e > last) at(e, base(e), "linear");
		}
		if (move === "pan-left" || move === "pan-right") {
			const from = move === "pan-left" ? -dx : dx;
			key("x", s, from);
			key("x", e, -from, "ease_in_out");
		} else if (move === "tilt-up" || move === "tilt-down") {
			const from = move === "tilt-down" ? dy : -dy;
			key("y", s, from);
			key("y", e, -from, "ease_in_out");
		}
	}

	// ---- transitions into beats (beat effect first, else the style's join)
	plans.forEach((plan, i) => {
		if (i === 0) return;
		const a = mainByPlan.get(plans[i - 1].index);
		const b = mainByPlan.get(plan.index);
		const named = plan.actions.find((action) => action.kind === "transition");
		const kind = named && named.kind === "transition" ? named.transition : preset?.join ?? null;
		if (!kind) return;
		if (!a || !b || a.end !== b.start) {
			if (named) plan.report.skipped.push({ what: `transition ${kind}`, reason: "the shots either side of the cut do not touch" });
			return;
		}
		const resolved = resolveTransitionKind(kind);
		const defaultDur = named ? (resolved ? TRANSITION_KINDS[resolved] ?? 0.3 : 0.3) : 0.2;
		const room = Math.min(a.end - a.start, b.end - b.start);
		const dur = Math.min(ticks(defaultDur), Math.floor(room / 2));
		if (dur < frame) {
			plan.report.skipped.push({ what: `transition ${kind}`, reason: "the shots are too short for it" });
			return;
		}
		transitionOps.push({ op: "transition", author, a: a.ref, b: b.ref, kind, dur: sec(dur) });
		plan.report.transitionIn = kind;
	});

	// ---- end card: the CTA
	const endPlan = endIndex >= 0 ? plans[endIndex] : undefined;
	const cta = (endPlan?.beat.cta ?? spec.cta ?? endPlan?.beat.line ?? "").trim();
	if (endPlan && endCardOptions && cta) {
		const lines = wrapText(cta, 22);
		const longest = Math.max(...lines.map((line) => line.length));
		const px = (0.88 * canvas.width) / (0.56 * Math.max(1, longest));
		const size = Math.max(2.5, Math.min(7, Math.round(((px * 90) / canvas.height) * 10) / 10));
		const style: TextStyle = {
			size,
			weight: "bold",
			color: "#FFFFFF",
			align: "center",
			y: Math.round(canvas.height * 0.16),
			bg: true,
			bg_color: "#111111",
			bg_radius: 24,
			...(endCardOptions.style ?? {}),
		};
		const trackId = textLane(endPlan.start, endPlan.end);
		textOps.push({
			op: "text_pop",
			author,
			t: sec(endPlan.start),
			text: lines.join("\n"),
			dur: sec(endPlan.end - endPlan.start),
			track: trackId,
			style,
			ref: `${prefix}-cta`,
		});
		endPlan.report.placed.push(`CTA "${cta}" on TEXT`);
		if (lines.length > 1) {
			addMissing(
				"text wrap",
				"TextStyle has no max width / wrap; long text runs off a 9:16 canvas",
				"the CTA is broken into lines with \\n and sized from its longest line (line breaks UNVERIFIED in the editor's text renderer)",
			);
		}
	} else if (endPlan && endCardOptions && !cta) {
		endPlan.report.skipped.push({ what: "CTA text", reason: "no CTA: the brief has none and the end-card beat has no line" });
	}

	// ---- big words (FX-22)
	for (const plan of plans) {
		if (!plan.actions.some((action) => action.kind === "big-word")) continue;
		const term = (plan.beat.emphasis ?? []).map((value) => lineTokens(value)[0]).find(Boolean);
		const word = (term ? plan.words.find((candidate) => normToken(candidate.text) === term) : undefined) ?? plan.words[0];
		if (!word) {
			plan.report.skipped.push({ what: "big word", reason: "no word timings for this beat" });
			continue;
		}
		const on = roundFrame(word.start);
		const off = Math.min(plan.end, Math.max(roundFrame(word.end + ticks(0.5)), on + ticks(0.6)));
		if (off - on < frame) continue;
		const trackId = textLane(on, off);
		textOps.push({
			op: "text_pop",
			author,
			t: sec(on),
			text: word.text.replace(/[.,!?;:]+$/, ""),
			dur: sec(off - on),
			track: trackId,
			style: { uppercase: true },
			ref: `${prefix}-b${plan.index}-bigword`,
		});
		plan.report.placed.push(`big word "${word.text}" on TEXT`);
	}

	// ---- captions
	const captionsOption = options.captions ?? true;
	const captionWords: TimedWord[] = [];
	if (captionsOption !== false) {
		const captionConfig = typeof captionsOption === "object" ? captionsOption : {};
		for (const plan of plans) {
			if (plan.kind === "end_card" && cta && endCardOptions && !captionConfig.overEndCard) continue;
			for (const word of plan.words) {
				const last = captionWords[captionWords.length - 1];
				const start = sec(word.start);
				if (last && start < last.start) continue;
				captionWords.push({ text: word.text, start, end: sec(word.end) });
			}
		}
		if (captionWords.length) {
			let style: TextStyle | undefined;
			if (preset) {
				const { yFraction, ...captionStyle } = preset.captions;
				style = { ...captionStyle, align: "center", ...(yFraction !== undefined ? { y: Math.round(canvas.height * yFraction) } : {}) };
			}
			if (captionConfig.style) style = { ...(style ?? {}), ...captionConfig.style };
			captionOps.push({
				op: "add_captions",
				author,
				track: tracks.captions,
				words: captionWords,
				max_words: Math.min(3, Math.max(1, captionConfig.maxWords ?? 3)),
				...(style ? { style } : {}),
			});
			if (plans.some((plan) => (plan.beat.emphasis ?? []).length)) {
				addMissing(
					"caption emphasis",
					"add_captions has no per-word highlight / emphasis field (one text element has one colour)",
					"the emphasis words get a punch-in instead; captions.ts buildCaptionOps can lay a highlight-word track when a browser measures text",
				);
			}
		} else {
			notes.push("no word timings anywhere: no captions");
		}
	}

	// ---- music: bed from 0, repeated if short, ducked under the voice, faded out
	const musicConfig = options.music === false ? null : (options.music ?? {});
	const voiceSpans: Array<[number, number]> = plans.flatMap((plan) => plan.words.map((word) => [word.start, word.end] as [number, number]));
	let musicPlaced = 0;
	if (musicConfig && music && total > 0) {
		const musicDb = music.db ?? musicConfig.db ?? -10;
		const length = music.duration_s !== undefined ? ticks(music.duration_s) : total;
		const refs: string[] = [];
		let at = 0;
		while (at < total && refs.length < 50) {
			const piece = Math.min(length, total - at);
			if (piece < frame) break;
			const ref = `${prefix}-music-${refs.length + 1}`;
			musicOps.push({
				op: "insert",
				author,
				track: tracks.music,
				t: sec(at),
				media: mediaOf(music),
				media_kind: "audio",
				in: 0,
				out: sec(piece),
				name: refs.length ? `Music bed (repeat ${refs.length + 1})` : "Music bed",
				ref,
			});
			musicOps.push({ op: "gain", author, el: ref, db: musicDb });
			refs.push(ref);
			at += piece;
		}
		musicPlaced = refs.length;
		if (refs.length > 1) {
			addMissing("music loop", "insert has no loop; a bed shorter than the cut stops", "the bed is inserted again back to back");
		}
		const attack = ticks((musicConfig.attackMs ?? 80) / 1000);
		const release = ticks((musicConfig.releaseMs ?? 300) / 1000);
		const amount = -Math.abs(musicConfig.duckDb ?? 8);
		const spans = mergeSpans(voiceSpans, ticks(0.5));
		if (spans.length) {
			musicOps.push({
				op: "duck",
				author,
				track: tracks.music,
				under: voiceTrack ?? tracks.main,
				amount_db: Math.abs(amount),
				attack_ms: musicConfig.attackMs ?? 80,
				release_ms: musicConfig.releaseMs ?? 300,
				spans: spans.map(([a, b]) => [r3(sec(a)), r3(sec(b))] as [number, number]),
			});
		}
		// fade-out on the last piece: keys after the duck (duck replaces the whole volume channel)
		const fade = ticks(musicConfig.fadeOut ?? 1.2);
		const lastStart = total - Math.min(length, total - (refs.length - 1) * length);
		const fadeStart = Math.max(lastStart, total - fade);
		if (refs.length && total - fadeStart >= frame) {
			const merged = mergeSpans(
				spans.map(([a, b]) => [secondsToTicks(r3(sec(a))), secondsToTicks(r3(sec(b)))] as [number, number]),
				attack + release,
			);
			const points: Array<[number, number]> = [];
			for (const [a, b] of merged) points.push([a - attack, 0], [a, amount], [b, amount], [b + release, 0]);
			const reductionAt = (time: number): number => {
				if (!points.length || time <= points[0][0] || time >= points[points.length - 1][0]) return 0;
				for (let i = 0; i < points.length - 1; i++) {
					const [t0, v0] = points[i];
					const [t1, v1] = points[i + 1];
					if (time >= t0 && time <= t1) return t1 === t0 ? v1 : v0 + ((time - t0) / (t1 - t0)) * (v1 - v0);
				}
				return 0;
			};
			const lastRef = refs[refs.length - 1];
			musicOps.push({ op: "keyframe", author, el: lastRef, prop: "volume", t: sec(fadeStart), value: r2(musicDb + reductionAt(fadeStart)) });
			musicOps.push({ op: "keyframe", author, el: lastRef, prop: "volume", t: sec(total), value: -60 });
		}
	} else if (musicConfig && !music) {
		skipped.push({ what: "music", reason: "no music asset: no bed, no ducking" });
	}

	// ---- SFX: cues (priority) and whooshes on cuts, ≥ minGap apart
	const sfxConfig = options.sfx === false ? null : (options.sfx ?? {});
	let sfxPlaced = 0;
	let sfxPending = 0;
	if (sfxConfig) {
		const minGap = ticks(sfxConfig.minGap ?? 0.25);
		const library = sfxConfig.library ?? [];
		const stop = new Set(["the", "a", "an", "of", "only", "sound", "sfx", "fx", "and", "on", "in", "its", "it", "s"]);
		const cueTokens = (text: string) => lineTokens(text).filter((token) => !stop.has(token));
		const score = (want: string[], have: string[]) =>
			want.filter((token) => have.some((candidate) => candidate === token || (token.length >= 4 && candidate.startsWith(token)) || (candidate.length >= 4 && token.startsWith(candidate)))).length;
		type Source =
			| { type: "asset"; asset: StoryboardAsset; sync: number }
			| { type: "library"; entry: SfxLibraryEntry }
			| { type: "pending"; name: string };
		const candidates: Array<{ kind: "cue" | "cut"; plan: Plan; event: number; priority: number; why: string; source: Source }> = [];
		const whooshAssets = sfxPool.filter((asset) => /whoosh|swish|swoosh|swipe|transition/i.test(`${asset.id} ${asset.name ?? ""} ${(asset.tags ?? []).join(" ")}`));
		const whooshLibrary = ["whoosh-short", "swish"].map((id) => library.find((entry) => entry.id === id)).filter((entry): entry is SfxLibraryEntry => Boolean(entry));
		const cutLibrary = whooshLibrary.length ? whooshLibrary : library.filter((entry) => entry.roles.includes("cut"));
		for (const plan of plans) {
			const cue = plan.beat.sound?.trim();
			if (cue) {
				const want = cueTokens(cue);
				const own = plan.attached.filter((asset) => asset.kind === "sfx");
				const ranked = sfxPool
					.map((asset) => ({ asset, score: score(want, [...lineTokens(asset.id), ...lineTokens(asset.name), ...(asset.tags ?? []).map(normToken)]) }))
					.filter((entry) => entry.score > 0)
					.sort((a, b) => b.score - a.score);
				const fromLibrary = library
					.map((entry) => ({ entry, score: score(want, [...lineTokens(entry.id), ...(entry.tags ?? []).map(normToken), normToken(entry.category)]) }))
					.filter((entry) => entry.score > 0)
					.sort((a, b) => b.score - a.score)[0];
				let source: Source;
				if (own[0]) source = { type: "asset", asset: own[0], sync: own[0].sync_s ?? 0 };
				else if (ranked[0]) source = { type: "asset", asset: ranked[0].asset, sync: ranked[0].asset.sync_s ?? 0 };
				else if (fromLibrary) source = { type: "library", entry: fromLibrary.entry };
				else source = { type: "pending", name: cue };
				candidates.push({ kind: "cue", plan, event: plan.start, priority: 100, why: `${plan.beat.id} cue: ${cue}`, source });
			}
		}
		if (sfxConfig.onCuts !== false) {
			let alternate = 0;
			let warned = false;
			for (const plan of plans.slice(1)) {
				let source: Source | null = null;
				if (whooshAssets.length) {
					const asset = whooshAssets[alternate % whooshAssets.length];
					source = { type: "asset", asset, sync: asset.sync_s ?? 0.02 };
				} else if (cutLibrary.length) {
					source = { type: "library", entry: cutLibrary[alternate % cutLibrary.length] };
				}
				alternate++;
				if (!source) {
					if (!warned) {
						skipped.push({ what: "whooshes on cuts", reason: "no whoosh sound: pass an sfx asset named whoosh / swish, or sfx.library" });
						warned = true;
					}
					continue;
				}
				candidates.push({ kind: "cut", plan, event: plan.start, priority: 70, why: `cut to ${plan.beat.id}`, source });
			}
		}
		const accepted: typeof candidates = [];
		for (const candidate of [...candidates].sort((a, b) => b.priority - a.priority || a.event - b.event)) {
			const clash = accepted.find((other) => Math.abs(other.event - candidate.event) < minGap);
			if (clash) {
				candidate.plan.report.skipped.push({ what: `sfx (${candidate.why})`, reason: `within ${sec(minGap)} s of ${clash.why}` });
				continue;
			}
			accepted.push(candidate);
		}
		accepted.sort((a, b) => a.event - b.event || b.priority - a.priority);
		accepted.forEach((candidate, n) => {
			const ref = `${prefix}-sfx-${n + 1}`;
			const source = candidate.source;
			if (source.type === "pending") {
				sfxOps.push({ op: "sfx", author, t: sec(candidate.event), name: source.name });
				pendingList.push({ op: "sfx", what: `"${source.name}" at ${r2(sec(candidate.event))} s (${candidate.why})`, honouredBy: "gateway" });
				candidate.plan.report.sfx.push(`${source.name} (pending: the gateway resolves the name)`);
				sfxPending++;
				return;
			}
			const sync = source.type === "asset" ? ticks(source.sync) : ticks(source.entry.sync_s);
			const start = Math.max(0, candidate.event - sync);
			const length = source.type === "asset" ? (source.asset.duration_s !== undefined ? ticks(source.asset.duration_s) : undefined) : ticks(source.entry.duration_s);
			if (length === undefined) {
				candidate.plan.report.skipped.push({ what: `sfx (${candidate.why})`, reason: "the sfx asset has no duration_s" });
				return;
			}
			const dur = Math.min(length, total - start);
			if (dur < ticks(0.05)) {
				candidate.plan.report.skipped.push({ what: `sfx (${candidate.why})`, reason: "less than 0.05 s before the end" });
				return;
			}
			const trackId = sfxLane(start, start + dur);
			const soundName = source.type === "asset" ? source.asset.id : source.entry.id;
			const name = `SFX ${soundName} · ${candidate.why}`;
			if (source.type === "asset") {
				sfxOps.push({ op: "sfx", author, t: sec(start), name, media: mediaOf(source.asset), dur: sec(dur), track: trackId, db: source.asset.db ?? sfxConfig.db ?? -8, ref });
			} else {
				sfxOps.push({ op: "sfx", author, t: sec(start), name, url: source.entry.url, dur: sec(dur), track: trackId, db: source.entry.default_db, ref });
			}
			candidate.plan.report.sfx.push(name);
			sfxPlaced++;
		});
	}

	// ---- grade (grade agent, 2026-10-20: the reducer applies known looks as the real `restorff-grade` effect; only a
	// name grades.ts does not know stays pending)
	const gradeName = options.grade !== undefined ? options.grade : (preset?.grade ?? null);
	const gradeKnown = (name: string) => resolveGradeName(name) !== null;
	if (gradeName) {
		gradeOps.push({ op: "grade", author, target: "all", preset: gradeName });
		if (!gradeKnown(gradeName)) pendingList.push({ op: "grade", what: `grade "${gradeName}" on the whole cut (unknown look)`, honouredBy: "editor" });
	}
	for (const plan of plans) {
		for (const action of plan.actions) {
			if (action.kind !== "grade") continue;
			const item = mainByPlan.get(plan.index);
			if (!item) {
				plan.report.skipped.push({ what: `grade ${action.grade}`, reason: "no shot to grade" });
				continue;
			}
			gradeOps.push({ op: "grade", author, target: item.ref, preset: action.grade });
			if (gradeKnown(action.grade)) {
				plan.report.placed.push(`grade ${action.grade}`);
			} else {
				pendingList.push({ op: "grade", what: `grade "${action.grade}" on ${plan.beat.id} (unknown look)`, honouredBy: "editor" });
				plan.report.placed.push(`grade ${action.grade} (pending: unknown look)`);
			}
		}
	}

	// ---- bookmarks, loudness
	if (options.marks !== false) {
		for (const plan of plans) {
			const title = plan.beat.title ?? plan.beat.shot ?? "";
			const line = plan.beat.line?.trim();
			markOps.push({
				op: "mark",
				author,
				t: sec(plan.start),
				note: `${plan.beat.id}${title ? ` · ${title}` : ""}${line ? ` — "${line}"` : ""}`,
				dur: sec(plan.end - plan.start),
			});
		}
		addMissing(
			"beat link on elements",
			"no op writes a beat / board-card id onto an element (the restorff tag is not settable), so EDT-14's two-way storyboard ↔ timeline sync has nothing to key on",
			"element names start with the beat id, and every beat is a bookmark with its line",
		);
	}
	const loudness = options.normalize === false ? null : (options.normalize ?? { lufs: -14, true_peak: -1 });
	if (loudness) tailOps.push({ op: "normalize", author, lufs: loudness.lufs, true_peak: loudness.true_peak });

	const ops: Op[] = [
		...canvasOps,
		...importOps,
		...trackOps,
		...mainOps,
		...brollOps,
		...motionOps,
		...speedOps,
		...cameraOps,
		...transitionOps,
		...voiceOps,
		...captionOps,
		...textOps,
		...musicOps,
		...sfxOps,
		...gradeOps,
		...markOps,
		...tailOps,
	];

	// ---- report
	for (const plan of plans) {
		plan.report.start = r3(sec(plan.start));
		plan.report.end = r3(sec(plan.end));
		plan.report.duration = r3(sec(plan.end - plan.start));
		for (const entry of plan.report.skipped) {
			if (!skipped.some((other) => other.beat === plan.beat.id && other.what === entry.what)) skipped.push({ beat: plan.beat.id, ...entry });
		}
	}
	const counts: Record<string, number> = {
		beats: plans.length,
		shots: mainOps.filter((op) => op.op === "insert").length,
		broll: brollOps.filter((op) => op.op === "insert").length,
		compositions: motionOps.length,
		voicePieces: voiceOps.filter((op) => op.op === "insert").length,
		captionWords: captionWords.length,
		cameraKeys: cameraOps.length,
		punchIns: plans.reduce((sum, plan) => sum + plan.report.punches.length, 0),
		transitions: transitionOps.length,
		music: musicPlaced,
		sfx: sfxPlaced,
		sfxPending,
		grades: gradeOps.length,
		marks: markOps.length,
		ops: ops.length,
	};
	const placedLines = [
		`${counts.shots} shot(s) on V1 A-ROLL, ${counts.broll} b-roll on V2, ${counts.compositions} composition(s)`,
		`${counts.voicePieces} VO piece(s)${voiceTrack && hasVoTrack ? ` on ${tracks.voice ? voiceTrack : "VOICE"}` : ""}; ${counts.captionWords} caption word(s)`,
		`${counts.cameraKeys} camera keyframe(s), ${counts.punchIns} punch-in(s), ${counts.transitions} transition(s)`,
		musicPlaced ? `music bed × ${musicPlaced}, ducked under the voice, faded out` : "no music",
		`${sfxPlaced} SFX placed, ${sfxPending} pending`,
		gradeName
			? gradeKnown(gradeName)
				? `grade "${gradeName}" on the whole cut (GRADE layer under the captions)`
				: `grade "${gradeName}" (pending: not a look grades.ts knows)`
			: "no grade",
		endPlan && cta && endCardOptions ? `end card ${endPlan.beat.id}: "${cta}"` : "no end card text",
	];
	const unusedAssets = assets.filter((asset) => !usedAssets.has(asset.id)).map((asset) => asset.id);
	const validation = validateOps(ops);
	if (!validation.ok) notes.push(`BUG: the compiler emitted ${validation.errors.length} invalid op(s) — see validation.errors`);

	const report: StoryboardCompileReport = {
		compiler: STORYBOARD_COMPILER_VERSION,
		title: spec.title,
		seed,
		style: preset?.id ?? null,
		duration: r3(sec(total)),
		fps: fpsValue,
		canvas,
		tracks: { ...tracks, ...(voiceTrack ? { voice: voiceTrack } : {}), added: addedTracks },
		beats: plans.map((plan) => plan.report),
		words: captionWords,
		counts,
		placed: placedLines,
		skipped,
		missing: [...missing.values()],
		pending: pendingList,
		unusedAssets,
		notes: [...(spec.notes ?? []), ...notes],
		validation,
	};
	return { ops, report };
}
