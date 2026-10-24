"use client";

import { useMemo } from "react";
import { useEditor } from "@/editor/use-editor";
import type { ElementRef, SceneTracks, TimelineElement } from "@/timeline";
import { getCompositionSource } from "./drop";
import type { CompositionSource } from "./types";

export interface SelectedComposition {
	ref: ElementRef;
	element: TimelineElement;
	source: CompositionSource;
}

function activeTracks(editor: {
	scenes: { getActiveScene: () => { tracks: SceneTracks } };
}): SceneTracks | null {
	try {
		return editor.scenes.getActiveScene().tracks;
	} catch {
		return null;
	}
}

/** The one selected timeline clip when it is a rendered composition (else null). */
export function useSelectedComposition(): SelectedComposition | null {
	const selected = useEditor((editor) => editor.selection.getSelectedElements());
	const tracks = useEditor((editor) => activeTracks(editor));
	return useMemo(() => {
		if (!tracks || selected.length !== 1) return null;
		const ref = selected[0];
		for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
			if (track.id !== ref.trackId) continue;
			const element = track.elements.find((candidate) => candidate.id === ref.elementId);
			const source = getCompositionSource({ element });
			if (element && source) return { ref, element, source };
		}
		return null;
	}, [selected, tracks]);
}
