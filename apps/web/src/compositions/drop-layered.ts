/**
 * The editor's drop of a PERSON effect (effects-layers agent, 2026-10-20): when a composition's manifest recipe puts
 * layers around the speaker (`effect.stack` with "cutout": Orbit, Couch Wall, Frame Break, Green Screen, Paper Cut,
 * Cover Story, Headline Wall, Glass Type, Vertigo…) and the clip under the playhead has a person cutout (Person tools →
 * Cut out person), the drop renders one file per layer and places them like MCP `effects apply` does, bottom → top:
 *
 *   the clip → `self:back` render (MOTION BACK) → the person cutout → `self:front` render (MOTION FRONT)
 *
 * Same planner as the server (`@/server/effects-layers-plan`, pure). The face box of the cutout (its median head and
 * face) fills props.face / mastheadOffset / window like the server does. Not done here (MCP apply does them): plate
 * keys on the clip (frame-break, ui-world, pullback), matte frames (paper-cut edge, green-screen light wrap, doodle
 * outline), clip stills (glass-type, vertigo). Without a cutout the caller drops one overlay as before.
 * One undo step. Runbook: docs/restorff/worklog/effects-layers.md.
 */
import type { EditorCore } from "@/core";
import { BatchCommand, type Command } from "@/commands";
import { AddMediaAssetCommand } from "@/commands/media";
import { AddTrackCommand, InsertElementCommand } from "@/commands/timeline";
import { elementRect, findCutoutFor, getCutoutSource } from "@/cutout/timeline-utils";
import {
	boxOnCanvas,
	faceProp,
	frameBreakWindow,
	layerPlan,
	mastheadOffsetFor,
	readRecipe,
} from "@/server/effects-layers-plan";
import type { TimelineElement, TimelineTrack } from "@/timeline";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import { getCompositionSource, projectCanvas, renderAndProcess, withCompositionSource } from "./drop";
import type { CompositionEntry, ParamValues, RenderAnswer } from "./types";

const BACK = "MOTION BACK";
const FRONT = "MOTION FRONT";

/** The footage clip under `time` (main first, then overlay video tracks that are not MOTION, cutouts or compositions). */
function clipUnder({ editor, time }: { editor: EditorCore; time: number }): TimelineElement | null {
	const tracks = editor.scenes.getActiveScene().tracks;
	const footage = [tracks.main, ...tracks.overlay.filter((track) => track.type === "video" && !track.name.toUpperCase().startsWith("MOTION"))] as TimelineTrack[];
	for (const track of footage) {
		const hit = (track.elements as TimelineElement[]).find(
			(element) =>
				element.type === "video" &&
				!getCutoutSource(element) &&
				!getCompositionSource({ element }) &&
				element.startTime <= time &&
				time < element.startTime + element.duration,
		);
		if (hit) return hit;
	}
	return null;
}

export type LayeredDrop =
	| { placed: true; answer: RenderAnswer; layers: string[] }
	| { placed: false; why: string };

/**
 * Drop a person effect in layers around the clip's cutout. Answers placed: false (and changes nothing) when the
 * composition has no person recipe, there is no video clip under the playhead, or that clip has no cutout yet.
 */
export async function dropLayeredComposition({
	editor,
	entry,
	props,
	at,
}: {
	editor: EditorCore;
	entry: CompositionEntry;
	props: ParamValues;
	at?: number;
}): Promise<LayeredDrop> {
	const recipe = readRecipe(entry);
	const plan = recipe ? layerPlan(recipe) : null;
	if (!recipe || !plan?.usesCutout || props.layer === "all") return { placed: false, why: "no person recipe" };
	const startTime = at !== undefined ? mediaTimeFromSeconds({ seconds: at }) : editor.playback.getCurrentTime();
	const clip = clipUnder({ editor, time: startTime });
	if (!clip) return { placed: false, why: "no video clip under the playhead" };
	const cutout = findCutoutFor({ tracks: editor.scenes.getActiveScene().tracks, sourceElementId: clip.id });
	if (!cutout) return { placed: false, why: "the clip under the playhead has no person cutout yet (Person tools → Cut out person)" };

	// the face box the cutout found (median over the clip) fills what the recipe's face input names
	const canvas = projectCanvas({ editor });
	const source = getCutoutSource(cutout.element);
	const asset = editor.media.getAssets().find((candidate) => candidate.id === (clip as { mediaId?: string }).mediaId) ?? null;
	const rect = elementRect({ element: clip, asset, canvas });
	const face = source?.face ? boxOnCanvas(source.face, rect, canvas) : null;
	const head = source?.head ? boxOnCanvas(source.head, rect, canvas) : null;
	const filled: ParamValues = {};
	// the dialog starts from the example props (the stand-in's face box): a value equal to the example is not the user's
	const userSet = (key: string) => key in props && JSON.stringify(props[key]) !== JSON.stringify(entry.example[key]);
	if (recipe.inputs.face && face) {
		if (entry.params.face?.type === "object" && !userSet("face")) filled.face = faceProp(face);
		if ("mastheadOffset" in entry.params && !userSet("mastheadOffset") && head) {
			filled.mastheadOffset = mastheadOffsetFor({ headTop: head.top, canvas, wordmark: String(props.wordmark ?? entry.example.wordmark ?? ""), frameInset: Number(props.frameInset ?? 32) });
		}
		if (entry.params.window?.type === "object" && !userSet("window") && head) {
			const current = (props.window ?? entry.params.window.default ?? {}) as { w?: number; h?: number };
			filled.window = frameBreakWindow({ head, plateScale: Number(props.plateScale ?? 0.82), plateY: Number(props.plateY ?? 0), width: current.w ?? 0.6, height: current.h ?? 0.42 });
		}
	}
	// filled only holds keys the user did not change, so it goes last
	const base = { ...(recipe.props ?? {}), ...props, ...filled };
	const hasLayer = "layer" in entry.params;
	const imported = await Promise.all(
		plan.renders.map((render) => renderAndProcess({ editor, name: entry.name, props: render.layer && hasLayer ? { ...base, layer: render.layer } : base })),
	);

	// placement: every command in one batch, each reading the tracks as the previous one left them
	const project = editor.project.getActive();
	const tracksNow = editor.scenes.getActiveScene().tracks;
	const cutoutIndex = cutout.location.kind === "overlay" ? cutout.location.index : tracksNow.overlay.length;
	const commands: Command[] = [];
	const layers: string[] = [];
	imported.forEach((item, i) => {
		const render = plan.renders[i];
		const duration = mediaTimeFromSeconds({ seconds: item.answer.duration });
		const below = render.side === "below_cutout";
		const neighbour = below ? tracksNow.overlay[cutoutIndex + 1] : tracksNow.overlay[cutoutIndex - 1];
		const prefix = below ? BACK : FRONT;
		const reuse =
			neighbour &&
			neighbour.type === "video" &&
			neighbour.name.toUpperCase().startsWith(prefix) &&
			!(neighbour.elements as TimelineElement[]).some((element) => startTime < element.startTime + element.duration && startTime + duration > element.startTime);
		let trackId: string;
		if (reuse) trackId = neighbour.id;
		else {
			const add = new AddTrackCommand({ type: "video", index: below ? cutoutIndex + 1 : cutoutIndex, name: prefix });
			commands.push(add);
			trackId = add.getTrackId();
		}
		const addMedia = new AddMediaAssetCommand({ projectId: project.metadata.id, asset: item.asset });
		commands.push(addMedia);
		const element = withCompositionSource({
			element: buildElementFromMedia({
				mediaId: addMedia.getAssetId(),
				mediaType: "video",
				name: `${entry.title}${render.layer ? ` · ${render.layer}` : ""}`,
				duration,
				startTime,
			}) as TimelineElement,
			source: item.source,
		});
		commands.push(new InsertElementCommand({ element, placement: { mode: "explicit", trackId } }));
		layers.push(`${prefix}: ${render.entry}`);
	});
	editor.command.execute({ command: new BatchCommand(commands) });
	return { placed: true, answer: imported[0].answer, layers };
}
