/**
 * Local voice-over (voice-music agent, 2026-10-20): text → a speech take with word timings, made only with what Windows
 * ships (System.Speech "Desktop" voices and the WinRT/OneCore voices) through ./voice-tts.ps1 — no install, no network,
 * no account. Paid voices (ElevenLabs etc.) are owner options, see docs/restorff/worklog/voice-music.md.
 *
 *   text ─ voice-tts.ps1 ─▶ raw WAV + engine word starts (SAPI: AudioPosition rescaled; OneCore: word-boundary cues)
 *        ─ ffmpeg ─▶ 48 kHz mono float ─▶ word starts snapped to the first voiced 10 ms frame, word ends from the audio
 *        ─ ffmpeg ─▶ tail trimmed (last word + 0.3 s), gain to −16 LUFS integrated, limiter if the true peak would pass
 *                    −1.5 dBTP → 16-bit 48 kHz mono WAV (bit-exact, so the same take hashes the same)
 *        ─ ffmpeg ─▶ measured again (ebur128) + a timing check against silencedetect (the report's real numbers)
 *
 * Takes are cached by (text, voice, speed, pipeline version) in <apps/web>/.data/voice/<key>.{wav,json}
 * (RESTORFFCUT_VOICE_DIR overrides; git-ignored with the rest of .data). Word timings are SOURCE seconds (into the take),
 * the `{text, start, end}` shape of @restorffcut/timeline-ops TimedWord and the transcript store (server/transcripts.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TimedWord } from "@restorffcut/timeline-ops";
import { HttpError } from "./http";
import { putProjectMedia } from "./media";
import { type TranscriptRecord, transcriptsDir } from "./transcripts";
import { decodeMono, detectSilences, ffmpeg, measureLoudness, runProgram } from "./voice-ffmpeg";

export const VOICE_TAKE_SCHEMA = "restorff-voice-take@1";
/** Bump when the processing changes: it is part of the cache key. */
export const VOICE_PIPELINE_VERSION = 1;
/** Speech stem target: −16 LUFS integrated, ≤ −1.5 dBTP (the export masters the whole mix to −14 LUFS / −1 dBTP). */
export const SPEECH_TARGET = { lufs: -16, truePeak: -1.5 } as const;
export const MAX_TEXT_CHARS = 1500;
export const DEFAULT_VOICE = "zira-desktop";
const RATE = 48_000;
const FRAME_S = 0.01;

export function voiceDir(): string {
	const configured = process.env.RESTORFFCUT_VOICE_DIR?.trim();
	if (configured) return path.resolve(configured);
	return path.join(process.cwd(), ".data", "voice");
}

export function voiceScript(): string {
	const configured = process.env.RESTORFFCUT_VOICE_SCRIPT?.trim();
	if (configured) return path.resolve(configured);
	return path.join(process.cwd(), "src", "server", "voice-tts.ps1");
}

const POWERSHELL = process.env.RESTORFFCUT_POWERSHELL || "powershell.exe";

// ─── voices ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface VoiceInfo {
	/** Short id the tools take: "zira-desktop", "david-desktop", "zira", "david", "mark". */
	id: string;
	name: string;
	engine: "sapi" | "onecore";
	language: string;
	gender: string;
	/** Native sample rate of the engine's output (MEASURED 2026-10-20: SAPI Desktop 22050, OneCore 16000). */
	native_rate: number;
}

export const voiceIdOf = (name: string) =>
	name
		.toLowerCase()
		.replace(/^microsoft\s+/, "")
		.trim()
		.replace(/\s+/g, "-");

interface VoiceCache {
	at: number;
	voices: VoiceInfo[];
	error: string | null;
}

function voiceCache(): { value: VoiceCache | null } {
	const g = globalThis as unknown as { __restorffVoices?: { value: VoiceCache | null } };
	g.__restorffVoices ??= { value: null };
	return g.__restorffVoices;
}

function lastJsonLine(stdout: string): Record<string, unknown> | null {
	const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i].startsWith("{")) continue;
		try {
			return JSON.parse(lines[i]) as Record<string, unknown>;
		} catch {
			/* keep looking */
		}
	}
	return null;
}

const psArgs = (extra: string[]) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", voiceScript(), ...extra];

/** The voices this machine can speak with (cached 10 min). Empty with an error on a machine without Windows speech. */
export async function listVoices(signal?: AbortSignal): Promise<{ voices: VoiceInfo[]; error: string | null }> {
	const cache = voiceCache();
	if (cache.value && Date.now() - cache.value.at < 10 * 60_000) return cache.value;
	let voices: VoiceInfo[] = [];
	let error: string | null = null;
	if (process.platform !== "win32") {
		error = `local voice-over needs Windows' speech engine (this server runs on ${process.platform})`;
	} else if (!existsSync(voiceScript())) {
		error = `the speech script is missing: ${voiceScript()}`;
	} else {
		try {
			const result = await runProgram(POWERSHELL, psArgs(["-List"]), { signal, timeoutMs: 60_000 });
			const parsed = lastJsonLine(result.stdout.toString("utf8"));
			if (!parsed?.ok) error = `voice list failed: ${String(parsed?.error ?? result.stderr.slice(0, 300))}`;
			else {
				voices = ((parsed.voices as Array<Record<string, string>>) ?? []).map((voice) => ({
					id: voiceIdOf(voice.name),
					name: voice.name,
					engine: voice.engine === "onecore" ? "onecore" : "sapi",
					language: voice.language,
					gender: voice.gender,
					native_rate: voice.engine === "onecore" ? 16_000 : 22_050,
				}));
			}
		} catch (failure) {
			error = `voice list failed: ${failure instanceof Error ? failure.message : String(failure)}`;
		}
	}
	const value = { at: Date.now(), voices, error };
	if (!error) cache.value = value;
	return value;
}

/** A voice by id, name or part of it ("zira" → "zira" exactly, else the Desktop voice); default DEFAULT_VOICE. */
export async function resolveVoice(input: string | undefined, signal?: AbortSignal): Promise<VoiceInfo> {
	const { voices, error } = await listVoices(signal);
	if (!voices.length) throw new HttpError(501, error ?? "no speech voices on this machine");
	const query = (input ?? "").trim().toLowerCase();
	if (!query) return voices.find((voice) => voice.id === DEFAULT_VOICE) ?? voices[0];
	const exact = voices.find((voice) => voice.id === query || voice.name.toLowerCase() === query || voiceIdOf(voice.name) === voiceIdOf(query));
	if (exact) return exact;
	const partial = voices
		.filter((voice) => voice.id.includes(voiceIdOf(query)) || voice.name.toLowerCase().includes(query))
		.sort((a, b) => (a.engine === b.engine ? 0 : a.engine === "sapi" ? -1 : 1));
	if (partial[0]) return partial[0];
	throw new HttpError(400, `no voice "${input}" on this machine; voices: ${voices.map((voice) => voice.id).join(", ")}`, {
		voices: voices.map((voice) => voice.id),
	});
}

// ─── the take ───────────────────────────────────────────────────────────────────────────────────────────────

export interface TimingEdge {
	word: string;
	edge: "start" | "end";
	/** Where the audio says the edge is (silencedetect), seconds into the take. */
	audio_s: number;
	/** Where our word timing puts it. */
	words_s: number;
	error_ms: number;
	/** The engine's own time for a start (before snapping), for the record. */
	engine_s?: number;
	engine_error_ms?: number;
}

export interface TimingCheck {
	method: string;
	edges: TimingEdge[];
	max_error_ms: number | null;
	median_error_ms: number | null;
	engine_start_max_error_ms: number | null;
}

export interface VoiceTake {
	schema: typeof VOICE_TAKE_SCHEMA;
	version: number;
	/** Cache key (sha256 of text + voice + speed + version), also the take's URL id. */
	key: string;
	/** sha256 of the WAV bytes (= its id in the media store and the transcript store). */
	hash: string;
	file: string;
	bytes: number;
	text: string;
	voice: { id: string; name: string; engine: "sapi" | "onecore" };
	speed: number;
	language: string;
	sample_rate: number;
	channels: number;
	duration_s: number;
	/** SOURCE seconds into the take, text with its punctuation (as written). */
	words: TimedWord[];
	/** The engine's word times as reported (starts; ends are the engine's own and are not used). */
	engine_words: TimedWord[];
	loudness: {
		target_lufs: number;
		target_true_peak_dbtp: number;
		raw_lufs: number | null;
		raw_true_peak_dbtp: number | null;
		gain_db: number;
		limited: boolean;
		lufs_i: number | null;
		true_peak_dbtp: number | null;
		lra: number | null;
	};
	timing: TimingCheck;
	created_at: string;
	ms: number;
}

const r3 = (value: number) => Math.round(value * 1000) / 1000;
const r2 = (value: number) => Math.round(value * 100) / 100;

export function cleanText(text: string): string {
	return text
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function takeKey(text: string, voice: VoiceInfo, speed: number): string {
	return createHash("sha256")
		.update(JSON.stringify({ v: VOICE_PIPELINE_VERSION, text, voice: voice.id, engine: voice.engine, speed: r2(speed) }))
		.digest("hex")
		.slice(0, 32);
}

const takeJson = (key: string) => path.join(voiceDir(), `${key}.json`);
const takeWav = (key: string) => path.join(voiceDir(), `${key}.wav`);

export function readTake(key: string): VoiceTake | null {
	if (!/^[0-9a-f]{16,64}$/.test(key)) return null;
	try {
		const take = JSON.parse(readFileSync(takeJson(key), "utf8")) as VoiceTake;
		if (take?.schema !== VOICE_TAKE_SCHEMA || !existsSync(takeWav(key))) return null;
		return { ...take, file: takeWav(key) };
	} catch {
		return null;
	}
}

export function takeFilePath(key: string): string | null {
	const file = takeWav(key);
	return /^[0-9a-f]{16,64}$/.test(key) && existsSync(file) ? file : null;
}

/** The text as written for an engine token: from its first character to the next whitespace ("cold" → "cold."). */
function writtenWord(text: string, char: number, len: number, nextChar: number | null): string {
	if (!(char >= 0) || char >= text.length) return "";
	let end = Math.max(char + Math.max(1, len), char + 1);
	const stop = nextChar !== null && nextChar > char ? nextChar : text.length;
	while (end < stop && !/\s/.test(text[end])) end++;
	return text.slice(char, end).trim();
}

/**
 * 10 ms frame levels (dBFS) and a voiced mask. A frame is voiced when it is within 40 dB of the loudest frame AND,
 * when `gainDb` is given, louder than −45 dBFS after that gain (the same pause definition as the timing check's
 * silencedetect on the finished take). MEASURED 2026-10-20: OneCore takes have a breath/noise floor near −51 dBFS in
 * pauses, so a purely relative threshold missed a 229 ms pause.
 */
function frameLevels(pcm: Float32Array, gainDb?: number): { voiced: Uint8Array; count: number } {
	// silencedetect compares SAMPLE amplitude, so a frame's level is its peak (an RMS frame below −45 dB can still hold
	// samples above it: MEASURED 2026-10-20, RMS ends came out 28–57 ms early against silencedetect)
	const size = Math.round(RATE * FRAME_S);
	const count = Math.floor(pcm.length / size);
	const db = new Float32Array(count);
	let max = -120;
	for (let k = 0; k < count; k++) {
		let peak = 0;
		for (let i = k * size; i < (k + 1) * size; i++) peak = Math.max(peak, Math.abs(pcm[i]));
		db[k] = 20 * Math.log10(peak + 1e-9);
		if (db[k] > max) max = db[k];
	}
	const threshold = gainDb === undefined ? Math.max(-80, max - 45) : Math.max(-80, max - 50, -45 - gainDb);
	const voiced = new Uint8Array(count);
	for (let k = 0; k < count; k++) voiced[k] = db[k] >= threshold ? 1 : 0;
	return { voiced, count };
}

/**
 * Word timings from the engine's starts and the audio (frames of 10 ms; a pause = ≥ 40 ms of silent frames):
 * - a start that falls inside a pause moves to the pause's end; a start just after a pause (≤ 60 ms) moves back to the
 *   pause's end (the voice began a little before the engine said so: MEASURED, OneCore "and" 4 ms early);
 * - an end is where the pause before the next word begins, when there is one next to that word's start; else the next
 *   word's start (connected speech); the last word ends where speech ends.
 * `gainDb` = the gain the take will get (calibrates the pause threshold to −45 dBFS in the finished file).
 */
export function refineWords(engine: TimedWord[], pcm: Float32Array, gainDb?: number): { words: TimedWord[]; speechEnd: number } {
	const { voiced, count } = frameLevels(pcm, gainDb);
	const frameOf = (t: number) => Math.max(0, Math.min(count, Math.round(t / FRAME_S)));
	let lastVoiced = count - 1;
	while (lastVoiced > 0 && !voiced[lastVoiced]) lastVoiced--;
	const speechEnd = (lastVoiced + 1) * FRAME_S;
	// pauses: runs of ≥ 4 silent frames [a, b)
	const runs: Array<{ a: number; b: number }> = [];
	for (let k = 0; k < count; ) {
		if (voiced[k]) {
			k++;
			continue;
		}
		let b = k;
		while (b < count && !voiced[b]) b++;
		if (b - k >= 4) runs.push({ a: k, b });
		k = b;
	}
	const starts = engine.map((word) => {
		const k = frameOf(word.start);
		const inside = runs.find((run) => run.a <= k && k < run.b && run.b - k <= 15);
		if (inside) return inside.b * FRAME_S;
		const justBefore = runs.find((run) => run.b <= k && k - run.b <= 6);
		if (justBefore) return justBefore.b * FRAME_S;
		return word.start;
	});
	const words: TimedWord[] = [];
	for (let i = 0; i < engine.length; i++) {
		const start = starts[i];
		let end: number;
		if (i + 1 < engine.length) {
			const kNext = frameOf(starts[i + 1]);
			const pause = [...runs].reverse().find((run) => run.a > frameOf(start) + 3 && Math.abs(run.b - kNext) <= 6);
			end = pause ? pause.a * FRAME_S : starts[i + 1];
			end = Math.min(end, starts[i + 1]);
		} else {
			end = speechEnd;
		}
		words.push({ text: engine[i].text, start: r3(start), end: r3(Math.max(start + 0.04, end)) });
	}
	return { words, speechEnd };
}

/** Our word edges against the pauses ffmpeg hears (silencedetect −45 dB, ≥ 0.12 s) inside the take. */
export async function checkTiming(file: string, duration: number, words: TimedWord[], engine: TimedWord[]): Promise<TimingCheck> {
	const silences = (await detectSilences(file, -45, 0.12)).filter((s) => s.start > 0.05 && s.end < duration - 0.05);
	const edges: TimingEdge[] = [];
	const nearest = (time: number, pick: (word: TimedWord) => number) => {
		let best = -1;
		for (let i = 0; i < words.length; i++) if (best < 0 || Math.abs(pick(words[i]) - time) < Math.abs(pick(words[best]) - time)) best = i;
		return best;
	};
	for (const silence of silences) {
		const before = nearest(silence.start, (word) => word.end);
		const after = nearest(silence.end, (word) => word.start);
		if (before >= 0) {
			edges.push({
				word: words[before].text,
				edge: "end",
				audio_s: r3(silence.start),
				words_s: words[before].end,
				error_ms: Math.round((words[before].end - silence.start) * 1000),
			});
		}
		if (after >= 0) {
			const engineStart = engine[after]?.start;
			edges.push({
				word: words[after].text,
				edge: "start",
				audio_s: r3(silence.end),
				words_s: words[after].start,
				error_ms: Math.round((words[after].start - silence.end) * 1000),
				...(typeof engineStart === "number" ? { engine_s: engineStart, engine_error_ms: Math.round((engineStart - silence.end) * 1000) } : {}),
			});
		}
	}
	const errors = edges.map((edge) => Math.abs(edge.error_ms)).sort((a, b) => a - b);
	const engineErrors = edges.filter((edge) => edge.engine_error_ms !== undefined).map((edge) => Math.abs(edge.engine_error_ms as number));
	return {
		method: "each pause ffmpeg silencedetect hears (−45 dB, ≥ 0.12 s) vs the nearest word end before it and word start after it",
		edges,
		max_error_ms: errors.length ? errors[errors.length - 1] : null,
		median_error_ms: errors.length ? errors[Math.floor(errors.length / 2)] : null,
		engine_start_max_error_ms: engineErrors.length ? Math.max(...engineErrors) : null,
	};
}

/** Size of a RIFF/WAVE file's `data` chunk (bytes of samples). */
export function wavDataBytes(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 12;
	while (offset + 8 <= bytes.byteLength) {
		const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
		const size = view.getUint32(offset + 4, true);
		if (id === "data") return Math.min(size, bytes.byteLength - offset - 8);
		offset += 8 + size + (size % 2);
	}
	return 0;
}

interface EngineOutput {
	ok: boolean;
	error?: string;
	engine: string;
	voice: string;
	sample_rate: number;
	duration_s: number;
	words: Array<{ word: string; start: number; end: number; char: number; len: number }>;
}

const inFlight = new Map<string, Promise<VoiceTake>>();

/** Speak `text` with `voice` at `speed` (0.5–2, 1 = normal). Cached; returns the take and whether it came from cache. */
export async function synthesizeTake(
	input: { text: string; voice?: string; speed?: number },
	signal?: AbortSignal,
): Promise<{ take: VoiceTake; cached: boolean }> {
	const text = cleanText(input.text ?? "");
	if (!text) throw new HttpError(400, "text is empty");
	if (text.length > MAX_TEXT_CHARS) throw new HttpError(400, `text is ${text.length} characters; at most ${MAX_TEXT_CHARS} per take (split it into lines)`);
	const speed = Math.max(0.5, Math.min(2, typeof input.speed === "number" && Number.isFinite(input.speed) ? input.speed : 1));
	const voice = await resolveVoice(input.voice, signal);
	const key = takeKey(text, voice, speed);
	const cached = readTake(key);
	if (cached) return { take: cached, cached: true };
	let job = inFlight.get(key);
	if (!job) {
		job = makeTake(key, text, voice, speed, signal).finally(() => inFlight.delete(key));
		inFlight.set(key, job);
	}
	return { take: await job, cached: false };
}

async function makeTake(key: string, text: string, voice: VoiceInfo, speed: number, signal?: AbortSignal): Promise<VoiceTake> {
	const began = Date.now();
	const dir = voiceDir();
	const tmp = path.join(dir, "tmp", randomUUID());
	mkdirSync(tmp, { recursive: true });
	try {
		const textFile = path.join(tmp, "text.txt");
		const raw = path.join(tmp, "raw.wav");
		const final = path.join(tmp, "take.wav");
		writeFileSync(textFile, text, "utf8");
		const run = await runProgram(
			POWERSHELL,
			psArgs(["-TextFile", textFile, "-Out", raw, "-Voice", voice.name, "-Engine", voice.engine, "-Speed", String(speed)]),
			{ signal, timeoutMs: 120_000 },
		);
		const out = lastJsonLine(run.stdout.toString("utf8")) as EngineOutput | null;
		if (!out?.ok || !existsSync(raw)) {
			throw new HttpError(500, `the speech engine failed: ${out?.error ?? (run.stderr.trim().slice(0, 400) || `exit ${run.code}`)}`);
		}
		if (!out.words?.length) throw new HttpError(500, "the speech engine reported no words");
		const engineWords: TimedWord[] = out.words.map((word, i) => ({
			text: writtenWord(text, word.char, word.len, out.words[i + 1]?.char ?? null) || word.word,
			start: r3(word.start),
			end: r3(word.end),
		}));

		// where speech ends (rough), so the tail can go: 48 kHz mono float, the same resampling as the final file
		const pcm = await decodeMono(raw, RATE, signal);
		const rawDuration = pcm.length / RATE;
		const end = Math.min(rawDuration, refineWords(engineWords, pcm).speechEnd + 0.3);

		// loudness: measure the trimmed take, gain to the target; when the true peak would pass the ceiling a limiter
		// holds it, and the gain is raised by what the limiter took (≤ 3 passes) so the take still lands on the target
		const trim = `aresample=${RATE}:resampler=soxr,atrim=end=${end.toFixed(4)}`;
		const before = await measureLoudness(raw, trim, signal);
		if (before.lufsI === null) throw new HttpError(500, "the take is silent (no gated loudness)");
		let gain = SPEECH_TARGET.lufs - before.lufsI;
		const limited = before.truePeak !== null && before.truePeak + gain > SPEECH_TARGET.truePeak;
		const ceiling = 10 ** ((SPEECH_TARGET.truePeak - 0.6) / 20);
		let after = before;
		for (let pass = 0; pass < (limited ? 4 : 1); pass++) {
			const chain = [
				trim,
				`volume=${gain.toFixed(3)}dB`,
				...(limited ? [`alimiter=limit=${ceiling.toFixed(5)}:attack=2:release=60:level=0`] : []),
				`afade=t=out:st=${Math.max(0, end - 0.03).toFixed(4)}:d=0.03`,
			].join(",");
			await ffmpeg(
				["-y", "-i", raw, "-af", chain, "-ac", "1", "-ar", String(RATE), "-c:a", "pcm_s16le", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", final],
				{ signal },
			);
			after = await measureLoudness(final, "", signal);
			const short = after.lufsI === null ? 0 : SPEECH_TARGET.lufs - after.lufsI;
			if (Math.abs(short) <= 0.4) break;
			gain += short;
		}
		// word timings, with the pause threshold calibrated to the finished level
		const { words } = refineWords(engineWords, pcm, gain);
		const bytes = readFileSync(final);
		const hash = createHash("sha256").update(bytes).digest("hex");
		const duration = r3(wavDataBytes(bytes) / (RATE * 2));
		const timing = await checkTiming(final, duration, words, engineWords);

		mkdirSync(dir, { recursive: true });
		renameSync(final, takeWav(key));
		const take: VoiceTake = {
			schema: VOICE_TAKE_SCHEMA,
			version: VOICE_PIPELINE_VERSION,
			key,
			hash,
			file: takeWav(key),
			bytes: bytes.byteLength,
			text,
			voice: { id: voice.id, name: voice.name, engine: voice.engine },
			speed,
			language: voice.language,
			sample_rate: RATE,
			channels: 1,
			duration_s: duration,
			words: words.map((word) => ({ ...word, end: Math.min(word.end, duration) })),
			engine_words: engineWords,
			loudness: {
				target_lufs: SPEECH_TARGET.lufs,
				target_true_peak_dbtp: SPEECH_TARGET.truePeak,
				raw_lufs: before.lufsI,
				raw_true_peak_dbtp: before.truePeak,
				gain_db: r2(gain),
				limited,
				lufs_i: after.lufsI,
				true_peak_dbtp: after.truePeak,
				lra: after.lra,
			},
			timing,
			created_at: new Date().toISOString(),
			ms: Date.now() - began,
		};
		writeFileSync(takeJson(key), JSON.stringify(take, null, 1));
		return take;
	} finally {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* a locked temp file is harmless; .data/voice/tmp is git-ignored */
		}
	}
}

// ─── where the take goes ────────────────────────────────────────────────────────────────────────────────────

/** Put the take's WAV into the project's media store under `mediaId` (the editor downloads it with the commit). */
export async function storeTakeAsMedia(projectId: string, mediaId: string, take: VoiceTake, name: string): Promise<{ size: number }> {
	const bytes = readFileSync(take.file);
	const meta = {
		name,
		type: "audio",
		duration: take.duration_s,
		hasAudio: true,
		size: bytes.byteLength,
		lastModified: Date.now(),
		restorff: { voice: take.voice.id, take: take.key },
	};
	const request = new Request("http://restorffcut.internal/media", {
		method: "PUT",
		body: new Uint8Array(bytes),
		headers: {
			"content-type": "audio/wav",
			"x-media-meta": Buffer.from(JSON.stringify(meta), "utf8").toString("base64url"),
			"x-media-sha256": take.hash,
		},
	});
	await putProjectMedia(projectId, mediaId, request);
	return { size: bytes.byteLength };
}

/**
 * The take's words in the transcript store (server/transcripts.ts, mcp-cut agent), keyed by the WAV's sha256 like any
 * transcribed media: <transcripts>/<sha256>/transcript.tts.<lang>.json, schema restorffcut-transcript@1, model "tts".
 * So `captions` / `autocut` read the voice-over like a transcribed clip, with the exact words that were spoken.
 */
export function writeTakeTranscript(take: VoiceTake, mediaName: string): string {
	const language = (take.language || "en").split("-")[0].toLowerCase();
	const dir = path.join(transcriptsDir(), take.hash);
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `transcript.tts.${language}.json`);
	const record: TranscriptRecord = {
		schema: "restorffcut-transcript@1",
		hash: take.hash,
		size: take.bytes,
		mime: "audio/wav",
		media_name: mediaName,
		model: "tts",
		language_asked: language,
		language,
		backend: `windows-${take.voice.engine}:${take.voice.name}`,
		device: "cpu",
		duration: take.duration_s,
		text: take.text,
		words: take.words,
		created_at: take.created_at,
		ms: take.ms,
	};
	if (!existsSync(file) || statSync(file).size === 0) {
		writeFileSync(`${file}.part`, JSON.stringify(record));
		renameSync(`${file}.part`, file);
	}
	return file;
}
