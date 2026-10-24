/**
 * sound-voice-v2 (2026-10-20): the pure halves of sounds design v2 (real cuts, loop seams, hits on the cut, composition
 * cues, covered text pops), batch place, loop-to-bars, the seamless envelope, and voice tightening / fitting maths.
 * Checked against the REAL SFX manifest (sounds worklog rule: a planner is tested on the real library file).
 * The live path (MCP → commit → render → onsets vs cuts) is measured in docs/restorff/worklog/sound-voice-v2.md.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { apply, type Project } from "@restorffcut/timeline-ops";
import { type MusicBed, planBed, planMusicEnvelope, snapToBars, tagBed } from "@/server/music-plan";
import { designSoundOnSnapshotV2, type PackSound, planPlaceSounds, type SfxPack } from "@/server/sound-design";
import { collectCompositionCues } from "@/server/sound-design-cues";
import { findRealCuts, planSoundDesignV2, type TimelineCue } from "@/server/sound-design-plan";
import { pauseCuts, sapiSpeedFor, shiftTime, shiftWords, speechShare } from "@/server/voice-tighten";

const T = 120_000;
const NOW = "2026-10-20T09:00:00.000Z";
const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "..", "..", "public", "sfx", "manifest.json"), "utf8")) as { sounds: PackSound[] };
const PACK: SfxPack = { pack: "restorff-core", version: "test", licence: "generated, ours", sounds: manifest.sounds.map((sound) => ({ ...sound, tags: sound.tags ?? [] })) };
const sync = (id: string) => PACK.sounds.find((sound) => sound.id === id)?.sync_s ?? Number.NaN;

const video = (id: string, name: string, media: string, t: number, dur: number, extra: Record<string, unknown> = {}) => ({
	id,
	type: "video",
	name,
	mediaId: media,
	startTime: Math.round(t * T),
	duration: Math.round(dur * T),
	trimStart: 0,
	trimEnd: 0,
	sourceDuration: Math.round(dur * T),
	hidden: false,
	params: { volume: 0, muted: false, opacity: 1 },
	...extra,
});

/**
 * Fictional Halcyon timeline: V1 = a (0–3) | b (3–6) | c (6–9); PAPER = one 2 s grain ×4 at 30 % (seams 2, 4, 6);
 * MOTION = a full-frame composition 9–13 (scene cuts inside at +1.5, +3.0; a stamp at +3.5) and a graphic stamp at
 * 4.5; TEXT = a title 0.25 s after the 3.0 cut and one at 7.5 (away from cuts); MUSIC + SFX lanes.
 */
function halcyon(): Project {
	const paper = [0, 2, 4, 6].map((t, i) => video(`el-paper-${i}`, "Paper texture", "media-paper", t, 2, { params: { volume: 0, muted: false, opacity: 0.3 } }));
	return {
		metadata: { id: "proj-sv2", name: "Halcyon Cold Brew / sound-voice-v2", duration: 13 * T, createdAt: NOW, updatedAt: NOW, restorff: { opsVersion: "ops@1", pending: [], media: [] } },
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [
						{ id: "trk-text", name: "TEXT", type: "text", muted: false, hidden: false, elements: [
							{ id: "el-title", type: "text", name: "Title", startTime: Math.round(3.25 * T), duration: Math.round(1.5 * T), trimStart: 0, trimEnd: 0, hidden: false, params: { content: "STEEPED 18 HOURS" } },
							{ id: "el-note", type: "text", name: "Note", startTime: Math.round(7.5 * T), duration: T, trimStart: 0, trimEnd: 0, hidden: false, params: { content: "NO SUGAR" } },
						] },
						{ id: "trk-motion", name: "MOTION", type: "video", muted: false, hidden: false, elements: [
							video("el-stamp", "Rubber stamp", "media-stamp", 4.5, 1.5, { restorff: { composition: { name: "stamp", hash: "aa", duration: 1.5 } } }),
							video("el-scenes", "Halcyon three scenes", "media-scenes", 9, 4, { restorff: { composition: { name: "halcyon-three-scenes", hash: "bb", custom: true, duration: 4 } } }),
						] },
						{ id: "trk-paper", name: "PAPER", type: "video", muted: false, hidden: false, elements: paper },
					],
					main: { id: "trk-main", name: "V1 A-ROLL", type: "video", muted: false, hidden: false, elements: [video("el-a", "halcyon-a.mp4", "media-a", 0, 3), video("el-b", "halcyon-b.mp4", "media-b", 3, 3), video("el-c", "halcyon-c.mp4", "media-c", 6, 3)] },
					audio: [
						{ id: "trk-music", name: "MUSIC", type: "audio", muted: false, elements: [], restorff: { role: "music" } },
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

const FULL = { "el-scenes": true, "el-stamp": false };
const CUES: TimelineCue[] = [
	{ t: 10.5, kind: "cut", label: "Halcyon three scenes: scene 2", source: "manifest", element: "el-scenes" },
	{ t: 12, kind: "cut", label: "Halcyon three scenes: scene 3", source: "manifest", element: "el-scenes" },
	{ t: 12.5, kind: "stamp", label: "Halcyon three scenes: 18 H", source: "manifest", element: "el-scenes" },
	{ t: 4.6, kind: "stamp", label: "Rubber stamp: lands", source: "frames", element: "el-stamp" },
];

describe("sounds design v2", () => {
	test("loop seams, texture overlays and graphics are not cuts; real cuts are", () => {
		const project = halcyon();
		const { cuts, skipped, appears } = findRealCuts(project.scenes[0], 13, FULL);
		expect(cuts.map((cut) => cut.time)).toEqual([3, 6, 9]);
		expect(skipped.map((edge) => edge.t)).toEqual([2, 4, 6]);
		expect(skipped.every((edge) => /texture overlay/.test(edge.reason))).toBe(true);
		expect(appears.map((a) => a.time)).toEqual([4.5]);
	});

	test("a clip repeated back to back at full opacity is a loop seam; a split of one shot is not a cut; a jump cut is", () => {
		const project = halcyon();
		const scene = project.scenes[0];
		const broll = { id: "trk-broll", name: "V2 B-ROLL", type: "video", muted: false, hidden: false, elements: [video("el-l1", "Steam loop", "media-steam", 1, 1), video("el-l2", "Steam loop", "media-steam", 2, 1)] };
		scene.tracks.overlay.push(broll as never);
		// split: el-b2 continues el-b's source (3 s in) → not a cut; el-c becomes a jump cut of the same media
		const main = scene.tracks.main.elements as unknown as Array<Record<string, unknown>>;
		main[1] = video("el-b", "halcyon-b.mp4", "media-b", 3, 1.5);
		main.splice(2, 0, { ...video("el-b2", "halcyon-b.mp4", "media-b", 4.5, 1.5), trimStart: Math.round(1.5 * T) });
		main[3] = { ...video("el-c", "halcyon-b.mp4", "media-b", 6, 3), trimStart: Math.round(5 * T) };
		const { cuts, skipped } = findRealCuts(scene, 13, FULL);
		// 1 = the steam loop in, 3 = its run ends (with the main cut), 6 = the jump cut inside media-b, 9 = the composition
		expect(cuts.map((cut) => cut.time)).toEqual([1, 3, 6, 9]);
		expect(skipped.some((edge) => edge.t === 2 && /loop seam of "Steam loop"/.test(edge.reason))).toBe(true);
		expect(skipped.some((edge) => edge.t === 4.5 && /carries on the same shot/.test(edge.reason))).toBe(true);
	});

	test("hits land ON the cut, cues map to their sounds, the late text pop is covered, nothing on seams", () => {
		const plan = planSoundDesignV2(halcyon(), PACK.sounds, CUES, FULL, {});
		const events = plan.placed.map((item) => item.event);
		for (const cut of [6, 9, 10.5, 12]) expect(plan.placed.some((item) => Math.abs(item.event - cut) < 1e-6 && item.kind !== "riser")).toBe(true);
		// 3.0 is the hook's end: its hit (onset) is on the cut
		expect(plan.placed.some((item) => item.kind === "hit" && item.event === 3)).toBe(true);
		for (const seam of [2, 4]) expect(events.some((event) => Math.abs(event - seam) < 0.05)).toBe(false);
		expect(plan.placed.find((item) => item.event === 12.5)?.sound).toBe("stamp-slam");
		expect(plan.placed.find((item) => Math.abs(item.event - 4.6) < 1e-6)?.sound).toBe("stamp-slam");
		expect(plan.covered_texts.map((text) => text.t)).toEqual([3.25]);
		expect(plan.placed.some((item) => item.kind === "pop" && item.event === 7.5)).toBe(true);
		// a cut sound's start = event − its sync point (the transient is the sync point)
		const cut6 = plan.placed.find((item) => item.event === 6);
		expect(cut6 && Math.abs(cut6.t - (6 - sync(cut6.sound)))).toBeLessThan(0.002);
		expect(plan.cuts.with_sound).toBe(plan.cuts.times.length);
		expect(plan.palette).toBe("paper");
	});

	test("options: no cut sounds, no cues, a forced palette", () => {
		const quiet = planSoundDesignV2(halcyon(), PACK.sounds, CUES, FULL, { whooshOnCuts: false, cues: false, palette: "clean" });
		expect(quiet.placed.some((item) => item.kind === "cut" || item.kind === "cue")).toBe(false);
		const clean = planSoundDesignV2(halcyon(), PACK.sounds, CUES, FULL, { palette: "clean" });
		expect(clean.placed.filter((item) => item.kind === "cut").every((item) => ["whoosh-hit", "swish-hit"].includes(item.sound))).toBe(true);
	});

	test("a second design replaces the first (no stacking)", () => {
		const once = designSoundOnSnapshotV2(halcyon(), PACK, "seed-1", {}, CUES, FULL);
		const count = (project: Project) => project.scenes[0].tracks.audio.flatMap((track) => track.elements).filter((element) => /^SFX /.test(element.name)).length;
		const first = count(once.project as Project);
		const twice = designSoundOnSnapshotV2(once.project as Project, PACK, "seed-2", {}, CUES, FULL);
		expect(twice.replaced).toBe(first);
		expect(count(twice.project as Project)).toBe(first);
	});

	test("manifest cues of a custom composition come back in timeline seconds, ÷ speed", async () => {
		const project = halcyon();
		const scenes = project.scenes[0].tracks.overlay[1].elements[1] as unknown as { restorff: { composition: Record<string, unknown> } };
		scenes.restorff.composition.source = `<script type="application/json" id="params">${JSON.stringify({ name: "halcyon-three-scenes", params: { speed: { type: "number", default: 1 } }, cues: [{ t: 1.5, kind: "cut" }, { t: 3, kind: "stamp", label: "18 H" }, { from_end: 0.5, kind: "tape-stop" }] })}</script>`;
		scenes.restorff.composition.props = { speed: 1.5 };
		const collected = await collectCompositionCues(project, { frames: false });
		const mine = collected.cues.filter((cue) => cue.element === "el-scenes");
		expect(mine.map((cue) => [cue.t, cue.kind])).toEqual([
			[10, "cut"],
			[11, "stamp"],
			[12.5, "tape-stop"],
		]);
		expect(collected.clips.find((clip) => clip.element === "el-scenes")?.source).toBe("manifest");
	});
});

describe("sounds place {items}", () => {
	test("many sounds, one batch: overlapping ones get a second lane, refs line up", () => {
		const project = halcyon();
		const find = (id: string) => PACK.sounds.find((sound) => sound.id === id) as PackSound;
		const plan = planPlaceSounds(project, [
			{ sound: find("stamp-slam"), event: 1.1, why: "stamp" },
			{ sound: find("whoosh-hit"), event: 1.0, why: "cut" },
			{ sound: find("pop"), event: 3, why: "title" },
		]);
		expect(plan.ops.filter((op) => op.op === "add_track")).toHaveLength(1);
		const result = apply(project, plan.ops, { seed: "batch", at: NOW });
		expect(result.ok).toBe(true);
		const placed = result.project.scenes[0].tracks.audio.flatMap((track) => track.elements);
		expect(placed).toHaveLength(3);
		expect(plan.items.map((item) => item.sound)).toEqual(["stamp-slam", "whoosh-hit", "pop"]);
		expect(plan.items[1].event).toBe(1);
	});
});

describe("music loop: true", () => {
	const BED: MusicBed = { id: "tense-100", name: "Countdown", mood: "tense", url: "/music/tense-100.ogg", bpm: 100, bars: 8, duration_s: 19.2, beat_times_s: Array.from({ length: 32 }, (_, i) => Math.round(i * 0.6 * 1000) / 1000), downbeats: [0, 4, 8, 12, 16, 20, 24, 28], lufs_i: -18 };

	test("snap to whole bars (neon-grid G-9: 38.0 s at 100 BPM → 16 bars = 38.4 s)", () => {
		const snap = snapToBars(BED, 38);
		expect(snap.bars).toBe(16);
		expect(snap.length_s).toBe(38.4);
		expect(snap.options.map((o) => o.bars)).toEqual([15, 16]);
		expect(snapToBars(BED, 10.5)).toMatchObject({ bars: 4, length_s: 9.6, delta_s: -0.9 });
		expect(snapToBars(BED, 9.6).options).toHaveLength(1);
	});

	test("a seamless bed gets no fade in or out; a normal one does", () => {
		for (const seamless of [false, true]) {
			const project = halcyon();
			const plan = planBed(project, BED, { t: 0, duration: 9.6 });
			const placed = apply(project, plan.ops, { seed: "bed", at: NOW });
			const ids = tagBed(placed.project, plan, placed.changes.refs, BED, { level: "auto", duckDb: 10, seamless });
			const env = planMusicEnvelope(placed.project);
			const keys = env.ops.filter((op) => op.op === "keyframe");
			if (seamless) expect(keys).toHaveLength(0);
			else expect(keys.some((op) => (op as { value: number }).value === -60)).toBe(true);
			expect(ids).toHaveLength(1);
		}
	});
});

describe("voice pacing", () => {
	const words = [
		{ text: "Cold", start: 0.1, end: 0.4 },
		{ text: "water.", start: 0.42, end: 0.8 },
		{ text: "Ground", start: 1.6, end: 1.9 },
		{ text: "beans.", start: 1.95, end: 2.3 },
	];

	test("pauses over 0.35 s are cut to 0.2 s from their middle; words shift by what was removed", () => {
		const cuts = pauseCuts(words, 0.35, 0.2);
		expect(cuts).toEqual([[0.9, 1.5]]);
		expect(shiftTime(1.6, cuts)).toBe(1);
		expect(shiftTime(1.2, cuts)).toBe(0.9);
		const shifted = shiftWords(words, cuts);
		expect(shifted[2]).toEqual({ text: "Ground", start: 1, end: 1.3 });
		expect(Math.round((shifted[2].start - shifted[1].end) * 1000) / 1000).toBe(0.2);
	});

	test("speech share merges gaps < 0.35 s (the recreations' measure)", () => {
		const before = speechShare(words, 2.6);
		expect(before.long_pauses).toBe(1);
		expect(before.speech_s).toBe(1.4);
		const after = speechShare(shiftWords(words, pauseCuts(words, 0.35, 0.2)), 2.0);
		expect(after.long_pauses).toBe(0);
		expect(after.share).toBeGreaterThan(before.share);
	});

	test("SAPI speeds move in whole Rate steps (round(10·log3 speed))", () => {
		expect(sapiSpeedFor(1)).toBe(1);
		expect(sapiSpeedFor(1.05)).toBe(1.12);
		expect(sapiSpeedFor(1.2)).toBe(1.25);
		expect(sapiSpeedFor(1.3)).toBe(1.39);
		for (const speed of [1.12, 1.25, 1.39, 1.55]) {
			const level = Math.round(10 * (Math.log(speed) / Math.log(3)));
			expect(Math.abs(3 ** (level / 10) - speed)).toBeLessThan(0.01);
		}
	});
});
