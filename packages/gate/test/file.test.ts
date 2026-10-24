import { describe, expect, test } from "bun:test";
import {
	fileFindings,
	loudnessGain,
	parseBlackdetect,
	parseEbur128,
	parseFfprobe,
	parseFreezedetect,
} from "../src/index.ts";

// Real ffmpeg 8.1 output (2026-10-20) on a fictional test clip: testsrc2 1080x1920 30 fps with 1 s of black at the
// start, and a 1 kHz sine at amplitude 0.0316 (−30 dBFS).
const EBUR128 = `[Parsed_ebur128_0 @ 000001db22465500] Summary:

  Integrated loudness:
    I:         -33.0 LUFS
    Threshold: -43.0 LUFS

  Loudness range:
    LRA:         0.0 LU
    Threshold: -53.0 LUFS
    LRA low:   -33.0 LUFS
    LRA high:  -33.0 LUFS

  True peak:
    Peak:      -29.3 dBFS
`;
const DETECT = `[Parsed_freezedetect_1 @ 000001dc4159c100] lavfi.freezedetect.freeze_start: 0
[Parsed_blackdetect_0 @ 000001dc4159b540] black_start:0 black_end:1 black_duration:1
[Parsed_freezedetect_1 @ 000001dc4159c100] lavfi.freezedetect.freeze_duration: 1
[Parsed_freezedetect_1 @ 000001dc4159c100] lavfi.freezedetect.freeze_end: 1
[Parsed_freezedetect_1 @ 000001dc4159c100] lavfi.freezedetect.freeze_start: 5.5
`;
const PROBE = JSON.stringify({
	streams: [
		{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1", r_frame_rate: "30/1" },
		{ codec_type: "audio", codec_name: "aac" },
	],
	format: { duration: "7.000000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
});

describe("file parsers", () => {
	test("ebur128 summary", () => {
		expect(parseEbur128(EBUR128)).toEqual({ integrated_lufs: -33, true_peak_dbtp: -29.3, lra_lu: 0 });
		expect(parseEbur128("no summary here")).toBeNull();
		expect(parseEbur128("Summary:\n I: -70.0 LUFS\n Peak: -inf dBFS")?.true_peak_dbtp).toBe(Number.NEGATIVE_INFINITY);
	});
	test("blackdetect + freezedetect (an open freeze runs to the end)", () => {
		expect(parseBlackdetect(DETECT)).toEqual([{ t: 0, t_end: 1, duration: 1 }]);
		expect(parseFreezedetect(DETECT, 7)).toEqual([
			{ t: 0, t_end: 1, duration: 1 },
			{ t: 5.5, t_end: 7, duration: 1.5 },
		]);
	});
	test("ffprobe", () => {
		expect(parseFfprobe(PROBE)).toMatchObject({ width: 1080, height: 1920, fps: 30, video_codec: "h264", audio_codec: "aac", duration_s: 7 });
	});
	test("loudness gain respects the true-peak ceiling", () => {
		expect(loudnessGain({ integrated_lufs: -33, true_peak_dbtp: -29.3, lra_lu: 0 })).toEqual({ gain_db: 19, wanted_db: 19, limited: false });
		const g = loudnessGain({ integrated_lufs: -20, true_peak_dbtp: -3, lra_lu: 0 });
		expect(g?.limited).toBe(true);
		expect(g?.gain_db).toBe(1.8);
	});
});

describe("file findings", () => {
	const probe = parseFfprobe(PROBE);
	test("a quiet master with black and a stall", () => {
		const run = fileFindings(
			{
				file: "ad014.mp4",
				probe,
				loudness: parseEbur128(EBUR128),
				black: parseBlackdetect(DETECT),
				frozen: parseFreezedetect(DETECT, 7),
				errors: [],
			},
			{ width: 1080, height: 1920, fps: 30 },
		);
		const loud = run.findings.find((f) => f.rule === "LOUD");
		expect(loud?.severity).toBe("must");
		expect(loud?.measure?.integrated_lufs).toBe(-33);
		expect(loud?.fix).toContain("+19.0 dB");
		const clean = run.findings.filter((f) => f.rule === "CLEAN");
		// the freeze inside the black span is not reported twice
		expect(clean.map((f) => [f.t, f.severity])).toEqual([
			[0, "must"],
			[5.5, "must"],
		]);
		expect(run.findings.some((f) => f.rule === "FORMAT")).toBe(false);
		expect(run.not_run).toEqual([]);
		expect(run.findings.every((f) => f.evidence === "MEASURED")).toBe(true);
	});
	test("an on-target file passes; a WebM fails FORMAT", () => {
		const ok = fileFindings(
			{ file: "a.mp4", probe, loudness: { integrated_lufs: -14.2, true_peak_dbtp: -1.5, lra_lu: 3 }, black: [], frozen: [], errors: [] },
			{ width: 1080, height: 1920, fps: 30 },
		);
		expect(ok.findings).toEqual([]);
		const webm = fileFindings(
			{
				file: "a.webm",
				probe: { ...probe!, video_codec: "vp9", audio_codec: "opus" },
				loudness: { integrated_lufs: -14, true_peak_dbtp: -1.5, lra_lu: 3 },
				black: [],
				frozen: [],
				errors: [],
			},
			{ width: 1080, height: 1920, fps: 30 },
		);
		expect(webm.findings.map((f) => f.rule)).toEqual(["FORMAT"]);
	});
	test("a failed measurement is not_run, never a pass", () => {
		const run = fileFindings({ file: "a.mp4", probe, loudness: null, black: null, frozen: null, errors: [{ rule: "LOUD", why: "ffmpeg crashed" }] }, { width: 1080, height: 1920, fps: 30 });
		expect(run.not_run.map((n) => n.rule).sort()).toEqual(["CLEAN", "LOUD"]);
	});
});
