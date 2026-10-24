#!/usr/bin/env bun
/**
 * restorffcut pipeline CLI. Runbook: docs/restorff/PIPELINE.md.
 *
 *   bun packages/pipeline/src/cli.ts autocut <video> --out <job-dir> [--silence 0.35] [--caption-y 540] [--force-tvf]
 *   bun packages/pipeline/src/cli.ts render  <job-dir> [--out <job-dir>/render.mp4] [--quality preview|final] [--gpu hw]
 *   bun packages/pipeline/src/cli.ts master  <in.mp4> --out <master.mp4>
 *   bun packages/pipeline/src/cli.ts gate    <job-dir> [--video <job-dir>/master.mp4] [--quick]
 *   bun packages/pipeline/src/cli.ts demo    <video> [--out <job-dir>] [--quality final] [--gpu hw] [--quick]
 *
 * Job folders must be outside the repo (they can hold third-party test media). Exit 0 = done (whatever the gate said),
 * 1 = a step failed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { renderJob, type RenderQuality } from "../../../scripts/render/render.ts";
import type { GpuMode } from "../../../scripts/render/cdp.ts";
import { autocut } from "./autocut.ts";
import { gate } from "./gate.ts";
import { master, measureLoudness } from "./master.ts";
import { DEFAULT_JOBS_PARENT, FFMPEG } from "./paths.ts";
import { syncCheck } from "./sync.ts";
import { probe, run, seconds, step } from "./util.ts";

function parseArgs(argv: string[]) {
	const positional: string[] = [];
	const flags: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else flags[key] = "true";
		} else positional.push(a);
	}
	return { positional, flags };
}

const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

function defaultJobDir(video: string): string {
	const stem = basename(video, extname(video)).replace(/[^A-Za-z0-9_-]/g, "-");
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
	return join(DEFAULT_JOBS_PARENT, `${stem}-${stamp}`);
}

/** Captions band for the Judge's OCR: where the pipeline put the captions (centre y, editor size → px). */
function captionBand(jobDir: string): [number, number] {
	const project = JSON.parse(readFileSync(join(jobDir, "project.json"), "utf8")) as {
		settings: { canvasSize: { height: number } };
		scenes: Array<{ tracks: { overlay: Array<{ name: string; elements: Array<{ params: Record<string, unknown> }> }> } }>;
	};
	const h = project.settings.canvasSize.height;
	const caption = project.scenes[0].tracks.overlay.find((t) => t.name === "CAPTIONS")?.elements[0];
	if (!caption) return [0.62, 0.78];
	const cy = h / 2 + Number(caption.params["transform.positionY"] ?? 0);
	const fontPx = (Number(caption.params.fontSize ?? 5) * h) / 90;
	const padY = Number(caption.params["background.paddingY"] ?? 0);
	const half = fontPx * 0.75 + padY;
	const clamp = (x: number) => Math.min(1, Math.max(0, Math.round(x * 1000) / 1000));
	return [clamp((cy - half) / h), clamp((cy + half) / h)];
}

/**
 * One frame per second at EXACT whole seconds (t000.jpg = 0.0 s, t001.jpg = 1.0 s …). Not `fps=1`: that filter
 * picks the last frame of each [n−0.5, n+0.5) window, ~0.5 s late (MEASURED 2026-10-20, LEARNINGS 1).
 */
/** Timeline seconds where one V1 A-ROLL piece ends and the next begins (the splices). */
function timelineCuts(jobDir: string): number[] {
	const project = JSON.parse(readFileSync(join(jobDir, "project.json"), "utf8")) as {
		scenes: Array<{ tracks: { main: { elements: Array<{ startTime: number }> } } }>;
	};
	return project.scenes[0].tracks.main.elements
		.map((e) => e.startTime / 120000)
		.filter((t) => t > 0)
		.sort((a, b) => a - b);
}

async function extractFrames(video: string, dir: string): Promise<number> {
	mkdirSync(dir, { recursive: true });
	const select = "select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,0.999)',scale=540:-2";
	const r = await run(FFMPEG, [
		"-hide_banner", "-v", "error", "-y", "-i", video, "-vf", select, "-fps_mode", "vfr", "-start_number", "0",
		"-q:v", "3", join(dir, "t%03d.jpg"),
	]);
	if (r.code !== 0) throw new Error(`frame extraction failed: ${r.stderr.slice(-400)}`);
	return readdirSync(dir).filter((f) => f.endsWith(".jpg")).length;
}

async function demo(video: string, flags: Record<string, string>) {
	const jobDir = resolve(flags.out ?? defaultJobDir(video));
	const timings: Record<string, number> = {};
	const started = performance.now();

	const cut = await step("autocut", timings, () =>
		autocut(video, {
			out: jobDir,
			silence: num(flags.silence),
			pad: num(flags.pad),
			captionY: num(flags["caption-y"]),
			captionSize: num(flags["caption-size"]),
			forceTvf: flags["force-tvf"] === "true",
		}),
	);
	console.error(
		`[autocut] ${cut.inputSeconds.toFixed(2)} s → ${cut.outputSeconds.toFixed(2)} s · ${cut.cuts} cut(s) · ${cut.retakes.length} retake(s) · ${cut.captions} caption chunks · TVF ${cut.transcript.reused ? "reused" : "ran"} (${cut.transcript.words} words)`,
	);

	const renderOut = join(jobDir, "render.mp4");
	const rendered = await step("render", timings, () =>
		renderJob(jobDir, {
			out: renderOut,
			quality: (flags.quality as RenderQuality) ?? "final",
			gpu: (flags.gpu as GpuMode) ?? "hw",
		}),
	);
	console.error(
		`[render] ${rendered.outputSeconds?.toFixed(2)} s of video in ${seconds(rendered.timings.renderMs ?? 0)} = ${rendered.wallPerOutputSecond?.toFixed(2)} s wall per output second · CPU ${rendered.cpu ? `${rendered.cpu.seconds} s (${rendered.cpu.avgCoresBusy} cores busy, ${rendered.cpu.machinePercent} % of ${rendered.cpu.cores})` : "n/a"}`,
	);

	const masterOut = join(jobDir, "master.mp4");
	const sourceLoudness = await measureLoudness(resolve(video));
	const mastered = await step("master", timings, () => master(renderOut, masterOut));
	console.error(
		`[master] render ${mastered.before.integratedLufs} LUFS / ${mastered.before.truePeakDbtp} dBTP → master ${mastered.after.integratedLufs} LUFS / ${mastered.after.truePeakDbtp} dBTP (${mastered.passes} pass(es), ${mastered.ok ? "on target" : "OFF TARGET"})`,
	);

	const band = captionBand(jobDir);
	const verdict = await step("gate", timings, () =>
		gate(jobDir, masterOut, { quick: flags.quick === "true", band }),
	);
	console.error(`[gate] ${verdict.gate} · must ${verdict.counts.must} · should ${verdict.counts.should} · info ${verdict.counts.info}`);

	const cutTimes = timelineCuts(jobDir);
	const sync = syncCheck(jobDir, cutTimes);
	console.error(
		`[sync] ${sync.matched}/${sync.planned} planned words heard in the render · median offset ${sync.medianOffsetS} s · p90 |offset| ${sync.p90AbsOffsetS} s · missing ${sync.missing.length} (${sync.missing.filter((m) => m.nearCut).length} near a cut)`,
	);

	const frames = await step("frames", timings, () => extractFrames(masterOut, join(jobDir, "look")));
	const masterProbe = await probe(masterOut);
	const summary = {
		schema: "restorffcut-pipeline-demo@1",
		video: resolve(video),
		jobDir,
		input: { seconds: cut.inputSeconds, loudness: sourceLoudness },
		output: { seconds: masterProbe.duration, file: masterOut, probe: masterProbe },
		cut: {
			cuts: cut.cuts,
			removed: cut.removed,
			retakes: cut.retakes,
			captions: cut.captions,
			keptSeconds: cut.outputSeconds,
			tvf: cut.transcript,
		},
		render: {
			seconds: (rendered.timings.renderMs ?? 0) / 1000,
			wallPerOutputSecond: rendered.wallPerOutputSecond,
			cpu: rendered.cpu,
			timings: rendered.timings,
			chrome: rendered.chrome.version,
			gpuMode: rendered.chrome.gpu,
			env: rendered.env,
		},
		master: { before: mastered.before, after: mastered.after, passes: mastered.passes, ok: mastered.ok },
		gate: { state: verdict.gate, counts: verdict.counts, notRun: verdict.notRun, band, findings: verdict.findingsPath },
		sync: { ...sync, cutTimes },
		frames: { dir: join(jobDir, "look"), count: frames },
		timings,
		totalSeconds: Math.round(performance.now() - started) / 1000,
	};
	writeFileSync(join(jobDir, "demo.json"), `${JSON.stringify(summary, null, 1)}\n`);
	console.error("\n[timings] " + Object.entries(timings).map(([k, v]) => `${k} ${seconds(v)}`).join(" · ") + ` · total ${summary.totalSeconds.toFixed(1)} s`);
	console.error(`[gate summary]\n${verdict.summary}`);
	console.log(JSON.stringify({ jobDir, demo: join(jobDir, "demo.json") }));
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const { positional, flags } = parseArgs(rest);
	switch (cmd) {
		case "autocut": {
			const video = positional[0];
			if (!video) throw new Error("usage: autocut <video> --out <job-dir>");
			const result = await autocut(video, {
				out: flags.out ?? defaultJobDir(video),
				silence: num(flags.silence),
				pad: num(flags.pad),
				captionY: num(flags["caption-y"]),
				captionSize: num(flags["caption-size"]),
				forceTvf: flags["force-tvf"] === "true",
				quality: flags.quality === "preview" ? "medium" : "high",
			});
			const { probe: _probe, ...printable } = result;
			console.log(JSON.stringify(printable, null, 1));
			return;
		}
		case "render": {
			const jobDir = positional[0];
			if (!jobDir) throw new Error("usage: render <job-dir> [--out file.mp4]");
			const r = await renderJob(jobDir, {
				out: flags.out ?? join(jobDir, "render.mp4"),
				quality: (flags.quality as RenderQuality) ?? "final",
				gpu: (flags.gpu as GpuMode) ?? "hw",
			});
			console.log(JSON.stringify({ out: r.out, bytes: r.bytes, timings: r.timings, wallPerOutputSecond: r.wallPerOutputSecond, cpu: r.cpu }, null, 1));
			return;
		}
		case "master": {
			const input = positional[0];
			if (!input || !flags.out) throw new Error("usage: master <in.mp4> --out <master.mp4>");
			console.log(JSON.stringify(await master(resolve(input), resolve(flags.out)), null, 1));
			return;
		}
		case "gate": {
			const jobDir = positional[0];
			if (!jobDir) throw new Error("usage: gate <job-dir> [--video master.mp4] [--quick]");
			const video = resolve(flags.video ?? join(jobDir, "master.mp4"));
			if (!existsSync(video)) throw new Error(`no ${video}: render and master first`);
			const r = await gate(resolve(jobDir), video, { quick: flags.quick === "true", band: captionBand(resolve(jobDir)) });
			console.log(JSON.stringify(r, null, 1));
			return;
		}
		case "demo": {
			const video = positional[0];
			if (!video) throw new Error("usage: demo <video> [--out <job-dir>]");
			await demo(video, flags);
			return;
		}
		default:
			console.error("commands: autocut · render · master · gate · demo (see docs/restorff/PIPELINE.md)");
			process.exit(cmd ? 1 : 0);
	}
}

main().catch((e) => {
	console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
