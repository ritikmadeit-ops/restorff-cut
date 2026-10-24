/**
 * @restorffcut/styles — saved styles from repeated instructions (EDT-20) and the explainer-from-references style card
 * + Paper collage plan (EDT-21). Pure TypeScript over @restorffcut/timeline-ops: every output is ops@1.
 * Runbook: ../README.md. UI: apps/web/src/styles-lab/. Worklog: docs/restorff/worklog/styles.md.
 */
export {
	bumpVersion,
	deleteStyle,
	dismissPattern,
	emptyLibrary,
	exportLibrary,
	importLibrary,
	listStyles,
	restoreVersion,
	saveStyle,
	slugify,
	validateStylePreset,
	STYLE_LIBRARY_FORMAT,
	USER_STYLE_PREFIX,
} from "./preset.ts";
// ui-fix-panels, 2026-10-21 (QA #8): caption sizes as ratios, the safe-area cap, migrating absolute sizes
export {
	CAPTION_SCALE_PARAM,
	CAPTION_SCALE_SPEC,
	LEGACY_CAPTION_SIZE_PARAM,
	estimateTextWidth,
	fitCaptionSize,
	migrateLibrary,
	migrateSavedStyle,
	projectCaptionSize,
	resolveCaptionSizeFlag,
	trackCaptionSize,
	wordingScale,
} from "./caption-size.ts";
export type { CaptionSizeFit, MigrateResult } from "./caption-size.ts";
export type {
	ImportResult,
	ParamRef,
	SavedStyle,
	SaveOptions,
	StyleFlag,
	StyleLibrary,
	StyleOrigin,
	StyleParamSpec,
	StyleStep,
	TargetSelector,
} from "./preset.ts";
export {
	applyStyle,
	batchSignature,
	clauseKey,
	detectRepeats,
	draftStyle,
	instructionKey,
	matchTrigger,
	opShape,
	planStyle,
	styleExpanders,
} from "./repeats.ts";
export type { ApplyStyleContext, DetectOptions, DraftSource, InstructionRecord, RepeatPattern, RepeatSuggestion, StylePlan } from "./repeats.ts";
export {
	frameDifference,
	grainBands,
	grainOf,
	hexToRgb,
	histogram,
	histogramDistance,
	kmeans,
	luma,
	paletteCoverage,
	paletteFromFrames,
	prng,
	recoverSaturated,
	rgbToHsl,
	samplePixels,
	toHex,
} from "./palette.ts";
export type { PaletteColor, PixelFrame, Rgb } from "./palette.ts";
export { cuesFromNames, GRAIN_HEAVY, GRAIN_TEXTURED, sceneChangesFromFrames, styleCardFromReferences } from "./card.ts";
// explainer-v2 (2026-10-20): beats as {line, picture, tag}, feel → pacing, the v2 Paper collage plan
export { beatLengths, bindBeats, FEEL_PACE, READ_WPS, readingSeconds, scriptOf, sentencesOf, stem, subjectsOf, TAG_MAX, words } from "./beats.ts";
export type { BeatInput, BeatTiming, BoundBeat, ExplainerAnswersV2, Feel, PictureAsset, PictureMatch, ScriptBeat } from "./beats.ts";
export { collageColorsV2, explainerPlanV2, KIT_PIECES, paperKindOf, resolveStills, scrapSvg, STILL_PREFIX } from "./explainer-v2.ts";
export type { ExplainerPlanV2, ShotKind, ShotPlan } from "./explainer-v2.ts";
export type { CardQuestion, ReferenceInput, StyleCard } from "./card.ts";
export {
	bindCompositions,
	collageColors,
	colorName,
	describePlan,
	explainerPlan,
	COLLAGE_COMPOSITIONS,
	COMPOSITION_PLACEHOLDER_PREFIX,
	FORMATS,
	PAPER_COLLAGE_STYLE_ID,
} from "./explainer.ts";
export type {
	BoundComposition,
	CompositionRequest,
	ExplainerAnswers,
	ExplainerAsset,
	ExplainerBeat,
	ExplainerOptions,
	ExplainerPlan,
} from "./explainer.ts";
