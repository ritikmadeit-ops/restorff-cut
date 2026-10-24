/**
 * Layered effects — the pure half (effects-layers agent, 2026-10-20). Reads a composition manifest's `effect` block
 * (the collage-fx agent's recipe: `stack`, `inputs`, `plateKeys`, `plateKeysOn`, `props`) and answers, with no I/O:
 *
 *   - which renders to make (one per `self` / `self:<layer>` entry, with `props.layer`),
 *   - where each goes relative to the clip ("plate") and its person cutout: below the cutout, above it, or on top,
 *   - the clip keyframes (plate keys) for the effect's real length and props,
 *   - the props the recipe's inputs fill from the server matte (face box → face / mastheadOffset / window).
 *
 * Bottom → top, a recipe `["plate", "self:back", "cutout", "self:front"]` becomes:
 *   clip → back render → the person cutout (transparent person.webm, frame-aligned with the clip) → front render.
 *
 * Pure: no Node imports, safe in the browser bundle — the server (./effects-layers.ts, MCP `effects apply`) and the
 * editor's composition drop (@/compositions/drop.ts) both place layers with it. Runbook:
 * docs/restorff/worklog/effects-layers.md.
 */

/** A plate key of the recipe: seconds from the effect's start; scale multiplies, x/y are fractions of the canvas. */
export interface PlateKey {
	t: number;
	scale?: number;
	x?: number;
	y?: number;
	ease?: "linear" | "hold" | "bezier" | "ease_in" | "ease_out" | "ease_in_out";
}

/** The manifest's `effect` block (packages/compositions/compositions/<name>/<name>.html). */
export interface EffectRecipe {
	fx: string[];
	/** Bottom → top: "plate", "cutout", "self", "self:<layer>". */
	stack: string[];
	inputs: Record<string, string>;
	plateKeys?: PlateKey[];
	/** Which tracks get the plate keys: "plate" and/or "cutout". */
	plateKeysOn?: string[];
	/** Props the recipe needs (e.g. pullback-window: pullFrom frame-width), under the caller's own. */
	props?: Record<string, unknown>;
	note?: string;
}

export type LayerSide = "below_cutout" | "above_cutout" | "on_top";

export interface LayerRender {
	/** The stack entry ("self:back", "self"). */
	entry: string;
	/** props.layer for this render, or null (the composition has one layer). */
	layer: string | null;
	side: LayerSide;
}

export interface LayerPlan {
	renders: LayerRender[];
	/** The person cutout is part of the stack (it needs the server matte). */
	usesCutout: boolean;
	plateKeys: PlateKey[];
	plateKeysOn: string[];
}

const EASES = new Set(["linear", "hold", "bezier", "ease_in", "ease_out", "ease_in_out"]);

/** The `effect` block of a parsed manifest, validated; null when there is none (or it is unusable). */
export function readRecipe(manifest: unknown): EffectRecipe | null {
	const effect = (manifest as { effect?: unknown } | null)?.effect as Record<string, unknown> | undefined;
	if (!effect || typeof effect !== "object") return null;
	const stack = Array.isArray(effect.stack) ? effect.stack.filter((entry): entry is string => typeof entry === "string") : [];
	if (!stack.some((entry) => entry === "self" || entry.startsWith("self:"))) return null;
	const keys = Array.isArray(effect.plateKeys)
		? effect.plateKeys
				.filter((key): key is Record<string, unknown> => !!key && typeof key === "object" && typeof (key as { t?: unknown }).t === "number")
				.map((key) => {
					const out: PlateKey = { t: key.t as number };
					for (const field of ["scale", "x", "y"] as const) if (typeof key[field] === "number") out[field] = key[field] as number;
					if (typeof key.ease === "string" && EASES.has(key.ease)) out.ease = key.ease as PlateKey["ease"];
					return out;
				})
				.sort((a, b) => a.t - b.t)
		: undefined;
	const inputs: Record<string, string> = {};
	if (effect.inputs && typeof effect.inputs === "object") {
		for (const [key, value] of Object.entries(effect.inputs as Record<string, unknown>)) if (typeof value === "string") inputs[key] = value;
	}
	return {
		fx: Array.isArray(effect.fx) ? effect.fx.filter((id): id is string => typeof id === "string") : [],
		stack,
		inputs,
		...(keys?.length ? { plateKeys: keys } : {}),
		...(Array.isArray(effect.plateKeysOn) ? { plateKeysOn: effect.plateKeysOn.filter((id): id is string => typeof id === "string") } : {}),
		...(effect.props && typeof effect.props === "object" && !Array.isArray(effect.props) ? { props: effect.props as Record<string, unknown> } : {}),
		...(typeof effect.note === "string" ? { note: effect.note } : {}),
	};
}

/** Renders and their place in the stack. A stack without "cutout" puts every render on top (the old overlay). */
export function layerPlan(recipe: EffectRecipe): LayerPlan {
	const cutoutAt = recipe.stack.indexOf("cutout");
	const renders: LayerRender[] = [];
	recipe.stack.forEach((entry, index) => {
		if (entry !== "self" && !entry.startsWith("self:")) return;
		const layer = entry.includes(":") ? entry.slice(entry.indexOf(":") + 1) : null;
		const side: LayerSide = cutoutAt < 0 ? "on_top" : index < cutoutAt ? "below_cutout" : "above_cutout";
		renders.push({ entry, layer, side });
	});
	return {
		renders,
		usesCutout: cutoutAt >= 0,
		plateKeys: recipe.plateKeys ?? [],
		plateKeysOn: recipe.plateKeysOn ?? (recipe.plateKeys?.length ? ["plate", "cutout"] : []),
	};
}

/** True when the recipe changes anything an overlay drop would not do (layers, keys, or matte/face inputs). */
export function isLayered(recipe: EffectRecipe, params: Record<string, unknown>): boolean {
	const plan = layerPlan(recipe);
	return plan.usesCutout || plan.renders.some((render) => render.layer !== null) || plan.plateKeys.length > 0 || matteInput(recipe, params) !== null;
}

/** How the recipe takes the person matte: frames over the effect ("frames"), one frame + a clip still ("plate+matte"). */
export function matteInput(recipe: EffectRecipe, params: Record<string, unknown>): "frames" | "plate+matte" | null {
	if (!("matte" in params)) return null;
	if (recipe.inputs["plate+matte"]) return "plate+matte";
	if (recipe.inputs.matte) return "frames";
	return null;
}

/**
 * A still of the clip the recipe asks for in `props.background` (glass-type: "a clean plate or a frame of the clip").
 * Not when the recipe has a plate+matte input (vertigo): there `background` means a CLEAN plate (the room without the
 * person) and a clip frame would be wrong; the clip still goes in `props.plate` instead.
 */
export function wantsBackgroundStill(recipe: EffectRecipe, params: Record<string, unknown>): boolean {
	const spec = params.background as { type?: string } | undefined;
	return spec?.type === "image" && !!recipe.inputs.background && !recipe.inputs["plate+matte"];
}

/**
 * The plate keys for this render: the manifest's numbers are for the composition's defaults, so keys in the second
 * half move with the end when the length changes (every recipe times its last keys from the end), and the params a
 * recipe writes into its keys (frame-break plateScale / plateY, ui-world split) replace the default values.
 */
export function plateKeysFor({
	recipe,
	name,
	duration,
	defaultDuration,
	props,
}: {
	recipe: EffectRecipe;
	name: string;
	duration: number;
	defaultDuration: number;
	props: Record<string, unknown>;
}): { keys: PlateKey[]; notes: string[] } {
	const keys = (recipe.plateKeys ?? []).map((key) => ({ ...key }));
	const notes: string[] = [];
	if (!keys.length) return { keys, notes };
	const shift = duration - defaultDuration;
	if (Math.abs(shift) > 1e-6) {
		for (const key of keys) if (key.t > defaultDuration / 2) key.t = Math.max(0, key.t + shift);
	}
	const num = (key: string) => (typeof props[key] === "number" && Number.isFinite(props[key]) ? (props[key] as number) : undefined);
	if (name === "frame-break") {
		const scale = num("plateScale");
		const y = num("plateY");
		const at = num("at");
		const shrink = num("shrink");
		// keys: 0 → at + shrink (in) → duration - 1/fps - shrink → duration - 1/fps (out); scale/y on the middle two
		if (keys.length === 4) {
			if (at !== undefined && shrink !== undefined) {
				keys[0].t = Math.max(0, at);
				keys[1].t = at + shrink;
				keys[2].t = Math.max(keys[1].t, keys[3].t - shrink);
			}
			for (const key of [keys[1], keys[2]]) {
				if (scale !== undefined) key.scale = scale;
				if (y !== undefined) key.y = y;
			}
		}
	} else if (name === "ui-world") {
		const split = num("split");
		if (split !== undefined) for (const key of keys) if ((key.y ?? 0) !== 0) key.y = split / 2;
	} else if (name === "pullback-window" && Object.keys(props).some((key) => ["desk", "scale", "bar"].includes(key))) {
		notes.push("pullback-window's plate keys are for its default window: changed layout props may leave a gap between the clip and the window's hole.");
	}
	for (const key of keys) key.t = Math.round(key.t * 10_000) / 10_000;
	keys.sort((a, b) => a.t - b.t);
	return { keys, notes };
}

/** [x, y, w, h] (top-left, fractions of the SOURCE frame) on a clip drawn in `rect` → fractions of the canvas. */
export function boxOnCanvas(
	box: [number, number, number, number],
	rect: { left: number; top: number; width: number; height: number },
	canvas: { width: number; height: number },
): { left: number; top: number; width: number; height: number; cx: number; cy: number } {
	const left = (rect.left + box[0] * rect.width) / canvas.width;
	const top = (rect.top + box[1] * rect.height) / canvas.height;
	const width = (box[2] * rect.width) / canvas.width;
	const height = (box[3] * rect.height) / canvas.height;
	return { left, top, width, height, cx: left + width / 2, cy: top + height / 2 };
}

const r4 = (value: number) => Math.round(value * 10_000) / 10_000;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** props.face (orbit, vertigo): centre x, centre y, width, height — fractions of the canvas. */
export function faceProp(face: { cx: number; cy: number; width: number; height: number }): { x: number; y: number; w: number; h: number } {
	return { x: r4(clamp(face.cx, 0, 1)), y: r4(clamp(face.cy, 0, 1)), w: r4(clamp(face.width, 0.02, 1)), h: r4(clamp(face.height, 0.02, 1)) };
}

/**
 * cover-story mastheadOffset (px on the 1080 grid): the wordmark's lower third behind the top of the head.
 * Wordmark: Instrument Serif caps fitted to the frame (≈0.62 em per letter, 360 px at most), line-height 0.82; its
 * top sits at max(safe top × 0.7, frameInset + 70) before the offset (cover-story.html build()).
 */
export function mastheadOffsetFor({
	headTop,
	canvas,
	wordmark,
	frameInset,
}: {
	/** Fraction of the canvas height. */
	headTop: number;
	canvas: { width: number; height: number };
	wordmark: string;
	frameInset: number;
}): number {
	const u = Math.min(canvas.width, canvas.height) / 1080;
	const safeTop = canvas.height / canvas.width > 1.5 ? Math.round(canvas.height * 0.11) : Math.round(Math.min(canvas.width, canvas.height) * 0.05);
	const baseTop = Math.max(safeTop * 0.7, frameInset * u + 70 * u);
	const letters = Math.max(1, wordmark.trim().length);
	const maxWidth = Math.min(canvas.width * 0.9, canvas.width - 2 * frameInset * u - 40 * u);
	const fontSize = clamp(maxWidth / (letters * 0.62), 80 * u, 360 * u);
	// cap height ≈ 0.7 em inside a 0.82 em line box: the letters' lower third starts ≈ 0.5 em below the box top
	const wantedTop = headTop * canvas.height - fontSize * 0.5;
	return Math.round(clamp((wantedTop - baseTop) / u, -400, 900));
}

/**
 * frame-break window (fractions of the canvas): centred on the face, its top edge a quarter of the way down the head
 * so the head breaks out over it, inside the shrunk clip (plateScale around the centre, shifted by plateY).
 */
export function frameBreakWindow({
	head,
	plateScale,
	plateY,
	width,
	height,
}: {
	head: { left: number; top: number; width: number; height: number; cx: number };
	plateScale: number;
	plateY: number;
	width: number;
	height: number;
}): { x: number; y: number; w: number; h: number } {
	const shrunk = (value: number) => 0.5 + (value - 0.5) * plateScale;
	const clipTop = shrunk(0) + plateY;
	const clipBottom = shrunk(1) + plateY;
	const clipLeft = shrunk(0);
	const clipRight = shrunk(1);
	const headTop = shrunk(head.top) + plateY;
	const headHeight = head.height * plateScale;
	const w = Math.min(width, clipRight - clipLeft - 0.02);
	let top = clamp(headTop + headHeight * 0.25, clipTop + 0.01, clipBottom - 0.2);
	let h = Math.min(height, clipBottom - 0.01 - top);
	if (h < 0.2) {
		h = 0.2;
		top = clipBottom - 0.01 - h;
	}
	const x = clamp(shrunk(head.cx), clipLeft + 0.01 + w / 2, clipRight - 0.01 - w / 2);
	return { x: r4(x), y: r4(top + h / 2), w: r4(w), h: r4(h) };
}

/** What `effects apply` fills from the server matte for this recipe (for describe and dry runs). */
export function layeredInputs(recipe: EffectRecipe, params: Record<string, unknown>): string[] {
	const out: string[] = [];
	const plan = layerPlan(recipe);
	if (plan.usesCutout) out.push("cutout: the person (transparent person.webm) on V2 CUTOUT above the clip");
	const matte = matteInput(recipe, params);
	if (matte === "frames") out.push("props.matte: the person matte as PNG frames at the canvas fps over the effect (props.matteFps)");
	if (matte === "plate+matte") out.push("props.plate: a still of the clip at the effect's start; props.matte: the person matte at that moment");
	if (wantsBackgroundStill(recipe, params)) out.push("props.background: a still of the clip at the effect's start");
	if (recipe.inputs.face) {
		if ((params.face as { type?: string } | undefined)?.type === "object") out.push("props.face: the median face box over the effect (centre x, y, w, h)");
		if ("mastheadOffset" in params) out.push("props.mastheadOffset: the masthead's lower third behind the top of the head");
		if ((params.window as { type?: string } | undefined)?.type === "object") out.push("props.window: centred on the face, top edge just under the top of the head");
	}
	if (plan.plateKeys.length) out.push(`plate keys on ${plan.plateKeysOn.join(" + ")} (and on the clip's cutout, if it has one)`);
	return out;
}

/** Props that carry pixels (data: URLs): never stored on the timeline element or echoed in an answer. */
export const PIXEL_PROPS = ["matte", "plate", "background"] as const;

/** Props without the pixel data the server fed in (what the element stores and the answer shows). */
export function storableProps(props: Record<string, unknown>, fed: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(props)) {
		if (fed.includes(key)) continue;
		if (typeof value === "string" && value.startsWith("data:") && value.length > 2000) continue;
		out[key] = value;
	}
	return out;
}
