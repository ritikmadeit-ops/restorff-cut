"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/utils/ui";
import type { CustomKit } from "../custom-api";
import type { ParamValues } from "../types";
import { CHECKER } from "./compose-dialog";

/**
 * Live preview of a custom composition (motion-code agent, 2026-10-20): the code runs in a sandboxed iframe
 * (`sandbox="allow-scripts"`: opaque origin, no access to the editor) with an inline-only CSP (no network at all),
 * with the same runtime, fonts and config the renderer injects. Time is driven from here: the scrubber posts
 * `seek(t)` into the frame (window.__hf), exactly as the renderer seeks frame by frame.
 */

/** No network: scripts/styles inline only; images, fonts and media from data:/blob: only. */
const PREVIEW_CSP =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

/** Text safe to place inside an inline <script>: `</script` must not close it early. */
function scriptSafe(text: string): string {
	return text.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/** The preview document: CSP + config + runtime + bridge, then the composition's own HTML. */
export function buildPreviewDoc({
	source,
	props,
	kit,
	width,
	height,
	fps,
	duration,
	token,
}: {
	source: string;
	props: ParamValues;
	kit: CustomKit;
	width: number;
	height: number;
	fps: number;
	duration: number;
	token: string;
}): string {
	const config = { params: props, width, height, fps, duration, fontData: kit.fontData };
	const bridge = `(function () {
  var TOKEN = ${JSON.stringify(token)};
  function post(m) { m.__rcPreview = TOKEN; try { parent.postMessage(m, "*"); } catch (e) {} }
  function errs() { return (window.RC && window.RC.errors ? window.RC.errors : []).slice(-6); }
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.__rcPreview !== TOKEN || d.type !== "seek") return;
    try { if (window.__hf) window.__hf.seek(d.t); } catch (err) { if (window.RC) window.RC.errors.push(String(err)); }
    post({ type: "status", errors: errs() });
  });
  if (window.RC && window.RC.ready) window.RC.ready.then(function (r) { post({ type: "ready", ok: !!(r && r.ok), errors: errs() }); });
  else post({ type: "ready", ok: false, errors: ["the runtime did not load"] });
})();`;
	const head = [
		`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
		`<script>window.__RC_CONFIG = ${scriptSafe(JSON.stringify(config))};</script>`,
		`<script>${scriptSafe(kit.runtime)}</script>`,
		`<script>${bridge}</script>`,
	].join("\n");
	// the optional `<script src="…runtime.js">` line is for standalone files; here the runtime is already inline
	const html = source.replace(/<script\b[^>]*\ssrc\s*=\s*["']?[^"'\s>]*runtime\.js[^"'\s>]*["']?[^>]*>\s*<\/script\s*>/gi, "");
	if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (tag) => `${tag}\n${head}\n`);
	if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${head}</head>`);
	return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

export interface PreviewStatus {
	state: "loading" | "ready" | "failed";
	errors: string[];
}

/**
 * The sandboxed frame, scaled to fit `boxWidth`. Renders at a reduced size (short side ≤ 540 px): compositions draw on
 * a 1080 grid (RC.u), so a smaller page is the same picture, cheaper.
 */
export function CodePreview({
	source,
	props,
	kit,
	canvas,
	duration,
	t,
	boxWidth,
	onStatus,
}: {
	source: string;
	props: ParamValues;
	kit: CustomKit | null;
	canvas: { width: number; height: number; fps: number };
	duration: number;
	t: number;
	boxWidth: number;
	onStatus?: (status: PreviewStatus) => void;
}) {
	const frameRef = useRef<HTMLIFrameElement>(null);
	const token = useMemo(() => `rc-${Math.floor(Math.random() * 1e12).toString(36)}`, []);
	const [ready, setReady] = useState(false);
	const tRef = useRef(t);
	tRef.current = t;

	const k = Math.min(1, 540 / Math.min(canvas.width, canvas.height));
	const width = Math.max(2, Math.round((canvas.width * k) / 2) * 2);
	const height = Math.max(2, Math.round((canvas.height * k) / 2) * 2);
	const scale = boxWidth / width;

	const doc = useMemo(
		() => (kit ? buildPreviewDoc({ source, props, kit, width, height, fps: canvas.fps, duration, token }) : ""),
		[source, props, kit, width, height, canvas.fps, duration, token],
	);

	useEffect(() => {
		setReady(false);
		onStatus?.({ state: "loading", errors: [] });
		const onMessage = (event: MessageEvent) => {
			const data = event.data as { __rcPreview?: string; type?: string; ok?: boolean; errors?: string[] } | null;
			if (!data || data.__rcPreview !== token || event.source !== frameRef.current?.contentWindow) return;
			if (data.type === "ready") {
				setReady(true);
				onStatus?.({ state: data.ok ? "ready" : "failed", errors: data.errors ?? [] });
				frameRef.current?.contentWindow?.postMessage({ __rcPreview: token, type: "seek", t: tRef.current }, "*");
			} else if (data.type === "status" && data.errors?.length) {
				onStatus?.({ state: "failed", errors: data.errors });
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
		// onStatus is a callback prop; re-subscribing on each doc is what matters
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [doc, token]);

	useEffect(() => {
		if (!ready) return;
		frameRef.current?.contentWindow?.postMessage({ __rcPreview: token, type: "seek", t }, "*");
	}, [t, ready, token]);

	return (
		<div
			className="border-line relative shrink-0 overflow-hidden rounded-[14px] border"
			style={{ width: boxWidth, height: height * scale, background: CHECKER }}
		>
			{kit ? (
				<iframe
					ref={frameRef}
					title="Custom composition preview"
					sandbox="allow-scripts"
					srcDoc={doc}
					className={cn("absolute top-0 left-0 border-0 transition-opacity", ready ? "opacity-100" : "opacity-40")}
					style={{
						width,
						height,
						transform: `scale(${scale})`,
						transformOrigin: "0 0",
						colorScheme: "normal",
						background: "transparent",
					}}
				/>
			) : (
				<div className="text-fog absolute inset-0 grid place-items-center text-xs">loading the runtime…</div>
			)}
		</div>
	);
}
