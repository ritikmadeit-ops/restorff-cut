import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	deleteStyle,
	dismissPattern,
	emptyLibrary,
	importLibrary,
	migrateLibrary,
	restoreVersion,
	saveStyle,
	type ImportResult,
	type InstructionRecord,
	type SavedStyle,
	type StyleLibrary,
} from "@restorffcut/styles";
import { safeJsonStorage } from "./storage";
// mcp-review agent, 2026-10-20: saved styles + history also live on the server (/api/styles) so Claude over MCP
// sees them; push on change, pull once on load (fire-and-forget, localStorage stays the working copy)
import { deleteServerStyle, dismissServerPattern, pullServerStyles, pushServerStyles, recordServerInstruction } from "@/server/styles-store-client";

/**
 * Styles lab state (EDT-20), in this browser: the saved-style library (versions kept) and the command history the
 * "Save as style?" suggestion is computed from. localStorage key "restorffcut-styles-lab" (wrapped in try/catch,
 * ./storage.ts). Export/Import JSON is the way to move styles between browsers until they live on the server.
 */
export const HISTORY_LIMIT = 150;

export interface SheetState {
	open: boolean;
	draft: SavedStyle | null;
	/** The repeat pattern the draft came from (dismissed/saved together). */
	pattern: string | null;
	/** Editing an existing saved style (Save = new version) rather than a new suggestion. */
	editing: boolean;
}

interface StylesLabState {
	library: StyleLibrary;
	history: InstructionRecord[];
	sheet: SheetState;
	addRecord: (record: InstructionRecord) => void;
	clearHistory: () => void;
	save: (args: { style: SavedStyle; note?: string }) => SavedStyle;
	remove: (id: string) => void;
	restore: (args: { id: string; version: string }) => void;
	dismiss: (pattern: string) => void;
	importJson: (text: string) => ImportResult;
	openSheet: (args: { draft: SavedStyle; pattern?: string | null; editing?: boolean }) => void;
	closeSheet: () => void;
}

const CLOSED: SheetState = { open: false, draft: null, pattern: null, editing: false };

export const useStylesLabStore = create<StylesLabState>()(
	persist(
		(set, get) => ({
			library: emptyLibrary(),
			history: [],
			sheet: CLOSED,
			addRecord: (record) => {
				set((state) => ({ history: [...state.history, record].slice(-HISTORY_LIMIT) }));
				recordServerInstruction(record); // mcp-review agent
			},
			clearHistory: () => set({ history: [] }),
			save: ({ style, note }) => {
				const result = saveStyle(get().library, style, { note });
				set({ library: result.library });
				pushServerStyles(result.library); // mcp-review agent
				return result.style;
			},
			remove: (id) => {
				set((state) => ({ library: deleteStyle(state.library, id) }));
				deleteServerStyle(id); // mcp-review agent
			},
			restore: ({ id, version }) => {
				set((state) => ({ library: restoreVersion(state.library, id, version) }));
				pushServerStyles(get().library); // mcp-review agent
			},
			dismiss: (pattern) => {
				set((state) => ({ library: dismissPattern(state.library, pattern) }));
				dismissServerPattern(pattern); // mcp-review agent
			},
			importJson: (text) => {
				const result = importLibrary(text, get().library);
				result.library = migrateLibrary(result.library, { now: new Date().toISOString() }).library; // ui-fix-panels (QA #8)
				set({ library: result.library });
				pushServerStyles(result.library); // mcp-review agent
				return result;
			},
			openSheet: ({ draft, pattern = null, editing = false }) => set({ sheet: { open: true, draft, pattern, editing } }),
			closeSheet: () => set({ sheet: CLOSED }),
		}),
		{
			name: "restorffcut-styles-lab",
			version: 1,
			storage: safeJsonStorage,
			partialize: (state) => ({ library: state.library, history: state.history }),
			// mcp-review agent: after localStorage loads, merge the server's library + history in (no-op on the server)
			// ui-fix-panels (QA #8): both copies are migrated (absolute caption sizes → ratios, or flagged); a changed
			// library is pushed back after the pull's own push, stamped later so it wins the merge
			onRehydrateStorage: () => () =>
				pullServerStyles(
					() => useStylesLabStore.getState(),
					(merged) => {
						const migrated = migrateLibrary(merged.library, { now: new Date().toISOString() });
						useStylesLabStore.setState({ ...merged, library: migrated.library });
						if (migrated.changed) setTimeout(() => pushServerStyles(useStylesLabStore.getState().library), 1500);
					},
				),
			merge: (persisted, current) => {
				const saved = (persisted ?? {}) as Partial<StylesLabState>;
				return {
					...current,
					library: saved.library?.styles ? migrateLibrary({ ...emptyLibrary(), ...saved.library }, { now: new Date().toISOString() }).library : current.library,
					history: Array.isArray(saved.history) ? saved.history.slice(-HISTORY_LIMIT) : current.history,
				};
			},
		},
	),
);
