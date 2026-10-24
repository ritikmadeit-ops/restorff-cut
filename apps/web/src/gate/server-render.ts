/**
 * Render final on RestorffCut's server (ui-fix-render, 2026-10-21; QA 2026-10-20 #4, the blocker).
 *
 * Before: Render final encoded in this tab (the in-browser exporter on the main thread): a 49.6 s cut took ~734 s with
 * the tab frozen, then POST /api/gate (the whole file as the body) answered 500 → INCOMPLETE, and the file could not be
 * downloaded. Now the editor drives the server pipeline the MCP `render` + `check` tools already use:
 *
 *   1. commit the edits (sync engine push; a local draft gets its server copy first) and upload media the server lacks
 *   2. POST /api/renders {timeline_id, commit, quality: final} → a detached worker renders headless + masters
 *      (−14 LUFS / ≤ −1 dBTP); poll GET /api/renders/:id once a second (progress bar; the tab stays responsive)
 *   3. POST /api/renders/:id/check → the export gate with piece types and fix calls; findings become timeline comments
 *   4. the gate sheet shows the verdict; "Download final" streams /api/renders/:id/file?download=1 when the gate passes
 *      or the owner overrode the MUSTs (D13, gate/run.ts recordOverride → refreshReport).
 *
 * The in-browser render stays as a fallback ("Render in this browser", gate/run.ts runBrowserGate).
 * Runbook: docs/restorff/worklog/ui-fix-render.md.
 */
import type { CheckRun, FileMeasures, GateReport, PieceDecision } from "@restorffcut/gate";
import type { EditorCore } from "@/core";
import type { RenderRow } from "@/server/renders-store";
import { syncEngine } from "@/sync/engine";
import { useSyncStore } from "@/sync/store";
import { type GateServerRender, useGateStore } from "./store";

const POLL_MS = 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown when the project server cannot be used (offline, sign-in needed): the sheet offers the in-browser render. */
export class ServerUnavailableError extends Error {}

let runToken = 0;

/** Stop waiting for the current server render (it keeps running on the server; the same commit is reused next time). */
export function stopWaitingForServerRender(): void {
	runToken++;
	const gate = useGateStore.getState();
	gate.set({ phase: gate.report ? "done" : "idle", status: null, startedAt: null });
}

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		cache: "no-store",
		credentials: "same-origin",
	});
	const text = await res.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { error: text.slice(0, 300) };
	}
	if (!res.ok) {
		const d = (data ?? {}) as { error?: string; detail?: string; code?: string; missing?: Array<{ media_id: string; why: string }> };
		const error = new Error(`${d.error ?? `${method} ${url} failed`}${d.detail ? ` (${d.detail})` : ""}`) as Error & {
			status?: number;
			code?: string;
			missing?: Array<{ media_id: string; why: string }>;
		};
		error.status = res.status;
		error.code = d.code;
		error.missing = d.missing;
		throw error;
	}
	return data as T;
}

function setStatus(status: string): void {
	useGateStore.getState().set({ status });
}

async function waitWhile(cond: () => boolean, timeoutMs: number): Promise<void> {
	const until = Date.now() + timeoutMs;
	while (cond() && Date.now() < until) await sleep(250);
}

/**
 * The commit that holds exactly what is on screen: links a local draft (first commit), flushes the save, pushes the
 * edits as a commit by `user`, and waits for the sync engine to settle. Uses the engine's public API only.
 */
export async function commitCurrentCut(editor: EditorCore): Promise<{ projectId: string; commit: string }> {
	await waitWhile(() => ["off", "checking"].includes(useSyncStore.getState().status), 20_000);
	let state = useSyncStore.getState();
	if (state.status === "offline" || state.status === "error") {
		await syncEngine.refresh().catch(() => {});
		state = useSyncStore.getState();
	}
	if (state.status === "offline" || state.status === "error") {
		throw new ServerUnavailableError(
			`RestorffCut's project server is not reachable (${state.error ?? state.status}). Render in this browser instead, or try again.`,
		);
	}
	if (state.status === "unlinked") {
		setStatus("Starting version history: this draft gets its server copy…");
		const ok = await syncEngine.link();
		if (!ok) throw new ServerUnavailableError("Could not create the server copy of this draft. Render in this browser instead.");
	}
	setStatus("Saving your edits as a commit…");
	await editor.save.flush().catch(() => {});
	const deadline = Date.now() + 60_000;
	let quiet = 0;
	while (Date.now() < deadline) {
		const s = useSyncStore.getState();
		if (s.status === "conflict") {
			throw new Error("The server moved while you edited. Resolve the conflict (Versions: take theirs or keep mine), then Render final again.");
		}
		if (s.status === "offline" || s.status === "error") {
			throw new ServerUnavailableError(`The project server stopped answering (${s.error ?? s.status}). Render in this browser instead.`);
		}
		if (s.status === "pushing" || s.status === "pulling" || s.status === "checking") {
			await sleep(300);
			continue;
		}
		const pushed = await syncEngine.push();
		const projectId = useSyncStore.getState().projectId ?? syncEngine.getProjectId();
		if (pushed && projectId) return { projectId, commit: pushed.id };
		// null: nothing to commit (the engine then says "synced") or the engine was busy (it retries itself). Accept
		// only a settled "synced" seen on three tries in a row.
		const after = useSyncStore.getState();
		quiet = after.status === "synced" ? quiet + 1 : 0;
		const commit = after.base ?? after.head?.id ?? null;
		if (quiet >= 3 && commit && projectId) return { projectId, commit };
		await sleep(400);
	}
	throw new Error("Your edits did not reach the server within 60 s (the sync engine stayed busy). Try again.");
}

function fileNameFor(editor: EditorCore): string {
	const name = editor.project.getActiveOrNull()?.metadata.name ?? "render";
	return `${name.replace(/[<>:"/\\|?*]+/g, "-").trim().slice(0, 80) || "render"}.mp4`;
}

function serverView(row: RenderRow, repeated: boolean, checkSeconds: number | null = null): GateServerRender {
	return {
		renderId: row.render_id,
		projectId: row.project_id,
		commit: row.commit,
		quality: row.quality,
		phase: row.phase,
		progress: row.progress,
		repeated,
		bytes: row.bytes,
		duration_s: row.duration_s,
		renderSeconds: row.timings?.total_ms ? Math.round(row.timings.total_ms / 100) / 10 : null,
		checkSeconds,
		url: `/api/renders/${row.render_id}/file`,
	};
}

interface CheckAnswer {
	report: GateReport;
	measures: FileMeasures;
	runs: { timeline: CheckRun; file: CheckRun };
	piece: PieceDecision | null;
	comments: { posted: number; fixed: number; errors: unknown[] };
}

/** The whole server run: commit → upload → render (polled) → check → the gate sheet. Never throws. */
export async function runServerGate(editor: EditorCore): Promise<void> {
	const token = ++runToken;
	const live = () => token === runToken;
	const gate = useGateStore.getState();
	gate.set({ open: true, where: "server", phase: "preparing", error: null, status: "Getting the cut to the server…", startedAt: Date.now(), server: null, buffer: null });
	try {
		const { projectId, commit } = await commitCurrentCut(editor);
		if (!live()) return;
		setStatus("Uploading media the server does not have yet…");
		await syncEngine.uploadMissingMedia();
		if (!live()) return;

		const start = () => api<{ render: RenderRow; repeated: boolean }>("POST", "/api/renders", { timeline_id: projectId, commit, quality: "final" });
		let started: { render: RenderRow; repeated: boolean };
		try {
			started = await start();
		} catch (error) {
			const e = error as { code?: string; missing?: Array<{ media_id: string; why: string }> };
			if (e.code !== "media_missing") throw error;
			// an upload may still have been running for media added since: once more
			setStatus("Uploading the media the render needs…");
			await syncEngine.uploadMissingMedia();
			try {
				started = await start();
			} catch (again) {
				const m = (again as typeof e).missing ?? e.missing ?? [];
				if ((again as typeof e).code === "media_missing") {
					throw new Error(`${m.length} media file(s) of this cut are only in this browser and could not be uploaded (${m.map((x) => x.media_id.slice(0, 8)).join(", ")}). Render in this browser instead, or re-import them.`);
				}
				throw again;
			}
		}
		if (!live()) return;
		let row = started.render;
		const fileName = fileNameFor(editor);
		useGateStore.getState().set({ phase: "rendering", status: started.repeated ? "This commit was already rendered: reusing it." : "Rendering on the server…", server: serverView(row, started.repeated), fileName });

		while (row.status === "queued" || row.status === "running") {
			await sleep(POLL_MS);
			if (!live()) return;
			try {
				row = (await api<{ render: RenderRow }>("GET", `/api/renders/${row.render_id}`)).render;
			} catch (error) {
				// a dev-server recompile can drop one poll; keep polling unless the render is gone
				if ((error as { status?: number }).status === 404) throw error;
				continue;
			}
			if (!live()) return;
			const phaseWords: Record<string, string> = { queued: "Starting the renderer…", render: "Rendering on the server…", master: "Mastering the loudness (−14 LUFS)…", store: "Storing the master…" };
			useGateStore.getState().set({ status: phaseWords[row.phase] ?? `Rendering (${row.phase})…`, server: serverView(row, started.repeated) });
		}
		if (row.status !== "done") throw new Error(`The server render failed: ${row.error ?? "no reason given"}`);

		useGateStore.getState().set({ phase: "checking", status: "Running the export gate on the master…", server: serverView(row, started.repeated) });
		const t0 = performance.now();
		const checked = await api<CheckAnswer>("POST", `/api/renders/${row.render_id}/check`, { comments: true });
		if (!live()) return;
		const checkSeconds = Math.round((performance.now() - t0) / 100) / 10;
		useGateStore.getState().set({
			phase: "done",
			status: null,
			startedAt: null,
			server: serverView(row, started.repeated, checkSeconds),
			fileName,
			timelineRun: checked.runs.timeline,
			fileRun: checked.runs.file,
			measures: checked.measures,
			report: checked.report,
			checkedAt: new Date().toISOString(),
			markerMode: checked.comments.errors.length && !checked.comments.posted ? "local" : "server",
		});
		void syncEngine.loadComments().catch(() => {});
	} catch (error) {
		if (!live()) return;
		const message = error instanceof Error ? error.message : String(error);
		useGateStore.getState().set({ phase: "error", status: null, startedAt: null, error: message });
	}
}

/** "Download final" for a server render: the master, streamed by the server (no copy in this tab's memory). */
export function downloadServerRender(render: GateServerRender, fileName: string): void {
	const a = document.createElement("a");
	a.href = `${render.url}?download=1&name=${encodeURIComponent(fileName.replace(/\.mp4$/i, ""))}`;
	a.download = fileName;
	a.rel = "noopener";
	document.body.appendChild(a);
	a.click();
	a.remove();
}
