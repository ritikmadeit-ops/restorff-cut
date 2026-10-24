/**
 * Transition kinds the editor can render (project v32 `element.transitionIn`), with the words ops@1 accepts for them.
 *
 * The editor's registry (apps/web/src/transitions/definitions.ts) adds names, shaders and parameters for the same ids;
 * a test there checks both lists stay equal. The shaders are in rust/crates/effects/src/shaders/transitions/.
 */

/** Canonical id → default length in seconds. */
export const TRANSITION_KINDS: Readonly<Record<string, number>> = {
	dissolve: 0.5,
	"dip-black": 0.6,
	"dip-white": 0.5,
	flash: 0.25,
	"whip-left": 0.3,
	"whip-right": 0.3,
	"whip-up": 0.3,
	"whip-down": 0.3,
	"push-left": 0.4,
	"push-right": 0.4,
	"push-up": 0.4,
	"push-down": 0.4,
	"slide-left": 0.4,
	"slide-right": 0.4,
	"slide-up": 0.4,
	"slide-down": 0.4,
	"zoom-in": 0.4,
	"wipe-left": 0.5,
	"wipe-right": 0.5,
	"wipe-up": 0.5,
	"wipe-down": 0.5,
	iris: 0.6,
	glitch: 0.3,
	blur: 0.5,
};

/** Other words for a kind (after lower-casing and `_`/space → `-`). */
const ALIASES: Readonly<Record<string, string>> = {
	crossfade: "dissolve",
	"cross-dissolve": "dissolve",
	mix: "dissolve",
	dip: "dip-black",
	"dip-to-black": "dip-black",
	"fade-black": "dip-black",
	"fade-to-black": "dip-black",
	"dip-to-white": "dip-white",
	"fade-white": "dip-white",
	"fade-to-white": "dip-white",
	"white-flash": "flash",
	whip: "whip-left",
	"whip-pan": "whip-left",
	swish: "whip-left",
	push: "push-left",
	slide: "slide-left",
	cover: "slide-left",
	zoom: "zoom-in",
	"zoom-through": "zoom-in",
	punch: "zoom-in",
	wipe: "wipe-right",
	circle: "iris",
	"iris-open": "iris",
	"blur-dissolve": "blur",
};

/** Kinds that are joins, not transitions: nothing to write. */
export const CUT_KINDS: readonly string[] = ["cut", "match", "match-cut", "hard-cut", "smash-cut", "jump-cut"];

export function normalizeTransitionKind(kind: string): string {
	return kind.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/** The canonical id for a kind or alias, or null when the editor cannot render it. */
export function resolveTransitionKind(kind: string): string | null {
	const normalized = normalizeTransitionKind(kind);
	if (TRANSITION_KINDS[normalized] !== undefined) return normalized;
	return ALIASES[normalized] ?? null;
}
