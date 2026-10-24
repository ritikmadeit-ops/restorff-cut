import type { TimedWord } from "@restorffcut/timeline-ops";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import type { AudioElement, SceneTracks, TimelineElement, VideoElement } from "@/timeline";
import { getTranscript, type MediaTranscript } from "@/transcription/transcript-store";
import { TICKS_PER_SECOND } from "@/wasm";

export type SpokenClip = (VideoElement | (AudioElement & { mediaId: string })) & { trackId: string };

/** Video / uploaded-audio clips that can carry speech, in timeline order. */
export function listSpokenClips(tracks: SceneTracks): SpokenClip[] {
	const clips: SpokenClip[] = [];
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const element of track.elements as TimelineElement[]) {
			if (element.type === "video") {
				if (element.isSourceAudioEnabled === false || element.params.muted === true) continue;
				clips.push({ ...element, trackId: track.id });
			} else if (element.type === "audio" && element.sourceType === "upload") {
				if (element.params.muted === true) continue;
				clips.push({ ...element, trackId: track.id });
			}
		}
	}
	return clips.sort((a, b) => a.startTime - b.startTime);
}

export const rateOf = (element: TimelineElement) =>
	"retime" in element && element.retime?.rate ? element.retime.rate : 1;

/** Source window of a clip, seconds: [in, out). */
export function clipSourceWindow(element: TimelineElement): { in: number; out: number; start: number } {
	const rate = rateOf(element);
	const sourceIn = element.trimStart / TICKS_PER_SECOND;
	return {
		in: sourceIn,
		out: sourceIn + (element.duration / TICKS_PER_SECOND) * rate,
		start: element.startTime / TICKS_PER_SECOND,
	};
}

/** The words of one clip, on the timeline (a word belongs to the clip when its middle is inside the clip). */
export function clipWordsOnTimeline(element: TimelineElement, transcript: MediaTranscript): TimedWord[] {
	const rate = rateOf(element);
	const window = clipSourceWindow(element);
	const toTimeline = (source: number) => window.start + (source - window.in) / rate;
	const clipEnd = window.start + element.duration / TICKS_PER_SECOND;
	const words: TimedWord[] = [];
	for (const word of transcript.words) {
		const middle = (word.start + word.end) / 2;
		if (middle < window.in || middle >= window.out) continue;
		const start = Math.max(window.start, toTimeline(word.start));
		const end = Math.min(clipEnd, toTimeline(word.end));
		if (end > start) words.push({ text: word.text, start, end });
	}
	return words;
}

/**
 * Every transcribed word on the timeline, in order — from each audible clip whose media has a transcript. Duplicates
 * (a video and its separated audio saying the same word at the same time) are dropped.
 */
export function collectTimelineWords({
	editor,
}: {
	editor: EditorCore;
}): { words: TimedWord[]; missing: MediaAsset[]; clips: number } {
	const tracks = editor.scenes.getActiveScene().tracks;
	const assets = new Map(editor.media.getAssets().map((asset) => [asset.id, asset]));
	const words: TimedWord[] = [];
	const missing = new Map<string, MediaAsset>();
	let clips = 0;
	for (const clip of listSpokenClips(tracks)) {
		const asset = assets.get(clip.mediaId);
		if (!asset) continue;
		const transcript = getTranscript(asset);
		if (!transcript) {
			if (asset.type === "audio" || asset.hasAudio !== false) missing.set(asset.id, asset);
			continue;
		}
		clips++;
		words.push(...clipWordsOnTimeline(clip, transcript));
	}
	words.sort((a, b) => a.start - b.start);
	const unique: TimedWord[] = [];
	for (const word of words) {
		const previous = unique[unique.length - 1];
		if (previous && previous.text === word.text && Math.abs(previous.start - word.start) < 0.03) continue;
		unique.push(word);
	}
	return { words: unique, missing: [...missing.values()], clips };
}
