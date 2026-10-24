#!/usr/bin/env bun
// Headless render driver (spike S2): opens /render/<job> on the RestorffCut dev server in headless Chromium, runs the
// editor's OWN export (window.__restorffcutRender.start → editor.project.export), and writes the MP4 bytes to --out.
// Measures wall time per second of output, Chromium's CPU time (whole process tree), and what works headless
// (WebGL2 renderer, WebCodecs H.264/AAC). Runbook: docs/restorff/PIPELINE.md.
//
//   bun scripts/render/render.ts <job-dir> --out out.mp4 [--quality preview|final] [--gpu hw|swiftshader|default]
//
// Exit codes: 0 rendered · 1 failed (message on stderr; render.json in the job dir says where).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DEV_URL, REPO_ROOT } from "../../packages/pipeline/src/paths.ts";
import { probe } from "../../packages/pipeline/src/util.ts";
import { Browser, type GpuMode } from "./cdp.ts";

export type RenderQuality = "preview" | "final";

export interface RenderOptions {
	out: string;
	quality?: RenderQuality;
	gpu?: GpuMode;
	devUrl?: string;
	/** Save a screenshot of the render page (debug). */
	screenshot?: boolean;
}

export interface RenderReport {
	ok: boolean;
	error?: string;
	job: string;
	jobDir: string;
	out: string;
	devUrl: string;
	chrome: { executable: string; version: string; gpu: GpuMode; flags: string[] };
	env?: Record<string, unknown>;
	info?: Record<string, unknown>;
	timings: {
		launchMs?: number;
		pageLoadMs?: number;
		editorLoadMs?: number;
		renderMs?: number;
		transferMs?: number;
		totalMs?: number;
	};
	outputSeconds?: number;
	wallPerOutputSecond?: number;
	cpu?: { seconds: number; cores: number; avgCoresBusy: number; machinePercent: number } | null;
	bytes?: number;
	probe?: unknown;
	console: Array<{ type: string; text: string }>;
}

const QUALITY: Record<RenderQuality, "medium" | "high"> = { preview: "medium", final: "high" };

/**
 * CPU seconds of a process and all its descendants (Windows: one CIM query). Null where unsupported — or when the
 * query does not answer within 10 s: on 2026-10-24 from ~14:16 IST this machine's WMI stopped answering
 * (`Get-CimInstance Win32_Process` > 40 s while `Get-Process` took 1 s, MEASURED by anim-runtime) and every server
 * render hung right after its `job` line, waiting here. The figure is diagnostics only; a render never waits for it.
 */
export async function processTreeCpuSeconds(rootPid: number, timeoutMs = 10000): Promise<number | null> {
	if (process.platform !== "win32" || rootPid <= 0) return null;
	const r = await new Promise<{ code: number; stdout: string } | null>((resolveQuery) => {
		const child = spawn(
			"powershell",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime | ConvertTo-Json -Compress",
			],
			{ stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
		);
		let stdout = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		const timer = setTimeout(() => {
			child.kill(); // our own query process, nothing else
			resolveQuery(null);
		}, timeoutMs);
		child.on("error", () => {
			clearTimeout(timer);
			resolveQuery(null);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveQuery({ code: code ?? -1, stdout });
		});
	});
	if (!r || r.code !== 0) {
		if (!r) console.error(`[render] CPU accounting skipped: the process query did not answer in ${timeoutMs / 1000} s (WMI)`);
		return null;
	}
	const rows = JSON.parse(r.stdout) as Array<{
		ProcessId: number;
		ParentProcessId: number;
		KernelModeTime: number;
		UserModeTime: number;
	}>;
	const children = new Map<number, number[]>();
	for (const row of rows) {
		const list = children.get(row.ParentProcessId) ?? [];
		list.push(row.ProcessId);
		children.set(row.ParentProcessId, list);
	}
	const byPid = new Map(rows.map((row) => [row.ProcessId, row]));
	let total = 0;
	const stack = [rootPid];
	const seen = new Set<number>();
	while (stack.length) {
		const pid = stack.pop() as number;
		if (seen.has(pid)) continue;
		seen.add(pid);
		const row = byPid.get(pid);
		if (row) total += (Number(row.KernelModeTime) + Number(row.UserModeTime)) / 1e7;
		for (const child of children.get(pid) ?? []) stack.push(child);
	}
	return total;
}

/**
 * "up" = anything answered (even a 500), "down" = nothing listening. Incident 2026-10-20: another agent's half-done
 * edit made every route 500 ("Module not found"); treating that as "down" made the driver start a SECOND dev server.
 */
async function serverState(url: string): Promise<{ up: boolean; ok: boolean; error?: string }> {
	try {
		const r = await fetch(`${url}/api/render-jobs`, { signal: AbortSignal.timeout(180000) });
		if (r.ok) return { up: true, ok: true };
		const body = await r.text();
		const message = body.match(/"message":"([^"]{0,400})/)?.[1]?.replace(/\\n/g, " ") ?? body.slice(0, 300);
		return { up: true, ok: false, error: `HTTP ${r.status}: ${message}` };
	} catch {
		return { up: false, ok: false };
	}
}

/**
 * The dev server is the skin agent's (BUILD-BRIEF §5). Down (nothing listening) → start it in the background.
 * Up but failing (a compile error from someone's edit) → wait up to `waitMs` for it to recover; never start another.
 */
export async function ensureDevServer(url: string, waitMs = 600000): Promise<void> {
	const first = await serverState(url);
	if (first.ok) return;
	if (first.up) {
		console.error(`[render] dev server answers but fails (${first.error}); waiting up to ${waitMs / 1000} s for it to recover`);
		const until = Date.now() + waitMs;
		while (Date.now() < until) {
			await new Promise((r) => setTimeout(r, 10000));
			const s = await serverState(url);
			if (s.ok) return;
		}
		throw new Error(`dev server at ${url} still failing after ${waitMs / 1000} s: ${first.error}`);
	}
	const web = join(REPO_ROOT, "apps", "web");
	const log = join(tmpdir(), "restorffcut-dev-server.log");
	console.error(`[render] dev server ${url} is down; starting it in the background (log: ${log})`);
	const fd = openSync(log, "a");
	const child = spawn("bun", ["run", "dev"], { cwd: web, detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
	child.unref();
	const deadline = Date.now() + 240000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 3000));
		if ((await serverState(url)).ok) return;
	}
	throw new Error(`dev server did not come up at ${url} within 240 s (see ${log})`);
}

/** Make the job visible to the server: a folder in its jobs root, or a `<job>.path` pointer file there. */
export async function registerJob(url: string, jobDir: string): Promise<string> {
	const r = await fetch(`${url}/api/render-jobs`);
	if (!r.ok) throw new Error(`GET ${url}/api/render-jobs: HTTP ${r.status}`);
	const { root } = (await r.json()) as { root: string };
	const job = basename(jobDir).replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "job";
	if (resolve(dirname(jobDir)).toLowerCase() !== resolve(root).toLowerCase() || basename(jobDir) !== job) {
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, `${job}.path`), resolve(jobDir));
	}
	return job;
}

export async function renderJob(jobDirInput: string, opts: RenderOptions): Promise<RenderReport> {
	const jobDir = resolve(jobDirInput);
	if (!existsSync(join(jobDir, "job.json"))) throw new Error(`${jobDir} has no job.json (run the autocut step first)`);
	const devUrl = (opts.devUrl ?? DEV_URL).replace(/\/$/, "");
	const quality = opts.quality ?? "final";
	const gpu = opts.gpu ?? "hw";
	const out = resolve(opts.out);
	const t0 = performance.now();
	const report: RenderReport = {
		ok: false,
		job: basename(jobDir),
		jobDir,
		out,
		devUrl,
		chrome: { executable: "", version: "", gpu, flags: [] },
		timings: {},
		console: [],
	};
	const writeReport = () => writeFileSync(join(jobDir, "render.json"), `${JSON.stringify(report, null, 1)}\n`);

	await ensureDevServer(devUrl);
	const job = await registerJob(devUrl, jobDir);
	report.job = job;

	let tLaunch = performance.now();
	const browser = await Browser.launch({ gpu });
	report.timings.launchMs = Math.round(performance.now() - tLaunch);
	report.chrome = { executable: browser.executable, version: browser.version, gpu, flags: browser.flags };
	console.error(`[render] ${browser.version} (${gpu}) pid ${browser.pid}`);
	const page = await browser.newPage(1280, 900);
	try {
		tLaunch = performance.now();
		await page.navigate(`${devUrl}/render/${encodeURIComponent(job)}`);
		report.timings.pageLoadMs = Math.round(performance.now() - tLaunch);

		// Wait for the editor core to load the job (first visit compiles the route: can take a minute).
		const readyDeadline = Date.now() + 300000;
		let state = "";
		while (Date.now() < readyDeadline) {
			state = await page.evaluate<string>("window.__restorffcutRender?.state ?? 'absent'");
			if (state === "ready" || state === "error") break;
			await new Promise((r) => setTimeout(r, 500));
		}
		if (state !== "ready") {
			const err = await page.evaluate<string>("window.__restorffcutRender?.error ?? ''");
			throw new Error(`render page not ready (state ${state}): ${err}`);
		}
		report.timings.editorLoadMs = await page.evaluate<number>("window.__restorffcutRender.loadMs");
		report.info = await page.evaluate<Record<string, unknown>>("window.__restorffcutRender.info");
		report.env = await page.evaluate<Record<string, unknown>>("window.__restorffcutRender.env()", true);
		console.error(`[render] env ${JSON.stringify(report.env)}`);
		console.error(`[render] job ${JSON.stringify(report.info)}`);

		const cpuBefore = await processTreeCpuSeconds(browser.pid);
		const tRender = performance.now();
		await page.evaluate(`void window.__restorffcutRender.start({ quality: ${JSON.stringify(QUALITY[quality])} })`);
		let lastPrint = 0;
		for (;;) {
			await new Promise((r) => setTimeout(r, 1000));
			const s = await page.evaluate<{ state: string; progress: number; error: string | null }>(
				"({ state: window.__restorffcutRender.state, progress: window.__restorffcutRender.progress, error: window.__restorffcutRender.error })",
			);
			if (performance.now() - lastPrint > 5000) {
				lastPrint = performance.now();
				console.error(`[render] ${s.state} ${(s.progress * 100).toFixed(1)}% · ${((performance.now() - tRender) / 1000).toFixed(0)} s`);
			}
			if (s.state === "done") break;
			if (s.state === "error") throw new Error(`export failed: ${s.error}`);
		}
		const wallRenderMs = Math.round(performance.now() - tRender);
		const cpuAfter = await processTreeCpuSeconds(browser.pid);
		const result = await page.evaluate<{ bytes: number; renderMs: number; durationSeconds: number }>(
			"window.__restorffcutRender.result",
		);
		report.timings.renderMs = result.renderMs ?? wallRenderMs;

		const tTransfer = performance.now();
		const chunk = 4 * 1024 * 1024;
		const parts: Buffer[] = [];
		for (let offset = 0; offset < result.bytes; offset += chunk) {
			const b64 = await page.evaluate<string>(`window.__restorffcutRender.chunk(${offset}, ${chunk})`, true);
			parts.push(Buffer.from(b64, "base64"));
		}
		const bytes = Buffer.concat(parts);
		if (bytes.length !== result.bytes) throw new Error(`transfer size mismatch: ${bytes.length} != ${result.bytes}`);
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, bytes);
		report.timings.transferMs = Math.round(performance.now() - tTransfer);
		report.bytes = bytes.length;

		report.outputSeconds = result.durationSeconds;
		report.wallPerOutputSecond = report.timings.renderMs / 1000 / result.durationSeconds;
		const cores = cpus().length;
		if (cpuBefore != null && cpuAfter != null) {
			const cpuSeconds = cpuAfter - cpuBefore;
			const busy = cpuSeconds / (wallRenderMs / 1000);
			report.cpu = {
				seconds: Math.round(cpuSeconds * 10) / 10,
				cores,
				avgCoresBusy: Math.round(busy * 100) / 100,
				machinePercent: Math.round((busy / cores) * 1000) / 10,
			};
		} else {
			report.cpu = null;
		}
		report.probe = await probe(out);
		report.ok = true;
		if (opts.screenshot) writeFileSync(join(jobDir, "render-page.png"), await page.screenshotPng());
	} catch (error) {
		report.error = error instanceof Error ? error.message : String(error);
		try {
			writeFileSync(join(jobDir, "render-page.png"), await page.screenshotPng());
		} catch {
			/* page gone */
		}
	} finally {
		report.console = page.console.slice(-200);
		await browser.close();
		report.timings.totalMs = Math.round(performance.now() - t0);
		writeReport();
	}
	if (!report.ok) throw new Error(`render failed: ${report.error} (details: ${join(jobDir, "render.json")})`);
	return report;
}

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

const isMain = process.argv[1] && /render[\\/]render\.ts$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	const jobDir = positional[0];
	if (!jobDir || flags.help) {
		console.error("usage: bun scripts/render/render.ts <job-dir> --out out.mp4 [--quality preview|final] [--gpu hw|swiftshader|default] [--screenshot]");
		process.exit(jobDir ? 0 : 1);
	}
	const out = flags.out ?? join(jobDir, "render.mp4");
	renderJob(jobDir, {
		out,
		quality: (flags.quality as RenderQuality) ?? "final",
		gpu: (flags.gpu as GpuMode) ?? "hw",
		screenshot: flags.screenshot === "true",
	})
		.then((r) => {
			console.log(
				JSON.stringify(
					{
						out: r.out,
						bytes: r.bytes,
						outputSeconds: r.outputSeconds,
						renderSeconds: (r.timings.renderMs ?? 0) / 1000,
						wallPerOutputSecond: r.wallPerOutputSecond,
						cpu: r.cpu,
						webgl2Renderer: r.env?.webgl2Renderer,
						avc: r.env?.videoEncoderAvc1080x1920,
					},
					null,
					1,
				),
			);
		})
		.catch((e) => {
			console.error(String(e instanceof Error ? e.message : e));
			process.exit(1);
		});
}
