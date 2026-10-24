/**
 * effects-v2 (2026-10-20): face-safe placement maths, lane order, instance find + removal. Pure: no server, no files.
 * Run: cd apps/web && bun test src/server/effects-v2.test.ts
 */
import { describe, expect, test } from "bun:test";
import type { ProjectSnapshot, SnapshotElement, SnapshotTrack } from "@/sync/snapshot";
import { findEffect, planRemoval, removeKeys } from "./effects-instances";
import { insertIndexFor, laneDrift, laneRank, nextLaneName } from "./effects-lanes";
import { type AlphaFrames, bestShift, faceCoverage, faceSpanFrom, headTopOf, keepOutOf, overlapReport, placeInZones, rowProfile, safeBandFor, zonesAround } from "./matte-placement";

const T = 120_000;
const canvas = { width: 1080, height: 1920 };
const identity = (box: [number, number, number, number]) => ({ left: box[0], top: box[1], width: box[2], height: box[3] });

describe("head top (incident: Cover Story placed from head_top 0.2286)", () => {
	test("a plausible segmenter head is used", () => {
		const face = { left: 0.31, top: 0.556, width: 0.28, height: 0.158 };
		expect(headTopOf(face, { left: 0.3, top: 0.512, width: 0.29, height: 0.21 })).toEqual({ top: 0.512, from: "segmenter" });
	});
	test("a head box that swallowed the burned-in caption above the head is not", () => {
		const face = { left: 0.306, top: 0.558, width: 0.281, height: 0.158 };
		const got = headTopOf(face, { left: 0.285, top: 0.231, width: 0.563, height: 0.496 });
		expect(got?.from).toBe("face");
		expect(got?.top).toBeCloseTo(0.558 - 0.35 * 0.158, 4);
	});
	test("the span's head top is the median of good frames", () => {
		const frames = [0, 1, 2, 3, 4].map((t) => ({ t, faces: [{ box: [0.31, 0.556, 0.28, 0.158] as [number, number, number, number] }], head: (t % 2 ? [0.29, 0.231, 0.56, 0.5] : [0.3, 0.5, 0.29, 0.22]) as [number, number, number, number], face_seg: null }));
		const span = faceSpanFrom(frames, 0, 4, identity);
		expect(span).not.toBeNull();
		expect(span?.head_top).toBeGreaterThan(0.45);
		expect(span?.head_top_from_segmenter).toBe(3);
		expect(span?.frames).toBe(5);
	});
});

/** Gray alpha frames 27 x 48 with an opaque block (fractions). */
function block(rect: { left: number; top: number; width: number; height: number }): AlphaFrames {
	const width = 27;
	const height = 48;
	const frame = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (x / width >= rect.left && x / width < rect.left + rect.width && y / height >= rect.top && y / height < rect.top + rect.height) frame[y * width + x] = 255;
	return { width, height, frames: [frame] };
}

describe("placement off the face", () => {
	const span = { envelope: { left: 0.3, top: 0.55, width: 0.32, height: 0.18 } };
	const keep = keepOutOf(span, canvas);
	const safe = safeBandFor(canvas);
	test("a card over the face is moved up, inside the safe band", () => {
		const card = { left: 0.15, top: 0.42, width: 0.7, height: 0.25 };
		const alpha = block(card);
		const before = overlapReport(alpha, span.envelope, keep);
		expect(before.clear).toBe(false);
		const shift = bestShift({ profile: rowProfile(alpha, { left: keep.left, right: keep.left + keep.width }), keepOut: keep, box: card, safe });
		expect(shift.fits).toBe(true);
		expect(shift.dy).toBeLessThan(0);
		expect(card.top + shift.dy).toBeGreaterThanOrEqual(safe.top - 1e-6);
		const moved = block({ ...card, top: card.top + shift.dy });
		expect(faceCoverage(moved, span.envelope).max).toBe(0);
	});
	test("zones around the face; a box too tall for both is scaled into the larger", () => {
		const zones = zonesAround(keep, safe);
		expect(zones.map((zone) => zone.name)).toEqual(["top", "bottom"]);
		const placed = placeInZones({ left: 0.1, top: 0.3, width: 0.8, height: 0.6 }, zones);
		expect(placed.zone?.name).toBe("top");
		expect(placed.scale).toBeLessThan(1);
	});
});

describe("lane order (E-8)", () => {
	const lane = (name: string, type = "video"): SnapshotTrack => ({ id: name, name, type, elements: [] });
	test("a new MOTION lane goes under the caption lanes, FX under MOTION", () => {
		const overlay = [lane("TEXT", "text"), lane("CAPTIONS", "text"), lane("V2 B-ROLL")];
		expect(insertIndexFor(overlay, 1)).toBe(2);
		const withMotion = [...overlay.slice(0, 2), lane("MOTION"), overlay[2]];
		expect(insertIndexFor(withMotion, 2)).toBe(3);
		expect(nextLaneName(withMotion, "MOTION")).toBe("MOTION 2");
		expect(laneRank(lane("MOTION BACK 2"))).toBe(6);
	});
	test("drift: MOTION above the captions is reported", () => {
		expect(laneDrift([lane("MOTION"), lane("CAPTIONS", "text")]).length).toBe(1);
		expect(laneDrift([lane("CAPTIONS", "text"), lane("MOTION"), lane("MOTION FRONT"), lane("V2 CUTOUT"), lane("MOTION BACK")])).toEqual([]);
	});
});

describe("find + remove an applied effect (E-1)", () => {
	const applied = { kind: "layered", t: 1, duration_s: 1, plate: "clip", given: ["word"], person: "seg", created_tracks: ["back", "front", "cut"], created_cutout: true, plate_keys: [{ el: "clip", props: ["transform.scaleX"], times: [T] }] };
	const layer = (id: string, layer: string): SnapshotElement => ({ id, type: "video", startTime: T, duration: T, restorff: { effect: { id: "FX-16", name: "Cover Story", instance: "fx_1", layer, side: layer === "back" ? "below_cutout" : "above_cutout", applied } } as SnapshotElement["restorff"] });
	const snapshot = (): ProjectSnapshot => ({
		metadata: { id: "p", name: "Halcyon test" },
		currentSceneId: "s",
		scenes: [
			{
				id: "s",
				tracks: {
					overlay: [
						{ id: "cap", name: "CAPTIONS", type: "text", elements: [] },
						{ id: "front", name: "MOTION FRONT", type: "video", elements: [layer("f1", "front")] },
						{ id: "cut", name: "V2 CUTOUT", type: "video", elements: [{ id: "seg", type: "video", startTime: T, duration: T, restorff: { cutout: { sourceElementId: "clip" } } as SnapshotElement["restorff"] }] },
						{ id: "back", name: "MOTION BACK", type: "video", elements: [layer("b1", "back")] },
					],
					main: { id: "main", name: "V1 A-ROLL", type: "video", elements: [{ id: "clip", type: "video", startTime: 0, duration: 8 * T, animations: { "transform.scaleX": { keys: [{ time: T, value: 0.8 }, { time: 5 * T, value: 1 }] } } }] },
				},
			},
		],
	});
	test("any element finds the whole instance (layer, person cutout)", () => {
		const s = snapshot();
		const byLayer = findEffect(s, "f1");
		expect(byLayer.kind).toBe("instance");
		if (byLayer.kind === "instance") expect(byLayer.members.map((m) => m.element.id).sort()).toEqual(["b1", "f1"]);
		const byCutout = findEffect(s, "seg");
		expect(byCutout.kind).toBe("instance");
	});
	test("removal deletes the layers, the person no one else uses, its lanes and its plate keys", () => {
		const s = snapshot();
		const found = findEffect(s, "b1");
		if (found.kind !== "instance") throw new Error("not found");
		const plan = planRemoval(s, found, { keepTracks: false });
		expect(plan.ops.filter((op) => op.op === "delete").map((op) => op.el).sort()).toEqual(["b1", "f1", "seg"]);
		expect(plan.ops.filter((op) => op.op === "remove_track").map((op) => op.track).sort()).toEqual(["back", "cut", "front"]);
		const keys = plan.finish(s);
		expect(keys.keys_removed).toBe(1);
		const clip = s.scenes[0].tracks?.main?.elements[0] as { animations?: Record<string, { keys: unknown[] }> };
		expect(clip.animations?.["transform.scaleX"].keys.length).toBe(1);
	});
	test("an update keeps the emptied lanes for the new layers", () => {
		const s = snapshot();
		const found = findEffect(s, "f1");
		if (found.kind !== "instance") throw new Error("not found");
		const plan = planRemoval(s, found, { keepTracks: true });
		expect(plan.ops.some((op) => op.op === "remove_track")).toBe(false);
		expect(plan.kept.tracks?.sort()).toEqual(["back", "cut", "front"]);
	});
	test("removeKeys drops only keys near the given times", () => {
		const el = { id: "x", type: "video", startTime: 0, duration: T, animations: { "transform.positionY": { keys: [{ time: 0 }, { time: 12_000 }, { time: 90_000 }] } } } as unknown as SnapshotElement;
		expect(removeKeys(el, ["transform.positionY"], [12_100])).toBe(1);
		expect((el.animations as Record<string, { keys: unknown[] }>)["transform.positionY"].keys.length).toBe(2);
	});
});
