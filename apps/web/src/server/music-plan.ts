/**
 * Music beds and voice on a timeline: the pure planning half of the `music` and `voiceover` tools (voice-music agent,
 * 2026-10-20). No Node imports: the MCP tools (server) and the Sounds panel (browser) both use it.
 *
 * Model (ops@1 has no "music" op, so a bed is placed with what exists):
 *   - a bed = one or more LIBRARY audio elements (`sfx` op with `url` + `dur` + `track`, sourceUrl /music/<id>.ogg)
 *     back to back on a MUSIC track; each copy is one loop (the beds are seamless loops, public/music/manifest.json);
 *     after the reducer runs, each element is re-tagged `restorff.role = "music"` + `restorff.music` (bed, run, loop),
 *     its source length set to the whole loop, and the track tagged `restorff.role = "music"`;
 *   - every copy gets its beat grid (`beats` op), so the media agent's beat snap and `snap_cuts` see the beats;
 *   - the level: "auto" = −22 LUFS when a voice is on the timeline, −18 LUFS when not (gain op);
 *   - ducking: the `duck` op on the MUSIC track under the voice, with spans = where words are spoken (voice-over words
 *     from `restorff.voice.words`, else whole voice clips, else the A-roll's clips when their media has audio);
 *   - fades: 30 ms in at a bed's start, `fade` seconds out at its end (keyframe ops on volume, on top of the duck).
 * A voice-over = an UPLOAD audio element on a VOICE track (role "voice") carrying `restorff.voice` = {take, words…}.
 */
import type { Op, Project as OpsProject } from "@restorffcut/timeline-ops";

export const TICKS_PER_SECOND = 120_000;
const s = (ticks: number) => ticks / TICKS_PER_SECOND;
const r3 = (value: number) => Math.round(value * 1000) / 1000;

/** Loudness the music sits at (LUFS, before the export's −14 LUFS master), and how it moves. */
export const MUSIC_MIX = {
	withVoiceLufs: -22,
	aloneLufs: -18,
	duckDb: 10,
	attackMs: 120,
	releaseMs: 350,
	/** Voice spans closer than this are held as one (the music does not pump between words). */
	holdGap: 0.6,
	fadeInS: 0.03,
	fadeOutMaxS: 1.5,
} as const;

export interface MusicBed {
	id: string;
	name: string;
	mood: string;
	description?: string;
	use?: string;
	tags?: string[];
	url: string;
	bytes?: number;
	bpm: number;
	bars: number;
	key?: string;
	duration_s: number;
	beat_times_s: number[];
	downbeats: number[];
	lufs_i: number | null;
	true_peak_dbtp?: number | null;
}

export interface MusicTag {
	bed: string;
	mood: string;
	run: string;
	loop: number;
	loops: number;
	level: "auto" | number;
	duck_db: number;
	fade_out_s: number;
	bpm: number;
	/** The bed's measured integrated loudness (manifest), for the auto level. */
	lufs_i: number | null;
	/**
	 * sound-voice-v2 (2026-10-20): placed with `loop: true` — the span is whole bars and the run has NO fade in or out,
	 * so a cut that loops (its last frame flows into its first) loops the music too.
	 */
	seamless?: boolean;
	/** Whole bars in the run (loop: true). */
	bars?: number;
}

/** Seconds per bar of a bed (its loop is whole bars). */
export const barSeconds = (bed: Pick<MusicBed, "duration_s" | "bars">) => bed.duration_s / Math.max(1, bed.bars);

export interface BarSnap {
	/** The length asked for (the cut, or duration_s). */
	asked_s: number;
	bar_s: number;
	/** asked_s in bars, unrounded. */
	bars_exact: number;
	/** What the bed uses: the nearest whole number of bars (≥ 1). */
	bars: number;
	length_s: number;
	/** length_s − asked_s. */
	delta_s: number;
	/** Both neighbours, for the hint. */
	options: Array<{ bars: number; length_s: number; delta_s: number }>;
}

/** The nearest whole-bar length to `seconds` (and its neighbours) for a bed. */
export function snapToBars(bed: Pick<MusicBed, "duration_s" | "bars">, seconds: number): BarSnap {
	const bar = barSeconds(bed);
	const exact = seconds / bar;
	const down = Math.max(1, Math.floor(exact + 1e-6));
	const up = Math.max(1, Math.ceil(exact - 1e-6));
	const bars = Math.max(1, Math.round(exact));
	const option = (n: number) => ({ bars: n, length_s: r3(n * bar), delta_s: r3(n * bar - seconds) });
	return {
		asked_s: r3(seconds),
		bar_s: r3(bar),
		bars_exact: Math.round(exact * 1000) / 1000,
		bars,
		length_s: r3(bars * bar),
		delta_s: r3(bars * bar - seconds),
		options: down === up ? [option(down)] : [option(down), option(up)],
	};
}

export interface VoiceTag {
	take: string;
	hash: string;
	voice: string;
	engine: string;
	speed: number;
	text: string;
	/** SOURCE seconds into the take. */
	words: Array<{ text: string; start: number; end: number }>;
}

type AnyTrack = OpsProject["scenes"][number]["tracks"]["audio"][number] | OpsProject["scenes"][number]["tracks"]["overlay"][number] | OpsProject["scenes"][number]["tracks"]["main"];
type AnyElement = AnyTrack["elements"][number];
type Tagged = { restorff?: { role?: string; music?: MusicTag; voice?: VoiceTag } & Record<string, unknown> };

export function activeScene(project: OpsProject) {
	return project.scenes.find((scene) => scene.id === project.currentSceneId) ?? project.scenes.find((scene) => scene.isMain) ?? project.scenes[0];
}

const roleOf = (item: unknown) => (item as Tagged).restorff?.role;
export const musicTagOf = (element: unknown): MusicTag | undefined => (element as Tagged).restorff?.music;
export const voiceTagOf = (element: unknown): VoiceTag | undefined => (element as Tagged).restorff?.voice;

export function isVoiceTrack(track: AnyTrack): boolean {
	return track.type === "audio" && (roleOf(track) === "voice" || /^(VOICE|VO)\b/i.test(track.name ?? ""));
}
export function isMusicTrack(track: AnyTrack): boolean {
	return track.type === "audio" && (roleOf(track) === "music" || /^MUSIC\b/i.test(track.name ?? ""));
}
export function isSfxTrack(track: AnyTrack): boolean {
	return track.type === "audio" && (roleOf(track) === "sfx" || /^SFX\b/i.test(track.name ?? ""));
}

const endOf = (element: AnyElement) => element.startTime + element.duration;

/** Where the cut's content ends, seconds (music lanes left out: a bed fits the cut, not itself). */
export function contentEndSeconds(project: OpsProject): number {
	const scene = activeScene(project);
	if (!scene) return 0;
	let end = 0;
	for (const track of [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio] as AnyTrack[]) {
		if (isMusicTrack(track)) continue;
		for (const element of track.elements as AnyElement[]) end = Math.max(end, endOf(element));
	}
	return s(end);
}

function mediaHasAudio(project: OpsProject, mediaId: string): boolean | undefined {
	const media = (project.metadata as { restorff?: { media?: Array<{ id: string; hasAudio?: boolean }> } }).restorff?.media ?? [];
	return media.find((entry) => entry.id === mediaId)?.hasAudio;
}

export interface VoiceSpans {
	/** Timeline seconds, merged when closer than MUSIC_MIX.holdGap. */
	spans: Array<[number, number]>;
	/** The track the `duck` op names as `under`. */
	under: string | null;
	source: "voice-words" | "voice-clips" | "a-roll" | null;
}

function mergeSpans(spans: Array<[number, number]>, gap: number): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const span of [...spans].sort((a, b) => a[0] - b[0])) {
		const last = out[out.length - 1];
		if (last && span[0] - last[1] < gap) last[1] = Math.max(last[1], span[1]);
		else out.push([span[0], span[1]]);
	}
	return out.map(([a, b]) => [r3(a), r3(b)] as [number, number]);
}

/** Where someone speaks on the timeline (see the header for the order of sources). */
export function voiceSpans(project: OpsProject): VoiceSpans {
	const scene = activeScene(project);
	if (!scene) return { spans: [], under: null, source: null };
	const voiceTracks = (scene.tracks.audio as AnyTrack[]).filter((track) => isVoiceTrack(track) && !(track as { muted?: boolean }).muted);
	const spans: Array<[number, number]> = [];
	let words = false;
	for (const track of voiceTracks) {
		for (const element of track.elements as AnyElement[]) {
			if ((element.params as Record<string, unknown>)?.muted === true) continue;
			const tag = voiceTagOf(element);
			const start = s(element.startTime);
			const end = s(endOf(element));
			if (tag?.words?.length) {
				const rate = (element as { retime?: { rate?: number } }).retime?.rate || 1;
				const sourceIn = s(element.trimStart);
				for (const word of tag.words) {
					const a = start + (word.start - sourceIn) / rate;
					const b = start + (word.end - sourceIn) / rate;
					if (b > start && a < end) spans.push([Math.max(start, a), Math.min(end, b)]);
				}
				words = true;
			} else {
				spans.push([start, end]);
			}
		}
	}
	if (spans.length) return { spans: mergeSpans(spans, MUSIC_MIX.holdGap), under: voiceTracks[0].id, source: words ? "voice-words" : "voice-clips" };
	// no voice-over: a talking head on the main track, when its media is known to carry audio
	const main = scene.tracks.main;
	for (const element of main.elements as AnyElement[]) {
		if (element.type !== "video" || (element as { isSourceAudioEnabled?: boolean }).isSourceAudioEnabled === false) continue;
		if (mediaHasAudio(project, (element as { mediaId: string }).mediaId) !== true) continue;
		spans.push([s(element.startTime), s(endOf(element))]);
	}
	if (spans.length) return { spans: mergeSpans(spans, MUSIC_MIX.holdGap), under: main.id, source: "a-roll" };
	return { spans: [], under: null, source: null };
}

export interface TimelineBeat {
	t: number;
	downbeat: boolean;
}

/** Every visible beat of every unmuted audio element (e.g. a bed), timeline seconds, sorted. */
export function timelineBeats(project: OpsProject): TimelineBeat[] {
	const scene = activeScene(project);
	if (!scene) return [];
	const out: TimelineBeat[] = [];
	for (const track of scene.tracks.audio as AnyTrack[]) {
		if ((track as { muted?: boolean }).muted) continue;
		for (const element of track.elements as AnyElement[]) {
			const beats = (element as { beats?: { times: number[]; downbeats?: number[] } }).beats;
			if (!beats?.times?.length) continue;
			const rate = (element as { retime?: { rate?: number } }).retime?.rate || 1;
			const downbeats = new Set(beats.downbeats ?? []);
			beats.times.forEach((source, i) => {
				const t = element.startTime + (source - element.trimStart) / rate;
				if (t >= element.startTime && t < endOf(element)) out.push({ t: r3(s(t)), downbeat: downbeats.has(i) });
			});
		}
	}
	return out.sort((a, b) => a.t - b.t);
}

/** The duck op's reduction (dB ≤ 0) at a timeline time — same envelope as timeline-ops reducer `opDuck`. */
export function duckReductionAt(time: number, spans: Array<[number, number]>, amountDb: number, attackS: number, releaseS: number): number {
	if (!spans.length || !amountDb) return 0;
	const merged = mergeSpans(spans, attackS + releaseS);
	const amount = -Math.abs(amountDb);
	const points: Array<[number, number]> = [];
	for (const [start, end] of merged) points.push([start - attackS, 0], [start, amount], [end, amount], [end + releaseS, 0]);
	if (time <= points[0][0] || time >= points[points.length - 1][0]) return 0;
	for (let i = 0; i < points.length - 1; i++) {
		const [t0, v0] = points[i];
		const [t1, v1] = points[i + 1];
		if (time >= t0 && time <= t1) return t1 === t0 ? v1 : v0 + ((time - t0) / (t1 - t0)) * (v1 - v0);
	}
	return 0;
}

/** Times (timeline seconds) where the duck op writes its keys: each merged span's attack start, start, end, release end. */
export function duckKeyTimes(spans: Array<[number, number]>, attackS: number, releaseS: number): number[] {
	return mergeSpans(spans, attackS + releaseS).flatMap(([start, end]) => [start - attackS, start, end, end + releaseS]);
}

export const autoLevelDb = (bed: Pick<MusicBed, "lufs_i">, withVoice: boolean) =>
	Math.round(((withVoice ? MUSIC_MIX.withVoiceLufs : MUSIC_MIX.aloneLufs) - (bed.lufs_i ?? -18)) * 100) / 100;

// ─── placing a bed ──────────────────────────────────────────────────────────────────────────────────────────

export interface BedPlan {
	ops: Op[];
	/** One per loop copy: the ref its `sfx` op defines, timeline start and length (seconds). */
	copies: Array<{ ref: string; t: number; dur: number; loop: number }>;
	track: { ref: string; existing: boolean; name: string };
	replaced: string[];
	span: { t: number; end: number };
	run: string;
	notes: string[];
}

/**
 * Ops that put `bed` under [t, t + duration) (default: from t to where the cut ends; the bed's own length on an empty
 * timeline): the bed's earlier copies there are replaced; a MUSIC track with room is reused, else one is added above
 * the SFX lanes. `level` "auto" or dB; `author` claude or user.
 */
export function planBed(
	project: OpsProject,
	bed: MusicBed,
	{ t = 0, duration, level = "auto", author = "claude", runId }: { t?: number; duration?: number; level?: "auto" | number; author?: "claude" | "user"; runId?: string },
): BedPlan {
	const scene = activeScene(project);
	const notes: string[] = [];
	const start = Math.max(0, t);
	const contentEnd = contentEndSeconds(project);
	const length = duration !== undefined ? duration : contentEnd > start + 0.5 ? contentEnd - start : bed.duration_s;
	if (duration === undefined && !(contentEnd > start + 0.5)) notes.push(`nothing on the timeline after ${start} s: the bed runs its own length (${bed.duration_s} s)`);
	const end = start + Math.max(0.5, length);
	const ops: Op[] = [];
	const replaced: string[] = [];
	const audio = scene.tracks.audio as AnyTrack[];
	const overlapsSpan = (element: AnyElement) => s(element.startTime) < end - 1e-6 && s(endOf(element)) > start + 1e-6;
	let trackId: string | null = null;
	let trackName = "MUSIC";
	for (const track of audio.filter(isMusicTrack)) {
		const inSpan = (track.elements as AnyElement[]).filter(overlapsSpan);
		if (inSpan.every((element) => musicTagOf(element))) {
			trackId = track.id;
			trackName = track.name;
			for (const element of inSpan) {
				ops.push({ op: "delete", author, el: element.id } as Op);
				replaced.push(element.id);
			}
			break;
		}
	}
	const existing = trackId !== null;
	if (!trackId) {
		const musicCount = audio.filter(isMusicTrack).length;
		trackName = musicCount ? `MUSIC ${musicCount + 1}` : "MUSIC";
		const sfxAt = audio.findIndex(isSfxTrack);
		ops.push({ op: "add_track", author, kind: "audio", name: trackName, index: sfxAt >= 0 ? sfxAt : audio.length, ref: "music_track" } as Op);
		trackId = "music_track";
	}
	const copies: BedPlan["copies"] = [];
	const loopLength = bed.duration_s;
	for (let loop = 0, at = start; at < end - 0.05; loop++, at += loopLength) {
		const dur = Math.min(loopLength, end - at);
		const ref = `bed_${loop}`;
		copies.push({ ref, t: r3(at), dur: r3(dur), loop });
		ops.push({ op: "sfx", author, t: r3(at), name: `MUSIC ${bed.name}${loop ? ` · loop ${loop + 1}` : ""}`, url: bed.url, dur: r3(dur), track: trackId, ref } as Op);
		ops.push({ op: "beats", author, el: ref, bpm: bed.bpm, times: bed.beat_times_s, downbeats: bed.downbeats, source: "manual" } as Op);
	}
	if (copies.length > 1) notes.push(`${copies.length} copies of the ${loopLength} s loop back to back (seamless)`);
	return { ops, copies, track: { ref: trackId, existing, name: trackName }, replaced, span: { t: r3(start), end: r3(end) }, run: runId ?? `${bed.id}@${r3(start)}`, notes };
}

/**
 * After the reducer placed a bed: tag its copies as music (role, bed, run, loop), give each the whole loop as its
 * source length (the last copy is a trimmed loop), and tag the track. Mutates `project`.
 */
export function tagBed(
	project: OpsProject,
	plan: BedPlan,
	refs: Record<string, string>,
	bed: MusicBed,
	{ level, duckDb, seamless = false }: { level: "auto" | number; duckDb: number; seamless?: boolean },
): string[] {
	const scene = activeScene(project);
	const trackId = refs[plan.track.ref] ?? plan.track.ref;
	const track = (scene.tracks.audio as AnyTrack[]).find((candidate) => candidate.id === trackId);
	if (!track) return [];
	(track as Tagged).restorff = { ...((track as Tagged).restorff ?? {}), role: "music" };
	const ids: string[] = [];
	const fadeOut = Math.min(MUSIC_MIX.fadeOutMaxS, Math.max(0.2, (plan.span.end - plan.span.t) * 0.25));
	for (const copy of plan.copies) {
		const id = refs[copy.ref];
		const element = (track.elements as AnyElement[]).find((candidate) => candidate.id === id);
		if (!element) continue;
		const loopTicks = Math.round(bed.duration_s * TICKS_PER_SECOND);
		(element as { sourceDuration?: number }).sourceDuration = loopTicks;
		(element as { trimEnd: number }).trimEnd = Math.max(0, loopTicks - element.trimStart - element.duration);
		const tag: MusicTag = {
			bed: bed.id,
			mood: bed.mood,
			run: plan.run,
			loop: copy.loop,
			loops: plan.copies.length,
			level,
			duck_db: duckDb,
			fade_out_s: seamless ? 0 : r3(fadeOut),
			bpm: bed.bpm,
			lufs_i: bed.lufs_i,
			...(seamless ? { seamless: true, bars: Math.round((plan.span.end - plan.span.t) / barSeconds(bed)) } : {}),
		};
		const restorff = (element as Tagged).restorff ?? {};
		(element as Tagged).restorff = { ...restorff, role: "music", music: tag };
		ids.push(id);
	}
	return ids;
}

// ─── the music's level, ducking and fades (re-run whenever the voice or the bed changes) ────────────────────

export interface EnvelopePlan {
	ops: Op[];
	ducked: Array<{ track: string; under: string; amount_db: number; spans: number }>;
	voice: VoiceSpans;
	levels: Array<{ el: string; db: number }>;
}

/**
 * gain (auto level) → duck (under the voice) → fades, for every music element placed by the music tool. The `duck` op
 * replaces a track's whole volume channel, so the fades are written after it, on the same envelope.
 */
export function planMusicEnvelope(project: OpsProject, { author = "claude", duck = true }: { author?: "claude" | "user"; duck?: boolean } = {}): EnvelopePlan {
	const scene = activeScene(project);
	const voice = voiceSpans(project);
	const withVoice = voice.spans.length > 0;
	const ops: Op[] = [];
	const ducked: EnvelopePlan["ducked"] = [];
	const levels: EnvelopePlan["levels"] = [];
	const attack = MUSIC_MIX.attackMs / 1000;
	const release = MUSIC_MIX.releaseMs / 1000;
	for (const track of (scene.tracks.audio as AnyTrack[]).filter(isMusicTrack)) {
		const ours = (track.elements as AnyElement[]).filter((element) => musicTagOf(element));
		if (!ours.length) continue;
		const base = new Map<string, number>();
		for (const element of ours) {
			const tag = musicTagOf(element) as MusicTag;
			const current = typeof (element.params as Record<string, unknown>).volume === "number" ? ((element.params as Record<string, number>).volume as number) : 0;
			const db = tag.level === "auto" ? autoLevelDb({ lufs_i: tag.lufs_i }, withVoice) : tag.level;
			if (Math.abs(db - current) > 0.005) ops.push({ op: "gain", author, el: element.id, db } as Op);
			base.set(element.id, db);
			levels.push({ el: element.id, db });
		}
		const amount = Math.max(...ours.map((element) => (musicTagOf(element) as MusicTag).duck_db));
		const doDuck = duck && withVoice && amount > 0 && voice.under !== null;
		if (doDuck) {
			ops.push({ op: "duck", author, track: track.id, under: voice.under as string, amount_db: amount, attack_ms: MUSIC_MIX.attackMs, release_ms: MUSIC_MIX.releaseMs, spans: voice.spans } as Op);
			ducked.push({ track: track.id, under: voice.under as string, amount_db: amount, spans: voice.spans.length });
		}
		const valueAt = (element: AnyElement, local: number) => {
			const time = s(element.startTime) + local;
			const reduction = doDuck ? duckReductionAt(time, voice.spans, amount, attack, release) : 0;
			return Math.round(((base.get(element.id) ?? 0) + reduction) * 100) / 100;
		};
		// the duck op's own key times (timeline seconds): a fade must also bend every duck key inside its window, or the
		// music swells back up mid-fade (MEASURED 2026-10-20: a duck release key at 5.13 s sat after the fade's −10 dB)
		const duckTimes = doDuck ? duckKeyTimes(voice.spans, attack, release) : [];
		const keysIn = (element: AnyElement, from: number, to: number) =>
			duckTimes.map((time) => time - s(element.startTime)).filter((local) => local > from + 1e-3 && local < to - 1e-3);
		// fades per run: in on its first copy, out on its last
		const runs = new Map<string, AnyElement[]>();
		for (const element of ours) {
			const run = (musicTagOf(element) as MusicTag).run;
			runs.set(run, [...(runs.get(run) ?? []), element]);
		}
		for (const copies of runs.values()) {
			copies.sort((a, b) => a.startTime - b.startTime);
			const first = copies[0];
			const last = copies[copies.length - 1];
			// loop: true (sound-voice-v2) — whole bars, no fade in, no fade out: the last bar flows into the first
			if ((musicTagOf(first) as MusicTag).seamless) continue;
			const key = (element: AnyElement, local: number, value: number) =>
				ops.push({ op: "keyframe", author, el: element.id, prop: "volume", t: r3(local), value: Math.max(-60, Math.min(20, value)), local: true } as Op);
			// fade in: −30 dB → the envelope over 30 ms
			const fadeIn = (local: number) => (local >= MUSIC_MIX.fadeInS ? 0 : -30 * (1 - local / MUSIC_MIX.fadeInS));
			for (const local of [0, ...keysIn(first, 0, MUSIC_MIX.fadeInS), MUSIC_MIX.fadeInS]) key(first, local, valueAt(first, local) + fadeIn(local));
			// fade out: 0 dB at its start, −10 dB at 65 %, −60 dB at the end (dB-linear between), on top of the envelope
			const dur = s(last.duration);
			const fade = Math.min((musicTagOf(last) as MusicTag).fade_out_s, dur * 0.9);
			const from = dur - fade;
			const knee = dur - fade * 0.35;
			const fadeOut = (local: number) => (local <= from ? 0 : local <= knee ? (-10 * (local - from)) / (knee - from) : -10 - (40 * (local - knee)) / (dur - knee));
			// a fade-out never rises: a duck releasing inside it (the voice ends during the fade) is held down
			// (MEASURED in the unit test: −20.5 dB at 5.13 s → −14.1 dB at 5.475 s before this clamp)
			let ceiling = Number.POSITIVE_INFINITY;
			for (const local of [from, ...keysIn(last, from, dur), knee].sort((a, b) => a - b)) {
				const value = Math.min(ceiling, valueAt(last, local) + fadeOut(local));
				ceiling = value;
				key(last, local, value);
			}
			key(last, dur, -60);
		}
	}
	return { ops, ducked, voice, levels };
}
