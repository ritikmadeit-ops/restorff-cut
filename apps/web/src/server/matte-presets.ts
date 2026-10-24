/**
 * Server side of MCP `cutout apply` (mcp-cutout agent, 2026-10-20): the cutout agent's four matte presets, built on a
 * commit's snapshot as ops@1 (so the commit records what was done) plus the few edits ops@1 cannot express (the
 * cutout's copy of the plate's transform/retime, masks, the blur effect, `restorff.cutout`).
 *
 * Same layers, order and maths as the editor's Person tools: the layout numbers come from `@/cutout/preset-layout`
 * (moved out of cutout/presets.ts for this). Layer order (EFFECTS.md "Layers", bottom → top):
 *   text_behind_person  plate · BEHIND TEXT · V2 CUTOUT
 *   green_screen        plate (blurred) · V2 CUTOUT      or   plate · BACKGROUND (colour) · V2 CUTOUT
 *   cover_story         plate · COVER FRAME · COVER MASTHEAD · V2 CUTOUT · COVER LINES · COVER DATELINE
 *   frame_break         plate (masked to a framed inset, scale keys) · V2 CUTOUT (same scale keys) → the person
 *                       breaks out over the frame
 * The cutout is the person-only WebM of the clip's media (server/matte.ts), placed on its own track directly above
 * the clip with the clip's start, length, trims, retime, transform and keyframes, source audio off.
 */
import type { Op } from "@restorffcut/timeline-ops";
import {
	backgroundRectParams,
	coverStoryLayout,
	fadeScaleInKeys,
	frameBreakLayout,
	headOnCanvas,
	textBehindLayout,
	type TextLayer,
} from "@/cutout/preset-layout";
import type { Box } from "@/segmentation/types";
import type { ProjectSnapshot, SnapshotElement, SnapshotScene, SnapshotTrack } from "@/sync/snapshot";
import type { FaceTrack, MatteJob } from "./matte";

export const TICKS = 120_000;
const toSeconds = (ticks: number) => ticks / TICKS;
const s3 = (seconds: number) => Math.round(seconds * 1000) / 1000;

export type PresetId = "text_behind_person" | "green_screen" | "cover_story" | "frame_break";

export const PRESETS: Record<PresetId, { fx: string; name: string; description: string }> = {
	text_behind_person: { fx: "FX-43", name: "Text behind person", description: "A big headline between the background and the speaker (the head covers its lower part)." },
	green_screen: { fx: "FX-12", name: "Green screen", description: "Replace the background with a colour, or blur it, without a green screen." },
	cover_story: { fx: "FX-16", name: "Cover story", description: "Magazine masthead behind the head, inset frame, dateline and cover lines in front." },
	frame_break: { fx: "FX-04", name: "Frame break", description: "The shot shrinks into a framed inset and the speaker breaks out over its edge." },
};

export const CUTOUT_TRACK_NAME = "V2 CUTOUT";

export interface PresetOptions {
	text?: string;
	font?: string;
	color?: string;
	/** green_screen: "#rrggbb", "blur" or "blur:<0..100>". */
	background?: string;
	lines?: string[];
	dateline?: string;
}

export interface Located {
	element: SnapshotElement;
	track: SnapshotTrack;
	group: "overlay" | "main" | "audio";
	/** Index in its group (overlay: 0 = top). */
	index: number;
}

/** Stored on the cutout as element.restorff.cutout (same shape as the editor's CutoutSource + where it came from). */
export interface ServerCutoutSource {
	sourceElementId: string;
	sourceMediaId: string;
	model: "multiclass";
	start: number;
	end: number;
	fps: number;
	person: Box | null;
	head: Box | null;
	face: Box | null;
	createdAt: string;
	server: { job_id: string; media_hash: string; faces: "restorffcut-faces@1" };
}

// ─── snapshot helpers ─────────────────────────────────────────────────────────────────────────────────────────

export function activeScene(snapshot: ProjectSnapshot): SnapshotScene | null {
	const scenes = snapshot.scenes ?? [];
	return scenes.find((scene) => scene.id === snapshot.currentSceneId) ?? scenes.find((scene) => scene.isMain) ?? scenes[0] ?? null;
}

export function locate(scene: SnapshotScene | null, elementId: string): Located | null {
	const tracks = scene?.tracks;
	if (!tracks) return null;
	const overlay = tracks.overlay ?? [];
	for (let index = 0; index < overlay.length; index++) {
		const element = (overlay[index].elements ?? []).find((candidate) => candidate.id === elementId);
		if (element) return { element, track: overlay[index], group: "overlay", index };
	}
	const mainElement = tracks.main?.elements?.find((candidate) => candidate.id === elementId);
	if (tracks.main && mainElement) return { element: mainElement, track: tracks.main, group: "main", index: 0 };
	const audio = tracks.audio ?? [];
	for (let index = 0; index < audio.length; index++) {
		const element = (audio[index].elements ?? []).find((candidate) => candidate.id === elementId);
		if (element) return { element, track: audio[index], group: "audio", index };
	}
	return null;
}

export function cutoutSourceOf(element: SnapshotElement | null | undefined): ServerCutoutSource | null {
	const restorff = element?.restorff as { cutout?: ServerCutoutSource } | undefined;
	return restorff?.cutout ?? null;
}

/** The cutout made from a clip, if one is on the scene. */
export function findCutoutOf(scene: SnapshotScene | null, plateId: string): Located | null {
	const overlay = scene?.tracks?.overlay ?? [];
	for (let index = 0; index < overlay.length; index++) {
		for (const element of overlay[index].elements ?? []) {
			if (cutoutSourceOf(element)?.sourceElementId === plateId) return { element, track: overlay[index], group: "overlay", index };
		}
	}
	return null;
}

export function canvasOf(snapshot: ProjectSnapshot): { width: number; height: number; fps: number } {
	const size = snapshot.settings?.canvasSize;
	const fps = snapshot.settings?.fps;
	const rate = typeof fps === "number" ? fps : fps ? fps.numerator / fps.denominator : 30;
	return { width: size?.width ?? 1080, height: size?.height ?? 1920, fps: rate > 0 ? rate : 30 };
}

export function num(params: Record<string, unknown> | undefined, key: string, fallback: number): number {
	const raw = params?.[key];
	const value = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

export function rateOf(element: SnapshotElement): number {
	const retime = element.retime as { rate?: number } | undefined;
	return retime?.rate && retime.rate > 0 ? retime.rate : 1;
}

/** Where a media element is drawn (renderer rule: contain-fit, then scale, then offset from the centre). */
export function drawnRect(element: SnapshotElement, media: { width: number; height: number }, canvas: { width: number; height: number }) {
	const sourceWidth = media.width || canvas.width;
	const sourceHeight = media.height || canvas.height;
	const contain = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
	const width = Math.abs(sourceWidth * contain * num(element.params, "transform.scaleX", 1));
	const height = Math.abs(sourceHeight * contain * num(element.params, "transform.scaleY", 1));
	const centerX = canvas.width / 2 + num(element.params, "transform.positionX", 0);
	const centerY = canvas.height / 2 + num(element.params, "transform.positionY", 0);
	return { left: centerX - width / 2, top: centerY - height / 2, width, height };
}

const uuid = () => globalThis.crypto.randomUUID();

// ─── the plan ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface PresetPlan {
	ops: Op[];
	/** Snapshot edits after the reducer ran (refs = result.changes.refs). */
	finish: (snapshot: ProjectSnapshot, refs: Record<string, string>) => void;
	/** What will be added, for the answer. */
	layers: string[];
	notes: string[];
	createsCutout: boolean;
	message: string;
}

function textOps(layer: TextLayer, track: string, ref: string, name: string, start: number, duration: number): Op[] {
	const ops: Record<string, unknown>[] = [
		{ op: "insert", author: "claude", track, t: s3(start), text: layer.content, dur: s3(duration), name, params: layer.params, ref },
	];
	const keys = fadeScaleInKeys(layer.animation);
	for (const [prop, list] of Object.entries(keys)) {
		for (const key of list) {
			if (key.time > duration) continue;
			ops.push({ op: "keyframe", author: "claude", el: ref, prop, t: s3(key.time), value: key.value, local: true });
		}
	}
	return ops as unknown as Op[];
}

/**
 * Builds the ops + edits for one preset on the clip `plate` (a video clip; its cutout is made in the same batch
 * unless one exists). `matte` is the finished job of the clip's media; `faces` its face track.
 */
export function planPreset({
	snapshot,
	plate,
	cutout,
	preset,
	options,
	matte,
	faces,
}: {
	snapshot: ProjectSnapshot;
	plate: Located;
	cutout: Located | null;
	preset: PresetId;
	options: PresetOptions;
	matte: MatteJob;
	faces: FaceTrack | null;
}): PresetPlan {
	const scene = activeScene(snapshot);
	const canvas = canvasOf(snapshot);
	const plateEl = plate.element;
	const startS = toSeconds(plateEl.startTime);
	const durS = toSeconds(plateEl.duration);
	const webm = matte.outputs?.person_webm;
	const range = matte.range ?? { start: 0, end: webm?.duration ?? 0 };
	if (!webm) throw new Error("the matte job has no person video");
	const source = matte.source ?? faces?.source ?? { width: webm.width, height: webm.height, duration: webm.duration, fps: webm.fps };

	// Where the clip's frames are in the person video (its timebase starts at range.start).
	const rate = rateOf(plateEl);
	const inS = toSeconds(plateEl.trimStart ?? 0) - range.start;
	const usedS = durS * rate;
	if (inS < -1e-3 || inS + usedS > webm.duration + 0.05) {
		throw new Error(
			`the matte covers source ${range.start.toFixed(2)}–${range.end.toFixed(2)} s but the clip uses ${(inS + range.start).toFixed(2)}–${(inS + range.start + usedS).toFixed(2)} s; run cutout matte with this clip's element_id first`,
		);
	}
	const ops: Record<string, unknown>[] = [];
	const layers: string[] = [];
	const notes: string[] = [];
	const overlayCount = scene?.tracks?.overlay?.length ?? 0;
	let cutoutIndex: number;
	let cutoutRef: string;
	const createsCutout = !cutout;
	if (cutout) {
		cutoutIndex = cutout.index;
		cutoutRef = cutout.element.id;
		layers.push(`${CUTOUT_TRACK_NAME}: reused ${cutout.element.id}`);
	} else {
		cutoutIndex = plate.group === "overlay" ? plate.index : overlayCount;
		cutoutRef = "cutout_clip";
		const name = `${plateEl.name || "clip"} · cutout`;
		ops.push(
			{ op: "import_media", author: "claude", kind: "video", name, url: `matte:${matte.media_hash}/${matte.variant}/person.webm`, duration: webm.duration, width: webm.width, height: webm.height, fps: webm.fps, has_audio: false, ref: "cutout_media" },
			{ op: "add_track", author: "claude", kind: "video", name: CUTOUT_TRACK_NAME, index: cutoutIndex, ref: "cutout_track" },
			{ op: "set", author: "claude", track: "cutout_track", prop: "muted", value: true },
			{ op: "insert", author: "claude", track: "cutout_track", t: s3(startS), media: "cutout_media", in: s3(Math.max(0, inS)), out: s3(Math.min(webm.duration, Math.max(0, inS) + usedS)), name, ref: "cutout_clip" },
		);
		layers.push(`${CUTOUT_TRACK_NAME}: the person (transparent video) above the clip`);
	}
	const behind = () => cutoutIndex + 1;

	// The head on the canvas, from the plate's drawn rect and the matte's median boxes.
	const rect = drawnRect(plateEl, { width: source.width, height: source.height }, canvas);
	const head = headOnCanvas({ rect, head: faces?.summary.head ?? null, person: faces?.summary.person ?? null, canvas });
	let message = "";

	switch (preset) {
		case "text_behind_person": {
			const layer = textBehindLayout({ text: options.text ?? "", fontFamily: options.font, color: options.color, canvas, head });
			ops.push({ op: "add_track", author: "claude", kind: "text", name: "BEHIND TEXT", index: behind(), ref: "behind_track" });
			ops.push(...(textOps(layer, "behind_track", "behind_text", `Behind · ${layer.content}`, startS, durS) as unknown as Record<string, unknown>[]));
			layers.push(`BEHIND TEXT: "${layer.content}" ${layer.params.fontFamily} size ${Math.round(Number(layer.params.fontSize))}, centred ${Math.round(head.top)} px from the top (head top), between the clip and the person`);
			message = `cutout: text behind person "${layer.content}"`;
			break;
		}
		case "green_screen": {
			const bg = (options.background ?? "blur:40").trim();
			const blur = /^blur(?::(\d{1,3}))?$/i.exec(bg);
			if (blur) {
				const intensity = Math.max(0, Math.min(100, blur[1] ? Number(blur[1]) : 40));
				notes.push("The blur is an effect on the clip (no op@1 for effects): written into the snapshot.");
				layers.push(`plate: blur ${intensity} (the person stays sharp on ${CUTOUT_TRACK_NAME})`);
				message = `cutout: green screen (blur ${intensity})`;
				const finishBlur = (snap: ProjectSnapshot) => {
					const found = locate(activeScene(snap), plateEl.id);
					if (!found) return;
					const effects = ((found.element.effects as Array<{ type?: string }> | undefined) ?? []).filter((effect) => effect.type !== "blur");
					found.element.effects = [...effects, { id: uuid(), type: "blur", params: { intensity }, enabled: true }];
				};
				return finalize({ ops, layers, notes, createsCutout, message, extra: finishBlur });
			}
			if (!/^#[0-9a-f]{3,8}$/i.test(bg)) throw new Error(`background must be a #hex colour, "blur" or "blur:<0..100>" (got ${bg})`);
			ops.push({ op: "add_track", author: "claude", kind: "overlay", name: "BACKGROUND", index: behind(), ref: "bg_track" });
			ops.push({ op: "insert", author: "claude", track: "bg_track", t: s3(startS), shape: "rectangle", dur: s3(durS), name: "Background", params: backgroundRectParams({ canvas, color: bg }), ref: "bg_rect" });
			layers.push(`BACKGROUND: ${bg} full-canvas rectangle between the clip and the person`);
			message = `cutout: green screen (${bg})`;
			break;
		}
		case "cover_story": {
			const layout = coverStoryLayout({ masthead: options.text ?? "", dateline: options.dateline, lines: options.lines, color: options.color, canvas, head });
			// Behind: frame (lowest), then the masthead above it — both below the person.
			ops.push({ op: "add_track", author: "claude", kind: "overlay", name: "COVER FRAME", index: behind(), ref: "cover_frame_track" });
			ops.push({ op: "insert", author: "claude", track: "cover_frame_track", t: s3(startS), shape: "rectangle", dur: s3(durS), name: "Cover frame", params: layout.frame, ref: "cover_frame" });
			ops.push({ op: "add_track", author: "claude", kind: "text", name: "COVER MASTHEAD", index: behind(), ref: "cover_masthead_track" });
			ops.push(...(textOps(layout.masthead, "cover_masthead_track", "cover_masthead", `Masthead · ${layout.masthead.content}`, startS, durS) as unknown as Record<string, unknown>[]));
			// In front: cover lines, then the dateline on top (each new track goes above the person).
			if (layout.lines) {
				ops.push({ op: "add_track", author: "claude", kind: "text", name: "COVER LINES", index: cutoutIndex, ref: "cover_lines_track" });
				ops.push(...(textOps(layout.lines, "cover_lines_track", "cover_lines", "Cover lines", startS, durS) as unknown as Record<string, unknown>[]));
			}
			ops.push({ op: "add_track", author: "claude", kind: "text", name: "COVER DATELINE", index: cutoutIndex, ref: "cover_dateline_track" });
			ops.push(...(textOps(layout.dateline, "cover_dateline_track", "cover_dateline", "Dateline", startS, durS) as unknown as Record<string, unknown>[]));
			layers.push(`COVER FRAME + COVER MASTHEAD "${layout.masthead.content}" behind the person; COVER LINES + COVER DATELINE in front`);
			message = `cutout: cover story "${layout.masthead.content}"`;
			break;
		}
		case "frame_break": {
			const layout = frameBreakLayout({ borderColor: options.color });
			const baseX = num(plateEl.params, "transform.scaleX", 1);
			const baseY = num(plateEl.params, "transform.scaleY", 1);
			const shrink = Math.min(layout.shrinkSeconds, durS);
			for (const el of [plateEl.id, cutoutRef]) {
				for (const [prop, base] of [["transform.scaleX", baseX], ["transform.scaleY", baseY]] as const) {
					ops.push({ op: "keyframe", author: "claude", el, prop, t: 0, value: base, local: true });
					ops.push({ op: "keyframe", author: "claude", el, prop, t: s3(shrink), value: Math.round(base * layout.scale * 100) / 100, local: true });
				}
			}
			notes.push("The frame is a rectangle mask with an outline on the clip (masks have no op@1): written into the snapshot.");
			layers.push(`plate: shrinks to ${layout.scale} in ${shrink} s inside a ${layout.mask.strokeWidth} px framed mask; the person (same keys) breaks out over the frame`);
			message = "cutout: frame break";
			const finishMask = (snap: ProjectSnapshot) => {
				const found = locate(activeScene(snap), plateEl.id);
				if (found) found.element.masks = [{ id: uuid(), type: "rectangle", params: { ...layout.mask } }];
			};
			return finalize({ ops, layers, notes, createsCutout, message, extra: finishMask });
		}
	}
	return finalize({ ops, layers, notes, createsCutout, message });

	function finalize({
		ops: list,
		layers: layerList,
		notes: noteList,
		createsCutout: creates,
		message: text,
		extra,
	}: {
		ops: Record<string, unknown>[];
		layers: string[];
		notes: string[];
		createsCutout: boolean;
		message: string;
		extra?: (snap: ProjectSnapshot) => void;
	}): PresetPlan {
		return {
			ops: list as unknown as Op[],
			layers: layerList,
			notes: noteList,
			createsCutout: creates,
			message: text,
			finish: (snap, refs) => {
				if (creates) {
					const cutoutId = refs.cutout_clip;
					const sceneAfter = activeScene(snap);
					const made = cutoutId ? locate(sceneAfter, cutoutId) : null;
					const plateAfter = locate(sceneAfter, plateEl.id);
					if (!made || !plateAfter) throw new Error("the cutout was not found after placing it (internal)");
					const p = plateAfter.element;
					const webmTicks = Math.round((webm?.duration ?? 0) * TICKS);
					const used = Math.round(p.duration * rate);
					const trimStart = Math.max(0, Math.round((p.trimStart ?? 0) - range.start * TICKS));
					Object.assign(made.element, {
						startTime: p.startTime,
						duration: p.duration,
						trimStart,
						trimEnd: Math.max(0, webmTicks - trimStart - used),
						sourceDuration: webmTicks,
						params: structuredClone(p.params ?? {}),
						animations: p.animations ? structuredClone(p.animations) : undefined,
						effects: Array.isArray(p.effects) ? structuredClone((p.effects as Array<{ type?: string }>).filter((effect) => effect.type !== "blur")) : undefined,
						retime: p.retime ? structuredClone(p.retime) : undefined,
						isSourceAudioEnabled: false,
						hidden: false,
					});
					const restorff = (made.element.restorff ?? {}) as Record<string, unknown>;
					const cutoutSource: ServerCutoutSource = {
						sourceElementId: p.id,
						sourceMediaId: String(p.mediaId ?? ""),
						model: "multiclass",
						// The clip's span in SOURCE seconds (like the editor's CutoutSource).
						start: toSeconds(p.trimStart ?? 0),
						end: toSeconds(p.trimStart ?? 0) + usedS,
						fps: webm?.fps ?? 0,
						person: faces?.summary.person ?? null,
						head: faces?.summary.head ?? null,
						face: faces?.summary.face ?? null,
						createdAt: new Date().toISOString(),
						server: { job_id: matte.job_id, media_hash: matte.media_hash, faces: "restorffcut-faces@1" },
					};
					made.element.restorff = { ...restorff, cutout: cutoutSource } as SnapshotElement["restorff"];
				}
				extra?.(snap);
			},
		};
	}
}
