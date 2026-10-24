// Where headless render jobs live, for the dev-only render route (`/render/[job]`). Runbook:
// docs/restorff/PIPELINE.md. A job is a folder with job.json + project.json + media files, written by
// `bun packages/pipeline/src/cli.ts autocut`. Jobs live OUTSIDE the repo (they can hold third-party test media).
//
// Root: $RESTORFFCUT_JOBS_DIR, else <os tmpdir>/restorffcut-jobs. A job is either a folder directly in the root, or a
// pointer file `<root>/<job>.path` whose content is the absolute path of the job folder (so the pipeline can keep its
// job folders anywhere, e.g. a session scratchpad, without restarting the dev server to change an env var).
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export function renderRouteEnabled(): boolean {
	return (
		process.env.NODE_ENV !== "production" ||
		process.env.RESTORFFCUT_RENDER_ROUTE === "1"
	);
}

export function jobsRoot(): string {
	return resolve(
		process.env.RESTORFFCUT_JOBS_DIR || join(tmpdir(), "restorffcut-jobs"),
	);
}

/** The job's folder, or null when the name is invalid or nothing is registered under it. */
export function resolveJobDir(job: string): string | null {
	if (!JOB_NAME.test(job) || job.endsWith(".path")) return null;
	const root = jobsRoot();
	const direct = join(root, job);
	if (existsSync(direct) && statSync(direct).isDirectory()) return direct;
	const pointer = join(root, `${job}.path`);
	if (!existsSync(pointer)) return null;
	const target = readFileSync(pointer, "utf8").trim();
	if (!target || !isAbsolute(target)) return null;
	if (!existsSync(target) || !statSync(target).isDirectory()) return null;
	return resolve(target);
}

/** A file inside the job folder, or null when the path escapes it. */
export function resolveJobFile(jobDir: string, parts: string[]): string | null {
	if (!parts.length || parts.some((p) => !p || p === "." || p === "..")) {
		return null;
	}
	const file = resolve(jobDir, ...parts);
	const rel = relative(jobDir, file);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
	return file;
}

const TYPES: Record<string, string> = {
	".json": "application/json",
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
};

export function contentTypeFor(file: string): string {
	const dot = file.lastIndexOf(".");
	return (
		(dot >= 0 && TYPES[file.slice(dot).toLowerCase()]) ||
		"application/octet-stream"
	);
}
