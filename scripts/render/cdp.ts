// Minimal Chrome DevTools Protocol client for the headless render driver, over the runtime's built-in WebSocket
// (Bun and Node >= 22). Same approach as packages/compositions/src/cdp.ts (Playwright's launch() hangs under Bun 1.2.18
// on Windows — compositions DECISION.md), but with GPU-capable flags: the editor's compositor is wgpu on WebGL2 and
// its encoder is WebCodecs, so this launches the full Chromium in `--headless=new` (not chrome-headless-shell with
// --disable-gpu). Runbook: docs/restorff/PIPELINE.md.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

type Json = Record<string, unknown>;

export type GpuMode = "hw" | "swiftshader" | "default";

/** $RESTORFFCUT_CHROME, else the newest Playwright full Chromium (chrome.exe), else the newest headless shell. */
export function findChrome(): string {
	const env = process.env.RESTORFFCUT_CHROME;
	if (env) {
		if (!existsSync(env)) throw new Error(`RESTORFFCUT_CHROME points at a missing file: ${env}`);
		return env;
	}
	const roots = [
		process.env.PLAYWRIGHT_BROWSERS_PATH,
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "ms-playwright"),
		join(homedir(), ".cache", "ms-playwright"),
	].filter((p): p is string => !!p && existsSync(p));
	const found: { rev: number; exe: string; full: boolean }[] = [];
	for (const root of roots) {
		for (const d of readdirSync(root)) {
			const m = d.match(/^(chromium_headless_shell|chromium)-(\d+)$/);
			if (!m) continue;
			const full = m[1] === "chromium";
			const exes = full
				? ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux64/chrome", "chrome-linux/chrome"]
				: ["chrome-headless-shell-win64/chrome-headless-shell.exe", "chrome-headless-shell-linux64/chrome-headless-shell"];
			for (const e of exes) {
				const exe = join(root, d, e);
				if (existsSync(exe)) found.push({ rev: Number(m[2]), exe, full });
			}
		}
	}
	found.sort((a, b) => Number(b.full) - Number(a.full) || b.rev - a.rev);
	if (!found[0]) {
		throw new Error(
			"no Chromium found. Install one with: bunx playwright@1.63.0 install chromium (or set RESTORFFCUT_CHROME)",
		);
	}
	return found[0].exe;
}

export function chromeFlags(gpu: GpuMode): string[] {
	const common = [
		"--headless=new",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-sync",
		"--mute-audio",
		"--autoplay-policy=no-user-gesture-required",
		"--disable-background-timer-throttling",
		"--disable-renderer-backgrounding",
		"--disable-backgrounding-occluded-windows",
		"--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints",
		"--window-size=1280,900",
	];
	if (gpu === "hw") return [...common, "--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"];
	if (gpu === "swiftshader") return [...common, "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
	return common;
}

export interface ConsoleLine {
	type: string;
	text: string;
}

export class Browser {
	private nextId = 0;
	private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }>();
	private listeners = new Map<string, Set<(params: Json) => void>>();
	version = "";
	readonly pid: number;

	private constructor(
		private ws: WebSocket,
		private proc: ChildProcess,
		private userDir: string,
		readonly executable: string,
		readonly flags: string[],
	) {
		this.pid = proc.pid ?? -1;
		ws.onmessage = (ev) => this.onMessage(String(ev.data));
		ws.onclose = () => {
			for (const p of this.pending.values()) p.reject(new Error(`CDP connection closed during ${p.method}`));
			this.pending.clear();
		};
	}

	static async launch(opts: { executable?: string; gpu?: GpuMode; timeoutMs?: number } = {}): Promise<Browser> {
		const exe = opts.executable ?? findChrome();
		const flags = chromeFlags(opts.gpu ?? "hw");
		const userDir = mkdtempSync(join(tmpdir(), "restorffcut-render-"));
		const proc = spawn(exe, [...flags, "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "about:blank"], {
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		});
		const timeoutMs = opts.timeoutMs ?? 30000;
		const wsUrl = await new Promise<string>((resolve, reject) => {
			let buf = "";
			const timer = setTimeout(() => reject(new Error(`Chromium did not start in ${timeoutMs} ms: ${buf.slice(-400)}`)), timeoutMs);
			proc.stderr?.on("data", (d: Buffer) => {
				buf += d.toString();
				const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
				if (m?.[1]) {
					clearTimeout(timer);
					resolve(m[1]);
				}
			});
			proc.on("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
			proc.on("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`Chromium exited (${code}) before DevTools was ready: ${buf.slice(-400)}`));
			});
		});
		const ws = new WebSocket(wsUrl);
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error(`could not open ${wsUrl}`));
		});
		const browser = new Browser(ws, proc, userDir, exe, flags);
		const v = await browser.send("Browser.getVersion");
		browser.version = String(v.product ?? "");
		return browser;
	}

	private onMessage(text: string) {
		const msg = JSON.parse(text) as {
			id?: number;
			result?: Json;
			error?: { message: string };
			method?: string;
			params?: Json;
			sessionId?: string;
		};
		if (msg.id != null) {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
			else p.resolve(msg.result ?? {});
			return;
		}
		if (msg.method) {
			for (const key of [`${msg.sessionId ?? ""}|${msg.method}`, `*|${msg.method}`]) {
				for (const fn of this.listeners.get(key) ?? []) fn(msg.params ?? {});
			}
		}
	}

	send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, method });
			this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
		});
	}

	on(method: string, sessionId: string | "*", fn: (params: Json) => void): void {
		const key = `${sessionId}|${method}`;
		const set = this.listeners.get(key) ?? new Set();
		set.add(fn);
		this.listeners.set(key, set);
	}

	once(method: string, sessionId: string, timeoutMs: number): Promise<Json> {
		const key = `${sessionId}|${method}`;
		return new Promise((resolve, reject) => {
			const set = this.listeners.get(key) ?? new Set();
			this.listeners.set(key, set);
			const timer = setTimeout(() => {
				set.delete(fn);
				reject(new Error(`timed out after ${timeoutMs} ms waiting for ${method}`));
			}, timeoutMs);
			const fn = (p: Json) => {
				clearTimeout(timer);
				set.delete(fn);
				resolve(p);
			};
			set.add(fn);
		});
	}

	async newPage(width: number, height: number): Promise<Page> {
		const { targetId } = (await this.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
		const { sessionId } = (await this.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
		const page = new Page(this, sessionId);
		this.on("Runtime.consoleAPICalled", sessionId, (p) => {
			const args = (p.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
			page.console.push({
				type: String(p.type),
				text: args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" "),
			});
		});
		this.on("Runtime.exceptionThrown", sessionId, (p) => {
			const d = p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
			page.console.push({ type: "exception", text: d?.exception?.description ?? d?.text ?? "exception" });
		});
		await page.send("Page.enable");
		await page.send("Runtime.enable");
		await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
		return page;
	}

	/** Graceful close of the browser this driver launched (its own child process only). */
	async close(): Promise<void> {
		try {
			await Promise.race([this.send("Browser.close"), new Promise((r) => setTimeout(r, 3000))]);
		} catch {
			/* already gone */
		}
		try {
			this.ws.close();
		} catch {
			/* ignore */
		}
		if (this.proc.exitCode == null) {
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, 5000);
				this.proc.once("exit", () => {
					clearTimeout(t);
					resolve();
				});
			});
		}
		for (let i = 0; i < 5; i++) {
			try {
				rmSync(this.userDir, { recursive: true, force: true });
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 300)); // Windows holds file locks briefly after exit
			}
		}
	}
}

export class Page {
	readonly console: ConsoleLine[] = [];
	constructor(
		private browser: Browser,
		readonly sessionId: string,
	) {}

	send(method: string, params: Json = {}): Promise<Json> {
		return this.browser.send(method, params, this.sessionId);
	}

	async navigate(url: string, timeoutMs = 300000): Promise<void> {
		const loaded = this.browser.once("Page.loadEventFired", this.sessionId, timeoutMs);
		const r = (await this.send("Page.navigate", { url })) as { errorText?: string };
		if (r.errorText) throw new Error(`navigate ${url}: ${r.errorText}`);
		await loaded;
	}

	async evaluate<T = unknown>(expression: string, awaitPromise = false): Promise<T> {
		const r = (await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true })) as {
			result?: { value?: T };
			exceptionDetails?: { text?: string; exception?: { description?: string } };
		};
		if (r.exceptionDetails) {
			throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
		}
		return r.result?.value as T;
	}

	async screenshotPng(): Promise<Buffer> {
		const r = (await this.send("Page.captureScreenshot", { format: "png" })) as { data: string };
		return Buffer.from(r.data, "base64");
	}
}
