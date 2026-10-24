// Drop-in effect definition for apps/web/src/effects/definitions/ (RestorffCut rust agent,
// 2026-10-20). Shader: rust/crates/effects/src/shaders/digital_zoom.wgsl, id
// "restorff-digital-zoom". Every numeric param is keyframable through the generic
// effects.<id>.params.<key> path. Install steps: docs/restorff/RUST.md.
import type { EffectDefinition } from "@/effects/types";
import type { ParamValues } from "@/params";

export const DIGITAL_ZOOM_SHADER = "restorff-digital-zoom";

function readNumber(params: ParamValues, key: string, fallback: number): number {
	const raw = params[key];
	const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
	return Number.isFinite(value) ? value : fallback;
}

export const digitalZoomEffectDefinition: EffectDefinition = {
	type: "restorff-digital-zoom",
	name: "Digital Zoom",
	keywords: ["zoom", "punch in", "push in", "digital zoom", "crash zoom"],
	params: [
		{ key: "focusX", label: "Focus X", type: "number", default: 50, min: 0, max: 100, step: 1 },
		{ key: "focusY", label: "Focus Y", type: "number", default: 50, min: 0, max: 100, step: 1 },
		{ key: "amount", label: "Amount", type: "number", default: 100, min: 0, max: 300, step: 1 },
		{ key: "blur", label: "Motion blur", type: "number", default: 0, min: 0, max: 100, step: 1 },
		{ key: "chroma", label: "Chromatic edge", type: "number", default: 0, min: 0, max: 100, step: 1 },
	],
	renderer: {
		passes: [
			{
				shader: DIGITAL_ZOOM_SHADER,
				uniforms: ({ effectParams }) => ({
					u_focal: [
						readNumber(effectParams, "focusX", 50) / 100,
						readNumber(effectParams, "focusY", 50) / 100,
					],
					// Amount 100 = 2x.
					u_zoom: 1 + Math.max(0, readNumber(effectParams, "amount", 100)) / 100,
					u_blur: readNumber(effectParams, "blur", 0) / 100,
					u_chroma: readNumber(effectParams, "chroma", 0) / 100,
				}),
			},
		],
	},
};
