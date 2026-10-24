import {
	pipeline,
	type AutomaticSpeechRecognitionPipeline,
	type AutomaticSpeechRecognitionOutput,
} from "@huggingface/transformers";
import type {
	TranscriptionSegment,
	TranscriptionWord,
	WordTimingQuality,
} from "@/transcription/types";
import {
	DEFAULT_CHUNK_LENGTH_SECONDS,
	DEFAULT_STRIDE_SECONDS,
} from "@/transcription/audio";
import { normalizeWords, splitSegmentsIntoWords } from "@/transcription/words";

export type WorkerMessage =
	| { type: "init"; modelId: string }
	| { type: "transcribe"; audio: Float32Array; language: string; words?: boolean }
	| { type: "cancel" };

export type WorkerResponse =
	| { type: "init-progress"; progress: number }
	| { type: "init-complete" }
	| { type: "init-error"; error: string }
	| { type: "transcribe-progress"; progress: number }
	| {
			type: "transcribe-complete";
			text: string;
			segments: TranscriptionSegment[];
			words?: TranscriptionWord[];
			wordTimings?: WordTimingQuality;
	  }
	| { type: "transcribe-error"; error: string }
	| { type: "cancelled" };

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let cancelled = false;
let lastReportedProgress = -1;
const fileBytes = new Map<string, { loaded: number; total: number }>();

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data;

	switch (message.type) {
		case "init":
			await handleInit({ modelId: message.modelId });
			break;
		case "transcribe":
			await handleTranscribe({
				audio: message.audio,
				language: message.language,
				words: message.words ?? false,
			});
			break;
		case "cancel":
			cancelled = true;
			self.postMessage({ type: "cancelled" } satisfies WorkerResponse);
			break;
	}
};

async function handleInit({ modelId }: { modelId: string }) {
	lastReportedProgress = -1;
	fileBytes.clear();

	try {
		transcriber = (await pipeline("automatic-speech-recognition", modelId, {
			dtype: "q4",
			device: "auto",
			progress_callback: (progressInfo: {
				status?: string;
				file?: string;
				loaded?: number;
				total?: number;
			}) => {
				const file = progressInfo.file;
				if (!file) return;

				const loaded = progressInfo.loaded ?? 0;
				const total = progressInfo.total ?? 0;

				if (progressInfo.status === "progress" && total > 0) {
					fileBytes.set(file, { loaded, total });
				} else if (progressInfo.status === "done") {
					const existing = fileBytes.get(file);
					if (existing) {
						fileBytes.set(file, {
							loaded: existing.total,
							total: existing.total,
						});
					}
				}

				// sum all bytes
				let totalLoaded = 0;
				let totalSize = 0;
				for (const { loaded, total } of fileBytes.values()) {
					totalLoaded += loaded;
					totalSize += total;
				}

				if (totalSize === 0) return;

				const overallProgress = (totalLoaded / totalSize) * 100;
				const roundedProgress = Math.floor(overallProgress);

				if (roundedProgress !== lastReportedProgress) {
					lastReportedProgress = roundedProgress;
					self.postMessage({
						type: "init-progress",
						progress: roundedProgress,
					} satisfies WorkerResponse);
				}
			},
		})) as unknown as AutomaticSpeechRecognitionPipeline;

		self.postMessage({ type: "init-complete" } satisfies WorkerResponse);
	} catch (error) {
		self.postMessage({
			type: "init-error",
			error: error instanceof Error ? error.message : "Failed to load model",
		} satisfies WorkerResponse);
	}
}

type Chunks = NonNullable<AutomaticSpeechRecognitionOutput["chunks"]>;

function chunksToTimed(chunks: Chunks | undefined): TranscriptionSegment[] {
	const timed: TranscriptionSegment[] = [];
	for (const chunk of chunks ?? []) {
		if (chunk.timestamp && chunk.timestamp.length >= 2) {
			const start = chunk.timestamp[0] ?? 0;
			timed.push({
				text: chunk.text,
				start,
				end: chunk.timestamp[1] ?? start,
			});
		}
	}
	return timed;
}

async function run({
	audio,
	language,
	timestamps,
}: {
	audio: Float32Array;
	language: string;
	timestamps: true | "word";
}): Promise<AutomaticSpeechRecognitionOutput> {
	if (!transcriber) throw new Error("Model not initialized");
	const rawResult = await transcriber(audio, {
		chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
		stride_length_s: DEFAULT_STRIDE_SECONDS,
		language: language === "auto" ? undefined : language,
		return_timestamps: timestamps,
	});
	return Array.isArray(rawResult) ? rawResult[0] : rawResult;
}

/** Sentence-ish segments rebuilt from words (for callers that read `segments`). */
function segmentsFromWords(words: TranscriptionWord[]): TranscriptionSegment[] {
	const segments: TranscriptionSegment[] = [];
	let current: TranscriptionWord[] = [];
	const flush = () => {
		if (!current.length) return;
		segments.push({
			text: current.map((word) => word.text).join(" "),
			start: current[0].start,
			end: current[current.length - 1].end,
		});
		current = [];
	};
	words.forEach((word, index) => {
		const previous = words[index - 1];
		if (previous && word.start - previous.end > 0.8) flush();
		current.push(word);
		if (/[.!?]$/.test(word.text)) flush();
	});
	flush();
	return segments;
}

async function handleTranscribe({
	audio,
	language,
	words,
}: {
	audio: Float32Array;
	language: string;
	words: boolean;
}) {
	if (!transcriber) {
		self.postMessage({
			type: "transcribe-error",
			error: "Model not initialized",
		} satisfies WorkerResponse);
		return;
	}

	cancelled = false;

	try {
		if (words) {
			// Word-level timestamps need a model exported with cross-attentions; if this one can't, fall back to
			// segment timings split across the words (marked approximate).
			try {
				const result = await run({ audio, language, timestamps: "word" });
				if (cancelled) return;
				const exact = normalizeWords({ words: chunksToTimed(result.chunks) });
				if (exact.length) {
					self.postMessage({
						type: "transcribe-complete",
						text: result.text,
						segments: segmentsFromWords(exact),
						words: exact,
						wordTimings: "exact",
					} satisfies WorkerResponse);
					return;
				}
			} catch (error) {
				if (cancelled) return;
				console.warn("word timestamps unavailable, using segment timings:", error);
			}
		}

		const result = await run({ audio, language, timestamps: true });
		if (cancelled) return;
		const segments = chunksToTimed(result.chunks);

		self.postMessage({
			type: "transcribe-complete",
			text: result.text,
			segments,
			...(words
				? {
						words: normalizeWords({ words: splitSegmentsIntoWords({ segments }) }),
						wordTimings: "approximate" as const,
					}
				: {}),
		} satisfies WorkerResponse);
	} catch (error) {
		if (cancelled) return;
		self.postMessage({
			type: "transcribe-error",
			error: error instanceof Error ? error.message : "Transcription failed",
		} satisfies WorkerResponse);
	}
}
