/**
 * revise-safety (2026-10-21): FACE on captions over a talking clip with NO face box (the warm-moody-oat run's c02
 * close-up: its media had no matte, so FACE was skipped and a caption box sat on the eyes). The clip's media is passed
 * as `presumedFaces`; captions whose centre is in the middle band (33–75 % of the height) for ≥ 0.3 s fire one finding
 * per clip, with a fix call (captions zone top). Fictional Halcyon data.
 */
import { describe, expect, test } from "bun:test";
import { runTimelineChecks, type GateElement, type GateProject, type GateTrack } from "../src/index.ts";
import { text, video } from "./fixtures.ts";

function track(id: string, name: string, type: string, elements: GateElement[], extra: Partial<GateTrack> = {}): GateTrack {
	return { id, name, type, elements, hidden: false, muted: false, ...extra };
}

function project(overlay: GateTrack[]): GateProject {
	return {
		metadata: { id: "p-rs", name: "Halcyon close-up", restorff: {} },
		scenes: [{ id: "sc", isMain: true, tracks: { overlay, main: track("t-main", "V1 A-ROLL", "video", [video("A", 0, 20, { mediaId: "m-A" })]), audio: [] } }],
		currentSceneId: "sc",
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 } },
	};
}

/** Caption chunks on a CAPTIONS track at y (px from the centre). */
const captions = (y: number) =>
	track(
		"t-cap",
		"CAPTIONS",
		"text",
		[0, 1, 2, 3].map((i) => text(`cap${i}`, 1 + i, 2 + i, `cold brew ${i}`, { fontSize: 5, "transform.positionY": y })),
		{ restorff: { role: "caption" } } as Partial<GateTrack>,
	);

describe("FACE on captions over a clip with no face box", () => {
	test("mid-frame captions over a talking clip with no face box fire ONE finding, with captions zone top as the fix", () => {
		const run = runTimelineChecks(project([captions(0)]), { presumedFaces: ["m-A"] });
		const found = run.findings.filter((f) => f.rule === "FACE");
		expect(found).toHaveLength(1);
		expect(found[0]?.measure).toMatchObject({ presumed_face: true, captions: 4 });
		expect(found[0]?.fix_call).toMatchObject({ tool: "captions", arguments: { zone: "top" } });
		expect(run.skipped.find((x) => x.rule === "FACE")).toBeUndefined();
	});
	test("captions in the top band, or no presumed media: nothing (and without either, FACE is skipped as before)", () => {
		expect(runTimelineChecks(project([captions(-600)]), { presumedFaces: ["m-A"] }).findings.filter((f) => f.rule === "FACE")).toEqual([]);
		const before = runTimelineChecks(project([captions(0)]));
		expect(before.findings.filter((f) => f.rule === "FACE")).toEqual([]);
		expect(before.skipped.find((x) => x.rule === "FACE")?.why).toContain("cutout matte");
	});
});
