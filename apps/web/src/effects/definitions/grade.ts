// RestorffCut "Grade" (grade agent, 2026-10-20). Shader: rust/crates/effects/src/shaders/grade.wgsl, id
// "restorff-grade" (restorffcut-wasm >= 0.5.0). One GPU pass; every slider is a number, so every slider is
// keyframable (effects.<id>.params.<key>). The sliders, their ranges, the named looks ("warm morning", "moody", …)
// and the uniform maths live in ONE place shared with the ops@1 reducer: packages/timeline-ops/src/grades.ts.
// `params.look` (a string, not declared here, so the generic panel does not show it) records the look the grade
// started from; the inspector's Grade row reads it (apps/web/src/grade/).
import { GRADE_EFFECT_TYPE, GRADE_PARAM_SPECS, GRADE_SHADER_ID, gradeUniforms } from "@restorffcut/timeline-ops";
import type { EffectDefinition } from "@/effects/types";

export const GRADE_SHADER = GRADE_SHADER_ID;

export const gradeEffectDefinition: EffectDefinition = {
	type: GRADE_EFFECT_TYPE,
	name: "Grade",
	keywords: [
		"grade",
		"colour",
		"color",
		"look",
		"lut",
		"warm",
		"cool",
		"moody",
		"film",
		"exposure",
		"contrast",
		"saturation",
		"temperature",
		"vignette",
		"grain",
	],
	params: GRADE_PARAM_SPECS.map((spec) => ({
		key: spec.key,
		label: spec.label,
		type: "number" as const,
		default: spec.default,
		min: spec.min,
		max: spec.max,
		step: spec.step,
	})),
	renderer: {
		passes: [
			{
				shader: GRADE_SHADER,
				uniforms: ({ effectParams, time }) => gradeUniforms(effectParams, time ?? 0),
			},
		],
	},
};
