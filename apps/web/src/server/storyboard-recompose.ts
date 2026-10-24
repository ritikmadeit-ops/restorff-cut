/**
 * Re-render compositions in place, several in ONE commit (revise-v2 agent, 2026-10-20; SUMMARY gap 2: "make the titles
 * bigger" was 22 commits, library compositions answered not_custom). Used by MCP `revise` (through commitAsClaude in
 * ./storyboard.ts) and `composition update {element_ids[] | updates[]}` (../mcp/composition.ts).
 *
 *   custom composition   its own source + the new props → packages/compositions custom render (network blocked)
 *   library composition  the library's source by name + the new props → the library render (the Motion view's
 *                        CompositionSource record keeps working); a new `source` makes it a custom one (its code now
 *                        travels in the clip)
 *
 * Each render lands in the project's media store under a new media id (an `import_media` op in the same batch); the
 * clip keeps its id, track and start; a new length resets its trims (refused if it would overlap the next clip).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Op } from "@restorffcut/timeline-ops";
import { renderCustomComposition, type CustomRenderServiceAnswer } from "@/app/api/compositions/_lib/custom";
import { callService, COMPOSITIONS_DIR, ServiceError } from "@/app/api/compositions/_lib/service";
import type { ProjectSnapshot, SnapshotElement, SnapshotTrack } from "@/sync/snapshot";
// composition-v3 (2026-10-21): versions on every re-render, the timeline kit for sources that include it
import { appendVersion, compositionStore, timelineKitInput, usesKitMarker, type BlobKind, type KitInput } from "./composition-versions";
import { putProjectMedia } from "./media";
import { manifestOf, storedComposition, type ManifestLite, type StoredComposition } from "./storyboard-compositions";

const TICKS = 120_000;
const r3 = (value: number) => Math.round(value * 1000) / 1000;

export interface CompositionChange {
	element_id: string;
	/** Props to MERGE into the stored ones (null removes a key). */
	props?: Record<string, unknown>;
	/** New source: a custom composition's code (a library one becomes custom). */
	source?: string;
	/** New length in seconds. */
	duration_s?: number;
	/** What the props were (defaults included) — for the answer's "a → b" when the clip never stored them. */
	before?: Record<string, unknown>;
	/** composition-v3: why this version exists (the commit message, "revert to v2", "kit changed"…); default "update". */
	note?: string;
	/** composition-v3: render with THIS kit instead of the timeline's (a kit change renders before it is committed). */
	kit?: { kit: KitInput; sha: string } | null;
}

export interface RenderedChange {
	change: CompositionChange;
	kind: "custom" | "library";
	title: string;
	name: string;
	source: string | null;
	props: Record<string, unknown>;
	previous: StoredComposition;
	/** The params block's defaults (what a prop the clip never stored was). */
	defaults?: Record<string, unknown>;
	answer: { hash: string; file: string; cached: boolean; duration: number; width: number; height: number; fps: number; frames: number; ms: number; title?: string; name?: string; report?: { warnings?: string[]; network?: string; blocked?: string[] } };
	url: string;
	/** Set once uploaded. */
	media_id?: string;
	/** composition-v3: the timeline kit (store sha) a custom source with the marker rendered with. */
	kit_sha?: string;
	/** composition-v3: texts the new version needs in the composition store (stored by uploadRendered). */
	blobs?: Array<{ kind: BlobKind; body: string }>;
}

export type RecomposeFailure = { ok: false; code: "not_found" | "not_composition" | "refused" | "layered" | "overlap" | "stopped"; message: string; element_id?: string; details?: unknown };

function canvasOf(snapshot: ProjectSnapshot): { width: number; height: number; fps: number } {
	const size = snapshot.settings?.canvasSize;
	const fps = snapshot.settings?.fps as number | { numerator: number; denominator: number } | undefined;
	const rate = typeof fps === "number" ? fps : fps ? fps.numerator / fps.denominator : 30;
	return { width: size?.width ?? 1080, height: size?.height ?? 1920, fps: Math.max(1, Math.min(120, Math.round(rate))) };
}

export function findInSnapshot(snapshot: ProjectSnapshot, id: string): { element: SnapshotElement; track: SnapshotTrack } | null {
	for (const scene of snapshot.scenes ?? []) {
		const tracks = [...(scene.tracks?.overlay ?? []), ...(scene.tracks?.main ? [scene.tracks.main] : []), ...(scene.tracks?.audio ?? [])];
		for (const track of tracks) {
			const element = (track.elements ?? []).find((candidate) => candidate.id === id);
			if (element) return { element, track };
		}
	}
	return null;
}

// ─── library sources and manifests (read live from the package) ────────────────────────────────────────────────

const libraryFile = (name: string) => join(COMPOSITIONS_DIR, "compositions", name, `${name}.html`);

export async function librarySource(name: string): Promise<string | null> {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return null;
	const file = libraryFile(name);
	if (!existsSync(file)) return null;
	return readFile(file, "utf8");
}

/** Manifests (params blocks) of library compositions by name; null where the file is missing or unreadable. */
export async function libraryManifests(names: Iterable<string>): Promise<Record<string, ManifestLite | null>> {
	const out: Record<string, ManifestLite | null> = {};
	for (const name of new Set(names)) {
		try {
			out[name] = manifestOf(await librarySource(name));
		} catch {
			out[name] = null;
		}
	}
	return out;
}

// ─── render ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface LibraryAnswer {
	name: string;
	hash: string;
	file: string;
	cached: boolean;
	duration: number;
	width: number;
	height: number;
	fps: number;
	frames: number;
	ms: number;
}

/** A params block's defaults, key → value. */
function defaultsOf(manifest: ManifestLite | null): Record<string, unknown> {
	return Object.fromEntries(Object.entries(manifest?.params ?? {}).map(([key, spec]) => [key, spec.default]));
}

/** Merge props: a null value removes the key; `$` meta keys never go to a renderer. */
export function mergeProps(current: Record<string, unknown> | undefined, patch: Record<string, unknown> | undefined): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...(current ?? {}) };
	for (const [key, value] of Object.entries(patch ?? {})) {
		if (value === null) delete merged[key];
		else merged[key] = value;
	}
	for (const key of Object.keys(merged)) if (key.startsWith("$")) delete merged[key];
	return merged;
}

async function renderOne(snapshot: ProjectSnapshot, change: CompositionChange): Promise<RenderedChange | RecomposeFailure> {
	const found = findInSnapshot(snapshot, change.element_id);
	if (!found) return { ok: false, code: "not_found", message: `No element ${change.element_id} on this timeline.`, element_id: change.element_id };
	const stored = storedComposition(found.element);
	if (!stored) return { ok: false, code: "not_composition", message: `${change.element_id} is not a composition (no code or library name on it).`, element_id: change.element_id };
	const effect = (found.element.restorff as { effect?: { layer?: string; fed_from_matte?: string[]; id?: string } } | undefined)?.effect;
	if (effect && (effect.layer || effect.fed_from_matte?.length) && !change.source) {
		return {
			ok: false,
			code: "layered",
			message: `${change.element_id} is one layer of the layered effect ${effect.id ?? ""} (its plates are fed from the person matte): re-rendering one layer alone would lose them. Change it with the effects tool.`,
			element_id: change.element_id,
			details: { effect },
		};
	}
	const canvas = canvasOf(snapshot);
	const props = mergeProps(stored.props, change.props);
	const length = change.duration_s ?? (typeof stored.duration === "number" ? stored.duration : found.element.duration / TICKS);
	const custom = typeof change.source === "string" ? change.source : stored.custom && typeof stored.source === "string" ? stored.source : null;
	try {
		if (custom !== null) {
			// composition-v3: a source with <!-- rc-kit --> renders with the timeline's kit (or the one the change brings)
			const kit = usesKitMarker(custom) ? (change.kit !== undefined ? change.kit : await timelineKitInput(snapshot)) : null;
			const answer: CustomRenderServiceAnswer = await renderCustomComposition({ source: custom, props, duration_s: length, ...canvas, ...(kit ? { kit: kit.kit } : {}) });
			return {
				...(kit ? { kit_sha: kit.sha } : {}),
				change,
				kind: "custom",
				title: answer.title || stored.title || "Custom composition",
				name: answer.name || stored.name || "custom",
				source: custom,
				props,
				previous: stored,
				defaults: defaultsOf(manifestOf(custom)),
				answer,
				url: `/api/compositions/custom/${answer.hash}`,
			};
		}
		if (!stored.name) return { ok: false, code: "not_composition", message: `${change.element_id} has neither code nor a library name.`, element_id: change.element_id };
		const answer = await callService<LibraryAnswer>({ verb: "render", request: { name: stored.name, props, width: canvas.width, height: canvas.height, fps: canvas.fps, duration: length } });
		return {
			change,
			kind: "library",
			title: stored.title ?? found.element.name ?? stored.name,
			name: stored.name,
			source: null,
			props,
			previous: stored,
			defaults: defaultsOf(manifestOf(await librarySource(stored.name).catch(() => null))),
			answer,
			url: `/api/compositions/file/${answer.hash}`,
		};
	} catch (error) {
		if (error instanceof ServiceError && error.status !== 500 && error.status !== 504) {
			const details = (error.details ?? {}) as { errors?: string[]; warnings?: string[] };
			return { ok: false, code: "refused", message: `${stored.title ?? stored.name ?? change.element_id} refused these props: ${error.message.slice(0, 600)}`, element_id: change.element_id, details: { errors: details.errors ?? [error.message], props } };
		}
		throw error;
	}
}

/** Render every change (3 at a time). The first refusal stops the batch: nothing is committed. */
export async function renderChanges(snapshot: ProjectSnapshot, changes: CompositionChange[], signal?: AbortSignal): Promise<{ ok: true; rendered: RenderedChange[]; ms: number } | RecomposeFailure> {
	const started = Date.now();
	const rendered: RenderedChange[] = new Array(changes.length);
	let failure: RecomposeFailure | null = null;
	let next = 0;
	const worker = async () => {
		while (!failure && next < changes.length) {
			if (signal?.aborted) {
				failure = { ok: false, code: "stopped", message: "The call ran out of time while rendering; nothing was committed (finished renders are cached, so the same call again is fast)." };
				return;
			}
			const i = next++;
			const result = await renderOne(snapshot, changes[i] as CompositionChange);
			if ("ok" in result) failure ??= result;
			else rendered[i] = result;
		}
	};
	await Promise.all(Array.from({ length: Math.min(3, changes.length) }, worker));
	if (failure) return failure;
	return { ok: true, rendered, ms: Date.now() - started };
}

/** Same render as the clip already has (same code, props and length): nothing to commit for it. */
export function isUnchanged(snapshot: ProjectSnapshot, item: RenderedChange): boolean {
	const found = findInSnapshot(snapshot, item.change.element_id);
	if (!found || !item.previous.hash || item.previous.hash !== item.answer.hash) return false;
	return Math.round(item.answer.duration * TICKS) === found.element.duration && (item.kind === "custom") === (item.previous.custom === true);
}

/** One `import_media` op per render (refs recomp_media_<i>), to go in the same batch as everything else. */
export function importOps(rendered: RenderedChange[], author: "claude" | "user" = "claude"): Op[] {
	return rendered.map(
		(item, i) =>
			({
				op: "import_media",
				author,
				kind: "video",
				name: item.title,
				url: item.url,
				duration: item.answer.duration,
				width: item.answer.width,
				height: item.answer.height,
				fps: item.answer.fps,
				has_audio: false,
				ref: `recomp_media_${i}`,
			}) as Op,
	);
}

const overlapsOthers = (track: SnapshotTrack, start: number, end: number, except: string) =>
	(track.elements ?? []).some((other) => other.id !== except && start < other.startTime + other.duration && end > other.startTime);

/** Swap each clip's video in place on the batch's result (media ids from its refs). Mutates `snapshot`. */
export function swapRendered(snapshot: ProjectSnapshot, refs: Record<string, string>, rendered: RenderedChange[]): RecomposeFailure | null {
	for (const [i, item] of rendered.entries()) {
		const mediaId = refs[`recomp_media_${i}`];
		const found = findInSnapshot(snapshot, item.change.element_id);
		if (!found || !mediaId) return { ok: false, code: "not_found", message: `${item.change.element_id} vanished while updating (internal).`, element_id: item.change.element_id };
		const { element, track } = found;
		const length = Math.round(item.answer.duration * TICKS);
		if (length !== element.duration) {
			if (overlapsOthers(track, element.startTime, element.startTime + length, element.id)) {
				return { ok: false, code: "overlap", message: `At ${r3(item.answer.duration)} s, ${item.title} would overlap the next clip on "${track.name ?? track.id}". Nothing was committed.`, element_id: element.id };
			}
			element.duration = length;
			element.trimStart = 0;
			element.trimEnd = 0;
			element.sourceDuration = length;
		}
		element.mediaId = mediaId;
		element.name = item.title;
		item.media_id = mediaId;
		const made: StoredComposition =
			item.kind === "custom"
				? { custom: true, name: item.name, title: item.title, source: item.source ?? "", props: item.props, hash: item.answer.hash, width: item.answer.width, height: item.answer.height, fps: item.answer.fps, duration: item.answer.duration, author: "claude" }
				: { ...item.previous, name: item.name, props: item.props, hash: item.answer.hash, width: item.answer.width, height: item.answer.height, fps: item.answer.fps, duration: item.answer.duration };
		// composition-v3: keep every version (the previous record's history + this one; texts go to the store on upload)
		const versioned = appendVersion(item.previous, { ...made, ...(item.kit_sha ? { kit_sha: item.kit_sha } : {}) }, { note: item.change.note });
		const { kit_sha: _staleKit, ...base } = versioned.record;
		const record = { ...base, ...(item.kit_sha ? { kit_sha: item.kit_sha } : {}) } as StoredComposition;
		item.blobs = versioned.blobs;
		element.restorff = { ...((element.restorff as Record<string, unknown> | undefined) ?? {}), composition: record } as SnapshotElement["restorff"];
	}
	return null;
}

/** Put each render's WebM in the project's media store under its new media id (the editor pulls it with the commit). */
export async function uploadRendered(projectId: string, rendered: RenderedChange[]): Promise<number> {
	// composition-v3: the versions' texts (source, props) into the content-addressed composition store first
	const blobs = rendered.flatMap((item) => item.blobs ?? []);
	if (blobs.length) await compositionStore().put(blobs);
	let bytesTotal = 0;
	for (const item of rendered) {
		if (!item.media_id) continue;
		const bytes = await readFile(item.answer.file);
		bytesTotal += bytes.byteLength;
		const sha = createHash("sha256").update(bytes).digest("hex");
		const meta = {
			name: `${item.title} · ${item.kind === "custom" ? "code · " : ""}${item.answer.hash.slice(0, 6)}.webm`,
			type: "video",
			width: item.answer.width,
			height: item.answer.height,
			duration: item.answer.duration,
			fps: item.answer.fps,
			hasAudio: false,
			size: bytes.byteLength,
			lastModified: Date.now(),
		};
		const request = new Request("http://restorffcut.internal/media", {
			method: "PUT",
			body: new Uint8Array(bytes),
			headers: { "content-type": "video/webm", "x-media-meta": Buffer.from(JSON.stringify(meta), "utf8").toString("base64url"), "x-media-sha256": sha },
		});
		await putProjectMedia(projectId, item.media_id, request);
	}
	return bytesTotal;
}

/** What a result says per composition: props before → after, the render. */
export function renderedView(item: RenderedChange) {
	const changed: Record<string, string> = {};
	const keys = new Set([...Object.keys(item.previous.props ?? {}), ...Object.keys(item.props)]);
	for (const key of keys) {
		const a = item.previous.props?.[key] ?? item.change.before?.[key] ?? item.defaults?.[key];
		const b = item.props[key];
		if (JSON.stringify(a) !== JSON.stringify(b)) changed[key] = `${JSON.stringify(a) ?? "—"} → ${JSON.stringify(b) ?? "—"}`.slice(0, 120);
	}
	return {
		element_id: item.change.element_id,
		title: item.title,
		kind: item.kind,
		...(item.previous.custom !== true && item.kind === "custom" ? { converted: "library → custom code" } : {}),
		props: changed,
		...(item.change.source !== undefined ? { source_changed: item.source !== item.previous.source } : {}),
		duration_s: r3(item.answer.duration),
		media_id: item.media_id ?? null,
		hash: item.answer.hash,
		previous_hash: item.previous.hash ?? null,
		render: { cached: item.answer.cached, ms: item.answer.ms, frames: item.answer.frames, size: `${item.answer.width}x${item.answer.height}`, fps: item.answer.fps },
		...(item.answer.report?.warnings?.length ? { warnings: item.answer.report.warnings } : {}),
	};
}
