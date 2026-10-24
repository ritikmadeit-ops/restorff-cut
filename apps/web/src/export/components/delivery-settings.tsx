"use client";

import { useEditor } from "@/editor/use-editor";
import { DeliverySection, type DeliveryChoice } from "./delivery-section";

/**
 * Settings → Delivery: the project's delivery preset, fit and master loudness. Stored in
 * `settings.delivery` / `settings.loudness`, so every export (Render final, the gate, the
 * headless render) uses them without its caller knowing about presets.
 */
export function DeliverySettings() {
	const editor = useEditor();
	const project = useEditor((e) => e.project.getActiveOrNull());
	if (!project) return null;
	const { settings } = project;
	const value: DeliveryChoice = {
		presetId: settings.delivery?.preset ?? "",
		fit: settings.delivery?.fit ?? "contain",
		normalize: settings.loudness?.enabled ?? true,
	};
	const onChange = (next: DeliveryChoice) => {
		void editor.project.updateSettings({
			settings: {
				delivery: { preset: next.presetId || undefined, fit: next.fit },
				loudness: {
					enabled: next.normalize,
					integratedLufs: settings.loudness?.integratedLufs ?? -14,
					truePeakDb: settings.loudness?.truePeakDb ?? -1,
				},
			},
		});
	};
	return (
		<div className="flex flex-col gap-2 pb-6">
			<DeliverySection value={value} onChange={onChange} canvas={settings.canvasSize} />
			<p className="text-fog px-3 text-[0.72rem] leading-snug">
				Every render uses this. A preset sets the encoded size and bitrates; the scene renders at the canvas size and
				is scaled into it. The master is measured on the encoded file and reported after the render.
			</p>
		</div>
	);
}
