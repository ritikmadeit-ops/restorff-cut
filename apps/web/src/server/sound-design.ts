/**
 * Sound on the server (mcp-media agent, 2026-10-20; PARITY G09): the built-in SFX pack read from disk, one sound placed
 * by name with its event on a time, and "Design the sound" planned with the SAME pure planner the editor's button uses
 * (`@restorffcut/timeline-ops` designSound — hit at 0.0 s, riser into the hook, whoosh per cut, pop per text in,
 * ≥ 0.25 s apart, light duck), so an MCP run and a button press give the same cut.
 *
 * Pure over a snapshot: these functions return the project after the ops plus what to commit; the MCP tool
 * (`apps/web/src/mcp/media-tool.ts`) commits it as Claude.
 *
 *   RESTORFFCUT_SFX_DIR   folder with manifest.json + the WAVs (default <apps/web>/public/sfx, served at /sfx/)
 *
 * Runbook: docs/restorff/worklog/mcp-media.md. The pack itself: docs/restorff/worklog/sounds.md.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
	apply,
	designSound,
	isSfxTrack,
	markDesign,
	type Op,
	type PlannedSfx,
	previousDesign,
	type Project as OpsProject,
	type SfxLibraryEntry,
	type SoundDesignOptions,
	TICKS_PER_SECOND,
	withoutPreviousDesign,
} from "@restorffcut/timeline-ops";
import { type DesignV2Options, type PlannedSfxV2, planSoundDesignV2, SOUND_DESIGN_PLANNER, type SoundDesignV2Plan, type TimelineCue } from "./sound-design-plan";

/** A sound as manifest.json lists it (the fields the server reads). */
export interface PackSound extends SfxLibraryEntry {
	file: string;
	description?: string;
	tags: string[];
	sync?: "peak" | "onset";
	licence?: string;
}

export interface SfxPack {
	pack: string;
	version: string;
	licence: string;
	sounds: PackSound[];
}

export function resolveSfxDir(): string {
	const configured = process.env.RESTORFFCUT_SFX_DIR?.trim();
	if (configured) return path.resolve(configured);
	return path.join(process.cwd(), "public", "sfx");
}

let cached: { mtimeMs: number; pack: SfxPack } | null = null;

/** manifest.json, re-read when the file changes (the pack can be rebuilt while the server runs). */
export async function loadSfxPackFromDisk(): Promise<SfxPack> {
	const file = path.join(resolveSfxDir(), "manifest.json");
	const info = await stat(file);
	if (cached && cached.mtimeMs === info.mtimeMs) return cached.pack;
	const raw = JSON.parse(await readFile(file, "utf8")) as Partial<SfxPack> & { sounds?: PackSound[] };
	if (!Array.isArray(raw.sounds)) throw new Error(`${file}: no sounds[]`);
	const pack: SfxPack = {
		pack: raw.pack ?? "restorff-core",
		version: raw.version ?? "?",
		licence: raw.licence ?? "generated, ours",
		sounds: raw.sounds.map((sound) => ({ ...sound, tags: Array.isArray(sound.tags) ? sound.tags : [] })),
	};
	cached = { mtimeMs: info.mtimeMs, pack };
	return pack;
}

/** A sound by id, then by name, then the first whose tags or roles contain the word ("whoosh", "riser", "paper"). */
export function findSound(pack: SfxPack, query: string): PackSound | null {
	const needle = query.trim().toLowerCase().replace(/\.wav$/, "");
	if (!needle) return null;
	return (
		pack.sounds.find((sound) => sound.id === needle) ??
		pack.sounds.find((sound) => sound.name.toLowerCase() === needle) ??
		pack.sounds.find((sound) => sound.tags.includes(needle) || sound.roles.includes(needle) || sound.category === needle) ??
		pack.sounds.find((sound) => sound.id.includes(needle) || sound.name.toLowerCase().includes(needle)) ??
		null
	);
}

export function filterSounds(pack: SfxPack, { tag, category, query }: { tag?: string; category?: string; query?: string }): PackSound[] {
	const t = tag?.trim().toLowerCase();
	const c = category?.trim().toLowerCase();
	const q = query?.trim().toLowerCase();
	return pack.sounds.filter((sound) => {
		if (c && sound.category !== c) return false;
		if (t && !sound.tags.includes(t) && !sound.roles.includes(t)) return false;
		if (q && ![sound.id, sound.name.toLowerCase(), sound.description?.toLowerCase() ?? "", ...sound.tags, ...sound.roles].some((field) => field.includes(q))) return false;
		return true;
	});
}

// ─── one sound ────────────────────────────────────────────────────────────────────────────────────────────────

const round = (value: number) => Math.round(value * 1000) / 1000;

function activeScene(project: OpsProject) {
	return project.scenes.find((scene) => scene.id === project.currentSceneId) ?? project.scenes.find((scene) => scene.isMain) ?? project.scenes[0];
}

/** An SFX lane with room for [from, to), or the add_track op for a new one (same rule as the editor's "+"). */
function laneFor(project: OpsProject, from: number, to: number, author: "claude" | "user"): { id: string; add?: Op } {
	const scene = activeScene(project);
	const lanes = scene.tracks.audio.filter(isSfxTrack);
	const free = lanes.find((track) =>
		track.elements.every((element) => {
			const start = element.startTime / TICKS_PER_SECOND;
			const end = (element.startTime + element.duration) / TICKS_PER_SECOND;
			return to <= start + 1e-6 || from >= end - 1e-6;
		}),
	);
	if (free) return { id: free.id };
	const name = lanes.length === 0 ? "SFX" : `SFX ${lanes.length + 1}`;
	return { id: "sfx-lane", add: { op: "add_track", author, kind: "audio", name, ref: "sfx-lane" } };
}

/** Where an element starts / ends, seconds, or null. */
export function elementTimes(project: OpsProject, elementId: string): { start: number; end: number; name: string } | null {
	for (const scene of [activeScene(project), ...project.scenes]) {
		for (const track of [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]) {
			const element = track.elements.find((candidate) => candidate.id === elementId);
			if (element) {
				return {
					start: element.startTime / TICKS_PER_SECOND,
					end: (element.startTime + element.duration) / TICKS_PER_SECOND,
					name: element.name,
				};
			}
		}
	}
	return null;
}

export interface PlaceSoundPlan {
	ops: Op[];
	/** Element start (seconds): the event minus the sound's sync point, never below 0. */
	t: number;
	/** Where the sound's event (a whoosh's peak, a hit's attack) lands. */
	event: number;
	dur: number;
	db: number;
	lane: { id: string; created: boolean };
}

/** sfx + gain (+ add_track) that put `sound`'s event on `event` seconds. */
export function planPlaceSound(project: OpsProject, sound: PackSound, event: number, opts: { db?: number; name?: string; author?: "claude" | "user" } = {}): PlaceSoundPlan {
	const author = opts.author ?? "claude";
	const t = Math.max(0, round(event - sound.sync_s));
	const lane = laneFor(project, t, t + sound.duration_s, author);
	const db = typeof opts.db === "number" ? opts.db : sound.default_db;
	const ops: Op[] = [];
	if (lane.add) ops.push(lane.add);
	ops.push(
		{ op: "sfx", author, t, name: opts.name ?? `SFX ${sound.id}`, url: sound.url, dur: sound.duration_s, track: lane.id, ref: "placed" },
		{ op: "gain", author, el: "placed", db },
	);
	return { ops, t, event: round(t + sound.sync_s), dur: sound.duration_s, db, lane: { id: lane.id, created: !!lane.add } };
}

// ─── Design the sound ─────────────────────────────────────────────────────────────────────────────────────────

export interface ServerSoundDesign {
	/** The project after the design (previous design removed, new one applied and marked). */
	project: OpsProject;
	/** The ops@1 that ran (to store on the commit). */
	applied: Op[];
	summary: string;
	placed: PlannedSfx[];
	replaced: number;
	dropped: Array<{ kind: string; event: number; reason: string }>;
	skipped: string[];
	notes: string[];
	hookEnd: number | null;
	ducked: string[];
}

// ─── many sounds, one commit (sound-voice-v2, 2026-10-20) ─────────────────────────────────────────────────────

export interface PlaceItem {
	sound: PackSound;
	/** Where the sound's event lands, seconds. */
	event: number;
	/** Why, for the element name ("SFX <id> · <why>"). */
	why: string;
	db?: number;
}

export interface PlaceManyPlan {
	ops: Op[];
	items: Array<{ ref: string; sound: string; t: number; event: number; dur: number; db: number; lane: string; laneCreated: boolean; why: string; lead_in_short: boolean }>;
}

/**
 * sfx + gain for every item (+ add_track when no SFX lane has room) as ONE batch: lanes are filled in time order, a new
 * "SFX n" lane only when every lane (including ones this batch added) overlaps. Refs: placed-1…, sfx-lane-1….
 */
export function planPlaceSounds(project: OpsProject, items: PlaceItem[], author: "claude" | "user" = "claude"): PlaceManyPlan {
	const scene = activeScene(project);
	const lanes = scene.tracks.audio.filter(isSfxTrack).map((track) => ({
		id: track.id,
		created: false,
		busy: track.elements.map((element) => [element.startTime / TICKS_PER_SECOND, (element.startTime + element.duration) / TICKS_PER_SECOND] as [number, number]),
	}));
	const ops: Op[] = [];
	const out: PlaceManyPlan["items"] = [];
	const order = items.map((item, index) => ({ item, index })).sort((a, b) => a.item.event - a.item.sound.sync_s - (b.item.event - b.item.sound.sync_s));
	const refs = new Array<PlaceManyPlan["items"][number]>(items.length);
	for (const { item, index } of order) {
		const t = Math.max(0, round(item.event - item.sound.sync_s));
		const span: [number, number] = [t, t + item.sound.duration_s];
		let lane = lanes.find((candidate) => candidate.busy.every(([a, b]) => span[1] <= a + 1e-6 || span[0] >= b - 1e-6));
		if (!lane) {
			const ref = `sfx-lane-${lanes.length + 1}`;
			ops.push({ op: "add_track", author, kind: "audio", name: lanes.length === 0 ? "SFX" : `SFX ${lanes.length + 1}`, ref });
			lane = { id: ref, created: true, busy: [] };
			lanes.push(lane);
		}
		lane.busy.push(span);
		const ref = `placed-${index + 1}`;
		const db = typeof item.db === "number" ? item.db : item.sound.default_db;
		ops.push(
			{ op: "sfx", author, t, name: `SFX ${item.sound.id} · ${item.why}`, url: item.sound.url, dur: item.sound.duration_s, track: lane.id, ref },
			{ op: "gain", author, el: ref, db },
		);
		refs[index] = { ref, sound: item.sound.id, t, event: round(t + item.sound.sync_s), dur: item.sound.duration_s, db, lane: lane.id, laneCreated: lane.created, why: item.why, lead_in_short: item.event < item.sound.sync_s - 1e-6 };
	}
	out.push(...refs);
	return { ops, items: out };
}

// ─── Design the sound v2 (sound-voice-v2, 2026-10-20) ─────────────────────────────────────────────────────────

export interface ServerSoundDesignV2 extends Omit<ServerSoundDesign, "placed" | "dropped"> {
	planner: typeof SOUND_DESIGN_PLANNER;
	placed: PlannedSfxV2[];
	dropped: SoundDesignV2Plan["dropped"];
	palette: SoundDesignV2Plan["palette"];
	cuts: SoundDesignV2Plan["cuts"];
	covered_texts: SoundDesignV2Plan["covered_texts"];
}

/**
 * v2 on a snapshot (./sound-design-plan.ts): real cuts only, hits on the cut, composition cues (collected by the caller
 * with ./sound-design-cues.ts, async). Same replace-the-previous-design contract as v1: elements are marked
 * `restorff.design = "sound-design@1"` (the shared mark), so v1 and v2 designs replace each other.
 */
export function designSoundOnSnapshotV2(project: OpsProject, pack: SfxPack, seed: string, options: DesignV2Options, cues: TimelineCue[], fullFrame: Record<string, boolean | null>): ServerSoundDesignV2 {
	const previous = previousDesign(project);
	const prepared = previous.elements.length || previous.duckKeys ? withoutPreviousDesign(project) : project;
	const plan = planSoundDesignV2(prepared, pack.sounds, cues, fullFrame, { ...options, author: options.author ?? "claude" });
	const result = apply(prepared, plan.ops, { seed, mode: "best_effort", at: new Date().toISOString() });
	markDesign(result);
	return {
		planner: SOUND_DESIGN_PLANNER,
		project: result.project,
		applied: result.changes.applied,
		summary: plan.summary,
		placed: plan.placed,
		replaced: previous.elements.length,
		dropped: plan.dropped,
		skipped: result.conflicts.map((conflict) => `${conflict.op}: ${conflict.message}`),
		notes: plan.notes,
		hookEnd: plan.hookEnd,
		ducked: plan.ducked,
		palette: plan.palette,
		cuts: plan.cuts,
		covered_texts: plan.covered_texts,
	};
}

/**
 * The editor's designTheSound (apps/web/src/sound-design/apply.ts) without the editor: remove what a previous run
 * placed, plan, apply best-effort, mark the new elements so the next run replaces them.
 */
export function designSoundOnSnapshot(project: OpsProject, pack: SfxPack, seed: string, options: SoundDesignOptions = {}): ServerSoundDesign {
	const previous = previousDesign(project);
	const prepared = previous.elements.length || previous.duckKeys ? withoutPreviousDesign(project) : project;
	const plan = designSound(prepared, pack.sounds, { ...options, author: options.author ?? "claude" });
	const result = apply(prepared, plan.ops, { seed, mode: "best_effort", at: new Date().toISOString() });
	markDesign(result);
	return {
		project: result.project,
		applied: result.changes.applied,
		summary: plan.summary,
		placed: plan.placed,
		replaced: previous.elements.length,
		dropped: plan.dropped,
		skipped: result.conflicts.map((conflict) => `${conflict.op}: ${conflict.message}`),
		notes: plan.notes,
		hookEnd: plan.hookEnd,
		ducked: plan.ducked,
	};
}
