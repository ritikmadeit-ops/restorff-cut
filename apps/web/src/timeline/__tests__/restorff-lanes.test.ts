import { describe, expect, test } from "bun:test";
import type { SceneTracks } from "@/timeline";
import { createRestorffLaneKeeper, getRestorffLane } from "@/timeline/restorff-lanes";

type AnyTrack = Record<string, unknown> & { id: string; type: string; name: string; elements: unknown[] };

function track(id: string, type: string, name: string, elements: unknown[] = [], restorff?: object): AnyTrack {
	return { id, type, name, elements, hidden: false, muted: false, ...(restorff ? { restorff } : {}) };
}

/** The editor's cleanup rule (core/index.ts): keep a track with elements, or the one empty track holding a lane. */
function prune(tracks: SceneTracks): string[] {
	const keep = createRestorffLaneKeeper();
	return [...tracks.overlay, ...tracks.audio]
		.filter((t) => t.elements.length > 0 || keep(t, tracks))
		.map((t) => t.name);
}

function scene(overlay: AnyTrack[], audio: AnyTrack[]): SceneTracks {
	return { overlay, main: track("trk-main", "video", "V1 A-ROLL"), audio } as unknown as SceneTracks;
}

describe("Restorff fixed lanes", () => {
	test("the gateway skeleton's empty lanes all survive the cleanup", () => {
		const tracks = scene(
			[track("trk-text", "text", "TEXT"), track("trk-captions", "text", "CAPTIONS"), track("trk-broll", "video", "V2 B-ROLL")],
			[track("trk-music", "audio", "MUSIC"), track("trk-sfx", "audio", "SFX", [], { role: "sfx" })],
		);
		expect(prune(tracks)).toEqual(["TEXT", "CAPTIONS", "V2 B-ROLL", "MUSIC", "SFX"]);
	});

	test("other empty tracks and empty duplicates of a held lane are still removed", () => {
		const tracks = scene(
			[
				track("t1", "text", "TEXT", [{ id: "e1" }]),
				track("t2", "text", "TEXT"),
				track("v3", "video", "V3"),
				track("g", "graphic", "GRAPHICS"),
				track("cw", "text", "CAPTION WORDS"),
			],
			[track("a3", "audio", "AUDIO 3"), track("m", "audio", "MUSIC")],
		);
		expect(prune(tracks)).toEqual(["TEXT", "MUSIC"]);
	});

	test("the exact lane name wins over a role-only match", () => {
		const tracks = scene(
			[track("base", "text", "Subtitles", [], { role: "caption" }), track("cap", "text", "CAPTIONS")],
			[],
		);
		expect(prune(tracks)).toEqual(["CAPTIONS"]);
	});

	test("lanes come from the ops@1 role tag first, then the name", () => {
		expect(getRestorffLane({ id: "x", type: "audio", name: "Pour hits", restorff: { role: "sfx" } })).toBe("SFX");
		expect(getRestorffLane({ id: "x", type: "audio", name: "music" })).toBe("MUSIC");
		expect(getRestorffLane({ id: "x", type: "video", name: "V3" })).toBeNull();
		expect(getRestorffLane({ id: "x", type: "text", name: "TEXT 2" })).toBeNull();
	});
});
