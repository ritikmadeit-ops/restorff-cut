/**
 * Running cutout / preset / reframe jobs, for the toolbar popover (progress, cancel, last error).
 */
import { create } from "zustand";
import type { CutoutProgress, CutoutProgressHandler } from "./types";

export interface CutoutJob {
	id: string;
	label: string;
	status: "running" | "done" | "error" | "cancelled";
	/** 0..1 overall. */
	progress: number;
	message: string;
	error?: string;
	controller: AbortController;
}

interface CutoutJobsState {
	jobs: CutoutJob[];
	upsert: (job: CutoutJob) => void;
	patch: (id: string, patch: Partial<CutoutJob>) => void;
	clearFinished: () => void;
}

export const useCutoutJobs = create<CutoutJobsState>((set) => ({
	jobs: [],
	upsert: (job) =>
		set((state) => ({ jobs: [job, ...state.jobs.filter((existing) => existing.id !== job.id)].slice(0, 8) })),
	patch: (id, patch) =>
		set((state) => ({ jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)) })),
	clearFinished: () => set((state) => ({ jobs: state.jobs.filter((job) => job.status === "running") })),
}));

const PHASE_SPAN: Record<CutoutProgress["phase"], [number, number]> = {
	"load-model": [0, 0.05],
	segment: [0.05, 0.5],
	cached: [0.5, 0.5],
	render: [0.5, 0.92],
	import: [0.92, 0.97],
	insert: [0.97, 1],
};

export function overallProgress(progress: CutoutProgress): number {
	const [from, to] = PHASE_SPAN[progress.phase];
	return from + (to - from) * Math.max(0, Math.min(1, progress.progress));
}

let counter = 1;

/** Runs a job with progress + cancel wired to the store. Re-throws errors after recording them. */
export async function runCutoutJob<T>({
	label,
	run,
	progressMap = overallProgress,
}: {
	label: string;
	run: (args: { onProgress: CutoutProgressHandler; signal: AbortSignal }) => Promise<T>;
	progressMap?: (progress: CutoutProgress) => number;
}): Promise<T> {
	const store = useCutoutJobs.getState();
	const id = `job-${counter++}`;
	const controller = new AbortController();
	store.upsert({ id, label, status: "running", progress: 0, message: "Starting…", controller });
	try {
		const result = await run({
			signal: controller.signal,
			onProgress: (progress) =>
				useCutoutJobs.getState().patch(id, { progress: progressMap(progress), message: progress.message }),
		});
		useCutoutJobs.getState().patch(id, { status: "done", progress: 1, message: "Done" });
		return result;
	} catch (error) {
		const aborted = error instanceof DOMException && error.name === "AbortError";
		useCutoutJobs.getState().patch(id, {
			status: aborted ? "cancelled" : "error",
			error: aborted ? undefined : error instanceof Error ? error.message : String(error),
			message: aborted ? "Cancelled" : "Failed",
		});
		throw error;
	}
}
