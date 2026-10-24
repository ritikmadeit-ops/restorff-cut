import { createJSONStorage, type StateStorage } from "zustand/middleware";

/**
 * localStorage that never throws (private windows, blocked site data, quota, server render): reads come back null,
 * writes are dropped. Saved styles must also be exportable as JSON for exactly this reason.
 */
const safe: StateStorage = {
	getItem: (name) => {
		try {
			return typeof window === "undefined" ? null : window.localStorage.getItem(name);
		} catch {
			return null;
		}
	},
	setItem: (name, value) => {
		try {
			if (typeof window !== "undefined") window.localStorage.setItem(name, value);
		} catch {
			// quota or blocked storage: the in-memory state still works for this session
		}
	},
	removeItem: (name) => {
		try {
			if (typeof window !== "undefined") window.localStorage.removeItem(name);
		} catch {
			// ignore
		}
	},
};

export const safeJsonStorage = createJSONStorage(() => safe);

/** Download text as a file (Export JSON). */
export function downloadText({ text, filename, type = "application/json" }: { text: string; filename: string; type?: string }): void {
	const url = URL.createObjectURL(new Blob([text], { type }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
