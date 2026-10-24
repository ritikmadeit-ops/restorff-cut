/**
 * Build the explainer (EDT-21) in the open project as ONE undo step:
 *   1. explainerPlan(card, answers, picked media) → ops@1 with composition placeholders (@restorffcut/styles)
 *   2. render each collage composition at the target canvas (server route /api/compositions/render, cached), import
 *      it (processMediaAssets → AddMediaAssetCommand, same path as the Effects tab)
 *   3. bindCompositions → real media ids; a render that failed is dropped and reported
 *   4. reducer → BatchCommand([imports…, canvas settings?, TracksSnapshotCommand])  (editor-bridge.ts runOps)
 */
import {
	bindCompositions,
	describePlan,
	explainerPlan,
	type BoundComposition,
	type ExplainerAnswers,
	type ExplainerAsset,
	type ExplainerBeat,
	type StyleCard,
} from "@restorffcut/styles";
import { AddMediaAssetCommand } from "@/commands/media";
import { fetchCatalogue, fetchRenderFile, renderComposition } from "@/compositions/api";
import type { CompositionSource } from "@/compositions/types";
import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { mainTrackEnd, opsSnapshot, PENDING_WORDS, runOps } from "../editor-bridge";

export interface ExplainerBuildReport {
	beats: ExplainerBeat[];
	duration: number;
	start: number;
	applied: number;
	committed: boolean;
	skipped: string[];
	pending: string[];
	missing: string[];
	notes: string[];
	effects: string[];
	/** Compositions that did not render (dropped from the build). */
	failed: string[];
	/** Plain-words change note for this version (paste into the commit / version list). */
	changeNote: string;
}

/** The project's media the person can pick as footage (images and videos). */
export function pickableMedia(editor: EditorCore): ExplainerAsset[] {
	return editor.media
		.getAssets()
		.filter((asset) => (asset.type === "video" || asset.type === "image") && !asset.ephemeral)
		.map((asset) => ({
			id: asset.id,
			kind: asset.type as "video" | "image",
			name: asset.name,
			...(asset.duration ? { duration: asset.duration } : {}),
			...(asset.width ? { width: asset.width } : {}),
			...(asset.height ? { height: asset.height } : {}),
		}));
}

export async function buildExplainer({
	editor,
	card,
	answers,
	assetIds,
	onStep,
}: {
	editor: EditorCore;
	card: StyleCard;
	answers: ExplainerAnswers;
	assetIds: string[];
	onStep?: (step: string) => void;
}): Promise<ExplainerBuildReport> {
	const project = editor.project.getActive();
	const picked = new Set(assetIds);
	const assets = pickableMedia(editor).filter((asset) => picked.has(asset.id));
	let available: string[] | undefined;
	try {
		available = (await fetchCatalogue()).map((entry) => entry.name);
	} catch {
		available = undefined; // the plan assumes the starter library; failed renders are dropped below
	}
	const start = mainTrackEnd(editor);
	const plan = explainerPlan(card, answers, assets, { start, canvas: project.settings.canvasSize, available });
	const target = plan.canvas ?? project.settings.canvasSize;
	const fps = Math.max(1, Math.min(120, Math.round(project.settings.fps.numerator / project.settings.fps.denominator)));

	const imports: AddMediaAssetCommand[] = [];
	const sources = new Map<string, CompositionSource>();
	const bound: Record<string, BoundComposition | null> = {};
	const failed: string[] = [];
	for (const request of plan.compositions) {
		onStep?.(`rendering ${request.title} (${request.beat + 1}/${plan.beats.length})…`);
		try {
			const answer = await renderComposition({ name: request.name, props: request.props, width: target.width, height: target.height, fps, duration: request.dur });
			const file = await fetchRenderFile({ answer, title: request.title });
			const [asset] = await processMediaAssets({ files: [file] });
			if (!asset) throw new Error("the editor could not import the render");
			const add = new AddMediaAssetCommand({ projectId: project.metadata.id, asset });
			imports.push(add);
			bound[request.key] = { media: add.getAssetId(), dur: answer.duration };
			sources.set(add.getAssetId(), {
				name: request.name,
				props: request.props,
				hash: answer.hash,
				width: answer.width,
				height: answer.height,
				fps: answer.fps,
				duration: answer.duration,
			});
		} catch (error) {
			bound[request.key] = null;
			failed.push(`${request.title}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	onStep?.("placing the beats…");
	const { ops } = bindCompositions(plan, bound);
	const run = runOps({
		editor,
		ops,
		seed: `${project.metadata.id}/explainer/${Date.now()}`,
		extra: imports,
		sources,
		snapshot: opsSnapshot(editor),
	});
	return {
		beats: plan.beats,
		duration: plan.duration,
		start,
		applied: run.applied,
		committed: run.committed,
		skipped: run.skipped,
		pending: run.pending.map((kind) => PENDING_WORDS[kind] ?? `${kind} recorded`),
		missing: plan.report.missing,
		notes: plan.report.notes,
		effects: plan.report.effects,
		failed,
		changeNote: describePlan(plan),
	};
}
