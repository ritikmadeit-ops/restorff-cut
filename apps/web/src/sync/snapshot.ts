/**
 * Pure helpers over a project snapshot (the editor's SerializedProject JSON, as a
 * commit stores it). Used by the server (hashing, diff summaries, pinning
 * comments) and the browser (change detection, the review player). No imports,
 * no clock, no DOM: safe on both sides.
 *
 * Times in a snapshot are integer ticks (120 000 per second, wasm MediaTime).
 */

export const TICKS_PER_SECOND = 120_000;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface SnapshotElement {
	id: string;
	type: string;
	name?: string;
	startTime: number;
	duration: number;
	trimStart?: number;
	trimEnd?: number;
	mediaId?: string;
	hidden?: boolean;
	params?: Record<string, unknown>;
	restorff?: { author?: string; role?: string };
	[key: string]: unknown;
}

export interface SnapshotTrack {
	id: string;
	name?: string;
	type: string;
	elements: SnapshotElement[];
	hidden?: boolean;
	muted?: boolean;
	restorff?: { role?: string };
	[key: string]: unknown;
}

export interface SnapshotScene {
	id: string;
	name?: string;
	isMain?: boolean;
	tracks?: {
		overlay?: SnapshotTrack[];
		main?: SnapshotTrack;
		audio?: SnapshotTrack[];
	};
	bookmarks?: unknown[];
	[key: string]: unknown;
}

export interface ProjectSnapshot {
	metadata: {
		id: string;
		name: string;
		thumbnail?: string;
		duration?: number;
		createdAt?: string;
		updatedAt?: string;
		restorff?: unknown;
		[key: string]: unknown;
	};
	scenes: SnapshotScene[];
	currentSceneId?: string;
	settings?: {
		fps?: { numerator: number; denominator: number } | number;
		canvasSize?: { width: number; height: number };
		[key: string]: unknown;
	};
	version?: number;
	timelineViewState?: unknown;
	[key: string]: unknown;
}

/** A track in display order (top to bottom), with the group it lives in. */
export interface OrderedTrack {
	track: SnapshotTrack;
	group: "overlay" | "main" | "audio";
}

export function isProjectSnapshot(value: unknown): value is ProjectSnapshot {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	const metadata = v.metadata as Record<string, unknown> | undefined;
	return (
		!!metadata &&
		typeof metadata === "object" &&
		typeof metadata.id === "string" &&
		Array.isArray(v.scenes)
	);
}

/** JSON with object keys sorted, undefined dropped: equal data, equal string. */
export function stableStringify(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		if (value instanceof Date) return value.toISOString();
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const child = (value as Record<string, unknown>)[key];
			if (child === undefined || typeof child === "function") continue;
			out[key] = sortKeys(child);
		}
		return out;
	}
	return value;
}

/**
 * The part of a snapshot that counts as "the cut": drops fields that change
 * without an edit — save and creation times (project AND scene), the thumbnail,
 * the duration (derived from the elements on every save), and the timeline's
 * scroll/zoom view state. Hash this, not the raw snapshot.
 *
 * ui-fix-timeline (QA 2026-10-20 #3): `scenes[].updatedAt` used to count, and the
 * editor bumps it when it rewrites a scene's tracks without changing them (open,
 * select), so browsing pushed "edit: no changes to the cut" commits (MEASURED on
 * the explainer recreation: 07a8480 vs 28cb786 differ in scenes.0.updatedAt,
 * metadata.updatedAt and timelineViewState only).
 */
export function hashView(snapshot: ProjectSnapshot): unknown {
	const { timelineViewState: _view, ...rest } = snapshot;
	const {
		updatedAt: _updated,
		createdAt: _created,
		thumbnail: _thumb,
		duration: _duration,
		...metadata
	} = snapshot.metadata ?? ({} as ProjectSnapshot["metadata"]);
	const scenes = Array.isArray(snapshot.scenes)
		? snapshot.scenes.map((scene) => {
				if (!scene || typeof scene !== "object") return scene;
				const { updatedAt: _sceneUpdated, createdAt: _sceneCreated, ...sceneRest } = scene;
				return sceneRest;
			})
		: snapshot.scenes;
	return { ...rest, metadata, scenes };
}

/**
 * Removes what should never travel in a commit: the base64 thumbnail and the
 * UI scroll state. Returns a new object.
 */
export function stripForCommit(snapshot: ProjectSnapshot): ProjectSnapshot {
	const clone = JSON.parse(JSON.stringify(snapshot)) as ProjectSnapshot;
	delete clone.metadata.thumbnail;
	delete clone.timelineViewState;
	return clone;
}

/** cyrb53: a fast 53-bit string hash for change detection (not a security hash). */
export function quickHash(input: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < input.length; i++) {
		const ch = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
	return n.toString(16).padStart(14, "0");
}

/** Change-detection fingerprint of a snapshot (same cut → same string). */
export function snapshotFingerprint(snapshot: ProjectSnapshot): string {
	return quickHash(stableStringify(hashView(snapshot)));
}

/**
 * Has the cut changed? True only when the local copy differs from BOTH the last
 * synced fingerprint and the base commit's cut. Either alone can be stale: the
 * synced fingerprint may come from an older `hashView` (stored in localStorage) or
 * from a copy taken before the editor normalised it; the base snapshot may be
 * missing or serialised differently. A commit is pushed only when both say "changed".
 */
export function cutChanged({
	local,
	syncedFingerprint,
	baseFingerprint,
}: {
	local: ProjectSnapshot;
	/** The fingerprint recorded at the last sync (localStorage), or null. */
	syncedFingerprint: string | null;
	/** snapshotFingerprint of the base commit's snapshot, or null when it is not loaded. */
	baseFingerprint: string | null;
}): boolean {
	const fingerprint = snapshotFingerprint(local);
	if (syncedFingerprint !== null && fingerprint === syncedFingerprint) return false;
	if (baseFingerprint !== null && fingerprint === baseFingerprint) return false;
	return true;
}

export function mainScene(snapshot: ProjectSnapshot): SnapshotScene | null {
	const scenes = snapshot.scenes ?? [];
	return (
		scenes.find((s) => s.id === snapshot.currentSceneId) ??
		scenes.find((s) => s.isMain) ??
		scenes[0] ??
		null
	);
}

export function orderedTracks(scene: SnapshotScene | null): OrderedTrack[] {
	if (!scene?.tracks) return [];
	const out: OrderedTrack[] = [];
	for (const track of scene.tracks.overlay ?? []) out.push({ track, group: "overlay" });
	if (scene.tracks.main) out.push({ track: scene.tracks.main, group: "main" });
	for (const track of scene.tracks.audio ?? []) out.push({ track, group: "audio" });
	return out;
}

export function ticksToSeconds(ticks: number): number {
	return ticks / TICKS_PER_SECOND;
}

export function secondsToTicks(seconds: number): number {
	const scaled = seconds * TICKS_PER_SECOND;
	const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
	return Object.is(rounded, -0) ? 0 : rounded;
}

export interface SnapshotStats {
	durationS: number;
	trackCount: number;
	elementCount: number;
}

export function snapshotStats(snapshot: ProjectSnapshot): SnapshotStats {
	const tracks = orderedTracks(mainScene(snapshot));
	let end = 0;
	let elements = 0;
	for (const { track } of tracks) {
		for (const el of track.elements ?? []) {
			elements++;
			end = Math.max(end, (el.startTime ?? 0) + (el.duration ?? 0));
		}
	}
	return {
		durationS: Math.round(ticksToSeconds(end) * 1000) / 1000,
		trackCount: tracks.length,
		elementCount: elements,
	};
}

// ─── Diff summary (ported idea: OpenCut-AI change-summary) ────────────────

export interface DiffSummary {
	tracksAdded: number;
	tracksRemoved: number;
	elementsAdded: number;
	elementsRemoved: number;
	elementsModified: number;
	settingsChanged: boolean;
	renamed: boolean;
	/** Up to 8 short lines: "+ text 'ONE POUR.' on TEXT", "~ S19 moved". */
	lines: string[];
}

export const EMPTY_DIFF: DiffSummary = {
	tracksAdded: 0,
	tracksRemoved: 0,
	elementsAdded: 0,
	elementsRemoved: 0,
	elementsModified: 0,
	settingsChanged: false,
	renamed: false,
	lines: [],
};

function indexElements(snapshot: ProjectSnapshot | null) {
	const tracks = new Map<string, SnapshotTrack>();
	const elements = new Map<string, { el: SnapshotElement; track: SnapshotTrack }>();
	if (!snapshot) return { tracks, elements };
	for (const scene of snapshot.scenes ?? []) {
		for (const { track } of orderedTracks(scene)) {
			tracks.set(track.id, track);
			for (const el of track.elements ?? []) elements.set(el.id, { el, track });
		}
	}
	return { tracks, elements };
}

function label(el: SnapshotElement): string {
	if (el.type === "text") {
		const content = el.params?.content;
		if (typeof content === "string" && content.trim()) {
			const short = content.trim().replace(/\s+/g, " ");
			return `text '${short.length > 24 ? `${short.slice(0, 23)}…` : short}'`;
		}
	}
	return el.name ? `${el.type} '${el.name}'` : el.type;
}

function describeChange(before: SnapshotElement, after: SnapshotElement): string {
	const what: string[] = [];
	if (before.startTime !== after.startTime) what.push("moved");
	if (
		before.duration !== after.duration ||
		before.trimStart !== after.trimStart ||
		before.trimEnd !== after.trimEnd
	) {
		what.push("trimmed");
	}
	if (stableStringify(before.params) !== stableStringify(after.params)) what.push("restyled");
	if (stableStringify(before.animations) !== stableStringify(after.animations)) {
		what.push("keyframed");
	}
	if (what.length === 0) what.push("changed");
	return what.join(", ");
}

export function diffSnapshots(
	before: ProjectSnapshot | null,
	after: ProjectSnapshot,
): DiffSummary {
	const a = indexElements(before);
	const b = indexElements(after);
	const summary: DiffSummary = { ...EMPTY_DIFF, lines: [] };
	const lines: string[] = [];

	for (const [id, track] of b.tracks) {
		if (!a.tracks.has(id)) {
			summary.tracksAdded++;
			lines.push(`+ track ${track.name ?? track.type}`);
		}
	}
	for (const [id, track] of a.tracks) {
		if (!b.tracks.has(id)) {
			summary.tracksRemoved++;
			lines.push(`- track ${track.name ?? track.type}`);
		}
	}
	for (const [id, { el, track }] of b.elements) {
		const prev = a.elements.get(id);
		if (!prev) {
			summary.elementsAdded++;
			lines.push(`+ ${label(el)} on ${track.name ?? track.type}`);
		} else if (stableStringify(prev.el) !== stableStringify(el)) {
			summary.elementsModified++;
			lines.push(`~ ${label(el)} ${describeChange(prev.el, el)}`);
		}
	}
	for (const [id, { el, track }] of a.elements) {
		if (!b.elements.has(id)) {
			summary.elementsRemoved++;
			lines.push(`- ${label(el)} from ${track.name ?? track.type}`);
		}
	}
	if (before) {
		summary.settingsChanged =
			stableStringify(before.settings) !== stableStringify(after.settings);
		summary.renamed = before.metadata?.name !== after.metadata?.name;
		if (summary.settingsChanged) lines.push("~ project settings");
		if (summary.renamed) lines.push(`~ renamed to '${after.metadata?.name}'`);
	}
	summary.lines = lines.slice(0, 8);
	if (lines.length > 8) summary.lines.push(`… ${lines.length - 8} more`);
	return summary;
}

/** "+2 elements · 3 changed · -1 track", or "no changes to the cut". */
export function describeDiff(summary: DiffSummary | null | undefined): string {
	if (!summary) return "";
	const parts: string[] = [];
	const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
	if (summary.elementsAdded) parts.push(`+${n(summary.elementsAdded, "element")}`);
	if (summary.elementsRemoved) parts.push(`-${n(summary.elementsRemoved, "element")}`);
	if (summary.elementsModified) parts.push(`${summary.elementsModified} changed`);
	if (summary.tracksAdded) parts.push(`+${n(summary.tracksAdded, "track")}`);
	if (summary.tracksRemoved) parts.push(`-${n(summary.tracksRemoved, "track")}`);
	if (summary.settingsChanged) parts.push("settings");
	if (summary.renamed) parts.push("renamed");
	return parts.length ? parts.join(" · ") : "no changes to the cut";
}

/** 0:08 · 1:02.40 — mono timecodes for markers and comment lists. */
export function formatTimecode(seconds: number, withHundredths = false): string {
	const safe = Math.max(0, seconds);
	const m = Math.floor(safe / 60);
	const s = Math.floor(safe % 60);
	const base = `${m}:${String(s).padStart(2, "0")}`;
	if (!withHundredths) return base;
	const hundredths = Math.floor((safe % 1) * 100);
	return `${base}.${String(hundredths).padStart(2, "0")}`;
}
