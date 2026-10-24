/**
 * Apply a SAVED style (EDT-20) to the open project as one undo step: @restorffcut/styles planStyle → ops@1 → the
 * reducer → the editor. A built-in editing style inside the saved style (`apply_style restorff/style/<id>`) gets its
 * compositions rendered and imported first, like the EDITING STYLE picker does (editing-style/apply.ts).
 */
import { planStyle, type SavedStyle } from "@restorffcut/styles";
import { getEditingStylePreset, type Op, type StyleCompositionMedia } from "@restorffcut/timeline-ops";
import { createCanvasMeasure } from "@/captions/build";
import { AddMediaAssetCommand } from "@/commands/media";
import { renderAndProcess } from "@/compositions/drop";
import type { CompositionSource } from "@/compositions/types";
import type { EditorCore } from "@/core";
import { opsSnapshot, PENDING_WORDS, runOps } from "./editor-bridge";

export interface SavedApplyReport {
	title: string;
	version: string;
	applied: number;
	committed: boolean;
	skipped: string[];
	pending: string[];
	notes: string[];
	/** Parts of the style nobody here understood: the person's Claude can do them. */
	unresolved: string[];
	compositions: string[];
}

export async function applySavedStyle({
	editor,
	style,
	params,
	onStep,
}: {
	editor: EditorCore;
	style: SavedStyle;
	params?: Record<string, unknown>;
	onStep?: (step: string) => void;
}): Promise<SavedApplyReport> {
	const project = editor.project.getActive();
	const snapshot = opsSnapshot(editor);
	// ui-fix-panels (QA #8): caption sizes are ratios of this project's captions, capped inside the safe area with the
	// renderer's own text measuring (planStyle also migrates a legacy absolute size, or skips it when flagged)
	const measure = createCanvasMeasure(project.settings.canvasSize.height);
	const plan = planStyle(style, snapshot.project, { params, measure });

	const imports: AddMediaAssetCommand[] = [];
	const sources = new Map<string, CompositionSource>();
	const titles: string[] = [];
	const ops: Op[] = [];
	for (const op of plan.ops) {
		const preset = op.op === "apply_style" ? getEditingStylePreset(op.preset_id) : undefined;
		if (op.op !== "apply_style" || !preset?.compositions.length) {
			ops.push(op);
			continue;
		}
		const media: StyleCompositionMedia[] = [];
		for (const item of preset.compositions) {
			onStep?.(`rendering ${item.name}…`);
			const imported = await renderAndProcess({ editor, name: item.name, props: item.props });
			const add = new AddMediaAssetCommand({ projectId: project.metadata.id, asset: imported.asset });
			imports.push(add);
			sources.set(add.getAssetId(), imported.source);
			titles.push(imported.title);
			media.push({ name: item.name, media: add.getAssetId(), t: item.at, dur: imported.answer.duration, title: imported.title });
		}
		ops.push({ ...op, params: { ...(op.params ?? {}), compositions: media } });
	}

	onStep?.("applying…");
	const run = ops.length
		? runOps({ editor, ops, seed: `${project.metadata.id}/saved-style/${style.id}@${style.version}/${Date.now()}`, extra: imports, sources, snapshot })
		: null;
	return {
		title: style.title,
		version: style.version,
		applied: run?.applied ?? 0,
		committed: run?.committed ?? false,
		skipped: run?.skipped ?? [],
		pending: (run?.pending ?? []).map((kind) => PENDING_WORDS[kind] ?? `${kind} recorded`),
		notes: plan.notes,
		unresolved: plan.unresolved,
		compositions: titles,
	};
}
