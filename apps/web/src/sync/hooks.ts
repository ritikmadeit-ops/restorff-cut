/**
 * The seam between the editor's local storage (services/storage/service.ts) and
 * the sync engine (./engine.ts). Storage calls these; it never imports the engine
 * (the engine imports storage), so there is no import cycle.
 */
import type { ProjectSnapshot } from "./snapshot";

type SavedListener = (project: ProjectSnapshot) => void;

const savedListeners = new Set<SavedListener>();

/** Called by storageService.saveProject after every local save. */
export function notifyProjectSaved(project: ProjectSnapshot): void {
	for (const listener of savedListeners) {
		try {
			listener(project);
		} catch (error) {
			console.error("[sync] save listener failed:", error);
		}
	}
}

export function onProjectSaved(listener: SavedListener): () => void {
	savedListeners.add(listener);
	return () => savedListeners.delete(listener);
}
