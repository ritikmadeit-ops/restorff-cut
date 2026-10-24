import type { LanguageCode } from "./languages";

export type TranscriptionLanguage = LanguageCode | "auto";

export interface TranscriptionSegment {
	text: string;
	start: number;
	end: number;
}

/** One word with its time in the transcribed audio (seconds). */
export interface TranscriptionWord {
	text: string;
	start: number;
	end: number;
}

/**
 * "exact" = the model's word-level timestamps (cross-attention alignment); "approximate" = segment timings split
 * across the words by letter count (the model could not give word timings).
 */
export type WordTimingQuality = "exact" | "approximate";

export interface TranscriptionResult {
	text: string;
	segments: TranscriptionSegment[];
	language: string;
	/** Word-level timings, when asked for (`words: true`). */
	words?: TranscriptionWord[];
	wordTimings?: WordTimingQuality;
}

export type TranscriptionStatus =
	| "idle"
	| "loading-model"
	| "transcribing"
	| "complete"
	| "error";

export interface TranscriptionProgress {
	status: TranscriptionStatus;
	progress: number;
	message?: string;
}

export type TranscriptionModelId =
	| "whisper-base-timestamped"
	| "whisper-tiny"
	| "whisper-small"
	| "whisper-medium"
	| "whisper-large-v3-turbo";

export interface TranscriptionModel {
	id: TranscriptionModelId;
	name: string;
	huggingFaceId: string;
	description: string;
}

export interface CaptionChunk {
	text: string;
	startTime: number;
	duration: number;
}
