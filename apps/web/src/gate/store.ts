/** React-facing state of the export gate (the last render, its checks, the sheet). */
import { create } from "zustand";
import type { CheckRun, FileMeasures, GateReport } from "@restorffcut/gate";
import type { ExportFormat, ExportQuality } from "@/export";

/**
 * preparing = committing the edits + uploading media the server lacks (server renders only);
 * rendering = the server render (polled) or the in-browser export; checking = the export gate.
 */
export type GatePhase = "idle" | "preparing" | "rendering" | "checking" | "fixing" | "done" | "error";

/**
 * Where Render final renders (ui-fix-render, 2026-10-21, QA #4): on RestorffCut's server (default: the MCP render
 * pipeline, ~4-5x real time, the tab stays responsive) or in this browser (the old path: the export encodes on the
 * main thread — a 49.6 s cut took ~734 s with the tab frozen).
 */
export type GateWhere = "server" | "browser";

export const GATE_BUSY_PHASES: readonly GatePhase[] = ["preparing", "rendering", "checking", "fixing"];

export function isGateBusy(phase: GatePhase): boolean {
	return GATE_BUSY_PHASES.includes(phase);
}

export interface LoudnessFixResult {
	gain_db: number;
	wanted_db: number;
	limited: boolean;
	elements: number;
	clamped: number;
	at: string;
}

/** The server render the gate ran on (Render final on the server). */
export interface GateServerRender {
	renderId: string;
	projectId: string;
	commit: string;
	quality: "preview" | "final";
	/** Worker phase: queued · render · master · store · done · failed. */
	phase: string;
	/** 0..1 while the export runs. */
	progress: number;
	/** The render was already made for this commit (reused, not rendered again). */
	repeated: boolean;
	bytes: number | null;
	duration_s: number | null;
	/** Server-side wall time of the render + master, seconds. */
	renderSeconds: number | null;
	/** Wall time of the check, seconds (measured in the browser). */
	checkSeconds: number | null;
	/** The master, streamed from /api/renders/:id/file. */
	url: string;
}

export interface GateStoreState {
	open: boolean;
	phase: GatePhase;
	error: string | null;
	/** What the busy phase is doing, in words ("uploading 2 media files…"). */
	status: string | null;
	/** Date.now() when the current run started (elapsed time in the sheet). */
	startedAt: number | null;
	where: GateWhere;
	/** The render the checks ran on; "Download final" saves exactly these bytes (browser renders only). */
	buffer: ArrayBuffer | null;
	/** The server render the checks ran on (server renders only). */
	server: GateServerRender | null;
	fileName: string | null;
	format: ExportFormat;
	quality: ExportQuality;
	includeAudio: boolean;
	timelineRun: CheckRun | null;
	fileRun: CheckRun | null;
	measures: FileMeasures | null;
	report: GateReport | null;
	checkedAt: string | null;
	/** Where the findings went: the project store's comments, or local markers only (no server copy). */
	markerMode: "server" | "local" | null;
	lastFix: LoudnessFixResult | null;
	set: (patch: Partial<GateStoreState>) => void;
	reset: () => void;
}

const initial = {
	open: false,
	phase: "idle" as GatePhase,
	error: null,
	status: null,
	startedAt: null,
	where: "server" as GateWhere,
	buffer: null,
	server: null,
	fileName: null,
	format: "mp4" as ExportFormat,
	quality: "high" as ExportQuality,
	includeAudio: true,
	timelineRun: null,
	fileRun: null,
	measures: null,
	report: null,
	checkedAt: null,
	markerMode: null,
	lastFix: null,
};

export const useGateStore = create<GateStoreState>()((set) => ({
	...initial,
	set: (patch) => set(patch),
	reset: () => set({ ...initial }),
}));
