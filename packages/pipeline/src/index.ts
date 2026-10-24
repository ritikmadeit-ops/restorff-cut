/**
 * @restorffcut/pipeline — talking head → TVF → cutFromTranscript → RestorffCut project → headless render → master →
 * export gate. CLI: ./cli.ts. Runbook: ../../../docs/restorff/PIPELINE.md.
 */
export { autocut, DEFAULT_CAPTION_STYLE, jobNameFor } from "./autocut.ts";
export type { AutocutOptions, AutocutResult } from "./autocut.ts";
export { transcribe, findTvfWork, readTvfTranscript } from "./tvf.ts";
export type { TvfTranscript } from "./tvf.ts";
export { master, measureLoudness } from "./master.ts";
export type { Loudness, MasterResult } from "./master.ts";
export { gate, scriptFromWords } from "./gate.ts";
export type { GateResult } from "./gate.ts";
export { syncCheck } from "./sync.ts";
export type { SyncReport } from "./sync.ts";
