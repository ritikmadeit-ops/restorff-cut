import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { digitalZoomEffectDefinition } from "./digital-zoom";
import { glassTypeEffectDefinition } from "./glass-type";
import { gradeEffectDefinition } from "./grade";
import { vertigoEffectDefinition } from "./vertigo";

const defaultEffects = [
	blurEffectDefinition,
	digitalZoomEffectDefinition,
	vertigoEffectDefinition,
	glassTypeEffectDefinition,
	gradeEffectDefinition,
];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}
