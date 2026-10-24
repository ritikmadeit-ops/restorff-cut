/**
 * gate-v2 (2026-10-20): piece types, picture changes (composition scenes, effects), text inside compositions, FACE,
 * FLASH (timeline + file), real lane names, exact fix calls, FORMAT / SAFE per canvas. Fictional Halcyon Cold Brew.
 */
import { describe, expect, test } from "bun:test";
import {
	buildReport,
	detectFlashes,
	fileFindings,
	filterDesignedFlashes,
	pinFindings,
	PROFILES,
	runTimelineChecks,
	safeZoneFor,
	type CompositionFacts,
	type FaceTrackLite,
	type GateElement,
	type GateProject,
	type GateTrack,
} from "../src/index.ts";
import { audio, defectProject, DEFECT_MEDIA, text, video } from "./fixtures.ts";

const S = 120_000;
const s = (seconds: number) => Math.round(seconds * S);

function track(id: string, name: string, type: string, elements: GateElement[], extra: Partial<GateTrack> = {}): GateTrack {
	return { id, name, type, elements, hidden: false, muted: false, ...extra };
}

function comp(id: string, from: number, to: number, name: string, extra: Record<string, unknown> = {}): GateElement {
	return video(id, from, to, { isSourceAudioEnabled: false, restorff: { composition: { name, props: {}, ...extra } } });
}

function project(
	tracks: { overlay?: GateTrack[]; main?: GateElement[]; audio?: GateTrack[] },
	opts: { w?: number; h?: number; meta?: Record<string, unknown> } = {},
): GateProject {
	return {
		metadata: { id: "p-v2", name: "Halcyon v2", restorff: opts.meta ?? {} },
		scenes: [{ id: "sc", isMain: true, tracks: { overlay: tracks.overlay ?? [], main: track("t-main", "V1 A-ROLL", "video", tracks.main ?? []), audio: tracks.audio ?? [] } }],
		currentSceneId: "sc",
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: opts.w ?? 1080, height: opts.h ?? 1920 } },
	};
}

/** A speaker clip 0–20 s with its own sound and nothing else (a talking head, no brief). */
const talkingHead = (overlay: GateTrack[] = []) => project({ overlay, main: [video("A", 0, 20)] });

describe("piece types", () => {
	test("a brief with an offer is an ad; the old fixtures keep every ad rule", () => {
		const run = runTimelineChecks(defectProject(), { media: DEFECT_MEDIA });
		expect(run.piece).toMatchObject({ type: "ad", source: "inferred" });
		expect(run.findings.find((f) => f.rule === "R15")?.severity).toBe("must");
	});

	test("a talking head with no offer: no ad rules (R15, R1, R4, R21 skipped, said why)", () => {
		const run = runTimelineChecks(talkingHead());
		expect(run.piece?.type).toBe("talking_head");
		const skipped = run.skipped.map((x) => x.rule);
		for (const rule of ["R15", "R1", "R4", "R21"]) expect(skipped).toContain(rule);
		expect(run.findings.some((f) => ["R15", "R1", "R4"].includes(f.rule))).toBe(false);
		expect(run.skipped.find((x) => x.rule === "R15")?.why).toContain("an ad rule");
	});

	test("16:9 built from references is an explainer: no FORMAT, title-safe zone, no offer", () => {
		const p = project({ main: [video("A", 0, 12), video("B", 12, 24)], overlay: [track("t-text", "TEXT", "text", [text("title", 0, 3, "Farm to bottle", { "transform.positionY": -300 })])] }, { w: 1920, h: 1080 });
		const run = runTimelineChecks(p, { hints: { references: true } });
		expect(run.piece?.type).toBe("explainer");
		expect(run.findings.filter((f) => f.rule === "FORMAT")).toEqual([]);
		expect(run.findings.filter((f) => f.rule === "R15")).toEqual([]);
		expect(safeZoneFor({ width: 1920, height: 1080 })).toMatchObject({ x0: 96, x1: 1824, y0: 54, y1: 1026 });
	});

	test("compositions as the picture: a motion graphic", () => {
		const p = project({ overlay: [track("t-motion", "MOTION", "video", [comp("c1", 0, 10, "hook"), comp("c2", 10, 20, "outro")])] });
		const facts: Record<string, CompositionFacts> = { c1: { opaque: true }, c2: { opaque: true } };
		const run = runTimelineChecks(p, { compositions: facts });
		expect(run.piece?.type).toBe("motion_graphic");
	});

	test("the owner's piece wins over the check argument (D13); the argument is used when the owner set none", () => {
		const owned = talkingHead();
		owned.metadata.restorff = { piece: "ad" };
		const run = runTimelineChecks(owned, { piece: "explainer" });
		expect(run.piece).toMatchObject({ type: "ad", source: "project" });
		expect(run.piece?.ignored?.type).toBe("explainer");
		expect(runTimelineChecks(talkingHead(), { piece: "brand film" }).piece).toMatchObject({ type: "brand_film", source: "check argument" });
	});

	test("a brief with a verified offer keeps R15 a MUST even on an owner-set explainer", () => {
		const p = talkingHead();
		p.metadata.restorff = { piece: "explainer", brief: { offer: { price: "$4.99", reason: "today only", cta: "Shop now" } } };
		const r15 = runTimelineChecks(p).findings.find((f) => f.rule === "R15");
		expect(r15?.severity).toBe("must");
		expect(r15?.fix_call?.arguments.ops).toEqual([expect.objectContaining({ op: "text_pop", text: "$4.99 · today only · Shop now" })]);
	});

	test("CAP-LEN: 1–3 words on an ad, up to 5 elsewhere", () => {
		const caps = track("t-cap", "CAPTIONS", "text", [text("cap", 1, 2, "steeped for eighteen slow hours", { "transform.positionY": 300 })], { restorff: { role: "caption" } });
		expect(runTimelineChecks(talkingHead([caps])).findings.filter((f) => f.rule === "CAP-LEN")).toEqual([]);
		expect(runTimelineChecks(talkingHead([caps]), { piece: "ad" }).findings.filter((f) => f.rule === "CAP-LEN")).toHaveLength(1);
		expect(PROFILES.ad.capMax).toBe(3);
	});
});

describe("FORMAT never flips a deliberate 16:9", () => {
	test("a brief asking 1080x1920 on a 16:9 canvas: the fix reframes, never set_canvas 1080x1920", () => {
		const p = project({ main: [video("A", 0, 10)] }, { w: 1920, h: 1080, meta: { brief: { deliver: "1080x1920" } } });
		const f = runTimelineChecks(p).findings.find((x) => x.rule === "FORMAT");
		expect(f?.severity).toBe("must");
		expect(JSON.stringify(f?.fix_call)).not.toContain("set_canvas");
	});
	test("a non-standard canvas: the nearest standard size in the same orientation", () => {
		const p = project({ main: [video("A", 0, 10)] }, { w: 1900, h: 1000 });
		const f = runTimelineChecks(p, { piece: "explainer" }).findings.find((x) => x.rule === "FORMAT");
		expect(f?.fix_call?.arguments.ops).toEqual([expect.objectContaining({ op: "set_canvas", w: 1920, h: 1080 })]);
	});
});

describe("compositions declare scenes and text", () => {
	const motion = (extra: Record<string, unknown> = {}) =>
		project({ overlay: [track("t-motion", "MOTION", "video", [comp("c1", 0, 20, "steep-story", extra)])] });

	test("scenes inside a composition are picture changes (an ad's R6 counts them)", () => {
		const without = runTimelineChecks(motion(), { piece: "ad", compositions: { c1: { opaque: true } } });
		expect(without.findings.filter((f) => f.rule === "R6").length).toBeGreaterThan(0);
		const withScenes = runTimelineChecks(motion(), { piece: "ad", compositions: { c1: { opaque: true, scenes: [1, 2, 2.5, 4, 6, 8, 9, 10.5, 12, 14, 16, 18] } } });
		expect(withScenes.findings.filter((f) => f.rule === "R6")).toEqual([]);
		expect(withScenes.changes?.scene).toBe(12);
	});

	test("declared scenes in the stored composition win (no server facts needed)", () => {
		const run = runTimelineChecks(motion({ scenes: [5, 10, 15], opaque: true }), { piece: "ad" });
		expect(run.changes?.scene).toBe(3);
	});

	test("R3 reads the text inside compositions (declared, or the custom manifest's text params)", () => {
		const declared = runTimelineChecks(motion({ text: [{ content: "Why eighteen hours?", t: 0.1, role: "headline" }], opaque: true }), { piece: "ad" });
		expect(declared.findings.filter((f) => f.rule === "R3")).toEqual([]);
		const source = '<script type="application/json" id="params">{"name":"x","params":{"title":{"type":"string","default":"Cold, not rushed"},"accent":{"type":"color","default":"#FF5A1F"}}}</script>';
		const fromManifest = runTimelineChecks(motion({ source, custom: true, opaque: true }), { piece: "ad" });
		expect(fromManifest.findings.filter((f) => f.rule === "R3")).toEqual([]);
		const none = runTimelineChecks(motion({ opaque: true }), { piece: "ad" });
		expect(none.findings.filter((f) => f.rule === "R3")).toHaveLength(1);
	});

	test("applied effects are picture changes; their layers count once", () => {
		const fx = (id: string, from: number, name: string) => video(id, from, from + 1, { isSourceAudioEnabled: false, restorff: { effect: { id: name, name }, composition: { name } } });
		const p = talkingHead([track("t-front", "MOTION FRONT", "video", [fx("o-f", 1, "Orbit"), fx("c-f", 2, "Couch Wall")]), track("t-back", "MOTION BACK", "video", [fx("o-b", 1, "Orbit"), fx("c-b", 2, "Couch Wall")])]);
		expect(runTimelineChecks(p).changes?.effect).toBe(2);
	});

	test("a transparent overlay is not the picture: findings name the real lane", () => {
		const p = project({ overlay: [track("t-paper", "PAPER", "video", [video("tex", 0, 20, { params: { blendMode: "overlay" } })])], main: [video("A", 0, 20)] });
		const run = runTimelineChecks(p, { piece: "ad" });
		const r5 = run.findings.find((f) => f.rule === "R5" && f.element_id === "A");
		expect(r5?.track_name).toBe("V1 A-ROLL");
		const motion = project({ overlay: [track("t-motion", "MOTION", "video", [comp("c1", 0, 20, "x")])] });
		const r6 = runTimelineChecks(motion, { piece: "ad", compositions: { c1: { opaque: true } } }).findings.find((f) => f.rule === "R6");
		expect(r6).toMatchObject({ track: "V2 B-ROLL", track_name: "MOTION", track_id: "t-motion" });
	});
});

describe("FACE", () => {
	// a 1080x1920 source with the face at x 0.35–0.65, y 0.40–0.55 for the whole clip
	const faces: Record<string, FaceTrackLite> = {
		"m-A": { source: { width: 1080, height: 1920 }, frames: Array.from({ length: 201 }, (_, i) => ({ t: i / 10, box: [0.35, 0.4, 0.3, 0.15] as [number, number, number, number] })) },
	};
	const title = (y: number) => track("t-text", "TEXT", "text", [text("title", 1, 4, "HALCYON", { fontSize: 6, "transform.positionY": y })]);

	test("a title over the face fires, with an exact move off it", () => {
		const run = runTimelineChecks(talkingHead([title(-50)]), { faces });
		const f = run.findings.find((x) => x.rule === "FACE");
		expect(f).toMatchObject({ severity: "should", element_id: "title", track: "TEXT", track_name: "TEXT" });
		expect(f?.fix_call?.arguments.ops).toEqual([expect.objectContaining({ op: "set", el: "title", prop: "transform.positionY" })]);
	});
	test("clear of the face, or with the person cut out above it: no FACE", () => {
		expect(runTimelineChecks(talkingHead([title(500)]), { faces }).findings.filter((f) => f.rule === "FACE")).toEqual([]);
		const cutout = track("t-cut", "V2 CUTOUT", "video", [video("cut", 0, 20, { restorff: { cutout: true }, isSourceAudioEnabled: false })]);
		expect(runTimelineChecks(talkingHead([cutout, title(-50)]), { faces }).findings.filter((f) => f.rule === "FACE")).toEqual([]);
	});
	test("no face boxes: skipped, with how to get them", () => {
		const run = runTimelineChecks(talkingHead([title(-50)]));
		expect(run.skipped.find((x) => x.rule === "FACE")?.why).toContain("cutout matte");
	});
	test("a composition is judged by its alpha grid; a full-frame treatment is not an overlay", () => {
		const grid = (on: (r: number, c: number) => boolean) => Array.from({ length: 16 * 9 }, (_, i) => (on(Math.floor(i / 9), i % 9) ? 255 : 0));
		const overlay = track("t-motion", "MOTION", "video", [comp("ov", 1, 3, "callout")]);
		const callout: CompositionFacts = { alpha: { fps: 5, cols: 9, rows: 16, frames: [grid((r, c) => r >= 6 && r <= 9 && c >= 3 && c <= 5)] } };
		expect(runTimelineChecks(talkingHead([overlay]), { faces, compositions: { ov: callout } }).findings.filter((f) => f.rule === "FACE")).toHaveLength(1);
		const frame: CompositionFacts = { alpha: { fps: 5, cols: 9, rows: 16, frames: [grid(() => true).map((v, i) => (i % 9 === 0 ? 0 : v))] } };
		expect(runTimelineChecks(talkingHead([overlay]), { faces, compositions: { ov: frame } }).findings.filter((f) => f.rule === "FACE")).toEqual([]);
	});
});

describe("FLASH", () => {
	const flashProject = () =>
		project({ main: [video("A", 0, 3, { mediaId: "m-raw" }), video("X", 3, 3 + 2 / 30, { mediaId: "m-raw", trimStart: s(30) }), video("B", 3 + 2 / 30, 6, { mediaId: "m-raw", trimStart: s(3 + 2 / 30) })] });

	test("a 2-frame clip between two shots fires, with an exact delete + trim (to the tick)", () => {
		const f = runTimelineChecks(flashProject()).findings.find((x) => x.rule === "FLASH");
		expect(f).toMatchObject({ severity: "must", element_id: "X", track_name: "V1 A-ROLL" });
		expect(f?.measure?.frames).toBe(2);
		expect(f?.fix_call?.arguments.ops).toEqual([expect.objectContaining({ op: "delete", el: "X" }), expect.objectContaining({ op: "trim", el: "A", out: 3.066667 })]);
	});
	test("a split that continues frame-exact is neither a flash nor a cut", () => {
		const p = project({ main: [video("A", 0, 3, { mediaId: "m-raw" }), video("A2", 3, 3 + 2 / 30, { mediaId: "m-raw", trimStart: s(3) }), video("A3", 3 + 2 / 30, 6, { mediaId: "m-raw", trimStart: s(3 + 2 / 30) })] });
		const run = runTimelineChecks(p);
		expect(run.findings.filter((f) => f.rule === "FLASH")).toEqual([]);
		expect(run.changes?.cut).toBe(0);
	});
	test("detectFlashes: two big changes 1–3 frames apart over steady pictures; a whip is not a flash", () => {
		const steady = Array.from({ length: 40 }, () => 1);
		const flash2 = [...steady.slice(0, 20), 30, 1, 28, ...steady.slice(0, 17)];
		expect(detectFlashes(flash2, { fps: 30 })).toEqual([expect.objectContaining({ frames: 2, t: 21 / 30 })]);
		const flashThenCut = [...steady.slice(0, 20), 30, 1, 28, 25, ...steady.slice(0, 16)];
		expect(detectFlashes(flashThenCut, { fps: 30 })).toHaveLength(1);
		const whip = [...steady.slice(0, 20), 30, 30, 30, 30, 30, ...steady.slice(0, 15)];
		expect(detectFlashes(whip, { fps: 30 })).toEqual([]);
		expect(detectFlashes(flash2, { fps: 30, near: [10] })).toEqual([]);
	});
	test("designed flashes are filtered, a black frame never is", () => {
		const p = project({ overlay: [track("t-motion", "MOTION", "video", [comp("c1", 0, 10, "form")])] });
		const facts: Record<string, CompositionFacts> = { c1: { opaque: true, motion: [[4.9, 5.2]] } };
		const f = { t: 5, t_end: 5.067, frames: 2, in_diff: 30, out_diff: 30, median_diff: 1 };
		expect(filterDesignedFlashes([f], p, facts).designed).toHaveLength(1);
		expect(filterDesignedFlashes([{ ...f, luma: 3 }], p, facts).kept).toHaveLength(1);
	});
	test("file FLASH is a candidate MUST on a talking head, a SHOULD on a motion graphic; it merges with the timeline's", () => {
		const m = { file: "x.mp4", probe: null, loudness: null, black: [], frozen: [], errors: [], flashes: [{ t: 3, t_end: 3.067, frames: 2, in_diff: 26.5, out_diff: 24.5, median_diff: 5.5, region: "face" as const }] };
		const th = fileFindings(m, { width: 1080, height: 1920, fps: 30 }, { piece: "talking_head" }).findings.find((x) => x.rule === "FLASH");
		expect(th).toMatchObject({ severity: "must", status: "candidate" });
		expect(th?.message).toContain("face box");
		expect(fileFindings(m, { width: 1080, height: 1920, fps: 30 }, { piece: "motion_graphic" }).findings.find((x) => x.rule === "FLASH")?.severity).toBe("should");
		const black = { ...m, flashes: [{ ...m.flashes[0], region: "frame" as const, luma: 2 }] };
		const bf = fileFindings(black, { width: 1080, height: 1920, fps: 30 }, { piece: "motion_graphic" }).findings.find((x) => x.rule === "FLASH");
		expect(bf?.severity).toBe("must");
		expect(bf?.message).toContain("black frame");
		const report = buildReport([runTimelineChecks(flashProject()), { ...fileFindings(m, { width: 1080, height: 1920, fps: 30 }, { piece: "talking_head" }), findings: pinFindings(fileFindings(m, { width: 1080, height: 1920, fps: 30 }).findings.filter((x) => x.rule === "FLASH"), flashProject()) }]);
		const flashes = report.findings.filter((x) => x.rule === "FLASH");
		expect(flashes).toHaveLength(1);
		expect(flashes[0].status).toBe("open");
	});
	test("held frames: a SHOULD on an explainer unless a stall; the CRAFT bar on an ad", () => {
		const m = { file: "x.mp4", probe: null, loudness: null, black: [], frozen: [{ t: 1, t_end: 1.33, duration: 0.33 }, { t: 5, t_end: 5.3, duration: 0.3 }], errors: [] };
		const sev = (piece: "explainer" | "ad") => fileFindings(m, { width: 1920, height: 1080, fps: 24 }, { piece }).findings.filter((x) => x.rule === "CLEAN").map((x) => x.severity);
		expect(sev("explainer")).toEqual(["should", "should"]);
		expect(sev("ad")).toEqual(["must", "must"]);
	});
});

describe("every timeline finding carries an exact fix call", () => {
	test("the defect project: each finding has fix_call {tool, arguments}", () => {
		const run = runTimelineChecks(defectProject(), { media: DEFECT_MEDIA });
		for (const f of run.findings) {
			expect(f.fix_call?.tool).toBeTruthy();
			expect(typeof f.fix_call?.arguments).toBe("object");
		}
	});
	test("SAFE's fix brings the measured box inside the zone", () => {
		const p = talkingHead([track("t-text", "TEXT", "text", [text("wide", 0, 3, "HALCYON COLD BREW IS STEEPED", { fontSize: 8, "transform.positionY": 0 })])]);
		const f = runTimelineChecks(p).findings.find((x) => x.rule === "SAFE");
		const scale = (f?.fix_call?.arguments.ops as Array<{ prop: string; value: number }>).find((o) => o.prop === "transform.scaleX")?.value ?? 1;
		const w = Number(f?.measure?.box_x1_px) - Number(f?.measure?.box_x0_px);
		expect(w * scale).toBeLessThanOrEqual(880);
	});
	test("audio rules name their real lane", () => {
		const p = talkingHead();
		p.scenes[0].tracks.audio = [track("t-music", "MUSIC", "audio", [audio("bed", 0, 5)], { restorff: { role: "music" } })];
		const r12 = runTimelineChecks(p, { piece: "ad" }).findings.find((f) => f.rule === "R12");
		expect(r12).toMatchObject({ track: "MUSIC", track_name: "MUSIC", track_id: "t-music" });
		expect(r12?.fix_call?.tool).toBe("music");
	});
});
