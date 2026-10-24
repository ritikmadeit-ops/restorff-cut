// Minimal Chrome DevTools Protocol client over the runtime's built-in WebSocket (works in Bun and Node >= 22).
// Why not Playwright/Puppeteer: under Bun 1.2.18 on Windows Playwright's launch() hangs and its `ws` transport
// fails (DECISION.md). This file needs nothing but a Chromium binary.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

type Json = Record<string, unknown>;
interface Pending {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
  method: string;
}

/** Locate a Chromium: $RESTORFFCUT_CHROME, else the newest Playwright chromium-headless-shell, else Playwright chromium. */
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
    join(homedir(), "Library", "Caches", "ms-playwright"),
  ].filter((p): p is string => !!p && existsSync(p));
  const candidates: { rev: number; exe: string; shell: boolean }[] = [];
  for (const root of roots) {
    for (const d of readdirSync(root)) {
      const m = d.match(/^(chromium_headless_shell|chromium)-(\d+)$/);
      if (!m) continue;
      const shell = m[1] === "chromium_headless_shell";
      const exes = shell
        ? [
            "chrome-headless-shell-win64/chrome-headless-shell.exe",
            "chrome-headless-shell-linux64/chrome-headless-shell",
            "chrome-headless-shell-mac-arm64/chrome-headless-shell",
            "chrome-headless-shell-mac-x64/chrome-headless-shell",
            "chrome-linux/headless_shell",
          ]
        : [
            "chrome-win64/chrome.exe",
            "chrome-win/chrome.exe",
            "chrome-linux64/chrome",
            "chrome-linux/chrome",
            "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
            "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
          ];
      for (const e of exes) {
        const exe = join(root, d, e);
        if (existsSync(exe)) candidates.push({ rev: Number(m[2]), exe, shell });
      }
    }
  }
  candidates.sort((a, b) => Number(b.shell) - Number(a.shell) || b.rev - a.rev);
  const best = candidates[0];
  if (!best) {
    throw new Error(
      "no Chromium found. Install one with: bunx playwright@1.63.0 install --only-shell chromium " +
        "(or set RESTORFFCUT_CHROME to a chrome / chrome-headless-shell executable)",
    );
  }
  return best.exe;
}

/** Flags chosen for identical pixels run to run: software raster, sRGB, no LCD text, no background throttling. */
export const CHROME_FLAGS = [
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-sync",
  "--disable-gpu",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--disable-lcd-text",
  "--hide-scrollbars",
  "--mute-audio",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--allow-file-access-from-files",
  "--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints",
  // finish raster before drawing; no async image decode; no compositor-thread animation (as HyperFrames' engine does)
  "--run-all-compositor-stages-before-draw",
  "--disable-checker-imaging",
  "--disable-threaded-animation",
  "--disable-threaded-scrolling",
  "--disable-new-content-rendering-timeout",
  "--disable-image-animation-resync",
  // one raster thread per renderer: tiles never race for shared glyph/blur caches inside a tab
  "--num-raster-threads=1",
  // WebGL (Three.js, shader blocks) runs on ANGLE + SwiftShader (CPU) under --disable-gpu: MEASURED on headless shell
  // 153, WebGL 1 and 2 report "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))" with or without this
  // flag; Chromium is retiring the automatic SwiftShader fallback, and this flag keeps it (anim-runtime, wave 7)
  "--enable-unsafe-swiftshader",
];

export class Browser {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(params: Json) => void>>();
  version = "";
  private ws: WebSocket;
  private proc: ChildProcess;
  private userDir: string;

  private constructor(ws: WebSocket, proc: ChildProcess, userDir: string) {
    this.ws = ws;
    this.proc = proc;
    this.userDir = userDir;
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error(`CDP connection closed during ${p.method}`));
      this.pending.clear();
    };
  }

  /** `extraFlags` go after CHROME_FLAGS (custom.ts adds the no-network flags for untrusted compositions). */
  static async launch(opts: { executable?: string; timeoutMs?: number; extraFlags?: string[] } = {}): Promise<Browser> {
    const exe = opts.executable ?? findChrome();
    const userDir = mkdtempSync(join(tmpdir(), "restorffcut-chrome-"));
    const flags = [...CHROME_FLAGS, ...(opts.extraFlags ?? [])];
    const proc = spawn(exe, [...flags, "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "about:blank"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`Chromium did not start in ${opts.timeoutMs ?? 20000} ms: ${buf.slice(-400)}`)), opts.timeoutMs ?? 20000);
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
    const b = new Browser(ws, proc, userDir);
    const v = await b.send("Browser.getVersion");
    b.version = String(v.product ?? "");
    return b;
  }

  private onMessage(text: string) {
    const msg = JSON.parse(text) as { id?: number; result?: Json; error?: { message: string }; method?: string; params?: Json; sessionId?: string };
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const key = `${msg.sessionId ?? ""}|${msg.method}`;
      for (const fn of this.listeners.get(key) ?? []) fn(msg.params ?? {});
    }
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  /** Call `fn` on every `method` event from this session until the returned function is called. */
  on(method: string, sessionId: string, fn: (params: Json) => void): () => void {
    const key = `${sessionId}|${method}`;
    const set = this.listeners.get(key) ?? new Set();
    this.listeners.set(key, set);
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Resolve on the next `method` event from this session. */
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

  /**
   * A tab in its own browser context, so its own renderer process: tabs then share no raster caches, whose
   * timing-dependent reuse made pixels differ by 1/255 between runs (MEASURED 2026-10-20, LEARNINGS.md §2).
   */
  async newPage(width: number, height: number): Promise<Page> {
    const { browserContextId } = (await this.send("Target.createBrowserContext", { disposeOnDetach: true })) as { browserContextId: string };
    const { targetId } = (await this.send("Target.createTarget", { url: "about:blank", browserContextId })) as { targetId: string };
    const { sessionId } = (await this.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    const page = new Page(this, sessionId, targetId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await page.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    return page;
  }

  async close(): Promise<void> {
    try {
      await Promise.race([this.send("Browser.close"), new Promise((r) => setTimeout(r, 2000))]);
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
        const t = setTimeout(() => {
          this.proc.kill();
          resolve();
        }, 3000);
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
        await new Promise((r) => setTimeout(r, 200)); // Windows keeps file locks for a moment after exit
      }
    }
  }
}

export class Page {
  private browser: Browser;
  readonly sessionId: string;
  readonly targetId: string;

  constructor(browser: Browser, sessionId: string, targetId: string) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method: string, params: Json = {}): Promise<Json> {
    return this.browser.send(method, params, this.sessionId);
  }

  /** Run before any page script on every navigation. */
  async addInitScript(source: string): Promise<void> {
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  async navigate(url: string, timeoutMs = 30000): Promise<void> {
    const loaded = this.browser.once("Page.loadEventFired", this.sessionId, timeoutMs);
    const r = (await this.send("Page.navigate", { url })) as { errorText?: string };
    if (r.errorText) throw new Error(`navigate ${url}: ${r.errorText}`);
    await loaded;
  }

  /** Evaluate an expression; returns its JSON value. Throws on a page exception. */
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

  /**
   * PNG with a real alpha channel. HyperFrames reports that `optimizeForSpeed: true` crushes partial alpha; on
   * Chromium 153 with these flags it gave pixel-identical RGBA (MEASURED 2026-10-20, 4 frames with blur, shadows,
   * 50 % fills) and is ~25 % faster, so it is the default. RESTORFFCUT_CAPTURE=safe switches it off;
   * test/render.test.ts re-checks the equality on every run.
   */
  async screenshotPng(fast = process.env.RESTORFFCUT_CAPTURE !== "safe"): Promise<Buffer> {
    const r = (await this.send("Page.captureScreenshot", { format: "png", fromSurface: true, optimizeForSpeed: fast })) as { data: string };
    return Buffer.from(r.data, "base64");
  }

  async setBackground(rgba: { r: number; g: number; b: number; a: number }): Promise<void> {
    await this.send("Emulation.setDefaultBackgroundColorOverride", { color: rgba });
  }
}
