/**
 * Browser client for custom compositions (motion-code agent, 2026-10-20): HTML/CSS/JS written in the Code view or by
 * Claude over MCP. Server side: app/api/compositions/custom/** → packages/compositions src/custom.ts (validated,
 * rendered with the network blocked, cached by hash). Runbook: docs/restorff/worklog/motion-code.md.
 *
 * Imports nothing from ./drop at run time (drop.ts uses renderCustomAndProcess for re-renders).
 */
import { processMediaAssets } from "@/media/processing";
import type { ImportedRender } from "./drop";
import type { CustomCompositionSource, ParamSpec, ParamValues, RenderAnswer } from "./types";

export interface CustomReport {
	errors: string[];
	warnings: string[];
	protocol: "rc" | "hf" | null;
	sourceBytes: number;
	network: "blocked";
	/** URLs the code tried to load while rendering (all were blocked). */
	blocked: string[];
}

export interface CustomRenderAnswer extends RenderAnswer {
	title: string;
	report: CustomReport;
}

export interface CustomManifest {
	name: string;
	title: string;
	description: string;
	duration: number;
	size: [number, number];
	fps: number;
	params: Record<string, ParamSpec>;
}

export interface CustomValidation {
	ok: boolean;
	errors: string[];
	warnings: string[];
	manifest: CustomManifest | null;
	values: ParamValues;
	protocol: "rc" | "hf" | null;
	bytes: number;
}

export interface CustomKit {
	runtime: string;
	fontData: Record<string, string>;
	renderer: string;
	limits: { maxBytes: number; maxSeconds: number };
	defaults: { width: number; height: number; fps: number; duration: number };
}

export interface CustomExample {
	name: string;
	title: string;
	description: string;
	duration: number;
	size: [number, number];
	file: string;
	source: string;
	props: ParamValues;
}

/** A refused render: `report.errors` says why, one line each (with "line N:" when it points into the code). */
export class CustomRefusedError extends Error {
	constructor(
		message: string,
		readonly report: { errors: string[]; warnings: string[] } | null,
	) {
		super(message);
	}
}

async function readJson<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => null)) as
		| (T & { error?: string; report?: { errors: string[]; warnings: string[] } })
		| null;
	if (!response.ok || !body) {
		throw new CustomRefusedError(body?.error ?? `request failed (${response.status})`, body?.report ?? null);
	}
	return body;
}

export async function validateCustomSource({
	source,
	props,
}: {
	source: string;
	props: ParamValues;
}): Promise<CustomValidation> {
	const response = await fetch("/api/compositions/custom/validate", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source, props }),
	});
	return readJson<CustomValidation>(response);
}

export async function renderCustomComposition({
	source,
	props,
	duration,
	width,
	height,
	fps,
}: {
	source: string;
	props: ParamValues;
	duration?: number;
	width: number;
	height: number;
	fps: number;
}): Promise<CustomRenderAnswer> {
	const response = await fetch("/api/compositions/custom", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source, props, duration_s: duration, width, height, fps }),
	});
	return readJson<CustomRenderAnswer>(response);
}

let kitPromise: Promise<CustomKit> | null = null;
/** Runtime + fonts for the sandboxed preview (cached for the page's life). */
export function fetchCustomKit(): Promise<CustomKit> {
	if (!kitPromise) {
		kitPromise = fetch("/api/compositions/custom/kit")
			.then((response) => readJson<CustomKit>(response))
			.catch((error) => {
				kitPromise = null;
				throw error;
			});
	}
	return kitPromise;
}

let examplesPromise: Promise<CustomExample[]> | null = null;
export function fetchCustomExamples(): Promise<CustomExample[]> {
	if (!examplesPromise) {
		examplesPromise = fetch("/api/compositions/custom/examples")
			.then((response) => readJson<{ examples: CustomExample[] }>(response))
			.then((body) => body.examples)
			.catch((error) => {
				examplesPromise = null;
				throw error;
			});
	}
	return examplesPromise;
}

/**
 * Render a custom composition at the canvas size (or hit the cache), download it and run it through the editor's
 * media processing. Nothing is committed. The returned `source` is what the clip stores in `restorff.composition`.
 */
export async function renderCustomAndProcess({
	source,
	props,
	duration,
	canvas,
	author,
}: {
	source: string;
	props: ParamValues;
	duration?: number;
	canvas: { width: number; height: number; fps: number };
	author: "claude" | "user";
}): Promise<ImportedRender & { answer: CustomRenderAnswer; source: CustomCompositionSource }> {
	const answer = await renderCustomComposition({ source, props, duration, ...canvas });
	const response = await fetch(answer.url);
	if (!response.ok) throw new Error(`could not fetch the render (${response.status})`);
	const blob = await response.blob();
	const title = answer.title || "Custom composition";
	const safe = title.replace(/[^\w\- ·]+/g, "").trim() || "custom";
	const file = new File([blob], `${safe} · code · ${answer.hash.slice(0, 6)}.webm`, { type: "video/webm" });
	const [asset] = await processMediaAssets({ files: [file] });
	if (!asset) throw new Error(`the editor could not import the ${title} render`);
	return {
		answer,
		asset,
		title,
		source: {
			custom: true,
			name: answer.name || "custom",
			title,
			source,
			props,
			hash: answer.hash,
			width: answer.width,
			height: answer.height,
			fps: answer.fps,
			duration: answer.duration,
			author,
		},
	};
}

/** A blank starter a person can type into (valid as is: params block + RC.composition with build and render). */
export const BLANK_CUSTOM_SOURCE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script type="application/json" id="params">
{
  "name": "my-word",
  "title": "My word",
  "description": "One word scales in, holds, and fades out. Start here and change anything.",
  "duration": 3,
  "params": {
    "word": { "type": "string", "default": "STEEP", "maxLength": 20, "label": "Word", "description": "The word on screen." },
    "accent": { "type": "color", "default": "#F6FF00", "label": "Accent", "description": "The underline." },
    "speed": { "type": "number", "default": 1, "min": 0.25, "max": 4, "step": 0.01, "label": "Speed", "description": "Motion speed." },
    "exit": { "type": "boolean", "default": true, "label": "Animate out", "description": "Fade over the last 0.3 s." }
  }
}
</script>
<style>
  #stage { position: absolute; inset: 0; display: grid; place-items: center; }
  .word { font-family: "Archivo"; font-weight: 900; font-stretch: 125%; text-transform: uppercase; color: #EDEBE6; text-shadow: 0 6px 30px rgba(0,0,0,.5); }
  .bar { height: 12px; margin-top: 10px; transform-origin: 0 50%; }
</style>
</head>
<body>
<div id="stage"><div><div class="word" id="w"></div><div class="bar" id="b"></div></div></div>
<script>
  RC.composition({
    build: function (RC) {
      var w = document.getElementById("w");
      w.textContent = RC.params.word;
      RC.fitText(w, RC.width - RC.safe.left - RC.safe.right, 220 * RC.u, 60 * RC.u);
      document.getElementById("b").style.background = RC.params.accent;
    },
    render: function (time, RC) {
      var inP = RC.progress(time.t, 0, 0.5, "bouncy");
      var out = RC.params.exit ? 1 - Math.min(1, time.left / 0.3) : 0;
      RC.set(document.getElementById("w"), { scale: 0.6 + 0.4 * inP, opacity: Math.min(1, inP * 2) * (1 - out) });
      RC.set(document.getElementById("b"), { sx: RC.progress(time.t, 0.35, 0.4, "snappy"), opacity: 1 - out });
    },
  });
</script>
</body>
</html>
`;
