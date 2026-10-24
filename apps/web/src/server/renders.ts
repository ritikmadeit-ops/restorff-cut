/**
 * Server-side renders of a timeline commit (MCP `render`, EDT-06/08): the commit's snapshot + the media store's
 * files → a render job folder (restorffcut-render-job@1, the pipeline's format) → a detached worker
 * (./renders-worker.ts: pipeline `render` = the editor's own export in headless Chromium, then `master`) → a row and
 * the mastered file (./renders-store.ts). The recipe is Restorff's gateway's (restorff/apps/gateway/src/core-tools.mjs
 * `render`, workers.mjs `renderJob` / `findBun`), moved inside RestorffCut so a Claude on the standalone MCP can use it.
 *
 * Media that exists only in a browser (never uploaded to the media store) cannot be rendered: `MediaMissingError`
 * lists the ids. Runbook: docs/restorff/worklog/mcp-render.md.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveMediaDir } from "@/lib/db/store";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { listProjectMedia, type MediaDto } from "./media";
import { getCommit, getProjectHead } from "./projects";
import {
	freshRow,
	listRows,
	newRenderId,
	RENDER_SCHEMA,
	renderJobsParent,
	rendersDir,
	writeRow,
	type RenderQuality,
	type RenderRow,
} from "./renders-store";

export class MediaMissingError extends Error {
	constructor(
		public missing: Array<{ media_id: string; why: string }>,
		public have: string[],
	) {
		super(`${missing.length} media file(s) of this cut are not on RestorffCut's server: ${missing.map((m) => m.media_id).join(", ")}`);
	}
}

/** The real bun.exe on Windows (an npm shim `bun.cmd` cannot be spawned without a shell). The gateway's findBun. */
export function findBun(): string {
	if (process.env.BUN?.trim()) return process.env.BUN.trim();
	if (process.versions.bun) return process.execPath;
	if (process.platform !== "win32") return "bun";
	for (const dir of (process.env.PATH ?? "").split(";").filter(Boolean)) {
		for (const candidate of [path.join(dir, "bun.exe"), path.join(dir, "node_modules", "bun", "bin", "bun.exe")]) {
			if (existsSync(candidate)) return candidate;
		}
	}
	const home = path.join(process.env.USERPROFILE ?? "", ".bun", "bin", "bun.exe");
	return existsSync(home) ? home : "bun";
}

/** apps/web (the dev server's cwd), where src/server/renders-worker.ts lives. */
function webRoot(): string {
	const configured = process.env.RESTORFFCUT_WEB_DIR?.trim();
	if (configured) return path.resolve(configured);
	const cwd = process.cwd();
	if (existsSync(path.join(cwd, "src", "server", "renders-worker.ts"))) return cwd;
	const nested = path.join(cwd, "apps", "web");
	if (existsSync(path.join(nested, "src", "server", "renders-worker.ts"))) return nested;
	return cwd;
}

/** Every mediaId the cut plays (the gateway's way: any "mediaId" anywhere in the snapshot). */
export function usedMediaIds(snapshot: unknown): string[] {
	const ids = new Set<string>();
	for (const m of JSON.stringify(snapshot ?? null).matchAll(/"mediaId":"([^"]+)"/g)) ids.add(m[1]);
	return [...ids];
}

function storeFile(hash: string): string {
	return path.join(resolveMediaDir(), hash.slice(0, 2), hash);
}

function extOf(media: MediaDto): string {
	const name = typeof media.meta?.name === "string" ? media.meta.name : "";
	const fromName = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1];
	const fromMime = media.mime.split("/")[1]?.replace(/^x-/, "").replace("quicktime", "mov").replace("mpeg", "mp3");
	return (fromName ?? fromMime ?? "bin").toLowerCase();
}

function linkOrCopy(from: string, to: string): "link" | "copy" {
	if (existsSync(to)) return "link";
	try {
		linkSync(from, to);
		return "link";
	} catch {
		copyFileSync(from, to);
		return "copy";
	}
}

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** A render of this exact commit + quality that is queued, running, or done with its file still there. */
function reusable(projectId: string, commit: string, quality: RenderQuality): RenderRow | null {
	for (const row of listRows()) {
		if (row.project_id !== projectId || row.commit !== commit || row.quality !== quality) continue;
		const fresh = freshRow(row.render_id) ?? row;
		if (fresh.status === "queued" || fresh.status === "running") return fresh;
		if (fresh.status === "done" && fresh.file && existsSync(fresh.file)) return fresh;
	}
	return null;
}

export interface StartRenderResult {
	row: RenderRow;
	repeated: boolean;
}

/**
 * Start (or reuse) a render of `commit` (default: the branch head). Builds the job folder synchronously (hard links,
 * so it is fast), then hands the render to a detached worker and returns at once with status queued/running.
 */
export async function startRender(input: {
	projectId: string;
	commit?: string;
	branch?: string;
	quality: RenderQuality;
	fresh?: boolean;
}): Promise<StartRenderResult> {
	const { projectId, quality } = input;
	let commitId = input.commit;
	let branch: string | null = input.branch ?? null;
	if (!commitId) {
		const head = await getProjectHead(projectId, input.branch);
		commitId = head.head.id;
		branch = head.branch;
	}
	const commit = await getCommit(projectId, commitId, { snapshot: true });
	const snapshot = commit.snapshot as ProjectSnapshot | null;
	if (!snapshot) throw new Error(`commit ${commit.id} has no snapshot`);
	if (!input.fresh) {
		const again = reusable(projectId, commit.id, quality);
		if (again) return { row: again, repeated: true };
	}

	// Every media file the cut plays must be in the server's media store.
	const used = usedMediaIds(snapshot);
	const stored = await listProjectMedia(projectId);
	const byId = new Map(stored.map((m) => [m.media_id, m]));
	const missing: Array<{ media_id: string; why: string }> = [];
	for (const id of used) {
		const m = byId.get(id);
		if (!m) missing.push({ media_id: id, why: "never uploaded (it is only in a browser)" });
		else if (!existsSync(storeFile(m.hash))) missing.push({ media_id: id, why: "recorded, but its file is missing on disk" });
	}
	if (missing.length) throw new MediaMissingError(missing, stored.map((m) => m.media_id));

	const renderId = newRenderId();
	const jobDir = path.join(renderJobsParent(), `rr-${renderId}`);
	mkdirSync(path.join(jobDir, "media"), { recursive: true });
	const jobMedia: Array<Record<string, unknown>> = [];
	const rowMedia: RenderRow["media"] = [];
	for (const id of used) {
		const m = byId.get(id) as MediaDto;
		const meta = (m.meta ?? {}) as Record<string, unknown>;
		const file = `media/${id.replace(/[^A-Za-z0-9_-]/g, "-")}.${extOf(m)}`;
		const linked = linkOrCopy(storeFile(m.hash), path.join(jobDir, file));
		const type = typeof meta.type === "string" ? meta.type : m.mime.split("/")[0] || "video";
		jobMedia.push({
			id,
			file,
			type,
			name: typeof meta.name === "string" ? meta.name : id,
			width: num(meta.width),
			height: num(meta.height),
			duration: num(meta.duration),
			fps: num(meta.fps),
			hasAudio: typeof meta.hasAudio === "boolean" ? meta.hasAudio : undefined,
		});
		rowMedia.push({ id, file, type, linked });
	}
	writeFileSync(path.join(jobDir, "project.json"), `${JSON.stringify(snapshot)}\n`);
	writeFileSync(
		path.join(jobDir, "job.json"),
		`${JSON.stringify(
			{
				schema: "restorffcut-render-job@1",
				project: "project.json",
				media: jobMedia,
				export: { format: "mp4", quality: quality === "final" ? "high" : "medium" },
				source: { project_id: projectId, commit: commit.id, render_id: renderId },
			},
			null,
			1,
		)}\n`,
	);

	const dir = rendersDir();
	mkdirSync(dir, { recursive: true });
	const logFile = path.join(jobDir, "worker.log");
	const now = new Date().toISOString();
	const row: RenderRow = writeRow({
		schema: RENDER_SCHEMA,
		render_id: renderId,
		project_id: projectId,
		commit: commit.id,
		branch,
		quality,
		status: "queued",
		phase: "queued",
		progress: 0,
		created_at: now,
		updated_at: now,
		started_at: null,
		finished_at: null,
		job_dir: jobDir,
		file: null,
		bytes: null,
		duration_s: null,
		width: null,
		height: null,
		fps: null,
		video_codec: null,
		audio_codec: null,
		loudness: null,
		timings: {},
		media: rowMedia,
		error: null,
		pid: null,
		log: logFile,
		check: null,
	});

	const web = webRoot();
	const worker = path.join(web, "src", "server", "renders-worker.ts");
	const fd = openSync(logFile, "a");
	const child = spawn(findBun(), [worker, renderId, dir], {
		cwd: path.resolve(web, "..", ".."),
		detached: true,
		stdio: ["ignore", fd, fd],
		windowsHide: true,
		env: process.env,
	});
	child.on("error", () => {
		/* reported through the row: freshRow sees a dead pid */
	});
	child.unref();
	const pid = child.pid ?? null;
	return { row: writeRow({ ...row, pid }, dir), repeated: false };
}

/** The row, polled until it is done/failed or `waitS` passes (the poll answers within the MCP call's budget). */
export async function waitRender(renderId: string, waitS: number, signal?: AbortSignal): Promise<RenderRow | null> {
	const until = Date.now() + Math.max(0, waitS) * 1000;
	let row = freshRow(renderId);
	while (row && (row.status === "queued" || row.status === "running") && Date.now() < until && !signal?.aborted) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		row = freshRow(renderId);
	}
	return row;
}

/** Renders of a project, newest first (stale running rows are reported failed). */
export function projectRenders(projectId: string): RenderRow[] {
	return listRows()
		.filter((row) => row.project_id === projectId)
		.map((row) => freshRow(row.render_id) ?? row);
}

/** The newest finished render of a commit (any quality), and the newest one still running. */
export function rendersOfCommit(projectId: string, commit: string): { done: RenderRow | null; running: RenderRow | null; older: RenderRow | null } {
	const rows = projectRenders(projectId);
	const usable = (row: RenderRow) => row.status === "done" && !!row.file && existsSync(row.file);
	return {
		done: rows.find((row) => row.commit === commit && usable(row)) ?? null,
		running: rows.find((row) => row.commit === commit && (row.status === "queued" || row.status === "running")) ?? null,
		older: rows.find((row) => row.commit !== commit && usable(row)) ?? null,
	};
}
