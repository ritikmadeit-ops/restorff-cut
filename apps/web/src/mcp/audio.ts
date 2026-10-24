/**
 * MCP tools `voiceover` and `music` (voice-music agent, 2026-10-20; owner rule "sound is half the ad", the reels' VO).
 *
 *   voiceover {timeline_id, text, voice?, rate?, t?, beat?, dry_run?}
 *     Windows' own speech engine (server/voice.ts: no install, no network, no account) → a take normalised to
 *     −16 LUFS with word timings checked against the audio → the project's media store → a clip on a VOICE track
 *     (created when needed) with its words in `restorff.voice` and in the transcript store (so `captions` reads them)
 *     → any music bed re-ducked under the new words → ONE commit by claude.
 *   voiceover {action: "voices"} lists the voices this machine has.
 *   sound-voice-v2 (2026-10-20): + tighten (cut pauses > 0.35 s inside the take → new word timings; server/voice-tighten.ts),
 *     fit_to {t0, t1} | {beat} | {element_id} (speed up in the engine's steps until the words end in the span, else
 *     refuse with does_not_fit — never overrun), overlap with another voice clip refused unless on_overlap after |
 *     new_lane (no more silent VOICE 2 lanes), `room` + `speech` share in every answer.
 *   music {loop: true} (sound-voice-v2): whole bars, no fades, ends on a bar, + snap_hint when the cut is not whole bars.
 *
 *   music {timeline_id, mood | track_id, t?, duration_s?, duck?, level_db?, duck_db?, dry_run?}
 *     A generated bed (public/music, licence "generated, ours"; server/music.ts) under the whole cut or a span, looped
 *     seamlessly, its beats on every copy (beat snap), at −22 LUFS with a voice / −18 without, ducked 10 dB under the
 *     voice's words, faded in and out → ONE commit by claude. Re-placing a bed over the same span replaces it.
 *   music {action: "list"} lists the beds.
 *
 * Planning (pure, shared with the Sounds panel): server/music-plan.ts. Runbook: docs/restorff/worklog/voice-music.md.
 */
import { apply, type ApplyResult, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import type { Actor } from "@/server/auth";
import { HttpError } from "@/server/http";
import { findBed, loadBeds, MOODS } from "@/server/music";
import {
	activeScene,
	type BarSnap,
	contentEndSeconds,
	isVoiceTrack,
	MUSIC_MIX,
	type MusicBed,
	musicTagOf,
	planBed,
	planMusicEnvelope,
	snapToBars,
	tagBed,
	TICKS_PER_SECOND,
	timelineBeats,
	type VoiceTag,
	voiceTagOf,
} from "@/server/music-plan";
import { getProjectHead, pushCommit } from "@/server/projects";
import { elementTimes } from "@/server/sound-design";
import { buildStoryboard } from "@/server/storyboard-rows";
import { DEFAULT_VOICE, listVoices, MAX_TEXT_CHARS, SPEECH_TARGET, storeTakeAsMedia, synthesizeTake, type VoiceTake, writeTakeTranscript } from "@/server/voice";
import { sapiSpeedFor, speechShare, TIGHTEN_DEFAULTS, type TightTake, tightenTake } from "@/server/voice-tighten";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { fail, type JsonSchema, type Payload, type Tool, type ToolContext, type ToolOutput } from "./protocol";

const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: "number", description, ...extra });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const r3 = (value: number) => Math.round(value * 1000) / 1000;
const sec = (ticks: number) => r3(ticks / TICKS_PER_SECOND);

function actorOf(ctx: ToolContext): Actor {
	const kind = ctx.auth?.kind === "service" ? "service" : "local-dev";
	return { kind, id: ctx.auth?.userId ?? kind, name: ctx.auth?.name ?? "Claude (MCP)" };
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const summaryNext = (timelineId: string, what: string) => ({ do: what, tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } });

function withNext(out: ToolOutput, next: Record<string, unknown>): ToolOutput {
	(out.payload as Payload).next = next;
	return out;
}

const baseMatches = (given: string | undefined, head: string) => !given || given === head || (given.length >= 7 && head.startsWith(given));

/** Head + base check + a deep copy to plan on. */
async function openTimeline(args: Record<string, unknown>): Promise<
	{ ok: true; timelineId: string; headId: string; branch: string; project: OpsProject } | { ok: false; out: ToolOutput }
> {
	const timelineId = text(args.timeline_id);
	if (!timelineId) return { ok: false, out: fail("invalid_arguments", "timeline_id is required (timeline list shows them).") };
	const head = await getProjectHead(timelineId, text(args.branch));
	if (!head.snapshot) return { ok: false, out: withNext(fail("no_snapshot", "This timeline has no snapshot yet."), summaryNext(timelineId, "Read the timeline.")) };
	const base = text(args.base_commit);
	if (!baseMatches(base, head.head.id)) {
		return {
			ok: false,
			out: withNext(fail("conflict", `The timeline moved on: its head is ${head.head.id}, not ${base}. Nothing was done.`, { head: head.head.id }), summaryNext(timelineId, "Read the timeline again, then retry on its head (or omit base_commit).")),
		};
	}
	return { ok: true, timelineId, headId: head.head.id, branch: head.branch, project: structuredClone(head.snapshot) as unknown as OpsProject };
}

function run(project: OpsProject, ops: Op[], seed: string): ApplyResult {
	return apply(project, ops, { seed, at: new Date().toISOString() });
}

function refused(result: ApplyResult, timelineId: string, what: string): ToolOutput {
	return withNext(fail("ops_conflict", `${what} was refused by the timeline reducer. Nothing was committed.`, { conflicts: result.conflicts.slice(0, 10) }), summaryNext(timelineId, "Read the summary for real ids and times."));
}

async function commit(
	ctx: ToolContext,
	timelineId: string,
	headId: string,
	branch: string,
	project: OpsProject,
	ops: unknown[],
	message: string,
): Promise<{ ok: true; commitId: string } | { ok: false; out: ToolOutput }> {
	const pushed = await pushCommit(timelineId, { base_commit: headId, branch, author: "claude", snapshot: project as unknown as ProjectSnapshot, ops, message }, actorOf(ctx));
	if (!pushed.ok) {
		return {
			ok: false,
			out: withNext(fail("conflict", `The timeline moved while committing (head ${pushed.conflict.head.id}). Nothing was committed.`, { head: pushed.conflict.head.id }), summaryNext(timelineId, "Read the timeline again and retry.")),
		};
	}
	return { ok: true, commitId: pushed.commit.id };
}

/** Music level, ducking and fades for the whole timeline, applied on top of `project` (re-run after any change). */
function envelope(project: OpsProject, timelineId: string, seed: string): { project: OpsProject; applied: unknown[]; plan: ReturnType<typeof planMusicEnvelope> } | ToolOutput {
	const plan = planMusicEnvelope(project, { author: "claude" });
	if (!plan.ops.length) return { project, applied: [], plan };
	const result = run(project, plan.ops, seed);
	if (!result.ok) return refused(result, timelineId, "Ducking the music");
	return { project: result.project as OpsProject, applied: result.changes.applied, plan };
}

const isOutput = (value: unknown): value is ToolOutput => !!value && typeof value === "object" && ("isError" in value || "payload" in value) && !("plan" in value);

function duckReport(plan: ReturnType<typeof planMusicEnvelope>) {
	if (!plan.ducked.length) return null;
	return {
		under: plan.voice.source,
		amount_db: plan.ducked[0].amount_db,
		attack_ms: MUSIC_MIX.attackMs,
		release_ms: MUSIC_MIX.releaseMs,
		spans: plan.voice.spans,
	};
}

// ─── voiceover ──────────────────────────────────────────────────────────────────────────────────────────────

async function voices(): Promise<ToolOutput> {
	const { voices: list, error } = await listVoices();
	return {
		payload: {
			voices: list.map((voice) => ({ id: voice.id, name: voice.name, engine: voice.engine, language: voice.language, gender: voice.gender, native_rate: voice.native_rate })),
			default: DEFAULT_VOICE,
			...(error ? { error } : {}),
			notes: [
				"Local Windows voices: free, offline, instant — and robotic. Natural voices (ElevenLabs and others) need the owner's account and credits: not wired.",
				"sapi = the Desktop voices (22 kHz; speed moves in steps of ~12 %); onecore = the Narrator voices (16 kHz).",
				"Pacing: tighten: true cuts the ~0.8 s pauses these voices leave after each sentence; fit_to {t0, t1} makes a line fit its span.",
			],
			owner_options: [
				{ option: "ElevenLabs text-to-speech", gives: "natural, expressive voices + character timings", needs: "the owner's account and credits" },
				{ option: "Microsoft Azure AI Speech (neural voices)", gives: "natural voices with the same word-boundary events + SSML pauses", needs: "the owner's account and credits" },
				{ option: "Google Cloud Text-to-Speech / Amazon Polly", gives: "natural voices; word times via SSML marks / speech marks", needs: "the owner's account and credits" },
				{ option: "OpenAI text-to-speech", gives: "natural voices; words via a local transcribe pass", needs: "the owner's account and credits" },
				{ option: "Piper or Kokoro (local neural TTS)", gives: "much less robotic, offline, no per-use cost", needs: "an install (owner decides; licences per voice model)" },
			],
			next: { do: "Say a line on a timeline.", tool: "voiceover", arguments: { timeline_id: "…", text: "Six a.m. and the kettle is still cold.", voice: DEFAULT_VOICE } },
		},
	};
}

// ─── pacing: tighten, fit_to (sound-voice-v2, 2026-10-20) ───────────────────────────────────────────────────

/** Seconds of take kept after the last word when a line is fitted into a span (the rest is silence). */
const FIT_TAIL_S = 0.12;
const DEFAULT_MAX_RATE = 1.4;

type Tighten = { maxPause: number; keep: number };

function parseTighten(raw: unknown): Tighten | null | "invalid" {
	if (raw === undefined || raw === null || raw === false) return null;
	if (raw === true) return { maxPause: TIGHTEN_DEFAULTS.maxPause, keep: TIGHTEN_DEFAULTS.keep };
	if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
	const o = raw as Record<string, unknown>;
	const maxPause = typeof o.max_pause_s === "number" ? o.max_pause_s : TIGHTEN_DEFAULTS.maxPause;
	const keep = typeof o.keep_s === "number" ? o.keep_s : TIGHTEN_DEFAULTS.keep;
	if (!(maxPause >= 0.1 && maxPause <= 3) || !(keep >= 0.04 && keep <= maxPause)) return "invalid";
	return { maxPause, keep };
}

interface FitSpec {
	t0: number;
	t1: number;
	from: string;
	maxRate: number;
}

const FIT_SHAPE = "fit_to is {t0, t1} (timeline seconds), {beat: N} (storyboard row N's span) or {element_id} (that clip's span), with max_rate? (≤ 2, default 1.4).";

function parseFit(raw: unknown, project: OpsProject, speed: number): FitSpec | null | string {
	if (raw === undefined || raw === null || raw === false) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) return FIT_SHAPE;
	const o = raw as Record<string, unknown>;
	let t0: number;
	let t1: number;
	let from: string;
	if (typeof o.t0 === "number" && typeof o.t1 === "number") {
		t0 = o.t0;
		t1 = o.t1;
		from = "span";
	} else if (typeof o.beat === "number") {
		const board = buildStoryboard(project as unknown as ProjectSnapshot);
		const row = board.rows[Math.round(o.beat) - 1];
		if (!row) return `there is no beat ${o.beat}: the storyboard has ${board.rows.length} rows (storyboard get lists them). ${FIT_SHAPE}`;
		t0 = row.start;
		t1 = row.end;
		from = `beat ${Math.round(o.beat)} (${row.range})`;
	} else if (typeof o.element_id === "string") {
		const times = elementTimes(project, o.element_id);
		if (!times) return `no element ${o.element_id} on this timeline. ${FIT_SHAPE}`;
		t0 = times.start;
		t1 = times.end;
		from = `element "${times.name}"`;
	} else return FIT_SHAPE;
	if (!(t0 >= 0) || !(t1 - t0 >= 0.3)) return `fit_to span ${t0}–${t1} s is too short for a line (at least 0.3 s). ${FIT_SHAPE}`;
	const asked = typeof o.max_rate === "number" ? Math.max(0.5, Math.min(2, o.max_rate)) : DEFAULT_MAX_RATE;
	return { t0: r3(t0), t1: r3(t1), from, maxRate: Math.max(asked, speed) };
}

/** Where the picture ends (main + overlays), seconds. */
function pictureEndSeconds(project: OpsProject): number {
	const scene = activeScene(project);
	let end = 0;
	for (const track of [scene.tracks.main, ...scene.tracks.overlay]) for (const element of track.elements) end = Math.max(end, element.startTime + element.duration);
	return sec(end);
}

interface Said {
	take: TightTake;
	cached: boolean;
	base: VoiceTake;
	tight: { from_take: string; pauses_cut: number; removed_s: number; max_pause_s: number; keep_s: number } | null;
}

async function sayOnce(line: string, voice: string | undefined, speed: number, tighten: Tighten | null, signal?: AbortSignal): Promise<Said> {
	const first = await synthesizeTake({ text: line, voice, speed }, signal);
	if (!tighten) return { take: first.take, cached: first.cached, base: first.take, tight: null };
	const done = await tightenTake(first.take, tighten, signal);
	const info = (done.take as TightTake).tightened;
	return {
		take: done.take,
		cached: first.cached && done.cached,
		base: first.take,
		tight: { from_take: first.take.key, pauses_cut: info?.pauses_cut ?? 0, removed_s: info?.removed_s ?? 0, max_pause_s: tighten.maxPause, keep_s: tighten.keep },
	};
}

/** Seconds of the take the line needs: to its last word plus a short tail. */
const needOf = (take: VoiceTake) => r3(Math.min(take.duration_s, (take.words[take.words.length - 1]?.end ?? take.duration_s) + FIT_TAIL_S));

/**
 * The take, sped up (in the engine's own steps, at most fit.maxRate) until it fits fit_to's span. A line that cannot
 * fit is refused with what it needs — it never runs over the span.
 */
async function makeTake(
	line: string,
	voice: string | undefined,
	speed: number,
	tighten: Tighten | null,
	fit: FitSpec | null,
	signal?: AbortSignal,
): Promise<(Said & { ok: true; need: number; tries: Array<{ rate: number; speech_s: number }>; notes: string[] }) | { ok: false; out: ToolOutput; fix: string; retry: Record<string, unknown> }> {
	let rate = speed;
	let said = await sayOnce(line, voice, rate, tighten, signal);
	let need = needOf(said.take);
	const tries = [{ rate: said.take.speed, speech_s: need }];
	const notes: string[] = [];
	if (!fit) return { ok: true, ...said, need, tries, notes };
	const span = r3(fit.t1 - fit.t0);
	const sapi = said.take.voice.engine === "sapi";
	const step = (x: number) => (sapi ? sapiSpeedFor(x) : Math.round(x * 100) / 100);
	const ceiling = sapi ? Math.round(3 ** (Math.floor(10 * (Math.log(fit.maxRate) / Math.log(3)) + 1e-9) / 10) * 100) / 100 : fit.maxRate;
	while (need > span + 1e-3 && rate < ceiling - 1e-6 && tries.length < 6) {
		let next = step(rate * (need / span) * 1.01);
		if (next <= rate + 1e-6) next = step(rate + 0.01);
		next = Math.min(next, ceiling);
		if (next <= rate + 1e-6) break;
		rate = next;
		said = await sayOnce(line, voice, rate, tighten, signal);
		need = needOf(said.take);
		tries.push({ rate: said.take.speed, speech_s: need });
	}
	if (tries.length > 1 && need <= span + 1e-3) notes.push(`fit_to: rate ${speed} → ${said.take.speed} so the line fits ${fit.from} (${span} s)`);
	if (need > span + 1e-3) {
		const words = said.take.words.length;
		const fewer = Math.max(1, Math.ceil(words * (1 - span / need)));
		const short = line.length > 42 ? `${line.slice(0, 40)}…` : line;
		const base = { text: line, ...(voice ? { voice } : {}) };
		return {
			ok: false,
			out: fail(
				"does_not_fit",
				`"${short}" needs ${need} s even at rate ${said.take.speed} (max_rate ${fit.maxRate}${sapi ? `; this voice speeds up in steps` : ""}); ${fit.from} is ${span} s (${fit.t0}–${fit.t1} s). Nothing was placed: the line would run over.`,
				{
					span: { t0: fit.t0, t1: fit.t1, seconds: span, from: fit.from },
					speech_s: need,
					over_s: r3(need - span),
					tries,
					options: [
						...(tighten ? [] : ["tighten: true — cut the pauses over 0.35 s first (often 0.5–1.5 s per line with these voices)"]),
						`say about ${fewer} word${fewer === 1 ? "" : "s"} fewer (${words} now)`,
						`widen the span to ${r3(fit.t0 + need)} s (fit_to t1)`,
						`allow a faster voice: max_rate up to 2 (now ${fit.maxRate})`,
					],
				},
			),
			fix: tighten ? "Shorten the line or widen the span (see options)." : "Cut the long pauses first: the same call with tighten: true.",
			retry: tighten ? { ...base, tighten: true, fit_to: { t0: fit.t0, t1: r3(fit.t0 + need) } } : { ...base, tighten: true, fit_to: { t0: fit.t0, t1: fit.t1 } },
		};
	}
	return { ok: true, ...said, need, tries, notes };
}

async function voiceover(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	if (args.action === "voices") return voices();
	const line = text(args.text);
	if (!line) return fail("invalid_arguments", `text is required: the line to say (at most ${MAX_TEXT_CHARS} characters; one call per line or paragraph).`);
	const opened = await openTimeline(args);
	if (!opened.ok) return opened.out;
	const { timelineId, headId, branch, project } = opened;
	const speed = typeof args.rate === "number" ? args.rate : 1;
	if (!(speed >= 0.5 && speed <= 2)) return fail("invalid_arguments", "rate is a speed multiplier from 0.5 to 2 (1 = normal).");
	// sound-voice-v2 (2026-10-20): tighten (cut long pauses), fit_to (a span the line must fit), on_overlap
	const tighten = parseTighten(args.tighten);
	if (tighten === "invalid") return fail("invalid_arguments", "tighten is true, false, or {max_pause_s (0.1–3, default 0.35), keep_s (default 0.2)}.");
	const fit = parseFit(args.fit_to, project, speed);
	if (typeof fit === "string") return withNext(fail("invalid_arguments", fit), { do: "Read the beats (storyboard rows) or the summary for spans.", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } });
	const onOverlap = args.on_overlap === "new_lane" || args.on_overlap === "after" ? args.on_overlap : "refuse";

	const made = await makeTake(line, text(args.voice), speed, tighten, fit, ctx.signal);
	if (!made.ok) return withNext(made.out, { do: made.fix, tool: "voiceover", arguments: { timeline_id: timelineId, ...made.retry } });
	const { take, cached, base, tight } = made;
	const firstWord = take.words[0]?.start ?? 0;
	const scene = activeScene(project);
	const voiceTracks = scene.tracks.audio.filter(isVoiceTrack);
	const notes: string[] = [...made.notes];

	// where: fit_to's t0, else t, else right after the last voice clip, else 0; beat moves the FIRST WORD onto a beat
	let t: number;
	if (fit) {
		t = fit.t0;
		if (typeof args.t === "number" && Math.abs(args.t - fit.t0) > 1e-3) notes.push(`t ${args.t} ignored: fit_to starts the line at ${fit.t0} s`);
	} else if (typeof args.t === "number" && args.t >= 0) t = args.t;
	else {
		const lastEnd = Math.max(0, ...voiceTracks.flatMap((track) => track.elements.map((element) => element.startTime + element.duration)));
		t = sec(lastEnd);
		if (lastEnd > 0) notes.push(`t not given: placed right after the last voice clip (${t} s)`);
	}
	let beatInfo: Record<string, unknown> | null = null;
	if (fit && args.beat !== undefined && args.beat !== false) notes.push("beat ignored: fit_to places the line");
	else if (args.beat !== undefined && args.beat !== false) {
		const beats = timelineBeats(project);
		if (!beats.length) notes.push("beat: no beats on the timeline yet (place a music bed first) — placed at t");
		else {
			const target =
				typeof args.beat === "number"
					? beats[Math.max(0, Math.min(beats.length - 1, Math.round(args.beat)))]
					: (beats.find((beat) => beat.downbeat && beat.t >= t + firstWord - 0.02) ?? beats.find((beat) => beat.t >= t + firstWord - 0.02));
			if (!target) notes.push(`beat: no beat after ${t} s — placed at t`);
			else {
				const placed = r3(Math.max(0, target.t - firstWord));
				beatInfo = { beat_t: target.t, downbeat: target.downbeat, first_word_at: r3(placed + firstWord) };
				if (target.t - firstWord < 0) notes.push("beat: the first beat is earlier than the take's lead-in; started at 0");
				t = placed;
			}
		}
	}
	const takeLength = take.duration_s;
	// fit_to: the clip ends inside the span (the take's silent tail is trimmed, never a word)
	const dur = fit ? r3(Math.min(takeLength, Math.max(made.need, fit.t1 - fit.t0))) : takeLength;
	// overruns are reported, never silently put on a new lane (sound-voice-v2; paper-collage REPORT §7)
	const clash = (from: number) =>
		voiceTracks
			.flatMap((track) => track.elements.map((element) => ({ id: element.id, name: element.name, start: sec(element.startTime), end: sec(element.startTime + element.duration) })))
			.filter((other) => other.start < from + dur - 1e-3 && other.end > from + 1e-3)
			.sort((a, b) => a.start - b.start);
	let overlaps = clash(t);
	if (overlaps.length && onOverlap === "after") {
		const moved = r3(Math.max(...overlaps.map((other) => other.end)));
		notes.push(`on_overlap after: moved from ${r3(t)} s to ${moved} s, after "${overlaps[overlaps.length - 1].name}"`);
		t = moved;
		overlaps = clash(t);
	}
	if (overlaps.length && onOverlap !== "new_lane") {
		const first = overlaps[0];
		const overlapS = r3(Math.min(t + dur, first.end) - Math.max(t, first.start));
		const nextStart = first.start > t ? first.start : null;
		return withNext(
			fail("voice_overlap", `This line (${r3(t)}–${r3(t + dur)} s) overlaps the voice clip "${first.name}" (${first.start}–${first.end} s) by ${overlapS} s. Nothing was placed.`, {
				line: { t: r3(t), end: r3(t + dur), duration_s: dur, speech_end_s: r3(t + made.need) },
				overlaps: overlaps.slice(0, 5),
				options: [
					...(nextStart !== null ? [`fit_to {t0: ${r3(t)}, t1: ${nextStart}}: speed it up (within max_rate) to end before "${first.name}"`] : []),
					...(tight ? [] : ["tighten: true: cut the long pauses (Windows voices leave ~0.8 s after each sentence)"]),
					`on_overlap: "after": start it at ${r3(Math.max(...overlaps.map((other) => other.end)))} s instead`,
					'on_overlap: "new_lane": put it on its own VOICE lane anyway (two voices at once)',
				],
			}),
			nextStart !== null
				? { do: "Fit the line into the room before the next voice clip.", tool: "voiceover", arguments: { timeline_id: timelineId, text: line, voice: take.voice.id, rate: speed, ...(tighten ? { tighten: true } : {}), fit_to: { t0: r3(t), t1: nextStart } } }
				: { do: "Start the line after the voice clip it overlaps.", tool: "voiceover", arguments: { timeline_id: timelineId, text: line, voice: take.voice.id, rate: speed, ...(tighten ? { tighten: true } : {}), on_overlap: "after", t: r3(t) } },
		);
	}
	if (overlaps.length) notes.push(`on_overlap new_lane: overlaps "${overlaps[0].name}" — placed on its own VOICE lane (two voices at once)`);
	const startTicks = Math.round(t * TICKS_PER_SECOND);
	const endTicks = startTicks + Math.round(dur * TICKS_PER_SECOND);
	const free = voiceTracks.find((track) => track.elements.every((element) => endTicks <= element.startTime || startTicks >= element.startTime + element.duration));
	const short = take.text.length > 42 ? `${take.text.slice(0, 40)}…` : take.text;
	const clipName = `VO · ${take.voice.id} · "${short}"`;
	const mediaName = `VO ${take.voice.id} ${take.key.slice(0, 8)}.wav`;
	const ops: Op[] = [
		{ op: "import_media", author: "claude", kind: "audio", name: mediaName, url: `/api/voice/takes/${take.key}.wav`, duration: takeLength, has_audio: true, ref: "vo_media" } as Op,
		...(free ? [] : [{ op: "add_track", author: "claude", kind: "audio", name: voiceTracks.length ? `VOICE ${voiceTracks.length + 1}` : "VOICE", index: 0, ref: "vo_track" } as Op]),
		{ op: "insert", author: "claude", track: free ? free.id : "vo_track", t: r3(t), media: "vo_media", in: 0, out: dur, name: clipName, ref: "vo_clip" } as Op,
	];
	// room: what comes after this line (the next voice clip, the end of the picture)
	const nextVoice = voiceTracks
		.flatMap((track) => track.elements.map((element) => sec(element.startTime)))
		.filter((start) => start >= t + dur - 1e-3)
		.sort((a, b) => a - b)[0];
	const pictureEnd = pictureEndSeconds(project);
	const room = {
		ends_at: r3(t + dur),
		speech_ends_at: r3(t + made.need),
		next_voice_at: nextVoice ?? null,
		...(nextVoice !== undefined ? { slack_s: r3(nextVoice - (t + dur)) } : {}),
		picture_ends_at: pictureEnd,
		...(pictureEnd > 0 && t + made.need > pictureEnd + 1e-3 ? { past_picture_s: r3(t + made.need - pictureEnd) } : {}),
	};
	if (room.past_picture_s) notes.push(`overrun: the words run ${room.past_picture_s} s past the end of the picture (${pictureEnd} s)`);
	const seed = `${timelineId}/${headId}/voiceover/${take.key}/${r3(t)}`;
	const placed = run(project, ops, seed);
	if (!placed.ok) return refused(placed, timelineId, "Placing the voice-over");
	const elementId = placed.changes.refs.vo_clip;
	const mediaId = placed.changes.refs.vo_media;
	const after = placed.project as OpsProject;
	const afterScene = activeScene(after);
	const track = afterScene.tracks.audio.find((candidate) => candidate.elements.some((element) => element.id === elementId));
	const element = track?.elements.find((candidate) => candidate.id === elementId);
	if (!track || !element || !mediaId) return fail("tool_failed", "The voice clip was not found after placing it (internal).");
	const tag: VoiceTag = { take: take.key, hash: take.hash, voice: take.voice.id, engine: take.voice.engine, speed: take.speed, text: take.text, words: take.words };
	(track as { restorff?: Record<string, unknown> }).restorff = { ...((track as { restorff?: Record<string, unknown> }).restorff ?? {}), role: "voice" };
	(element as { restorff?: Record<string, unknown> }).restorff = { ...((element as { restorff?: Record<string, unknown> }).restorff ?? {}), role: "voice", voice: tag };

	const env = envelope(after, timelineId, `${seed}/duck`);
	if (isOutput(env)) return env;
	const words = take.words.map((word) => ({ text: word.text, start: r3(t + word.start), end: r3(t + word.end) }));
	const report = {
		element_id: elementId,
		media_id: mediaId,
		track: { id: track.id, name: track.name, created: !free },
		t: r3(t),
		duration_s: dur,
		voice: take.voice,
		rate: take.speed,
		words,
		take: { key: take.key, sha256: take.hash, cached, url: `/api/voice/takes/${take.key}.wav`, made_ms: take.ms },
		loudness: { lufs_i: take.loudness.lufs_i, true_peak_dbtp: take.loudness.true_peak_dbtp, target_lufs: SPEECH_TARGET.lufs, limited: take.loudness.limited },
		timing: {
			checked_edges: take.timing.edges.length,
			max_error_ms: take.timing.max_error_ms,
			median_error_ms: take.timing.median_error_ms,
			engine_start_max_error_ms: take.timing.engine_start_max_error_ms,
			method: take.timing.method,
		},
		...(beatInfo ? { beat: beatInfo } : {}),
		speech: {
			share: speechShare(take.words, takeLength).share,
			speech_s: speechShare(take.words, takeLength).speech_s,
			long_pauses: speechShare(take.words, takeLength).long_pauses,
			...(tight ? { before_tighten: speechShare(base.words, base.duration_s) } : {}),
			method: "word spans with gaps < 0.35 s merged, over the take's length",
		},
		...(tight ? { tightened: tight } : {}),
		...(fit ? { fit: { span: { t0: fit.t0, t1: fit.t1, from: fit.from }, fits: true, rate: take.speed, tries: made.tries, max_rate: fit.maxRate, speech_s: r3(made.need), slack_s: r3(fit.t1 - fit.t0 - made.need) } } : {}),
		room,
		music: duckReport(env.plan),
		...(notes.length ? { notes } : {}),
	};
	if (args.dry_run === true) {
		return {
			payload: {
				dry_run: true,
				...report,
				ops: [...placed.changes.applied, ...env.applied].length,
				next: {
					do: "Looks right: say it for real (same call without dry_run).",
					tool: "voiceover",
					arguments: { timeline_id: timelineId, text: take.text, voice: take.voice.id, ...(fit ? { fit_to: args.fit_to } : { t: r3(t), rate: take.speed }), ...(tighten ? { tighten: args.tighten } : {}) },
				},
			},
		};
	}
	await storeTakeAsMedia(timelineId, mediaId, take, mediaName);
	const transcript = writeTakeTranscript(take, mediaName);
	const message = text(args.message) ?? `voiceover: "${short}" (${take.voice.id}${take.speed !== 1 ? ` ×${take.speed}` : ""}${tight ? `, tightened −${tight.removed_s} s` : ""}${fit ? `, fit ${fit.t0}–${fit.t1} s` : ""})`;
	const done = await commit(ctx, timelineId, headId, branch, env.project, [...placed.changes.applied, ...env.applied], message);
	if (!done.ok) return done.out;
	const hasMusic = afterScene.tracks.audio.some((candidate) => candidate.elements.some((el) => musicTagOf(el)));
	return {
		payload: {
			commit_id: done.commitId,
			...report,
			transcript: { store: "server/transcripts (model tts)", file: transcript.split(/[\\/]/).slice(-2).join("/") },
			editor: "The editor pulls this commit and the take within ~15 s (or on focus); the clip sits on the VOICE track.",
			next: hasMusic
				? { do: "Caption the voice-over (its exact words are in the transcript store).", tool: "captions", arguments: { timeline_id: timelineId, element_id: elementId } }
				: { do: "Put a music bed under it (ducked under these words).", tool: "music", arguments: { timeline_id: timelineId, mood: "warm" } },
		},
	};
}

// ─── music ──────────────────────────────────────────────────────────────────────────────────────────────────

function bedView(bed: MusicBed) {
	return {
		id: bed.id,
		name: bed.name,
		mood: bed.mood,
		bpm: bed.bpm,
		bars: bed.bars,
		key: bed.key,
		duration_s: bed.duration_s,
		lufs_i: bed.lufs_i,
		use: bed.use,
		description: bed.description,
		url: bed.url,
	};
}

function listBeds(): ToolOutput {
	const manifest = loadBeds();
	return {
		payload: {
			beds: manifest.beds.map(bedView),
			moods: MOODS,
			licence: manifest.licence,
			licence_note: manifest.licence_note,
			notes: ["Every bed is a seamless loop at a fixed tempo; longer spans get copies back to back. Licensed or AI-generated tracks need the owner's account: not wired."],
			next: { do: "Put one under a timeline.", tool: "music", arguments: { timeline_id: "…", mood: manifest.beds[0]?.mood ?? "warm" } },
		},
	};
}

async function music(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	if (args.action === "list") return listBeds();
	const mood = text(args.mood);
	const trackId = text(args.track_id);
	if (!mood && !trackId) return withNext(fail("invalid_arguments", `Pass mood (${MOODS.join(", ")}) or track_id (a bed id from music list).`), { do: "List the beds.", tool: "music", arguments: { action: "list" } });
	let bed: MusicBed;
	try {
		bed = findBed({ id: trackId, mood });
	} catch (error) {
		if (error instanceof HttpError && error.status === 400) return withNext(fail("unknown_bed", error.message, error.extra ?? {}), { do: "List the beds.", tool: "music", arguments: { action: "list" } });
		throw error;
	}
	const opened = await openTimeline(args);
	if (!opened.ok) return opened.out;
	const { timelineId, headId, branch, project } = opened;
	const t = typeof args.t === "number" && args.t >= 0 ? args.t : 0;
	let duration = typeof args.duration_s === "number" && args.duration_s > 0 ? args.duration_s : undefined;
	const level: "auto" | number = typeof args.level_db === "number" ? Math.max(-60, Math.min(20, args.level_db)) : "auto";
	const duck = args.duck !== false;
	const duckDb = duck ? (typeof args.duck_db === "number" ? Math.min(30, Math.abs(args.duck_db)) : MUSIC_MIX.duckDb) : 0;
	// loop: true (sound-voice-v2) — whole bars, no fades, so the music loops with a cut that loops
	const seamless = args.loop === true;
	let snap: BarSnap | null = null;
	if (seamless) {
		const contentEnd = contentEndSeconds(project);
		snap = snapToBars(bed, duration ?? (contentEnd > t + 0.5 ? contentEnd - t : bed.duration_s));
		duration = snap.length_s;
	}

	const plan = planBed(project, bed, { t, duration, level, author: "claude" });
	const seed = `${timelineId}/${headId}/music/${plan.run}${seamless ? "/loop" : ""}`;
	const placed = run(project, plan.ops, seed);
	if (!placed.ok) return refused(placed, timelineId, "Placing the bed");
	const after = placed.project as OpsProject;
	const ids = tagBed(after, plan, placed.changes.refs, bed, { level, duckDb, seamless });
	const env = envelope(after, timelineId, `${seed}/envelope`);
	if (isOutput(env)) return env;
	const final = activeScene(env.project);
	const trackRef = placed.changes.refs[plan.track.ref] ?? plan.track.ref;
	const musicTrack = final.tracks.audio.find((candidate) => candidate.id === trackRef);
	const elements = (musicTrack?.elements ?? []).filter((element) => ids.includes(element.id));
	const report = {
		bed: bedView(bed),
		track: { id: trackRef, name: plan.track.name, created: !plan.track.existing },
		span: { t: plan.span.t, end: plan.span.end, duration_s: r3(plan.span.end - plan.span.t) },
		elements: elements.map((element) => ({
			id: element.id,
			t: sec(element.startTime),
			dur: sec(element.duration),
			volume_db: (element.params as Record<string, unknown>).volume ?? 0,
			loop: musicTagOf(element)?.loop ?? 0,
		})),
		level: level === "auto" ? { mode: "auto", target_lufs: env.plan.voice.spans.length ? MUSIC_MIX.withVoiceLufs : MUSIC_MIX.aloneLufs } : { mode: "fixed", db: level },
		ducked: duckReport(env.plan),
		...(duck && !env.plan.voice.spans.length ? { duck_note: "nothing to duck under yet: a voiceover added later re-ducks this bed under its words" } : {}),
		beats: { bpm: bed.bpm, on_timeline: timelineBeats(env.project).length },
		...(snap ? { loop: { seamless: true, fades: "none", bars: snap.bars, bar_s: snap.bar_s, length_s: snap.length_s, ends_on_bar: true } } : {}),
		...(snap && Math.abs(snap.delta_s) > 0.001 ? { snap_hint: snapHint(project, snap, t) } : {}),
		replaced: plan.replaced,
		...(plan.notes.length ? { notes: plan.notes } : {}),
	};
	if (args.dry_run === true) {
		return { payload: { dry_run: true, ...report, next: { do: "Looks right: place it (same call without dry_run).", tool: "music", arguments: { timeline_id: timelineId, track_id: bed.id, t, ...(seamless ? { loop: true } : {}) } } } };
	}
	const message = text(args.message) ?? `music: ${bed.name} (${bed.mood}, ${bed.bpm} BPM) ${plan.span.t}–${plan.span.end} s${snap ? ` · loop, ${snap.bars} bars` : ""}`;
	const done = await commit(ctx, timelineId, headId, branch, env.project, [...placed.changes.applied, ...env.applied], message);
	if (!done.ok) return done.out;
	const hint = (report as { snap_hint?: ReturnType<typeof snapHint> }).snap_hint;
	return {
		payload: {
			commit_id: done.commitId,
			...report,
			editor: "The editor pulls this commit within ~15 s; the bed plays from /music (no upload needed) on the MUSIC track, its beats drawn on the clip.",
			next: hint
				? { do: hint.do, tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } }
				: { do: "Render it and listen: the mix is mastered to −14 LUFS.", tool: "render", arguments: { timeline_id: timelineId, quality: "preview" } },
		},
	};
}

/** "Snap the cut length to whole bars": the cut is not whole bars, so its loop point would land mid-bar. */
function snapHint(project: OpsProject, snap: BarSnap, t: number) {
	const scene = activeScene(project);
	let last: { id: string; name: string; end: number } | null = null;
	for (const track of [scene.tracks.main, ...scene.tracks.overlay]) {
		for (const element of track.elements) {
			const end = sec(element.startTime + element.duration);
			if (!last || end > last.end) last = { id: element.id, name: element.name, end };
		}
	}
	const cutEnd = r3(t + snap.asked_s);
	const best = snap.options.reduce((a, b) => (Math.abs(b.delta_s) < Math.abs(a.delta_s) ? b : a), snap.options[0]);
	const verb = (delta: number) => (delta >= 0 ? `extend by ${r3(delta)} s` : `trim ${r3(-delta)} s`);
	return {
		cut_s: snap.asked_s,
		bar_s: snap.bar_s,
		bars_exact: snap.bars_exact,
		bed_bars: snap.bars,
		bed_ends_at: r3(t + snap.length_s),
		options: snap.options.map((option) => ({ ...option, cut_ends_at: r3(t + option.length_s) })),
		...(last ? { last_clip: { element_id: last.id, name: last.name, ends_at: last.end } } : {}),
		do: `The cut is ${snap.bars_exact} bars (${snap.asked_s} s at ${snap.bar_s} s a bar), so a loop would restart the music mid-bar. Snap the cut to ${best.bars} bars = ${best.length_s} s: ${last ? `${verb(best.delta_s)} the last clip "${last.name}" (ends at ${last.end} s)` : verb(best.delta_s)}, then place the music again with loop: true. The bed already runs ${snap.bars} whole bars (to ${r3(t + snap.length_s)} s; the cut ends at ${cutEnd} s).`,
	};
}

// ─── the tools ──────────────────────────────────────────────────────────────────────────────────────────────

export const VOICEOVER_TOOL: Tool = {
	name: "voiceover",
	title: "Voice-over (local)",
	description: `Says a line with this machine's own speech engine (Windows voices; free, offline; robotic next to a paid voice) and puts it on the timeline as ONE commit by claude: the take is normalised to ${SPEECH_TARGET.lufs} LUFS, its word timings are checked against the audio, it lands on a VOICE track (added when needed) at t (default: right after the last voice clip; beat: true puts the FIRST WORD on the next downbeat of the music, a number on that beat), its words go to the transcript store (captions reads them) and any music bed is re-ducked under them. rate = speed 0.5–2. tighten: true cuts pauses over 0.35 s inside the take (new word timings returned). fit_to {t0, t1} | {beat} | {element_id} speeds the voice up (within max_rate) until the line ends inside that span, else refuses (does_not_fit) — it never overruns. A line that would overlap another voice clip is refused with the overlap and a fix (on_overlap: after | new_lane to choose otherwise); room says what follows the line. action "voices" lists the voices (default ${DEFAULT_VOICE}). dry_run: true plans without committing (the take is still made and cached).`,
	inputSchema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["say", "voices"], description: "say (default) or voices (list them)." },
			timeline_id: str("The timeline (project id from timeline list)."),
			text: str(`The line to say, at most ${MAX_TEXT_CHARS} characters. Punctuation shapes the pauses.`),
			voice: str(`A voice id from action voices (default ${DEFAULT_VOICE}); a part of a name works ("david").`),
			rate: num("Speaking speed, 0.5–2 (1 = normal).", { minimum: 0.5, maximum: 2 }),
			t: num("Where the take starts on the timeline, seconds (default: after the last voice clip, else 0).", { minimum: 0 }),
			beat: { type: ["boolean", "number"], description: "true: the first word lands on the first downbeat at/after t; a number: on that beat (0 = the first beat on the timeline). Needs a music bed." },
			tighten: {
				type: ["boolean", "object"],
				description: "Cut the long pauses inside the take: true = every pause over 0.35 s between words becomes 0.2 s (these voices leave ~0.8 s after each sentence); or {max_pause_s, keep_s}. The answer's words are the NEW timings; speech.before_tighten vs speech.share shows the change.",
			},
			fit_to: {
				type: "object",
				description: "The line must fit this span: {t0, t1} seconds, {beat: N} (storyboard row N), or {element_id} (that clip's span); max_rate? (default 1.4, ≤ 2). The voice is sped up in its own steps until the words end inside the span; the take's silent tail is trimmed. If it cannot fit, nothing is placed and the answer (does_not_fit) says how much is over and what to change. t and beat are ignored.",
			},
			on_overlap: {
				type: "string",
				enum: ["refuse", "after", "new_lane"],
				description: "When the line would overlap another voice clip: refuse (default: nothing placed, the answer says by how much and how to fit), after (start it where that clip ends), new_lane (the old behaviour: its own VOICE lane, two voices at once).",
			},
			dry_run: bool("Plan only: report placement, words, loudness and timing without committing."),
			base_commit: str("Optional: the head you read; if the timeline moved on nothing is done."),
			message: str("Commit message (default: voiceover: \"<line>\" (<voice>))."),
			branch: str("Branch (default: the project's default branch)."),
		},
		required: [],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	budgetSeconds: 120,
	run: voiceover,
};

export const MUSIC_TOOL: Tool = {
	name: "music",
	title: "Music bed",
	description: `Puts a generated music bed (ours, free to ship: ${MOODS.join(", ")}) under the whole cut or a span as ONE commit by claude: seamless loop copies on a MUSIC track, the beat grid on each (beat snap / snap_cuts use it), level auto (−22 LUFS under a voice, −18 alone; level_db overrides), ducked ${MUSIC_MIX.duckDb} dB under the voice's words (duck: false to skip; duck_db to change), 30 ms fade in, up to ${MUSIC_MIX.fadeOutMaxS} s fade out — or loop: true = whole bars, no fades, ends on a bar (for a cut that loops; snap_hint gives the cut length in whole bars). Pick by mood or by track_id (a bed id from action list). t + duration_s = the span (default: from t to where the cut ends). Placing again over the same span replaces the bed. dry_run: true plans without committing.`,
	inputSchema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["place", "list"], description: "place (default) or list the beds." },
			timeline_id: str("The timeline."),
			mood: { type: "string", enum: [...MOODS], description: "Pick the bed by mood." },
			track_id: str("Or a bed id from action list (e.g. warm-90)."),
			t: num("Where the bed starts, seconds (default 0).", { minimum: 0 }),
			duration_s: num("How long (default: to the end of the cut; on an empty timeline the bed's own length).", { minimum: 0.5 }),
			loop: bool("A seamless loop: the bed runs a whole number of bars (the nearest to the cut, or to duration_s) with NO fade in or out, so a cut whose end flows into its start loops the music too. When the cut is not whole bars, snap_hint says how long to make it."),
			duck: bool("Duck under the voice (default true)."),
			duck_db: num("How far to duck, dB (default 10).", { minimum: 0, maximum: 30 }),
			level_db: num("Fixed element level in dB instead of the auto level."),
			dry_run: bool("Plan only, nothing committed."),
			base_commit: str("Optional: the head you read; if the timeline moved on nothing is done."),
			message: str("Commit message (default: music: <bed> (<mood>, <bpm> BPM) <span>)."),
			branch: str("Branch (default: the project's default branch)."),
		},
		required: [],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	budgetSeconds: 60,
	run: music,
};

/** The line the server's instructions get. */
export const AUDIO_INSTRUCTIONS =
	"Sound is half the ad: narrate with voiceover {timeline_id, text, voice?} (one line per call; words go to the transcript store, so captions follow; tighten: true cuts the long pauses; fit_to {t0, t1} | {beat: N} makes the line fit its span or refuses) and put a bed under it with music {timeline_id, mood: warm | moody | upbeat | ambient | tense} — ducked under the words, beats on the clip; loop: true = whole bars, no fades, for a cut that loops; voiceover {beat: true} lands a line on the next downbeat.";
