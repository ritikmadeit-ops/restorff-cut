import { create } from "zustand";
import { persist } from "zustand/middleware";
import { EDITING_STYLE_PRESETS } from "@restorffcut/timeline-ops";
import type { StyleApplyReport } from "./apply";

/**
 * The EDITING STYLE picker (design/edit-artboard.png). Picking a style APPLIES it to the open project through ops@1
 * (./apply.ts → @restorffcut/timeline-ops `apply_style restorff/style/<id>`): captions, pacing, joins, grade and the
 * style's compositions. The list itself lives in packages/timeline-ops/src/styles.ts so the gateway (Claude) and the
 * editor share one definition.
 *
 * Remembered here per project in this browser (localStorage "restorffcut-editing-style"): which style was applied
 * last and what it reported. Open issue: this should move into the project document / commits.
 */
export interface EditingStyle {
	id: string;
	label: string;
	hint: string;
}

export const EDITING_STYLES: EditingStyle[] = EDITING_STYLE_PRESETS.map((preset) => ({
	id: preset.id,
	label: preset.label,
	hint: preset.hint,
}));

export const DEFAULT_EDITING_STYLE_ID = EDITING_STYLES[0].id;

interface EditingStyleState {
	styleByProject: Record<string, string>;
	reportByProject: Record<string, StyleApplyReport>;
	setStyle: (args: { projectId: string; styleId: string }) => void;
	setReport: (args: { projectId: string; report: StyleApplyReport }) => void;
}

export const useEditingStyleStore = create<EditingStyleState>()(
	persist(
		(set) => ({
			styleByProject: {},
			reportByProject: {},
			setStyle: ({ projectId, styleId }) =>
				set((state) => ({
					styleByProject: { ...state.styleByProject, [projectId]: styleId },
				})),
			setReport: ({ projectId, report }) =>
				set((state) => ({
					reportByProject: { ...state.reportByProject, [projectId]: report },
				})),
		}),
		{
			name: "restorffcut-editing-style",
			version: 2,
			migrate: (persisted) => {
				const old = (persisted ?? {}) as Partial<EditingStyleState>;
				return { styleByProject: old.styleByProject ?? {}, reportByProject: {} } as EditingStyleState;
			},
		},
	),
);

export function getEditingStyle({ id }: { id: string | undefined }): EditingStyle {
	return EDITING_STYLES.find((style) => style.id === id) ?? EDITING_STYLES[0];
}
