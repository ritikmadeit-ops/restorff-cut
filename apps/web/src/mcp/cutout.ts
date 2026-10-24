/**
 * MCP tool `cutout` (mcp-cutout agent, 2026-10-20; EDT-22 + EDT-06 sizes): what the editor's Person tools do, for a
 * Claude over /api/mcp — server-side person matte + face boxes, the four matte presets as one commit by `claude`, and
 * auto-reframe to 4:5 / 1:1 / 16:9 from the face boxes.
 *
 *   matte    timeline_id + element_id | media_id → a background job in headless Chromium (server/matte.ts): the
 *            person as a transparent WebM + face boxes per frame, cached by media sha256. Returns job_id at once
 *            (or waits up to wait_s).
 *   status   job_id | element_id | media_id → state, progress, speeds (frames per second per phase), face summary.
 *   apply    timeline_id + element_id + preset (+ text …) → cutout on V2 CUTOUT + the preset's layers, ONE commit.
 *   reframe  timeline_id + size → the cut at that size on its own branch (default reframe-<w>x<h>), clips following
 *            the face; one commit by claude on that branch.
 *
 * Every result ends with `next`. Runbook + example calls: docs/restorff/worklog/mcp-cutout.md.
 */
import { readFile } from "node:fs/promises";
import { apply, type Project as OpsProject } from "@restorffcut/timeline-ops";
import type { Actor } from "@/server/auth";
import { HttpError } from "@/server/http";
import {
	type FaceTrack,
	fileBytes,
	findMatteJob,
	getFaceBoxes,
	getMatteJob,
	type MatteJob,
	matteOutputFiles,
	projectMediaRecord,
	startMatteJob,
	waitForMatte,
} from "@/server/matte";
import { activeScene, canvasOf, cutoutSourceOf, findCutoutOf, locate, planPreset, PRESETS, type PresetId } from "@/server/matte-presets";
import { branchForSize, planReframe, TARGET_SIZES, type TargetSize } from "@/server/matte-reframe";
import { putProjectMedia } from "@/server/media";
import { getProjectHead, listBranches, pushCommit } from "@/server/projects";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { fail, type JsonSchema, type Payload, type Tool, type ToolContext, type ToolOutput } from "./protocol";

const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
const MAX_WAIT_S = 170;

function actorOf(ctx: ToolContext): Actor {
	const kind = ctx.auth?.kind === "service" ? "service" : "local-dev";
	return { kind, id: ctx.auth?.userId ?? kind, name: ctx.auth?.name ?? "Claude (MCP)" };
}

function need(args: Record<string, unknown>, key: string, why: string): string {
	const value = args[key];
	if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} is required ${why}`);
	return value.trim();
}

const opt = (args: Record<string, unknown>, key: string): string | undefined =>
	typeof args[key] === "string" && (args[key] as string).trim() ? (args[key] as string).trim() : undefined;

const waitMs = (args: Record<string, unknown>) =>
	Math.max(0, Math.min(MAX_WAIT_S, typeof args.wait_s === "number" ? args.wait_s : 0)) * 1000;

const summaryNext = (id: string, what = "Read the timeline summary (element ids, times).") => ({
	do: what,
	tool: "timeline",
	arguments: { action: "summary", timeline_id: id },
});

function withNext(out: ToolOutput, next: Payload): ToolOutput {
	if (out.payload) (out.payload as Payload).next = next;
	return out;
}

/** The job, slimmed for an answer. */
function jobView(job: MatteJob): Payload {
	const files = matteOutputFiles(job);
	return {
		job_id: job.job_id,
		state: job.state,
		phase: job.phase,
		progress: Math.round((job.progress ?? 0) * 100) / 100,
		done: job.done,
		total: job.total,
		media_hash: job.media_hash,
		variant: job.variant,
		...(job.error ? { error: job.error } : {}),
		...(job.source ? { source: job.source } : {}),
		...(job.range ? { range: job.range } : {}),
		...(job.outputs
			? {
					outputs: {
						person_webm: { ...job.outputs.person_webm, bytes: fileBytes(files.webm) },
						faces: { ...job.outputs.faces, bytes: fileBytes(files.faces) },
						folder: files.dir,
					},
				}
			: {}),
		...(job.speed ? { speed: job.speed } : {}),
		...(job.timings ? { timings: job.timings } : {}),
		...(job.env ? { env: job.env } : {}),
		created_at: job.created_at,
		finished_at: job.finished_at,
	};
}

function faceSummary(track: FaceTrack | null): Payload | null {
	if (!track) return null;
	return {
		frames: track.summary.frames,
		fps: track.fps,
		face_found: track.summary.face_found,
		median_face: track.summary.face,
		median_head: track.summary.head,
		median_person: track.summary.person,
		max_faces: track.summary.max_faces,
		detector: `${track.detector.name} (${track.detector.delegate})`,
		segmenter: `${track.segmenter.model} (${track.segmenter.delegate})`,
		boxes: "[x, y, w, h] in 0..1 of the source frame, top-left origin; t in source seconds",
		reader: "server/matte.ts getFaceBoxes(media_hash) → restorffcut-faces@1; faceAt(track, t)",
	};
}

/** element_id (a video clip, or its cutout → its clip) or media_id → the media to matte. */
async function resolveMedia(args: Record<string, unknown>, timelineId: string) {
	const elementId = opt(args, "element_id");
	let mediaId = opt(args, "media_id");
	let elementName: string | null = null;
	if (elementId) {
		const head = await getProjectHead(timelineId, opt(args, "branch"));
		const scene = head.snapshot ? activeScene(head.snapshot) : null;
		let found = locate(scene, elementId);
		const source = cutoutSourceOf(found?.element);
		if (found && source) found = locate(scene, source.sourceElementId) ?? found;
		if (!found) throw new HttpError(404, `no element ${elementId} on this timeline`);
		if (found.element.type !== "video") throw new HttpError(400, `element ${elementId} is ${found.element.type}; the server matte works on video clips`);
		mediaId = String(found.element.mediaId ?? "");
		elementName = String(found.element.name ?? "");
	}
	if (!mediaId) throw new HttpError(400, "pass element_id (a video clip) or media_id");
	const media = await projectMediaRecord(timelineId, mediaId);
	return { media, mediaId, elementName };
}

const mediaMissing = (timelineId: string, mediaId: string): ToolOutput =>
	withNext(
		fail(
			"media_not_on_server",
			`Media ${mediaId} is not in this timeline's media store on the server, so it cannot be matted here. The editor uploads a project's media after "Start version history" and after each pushed commit; or upload it: PUT /api/projects/${timelineId}/media/${mediaId} (raw file body, README-RESTORFF.md).`,
		),
		{ do: "List the media the timeline has.", tool: "media", arguments: { action: "list", timeline_id: timelineId } },
	);

// ─── actions ──────────────────────────────────────────────────────────────────────────────────────────────────

async function matte(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "for matte");
	const { media, mediaId, elementName } = await resolveMedia(args, timelineId);
	if (!media) return mediaMissing(timelineId, mediaId);
	const started = startMatteJob({ media, force: args.force === true });
	let job = started.job;
	const wait = waitMs(args);
	if (wait > 0 && (job.state === "queued" || job.state === "running")) job = (await waitForMatte(job.job_id, wait, ctx.signal)) ?? job;
	const finished = job.state === "done";
	return {
		payload: {
			...jobView(job),
			cached: started.cached,
			started: started.started,
			media_id: mediaId,
			...(elementName ? { clip: elementName } : {}),
			...(finished ? { faces: faceSummary(getFaceBoxes(job.media_hash)) } : {}),
			note: finished
				? "The person video and face boxes are cached by the media's sha256; every clip of this media reuses them."
				: "Runs in the background (headless Chromium: segmentation 15 fps, face detector, VP9-alpha encode). Poll status every ~10 s.",
			next: finished
				? { do: "Put text behind the person (or another preset) on the clip.", tool: "cutout", arguments: { action: "apply", timeline_id: timelineId, element_id: opt(args, "element_id") ?? "<a clip of this media>", preset: "text_behind_person", text: "ONE POUR." } }
				: job.state === "error"
					? { do: "Read the error; run matte again with force: true once fixed.", tool: "cutout", arguments: { action: "matte", timeline_id: timelineId, ...(opt(args, "element_id") ? { element_id: opt(args, "element_id") } : { media_id: mediaId }), force: true } }
					: { do: "Wait for the job (wait_s holds the call open up to 170 s).", tool: "cutout", arguments: { action: "status", job_id: job.job_id, wait_s: 60 } },
		},
		isError: job.state === "error",
	};
}

async function status(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	let job: MatteJob | null = null;
	const jobId = opt(args, "job_id");
	const timelineId = opt(args, "timeline_id");
	let mediaId: string | undefined;
	if (jobId) job = getMatteJob(jobId);
	else if (timelineId) {
		const resolved = await resolveMedia(args, timelineId);
		mediaId = resolved.mediaId;
		if (!resolved.media) return mediaMissing(timelineId, resolved.mediaId);
		job = findMatteJob(resolved.media.hash);
	} else return fail("invalid_arguments", "Pass job_id, or timeline_id with element_id or media_id.");
	if (!job) {
		return withNext(fail("not_found", jobId ? `No matte job ${jobId}.` : `No matte job for media ${mediaId} yet.`), {
			do: "Start one.",
			tool: "cutout",
			arguments: { action: "matte", timeline_id: timelineId ?? "…", ...(opt(args, "element_id") ? { element_id: opt(args, "element_id") } : { media_id: mediaId ?? "…" }) },
		});
	}
	const wait = waitMs(args);
	if (wait > 0 && (job.state === "queued" || job.state === "running")) job = (await waitForMatte(job.job_id, wait, ctx.signal)) ?? job;
	const done = job.state === "done";
	return {
		payload: {
			...jobView(job),
			...(done ? { faces: faceSummary(getFaceBoxes(job.media_hash, { variant: job.variant })) } : {}),
			next: done
				? { do: "Build an effect on a clip of this media.", tool: "cutout", arguments: { action: "apply", timeline_id: timelineId ?? "<timeline>", element_id: opt(args, "element_id") ?? "<clip>", preset: "text_behind_person", text: "ONE POUR." } }
				: job.state === "error"
					? { do: "Fix the cause (see error and outputs folder driver.log), then matte again with force: true.", tool: "cutout", arguments: { action: "matte", timeline_id: timelineId ?? "<timeline>", force: true } }
					: { do: "Still working: ask again.", tool: "cutout", arguments: { action: "status", job_id: job.job_id, wait_s: 60 } },
		},
		isError: job.state === "error",
	};
}

/** Store the person WebM in the project's media store under the reducer's media id (the editor pulls it). */
async function uploadPerson(projectId: string, mediaId: string, job: MatteJob, name: string) {
	const files = matteOutputFiles(job);
	const bytes = await readFile(files.webm);
	const webm = job.outputs?.person_webm;
	const meta = {
		name: `${name}.webm`,
		type: "video",
		width: webm?.width,
		height: webm?.height,
		duration: webm?.duration,
		fps: webm?.fps,
		hasAudio: false,
		size: bytes.byteLength,
		lastModified: Date.now(),
	};
	const request = new Request("http://restorffcut.internal/media", {
		method: "PUT",
		body: new Uint8Array(bytes),
		headers: { "content-type": "video/webm", "x-media-meta": Buffer.from(JSON.stringify(meta), "utf8").toString("base64url") },
	});
	return putProjectMedia(projectId, mediaId, request);
}

const baseMatches = (given: string | undefined, head: string) => !given || given === head || (given.length >= 7 && head.startsWith(given));

async function applyPreset(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "for apply");
	const elementId = need(args, "element_id", "for apply (the clip to build the effect on)");
	const preset = (opt(args, "preset") ?? "text_behind_person") as PresetId;
	if (!PRESET_IDS.includes(preset)) return fail("invalid_arguments", `preset must be one of ${PRESET_IDS.join(", ")}.`);
	const branch = opt(args, "branch");
	let head = await getProjectHead(timelineId, branch);
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot.");
	const base = opt(args, "base_commit");
	if (!baseMatches(base, head.head.id)) {
		return withNext(fail("conflict", `The timeline moved on: its head is ${head.head.id}, not ${base}. Nothing was done.`, { head: head.head.id }), summaryNext(timelineId, "Read the timeline again and retry on its head."));
	}
	let scene = activeScene(head.snapshot);
	let target = locate(scene, elementId);
	if (!target) return withNext(fail("not_found", `No element ${elementId} on this timeline.`), summaryNext(timelineId));
	const sourceOfTarget = cutoutSourceOf(target.element);
	if (sourceOfTarget) target = locate(scene, sourceOfTarget.sourceElementId) ?? target;
	if (target.element.type !== "video") {
		return withNext(fail("unsupported", `Element ${target.element.id} is ${target.element.type}. Over MCP the presets work on video clips (stills: the editor's Person tools).`), summaryNext(timelineId));
	}
	const mediaId = String(target.element.mediaId ?? "");
	const media = await projectMediaRecord(timelineId, mediaId);
	if (!media) return mediaMissing(timelineId, mediaId);

	// The matte: cached → use it; running → wait for it (wait_s); missing or failed → start it.
	let job = startMatteJob({ media }).job;
	if (job.state !== "done") {
		const wait = waitMs(args);
		if (wait > 0) job = (await waitForMatte(job.job_id, wait, ctx.signal)) ?? job;
	}
	if (job.state !== "done") {
		return withNext(
			fail("matte_not_ready", job.state === "error" ? `The matte job failed: ${job.error}` : `The person matte for this clip's media is ${job.state} (${job.phase} ${job.done}/${job.total}). Nothing was committed.`, { job: jobView(job) }),
			{ do: "Wait for the matte, then apply again.", tool: "cutout", arguments: { action: "status", job_id: job.job_id, wait_s: 90 } },
		);
	}
	const faces = getFaceBoxes(job.media_hash, { variant: job.variant });

	// Re-read the head (the matte may have taken minutes) and build on it.
	head = await getProjectHead(timelineId, branch);
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot.");
	if (!baseMatches(base, head.head.id)) {
		return withNext(fail("conflict", `The timeline moved on while the matte ran: its head is ${head.head.id}. Nothing was committed.`, { head: head.head.id }), summaryNext(timelineId));
	}
	const working = structuredClone(head.snapshot) as ProjectSnapshot;
	scene = activeScene(working);
	const plate = locate(scene, target.element.id);
	if (!plate) return fail("not_found", "The clip vanished while the matte ran.");
	const existing = findCutoutOf(scene, plate.element.id);
	let plan: ReturnType<typeof planPreset>;
	try {
		plan = planPreset({
			snapshot: working,
			plate,
			cutout: existing,
			preset,
			options: {
				text: opt(args, "text"),
				font: opt(args, "font"),
				color: opt(args, "color"),
				background: opt(args, "background"),
				dateline: opt(args, "dateline"),
				lines: Array.isArray(args.lines) ? (args.lines as unknown[]).filter((line): line is string => typeof line === "string") : undefined,
			},
			matte: job,
			faces,
		});
	} catch (error) {
		return withNext(fail("cannot_place", error instanceof Error ? error.message : String(error)), summaryNext(timelineId));
	}
	const result = apply(working as unknown as OpsProject, plan.ops, { seed: `${timelineId}/${head.head.id}/cutout/${preset}/${job.media_hash.slice(0, 12)}`, at: new Date().toISOString() });
	if (!result.ok) {
		return withNext(fail("ops_conflict", "The timeline reducer refused the preset. Nothing was committed.", { conflicts: result.conflicts.slice(0, 10) }), summaryNext(timelineId));
	}
	const snapshot = result.project as unknown as ProjectSnapshot;
	plan.finish(snapshot, result.changes.refs);
	const refs = result.changes.refs;
	const cutoutId = plan.createsCutout ? refs.cutout_clip : existing?.element.id;
	const message = opt(args, "message") ?? plan.message;
	const report = {
		preset,
		fx: PRESETS[preset].fx,
		clip: { element_id: plate.element.id, name: plate.element.name ?? null },
		cutout: { element_id: cutoutId ?? null, created: plan.createsCutout, media_id: refs.cutout_media ?? (existing?.element.mediaId as string | undefined) ?? null },
		layers: plan.layers,
		ops: result.changes.ops.map((change) => ({ op: change.op, status: change.status, summary: change.summary })),
		...(plan.notes.length ? { notes: plan.notes } : {}),
		matte: { job_id: job.job_id, face_found: faces?.summary.face_found ?? null, median_head: faces?.summary.head ?? null },
	};
	if (args.dry_run === true) {
		return {
			payload: {
				dry_run: true,
				...report,
				message,
				next: { do: "Looks right: commit it (same call without dry_run).", tool: "cutout", arguments: { action: "apply", timeline_id: timelineId, element_id: elementId, preset, base_commit: head.head.id } },
			},
		};
	}
	let uploaded: { bytes: number } | null = null;
	if (plan.createsCutout && refs.cutout_media) {
		const media = await uploadPerson(timelineId, refs.cutout_media, job, `${plate.element.name ?? "clip"} · cutout`);
		uploaded = { bytes: media.size };
	}
	const pushed = await pushCommit(timelineId, { base_commit: head.head.id, branch: head.branch, author: "claude", snapshot, ops: result.changes.applied, message }, actorOf(ctx));
	if (!pushed.ok) {
		return withNext(fail("conflict", "The timeline moved while committing. Nothing was committed.", { head: pushed.conflict.head.id }), summaryNext(timelineId, "Rebase on the new head and apply again."));
	}
	return {
		payload: {
			commit_id: pushed.commit.id,
			branch: pushed.branch,
			message: pushed.commit.message,
			...report,
			...(uploaded ? { person_video_uploaded: uploaded } : {}),
			editor: "The editor pulls this commit and the person video within ~15 s (or on focus).",
			next: { do: "Render it and look at a frame (is the text behind the head?).", tool: "look", arguments: { kind: "render", ref: timelineId } },
		},
	};
}

async function reframe(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "for reframe");
	const size = need(args, "size", "for reframe (4:5, 1:1 or 16:9)") as TargetSize;
	if (!TARGET_SIZES.includes(size)) return fail("invalid_arguments", `size must be one of ${TARGET_SIZES.join(", ")} (9:16 is the master).`);
	const sourceBranch = opt(args, "branch");
	const head = await getProjectHead(timelineId, sourceBranch);
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot.");
	const canvas = canvasOf(head.snapshot);
	const scene = activeScene(head.snapshot);

	// Faces for every video clip's media (start the missing ones).
	const mediaIds = new Set<string>();
	for (const track of [...(scene?.tracks?.overlay ?? []), ...(scene?.tracks?.main ? [scene.tracks.main] : [])]) {
		for (const element of track.elements ?? []) if (element.type === "video" && element.mediaId && !cutoutSourceOf(element)) mediaIds.add(String(element.mediaId));
	}
	const faces = new Map<string, FaceTrack | null>();
	const sizes = new Map<string, { width: number; height: number }>();
	const pending: Payload[] = [];
	const notOnServer: string[] = [];
	for (const mediaId of mediaIds) {
		const media = await projectMediaRecord(timelineId, mediaId);
		if (!media) {
			notOnServer.push(mediaId);
			faces.set(mediaId, null);
			continue;
		}
		const w = Number(media.meta?.width);
		const h = Number(media.meta?.height);
		if (w > 0 && h > 0) sizes.set(mediaId, { width: w, height: h });
		let track = getFaceBoxes(media.hash);
		if (!track) {
			let job = startMatteJob({ media }).job;
			const wait = waitMs(args);
			if (wait > 0 && job.state !== "done") job = (await waitForMatte(job.job_id, wait, ctx.signal)) ?? job;
			track = job.state === "done" ? getFaceBoxes(media.hash) : null;
			if (!track) pending.push({ media_id: mediaId, job_id: job.job_id, state: job.state, phase: job.phase, done: job.done, total: job.total });
		}
		faces.set(mediaId, track);
	}
	if (pending.length) {
		return withNext(fail("matte_not_ready", `Face boxes are still being made for ${pending.length} media. Nothing was committed.`, { pending }), {
			do: "Wait for the matte job(s), then reframe again.",
			tool: "cutout",
			arguments: { action: "status", job_id: pending[0].job_id, wait_s: 90 },
		});
	}
	const working = structuredClone(head.snapshot) as ProjectSnapshot;
	const plan = planReframe({ snapshot: working, size, facesFor: (id) => faces.get(id) ?? null, mediaSize: (id) => sizes.get(id) ?? null });
	plan.prepare(working);
	const targetBranch = opt(args, "target_branch") ?? branchForSize(size);
	const branches = await listBranches(timelineId);
	const existingBranch = branches.branches.find((candidate) => candidate.name === targetBranch);
	if (targetBranch === head.branch) return fail("invalid_arguments", "target_branch must differ from the branch you reframe from.");
	const result = apply(working as unknown as OpsProject, plan.ops, { seed: `${timelineId}/${head.head.id}/reframe/${size}`, at: new Date().toISOString() });
	if (!result.ok) return withNext(fail("ops_conflict", "The timeline reducer refused the reframe. Nothing was committed.", { conflicts: result.conflicts.slice(0, 10) }), summaryNext(timelineId));
	const snapshot = result.project as unknown as ProjectSnapshot;
	plan.finish(snapshot);
	const outSize = snapshot.settings?.canvasSize;
	const report = {
		size,
		from: { branch: head.branch, commit: head.head.id, canvas: `${canvas.width}x${canvas.height}` },
		to: { branch: targetBranch, canvas: outSize ? `${outSize.width}x${outSize.height}` : null, delivery: (snapshot.settings as { delivery?: unknown } | undefined)?.delivery ?? null, branch_existed: !!existingBranch },
		followed: plan.tracked,
		scaled_with_canvas: plan.scaled,
		ops: result.changes.ops.length,
		...(notOnServer.length ? { media_not_on_server: notOnServer, note: "Those clips were reframed without face boxes (centred on their upper third)." } : {}),
		...(plan.notes.length ? { notes: plan.notes } : {}),
	};
	if (args.dry_run === true) {
		return { payload: { dry_run: true, ...report, next: { do: "Commit it (same call without dry_run).", tool: "cutout", arguments: { action: "reframe", timeline_id: timelineId, size } } } };
	}
	// A new branch starts at the source head; an existing one gets a commit rebuilt from the source (its edits are replaced).
	const baseCommit = existingBranch?.head?.id ?? head.head.id;
	const message = opt(args, "message") ?? `reframe ${size} from ${head.branch} @ ${head.head.id.slice(0, 7)} (follows the face)`;
	const pushed = await pushCommit(timelineId, { base_commit: baseCommit, branch: targetBranch, author: "claude", snapshot, ops: result.changes.applied, message }, actorOf(ctx));
	if (!pushed.ok) return withNext(fail("conflict", `Branch ${targetBranch} moved while committing. Nothing was committed.`, { head: pushed.conflict.head.id }), summaryNext(timelineId));
	return {
		payload: {
			commit_id: pushed.commit.id,
			branch: pushed.branch,
			created_branch: pushed.created_branch,
			message: pushed.commit.message,
			...report,
			editor: `The ${size} cut is branch ${pushed.branch}: open the Versions panel (commit line) to switch to it. Its canvas is ${report.to.canvas}; Export uses the ${size} delivery preset.`,
			next: { do: "Read the reframed timeline (or render it and look at a frame: is the face kept in frame?).", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId, branch: pushed.branch } },
		},
	};
}

// ─── the tool ─────────────────────────────────────────────────────────────────────────────────────────────────

const str = (description: string): JsonSchema => ({ type: "string", description });

export const CUTOUT_TOOL: Tool = {
	name: "cutout",
	title: "Person cutout, face boxes and reframe",
	description:
		"Cut the speaker out of a clip on the server, so text and graphics can go BEHIND them, and follow their face. matte = start the person matte + face boxes for a clip's media (background job in headless Chromium; cached by media hash; returns job_id); status = progress, speeds and the face summary; apply = one commit by claude that puts the person on V2 CUTOUT above the clip and adds a preset: text_behind_person (a big headline the head covers), green_screen (background: #hex or blur[:0..100]), cover_story (magazine masthead behind the head + cover lines in front), frame_break (the shot shrinks into a frame and the speaker breaks out); reframe = the cut at 4:5, 1:1 or 16:9 on its own branch, clips following the face. Element ids and times come from timeline summary.",
	inputSchema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["matte", "status", "apply", "reframe"] },
			timeline_id: str("The timeline (project id from timeline list). Required except for status with job_id."),
			element_id: str("matte, status: a video clip whose media to matte. apply: the clip to build the effect on (or its cutout)."),
			media_id: str("matte, status: a media id of the timeline instead of a clip."),
			job_id: str("status: the job id a matte call returned."),
			preset: { type: "string", enum: PRESET_IDS, description: "apply: which effect (default text_behind_person)." },
			text: str("apply: the headline (text_behind_person) or the masthead (cover_story). Upper-cased."),
			lines: { type: "array", items: { type: "string" }, description: "apply cover_story: cover lines (default two Halcyon lines)." },
			dateline: str("apply cover_story: the small line on top (default NO. 01 · OCTOBER 2026)."),
			color: str("apply: text/frame colour (default #EDEBE6)."),
			font: str("apply text_behind_person: font family (default Anton)."),
			background: str("apply green_screen: #hex colour, blur, or blur:<0..100> (default blur:40)."),
			size: { type: "string", enum: TARGET_SIZES, description: "reframe: the new size (the master is 9:16)." },
			branch: str("apply: branch to edit; reframe: branch to reframe from (default: the project's default branch)."),
			target_branch: str("reframe: branch to write (default reframe-<w>x<h>; created from the source head, or rebuilt if it exists)."),
			base_commit: str("apply: optional; the head you read. If the timeline moved on, nothing is done."),
			message: str("apply, reframe: the commit message (default describes the effect)."),
			wait_s: { type: "number", minimum: 0, maximum: MAX_WAIT_S, description: "matte, status, apply, reframe: hold the call up to this many seconds for a running matte job (default 0)." },
			force: { type: "boolean", description: "matte: run again even when cached." },
			dry_run: { type: "boolean", description: "apply, reframe: report the layers and ops without committing or uploading." },
		},
		required: ["action"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	budgetSeconds: 195,
	async run(args, ctx) {
		switch (args.action) {
			case "matte":
				return matte(args, ctx);
			case "status":
				return status(args, ctx);
			case "apply":
				return applyPreset(args, ctx);
			case "reframe":
				return reframe(args, ctx);
			default:
				return fail("invalid_arguments", `Unknown action ${String(args.action)}.`);
		}
	},
};

/** The server-instructions line (one sentence: where to start). */
export const CUTOUT_INSTRUCTIONS =
	"To put text or graphics behind the speaker, or make 4:5 / 1:1 / 16:9 cuts that follow their face: cutout matte (element_id) → cutout status until done → cutout apply (preset text_behind_person, green_screen, cover_story or frame_break) or cutout reframe (size).";
