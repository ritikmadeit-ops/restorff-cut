import { create } from "zustand";
import type { MediaAsset } from "@/media/types";
import { transcriptionService } from "@/services/transcription/service";
import { decodeMediaAudioForTranscription } from "./media-audio";
import { WORD_TIMING_FALLBACK_MODEL, WORD_TIMING_MODEL } from "./models";
import type {
	TranscriptionLanguage,
	TranscriptionModelId,
	TranscriptionProgress,
	TranscriptionWord,
	WordTimingQuality,
} from "./types";

/**
 * Transcripts per media file (word timings in SOURCE seconds), cached in memory and in localStorage so a reload or a
 * second clip of the same file never transcribes twice. Key: media id; the fingerprint (name + size) catches a
 * different file reusing an id. Runbook: docs/restorff/worklog/captions.md.
 */
export interface MediaTranscript {
	mediaId: string;
	mediaName: string;
	fingerprint: string;
	modelId: TranscriptionModelId;
	language: string;
	text: string;
	words: TranscriptionWord[];
	wordTimings: WordTimingQuality;
	createdAt: string;
}

export interface TranscriptJob {
	status: "working" | "error";
	step: string;
	error?: string;
}

interface TranscriptState {
	transcripts: Record<string, MediaTranscript>;
	jobs: Record<string, TranscriptJob>;
}

const STORAGE_KEY = "restorffcut.transcripts.v1";
/** Keep the cache small: at most this many transcripts in localStorage (oldest dropped first). */
const MAX_STORED = 40;

function loadStored(): Record<string, MediaTranscript> {
	try {
		if (typeof localStorage === "undefined") return {};
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? (JSON.parse(raw) as Record<string, MediaTranscript>) : {};
	} catch {
		return {};
	}
}

function saveStored(transcripts: Record<string, MediaTranscript>) {
	try {
		const list = Object.values(transcripts)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, MAX_STORED);
		localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(list.map((t) => [t.mediaId, t]))));
	} catch {
		// storage full or blocked: the in-memory cache still works for this session
	}
}

export const useTranscriptStore = create<TranscriptState>(() => ({
	transcripts: typeof window === "undefined" ? {} : loadStored(),
	jobs: {},
}));

export function fingerprintOf(asset: MediaAsset): string {
	return `${asset.name}:${asset.file?.size ?? 0}`;
}

export function getTranscript(asset: MediaAsset): MediaTranscript | null {
	const found = useTranscriptStore.getState().transcripts[asset.id];
	return found && found.fingerprint === fingerprintOf(asset) ? found : null;
}

export function getTranscriptById(mediaId: string): MediaTranscript | null {
	return useTranscriptStore.getState().transcripts[mediaId] ?? null;
}

function setJob(mediaId: string, job: TranscriptJob | null) {
	useTranscriptStore.setState((state) => {
		const jobs = { ...state.jobs };
		if (job) jobs[mediaId] = job;
		else delete jobs[mediaId];
		return { jobs };
	});
}

export function forgetTranscript(mediaId: string) {
	useTranscriptStore.setState((state) => {
		const transcripts = { ...state.transcripts };
		delete transcripts[mediaId];
		saveStored(transcripts);
		return { transcripts };
	});
}

/** Replace a transcript's words (the transcript editor: fix a misheard word before cutting / captioning). */
export function updateTranscriptWords(mediaId: string, words: TranscriptionWord[]) {
	useTranscriptStore.setState((state) => {
		const current = state.transcripts[mediaId];
		if (!current) return state;
		const transcripts = {
			...state.transcripts,
			[mediaId]: { ...current, words, text: words.map((word) => word.text).join(" ") },
		};
		saveStored(transcripts);
		return { transcripts };
	});
}

const inflight = new Map<string, Promise<MediaTranscript>>();

/** Transcribe one media file (cached). Word-level timings when the model can, approximate otherwise. */
export function transcribeMedia({
	asset,
	modelId = WORD_TIMING_MODEL,
	language = "auto",
	force = false,
}: {
	asset: MediaAsset;
	modelId?: TranscriptionModelId;
	language?: TranscriptionLanguage;
	force?: boolean;
}): Promise<MediaTranscript> {
	if (!force) {
		const cached = getTranscript(asset);
		if (cached) return Promise.resolve(cached);
	}
	const running = inflight.get(asset.id);
	if (running) return running;

	const job = (async () => {
		try {
			setJob(asset.id, { status: "working", step: "Reading audio…" });
			const samples = await decodeMediaAudioForTranscription({ asset });
			const onProgress = (progress: TranscriptionProgress) => {
				setJob(asset.id, {
					status: "working",
					step:
						progress.status === "loading-model"
							? `Loading model ${Math.round(progress.progress)}%`
							: "Transcribing…",
				});
			};
			let usedModel = modelId;
			let result: Awaited<ReturnType<typeof transcriptionService.transcribe>>;
			try {
				result = await transcriptionService.transcribe({
					audioData: samples,
					language,
					modelId,
					onProgress,
					words: true,
				});
			} catch (error) {
				// the word-timing model may not load (network, missing export): fall back once to the default model
				if (modelId !== WORD_TIMING_MODEL) throw error;
				console.warn(`${modelId} failed, falling back to ${WORD_TIMING_FALLBACK_MODEL}:`, error);
				usedModel = WORD_TIMING_FALLBACK_MODEL;
				result = await transcriptionService.transcribe({
					audioData: samples,
					language,
					modelId: usedModel,
					onProgress,
					words: true,
				});
			}
			const transcript: MediaTranscript = {
				mediaId: asset.id,
				mediaName: asset.name,
				fingerprint: fingerprintOf(asset),
				modelId: usedModel,
				language: result.language ?? language,
				text: result.text,
				words: result.words ?? [],
				wordTimings: result.wordTimings ?? "approximate",
				createdAt: new Date().toISOString(),
			};
			useTranscriptStore.setState((state) => {
				const transcripts = { ...state.transcripts, [asset.id]: transcript };
				saveStored(transcripts);
				return { transcripts };
			});
			setJob(asset.id, null);
			return transcript;
		} catch (error) {
			setJob(asset.id, {
				status: "error",
				step: "",
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		} finally {
			inflight.delete(asset.id);
		}
	})();
	inflight.set(asset.id, job);
	return job;
}
