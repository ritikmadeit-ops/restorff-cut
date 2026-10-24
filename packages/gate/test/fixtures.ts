/**
 * Fixture projects for the gate (fictional brand: Halcyon Cold Brew). `cleanProject()` passes every timeline check;
 * `defectProject()` plants one defect per check (see the comments).
 */
import type { GateElement, GateProject, GateTrack } from "../src/types.ts";

const S = 120_000;
const s = (seconds: number) => Math.round(seconds * S);

export function video(id: string, from: number, to: number, extra: Partial<GateElement> = {}): GateElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: `m-${id}`,
		startTime: s(from),
		duration: s(to - from),
		trimStart: 0,
		trimEnd: 0,
		sourceDuration: s(to - from),
		isSourceAudioEnabled: true,
		params: { volume: 0 },
		...extra,
	};
}

export function text(id: string, from: number, to: number, content: string, params: Record<string, unknown> = {}): GateElement {
	return {
		id,
		name: id,
		type: "text",
		startTime: s(from),
		duration: s(to - from),
		trimStart: 0,
		trimEnd: 0,
		params: { content, fontSize: 2, textAlign: "center", lineHeight: 1.2, "transform.positionX": 0, "transform.positionY": 0, ...params },
	};
}

export function audio(id: string, from: number, to: number, extra: Partial<GateElement> = {}): GateElement {
	return {
		id,
		name: id,
		type: "audio",
		sourceType: "upload",
		mediaId: `m-${id}`,
		startTime: s(from),
		duration: s(to - from),
		trimStart: 0,
		trimEnd: 0,
		params: { volume: 0 },
		...extra,
	};
}

function track(id: string, name: string, type: string, elements: GateElement[]): GateTrack {
	return { id, name, type, elements, hidden: false, muted: false };
}

function project(tracks: { overlay: GateTrack[]; main: GateTrack; audio: GateTrack[] }, meta: Record<string, unknown>, fps = 30): GateProject {
	return {
		metadata: { id: "p1", name: "Halcyon AD-014", restorff: meta },
		scenes: [{ id: "sc1", isMain: true, tracks }],
		currentSceneId: "sc1",
		settings: { fps: { numerator: fps, denominator: 1 }, canvasSize: { width: 1080, height: 1920 } },
	};
}

const BRIEF = { offer: { price: "$4.99", reason: "today only", cta: "Shop now" } };

export function cleanProject(): GateProject {
	return project(
		{
			overlay: [
				track("t-text", "TEXT", "text", [
					text("headline", 0, 3, "Cold brew, no bitterness", { "transform.positionY": -500, fontSize: 2.5 }),
					text("offer", 7, 12, "$4.99 · today only · Shop now", { "transform.positionY": -200 }),
				]),
				track("t-cap", "CAPTIONS", "text", [
					text("cap1", 0, 1, "Smooth", { "transform.positionY": 300 }),
					text("cap2", 1, 2, "and cold", { "transform.positionY": 300 }),
				]),
			],
			main: track("t-main", "V1 A-ROLL", "video", [
				video("S01", 0, 1),
				video("S02", 1, 2),
				video("S03", 2, 3),
				video("S04", 3, 5),
				video("S05", 5, 7),
				video("S06", 7, 9),
				video("S07", 9, 11),
				video("S08", 11, 12),
			]),
			audio: [track("t-music", "MUSIC", "audio", [audio("bed", 0, 12)]), track("t-sfx", "SFX", "audio", [])],
		},
		{ brief: BRIEF, board: { music: { hits: [{ t: 3, what: "drop", shot: "S04" }] } } },
	);
}

/**
 * One planted defect per check:
 * SAFE     "top-text" sits at y ≈ 30 px (above the 220 px line)
 * CAP-LEN  "cap-long" is 6 words
 * R3       the only headline starts at 1.0 s
 * R15      no offer card in the last 6 s (the brief has a verified offer)
 * R1       one shot in 0–3 s
 * R5       S02 holds 4 s (and the median is 3 s)
 * R6       10–20 s has 3 shots
 * R12      music covers 0.5–10 of 20 s
 * R23      S03 (7–8 s) has its sound off and no SFX
 * R4       nothing at 0.0 (music starts at 0.5)
 * R21      the board's hit at 5.0 s lands on no cut
 * CLEAN    a black gap 9.0–9.5 s; S06 is 0.6 s shorter than its slot (media store says so)
 * FORMAT   27 fps
 */
export function defectProject(): GateProject {
	return project(
		{
			overlay: [
				track("t-text", "TEXT", "text", [
					text("late-headline", 1, 4, "Halcyon cold brew", { "transform.positionY": -500 }),
					text("top-text", 5, 6, "Top", { "transform.positionY": -930 }),
				]),
				track("t-cap", "CAPTIONS", "text", [
					text("cap-long", 11, 12, "this caption is far too long", { "transform.positionY": 300 }),
				]),
			],
			main: track("t-main", "V1 A-ROLL", "video", [
				video("S01", 0, 3),
				video("S02", 3, 7),
				video("S03", 7, 8, { isSourceAudioEnabled: false }),
				video("S04", 8, 9),
				video("S05", 9.5, 10),
				video("S06", 10, 13),
				video("S07", 13, 16.5),
				video("S08", 16.5, 20),
			]),
			audio: [track("t-music", "MUSIC", "audio", [audio("bed", 0.5, 10)]), track("t-sfx", "SFX", "audio", [])],
		},
		{ brief: BRIEF, board: { music: { hits: [{ t: 5, what: "drop", shot: "S02" }] } } },
		27,
	);
}

/** Media store facts for defectProject: S06's file is 2.4 s long but sits in a 3 s slot. */
export const DEFECT_MEDIA = { "m-S06": { duration: 2.4 } };
