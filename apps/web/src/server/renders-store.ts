/**
 * Renders made over MCP (`render` tool): one JSON row per render on disk, plus the mastered file.
 *
 *   <renders dir>/<render_id>.json         the row (schema restorffcut-render@1)
 *   <renders dir>/<render_id>/master.mp4   the mastered file (−14 LUFS, ≤ −1 dBTP), once done
 *
 * Renders dir: $RESTORFFCUT_RENDERS_DIR, else <apps/web>/.data/renders (git-ignored, like the media store).
 * Job folders (what the headless renderer reads: job.json + project.json + media/) live OUTSIDE the repo:
 * $RESTORFFCUT_RENDER_JOBS, else <os tmpdir>/restorffcut-renders/rr-<render_id>.
 *
 * Node builtins only (no "@/" imports): the background worker (./renders-worker.ts, run by bun outside Next) reads
 * and writes the same rows. Runbook: docs/restorff/worklog/mcp-render.md.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const RENDER_SCHEMA = "restorffcut-render@1";
export type RenderQuality = "preview" | "final";
export type RenderStatus = "queued" | "running" | "done" | "failed";
export type RenderPhase = "queued" | "render" | "master" | "store" | "done" | "failed";

export interface RenderLoudness {
	integratedLufs: number;
	truePeakDbtp: number;
	lra: number;
}

export interface RenderCheckSummary {
	state: "PASS" | "BLOCKED" | "INCOMPLETE";
	counts: { must: number; should: number; info: number };
	at: string;
	blocking: number;
}

export interface RenderRow {
	schema: typeof RENDER_SCHEMA;
	render_id: string;
	project_id: string;
	commit: string;
	branch: string | null;
	quality: RenderQuality;
	status: RenderStatus;
	phase: RenderPhase;
	/** 0..1 while the editor's export runs (from the driver's progress lines). */
	progress: number;
	created_at: string;
	updated_at: string;
	started_at: string | null;
	finished_at: string | null;
	/** The job folder the headless renderer reads (outside the repo). */
	job_dir: string;
	/** The mastered file (absolute path), once done. */
	file: string | null;
	bytes: number | null;
	duration_s: number | null;
	width: number | null;
	height: number | null;
	fps: number | null;
	video_codec: string | null;
	audio_codec: string | null;
	/** Loudness of the editor's render (before) and of the master (after); null when the render has no audio. */
	loudness: { before: RenderLoudness | null; after: RenderLoudness | null; passes: number | null; ok: boolean | null } | null;
	/** Wall time of the steps, ms. */
	timings: { render_ms?: number; master_ms?: number; total_ms?: number; wall_per_output_s?: number | null };
	media: Array<{ id: string; file: string; type: string; linked: "link" | "copy" }>;
	error: string | null;
	/** The worker's pid (to tell a crashed worker from a slow one) and its log file. */
	pid: number | null;
	log: string;
	/** The last `check` on this render. */
	check: RenderCheckSummary | null;
}

export function rendersDir(): string {
	const configured = process.env.RESTORFFCUT_RENDERS_DIR?.trim();
	return configured ? path.resolve(configured) : path.join(process.cwd(), ".data", "renders");
}

export function renderJobsParent(): string {
	const configured = process.env.RESTORFFCUT_RENDER_JOBS?.trim();
	return configured ? path.resolve(configured) : path.join(tmpdir(), "restorffcut-renders");
}

const RENDER_ID = /^r[a-z0-9]{6,40}$/;

export function isRenderId(value: unknown): value is string {
	return typeof value === "string" && RENDER_ID.test(value);
}

export function rowFile(renderId: string, dir = rendersDir()): string {
	if (!isRenderId(renderId)) throw new Error(`invalid render id ${renderId}`);
	return path.join(dir, `${renderId}.json`);
}

export function readRow(renderId: string, dir = rendersDir()): RenderRow | null {
	if (!isRenderId(renderId)) return null;
	const file = rowFile(renderId, dir);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as RenderRow;
	} catch {
		return null;
	}
}

/** Atomic write (temp file + rename), so a reader never sees half a row. */
export function writeRow(row: RenderRow, dir = rendersDir()): RenderRow {
	mkdirSync(dir, { recursive: true });
	const file = rowFile(row.render_id, dir);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(row, null, 1)}\n`);
	renameSync(tmp, file);
	return row;
}

export function updateRow(renderId: string, patch: Partial<RenderRow>, dir = rendersDir()): RenderRow | null {
	const row = readRow(renderId, dir);
	if (!row) return null;
	return writeRow({ ...row, ...patch, updated_at: new Date().toISOString() }, dir);
}

export function listRows(dir = rendersDir()): RenderRow[] {
	if (!existsSync(dir)) return [];
	const rows: RenderRow[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const row = readRow(name.slice(0, -5), dir);
		if (row?.schema === RENDER_SCHEMA) rows.push(row);
	}
	return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

/** True when a process with this pid exists (signal 0 = an existence check; nothing is sent to the process). */
export function pidAlive(pid: number | null): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/** A running row whose worker is gone, or that has not moved for this long, is reported failed. */
export const STALE_MS = 20 * 60 * 1000;

/** The row as callers should see it: a queued/running row with a dead or silent worker becomes failed (and is saved). */
export function freshRow(renderId: string, dir = rendersDir()): RenderRow | null {
	const row = readRow(renderId, dir);
	if (!row || (row.status !== "queued" && row.status !== "running")) return row;
	const age = Date.now() - Date.parse(row.updated_at);
	const started = Date.now() - Date.parse(row.created_at);
	const dead = row.pid !== null && !pidAlive(row.pid) && started > 5000;
	if (dead || age > STALE_MS) {
		return updateRow(
			renderId,
			{
				status: "failed",
				phase: "failed",
				finished_at: new Date().toISOString(),
				error: dead
					? `the render worker (pid ${row.pid}) exited without finishing; its log: ${row.log}`
					: `no progress for ${Math.round(age / 60000)} min; its log: ${row.log}`,
			},
			dir,
		);
	}
	return row;
}

export function newRenderId(): string {
	const time = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
	return `r${time}${rand}`;
}
