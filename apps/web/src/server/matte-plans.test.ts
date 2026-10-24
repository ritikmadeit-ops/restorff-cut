// Pure planners of MCP `cutout` (mcp-cutout agent, 2026-10-20): preset placement on a snapshot, the font floor, and
// reframe with face boxes. No server, no Chromium: a fixture snapshot made with timeline-ops, a fake matte job and a
// fake face track. Run: cd apps/web && bun test src/server/matte-plans.test.ts
import { describe, expect, test } from "bun:test";
import { apply, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import { coverStoryLayout, fitFontSize } from "@/cutout/preset-layout";
import type { ProjectSnapshot } from "@/sync/snapshot";
import type { FaceTrack, MatteJob } from "./matte";
import { activeScene, cutoutSourceOf, findCutoutOf, locate, planPreset, TICKS } from "./matte-presets";
import { planReframe } from "./matte-reframe";

const HASH = "a".repeat(64);
const FACE: [number, number, number, number] = [0.31, 0.56, 0.28, 0.16];

function fixture(): { snapshot: ProjectSnapshot; plateId: string; mediaId: string } {
	const now = "2026-10-20T00:00:00.000Z";
	const empty = {
		metadata: { id: "halcyon-test", name: "Halcyon Cold Brew · test", duration: 0, createdAt: now, updatedAt: now, restorff: { opsVersion: "ops@1", pending: [], media: [] } },
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: { overlay: [], main: { id: "trk-main", name: "V1 A-ROLL", type: "video", muted: false, hidden: false, elements: [] }, audio: [] },
				bookmarks: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		currentSceneId: "scene-main",
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 }, canvasSizeMode: "preset", background: { type: "color", color: "#000000" } },
		version: 32,
	};
	const ops = [
		{ op: "import_media", author: "user", kind: "video", name: "talk.mp4", url: "upload:talk.mp4", duration: 6, width: 1080, height: 1920, fps: 30, has_audio: true, ref: "m" },
		{ op: "insert", author: "user", track: "main", t: 0, media: "m", in: 0, out: 6, name: "S01", ref: "a" },
	] as unknown as Op[];
	const result = apply(empty as unknown as OpsProject, ops, { seed: "fixture" });
	if (!result.ok) throw new Error(JSON.stringify(result.conflicts).slice(0, 500));
	return { snapshot: result.project as unknown as ProjectSnapshot, plateId: result.changes.refs.a, mediaId: result.changes.refs.m };
}

const job = {
	job_id: `${HASH.slice(0, 24)}.full`,
	media_hash: HASH,
	variant: "full",
	state: "done",
	range: { start: 0, end: 6 },
	source: { width: 1080, height: 1920, duration: 6, fps: 30 },
	outputs: { person_webm: { file: "person.webm", bytes: 1, width: 1080, height: 1920, fps: 30, frames: 180, duration: 6 }, faces: { file: "faces.json", frames: 90 } },
} as unknown as MatteJob;

function faces(): FaceTrack {
	const frames = Array.from({ length: 90 }, (_, i) => ({
		t: i / 15,
		faces: [{ box: FACE, score: 0.95, keypoints: [] as Array<[number, number]> }],
		person: [0, 0.45, 1, 0.55] as [number, number, number, number],
		head: [0.29, 0.47, 0.31, 0.26] as [number, number, number, number],
		face_seg: FACE,
		coverage: 0.34,
	}));
	return {
		schema: "restorffcut-faces@1",
		media_hash: HASH,
		source: { width: 1080, height: 1920, duration: 6, fps: 30 },
		range: { start: 0, end: 6 },
		fps: 15,
		detector: { name: "blaze_face_short_range", model_url: "", delegate: "GPU", long_side: 640 },
		segmenter: { model: "multiclass", delegate: "GPU", long_side: 256 },
		frames,
		summary: { frames: 90, face_found: 1, face: FACE, head: [0.29, 0.47, 0.31, 0.26], person: [0, 0.45, 1, 0.55], max_faces: 1 },
	};
}

function applyText(snapshot: ProjectSnapshot, plateId: string) {
	const plate = locate(activeScene(snapshot), plateId);
	if (!plate) throw new Error("plate missing");
	const plan = planPreset({ snapshot, plate, cutout: null, preset: "text_behind_person", options: { text: "One pour." }, matte: job, faces: faces() });
	const result = apply(snapshot as unknown as OpsProject, plan.ops, { seed: "t" });
	expect(result.ok).toBe(true);
	const after = result.project as unknown as ProjectSnapshot;
	plan.finish(after, result.changes.refs);
	return { after, refs: result.changes.refs, plan };
}

describe("cutout apply (server planner)", () => {
	test("text_behind_person: person on top, headline between, cutout aligned with the clip", () => {
		const { snapshot, plateId } = fixture();
		const { after, refs, plan } = applyText(snapshot, plateId);
		expect(plan.createsCutout).toBe(true);
		const overlay = activeScene(after)?.tracks?.overlay ?? [];
		expect(overlay.map((track) => track.name)).toEqual(["V2 CUTOUT", "BEHIND TEXT"]);
		const cutout = locate(activeScene(after), refs.cutout_clip);
		const plate = locate(activeScene(after), plateId);
		expect(cutout?.element.startTime).toBe(plate?.element.startTime);
		expect(cutout?.element.duration).toBe(plate?.element.duration);
		expect(cutout?.element.trimStart).toBe(0);
		expect(cutout?.element.sourceDuration).toBe(6 * TICKS);
		expect(cutout?.element.isSourceAudioEnabled).toBe(false);
		expect(cutoutSourceOf(cutout?.element)?.sourceElementId).toBe(plateId);
		expect(findCutoutOf(activeScene(after), plateId)?.element.id).toBe(refs.cutout_clip);
		const text = locate(activeScene(after), refs.behind_text);
		expect(text?.element.params?.content).toBe("ONE POUR.");
		// centred just below the top of the head (0.47 × 1920 ≈ 902 px): positionY = centre − 960
		const y = Number(text?.element.params?.["transform.positionY"]);
		expect(y).toBeGreaterThan(-100);
		expect(y).toBeLessThan(0);
	});

	test("small cover-story text keeps its size (font floor 1, not 5)", () => {
		const canvas = { width: 1080, height: 1920 };
		expect(fitFontSize({ text: "X", canvas, widthFraction: 1, charEm: 1, maxHeightFraction: 0.022 }).fontSize).toBeLessThan(2.5);
		const layout = coverStoryLayout({ masthead: "Halcyon", canvas, head: { top: 900 } });
		expect(Number(layout.dateline.params.fontSize)).toBeLessThan(2.5);
	});
});

describe("cutout reframe (server planner)", () => {
	test("1:1: clip covers the square and keeps the face in frame; text behind the person follows the clip", () => {
		const { snapshot: base, plateId, mediaId } = fixture();
		const { after: snapshot, refs } = applyText(base, plateId);
		const working = structuredClone(snapshot);
		const track = faces();
		const plan = planReframe({ snapshot: working, size: "1:1", facesFor: (id) => (id === mediaId ? track : null), mediaSize: () => ({ width: 1080, height: 1920 }) });
		plan.prepare(working);
		const result = apply(working as unknown as OpsProject, plan.ops, { seed: "r" });
		expect(result.ok).toBe(true);
		const out = result.project as unknown as ProjectSnapshot;
		plan.finish(out);
		expect(out.settings?.canvasSize).toEqual({ width: 1080, height: 1080 });
		const plate = locate(activeScene(out), plateId)?.element;
		const scaleY = Number(plate?.params?.["transform.scaleY"]);
		const y = Number(plate?.params?.["transform.positionY"]);
		expect(scaleY).toBeCloseTo(1.78, 2);
		// drawn 1080 x 1920 in a 1080 x 1080 canvas: |y| ≤ 420 keeps it covered
		expect(Math.abs(y)).toBeLessThanOrEqual(420);
		// the face (source y 0.56..0.72 of 1920) lands inside the square
		const top = 540 + y - 960; // canvas y of source row 0
		expect(top + FACE[1] * 1920).toBeGreaterThan(0);
		expect(top + (FACE[1] + FACE[3]) * 1920).toBeLessThan(1080);
		// the headline stays at the head: ~ the same source row as before, mapped through the clip
		const text = locate(activeScene(out), refs.behind_text)?.element;
		const textY = 540 + Number(text?.params?.["transform.positionY"]);
		expect(textY - top).toBeGreaterThan(800);
		expect(textY - top).toBeLessThan(1000);
		expect(plan.notes.join(" ")).toContain("behind the person");
	});
});
