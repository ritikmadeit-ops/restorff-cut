import type { EditorCore } from "@/core";
import type { RemoteComment } from "@/sync/remote";
import { resolveFindingTarget, type TrackWithElements } from "./judge-row";

export function sceneTracks(editor: EditorCore): TrackWithElements[] {
	const scene = editor.scenes.getActiveSceneOrNull();
	return scene ? [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio] : [];
}

/**
 * Selects the finding's element on the lane it lives on now; leaves the selection alone when it is gone.
 * ui-fix-timeline (QA 2026-10-20 #2): selecting the PINNED lane + element matched nothing when the gate pinned a
 * finding to its role's lane (R5 → V2 B-ROLL) while the element sat on another (MOTION), and the inspector went
 * blank until reload. Used by the JUDGE-row markers and the finding card's Jump.
 */
export function selectFindingElement(
	editor: EditorCore,
	comment: Pick<RemoteComment, "track_id" | "element_id">,
): boolean {
	const target = resolveFindingTarget(sceneTracks(editor), comment);
	if (!target) return false;
	editor.selection.setSelectedElements({ elements: [target] });
	return true;
}
