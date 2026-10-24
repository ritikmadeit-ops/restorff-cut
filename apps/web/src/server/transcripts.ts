/**
 * Server-side transcripts (mcp-cut agent, 2026-10-20; EDT-11/12): word timings for a project's media file, made with
 * temporal-visual-flux (TVF = faster-whisper with word timestamps, CUDA when available) exactly as the pipeline does
 * (packages/pipeline/src/tvf.ts), cached per media sha256, run as a background job.
 *
 *   <dir>/<sha256>/source.<ext>                      hard link to the media store's file (TVF wants a file name)
 *   <dir>/<sha256>/tvf-<model>/<slug>/…              TVF's own work folder (audio16k.wav, transcript/, manifest.json)
 *   <dir>/<sha256>/transcript.<model>.<lang>.json    our record (schema restorffcut-transcript@1) — the cache
 *   <dir>/<sha256>/silences.<db>.<min>.json          ffmpeg silencedetect, for silence-aware cuts
 *   <dir>/jobs/<job id>.json                         job state (also kept in memory on globalThis)
 *
 * <dir> = RESTORFFCUT_TRANSCRIPTS_DIR, default <apps/web>/.data/transcripts (git-ignored, like the media store).
 * Programs: RESTORFF_PY (Python that can `import tvf`), RESTORFF_TVF_DIR, FFMPEG — same names and defaults as
 * packages/pipeline/src/paths.ts. TVF also appends one telemetry line per stage to its own logs/runs/ (TVF's design;
 * the pipeline's runs do the same).
 *
 * Why not import @restorffcut/pipeline: no web module imports it yet, and its paths.ts resolves the repo through
 * import.meta.url, which a bundled module may not have — a throw at import would take /api/mcp down for every tool.
 * The three small pieces used here (TVF transcript reader, silencedetect, word clipping) are copied and named.
 *
 * Runbook: docs/restorff/worklog/mcp-cut.md.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TimedWord } from "@restorffcut/timeline-ops";
import { resolveMediaDir } from "@/lib/db/store";
import { HttpError } from "./http";
import { listProjectMedia, type MediaDto } from "./media";

// ─── paths and programs ──────────────────────────────────────────────────────────────────────────────────────

export const PY = process.env.RESTORFF_PY || "C:\\Program Files\\Python313\\python.exe";
export const TVF_DIR = process.env.RESTORFF_TVF_DIR || "C:\\data\\code\\temporal-visual-flux";
export const FFMPEG = process.env.FFMPEG || "ffmpeg";

export function transcriptsDir(): string {
	const configured = process.env.RESTORFFCUT_TRANSCRIPTS_DIR?.trim();
	if (configured) return path.resolve(configured);
	return path.join(process.cwd(), ".data", "transcripts");
}

/** faster-whisper models with weights already on this machine (no download): large-v3 is the default (best timings). */
export const TRANSCRIBE_MODELS = ["large-v3", "small.en", "base.en"] as const;
export type TranscribeModel = (typeof TRANSCRIBE_MODELS)[number];
export const DEFAULT_TRANSCRIBE_MODEL: TranscribeModel = "large-v3";
/** A run longer than this is stopped (a 10-minute file takes ~1-2 min on the RTX 3060). */
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

// ─── the record ──────────────────────────────────────────────────────────────────────────────────────────────

export interface TranscriptRecord {
	schema: "restorffcut-transcript@1";
	hash: string;
	size: number;
	mime: string;
	media_name: string | null;
	model: string;
	/** What was asked ("auto" = detect). */
	language_asked: string;
	/** What Whisper used / detected. */
	language: string;
	backend: string;
	device: string;
	duration: number;
	text: string;
	/** Seconds in the SOURCE file (after the relisten pass when it ran). */
	words: TimedWord[];
	created_at: string;
	/** Wall time of the job that made it (TVF + relisten). */
	ms: number;
	/**
	 * The relisten pass: every stretch between silences transcribed again on its own. Whisper over a whole file
	 * merges a restarted phrase into one ("This tool is … This tool is called" → "This tool is called", the pause
	 * hidden inside "called": pipeline LEARNINGS 5); heard alone, each take comes back. Only words the second pass
	 * hears BEFORE a stretch's first word or AFTER its last word are added (the bulk keeps the first pass's spelling).
	 */
	relisten?: { stretches: number; replaced: number; added_words: number; ms: number; device?: string; error?: string; whisper_words?: TimedWord[] };
	/** captions-v2: the person's word fixes applied on read (never stored in this file; see `edits.json`). */
	edits?: TranscriptEditReport[];
}

// ─── the person's word fixes (captions-v2, 2026-10-20) ───────────────────────────────────────────────────────

/**
 * One fix to a media file's transcript, kept beside the cache as `<sha256>/edits.json` and applied every time the
 * transcript is read — so a caption rebuild, an autocut or a forced re-transcription never brings Whisper's word back
 * (warm-moody REPORT §5 item 9: a rebuild silently restored "Cloud"). `from` is matched word by word, ignoring case and
 * punctuation; `source_t` (seconds in the media file) limits it to the one occurrence nearest that time (within 2 s).
 */
export interface TranscriptEdit {
	from: string;
	to: string;
	source_t?: number;
	created_at: string;
}

export interface TranscriptEditReport {
	from: string;
	to: string;
	source_t?: number;
	/** Where it matched (source seconds of the first replaced word); empty = it matched nothing this time. */
	matched: number[];
}

const EDITS_SCHEMA = "restorffcut-transcript-edits@1";
const editsPath = (hash: string) => path.join(hashDir(hash), "edits.json");

export function readEdits(hash: string): TranscriptEdit[] {
	try {
		const file = JSON.parse(readFileSync(editsPath(hash), "utf8")) as { schema?: string; edits?: TranscriptEdit[] };
		return file?.schema === EDITS_SCHEMA && Array.isArray(file.edits) ? file.edits : [];
	} catch {
		return [];
	}
}

export function saveEdits(hash: string, edits: TranscriptEdit[]): void {
	mkdirSync(hashDir(hash), { recursive: true });
	const file = editsPath(hash);
	writeFileSync(`${file}.part`, JSON.stringify({ schema: EDITS_SCHEMA, edits }, null, 1));
	renameSync(`${file}.part`, file);
}

/** A word compared for a fix: lower case, letters / digits / apostrophes only. */
export const editKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

const TRAILING_PUNCTUATION = /[.,!?;:…]+$/u;

/**
 * Apply fixes in order. Each `from` (one or more words) is found as a run of words; the run is replaced by `to`'s words
 * spread over the same time by letters (a single word keeps its times). The replaced run's trailing punctuation is
 * kept when `to` has none ("Cloud," → "Claude,"). `to: ""` deletes the words. Pure.
 */
export function applyTranscriptEdits(words: readonly TimedWord[], edits: readonly TranscriptEdit[]): { words: TimedWord[]; report: TranscriptEditReport[] } {
	let out = words.map((word) => ({ ...word }));
	const report: TranscriptEditReport[] = [];
	for (const edit of edits) {
		const from = edit.from.trim().split(/\s+/).map(editKey).filter(Boolean);
		const to = edit.to.trim().split(/\s+/).filter(Boolean);
		const entry: TranscriptEditReport = { from: edit.from, to: edit.to, ...(edit.source_t !== undefined ? { source_t: edit.source_t } : {}), matched: [] };
		report.push(entry);
		if (!from.length) continue;
		const hits: number[] = [];
		for (let i = 0; i + from.length <= out.length; i++) {
			let same = true;
			for (let k = 0; k < from.length; k++) {
				if (editKey(out[i + k].text) !== from[k]) {
					same = false;
					break;
				}
			}
			if (same) hits.push(i);
		}
		let chosen = hits;
		if (edit.source_t !== undefined && hits.length) {
			const t = edit.source_t;
			const nearest = hits.reduce((best, i) => (Math.abs(out[i].start - t) < Math.abs(out[best].start - t) ? i : best), hits[0]);
			chosen = Math.abs(out[nearest].start - t) <= 2 ? [nearest] : [];
		}
		// replace from the last hit backwards so earlier indexes stay valid
		for (const i of [...chosen].sort((a, b) => b - a)) {
			const run = out.slice(i, i + from.length);
			const start = run[0].start;
			const end = run[run.length - 1].end;
			const tail = TRAILING_PUNCTUATION.exec(run[run.length - 1].text.trim())?.[0] ?? "";
			entry.matched.unshift(Math.round(start * 1000) / 1000);
			let replacement: TimedWord[] = [];
			if (to.length === 1) {
				replacement = [{ text: to[0], start, end }];
			} else if (to.length > 1) {
				const letters = to.reduce((sum, token) => sum + token.length, 0) || 1;
				let cursor = start;
				replacement = to.map((token) => {
					const span = ((end - start) * token.length) / letters;
					const word = { text: token, start: Math.round(cursor * 1000) / 1000, end: Math.round((cursor + span) * 1000) / 1000 };
					cursor += span;
					return word;
				});
			}
			const last = replacement[replacement.length - 1];
			if (last && tail && !TRAILING_PUNCTUATION.test(last.text)) last.text = `${last.text}${tail}`;
			out = [...out.slice(0, i), ...replacement, ...out.slice(i + from.length)];
		}
	}
	return { words: out, report };
}

export interface MediaFile {
	projectId: string;
	mediaId: string;
	hash: string;
	size: number;
	mime: string;
	name: string | null;
	file: string;
	meta: Record<string, unknown> | null;
}

const hashDir = (hash: string) => path.join(transcriptsDir(), hash);
const langKey = (language: string | null | undefined) => (language && language.trim() ? language.trim().toLowerCase() : "auto");
const recordPath = (hash: string, model: string, language: string | null | undefined) =>
	path.join(hashDir(hash), `transcript.${model}.${langKey(language)}.json`);

/** The project's media file on disk (the media store, server/media.ts), or a 404 that says how to get it there. */
export async function resolveMediaFile(projectId: string, mediaId: string, listed?: MediaDto[]): Promise<MediaFile> {
	const media = listed ?? (await listProjectMedia(projectId));
	const row = media.find((entry) => entry.media_id === mediaId);
	if (!row) {
		throw new HttpError(
			404,
			`media ${mediaId} is not on the server for this timeline. The editor uploads a project's media when version history is on (and after each push); or PUT the file to /api/projects/${projectId}/media/${mediaId}.`,
		);
	}
	const file = path.join(resolveMediaDir(), row.hash.slice(0, 2), row.hash);
	if (!existsSync(file)) throw new HttpError(410, `media ${mediaId} is recorded but its file is missing on the server`);
	const name = typeof row.meta?.name === "string" ? (row.meta.name as string) : null;
	return { projectId, mediaId, hash: row.hash, size: row.size, mime: row.mime, name, file, meta: row.meta };
}

function extensionFor(mime: string, name: string | null): string {
	const fromName = name ? path.extname(name).toLowerCase() : "";
	if (/^\.[a-z0-9]{2,5}$/.test(fromName)) return fromName;
	const table: Record<string, string> = {
		"video/mp4": ".mp4",
		"video/quicktime": ".mov",
		"video/webm": ".webm",
		"video/x-matroska": ".mkv",
		"audio/mpeg": ".mp3",
		"audio/mp4": ".m4a",
		"audio/x-m4a": ".m4a",
		"audio/wav": ".wav",
		"audio/x-wav": ".wav",
		"audio/webm": ".webm",
		"audio/ogg": ".ogg",
	};
	return table[mime] ?? ".mp4";
}

/** A named path to the media bytes for TVF/ffmpeg: a hard link next to the cache (no copy), else the store file. */
export function sourcePath(media: MediaFile): string {
	const dir = hashDir(media.hash);
	mkdirSync(dir, { recursive: true });
	const linked = path.join(dir, `source${extensionFor(media.mime, media.name)}`);
	if (existsSync(linked)) return linked;
	try {
		linkSync(media.file, linked);
		return linked;
	} catch {
		return media.file; // other drive / no hard links: ffmpeg reads by content, the name doesn't matter
	}
}

function readRecord(file: string): TranscriptRecord | null {
	try {
		const record = JSON.parse(readFileSync(file, "utf8")) as TranscriptRecord;
		return record?.schema === "restorffcut-transcript@1" && Array.isArray(record.words) ? record : null;
	} catch {
		return null;
	}
}

/**
 * The cached transcript of these bytes: the asked model + language if given, else the best one there is
 * (large-v3 before small.en before base.en; newest first). The person's word fixes (`edits.json`, captions-v2) are
 * applied to `words` and `text` unless `raw` — so captions, autocut and the editor all read the fixed words, and a
 * re-transcription (force) keeps them.
 */
export function findTranscript(
	hash: string,
	opts: { model?: string; language?: string | null; raw?: boolean; /** revise-safety: fixes applied after the saved ones, not saved (a dry run, a commit not made yet). */ extra?: readonly TranscriptEdit[] } = {},
): TranscriptRecord | null {
	const found = findRawTranscript(hash, opts);
	if (!found || opts.raw) return found;
	const edits = [...readEdits(hash), ...(opts.extra ?? [])];
	if (!edits.length) return found;
	const fixed = applyTranscriptEdits(found.words, edits);
	return { ...found, words: fixed.words, text: fixed.words.map((word) => word.text).join(" "), edits: fixed.report };
}

function findRawTranscript(hash: string, opts: { model?: string; language?: string | null } = {}): TranscriptRecord | null {
	if (opts.model) {
		const exact = readRecord(recordPath(hash, opts.model, opts.language));
		if (exact) return exact;
		if (opts.language) return null;
	}
	const dir = hashDir(hash);
	if (!existsSync(dir)) return null;
	const records = readdirSync(dir)
		.filter((name) => name.startsWith("transcript.") && name.endsWith(".json"))
		.map((name) => readRecord(path.join(dir, name)))
		.filter((record): record is TranscriptRecord => !!record && (!opts.model || record.model === opts.model));
	const rank = (model: string) => {
		const i = (TRANSCRIBE_MODELS as readonly string[]).indexOf(model);
		return i < 0 ? 99 : i;
	};
	records.sort((a, b) => rank(a.model) - rank(b.model) || b.created_at.localeCompare(a.created_at));
	return records[0] ?? null;
}

// ─── TVF transcript.json → words (copy of packages/pipeline/src/tvf.ts readTvfTranscript) ────────────────────

interface TvfTranscriptFile {
	backend?: string;
	model?: string;
	device?: string;
	language?: string;
	duration?: number;
	segments?: Array<{ words?: Array<{ start: number; end: number; word: string }>; text?: string }>;
}

function readTvfWords(transcriptJson: string) {
	const t = JSON.parse(readFileSync(transcriptJson, "utf8")) as TvfTranscriptFile;
	const words: TimedWord[] = [];
	for (const segment of t.segments ?? []) {
		for (const w of segment.words ?? []) {
			const text = String(w.word ?? "").trim();
			if (!text || !(w.end > w.start)) continue;
			words.push({ text, start: round3(w.start), end: round3(w.end) });
		}
	}
	words.sort((a, b) => a.start - b.start);
	return {
		words,
		backend: String(t.backend ?? "?"),
		model: String(t.model ?? "?"),
		device: String(t.device ?? "?"),
		language: String(t.language ?? "?"),
		duration: Number(t.duration ?? 0),
	};
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The TVF work folder (one per video slug) under `workRoot` that holds a transcript. */
function findTvfTranscript(workRoot: string): string | null {
	if (!existsSync(workRoot)) return null;
	for (const slug of readdirSync(workRoot)) {
		const file = path.join(workRoot, slug, "transcript", "transcript.json");
		if (existsSync(file)) return file;
	}
	return null;
}

// ─── jobs ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TranscriptJob {
	id: string;
	key: string;
	project_id: string;
	media_id: string;
	hash: string;
	model: string;
	language: string;
	status: "running" | "done" | "error" | "interrupted";
	step: string;
	started_at: string;
	finished_at?: string;
	ms?: number;
	words?: number;
	error?: string;
}

interface JobState {
	jobs: Map<string, TranscriptJob>;
	running: Map<string, string>; // key → job id
	waiters: Map<string, Array<() => void>>;
	/** captions-v2: jobs waiting for the GPU (one transcription at a time: `transcribe {all}` starts nine at once). */
	queue?: Array<() => void>;
	active?: number;
}

/** Transcriptions run one at a time (large-v3 on a 12 GB GPU; the relisten pass loads the model again). */
const PARALLEL_JOBS = 1;

function enqueue(job: TranscriptJob, start: () => void): void {
	const state = jobState();
	state.queue ??= [];
	state.active ??= 0;
	if (state.active < PARALLEL_JOBS) {
		state.active++;
		start();
		return;
	}
	job.step = `queued: ${state.queue.length + 1} ahead (one transcription runs at a time)`;
	saveJob(job);
	state.queue.push(() => {
		job.step = "starting TVF (audio → faster-whisper)";
		saveJob(job);
		start();
	});
}

function nextInQueue(): void {
	const state = jobState();
	state.active = Math.max(0, (state.active ?? 1) - 1);
	const next = state.queue?.shift();
	if (next) {
		state.active++;
		next();
	}
}

/** Jobs live on globalThis so a dev-server hot reload of this module keeps them (and their child processes). */
function jobState(): JobState {
	const g = globalThis as unknown as { __restorffcutTranscriptJobs?: JobState };
	g.__restorffcutTranscriptJobs ??= { jobs: new Map(), running: new Map(), waiters: new Map() };
	return g.__restorffcutTranscriptJobs;
}

const jobsDir = () => path.join(transcriptsDir(), "jobs");

function saveJob(job: TranscriptJob): void {
	try {
		mkdirSync(jobsDir(), { recursive: true });
		const file = path.join(jobsDir(), `${job.id}.json`);
		writeFileSync(`${file}.part`, JSON.stringify(job, null, 1));
		renameSync(`${file}.part`, file);
	} catch {
		/* the in-memory job still answers */
	}
}

function finish(job: TranscriptJob, patch: Partial<TranscriptJob>): void {
	const state = jobState();
	Object.assign(job, patch, { finished_at: new Date().toISOString(), ms: Date.now() - Date.parse(job.started_at) });
	state.running.delete(job.key);
	saveJob(job);
	for (const wake of state.waiters.get(job.id) ?? []) wake();
	state.waiters.delete(job.id);
	nextInQueue();
}

/** A job by id: from memory, else from disk (a job that was running when the server restarted reads "interrupted"). */
export function getTranscriptJob(id: string): TranscriptJob | null {
	if (!/^tr_[A-Za-z0-9-]{6,64}$/.test(id)) return null;
	const live = jobState().jobs.get(id);
	if (live) return live;
	try {
		const job = JSON.parse(readFileSync(path.join(jobsDir(), `${id}.json`), "utf8")) as TranscriptJob;
		if (job.status === "running") return { ...job, status: "interrupted", step: "the server restarted while this ran; start it again" };
		return job;
	} catch {
		return null;
	}
}

/** Resolve when the job finishes or after `ms`, whichever is first (or when `signal` aborts). */
export function waitForJob(id: string, ms: number, signal?: AbortSignal): Promise<TranscriptJob | null> {
	const job = getTranscriptJob(id);
	if (!job || job.status !== "running" || ms <= 0) return Promise.resolve(job);
	const state = jobState();
	return new Promise((resolve) => {
		let done = false;
		const wake = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", wake);
			resolve(getTranscriptJob(id));
		};
		const timer = setTimeout(wake, ms);
		signal?.addEventListener("abort", wake, { once: true });
		const list = state.waiters.get(id) ?? [];
		list.push(wake);
		state.waiters.set(id, list);
	});
}

export interface StartResult {
	/** Cached transcript (no job started). */
	record?: TranscriptRecord;
	job?: TranscriptJob;
	joined?: boolean;
}

/**
 * Start (or join) a transcription of one media file. A cached transcript of the same bytes, model and language comes
 * back at once unless `force`. The job runs `python -m tvf transcript` in the background and writes the record.
 */
export function startTranscript(
	media: MediaFile,
	opts: { model?: string; language?: string | null; force?: boolean; relisten?: boolean } = {},
): StartResult {
	const model = opts.model ?? DEFAULT_TRANSCRIBE_MODEL;
	if (!(TRANSCRIBE_MODELS as readonly string[]).includes(model)) {
		throw new HttpError(400, `model must be one of ${TRANSCRIBE_MODELS.join(", ")} (weights on this machine)`);
	}
	const language = langKey(opts.language);
	if (language !== "auto" && !/^[a-z]{2,3}$/.test(language)) throw new HttpError(400, "language must be an ISO code like en, or omitted");
	const relisten = opts.relisten !== false;
	if (!opts.force) {
		const cached = readRecord(recordPath(media.hash, model, language));
		// a record made without the relisten pass is upgraded by a job (TVF's own stage cache makes its part instant)
		if (cached && (!relisten || cached.relisten)) return { record: cached };
	}
	const state = jobState();
	const key = `${media.hash}|${model}|${language}`;
	const runningId = state.running.get(key);
	const running = runningId ? state.jobs.get(runningId) : undefined;
	if (running && running.status === "running") return { job: running, joined: true };

	const job: TranscriptJob = {
		id: `tr_${randomUUID()}`,
		key,
		project_id: media.projectId,
		media_id: media.mediaId,
		hash: media.hash,
		model,
		language,
		status: "running",
		step: "starting TVF (audio → faster-whisper)",
		started_at: new Date().toISOString(),
	};
	state.jobs.set(job.id, job);
	state.running.set(key, job.id);
	saveJob(job);
	enqueue(job, () => runJob(job, media, opts.force === true, relisten));
	return { job };
}

/** A transcript record with the person's fixes applied (for records read straight from the cache file). */
export function withTranscriptEdits(record: TranscriptRecord): TranscriptRecord {
	if (record.edits) return record;
	const edits = readEdits(record.hash);
	if (!edits.length) return record;
	const fixed = applyTranscriptEdits(record.words, edits);
	return { ...record, words: fixed.words, text: fixed.words.map((word) => word.text).join(" "), edits: fixed.report };
}

function runJob(job: TranscriptJob, media: MediaFile, force: boolean, relisten: boolean): void {
	let source: string;
	try {
		source = sourcePath(media);
	} catch (error) {
		finish(job, { status: "error", step: "", error: `could not prepare the source: ${(error as Error).message}` });
		return;
	}
	const workRoot = path.join(hashDir(media.hash), `tvf-${job.model}`);
	mkdirSync(workRoot, { recursive: true });
	// --json is TVF's global flag: it goes before the subcommand
	const args = ["-m", "tvf", "--json", "transcript", source, "--work", workRoot, "--model", job.model];
	if (job.language !== "auto") args.push("--language", job.language);
	if (force) args.push("--force");
	let stderr = "";
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(PY, args, { cwd: TVF_DIR, env: { ...process.env, PYTHONIOENCODING: "utf-8" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		finish(job, { status: "error", step: "", error: `could not start ${PY}: ${(error as Error).message}` });
		return;
	}
	job.step = "transcribing (faster-whisper, word timestamps)";
	saveJob(job);
	const timer = setTimeout(() => {
		stderr += `\n[stopped after ${JOB_TIMEOUT_MS / 60000} min]`;
		child.kill();
	}, JOB_TIMEOUT_MS);
	child.stdout?.on("data", () => {
		/* the --json summary; the transcript itself is read from the work folder */
	});
	child.stderr?.on("data", (d: Buffer) => {
		stderr = (stderr + d.toString()).slice(-4000);
	});
	child.on("error", (error) => {
		clearTimeout(timer);
		if (job.status === "running") finish(job, { status: "error", step: "", error: `${PY}: ${error.message}` });
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		if (job.status !== "running") return;
		if (code !== 0) {
			finish(job, { status: "error", step: "", error: `tvf transcript exited ${code}: ${stderr.trim().slice(-1200)}` });
			return;
		}
		void complete();
	});

	async function complete() {
		try {
			const file = findTvfTranscript(workRoot);
			if (!file) throw new Error("TVF finished but wrote no transcript/transcript.json");
			const tvf = readTvfWords(file);
			let relistened: TranscriptRecord["relisten"] | undefined;
			if (relisten && tvf.words.length) {
				job.step = "relistening each stretch between pauses";
				saveJob(job);
				const pass = await relistenPass(media, path.join(path.dirname(path.dirname(file)), "audio", "audio16k.wav"), job, tvf.words, tvf.duration);
				relistened = pass.info;
				if (pass.merged) {
					relistened.whisper_words = tvf.words; // the first pass, kept for comparison
					tvf.words = pass.merged;
				}
			}
			const record: TranscriptRecord = {
				schema: "restorffcut-transcript@1",
				hash: media.hash,
				size: media.size,
				mime: media.mime,
				media_name: media.name,
				model: job.model,
				language_asked: job.language,
				language: tvf.language,
				backend: tvf.backend,
				device: tvf.device,
				duration: tvf.duration,
				text: tvf.words.map((word) => word.text).join(" "),
				words: tvf.words,
				created_at: new Date().toISOString(),
				ms: Date.now() - Date.parse(job.started_at),
				...(relistened ? { relisten: relistened } : {}),
			};
			const out = recordPath(media.hash, job.model, job.language);
			writeFileSync(`${out}.part`, JSON.stringify(record));
			renameSync(`${out}.part`, out);
			finish(job, { status: "done", step: "done", words: tvf.words.length });
		} catch (error) {
			finish(job, { status: "error", step: "", error: (error as Error).message });
		}
	}
}

// ─── relisten: each stretch between pauses transcribed on its own ────────────────────────────────────────────

/** Python run with cwd = TVF (so `import tvf` works); request JSON on stdin, result JSON on stdout. */
const RELISTEN_PY = [
	"import json, sys",
	"req = json.load(sys.stdin)",
	"from tvf.transcript import register_cuda_dlls, detect_device, is_cuda_runtime_error",
	"register_cuda_dlls()",
	"from faster_whisper import WhisperModel",
	"from faster_whisper.audio import decode_audio",
	"audio = decode_audio(req['wav'], sampling_rate=16000)",
	"dev, compute = detect_device()",
	"def run(dev, compute):",
	"    model = WhisperModel(req['model'], device=dev, compute_type=compute)",
	"    out = []",
	"    for s, e in req['stretches']:",
	"        a = audio[int(s * 16000):int(e * 16000)]",
	"        words = []",
	"        if len(a) >= 3200:",
	"            segs, info = model.transcribe(a, language=req.get('language'), word_timestamps=True, vad_filter=False, beam_size=5, temperature=0.0, condition_on_previous_text=False)",
	"            for seg in segs:",
	"                for w in (seg.words or []):",
	"                    words.append([w.word.strip(), round(s + w.start, 3), round(s + w.end, 3), round(float(w.probability), 3)])",
	"        out.append(words)",
	"    return out",
	"try:",
	"    out = run(dev, compute)",
	"except RuntimeError as exc:",
	"    if dev != 'cuda' or not is_cuda_runtime_error(exc):",
	"        raise",
	"    dev, compute = 'cpu', 'int8'",
	"    out = run(dev, compute)",
	"print(json.dumps({'device': dev, 'stretches': out}))",
].join("\n");

const normWord = (text: string) => text.toLowerCase().replace(/[^a-z0-9']/g, "");

async function relistenPass(
	media: MediaFile,
	wav: string,
	job: TranscriptJob,
	words: TimedWord[],
	duration: number,
): Promise<{ info: NonNullable<TranscriptRecord["relisten"]>; merged: TimedWord[] | null }> {
	const started = Date.now();
	const info = (fields: Omit<NonNullable<TranscriptRecord["relisten"]>, "ms">) => ({ ...fields, ms: Date.now() - started });
	try {
		if (!existsSync(wav)) throw new Error(`no ${wav}`);
		const silences = await detectSilences(media, { minSeconds: 0.35 });
		const end = duration > 0 ? duration : (words[words.length - 1]?.end ?? 0) + 0.5;
		// stretches = what lies between the pauses, with 0.05 s of the pause on each side for context
		const stretches: Array<[number, number]> = [];
		let cursor = 0;
		for (const s of silences) {
			if (s.start - cursor >= 0.2) stretches.push([round3(Math.max(0, cursor - 0.05)), round3(Math.min(end, s.start + 0.05))]);
			cursor = Math.max(cursor, s.end);
		}
		if (end - cursor >= 0.2) stretches.push([round3(Math.max(0, cursor - 0.05)), round3(end)]);
		if (stretches.length < 2) return { info: info({ stretches: stretches.length, replaced: 0, added_words: 0 }), merged: null };

		const request = JSON.stringify({ wav, model: job.model, language: job.language === "auto" ? null : job.language, stretches });
		const stdout = await new Promise<string>((resolve, reject) => {
			const child = spawn(PY, ["-c", RELISTEN_PY], { cwd: TVF_DIR, env: { ...process.env, PYTHONIOENCODING: "utf-8" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
			let out = "";
			let err = "";
			const timer = setTimeout(() => child.kill(), JOB_TIMEOUT_MS);
			child.stdout?.on("data", (d: Buffer) => {
				out += d.toString();
			});
			child.stderr?.on("data", (d: Buffer) => {
				err = (err + d.toString()).slice(-2000);
			});
			child.on("error", reject);
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve(out);
				else reject(new Error(`relisten exited ${code}: ${err.trim().slice(-600)}`));
			});
			child.stdin?.end(request);
		});
		const line = stdout.trim().split(/\r?\n/).pop() ?? "{}";
		const result = JSON.parse(line) as { device?: string; stretches?: Array<Array<[string, number, number, number]>> };
		const heard = result.stretches ?? [];

		// the first pass's words, clipped to the pauses so each lands in the stretch it was really said in
		const clipped = clipWordsToSilences(words, silences).words;
		const inStretch = (word: TimedWord, [s, e]: [number, number]) => {
			const middle = (word.start + word.end) / 2;
			return middle >= s && middle < e;
		};
		const merged: TimedWord[] = [];
		const used = new Set<number>();
		let replaced = 0;
		let added = 0;
		// Only the EDGES of a stretch are taken from the second pass: words heard before the stretch's first word (a
		// restart Whisper folded into that word) and after its last word (an aborted phrase before a pause). The bulk
		// keeps the first pass's spelling and punctuation (heard alone, "HyperFrames." came back as "hyper frames").
		const confident = (list: Array<{ p: number }>) => list.length > 0 && list.reduce((sum, w) => sum + w.p, 0) / list.length >= 0.5;
		stretches.forEach((stretch, i) => {
			const firstIdx = clipped.map((word, k) => (inStretch(word, stretch) && !used.has(k) ? k : -1)).filter((k) => k >= 0);
			for (const k of firstIdx) used.add(k);
			const first = firstIdx.map((k) => ({ ...words[k], start: clipped[k].start, end: clipped[k].end }));
			const again = (heard[i] ?? []).filter(([text, a, b]) => normWord(text) && b > a).map(([text, a, b, p]) => ({ text, start: a, end: b, p }));
			if (!first.length || again.length <= first.length) {
				merged.push(...firstIdx.map((k) => words[k]));
				return;
			}
			const head = normWord(first[0].text);
			const tail = normWord(first[first.length - 1].text);
			const k = again.slice(0, 10).findIndex((w) => normWord(w.text) === head);
			let m = -1;
			for (let j = again.length - 1; j >= Math.max(0, again.length - 10); j--) {
				if (normWord(again[j].text) === tail) {
					m = j;
					break;
				}
			}
			const lead = k > 0 ? again.slice(0, k) : [];
			const trail = m >= 0 && m < again.length - 1 && m >= k ? again.slice(m + 1) : [];
			const out = firstIdx.map((idx) => ({ ...words[idx] }));
			let changed = false;
			if (lead.length && confident(lead)) {
				// the first word really starts where the second pass heard it (the restart sat inside it)
				out[0] = { ...out[0], start: Math.max(clipped[firstIdx[0]].start, again[k].start) };
				out.unshift(...lead.map(({ text, start, end }) => ({ text, start, end })));
				added += lead.length;
				changed = true;
			}
			if (trail.length && confident(trail)) {
				const last = out.length - 1;
				out[last] = { ...out[last], end: Math.min(clipped[firstIdx[firstIdx.length - 1]].end, again[m].end) };
				out.push(...trail.map(({ text, start, end }) => ({ text, start, end })));
				added += trail.length;
				changed = true;
			}
			if (changed) replaced++;
			merged.push(...out);
		});
		// words the first pass put inside a pause (no stretch) stay as they were
		clipped.forEach((_, k) => {
			if (!used.has(k)) merged.push(words[k]);
		});
		merged.sort((a, b) => a.start - b.start);
		return { info: info({ stretches: stretches.length, replaced, added_words: added, device: result.device }), merged: replaced ? merged : null };
	} catch (error) {
		return { info: info({ stretches: 0, replaced: 0, added_words: 0, error: (error as Error).message }), merged: null };
	}
}

// ─── silences (copy of packages/pipeline/src/silence.ts) ─────────────────────────────────────────────────────

export interface Silence {
	start: number;
	end: number;
}

/**
 * Silent stretches of the media's first audio stream (ffmpeg silencedetect), cached per bytes + settings. Whisper
 * stretches a word across a pause and can merge two takes into one (pipeline LEARNINGS 5); clipping words to the
 * measured silences turns the hidden pause back into a gap the cutter removes.
 */
export async function detectSilences(media: MediaFile, opts: { noiseDb?: number; minSeconds?: number } = {}, signal?: AbortSignal): Promise<Silence[]> {
	const noise = opts.noiseDb ?? -40;
	const min = opts.minSeconds ?? 0.35;
	const cache = path.join(hashDir(media.hash), `silences.${noise}.${min}.json`);
	try {
		return JSON.parse(readFileSync(cache, "utf8")) as Silence[];
	} catch {
		/* not cached */
	}
	const stderr = await new Promise<string>((resolve, reject) => {
		const child = spawn(FFMPEG, ["-hide_banner", "-nostats", "-i", media.file, "-map", "0:a:0", "-af", `silencedetect=noise=${noise}dB:d=${min}`, "-f", "null", "-"], {
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let err = "";
		child.stderr?.on("data", (d: Buffer) => {
			err += d.toString();
		});
		const onAbort = () => child.kill();
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", reject);
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			if (code === 0) resolve(err);
			else if (/matches no streams|does not contain any stream/i.test(err)) resolve(""); // no audio: no silences
			else reject(new Error(`silencedetect failed (exit ${code}): ${err.slice(-400)}`));
		});
	});
	const out: Silence[] = [];
	let open: number | null = null;
	for (const line of stderr.split(/\r?\n/)) {
		const s = line.match(/silence_start:\s*(-?[\d.]+)/);
		if (s) open = Math.max(0, Number(s[1]));
		const e = line.match(/silence_end:\s*(-?[\d.]+)/);
		if (e && open !== null) {
			out.push({ start: round3(open), end: round3(Number(e[1])) });
			open = null;
		}
	}
	if (open !== null) out.push({ start: round3(open), end: 1e9 });
	try {
		mkdirSync(path.dirname(cache), { recursive: true });
		writeFileSync(cache, JSON.stringify(out));
	} catch {
		/* cache is optional */
	}
	return out;
}

/** Clip every word that overlaps a silence to its longer non-silent side; a word wholly inside a silence is kept. */
export function clipWordsToSilences(words: readonly TimedWord[], silences: readonly Silence[], minWord = 0.06): { words: TimedWord[]; clipped: number } {
	let clipped = 0;
	const result = words.map((word) => {
		let { start, end } = word;
		for (const s of silences) {
			if (s.end <= start || s.start >= end) continue;
			const before = s.start - start;
			const after = end - s.end;
			if (before < minWord && after < minWord) continue;
			if (after >= before) start = s.end;
			else end = s.start;
		}
		if (start !== word.start || end !== word.end) clipped++;
		return { ...word, start, end };
	});
	return { words: result, clipped };
}

/** For the editor (GET /api/transcripts/…): the transcript in the shape of transcription/transcript-store.ts. */
export function asEditorTranscript(record: TranscriptRecord, media: MediaFile) {
	return {
		mediaId: media.mediaId,
		mediaName: media.name ?? media.mediaId,
		// transcript-store's fingerprint is `${asset.name}:${asset.file.size}`
		fingerprint: `${media.name ?? media.mediaId}:${media.size}`,
		modelId: `tvf-faster-whisper-${record.model}`,
		language: record.language,
		text: record.text,
		words: record.words,
		wordTimings: "exact" as const,
		createdAt: record.created_at,
		source: "server" as const,
	};
}

/** Disk used by one media file's transcript cache (for the worklog's cost notes). */
export function cacheBytes(hash: string): number {
	let total = 0;
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const p = path.join(dir, name);
			const info = statSync(p);
			if (info.isDirectory()) walk(p);
			else if (!name.startsWith("source.")) total += info.size;
		}
	};
	try {
		walk(hashDir(hash));
	} catch {
		/* none */
	}
	return total;
}
