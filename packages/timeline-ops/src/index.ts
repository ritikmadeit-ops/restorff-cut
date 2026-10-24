/**
 * @restorffcut/timeline-ops — ops@1 and the pure reducer over RestorffCut's project JSON.
 * Runbook: ../README.md. The project shape: ../MODEL.md. Op ↔ editor command parity: ../PARITY.md.
 */
export { apply, opTimeToTicks } from "./reducer.ts";
export type {
	ApplyChanges,
	ApplyOptions,
	ApplyResult,
	Conflict,
	ConflictKind,
	OpChange,
	OpStatus,
	UnsupportedRecord,
} from "./reducer.ts";
export { validateOp, validateOps, assertOps } from "./validate.ts";
export type { ValidationError, ValidationResult } from "./validate.ts";
// mcp-discover, 2026-10-20: per-op rules for the MCP op reference (apps/web/src/mcp/ops-reference.ts)
export { opFieldRules } from "./validate.ts";
export type { OpFieldRules } from "./validate.ts";
export { OP_NAMES, OPS_VERSION, AUTHORS } from "./ops.ts";
export type * from "./ops.ts";
// media agent, 2026-10-20: transition kinds the editor renders (project v32 transitionIn)
export { CUT_KINDS, normalizeTransitionKind, resolveTransitionKind, TRANSITION_KINDS } from "./transitions.ts";
// grade agent, 2026-10-20: the colour grade (looks, nudges, params, shader uniforms) — one place for reducer and app
export {
	applyGradeNudge,
	clampGradeParams,
	CUSTOM_LOOK,
	getGradeLook,
	GRADE_EFFECT_TYPE,
	GRADE_LOOKS,
	GRADE_NUDGES,
	GRADE_PARAM_KEYS,
	GRADE_PARAM_SPECS,
	GRADE_SHADER_ID,
	GRADE_TRACK_NAME,
	gradeEffectParams,
	gradeLabel,
	gradeParamProblems,
	gradeUniforms,
	gradeVocabulary,
	isNeutralGrade,
	lookParams,
	matchLook,
	NEUTRAL_GRADE,
	NO_GRADE,
	normalizeGradeName,
	readGradeParams,
	resolveGradeName,
} from "./grades.ts";
export type { GradeLook, GradeNudge, GradeParamGroup, GradeParamKey, GradeParams, GradeParamSpec, GradeUniformValue, ResolvedGrade } from "./grades.ts";
export type * from "./model.ts";
export { EDITOR_PROJECT_VERSION } from "./model.ts";
export {
	TICKS_PER_SECOND,
	secondsToTicks,
	ticksToSeconds,
	ticksPerFrame,
	roundTicksToFrame,
	floatToFrameRate,
} from "./time.ts";
export {
	chunkWords,
	chunkWordGroups,
	buildCaptionOps,
	scaleSafeArea,
	getCaptionStyle,
	editChunkText,
	mergeChunkWithNext,
	splitChunk,
	nudgeChunk,
	nudgeChunkEdge,
	removeChunk,
	CAPTION_SAFE_AREA,
	CAPTION_STYLE_PRESETS,
	CAPTION_TRACK_NAMES,
	DEFAULT_CAPTION_STYLE_ID,
	// captions-v2, 2026-10-20: per-chunk looks, the key-word style, ≤ 5 words, caption lanes
	MAX_CAPTION_WORDS,
	captionLaneName,
	captionWordText,
	pickKeyWords,
	resolveCaptionLook,
	lookAfterRestyle,
} from "./captions.ts";
export type {
	CaptionBuild,
	CaptionBuildInput,
	CaptionCase,
	CaptionChunk,
	CaptionChunkLayout,
	CaptionDocChunk,
	CaptionFont,
	CaptionHighlight,
	CaptionLook,
	CaptionStylePreset,
	CaptionTextOverride,
	ChunkOptions,
	MeasureText,
	SafeArea,
} from "./captions.ts";
export { checkInvariants } from "./scene.ts";
export {
	BUILTIN_STYLES,
	EDITING_STYLE_PRESETS,
	MOTION_TRACK_NAME,
	STYLE_PRESET_PREFIX,
	expandEditingStyle,
	getEditingStylePreset,
} from "./styles.ts";
export type {
	EditingStylePreset,
	StyleComposition,
	StyleCompositionMedia,
	StyleContext,
	StyleExpander,
	StylePacing,
} from "./styles.ts";
export { deterministicUuid } from "./ids.ts";
export { resolveSentence, splitClauses, tightenCut, captionTracks } from "./intents.ts"; // bridge agent: sentence → ops
export type { ClausePlan, IntentContext, IntentKind, IntentPlan, TightenOptions, TightenPlan } from "./intents.ts";
export { cutFromTranscript } from "./compilers/talking-head.ts";
// sounds agent, 2026-10-20: "Design the sound" planner (pure; library passed in)
export {
	designSound,
	isCaptionTrack,
	isMusicTrack,
	isSfxTrack,
	markDesign,
	previousDesign,
	SOUND_DESIGN_VERSION,
	summarize as summarizeSoundDesign,
	withoutPreviousDesign,
} from "./sound-design.ts";
export type { DesignKind, DroppedSfx, PlannedSfx, SfxLibraryEntry, SoundDesignOptions, SoundDesignPlan } from "./sound-design.ts";
export type { CutCandidate, CutOptions, CutPlan, RemovedRegion, TalkingHeadClip } from "./compilers/talking-head.ts";
export { classifyEffect, compileStoryboard, normToken, SKELETON_TRACKS, STORYBOARD_COMPILER_VERSION, type CameraMove, type StoryboardAsset, type StoryboardAssetKind, type StoryboardAssetWord, type StoryboardBeat, type StoryboardBeatPlacement, type StoryboardCompileOptions, type StoryboardCompileReport, type StoryboardCompileResult, type StoryboardSpec, type StoryboardTracks } from "./compilers/storyboard.ts"; // compiler agent, 2026-10-20: EDT-03 storyboard → v0
export { parseWords, specFromBoard, specFromBrief, type BoardSpecOptions, type BriefSpecOptions, type ParsedLine } from "./compilers/from-board.ts"; // compiler agent, 2026-10-20: Zeigarnik board / brief → spec
