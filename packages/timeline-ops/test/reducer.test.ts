import { describe, expect, test } from "bun:test";
import { apply, type AudioElement, type Op, type ScalarChannel, type TextElement, type VideoElement } from "../src/index.ts";
import { fixtureProject, T } from "./fixture.ts";
import { el, run, scene, track, trackOf } from "./helpers.ts";

const C = "claude" as const;

describe("purity and determinism", () => {
	test("never mutates the input project", () => {
		const input = fixtureProject();
		const before = JSON.stringify(input);
		apply(input, [{ op: "split", author: C, el: "el-aroll", t: 8 }, { op: "delete", author: C, el: "el-music" }], { seed: "s" });
		expect(JSON.stringify(input)).toBe(before);
	});

	test("same project + ops + seed gives identical output; another seed gives other ids", () => {
		const ops: Op[] = [
			{ op: "split", author: C, el: "el-aroll", t: 8, ref: "right" },
			{ op: "add_captions", author: C, words: [{ text: "Halcyon", start: 0.5, end: 0.9 }] },
		];
		const a = run(ops);
		const b = run(ops);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		const c = run(ops, { seed: "other" });
		expect(c.changes.refs.right).not.toBe(a.changes.refs.right);
		expect(a.changes.refs.right).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	test("timestamps only change when `at` is given", () => {
		const ops: Op[] = [{ op: "delete", author: C, el: "el-music" }];
		expect(run(ops).project.metadata.updatedAt).toBe("2026-10-20T09:00:00.000Z");
		const stamped = run(ops, { at: "2026-10-20T12:00:00.000Z" }).project;
		expect(stamped.metadata.updatedAt).toBe("2026-10-20T12:00:00.000Z");
		expect(scene(stamped).updatedAt).toBe("2026-10-20T12:00:00.000Z");
	});

	test("metadata.duration follows the timeline", () => {
		const result = run([
			{ op: "delete", author: C, el: "el-music" },
			{ op: "trim", author: C, el: "el-aroll", out: 10 },
		]);
		expect(result.project.metadata.duration).toBe(10 * T);
	});
});

describe("batch modes", () => {
	const overlapping: Op[] = [
		{ op: "insert", author: C, track: "trk-text", t: 1, text: "COLD", dur: 2 },
		{ op: "insert", author: C, track: "trk-text", t: 2, text: "BREW", dur: 2 },
		{ op: "insert", author: C, track: "trk-text", t: 5, text: "NOW", dur: 1 },
	];

	test("atomic (default): a conflict leaves the project untouched and reports where", () => {
		const result = run(overlapping);
		expect(result.ok).toBe(false);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]).toMatchObject({ index: "1", op: "insert", kind: "overlap" });
		expect(result.changes.ops.map((change) => change.status)).toEqual(["rolled_back", "conflict", "skipped"]);
		expect(result.changes.applied).toEqual([]);
		expect(JSON.stringify(result.project)).toBe(JSON.stringify(fixtureProject()));
	});

	test("best_effort: skips the conflicting op and keeps going", () => {
		const result = run(overlapping, { mode: "best_effort" });
		expect(result.ok).toBe(false);
		expect(track(result.project, "trk-text").elements.map((e) => (e as TextElement).params.content)).toEqual(["COLD", "NOW"]);
		expect(result.changes.applied).toHaveLength(2);
	});

	test("an invalid op rejects the whole batch before anything runs", () => {
		const result = run([
			{ op: "delete", author: C, el: "el-music" },
			{ op: "delete", el: "el-aroll" } as unknown as Op,
		]);
		expect(result.ok).toBe(false);
		expect(result.conflicts[0]).toMatchObject({ index: "1", kind: "invalid_op" });
		expect(el(result.project, "el-music")).toBeDefined();
	});

	test("a missing target is a conflict, not a crash", () => {
		const result = run([{ op: "move", author: C, el: "el-nope", t: 1 }]);
		expect(result.conflicts[0]).toMatchObject({ kind: "missing_target", target: "el-nope" });
	});

	test("refs are unique per batch", () => {
		const result = run([
			{ op: "add_track", author: C, kind: "text", ref: "x" },
			{ op: "add_track", author: C, kind: "text", ref: "x" },
		]);
		expect(result.conflicts[0].kind).toBe("duplicate_ref");
	});
});

describe("canvas", () => {
	test("set_canvas sets size, fps (float → exact rational) and background", () => {
		const { project, ok } = run([{ op: "set_canvas", author: C, w: 1080, h: 1350, fps: 29.97, background: "#16161A" }]);
		expect(ok).toBe(true);
		expect(project.settings.canvasSize).toEqual({ width: 1080, height: 1350 });
		expect(project.settings.fps).toEqual({ numerator: 30000, denominator: 1001 });
		expect(project.settings.background).toEqual({ type: "color", color: "#16161A" });
	});

	test("set_canvas refuses a frame rate with a non-integer tick count per frame", () => {
		const result = run([{ op: "set_canvas", author: C, fps: { numerator: 7, denominator: 3 } }]);
		expect(result.conflicts[0].kind).toBe("out_of_range");
	});

	test("add_size_variant is a recorded no-op: pending in metadata, reported unsupported", () => {
		const result = run([{ op: "add_size_variant", author: C, aspect: "4:5", reframe: "auto" }]);
		expect(result.ok).toBe(true);
		expect(result.changes.ops[0].status).toBe("pending");
		expect(result.changes.unsupported[0]).toMatchObject({ op: "add_size_variant", honouredBy: "variant-compiler" });
		const pending = result.project.metadata.restorff?.pending ?? [];
		expect(pending).toHaveLength(1);
		expect(pending[0].op).toMatchObject({ op: "add_size_variant", aspect: "4:5" });
		expect(pending[0].id).toBe(result.changes.unsupported[0].pendingId);
	});
});

describe("media", () => {
	test("import_media adds a manifest entry; a ref resolves it; a repeat import is a no-op", () => {
		const result = run([
			{ op: "import_media", author: C, kind: "video", blob_sha: "sha-pour-2", duration: 6.5, ref: "pour" },
			{ op: "import_media", author: C, kind: "video", blob_sha: "sha-pour-2", ref: "pour-again" },
			{ op: "insert", author: C, track: "trk-broll", t: 10, media: "pour", in: 0, out: 2 },
		]);
		expect(result.ok).toBe(true);
		const media = result.project.metadata.restorff?.media ?? [];
		const entry = media.find((m) => m.blobSha === "sha-pour-2");
		expect(entry?.duration).toBe(6.5 * T);
		expect(result.changes.refs["pour-again"]).toBe(result.changes.refs.pour);
		expect(result.changes.ops[1].status).toBe("noop");
		const inserted = track(result.project, "trk-broll").elements[1] as VideoElement;
		expect(inserted.mediaId).toBe(entry?.id as string);
		expect(inserted.sourceDuration).toBe(6.5 * T);
	});
});

describe("tracks", () => {
	test("add_track: caption on top, video just above main, audio at the bottom, overlay = graphic", () => {
		const { project } = run([
			{ op: "add_track", author: C, kind: "caption", ref: "cap" },
			{ op: "add_track", author: C, kind: "video", name: "V3" },
			{ op: "add_track", author: C, kind: "audio", name: "VO" },
			{ op: "add_track", author: C, kind: "overlay", name: "Stickers", index: 1 },
		]);
		const tracks = scene(project).tracks;
		expect(tracks.overlay.map((t) => t.name)).toEqual(["CAPTIONS", "Stickers", "TEXT", "V2 B-ROLL", "V3"]);
		expect(tracks.overlay[0]).toMatchObject({ type: "text", restorff: { role: "caption", createdBy: "claude" } });
		expect(tracks.overlay[1].type).toBe("graphic");
		expect(tracks.audio.map((t) => t.name)).toEqual(["MUSIC", "SFX", "VO"]);
	});

	test("unnamed tracks get the editor's artboard names (timeline/tracks.ts getDefaultTrackName)", () => {
		const { project } = run([
			{ op: "add_track", author: C, kind: "video" },
			{ op: "add_track", author: C, kind: "video" },
			{ op: "add_track", author: C, kind: "audio" },
			{ op: "add_track", author: C, kind: "text" },
		]);
		const tracks = scene(project).tracks;
		expect(tracks.overlay.filter((t) => t.type === "video").map((t) => t.name)).toEqual(["V2 B-ROLL", "V3", "V4"]);
		expect(tracks.overlay.filter((t) => t.type === "text").map((t) => t.name)).toEqual(["TEXT", "TEXT 2"]);
		expect(tracks.audio.map((t) => t.name)).toEqual(["MUSIC", "SFX", "AUDIO 3"]);
	});

	test("remove_track removes the track and its elements; the main track cannot go", () => {
		const removed = run([{ op: "remove_track", author: C, track: "trk-music" }]);
		expect(scene(removed.project).tracks.audio.map((t) => t.id)).toEqual(["trk-sfx"]);
		expect(removed.changes.ops[0].removed?.elements).toEqual(["el-music"]);
		const main = run([{ op: "remove_track", author: C, track: "main" }]);
		expect(main.conflicts[0].kind).toBe("incompatible");
	});

	test("reorder_tracks reorders within the groups and refuses audio above main", () => {
		const { project } = run([{ op: "reorder_tracks", author: C, order: ["trk-broll", "trk-text", "main", "trk-sfx", "trk-music"] }]);
		const tracks = scene(project).tracks;
		expect(tracks.overlay.map((t) => t.id)).toEqual(["trk-broll", "trk-text"]);
		expect(tracks.audio.map((t) => t.id)).toEqual(["trk-sfx", "trk-music"]);
		const bad = run([{ op: "reorder_tracks", author: C, order: ["trk-music", "trk-text", "main", "trk-broll", "trk-sfx"] }]);
		expect(bad.conflicts[0].kind).toBe("incompatible");
	});
});

describe("elements", () => {
	test("insert media: in/out become exact tick trims within the media", () => {
		const { project, ok } = run([{ op: "insert", author: C, track: "trk-broll", t: 10, media: "media-broll", in: 1, out: 3.5, ref: "b" }]);
		expect(ok).toBe(true);
		const inserted = track(project, "trk-broll").elements[1] as VideoElement;
		expect(inserted).toMatchObject({
			type: "video",
			mediaId: "media-broll",
			startTime: 10 * T,
			duration: 2.5 * T,
			trimStart: 1 * T,
			trimEnd: 4.5 * T,
			sourceDuration: 8 * T,
			isSourceAudioEnabled: true,
			restorff: { createdBy: "claude", author: "claude" },
		});
		expect(inserted.params["transform.scaleX"]).toBe(1);
		expect(inserted.params.volume).toBe(0);
	});

	test("insert text, image and shape with editor defaults plus style", () => {
		const { project, ok, changes } = run([
			{ op: "insert", author: C, track: "trk-text", t: 1, text: "Steeped 20 hours", style: { size: 9, weight: "bold", uppercase: true } },
			{ op: "insert", author: C, track: "trk-broll", t: 12, media: "media-still", dur: 2 },
			{ op: "add_track", author: C, kind: "overlay", ref: "g" },
			{ op: "insert", author: C, track: "g", t: 0, shape: "star", dur: 1, params: { fill: "#F6FF00" } },
		]);
		expect(ok).toBe(true);
		const text = track(project, "trk-text").elements[0] as TextElement;
		expect(text.params).toMatchObject({ content: "STEEPED 20 HOURS", fontSize: 9, fontWeight: "bold", fontFamily: "Arial", lineHeight: 1.2 });
		expect(text.duration).toBe(5 * T); // DEFAULT_NEW_ELEMENT_DURATION, timeline/creation.ts:3
		const image = track(project, "trk-broll").elements[1];
		expect(image).toMatchObject({ type: "image", duration: 2 * T, trimStart: 0, trimEnd: 0 });
		// add_track without index puts a graphic track just above main (insert-index.ts default), not on top
		expect(scene(project).tracks.overlay.map((t) => t.id).indexOf(changes.refs.g)).toBe(2);
		const star = track(project, changes.refs.g).elements[0];
		expect(star).toMatchObject({ type: "graphic", definitionId: "star", name: "Star" });
		expect(star.params).toMatchObject({ fill: "#F6FF00", points: 5, depth: 45, opacity: 1 });
	});

	test("insert refuses overlaps, wrong track types and trims past the media", () => {
		expect(run([{ op: "insert", author: C, track: "trk-broll", t: 6, media: "media-broll", in: 0, out: 1 }]).conflicts[0].kind).toBe("overlap");
		expect(run([{ op: "insert", author: C, track: "trk-text", t: 0, media: "media-music", in: 0, out: 1 }]).conflicts[0].kind).toBe("incompatible");
		expect(run([{ op: "insert", author: C, track: "trk-broll", t: 9, media: "media-broll", in: 2, out: 9 }]).conflicts[0].kind).toBe("out_of_range");
		expect(run([{ op: "insert", author: C, track: "trk-broll", t: 9, media: "media-unknown", in: 0, out: 1 }]).conflicts[0].kind).toBe("missing_target");
	});

	test("insert on an empty main track snaps to 0 (the editor's magnetic main track)", () => {
		const result = run([
			{ op: "delete", author: C, el: "el-aroll" },
			{ op: "insert", author: C, track: "main", t: 3, media: "media-aroll", in: 0, out: 4 },
		]);
		const inserted = scene(result.project).tracks.main.elements[0];
		expect(inserted.startTime).toBe(0);
		expect(result.changes.ops[1].details?.adjustedStart).toEqual({ requested: 3 * T, actual: 0, rule: "main track starts at 0" });
	});

	test("move along a track and onto another track of the same type", () => {
		const along = run([{ op: "move", author: C, el: "el-broll", t: 12 }]);
		expect(el(along.project, "el-broll").startTime).toBe(12 * T);
		const across = run([
			{ op: "add_track", author: C, kind: "video", ref: "v3" },
			{ op: "move", author: C, el: "el-broll", t: 1, track: "v3" },
		]);
		expect(trackOf(across.project, "el-broll").id).toBe(across.changes.refs.v3);
		expect(run([{ op: "move", author: C, el: "el-broll", t: 0, track: "trk-text" }]).conflicts[0].kind).toBe("incompatible");
		expect(run([{ op: "move", author: C, el: "el-music", t: 1, track: "trk-sfx" }]).ok).toBe(true);
	});

	test("trim keeps the kept frames where they were (content-anchored, like the editor's resize)", () => {
		const { project } = run([{ op: "trim", author: C, el: "el-aroll", in: 2, out: 10 }]);
		expect(el(project, "el-aroll")).toMatchObject({ startTime: 2 * T, duration: 8 * T, trimStart: 2 * T, trimEnd: 10 * T });
	});

	test("trim refuses going past the media, under one frame, or before timeline 0", () => {
		expect(run([{ op: "trim", author: C, el: "el-broll", out: 8.5 }]).conflicts[0].kind).toBe("out_of_range");
		expect(run([{ op: "trim", author: C, el: "el-aroll", in: 5, out: 5.01 }]).conflicts[0].kind).toBe("out_of_range");
		const shifted = run([
			{ op: "trim", author: C, el: "el-broll", in: 2 },
			{ op: "move", author: C, el: "el-broll", t: 0.5 },
			{ op: "trim", author: C, el: "el-broll", in: 0 },
		]);
		expect(shifted.conflicts[0]).toMatchObject({ index: "2", kind: "out_of_range" });
	});

	test("split: left keeps the id, right is new; trims and names follow SplitElementsCommand", () => {
		const { project, changes } = run([{ op: "split", author: C, el: "el-aroll", t: 8, ref: "r" }]);
		const main = scene(project).tracks.main.elements;
		expect(main.map((e) => e.id)).toEqual(["el-aroll", changes.refs.r]);
		expect(main[0]).toMatchObject({ name: "S01 talking head (left)", startTime: 0, duration: 8 * T, trimStart: 0, trimEnd: 12 * T });
		expect(main[1]).toMatchObject({ name: "S01 talking head (right)", startTime: 8 * T, duration: 12 * T, trimStart: 8 * T, trimEnd: 0 });
		expect(run([{ op: "split", author: C, el: "el-aroll", t: 20 }]).conflicts[0].kind).toBe("out_of_range");
	});

	test("delete and ripple_delete (track scope and all tracks)", () => {
		const deleted = run([{ op: "delete", author: C, el: "el-broll" }]);
		expect(track(deleted.project, "trk-broll").elements).toHaveLength(0);

		const setup: Op[] = [
			{ op: "insert", author: C, track: "trk-broll", t: 10, media: "media-broll", in: 0, out: 2, ref: "late" },
			{ op: "insert", author: C, track: "trk-text", t: 10, text: "LATE", dur: 1, ref: "txt" },
		];
		const trackOnly = run([...setup, { op: "ripple_delete", author: C, el: "el-broll" }]);
		expect(el(trackOnly.project, trackOnly.changes.refs.late).startTime).toBe(7 * T);
		expect(el(trackOnly.project, trackOnly.changes.refs.txt).startTime).toBe(10 * T);

		const everywhere = run([...setup, { op: "ripple_delete", author: C, el: "el-broll", scope: "all" }]);
		expect(el(everywhere.project, everywhere.changes.refs.txt).startTime).toBe(7 * T);
		expect(everywhere.changes.ops[2].details?.straddling).toEqual(["el-aroll", "el-music"]);
	});
});

describe("motion", () => {
	test("set maps friendly props onto editor params and coerces like the editor", () => {
		const { project, ok } = run([
			{ op: "set", author: C, el: "el-aroll", prop: "x", value: 120 },
			{ op: "set", author: C, el: "el-aroll", prop: "scale", value: 1.25 },
			{ op: "set", author: C, el: "el-aroll", prop: "opacity", value: 1.5 },
			{ op: "set", author: C, el: "el-aroll", prop: "volume", value: -3 },
			{ op: "set", author: C, el: "el-aroll", prop: "name", value: "S01 hook" },
			{ op: "set", author: C, el: "el-broll", prop: "hidden", value: true },
			{ op: "set", author: C, track: "trk-music", prop: "muted", value: true },
		]);
		expect(ok).toBe(true);
		const aroll = el(project, "el-aroll");
		expect(aroll.params).toMatchObject({ "transform.positionX": 120, "transform.scaleX": 1.25, "transform.scaleY": 1.25, opacity: 1, volume: -3 });
		expect(aroll.name).toBe("S01 hook");
		expect((el(project, "el-broll") as VideoElement).hidden).toBe(true);
		expect(track(project, "trk-music")).toMatchObject({ muted: true });
	});

	test("set refuses unknown props and impossible track props", () => {
		expect(run([{ op: "set", author: C, el: "el-music", prop: "x", value: 1 }]).conflicts[0].kind).toBe("incompatible");
		expect(run([{ op: "set", author: C, track: "trk-music", prop: "hidden", value: true }]).conflicts[0].kind).toBe("incompatible");
	});

	test("set speed retimes: duration follows the visible source span", () => {
		const { project } = run([{ op: "set", author: C, el: "el-broll", prop: "speed", value: 2 }]);
		expect(el(project, "el-broll")).toMatchObject({ duration: 1.5 * T, retime: { rate: 2 } });
	});

	test("set source_audio false extracts the audio (audio separation); true recovers it", () => {
		const { project, changes } = run([{ op: "set", author: C, el: "el-aroll", prop: "source_audio", value: false }]);
		expect((el(project, "el-aroll") as VideoElement).isSourceAudioEnabled).toBe(false);
		const extracted = track(project, "trk-sfx").elements[0] as AudioElement;
		expect(extracted).toMatchObject({ type: "audio", sourceType: "upload", mediaId: "media-aroll", startTime: 0, duration: 20 * T, params: { volume: 0, muted: false } });
		expect(changes.ops[0].created?.elements).toEqual([extracted.id]);
		const back = run([{ op: "set", author: C, el: "el-aroll", prop: "source_audio", value: true }], {}, project);
		expect((el(back.project, "el-aroll") as VideoElement).isSourceAudioEnabled).toBe(true);
		expect(track(back.project, "trk-sfx").elements).toHaveLength(1);
	});

	test("keyframe: timeline time → element-relative ticks; ease shapes the segment into the key", () => {
		const { project, ok } = run([
			{ op: "keyframe", author: C, el: "el-broll", prop: "x", t: 6, value: 100 },
			{ op: "keyframe", author: C, el: "el-broll", prop: "x", t: 7, value: 300, ease: "ease_in_out" },
		]);
		expect(ok).toBe(true);
		const channel = el(project, "el-broll").animations?.["transform.positionX"] as ScalarChannel;
		expect(channel.keys.map((k) => [k.time, k.value])).toEqual([[1 * T, 100], [2 * T, 300]]);
		expect(channel.keys[0]).toMatchObject({ segmentToNext: "bezier", rightHandle: { dt: 50400, dv: 0 } });
		expect(channel.keys[1]).toMatchObject({ segmentToNext: "linear", leftHandle: { dt: -50400, dv: 0 } });
	});

	test("keyframe: scale writes both axes; times clamp to the element; a key at the same tick is replaced", () => {
		const { project, changes } = run([
			{ op: "keyframe", author: C, el: "el-broll", prop: "scale", t: 0, value: 1, local: true },
			{ op: "keyframe", author: C, el: "el-broll", prop: "scale", t: 20, value: 1.15 },
			{ op: "keyframe", author: C, el: "el-broll", prop: "scale", t: 0, value: 1.05, local: true },
		]);
		const animations = el(project, "el-broll").animations ?? {};
		for (const path of ["transform.scaleX", "transform.scaleY"]) {
			expect((animations[path] as ScalarChannel).keys.map((k) => [k.time, k.value])).toEqual([[0, 1.05], [3 * T, 1.15]]);
		}
		expect(changes.ops[1].details?.clamped).toEqual({ requested: 15 * T, actual: 3 * T });
	});

	test("keyframe: crop is kept pending; a non-keyframable param is refused", () => {
		const crop = run([{ op: "keyframe", author: C, el: "el-broll", prop: "crop", t: 6, value: 0.2 }]);
		expect(crop.changes.ops[0].status).toBe("pending");
		expect(crop.changes.unsupported[0].op).toBe("keyframe");
		expect(run([{ op: "keyframe", author: C, el: "el-broll", prop: "blendMode", t: 6, value: 1 }]).conflicts[0].kind).toBe("incompatible");
	});
});

describe("text", () => {
	const words = [
		{ text: "Halcyon", start: 0.5, end: 0.8 },
		{ text: "cold", start: 0.85, end: 1.1 },
		{ text: "brew.", start: 1.15, end: 1.5 },
		{ text: "Never", start: 2.4, end: 2.7 },
		{ text: "bitter.", start: 2.75, end: 3.1 },
	];

	test("add_captions makes a caption track on top with 1-3-word chunks", () => {
		const { project, changes, ok } = run([{ op: "add_captions", author: C, words, ref: "cap" }]);
		expect(ok).toBe(true);
		const captions = scene(project).tracks.overlay[0];
		expect(captions).toMatchObject({ id: changes.refs.cap, name: "CAPTIONS", type: "text", restorff: { role: "caption" } });
		const chunks = captions.elements as TextElement[];
		expect(chunks.map((c) => c.params.content)).toEqual(["Halcyon cold brew.", "Never bitter."]);
		expect(chunks.map((c) => [c.startTime, c.duration])).toEqual([[0.5 * T, 1 * T], [2.4 * T, 0.7 * T]]);
		expect(chunks[0]).toMatchObject({ name: "Caption 1", restorff: { role: "caption" } });
		expect(chunks[0].params).toMatchObject({ fontWeight: "bold", fontSize: 5, "transform.positionY": 384 });
	});

	test("set_caption_style restyles every caption; apply_style is recorded expanded", () => {
		const { project, changes } = run([
			{ op: "add_captions", author: C, words },
			{ op: "apply_style", author: C, preset_id: "restorff/bold-captions" },
		]);
		const chunks = scene(project).tracks.overlay[0].elements as TextElement[];
		expect(chunks[0].params).toMatchObject({ content: "HALCYON COLD BREW.", fontSize: 6, "background.enabled": true });
		expect(chunks[0].restorff?.author).toBe("preset");
		expect(changes.ops.map((c) => c.index)).toEqual(["0", "1", "1.1"]);
		expect(changes.applied.map((op) => [op.op, op.author])).toEqual([["add_captions", "claude"], ["set_caption_style", "preset"]]);
		expect(run([{ op: "apply_style", author: C, preset_id: "nope" }]).conflicts[0].kind).toBe("unknown_preset");
	});

	test("text_pop: a text element that pops (scale + opacity keyframes)", () => {
		const { project, ok } = run([{ op: "text_pop", author: C, t: 2, text: "Cold. Smooth.", style: { uppercase: true } }]);
		expect(ok).toBe(true);
		const pop = track(project, "trk-text").elements[0] as TextElement;
		expect(pop).toMatchObject({ startTime: 2 * T, duration: 1.2 * T, params: { content: "COLD. SMOOTH." }, restorff: { role: "text_pop" } });
		const scale = pop.animations?.["transform.scaleX"] as ScalarChannel;
		expect(scale.keys.map((k) => [k.time, k.value])).toEqual([[0, 0.6], [14400, 1.08], [24000, 1]]);
		const opacity = pop.animations?.opacity as ScalarChannel;
		expect(opacity.keys.map((k) => [k.time, k.value])).toEqual([[0, 0], [9600, 1]]);
	});
});

describe("transitions", () => {
	test("cut and match are recorded no-ops", () => {
		const result = run([{ op: "transition", author: C, a: "el-aroll", b: "el-broll", kind: "cut" }]);
		expect(result.changes.ops[0].status).toBe("noop");
	});

	test("fade writes opacity keyframes on both sides (through the background)", () => {
		const { project, changes } = run([
			{ op: "split", author: C, el: "el-aroll", t: 10, ref: "b" },
			{ op: "transition", author: C, a: "el-aroll", b: "b", kind: "fade", dur: 0.4 },
		]);
		const a = el(project, "el-aroll").animations?.opacity as ScalarChannel;
		const b = el(project, changes.refs.b).animations?.opacity as ScalarChannel;
		expect(a.keys.map((k) => [k.time, k.value])).toEqual([[10 * T - 24000, 1], [10 * T, 0]]);
		expect(b.keys.map((k) => [k.time, k.value])).toEqual([[0, 0], [24000, 1]]);
	});

	test("dip, whip, dissolve… write transitionIn on the incoming clip (v32); aliases resolve; a gap is a conflict", () => {
		const { project, changes, ok } = run([
			{ op: "split", author: C, el: "el-aroll", t: 10, ref: "b" },
			{ op: "transition", author: C, a: "el-aroll", b: "b", kind: "dip", dur: 0.4 },
		]);
		expect(ok).toBe(true);
		expect((el(project, changes.refs.b) as { transitionIn?: unknown }).transitionIn).toEqual({ type: "dip-black", duration: 0.4 * T });
		const whip = run([
			{ op: "split", author: C, el: "el-aroll", t: 10, ref: "b" },
			{ op: "transition", author: C, a: "el-aroll", b: "b", kind: "WHIP_PAN" },
		]);
		expect((el(whip.project, whip.changes.refs.b) as { transitionIn?: unknown }).transitionIn).toEqual({ type: "whip-left", duration: 0.3 * T });
		// el-broll is on another track: not a cut.
		expect(run([{ op: "transition", author: C, a: "el-aroll", b: "el-broll", kind: "dissolve" }]).ok).toBe(false);
		// an unknown kind is kept pending for a later editor build
		const unknown = run([
			{ op: "split", author: C, el: "el-aroll", t: 10, ref: "b" },
			{ op: "transition", author: C, a: "el-aroll", b: "b", kind: "page-curl" },
		]);
		expect(unknown.changes.unsupported[0]).toMatchObject({ op: "transition", honouredBy: "editor" });
	});

	test("a split keeps the transition on the left half only", () => {
		const { project, changes } = run([
			{ op: "split", author: C, el: "el-aroll", t: 10, ref: "b" },
			{ op: "transition", author: C, a: "el-aroll", b: "b", kind: "flash" },
			{ op: "split", author: C, el: "b", t: 12, ref: "c" },
		]);
		expect((el(project, changes.refs.b) as { transitionIn?: unknown }).transitionIn).toBeDefined();
		expect((el(project, changes.refs.c) as { transitionIn?: unknown }).transitionIn).toBeUndefined();
	});
});

describe("audio", () => {
	test("gain sets the element level in dB", () => {
		expect(el(run([{ op: "gain", author: C, el: "el-music", db: -12 }]).project, "el-music").params.volume).toBe(-12);
		expect(run([{ op: "gain", author: C, el: "el-broll", db: -12 }]).ok).toBe(true);
	});

	test("duck writes a volume envelope on the music under each voice span", () => {
		const { project, ok } = run([
			{ op: "import_media", author: C, kind: "audio", blob_sha: "sha-vo", duration: 30, ref: "vo-media" },
			{ op: "add_track", author: C, kind: "audio", name: "VO", ref: "vo" },
			{ op: "insert", author: C, track: "vo", t: 2, media: "vo-media", in: 0, out: 3 },
			{ op: "insert", author: C, track: "vo", t: 10, media: "vo-media", in: 3, out: 6 },
			{ op: "duck", author: C, track: "trk-music", under: "vo", amount_db: 10, attack_ms: 100, release_ms: 200 },
		]);
		expect(ok).toBe(true);
		const volume = el(project, "el-music").animations?.volume as ScalarChannel;
		expect(volume.keys.map((k) => [k.time, k.value])).toEqual([
			[0, -6], [228000, -6], [240000, -16], [600000, -16], [624000, -6],
			[1188000, -6], [1200000, -16], [1560000, -16], [1584000, -6], [2400000, -6],
		]);
	});

	test("sfx: imported media or a library url is placed; a bare name is kept pending", () => {
		const { project, ok } = run([
			{ op: "sfx", author: C, t: 3, name: "whoosh", media: "media-whoosh" },
			{ op: "sfx", author: C, t: 4, name: "pop", url: "https://example.invalid/pop.wav", dur: 0.3, db: -4 },
			{ op: "sfx", author: C, t: 5, name: "riser" },
		]);
		expect(ok).toBe(true);
		const sfx = track(project, "trk-sfx").elements as AudioElement[];
		expect(sfx[0]).toMatchObject({ sourceType: "upload", mediaId: "media-whoosh", startTime: 3 * T, duration: 0.6 * T, trimEnd: 0 });
		expect(sfx[1]).toMatchObject({ sourceType: "library", startTime: 4 * T, duration: 0.3 * T, params: { volume: -4 } });
		expect(project.metadata.restorff?.pending.map((p) => p.op.name)).toEqual(["riser"]);
	});

	test("normalize sets the master loudness target the export masters to (v32 settings.loudness)", () => {
		const result = run([{ op: "normalize", author: C, lufs: -14, true_peak: -1 }]);
		expect(result.ok).toBe(true);
		expect(result.changes.unsupported).toEqual([]);
		expect(result.project.settings.loudness).toEqual({ enabled: true, integratedLufs: -14, truePeakDb: -1 });
	});

	test("duck with explicit voice spans ducks only there", () => {
		const { project } = run([
			{ op: "add_track", author: C, kind: "audio", name: "VO", ref: "vo" },
			{ op: "duck", author: C, track: "trk-music", under: "vo", amount_db: 12, attack_ms: 100, release_ms: 100, spans: [[4, 5]] },
		]);
		const volume = el(project, "el-music").animations?.volume as ScalarChannel;
		expect(volume.keys.map((k) => [k.time, k.value])).toEqual([
			[0, -6], [4 * T - 12000, -6], [4 * T, -18], [5 * T, -18], [5 * T + 12000, -6], [20 * T, -6],
		]);
	});

	test("beats store source-time beats on the music; snap_cuts rolls a cut onto the nearest beat", () => {
		const { project, changes, ok } = run([
			{ op: "beats", author: C, el: "el-music", bpm: 120, times: [9.9, 10.4] },
			{ op: "split", author: C, el: "el-aroll", t: 10, ref: "b" },
			{ op: "snap_cuts", author: C },
		]);
		expect(ok).toBe(true);
		const music = el(project, "el-music") as AudioElement & { beats?: { times: number[] } };
		expect(music.beats?.times).toEqual([9.9 * T, 10.4 * T]);
		// el-music starts at 0 with trimStart 0 (fixture), so the beat at 9.9 s is on the timeline at 9.9 s.
		const left = el(project, "el-aroll");
		expect(left.startTime + left.duration).toBe(9.9 * T);
		expect(el(project, changes.refs.b).startTime).toBe(9.9 * T);
	});
});

describe("look and notes", () => {
	test("grade is kept pending; a missing target is still a conflict", () => {
		const result = run([{ op: "grade", author: C, target: "all", preset: "warm-cafe" }]);
		expect(result.changes.ops[0].status).toBe("pending");
		expect(run([{ op: "grade", author: C, target: "el-nope", lut: "x.cube" }]).conflicts[0].kind).toBe("missing_target");
	});

	test("mark adds a frame-rounded bookmark, and updates the one already on that frame", () => {
		const { project } = run([
			{ op: "mark", author: C, t: 1.01, note: "hook lands" },
			{ op: "mark", author: C, t: 1.0, note: "hook lands here", color: "#F6FF00" },
			{ op: "mark", author: C, t: 0.2, note: "open" },
		]);
		expect(scene(project).bookmarks).toEqual([
			{ time: 24000, note: "open" },
			{ time: 1 * T, note: "hook lands here", color: "#F6FF00" },
		]);
	});
});
