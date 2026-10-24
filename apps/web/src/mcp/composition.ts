/**
 * MCP tool `composition` (motion-code agent, 2026-10-20; EDT-15): Claude writes a motion graphic as HTML/CSS/JS, the
 * server validates it, renders it with the network blocked (packages/compositions src/custom.ts), stores the video in
 * the project's media store and commits a clip on the MOTION track as author `claude`. The clip carries its code
 * (element.restorff.composition = { custom: true, source, props, hash, … }), so `get` reads it back and `update`
 * re-renders it in place. The editor pulls the commit (and the video) like any other.
 *
 *   contract  how to write one (+ a real example; cues, scenes, text and kit declarations; versions; library pieces)
 *   write     source + props + duration + t → clip on MOTION; or library: a library composition by name
 *   update    element id + new source and/or props        get     an element's source and props
 *   history   an element's versions and what changed       revert  put a version back (one commit)
 *   kit       read / set the timeline's shared kit; a change re-renders exactly the clips that include it (one commit)
 *
 * composition-v3 (2026-10-21; neon-grid-nitro REPORT items 3, 4, 8, 9): versions (server/composition-versions.ts: the
 * clip holds hashes, the texts live once in a content-addressed store), the timeline kit over MCP (`kit`, `use_kit`),
 * `library` on write, the contract documents cues / scenes / text / opaque / kits.
 *
 * Runbook + example calls: packages/compositions/README.md "Custom compositions"; docs/restorff/worklog/motion-code.md,
 * docs/restorff/worklog/composition-v3.md.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { apply, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import {
	type CustomRenderServiceAnswer,
	renderCustomComposition,
} from "@/app/api/compositions/_lib/custom";
import { callService, ServiceError } from "@/app/api/compositions/_lib/service";
import type { Actor } from "@/server/auth";
import {
	appendVersion,
	compositionStore,
	diffVersions,
	KIT_MARKER,
	kitBody,
	kitClips,
	planRevert,
	setTimelineKit,
	sha256,
	stableJson,
	timelineKitInput,
	timelineKitOf,
	usesKitMarker,
	versionsOf,
	withKitMarker,
	type CompositionVersion,
	type KitInput,
	type VersionedComposition,
} from "@/server/composition-versions";
import { HttpError } from "@/server/http";
import { putProjectMedia } from "@/server/media";
import { getProjectHead, pushCommit } from "@/server/projects";
import { CUE_SOUNDS } from "@/server/sound-design-plan";
import { commitAsClaude } from "@/server/storyboard";
import { manifestOf } from "@/server/storyboard-compositions";
import { importOps, isUnchanged, librarySource, renderChanges, renderedView, swapRendered, uploadRendered, type CompositionChange, type RenderedChange } from "@/server/storyboard-recompose";
import type { ProjectSnapshot, SnapshotElement, SnapshotScene, SnapshotTrack } from "@/sync/snapshot";
import { fail, type JsonSchema, type Payload, type Tool, type ToolContext, type ToolOutput } from "./protocol";

const TICKS = 120_000;
const MOTION = "MOTION";
const toTicks = (seconds: number) => Math.round(seconds * TICKS);
const toSeconds = (ticks: number) => Math.round((ticks / TICKS) * 1000) / 1000;

type StoredComposition = VersionedComposition;

// ─── snapshot helpers ─────────────────────────────────────────────────────────────────────────────────────────

/** The scene ops@1 edits: currentSceneId, else the main scene, else the first (reducer.ts, summary.ts). */
function activeScene(snapshot: ProjectSnapshot): SnapshotScene | null {
	const scenes = snapshot.scenes ?? [];
	return scenes.find((scene) => scene.id === snapshot.currentSceneId) ?? scenes.find((scene) => scene.isMain) ?? scenes[0] ?? null;
}

function tracksOf(scene: SnapshotScene | null): SnapshotTrack[] {
	if (!scene?.tracks) return [];
	return [...(scene.tracks.overlay ?? []), ...(scene.tracks.main ? [scene.tracks.main] : []), ...(scene.tracks.audio ?? [])];
}

function findElement(snapshot: ProjectSnapshot, elementId: string): { track: SnapshotTrack; element: SnapshotElement; scene: SnapshotScene } | null {
	const scenes = [activeScene(snapshot), ...(snapshot.scenes ?? [])].filter((s): s is SnapshotScene => !!s);
	for (const scene of scenes) {
		for (const track of tracksOf(scene)) {
			const element = (track.elements ?? []).find((candidate) => candidate.id === elementId);
			if (element) return { track, element, scene };
		}
	}
	return null;
}

function compositionOf(element: SnapshotElement): StoredComposition | null {
	const restorff = element.restorff as { composition?: StoredComposition } | undefined;
	return restorff?.composition ?? null;
}

function canvasOf(snapshot: ProjectSnapshot): { width: number; height: number; fps: number } {
	const size = snapshot.settings?.canvasSize;
	const fps = snapshot.settings?.fps;
	const rate = typeof fps === "number" ? fps : fps ? fps.numerator / fps.denominator : 30;
	return {
		width: size?.width ?? 1080,
		height: size?.height ?? 1920,
		fps: Math.max(1, Math.min(120, Math.round(rate))),
	};
}

const overlaps = (track: SnapshotTrack, start: number, end: number, except?: string) =>
	(track.elements ?? []).some((el) => el.id !== except && start < el.startTime + el.duration && end > el.startTime);

/** A MOTION track with room for [start, end) on the active scene, or null (then the batch adds one on top). */
function motionTrackWithRoom(snapshot: ProjectSnapshot, start: number, end: number): SnapshotTrack | null {
	const overlay = activeScene(snapshot)?.tracks?.overlay ?? [];
	return overlay.find((track) => track.type === "video" && (track.name ?? "").toUpperCase().startsWith(MOTION) && !overlaps(track, start, end)) ?? null;
}

function motionTrackCount(snapshot: ProjectSnapshot): number {
	const overlay = activeScene(snapshot)?.tracks?.overlay ?? [];
	return overlay.filter((track) => (track.name ?? "").toUpperCase().startsWith(MOTION)).length;
}

// ─── render + media ───────────────────────────────────────────────────────────────────────────────────────────

/** Render through the package; a refusal becomes a tool error that says why (and what to read). */
async function renderOrRefuse(input: Parameters<typeof renderCustomComposition>[0]): Promise<CustomRenderServiceAnswer | ToolOutput> {
	try {
		return await renderCustomComposition(input);
	} catch (error) {
		if (error instanceof ServiceError && error.status === 422) {
			const details = (error.details ?? {}) as { errors?: string[]; warnings?: string[] };
			const out = fail("refused", "The composition was refused; nothing was rendered or committed.", {
				errors: details.errors ?? [error.message],
				warnings: details.warnings ?? [],
			});
			(out.payload as Payload).next = {
				do: "Fix every error and call write again. Read the contract if anything is unclear.",
				tool: "composition",
				arguments: { action: "contract" },
			};
			return out;
		}
		throw error;
	}
}

const isOutput = (value: unknown): value is ToolOutput => !!value && typeof value === "object" && "isError" in value;

/** Store the rendered WebM in the project's media store under `mediaId`, so the editor pulls it with the commit. */
async function uploadRender(projectId: string, mediaId: string, answer: { file: string; title?: string; hash: string; width: number; height: number; duration: number; fps: number }, label = "code"): Promise<{ sha: string; size: number }> {
	const bytes = await readFile(answer.file);
	const sha = createHash("sha256").update(bytes).digest("hex");
	const meta = {
		name: `${answer.title || "Custom composition"} · ${label} · ${answer.hash.slice(0, 6)}.webm`,
		type: "video",
		width: answer.width,
		height: answer.height,
		duration: answer.duration,
		fps: answer.fps,
		hasAudio: false,
		size: bytes.byteLength,
		lastModified: Date.now(),
	};
	const request = new Request("http://restorffcut.internal/media", {
		method: "PUT",
		body: new Uint8Array(bytes),
		headers: {
			"content-type": "video/webm",
			"x-media-meta": Buffer.from(JSON.stringify(meta), "utf8").toString("base64url"),
			"x-media-sha256": sha,
		},
	});
	await putProjectMedia(projectId, mediaId, request);
	return { sha, size: bytes.byteLength };
}

function stored(answer: CustomRenderServiceAnswer, source: string, props: Record<string, unknown>): StoredComposition {
	return {
		custom: true,
		name: answer.name || "custom",
		title: answer.title || "Custom composition",
		source,
		props,
		hash: answer.hash,
		width: answer.width,
		height: answer.height,
		fps: answer.fps,
		duration: answer.duration,
		author: "claude",
	};
}

function actorOf(ctx: ToolContext): Actor {
	const kind = ctx.auth?.kind === "service" ? "service" : "local-dev";
	return { kind, id: ctx.auth?.userId ?? kind, name: ctx.auth?.name ?? "Claude (MCP)" };
}

function need(args: Record<string, unknown>, key: string, why: string): string {
	const value = args[key];
	if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} is required ${why}`);
	return value;
}

function conflict(timelineId: string, head: string, given: string): ToolOutput {
	const out = fail("conflict", `The timeline moved on: its head is ${head}, not ${given}. Nothing was rendered or committed.`, { head });
	(out.payload as Payload).next = { do: "Read the timeline again, then retry on its head (or omit base_commit).", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } };
	return out;
}

const baseMatches = (given: string | undefined, head: string) => !given || given === head || (given.length >= 7 && head.startsWith(given));

/** Commit a snapshot as Claude; a race with another writer comes back as a conflict. */
async function commit(
	ctx: ToolContext,
	timelineId: string,
	headId: string,
	branch: string,
	snapshot: ProjectSnapshot,
	ops: unknown[],
	message: string,
): Promise<{ ok: true; commitId: string } | { ok: false; out: ToolOutput }> {
	const pushed = await pushCommit(timelineId, { base_commit: headId, branch, author: "claude", snapshot, ops, message }, actorOf(ctx));
	if (!pushed.ok) return { ok: false, out: conflict(timelineId, pushed.conflict.head.id, headId) };
	return { ok: true, commitId: pushed.commit.id };
}

const EDITOR_NOTE =
	"The editor pulls this commit and its video within ~15 s (or on focus); the clip sits on the MOTION track, marked as written by Claude, and Edit code reopens it.";

// ─── composition-v3 helpers ─────────────────────────────────────────────────────────────────────────────────────

/** The library kit a params block names (`"kit": "neon-grid"`), or null. */
function paramsKitName(source: string | null | undefined): string | null {
	if (typeof source !== "string") return null;
	const block = /<script[^>]*id=["']params["'][^>]*>([\s\S]*?)<\/script>/i.exec(source) ?? /<script[^>]*type=["']application\/json["'][^>]*id=["']params["'][^>]*>([\s\S]*?)<\/script>/i.exec(source);
	if (!block) return null;
	try {
		const kit = (JSON.parse(block[1] as string) as { kit?: unknown }).kit;
		return typeof kit === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(kit) ? kit : null;
	} catch {
		return null;
	}
}

/** A piece with a `t0` param ("where this clip starts on the timeline") gets it from t when the caller leaves it out. */
function withT0(source: string | null, raw: Record<string, unknown>, t: number): { props: Record<string, unknown>; filled: boolean } {
	// `$comment`-style keys are notes in a props file, never params (update's merge drops them too)
	const props = Object.fromEntries(Object.entries(raw ?? {}).filter(([key]) => !key.startsWith("$")));
	const manifest = manifestOf(source);
	if (!manifest?.params || !("t0" in manifest.params) || props.t0 !== undefined) return { props, filled: false };
	return { props: { ...props, t0: Math.round(t * 1000) / 1000 }, filled: true };
}

/** What a clip's own start is, in timeline seconds (its trim taken out): what a `t0` param should say. */
const clipOrigin = (element: SnapshotElement) => toSeconds(element.startTime - (element.trimStart ?? 0));

function noKitAnswer(timelineId: string): ToolOutput {
	const out = fail("no_kit", `This source includes the timeline kit (${KIT_MARKER}) but the timeline has no kit yet, and its params block names no library kit. Nothing was rendered or committed.`);
	(out.payload as Payload).next = { do: "Set the timeline's kit first (your shared code, or a library kit), then write again.", tool: "composition", arguments: { action: "kit", timeline_id: timelineId, kit: { js: "var KIT = { … };", css: "" } } };
	return out;
}

/** Versions as `history` shows them: oldest first, with what changed from the one before. */
async function versionRows(record: StoredComposition) {
	const versions = versionsOf(record);
	const shas = versions.flatMap((v) => [v.props_sha, ...(v.source_sha ? [v.source_sha] : [])]);
	const texts = await compositionStore().get(shas);
	// a record from before versions were kept: its texts are on the clip itself
	if (!(Array.isArray(record.versions) && record.versions.length)) {
		const props = stableJson(record.props ?? {});
		texts.set(sha256(props), props);
		if (typeof record.source === "string") texts.set(sha256(record.source), record.source);
	}
	return versions.map((v, i) => ({
		v: v.v,
		at: v.at,
		note: v.note,
		kind: v.kind,
		...(v.title ? { title: v.title } : {}),
		hash: v.hash ?? null,
		duration_s: v.duration ?? null,
		...(v.kit_sha ? { kit: v.kit_sha.slice(0, 12) } : {}),
		changed: i === 0 ? { first: true } : diffVersions(versions[i - 1] as CompositionVersion, v, texts),
		in_store: { props: texts.has(v.props_sha), ...(v.source_sha ? { source: texts.has(v.source_sha) } : {}) },
		...(i === versions.length - 1 ? { current: true } : {}),
	}));
}

// ─── actions ──────────────────────────────────────────────────────────────────────────────────────────────────

/** How versions, the kit and library pieces work over MCP (what the package's contract can't know). */
const MCP_RULES = {
	versions:
		"Every write, update, revise, revert and kit change keeps a version of the clip (source + props + kit + render hash; the texts live once in the server's composition store). composition {action: history, timeline_id, element_id} lists them with what changed (props a → b, source +/- lines, kit, length); {action: revert, timeline_id, element_id, version: 2} puts v2 back in ONE commit, recorded as a new version (history stays append-only). version: \"previous\" = the one before the current.",
	kit:
		"The timeline kit = shared code for this timeline's custom compositions. composition {action: kit, timeline_id, kit: {js, css?, html?}} (or library_kit: \"neon-grid\" = packages/compositions/kits/neon-grid.js) sets it; every custom clip whose source has <!-- rc-kit --> re-renders with it in ONE commit and nothing else is touched (dry_run: true lists them first). {action: kit, timeline_id} alone reads it (code + which clips include it). write / update {use_kit: true} put the marker into <head> for you. A source that names a library kit in its params block (\"kit\": \"neon-grid\") renders with that kit while the timeline has none.",
	library:
		"composition write {timeline_id, library: \"<name>\", props, t, duration_s} places a LIBRARY composition (effects list shows them as comp:<name>); a piece with a `t0` param gets t0 = t; on-screen words come only from props (the piece answers `needs` when a required one is missing). Library pieces built for replication (every word and time a param, timed from the voice's words): the neon-grid kit — library_kits[].used_by below; worked plans for two products: packages/compositions/examples/neon-grid/*.json.",
	cues_from_params:
		"A composition whose times are params should push its sound cues in build(): window.__rcCues = [{t (real seconds into the clip), kind, label}] — they follow the params, while a params-block \"cues\" list is fixed.",
};

async function contract(): Promise<ToolOutput> {
	const info = await callService<Payload>({ verb: "custom-contract" });
	return {
		payload: {
			...info,
			// composition-v3: the kinds sound design knows (server/sound-design-plan.ts CUE_SOUNDS), and the MCP-side rules
			cue_kinds: CUE_SOUNDS.map((row) => ({ kinds: row.kinds, sounds: row.sounds, strong: row.strong })),
			mcp: MCP_RULES,
			next: {
				do: "Write one: the whole HTML file as source, props for its params, duration_s, and where it starts (t, seconds). Or place a library piece: write {library, props, t}.",
				tool: "composition",
				arguments: { action: "write", timeline_id: "…", source: "<!doctype html>…", props: {}, duration_s: 4, t: 0 },
			},
		},
	};
}

async function write(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "for write").trim();
	const library = typeof args.library === "string" && args.library.trim() ? args.library.trim() : undefined;
	if (library) return writeLibrary(args, ctx, timelineId, library);
	const useKit = args.use_kit === true;
	const source = useKit ? withKitMarker(need(args, "source", "for write (the whole HTML file)")) : need(args, "source", "for write (the whole HTML file)");
	const t = typeof args.t === "number" ? args.t : 0;
	if (!(t >= 0)) return fail("invalid_arguments", "t must be >= 0 (seconds on the timeline).");
	const { props, filled: t0Filled } = withT0(source, (args.props as Record<string, unknown> | undefined) ?? {}, t);
	const branch = typeof args.branch === "string" && args.branch ? args.branch : undefined;
	const head = await getProjectHead(timelineId, branch);
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot to add to.");
	const base = typeof args.base_commit === "string" ? args.base_commit : undefined;
	if (!baseMatches(base, head.head.id)) return conflict(timelineId, head.head.id, base ?? "");

	const canvas = canvasOf(head.snapshot);
	// composition-v3: a source that includes the kit renders with the timeline's (else its params block's library kit)
	const kit = usesKitMarker(source) ? await timelineKitInput(head.snapshot) : null;
	if (usesKitMarker(source) && !kit && !paramsKitName(source)) return noKitAnswer(timelineId);
	const rendered = await renderOrRefuse({ source, props, duration_s: typeof args.duration_s === "number" ? args.duration_s : undefined, ...canvas, ...(kit ? { kit: kit.kit } : {}) });
	if (isOutput(rendered)) return rendered;

	const start = toTicks(t);
	const end = start + toTicks(rendered.duration);
	const free = motionTrackWithRoom(head.snapshot, start, end);
	const count = motionTrackCount(head.snapshot);
	const ops: Record<string, unknown>[] = [
		{ op: "import_media", author: "claude", kind: "video", name: rendered.title, url: `/api/compositions/custom/${rendered.hash}`, duration: rendered.duration, width: rendered.width, height: rendered.height, fps: rendered.fps, has_audio: false, ref: "motion_media" },
		...(free ? [] : [{ op: "add_track", author: "claude", kind: "video", name: count ? `${MOTION} ${count + 1}` : MOTION, index: 0, ref: "motion_track" }]),
		{ op: "insert", author: "claude", track: free ? free.id : "motion_track", t, media: "motion_media", in: 0, out: rendered.duration, name: rendered.title, ref: "motion_clip" },
	];
	const result = apply(head.snapshot as unknown as OpsProject, ops as unknown as Op[], { seed: `${timelineId}/${head.head.id}/composition/${rendered.hash}`, at: new Date().toISOString() });
	if (!result.ok) {
		return fail("ops_conflict", "Placing the clip was refused by the timeline reducer. Nothing was committed.", { conflicts: result.conflicts.slice(0, 10) });
	}
	const elementId = result.changes.refs.motion_clip;
	const mediaId = result.changes.refs.motion_media;
	const snapshot = result.project as unknown as ProjectSnapshot;
	const found = elementId ? findElement(snapshot, elementId) : null;
	if (!found || !mediaId) return fail("tool_failed", "The clip was not found after placing it (internal).");
	const message = typeof args.message === "string" && args.message.trim() ? args.message.trim() : `composition: ${rendered.title}`;
	// composition-v3: v1 of the clip (its texts into the composition store)
	const versioned = appendVersion(null, { ...stored(rendered, source, props), ...(kit ? { kit_sha: kit.sha } : {}) }, { note: message });
	found.element.restorff = { ...(found.element.restorff ?? {}), composition: versioned.record } as SnapshotElement["restorff"];
	await compositionStore().put(versioned.blobs);

	const media = await uploadRender(timelineId, mediaId, rendered);
	const done = await commit(ctx, timelineId, head.head.id, head.branch, snapshot, result.changes.applied, message);
	if (!done.ok) return done.out;
	return {
		payload: {
			commit_id: done.commitId,
			element_id: elementId,
			media_id: mediaId,
			track: { id: found.track.id, name: found.track.name ?? null, created: !free },
			t,
			duration_s: rendered.duration,
			title: rendered.title,
			hash: rendered.hash,
			version: 1,
			...(usesKitMarker(source) ? { kit: kit ? { from: "timeline", sha: kit.sha.slice(0, 12) } : { from: rendered.kitFrom ?? `library:${paramsKitName(source)}` } } : {}),
			...(t0Filled ? { t0: props.t0 } : {}),
			render: { cached: rendered.cached, ms: rendered.ms, frames: rendered.frames, size: `${rendered.width}x${rendered.height}`, fps: rendered.fps, bytes: media.size },
			report: { warnings: rendered.report.warnings, network: rendered.report.network, blocked: rendered.report.blocked },
			video_url: `/api/compositions/custom/${rendered.hash}`,
			editor: EDITOR_NOTE,
			next: {
				do: "To change it, send new props (merged) and/or new source; to read its code back, use get; history lists its versions.",
				tool: "composition",
				arguments: { action: "update", timeline_id: timelineId, element_id: elementId, props: {} },
			},
		},
	};
}

interface LibraryRenderAnswer {
	name: string;
	hash: string;
	file: string;
	cached: boolean;
	duration: number;
	width: number;
	height: number;
	fps: number;
	frames: number;
	params: Record<string, unknown>;
	blanked?: string[];
	fit?: number;
	rate?: number;
	ms: number;
}

/** composition-v3: `write {library}` — a library composition by name, placed and committed like a custom one. */
async function writeLibrary(args: Record<string, unknown>, ctx: ToolContext, timelineId: string, name: string): Promise<ToolOutput> {
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return fail("invalid_arguments", `library must be a library composition's name (kebab-case), got "${name}".`);
	const source = await librarySource(name);
	if (!source) {
		const out = fail("not_found", `No library composition "${name}".`);
		(out.payload as Payload).next = { do: "List the library (compositions are comp:<name>).", tool: "effects", arguments: { action: "list", kind: "composition" } };
		return out;
	}
	const manifest = manifestOf(source);
	const title = (manifest?.title as string | undefined) ?? name;
	const t = typeof args.t === "number" ? args.t : 0;
	if (!(t >= 0)) return fail("invalid_arguments", "t must be >= 0 (seconds on the timeline).");
	const { props, filled: t0Filled } = withT0(source, (args.props as Record<string, unknown> | undefined) ?? {}, t);
	const branch = typeof args.branch === "string" && args.branch ? args.branch : undefined;
	const head = await getProjectHead(timelineId, branch);
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot to add to.");
	const base = typeof args.base_commit === "string" ? args.base_commit : undefined;
	if (!baseMatches(base, head.head.id)) return conflict(timelineId, head.head.id, base ?? "");
	const canvas = canvasOf(head.snapshot);
	let answer: LibraryRenderAnswer;
	try {
		answer = await callService<LibraryRenderAnswer>({ verb: "render", request: { name, props, width: canvas.width, height: canvas.height, fps: canvas.fps, ...(typeof args.duration_s === "number" ? { duration: args.duration_s } : {}) } });
	} catch (error) {
		if (error instanceof ServiceError && error.status !== 500 && error.status !== 504) {
			const out = fail("refused", `${name} refused these props; nothing was rendered or committed: ${error.message.slice(0, 900)}`, { details: error.details ?? null });
			(out.payload as Payload).next = { do: "Read its params (types, what each means), then write again with them.", tool: "effects", arguments: { action: "describe", name: `comp:${name}` } };
			return out;
		}
		throw error;
	}
	const start = toTicks(t);
	const end = start + toTicks(answer.duration);
	const free = motionTrackWithRoom(head.snapshot, start, end);
	const count = motionTrackCount(head.snapshot);
	const ops: Record<string, unknown>[] = [
		{ op: "import_media", author: "claude", kind: "video", name: title, url: `/api/compositions/file/${answer.hash}`, duration: answer.duration, width: answer.width, height: answer.height, fps: answer.fps, has_audio: false, ref: "motion_media" },
		...(free ? [] : [{ op: "add_track", author: "claude", kind: "video", name: count ? `${MOTION} ${count + 1}` : MOTION, index: 0, ref: "motion_track" }]),
		{ op: "insert", author: "claude", track: free ? free.id : "motion_track", t, media: "motion_media", in: 0, out: answer.duration, name: title, ref: "motion_clip" },
	];
	const result = apply(head.snapshot as unknown as OpsProject, ops as unknown as Op[], { seed: `${timelineId}/${head.head.id}/composition/${answer.hash}`, at: new Date().toISOString() });
	if (!result.ok) return fail("ops_conflict", "Placing the clip was refused by the timeline reducer. Nothing was committed.", { conflicts: result.conflicts.slice(0, 10) });
	const elementId = result.changes.refs.motion_clip;
	const mediaId = result.changes.refs.motion_media;
	const snapshot = result.project as unknown as ProjectSnapshot;
	const found = elementId ? findElement(snapshot, elementId) : null;
	if (!found || !mediaId) return fail("tool_failed", "The clip was not found after placing it (internal).");
	const message = typeof args.message === "string" && args.message.trim() ? args.message.trim() : `composition: ${title}`;
	const record: StoredComposition = { name, title, props, hash: answer.hash, width: answer.width, height: answer.height, fps: answer.fps, duration: answer.duration, author: "claude" };
	const versioned = appendVersion(null, record, { note: message });
	found.element.restorff = { ...(found.element.restorff ?? {}), composition: versioned.record } as SnapshotElement["restorff"];
	await compositionStore().put(versioned.blobs);
	const media = await uploadRender(timelineId, mediaId, { ...answer, title }, "library");
	const done = await commit(ctx, timelineId, head.head.id, head.branch, snapshot, result.changes.applied, message);
	if (!done.ok) return done.out;
	return {
		payload: {
			commit_id: done.commitId,
			element_id: elementId,
			media_id: mediaId,
			track: { id: found.track.id, name: found.track.name ?? null, created: !free },
			t,
			duration_s: answer.duration,
			library: name,
			title,
			hash: answer.hash,
			version: 1,
			...(t0Filled ? { t0: props.t0 } : {}),
			...(answer.blanked?.length ? { blanked: answer.blanked } : {}),
			render: { cached: answer.cached, ms: answer.ms, frames: answer.frames, size: `${answer.width}x${answer.height}`, fps: answer.fps, bytes: media.size, ...(answer.fit ? { fit: answer.fit, rate: answer.rate } : {}) },
			video_url: `/api/compositions/file/${answer.hash}`,
			editor: EDITOR_NOTE,
			next: { do: "Change it with new props (merged); its versions are in history.", tool: "composition", arguments: { action: "update", timeline_id: timelineId, element_id: elementId, props: {} } },
		},
	};
}

/**
 * update — revise-v2 agent, 2026-10-20 (SUMMARY gap 2: "make the titles bigger" took 22 commits; library compositions
 * answered not_custom). Every form is ONE commit through server/storyboard.ts commitAsClaude:
 *   {element_id, props?, source?, duration_s?}            one clip (as before)
 *   {element_ids: [...], props?, duration_s?}              the same props on several clips
 *   {updates: [{element_id, props?, source?, duration_s?}]} different changes on several clips
 * Custom clips re-render from their own code; LIBRARY clips re-render from the library's source by name with the
 * merged props (a `source` makes a library clip custom). Layers of a layered effect are refused (effects tool).
 * composition-v3: every update is a new version (history / revert); `use_kit: true` puts the kit marker into the
 * source; a piece with a `t0` param follows its clip's start when the caller does not send t0.
 */
function updatesOf(args: Record<string, unknown>): CompositionChange[] | string {
	const props = args.props as Record<string, unknown> | undefined;
	if (props !== undefined && (props === null || typeof props !== "object" || Array.isArray(props))) return "props must be a JSON object";
	const duration = typeof args.duration_s === "number" ? args.duration_s : undefined;
	const source = typeof args.source === "string" && args.source.trim() ? args.source : undefined;
	const list: CompositionChange[] = [];
	if (Array.isArray(args.updates)) {
		for (const [i, raw] of (args.updates as unknown[]).entries()) {
			if (!raw || typeof raw !== "object") return `updates[${i}] must be an object {element_id, props?, source?, duration_s?}`;
			const item = raw as Record<string, unknown>;
			if (typeof item.element_id !== "string" || !item.element_id.trim()) return `updates[${i}].element_id is required`;
			if (item.props !== undefined && (item.props === null || typeof item.props !== "object" || Array.isArray(item.props))) return `updates[${i}].props must be a JSON object`;
			const change: CompositionChange = { element_id: item.element_id.trim() };
			if (item.props) change.props = item.props as Record<string, unknown>;
			if (typeof item.source === "string" && item.source.trim()) change.source = item.source;
			if (typeof item.duration_s === "number") change.duration_s = item.duration_s;
			if (!change.props && !change.source && change.duration_s === undefined && args.use_kit !== true) return `updates[${i}] changes nothing: send props, source or duration_s`;
			list.push(change);
		}
	}
	const ids = [
		...(Array.isArray(args.element_ids) ? (args.element_ids as unknown[]).filter((id): id is string => typeof id === "string" && !!id.trim()).map((id) => id.trim()) : []),
		...(typeof args.element_id === "string" && args.element_id.trim() ? [args.element_id.trim()] : []),
	];
	if (ids.length) {
		if (props === undefined && source === undefined && duration === undefined && args.use_kit !== true) return "Send props and/or source (and/or duration_s) to change.";
		if (source !== undefined && ids.length > 1) return "one source can't replace several compositions' code: use updates [{element_id, source}]";
		for (const id of ids) list.push({ element_id: id, ...(props ? { props } : {}), ...(source !== undefined ? { source } : {}), ...(duration !== undefined ? { duration_s: duration } : {}) });
	}
	if (!list.length) return "Say which clip: element_id, element_ids [...], or updates [{element_id, props}].";
	const seen = new Set<string>();
	for (const change of list) {
		if (seen.has(change.element_id)) return `${change.element_id} is listed twice: put all its changes in one entry`;
		seen.add(change.element_id);
	}
	return list;
}

/** The answer for a failed commitAsClaude outcome (update and revert share it). */
function outcomeFailure(outcome: { code: string; message: string; details?: unknown; head?: string }, timelineId: string, args: Record<string, unknown>): ToolOutput {
	const out = fail(outcome.code === "render_refused" ? "refused" : outcome.code, outcome.message, { ...(outcome.details ? { details: outcome.details } : {}), ...(outcome.head ? { head: outcome.head } : {}) });
	const elementId = (outcome.details as { element_id?: string } | undefined)?.element_id;
	(out.payload as Payload).next =
		outcome.code === "layered"
			? { do: "That clip is one layer of a layered effect (plates fed from the person matte): change it with the effects tool.", tool: "effects", arguments: { action: "list", timeline_id: timelineId } }
			: outcome.code === "stopped"
				? { do: "Send the same call again: finished renders are cached.", tool: "composition", arguments: { ...args } }
				: elementId
					? { do: "Read that composition's params (types, ranges) and fix the values.", tool: "composition", arguments: { action: "get", timeline_id: timelineId, element_id: elementId } }
					: { do: "Read the timeline again.", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } };
	return out;
}

async function update(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "for update").trim();
	const changes = updatesOf(args);
	if (typeof changes === "string") return fail("invalid_arguments", changes);
	const branch = typeof args.branch === "string" && args.branch ? args.branch : undefined;
	const head = await getProjectHead(timelineId, branch);
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot.");
	const base = typeof args.base_commit === "string" ? args.base_commit : undefined;
	if (!baseMatches(base, head.head.id)) return conflict(timelineId, head.head.id, base ?? "");
	const useKit = args.use_kit === true;
	const hasTimelineKit = !!timelineKitOf(head.snapshot);
	const t0Synced: Record<string, number> = {};
	// every target must be a composition (custom or library) before anything renders
	for (const change of changes) {
		const target = findElement(head.snapshot, change.element_id);
		const current = target ? compositionOf(target.element) : null;
		if (!target || !current) {
			const out = fail("not_found", target ? `${change.element_id} is not a composition (no code or library name on it).` : `No element ${change.element_id} on this timeline.`);
			(out.payload as Payload).next = { do: "Find the composition clips' ids (elements with a composition).", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } };
			return out;
		}
		// composition-v3: use_kit puts the marker into the (new or current) source of a custom clip
		if (useKit) {
			const code = change.source ?? (current.custom === true ? current.source : undefined);
			if (typeof code !== "string") return fail("invalid_arguments", `use_kit is for custom code: ${change.element_id} is the library composition ${current.name ?? ""} (send a source to make it custom).`);
			if (!usesKitMarker(code)) change.source = withKitMarker(code);
		}
		const code = change.source ?? (current.custom === true ? current.source : null);
		if (usesKitMarker(code) && !hasTimelineKit && !paramsKitName(code)) return noKitAnswer(timelineId);
		// a piece timed on the timeline (`t0` param) follows its clip when the clip has moved
		if (change.props?.t0 === undefined) {
			const manifest = manifestOf(code ?? (current.name ? await librarySource(current.name) : null));
			if (manifest?.params && "t0" in manifest.params) {
				const origin = clipOrigin(target.element);
				const now = typeof current.props?.t0 === "number" ? current.props.t0 : (manifest.params.t0?.default as number | undefined);
				if (typeof now !== "number" || Math.abs(now - origin) > 0.0005) {
					change.props = { ...(change.props ?? {}), t0: origin };
					t0Synced[change.element_id] = origin;
				}
			}
		}
	}
	const single = changes.length === 1 ? changes[0] : undefined;
	const titles = changes.map((change) => {
		const element = findElement(head.snapshot as ProjectSnapshot, change.element_id)?.element as SnapshotElement;
		return compositionOf(element)?.title ?? element?.name ?? compositionOf(element)?.name ?? change.element_id;
	});
	const message =
		typeof args.message === "string" && args.message.trim()
			? args.message.trim()
			: single
				? `composition: ${titles[0]} (updated)`
				: `compositions: ${changes.length} updated (${[...new Set(titles)].slice(0, 3).join(", ")}${changes.length > 3 ? "…" : ""})`;
	for (const change of changes) change.note = message;
	const outcome = await commitAsClaude({ timelineId, ops: [], message, actor: actorOf(ctx), baseCommit: head.head.id, branch, compositions: changes, signal: ctx.signal });
	if (!outcome.ok) return outcomeFailure(outcome, timelineId, args);
	if (!outcome.commit) {
		const first = changes[0] as CompositionChange;
		return { payload: { unchanged: true, element_ids: outcome.unchanged ?? changes.map((change) => change.element_id), next: { do: "Nothing changed: same code, props and length.", tool: "composition", arguments: { action: "get", timeline_id: timelineId, element_id: first.element_id } } } };
	}
	const views = outcome.compositions as Array<Record<string, unknown>>;
	const view = views[0] ?? {};
	const after = single ? compositionOf(findElement(outcome.snapshot, single.element_id)?.element as SnapshotElement) : null;
	return {
		payload: {
			commit_id: outcome.commit.id,
			...(single
				? {
						element_id: single.element_id,
						media_id: view.media_id ?? null,
						duration_s: view.duration_s,
						title: view.title,
						kind: view.kind,
						hash: view.hash,
						previous_hash: view.previous_hash ?? null,
						props: after?.props ?? {},
						changed: view.props,
						source_changed: single.source !== undefined,
						...(view.converted ? { converted: view.converted } : {}),
						render: view.render,
						...(view.warnings ? { warnings: view.warnings } : {}),
						version: after?.versions?.[after.versions.length - 1]?.v ?? null,
					}
				: { updated: views.length, compositions: views }),
			...(Object.keys(t0Synced).length ? { t0_synced: t0Synced } : {}),
			...(outcome.unchanged?.length ? { unchanged: outcome.unchanged } : {}),
			message,
			editor: EDITOR_NOTE,
			next: single
				? { do: "Read it back, or see its versions.", tool: "composition", arguments: { action: "history", timeline_id: timelineId, element_id: single.element_id } }
				: { do: "Look at the change: render a preview of this commit, then look.", tool: "render", arguments: { timeline_id: timelineId, commit: outcome.commit.id, quality: "preview" } },
		},
	};
}

async function get(args: Record<string, unknown>): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "for get").trim();
	const elementId = need(args, "element_id", "for get").trim();
	const head = await getProjectHead(timelineId, typeof args.branch === "string" && args.branch ? args.branch : undefined);
	const target = head.snapshot ? findElement(head.snapshot, elementId) : null;
	const current = target ? compositionOf(target.element) : null;
	if (!target || !current) {
		const out = fail("not_found", target ? "That element is not a composition." : `No element ${elementId} on this timeline.`);
		(out.payload as Payload).next = { do: "Read the summary for element ids.", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } };
		return out;
	}
	const custom = current.custom === true;
	// library compositions: their source is the package's file (revise-v2: so a code change can start from it)
	const source = custom ? (current.source ?? "") : current.name ? await librarySource(current.name) : null;
	const manifest = manifestOf(source);
	const effect = (target.element.restorff as { effect?: { id?: string; layer?: string; fed_from_matte?: string[] } } | undefined)?.effect;
	const layered = !!effect && (!!effect.layer || !!effect.fed_from_matte?.length);
	const versions = versionsOf(current);
	const timelineKit = head.snapshot ? timelineKitOf(head.snapshot) : null;
	const libraryKit = paramsKitName(source);
	return {
		payload: {
			timeline_id: timelineId,
			head: head.head.id,
			element_id: elementId,
			track: { id: target.track.id, name: target.track.name ?? null },
			t: toSeconds(target.element.startTime),
			duration_s: toSeconds(target.element.duration),
			custom,
			name: current.name ?? null,
			title: current.title ?? null,
			author: current.author ?? null,
			props: current.props ?? {},
			...(manifest ? { params: manifest.params } : {}),
			hash: current.hash ?? null,
			size: { width: current.width ?? null, height: current.height ?? null, fps: current.fps ?? null },
			// composition-v3
			versions: { count: versions.length, current: versions[versions.length - 1]?.v ?? null },
			...(usesKitMarker(source) || libraryKit
				? {
						kit: {
							includes_marker: usesKitMarker(source),
							...(libraryKit ? { library_kit: libraryKit } : {}),
							timeline_kit: timelineKit ? timelineKit.sha.slice(0, 12) : null,
							...(custom ? {} : libraryKit ? { fork_as_code: `This library piece runs on the library kit ${libraryKit}: a source you send with update {source} renders with it while the timeline has no kit; to share one kit across code clips: composition kit {library_kit: "${libraryKit}"}.` } : {}),
						},
					}
				: {}),
			...(source !== null ? { source, source_from: custom ? "clip" : "library" } : {}),
			...(layered ? { layered_effect: effect, note: "One layer of a layered effect: change it with the effects tool (its plates come from the person matte)." } : custom ? {} : { note: "A library composition: update {props} re-renders it from the library with the new params; update {source} makes it a custom composition with your code." }),
			next: layered
				? { do: "Change the effect with the effects tool.", tool: "effects", arguments: { action: "list", timeline_id: timelineId } }
				: { do: "Change it: send new props (merged; null removes) and/or a new source.", tool: "composition", arguments: { action: "update", timeline_id: timelineId, element_id: elementId, base_commit: head.head.id, props: {} } },
		},
	};
}

/** composition-v3: an element's versions, oldest first, each with what changed from the one before. */
async function history(args: Record<string, unknown>): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "for history").trim();
	const elementId = need(args, "element_id", "for history").trim();
	const head = await getProjectHead(timelineId, typeof args.branch === "string" && args.branch ? args.branch : undefined);
	const target = head.snapshot ? findElement(head.snapshot, elementId) : null;
	const current = target ? compositionOf(target.element) : null;
	if (!target || !current) {
		const out = fail("not_found", target ? "That element is not a composition." : `No element ${elementId} on this timeline.`);
		(out.payload as Payload).next = { do: "Read the summary for element ids.", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } };
		return out;
	}
	const rows = await versionRows(current);
	const last = rows[rows.length - 1];
	return {
		payload: {
			timeline_id: timelineId,
			head: head.head.id,
			element_id: elementId,
			title: current.title ?? current.name ?? null,
			current: last?.v ?? null,
			count: rows.length,
			versions: rows,
			next:
				rows.length > 1
					? { do: "Put an earlier version back (one commit, recorded as a new version).", tool: "composition", arguments: { action: "revert", timeline_id: timelineId, element_id: elementId, version: (rows[rows.length - 2] as { v: number }).v } }
					: { do: "Only one version so far: change it with update.", tool: "composition", arguments: { action: "update", timeline_id: timelineId, element_id: elementId, props: {} } },
		},
	};
}

/** composition-v3: put a version back — its source, its props exactly, its length — as ONE commit (a new version). */
async function revert(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "for revert").trim();
	const elementId = need(args, "element_id", "for revert").trim();
	const branch = typeof args.branch === "string" && args.branch ? args.branch : undefined;
	const head = await getProjectHead(timelineId, branch);
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot.");
	const base = typeof args.base_commit === "string" ? args.base_commit : undefined;
	if (!baseMatches(base, head.head.id)) return conflict(timelineId, head.head.id, base ?? "");
	const target = findElement(head.snapshot, elementId);
	const current = target ? compositionOf(target.element) : null;
	if (!target || !current) return fail("not_found", target ? "That element is not a composition." : `No element ${elementId} on this timeline.`);
	const versions = versionsOf(current);
	const shas = versions.flatMap((v) => [v.props_sha, ...(v.source_sha ? [v.source_sha] : [])]);
	const planned = planRevert(current, args.version, await compositionStore().get(shas), toSeconds(target.element.duration));
	if (!planned.ok) {
		if (planned.code === "unchanged") return { payload: { unchanged: true, element_id: elementId, note: `${planned.message}.` } };
		const out = fail(planned.code, `${elementId}: ${planned.message}. Nothing was committed.`);
		(out.payload as Payload).next = { do: "List its versions.", tool: "composition", arguments: { action: "history", timeline_id: timelineId, element_id: elementId } };
		return out;
	}
	const { want } = planned.plan;
	const change: CompositionChange = {
		element_id: elementId,
		props: planned.plan.props,
		...(planned.plan.source !== undefined ? { source: planned.plan.source } : {}),
		...(planned.plan.duration_s !== undefined ? { duration_s: planned.plan.duration_s } : {}),
		note: planned.plan.note,
	};
	const title = current.title ?? current.name ?? elementId;
	const message = typeof args.message === "string" && args.message.trim() ? args.message.trim() : `composition: ${title} back to v${want.v}`;
	const outcome = await commitAsClaude({ timelineId, ops: [], message, actor: actorOf(ctx), baseCommit: head.head.id, branch, compositions: [change], signal: ctx.signal });
	if (!outcome.ok) return outcomeFailure(outcome, timelineId, args);
	if (!outcome.commit) return { payload: { unchanged: true, element_id: elementId, note: `The render is already v${want.v}'s (same code, props and length).` } };
	const view = (outcome.compositions as Array<Record<string, unknown>>)[0] ?? {};
	const after = compositionOf(findElement(outcome.snapshot, elementId)?.element as SnapshotElement);
	const timelineKit = timelineKitOf(head.snapshot);
	return {
		payload: {
			commit_id: outcome.commit.id,
			element_id: elementId,
			reverted_to: want.v,
			version: after?.versions?.[after.versions.length - 1]?.v ?? null,
			hash: view.hash,
			previous_hash: view.previous_hash ?? null,
			same_render_as_then: !!want.hash && view.hash === want.hash,
			changed: view.props,
			source_changed: change.source !== undefined,
			...(want.kit_sha && timelineKit && want.kit_sha !== timelineKit.sha ? { kit_note: `v${want.v} rendered with kit ${want.kit_sha.slice(0, 12)}; it re-rendered with the timeline's current kit ${timelineKit.sha.slice(0, 12)} (the kit is timeline-wide: composition kit sets it).` } : {}),
			render: view.render,
			message,
			editor: EDITOR_NOTE,
			next: { do: "See the versions now.", tool: "composition", arguments: { action: "history", timeline_id: timelineId, element_id: elementId } },
		},
	};
}

/**
 * composition-v3: the timeline kit. No kit / library_kit → read it. Otherwise validate, store, re-render every custom
 * clip that includes it with the NEW kit and commit all of it (the kit pointer + the swapped renders) as ONE commit.
 */
async function kit(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "for kit").trim();
	const branch = typeof args.branch === "string" && args.branch ? args.branch : undefined;
	const head = await getProjectHead(timelineId, branch);
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot.");
	const snapshot0 = head.snapshot;
	const current = timelineKitOf(snapshot0);
	const { including, others } = kitClips(snapshot0);
	const clipRow = ({ element }: { element: SnapshotElement }) => {
		const c = compositionOf(element);
		return { element_id: element.id, title: c?.title ?? c?.name ?? element.name ?? null, hash: c?.hash ?? null };
	};
	const libraryKit = typeof args.library_kit === "string" && args.library_kit.trim() ? args.library_kit.trim() : undefined;
	if (args.kit === undefined && !libraryKit) {
		const loaded = current ? await timelineKitInput(snapshot0).catch(() => null) : null;
		return {
			payload: {
				timeline_id: timelineId,
				head: head.head.id,
				kit: current ? { sha: current.sha, bytes: current.bytes, from: current.from, at: current.at, by: current.by ?? null, earlier: (current.history ?? []).map((h) => ({ sha: h.sha.slice(0, 12), at: h.at, from: h.from })) } : null,
				...(loaded ? { code: loaded.kit } : {}),
				including: including.map(clipRow),
				not_including: others.length,
				marker: KIT_MARKER,
				next: current
					? { do: "Change the kit: every clip that includes it re-renders in one commit.", tool: "composition", arguments: { action: "kit", timeline_id: timelineId, kit: { js: "…" }, dry_run: true } }
					: { do: "Set a kit (your shared helpers/styles, or a library kit).", tool: "composition", arguments: { action: "kit", timeline_id: timelineId, library_kit: "neon-grid" } },
			},
		};
	}
	if (args.kit === null) return fail("invalid_arguments", "Removing the kit is not supported: clips that include it would no longer render. Send a new kit, or take the marker out of each clip's source.");
	let input: KitInput;
	let from: string;
	if (libraryKit) {
		try {
			const lib = await callService<{ name: string; js: string; css?: string }>({ verb: "library-kit", request: { name: libraryKit } });
			input = { js: lib.js, ...(lib.css ? { css: lib.css } : {}) };
			from = `library:${lib.name}`;
		} catch (error) {
			if (error instanceof ServiceError) return fail("not_found", error.message);
			throw error;
		}
	} else {
		const raw = args.kit;
		if (typeof raw === "string") input = raw;
		else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			const o = raw as Record<string, unknown>;
			const pick = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? { [k]: o[k] as string } : {});
			input = { ...pick("css"), ...pick("js"), ...pick("html") };
		} else return fail("invalid_arguments", "kit must be HTML text or {css?, js?, html?}.");
		from = "inline";
	}
	const checked = await callService<{ ok: boolean; errors: string[]; warnings: string[]; bytes: number }>({ verb: "kit-validate", request: { kit: input } });
	if (!checked.ok) {
		const out = fail("refused", "The kit was refused; nothing was stored, rendered or committed.", { errors: checked.errors, warnings: checked.warnings });
		(out.payload as Payload).next = { do: "Fix every error (the kit follows the composition rules and only defines: no RC.composition).", tool: "composition", arguments: { action: "contract" } };
		return out;
	}
	const body = kitBody(input);
	const sha = sha256(body);
	if (current?.sha === sha) return { payload: { unchanged: true, kit: { sha: sha.slice(0, 12), from: current.from }, including: including.map(clipRow), note: "The timeline already has this kit." } };
	if (args.dry_run === true) {
		return {
			payload: {
				dry_run: true,
				kit: { sha: sha.slice(0, 12), bytes: checked.bytes, from, previous: current ? current.sha.slice(0, 12) : null },
				would_rerender: including.map(clipRow),
				untouched: others.map(clipRow),
				warnings: checked.warnings,
				next: { do: "Set it (one commit).", tool: "composition", arguments: { action: "kit", timeline_id: timelineId, ...(libraryKit ? { library_kit: libraryKit } : { kit: "…the same kit…" }) } },
			},
		};
	}
	await compositionStore().put([{ kind: "kit", body }]);
	const changes: CompositionChange[] = including.map(({ element }) => ({ element_id: element.id, kit: { kit: input, sha }, note: `kit ${sha.slice(0, 8)} (${from})` }));
	let rendered: RenderedChange[] = [];
	const unchanged: string[] = [];
	if (changes.length) {
		const done = await renderChanges(snapshot0, changes, ctx.signal);
		if (!done.ok) return outcomeFailure({ code: done.code === "refused" ? "render_refused" : done.code, message: done.message, details: { element_id: done.element_id, ...(done.details ? { details: done.details } : {}) } }, timelineId, args);
		rendered = done.rendered.filter((item) => {
			if (!isUnchanged(snapshot0, item)) return true;
			unchanged.push(item.change.element_id);
			return false;
		});
	}
	const batch = importOps(rendered);
	const result = apply(snapshot0 as unknown as OpsProject, batch, { seed: `${timelineId}/${head.head.id}/kit/${sha}`, at: new Date().toISOString(), mode: "atomic" });
	if (!result.ok) return fail("ops_conflict", "The reducer refused the batch. Nothing was committed.", { conflicts: result.conflicts.slice(0, 10) });
	const snapshot = result.project as unknown as ProjectSnapshot;
	const swapped = swapRendered(snapshot, result.changes.refs, rendered);
	if (swapped) return fail(swapped.code, swapped.message, { element_id: swapped.element_id ?? null });
	const record = setTimelineKit(snapshot, { sha, bytes: checked.bytes, at: new Date().toISOString(), by: actorOf(ctx).name, from });
	await uploadRendered(timelineId, rendered);
	if (ctx.signal.aborted) return fail("stopped", "The call ran out of time before committing; nothing was committed (renders are cached: the same call again is fast).");
	const message = typeof args.message === "string" && args.message.trim() ? args.message.trim() : `composition kit: ${from} (${rendered.length} clip${rendered.length === 1 ? "" : "s"} re-rendered)`;
	const done = await commit(ctx, timelineId, head.head.id, head.branch, snapshot, result.changes.applied, message);
	if (!done.ok) return done.out;
	return {
		payload: {
			commit_id: done.commitId,
			kit: { sha: record.sha.slice(0, 12), bytes: record.bytes, from: record.from, previous: current ? current.sha.slice(0, 12) : null },
			rerendered: rendered.map(renderedView),
			...(unchanged.length ? { unchanged } : {}),
			untouched: others.map(clipRow),
			warnings: checked.warnings,
			message,
			editor: EDITOR_NOTE,
			next: { do: "Look at the re-rendered clips: render a preview of this commit.", tool: "render", arguments: { timeline_id: timelineId, commit: done.commitId, quality: "preview" } },
		},
	};
}

// ─── the tool ─────────────────────────────────────────────────────────────────────────────────────────────────

const str = (description: string): JsonSchema => ({ type: "string", description });

export const COMPOSITION_TOOL: Tool = {
	name: "composition",
	title: "Motion graphics as code",
	description:
		"Write a motion graphic as one HTML/CSS/JS file (a pure function of time), and it lands on the timeline's MOTION track as a transparent video, committed as Claude. contract = how to write one (read it first, with a real example; also the cue / scene / text declarations, the kit rules and the library kits); write = source + props + duration_s + t → validated, rendered with the network blocked, placed and committed — or library: \"<name>\" + props to place a library composition (a `t0` param is filled from t); update = new props (merged; null removes) and/or source and/or duration_s → re-rendered in place, as ONE commit for one clip (element_id), several clips with the same props (element_ids: [...]) or different changes (updates: [{element_id, props?, source?, duration_s?}]) — library compositions (placed by effects or a style) take new props too, and a new source makes one custom; get = an element's source (a library one's from the package), its props and its params (types, ranges); history = an element's versions (every write / update / revise / revert / kit change keeps one) and what changed; revert = put a version back in ONE commit; kit = the timeline's shared code ({js, css?} or library_kit) — setting it re-renders exactly the clips whose source has <!-- rc-kit --> in ONE commit (use_kit: true on write / update adds the marker). For a person's sentence (\"make the titles bigger\") prefer revise: it finds the compositions and changes them in one commit. The code travels with the commit, so it can always be reopened and changed. Before writing one, read guide {topic: \"composition-authoring\"} (how to make it good) and \"composition-example\" (a worked piece).",
	inputSchema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["contract", "write", "update", "get", "history", "revert", "kit"] },
			timeline_id: str("write, update, get, history, revert, kit: the timeline (project id from timeline list)."),
			source: str("write (required unless library), update: the whole HTML file, at most 256 KB, everything inline (no network)."),
			library: str("write: place a LIBRARY composition by name instead of a source (e.g. neon-hook); props = its params (on-screen words must be sent)."),
			props: { type: "object", description: "write, update: values for the params block (JSON object). update merges them into the stored props; null removes a key. A piece with a t0 param gets t0 = t (write) / its clip's start (update) unless you send one. An image value may be a media_id of this timeline (media import answers it; a video's id = its frame at 1 s), media:<id> or this server's /api/projects/<timeline>/media/<id> URL: the server inlines it before the network-blocked render (the stored props keep the id)." },
			duration_s: { type: "number", description: "write, update: length in seconds (default: the params block's duration, else 4; at most 60).", minimum: 0.1, maximum: 60 },
			t: { type: "number", description: "write: where the clip starts on the timeline, in seconds (default 0).", minimum: 0 },
			use_kit: { type: "boolean", description: "write, update: include the timeline's kit — puts <!-- rc-kit --> into the source's <head> (set the kit first with action kit)." },
			element_id: str("update, get, history, revert: the clip's element id (from a write result or timeline summary)."),
			element_ids: { type: "array", items: { type: "string" }, description: "update: several clips that take the same props / duration_s — one commit." },
			updates: {
				type: "array",
				items: { type: "object", description: "{element_id, props?, source?, duration_s?}" },
				description: "update: different changes on several clips — one commit. Each item: {element_id, props? (merged; null removes), source?, duration_s?}.",
			},
			version: { type: ["number", "string"], description: "revert: the version number to put back (history lists them), or \"previous\"." },
			kit: { type: ["object", "string", "null"], description: "kit: the timeline's shared code, {js?, css?, html?} or HTML text, at most 128 KB, same rules as a composition (only defines; no RC.composition)." },
			library_kit: str("kit: use a library kit as the timeline's kit (packages/compositions/kits/<name>.js, e.g. neon-grid; contract lists them)."),
			dry_run: { type: "boolean", description: "kit: say which clips would re-render, change nothing." },
			base_commit: str("write, update, revert: optional; the head you read. If the timeline moved on, nothing is done (conflict). Omit to build on the current head."),
			message: str("write, update, revert, kit: the commit message (default: composition: <title>)."),
			branch: str("Branch (default: the project's default branch)."),
		},
		required: ["action"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	// a render takes ~1 s per output second at 1080×1920 plus ~1 s to start Chromium; 60 s is the longest allowed
	budgetSeconds: 180,
	async run(args, ctx) {
		switch (args.action) {
			case "contract":
				return contract();
			case "write":
				return write(args, ctx);
			case "update":
				return update(args, ctx);
			case "get":
				return get(args);
			case "history":
				return history(args);
			case "revert":
				return revert(args, ctx);
			case "kit":
				return kit(args, ctx);
			default:
				return fail("invalid_arguments", `Unknown action ${String(args.action)}.`);
		}
	},
};

/** The line the server's instructions get, so a Claude knows the tool exists and where to start. */
export const COMPOSITION_INSTRUCTIONS =
	"For motion graphics (kinetic type, 3D grids, charts, titles), write them as code: composition contract → composition write (source, props, duration_s, t) → the clip lands on MOTION; composition update changes it in place — several clips in one commit with element_ids or updates, library ones included (props); composition history / revert for earlier versions; composition kit for code shared by a timeline's compositions; composition write {library} places a library piece (the neon-grid kit: every word and time a param).";
