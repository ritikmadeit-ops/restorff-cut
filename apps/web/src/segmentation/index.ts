/**
 * Person segmentation in the browser (MediaPipe image segmenter, Apache-2.0, in a Web Worker).
 * Runbook + decisions: docs/restorff/worklog/cutout.md.
 */
export * from "./config";
export * from "./types";
export { segmentationClient } from "./client";
export { getMatte, findCachedMatte, clearMatteCache, effectiveAnalysisFps } from "./cache";
export {
	sampleMatteRgba,
	boxesAt,
	medianBox,
	subjectSeries,
	DEFAULT_EDGE,
	type EdgeShape,
	type SubjectSample,
} from "./matte";
export { boxCenter, unionBox } from "./boxes";
