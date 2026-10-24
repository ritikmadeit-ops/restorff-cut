/**
 * The reducer-perf rewrite (2026-10-20) must not change any result: every case here runs through the frozen
 * pre-rewrite reducer (test/reference/reducer-v0.ts) and the new one, and the two must give byte-identical JSON (or
 * throw the same message). The new one runs as applyWithSelfCheck: after every op its incremental state (undo log,
 * live index, invariant multiset — src/reducer-state.ts) is compared with a rebuild from scratch.
 *
 * Covered here: the bench batches (bench/batches.ts), a kitchen-sink batch with every op kind and conflicts mixed in
 * (best_effort, atomic, every prefix, snap/at/sceneId options), a 40-round random chain, and broken or JS-aliased
 * input projects. The whole existing suite through both reducers: `bun test --preload ./test/dual-apply.preload.ts`.
 */
import { describe, expect, test } from "bun:test";
import { BATCH_KINDS, buildBatch } from "../bench/batches.ts";
import type { ApplyOptions, Op, Project, TextElement, TimelineElement, TimelineTrack, VideoElement } from "../src/index.ts";
import { applyWithSelfCheck } from "../src/reducer.ts";
import { BatchState } from "../src/reducer-state.ts";
import { checkInvariants } from "../src/scene.ts";
import { fixtureProject, prng, T, TRANSCRIPT } from "./fixture.ts";
import { apply as referenceApply } from "./reference/reducer-v0.ts";
import { checkInvariants as referenceCheckInvariants } from "./reference/scene-v0.ts";

const C = "claude" as const;

function outcome(run: () => unknown): { json?: string; error?: string; value?: unknown } {
	try {
		const value = run();
		return { json: JSON.stringify(value), value };
	} catch (thrown) {
		return { error: thrown instanceof Error ? thrown.message : String(thrown) };
	}
}

/** "" when equal, else where the two JSON strings first differ (a 1 MB toBe diff would be unreadable). */
function difference(a: string | undefined, b: string | undefined): string {
	if (a === b) return "";
	const x = a ?? "<none>";
	const y = b ?? "<none>";
	let i = 0;
	while (i < x.length && i < y.length && x[i] === y[i]) i++;
	return `first difference at char ${i}: old …${x.slice(Math.max(0, i - 120), i + 120)}… new …${y.slice(Math.max(0, i - 120), i + 120)}…`;
}

let compared = 0;

/** Old and new on the same input: same JSON (or same error). Returns the new result. */
function same(project: Project, ops: readonly Op[], options: ApplyOptions) {
	const input = JSON.stringify(project);
	const old = outcome(() => referenceApply(project, ops, options));
	const now = outcome(() => applyWithSelfCheck(project, ops, options));
	expect(JSON.stringify(project)).toBe(input); // neither mutated its input
	expect(now.error).toBe(old.error);
	expect(difference(old.json, now.json)).toBe("");
	compared++;
	const result = now.value as ReturnType<typeof applyWithSelfCheck> | undefined;
	if (result) {
		// the split-up checkInvariants (src/scene.ts) still returns the frozen one's list, in order
		for (const scene of result.project.scenes ?? []) {
			if (!scene?.tracks?.main) continue;
			const media = result.project.metadata.restorff?.media ?? [];
			expect(checkInvariants(scene, media)).toEqual(referenceCheckInvariants(scene, media));
		}
	}
	return result;
}

const statuses = (result: ReturnType<typeof applyWithSelfCheck> | undefined) =>
	result ? result.changes.ops.map((change) => change.status) : [];

// ---------------------------------------------------------------- bench batches

describe("bench batches (bench/batches.ts): old and new give the same JSON", () => {
	for (const kind of BATCH_KINDS) {
		test(`${kind}, ~300 ops: atomic, and best_effort with a conflict planted every 25 ops`, () => {
			const batch = buildBatch(kind, 300);
			expect(same(batch.project, batch.ops, { seed: "equiv" })?.ok).toBe(true);
			// conflicts mid-batch: an op on a missing element, and a duplicate ref, every 25 ops
			const noisy: Op[] = batch.ops.flatMap((op, i) =>
				i % 25 === 12
					? [op, { op: "delete", author: C, el: `missing-${i}` }, { op: "mark", author: C, t: i / 10, note: "x" }]
					: [op],
			);
			const best = same(batch.project, noisy, { seed: "equiv", mode: "best_effort" });
			expect(best?.conflicts.length).toBeGreaterThan(0);
			const atomic = same(batch.project, noisy, { seed: "equiv" });
			expect(atomic?.ok).toBe(false);
		});
	}
});

// ---------------------------------------------------------------- every op kind

const W = (text: string, start: number, end: number) => ({ text, start, end });

/** Every op kind against the Halcyon fixture, with conflicts mixed in (comments say which ones fail). */
const SINK: Op[] = [
	{ op: "set_canvas", author: C, w: 1080, h: 1920, fps: 30, background: "#101010" },
	{ op: "import_media", author: C, kind: "video", blob_sha: "sha-halcyon-pour-2", duration: 6, has_audio: false, ref: "pour2" },
	{ op: "import_media", author: C, kind: "video", blob_sha: "sha-halcyon-pour-2", duration: 6 }, // already there: noop
	{ op: "add_track", author: C, kind: "caption", ref: "cap" },
	{ op: "add_captions", author: C, track: "cap", words: TRANSCRIPT.slice(0, 7), max_words: 2 },
	{ op: "add_captions", author: C, track: "cap", words: [W("again", 1, 1.4)] }, // overlaps a caption: conflict mid-op
	{ op: "add_captions", author: C, words: [W("cold", 1, 2), W("brew", 1.5, 2.5)], max_words: 1 }, // new track, then its own chunks overlap: rolled back
	{ op: "insert", author: C, track: "trk-text", t: 1, text: "COLD", dur: 2, ref: "t1", style: { size: 8, weight: "bold" } },
	{ op: "insert", author: C, track: "trk-text", t: 2, text: "BREW", dur: 2 }, // overlap: conflict
	{ op: "insert", author: C, track: "trk-text", t: 1, text: "DUP", dur: 1, ref: "t1" }, // duplicate ref: conflict
	{ op: "keyframe", author: C, el: "t1", prop: "scale", t: 1, value: 0.8 },
	{ op: "keyframe", author: C, el: "t1", prop: "scale", t: 1.5, value: 1.2, ease: "ease_out" },
	{ op: "keyframe", author: C, el: "t1", prop: "opacity", t: 2.5, value: 0, ease: "hold" },
	{ op: "keyframe", author: C, el: "t1", prop: "crop", t: 1, value: 1 }, // pending
	{ op: "set", author: C, el: "t1", prop: "opacity", value: 0.9 },
	{ op: "set", author: C, el: "t1", prop: "text", value: "   " }, // blank: conflict
	{ op: "text_pop", author: C, t: 4, text: "SMOOTH", ref: "pop" },
	{ op: "text_pop", author: C, t: 4.2, text: "BOLD" }, // finds or makes a free text track
	{ op: "set", author: C, track: "trk-text", prop: "name", value: "TITLES" },
	{ op: "set", author: C, track: "trk-music", prop: "muted", value: true },
	{ op: "set", author: C, track: "trk-text", prop: "hidden", value: true },
	{ op: "set", author: C, track: "trk-music", prop: "hidden", value: true }, // audio can't hide: conflict
	{ op: "split", author: C, el: "el-aroll", t: 8, ref: "r1" },
	{ op: "split", author: C, el: "r1", t: 12, ref: "r2" },
	{ op: "trim", author: C, el: "r2", out: 19 },
	{ op: "transition", author: C, a: "el-aroll", b: "r1", kind: "dissolve", dur: 0.4 },
	{ op: "transition", author: C, a: "r1", b: "r2", kind: "fade", dur: 0.3 },
	{ op: "transition", author: C, a: "r1", b: "r2", kind: "cut" }, // noop
	{ op: "transition", author: C, a: "r1", b: "r2", kind: "morph-cut" }, // unknown kind: pending
	{ op: "move", author: C, el: "el-broll", t: 10 },
	{ op: "move", author: C, el: "el-broll", t: 0, track: "trk-text" }, // video on a text track: conflict
	{ op: "insert", author: C, track: "trk-broll", t: 2, media: "pour2", in: 0, out: 2, ref: "b2" },
	{ op: "insert", author: C, track: "trk-broll", t: 14, media: "media-still", dur: 1.5, ref: "still" },
	{ op: "insert", author: C, track: "trk-broll", t: 20, media: "media-broll", in: 0, out: 9 }, // past the media: conflict
	{ op: "set", author: C, el: "el-broll", prop: "source_audio", value: false },
	{ op: "set", author: C, el: "b2", prop: "source_audio", value: false }, // no audio in that media: conflict
	{ op: "set", author: C, el: "el-broll", prop: "speed", value: 1.5 },
	{ op: "set", author: C, el: "r1", prop: "speed", value: 0.5 }, // grows into r2: overlap conflict
	{ op: "gain", author: C, el: "el-music", db: -3 },
	{ op: "beats", author: C, el: "el-music", bpm: 120, times: [0.5, 1, 1.5, 2, 7.9, 8.1, 11.95, 12.05], downbeats: [0] },
	{ op: "snap_cuts", author: C, track: "main", max_shift: 0.2 },
	{ op: "set", author: C, track: "trk-music", prop: "muted", value: false },
	{ op: "duck", author: C, track: "trk-music", under: "main", amount_db: 10 },
	{ op: "sfx", author: C, t: 3, name: "whoosh" }, // by name: pending
	{ op: "sfx", author: C, t: 3, name: "whoosh", media: "media-whoosh", ref: "fx1" },
	{ op: "sfx", author: C, t: 3.2, name: "whoosh", media: "media-whoosh" }, // overlaps fx1: goes on another SFX track
	{ op: "grade", author: C, target: "el-aroll", preset: "warm" },
	{ op: "grade", author: C, target: "all", preset: "warm" },
	{ op: "grade", author: C, target: "all", preset: "no-such-look" }, // pending
	{ op: "grade", author: C, target: "all", preset: "none" }, // removes the grade layer and its track
	{ op: "grade", author: C, target: "main", preset: "warm" },
	{ op: "mark", author: C, t: 2, note: "hook" },
	{ op: "mark", author: C, t: 2, note: "hook, again", color: "#ff0000" },
	{ op: "normalize", author: C, lufs: -14, true_peak: -1 },
	{ op: "add_size_variant", author: C, aspect: "4:5", reframe: "auto" },
	{ op: "set_caption_style", author: C, style: { size: 6, weight: "bold", uppercase: true } },
	{ op: "apply_style", author: C, preset_id: "restorff/bold-captions" },
	{ op: "apply_style", author: C, preset_id: "restorff/style/talking-head" },
	{ op: "apply_style", author: C, preset_id: "no/such/preset" }, // conflict
	{ op: "add_track", author: C, kind: "overlay", name: "STICKERS", ref: "stk" },
	{ op: "insert", author: C, track: "stk", t: 1, shape: "rectangle", dur: 1 },
	{ op: "remove_track", author: C, track: "stk" },
	{ op: "remove_track", author: C, track: "main" }, // conflict
	{ op: "ripple_delete", author: C, el: "r1", scope: "all" },
	{ op: "ripple_delete", author: C, el: "fx1" },
	{ op: "delete", author: C, el: "el-music" },
	{ op: "delete", author: C, el: "el-music" }, // gone: conflict
	{ op: "split", author: C, el: "el-aroll", t: 0.5, ref: "head" },
	{ op: "keyframe", author: C, el: "head", prop: "x", t: 0.1, value: 40, local: true },
];

describe("every op kind, conflicts mixed in", () => {
	test("best_effort over the kitchen sink", () => {
		const result = same(fixtureProject(), SINK, { seed: "sink", mode: "best_effort" });
		const counts = statuses(result).reduce<Record<string, number>>((all, status) => ({ ...all, [status]: (all[status] ?? 0) + 1 }), {});
		// not vacuous: most ops land, several conflict, some are pending or no-ops
		expect(counts.applied).toBeGreaterThan(35);
		expect(counts.conflict).toBeGreaterThan(8);
		expect(counts.pending).toBeGreaterThan(2);
	});

	test("atomic over the kitchen sink, then over every prefix of it", () => {
		same(fixtureProject(), SINK, { seed: "sink" });
		for (let n = 1; n <= SINK.length; n++) same(fixtureProject(), SINK.slice(0, n), { seed: `prefix-${n}` });
	});

	test("options: snap to frames, a timestamp, an explicit scene", () => {
		same(fixtureProject(), SINK, { seed: "snap", mode: "best_effort", snap: "frame", at: "2026-10-20T12:00:00.000Z" });
		same(fixtureProject(), SINK.slice(0, 30), { seed: "scene", mode: "best_effort", sceneId: "scene-main" });
		same(fixtureProject(), SINK.slice(0, 5), { seed: "scene", sceneId: "no-such-scene" }); // both throw
		same(fixtureProject(), [{ op: "delete", el: "el-music" } as unknown as Op], { seed: "invalid" }); // validator rejects
	});

	test("an op that re-creates an id already in the project fails the invariant check with the same message", () => {
		const first = same(fixtureProject(), [{ op: "split", author: C, el: "el-aroll", t: 4, ref: "r" }], { seed: "s" });
		const again = same(first?.project as Project, [{ op: "split", author: C, el: "el-aroll", t: 2, ref: "r" }], { seed: "s" });
		expect(again?.conflicts[0]?.kind).toBe("invariant");
		expect(again?.conflicts[0]?.message).toContain("duplicate element id");
		same(first?.project as Project, [{ op: "split", author: C, el: "el-aroll", t: 2, ref: "r" }], { seed: "s", mode: "best_effort" });
		// extract → recover → extract again with the same seed: the audio id repeats AFTER the clip was replaced
		const extract: Op[] = [{ op: "set", author: C, el: "el-aroll", prop: "source_audio", value: false }];
		const one = same(fixtureProject(), extract, { seed: "a" });
		const two = same(one?.project as Project, [{ op: "set", author: C, el: "el-aroll", prop: "source_audio", value: true }], { seed: "b" });
		const three = same(two?.project as Project, [...extract, { op: "mark", author: C, t: 1, note: "after" }], { seed: "a", mode: "best_effort" });
		expect(three?.conflicts[0]?.kind).toBe("invariant");
	});
});

// ---------------------------------------------------------------- the state's primitives, rolled back directly

describe("BatchState primitives roll back exactly", () => {
	test("each primitive, alone and all together, then rollback: the scene is byte-identical and the state re-verifies", () => {
		const fresh = () => {
			const project = fixtureProject();
			const scene = project.scenes[0];
			return { project, scene, state: new BatchState(project, scene, project.metadata.restorff?.media) };
		};
		const by = (scene: Project["scenes"][number], id: string) =>
			[...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio].find((track) => track.id === id) as TimelineTrack;
		const steps: Array<(state: BatchState, scene: Project["scenes"][number]) => void> = [
			(state, scene) => state.append(by(scene, "trk-text"), text("n1", T, T)),
			(state, scene) => state.replace(by(scene, "trk-main"), { ...scene.tracks.main.elements[0], name: "renamed" }),
			(state, scene) => state.removeId(by(scene, "trk-broll"), "el-broll"),
			(state, scene) => {
				const aroll = scene.tracks.main.elements[0];
				state.split(by(scene, "trk-main"), aroll.id, { ...aroll, duration: 5 * T }, { ...aroll, id: "right", startTime: 5 * T, duration: 15 * T });
			},
			(state, scene) => state.setAll(by(scene, "trk-text"), Array.from({ length: 40 }, (_, i) => text(`bulk${i}`, i * T, T / 2))),
			(state, scene) => state.mapElements(by(scene, "trk-main"), (element) => ({ ...element, startTime: element.startTime + T })),
			(state, scene) => {
				const before = [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio];
				scene.tracks.audio = scene.tracks.audio.filter((track) => track.id !== "trk-music");
				state.groupsChanged(before, [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]);
			},
			(state, scene) => state.setTrackProp(by(scene, "trk-text"), "name", "TITLES"),
			(state, scene) => state.setTrackProp(by(scene, "trk-text"), "muted", true),
		];
		const runs = [...steps.map((step) => [step]), steps.filter((_, i) => i !== 6)];
		for (const run of runs) {
			const { project, scene, state } = fresh();
			const tracks = scene.tracks;
			const groups = { overlay: [...tracks.overlay], audio: [...tracks.audio] };
			const before = JSON.stringify(project);
			state.begin();
			for (const step of run) step(state, scene);
			expect(JSON.stringify(project)).not.toBe(before);
			state.rollback();
			// the reducer's savepoint restores the group arrays; the primitives restore everything else
			tracks.overlay = groups.overlay;
			tracks.audio = groups.audio;
			expect(JSON.stringify(project)).toBe(before);
			state.verify(project.metadata.restorff?.media);
		}
	});
});

// ---------------------------------------------------------------- random chain

/** A random but mostly-valid batch against the project as it is now (refs defined and used inside the batch). */
function randomBatch(random: () => number, project: Project, size: number): Op[] {
	const pick = <V>(items: readonly V[]): V => items[Math.floor(random() * items.length)];
	const r2 = (value: number) => Math.round(value * 100) / 100;
	const scene = project.scenes[0];
	const tracks: TimelineTrack[] = [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio];
	const elements: TimelineElement[] = tracks.flatMap((track) => [...track.elements]);
	const ids = [...elements.map((element) => element.id), "missing"];
	const refs: string[] = [];
	const ops: Op[] = [];
	for (let i = 0; i < size; i++) {
		const element = elements.length ? pick(elements) : undefined;
		const id = refs.length && random() < 0.3 ? pick(refs) : element && random() < 0.95 ? element.id : pick(ids);
		const start = element ? element.startTime / T : 0;
		const length = element ? element.duration / T : 1;
		const inside = r2(start + 0.05 + random() * Math.max(0, length - 0.1));
		const kind = pick([
			"split", "split", "trim", "move", "keyframe", "keyframe", "insert", "insert", "delete", "ripple", "set", "gain",
			"pop", "mark", "captions", "transition", "grade", "track", "sfx", "speed",
		] as const);
		const ref = `r${i}`;
		if (kind === "split") {
			ops.push({ op: "split", author: C, el: id, t: inside, ref });
			refs.push(ref);
		}
		if (kind === "trim" && element) ops.push({ op: "trim", author: C, el: id, in: r2(element.trimStart / T + random() * length * 0.3), out: r2(element.trimStart / T + length * (0.5 + random() * 0.5)) });
		if (kind === "move") ops.push({ op: "move", author: C, el: id, t: r2(random() * 25), ...(random() < 0.2 ? { track: pick(tracks).id } : {}) });
		if (kind === "keyframe") ops.push({ op: "keyframe", author: C, el: id, prop: pick(["x", "opacity", "scale", "volume"]), t: inside, value: r2(random()), ...(random() < 0.4 ? { ease: pick(["ease_in", "ease_out", "hold", "linear"] as const) } : {}) });
		if (kind === "insert") {
			ops.push(random() < 0.6
				? { op: "insert", author: C, track: pick(["trk-text", "trk-text", "cap"].filter((name) => name !== "cap" || refs.includes("cap"))), t: r2(random() * 25), text: "Halcyon", dur: r2(0.2 + random() * 2), ref }
				: { op: "insert", author: C, track: pick(["trk-broll", "main"]), t: r2(random() * 25), media: "media-broll", in: 0, out: r2(0.5 + random() * 3), ref });
			refs.push(ref);
		}
		if (kind === "delete" && random() < 0.4) ops.push({ op: "delete", author: C, el: id });
		if (kind === "ripple" && random() < 0.4) ops.push({ op: "ripple_delete", author: C, el: id, scope: pick(["track", "all"] as const) });
		if (kind === "set") ops.push({ op: "set", author: C, el: id, prop: pick(["opacity", "x", "name", "hidden", "volume"]), value: pick([0.5, 12, "Halcyon", true]) });
		if (kind === "gain") ops.push({ op: "gain", author: C, el: id, db: r2(-12 + random() * 12) });
		if (kind === "speed") ops.push({ op: "set", author: C, el: id, prop: "speed", value: pick([0.5, 1, 1.5, 2]) });
		if (kind === "pop") ops.push({ op: "text_pop", author: C, t: r2(random() * 20), text: "COLD", dur: r2(0.3 + random()) });
		if (kind === "mark") ops.push({ op: "mark", author: C, t: r2(random() * 20), note: "beat" });
		if (kind === "captions") {
			const at = r2(random() * 18);
			ops.push({ op: "add_captions", author: C, words: [W("cold", at, at + 0.3), W("brew", at + 0.35, at + 0.7)], ...(refs.includes("cap") ? { track: "cap" } : { ref: "cap" }) });
			if (!refs.includes("cap")) refs.push("cap");
		}
		if (kind === "transition" && elements.length > 1) ops.push({ op: "transition", author: C, a: id, b: pick(elements).id, kind: pick(["fade", "dissolve", "cut", "wipe"]), dur: 0.2 });
		if (kind === "grade") ops.push({ op: "grade", author: C, target: pick([id, "main", "all", "all"]), preset: pick(["warm", "none", "cool"]) });
		if (kind === "track" && random() < 0.3) ops.push(random() < 0.5 ? { op: "add_track", author: C, kind: pick(["text", "video", "audio"] as const) } : { op: "remove_track", author: C, track: pick(tracks).id });
		if (kind === "sfx") ops.push({ op: "sfx", author: C, t: r2(random() * 20), name: "whoosh", media: "media-whoosh" });
	}
	return ops;
}

describe("random chain", () => {
	test("40 random batches of 25 ops, alternating best_effort and atomic, each on the last result", () => {
		const random = prng(2026);
		let project = fixtureProject();
		let landed = 0;
		let conflicted = 0;
		for (let round = 0; round < 40; round++) {
			const ops = randomBatch(random, project, 25);
			const mode = round % 2 === 0 ? "best_effort" : "atomic";
			const result = same(project, ops, { seed: `chain-${round}`, mode });
			if (!result) continue;
			landed += result.changes.ops.filter((change) => change.status === "applied").length;
			conflicted += result.conflicts.length;
			project = result.project;
		}
		expect(landed).toBeGreaterThan(150); // not vacuous
		expect(conflicted).toBeGreaterThan(40);
	});
});

// ---------------------------------------------------------------- broken and aliased inputs

const text = (id: string, start: number, duration: number, extra: Partial<TextElement> = {}): TextElement => ({
	id,
	type: "text",
	name: id,
	startTime: start,
	duration,
	trimStart: 0,
	trimEnd: 0,
	params: { content: id, opacity: 1 },
	...extra,
});

const BROKEN: Record<string, () => Project> = {
	"overlapping texts": () => {
		const project = fixtureProject();
		const track = project.scenes[0].tracks.overlay[0] as { elements: TimelineElement[] };
		track.elements = [text("x1", 1 * T, 3 * T), text("x2", 2 * T, 3 * T), text("x3", 10 * T, T)];
		return project;
	},
	"zero-length and fractional elements": () => {
		const project = fixtureProject();
		const track = project.scenes[0].tracks.overlay[0] as { elements: TimelineElement[] };
		track.elements = [text("z0", 1 * T, 0), text("z1", 2.5 * T + 0.5, T), text("z2", 6 * T, -T)];
		return project;
	},
	"duplicate element id on two tracks": () => {
		const project = fixtureProject();
		const broll = project.scenes[0].tracks.overlay[1] as { elements: TimelineElement[] };
		broll.elements = [...broll.elements, { ...(broll.elements[0] as VideoElement), startTime: 12 * T }];
		const text0 = project.scenes[0].tracks.overlay[0] as { elements: TimelineElement[] };
		text0.elements = [text("el-music", 1 * T, T)];
		return project;
	},
	"keyframe past the end, trimmed past the media": () => {
		const project = fixtureProject();
		const aroll = project.scenes[0].tracks.main.elements[0] as VideoElement;
		aroll.animations = { opacity: { keys: [{ id: "k1", time: 0, value: 1, segmentToNext: "linear", tangentMode: "flat" }, { id: "k2", time: 30 * T, value: 0, segmentToNext: "linear", tangentMode: "flat" }] } };
		const broll = project.scenes[0].tracks.overlay[1].elements[0] as VideoElement;
		broll.trimStart = 6 * T;
		return project;
	},
	"audio track in the overlay group, duplicate track id": () => {
		const project = fixtureProject();
		const tracks = project.scenes[0].tracks;
		tracks.overlay = [...tracks.overlay, { ...tracks.audio[1], elements: [] } as unknown as (typeof tracks.overlay)[number]];
		tracks.audio = [...tracks.audio, { id: "trk-music", name: "MUSIC 2", type: "audio", muted: false, elements: [] }];
		return project;
	},
	"no restorff metadata at all": () => {
		const project = fixtureProject();
		delete (project.metadata as { restorff?: unknown }).restorff;
		return project;
	},
	"one elements array shared by two tracks (JS-built)": () => {
		const project = fixtureProject();
		const tracks = project.scenes[0].tracks;
		const shared = (tracks.overlay[0] as { elements: TextElement[] }).elements;
		shared.push(text("s1", 1 * T, T));
		tracks.overlay = [...tracks.overlay, { id: "trk-text-2", name: "TEXT 2", type: "text", hidden: false, elements: shared }];
		return project;
	},
	"one element object on two tracks (JS-built)": () => {
		const project = fixtureProject();
		const tracks = project.scenes[0].tracks;
		const shared = text("same", 1 * T, T);
		(tracks.overlay[0] as { elements: TimelineElement[] }).elements = [shared];
		tracks.overlay = [...tracks.overlay, { id: "trk-text-2", name: "TEXT 2", type: "text", hidden: false, elements: [shared] }];
		return project;
	},
	"one track object twice (JS-built)": () => {
		const project = fixtureProject();
		const tracks = project.scenes[0].tracks;
		tracks.overlay = [...tracks.overlay, tracks.overlay[0]];
		return project;
	},
};

const ON_BROKEN: Op[] = [
	{ op: "insert", author: C, track: "trk-text", t: 15, text: "LATE", dur: 1, ref: "late" },
	{ op: "insert", author: C, track: "trk-text", t: 2.2, text: "MIDDLE", dur: 0.5 },
	{ op: "keyframe", author: C, el: "late", prop: "scale", t: 15.5, value: 1.2 },
	{ op: "split", author: C, el: "el-aroll", t: 6, ref: "r" },
	{ op: "move", author: C, el: "el-broll", t: 13 },
	{ op: "delete", author: C, el: "el-music" },
	{ op: "set", author: C, el: "x2", prop: "opacity", value: 0.4 },
	{ op: "delete", author: C, el: "x2" },
	{ op: "delete", author: C, el: "z0" },
	{ op: "trim", author: C, el: "el-broll", in: 0, out: 2 },
	{ op: "ripple_delete", author: C, el: "r", scope: "all" },
	{ op: "sfx", author: C, t: 1, name: "whoosh" },
	{ op: "import_media", author: C, kind: "audio", url: "https://example.invalid/halcyon-bed-2.mp3", duration: 30 },
	{ op: "add_captions", author: C, words: TRANSCRIPT.slice(0, 4) },
	{ op: "set", author: C, el: "same", prop: "opacity", value: 0.5 },
	{ op: "remove_track", author: C, track: "trk-sfx" },
	{ op: "grade", author: C, target: "all", preset: "warm" },
];

describe("broken and aliased input projects", () => {
	for (const [name, build] of Object.entries(BROKEN)) {
		test(name, () => {
			same(build(), ON_BROKEN, { seed: "broken", mode: "best_effort" });
			same(build(), ON_BROKEN, { seed: "broken" });
			for (let n = 1; n <= ON_BROKEN.length; n += 4) same(build(), ON_BROKEN.slice(0, n), { seed: `broken-${n}` });
			const random = prng(name.length);
			let project = build();
			for (let round = 0; round < 6; round++) {
				const result = same(project, randomBatch(random, project, 15), { seed: `broken-chain-${round}`, mode: "best_effort" });
				if (result) project = result.project;
			}
		});
	}

	test(`compared ${"old vs new"} on every case above`, () => {
		expect(compared).toBeGreaterThan(200);
	});
});
