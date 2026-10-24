/**
 * Caption sizes in saved styles (ui-fix-panels, 2026-10-21; QA 2026-10-20 finding #8).
 *
 * The incident: "Bigger captions" was saved from a project whose captions were large, as an ABSOLUTE size
 * (`caption_size` 20 = 427 px letters on 1080×1920). Applied to a project with size-5 captions it blew them four times
 * past the frame. Rules from here on:
 *   1. a saved style stores a caption size as a RATIO of the captions it is applied to (`style.scale` → ×1.35),
 *      worked out from the size the captions had before the instruction ran (InstructionRecord.caption_size_before);
 *   2. every caption size a saved style sets is capped so the widest caption on that track stays inside the caption
 *      safe area (timeline-ops CAPTION_SAFE_AREA), in whole editor units (the editor stores fontSize in steps of 1);
 *   3. styles saved before this rule are migrated: an absolute size becomes a ratio when the size it was saved from is
 *      known; otherwise the style is FLAGGED (the size is skipped when applied, and the flag says why and suggests the
 *      ratio its trigger wording means).
 */
import {
	CAPTION_SAFE_AREA,
	captionTracks,
	resolveSentence,
	scaleSafeArea,
	type CaptionFont,
	type MeasureText,
	type Project,
	type TimelineTrack,
} from "@restorffcut/timeline-ops";
import type { ParamRef, SavedStyle, StyleFlag, StyleLibrary, StyleParamSpec, StyleStep } from "./preset.ts";

/** The param a relative caption size is lifted into. */
export const CAPTION_SCALE_PARAM = "caption_scale";
/** The legacy absolute-size param (styles saved before 2026-10-21). */
export const LEGACY_CAPTION_SIZE_PARAM = "caption_size";
export const CAPTION_SCALE_SPEC: Omit<Extract<StyleParamSpec, { type: "number" }>, "default"> = {
	type: "number",
	min: 0.5,
	max: 2.5,
	label: "Caption size (× the captions it is applied to)",
};
/** px = size × canvas height / 90 (the editor's text unit, timeline-ops captions.ts). */
const FONT_SIZE_REFERENCE = 90;
/** The editor's text line height default. */
const LINE_HEIGHT = 1.2;

const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function median(values: number[]): number | undefined {
	if (!values.length) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

/** Median font size (editor units) of the caption elements on a track; undefined when it has none. */
export function trackCaptionSize(track: TimelineTrack): number | undefined {
	return median(
		track.elements.map((element) => Number((element.params as Record<string, unknown> | undefined)?.fontSize)).filter((n) => Number.isFinite(n) && n > 0),
	);
}

/** Median caption size over every caption track of a scene (what "bigger captions" scaled from). */
export function projectCaptionSize(project: Project, sceneId?: string): number | undefined {
	const scenes = project.scenes ?? [];
	const scene = (sceneId ? scenes.find((s) => s.id === sceneId) : undefined) ?? scenes.find((s) => s.id === project.currentSceneId) ?? scenes.find((s) => s.isMain) ?? scenes[0];
	if (!scene) return undefined;
	const sizes = captionTracks(scene.tracks).flatMap((track) =>
		track.elements.map((element) => Number((element.params as Record<string, unknown> | undefined)?.fontSize)).filter((n) => Number.isFinite(n) && n > 0),
	);
	return median(sizes);
}

/**
 * Width of one line of text when no real measurer is at hand (servers, tests): per-character em widths of a bold
 * sans (upper case and digits wider, spaces narrow), +6 % for bold, plus letter spacing. Errs wide, so the cap errs
 * small rather than off the frame. The editor passes the canvas measurer (captions/build.ts createCanvasMeasure).
 */
export function estimateTextWidth(text: string, font: CaptionFont, canvasHeight: number): number {
	const px = (font.size * canvasHeight) / FONT_SIZE_REFERENCE;
	let em = 0;
	for (const ch of text) {
		if (ch === " ") em += 0.3;
		else if (/[A-Z0-9]/.test(ch)) em += 0.7;
		else if (/[iljtf.,:;'!|]/.test(ch)) em += 0.32;
		else if (/[mwMW]/.test(ch)) em += 0.86;
		else em += 0.58;
	}
	const bold = font.weight === "bold" ? 1.06 : 1;
	return em * px * bold + Math.max(0, [...text].length - 1) * (font.letterSpacing ?? 0);
}

export interface CaptionSizeFit {
	/** The size to set (whole editor units). */
	size: number;
	/** True when the safe area made it smaller than asked. */
	capped: boolean;
	/** The caption that limited it (its text), when capped. */
	limitedBy?: string;
}

/**
 * The largest whole size ≤ `wanted` at which every caption on `track` fits inside the caption safe area (width, from
 * where each caption is centred, and height). Captions are single lines; a box adds its padding (param × size / 15 px).
 */
export function fitCaptionSize({
	track,
	wanted,
	canvas,
	measure,
}: {
	track: TimelineTrack;
	wanted: number;
	canvas: { width: number; height: number };
	measure?: MeasureText;
}): CaptionSizeFit {
	const safe = scaleSafeArea(CAPTION_SAFE_AREA, canvas);
	const target = Math.max(1, Math.round(wanted));
	let size = target;
	let limitedBy: string | undefined;
	for (const element of track.elements) {
		const params = (element.params ?? {}) as Record<string, unknown>;
		const content = String(params.content ?? "");
		if (!content.trim()) continue;
		const scaleX = Math.abs(num(params["transform.scaleX"], 1)) || 1;
		const scaleY = Math.abs(num(params["transform.scaleY"], 1)) || 1;
		const cx = canvas.width / 2 + num(params["transform.positionX"], 0);
		const cy = canvas.height / 2 + num(params["transform.positionY"], 0);
		const inside = (value: number, lo: number, hi: number) => (value > lo && value < hi ? value : (lo + hi) / 2);
		const halfW = Math.min(inside(cx, safe.left, safe.right) - safe.left, safe.right - inside(cx, safe.left, safe.right));
		const halfH = Math.min(inside(cy, safe.top, safe.bottom) - safe.top, safe.bottom - inside(cy, safe.top, safe.bottom));
		const boxed = params["background.enabled"] === true;
		const padX = boxed ? num(params["background.paddingX"], 0) : 0;
		const padY = boxed ? num(params["background.paddingY"], 0) : 0;
		const lines = content.split("\n");
		const lineHeight = num(params.lineHeight, LINE_HEIGHT);
		const widthAt = (s: number) => {
			const font: CaptionFont = {
				family: String(params.fontFamily ?? "Arial"),
				size: s,
				weight: params.fontWeight === "bold" ? "bold" : "normal",
				italic: params.fontStyle === "italic",
				letterSpacing: num(params.letterSpacing, 0),
			};
			const widest = Math.max(...lines.map((line) => (measure ? measure(line, font) : estimateTextWidth(line, font, canvas.height))));
			return (widest + (2 * padX * s) / 15) * scaleX;
		};
		const heightAt = (s: number) => ((lines.length * lineHeight * s * canvas.height) / FONT_SIZE_REFERENCE + (2 * padY * s) / 15) * scaleY;
		const fits = (s: number) => widthAt(s) <= 2 * halfW && heightAt(s) <= 2 * halfH;
		let s = size;
		while (s > 1 && !fits(s)) s -= 1;
		if (s < size) {
			size = s;
			limitedBy = content;
		}
	}
	return { size, capped: size < target, ...(limitedBy && size < target ? { limitedBy } : {}) };
}

// ─── migration of styles saved with an absolute caption size ────────────────────────────────────────────────────

function isRef(value: unknown): value is ParamRef {
	return !!value && typeof value === "object" && typeof (value as ParamRef).$param === "string" && Object.keys(value).length === 1;
}

/** The ratio a caption sentence means ("bigger captions" → 1.35, "huge captions" → 1.8), from the command bar's own rules. */
export function wordingScale(sentence: string): number | null {
	const probe: Project = {
		metadata: { id: "probe", name: "probe", duration: 120_000, createdAt: "", updatedAt: "" },
		scenes: [
			{
				id: "s",
				name: "probe",
				isMain: true,
				tracks: {
					overlay: [
						{
							id: "c",
							name: "CAPTIONS",
							type: "text",
							hidden: false,
							elements: [
								{ id: "e", type: "text", name: "x", startTime: 0, duration: 120_000, trimStart: 0, trimEnd: 0, params: { content: "x", fontSize: 10 } },
							],
						},
					],
					main: { id: "m", name: "V1", type: "video", muted: false, hidden: false, elements: [] },
					audio: [],
				},
				bookmarks: [],
				createdAt: "",
				updatedAt: "",
			},
		],
		currentSceneId: "s",
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 }, canvasSizeMode: "preset", background: { type: "color", color: "#000000" } },
		version: 32,
	} as unknown as Project;
	try {
		const plan = resolveSentence(sentence, { project: probe });
		for (const op of plan.ops) {
			const size = op.op === "set_caption_style" ? (op.style as { size?: number }).size : undefined;
			if (typeof size === "number" && size > 0 && size !== 10) return round(size / 10, 2);
		}
	} catch {
		// a sentence the rules can't read: no suggestion
	}
	return null;
}

export interface MigrateResult {
	style: SavedStyle;
	changed: boolean;
	/** What happened, in plain words (for logs and the UI). */
	notes: string[];
}

/**
 * Turn a style's ABSOLUTE caption size into a ratio (QA #8). For every `set_caption_style` op step whose `style.size`
 * is a number or a ref to a number param:
 *   - the size it was saved from is known (`origin.caption_size_before`, or the param's `from`) → `style.scale` =
 *     size / from, param `caption_scale`; the old param goes;
 *   - not known → the step keeps its size (nothing is invented) and the style gets a flag
 *     `absolute_caption_size` with the ratio its trigger wording means (`suggested_scale`); planStyle skips a flagged
 *     absolute size and says so. Idempotent: a migrated or already-flagged style comes back unchanged.
 */
export function migrateSavedStyle(style: SavedStyle, options: { now?: string } = {}): MigrateResult {
	const notes: string[] = [];
	const params: Record<string, StyleParamSpec> = { ...(style.params ?? {}) };
	const flags: StyleFlag[] = [...(style.flags ?? [])];
	let changed = false;
	const from = style.origin?.caption_size_before;
	const steps: StyleStep[] = style.steps.map((step) => {
		if (step.kind !== "op" || step.op.op !== "set_caption_style") return step;
		const textStyle = step.op.style as Record<string, unknown> | undefined;
		if (!textStyle || textStyle.size === undefined) return step;
		const sizeValue = textStyle.size;
		const paramName = isRef(sizeValue) ? sizeValue.$param : null;
		const spec = paramName ? params[paramName] : undefined;
		const absolute = typeof sizeValue === "number" ? sizeValue : spec?.type === "number" ? spec.default : null;
		if (absolute === null || !(absolute > 0)) return step;
		const savedFrom = from ?? (spec && "from" in spec && typeof spec.from === "number" ? spec.from : undefined);
		if (savedFrom && savedFrom > 0) {
			const ratio = round(absolute / savedFrom, 3);
			const { size: _size, ...rest } = textStyle;
			if (paramName) delete params[paramName];
			params[CAPTION_SCALE_PARAM] = { ...CAPTION_SCALE_SPEC, default: ratio };
			changed = true;
			notes.push(`caption size ${absolute} saved from ${savedFrom} → ×${ratio}`);
			return { ...step, op: { ...step.op, style: { ...rest, scale: { $param: CAPTION_SCALE_PARAM } } } };
		}
		if (!flags.some((flag) => flag.code === "absolute_caption_size")) {
			const suggested = style.triggers.map(wordingScale).find((value): value is number => value !== null) ?? null;
			flags.push({
				code: "absolute_caption_size",
				size: absolute,
				...(suggested ? { suggested_scale: suggested } : {}),
				message: `Saved with a fixed caption size (${absolute}) instead of a ratio, and the size it was saved from is unknown — so it is skipped when this style is applied.${suggested ? ` Its wording means ×${suggested}.` : ""} Set a ratio to use it again.`,
			});
			changed = true;
			notes.push(`caption size ${absolute}: saved-from size unknown → flagged`);
		}
		return step;
	});
	if (!changed) return { style, changed: false, notes };
	// `now` stamps updated_at, so a migrated copy wins a same-version merge with an unmigrated one (styles-store-merge)
	return { style: { ...style, steps, params, ...(flags.length ? { flags } : {}), ...(options.now ? { updated_at: options.now } : {}) }, changed: true, notes };
}

/**
 * Fix a flagged style: its absolute caption size becomes `scale` (default: the ratio its wording means). Returns the
 * style unchanged when it has no absolute caption size flag.
 */
export function resolveCaptionSizeFlag(style: SavedStyle, scale?: number): SavedStyle {
	const flag = style.flags?.find((candidate) => candidate.code === "absolute_caption_size");
	const ratio = scale ?? flag?.suggested_scale;
	if (!flag || !ratio || !(ratio > 0)) return style;
	const params: Record<string, StyleParamSpec> = { ...(style.params ?? {}) };
	const steps: StyleStep[] = style.steps.map((step) => {
		if (step.kind !== "op" || step.op.op !== "set_caption_style") return step;
		const textStyle = step.op.style as Record<string, unknown> | undefined;
		if (!textStyle || textStyle.size === undefined) return step;
		if (isRef(textStyle.size)) delete params[textStyle.size.$param];
		const { size: _size, ...rest } = textStyle;
		return { ...step, op: { ...step.op, style: { ...rest, scale: { $param: CAPTION_SCALE_PARAM } } } };
	});
	params[CAPTION_SCALE_PARAM] = { ...CAPTION_SCALE_SPEC, default: round(ratio, 3) };
	const flags = (style.flags ?? []).filter((candidate) => candidate !== flag);
	const { flags: _flags, ...rest } = style;
	return { ...rest, steps, params, ...(flags.length ? { flags } : {}) };
}

/** migrateSavedStyle over a whole library (current styles and older versions). */
export function migrateLibrary(library: StyleLibrary, options: { now?: string } = {}): { library: StyleLibrary; changed: boolean; notes: string[] } {
	let changed = false;
	const notes: string[] = [];
	const styles: Record<string, SavedStyle> = {};
	for (const [id, style] of Object.entries(library.styles ?? {})) {
		const result = migrateSavedStyle(style, options);
		styles[id] = result.style;
		if (result.changed) {
			changed = true;
			notes.push(...result.notes.map((note) => `${id}: ${note}`));
		}
	}
	const versions: Record<string, SavedStyle[]> = {};
	for (const [id, list] of Object.entries(library.versions ?? {})) {
		versions[id] = list.map((style) => {
			const result = migrateSavedStyle(style);
			if (result.changed) changed = true;
			return result.style;
		});
	}
	return changed ? { library: { ...library, styles, versions }, changed, notes } : { library, changed: false, notes };
}
