import { afterEach, describe, expect, test } from "bun:test";
import { collectAudioClips } from "@/media/audio";
import { audioFrameCount, MAX_CLIP_SECONDS, renderRetimedBuffer } from "@/retime/audio-stretch";
import type { SceneTracks } from "@/timeline";

/**
 * QA 2026-10-20 #5 (ui-fix-render): "Retimed-clip audio throws createBuffer(2, 2618995712, 48000)". The clip was not
 * retimed: it was the paper-collage's MUSIC bed (a library element, 2,559,960 ticks = 21.33 s, ducked → volume
 * keyframes → the prepared-buffer path). fetchLibraryAudioClip handed the AudioManager TICKS as seconds; Web Audio
 * wrapped 2,559,960 × 48,000 to 32 bits. The neon-grid's 2,304,000-tick bed gave the QA's other number, 3,217,817,600.
 */
const TICKS = 120_000;

function libraryBed({ startTicks, durationTicks }: { startTicks: number; durationTicks: number }) {
	return {
		id: "bed-1",
		name: "MUSIC Warm morning",
		type: "audio",
		sourceType: "library",
		sourceUrl: "http://localhost/sounds/warm-morning.mp3",
		startTime: startTicks,
		duration: durationTicks,
		trimStart: 0,
		trimEnd: 0,
		params: { volume: -4 },
		animations: {
			volume: {
				keys: [
					{ id: "k1", time: 0, value: -4, tangentMode: "flat", segmentToNext: "linear" },
					{ id: "k2", time: 120000, value: -14, tangentMode: "flat", segmentToNext: "linear" },
				],
			},
		},
	};
}

function tracksWith(element: unknown): SceneTracks {
	return {
		overlay: [],
		main: { id: "main", name: "V1 A-ROLL", type: "video", elements: [], muted: false, hidden: false, isMain: true },
		audio: [{ id: "music", name: "MUSIC", type: "audio", elements: [element], muted: false }],
	} as unknown as SceneTracks;
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("library audio clips are in seconds (QA #5)", () => {
	test("the QA's createBuffer lengths are the beds' TICKS × 48 kHz wrapped to 32 bits", () => {
		expect((2_559_960 * 48_000) % 2 ** 32).toBe(2_618_995_712);
		expect((2_304_000 * 48_000) % 2 ** 32).toBe(3_217_817_600);
	});

	test("collectAudioClips returns a library bed's start, length and trims in seconds", async () => {
		globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
		const bed = libraryBed({ startTicks: 2_559_960, durationTicks: 2_559_960 });
		const clips = await collectAudioClips({ tracks: tracksWith(bed), mediaAssets: [] });
		expect(clips).toHaveLength(1);
		expect(clips[0].startTime).toBeCloseTo(2_559_960 / TICKS, 9);
		expect(clips[0].duration).toBeCloseTo(21.333, 3);
		expect(clips[0].trimStart).toBe(0);
		expect(clips[0].trimEnd).toBe(0);
		// a 21.33 s bed needs ~1.02 M frames at 48 kHz, not 2.6 billion
		expect(audioFrameCount({ seconds: clips[0].duration, sampleRate: 48_000 })).toBe(1_023_984);
	});

	test("audioFrameCount refuses a ticks-sized span instead of letting Web Audio wrap it", () => {
		expect(() => audioFrameCount({ seconds: 2_559_960, sampleRate: 48_000 })).toThrow(/ticks, not seconds/);
		expect(() => audioFrameCount({ seconds: Number.NaN, sampleRate: 48_000 })).toThrow(RangeError);
		expect(audioFrameCount({ seconds: MAX_CLIP_SECONDS, sampleRate: 48_000 })).toBe(MAX_CLIP_SECONDS * 48_000);
		expect(audioFrameCount({ seconds: 0, sampleRate: 48_000 })).toBe(1);
	});

	test("renderRetimedBuffer (2x, no pitch keeping) asks for clip-length frames", async () => {
		const asked: number[] = [];
		const fakeBuffer = (channels: number, length: number, sampleRate: number) => {
			const data = Array.from({ length: channels }, () => new Float32Array(length));
			return { numberOfChannels: channels, length, sampleRate, getChannelData: (c: number) => data[c] };
		};
		const audioContext = {
			sampleRate: 48_000,
			createBuffer: (channels: number, length: number, sampleRate: number) => {
				asked.push(length);
				return fakeBuffer(channels, length, sampleRate);
			},
		} as unknown as BaseAudioContext;
		const source = fakeBuffer(2, 48_000 * 4, 48_000) as unknown as AudioBuffer;
		const out = await renderRetimedBuffer({
			audioContext,
			sourceBuffer: source,
			trimStart: 0,
			clipDuration: 1.5,
			retime: { rate: 2 },
			maintainPitch: false,
		});
		expect(asked).toEqual([72_000]);
		expect(out.length).toBe(72_000);
		await expect(
			renderRetimedBuffer({ audioContext, sourceBuffer: source, trimStart: 0, clipDuration: 2_559_960, retime: { rate: 2 } }),
		).rejects.toThrow(/ticks, not seconds/);
	});
});
