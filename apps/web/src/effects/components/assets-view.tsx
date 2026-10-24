"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { effectsRegistry, EFFECT_TARGET_ELEMENT_TYPES } from "@/effects";
import { effectPreviewService } from "@/services/renderer/effect-preview";
import { useEditor } from "@/editor/use-editor";
import { buildEffectElement } from "@/timeline/element-utils";
import type { EffectDefinition } from "@/effects/types";
import type { EditorCore } from "@/core";
import { cn } from "@/utils/ui";
import { fetchCatalogue } from "@/compositions/api";
import type { CompositionEntry } from "@/compositions/types";
import type { CatalogueEffect } from "@/compositions/effects-catalogue";
import { useSelectedComposition } from "@/compositions/use-selected-composition";
import { ComposeDialog } from "@/compositions/components/compose-dialog";
import { EffectsLibrary } from "@/compositions/components/effects-library";
import { MotionGrid } from "@/compositions/components/motion-grid";
import { SelectedCompositionCard } from "@/compositions/components/selected-composition-card";
import { CustomRepairBanner, MotionCodeEntry } from "@/compositions/components/code-entry";

/**
 * The Effects tab (compose agent, 2026-10-20): MOTION = compositions rendered to alpha video and dropped on the
 * MOTION track; SHADERS = the compositor effects (blur, digital zoom, vertigo, glass); LIBRARY = every effect from
 * docs/restorff/EFFECTS.md with its honest status. A selected composition clip gets a change-by-sentence card on top.
 */
type View = "motion" | "shaders" | "library";

const VIEWS: Array<{ id: View; label: string }> = [
	{ id: "motion", label: "Motion" },
	{ id: "shaders", label: "Shaders" },
	{ id: "library", label: "Library" },
];

function addShaderEffect({
	editor,
	effectType,
	params,
}: {
	editor: EditorCore;
	effectType: string;
	/** Start values over the defaults (grade agent, 2026-10-20: a library grade row brings its look). */
	params?: Record<string, number | string>;
}) {
	const built = buildEffectElement({
		effectType,
		startTime: editor.playback.getCurrentTime(),
	});
	const element = params ? { ...built, params: { ...built.params, ...params } } : built;
	editor.timeline.insertElement({
		placement: { mode: "auto", trackType: "effect" },
		element,
	});
}

export function EffectsView() {
	const editor = useEditor();
	const [view, setView] = useState<View>("motion");
	const [entries, setEntries] = useState<CompositionEntry[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [picked, setPicked] = useState<CompositionEntry | null>(null);
	const selected = useSelectedComposition();

	useEffect(() => {
		let alive = true;
		fetchCatalogue()
			.then((list) => alive && setEntries(list))
			.catch((error) => alive && setLoadError(error instanceof Error ? error.message : String(error)));
		return () => {
			alive = false;
		};
	}, []);

	const onUse = (effect: CatalogueEffect) => {
		if (effect.via?.kind === "composition") {
			const name = effect.via.name;
			const entry = entries?.find((candidate) => candidate.name === name);
			if (entry) setPicked(entry);
		} else if (effect.via?.kind === "shader") {
			addShaderEffect({ editor, effectType: effect.via.type, params: effect.via.params });
		}
	};

	return (
		<PanelView title="Effects">
			<div className="bg-surface border-line mb-4 grid grid-cols-3 gap-0.5 rounded-[12px] border p-0.5">
				{VIEWS.map((item) => (
					<button
						key={item.id}
						type="button"
						onClick={() => setView(item.id)}
						className={cn(
							"rc-mono cursor-pointer rounded-[10px] py-1.5 text-[0.68rem] uppercase tracking-[0.08em] transition-colors",
							view === item.id ? "bg-[#2a2a31] text-bone" : "text-fog hover:text-bone",
						)}
					>
						{item.label}
					</button>
				))}
			</div>

			<CustomRepairBanner />

			{selected && (
				<SelectedCompositionCard
					selected={selected}
					entry={selected.source.custom ? undefined : entries?.find((entry) => entry.name === selected.source.name)}
				/>
			)}

			{view === "motion" && (
				<div className="flex flex-col gap-3 pb-6">
					<p className="text-fog text-[0.72rem] leading-snug">
						Motion graphics written as code. Pick one, fill it in, and it renders with alpha onto the MOTION
						track at the playhead.
					</p>
					<MotionCodeEntry />
					{loadError && <p className="rc-mono text-[0.7rem] text-[#e5484d]">{loadError}</p>}
					{!entries && !loadError && <p className="rc-mono text-fog text-[0.7rem]">loading the library…</p>}
					{entries && <MotionGrid entries={entries} onPick={setPicked} />}
				</div>
			)}

			{view === "shaders" && (
				<div className="flex flex-col gap-3 pb-6">
					<p className="text-fog text-[0.72rem] leading-snug">
						Per-pixel effects in the compositor. Drag onto a clip, or + to add an effect layer at the playhead.
					</p>
					<EffectsGrid effects={effectsRegistry.getAll()} />
				</div>
			)}

			{view === "library" && <EffectsLibrary onUse={onUse} />}

			{picked && (
				<ComposeDialog
					open={!!picked}
					onOpenChange={(open) => {
						if (!open) setPicked(null);
					}}
					entry={picked}
				/>
			)}
		</PanelView>
	);
}

function EffectsGrid({ effects }: { effects: EffectDefinition[] }) {
	return (
		<div
			className="grid gap-2"
			style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}
		>
			{effects.map((effect) => (
				<EffectItem key={effect.type} effect={effect} />
			))}
		</div>
	);
}

function EffectPreviewCanvas({ effectType }: { effectType: string }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const render = () => {
			if (canvasRef.current) {
				effectPreviewService.renderPreview({
					effectType,
					params: {},
					targetCanvas: canvasRef.current,
				});
			}
		};

		render();
		return effectPreviewService.onPreviewImageReady({ callback: render });
	}, [effectType]);

	return <canvas ref={canvasRef} className="size-full" />;
}

function EffectItem({ effect }: { effect: EffectDefinition }) {
	const editor = useEditor();

	const handleAddToTimeline = useCallback(() => {
		addShaderEffect({ editor, effectType: effect.type });
	}, [editor, effect.type]);

	const preview = <EffectPreviewCanvas effectType={effect.type} />;

	return (
		<DraggableItem
			name={effect.name}
			preview={preview}
			dragData={{
				id: effect.type,
				name: effect.name,
				type: "effect",
				effectType: effect.type,
				targetElementTypes: EFFECT_TARGET_ELEMENT_TYPES,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}
