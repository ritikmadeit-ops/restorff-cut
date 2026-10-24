/**
 * Text measuring for captions built on the server (mcp-cut agent, 2026-10-20).
 *
 * The editor places a highlighted / karaoke word over its chunk by MEASURING text (captions/build.ts →
 * createCanvasMeasure: canvas 2D, the renderer's font string, the Google font loaded first). A server has no canvas,
 * so this measures in headless Chromium the same way: the same Google Fonts CSS the editor requests
 * (fonts/google-fonts.ts loadFullFont, weights 400 + 700), the same font string (text/primitives.ts
 * buildTextFontString: `<style> <weight> <px>px "<family>", sans-serif`), canvas letterSpacing like
 * text/layout.ts setCanvasLetterSpacing. Every string is measured once at 100 px with letter spacing 0 and 10 px;
 * width at size s and spacing L = w100 × px(s) / 100 + L × (per-px spacing count). Canvas text width scales
 * linearly with the font size (hinting is off in headless Chromium).
 *
 * If Chromium or the font can't be had, it falls back to the pipeline's estimate (packages/pipeline/src/captions.ts
 * estimateWidthPx: 0.55 em per character, ASSUMPTION checked by eye on renders) and says so in the report.
 *
 * Chromium: RESTORFFCUT_CHROME, else the newest Playwright chrome-headless-shell / chromium (same search as
 * packages/compositions/src/cdp.ts findChrome). One short-lived browser per call (~1 s), its own temp profile.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptionFont, MeasureText } from "@restorffcut/timeline-ops";

export interface MeasureReport {
	method: "chromium" | "estimate";
	browser?: string;
	/** Family → did the real font load (false = measured with a fallback font, or estimated). */
	fonts: Record<string, boolean>;
	strings: number;
	ms: number;
	error?: string;
}

interface FontKey {
	family: string;
	weight: "normal" | "bold";
	italic: boolean;
}

const keyOf = (text: string, font: FontKey) => `${font.family}|${font.weight}|${font.italic ? "i" : "n"}|${text}`;

export function findChromium(): string | null {
	const env = process.env.RESTORFFCUT_CHROME;
	if (env) return existsSync(env) ? env : null;
	const roots = [
		process.env.PLAYWRIGHT_BROWSERS_PATH,
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "ms-playwright"),
		join(homedir(), ".cache", "ms-playwright"),
	].filter((p): p is string => !!p && existsSync(p));
	const candidates: Array<{ rev: number; exe: string; shell: boolean }> = [];
	for (const root of roots) {
		for (const dir of readdirSync(root)) {
			const m = dir.match(/^(chromium_headless_shell|chromium)-(\d+)$/);
			if (!m) continue;
			const shell = m[1] === "chromium_headless_shell";
			const exes = shell
				? ["chrome-headless-shell-win64/chrome-headless-shell.exe", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"]
				: ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux64/chrome", "chrome-linux/chrome"];
			for (const e of exes) {
				const exe = join(root, dir, e);
				if (existsSync(exe)) candidates.push({ rev: Number(m[2]), exe, shell });
			}
		}
	}
	candidates.sort((a, b) => Number(b.shell) - Number(a.shell) || b.rev - a.rev);
	return candidates[0]?.exe ?? null;
}

/** The pipeline's width model (packages/pipeline/src/captions.ts): 0.55 em per character incl. spaces. */
export function estimateWidth(text: string, font: CaptionFont, canvasHeight: number): number {
	const px = (font.size * canvasHeight) / 90;
	return text.length * px * 0.55 + font.letterSpacing * text.length;
}

type Json = Record<string, unknown>;

/** Launch → one Runtime.evaluate → close. Minimal CDP over Node's built-in WebSocket. */
async function evaluateInChromium(expression: string, timeoutMs: number): Promise<{ value: unknown; browser: string }> {
	const exe = findChromium();
	if (!exe) throw new Error("no Chromium found (set RESTORFFCUT_CHROME or install Playwright's chromium-headless-shell)");
	const userDir = mkdtempSync(join(tmpdir(), "restorffcut-measure-"));
	const proc = spawn(
		exe,
		["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu", "--font-render-hinting=none", "--mute-audio", "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "about:blank"],
		{ stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
	);
	let ws: WebSocket | null = null;
	const deadline = setTimeout(() => {
		try {
			ws?.close();
		} catch {
			/* ignore */
		}
		if (proc.exitCode == null) proc.kill();
	}, timeoutMs);
	try {
		const wsUrl = await new Promise<string>((resolve, reject) => {
			let buf = "";
			proc.stderr?.on("data", (d: Buffer) => {
				buf += d.toString();
				const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
				if (m?.[1]) resolve(m[1]);
			});
			proc.on("error", reject);
			proc.on("exit", (code) => reject(new Error(`Chromium exited (${code}) before DevTools was ready: ${buf.slice(-300)}`)));
		});
		const socket = new WebSocket(wsUrl);
		ws = socket;
		await new Promise<void>((resolve, reject) => {
			socket.onopen = () => resolve();
			socket.onerror = () => reject(new Error(`could not open ${wsUrl}`));
		});
		let nextId = 0;
		const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }>();
		socket.onmessage = (event) => {
			const msg = JSON.parse(String(event.data)) as { id?: number; result?: Json; error?: { message: string } };
			if (msg.id == null) return;
			const p = pending.get(msg.id);
			if (!p) return;
			pending.delete(msg.id);
			if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
			else p.resolve(msg.result ?? {});
		};
		socket.onclose = () => {
			for (const p of pending.values()) p.reject(new Error(`CDP closed during ${p.method}`));
			pending.clear();
		};
		const send = (method: string, params: Json = {}, sessionId?: string) =>
			new Promise<Json>((resolve, reject) => {
				const id = ++nextId;
				pending.set(id, { resolve, reject, method });
				socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
			});
		const version = await send("Browser.getVersion");
		const { targetId } = (await send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
		const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
		const r = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)) as {
			result?: { value?: unknown };
			exceptionDetails?: { text?: string; exception?: { description?: string } };
		};
		if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
		try {
			await Promise.race([send("Browser.close"), new Promise((resolve) => setTimeout(resolve, 1500))]);
		} catch {
			/* closing */
		}
		return { value: r.result?.value, browser: String(version.product ?? "") };
	} finally {
		clearTimeout(deadline);
		try {
			ws?.close();
		} catch {
			/* ignore */
		}
		if (proc.exitCode == null) {
			await new Promise<void>((resolve) => {
				const t = setTimeout(() => {
					if (proc.exitCode == null) proc.kill();
					resolve();
				}, 2500);
				proc.once("exit", () => {
					clearTimeout(t);
					resolve();
				});
			});
		}
		for (let i = 0; i < 5; i++) {
			try {
				rmSync(userDir, { recursive: true, force: true });
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 200)); // Windows holds locks briefly after exit
			}
		}
	}
}

/** The page script: load each family from Google Fonts (as the editor does), then measure every string. */
function pageScript(families: string[], items: Array<{ text: string; font: FontKey }>): string {
	const request = JSON.stringify({ families, items: items.map((item) => [item.text, item.font.family, item.font.weight, item.font.italic]) });
	return `(async (req) => {
		const fonts = {};
		for (const family of req.families) {
			const link = document.createElement("link");
			link.rel = "stylesheet";
			link.href = "https://fonts.googleapis.com/css2?family=" + family.replace(/ /g, "+") + ":wght@400;700&display=swap";
			document.head.appendChild(link);
			await new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; setTimeout(resolve, 8000); });
			try { await Promise.all([400, 700].map((w) => document.fonts.load(w + " 100px \\"" + family + "\\""))); } catch (e) {}
			fonts[family] = [...document.fonts].some((face) => face.family.replace(/["']/g, "") === family && face.status === "loaded");
		}
		const ctx = document.createElement("canvas").getContext("2d");
		const out = [];
		for (const [text, family, weight, italic] of req.items) {
			ctx.font = (italic ? "italic" : "normal") + " " + weight + " 100px \\"" + family + "\\", sans-serif";
			ctx.letterSpacing = "0px";
			const w0 = ctx.measureText(text).width;
			ctx.letterSpacing = "10px";
			const w10 = ctx.measureText(text).width;
			out.push([w0, (w10 - w0) / 10]);
		}
		return { fonts, out };
	})(${request})`;
}

/**
 * A measure that writes down every (text, font) it is asked for and answers with the estimate — pass 1 of a caption
 * build, so pass 2 can measure exactly those strings in Chromium (captions-v2: key-word runs, karaoke prefixes …).
 */
export function recordingMeasure(canvasHeight: number): { measure: MeasureText; strings: () => Array<{ text: string; font: FontKey }> } {
	const seen = new Map<string, { text: string; font: FontKey }>();
	const measure: MeasureText = (text, font) => {
		const key: FontKey = { family: font.family, weight: font.weight, italic: font.italic };
		seen.set(keyOf(text, key), { text, font: key });
		return estimateWidth(text, font, canvasHeight);
	};
	return { measure, strings: () => [...seen.values()] };
}

// ─── one text box for the caption builder and the export gate (captions-v2 → gate-v2) ────────────────────────

/** Box of a text element relative to its position, px (the gate's TextRect: left/top from the anchor point). */
export interface TextBoxRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

const numParam = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** The font a text element is drawn with (the editor's params → the measure's font). */
export function fontOfParams(params: Record<string, unknown>): CaptionFont {
	return {
		family: typeof params.fontFamily === "string" && params.fontFamily ? params.fontFamily : "Arial",
		size: numParam(params.fontSize, 15),
		weight: params.fontWeight === "bold" ? "bold" : "normal",
		italic: params.fontStyle === "italic",
		letterSpacing: numParam(params.letterSpacing, 0),
	};
}

/**
 * The editor's box of a text element, from its params (text/layout.ts: getTextRect — lines × line height, aligned on
 * the position — joined with getTextBackgroundRect when the background is on: padding × fontSize / 15, offsets).
 * Unscaled, unrotated: the gate's textBox applies the transform. This is what both the caption builder's safe-area
 * report and (when gate-v2 passes `measureText`) the export gate's SAFE check measure.
 */
export function textBoxOf(params: Record<string, unknown>, canvasHeight: number, measure: MeasureText): TextBoxRect {
	const font = fontOfParams(params);
	const px = (font.size * canvasHeight) / 90;
	const lines = String(params.content ?? "").split("\n");
	const width = Math.max(0, ...lines.map((line) => measure(line, font)));
	const height = lines.length * px * numParam(params.lineHeight, 1.2);
	const left = params.textAlign === "left" ? 0 : params.textAlign === "right" ? -width : -width / 2;
	let rect: TextBoxRect = { left, top: -height / 2, width, height };
	const color = params["background.color"];
	if (params["background.enabled"] === true && color !== "transparent") {
		const ratio = font.size / 15;
		const padX = numParam(params["background.paddingX"], 30) * ratio;
		const padY = numParam(params["background.paddingY"], 42) * ratio;
		const offX = numParam(params["background.offsetX"], 0);
		const offY = numParam(params["background.offsetY"], 0);
		const bg = { left: left - padX + offX, top: -height / 2 - padY + offY, width: width + 2 * padX, height: height + 2 * padY };
		const x0 = Math.min(rect.left, bg.left);
		const y0 = Math.min(rect.top, bg.top);
		const x1 = Math.max(rect.left + rect.width, bg.left + bg.width);
		const y1 = Math.max(rect.top + rect.height, bg.top + bg.height);
		rect = { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
	}
	return rect;
}

/**
 * ONE text measurer for the export gate (gate-v2: pass `measureText` to runTimelineChecks in server/renders-check.ts)
 * and the caption builder: every line of every text element is measured in headless Chromium with the real font (the
 * editor's font string, Google Fonts loaded like the editor), then `measureText(el)` returns the element's box exactly
 * as `textBoxOf` builds it. Falls back to the 0.55 em estimate (and says so in `report`) when Chromium is missing.
 */
export async function prepareTextMeasure(
	elements: ReadonlyArray<{ params?: Record<string, unknown> }>,
	canvasHeight: number,
	opts: { timeoutMs?: number; method?: "chromium" | "estimate" } = {},
): Promise<{ measureText: (element: { params?: Record<string, unknown> }) => TextBoxRect; measure: MeasureText; report: MeasureReport }> {
	const wanted: Array<{ text: string; font: FontKey }> = [];
	for (const element of elements) {
		const params = element.params ?? {};
		const font = fontOfParams(params);
		for (const line of String(params.content ?? "").split("\n")) wanted.push({ text: line, font: { family: font.family, weight: font.weight, italic: font.italic } });
	}
	const { measure, report } = await prepareMeasure(wanted, canvasHeight, opts);
	return { measureText: (element) => textBoxOf(element.params ?? {}, canvasHeight, measure), measure, report };
}

/**
 * Measure every string that `strings()` will need, then hand back a synchronous `MeasureText` (what
 * timeline-ops buildCaptionOps takes). Strings it was not asked for fall back to the estimate.
 */
export async function prepareMeasure(
	wanted: Array<{ text: string; font: FontKey }>,
	canvasHeight: number,
	opts: { timeoutMs?: number; method?: "chromium" | "estimate" } = {},
): Promise<{ measure: MeasureText; report: MeasureReport }> {
	const started = Date.now();
	const unique = new Map<string, { text: string; font: FontKey }>();
	for (const item of wanted) unique.set(keyOf(item.text, item.font), item);
	const items = [...unique.values()];
	const families = [...new Set(items.map((item) => item.font.family))];
	const estimate: MeasureText = (text, font) => estimateWidth(text, font, canvasHeight);
	if (opts.method === "estimate" || !items.length) {
		return { measure: estimate, report: { method: "estimate", fonts: Object.fromEntries(families.map((f) => [f, false])), strings: items.length, ms: Date.now() - started } };
	}
	try {
		const { value, browser } = await evaluateInChromium(pageScript(families, items), opts.timeoutMs ?? 45_000);
		const result = value as { fonts: Record<string, boolean>; out: Array<[number, number]> };
		if (!result || !Array.isArray(result.out) || result.out.length !== items.length) throw new Error("measure page returned no widths");
		const table = new Map<string, [number, number]>();
		items.forEach((item, i) => table.set(keyOf(item.text, item.font), result.out[i]));
		const measure: MeasureText = (text, font) => {
			const hit = table.get(keyOf(text, { family: font.family, weight: font.weight, italic: font.italic }));
			if (!hit) return estimate(text, font);
			const px = font.size * (canvasHeight / 90);
			return (hit[0] * px) / 100 + font.letterSpacing * hit[1];
		};
		return { measure, report: { method: "chromium", browser, fonts: result.fonts, strings: items.length, ms: Date.now() - started } };
	} catch (error) {
		return {
			measure: estimate,
			report: { method: "estimate", fonts: Object.fromEntries(families.map((f) => [f, false])), strings: items.length, ms: Date.now() - started, error: (error as Error).message },
		};
	}
}
