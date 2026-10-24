/**
 * Auto captions in the editor (EDT-12): a caption document (chunks of timed words) → @restorffcut/timeline-ops
 * `buildCaptionOps` (measured layout, safe area, style) → reducer → one undo step.
 *
 * The caption document lives IN the timeline: every chunk element on the CAPTIONS track carries its words (seconds
 * relative to the element's start) in `restorff.caption`, so it survives save / reload / undo and follows the element
 * if someone drags it. Every edit in the caption list is "read the doc → change it → rebuild all caption tracks".
 */
import {
	buildCaptionOps,
	CAPTION_TRACK_NAMES,
	chunkWordGroups,
	getCaptionStyle,
	type CaptionDocChunk,
	type CaptionFont,
	type MeasureText,
	type Op,
	type TimedWord,
} from "@restorffcut/timeline-ops";
import type { EditorCore } from "@/core";
import { loadFonts } from "@/fonts/google-fonts";
import { setCanvasLetterSpacing } from "@/text/layout";
import { getTextMeasurementContext } from "@/text/measure-element";
import { buildTextFontString } from "@/text/primitives";
import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";
import { DEFAULTS } from "@/timeline/defaults";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { commitTracks, conflictText, freshSeed, runOpsOnActiveScene } from "./ops-bridge";

export type CaptionLayer = "base" | "words" | "shadow";

interface CaptionTag {
	style: string;
	/** Words, seconds relative to the element's start. */
	words: TimedWord[];
}

type Tagged<T> = T & {
	restorff?: { role?: string; captionLayer?: CaptionLayer; caption?: CaptionTag; [key: string]: unknown };
};

const LAYER_NAMES = new Set<string>(Object.values(CAPTION_TRACK_NAMES));

/** Tracks that hold captions (ours, the reducer's add_captions, or an imported subtitle track). */
export function findCaptionTracks(tracks: SceneTracks): TimelineTrack[] {
	return tracks.overlay.filter((track) => {
		if (track.type !== "text") return false;
		const tag = (track as Tagged<TimelineTrack>).restorff;
		// captions-v2: the key-word style adds numbered lanes ("CAPTION WORDS 2", "CAPTION SHADOW 3")
		return Boolean(tag?.captionLayer) || tag?.role === "caption" || LAYER_NAMES.has(track.name.toUpperCase().replace(/ \d+$/, ""));
	});
}

function baseTrack(tracks: SceneTracks): TimelineTrack | null {
	const candidates = findCaptionTracks(tracks);
	return (
		candidates.find((track) => (track as Tagged<TimelineTrack>).restorff?.captionLayer === "base") ??
		candidates.find((track) => {
			const tag = (track as Tagged<TimelineTrack>).restorff;
			const name = track.name.toUpperCase().replace(/ \d+$/, "");
			return !tag?.captionLayer && name !== CAPTION_TRACK_NAMES.words && name !== CAPTION_TRACK_NAMES.shadow;
		}) ??
		null
	);
}

/** Read the caption document back from the timeline (chunks sorted by time) and the style it was built with. */
export function readCaptionDoc(tracks: SceneTracks): { doc: CaptionDocChunk[]; styleId: string | null; trackId: string | null } {
	const track = baseTrack(tracks);
	if (!track) return { doc: [], styleId: null, trackId: null };
	let styleId: string | null = null;
	const elements = [...track.elements].sort((a, b) => a.startTime - b.startTime) as Tagged<TimelineElement>[];
	const doc = elements.map((element) => {
		const start = element.startTime / TICKS_PER_SECOND;
		const end = start + element.duration / TICKS_PER_SECOND;
		const tag = element.restorff?.caption;
		if (tag && !styleId) styleId = tag.style;
		let words: TimedWord[];
		if (tag?.words?.length) {
			words = tag.words.map((word) => ({ text: word.text, start: start + word.start, end: start + word.end }));
		} else {
			// a caption made elsewhere (add_captions, SRT): spread its words over its time by letters
			const tokens = String(element.params.content ?? "").trim().split(/\s+/).filter(Boolean);
			const letters = tokens.reduce((sum, token) => sum + token.length + 1, 0) || 1;
			let cursor = start;
			words = tokens.map((token) => {
				const span = ((end - start) * (token.length + 1)) / letters;
				const word = { text: token, start: cursor, end: cursor + span };
				cursor += span;
				return word;
			});
		}
		return { start, end, words };
	});
	return { doc: doc.filter((chunk) => chunk.words.length && chunk.end > chunk.start), styleId, trackId: track.id };
}

/** Canvas measuring with the renderer's own font string and letter spacing (text/primitives.ts). */
export function createCanvasMeasure(canvasHeight: number): MeasureText {
	const ctx = getTextMeasurementContext();
	return (text: string, font: CaptionFont) => {
		ctx.save();
		ctx.font = buildTextFontString({
			fontFamily: font.family,
			fontWeight: font.weight,
			fontStyle: font.italic ? "italic" : "normal",
			scaledFontSize: font.size * (canvasHeight / FONT_SIZE_SCALE_REFERENCE),
		});
		setCanvasLetterSpacing({ ctx, letterSpacingPx: font.letterSpacing });
		const width = ctx.measureText(text).width;
		ctx.restore();
		return width;
	};
}

export interface CaptionBuildReport {
	chunks: number;
	shrunk: number;
	styleId: string;
	replacedTracks: number;
}

/**
 * Replace every caption track with captions built from `doc` in style `styleId`. One undo step.
 */
export async function rebuildCaptions({
	editor,
	doc,
	styleId,
}: {
	editor: EditorCore;
	doc: CaptionDocChunk[];
	styleId: string;
}): Promise<CaptionBuildReport> {
	const style = getCaptionStyle(styleId);
	if (style.base.font) await loadFonts({ families: [style.base.font] });
	const canvas = editor.project.getActive().settings.canvasSize;
	const tracks = editor.scenes.getActiveScene().tracks;
	const old = findCaptionTracks(tracks);

	const build = buildCaptionOps({
		chunks: doc,
		style,
		canvas,
		measure: createCanvasMeasure(canvas.height),
		lineHeight: DEFAULTS.text.lineHeight,
		author: "user",
	});
	const ops: Op[] = [
		...old.map((track) => ({ op: "remove_track" as const, author: "user" as const, track: track.id })),
		...build.ops,
	];
	const run = runOpsOnActiveScene({ editor, ops, seed: freshSeed(editor, `captions-${style.id}`) });
	if (!run.result.ok) throw new Error(`captions not applied — ${conflictText(run.result)}`);

	// tag tracks and chunk elements so the caption list can read the document back
	const refs = run.result.changes.refs;
	const layerOf = new Map<string, CaptionLayer>();
	layerOf.set(refs[build.tracks.base], "base");
	// captions-v2: every lane of a layer (key-word chunks show their runs at once, one lane per run)
	for (const ref of build.tracks.wordSlots ?? (build.tracks.words ? [build.tracks.words] : [])) layerOf.set(refs[ref], "words");
	for (const ref of build.tracks.shadowSlots ?? (build.tracks.shadow ? [build.tracks.shadow] : [])) layerOf.set(refs[ref], "shadow");
	const tagOf = new Map<string, CaptionTag>();
	for (const layout of build.chunks) {
		const id = refs[layout.ref];
		const chunk = doc[layout.index];
		if (!id || !chunk) continue;
		tagOf.set(id, {
			style: style.id,
			words: chunk.words.map((word) => ({
				text: word.text,
				start: Math.max(0, word.start - chunk.start),
				end: Math.max(0, word.end - chunk.start),
			})),
		});
	}
	const tagTrack = (track: TimelineTrack): TimelineTrack => {
		const layer = layerOf.get(track.id);
		if (!layer) return track;
		const tagged = track as Tagged<TimelineTrack>;
		return {
			...track,
			restorff: { ...(tagged.restorff ?? {}), captionLayer: layer },
			elements: track.elements.map((element) => {
				const current = element as Tagged<TimelineElement>;
				const caption = tagOf.get(element.id);
				return {
					...element,
					restorff: {
						...(current.restorff ?? {}),
						captionLayer: layer,
						...(layer === "base" ? { role: "caption" } : {}),
						...(caption ? { caption } : {}),
					},
				};
			}),
		} as unknown as TimelineTrack;
	};
	const after: SceneTracks = {
		overlay: run.after.overlay.map(tagTrack) as SceneTracks["overlay"],
		main: run.after.main,
		audio: run.after.audio,
	};
	commitTracks({ editor, before: run.before, after });
	return {
		chunks: build.chunks.length,
		shrunk: build.chunks.filter((chunk) => chunk.shrunk).length,
		styleId: style.id,
		replacedTracks: old.length,
	};
}

/** Auto captions from timeline words. */
export function captionDocFromWords({
	words,
	maxWords,
}: {
	words: TimedWord[];
	maxWords: number;
}): CaptionDocChunk[] {
	return chunkWordGroups(words, { maxWords });
}

/** Remove every caption track (one undo step). */
export function clearCaptions({ editor }: { editor: EditorCore }): number {
	const tracks = editor.scenes.getActiveScene().tracks;
	const old = findCaptionTracks(tracks);
	if (!old.length) return 0;
	const ops: Op[] = old.map((track) => ({ op: "remove_track" as const, author: "user" as const, track: track.id }));
	const run = runOpsOnActiveScene({ editor, ops, seed: freshSeed(editor, "captions-clear") });
	if (!run.result.ok) throw new Error(conflictText(run.result));
	commitTracks({ editor, before: run.before, after: run.after });
	return old.length;
}
