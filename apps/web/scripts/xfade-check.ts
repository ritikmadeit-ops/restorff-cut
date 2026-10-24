/**
 * MEASURE the audio crossfade under a transition on a headless render (docs/restorff/worklog/polish.md §3).
 *
 *   cd apps/web
 *   bun scripts/xfade-check.ts build <job dir OUTSIDE the repo>      # fictional media + project.json + job.json
 *   cd ../.. && bun packages/pipeline/src/cli.ts render <job dir>    # → <job>/render.mp4 (the editor's own export)
 *   cd apps/web && bun scripts/xfade-check.ts measure <job>/render.mp4 [from_s] [to_s]
 *
 * The job: clip A = gradient + 440 Hz sine, clip B = gradient + 1000 Hz sine (4 s each, amplitude 0.25). A plays
 * source 0–3 s on the main track (1 s tail handle), B plays source 1–4 s from 3 s (1 s head handle), joined by a
 * 1.0 s dissolve: the window is 2.50–3.50 s. `measure` prints RMS per 50 ms (ffmpeg astats, mono sum) of the full
 * mix and of each tone band (two cascaded band-passes, Q 10). Hard cut = A drops and B appears inside the 3.00 s
 * window; crossfade = A falls and B rises across 2.50–3.50 s, crossing ~3 dB down at the cut, full mix flat.
 *
 * Needs ffmpeg on PATH; `render` needs the dev server on 8791.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apply, EDITOR_PROJECT_VERSION, type Op, type Project } from "@restorffcut/timeline-ops";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

function build(target: string) {
	const jobDir = resolve(target);
	const rel = relative(REPO, jobDir);
	if (!rel.startsWith("..")) throw new Error(`refusing to write a job inside the repo: ${jobDir}`);
	mkdirSync(join(jobDir, "media"), { recursive: true });

	const makeClip = (file: string, freq: number, c0: string, c1: string) =>
		execFileSync("ffmpeg", [
			"-hide_banner", "-loglevel", "error", "-y",
			"-f", "lavfi", "-i", `gradients=s=540x960:r=30:c0=${c0}:c1=${c1}:duration=4:speed=0.01`,
			"-f", "lavfi", "-i", `sine=f=${freq}:sample_rate=48000:duration=4`,
			"-filter_complex", "[1:a]volume=0.25,aformat=channel_layouts=stereo[a]",
			"-map", "0:v", "-map", "[a]",
			"-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15",
			"-c:a", "aac", "-b:a", "192k", "-shortest",
			join(jobDir, "media", file),
		]);
	makeClip("clip-a.mp4", 440, "0x2F3B40", "0x8C8C95");
	makeClip("clip-b.mp4", 1000, "0x4A3526", "0xE8A33D");

	const now = "2026-10-20T00:00:00.000Z";
	const empty = {
		metadata: { id: "polish-xfade", name: "Halcyon Cold Brew / crossfade check", duration: 0, createdAt: now, updatedAt: now, restorff: { opsVersion: "ops@1", pending: [], media: [] } },
		scenes: [{
			id: "scene-main", name: "Main scene", isMain: true,
			tracks: { overlay: [], main: { id: "trk-main", name: "V1 A-ROLL", type: "video", muted: false, hidden: false, elements: [] }, audio: [] },
			bookmarks: [], createdAt: now, updatedAt: now,
		}],
		currentSceneId: "scene-main",
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 }, canvasSizeMode: "preset", background: { type: "color", color: "#000000" } },
		version: EDITOR_PROJECT_VERSION,
		timelineViewState: { zoomLevel: 1, scrollLeft: 0, playheadTime: 0 },
	} as unknown as Project;

	const ops = [
		{ op: "import_media", author: "user", kind: "video", url: "media/clip-a.mp4", name: "clip-a.mp4", duration: 4, width: 540, height: 960, fps: 30, has_audio: true, ref: "ma" },
		{ op: "import_media", author: "user", kind: "video", url: "media/clip-b.mp4", name: "clip-b.mp4", duration: 4, width: 540, height: 960, fps: 30, has_audio: true, ref: "mb" },
		{ op: "insert", author: "user", track: "main", t: 0, media: "ma", in: 0, out: 3, name: "A 440 Hz", ref: "a" },
		{ op: "insert", author: "user", track: "main", t: 3, media: "mb", in: 1, out: 4, name: "B 1000 Hz", ref: "b" },
		{ op: "transition", author: "user", a: "a", b: "b", kind: "dissolve", dur: 1 },
	] as unknown as Op[];
	const result = apply(empty, ops, { seed: "polish-xfade", at: now });
	if (!result.ok) throw new Error(JSON.stringify(result.conflicts));
	const refs = result.changes.refs;
	result.project.metadata.duration = 6 * 120_000;
	writeFileSync(join(jobDir, "project.json"), `${JSON.stringify(result.project, null, 1)}\n`);
	writeFileSync(join(jobDir, "job.json"), `${JSON.stringify({
		schema: "restorffcut-render-job@1",
		project: "project.json",
		media: [
			{ id: refs.ma, file: "media/clip-a.mp4", type: "video", name: "clip-a.mp4", width: 540, height: 960, duration: 4, fps: 30, hasAudio: true },
			{ id: refs.mb, file: "media/clip-b.mp4", type: "video", name: "clip-b.mp4", width: 540, height: 960, duration: 4, fps: 30, hasAudio: true },
		],
		export: { format: "mp4", quality: "high" },
	}, null, 1)}\n`);
	console.log(`job ready: ${jobDir}\nnext: bun packages/pipeline/src/cli.ts render ${jobDir}   (from the repo root)`);
}

function rmsSeries(file: string, filter: string): Map<string, number> {
	const graph = `${filter}${filter ? "," : ""}aresample=48000,pan=mono|c0=0.5*c0+0.5*c1,asetnsamples=n=2400:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`;
	const out = execFileSync("ffmpeg", ["-hide_banner", "-nostats", "-loglevel", "error", "-i", file, "-af", graph, "-f", "null", "-"], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const series = new Map<string, number>();
	let t = 0;
	for (const line of out.split(/\r?\n/)) {
		const time = line.match(/pts_time:([0-9.]+)/);
		if (time) t = Number(time[1]);
		const rms = line.match(/RMS_level=(-?[0-9.]+|-inf)/);
		if (rms) series.set(t.toFixed(2), rms[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(rms[1]));
	}
	return series;
}

function measure(file: string, from: number, to: number) {
	const full = rmsSeries(file, "");
	const a = rmsSeries(file, "bandpass=f=440:width_type=q:w=10,bandpass=f=440:width_type=q:w=10");
	const b = rmsSeries(file, "bandpass=f=1000:width_type=q:w=10,bandpass=f=1000:width_type=q:w=10");
	const fmt = (v: number | undefined) => (v === undefined ? "   n/a" : Number.isFinite(v) ? v.toFixed(1).padStart(6) : "  -inf");
	console.log(`file ${file}`);
	console.log("window_s     full_dB  A440_dB  B1000_dB");
	for (const key of [...full.keys()].sort((x, y) => Number(x) - Number(y))) {
		const t = Number(key);
		if (t < from - 1e-6 || t > to + 1e-6) continue;
		console.log(`${t.toFixed(2)}-${(t + 0.05).toFixed(2)}  ${fmt(full.get(key))}   ${fmt(a.get(key))}   ${fmt(b.get(key))}`);
	}
}

const [command, arg, from, to] = process.argv.slice(2);
if (command === "build" && arg) build(arg);
else if (command === "measure" && arg) measure(arg, Number(from ?? 2), Number(to ?? 4));
else {
	console.error("usage: bun scripts/xfade-check.ts build <job dir outside the repo> | measure <render.mp4> [from_s] [to_s]");
	process.exit(1);
}
