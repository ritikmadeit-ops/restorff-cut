/**
 * The transitions RestorffCut can render. Each one is a two-input WGSL shader in the wasm
 * compositor (`rust/crates/effects/src/shaders/transitions/*.wgsl`, registry
 * `rust/crates/effects/src/transitions.rs`) plus fixed parameters. A clip stores only
 * `transitionIn: { type: <id>, duration: <ticks> }` (project v32), so a definition can be
 * retuned without migrating projects.
 *
 * Directions name the way the PICTURE moves on screen ("whip left" = the image travels
 * left, as when the camera whips right). The canonical id list is shared with ops@1:
 * packages/timeline-ops/src/transitions.ts (a test keeps the two equal).
 * Feature set ported from OpenCut-AI's transition registry (MIT); shaders and timing are new.
 */
import type { EffectUniformValue } from "@/effects/types";

export type TransitionCategory = "dissolve" | "dip" | "motion" | "wipe" | "stylised";

export interface TransitionDefinition {
	id: string;
	name: string;
	category: TransitionCategory;
	/** Wasm transition shader id. */
	shader: string;
	uniforms: Record<string, EffectUniformValue>;
	defaultDurationSeconds: number;
	/** One line for the panel: what it is for. */
	hint: string;
	keywords: string[];
}

const LEFT = [-1, 0];
const RIGHT = [1, 0];
const UP = [0, -1];
const DOWN = [0, 1];

const DIRECTIONS = [
	{ suffix: "left", label: "left", vector: LEFT },
	{ suffix: "right", label: "right", vector: RIGHT },
	{ suffix: "up", label: "up", vector: UP },
	{ suffix: "down", label: "down", vector: DOWN },
] as const;

const SHADER = (name: string) => `restorff-transition-${name}`;

export const TRANSITIONS: TransitionDefinition[] = [
	{
		id: "dissolve",
		name: "Dissolve",
		category: "dissolve",
		shader: SHADER("dissolve"),
		uniforms: {},
		defaultDurationSeconds: 0.5,
		hint: "Soft time jump or mood change",
		keywords: ["crossfade", "cross dissolve", "mix", "fade"],
	},
	{
		id: "blur",
		name: "Blur dissolve",
		category: "dissolve",
		shader: SHADER("blur"),
		uniforms: { u_strength: 0.04 },
		defaultDurationSeconds: 0.5,
		hint: "Defocus out, focus in",
		keywords: ["defocus", "soft", "dreamy"],
	},
	{
		id: "dip-black",
		name: "Dip to black",
		category: "dip",
		shader: SHADER("dip"),
		uniforms: { u_color: [0, 0, 0, 1] },
		defaultDurationSeconds: 0.6,
		hint: "Section break; fade in from black on the first clip",
		keywords: ["black", "fade", "fade in", "fade out"],
	},
	{
		id: "dip-white",
		name: "Dip to white",
		category: "dip",
		shader: SHADER("dip"),
		uniforms: { u_color: [1, 1, 1, 1] },
		defaultDurationSeconds: 0.5,
		hint: "Bright, clean reset",
		keywords: ["white", "fade", "bright"],
	},
	{
		id: "flash",
		name: "Flash",
		category: "dip",
		shader: SHADER("flash"),
		uniforms: { u_intensity: 1 },
		defaultDurationSeconds: 0.25,
		hint: "A cut hidden in a burst of light — put it on a beat",
		keywords: ["flash", "light", "exposure", "beat", "hit"],
	},
	...DIRECTIONS.map(
		({ suffix, label, vector }): TransitionDefinition => ({
			id: `whip-${suffix}`,
			name: `Whip ${label}`,
			category: "motion",
			shader: SHADER("whip"),
			uniforms: { u_direction: [...vector], u_blur: 0.35 },
			defaultDurationSeconds: 0.3,
			hint: "Whip pan with motion blur — energy between shots",
			keywords: ["whip", "pan", "swish", "motion blur", label],
		}),
	),
	...DIRECTIONS.map(
		({ suffix, label, vector }): TransitionDefinition => ({
			id: `push-${suffix}`,
			name: `Push ${label}`,
			category: "motion",
			shader: SHADER("whip"),
			uniforms: { u_direction: [...vector], u_blur: 0 },
			defaultDurationSeconds: 0.4,
			hint: "The next shot pushes this one out",
			keywords: ["push", "slide", label],
		}),
	),
	...DIRECTIONS.map(
		({ suffix, label, vector }): TransitionDefinition => ({
			id: `slide-${suffix}`,
			name: `Slide ${label}`,
			category: "motion",
			shader: SHADER("slide"),
			uniforms: { u_direction: [...vector] },
			defaultDurationSeconds: 0.4,
			hint: "The next shot slides in over this one",
			keywords: ["slide", "cover", label],
		}),
	),
	{
		id: "zoom-in",
		name: "Zoom through",
		category: "motion",
		shader: SHADER("zoom"),
		uniforms: { u_center: [0.5, 0.5], u_strength: 1, u_blur: 0.6 },
		defaultDurationSeconds: 0.4,
		hint: "Punch through the frame into the next shot",
		keywords: ["zoom", "punch", "zoom through", "push in"],
	},
	...DIRECTIONS.map(
		({ suffix, label, vector }): TransitionDefinition => ({
			id: `wipe-${suffix}`,
			name: `Wipe ${label}`,
			category: "wipe",
			shader: SHADER("wipe"),
			uniforms: { u_direction: [...vector], u_softness: 0.06 },
			defaultDurationSeconds: 0.5,
			hint: "A soft edge sweeps the next shot in",
			keywords: ["wipe", "reveal", label],
		}),
	),
	{
		id: "iris",
		name: "Iris",
		category: "wipe",
		shader: SHADER("iris"),
		uniforms: { u_center: [0.5, 0.5], u_feather: 0.04 },
		defaultDurationSeconds: 0.6,
		hint: "Circle opens from the centre",
		keywords: ["iris", "circle", "reveal"],
	},
	{
		id: "glitch",
		name: "Glitch",
		category: "stylised",
		shader: SHADER("glitch"),
		uniforms: { u_strength: 1 },
		defaultDurationSeconds: 0.3,
		hint: "Torn bands and RGB split around the cut",
		keywords: ["glitch", "digital", "error", "rgb"],
	},
];

const BY_ID = new Map(TRANSITIONS.map((definition) => [definition.id, definition]));

export function getTransitionDefinition(id: string): TransitionDefinition | null {
	return BY_ID.get(id) ?? null;
}

export const TRANSITION_CATEGORY_LABELS: Record<TransitionCategory, string> = {
	dissolve: "Dissolves",
	dip: "Dips & flashes",
	motion: "Motion",
	wipe: "Wipes",
	stylised: "Stylised",
};
