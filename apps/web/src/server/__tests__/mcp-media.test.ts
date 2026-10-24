/**
 * mcp-media (2026-10-20): the pure parts of timeline create, media import, links and sound over MCP. The live path
 * (fetch → ffprobe → store → commit) is exercised against the dev server with scripts/mcp-call.ts — runbook in
 * docs/restorff/worklog/mcp-media.md.
 */
import { describe, expect, test } from "bun:test";
import { apply, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import { resolveTrack, withLinks } from "@/mcp/media-tool";
import { parseProbe } from "@/server/media-import";
import { designSoundOnSnapshot, filterSounds, findSound, loadSfxPackFromDisk, planPlaceSound } from "@/server/sound-design";
import { emptyProject, frameRate } from "@/server/timeline-skeleton";
import type { ProjectSnapshot } from "@/sync/snapshot";

const probeJson = (streams: unknown[], format: Record<string, unknown>) => JSON.stringify({ streams, format });

describe("parseProbe", () => {
	test("phone video: rotation swaps width and height, fps from avg_frame_rate, audio found", () => {
		const probe = parseProbe(
			probeJson(
				[
					{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001", side_data_list: [{ rotation: -90 }] },
					{ codec_type: "audio", codec_name: "aac" },
				],
				{ format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.345678" },
			),
		);
		expect(probe).toMatchObject({ kind: "video", width: 1080, height: 1920, fps: 29.97, hasAudio: true, duration: 12.346, rotation: -90 });
	});
	test("png still is an image with no duration", () => {
		const probe = parseProbe(probeJson([{ codec_type: "video", codec_name: "png", width: 1080, height: 1920, nb_frames: "1" }], { format_name: "png_pipe" }));
		expect(probe).toMatchObject({ kind: "image", duration: null, fps: null, hasAudio: false });
	});
	test("wav is audio; cover art in an mp3 is not a picture track", () => {
		expect(parseProbe(probeJson([{ codec_type: "audio", codec_name: "pcm_s16le" }], { format_name: "wav", duration: "6.0" }))).toMatchObject({ kind: "audio", duration: 6 });
		const mp3 = parseProbe(probeJson([{ codec_type: "audio", codec_name: "mp3" }, { codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } }], { format_name: "mp3", duration: "3" }));
		expect(mp3?.kind).toBe("audio");
	});
	test("no streams or bad JSON → null", () => {
		expect(parseProbe(probeJson([], { format_name: "tty" }))).toBeNull();
		expect(parseProbe("not json")).toBeNull();
	});
});

describe("timeline skeleton", () => {
	test("named lanes, aspect sizes, NTSC rates", () => {
		const project = emptyProject({ id: "t1", name: "Halcyon test", aspect: "16:9", fps: 29.97 });
		const tracks = project.scenes[0].tracks;
		expect(tracks?.overlay?.map((track) => track.name)).toEqual(["TEXT", "CAPTIONS", "V2 B-ROLL"]);
		expect(tracks?.main?.name).toBe("V1 A-ROLL");
		expect(tracks?.audio?.map((track) => track.name)).toEqual(["MUSIC", "SFX"]);
		expect(project.settings?.canvasSize).toEqual({ width: 1920, height: 1080 });
		expect(frameRate(29.97)).toEqual({ numerator: 30000, denominator: 1001 });
		expect(frameRate(30)).toEqual({ numerator: 30, denominator: 1 });
	});
	test("the reducer accepts it (version, scenes, lanes)", () => {
		const project = emptyProject({ id: "t2", name: "Halcyon test" }) as unknown as OpsProject;
		const result = apply(project, [{ op: "add_track", author: "claude", kind: "audio", name: "VOICE" }] as Op[], { seed: "skeleton" });
		expect(result.ok).toBe(true);
	});
});

describe("resolveTrack", () => {
	const project = emptyProject({ id: "t3", name: "Halcyon test" });
	test.each([
		["V1", "trk-main"],
		["main", "trk-main"],
		["a-roll", "trk-main"],
		["V2", "trk-broll"],
		["B-ROLL", "trk-broll"],
		["music", "trk-music"],
		["SFX", "trk-sfx"],
		["text", "trk-text"],
		["captions", "trk-captions"],
		["trk-sfx", "trk-sfx"],
	])("%s → %s", (wanted, id) => {
		expect(resolveTrack(project, wanted)?.track.id).toBe(id);
	});
	test("unknown lane → null", () => {
		expect(resolveTrack(project, "V9")).toBeNull();
	});
});

describe("withLinks", () => {
	const request = new Request("http://localhost:8791/api/mcp");
	test("adds editor_url before next, from the payload's timeline id or the args", () => {
		const out = withLinks({ commit_id: "c1", next: { do: "x" } }, { timeline_id: "abc" }, request);
		expect(out.editor_url).toBe("http://localhost:8791/editor/abc");
		expect(Object.keys(out).at(-1)).toBe("next");
	});
	test("leaves results without a timeline alone", () => {
		expect(withLinks({ timelines: [] }, { action: "list" }, request).editor_url).toBeUndefined();
	});
});

describe("sound pack + placement", async () => {
	const pack = await loadSfxPackFromDisk();
	test("the pack loads from public/sfx", () => {
		expect(pack.sounds.length).toBeGreaterThanOrEqual(20);
		expect(findSound(pack, "whoosh-short")?.id).toBe("whoosh-short");
		expect(findSound(pack, "paper")?.id).toBe("paper-rustle");
		expect(filterSounds(pack, { tag: "riser" }).every((sound) => sound.tags.includes("riser") || sound.roles.includes("riser"))).toBe(true);
	});
	test("place puts the sound's event on the time, on the SFX lane", () => {
		const project = emptyProject({ id: "t4", name: "Halcyon test" }) as unknown as OpsProject;
		const whoosh = findSound(pack, "whoosh-short");
		if (!whoosh) throw new Error("no whoosh-short");
		const plan = planPlaceSound(project, whoosh, 2);
		expect(plan.event).toBeCloseTo(2, 3);
		expect(plan.lane).toEqual({ id: "trk-sfx", created: false });
		const result = apply(project, plan.ops, { seed: "place" });
		expect(result.ok).toBe(true);
	});
	// the cut at 4 s is the hook's end (a hit wins there by the 0.25 s rule); the cut at 8 s gets the whoosh
	test("design on two cuts with a text: hit at 0, whoosh on a cut, pop on the text; a second run replaces", () => {
		const base = emptyProject({ id: "t5", name: "Halcyon test" }) as unknown as OpsProject;
		const clip = (ref: string) => ({ op: "import_media", author: "claude", kind: "video", name: `${ref}.mp4`, blob_sha: ref, duration: 4, width: 1080, height: 1920, fps: 30, ref });
		const built = apply(
			base,
			[
				clip("a"),
				clip("b"),
				clip("c"),
				{ op: "insert", author: "claude", track: "main", t: 0, media: "a", in: 0, out: 4 },
				{ op: "insert", author: "claude", track: "main", t: 4, media: "b", in: 0, out: 4 },
				{ op: "insert", author: "claude", track: "main", t: 8, media: "c", in: 0, out: 4 },
				{ op: "insert", author: "claude", track: "trk-text", t: 10, text: "Halcyon", dur: 1.5 },
			] as Op[],
			{ seed: "design-base" },
		);
		expect(built.ok).toBe(true);
		const first = designSoundOnSnapshot(built.project, pack, "design-1");
		const kinds = first.placed.map((item) => item.kind);
		expect(kinds).toContain("hit");
		expect(kinds).toContain("whoosh");
		expect(kinds).toContain("pop");
		expect(first.placed.find((item) => item.kind === "hit")?.event).toBe(0);
		expect(first.skipped).toEqual([]);
		const second = designSoundOnSnapshot(first.project, pack, "design-2");
		expect(second.replaced).toBe(first.placed.length);
		const sfxCount = (project: OpsProject) =>
			project.scenes[0].tracks.audio.reduce((sum, track) => sum + track.elements.filter((element) => element.name.startsWith("SFX ")).length, 0);
		expect(sfxCount(second.project)).toBe(first.placed.length);
	});
});

// keep the ProjectSnapshot import honest: the skeleton is a snapshot the store accepts
const _typecheck: ProjectSnapshot = emptyProject({ id: "t6", name: "x" });
void _typecheck;
