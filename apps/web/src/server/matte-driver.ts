/**
 * Matte driver (mcp-cutout agent, 2026-10-20): one matte job, run as its own process by `startMatteJob`
 * (server/matte.ts). Launches headless Chromium (scripts/render/cdp.ts: full Chromium, `--headless=new`, GPU flags),
 * opens the dev-only page /matte/<job_id> on the running dev server, starts `window.__restorffcutMatte.run(spec)`,
 * mirrors its progress into job.json every second, then copies person.webm and faces.json out of the page (base64
 * chunks over CDP, like scripts/render/render.ts does with the MP4) and records timings and speeds.
 *
 *   node --experimental-transform-types --no-warnings src/server/matte-driver.ts <job-dir>
 *   bun src/server/matte-driver.ts <job-dir>          (cwd: apps/web; the job dir holds job.json with .spec)
 *
 * Never starts a dev server: if nothing answers at spec.dev_url the job ends in error (BUILD-BRIEF §5: one dev
 * server, the skin agent's). Closes only the Chromium it launched. Runbook: docs/restorff/worklog/mcp-cutout.md.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Browser, type GpuMode, type Page } from "../../../../scripts/render/cdp.ts";
import type { FaceTrack, MatteJob } from "./matte";

type PageState = {
	state: string;
	phase: string;
	progress: number;
	done: number;
	total: number;
	error: string | null;
};

type PageResult = {
	ok: boolean;
	webmBytes: number;
	facesChars: number;
	width: number;
	height: number;
	fps: number;
	frames: number;
	duration: number;
	source: { width: number; height: number; duration: number; fps: number };
	range: { start: number; end: number };
	matteFrames: number;
	faceFrames: number;
	timings: Record<string, number>;
	env: Record<string, unknown>;
};

const dir = resolve(process.argv[2] ?? "");
const jobFile = join(dir, "job.json");
if (!process.argv[2] || !existsSync(jobFile)) {
	console.error("usage: node --experimental-transform-types src/server/matte-driver.ts <job-dir with job.json> (or bun)");
	process.exit(2);
}

let job = JSON.parse(readFileSync(jobFile, "utf8")) as MatteJob;
const spec = job.spec;

function save(patch: Partial<MatteJob>) {
	job = { ...job, ...patch };
	const tmp = `${jobFile}.driver.tmp`;
	writeFileSync(tmp, `${JSON.stringify(job, null, 1)}\n`);
	renameSync(tmp, jobFile);
}

function log(message: string) {
	console.log(`[matte ${new Date().toISOString()}] ${message}`);
}

async function pageUp(url: string): Promise<boolean> {
	try {
		const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(60_000) });
		return response.status < 500;
	} catch {
		return false;
	}
}

async function pull(page: Page, kind: "webm" | "faces", bytes: number): Promise<Buffer> {
	// 1 MB (1.4 MB of base64 per CDP message). Was 4 MB: an 8 s 1080x1920 person.webm (> ~3.7 MB, one 5+ MB message)
	// closed the CDP socket every time ("CDP connection closed during Runtime.evaluate", effects-layers agent
	// 2026-10-20; the 6 s test clip, 2.8 MB, fitted). ASSUMPTION: the client's WebSocket message-size cap.
	const chunk = 1024 * 1024;
	const parts: Buffer[] = [];
	for (let offset = 0; offset < bytes; offset += chunk) {
		const b64 = await page.evaluate<string>(`window.__restorffcutMatte.chunk(${JSON.stringify(kind)}, ${offset}, ${chunk})`, true);
		parts.push(Buffer.from(b64, "base64"));
	}
	const all = Buffer.concat(parts);
	if (all.length !== bytes) throw new Error(`${kind}: transfer size mismatch (${all.length} != ${bytes})`);
	return all;
}

async function main() {
	const t0 = performance.now();
	save({ state: "running", phase: "launch", progress: 0, pid: process.pid, started_at: new Date().toISOString(), error: null });
	if (!(await pageUp(spec.dev_url))) throw new Error(`no dev server answers at ${spec.dev_url} (start it with: cd apps/web && bun run dev)`);
	const gpu = (process.env.RESTORFFCUT_MATTE_GPU as GpuMode | undefined) ?? "hw";
	const tLaunch = performance.now();
	const browser = await Browser.launch({ gpu });
	const launchMs = Math.round(performance.now() - tLaunch);
	log(`${browser.version} (${gpu}) pid ${browser.pid}`);
	const page = await browser.newPage(1280, 900);
	try {
		const tPage = performance.now();
		save({ phase: "page" });
		await page.navigate(`${spec.dev_url}/matte/${encodeURIComponent(spec.job_id)}`);
		// First visit compiles the route in dev: give it a few minutes.
		const readyBy = Date.now() + 300_000;
		let state = "absent";
		while (Date.now() < readyBy) {
			state = await page.evaluate<string>("window.__restorffcutMatte?.state ?? 'absent'");
			if (state === "ready" || state === "error") break;
			await new Promise((r) => setTimeout(r, 500));
		}
		if (state !== "ready") {
			const error = await page.evaluate<string>("window.__restorffcutMatte?.error ?? ''").catch(() => "");
			throw new Error(`matte page not ready (state ${state}) ${error}`);
		}
		const pageMs = Math.round(performance.now() - tPage);
		let tRun = performance.now();
		await page.evaluate(`void window.__restorffcutMatte.run(${JSON.stringify(spec)})`);
		let lastLog = 0;
		let restarts = 0;
		let absentSince: number | null = null;
		for (;;) {
			await new Promise((r) => setTimeout(r, 1000));
			const absent: PageState = { state: "absent", phase: "reloading", progress: 0, done: 0, total: 0, error: null };
			// During a reload the evaluate itself can fail (execution context destroyed): treat it as "absent".
			const s = await page
				.evaluate<PageState>(
					"(() => { const m = window.__restorffcutMatte; return m ? { state: m.state, phase: m.phase, progress: m.progress, done: m.done, total: m.total, error: m.error } : null; })()",
				)
				.then((value) => value ?? absent)
				.catch(() => absent);
			// A dev-server hot reload (another agent's edit) can reload the page mid-run: start the run again (twice).
			if (s.state === "absent" || s.state === "loading" || s.state === "ready") {
				absentSince ??= Date.now();
				if (Date.now() - absentSince > 180_000) throw new Error(`the matte page did not come back after a reload (state ${s.state})`);
				if (s.state === "ready") {
					absentSince = null;
					if (++restarts > 2) throw new Error("the matte page reloaded 3 times during the run (dev-server hot reloads); try again");
					log(`page reloaded during the run; starting again (${restarts}/2)`);
					tRun = performance.now();
					await page.evaluate(`void window.__restorffcutMatte.run(${JSON.stringify(spec)})`);
				}
				continue;
			}
			save({ phase: s.phase, progress: s.progress, done: s.done, total: s.total });
			if (performance.now() - lastLog > 5000) {
				lastLog = performance.now();
				log(`${s.state} ${s.phase} ${s.done}/${s.total} · ${((performance.now() - tRun) / 1000).toFixed(0)} s`);
			}
			if (s.state === "done") break;
			if (s.state === "error") throw new Error(`matte page: ${s.error}`);
		}
		const runMs = Math.round(performance.now() - tRun);
		const result = await page.evaluate<PageResult>("window.__restorffcutMatte.result");
		save({ phase: "transfer" });
		const tTransfer = performance.now();
		const webm = await pull(page, "webm", result.webmBytes);
		const facesText = (await pull(page, "faces", result.facesChars)).toString("utf8");
		const transferMs = Math.round(performance.now() - tTransfer);
		const faces = JSON.parse(facesText) as FaceTrack;
		faces.media_hash = spec.media_hash;
		const webmFile = join(dir, "person.webm");
		const facesFile = join(dir, "faces.json");
		writeFileSync(`${webmFile}.part`, webm);
		renameSync(`${webmFile}.part`, webmFile);
		writeFileSync(`${facesFile}.part`, `${JSON.stringify(faces)}\n`);
		renameSync(`${facesFile}.part`, facesFile);

		const timings = { launch_ms: launchMs, page_ms: pageMs, run_ms: runMs, transfer_ms: transferMs, ...result.timings, total_ms: Math.round(performance.now() - t0) };
		const per = (frames: number, ms: number | undefined) => (ms && ms > 0 ? Math.round((frames / (ms / 1000)) * 10) / 10 : 0);
		const span = result.range.end - result.range.start;
		const speed = {
			segment_fps: per(result.matteFrames, result.timings.segment_ms),
			faces_fps: per(result.faceFrames, result.timings.faces_ms),
			encode_fps: per(result.frames, result.timings.encode_ms),
			/** Media seconds per wall second for the in-page work (model load excluded); >1 = faster than real time. */
			realtime_x: Math.round((span / (runMs / 1000)) * 100) / 100,
			/** Same, for the whole job (Chromium launch + first compile included). */
			realtime_x_total: Math.round((span / (timings.total_ms / 1000)) * 100) / 100,
		};
		save({
			state: "done",
			phase: "done",
			progress: 1,
			finished_at: new Date().toISOString(),
			source: result.source,
			range: result.range,
			outputs: {
				person_webm: { file: "person.webm", bytes: webm.length, width: result.width, height: result.height, fps: result.fps, frames: result.frames, duration: result.duration },
				faces: { file: "faces.json", frames: faces.frames.length },
			},
			timings,
			speed,
			env: { chrome: browser.version, gpu, ...result.env },
			console: page.console.slice(-30),
		});
		log(`done: ${JSON.stringify(speed)}`);
	} catch (error) {
		save({ console: page.console.slice(-60) });
		throw error;
	} finally {
		await browser.close();
	}
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		log(`error: ${message}`);
		try {
			save({ state: "error", error: message, finished_at: new Date().toISOString() });
		} catch {
			/* job folder gone */
		}
		process.exit(1);
	});
