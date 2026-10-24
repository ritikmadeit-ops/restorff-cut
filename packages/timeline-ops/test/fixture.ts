/**
 * Fictional fixture: Halcyon Cold Brew, AD-014, 9:16 at 30 fps. Shaped exactly like the editor's serialized
 * project (services/storage/types.ts SerializedProject, version 31). No real client data.
 */
import type { Project, TimedWord, VideoElement } from "../src/index.ts";

export const T = 120_000; // ticks per second

export function fixtureProject(): Project {
	const aroll: VideoElement = {
		id: "el-aroll",
		type: "video",
		name: "S01 talking head",
		mediaId: "media-aroll",
		startTime: 0,
		duration: 20 * T,
		trimStart: 0,
		trimEnd: 0,
		sourceDuration: 20 * T,
		isSourceAudioEnabled: true,
		hidden: false,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
			blendMode: "normal",
			volume: 0,
			muted: false,
		},
	};
	return {
		metadata: {
			id: "proj-halcyon-ad014",
			name: "Halcyon Cold Brew / AD-014",
			duration: 20 * T,
			createdAt: "2026-10-20T09:00:00.000Z",
			updatedAt: "2026-10-20T09:00:00.000Z",
			restorff: {
				opsVersion: "ops@1",
				pending: [],
				media: [
					{ id: "media-aroll", kind: "video", name: "halcyon-aroll.mp4", duration: 20 * T, width: 1080, height: 1920, fps: 30, hasAudio: true, author: "user" },
					{ id: "media-broll", kind: "video", name: "halcyon-pour.mp4", duration: 8 * T, width: 1080, height: 1920, fps: 30, hasAudio: false, author: "user" },
					{ id: "media-music", kind: "audio", name: "halcyon-bed.mp3", duration: 60 * T, author: "user" },
					{ id: "media-whoosh", kind: "audio", name: "whoosh.wav", duration: 0.6 * T, author: "user" },
					{ id: "media-still", kind: "image", name: "halcyon-can.png", width: 1080, height: 1920, author: "user" },
				],
			},
		},
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [
						{ id: "trk-text", name: "TEXT", type: "text", elements: [], hidden: false },
						{
							id: "trk-broll",
							name: "V2 B-ROLL",
							type: "video",
							muted: false,
							hidden: false,
							elements: [
								{
									id: "el-broll",
									type: "video",
									name: "S04 pour",
									mediaId: "media-broll",
									startTime: 5 * T,
									duration: 3 * T,
									trimStart: 0,
									trimEnd: 5 * T,
									sourceDuration: 8 * T,
									isSourceAudioEnabled: true,
									hidden: false,
									params: { ...aroll.params },
								},
							],
						},
					],
					main: { id: "trk-main", name: "V1 A-ROLL", type: "video", muted: false, hidden: false, elements: [aroll] },
					audio: [
						{
							id: "trk-music",
							name: "MUSIC",
							type: "audio",
							muted: false,
							elements: [
								{
									id: "el-music",
									type: "audio",
									sourceType: "upload",
									name: "Halcyon bed",
									mediaId: "media-music",
									startTime: 0,
									duration: 20 * T,
									trimStart: 0,
									trimEnd: 40 * T,
									sourceDuration: 60 * T,
									params: { volume: -6, muted: false },
								},
							],
						},
						{ id: "trk-sfx", name: "SFX", type: "audio", muted: false, elements: [], restorff: { role: "sfx" } },
					],
				},
				bookmarks: [],
				createdAt: "2026-10-20T09:00:00.000Z",
				updatedAt: "2026-10-20T09:00:00.000Z",
			},
		],
		currentSceneId: "scene-main",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			canvasSizeMode: "preset",
			background: { type: "color", color: "#000000" },
		},
		version: 31,
		timelineViewState: { zoomLevel: 1, scrollLeft: 0, playheadTime: 0 },
	};
}

/**
 * Talking-head transcript (source seconds of media-aroll). Sentence 2 is said twice: the first take is to go.
 * Pauses: 0.9 s and 1.2 s (cut), 0.2 s (kept), 0.5 s (cut); silence before the first word and after the last.
 */
export const TRANSCRIPT: TimedWord[] = [
	{ text: "Halcyon", start: 0.5, end: 0.8 },
	{ text: "cold", start: 0.85, end: 1.1 },
	{ text: "brew.", start: 1.15, end: 1.5 },
	{ text: "Steeped", start: 2.4, end: 2.6 },
	{ text: "for", start: 2.65, end: 2.8 },
	{ text: "twenty", start: 2.85, end: 3.1 },
	{ text: "hours.", start: 3.15, end: 3.6 },
	{ text: "Steeped", start: 4.8, end: 5.0 },
	{ text: "for", start: 5.05, end: 5.2 },
	{ text: "twenty", start: 5.25, end: 5.5 },
	{ text: "hours.", start: 5.55, end: 6.0 },
	{ text: "Never", start: 6.2, end: 6.5 },
	{ text: "bitter.", start: 6.55, end: 6.9 },
	{ text: "Try", start: 7.4, end: 7.7 },
	{ text: "it", start: 7.75, end: 7.9 },
	{ text: "today.", start: 7.95, end: 8.4 },
];

/** Deterministic PRNG for property tests (mulberry32). */
export function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
