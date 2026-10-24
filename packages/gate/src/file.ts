/**
 * The file half of the gate: parsers for what ffmpeg / ffprobe print, and the findings made from those measures.
 * Pure (no child_process here): the server route `apps/web/src/app/api/gate` runs the tools and hands us the text.
 *
 *   LOUD    ffmpeg -nostats -i <file> -filter_complex ebur128=peak=true -f null -     (stderr: the Summary block)
 *   CLEAN   ffmpeg -nostats -i <file> -vf blackdetect=d=0.08:pix_th=0.10,freezedetect=n=-60dB:d=0.2 -an -f null -
 *   FORMAT  ffprobe -v error -show_streams -show_format -of json <file>
 *
 * Thresholds: EXPORT-GATE §2 (LOUD −14 LUFS ±1, ≤ −1 dBTP; CLEAN 0 black, held < 0.2 s each and < 0.5 s total,
 * ≥ 1.5 s is a stall; FORMAT the delivery size, the brief's fps, H.264 + AAC).
 */
import { PROFILES } from "./piece.ts";
import { round, formatTime } from "./project.ts";
import { GATE_SOURCE } from "./timeline.ts";
import type { CheckRun, FileExpect, FileMeasures, Finding, LoudnessMeasure, PieceType, ProbeMeasure, SpanMeasure } from "./types.ts";

export const FILE_CHECKS = ["LOUD", "CLEAN", "FORMAT", "FLASH"] as const;

function numOrNull(s: string | undefined): number | null {
	if (s === undefined) return null;
	if (/^-inf/i.test(s)) return Number.NEGATIVE_INFINITY;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

/** Parse the `Summary:` block ebur128 prints at the end (the last one wins if there are several). */
export function parseEbur128(stderr: string): LoudnessMeasure | null {
	const at = stderr.lastIndexOf("Summary:");
	if (at < 0) return null;
	const block = stderr.slice(at);
	const i = /\bI:\s*(-?inf|-?[\d.]+)\s*LUFS/i.exec(block);
	const lra = /\bLRA:\s*(-?[\d.]+)\s*LU\b/i.exec(block);
	const peak = /\bPeak:\s*(-?inf|-?[\d.]+)\s*dBFS/i.exec(block);
	if (!i) return null;
	return {
		integrated_lufs: numOrNull(i[1]),
		true_peak_dbtp: peak ? numOrNull(peak[1]) : null,
		lra_lu: lra ? numOrNull(lra[1]) : null,
	};
}

export function parseBlackdetect(stderr: string): SpanMeasure[] {
	const out: SpanMeasure[] = [];
	const re = /black_start:\s*(-?[\d.]+)\s+black_end:\s*(-?[\d.]+)\s+black_duration:\s*(-?[\d.]+)/g;
	for (let m = re.exec(stderr); m; m = re.exec(stderr)) {
		out.push({ t: Number(m[1]), t_end: Number(m[2]), duration: Number(m[3]) });
	}
	return out;
}

/** freezedetect logs start / duration / end as separate lines; a freeze that runs to the end has no end line. */
export function parseFreezedetect(stderr: string, fileDuration?: number | null): SpanMeasure[] {
	const out: SpanMeasure[] = [];
	const re = /lavfi\.freezedetect\.freeze_(start|duration|end):\s*(-?[\d.]+)/g;
	let open: number | null = null;
	for (let m = re.exec(stderr); m; m = re.exec(stderr)) {
		const v = Number(m[2]);
		if (m[1] === "start") open = v;
		else if (m[1] === "end" && open !== null) {
			out.push({ t: open, t_end: v, duration: round(v - open, 3) });
			open = null;
		}
	}
	if (open !== null && fileDuration) out.push({ t: open, t_end: fileDuration, duration: round(fileDuration - open, 3) });
	return out;
}

function rate(s: unknown): number | null {
	if (typeof s !== "string") return null;
	const [n, d] = s.split("/").map(Number);
	if (!Number.isFinite(n) || !Number.isFinite(d) || !d || !n) return null;
	return n / d;
}

export function parseFfprobe(json: string | unknown): ProbeMeasure | null {
	let data: unknown = json;
	if (typeof json === "string") {
		try {
			data = JSON.parse(json);
		} catch {
			return null;
		}
	}
	const d = data as {
		streams?: Array<Record<string, unknown>>;
		format?: Record<string, unknown>;
	};
	if (!d || !Array.isArray(d.streams)) return null;
	const v = d.streams.find((s) => s.codec_type === "video");
	const a = d.streams.find((s) => s.codec_type === "audio");
	const dur = Number(d.format?.duration ?? v?.duration);
	return {
		width: typeof v?.width === "number" ? v.width : null,
		height: typeof v?.height === "number" ? v.height : null,
		fps: rate(v?.avg_frame_rate) ?? rate(v?.r_frame_rate),
		video_codec: typeof v?.codec_name === "string" ? v.codec_name : null,
		audio_codec: typeof a?.codec_name === "string" ? a.codec_name : null,
		duration_s: Number.isFinite(dur) ? dur : null,
		container: typeof d.format?.format_name === "string" ? (d.format.format_name as string) : null,
	};
}

export const LOUD_TARGET = { lufs: -14, tolerance: 1, truePeakMax: -1 } as const;

/**
 * The gain that brings integrated loudness to the target without pushing the true peak over the ceiling (no
 * limiter in the editor yet). `limited` is true when the peak, not the loudness, set the gain.
 */
export function loudnessGain(
	m: LoudnessMeasure,
	target: { lufs?: number; truePeakMax?: number } = {},
): { gain_db: number; wanted_db: number; limited: boolean } | null {
	if (m.integrated_lufs === null || !Number.isFinite(m.integrated_lufs)) return null;
	const lufs = target.lufs ?? LOUD_TARGET.lufs;
	const ceiling = target.truePeakMax ?? LOUD_TARGET.truePeakMax;
	const wanted = lufs - m.integrated_lufs;
	const peak = m.true_peak_dbtp;
	const headroom = peak === null || !Number.isFinite(peak) ? Number.POSITIVE_INFINITY : ceiling - 0.2 - peak;
	const gain = Math.min(wanted, headroom);
	return { gain_db: round(gain, 1), wanted_db: round(wanted, 1), limited: headroom < wanted };
}

/** Findings from the measures of one encoded file. */
export function fileFindings(
	m: FileMeasures,
	expect: FileExpect,
	opts: { source?: string; commit?: string | null; piece?: PieceType } = {},
): CheckRun {
	const findings: Finding[] = [];
	const ran: string[] = [];
	const skipped: CheckRun["skipped"] = [];
	const not_run: CheckRun["not_run"] = [...m.errors];
	const source = opts.source ?? GATE_SOURCE;
	const base = {
		status: "open" as const,
		evidence: "MEASURED" as const,
		source,
		file: m.file,
		commit: opts.commit ?? null,
		element_id: null,
	};

	// LOUD
	if (m.probe && !m.probe.audio_codec) {
		ran.push("LOUD");
		findings.push({
			...base,
			id: "gate-LOUD-master",
			rule: "LOUD",
			severity: "must",
			t: 0,
			t_end: m.probe.duration_s,
			track: "MASTER",
			measure: { audio_stream: false },
			target: "−14 LUFS ±1, true peak ≤ −1 dBTP",
			message: "The rendered file has no audio stream.",
			fix: "render with audio included (sound is half the ad)",
			fix_call: { tool: "timeline", arguments: { action: "summary" }, does: "the cut has no sound: add a voice, a bed (music place) or SFX (sounds design), then render again" },
		});
	} else if (m.loudness) {
		ran.push("LOUD");
		const lufs = expect.lufs ?? LOUD_TARGET.lufs;
		const tol = expect.lufsTolerance ?? LOUD_TARGET.tolerance;
		const ceil = expect.truePeakMax ?? LOUD_TARGET.truePeakMax;
		const i = m.loudness.integrated_lufs;
		const tp = m.loudness.true_peak_dbtp;
		const silent = i === null || !Number.isFinite(i) || i <= -69.9;
		const loudOff = silent || Math.abs((i as number) - lufs) > tol + 1e-9;
		const peakOff = tp !== null && Number.isFinite(tp) && tp > ceil + 1e-9;
		if (loudOff || peakOff) {
			const g = loudnessGain(m.loudness, { lufs, truePeakMax: ceil });
			const gainText = g ? `${g.wanted_db >= 0 ? "+" : ""}${g.wanted_db.toFixed(1)}` : "+?";
			const parts = [
				silent ? "the master is silent" : `integrated ${(i as number).toFixed(1)} LUFS (target ${lufs} ±${tol})`,
				tp === null ? null : `true peak ${Number.isFinite(tp) ? tp.toFixed(1) : "−inf"} dBTP (max ${ceil})`,
			].filter(Boolean);
			findings.push({
				...base,
				id: "gate-LOUD-master",
				rule: "LOUD",
				severity: "must",
				t: 0,
				t_end: m.probe?.duration_s ?? null,
				track: "MASTER",
				measure: {
					integrated_lufs: i === null || !Number.isFinite(i) ? null : round(i, 1),
					true_peak_dbtp: tp === null || !Number.isFinite(tp) ? null : round(tp, 1),
					lra_lu: m.loudness.lra_lu,
					gain_db: g?.wanted_db ?? null,
				},
				target: `${lufs} LUFS ±${tol}, true peak ≤ ${ceil} dBTP`,
				message: `Loudness is off: ${parts.join(", ")}.`,
				fix: `apply ${gainText} dB, then a true-peak limiter at ${ceil} dBTP; re-measure on the encoded file`,
				fix_call: silent
					? { tool: "timeline", arguments: { action: "summary" }, does: "the master is silent: put sound on the timeline, then render again" }
					: {
							tool: "timeline_ops",
							arguments: { ops: [{ op: "normalize", author: "claude", lufs, true_peak: ceil }], message: "gate fix (LOUD): normalise the master" },
							does: `normalise the export to ${lufs} LUFS / ${ceil} dBTP, then render again`,
						},
			});
		}
	} else if (!not_run.some((n) => n.rule === "LOUD")) {
		not_run.push({ rule: "LOUD", why: "no ebur128 summary from ffmpeg" });
	}

	// CLEAN
	if (m.black || m.frozen) {
		ran.push("CLEAN");
		for (const b of m.black ?? []) {
			findings.push({
				...base,
				id: `gate-CLEAN-black${Math.round(b.t * 100)}`,
				rule: "CLEAN",
				severity: "must",
				t: round(b.t, 3),
				t_end: round(b.t_end, 3),
				track: null,
				measure: { black_s: round(b.duration, 3) },
				target: "0 black frames",
				message: `Black picture from ${formatTime(b.t)} for ${round(b.duration, 2)} s.`,
				fix: "close the gap on the video track or replace the black clip",
				fix_call: { tool: "look", arguments: { kind: "render", times: [round(b.t, 3), round((b.t + b.t_end) / 2, 3)] }, does: "see the black, then close the gap or replace the clip with timeline_ops" },
			});
		}
		// Black frames are also "frozen": a hold inside a black span is the same defect, reported once.
		const inBlack = (f: SpanMeasure) => (m.black ?? []).some((b) => f.t >= b.t - 0.05 && f.t_end <= b.t_end + 0.05);
		const held = (m.frozen ?? []).filter((f) => f.duration >= 0.2 - 1e-9 && !inBlack(f));
		const total = held.reduce((a, f) => a + f.duration, 0);
		// A beat that lands and holds is part of an explainer's or a motion graphic's grammar: there a hold is a SHOULD
		// unless it is a stall (ASSUMPTION, gate-v2); on ads and talking heads the CRAFT bar stands (≥ 0.5 s in total = MUST).
		const designedHolds = opts.piece === "explainer" || opts.piece === "motion_graphic" || opts.piece === "brand_film";
		for (const f of held) {
			const stall = f.duration >= 1.5;
			findings.push({
				...base,
				id: `gate-CLEAN-held${Math.round(f.t * 100)}`,
				rule: "CLEAN",
				severity: stall || (total >= 0.5 && !designedHolds) ? "must" : "should",
				t: round(f.t, 3),
				t_end: round(f.t_end, 3),
				track: null,
				measure: { frozen_s: round(f.duration, 3), frozen_total_s: round(total, 3) },
				target: "no held frames ≥ 0.2 s (total < 0.5 s); ≥ 1.5 s is a stall",
				message: `Picture held still for ${round(f.duration, 2)} s from ${formatTime(f.t)}${stall ? " (a stall)" : ""}.`,
				fix: "the clip is shorter than its slot and is padded with cloned frames: trim the slot to the clip, extend the clip, or add a camera move",
				fix_call: { tool: "look", arguments: { kind: "render", times: [round(f.t, 3), round((f.t + f.t_end) / 2, 3)] }, does: "see the hold, then add a move or a change there with timeline_ops (a keyframe push-in, a beat)" },
			});
		}
	} else if (!not_run.some((n) => n.rule === "CLEAN")) {
		not_run.push({ rule: "CLEAN", why: "no blackdetect / freezedetect output" });
	}

	// FORMAT
	if (m.probe) {
		ran.push("FORMAT");
		const p = m.probe;
		const problems: string[] = [];
		const measure: Record<string, number | string | null> = {
			width_px: p.width,
			height_px: p.height,
			fps: p.fps === null ? null : round(p.fps, 3),
			video_codec: p.video_codec,
			audio_codec: p.audio_codec,
		};
		if (p.width !== expect.width || p.height !== expect.height)
			problems.push(`${p.width}x${p.height} instead of ${expect.width}x${expect.height}`);
		if (p.fps === null || Math.abs(p.fps - expect.fps) > 0.05)
			problems.push(`${p.fps === null ? "unknown" : round(p.fps, 3)} fps instead of ${round(expect.fps, 3)}`);
		if (expect.requireH264Aac !== false) {
			if (p.video_codec !== "h264") problems.push(`video ${p.video_codec ?? "missing"} instead of H.264`);
			if (p.audio_codec && p.audio_codec !== "aac") problems.push(`audio ${p.audio_codec} instead of AAC`);
		}
		if (problems.length) {
			findings.push({
				...base,
				id: "gate-FORMAT-file",
				rule: "FORMAT",
				severity: "must",
				t: 0,
				t_end: null,
				track: "MASTER",
				measure,
				target: `${expect.width}x${expect.height}, ${round(expect.fps, 3)} fps, H.264 + AAC`,
				message: `The file is off-spec: ${problems.join("; ")}.`,
				fix: `re-render at ${expect.width}x${expect.height}, ${round(expect.fps, 3)} fps, as MP4 (H.264 + AAC)`,
				fix_call: { tool: "render", arguments: { fresh: true }, does: `render the head again (the canvas is the delivery: ${expect.width}x${expect.height}, ${round(expect.fps, 3)} fps)` },
			});
		}
	} else if (!not_run.some((n) => n.rule === "FORMAT")) {
		not_run.push({ rule: "FORMAT", why: "ffprobe gave no stream information" });
	}

	// FLASH (file half, gate-v2): measured flashes are candidates until someone looks at the frames.
	if (m.flashes === undefined || m.flashes === null) {
		if (!not_run.some((n) => n.rule === "FLASH")) skipped.push({ rule: "FLASH", why: "the file's frame changes were not measured (the timeline half still ran)" });
	} else {
		ran.push("FLASH");
		const mode = opts.piece ? PROFILES[opts.piece].rules.FLASH : "must";
		if (mode !== "skip") {
			for (const f of m.flashes) {
				const black = f.luma !== undefined && f.luma < 12;
				findings.push({
					...base,
					id: `gate-FLASH-file${Math.round(f.t * 100)}`,
					rule: "FLASH",
					// a black frame is a MUST on every piece (as CLEAN's black; blackdetect only sees ≥ 0.08 s)
					severity: black ? "must" : mode,
					status: "candidate",
					t: round(f.t, 3),
					t_end: round(f.t_end, 3),
					track: null,
					measure: { frames: f.frames, in_diff: f.in_diff, out_diff: f.out_diff, median_diff: f.median_diff, ...(f.luma !== undefined ? { luma: f.luma } : {}) },
					target: "no picture on screen for only 1–3 frames at a cut",
					message: `${black ? "A black frame" : "A picture"} shows for ${f.frames} frame${f.frames === 1 ? "" : "s"} at ${formatTime(f.t)} (${f.region === "face" ? "inside the speaker's face box, " : ""}the picture changes by ${f.in_diff} entering and ${f.out_diff} leaving, against ${f.median_diff} around it).`,
					fix: `look at the frames from ${formatTime(f.t)}; if they are a stray sliver (an autocut pad, a cut one frame off), trim them from the clip that shows them`,
					fix_call: { tool: "look", arguments: { kind: "render", times: [round(Math.max(0, f.t - 1 / 30), 3), round(f.t, 3), round(f.t_end, 3)] }, does: "see the frame before, the flash and the frame after; then trim the flash frames off that clip with timeline_ops" },
				});
			}
		}
	}

	return { findings, ran, not_run, skipped };
}
