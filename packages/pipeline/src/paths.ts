/**
 * Every path and external program the pipeline uses, in one place. Each one has an environment override; the
 * defaults are this machine's layout (documented in docs/restorff/PIPELINE.md §Setup).
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** restorffcut repo root (packages/pipeline/src → ../../..). */
export const REPO_ROOT = resolve(here, "..", "..", "..");

/** Python that can `import tvf` and run the Judge worker. */
export const PY = process.env.RESTORFF_PY || "C:\\Program Files\\Python313\\python.exe";

/** temporal-visual-flux checkout (word-timed transcripts). Its analyses live in <TVF_DIR>/work/<slug>. */
export const TVF_DIR = process.env.RESTORFF_TVF_DIR || "C:\\data\\code\\temporal-visual-flux";

/** Restorff's Judge worker (judge.py). */
export const JUDGE_DIR =
	process.env.RESTORFF_JUDGE_DIR || resolve(REPO_ROOT, "..", "restorff", "workers", "judge");

/** The running RestorffCut dev server (owned by the skin agent; port 8791 — BUILD-BRIEF §5). */
export const DEV_URL = (process.env.RESTORFFCUT_DEV_URL || "http://localhost:8791").replace(/\/$/, "");

/** Default parent for job folders when --out is not given. Never inside the repo: jobs can hold third-party media. */
export const DEFAULT_JOBS_PARENT =
	process.env.RESTORFFCUT_PIPELINE_JOBS || join(tmpdir(), "restorffcut-pipeline");

export const FFMPEG = process.env.FFMPEG || "ffmpeg";
export const FFPROBE = process.env.FFPROBE || "ffprobe";

/** Refuse to write a job folder inside the repo (rule 11: reel-derived media never lands in the repo). */
export function assertOutsideRepo(path: string): void {
	const abs = resolve(path).toLowerCase();
	const repo = REPO_ROOT.toLowerCase();
	if (abs === repo || abs.startsWith(repo + "\\") || abs.startsWith(repo + "/")) {
		throw new Error(`refusing to write a job inside the repo (${path}); use a folder outside ${REPO_ROOT}`);
	}
}

export function requireFile(path: string, what: string): string {
	if (!existsSync(path)) throw new Error(`${what} not found: ${path}`);
	return path;
}
