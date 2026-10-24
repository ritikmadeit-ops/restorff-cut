/**
 * Reading the project JSON for the gate: scenes, track roles, shots, sounds. Pure; no editor imports.
 * Track roles follow MODEL.md §4 (names from the Edit artboard) and the Restorff tags (`track.restorff.role`,
 * `element.restorff.role`).
 */
import type { FindingTrack, GateBrief, GateElement, GateProject, GateRestorffMeta, GateScene, GateTrack } from "./types.ts";

export const TICKS_PER_SECOND = 120_000;

export function ticksToSeconds(ticks: number): number {
	return ticks / TICKS_PER_SECOND;
}

export function round(value: number, digits = 2): number {
	const f = 10 ** digits;
	return Math.round(value * f) / f;
}

export function fpsOf(project: GateProject): number {
	const fps = project.settings.fps;
	if (typeof fps === "number") return fps;
	if (!fps || !fps.denominator) return 30;
	return fps.numerator / fps.denominator;
}

export function frameSeconds(project: GateProject): number {
	return 1 / (fpsOf(project) || 30);
}

export function restorffMeta(project: GateProject): GateRestorffMeta {
	return (project.metadata?.restorff ?? {}) as GateRestorffMeta;
}

export function briefOf(project: GateProject): GateBrief {
	return restorffMeta(project).brief ?? {};
}

export function pickScene(project: GateProject, sceneId?: string): GateScene | null {
	const scenes = project.scenes ?? [];
	return (
		scenes.find((s) => s.id === (sceneId ?? project.currentSceneId)) ??
		scenes.find((s) => s.isMain) ??
		scenes[0] ??
		null
	);
}

export function allTracks(scene: GateScene): GateTrack[] {
	return [...(scene.tracks.overlay ?? []), scene.tracks.main, ...(scene.tracks.audio ?? [])].filter(Boolean);
}

export function elStart(el: GateElement): number {
	return ticksToSeconds(el.startTime);
}

export function elEnd(el: GateElement): number {
	return ticksToSeconds(el.startTime + el.duration);
}

/** End of the last element of the scene, seconds. */
export function runtimeOf(scene: GateScene): number {
	let end = 0;
	for (const track of allTracks(scene)) for (const el of track.elements) end = Math.max(end, elEnd(el));
	return end;
}

// ------------------------------------------------------------------ roles

export type AudioRole = "music" | "sfx" | "voice";

export function audioRole(track: GateTrack, el?: GateElement): AudioRole {
	const elRole = el?.restorff?.role;
	if (elRole === "sfx") return "sfx";
	if (elRole === "music") return "music";
	const role = track.restorff?.role;
	if (role === "music") return "music";
	if (role === "sfx") return "sfx";
	const name = (track.name ?? "").toUpperCase();
	if (/MUSIC|BED/.test(name)) return "music";
	if (/SFX|FX\b|SOUND/.test(name)) return "sfx";
	if (el && /\b(sfx|whoosh|swoosh|hit|boom|impact|riser|pop|click|snap|swish|ding)\b/i.test(el.name ?? "")) return "sfx";
	return "voice";
}

export function isCaptionTrack(track: GateTrack): boolean {
	return track.restorff?.role === "caption" || /CAPTION|SUBTITLE/i.test(track.name ?? "");
}

export function isCaption(track: GateTrack, el: GateElement): boolean {
	return el.restorff?.role === "caption" || isCaptionTrack(track) || /^Caption \d+/.test(el.name ?? "");
}

export interface PlacedElement {
	track: GateTrack;
	el: GateElement;
	/** 0 = top of the overlay group; the main track comes after every overlay track. */
	order: number;
	isMain: boolean;
}

export function textElements(scene: GateScene): PlacedElement[] {
	const out: PlacedElement[] = [];
	scene.tracks.overlay.forEach((track, order) => {
		if (track.type !== "text" || track.hidden) return;
		for (const el of track.elements) if (el.type === "text" && !el.hidden) out.push({ track, el, order, isMain: false });
	});
	return out;
}

/** Visible picture elements (video + image) on video tracks, top-most first. */
export function videoElements(scene: GateScene): PlacedElement[] {
	const out: PlacedElement[] = [];
	scene.tracks.overlay.forEach((track, order) => {
		if (track.type !== "video" || track.hidden) return;
		for (const el of track.elements)
			if ((el.type === "video" || el.type === "image") && !el.hidden) out.push({ track, el, order, isMain: false });
	});
	const main = scene.tracks.main;
	if (main && !main.hidden) {
		for (const el of main.elements)
			if ((el.type === "video" || el.type === "image") && !el.hidden)
				out.push({ track: main, el, order: scene.tracks.overlay.length, isMain: true });
	}
	return out;
}

export function textContent(el: GateElement): string {
	const content = el.params?.content;
	return typeof content === "string" ? content : "";
}

export function wordCount(text: string): number {
	return text
		.split(/\s+/)
		.map((w) => w.replace(/^[^\p{L}\p{N}$€£₹¥]+|[^\p{L}\p{N}%]+$/gu, ""))
		.filter(Boolean).length;
}

// ------------------------------------------------------------------ shots

export interface Shot {
	t: number;
	t_end: number;
	el: GateElement;
	track: GateTrack;
	isMain: boolean;
}

export interface ShotMap {
	shots: Shot[];
	/** Spans with no visible picture (black). */
	gaps: Array<{ t: number; t_end: number }>;
	runtime: number;
}

/**
 * The picture as the viewer sees it: at every moment the top-most visible video/image element. A shot is a run of
 * time with the same top-most element; a gap is a run with none (black frames). ASSUMPTION: an overlay element is
 * treated as covering the frame even when it is scaled down (picture-in-picture counts as a cut).
 */
export function shotMap(scene: GateScene, minGap = 0): ShotMap {
	const runtime = runtimeOf(scene);
	const vids = videoElements(scene);
	const points = new Set<number>([0, runtime]);
	for (const { el } of vids) {
		const s = Math.max(0, Math.min(runtime, elStart(el)));
		const e = Math.max(0, Math.min(runtime, elEnd(el)));
		points.add(s);
		points.add(e);
	}
	const sorted = [...points].sort((a, b) => a - b);
	const shots: Shot[] = [];
	const gaps: Array<{ t: number; t_end: number }> = [];
	for (let i = 0; i < sorted.length - 1; i++) {
		const a = sorted[i];
		const b = sorted[i + 1];
		if (b - a <= 1e-9) continue;
		const mid = (a + b) / 2;
		let top: PlacedElement | null = null;
		for (const v of vids) {
			if (elStart(v.el) <= mid && mid < elEnd(v.el)) {
				if (!top || v.order < top.order) top = v;
			}
		}
		if (!top) {
			const last = gaps[gaps.length - 1];
			if (last && Math.abs(last.t_end - a) < 1e-9) last.t_end = b;
			else gaps.push({ t: a, t_end: b });
			continue;
		}
		const last = shots[shots.length - 1];
		if (last && last.el.id === top.el.id && Math.abs(last.t_end - a) < 1e-9) last.t_end = b;
		else shots.push({ t: a, t_end: b, el: top.el, track: top.track, isMain: top.isMain });
	}
	return { shots, gaps: gaps.filter((g) => g.t_end - g.t > minGap), runtime };
}

export function trackForVideo(isMain: boolean): FindingTrack {
	return isMain ? "V1 A-ROLL" : "V2 B-ROLL";
}

/** The shot under t (top-most visible picture). */
export function shotAt(map: ShotMap, t: number): Shot | null {
	return map.shots.find((s) => s.t <= t && t < s.t_end) ?? map.shots[map.shots.length - 1] ?? null;
}

// ------------------------------------------------------------------ sound

export interface Sound {
	t: number;
	t_end: number;
	role: AudioRole;
	el: GateElement;
	track: GateTrack;
}

function volumeOf(el: GateElement): number {
	const v = el.params?.volume;
	return typeof v === "number" ? v : 0;
}

function isMutedEl(el: GateElement): boolean {
	return el.params?.muted === true || volumeOf(el) <= -60;
}

/** Every audible span: audio elements on unmuted tracks, and video elements whose own sound is on. */
export function sounds(scene: GateScene): Sound[] {
	const out: Sound[] = [];
	for (const track of scene.tracks.audio ?? []) {
		if (track.muted) continue;
		for (const el of track.elements) {
			if (el.type !== "audio" || isMutedEl(el)) continue;
			out.push({ t: elStart(el), t_end: elEnd(el), role: audioRole(track, el), el, track });
		}
	}
	for (const { el, track } of videoElements(scene)) {
		if (el.type !== "video" || track.muted || el.isSourceAudioEnabled === false || isMutedEl(el)) continue;
		out.push({ t: elStart(el), t_end: elEnd(el), role: "voice", el, track });
	}
	return out;
}

/** Music beats in timeline seconds (downbeats when known), clipped to each element's visible span. */
export function musicHits(scene: GateScene, downbeatsOnly = false): number[] {
	const hits: number[] = [];
	for (const s of sounds(scene)) {
		if (s.role !== "music" || !s.el.beats?.times?.length) continue;
		const rate = s.el.retime?.rate || 1;
		const trimStart = s.el.trimStart ?? 0;
		const idx = downbeatsOnly && s.el.beats.downbeats?.length ? s.el.beats.downbeats : null;
		const times = idx ? idx.map((i) => s.el.beats!.times[i]).filter((v) => typeof v === "number") : s.el.beats.times;
		for (const src of times) {
			const t = ticksToSeconds(s.el.startTime + (src - trimStart) / rate);
			if (t >= s.t - 1e-6 && t < s.t_end) hits.push(t);
		}
	}
	return hits.sort((a, b) => a - b);
}

export function hasMoveAnimation(el: GateElement): boolean {
	const anims = el.animations ?? {};
	for (const [path, channel] of Object.entries(anims)) {
		if (!path.startsWith("transform.") || !channel) continue;
		const keys = (channel as { keys?: unknown[] }).keys;
		if (Array.isArray(keys) && keys.length >= 2) return true;
	}
	return false;
}

/** Merge overlapping spans and return their union. */
export function union(spans: Array<{ t: number; t_end: number }>): Array<{ t: number; t_end: number }> {
	const sorted = spans.filter((s) => s.t_end > s.t).sort((a, b) => a.t - b.t);
	const out: Array<{ t: number; t_end: number }> = [];
	for (const s of sorted) {
		const last = out[out.length - 1];
		if (last && s.t <= last.t_end + 1e-9) last.t_end = Math.max(last.t_end, s.t_end);
		else out.push({ ...s });
	}
	return out;
}

export function formatTime(t: number): string {
	const m = Math.floor(t / 60);
	const s = t - m * 60;
	return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}
