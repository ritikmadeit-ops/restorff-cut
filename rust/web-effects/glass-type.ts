// Drop-in effect definition for apps/web/src/effects/definitions/ (RestorffCut rust agent,
// 2026-10-20). Shader: rust/crates/effects/src/shaders/glass_panel.wgsl, id
// "restorff-glass-panel". A frosted-glass rounded panel meant to sit behind text: put it on an
// effect layer (or the clip) under the text track. Pixel sizes are authored at a 1080 px short
// side and scale with the render size. Install steps: docs/restorff/RUST.md.
import { converter, parse } from "culori";
import type { EffectDefinition } from "@/effects/types";
import type { ParamValues } from "@/params";

export const GLASS_PANEL_SHADER = "restorff-glass-panel";

const REFERENCE_SHORT_SIDE = 1080;
const toRgb = converter("rgb");

function readNumber(params: ParamValues, key: string, fallback: number): number {
	const raw = params[key];
	const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
	return Number.isFinite(value) ? value : fallback;
}

/** Canvas pixels are sRGB-encoded in an Unorm texture, so the tint goes in as sRGB 0..1. */
function readSrgb(params: ParamValues, key: string): [number, number, number] {
	const parsed = parse(String(params[key] ?? "#ffffff"));
	const rgb = parsed ? toRgb(parsed) : undefined;
	return rgb ? [rgb.r ?? 1, rgb.g ?? 1, rgb.b ?? 1] : [1, 1, 1];
}

export const glassTypeEffectDefinition: EffectDefinition = {
	type: "restorff-glass-type",
	name: "Glass Type",
	keywords: ["glass", "frosted", "panel", "blur card", "glassmorphism", "caption card"],
	params: [
		{ key: "x", label: "X", type: "number", default: 10, min: 0, max: 100, step: 1 },
		{ key: "y", label: "Y", type: "number", default: 62, min: 0, max: 100, step: 1 },
		{ key: "width", label: "Width", type: "number", default: 80, min: 0, max: 100, step: 1 },
		{ key: "height", label: "Height", type: "number", default: 22, min: 0, max: 100, step: 1 },
		{ key: "cornerRadius", label: "Corner radius", type: "number", default: 24, min: 0, max: 200, step: 1 },
		{ key: "blur", label: "Frost", type: "number", default: 24, min: 0, max: 100, step: 1 },
		{ key: "brightness", label: "Brightness", type: "number", default: 12, min: 0, max: 100, step: 1 },
		{ key: "tint", label: "Tint", type: "color", default: "#ffffff" },
		{ key: "tintStrength", label: "Tint strength", type: "number", default: 6, min: 0, max: 100, step: 1 },
		{ key: "borderWidth", label: "Border", type: "number", default: 1.5, min: 0, max: 20, step: 0.5 },
		{ key: "borderOpacity", label: "Border opacity", type: "number", default: 35, min: 0, max: 100, step: 1 },
	],
	renderer: {
		passes: [
			{
				shader: GLASS_PANEL_SHADER,
				uniforms: ({ effectParams, width, height }) => {
					const pixelScale = Math.min(width, height) / REFERENCE_SHORT_SIDE;
					return {
						u_rect: [
							readNumber(effectParams, "x", 10) / 100,
							readNumber(effectParams, "y", 62) / 100,
							readNumber(effectParams, "width", 80) / 100,
							readNumber(effectParams, "height", 22) / 100,
						],
						u_corner_radius: readNumber(effectParams, "cornerRadius", 24) * pixelScale,
						u_blur: readNumber(effectParams, "blur", 24) * pixelScale,
						u_brightness: readNumber(effectParams, "brightness", 12) / 100,
						u_tint: [
							...readSrgb(effectParams, "tint"),
							readNumber(effectParams, "tintStrength", 6) / 100,
						],
						u_border_width: readNumber(effectParams, "borderWidth", 1.5) * pixelScale,
						u_border_opacity: readNumber(effectParams, "borderOpacity", 35) / 100,
						u_softness: Math.max(0.5, pixelScale),
					};
				},
			},
		],
	},
};
