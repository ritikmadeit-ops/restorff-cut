/**
 * voice-music (2026-10-20): the pure halves of the `voiceover` and `music` tools — bed placement and loops, the duck
 * envelope (must match timeline-ops' reducer), fades that never swell, voice spans from words, beats on the timeline,
 * and word timings from audio. The live path (Windows speech → media store → commit → render) is measured with
 * scripts/mcp-call.ts: docs/restorff/worklog/voice-music.md.
 */
import { describe, expect, test } from "bun:test";
import { apply, type Op, type Project } from "@restorffcut/timeline-ops";
import { duckReductionAt, MUSIC_MIX, type MusicBed, planBed, planMusicEnvelope, tagBed, timelineBeats, voiceSpans } from "@/server/music-plan";
import { refineWords, wavDataBytes } from "@/server/voice";

const T = 120_000;
const NOW = "2026-10-20T09:00:00.000Z";

/** Fictional Halcyon Cold Brew timeline: V1 with `contentS` of video (no audio), empty MUSIC and SFX lanes. */
function halcyon(contentS = 0): Project {
	return {
		metadata: { id: "proj-halcyon-vm", name: "Halcyon Cold Brew / VM", duration: contentS * T, createdAt: NOW, updatedAt: NOW, restorff: { opsVersion: "ops@1", pending: [], media: [{ id: "media-pour", kind: "video", name: "halcyon-pour.mp4", duration: 60 * T, hasAudio: false, author: "user" }] } },
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [],
					main: {
						id: "trk-main",
						name: "V1 A-ROLL",
						type: "video",
						muted: false,
						hidden: false,
						elements: contentS
							? [{ id: "el-pour", type: "video", name: "S01 pour", mediaId: "media-pour", startTime: 0, duration: contentS * T, trimStart: 0, trimEnd: (60 - contentS) * T, sourceDuration: 60 * T, isSourceAudioEnabled: true, hidden: false, params: { volume: 0, muted: false } }]
							: [],
					},
					audio: [
						{ id: "trk-music", name: "MUSIC", type: "audio", muted: false, elements: [] },
						{ id: "trk-sfx", name: "SFX", type: "audio", muted: false, elements: [], restorff: { role: "sfx" } },
					],
				},
				bookmarks: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
		],
		currentSceneId: "scene-main",
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 }, canvasSizeMode: "preset", background: { type: "color", color: "#000000" } },
		version: 32,
	} as unknown as Project;
}

const BED: MusicBed = {
	id: "tense-100",
	name: "Countdown",
	mood: "tense",
	url: "/music/tense-100.ogg",
	bpm: 100,
	bars: 8,
	duration_s: 19.2,
	beat_times_s: Array.from({ length: 32 }, (_, i) => Math.round(i * 0.6 * 1000) / 1000),
	downbeats: [0, 4, 8, 12, 16, 20, 24, 28],
	lufs_i: -18,
};

/** A voice clip on a VOICE track at t, with words (source seconds), tagged the way the voiceover tool tags it. */
function withVoice(project: Project, t: number, words: Array<{ text: string; start: number; end: number }>, durS: number): Project {
	const scene = project.scenes[0];
	scene.tracks.audio.unshift({
		id: "trk-voice",
		name: "VOICE",
		type: "audio",
		muted: false,
		restorff: { role: "voice" },
		elements: [
			{ id: "el-vo", type: "audio", sourceType: "upload", mediaId: "media-vo", name: "VO", startTime: Math.round(t * T), duration: Math.round(durS * T), trimStart: 0, trimEnd: 0, sourceDuration: Math.round(durS * T), params: { volume: 0, muted: false }, restorff: { role: "voice", voice: { take: "k", hash: "h", voice: "zira-desktop", engine: "sapi", speed: 1, text: "", words } } },
		],
	} as never);
	return project;
}

function placeBed(project: Project, options: Parameters<typeof planBed>[2] = {}) {
	const plan = planBed(project, BED, options);
	const placed = apply(project, plan.ops, { seed: "test/bed" });
	expect(placed.ok).toBe(true);
	tagBed(placed.project, plan, placed.changes.refs, BED, { level: "auto", duckDb: MUSIC_MIX.duckDb });
	const envelope = planMusicEnvelope(placed.project);
	const final = apply(placed.project, envelope.ops, { seed: "test/envelope" });
	expect(final.ok).toBe(true);
	return { plan, project: final.project, envelope };
}

const musicElements = (project: Project) => project.scenes[0].tracks.audio.find((track) => track.id === "trk-music")?.elements ?? [];
const volumeKeys = (element: unknown) =>
	(((element as { animations?: { volume?: { keys: Array<{ time: number; value: number }> } } }).animations?.volume?.keys ?? []) as Array<{ time: number; value: number }>).map((key) => [key.time / T, key.value] as const);

describe("planBed", () => {
	test("empty timeline: one copy, the bed's own length, on the existing MUSIC lane", () => {
		const { plan, project } = placeBed(halcyon(0));
		expect(plan.track.existing).toBe(true);
		expect(plan.copies).toEqual([{ ref: "bed_0", t: 0, dur: 19.2, loop: 0 }]);
		const [element] = musicElements(project) as Array<{ sourceUrl: string; restorff: { role: string } }>;
		expect(element.sourceUrl).toBe("/music/tense-100.ogg");
		expect(element.restorff.role).toBe("music");
	});

	test("a 40 s cut: three seamless copies, the last trimmed, each with the whole loop as its source", () => {
		const { plan, project } = placeBed(halcyon(40));
		expect(plan.copies.map((copy) => [copy.t, copy.dur])).toEqual([
			[0, 19.2],
			[19.2, 19.2],
			[38.4, 1.6],
		]);
		const last = musicElements(project)[2] as { duration: number; trimEnd: number; sourceDuration: number };
		expect(last.sourceDuration).toBe(19.2 * T);
		expect(last.trimEnd).toBe(17.6 * T);
		// beats: every copy carries the grid; the timeline sees 40 s × 100 BPM = 67 beats
		expect(timelineBeats(project).length).toBe(67);
		expect(timelineBeats(project).filter((beat) => beat.downbeat).map((beat) => beat.t).slice(0, 3)).toEqual([0, 2.4, 4.8]);
	});

	test("placing again over the same span replaces the bed (no stacking)", () => {
		const first = placeBed(halcyon(10)).project;
		const again = placeBed(first);
		expect(again.plan.replaced.length).toBe(1);
		expect(musicElements(again.project).length).toBe(1);
	});

	test("no voice: the auto level is −18 LUFS (0 dB for a −18 LUFS bed) and nothing is ducked", () => {
		const { envelope, project } = placeBed(halcyon(10));
		expect(envelope.ducked).toEqual([]);
		expect((musicElements(project)[0].params as { volume: number }).volume).toBe(0);
	});
});

describe("ducking and fades", () => {
	const words = [
		{ text: "Six", start: 0.1, end: 0.44 },
		{ text: "cold.", start: 1.75, end: 2.17 },
		{ text: "One", start: 3.02, end: 3.25 },
		{ text: "door.", start: 4.74, end: 5.13 },
	];

	test("voice spans come from the words, merged across short gaps", () => {
		const spans = voiceSpans(withVoice(halcyon(9), 1, words, 5.43));
		expect(spans.source).toBe("voice-words");
		expect(spans.under).toBe("trk-voice");
		// 0.44→1.75 is 1.31 s apart (kept apart), 2.17→3.02 is 0.85 s (kept apart), word gaps < 0.6 s merge
		expect(spans.spans).toEqual([
			[1.1, 1.44],
			[2.75, 3.17],
			[4.02, 4.25],
			[5.74, 6.13],
		]);
	});

	test("the duck envelope we predict equals the reducer's duck keys", () => {
		const { project, envelope } = placeBed(withVoice(halcyon(9), 0, words, 5.43));
		expect(envelope.ducked[0]).toMatchObject({ track: "trk-music", under: "trk-voice", amount_db: MUSIC_MIX.duckDb });
		const attack = MUSIC_MIX.attackMs / 1000;
		const release = MUSIC_MIX.releaseMs / 1000;
		const keys = volumeKeys(musicElements(project)[0]);
		const fadeStart = 9 - Math.min(MUSIC_MIX.fadeOutMaxS, 9 * 0.25);
		for (const [time, value] of keys) {
			if (time <= MUSIC_MIX.fadeInS || time >= fadeStart) continue;
			const expected = -4 + duckReductionAt(time, envelope.voice.spans, MUSIC_MIX.duckDb, attack, release);
			expect(value).toBeCloseTo(expected, 1);
		}
		// where a word starts and ends the bed is 10 dB down from its −4 dB level (the duck's own keys)
		expect(keys.filter(([time, value]) => (Math.abs(time - 0.1) < 1e-6 || Math.abs(time - 0.44) < 1e-6) && value === -14).length).toBe(2);
	});

	test("the fade-out never rises, even across a duck release inside it", () => {
		// voice ends at 5.13 s; a 6 s bed fades over its last 1.5 s, and the duck releases at 5.13 → 5.48 s
		const { project } = placeBed(withVoice(halcyon(6), 0, words, 5.43));
		const keys = volumeKeys(musicElements(project)[0]);
		const fade = keys.filter(([time]) => time >= 6 - 1.5 - 1e-6);
		for (let i = 1; i < fade.length; i++) expect(fade[i][1]).toBeLessThanOrEqual(fade[i - 1][1] + 1e-9);
		expect(fade[fade.length - 1]).toEqual([6, -60]);
	});

	test("a voice added after the bed: re-running the envelope ducks the existing bed and drops it to −4 dB", () => {
		const bedFirst = placeBed(halcyon(9)).project;
		const voiced = withVoice(bedFirst, 0, words, 5.43);
		const envelope = planMusicEnvelope(voiced);
		const after = apply(voiced, envelope.ops as Op[], { seed: "test/re-duck" });
		expect(after.ok).toBe(true);
		expect(envelope.ducked.length).toBe(1);
		expect((musicElements(after.project)[0].params as { volume: number }).volume).toBe(-4);
	});
});

describe("voice take helpers", () => {
	test("refineWords: ends land where the pause starts, starts in silence move to the onset", () => {
		const rate = 48_000;
		const pcm = new Float32Array(rate * 3);
		const tone = (from: number, to: number) => {
			for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / rate);
		};
		tone(0.1, 0.8); // word 1
		tone(0.8, 1.2); // word 2 (connected)
		tone(1.7, 2.5); // word 3 after a 0.5 s pause
		const engine = [
			{ text: "one", start: 0.1, end: 0.1 },
			{ text: "two", start: 0.8, end: 0.8 },
			{ text: "three", start: 1.65, end: 1.65 }, // the engine says 50 ms early: inside the pause
		];
		const { words, speechEnd } = refineWords(engine, pcm, 0);
		expect(words[0]).toEqual({ text: "one", start: 0.1, end: 0.8 });
		expect(words[1].end).toBeCloseTo(1.2, 2);
		expect(words[2].start).toBeCloseTo(1.7, 2);
		expect(speechEnd).toBeCloseTo(2.5, 2);
		expect(words[2].end).toBeCloseTo(2.5, 2);
	});

	test("wavDataBytes finds the data chunk past other chunks", () => {
		const bytes = new Uint8Array(12 + 8 + 4 + 8 + 16);
		const view = new DataView(bytes.buffer);
		const put = (offset: number, text: string) => [...text].forEach((c, i) => (bytes[offset + i] = c.charCodeAt(0)));
		put(0, "RIFF");
		put(8, "WAVE");
		put(12, "LIST");
		view.setUint32(16, 4, true);
		put(24, "data");
		view.setUint32(28, 16, true);
		expect(wavDataBytes(bytes)).toBe(16);
	});
});
