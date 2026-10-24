/**
 * `look {kind: "clip", timeline_id, element_id, times?}` (effects-v2 agent, 2026-10-20; SUMMARY gap 12a): see ONE
 * scene without rendering the timeline. Frames come straight from the files already on disk — the composition's own
 * render (packages/compositions cache, by hash), the clip's media, the person cutout's person.webm — composited bottom
 * → top in FFmpeg (server/renders-look.ts compositeStill). For an applied effect (any of its elements) the scene is
 * the clip it sits on + every layer of the effect + its person cutout; for a composition, the clip under it + it; for
 * a clip, the clip with the effect layers over it at that time.
 *
 * Not drawn (render + look for the real frame): FX shader layers (Digital Zoom, Vertigo shader…), grades, masks,
 * captions and text elements, transitions. Clip keyframes are followed linearly (eases approximated).
 */
import { CACHE_DIR, CUSTOM_CACHE_DIR } from "@/app/api/compositions/_lib/service";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSnapshot, SnapshotElement, SnapshotTrack } from "@/sync/snapshot";
import { findEffect as findApplied } from "./effects-instances";
import { placeOnCanvas } from "./effects-layers";
import { getMatteJob, matteOutputFiles, projectMediaRecord } from "./matte";
import { footageClipOver } from "./matte-face-span";
import { activeScene, canvasOf, type Located, locate, rateOf, TICKS } from "./matte-presets";
import { getProjectHead } from "./projects";
import { compositeStill, type StillLayer } from "./renders-look";

type Next = { do: string; tool: string; arguments?: Record<string, unknown> };

export interface LookClipAnswer {
	payload: Record<string, unknown>;
	images?: Array<{ data: string; mimeType: "image/jpeg" }>;
	isError?: boolean;
}

const s3 = (seconds: number) => Math.round(seconds * 1000) / 1000;
const fail = (code: string, message: string, next?: Next): LookClipAnswer => ({ payload: { error: { code, message }, ...(next ? { next } : {}) }, isError: true });

const TRANSFORM_KEYS = ["transform.scaleX", "transform.scaleY", "transform.positionX", "transform.positionY"];

/** The element with its transform params at local ticks `local` (keys interpolated linearly). */
function keyedAt(element: SnapshotElement, local: number): SnapshotElement {
	const animations = element.animations as Record<string, { keys?: Array<{ time: number; value: number }> }> | undefined;
	if (!animations) return element;
	const params = { ...(element.params ?? {}) };
	for (const key of TRANSFORM_KEYS) {
		const keys = animations[key]?.keys;
		if (!keys?.length) continue;
		const sorted = [...keys].sort((a, b) => a.time - b.time);
		let value = sorted[0].value;
		if (local >= sorted[sorted.length - 1].time) value = sorted[sorted.length - 1].value;
		else {
			for (let i = 0; i + 1 < sorted.length; i++) {
				const a = sorted[i];
				const b = sorted[i + 1];
				if (local >= a.time && local <= b.time) {
					value = b.time > a.time ? a.value + ((b.value - a.value) * (local - a.time)) / (b.time - a.time) : b.value;
					break;
				}
			}
		}
		params[key] = value;
	}
	return { ...element, params };
}

const isComposition = (el: SnapshotElement) => !!(el.restorff as { composition?: unknown } | undefined)?.composition;
const isCutout = (el: SnapshotElement) => !!(el.restorff as { cutout?: unknown } | undefined)?.cutout;

function compositionFile(el: SnapshotElement): string | null {
	const hash = (el.restorff as { composition?: { hash?: string } }).composition?.hash;
	if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null;
	for (const file of [join(CACHE_DIR, `${hash}.webm`), join(CUSTOM_CACHE_DIR, `${hash}.webm`)]) if (existsSync(file)) return file;
	return null;
}

/** Bottom → top: main, then overlay lanes from the bottom (index high → low). */
function stackOrder(snapshot: ProjectSnapshot): Array<{ track: SnapshotTrack; rank: number }> {
	const scene = activeScene(snapshot);
	const overlay = scene?.tracks?.overlay ?? [];
	return [...(scene?.tracks?.main ? [{ track: scene.tracks.main, rank: -1 }] : []), ...overlay.map((track, index) => ({ track, rank: overlay.length - index })).reverse()];
}

export async function lookClip({
	timelineId,
	elementId,
	times,
	branch,
	over = "clip",
	signal,
}: {
	timelineId: string;
	elementId: string;
	times?: number[];
	branch?: string;
	over?: "clip" | "none";
	signal?: AbortSignal;
}): Promise<LookClipAnswer> {
	const loaded = await getProjectHead(timelineId, branch);
	const snapshot = loaded.snapshot;
	if (!snapshot) return fail("no_snapshot", "This timeline has no snapshot.");
	const scene = activeScene(snapshot);
	const seed = locate(scene, elementId);
	const summaryNext: Next = { do: "Read the timeline summary for element ids.", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } };
	if (!seed) return fail("not_found", `No element ${elementId} on this timeline.`, summaryNext);
	const canvas = canvasOf(snapshot);

	// the scene: the effect's members (+ its person), else the element itself
	const members = new Set<string>();
	let what = seed.element.name ?? seed.element.type;
	let plateId: string | null = null;
	const found = findApplied(snapshot, elementId);
	if (found.kind === "instance") {
		for (const item of found.members) members.add(item.element.id);
		if (found.record?.person) members.add(found.record.person);
		plateId = found.record?.plate ?? null;
		what = `${found.effect.id} ${found.effect.name}`;
	} else if (isComposition(seed.element) || isCutout(seed.element)) {
		members.add(seed.element.id);
	} else if (seed.element.type === "video" || seed.element.type === "image") {
		plateId = seed.element.id;
	} else {
		return fail("not_drawable", `${elementId} is a ${seed.element.type} element: look kind clip draws compositions, effects built from them, person cutouts and clips. For text, captions and FX shader layers render the timeline and look kind render.`, summaryNext);
	}
	const memberEls = [...members].map((id) => locate(scene, id)).filter((item): item is Located => !!item);
	const spanStart = Math.min(...(memberEls.length ? memberEls : [seed]).map((item) => item.element.startTime));
	const spanEnd = Math.max(...(memberEls.length ? memberEls : [seed]).map((item) => item.element.startTime + item.element.duration));
	const asked = (times ?? []).filter((t) => Number.isFinite(t)).slice(0, 12);
	const at = asked.length ? asked : [0.15, 0.4, 0.65, 0.9].map((share) => (spanStart + (spanEnd - spanStart) * share) / TICKS);

	const drawn = new Set<string>();
	const notDrawn = new Set<string>();
	const frames: Array<{ image: number; t: number; layers: string[] }> = [];
	const images: Array<{ data: string; mimeType: "image/jpeg" }> = [];
	for (const t of at) {
		const ticks = Math.round(t * TICKS);
		const layers: StillLayer[] = [];
		const names: string[] = [];
		const activeAt = (el: SnapshotElement) => el.startTime <= ticks && ticks < el.startTime + el.duration;
		// the clip
		if (over === "clip") {
			const plate = (plateId ? locate(scene, plateId)?.element : null) ?? footageClipOver(snapshot, t, t + 1 / canvas.fps);
			if (plate && activeAt(plate) && plate.type === "video") {
				const media = await projectMediaRecord(timelineId, String(plate.mediaId ?? "")).catch(() => null);
				if (media && existsSync(media.file)) {
					const local = ticks - plate.startTime;
					const source = { width: Number(media.meta?.width) || canvas.width, height: Number(media.meta?.height) || canvas.height };
					const place = placeOnCanvas(keyedAt(plate, local), source, canvas, canvas.width, "black@0");
					layers.push({ file: media.file, at: ((plate.trimStart ?? 0) + local * rateOf(plate)) / TICKS, place: place.filters });
					names.push(`clip ${plate.name ?? plate.id}`);
					drawn.add("the clip (its media, keys followed linearly; masks and grades not drawn)");
				} else notDrawn.add("the clip (its media is not on the server)");
			}
		}
		// the effect's layers and its person, bottom → top, in lane order
		for (const { track } of stackOrder(snapshot)) {
			for (const el of track.elements ?? []) {
				if (!activeAt(el)) continue;
				// an effect: its own layers; a clip: every composition and person cutout over it at that time
				const ours = members.size ? members.has(el.id) : track !== scene?.tracks?.main && (isComposition(el) || isCutout(el));
				if (!ours) continue;
				if (isComposition(el)) {
					const file = compositionFile(el);
					if (!file) {
						notDrawn.add(`${el.name ?? el.id} (its render is not in the cache any more: render the timeline)`);
						continue;
					}
					layers.push({ file, at: ((el.trimStart ?? 0) + (ticks - el.startTime)) / TICKS, alpha: true });
					names.push(`${track.name ?? track.id}: ${el.name ?? el.id}`);
					drawn.add("composition layers (their own renders)");
				} else if (isCutout(el)) {
					const jobId = (el.restorff as { cutout?: { server?: { job_id?: string } } }).cutout?.server?.job_id;
					const job = jobId ? getMatteJob(jobId) : null;
					const webm = job ? matteOutputFiles(job).webm : null;
					if (!job || !webm || !existsSync(webm) || !job.outputs?.person_webm) {
						notDrawn.add("the person cutout (no server matte file for it)");
						continue;
					}
					const local = ticks - el.startTime;
					const person = job.outputs.person_webm;
					const place = placeOnCanvas(keyedAt(el, local), { width: person.width, height: person.height }, canvas, canvas.width, "black@0");
					layers.push({ file: webm, at: ((el.trimStart ?? 0) + local * rateOf(el)) / TICKS, alpha: true, place: place.filters });
					names.push(`${track.name ?? track.id}: the person`);
					drawn.add("the person cutout (person.webm)");
				} else {
					notDrawn.add(`${el.type} elements (${el.name ?? el.id})`);
				}
			}
		}
		if (!layers.length) {
			frames.push({ image: 0, t: s3(t), layers: ["nothing of it at this time"] });
			continue;
		}
		const still = await compositeStill(canvas, layers, { signal });
		images.push(still);
		frames.push({ image: images.length, t: s3(t), layers: names });
	}
	const fx = (scene?.tracks?.overlay ?? []).some((track) => track.type === "effect" && (track.elements ?? []).some((el) => el.startTime < spanEnd && el.startTime + el.duration > spanStart));
	if (fx) notDrawn.add("FX shader layers and grades over this time (Digital Zoom, Vertigo…)");
	return {
		payload: {
			kind: "clip",
			timeline_id: timelineId,
			commit: loaded.head.id,
			element_id: elementId,
			scene: what,
			span: { from: s3(spanStart / TICKS), to: s3(spanEnd / TICKS) },
			frames,
			drawn: [...drawn],
			...(notDrawn.size ? { not_drawn: [...notDrawn] } : {}),
			how: "straight from the layers' own files on disk (no timeline render), composited bottom → top; 432x768 for 9:16",
			next: { do: "When it looks right, render the timeline and look at the real frames (FX layers, captions and grades included).", tool: "render", arguments: { timeline_id: timelineId, quality: "preview" } },
		},
		...(images.length ? { images } : {}),
	};
}
