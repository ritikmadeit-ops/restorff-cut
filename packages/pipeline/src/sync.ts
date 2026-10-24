/**
 * Did the render say what the cut plan says it says, when it says it? Aligns the words the Judge's TVF pass heard in
 * the rendered file with the kept words of the cut plan (timeline times), and reports the timing offset and any
 * planned word that was not heard (a word clipped at a splice — EXPORT-GATE "CLIP": "a trim can clip a word at a
 * splice"). MEASURED evidence for "cuts land on word boundaries" and for A/V-caption sync.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TimedWord } from "@restorffcut/timeline-ops";
import { readTvfTranscript } from "./tvf.ts";

export interface SyncReport {
	transcript: string | null;
	planned: number;
	heard: number;
	matched: number;
	medianOffsetS: number | null;
	p90AbsOffsetS: number | null;
	maxAbsOffsetS: number | null;
	/** Planned words not matched in what was heard, with their timeline time. */
	missing: Array<{ text: string; t: number; nearCut: boolean }>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']/g, "");

function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
	const n = a.length;
	const m = b.length;
	const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const pairs: Array<[number, number]> = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			pairs.push([i, j]);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
		else j++;
	}
	return pairs;
}

/** The TVF work folder the Judge made for the rendered file (judge/<name>/tvf/<slug>). */
export function findJudgeTranscript(jobDir: string): string | null {
	const tvfRoot = join(jobDir, "judge", "gate", "tvf");
	if (!existsSync(tvfRoot)) return null;
	for (const dir of readdirSync(tvfRoot)) {
		if (existsSync(join(tvfRoot, dir, "transcript", "transcript.json"))) return join(tvfRoot, dir);
	}
	return null;
}

export function syncCheck(jobDir: string, cutTimes: number[] = []): SyncReport {
	const cut = JSON.parse(readFileSync(join(jobDir, "cut.json"), "utf8")) as { keptWords: TimedWord[] };
	const planned = cut.keptWords;
	const workDir = findJudgeTranscript(jobDir);
	if (!workDir) {
		return { transcript: null, planned: planned.length, heard: 0, matched: 0, medianOffsetS: null, p90AbsOffsetS: null, maxAbsOffsetS: null, missing: [] };
	}
	const heard = readTvfTranscript(workDir).words;
	const pairs = lcsPairs(planned.map((w) => norm(w.text)), heard.map((w) => norm(w.text)));
	const offsets = pairs.map(([i, j]) => heard[j].start - planned[i].start).sort((x, y) => x - y);
	const abs = offsets.map(Math.abs).sort((x, y) => x - y);
	const matchedPlanned = new Set(pairs.map(([i]) => i));
	const missing = planned
		.map((w, i) => ({ w, i }))
		.filter(({ i }) => !matchedPlanned.has(i))
		.map(({ w }) => ({ text: w.text, t: Math.round(w.start * 100) / 100, nearCut: cutTimes.some((c) => Math.abs(c - w.start) < 0.5) }));
	const pick = (list: number[], q: number) => (list.length ? Math.round(list[Math.min(list.length - 1, Math.floor(q * list.length))] * 1000) / 1000 : null);
	return {
		transcript: join(workDir, "transcript", "transcript.json"),
		planned: planned.length,
		heard: heard.length,
		matched: pairs.length,
		medianOffsetS: pick(offsets, 0.5),
		p90AbsOffsetS: pick(abs, 0.9),
		maxAbsOffsetS: abs.length ? Math.round(abs[abs.length - 1] * 1000) / 1000 : null,
		missing,
	};
}
