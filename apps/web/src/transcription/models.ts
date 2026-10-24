import type {
	TranscriptionModel,
	TranscriptionModelId,
} from "./types";

export const TRANSCRIPTION_MODELS: TranscriptionModel[] = [
	{
		// exported with cross-attentions, so `return_timestamps: "word"` gives real word timings (ASSUMPTION: model id
		// from the transformers.js word-timestamps demo; if it fails to load, the talking-head flow falls back to Small)
		id: "whisper-base-timestamped",
		name: "Base · word timings",
		huggingFaceId: "onnx-community/whisper-base_timestamped",
		description: "Word-level timings for cuts and captions",
	},
	{
		id: "whisper-tiny",
		name: "Tiny",
		huggingFaceId: "onnx-community/whisper-tiny",
		description: "Fastest, lower accuracy",
	},
	{
		id: "whisper-small",
		name: "Small",
		huggingFaceId: "onnx-community/whisper-small",
		description: "Good balance of speed and accuracy",
	},
	{
		id: "whisper-medium",
		name: "Medium",
		huggingFaceId: "onnx-community/whisper-medium",
		description: "Higher accuracy, slower",
	},
	{
		id: "whisper-large-v3-turbo",
		name: "Large v3 Turbo",
		huggingFaceId: "onnx-community/whisper-large-v3-turbo",
		description: "Best accuracy, requires WebGPU for good performance",
	},
];

export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModelId =
	"whisper-small";

/** Default for the talking-head flow (transcript → cut → captions): word timings matter most there. */
export const WORD_TIMING_MODEL: TranscriptionModelId = "whisper-base-timestamped";
/** Used when the word-timing model can't load. */
export const WORD_TIMING_FALLBACK_MODEL: TranscriptionModelId = DEFAULT_TRANSCRIPTION_MODEL;
