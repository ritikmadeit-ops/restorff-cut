// Drop-in effect definition for apps/web/src/effects/definitions/ (RestorffCut rust agent,
// 2026-10-20). Shader: rust/crates/effects/src/shaders/vertigo.wgsl, id "restorff-vertigo".
// Keyframe Strength (e.g. 0 -> 100 over the shot) for the dolly-zoom push; the centre region
// keeps its size while the surroundings magnify. Install steps: docs/restorff/RUST.md.
import type { EffectDefinition } from "@/effects/types";
import type { ParamValues } from "@/params";

export const VERTIGO_SHADER = "restorff-vertigo";

function readNumber(params: ParamValues, key: string, fallback: number): number {
	const raw = params[key];
	const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
	return Number.isFinite(value) ? value : fallback;
}

export const vertigoEffectDefinition: EffectDefinition = {
	type: "restorff-vertigo",
	name: "Vertigo",
	keywords: ["vertigo", "dolly zoom", "zolly", "hitchcock", "warp"],
	params: [
		{ key: "centerX", label: "Center X", type: "number", default: 50, min: 0, max: 100, step: 1 },
		{ key: "centerY", label: "Center Y", type: "number", default: 50, min: 0, max: 100, step: 1 },
		{ key: "radius", label: "Subject size", type: "number", default: 25, min: 0, max: 100, step: 1 },
		{ key: "strength", label: "Strength", type: "number", default: 50, min: 0, max: 100, step: 1 },
		{ key: "feather", label: "Feather", type: "number", default: 15, min: 0, max: 100, step: 1 },
	],
	renderer: {
		passes: [
			{
				shader: VERTIGO_SHADER,
				uniforms: ({ effectParams }) => ({
					u_center: [
						readNumber(effectParams, "centerX", 50) / 100,
						readNumber(effectParams, "centerY", 50) / 100,
					],
					// Fractions of the frame's short side.
					u_radius: readNumber(effectParams, "radius", 25) / 100,
					u_strength: readNumber(effectParams, "strength", 50) / 100,
					u_feather: readNumber(effectParams, "feather", 15) / 100,
				}),
			},
		],
	},
};
