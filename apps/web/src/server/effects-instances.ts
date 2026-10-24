/**
 * Applied effects as things you can change (effects-v2 agent, 2026-10-20; SUMMARY gap 15, recreation E-1).
 *
 * Every `effects apply` from effects-v2 on tags each element it adds with `restorff.effect.instance` (one id per
 * apply) and `restorff.effect.applied` (the record below: when, how long, which clip, which params the caller set, the
 * person cutout it uses, the tracks it created and the plate keys it wrote). `effects update` and `effects remove`
 * start from ANY element of an effect (a layer, its FX layer, the clip it keys, its person cutout) and find the rest:
 *
 *   findEffect(snapshot, id)     → the instance (its member elements + record), a clip effect / transition on a clip,
 *                                  several candidates (ambiguous), or nothing
 *   removeInstance(snapshot, …)  → delete the members, the person cutout no other effect uses, the plate keys it wrote,
 *                                  and (unless kept for an update) the tracks it created that are now empty
 *
 * Effects applied before effects-v2 ("legacy": no instance tag) are grouped by effect id + start time; their plate
 * keys are recomputed by the caller (effects.ts, from the manifest recipe) and their whole-clip cutout is deleted only
 * when nothing else (another effect layer, a cutout-tool text/shape layer) overlaps it.
 */
import type { ProjectSnapshot, SnapshotElement, SnapshotTrack } from "@/sync/snapshot";
import { activeScene, cutoutSourceOf, type Located, locate, TICKS } from "./matte-presets";

export interface PlateKeyRecord {
	/** The element the keys are on (the clip, or its person cutout). */
	el: string;
	props: string[];
	/** Element-local ticks. */
	times: number[];
}

export interface AppliedRecord {
	kind: "composition" | "layered" | "shader";
	/** Timeline seconds. */
	t: number;
	duration_s: number;
	word?: string;
	occurrence?: number;
	/** The clip the effect is built on / keys (layered), or null. */
	plate?: string | null;
	/** Param keys the caller set (the rest came from the example, the recipe or the matte). */
	given: string[];
	/** The person cutout (V2 CUTOUT) this effect stands behind/around. */
	person?: string | null;
	created_tracks: string[];
	created_cutout?: boolean;
	plate_keys?: PlateKeyRecord[];
}

export interface EffectTag {
	id: string;
	name: string;
	instance?: string;
	applied?: AppliedRecord;
	layer?: string | null;
	side?: string;
	[key: string]: unknown;
}

export const effectTagOf = (element: SnapshotElement | null | undefined): EffectTag | null => {
	const tag = (element?.restorff as { effect?: EffectTag } | undefined)?.effect;
	return tag && typeof tag.id === "string" ? tag : null;
};

export function newInstanceId(): string {
	return `fx_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export type FoundEffect =
	| {
			kind: "instance";
			instance: string | null;
			effect: { id: string; name: string };
			record: AppliedRecord | null;
			members: Located[];
			legacy: boolean;
	  }
	| { kind: "clip_effect"; clip: Located; effect: { id: string; type: string; params?: Record<string, unknown> } }
	| { kind: "transition"; clip: Located; transition: { type: string; duration: number } }
	| { kind: "ambiguous"; options: Array<Record<string, unknown>> }
	| { kind: "none"; why: string };

function allLocated(snapshot: ProjectSnapshot): Located[] {
	const scene = activeScene(snapshot);
	const out: Located[] = [];
	(scene?.tracks?.overlay ?? []).forEach((track, index) => {
		for (const element of track.elements ?? []) out.push({ element, track, group: "overlay", index });
	});
	const main = scene?.tracks?.main;
	if (main) for (const element of main.elements ?? []) out.push({ element, track: main, group: "main", index: 0 });
	return out;
}

const FRAME_TICKS = 4000; // one frame at 30 fps

/** The members of an effect instance (or a legacy group: same effect id, same start ± 1 frame, same kind). */
function membersOf(snapshot: ProjectSnapshot, seed: Located): { instance: string | null; members: Located[]; legacy: boolean } {
	const tag = effectTagOf(seed.element);
	const everything = allLocated(snapshot);
	if (tag?.instance) {
		return { instance: tag.instance, members: everything.filter((item) => effectTagOf(item.element)?.instance === tag.instance), legacy: false };
	}
	const isComp = !!(seed.element.restorff as { composition?: unknown } | undefined)?.composition;
	const members = everything.filter((item) => {
		const other = effectTagOf(item.element);
		if (!other || other.instance || other.id !== tag?.id) return false;
		const otherComp = !!(item.element.restorff as { composition?: unknown } | undefined)?.composition;
		return otherComp === isComp && Math.abs(item.element.startTime - seed.element.startTime) <= FRAME_TICKS;
	});
	return { instance: null, members: members.length ? members : [seed], legacy: true };
}

const summaryOf = (item: Located) => {
	const tag = effectTagOf(item.element);
	return {
		element_id: item.element.id,
		effect: tag ? `${tag.id} ${tag.name}` : item.element.name ?? item.element.type,
		t: Math.round((item.element.startTime / TICKS) * 1000) / 1000,
		duration_s: Math.round((item.element.duration / TICKS) * 1000) / 1000,
		track: item.track.name ?? item.track.id,
	};
};

/** The effect an element belongs to. `effectId` picks one effect object on a clip (shader applied with element_id). */
export function findEffect(snapshot: ProjectSnapshot, elementId: string, effectId?: string): FoundEffect {
	const scene = activeScene(snapshot);
	const seed = locate(scene, elementId);
	if (!seed) return { kind: "none", why: `No element ${elementId} on this timeline.` };
	const tag = effectTagOf(seed.element);
	if (tag) {
		const { instance, members, legacy } = membersOf(snapshot, seed);
		const record = members.map((item) => effectTagOf(item.element)?.applied).find((value): value is AppliedRecord => !!value) ?? null;
		return { kind: "instance", instance, effect: { id: tag.id, name: tag.name }, record, members, legacy };
	}
	// a person cutout: the effects standing around it
	const cut = cutoutSourceOf(seed.element);
	if (cut) {
		const users = allLocated(snapshot).filter((item) => {
			const t = effectTagOf(item.element);
			if (!t) return false;
			if (t.applied?.person) return t.applied.person === seed.element.id;
			// legacy: layers on MOTION BACK/FRONT over the cutout's span
			const name = (item.track.name ?? "").toUpperCase();
			return (name.startsWith("MOTION BACK") || name.startsWith("MOTION FRONT")) && item.element.startTime < seed.element.startTime + seed.element.duration && item.element.startTime + item.element.duration > seed.element.startTime;
		});
		const instances = new Map<string, Located>();
		for (const item of users) instances.set(effectTagOf(item.element)?.instance ?? `${effectTagOf(item.element)?.id}@${item.element.startTime}`, item);
		if (instances.size === 1) return findEffect(snapshot, [...instances.values()][0].element.id);
		if (!instances.size) return { kind: "none", why: `${elementId} is a person cutout no effect uses (the cutout tool's, or left over): delete it with timeline_ops delete.` };
		return { kind: "ambiguous", options: [...instances.values()].map(summaryOf) };
	}
	// a clip: an effect object on it, its transition in, or the layered effects built on it
	if (seed.element.type === "video" || seed.element.type === "image") {
		const options: Array<Record<string, unknown>> = [];
		const effects = ((seed.element.effects as Array<{ id: string; type: string; params?: Record<string, unknown> }> | undefined) ?? []).filter((effect) => effect.type !== "restorff-grade");
		const into = seed.element.transitionIn as { type?: string; duration?: number } | undefined;
		if (effectId === "transition") {
			if (into?.type) return { kind: "transition", clip: seed, transition: { type: into.type, duration: into.duration ?? 0 } };
			return { kind: "none", why: `No transition leads into clip ${elementId}.` };
		}
		if (effectId) {
			const effect = effects.find((candidate) => candidate.id === effectId);
			if (effect) return { kind: "clip_effect", clip: seed, effect };
			return { kind: "none", why: `Clip ${elementId} has no effect ${effectId} (it has: ${effects.map((e) => `${e.id} ${e.type}`).join(", ") || "none"}).` };
		}
		for (const effect of effects) options.push({ element_id: elementId, effect_id: effect.id, effect: effect.type, on: "the clip (whole length)" });
		const transition = into;
		if (transition?.type) options.push({ element_id: elementId, effect_id: "transition", transition: transition.type, on: "the cut into this clip" });
		const built = new Map<string, Located>();
		for (const item of allLocated(snapshot)) {
			const t = effectTagOf(item.element);
			if (t?.applied?.plate === elementId && t.instance) built.set(t.instance, item);
		}
		for (const item of built.values()) options.push(summaryOf(item));
		if (options.length === 1) {
			if (effects.length === 1) return { kind: "clip_effect", clip: seed, effect: effects[0] };
			if (transition?.type) return { kind: "transition", clip: seed, transition: { type: transition.type, duration: transition.duration ?? 0 } };
			return findEffect(snapshot, [...built.values()][0].element.id);
		}
		if (!options.length) return { kind: "none", why: `Clip ${elementId} carries no applied effect (no effect on it, no transition into it, no effect built on it).` };
		return { kind: "ambiguous", options };
	}
	return { kind: "none", why: `${elementId} (${seed.element.type}) is not part of an applied effect.` };
}

// ─── removal ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Remove keyframes of `props` on an element within one frame of `times` (element-local ticks). Returns how many. */
export function removeKeys(element: SnapshotElement, props: string[], times: number[], tolerance = FRAME_TICKS / 2): number {
	const animations = element.animations as Record<string, { keys?: Array<{ time: number }> }> | undefined;
	if (!animations) return 0;
	let removed = 0;
	for (const prop of props) {
		const channel = animations[prop];
		if (!channel || !Array.isArray(channel.keys)) continue;
		const keep = channel.keys.filter((key) => !times.some((time) => Math.abs(key.time - time) <= tolerance));
		removed += channel.keys.length - keep.length;
		if (keep.length) animations[prop] = { ...channel, keys: keep };
		else delete animations[prop];
	}
	if (!Object.keys(animations).length) delete (element as { animations?: unknown }).animations;
	return removed;
}

const BEHIND_LANES = /^(BEHIND TEXT|COVER |BACKGROUND)/;
const EFFECT_LANES = /^(MOTION|FX|V2 CUTOUT)/;

export interface RemovalPlan {
	/** ops@1 recorded with the commit (deletes, track removals). */
	ops: Array<Record<string, unknown>>;
	/** Snapshot edits after the reducer ran (plate keys; users of a segment cut at its head). `refs` = the run's refs. */
	finish: (snapshot: ProjectSnapshot, refs?: Record<string, string>) => { keys_removed: number };
	removed: { elements: string[]; cutout: string | null; tracks: string[] };
	kept: { cutout?: string; why?: string; tracks?: string[] };
	notes: string[];
}

/**
 * What removing an instance takes. `legacyKeys` = the plate keys a legacy effect wrote (recomputed by the caller);
 * `keepTracks` keeps the emptied tracks (an update re-applies into them; the caller removes leftovers).
 */
export function planRemoval(
	snapshot: ProjectSnapshot,
	found: Extract<FoundEffect, { kind: "instance" }>,
	opts: { keepTracks: boolean; legacyKeys?: PlateKeyRecord[] },
): RemovalPlan {
	const everything = allLocated(snapshot);
	const memberIds = new Set(found.members.map((item) => item.element.id));
	const record = found.record;
	const notes: string[] = [];
	const ops: Array<Record<string, unknown>> = found.members.map((item) => ({ op: "delete", author: "claude", el: item.element.id }));
	const deleted = new Set(memberIds);

	// the person cutout
	let cutout: Located | null = null;
	let keptCutout: { cutout?: string; why?: string } = {};
	const span = {
		start: Math.min(...found.members.map((item) => item.element.startTime)),
		end: Math.max(...found.members.map((item) => item.element.startTime + item.element.duration)),
	};
	const candidates: Located[] = [];
	const located = record?.person ? locate(activeScene(snapshot), record.person) : null;
	if (located) candidates.push(located);
	else if (record?.person && record.plate) {
		// the segment was cut since (a transition took its start out of the window: a new element id): the plate's
		// segments over this effect's window stand in for it
		for (const item of everything) {
			const source = cutoutSourceOf(item.element);
			if (source?.sourceElementId === record.plate && item.element.startTime < span.end && item.element.startTime + item.element.duration > span.start) candidates.push(item);
		}
	} else if (found.legacy && record === null) {
		const plateIds = new Set(found.members.map((item) => (effectTagOf(item.element) as { plate?: string } | null)?.plate).filter(Boolean));
		for (const item of everything) {
			const source = cutoutSourceOf(item.element);
			if (!source) continue;
			const overlapsSpan = item.element.startTime < span.end && item.element.startTime + item.element.duration > span.start;
			if (overlapsSpan && (plateIds.size === 0 || plateIds.has(source.sourceElementId))) candidates.push(item);
		}
		// only a layered effect has a cutout of its own: a legacy one sits on MOTION BACK/FRONT
		if (!found.members.some((item) => /^MOTION (BACK|FRONT)/.test((item.track.name ?? "").toUpperCase()))) candidates.length = 0;
	}
	let headTrim: { ref: string; was: string; wasStart: number; users: string[] } | null = null;
	for (const candidate of candidates) {
		const users = everything.filter((item) => {
			if (memberIds.has(item.element.id)) return false;
			const tag = effectTagOf(item.element);
			const overlapsCut = item.element.startTime < candidate.element.startTime + candidate.element.duration && item.element.startTime + item.element.duration > candidate.element.startTime;
			if (tag?.applied?.person) return tag.applied.person === candidate.element.id;
			if (tag && overlapsCut && /^MOTION (BACK|FRONT)/.test((item.track.name ?? "").toUpperCase())) return true;
			return overlapsCut && BEHIND_LANES.test((item.track.name ?? "").toUpperCase());
		});
		if (users.length) {
			keptCutout = { cutout: candidate.element.id, why: `still used by ${[...new Set(users.map((item) => effectTagOf(item.element)?.name ?? item.track.name ?? item.element.id))].slice(0, 3).join(", ")}` };
			// a shared segment shrinks back to the effects still on it (only when every user is a tagged effect)
			if (!cutout && users.every((item) => effectTagOf(item.element)?.applied?.person === candidate.element.id)) {
				const segStart = candidate.element.startTime;
				const segEnd = segStart + candidate.element.duration;
				const usersStart = Math.min(...users.map((item) => item.element.startTime));
				const usersEnd = Math.max(...users.map((item) => item.element.startTime + item.element.duration));
				if (segEnd - usersEnd > FRAME_TICKS && usersEnd > segStart) {
					ops.push({ op: "split", author: "claude", el: candidate.element.id, t: usersEnd / TICKS, ref: "seg_tail" }, { op: "delete", author: "claude", el: "seg_tail" });
					notes.push(`the shared person segment now ends with the effects still on it (${Math.round((usersEnd / TICKS) * 1000) / 1000} s)`);
				}
				if (usersStart - segStart > FRAME_TICKS && usersStart < segEnd) {
					ops.push({ op: "split", author: "claude", el: candidate.element.id, t: usersStart / TICKS, ref: "seg_rest" }, { op: "delete", author: "claude", el: candidate.element.id });
					headTrim = { ref: "seg_rest", was: candidate.element.id, wasStart: segStart, users: users.map((item) => item.element.id) };
					notes.push(`the shared person segment now starts with the effects still on it (${Math.round((usersStart / TICKS) * 1000) / 1000} s)`);
				}
			}
		} else if (!cutout) {
			cutout = candidate;
			ops.push({ op: "delete", author: "claude", el: candidate.element.id });
			deleted.add(candidate.element.id);
		}
	}

	// tracks left empty
	const tracks: string[] = [];
	const keptTracks: string[] = [];
	const touched = new Map<string, SnapshotTrack>();
	for (const item of [...found.members, ...(cutout ? [cutout] : [])]) if (item.group === "overlay") touched.set(item.track.id, item.track);
	const created = new Set(record?.created_tracks ?? []);
	for (const track of touched.values()) {
		const empty = (track.elements ?? []).every((el) => deleted.has(el.id));
		if (!empty) continue;
		const ours = record ? created.has(track.id) : EFFECT_LANES.test((track.name ?? "").toUpperCase());
		if (!ours) continue;
		if (opts.keepTracks) keptTracks.push(track.id);
		else {
			ops.push({ op: "remove_track", author: "claude", track: track.id });
			tracks.push(track.id);
		}
	}

	const keyRecords = record?.plate_keys ?? opts.legacyKeys ?? [];
	if (found.legacy && !record && opts.legacyKeys?.length) notes.push("Plate keys recomputed from the manifest recipe (this effect was applied before effects-v2 tagged its keys).");
	return {
		ops,
		finish: (after, refs = {}) => {
			let keysRemoved = 0;
			const scene = activeScene(after);
			// a shared segment cut at its head is a new element: its users and key records follow it
			const moved = headTrim && refs[headTrim.ref] ? { from: headTrim.was, to: refs[headTrim.ref], shift: (locate(scene, refs[headTrim.ref])?.element.startTime ?? headTrim.wasStart) - headTrim.wasStart } : null;
			if (moved && headTrim) {
				for (const id of headTrim.users) {
					const applied = effectTagOf(locate(scene, id)?.element)?.applied;
					if (!applied) continue;
					if (applied.person === moved.from) applied.person = moved.to;
					for (const keys of applied.plate_keys ?? []) {
						if (keys.el !== moved.from) continue;
						keys.el = moved.to;
						keys.times = keys.times.map((time) => time - moved.shift);
					}
				}
			}
			for (const keys of keyRecords) {
				const el = moved && keys.el === moved.from ? moved.to : keys.el;
				if (deleted.has(el)) continue;
				const target = locate(scene, el);
				if (target) keysRemoved += removeKeys(target.element, keys.props, el === keys.el ? keys.times : keys.times.map((time) => time - (moved?.shift ?? 0)));
			}
			return { keys_removed: keysRemoved };
		},
		removed: { elements: [...memberIds], cutout: cutout?.element.id ?? null, tracks },
		kept: { ...keptCutout, ...(keptTracks.length ? { tracks: keptTracks } : {}) },
		notes,
	};
}

/** Tracks in `ids` that are empty in `snapshot` (an update removes the old effect's leftover lanes with them). */
export function emptyTracks(snapshot: ProjectSnapshot, ids: string[]): string[] {
	const overlay = activeScene(snapshot)?.tracks?.overlay ?? [];
	return ids.filter((id) => {
		const track = overlay.find((candidate) => candidate.id === id);
		return !!track && !(track.elements ?? []).length;
	});
}
