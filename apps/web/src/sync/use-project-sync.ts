"use client";

import { useEffect } from "react";
import { useEditor } from "@/editor/use-editor";
import { syncEngine } from "./engine";

/**
 * Attaches the sync engine to the open project. Mounted once, by the header's
 * commit line (components/editor/commit-line.tsx).
 */
export function useProjectSync(): void {
	const editor = useEditor();
	const projectId = useEditor((e) => e.project.getActiveOrNull()?.metadata.id ?? null);

	useEffect(() => {
		if (projectId) syncEngine.attach(editor, projectId);
	}, [editor, projectId]);

	useEffect(() => () => syncEngine.detach(), []);
}
