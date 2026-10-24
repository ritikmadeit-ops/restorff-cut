/**
 * Where a clip's grade comes from (grade agent, 2026-10-20). A clip is graded by its own `restorff-grade` effect
 * (ops@1 `grade {target: <clip>}`) and/or by the timeline's GRADE adjustment layer (`grade {target: "all"}`), an
 * effect element on an effect track that covers the clip's time and sits above the clip's track (effect layers
 * apply to everything rendered below them). Pure: no editor, no React — unit-tested in __tests__/target.test.ts.
 */
import { GRADE_EFFECT_TYPE, gradeLabel } from "@restorffcut/timeline-ops";
import type { Effect } from "@/effects/types";
import type { EffectElement, SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";

export type GradeScope = "clip" | "timeline";

export interface GradeSource {
	scope: GradeScope;
	/** The element whose params hold the grade: the clip (its effect) or the GRADE layer's effect element. */
	trackId: string;
	elementId: string;
	/** The grade effect on the clip (scope "clip" only). */
	effectId?: string;
	params: Record<string, unknown>;
	label: string;
}

type WithEffects = TimelineElement & { effects?: Effect[] };

export function clipGradeEffect(element: TimelineElement): Effect | undefined {
	return (element as WithEffects).effects?.find((effect) => effect.type === GRADE_EFFECT_TYPE && effect.enabled !== false);
}

export function isGradeLayer(element: TimelineElement): element is EffectElement {
	return element.type === "effect" && (element as EffectElement).effectType === GRADE_EFFECT_TYPE;
}

/** Overlay tracks top → bottom, then main: the index a track is drawn at (lower = on top). */
function stackIndex(tracks: SceneTracks, trackId: string): number {
	const index = tracks.overlay.findIndex((track) => track.id === trackId);
	if (index >= 0) return index;
	return tracks.main.id === trackId ? tracks.overlay.length : Number.POSITIVE_INFINITY;
}

/** The clip's own grade, if any. */
export function clipGrade(element: TimelineElement, track: TimelineTrack): GradeSource | null {
	if (isGradeLayer(element)) {
		return { scope: "timeline", trackId: track.id, elementId: element.id, params: element.params, label: gradeLabel(element.params) };
	}
	const effect = clipGradeEffect(element);
	if (!effect) return null;
	return { scope: "clip", trackId: track.id, elementId: element.id, effectId: effect.id, params: effect.params, label: gradeLabel(effect.params) };
}

/**
 * The GRADE layer that colours this clip: an enabled grade effect element above the clip's track overlapping its
 * time. Without a clip (or for audio) the first grade layer on the timeline.
 */
export function timelineGrade(tracks: SceneTracks, element?: TimelineElement, track?: TimelineTrack): GradeSource | null {
	const clipStack = track ? stackIndex(tracks, track.id) : Number.POSITIVE_INFINITY;
	for (let index = 0; index < tracks.overlay.length; index++) {
		const candidate = tracks.overlay[index] as TimelineTrack;
		if (candidate.type !== "effect" || ("hidden" in candidate && candidate.hidden)) continue;
		if (index >= clipStack) break;
		for (const layer of candidate.elements) {
			if (!isGradeLayer(layer)) continue;
			if (element && !(layer.startTime < element.startTime + element.duration && layer.startTime + layer.duration > element.startTime)) continue;
			return { scope: "timeline", trackId: candidate.id, elementId: layer.id, params: layer.params, label: gradeLabel(layer.params) };
		}
	}
	return null;
}

/** What the inspector's Grade row prints: "warm morning", "film · timeline", "punchy + moody · timeline", "none". */
export function gradeRowValue(tracks: SceneTracks, element: TimelineElement, track: TimelineTrack): { text: string; graded: boolean } {
	const own = clipGrade(element, track);
	if (own?.scope === "timeline") return { text: own.label, graded: own.label !== "none" };
	const layer = timelineGrade(tracks, element, track);
	const ownText = own && own.label !== "none" ? own.label : null;
	const layerText = layer && layer.label !== "none" ? layer.label : null;
	if (ownText && layerText) return { text: `${ownText} + ${layerText} · timeline`, graded: true };
	if (ownText) return { text: ownText, graded: true };
	if (layerText) return { text: `${layerText} · timeline`, graded: true };
	return { text: "none", graded: false };
}
