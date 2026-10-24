"use client";

import { useMemo } from "react";
import { getCaptionStyle } from "@restorffcut/timeline-ops";
import { useEditor } from "@/editor/use-editor";
import { readCaptionDoc } from "./build";

/**
 * One line for the inspector's "Captions" row (design/edit-artboard.png: "1–3 words · highlight"), e.g.
 * "1–3 words · highlight", "1 word · Huge centred", or "none". For the properties panel owner to import.
 */
export function useCaptionSummary(): string {
	const tracks = useEditor((editor) => editor.scenes.getActiveSceneOrNull()?.tracks ?? null);
	return useMemo(() => {
		if (!tracks) return "none";
		const { doc, styleId } = readCaptionDoc(tracks);
		if (!doc.length) return "none";
		const counts = doc.map((chunk) => chunk.words.length);
		const min = Math.min(...counts);
		const max = Math.max(...counts);
		const words = min === max ? `${min} word${min === 1 ? "" : "s"}` : `${min}–${max} words`;
		if (!styleId) return words;
		const style = getCaptionStyle(styleId);
		return `${words} · ${style.highlight.kind === "word-box" ? "highlight" : style.highlight.kind === "karaoke" ? "karaoke" : style.label.toLowerCase()}`;
	}, [tracks]);
}
