/**
 * Fictional fixture for the interchange tests and demos: Halcyon Cold Brew AD-014, 9:16, 30 fps (or any rate), shaped
 * like the editor's SerializedProject v32. No real client data.
 */
import type { ProjectSnapshot } from "@/sync/snapshot";
import type { InterchangeInput } from "./interchange-timeline";

const T = 120_000;
type Json = Record<string, any>;

const visual = (extra: Json = {}) => ({
	"transform.positionX": 0,
	"transform.positionY": 0,
	"transform.scaleX": 1,
	"transform.scaleY": 1,
	"transform.rotate": 0,
	opacity: 1,
	blendMode: "normal",
	...extra,
});

const caption = (id: string, content: string, start: number, end: number) => ({
	id,
	type: "text",
	name: content,
	startTime: Math.round(start * T),
	duration: Math.round((end - start) * T),
	trimStart: 0,
	trimEnd: 0,
	params: visual({ content, fontFamily: "Archivo", fontSize: 4.6, color: "#FFFFFF", fontWeight: "bold", textAlign: "center", "transform.positionY": 384 }),
	restorff: { role: "caption", author: "claude" },
});

/** Halcyon Cold Brew AD-014: 2 video lanes, a motion lane, captions, a title, a grade layer, music, SFX, a dissolve. */
export function halcyonFixture(fps: { numerator: number; denominator: number } = { numerator: 30, denominator: 1 }): ProjectSnapshot {
	return {
		metadata: {
			id: "proj-halcyon-interchange",
			name: "Halcyon Cold Brew / AD-014",
			duration: 10 * T,
			createdAt: "2026-10-20T09:00:00.000Z",
			updatedAt: "2026-10-20T09:00:00.000Z",
			restorff: {
				opsVersion: "ops@1",
				pending: [],
				media: [
					{ id: "media-aroll", kind: "video", name: "halcyon-aroll.mp4", duration: 20 * T, width: 1080, height: 1920, fps: 30, hasAudio: true },
					{ id: "media-fridge", kind: "video", name: "halcyon-fridge.mp4", duration: 10 * T, width: 1080, height: 1920, fps: 30, hasAudio: true },
					{ id: "media-pour", kind: "video", name: "halcyon-pour.mp4", duration: 8 * T, width: 1080, height: 1920, fps: 30, hasAudio: true },
					{ id: "media-still", kind: "image", name: "halcyon-can.png", width: 1080, height: 1920 },
					{ id: "media-motion", kind: "video", name: "badge-pills.webm", duration: 2 * T, width: 1080, height: 1920, fps: 30, hasAudio: false },
					{ id: "media-music", kind: "audio", name: "halcyon-bed.mp3", duration: 60 * T },
					{ id: "media-whoosh", kind: "audio", name: "whoosh.wav", duration: 0.6 * T },
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
						{
							id: "trk-grade",
							name: "GRADE",
							type: "effect",
							hidden: false,
							restorff: { role: "grade" },
							elements: [{ id: "el-grade", type: "effect", name: "Grade", effectType: "restorff-grade", startTime: 0, duration: 10 * T, trimStart: 0, trimEnd: 0, params: { temperature: 12 } }],
						},
						{
							id: "trk-captions",
							name: "CAPTIONS",
							type: "text",
							hidden: false,
							restorff: { role: "caption" },
							elements: [caption("el-cap-1", "Halcyon cold brew.", 0.5, 1.5), caption("el-cap-2", "Steeped for twenty hours.", 1.6, 3.0), caption("el-cap-3", "Never bitter.", 3.1, 4.0)],
						},
						{
							id: "trk-text",
							name: "TEXT",
							type: "text",
							hidden: false,
							elements: [
								{
									id: "el-title",
									type: "text",
									name: "ONE POUR.",
									startTime: 6.2 * T,
									duration: 2 * T,
									trimStart: 0,
									trimEnd: 0,
									params: visual({ content: "ONE POUR.", fontFamily: "Archivo", fontSize: 6, color: "#F6FF00", fontWeight: "bold", textAlign: "center", "transform.positionY": -400 }),
								},
							],
						},
						{
							id: "trk-motion",
							name: "MOTION",
							type: "video",
							muted: false,
							hidden: false,
							elements: [
								{
									id: "el-motion",
									type: "video",
									name: "Badge pills",
									mediaId: "media-motion",
									startTime: 0.5 * T,
									duration: 2 * T,
									trimStart: 0,
									trimEnd: 0,
									sourceDuration: 2 * T,
									isSourceAudioEnabled: false,
									hidden: false,
									params: visual({ volume: 0, muted: false }),
									restorff: { author: "claude", composition: { name: "badge-pills", title: "Badge pills", custom: false } },
								},
							],
						},
						{
							id: "trk-broll",
							name: "V2 B-ROLL",
							type: "video",
							muted: false,
							hidden: false,
							elements: [
								{
									id: "el-pour",
									type: "video",
									name: "S03 pour",
									mediaId: "media-pour",
									startTime: 3 * T,
									duration: 3 * T,
									trimStart: 0,
									trimEnd: 5 * T,
									sourceDuration: 8 * T,
									isSourceAudioEnabled: false,
									hidden: false,
									params: visual({ "transform.scaleX": 1.2, "transform.scaleY": 1.2, volume: 0, muted: false }),
								},
								{
									id: "el-can",
									type: "image",
									name: "S05 can",
									mediaId: "media-still",
									startTime: 8 * T,
									duration: 2 * T,
									trimStart: 0,
									trimEnd: 0,
									hidden: false,
									params: visual(),
								},
							],
						},
					],
					main: {
						id: "trk-main",
						name: "V1 A-ROLL",
						type: "video",
						muted: false,
						hidden: false,
						elements: [
							{
								id: "el-s01",
								type: "video",
								name: "S01 talking head",
								mediaId: "media-aroll",
								startTime: 0,
								duration: 6 * T,
								trimStart: 0.5 * T,
								trimEnd: 13.5 * T,
								sourceDuration: 20 * T,
								isSourceAudioEnabled: true,
								hidden: false,
								params: visual({ volume: 0, muted: false }),
							},
							{
								id: "el-s02",
								type: "video",
								name: "S02 fridge",
								mediaId: "media-fridge",
								startTime: 6 * T,
								duration: 4 * T,
								trimStart: 1 * T,
								trimEnd: 5 * T,
								sourceDuration: 10 * T,
								isSourceAudioEnabled: true,
								hidden: false,
								transitionIn: { type: "dissolve", duration: 0.5 * T },
								params: visual({ volume: -3, muted: false }),
							},
						],
					},
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
									duration: 10 * T,
									trimStart: 0,
									trimEnd: 50 * T,
									sourceDuration: 60 * T,
									params: { volume: -10, muted: false },
									animations: { volume: { keys: [{ id: "k1", time: 0, value: -10, segmentToNext: "linear", tangentMode: "flat" }, { id: "k2", time: 9 * T, value: -60, segmentToNext: "linear", tangentMode: "flat" }] } },
								},
							],
						},
						{
							id: "trk-sfx",
							name: "SFX",
							type: "audio",
							muted: false,
							restorff: { role: "sfx" },
							elements: [
								{
									id: "el-whoosh",
									type: "audio",
									sourceType: "upload",
									name: "Whoosh",
									mediaId: "media-whoosh",
									startTime: 5.75 * T, // off the frame grid on purpose: 172.5 frames
									duration: 0.6 * T,
									trimStart: 0,
									trimEnd: 0,
									sourceDuration: 0.6 * T,
									params: { volume: -8, muted: false },
								},
							],
						},
					],
				},
				bookmarks: [{ time: 6 * T, note: "S02 · Fridge" }],
				createdAt: "2026-10-20T09:00:00.000Z",
				updatedAt: "2026-10-20T09:00:00.000Z",
			},
		],
		currentSceneId: "scene-main",
		settings: { fps, canvasSize: { width: 1080, height: 1920 }, canvasSizeMode: "preset", background: { type: "color", color: "#000000" } },
		version: 32,
	} as unknown as ProjectSnapshot;
}

export const COMMENTS = [{ time_s: 2, body: "Caption sits in the unsafe zone → move it up 120 px", severity: "must", rule_id: "SAFE", author: "judge", status: "open" }];

/** The export input the tests use: the fixture, one Judge comment, media URLs on this server. */
export const fixtureInput = (snapshot: ProjectSnapshot): InterchangeInput => ({
	snapshot,
	timelineId: "proj-halcyon-interchange",
	commitId: "7f3a000000000000000000000000000000000000",
	comments: COMMENTS,
	exportedAt: "2026-10-20T14:00:00.000Z",
	mediaUrl: (id) => `http://localhost:8791/api/projects/proj-halcyon-interchange/media/${encodeURIComponent(id)}`,
});
