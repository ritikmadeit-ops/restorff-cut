/**
 * A compact, Claude-readable view of a project snapshot: canvas, length, tracks top to bottom with every element's
 * id and times in seconds (what `timeline_ops` needs to address things), and the media the project uses.
 */
import type { ProjectSnapshot, SnapshotElement, SnapshotScene, SnapshotTrack } from "@/sync/snapshot";

const TICKS = 120_000;
const MAX_ELEMENTS_PER_TRACK = 150;
const s = (ticks: unknown) => (typeof ticks === "number" ? Math.round((ticks / TICKS) * 1000) / 1000 : null);

function activeScene(snapshot: ProjectSnapshot): SnapshotScene | null {
	const scenes = snapshot.scenes ?? [];
	return scenes.find((scene) => scene.id === snapshot.currentSceneId) ?? scenes.find((scene) => scene.isMain) ?? scenes[0] ?? null;
}

function orderedTracks(scene: SnapshotScene | null): Array<{ group: "overlay" | "main" | "audio"; track: SnapshotTrack }> {
	if (!scene?.tracks) return [];
	return [
		...(scene.tracks.overlay ?? []).map((track) => ({ group: "overlay" as const, track })),
		...(scene.tracks.main ? [{ group: "main" as const, track: scene.tracks.main }] : []),
		...(scene.tracks.audio ?? []).map((track) => ({ group: "audio" as const, track })),
	];
}

function elementView(element: SnapshotElement) {
	const params = (element.params ?? {}) as Record<string, unknown>;
	const text = typeof params.content === "string" ? params.content : undefined;
	const stored = (element.restorff as { composition?: { name?: string; custom?: boolean } } | undefined)?.composition;
	const composition = stored?.name;
	// custom compositions (motion-code) carry their code: `composition get` reads it, `composition update` changes it
	const code = stored?.custom === true;
	return {
		id: element.id,
		type: element.type,
		name: element.name ?? null,
		t: s(element.startTime),
		dur: s(element.duration),
		...(typeof element.trimStart === "number" && element.trimStart ? { in: s(element.trimStart) } : {}),
		...(element.mediaId ? { media: element.mediaId } : {}),
		...(text !== undefined ? { text: text.length > 80 ? `${text.slice(0, 77)}…` : text } : {}),
		...(composition ? { composition } : {}),
		...(code ? { code: true } : {}),
		...(element.hidden ? { hidden: true } : {}),
		...(element.restorff?.author ? { author: element.restorff.author } : {}),
	};
}

export function summarizeSnapshot(snapshot: ProjectSnapshot | null) {
	if (!snapshot) return null;
	const scene = activeScene(snapshot);
	const tracks = orderedTracks(scene);
	let end = 0;
	for (const { track } of tracks) for (const element of track.elements ?? []) end = Math.max(end, element.startTime + element.duration);
	const fps = snapshot.settings?.fps;
	const restorff = (snapshot.metadata.restorff ?? {}) as { pending?: unknown[] };
	return {
		name: snapshot.metadata.name,
		canvas: {
			w: snapshot.settings?.canvasSize?.width ?? null,
			h: snapshot.settings?.canvasSize?.height ?? null,
			fps: typeof fps === "number" ? fps : fps ? Math.round((fps.numerator / fps.denominator) * 1000) / 1000 : null,
		},
		duration_s: s(end),
		scene: scene ? { id: scene.id, name: scene.name ?? null } : null,
		tracks: tracks.map(({ group, track }) => ({
			id: track.id,
			group,
			name: track.name ?? null,
			type: track.type,
			...(track.restorff?.role ? { role: track.restorff.role } : {}),
			...(track.hidden ? { hidden: true } : {}),
			...(track.muted ? { muted: true } : {}),
			count: track.elements?.length ?? 0,
			elements: (track.elements ?? []).slice(0, MAX_ELEMENTS_PER_TRACK).map(elementView),
			...((track.elements?.length ?? 0) > MAX_ELEMENTS_PER_TRACK ? { truncated: true } : {}),
		})),
		pending_instructions: Array.isArray(restorff.pending) ? restorff.pending.length : 0,
		units: "seconds; t = timeline start, dur = length, in = source in-point; main = the A-roll track",
	};
}

/** Media the project knows about: the ops manifest (metadata.restorff.media) plus every media id clips play. */
export function mediaOf(snapshot: ProjectSnapshot | null) {
	if (!snapshot) return { manifest: [], used: [] };
	const restorff = (snapshot.metadata.restorff ?? {}) as { media?: Array<Record<string, unknown>> };
	const manifest = (restorff.media ?? []).map((entry) => ({
		...entry,
		...(typeof entry.duration === "number" ? { duration_s: s(entry.duration) } : {}),
	}));
	const used = new Map<string, { media: string; kinds: Set<string>; elements: number; names: Set<string> }>();
	for (const scene of snapshot.scenes ?? []) {
		for (const { track } of orderedTracks(scene)) {
			for (const element of track.elements ?? []) {
				if (!element.mediaId) continue;
				const entry = used.get(element.mediaId) ?? { media: element.mediaId, kinds: new Set(), elements: 0, names: new Set() };
				entry.kinds.add(element.type);
				entry.elements += 1;
				if (element.name && entry.names.size < 3) entry.names.add(element.name);
				used.set(element.mediaId, entry);
			}
		}
	}
	return {
		manifest,
		used: [...used.values()].map((entry) => ({ media: entry.media, kinds: [...entry.kinds], elements: entry.elements, names: [...entry.names] })),
	};
}

/** The snapshot without heavy fields Claude never needs (the thumbnail data URL, the timeline view state). */
export function slimSnapshot(snapshot: ProjectSnapshot | null): ProjectSnapshot | null {
	if (!snapshot) return null;
	const { timelineViewState: _view, ...rest } = snapshot;
	const { thumbnail: _thumb, ...metadata } = snapshot.metadata;
	return { ...rest, metadata } as ProjectSnapshot;
}
