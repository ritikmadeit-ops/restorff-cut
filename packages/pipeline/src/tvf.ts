/**
 * Word-timed transcripts from temporal-visual-flux (TVF). Reuses an existing analysis of the same file (TVF keeps one
 * work folder per video under <TVF_DIR>/work/<slug>, with manifest.json naming its source), else runs
 * `python -m tvf run <video>` (resumable; faster-whisper large-v3 on CUDA when available).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TimedWord } from "@restorffcut/timeline-ops";
import { PY, TVF_DIR } from "./paths.ts";
import { run } from "./util.ts";

export interface TvfTranscript {
	workDir: string;
	transcriptPath: string;
	backend: string;
	model: string;
	device: string;
	language: string;
	duration: number;
	words: TimedWord[];
	reused: boolean;
	ms: number;
}

interface TvfWord {
	start: number;
	end: number;
	word: string;
	probability?: number;
}

interface TvfTranscriptFile {
	backend?: string;
	model?: string;
	device?: string;
	language?: string;
	duration?: number;
	segments?: Array<{ words?: TvfWord[]; text?: string; start: number; end: number }>;
}

const norm = (p: string) => resolve(p).replace(/\\/g, "/").toLowerCase();

/**
 * The TVF work folder that analysed this exact file (path and size match) and has a finished transcript. Looks in
 * `workRoot` (default: TVF's own <TVF_DIR>/work, where earlier analyses live — read only).
 */
export function findTvfWork(video: string, workRoot = join(TVF_DIR, "work")): string | null {
	const work = workRoot;
	if (!existsSync(work)) return null;
	const target = norm(video);
	const info = statSync(video);
	for (const dir of readdirSync(work)) {
		const manifestPath = join(work, dir, "manifest.json");
		if (!existsSync(manifestPath)) continue;
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
				source?: { path?: string; size?: number };
				stages?: Record<string, { status?: string }>;
			};
			if (!manifest.source?.path || norm(manifest.source.path) !== target) continue;
			if (manifest.source.size != null && manifest.source.size !== info.size) continue;
			if (manifest.stages?.transcript?.status !== "ok") continue;
			if (!existsSync(join(work, dir, "transcript", "transcript.json"))) continue;
			return join(work, dir);
		} catch {
			/* not a TVF manifest */
		}
	}
	return null;
}

export function readTvfTranscript(workDir: string): Omit<TvfTranscript, "reused" | "ms"> {
	const transcriptPath = join(workDir, "transcript", "transcript.json");
	const t = JSON.parse(readFileSync(transcriptPath, "utf8")) as TvfTranscriptFile;
	const words: TimedWord[] = [];
	for (const segment of t.segments ?? []) {
		for (const w of segment.words ?? []) {
			const text = String(w.word ?? "").trim();
			if (!text || !(w.end > w.start)) continue;
			words.push({ text, start: w.start, end: w.end });
		}
	}
	words.sort((a, b) => a.start - b.start);
	return {
		workDir,
		transcriptPath,
		backend: String(t.backend ?? "?"),
		model: String(t.model ?? "?"),
		device: String(t.device ?? "?"),
		language: String(t.language ?? "?"),
		duration: Number(t.duration ?? 0),
		words,
	};
}

/**
 * Reuse or run TVF. Reuse: an analysis in TVF's own work folder, or in `workRoot`. A new run writes ONLY into
 * `workRoot` (`--work`, e.g. <job>/tvf) — never into the TVF checkout (another project; and test media stay out of
 * it). `force` re-runs even when an analysis exists.
 */
export async function transcribe(video: string, opts: { force?: boolean; workRoot?: string } = {}): Promise<TvfTranscript> {
	const started = performance.now();
	if (!opts.force) {
		const existing = findTvfWork(video) ?? (opts.workRoot ? findTvfWork(video, opts.workRoot) : null);
		if (existing) {
			return { ...readTvfTranscript(existing), reused: true, ms: Math.round(performance.now() - started) };
		}
	}
	if (!opts.workRoot) throw new Error("no TVF analysis of this file to reuse, and no workRoot for a new run");
	const r = await run(PY, ["-m", "tvf", "run", resolve(video), "--work", resolve(opts.workRoot), ...(opts.force ? ["--force"] : [])], {
		cwd: TVF_DIR,
		echo: true,
		env: { PYTHONIOENCODING: "utf-8" },
	});
	if (r.code !== 0) throw new Error(`tvf run failed (exit ${r.code}): ${r.stderr.slice(-800)}`);
	const workDir = findTvfWork(video, opts.workRoot);
	if (!workDir) throw new Error("tvf run finished but no work folder with a transcript names this video");
	return { ...readTvfTranscript(workDir), reused: false, ms: Math.round(performance.now() - started) };
}
