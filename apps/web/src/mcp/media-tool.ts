/**
 * MCP: get a timeline and media in, sound it, link it (mcp-media agent, 2026-10-20; PARITY G01, G09, G12).
 *
 *   timeline create   {name, aspect?, fps?} → a new server project with Restorff's named lanes, committed by claude
 *   timeline share    {timeline_id, can_comment?, expires_in?, commit_id?} → a review link + the editor link
 *   media import      {timeline_id, url | data_base64 | path_hint | upload_id, name?, kind?, place?} → ffprobe →
 *                     the project's media store (sha256) → import_media (+ insert) as ONE commit by claude
 *   media upload_url  {timeline_id, name?} → a signed PUT URL for a big file (then import {upload_id})
 *   media list        {timeline_id} → the manifest, what plays it, and which files the server holds
 *   sounds list       {tag?, category?, query?} → the built-in SFX pack (generated, ours)
 *   sounds place      {timeline_id, name, t | element_id} → the sound's event lands on t → one commit
 *                     {timeline_id, items: [{name, t | element_id, at?, db?, why?}]} → all of them, ONE commit
 *                     (sound-voice-v2, 2026-10-20)
 *   sounds design     {timeline_id, dry_run?, options?} → "Design the sound" on the server → one commit. Since
 *                     2026-10-20 (sound-voice-v2) the v2 planner (server/sound-design-plan.ts: real cuts only, hits on
 *                     the cut, composition cues via server/sound-design-cues.ts); options.planner "v1" = the editor
 *                     button's planner. Runbook: docs/restorff/worklog/sound-voice-v2.md.
 * Every timeline-scoped result also gets `editor_url` (handler.ts decorate → withLinks below).
 *
 * The editor pulls these commits like any other, and its importRemoteMedia downloads the imported files from the
 * server store (services/storage/service.ts). Runbook + example calls: docs/restorff/worklog/mcp-media.md.
 */
import { randomUUID } from "node:crypto";
import { apply, type Op, type Project as OpsProject, type SoundDesignOptions } from "@restorffcut/timeline-ops";
import type { Actor } from "@/server/auth";
import { HttpError } from "@/server/http";
import { listProjectMedia } from "@/server/media";
import {
	createUploadTicket,
	discard,
	forgetUpload,
	IMPORT_MAX_BYTES,
	type MediaKind,
	mimeFor,
	probeMedia,
	sha256File,
	type StagedFile,
	stageFromBase64,
	stageFromPath,
	stageFromUpload,
	stageFromUrl,
	storeStagedFile,
} from "@/server/media-import";
import { createProject, getProjectHead, pushCommit } from "@/server/projects";
import { createShareLink, SHARE_EXPIRY } from "@/server/share";
import {
	designSoundOnSnapshot,
	designSoundOnSnapshotV2,
	elementTimes,
	filterSounds,
	findSound,
	loadSfxPackFromDisk,
	type PlaceItem,
	planPlaceSound,
	planPlaceSounds,
} from "@/server/sound-design";
import { collectCompositionCues } from "@/server/sound-design-cues";
import type { DesignV2Options } from "@/server/sound-design-plan";
import { ASPECT_NAMES, ASPECTS, type Aspect, emptyProject, LANES } from "@/server/timeline-skeleton";
import type { ProjectSnapshot, SnapshotTrack } from "@/sync/snapshot";
import { mediaOf } from "./summary";
import { fail, type JsonSchema, type Payload, type Tool, type ToolContext, type ToolOutput } from "./protocol";

const TICKS = 120_000;
const seconds = (ticks: number) => Math.round((ticks / TICKS) * 1000) / 1000;

// ─── shared helpers ───────────────────────────────────────────────────────────────────────────────────────────

const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: "number", description, ...extra });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const oneOf = (values: string[], description?: string): JsonSchema => ({ type: "string", enum: values, ...(description ? { description } : {}) });

function actorOf(ctx: ToolContext): Actor {
	const kind = ctx.auth?.kind === "service" ? "service" : "local-dev";
	return { kind, id: ctx.auth?.userId ?? kind, name: ctx.auth?.name ?? "Claude (MCP)" };
}

function need(args: Record<string, unknown>, key: string, why: string): string {
	const value = args[key];
	if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} is required ${why}`);
	return value.trim();
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const baseMatches = (given: string | undefined, head: string) => !given || given === head || (given.length >= 7 && head.startsWith(given));

const summaryNext = (id: string, what = "Read the timeline summary (element ids, times) before editing.") => ({
	do: what,
	tool: "timeline",
	arguments: { action: "summary", timeline_id: id },
});

function conflict(timelineId: string, head: string, given: string): ToolOutput {
	const out = fail("conflict", `The timeline moved on: its head is ${head}, not ${given}. Nothing was committed.`, { head });
	(out.payload as Payload).next = summaryNext(timelineId, "Read the timeline again, then retry on its head (or omit base_commit).");
	return out;
}

/** Commit a snapshot as Claude; a race with another writer comes back as a conflict. */
async function commitSnapshot(
	ctx: ToolContext,
	timelineId: string,
	head: { id: string; branch: string },
	snapshot: OpsProject | ProjectSnapshot,
	ops: unknown[],
	message: string,
): Promise<{ ok: true; commitId: string; stats: unknown } | { ok: false; out: ToolOutput }> {
	const pushed = await pushCommit(timelineId, { base_commit: head.id, branch: head.branch, author: "claude", snapshot, ops, message }, actorOf(ctx));
	if (!pushed.ok) return { ok: false, out: conflict(timelineId, pushed.conflict.head.id, head.id) };
	return { ok: true, commitId: pushed.commit.id, stats: pushed.commit.stats };
}

// ─── links (G12) ──────────────────────────────────────────────────────────────────────────────────────────────

/** The server's public base: RESTORFFCUT_PUBLIC_URL, else the origin the call came in on (as POST /api/share does). */
export function publicOrigin(request: Request | undefined | null): string {
	const configured = process.env.RESTORFFCUT_PUBLIC_URL?.trim().replace(/\/$/, "");
	if (configured) return configured;
	try {
		if (request?.url) return new URL(request.url).origin;
	} catch {
		// fall through
	}
	return "http://localhost:8791";
}

/** `/editor/<id>` opens a server project by link (the editor loads it from the server if this browser lacks it). */
export function editorUrl(request: Request | undefined | null, timelineId: string): string {
	return `${publicOrigin(request)}/editor/${encodeURIComponent(timelineId)}`;
}

/**
 * handler.ts decorate: every successful result about one timeline (a summary, a commit, an import…) gets the link a
 * person opens it with, just before `next`. Results that already carry `editor_url` are left alone.
 */
export function withLinks(payload: Payload, args: Record<string, unknown> | undefined, request: Request | undefined | null): Payload {
	if (typeof payload.editor_url === "string") return payload;
	const id = typeof payload.timeline_id === "string" ? payload.timeline_id : typeof args?.timeline_id === "string" ? args.timeline_id.trim() : "";
	if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return payload;
	const { next, ...rest } = payload;
	return next === undefined ? { ...rest, editor_url: editorUrl(request, id) } : { ...rest, editor_url: editorUrl(request, id), next };
}

// ─── timeline create / share ──────────────────────────────────────────────────────────────────────────────────

export async function createTimeline(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const name = (text(args.name) ?? "Untitled").slice(0, 200);
	const aspect = (text(args.aspect) ?? "9:16") as Aspect;
	if (!(aspect in ASPECTS)) return fail("invalid_arguments", `aspect must be one of ${ASPECT_NAMES.join(" · ")}`);
	const fps = typeof args.fps === "number" ? args.fps : 30;
	if (!(fps >= 1 && fps <= 120)) return fail("invalid_arguments", "fps must be between 1 and 120 (24, 25, 30, 50, 60; 29.97 works too)");
	const id = randomUUID();
	const snapshot = emptyProject({ id, name, aspect, fps });
	const { project, commit } = await createProject(actorOf(ctx), {
		id,
		name,
		snapshot,
		author: "claude",
		message: text(args.message) ?? `create ${name} (${aspect}, ${fps} fps)`,
	});
	const { width, height } = ASPECTS[aspect];
	return {
		payload: {
			timeline_id: project.id,
			name: project.name,
			head: commit.id,
			branch: project.default_branch,
			canvas: { aspect, w: width, h: height, fps },
			tracks: LANES.map((lane) => ({ id: lane.id, name: lane.name, group: lane.group, type: lane.type })),
			editor_url: editorUrl(ctx.request, project.id),
			notes: [
				"Lanes top to bottom: TEXT, CAPTIONS, V2 B-ROLL (overlays), V1 A-ROLL (main: clips butt together from 0 s), MUSIC, SFX.",
				"media import's place.track takes a lane name (\"V1\", \"V2\", \"MUSIC\", \"SFX\", \"TEXT\") or a track id.",
			],
			next: {
				do: "Bring the footage in and put it on V1 (one call per file; repeat for each clip).",
				tool: "media",
				arguments: { action: "import", timeline_id: project.id, url: "https://…/take-1.mp4", name: "take-1.mp4", place: { track: "V1" } },
			},
		},
	};
}

export async function shareTimeline(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const id = need(args, "timeline_id", "for share");
	const expiresIn = text(args.expires_in) ?? "7d";
	if (!(expiresIn in SHARE_EXPIRY)) return fail("invalid_arguments", `expires_in must be one of ${Object.keys(SHARE_EXPIRY).join(" · ")}`);
	const canComment = args.can_comment === undefined ? true : args.can_comment === true;
	const result = await createShareLink(
		actorOf(ctx),
		{ project_id: id, commit_id: text(args.commit_id), branch: text(args.branch), can_comment: canComment, expires_in: expiresIn },
		publicOrigin(ctx.request),
	);
	return {
		payload: {
			timeline_id: id,
			url: result.url,
			editor_url: result.editor_url,
			link: {
				id: result.link.id,
				can_comment: result.link.can_comment,
				pinned_commit: result.link.commit_id,
				follows_branch: result.link.pinned ? null : result.link.branch,
				expires_at: result.link.expires_at,
			},
			notes: [
				`url opens a read-only review player${canComment ? " where the person can leave comments pinned to a time" : ""}; it is shown only once (the server keeps its hash).`,
				"editor_url opens the timeline in the editor itself.",
				result.link.pinned ? "The link is pinned to that commit." : "The link follows the branch head: later commits show up in it.",
			],
			next: canComment
				? { do: "After the person has looked, read their comments.", tool: "timeline", arguments: { action: "comments", timeline_id: id } }
				: summaryNext(id),
		},
	};
}

// ─── media ────────────────────────────────────────────────────────────────────────────────────────────────────

function activeScene(snapshot: ProjectSnapshot) {
	const scenes = snapshot.scenes ?? [];
	return scenes.find((scene) => scene.id === snapshot.currentSceneId) ?? scenes.find((scene) => scene.isMain) ?? scenes[0] ?? null;
}

function sceneTracks(snapshot: ProjectSnapshot): Array<{ track: SnapshotTrack; group: "overlay" | "main" | "audio" }> {
	const tracks = activeScene(snapshot)?.tracks;
	if (!tracks) return [];
	return [
		...(tracks.overlay ?? []).map((track) => ({ track, group: "overlay" as const })),
		...(tracks.main ? [{ track: tracks.main, group: "main" as const }] : []),
		...(tracks.audio ?? []).map((track) => ({ track, group: "audio" as const })),
	];
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A track id, "main", or a lane name: "V1 A-ROLL", "V1", "A-roll", "V2", "B-roll", "MUSIC", "SFX", "TEXT"… */
export function resolveTrack(snapshot: ProjectSnapshot, wanted: string): { track: SnapshotTrack; group: string } | null {
	const all = sceneTracks(snapshot);
	const byId = all.find(({ track }) => track.id === wanted);
	if (byId) return byId;
	const w = norm(wanted);
	if (!w) return null;
	const main = all.find(({ group }) => group === "main");
	if (main && ["main", "v1", "aroll", "a", "v1aroll", "maintrack"].includes(w)) return main;
	const exact = all.find(({ track }) => norm(track.name ?? "") === w);
	if (exact) return exact;
	const token = all.find(({ track }) => (track.name ?? "").split(/\s+/).some((part) => norm(part) === w));
	if (token) return token;
	if (["broll", "b", "overlay", "v2"].includes(w)) return all.find(({ track, group }) => group === "overlay" && track.type === "video") ?? null;
	if (["music", "bed"].includes(w)) return all.find(({ track }) => track.type === "audio" && (track.restorff?.role === "music" || /music/i.test(track.name ?? ""))) ?? null;
	if (["sfx", "sound", "sounds"].includes(w)) return all.find(({ track }) => track.type === "audio" && (track.restorff?.role === "sfx" || /sfx/i.test(track.name ?? ""))) ?? null;
	if (["audio", "voice", "vo"].includes(w)) return all.find(({ track }) => track.type === "audio") ?? null;
	return null;
}

const trackEnd = (track: SnapshotTrack) => seconds(Math.max(0, ...(track.elements ?? []).map((element) => element.startTime + element.duration)));

interface PlaceArgs {
	track?: string;
	t?: number;
	in?: number;
	out?: number;
	dur?: number;
}

async function uploadInstructions(ctx: ToolContext, timelineId: string, name: string | null, file: string | null, place: unknown, status?: string): Promise<ToolOutput> {
	const ticket = await createUploadTicket(timelineId, name);
	const putUrl = `${publicOrigin(ctx.request)}/api/media-uploads/${ticket.token}`;
	return {
		payload: {
			...(status ? { status } : {}),
			timeline_id: timelineId,
			upload_id: ticket.upload_id,
			put_url: putUrl,
			method: "PUT",
			expires_at: ticket.expires_at,
			max_bytes: ticket.max_bytes,
			curl: `curl -sS -T "${file ?? "<your file>"}" "${putUrl}"`,
			notes: [
				"PUT the raw file to put_url (no auth header: the URL is the credential, valid for an hour). It answers 201 {upload_id, bytes, sha256}.",
				"Then call media import with this upload_id to probe, store and place it.",
			],
			next: {
				do: "Upload the file to put_url, then finish the import.",
				tool: "media",
				arguments: { action: "import", timeline_id: timelineId, upload_id: ticket.upload_id, ...(name ? { name } : {}), ...(place ? { place } : {}) },
			},
		},
	};
}

async function importMedia(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "for media import");
	const sources = (["url", "data_base64", "path_hint", "upload_id"] as const).filter((key) => text(args[key]));
	if (sources.length !== 1) {
		const out = fail(
			"invalid_arguments",
			sources.length
				? `Give exactly one source, not ${sources.join(" + ")}.`
				: "Give one source: url (the server fetches it), data_base64 (≤ ~700 KB), path_hint (a file on the server's disk) or upload_id (after media upload_url).",
		);
		(out.payload as Payload).next = { do: "For a big file on your machine, get an upload URL.", tool: "media", arguments: { action: "upload_url", timeline_id: timelineId } };
		return out;
	}
	const place = args.place as PlaceArgs | undefined;
	if (place !== undefined && (typeof place !== "object" || place === null || Array.isArray(place))) return fail("invalid_arguments", "place must be an object {track, t?, in?, out?, dur?}");
	if (place && typeof place.track !== "string") return fail("invalid_arguments", "place.track is required: a lane name (V1, V2, MUSIC, SFX) or a track id");
	for (const key of ["t", "in", "out", "dur"] as const) {
		if (place?.[key] !== undefined && !(typeof place[key] === "number" && Number.isFinite(place[key]) && (place[key] as number) >= 0)) {
			return fail("invalid_arguments", `place.${key} must be a number of seconds ≥ 0`);
		}
	}
	const kindWanted = text(args.kind) as MediaKind | undefined;
	const branch = text(args.branch);

	// the head first: a wrong timeline id should fail before anything is fetched
	const head = await getProjectHead(timelineId, branch);
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot to add to.");
	const base = text(args.base_commit);
	if (!baseMatches(base, head.head.id)) return conflict(timelineId, head.head.id, base ?? "");
	const placeTrack = place ? resolveTrack(head.snapshot, place.track as string) : null;
	if (place && !placeTrack) {
		return fail("unknown_track", `No track "${place.track}" on this timeline. Nothing was imported.`, {
			tracks: sceneTracks(head.snapshot).map(({ track }) => ({ id: track.id, name: track.name ?? null, type: track.type })),
		});
	}

	let staged: StagedFile | null = null;
	const source = sources[0];
	try {
		if (source === "url") staged = await stageFromUrl(text(args.url) as string, ctx.signal);
		else if (source === "data_base64") staged = await stageFromBase64(args.data_base64 as string, text(args.name) ?? null);
		else if (source === "upload_id") staged = await stageFromUpload(text(args.upload_id) as string, timelineId);
		else {
			const hint = text(args.path_hint) as string;
			staged = stageFromPath(hint);
			if (!staged) return uploadInstructions(ctx, timelineId, text(args.name) ?? hint.split(/[\\/]/).pop() ?? null, hint, place, "upload_needed");
		}

		const probe = await probeMedia(staged.file);
		if (kindWanted && kindWanted !== probe.kind) {
			const ok = (kindWanted === "audio" && probe.hasAudio) || (kindWanted === "image" && probe.kind === "video" && probe.duration === null);
			if (!ok) return fail("kind_mismatch", `The file is ${probe.kind}${probe.hasAudio ? " with audio" : ""}, not ${kindWanted}. Nothing was imported.`, { probe });
		}
		const kind: MediaKind = kindWanted ?? probe.kind;
		const sha = await sha256File(staged.file);
		const name = (text(args.name) ?? staged.nameHint ?? `${kind}-${sha.slice(0, 8)}`).slice(0, 200);
		const mime = mimeFor(staged, probe, name);

		const ops: Record<string, unknown>[] = [
			{
				op: "import_media",
				author: "claude",
				kind,
				name,
				blob_sha: sha,
				...(probe.duration !== null && kind !== "image" ? { duration: probe.duration } : {}),
				...(probe.width ? { width: probe.width, height: probe.height } : {}),
				...(probe.fps ? { fps: probe.fps } : {}),
				has_audio: probe.hasAudio,
				ref: "imported",
			},
		];
		let placed: { track: { id: string; name: string | null }; t: number; in?: number; out?: number; dur?: number } | null = null;
		if (place && placeTrack) {
			const t = typeof place.t === "number" ? place.t : trackEnd(placeTrack.track);
			const insert: Record<string, unknown> = { op: "insert", author: "claude", track: placeTrack.group === "main" ? "main" : placeTrack.track.id, t, media: "imported", name, ref: "placed" };
			if (kind === "image") insert.dur = place.dur ?? 3;
			else {
				const length = probe.duration ?? undefined;
				const inPoint = place.in ?? 0;
				const outPoint = place.out ?? (place.dur !== undefined ? inPoint + place.dur : length);
				if (outPoint === undefined) return fail("invalid_arguments", "The file's length is unknown: give place.out or place.dur.");
				if (length !== undefined && outPoint > length + 1e-3) return fail("invalid_arguments", `place.out ${outPoint} s is past the end of the file (${length} s).`);
				if (outPoint <= inPoint) return fail("invalid_arguments", "place.out must be after place.in.");
				insert.in = inPoint;
				insert.out = Math.min(outPoint, length ?? outPoint);
			}
			ops.push(insert);
			placed = { track: { id: placeTrack.track.id, name: placeTrack.track.name ?? null }, t, ...(insert.in !== undefined ? { in: insert.in as number, out: insert.out as number } : { dur: insert.dur as number }) };
		}

		const result = apply(head.snapshot as unknown as OpsProject, ops as unknown as Op[], { seed: `${timelineId}/${head.head.id}/media-import/${sha}`, at: new Date().toISOString() });
		if (!result.ok) {
			const out = fail("ops_conflict", "The timeline refused the import (wrong track type, overlap, or out of range). Nothing was committed.", { conflicts: result.conflicts.slice(0, 10) });
			(out.payload as Payload).next = summaryNext(timelineId, "Read the summary for free spots and track types, then retry with another place.");
			return out;
		}
		const mediaId = result.changes.refs.imported;
		const elementId = result.changes.refs.placed;
		if (!mediaId) return fail("tool_failed", "The media id was not assigned (internal).");
		const reused = result.changes.ops[0]?.status !== "applied";

		const already = (await listProjectMedia(timelineId)).find((entry) => entry.media_id === mediaId);
		const stored = already?.hash === sha ? already : await storeStagedFile(timelineId, mediaId, staged, { name, mime, sha, probe, kind });
		if (source === "upload_id") forgetUpload(text(args.upload_id) as string);

		const probeView = {
			duration_s: probe.duration,
			width: probe.width,
			height: probe.height,
			fps: probe.fps,
			has_audio: probe.hasAudio,
			format: probe.format,
			video_codec: probe.video_codec,
			audio_codec: probe.audio_codec,
			...(probe.rotation ? { rotation: probe.rotation } : {}),
		};
		const storedView = { sha256: sha, bytes: stored.size, mime: stored.mime, deduplicated: already?.hash === sha };
		if (reused && !elementId) {
			return {
				payload: {
					timeline_id: timelineId,
					already_imported: true,
					media_id: mediaId,
					name,
					kind,
					probe: probeView,
					stored: storedView,
					next: { do: "It is already in this timeline's media: place it.", tool: "timeline_ops", arguments: { timeline_id: timelineId, base_commit: head.head.id, ops: [{ op: "insert", track: "main", t: 0, media: mediaId }], message: `place ${name}` } },
				},
			};
		}

		const message = text(args.message) ?? (placed ? `import ${name} → ${placed.track.name ?? placed.track.id} at ${placed.t} s` : `import ${name}`);
		const done = await commitSnapshot(ctx, timelineId, { id: head.head.id, branch: head.branch }, result.project, result.changes.applied, message);
		if (!done.ok) return done.out;
		const element = elementId ? result.changes.ops.find((change) => change.op === "insert") : undefined;
		return {
			payload: {
				timeline_id: timelineId,
				commit_id: done.commitId,
				media_id: mediaId,
				...(elementId ? { element_id: elementId } : {}),
				name,
				kind,
				source,
				probe: probeView,
				stored: storedView,
				...(placed ? { placed: { ...placed, ...(element?.summary ? { summary: element.summary } : {}) } } : {}),
				...(result.changes.warnings?.length ? { warnings: result.changes.warnings } : {}),
				editor: "The editor pulls this commit within ~15 s (or on focus) and downloads the file from the server's media store.",
				next: placed
					? summaryNext(timelineId, "Check where it landed (and its element id), then import the next clip or cut.")
					: {
							do: "Place it on a track.",
							tool: "timeline_ops",
							arguments: { timeline_id: timelineId, base_commit: done.commitId, ops: [{ op: "insert", track: "main", t: 0, media: mediaId }], message: `place ${name}` },
						},
			},
		};
	} finally {
		discard(staged);
	}
}

async function listMedia(args: Record<string, unknown>): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "for media list");
	const head = await getProjectHead(timelineId, text(args.branch));
	const [files, view] = [await listProjectMedia(timelineId), mediaOf(head.snapshot)];
	const onServer = new Map(files.map((file) => [file.media_id, file]));
	const usedBy = new Map(view.used.map((entry) => [entry.media, entry]));
	const manifestIds = new Set<string>();
	const media = (view.manifest as Array<Record<string, unknown>>).map((entry) => {
		const id = String(entry.id);
		manifestIds.add(id);
		const file = onServer.get(id);
		const used = usedBy.get(id);
		return {
			media_id: id,
			name: (entry.name as string | undefined) ?? null,
			kind: (entry.kind as string | undefined) ?? null,
			...(typeof entry.duration_s === "number" ? { duration_s: entry.duration_s } : {}),
			...(entry.width ? { width: entry.width, height: entry.height } : {}),
			...(entry.fps ? { fps: entry.fps } : {}),
			...(entry.hasAudio !== undefined ? { has_audio: entry.hasAudio } : {}),
			...(entry.url ? { url: entry.url } : {}),
			elements: used?.elements ?? 0,
			on_server: file ? { bytes: file.size, mime: file.mime, sha256: file.hash } : null,
		};
	});
	// media the editor imported itself (no ops manifest entry) but clips play, or the server holds
	const extra = [...new Set([...usedBy.keys(), ...onServer.keys()])]
		.filter((id) => !manifestIds.has(id))
		.map((id) => {
			const file = onServer.get(id);
			const used = usedBy.get(id);
			const meta = (file?.meta ?? {}) as Record<string, unknown>;
			return {
				media_id: id,
				name: (meta.name as string | undefined) ?? used?.names[0] ?? null,
				kind: (meta.type as string | undefined) ?? used?.kinds[0] ?? null,
				...(typeof meta.duration === "number" ? { duration_s: meta.duration } : {}),
				elements: used?.elements ?? 0,
				on_server: file ? { bytes: file.size, mime: file.mime, sha256: file.hash } : null,
			};
		});
	const all = [...media, ...extra];
	const missing = all.filter((entry) => entry.elements > 0 && !entry.on_server).length;
	return {
		payload: {
			timeline_id: timelineId,
			head: head.head.id,
			count: all.length,
			media: all,
			...(missing ? { notes: [`${missing} media used on the timeline have no file on the server yet (the editor uploads them when it next syncs); a server render cannot read those.`] } : {}),
			next: all.length ? summaryNext(timelineId) : { do: "Import something.", tool: "media", arguments: { action: "import", timeline_id: timelineId, url: "https://…/clip.mp4", place: { track: "V1" } } },
		},
	};
}

export const MEDIA_TOOL: Tool = {
	name: "media",
	title: "Media",
	description:
		"Bring footage, music, voice and images into a timeline, and list what it has. import: one source — url (the server fetches it; http/https), data_base64 (small files, the call body is capped at ~1 MB), path_hint (a file on the server's own disk; if the server cannot see it you get an upload URL instead) or upload_id (after upload_url + a PUT of the file) — is probed with ffprobe (kind, width, height, duration, fps, audio), stored in the timeline's media store (sha256, deduplicated) and, with place {track, t?, in?, out?, dur?}, put on a track: all ONE commit by claude. place.track is a lane name (\"V1\" = the A-roll main track, \"V2\" B-roll, \"MUSIC\", \"SFX\", \"TEXT\") or a track id; no t = after the last clip on that track. upload_url: a signed PUT URL (1 h) for big files on your machine — `curl -T file URL`, then import {upload_id}. list: every media with its kind, length, how many clips play it and whether the server holds the file.",
	inputSchema: {
		type: "object",
		properties: {
			action: oneOf(["import", "list", "upload_url"]),
			timeline_id: str("The timeline (from timeline create or timeline list)."),
			url: str("import: an http(s) URL of the file."),
			data_base64: str("import: the file's bytes as base64 (a data: URL is fine); small files only (~700 KB)."),
			path_hint: str("import: an absolute path of the file. Imported in place when the server can read it; otherwise the answer is an upload URL and a curl command for that path."),
			upload_id: str("import: the upload_id from upload_url, after the file was PUT."),
			name: str("import, upload_url: the media's name in the editor's bin (default: the file name)."),
			kind: oneOf(["video", "audio", "image"], "import: force a kind (default: what ffprobe finds; \"audio\" takes just the sound of a video)."),
			place: {
				type: "object",
				description: "import: also put it on the timeline: {track: lane name or track id, t?: start seconds (default: after the last clip on that track), in?/out?: source seconds (video/audio), dur?: seconds (images; default 3)}.",
			},
			base_commit: str("import: optional; the head you read. If the timeline moved on, nothing is done."),
			message: str("import: the commit message (default: import <name> → <track> at <t> s)."),
			branch: str("Branch (default: the project's default branch)."),
		},
		required: ["action", "timeline_id"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	// a URL fetch of a big file plus ffprobe and a hash; anything slower should go through upload_url
	budgetSeconds: 180,
	async run(args, ctx) {
		switch (args.action) {
			case "import":
				return importMedia(args, ctx);
			case "list":
				return listMedia(args);
			case "upload_url": {
				const timelineId = need(args, "timeline_id", "for upload_url");
				await getProjectHead(timelineId); // the timeline must exist
				return uploadInstructions(ctx, timelineId, text(args.name) ?? null, null, undefined);
			}
			default:
				return fail("invalid_arguments", `Unknown action ${String(args.action)}.`);
		}
	},
};

// ─── sounds (G09) ─────────────────────────────────────────────────────────────────────────────────────────────

async function listSounds(args: Record<string, unknown>): Promise<ToolOutput> {
	const pack = await loadSfxPackFromDisk();
	const sounds = filterSounds(pack, { tag: text(args.tag), category: text(args.category), query: text(args.query) });
	const categories: Record<string, number> = {};
	const tags: Record<string, number> = {};
	for (const sound of pack.sounds) {
		categories[sound.category] = (categories[sound.category] ?? 0) + 1;
		for (const tag of sound.tags) tags[tag] = (tags[tag] ?? 0) + 1;
	}
	return {
		payload: {
			pack: { name: pack.pack, version: pack.version, licence: pack.licence, count: pack.sounds.length },
			matched: sounds.length,
			sounds: sounds.map((sound) => ({
				id: sound.id,
				name: sound.name,
				category: sound.category,
				tags: sound.tags,
				roles: sound.roles,
				duration_s: sound.duration_s,
				sync_s: sound.sync_s,
				...(sound.sync ? { sync: sound.sync } : {}),
				default_db: sound.default_db,
				...(sound.description ? { description: sound.description } : {}),
				url: sound.url,
			})),
			categories,
			tags: Object.entries(tags)
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([tag, count]) => ({ tag, count })),
			notes: [
				"sync_s = seconds into the file where its event is (a whoosh's peak, a hit's attack). sounds place puts that event on your time.",
				"sounds design places a hit at 0, a riser into the hook, a hit ON every real cut (not on loop seams or texture overlays), sounds on the cues inside compositions (typing, stamps, markers, scene cuts) and a pop per text that comes in away from a cut, at least 0.25 s apart, and ducks the music lightly.",
				"Several sounds by hand: sounds place {timeline_id, items: [{name, t}, …]} = one commit.",
			],
			next: { do: "Place one where something happens, or design the whole sound.", tool: "sounds", arguments: { action: "place", timeline_id: "…", items: [{ name: sounds[0]?.id ?? "whoosh-hit", t: 1.5 }] } },
		},
	};
}

/**
 * sounds place {items: [{name, t | element_id (+ at), db?, why?}, …]} — many sounds, ONE commit (sound-voice-v2,
 * 2026-10-20: the recreations placed 5–14 sounds as 5–14 commits). Every item is checked before anything is applied.
 */
async function placeSounds(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "for sounds place");
	const raw = args.items as unknown[];
	if (!Array.isArray(raw) || !raw.length) return fail("invalid_arguments", "items must be a non-empty array of {name, t | element_id, at?, db?, why?}.");
	if (raw.length > 200) return fail("invalid_arguments", `items has ${raw.length} entries; at most 200 per call.`);
	const pack = await loadSfxPackFromDisk();
	const head = await getProjectHead(timelineId, text(args.branch));
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot.");
	const base = text(args.base_commit);
	if (!baseMatches(base, head.head.id)) return conflict(timelineId, head.head.id, base ?? "");
	const project = head.snapshot as unknown as OpsProject;
	const problems: string[] = [];
	const planned: PlaceItem[] = [];
	raw.forEach((entry, index) => {
		const item = (entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
		const where = `items[${index}]`;
		const wanted = text(item.name) ?? text(item.sound);
		if (!wanted) return problems.push(`${where}: name is required (a sound id from sounds list, e.g. whoosh-hit)`);
		const sound = findSound(pack, wanted);
		if (!sound) return problems.push(`${where}: no sound "${wanted}" in the pack`);
		let event: number;
		let why: string;
		const elementId = text(item.element_id);
		if (elementId) {
			const times = elementTimes(project, elementId);
			if (!times) return problems.push(`${where}: no element ${elementId} on this timeline`);
			const atEnd = item.at === "end";
			event = atEnd ? times.end : times.start;
			why = `${atEnd ? "end" : "start"} of ${times.name}`;
		} else if (typeof item.t === "number" && Number.isFinite(item.t) && item.t >= 0) {
			event = item.t;
			why = `${item.t} s`;
		} else return problems.push(`${where}: give t (seconds where the sound's event lands) or element_id`);
		if (item.db !== undefined && !(typeof item.db === "number" && Number.isFinite(item.db))) return problems.push(`${where}: db must be a number`);
		planned.push({ sound, event, why: text(item.why) ?? why, db: typeof item.db === "number" ? item.db : undefined });
	});
	if (problems.length) {
		const out = fail("invalid_arguments", `${problems.length} item(s) are wrong; nothing was placed.`, { problems: problems.slice(0, 30), sounds: pack.sounds.map((sound) => sound.id) });
		(out.payload as Payload).next = { do: "List the pack.", tool: "sounds", arguments: { action: "list" } };
		return out;
	}
	const plan = planPlaceSounds(project, planned);
	const result = apply(project, plan.ops, { seed: `${timelineId}/${head.head.id}/sounds/batch/${planned.length}/${planned[0].event}`, at: new Date().toISOString() });
	if (!result.ok) {
		const out = fail("ops_conflict", "The timeline refused the sounds. Nothing was committed.", { conflicts: result.conflicts.slice(0, 10) });
		(out.payload as Payload).next = summaryNext(timelineId);
		return out;
	}
	const message = text(args.message) ?? `sounds: ${planned.length} placed (${[...new Set(planned.map((item) => item.sound.id))].slice(0, 6).join(", ")})`;
	const done = await commitSnapshot(ctx, timelineId, { id: head.head.id, branch: head.branch }, result.project, result.changes.applied, message);
	if (!done.ok) return done.out;
	const short = plan.items.filter((item) => item.lead_in_short);
	return {
		payload: {
			timeline_id: timelineId,
			commit_id: done.commitId,
			placed: plan.items.map((item) => ({
				element_id: result.changes.refs[item.ref],
				sound: item.sound,
				t: item.t,
				event: item.event,
				dur: item.dur,
				db: item.db,
				lane: { id: result.changes.refs[item.lane] ?? item.lane, created: item.laneCreated },
				why: item.why,
			})),
			count: plan.items.length,
			lanes_created: [...new Set(plan.items.filter((item) => item.laneCreated).map((item) => item.lane))].length,
			...(short.length ? { notes: short.map((item) => `${item.sound} lands at ${item.event} s, not earlier: it needs its lead-in before its event`) } : {}),
			next: summaryNext(timelineId, "Check the SFX lanes."),
		},
	};
}

async function placeSound(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	if (args.items !== undefined) return placeSounds(args, ctx);
	const timelineId = need(args, "timeline_id", "for sounds place");
	const wanted = need(args, "name", "for sounds place (a sound id from sounds list, e.g. whoosh-short)");
	const pack = await loadSfxPackFromDisk();
	const sound = findSound(pack, wanted);
	if (!sound) {
		const out = fail("unknown_sound", `No sound "${wanted}" in the pack.`, { sounds: pack.sounds.map((candidate) => candidate.id) });
		(out.payload as Payload).next = { do: "List the pack.", tool: "sounds", arguments: { action: "list" } };
		return out;
	}
	const head = await getProjectHead(timelineId, text(args.branch));
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot.");
	const base = text(args.base_commit);
	if (!baseMatches(base, head.head.id)) return conflict(timelineId, head.head.id, base ?? "");
	const project = head.snapshot as unknown as OpsProject;
	let event: number;
	let why: string;
	const elementId = text(args.element_id);
	if (elementId) {
		const times = elementTimes(project, elementId);
		if (!times) return fail("not_found", `No element ${elementId} on this timeline.`, {});
		const atEnd = args.at === "end";
		event = atEnd ? times.end : times.start;
		why = `${atEnd ? "end" : "start"} of ${times.name}`;
	} else if (typeof args.t === "number" && args.t >= 0) {
		event = args.t;
		why = `${args.t} s`;
	} else {
		return fail("invalid_arguments", "Give t (seconds where the sound's event lands) or element_id (its start; at: \"end\" for its end).");
	}
	const plan = planPlaceSound(project, sound, event, { db: typeof args.db === "number" ? args.db : undefined, name: `SFX ${sound.id} · ${why}` });
	const result = apply(project, plan.ops, { seed: `${timelineId}/${head.head.id}/sounds/${sound.id}/${plan.t}`, at: new Date().toISOString() });
	if (!result.ok) {
		const out = fail("ops_conflict", "The timeline refused the sound. Nothing was committed.", { conflicts: result.conflicts.slice(0, 10) });
		(out.payload as Payload).next = summaryNext(timelineId);
		return out;
	}
	const message = text(args.message) ?? `sound: ${sound.id} on ${why}`;
	const done = await commitSnapshot(ctx, timelineId, { id: head.head.id, branch: head.branch }, result.project, result.changes.applied, message);
	if (!done.ok) return done.out;
	return {
		payload: {
			timeline_id: timelineId,
			commit_id: done.commitId,
			element_id: result.changes.refs.placed,
			sound: sound.id,
			t: plan.t,
			event: plan.event,
			dur: plan.dur,
			db: plan.db,
			lane: { id: result.changes.refs["sfx-lane"] ?? plan.lane.id, created: plan.lane.created },
			...(plan.t === 0 && event < sound.sync_s ? { notes: [`The event lands at ${plan.event} s, not ${event} s: the sound needs ${sound.sync_s} s of lead-in before its event.`] } : {}),
			next: summaryNext(timelineId, "Check the SFX lane."),
		},
	};
}

function designOptions(raw: unknown): SoundDesignOptions {
	const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const flag = (key: string) => (typeof o[key] === "boolean" ? (o[key] as boolean) : undefined);
	const number = (key: string) => (typeof o[key] === "number" && Number.isFinite(o[key]) ? (o[key] as number) : undefined);
	const options: SoundDesignOptions = {
		minGap: number("min_gap"),
		hitAtStart: flag("hit_at_start"),
		whooshOnCuts: flag("whoosh_on_cuts"),
		popOnText: flag("pop_on_text"),
		riserIntoHook: flag("riser_into_hook"),
		hookEnd: number("hook_end"),
		captionTicks: flag("caption_ticks"),
		duck: flag("duck"),
		duckDb: number("duck_db"),
		author: "claude",
	};
	for (const key of Object.keys(options) as Array<keyof SoundDesignOptions>) if (options[key] === undefined) delete options[key];
	return options;
}

/** v2 options (sound-voice-v2): the v1 keys plus cues, palette, sounds, frames. */
function designOptionsV2(raw: unknown): DesignV2Options & { frames?: boolean } {
	const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const v1 = designOptions(raw);
	const palette = typeof o.palette === "string" && ["auto", "clean", "paper", "tech"].includes(o.palette) ? (o.palette as DesignV2Options["palette"]) : undefined;
	const sounds = o.sounds && typeof o.sounds === "object" && !Array.isArray(o.sounds) ? Object.fromEntries(Object.entries(o.sounds as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string> : undefined;
	const options: DesignV2Options & { frames?: boolean } = {
		minGap: v1.minGap,
		hitAtStart: v1.hitAtStart,
		whooshOnCuts: v1.whooshOnCuts,
		popOnText: v1.popOnText,
		riserIntoHook: v1.riserIntoHook,
		hookEnd: v1.hookEnd,
		captionTicks: v1.captionTicks,
		duck: v1.duck,
		duckDb: v1.duckDb,
		cues: typeof o.cues === "boolean" ? o.cues : undefined,
		frames: typeof o.frames === "boolean" ? o.frames : undefined,
		palette,
		sounds,
		author: "claude",
	};
	for (const key of Object.keys(options) as Array<keyof typeof options>) if (options[key] === undefined) delete options[key];
	return options;
}

async function designTimelineSound(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const raw = (args.options && typeof args.options === "object" ? args.options : {}) as Record<string, unknown>;
	if (raw.planner === "v1") return designTimelineSoundV1(args, ctx);
	const timelineId = need(args, "timeline_id", "for sounds design");
	const head = await getProjectHead(timelineId, text(args.branch));
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot.");
	const base = text(args.base_commit);
	if (!baseMatches(base, head.head.id)) return conflict(timelineId, head.head.id, base ?? "");
	const pack = await loadSfxPackFromDisk();
	const options = designOptionsV2(args.options);
	const project = head.snapshot as unknown as OpsProject;
	const collected = await collectCompositionCues(project, { frames: options.frames !== false, signal: ctx.signal });
	const { frames: _frames, ...planOptions } = options;
	const design = designSoundOnSnapshotV2(project, pack, `${timelineId}/${head.head.id}/sound-design-v2`, planOptions, collected.cues, collected.fullFrame);
	const report = {
		planner: design.planner,
		summary: design.summary,
		palette: design.palette,
		placed: design.placed.map((item) => ({ kind: item.kind, sound: item.sound, t: item.t, event: item.event, dur: item.dur, db: item.db, reason: item.reason, source: item.source })),
		cuts: {
			count: design.cuts.times.length,
			with_sound: design.cuts.with_sound,
			...(design.cuts.by_hand ? { by_hand: design.cuts.by_hand } : {}),
			times: design.cuts.times,
			not_cuts: design.cuts.skipped.length,
			...(design.cuts.skipped.length ? { not_cuts_detail: design.cuts.skipped.slice(0, 20) } : {}),
		},
		compositions: collected.clips,
		cues_used: collected.cues.length,
		...(design.covered_texts.length ? { covered_texts: design.covered_texts } : {}),
		replaced: design.replaced,
		dropped: design.dropped.length,
		...(design.dropped.length ? { dropped_detail: design.dropped.slice(0, 20) } : {}),
		ducked: design.ducked.length,
		hook_end: design.hookEnd,
		...(design.skipped.length ? { skipped: design.skipped } : {}),
		notes: design.notes,
	};
	if (args.dry_run === true) {
		return {
			payload: {
				timeline_id: timelineId,
				dry_run: true,
				head: head.head.id,
				...report,
				next: { do: "Looks right: commit it (same call without dry_run).", tool: "sounds", arguments: { action: "design", timeline_id: timelineId, base_commit: head.head.id, ...(args.options ? { options: args.options } : {}) } },
			},
		};
	}
	if (!design.applied.length) {
		return { payload: { timeline_id: timelineId, committed: false, ...report, next: summaryNext(timelineId, "Nothing to design yet: put clips and text on the timeline first.") } };
	}
	const message = text(args.message) ?? `Design the sound: ${design.summary}`;
	const done = await commitSnapshot(ctx, timelineId, { id: head.head.id, branch: head.branch }, design.project, design.applied, message);
	if (!done.ok) return done.out;
	return {
		payload: {
			timeline_id: timelineId,
			commit_id: done.commitId,
			...report,
			editor: "Running sounds design again (here or the editor's button) replaces this design instead of stacking it.",
			next: { do: "Render and listen; or add sounds by hand in one commit.", tool: "render", arguments: { timeline_id: timelineId, quality: "preview" } },
		},
	};
}

/** v1 (packages/timeline-ops designSound, the editor button's planner): options.planner = "v1". */
async function designTimelineSoundV1(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "for sounds design");
	const head = await getProjectHead(timelineId, text(args.branch));
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot.");
	const base = text(args.base_commit);
	if (!baseMatches(base, head.head.id)) return conflict(timelineId, head.head.id, base ?? "");
	const pack = await loadSfxPackFromDisk();
	const design = designSoundOnSnapshot(head.snapshot as unknown as OpsProject, pack, `${timelineId}/${head.head.id}/sound-design`, designOptions(args.options));
	const report = {
		summary: design.summary,
		placed: design.placed.map((item) => ({ kind: item.kind, sound: item.sound, t: item.t, event: item.event, dur: item.dur, db: item.db, reason: item.reason })),
		replaced: design.replaced,
		dropped: design.dropped.length,
		...(design.dropped.length ? { dropped_detail: design.dropped.slice(0, 20) } : {}),
		ducked: design.ducked.length,
		hook_end: design.hookEnd,
		...(design.skipped.length ? { skipped: design.skipped } : {}),
		notes: design.notes,
	};
	if (args.dry_run === true) {
		return {
			payload: {
				timeline_id: timelineId,
				dry_run: true,
				head: head.head.id,
				...report,
				next: { do: "Looks right: commit it (same call without dry_run).", tool: "sounds", arguments: { action: "design", timeline_id: timelineId, base_commit: head.head.id } },
			},
		};
	}
	if (!design.applied.length) {
		return { payload: { timeline_id: timelineId, committed: false, ...report, next: summaryNext(timelineId, "Nothing to design yet: put clips and text on the timeline first.") } };
	}
	const message = text(args.message) ?? `Design the sound: ${design.summary}`;
	const done = await commitSnapshot(ctx, timelineId, { id: head.head.id, branch: head.branch }, design.project, design.applied, message);
	if (!done.ok) return done.out;
	return {
		payload: {
			timeline_id: timelineId,
			commit_id: done.commitId,
			...report,
			editor: "Pressing \"Design the sound\" again (here or in the editor) replaces this design instead of stacking it.",
			next: summaryNext(timelineId, "Check the SFX lane."),
		},
	};
}

export const SOUNDS_TOOL: Tool = {
	name: "sounds",
	title: "Sound effects",
	description:
		"RestorffCut's built-in SFX pack (whooshes, whoosh/swish hits, hits, risers, pops, ticks, typing burst, typewriter, stamp slam, marker scribble, paper slide/rustle, tape stop, record scratch…; generated by us, free to use). list {tag?, category?, query?}: the sounds with their length, sync point and suggested level. place {timeline_id, name, t | element_id (+ at: start|end), db?}: one sound with its EVENT (a whoosh's peak, a hit's attack) on that time, on a free SFX lane — one commit; place {timeline_id, items: [{name, t | element_id, at?, db?, why?}, …]}: many sounds in ONE commit. design {timeline_id, dry_run?, options?}: \"Design the sound\" for the whole cut — a hit at 0 s, a riser into the end of the hook, a hit ON every real cut (loop seams, texture overlays and graphics are not cuts; read cuts.not_cuts_detail), sounds on the cues inside compositions (typing, stamps, markers, scene cuts — from the composition's manifest `cues`, else its own frames; see compositions[]), a pop on text that comes in away from a cut, ≥ 0.25 s apart, the music ducked 3 dB under them; re-running replaces the previous design. options: {palette: auto|clean|paper|tech, cues, frames, sounds: {kind: sound id}, caption_ticks, duck, duck_db, hook_end, min_gap, hit_at_start, whoosh_on_cuts, pop_on_text, riser_into_hook, planner: \"v1\" for the old planner}. Which sound on which action, levels, music and voice: guide {topic: \"sound\"}.",
	inputSchema: {
		type: "object",
		properties: {
			action: oneOf(["list", "place", "design"]),
			timeline_id: str("place, design: the timeline."),
			tag: str("list: only sounds with this tag or role (whoosh, cut, transition, hit, riser, pop, text_in, paper…)."),
			category: str("list: only this category."),
			query: str("list: words to search ids, names, tags and descriptions."),
			name: str("place: a sound id from list (e.g. whoosh-short), or a tag (\"riser\") to take the first match."),
			items: {
				type: "array",
				description: "place: many sounds in ONE commit — [{name, t | element_id, at?: start|end, db?, why?}] (why goes into the element name; at most 200).",
				items: {
					type: "object",
					properties: {
						name: str("A sound id or tag."),
						t: num("Seconds where its event lands.", { minimum: 0 }),
						element_id: str("Or: on this element's start (at: end = its end)."),
						at: oneOf(["start", "end"]),
						db: num("Element volume in dB (default: the sound's suggested level)."),
						why: str("Short reason, kept in the element name (\"stamp lands\")."),
					},
				},
			},
			t: num("place: seconds on the timeline where the sound's event lands.", { minimum: 0 }),
			element_id: str("place: put the event on this element's start (or its end with at: \"end\")."),
			at: oneOf(["start", "end"], "place with element_id: which edge (default start)."),
			db: num("place: element volume in dB (default: the sound's suggested level)."),
			dry_run: bool("design: plan only; nothing is committed."),
			options: {
				type: "object",
				description:
					"design: {palette?: auto|clean|paper|tech (cut sounds), cues?: false = ignore composition cues, frames?: false = no frame reading, sounds?: {cut|cut_alt|hit|hook_hit|riser|pop|tick|<cue kind>: sound id}, caption_ticks?, duck?, duck_db?, hook_end?, min_gap?, hit_at_start?, whoosh_on_cuts?, pop_on_text?, riser_into_hook?, planner?: \"v1\"}.",
			},
			base_commit: str("place, design: optional; the head you read. If the timeline moved on, nothing is done."),
			message: str("place, design: the commit message."),
			branch: str("Branch (default: the project's default branch)."),
		},
		required: ["action"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	// design reads every composition's frames once (cached by render hash afterwards): ~0.3–2 s per clip
	budgetSeconds: 120,
	async run(args, ctx) {
		switch (args.action) {
			case "list":
				return listSounds(args);
			case "place":
				return placeSound(args, ctx);
			case "design":
				return designTimelineSound(args, ctx);
			default:
				return fail("invalid_arguments", `Unknown action ${String(args.action)}.`);
		}
	},
};

/** The server-instructions line (tools.ts SERVER_INSTRUCTIONS). */
export const MEDIA_INSTRUCTIONS = `No timeline yet? timeline create {name, aspect} → media import {timeline_id, url | data_base64 | path_hint | upload_id, place: {track: "V1"}} once per clip (files over ~700 KB from your own machine: media upload_url, then curl -T, then import {upload_id}; up to ${Math.round(IMPORT_MAX_BYTES / 1048576)} MB). Sound: sounds list / sounds place / sounds design. timeline share gives the person a review link; every timeline result carries editor_url.`;
