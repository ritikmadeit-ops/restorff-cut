/**
 * Pure layout maths of the four matte presets (EFFECTS.md "M": FX-43 text behind person, FX-12 green screen, FX-16
 * cover story, FX-04 frame break), shared by the editor (`./presets.ts`, Person tools) and the server (MCP `cutout
 * apply`, `@/server/matte-presets.ts`), so both place exactly the same layers.
 *
 * Moved out of presets.ts by the mcp-cutout agent (2026-10-20; docs/restorff/worklog/mcp-cutout.md): presets.ts imports
 * the editor core and cannot load on the server. Rule here: no editor, DOM, wasm or id imports — numbers in, editor
 * params (keys as in params/registry.ts) out. Times are SECONDS; callers convert to ticks.
 */
import type { Box } from "@/segmentation/types";

export type Canvas = { width: number; height: number };
export type Rect = { left: number; top: number; width: number; height: number };

export const CONDENSED_FONTS = /anton|bebas|oswald|league gothic/i;

/** Text font size (editor units: px = size × canvasHeight / 90) for a word to span `widthFraction` of the canvas. */
export function fitFontSize({
	text,
	canvas,
	widthFraction,
	charEm,
	maxHeightFraction,
}: {
	text: string;
	canvas: Canvas;
	widthFraction: number;
	charEm: number;
	maxHeightFraction: number;
}): { fontSize: number; emPx: number } {
	const longestLine = Math.max(1, ...text.split("\n").map((line) => line.length));
	const emPx = Math.min(canvas.height * maxHeightFraction, (canvas.width * widthFraction) / (longestLine * charEm));
	// Floor 1 = the editor's own minimum (params/registry.ts). It was 5 in presets.ts, which made the cover-story
	// dateline and cover lines (42-65 px wanted) 107 px and cut them off at the frame edges (SEEN 2026-10-20, render).
	const fontSize = Math.max(1, Math.min(300, emPx / (canvas.height / 90)));
	return { fontSize, emPx: fontSize * (canvas.height / 90) };
}

/** Scale factor (on top of the renderer's contain-fit) that makes media of this size cover the canvas. */
export function coverScale({ canvas, width, height }: { canvas: Canvas; width: number; height: number }): number {
	const contain = Math.min(canvas.width / width, canvas.height / height);
	const cover = Math.max(canvas.width / width, canvas.height / height);
	return cover / contain;
}

/** The head on the canvas (px) from the plate's drawn rect and the matte boxes, or a sensible guess. */
export function headOnCanvas({
	rect,
	head,
	person,
	canvas,
}: {
	rect: Rect;
	head: Box | null;
	person: Box | null;
	canvas: Canvas;
}): { top: number; centerX: number; height: number } {
	const box: Box | null = head ?? (person ? [person[0], person[1], person[2], person[3] * 0.25] : null);
	if (!box) return { top: canvas.height * 0.22, centerX: canvas.width / 2, height: canvas.height * 0.15 };
	return {
		top: rect.top + box[1] * rect.height,
		centerX: rect.left + (box[0] + box[2] / 2) * rect.width,
		height: box[3] * rect.height,
	};
}

/** Fade + scale-in keyframes, seconds from the element's start (the editor and the server turn them into ticks). */
export function fadeScaleInKeys({ from = 0.92, fadeSeconds = 0.25, delaySeconds = 0 } = {}): Record<
	"opacity" | "transform.scaleX" | "transform.scaleY",
	Array<{ time: number; value: number }>
> {
	const ramp = (a: number, b: number) => [
		{ time: delaySeconds, value: a },
		{ time: delaySeconds + fadeSeconds, value: b },
	];
	return { opacity: ramp(0, 1), "transform.scaleX": ramp(from, 1), "transform.scaleY": ramp(from, 1) };
}

// ---------------------------------------------------------------- FX-43 text behind person

export interface TextLayer {
	content: string;
	params: Record<string, unknown>;
	animation: { from: number; fadeSeconds: number; delaySeconds: number };
}

/** The headline that goes between the plate and the person: big, centred, its lower part hidden by the head. */
export function textBehindLayout({
	text,
	fontFamily,
	color,
	canvas,
	head,
}: {
	text: string;
	fontFamily?: string;
	color?: string;
	canvas: Canvas;
	head: { top: number };
}): TextLayer {
	const family = fontFamily ?? "Anton";
	const condensed = CONDENSED_FONTS.test(family);
	const content = (text || "STEEP").toUpperCase();
	const { fontSize, emPx } = fitFontSize({
		text: content,
		canvas,
		widthFraction: 0.92,
		charEm: condensed ? 0.5 : 0.68,
		maxHeightFraction: 0.32,
	});
	// The head covers the lower part of the letters: centre the word just below the top of the head.
	const centerY = Math.max(emPx * 0.6, Math.min(canvas.height - emPx * 0.6, head.top + emPx * 0.12));
	return {
		content,
		params: {
			fontFamily: family,
			fontSize,
			fontWeight: condensed ? "normal" : "bold",
			color: color ?? "#EDEBE6",
			textAlign: "center",
			letterSpacing: 0,
			lineHeight: 0.95,
			"transform.positionX": 0,
			"transform.positionY": centerY - canvas.height / 2,
		},
		animation: { from: 0.92, fadeSeconds: 0.25, delaySeconds: 0 },
	};
}

// ---------------------------------------------------------------- FX-12 green screen

/** A full-canvas rectangle (graphic "rectangle", whose unit size is the canvas's short side). */
export function backgroundRectParams({ canvas, color }: { canvas: Canvas; color: string }): Record<string, unknown> {
	const side = Math.min(canvas.width, canvas.height);
	return {
		fill: color,
		strokeWidth: 0,
		cornerRadius: 0,
		"transform.scaleX": (canvas.width / side) * 1.02,
		"transform.scaleY": (canvas.height / side) * 1.02,
	};
}

// ---------------------------------------------------------------- FX-16 cover story

export interface CoverStoryLayout {
	masthead: TextLayer;
	/** Rectangle graphic params (outline only). */
	frame: Record<string, unknown>;
	dateline: TextLayer;
	lines: TextLayer | null;
}

/** Layer order, bottom → top: plate, frame, masthead, PERSON, cover lines, dateline. */
export function coverStoryLayout({
	masthead,
	dateline,
	lines,
	color,
	canvas,
	head,
}: {
	masthead: string;
	dateline?: string;
	lines?: string[];
	color?: string;
	canvas: Canvas;
	head: { top: number };
}): CoverStoryLayout {
	const ink = color ?? "#EDEBE6";
	const title = (masthead || "STEEP").toUpperCase();
	const { fontSize, emPx } = fitFontSize({ text: title, canvas, widthFraction: 0.9, charEm: 0.74, maxHeightFraction: 0.26 });
	const mastheadY = Math.max(canvas.height * 0.035 + emPx * 0.55, Math.min(canvas.height * 0.4, head.top + emPx * 0.18));
	const side = Math.min(canvas.width, canvas.height);
	const small = fitFontSize({ text: "X", canvas, widthFraction: 1, charEm: 1, maxHeightFraction: 0.022 });
	const datelineText = (dateline ?? "NO. 01 · OCTOBER 2026").toUpperCase();
	const kept = (lines ?? ["Cold brew, slowly", "18 hours in the making"]).filter((line) => line.trim());
	const linesText = kept.map((line) => line.toUpperCase()).join("\n");
	const linesSize = fitFontSize({ text: linesText, canvas, widthFraction: 0.8, charEm: 0.62, maxHeightFraction: 0.034 });
	return {
		masthead: {
			content: title,
			params: {
				fontFamily: "Bodoni Moda",
				fontSize,
				fontWeight: "bold",
				color: ink,
				textAlign: "center",
				letterSpacing: 0,
				lineHeight: 0.9,
				"transform.positionX": 0,
				"transform.positionY": mastheadY - canvas.height / 2,
			},
			animation: { from: 1.08, fadeSeconds: 0.35, delaySeconds: 0 },
		},
		frame: {
			fill: "rgba(0,0,0,0)",
			stroke: ink,
			strokeWidth: 2,
			strokeAlign: "inside",
			cornerRadius: 0,
			"transform.scaleX": (canvas.width * 0.94) / side,
			"transform.scaleY": (canvas.height * 0.965) / side,
		},
		dateline: {
			content: datelineText,
			params: {
				fontFamily: "Archivo",
				fontSize: small.fontSize,
				fontWeight: "bold",
				color: ink,
				textAlign: "center",
				letterSpacing: 2,
				"transform.positionX": 0,
				"transform.positionY": -canvas.height / 2 + canvas.height * 0.03 + small.emPx * 0.6,
			},
			animation: { from: 1, fadeSeconds: 0.25, delaySeconds: 0.3 },
		},
		lines: linesText
			? {
					content: linesText,
					params: {
						fontFamily: "Archivo",
						fontSize: linesSize.fontSize,
						fontWeight: "bold",
						color: ink,
						textAlign: "center",
						letterSpacing: 1,
						lineHeight: 1.15,
						"transform.positionX": 0,
						"transform.positionY": canvas.height / 2 - canvas.height * 0.08 - linesSize.emPx * kept.length * 0.6,
					},
					animation: { from: 1, fadeSeconds: 0.3, delaySeconds: 0.45 },
				}
			: null,
	};
}

// ---------------------------------------------------------------- FX-04 frame break

export interface FrameBreakLayout {
	/** Element scale inside the frame (multiplies the clip's own scale). */
	scale: number;
	shrinkSeconds: number;
	/** RectangleMask params for the plate (`masks/types.ts` RectangleMaskParams). */
	mask: {
		centerX: number;
		centerY: number;
		width: number;
		height: number;
		rotation: number;
		scale: number;
		feather: number;
		inverted: boolean;
		strokeColor: string;
		strokeWidth: number;
		strokeAlign: "inside" | "center" | "outside";
	};
}

export function frameBreakLayout(
	options: {
		scale?: number;
		frameWidth?: number;
		frameHeight?: number;
		borderPx?: number;
		borderColor?: string;
		shrinkSeconds?: number;
	} = {},
): FrameBreakLayout {
	return {
		scale: options.scale ?? 0.8,
		shrinkSeconds: options.shrinkSeconds ?? 0.3,
		mask: {
			centerX: 0,
			centerY: 0.04,
			width: options.frameWidth ?? 0.78,
			height: options.frameHeight ?? 0.7,
			rotation: 0,
			scale: 1,
			feather: 0,
			inverted: false,
			strokeColor: options.borderColor ?? "#EDEBE6",
			strokeWidth: options.borderPx ?? 8,
			strokeAlign: "outside",
		},
	};
}
