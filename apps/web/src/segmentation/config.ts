/**
 * Person segmentation — every path, URL and tunable in one place.
 *
 * Runbook: docs/restorff/worklog/cutout.md. Licences (checked 2026-10-20):
 * - `@mediapipe/tasks-vision` 0.10.35 — Apache-2.0 (package.json). Pinned EXACTLY: 1.x sends usage metrics to
 *   Google (odml.pa.googleapis.com) and needs user consent; 0.10.35 has no network endpoint in its bundle.
 * - Both models below — Apache-2.0 per their Google model cards (Selfie Segmentation 2021-05-06, Multiclass Selfie
 *   Segmentation 2023-05-10). Never swap in a non-commercial model (RMBG etc.).
 */

/** Keep equal to the exact version in apps/web/package.json. */
export const MEDIAPIPE_TASKS_VISION_VERSION = "0.10.35";

export type SegmentationModelId = "multiclass" | "selfie";

export interface SegmentationModelInfo {
	id: SegmentationModelId;
	label: string;
	/** Default download URL (Google's model bucket, CORS-enabled). Override with the env var below. */
	url: string;
	envVar: string;
	licence: string;
	modelCard: string;
	/** What the model can tell us beyond the person matte. */
	hasFaceClass: boolean;
	note: string;
}

export const SEGMENTATION_MODELS: Record<SegmentationModelId, SegmentationModelInfo> = {
	multiclass: {
		id: "multiclass",
		label: "Quality (multiclass, face-aware)",
		url: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
		envVar: "NEXT_PUBLIC_RESTORFF_SEGMENTER_MULTICLASS_URL",
		licence: "Apache-2.0",
		modelCard:
			"https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf",
		hasFaceClass: true,
		note: "Classes background, hair, body-skin, face-skin, clothes, others. Gives a real face box.",
	},
	selfie: {
		id: "selfie",
		label: "Fast (selfie, 249 KB)",
		url: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
		envVar: "NEXT_PUBLIC_RESTORFF_SEGMENTER_SELFIE_URL",
		licence: "Apache-2.0",
		modelCard:
			"https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf",
		hasFaceClass: false,
		note: "Person / background only; the head box is estimated from the top of the person mask.",
	},
};

export const DEFAULT_SEGMENTATION_MODEL: SegmentationModelId = "multiclass";

/**
 * Where the MediaPipe wasm runtime is loaded from. Default: jsDelivr at the pinned version. Self-host: copy
 * `node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.{js,wasm}` (and `vision_wasm_nosimd_internal.*` for
 * browsers without wasm SIMD) to e.g. `apps/web/public/mediapipe/` and set NEXT_PUBLIC_RESTORFF_MEDIAPIPE_WASM=/mediapipe.
 * (The worker loads the CLASSIC loader files, not the `_module_` ones — see segmentation/worker.ts.)
 */
export function getMediapipeWasmBase(): string {
	const fromEnv = process.env.NEXT_PUBLIC_RESTORFF_MEDIAPIPE_WASM;
	if (fromEnv && fromEnv.trim()) return absolutise(fromEnv.trim().replace(/\/$/, ""));
	return `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_TASKS_VISION_VERSION}/wasm`;
}

export function getSegmentationModelUrl(id: SegmentationModelId): string {
	const env: Record<SegmentationModelId, string | undefined> = {
		multiclass: process.env.NEXT_PUBLIC_RESTORFF_SEGMENTER_MULTICLASS_URL,
		selfie: process.env.NEXT_PUBLIC_RESTORFF_SEGMENTER_SELFIE_URL,
	};
	const fromEnv = env[id];
	if (fromEnv && fromEnv.trim()) return absolutise(fromEnv.trim());
	return SEGMENTATION_MODELS[id].url;
}

/** Relative paths are resolved against the page origin (the worker has a different base URL). */
function absolutise(url: string): string {
	if (/^https?:\/\//i.test(url)) return url;
	if (typeof window === "undefined") return url;
	return new URL(url, window.location.origin).toString();
}

/** Analysis rate for mattes; frames in between are interpolated. */
export const MATTE_ANALYSIS_FPS = 15;
/** Analysis rate when only subject boxes are needed (auto-reframe). */
export const BOX_ANALYSIS_FPS = 2;
/** Long side of the frames handed to the model (the models work at 256 x 256 internally). */
export const ANALYSIS_LONG_SIDE = 256;
/** Upper bound on analysed frames per clip; the rate is lowered for very long clips to stay under it. */
export const MAX_ANALYSIS_FRAMES = 3600;
/** OPFS directory for cached mattes (one file per media + range + model + rate). */
export const MATTE_CACHE_DIRECTORY = "restorff-mattes";
/** Mattes kept in memory (most recent first). */
export const MATTE_MEMORY_CACHE_SIZE = 6;
