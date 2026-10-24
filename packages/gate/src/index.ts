/**
 * @restorffcut/gate — RestorffCut's export gate (docs/restorff/EXPORT-GATE.md).
 * Runbook: ../README.md. Pure functions only; the ffmpeg runner lives in apps/web/src/gate/server.
 */
export {
	runTimelineChecks,
	TIMELINE_CHECKS,
	GATE_SOURCE,
	SAFE_AREA_1080x1920,
	safeArea,
	textBox,
	estimateTextRect,
	withBackground,
	parseDeliver,
	briefDeliver,
	laneOf,
	fitOps,
} from "./timeline.ts";
export {
	PIECE_TYPES,
	PROFILES,
	decidePiece,
	inferPiece,
	normalizePiece,
	isPieceType,
	safeZoneFor,
	aspectName,
	nearestStandard,
	STANDARD_SIZES,
} from "./piece.ts";
export type { PieceProfile, RhythmBars, RuleMode, SafeZone, PieceSignals } from "./piece.ts";
export { changeMap, baseRuns, covers, continues } from "./changes.ts";
export type { Change, ChangeKind, ChangeMap, PictureShot, BaseRun } from "./changes.ts";
export { compositionFacts, manifestFromSource, storedComposition, localToTimeline, alphaBox, alphaCoverage } from "./compositions.ts";
export type { ManifestLike, StoredComposition } from "./compositions.ts";
export { faceOnCanvas, boxCoverage } from "./face.ts";
export { detectFlashes, filterDesignedFlashes } from "./flash.ts";
export {
	FILE_CHECKS,
	LOUD_TARGET,
	fileFindings,
	loudnessGain,
	parseBlackdetect,
	parseEbur128,
	parseFfprobe,
	parseFreezedetect,
} from "./file.ts";
export {
	MIN_REASON_CHARS,
	NEVER_OVERRIDE,
	OverrideError,
	applyOverrides,
	buildReport,
	fixedSince,
	isBlocking,
	mergeFindings,
	overrideMatches,
	pinFindings,
	sortFindings,
	toSchemaFinding,
	validateOverride,
} from "./gate.ts";
export {
	RETENTION_BARS,
	RETENTION_CHECKS,
	RETENTION_DETECTOR,
	RETENTION_MEASURER,
	audioOnsets,
	cutsOnHit,
	eventWindows,
	eventsPer10s,
	retentionFindings,
	retentionMap,
	stretchesOf,
	visualEvents,
} from "./retention.ts";
export type { RetentionMap, RetentionRuleOptions, RetentionStretch, RetentionWindow } from "./retention.ts";
export { TICKS_PER_SECOND, formatTime, fpsOf, pickScene, runtimeOf, shotMap, ticksToSeconds } from "./project.ts";
export type * from "./types.ts";
