/**
 * What a composition element shows (gate-v2, 2026-10-20). A composition (motion graphics written as code,
 * packages/compositions) renders to one video clip on a MOTION lane, so to the timeline it is one element — the old
 * gate counted "8 scenes in 6 compositions" as 6 shots and could not read a word of their text (SUMMARY gap 5).
 *
 * The contract a composition can declare (manifest JSON block or props; library-v2 adds it to the manifest type):
 *   scenes: [2.1, 4.5]                         scene boundaries, seconds from the composition's start
 *   text:   [{content, t?, t_end?, role?, box?}] on-screen text (role "headline" · "label" · "caption"), local seconds
 *   opaque: true                                the composition paints the whole frame (it is the picture, not an overlay)
 * Undeclared, the gate falls back to (a) the manifest's text params (types string / text, lists of them, string fields
 * of list objects) merged with the element's props, timed at the element's start (ASSUMPTION), and (b) what the server
 * measured on the composition's own render (scene cuts from a frame diff, an alpha coverage grid): CompositionFacts
 * passed in `TimelineCheckOptions.compositions`, keyed by element id or media id.
 *
 * Pure: no file or network access. Custom compositions carry their source (with the manifest) on the element; library
 * manifests come from the server (it reads packages/compositions) as `manifest` facts.
 */
import type { CompositionFacts, GateElement } from "./types.ts";

export interface StoredComposition {
	name?: string;
	title?: string;
	props?: Record<string, unknown>;
	source?: string;
	custom?: boolean;
	duration?: number;
	fps?: number;
	width?: number;
	height?: number;
	scenes?: unknown;
	text?: unknown;
	opaque?: unknown;
	[k: string]: unknown;
}

interface ParamSpecLike {
	type?: string;
	default?: unknown;
	of?: ParamSpecLike;
	fields?: Record<string, ParamSpecLike>;
	description?: string;
}

export interface ManifestLike {
	name?: string;
	params?: Record<string, ParamSpecLike>;
	scenes?: unknown;
	text?: unknown;
	opaque?: unknown;
	[k: string]: unknown;
}

export function storedComposition(el: GateElement): StoredComposition | null {
	const comp = (el.restorff as { composition?: unknown } | null | undefined)?.composition;
	return comp && typeof comp === "object" ? (comp as StoredComposition) : null;
}

/** The manifest inside a custom composition's source (`<script type="application/json" id="params">`). */
export function manifestFromSource(source: unknown): ManifestLike | null {
	if (typeof source !== "string") return null;
	const m = /<script[^>]*id=["']params["'][^>]*>([\s\S]*?)<\/script>/i.exec(source);
	if (!m) return null;
	try {
		const parsed = JSON.parse(m[1]) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as ManifestLike) : null;
	} catch {
		return null;
	}
}

function numbers(value: unknown): number[] | null {
	if (!Array.isArray(value)) return null;
	const out = value
		.map((v) => (typeof v === "number" ? v : v && typeof v === "object" ? Number((v as { t?: unknown }).t) : Number.NaN))
		.filter((v) => Number.isFinite(v) && v > 0);
	return out.length ? out.sort((a, b) => a - b) : [];
}

type TextItem = NonNullable<CompositionFacts["text"]>[number];

function textItems(value: unknown): TextItem[] | null {
	if (!Array.isArray(value)) return null;
	const out: TextItem[] = [];
	for (const v of value) {
		if (typeof v === "string" && v.trim()) out.push({ content: v.trim() });
		else if (v && typeof v === "object") {
			const o = v as Record<string, unknown>;
			const content = typeof o.content === "string" ? o.content : typeof o.text === "string" ? o.text : null;
			if (!content?.trim()) continue;
			const box = Array.isArray(o.box) && o.box.length === 4 && o.box.every((n) => typeof n === "number") ? (o.box as [number, number, number, number]) : undefined;
			out.push({
				content: content.trim(),
				...(typeof o.t === "number" ? { t: o.t } : {}),
				...(typeof o.t_end === "number" ? { t_end: o.t_end } : {}),
				...(typeof o.role === "string" ? { role: o.role } : {}),
				...(box ? { box } : {}),
			});
		}
	}
	return out;
}

/** Keys whose string values are display text when there is no manifest to say so (library pieces in the editor). */
const DISPLAY_KEYS =
	/^(text|title|titles|subtitle|label|labels|word|kicker|headline|heading|caption|tag|sub|items|lines|line|name|names|legend|note|issue|chapter|big|endLabel|prompt|count|masthead|cta|quote|handle|form|key|keys|places|nodes|rowA|rowB|beats|steps|list)$/;
const TIME_KEYS = ["at", "t", "start"] as const;
const CAPTION_WORD = (o: Record<string, unknown>) => typeof o.w === "string" && typeof o.s === "number";

/** Text from params: string / text params, lists of them, string fields of list objects (timed by their `at`). */
function textFromParams(manifest: ManifestLike | null, props: Record<string, unknown>): TextItem[] {
	const out: TextItem[] = [];
	const specs = manifest?.params ?? null;
	const keys = specs ? Object.keys(specs) : Object.keys(props);
	for (const key of keys) {
		const spec = specs?.[key];
		const value = key in props ? props[key] : spec?.default;
		if (value == null) continue;
		const isText = spec ? spec.type === "string" || spec.type === "text" : DISPLAY_KEYS.test(key);
		if (typeof value === "string") {
			if (isText && value.trim() && !/^(#|data:|https?:)/.test(value.trim())) out.push({ content: value.trim(), role: key });
			continue;
		}
		if (!Array.isArray(value)) continue;
		const of = spec?.of;
		const listOfText = spec ? of?.type === "string" || of?.type === "text" : DISPLAY_KEYS.test(key);
		for (const item of value) {
			if (typeof item === "string") {
				if (listOfText && item.trim() && !/^(#|data:|https?:)/.test(item.trim())) out.push({ content: item.trim(), role: key });
				continue;
			}
			if (!item || typeof item !== "object") continue;
			const o = item as Record<string, unknown>;
			if (CAPTION_WORD(o)) {
				out.push({ content: String(o.w).trim(), role: "caption" });
				continue;
			}
			const fields = of?.fields;
			for (const [field, v] of Object.entries(o)) {
				if (typeof v !== "string" || !v.trim() || /^(#|data:|https?:)/.test(v.trim())) continue;
				const fieldIsText = fields ? fields[field]?.type === "string" || fields[field]?.type === "text" : /^(text|label|title|name|word|date|w|caption|sub)$/.test(field);
				if (!fieldIsText) continue;
				const at = TIME_KEYS.map((k) => o[k]).find((n) => typeof n === "number") as number | undefined;
				out.push({ content: v.trim(), role: key, ...(at !== undefined ? { t: at } : {}) });
			}
		}
	}
	return out;
}

/**
 * Everything the gate knows about one composition element: declared facts (manifest / props), the manifest's text,
 * and the server's measured facts (by element id, else by media id). Declared scenes win over measured ones.
 */
export function compositionFacts(
	el: GateElement,
	measured?: Record<string, CompositionFacts>,
	libraryManifest?: ManifestLike | null,
): (CompositionFacts & { name: string; declared: boolean }) | null {
	const comp = storedComposition(el);
	if (!comp) return null;
	const props = (comp.props && typeof comp.props === "object" ? comp.props : {}) as Record<string, unknown>;
	const manifest = manifestFromSource(comp.source) ?? libraryManifest ?? null;
	const server = measured?.[el.id] ?? (el.mediaId ? measured?.[el.mediaId] : undefined) ?? {};
	const from: Record<string, string> = { ...(server.from ?? {}) };

	const declaredScenes = numbers(comp.scenes) ?? numbers(props.scenes) ?? numbers(manifest?.scenes);
	const declaredText = textItems(comp.text) ?? textItems(props.text) ?? textItems(manifest?.text);
	const declaredOpaque =
		typeof comp.opaque === "boolean" ? comp.opaque : typeof props.opaque === "boolean" ? props.opaque : typeof manifest?.opaque === "boolean" ? (manifest.opaque as boolean) : undefined;

	let scenes = server.scenes;
	if (declaredScenes) {
		scenes = declaredScenes;
		from.scenes = "declared";
	}
	let text = server.text;
	if (declaredText) {
		text = declaredText;
		from.text = "declared";
	} else if (!text?.length) {
		text = textFromParams(manifest, props);
		from.text = manifest ? "manifest params" : "props";
	}
	let opaque = server.opaque;
	if (declaredOpaque !== undefined) {
		opaque = declaredOpaque;
		from.opaque = "declared";
	}
	return {
		name: String(comp.name ?? comp.title ?? el.name ?? "composition"),
		declared: Boolean(declaredScenes || declaredText || declaredOpaque !== undefined),
		...(scenes ? { scenes } : {}),
		...(text ? { text } : {}),
		...(opaque !== undefined ? { opaque } : {}),
		...(server.alpha ? { alpha: server.alpha } : {}),
		...(server.flashes ? { flashes: server.flashes } : {}),
		...(server.motion ? { motion: server.motion } : {}),
		from,
	};
}

/** Map a composition-local time to timeline seconds (trim + speed), or null when it falls outside the element. */
export function localToTimeline(el: GateElement, local: number, ticksPerSecond = 120_000): number | null {
	const rate = el.retime?.rate || 1;
	const trimStart = (el.trimStart ?? 0) / ticksPerSecond;
	const start = el.startTime / ticksPerSecond;
	const end = (el.startTime + el.duration) / ticksPerSecond;
	const t = start + (local - trimStart) / rate;
	return t > start + 1e-6 && t < end - 1e-6 ? t : null;
}

/** The alpha grid frame nearest a local time (null when not measured). */
export function alphaFrameAt(facts: CompositionFacts, local: number): number[] | null {
	const a = facts.alpha;
	if (!a?.frames.length) return null;
	const i = Math.max(0, Math.min(a.frames.length - 1, Math.round(local * a.fps)));
	return a.frames[i] ?? null;
}

/** Share (0..1) of a box [x0,y0,x1,y1] (0..1 of the canvas) covered by visible pixels in an alpha grid frame. */
export function alphaCoverage(grid: number[], cols: number, rows: number, box: [number, number, number, number], threshold = 96): number {
	const [x0, y0, x1, y1] = box;
	const c0 = Math.max(0, Math.floor(x0 * cols));
	const c1 = Math.min(cols - 1, Math.ceil(x1 * cols) - 1);
	const r0 = Math.max(0, Math.floor(y0 * rows));
	const r1 = Math.min(rows - 1, Math.ceil(y1 * rows) - 1);
	let on = 0;
	let all = 0;
	for (let r = r0; r <= r1; r++) {
		for (let c = c0; c <= c1; c++) {
			all++;
			if ((grid[r * cols + c] ?? 0) >= threshold) on++;
		}
	}
	return all ? on / all : 0;
}

/** Bounding box (0..1) of the visible pixels in an alpha grid frame, or null when nothing shows. */
export function alphaBox(grid: number[], cols: number, rows: number, threshold = 96): [number, number, number, number] | null {
	let x0 = cols;
	let y0 = rows;
	let x1 = -1;
	let y1 = -1;
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			if ((grid[r * cols + c] ?? 0) < threshold) continue;
			x0 = Math.min(x0, c);
			y0 = Math.min(y0, r);
			x1 = Math.max(x1, c);
			y1 = Math.max(y1, r);
		}
	}
	return x1 < 0 ? null : [x0 / cols, y0 / rows, (x1 + 1) / cols, (y1 + 1) / rows];
}
