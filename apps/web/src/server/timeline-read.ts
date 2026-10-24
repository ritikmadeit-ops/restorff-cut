/**
 * Reading a timeline over MCP (mcp-discover, wave 5, 2026-10-20; recreations SUMMARY gap 1).
 *
 * What the five recreations hit: `timeline get` answered `result_too_large` (183,542 – 621,818 chars) with no paging
 * and no way to read one element; `summary` rounded times to ms, so a `move` built on it conflicted by 40 ticks; the
 * summary had no transforms. This module is the pure read side the `timeline` tool calls:
 *   - `summaryView`  — tracks top to bottom, every element with EXACT seconds (6 decimals: round-trips every tick),
 *                      `end`, non-default transforms, keyframe counts; pages by a char budget (offset).
 *   - `pageView`     — full elements (params, transforms, keyframes in seconds, restorff data) by track, element ids,
 *                      or a time window, packed under a char budget; `next_offset` pages on.
 *   - `elementView`  — one element in full + its track, neighbours and copyable ops with its exact numbers.
 *   - `resolveTrackStrict` — a track by id, "main", or an unambiguous name ("MUSIC", "V2 B-ROLL", "V1").
 * Units: seconds everywhere; ticks only in fields named `*_ticks` (120,000 per second).
 */
import type { ProjectSnapshot, SnapshotElement, SnapshotScene, SnapshotTrack } from "@/sync/snapshot";
import { exactSeconds, scrubData, TICKS_PER_SECOND } from "./timeline-read-hygiene";

export { exactSeconds, TICKS_PER_SECOND };

/** The protocol caps a whole answer at 75,000 chars; a page of full elements (get) stays under this… */
export const PAGE_LIMIT_CHARS = 68_000;
/** …and a summary page under this (its envelope around it is small: ids, head, next, editor link). */
export const SUMMARY_LIMIT_CHARS = 71_000;

export type Group = "overlay" | "main" | "audio";

export interface TrackRef {
	track: SnapshotTrack;
	group: Group;
	/** 0 = the top lane. */
	index: number;
}

export function activeScene(snapshot: ProjectSnapshot): SnapshotScene | null {
	const scenes = snapshot.scenes ?? [];
	return scenes.find((scene) => scene.id === snapshot.currentSceneId) ?? scenes.find((scene) => scene.isMain) ?? scenes[0] ?? null;
}

export function tracksOf(snapshot: ProjectSnapshot): TrackRef[] {
	const tracks = activeScene(snapshot)?.tracks;
	if (!tracks) return [];
	const out: Array<Omit<TrackRef, "index">> = [
		...(tracks.overlay ?? []).map((track) => ({ track, group: "overlay" as const })),
		...(tracks.main ? [{ track: tracks.main, group: "main" as const }] : []),
		...(tracks.audio ?? []).map((track) => ({ track, group: "audio" as const })),
	];
	return out.map((entry, index) => ({ ...entry, index }));
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const MAIN_WORDS = new Set(["main", "v1", "aroll", "v1aroll", "maintrack"]);

/**
 * A track by id, "main" (or V1 / A-roll), an exact name ("V2 B-ROLL", "music"), or a name's first word ("V2")
 * when exactly one track matches. Several matches → `ambiguous` lists them (never a guess).
 */
export function resolveTrackStrict(snapshot: ProjectSnapshot, wanted: string): { match: TrackRef | null; ambiguous: TrackRef[] } {
	const all = tracksOf(snapshot);
	const byId = all.find(({ track }) => track.id === wanted);
	if (byId) return { match: byId, ambiguous: [] };
	const w = norm(wanted);
	if (!w) return { match: null, ambiguous: [] };
	if (MAIN_WORDS.has(w)) {
		const main = all.find(({ group }) => group === "main");
		if (main) return { match: main, ambiguous: [] };
	}
	const exact = all.filter(({ track }) => norm(track.name ?? "") === w);
	if (exact.length === 1) return { match: exact[0], ambiguous: [] };
	if (exact.length > 1) return { match: null, ambiguous: exact };
	const first = all.filter(({ track }) => norm((track.name ?? "").split(/\s+/)[0] ?? "") === w);
	if (first.length === 1) return { match: first[0], ambiguous: [] };
	return { match: null, ambiguous: first };
}

export const trackLabel = ({ track, group, index }: TrackRef) => ({ id: track.id, name: track.name ?? null, group, type: track.type, index });

/**
 * Ops that name a track instead of giving its id (timeline_ops). The reducer only takes ids, "main" or a batch ref;
 * models write "MUSIC" or "V2 B-ROLL". Rewritten to the id when exactly ONE track matches (resolveTrackStrict);
 * ambiguous or unknown names are left for the reducer to refuse (its conflict names the target). Fields: track and
 * under on any op, grade's target (unless "all" / an element id), reorder_tracks' order.
 */
export function resolveTrackNames(snapshot: ProjectSnapshot, ops: unknown[]) {
	const refs = new Set(ops.map((op) => (op as { ref?: unknown } | null)?.ref).filter((ref): ref is string => typeof ref === "string"));
	const all = tracksOf(snapshot);
	const trackIds = new Set(all.map(({ track }) => track.id));
	const elementIds = new Set(all.flatMap(({ track }) => (track.elements ?? []).map((element) => element.id)));
	const resolved: Array<{ index: number; field: string; from: string; to: string }> = [];
	const fix = (index: number, field: string, value: unknown): unknown => {
		if (typeof value !== "string" || value === "main" || refs.has(value) || trackIds.has(value) || elementIds.has(value)) return value;
		const found = resolveTrackStrict(snapshot, value).match;
		if (!found) return value;
		const to = found.group === "main" ? "main" : found.track.id;
		resolved.push({ index, field, from: value, to });
		return to;
	};
	const out = ops.map((raw, index) => {
		if (!raw || typeof raw !== "object") return raw;
		const op = { ...(raw as Record<string, unknown>) };
		for (const field of ["track", "under"]) if (field in op) op[field] = fix(index, field, op[field]);
		if (op.op === "grade" && "target" in op && op.target !== "all") op.target = fix(index, "target", op.target);
		if (op.op === "reorder_tracks" && Array.isArray(op.order)) op.order = (op.order as unknown[]).map((entry) => fix(index, "order", entry));
		return op;
	});
	return { ops: out, resolved };
}

// ─── element views ──────────────────────────────────────────────────────────────────────────────────────────────

const VISUAL = new Set(["video", "image", "text", "sticker", "graphic", "shape"]);
const TRANSFORM_KEYS: Array<[string, string, number]> = [
	["transform.positionX", "x", 0],
	["transform.positionY", "y", 0],
	["transform.scaleX", "scale_x", 1],
	["transform.scaleY", "scale_y", 1],
	["transform.rotate", "rotation", 0],
	["opacity", "opacity", 1],
];
const FRIENDLY_PATH: Record<string, string> = {
	"transform.positionX": "x",
	"transform.positionY": "y",
	"transform.scaleX": "scale_x",
	"transform.scaleY": "scale_y",
	"transform.rotate": "rotation",
	opacity: "opacity",
	volume: "volume",
};

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const startOf = (element: SnapshotElement) => num(element.startTime) ?? 0;
const durOf = (element: SnapshotElement) => num(element.duration) ?? 0;

/** x · y (canvas px from the centre, y down) · scale_x · scale_y (1 = 100 %) · rotation (degrees) · opacity (0–1). */
export function transformOf(element: SnapshotElement, { all = false }: { all?: boolean } = {}): Record<string, number> | null {
	if (!VISUAL.has(element.type)) return null;
	const params = (element.params ?? {}) as Record<string, unknown>;
	const out: Record<string, number> = {};
	for (const [key, name, fallback] of TRANSFORM_KEYS) {
		const value = num(params[key]) ?? fallback;
		if (all || value !== fallback) out[name] = value;
	}
	if (!all && out.scale_x !== undefined && out.scale_x === out.scale_y) {
		out.scale = out.scale_x;
		delete out.scale_x;
		delete out.scale_y;
	}
	return Object.keys(out).length ? out : null;
}

interface RawKey {
	id?: string;
	time?: number;
	value?: unknown;
	segmentToNext?: string;
	tangentMode?: string;
	leftHandle?: { dt?: number; dv?: number };
	rightHandle?: { dt?: number; dv?: number };
}

function channelsOf(animations: unknown): Array<[string, RawKey[]]> {
	if (!animations || typeof animations !== "object") return [];
	const out: Array<[string, RawKey[]]> = [];
	for (const [path, data] of Object.entries(animations as Record<string, unknown>)) {
		if (!data || typeof data !== "object") continue;
		const keys = (data as { keys?: unknown }).keys;
		if (Array.isArray(keys)) {
			if (keys.length) out.push([path, keys as RawKey[]]);
			continue;
		}
		for (const [sub, channel] of Object.entries(data as Record<string, unknown>)) {
			const subKeys = (channel as { keys?: unknown } | null)?.keys;
			if (Array.isArray(subKeys) && subKeys.length) out.push([`${path}.${sub}`, subKeys as RawKey[]]);
		}
	}
	return out;
}

/** {prop: number of keyframes} with friendly names (x, y, scale_x, opacity…). */
export function keyframeCounts(element: SnapshotElement): Record<string, number> | null {
	const channels = channelsOf(element.animations);
	if (!channels.length) return null;
	return Object.fromEntries(channels.map(([path, keys]) => [FRIENDLY_PATH[path] ?? path, keys.length]));
}

/** Keyframes in seconds: t = seconds from the element's start, at = timeline seconds (what keyframe ops take). */
export function keyframesOf(element: SnapshotElement) {
	const start = startOf(element);
	const channels = channelsOf(element.animations);
	if (!channels.length) return null;
	return Object.fromEntries(
		channels.map(([path, keys]) => [
			FRIENDLY_PATH[path] ?? path,
			{
				param: path,
				keys: keys.map((key) => {
					const time = num(key.time) ?? 0;
					return {
						t: exactSeconds(time),
						at: exactSeconds(start + time),
						value: key.value,
						...(key.segmentToNext ? { to_next: key.segmentToNext } : {}),
						...(key.leftHandle ? { left_handle: { dt_s: exactSeconds(num(key.leftHandle.dt) ?? 0), dv: key.leftHandle.dv ?? 0 } } : {}),
						...(key.rightHandle ? { right_handle: { dt_s: exactSeconds(num(key.rightHandle.dt) ?? 0), dv: key.rightHandle.dv ?? 0 } } : {}),
						...(key.id ? { id: key.id } : {}),
						time_ticks: time,
					};
				}),
			},
		]),
	);
}

function compositionOf(element: SnapshotElement): { name?: string; custom?: boolean } | null {
	return ((element.restorff as Record<string, unknown> | undefined)?.composition as { name?: string; custom?: boolean } | undefined) ?? null;
}

/** The compact view `summary` lists: what timeline_ops needs to address and place things. */
export function compactElement(element: SnapshotElement) {
	const params = (element.params ?? {}) as Record<string, unknown>;
	const text = typeof params.content === "string" ? params.content : undefined;
	const composition = compositionOf(element);
	const restorff = (element.restorff ?? {}) as Record<string, unknown>;
	const start = startOf(element);
	const dur = durOf(element);
	const trimStart = num(element.trimStart);
	const transform = transformOf(element);
	const keyframes = keyframeCounts(element);
	const transition = element.transitionIn as { type?: string; duration?: number } | undefined;
	return {
		id: element.id,
		type: element.type,
		name: element.name ?? null,
		t: exactSeconds(start),
		dur: exactSeconds(dur),
		end: exactSeconds(start + dur),
		...(trimStart ? { in: exactSeconds(trimStart) } : {}),
		...(element.mediaId ? { media: element.mediaId } : {}),
		...(text !== undefined ? { text: text.length > 80 ? `${text.slice(0, 77)}…` : text } : {}),
		...(composition?.name ? { composition: composition.name } : {}),
		...(composition?.custom === true ? { code: true } : {}),
		...(typeof element.effectType === "string" ? { effect: element.effectType } : {}),
		...(typeof restorff.captionLayer === "string" ? { caption_layer: restorff.captionLayer } : {}),
		...(transform ? { transform } : {}),
		...(keyframes ? { keyframes } : {}),
		...(transition?.type ? { transition_in: { kind: transition.type, dur: exactSeconds(num(transition.duration) ?? 0) } } : {}),
		...(element.hidden ? { hidden: true } : {}),
		...(typeof restorff.author === "string" ? { author: restorff.author } : {}),
	};
}

const LONG_TEXT = 6_000;
const TIME_KEYS = new Set(["id", "type", "name", "startTime", "duration", "trimStart", "trimEnd", "sourceDuration", "mediaId", "animations", "transitionIn", "hidden", "params", "restorff"]);

/** Long code inside restorff.composition: summarized (composition get returns it whole). */
function restorffView(restorff: unknown) {
	if (!restorff || typeof restorff !== "object") return restorff ?? null;
	const out: Record<string, unknown> = { ...(restorff as Record<string, unknown>) };
	const composition = out.composition as Record<string, unknown> | undefined;
	if (composition && typeof composition.source === "string" && composition.source.length > LONG_TEXT) {
		out.composition = {
			...composition,
			source: { omitted: "composition source", chars: composition.source.length, head: composition.source.slice(0, 160), read_with: "composition get {timeline_id, element_id}" },
		};
	}
	return out;
}

/** One element in full: params, transforms, keyframes in seconds, exact times in seconds AND ticks. */
export function fullElement(element: SnapshotElement) {
	const start = startOf(element);
	const dur = durOf(element);
	const trimStart = num(element.trimStart);
	const trimEnd = num(element.trimEnd);
	const sourceDuration = num(element.sourceDuration);
	const transition = element.transitionIn as { type?: string; duration?: number } | undefined;
	const rest = Object.fromEntries(Object.entries(element).filter(([key]) => !TIME_KEYS.has(key)));
	return {
		id: element.id,
		type: element.type,
		name: element.name ?? null,
		t: exactSeconds(start),
		dur: exactSeconds(dur),
		end: exactSeconds(start + dur),
		...(trimStart !== null ? { in: exactSeconds(trimStart) } : {}),
		...(trimEnd !== null ? { trim_end: exactSeconds(trimEnd) } : {}),
		...(sourceDuration !== null ? { source_dur: exactSeconds(sourceDuration) } : {}),
		start_ticks: start,
		duration_ticks: dur,
		...(trimStart !== null ? { trim_start_ticks: trimStart } : {}),
		...(trimEnd !== null ? { trim_end_ticks: trimEnd } : {}),
		...(element.mediaId ? { media: element.mediaId } : {}),
		...(element.hidden !== undefined ? { hidden: element.hidden } : {}),
		transform: transformOf(element, { all: true }),
		keyframes: keyframesOf(element),
		...(transition?.type ? { transition_in: { kind: transition.type, dur: exactSeconds(num(transition.duration) ?? 0), duration_ticks: num(transition.duration) ?? 0 } } : {}),
		params: element.params ?? {},
		restorff: restorffView(element.restorff),
		...rest,
	};
}

// ─── selection + paging ─────────────────────────────────────────────────────────────────────────────────────────

export interface ReadFilter {
	/** A track id or name. */
	track?: string;
	element_ids?: string[];
	/** Elements overlapping [from_s, to_s) in timeline seconds. */
	from_s?: number;
	to_s?: number;
	/** Where the page starts in the filtered list (next_offset of the page before). */
	offset?: number;
}

export interface Selection {
	items: Array<{ ref: TrackRef; element: SnapshotElement }>;
	track: TrackRef | null;
	problem?: { code: string; message: string; candidates?: ReturnType<typeof trackLabel>[] };
}

export function selectElements(snapshot: ProjectSnapshot, filter: ReadFilter): Selection {
	let tracks = tracksOf(snapshot);
	let only: TrackRef | null = null;
	if (filter.track) {
		const found = resolveTrackStrict(snapshot, filter.track);
		if (!found.match) {
			return {
				items: [],
				track: null,
				problem: found.ambiguous.length
					? { code: "ambiguous_track", message: `"${filter.track}" matches ${found.ambiguous.length} tracks: pass one of their ids.`, candidates: found.ambiguous.map(trackLabel) }
					: { code: "unknown_track", message: `No track "${filter.track}" on this timeline.`, candidates: tracks.map(trackLabel) },
			};
		}
		only = found.match;
		tracks = [found.match];
	}
	const ids = filter.element_ids?.length ? new Set(filter.element_ids) : null;
	const from = typeof filter.from_s === "number" ? Math.round(filter.from_s * TICKS_PER_SECOND) : null;
	const to = typeof filter.to_s === "number" ? Math.round(filter.to_s * TICKS_PER_SECOND) : null;
	const items: Selection["items"] = [];
	for (const ref of tracks) {
		const elements = [...(ref.track.elements ?? [])].sort((a, b) => startOf(a) - startOf(b));
		for (const element of elements) {
			if (ids && !ids.has(element.id)) continue;
			if (from !== null && startOf(element) + durOf(element) <= from) continue;
			if (to !== null && startOf(element) >= to) continue;
			items.push({ ref, element });
		}
	}
	return { items, track: only };
}

/**
 * Greedy packing: views in order from `offset` until the next one would pass `budget` chars (always at least one).
 * Each view is scrubbed of data: URLs first, so the measure is the size the model will actually receive.
 */
export function pack<T>(views: T[], budget: number, offset = 0, measure: (item: T) => unknown = (item) => item): { chunk: T[]; chars: number; nextOffset: number | null } {
	const chunk: T[] = [];
	let chars = 0;
	let i = Math.max(0, Math.min(offset, views.length));
	for (; i < views.length; i++) {
		const size = JSON.stringify(measure(views[i])).length + 1;
		if (chunk.length && chars + size > budget) break;
		chunk.push(views[i]);
		chars += size;
	}
	return { chunk, chars, nextOffset: i < views.length ? i : null };
}

function canvasOf(snapshot: ProjectSnapshot) {
	const fps = snapshot.settings?.fps;
	return {
		w: snapshot.settings?.canvasSize?.width ?? null,
		h: snapshot.settings?.canvasSize?.height ?? null,
		fps: typeof fps === "number" ? fps : fps ? Math.round((fps.numerator / fps.denominator) * 1000) / 1000 : null,
	};
}

function durationTicks(snapshot: ProjectSnapshot): number {
	let end = 0;
	for (const { track } of tracksOf(snapshot)) for (const element of track.elements ?? []) end = Math.max(end, startOf(element) + durOf(element));
	return end;
}

function trackHeader(ref: TrackRef) {
	const { track, group, index } = ref;
	return {
		id: track.id,
		index,
		group,
		name: track.name ?? null,
		type: track.type,
		...(track.restorff?.role ? { role: track.restorff.role } : {}),
		...(track.hidden ? { hidden: true } : {}),
		...(track.muted ? { muted: true } : {}),
		count: track.elements?.length ?? 0,
	};
}

const filterEcho = (filter: ReadFilter) =>
	Object.fromEntries(Object.entries({ track: filter.track, element_ids: filter.element_ids, from_s: filter.from_s, to_s: filter.to_s }).filter(([, value]) => value !== undefined));

export const SUMMARY_UNITS =
	"seconds, exact to the tick (6 decimals: use them as they are); t = timeline start, dur = length, end = t + dur, in = source in-point; transform: x / y = canvas px from the centre (y down), scale 1 = 100 %, rotation in degrees, opacity 0–1; keyframes = keys per property; main = the A-roll track; ticks (120,000 per second) only in fields named *_ticks";

/**
 * The summary: every track (top to bottom) with its elements in compact form. When everything fits under `limit`
 * chars it is one page (no `page` field); otherwise it pages with `offset` (page.next_offset).
 */
export function summaryView(snapshot: ProjectSnapshot, filter: ReadFilter = {}, limit = SUMMARY_LIMIT_CHARS) {
	const selection = selectElements(snapshot, filter);
	if (selection.problem) return { problem: selection.problem };
	const tracks = selection.track ? [selection.track] : tracksOf(snapshot);
	const restorff = (snapshot.metadata.restorff ?? {}) as { pending?: unknown[] };
	const envelope = {
		name: snapshot.metadata.name,
		canvas: canvasOf(snapshot),
		duration_s: exactSeconds(durationTicks(snapshot)),
		scene: (() => {
			const scene = activeScene(snapshot);
			return scene ? { id: scene.id, name: scene.name ?? null } : null;
		})(),
		pending_instructions: Array.isArray(restorff.pending) ? restorff.pending.length : 0,
		units: SUMMARY_UNITS,
	};
	const headers = tracks.map(trackHeader);
	const views = selection.items.map(({ ref, element }) => ({ track: ref.track.id, view: scrubData(compactElement(element)).value }));
	const budget = Math.max(8_000, limit - JSON.stringify({ envelope, headers }).length - 1_500);
	const { chunk, nextOffset } = pack(views, budget, filter.offset ?? 0, (item) => item.view);
	const byTrack = new Map<string, unknown[]>();
	for (const item of chunk) byTrack.set(item.track, [...(byTrack.get(item.track) ?? []), item.view]);
	const offset = Math.max(0, filter.offset ?? 0);
	const filtered = Object.keys(filterEcho(filter)).length > 0;
	const paged = filtered || offset > 0 || nextOffset !== null;
	return {
		summary: {
			...envelope,
			tracks: headers.map((header) => ({ ...header, elements: byTrack.get(header.id) ?? [] })),
			...(paged
				? {
						page: {
							...filterEcho(filter),
							offset,
							returned: chunk.length,
							total: views.length,
							next_offset: nextOffset,
							note: "Elements are listed track by track (top lane first), by start time; pass next_offset as offset for the rest.",
						},
					}
				: {}),
		},
		nextOffset,
	};
}

/** The media this project knows (manifest), compact, seconds. */
export function mediaList(snapshot: ProjectSnapshot) {
	const restorff = (snapshot.metadata.restorff ?? {}) as { media?: Array<Record<string, unknown>> };
	return (restorff.media ?? []).map((entry) => ({
		id: entry.id,
		kind: entry.kind ?? null,
		name: entry.name ?? null,
		...(typeof entry.duration === "number" ? { duration_s: exactSeconds(entry.duration) } : {}),
		...(entry.width ? { w: entry.width, h: entry.height } : {}),
		...(entry.fps ? { fps: entry.fps } : {}),
		...(typeof entry.hasAudio === "boolean" ? { has_audio: entry.hasAudio } : {}),
	}));
}

/** A page of full elements (the paged `timeline get`). */
export function pageView(snapshot: ProjectSnapshot, filter: ReadFilter = {}, limit = PAGE_LIMIT_CHARS) {
	const selection = selectElements(snapshot, filter);
	if (selection.problem) return { problem: selection.problem };
	const offset = Math.max(0, filter.offset ?? 0);
	const envelope = {
		name: snapshot.metadata.name,
		canvas: canvasOf(snapshot),
		settings: snapshot.settings ?? null,
		duration_s: exactSeconds(durationTicks(snapshot)),
		...(offset === 0 ? { media: mediaList(snapshot) } : {}),
		units: SUMMARY_UNITS,
	};
	const headers = (selection.track ? [selection.track] : tracksOf(snapshot)).map(trackHeader);
	const views = selection.items.map(({ ref, element }) => ({ track: ref.track.id, view: scrubData(fullElement(element)).value }));
	const budget = Math.max(8_000, limit - JSON.stringify({ envelope, headers }).length - 2_000);
	const { chunk, nextOffset } = pack(views, budget, offset, (item) => item.view);
	const byTrack = new Map<string, unknown[]>();
	for (const item of chunk) byTrack.set(item.track, [...(byTrack.get(item.track) ?? []), item.view]);
	return {
		page: {
			...envelope,
			tracks: headers.filter((header) => byTrack.has(header.id) || selection.track).map((header) => ({ ...header, elements: byTrack.get(header.id) ?? [] })),
			page: { ...filterEcho(filter), offset, returned: chunk.length, total: views.length, next_offset: nextOffset },
			...(offset === 0 ? {} : { media_note: "the media list is on the first page (offset 0)" }),
		},
		nextOffset,
	};
}

/** One element in full + where it sits + ops a model can copy with its exact numbers. */
export function elementView(snapshot: ProjectSnapshot, elementId: string) {
	for (const ref of tracksOf(snapshot)) {
		const elements = [...(ref.track.elements ?? [])].sort((a, b) => startOf(a) - startOf(b));
		const position = elements.findIndex((element) => element.id === elementId);
		if (position < 0) continue;
		const element = elements[position];
		const before = elements[position - 1];
		const after = elements[position + 1];
		const neighbour = (other: SnapshotElement | undefined, gapTicks: number) =>
			other ? { id: other.id, name: other.name ?? null, t: exactSeconds(startOf(other)), end: exactSeconds(startOf(other) + durOf(other)), gap_s: exactSeconds(gapTicks) } : null;
		const t = exactSeconds(startOf(element));
		const end = exactSeconds(startOf(element) + durOf(element));
		const transform = transformOf(element, { all: true });
		const ops: Array<Record<string, unknown>> = [{ op: "move", el: element.id, t }];
		if ((element.type === "video" || element.type === "audio") && typeof element.trimStart === "number") {
			const inS = exactSeconds(element.trimStart);
			ops.push({ op: "trim", el: element.id, in: inS, out: exactSeconds(element.trimStart + durOf(element)) });
		}
		ops.push({ op: "split", el: element.id, t: exactSeconds(startOf(element) + durOf(element) / 2) });
		if (transform) {
			ops.push({ op: "set", el: element.id, prop: "y", value: transform.y });
			ops.push({ op: "keyframe", el: element.id, prop: "scale", t, value: transform.scale_x }, { op: "keyframe", el: element.id, prop: "scale", t: end, value: Math.round(transform.scale_x * 110) / 100 });
		}
		const params = (element.params ?? {}) as Record<string, unknown>;
		if (typeof params.content === "string") ops.push({ op: "set", el: element.id, prop: "text", value: params.content });
		if (element.type === "audio" || element.type === "video") ops.push({ op: "gain", el: element.id, db: num(params.volume) ?? 0 });
		ops.push({ op: "delete", el: element.id });
		return {
			element: scrubData(fullElement(element)).value,
			track: trackLabel(ref),
			before: neighbour(before, before ? startOf(element) - (startOf(before) + durOf(before)) : 0),
			after: neighbour(after, after ? startOf(after) - (startOf(element) + durOf(element)) : 0),
			op_templates: ops,
			op_templates_note:
				"Each template carries this element's exact numbers (most change nothing as they are): change the value you mean, then send it with timeline_ops (dry_run first). The keyframe pair grows it 10 % over its length.",
		};
	}
	return null;
}

/** Element ids nearest a missing one (same prefix), for a helpful not_found. */
export function similarIds(snapshot: ProjectSnapshot, wanted: string, max = 5): string[] {
	const head = wanted.slice(0, 4);
	const out: string[] = [];
	for (const { track } of tracksOf(snapshot)) for (const element of track.elements ?? []) if (head && element.id.startsWith(head)) out.push(element.id);
	return out.slice(0, max);
}
