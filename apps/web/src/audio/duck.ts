/**
 * Ducking: music under voice (README "Sound is half the ad": dialogue clear over music,
 * −18 to −12 dB, ducked). Finds where the voice actually speaks (VAD on the voice mix, not
 * whole clip spans) and writes a linear `volume` envelope (dB keyframes) on every element
 * of the music track. Same envelope shape as the ops@1 `duck` op in
 * packages/timeline-ops (attack before each phrase, release after, phrases closer than
 * attack + release merged).
 * Ported idea: OpenCut-AI use-auto-duck.ts (transcript segments, −18 dB, 0.3 s fades).
 */
import type { EditorCore } from "@/core";
import type { ScalarAnimationKey } from "@/animation/types";
import { createTimelineAudioBuffer } from "@/media/audio";
import type { AudioTrack, SceneTracks, TimelineElement } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { roundMediaTime, TICKS_PER_SECOND } from "@/wasm";
import { detectVoiceSpans } from "./vad";

export const DUCK_DEFAULTS = { amountDb: -15, attackMs: 80, releaseMs: 300 };
const VOLUME_MIN_DB = -60;
const VOLUME_MAX_DB = 20;

export interface DuckEnvelopeOptions {
	amountDb: number;
	attackTicks: number;
	releaseTicks: number;
}

/** Piecewise-linear reduction (dB ≤ 0) over timeline ticks for the given voice spans. */
export function duckEnvelopePoints(
	spans: Array<[number, number]>,
	{ amountDb, attackTicks, releaseTicks }: DuckEnvelopeOptions,
): Array<[number, number]> {
	const amount = -Math.abs(amountDb);
	const merged: Array<[number, number]> = [];
	for (const span of [...spans].sort((a, b) => a[0] - b[0])) {
		const last = merged[merged.length - 1];
		if (last && span[0] - last[1] < attackTicks + releaseTicks) last[1] = Math.max(last[1], span[1]);
		else merged.push([span[0], span[1]]);
	}
	const points: Array<[number, number]> = [];
	for (const [start, end] of merged) {
		points.push([start - attackTicks, 0], [start, amount], [end, amount], [end + releaseTicks, 0]);
	}
	return points;
}

function reductionAt(points: Array<[number, number]>, time: number): number {
	if (points.length === 0 || time <= points[0][0] || time >= points[points.length - 1][0]) return 0;
	for (let i = 0; i < points.length - 1; i++) {
		const [t0, v0] = points[i];
		const [t1, v1] = points[i + 1];
		if (time >= t0 && time <= t1) return t1 === t0 ? v1 : v0 + ((time - t0) / (t1 - t0)) * (v1 - v0);
	}
	return 0;
}

/** Volume keys (element-relative ticks) for one music element, or null if nothing to duck. */
export function buildDuckKeys(element: TimelineElement, points: Array<[number, number]>): ScalarAnimationKey[] | null {
	const start = element.startTime;
	const end = element.startTime + element.duration;
	const times = [start, ...points.map(([time]) => time).filter((time) => time > start && time < end), end];
	const samples = times.map((time) => [time, reductionAt(points, time)] as [number, number]);
	if (samples.every(([, reduction]) => reduction === 0)) return null;
	const base = typeof element.params.volume === "number" ? element.params.volume : 0;
	const keys: ScalarAnimationKey[] = [];
	samples.forEach(([time, reduction], index) => {
		const previous = samples[index - 1];
		const next = samples[index + 1];
		if (previous && next && previous[1] === reduction && next[1] === reduction) return;
		const value = Math.min(VOLUME_MAX_DB, Math.max(VOLUME_MIN_DB, Math.round((base + reduction) * 100) / 100));
		keys.push({
			id: generateUUID(),
			time: roundMediaTime({ time: time - start }),
			value,
			segmentToNext: "linear",
			tangentMode: "flat",
		});
	});
	return keys;
}

function isVoiceTrack(track: AudioTrack): boolean {
	return !/^(music|sfx|sound|fx|bgm)/i.test(track.name.trim());
}

/** Scene tracks holding only what counts as voice: the main (A-roll) track and voice audio tracks. */
function voiceOnlyTracks(tracks: SceneTracks, musicTrackId: string): SceneTracks {
	return {
		overlay: [],
		main: tracks.main,
		audio: tracks.audio.filter((track) => track.id !== musicTrackId && isVoiceTrack(track)),
	};
}

export async function duckMusicUnderVoice({
	editor,
	musicTrackId,
	amountDb = DUCK_DEFAULTS.amountDb,
	attackMs = DUCK_DEFAULTS.attackMs,
	releaseMs = DUCK_DEFAULTS.releaseMs,
}: {
	editor: EditorCore;
	musicTrackId: string;
	amountDb?: number;
	attackMs?: number;
	releaseMs?: number;
}): Promise<{ ducked: number; phrases: number; voiceSeconds: number }> {
	const tracks = editor.scenes.getActiveScene().tracks;
	const musicTrack = tracks.audio.find((track) => track.id === musicTrackId);
	if (!musicTrack) throw new Error("Music track not found");
	const duration = editor.timeline.getTotalDuration();
	const voiceMix = await createTimelineAudioBuffer({
		tracks: voiceOnlyTracks(tracks, musicTrackId),
		mediaAssets: editor.media.getAssets(),
		duration,
	});
	if (!voiceMix) return { ducked: 0, phrases: 0, voiceSeconds: 0 };
	const channels = Array.from({ length: voiceMix.numberOfChannels }, (_, channel) => voiceMix.getChannelData(channel));
	const spans = detectVoiceSpans(channels, voiceMix.sampleRate);
	const tickSpans = spans.map(
		(span) => [Math.round(span.start * TICKS_PER_SECOND), Math.round(span.end * TICKS_PER_SECOND)] as [number, number],
	);
	const points = duckEnvelopePoints(tickSpans, {
		amountDb,
		attackTicks: Math.round((attackMs / 1000) * TICKS_PER_SECOND),
		releaseTicks: Math.round((releaseMs / 1000) * TICKS_PER_SECOND),
	});
	const updates: Array<{ trackId: string; elementId: string; patch: Partial<TimelineElement> }> = [];
	for (const element of musicTrack.elements) {
		const keys = buildDuckKeys(element, points);
		if (!keys) continue;
		updates.push({
			trackId: musicTrack.id,
			elementId: element.id,
			patch: { animations: { ...(element.animations ?? {}), volume: { keys } } },
		});
	}
	editor.timeline.updateElements({ updates });
	return {
		ducked: updates.length,
		phrases: spans.length,
		voiceSeconds: spans.reduce((sum, span) => sum + span.end - span.start, 0),
	};
}
