/**
 * The export gate in the editor: Render final → export → timeline checks (exact, from the project) + file checks
 * (POST /api/gate: ffmpeg on the encoded file) → one report → markers on the timeline.
 * Spec: docs/restorff/EXPORT-GATE.md. Decision on overrides: plan/DECISIONS.md D13.
 */
import {
	buildReport,
	fixedSince,
	loudnessGain,
	OverrideError,
	parseDeliver,
	pinFindings,
	runTimelineChecks,
	validateOverride,
	type CheckRun,
	type FileMeasures,
	type Finding,
	type GateOverride,
	type GateProject,
	type MediaInfo,
} from "@restorffcut/gate";
import type { EditorCore } from "@/core";
import { getExportFileExtension, getExportMimeType, type ExportFormat, type ExportQuality } from "@/export";
import type { TProject } from "@/project/types";
import { remote, type RemoteComment } from "@/sync/remote";
import { syncEngine } from "@/sync/engine";
import { useSyncStore } from "@/sync/store";
import { getTextMeasurementContext, measureTextElement } from "@/text/measure-element";
import type { TextElement, TimelineElement } from "@/timeline";
import { mediaTimeFromSeconds } from "@/wasm";
import { gateCommentPayload } from "./comment-payload";
import { currentOwner, isProjectOwner } from "./owner";
import { runServerGate } from "./server-render";
import { type GateWhere, useGateStore } from "./store";

const FILE_RULES = ["LOUD", "CLEAN", "FORMAT"] as const;

// ------------------------------------------------------------------ reading the project

interface RestorffMetaLike {
	overrides?: GateOverride[];
	brief?: { deliver?: unknown; fps?: number };
	[k: string]: unknown;
}

function restorffMeta(project: TProject): RestorffMetaLike {
	return ((project.metadata as unknown as { restorff?: RestorffMetaLike }).restorff ?? {}) as RestorffMetaLike;
}

export function projectOverrides(project: TProject | null): GateOverride[] {
	if (!project) return [];
	return restorffMeta(project).overrides ?? [];
}

/** The project as the gate reads it: the live scenes (not the last saved copy). */
export function gateInput(editor: EditorCore): { project: GateProject; media: Record<string, MediaInfo> } {
	const active = editor.project.getActive();
	const scene = editor.scenes.getActiveSceneOrNull();
	const project = {
		...active,
		scenes: editor.scenes.getScenes(),
		currentSceneId: scene?.id ?? active.currentSceneId,
	} as unknown as GateProject;
	const media: Record<string, MediaInfo> = {};
	for (const asset of editor.media.getAssets()) {
		media[asset.id] = {
			// ASSUMPTION: MediaAsset.duration is seconds (media/processing).
			duration: typeof asset.duration === "number" ? asset.duration : undefined,
			width: asset.width,
			height: asset.height,
			fps: asset.fps,
			hasAudio: asset.hasAudio,
		};
	}
	return { project, media };
}

function measureText(canvasHeight: number) {
	return (el: unknown) => {
		try {
			const m = measureTextElement({
				element: el as TextElement,
				canvasHeight,
				localTime: 0,
				ctx: getTextMeasurementContext(),
			});
			return m.visualRect;
		} catch {
			return null;
		}
	};
}

export function runTimelineHalf(editor: EditorCore, commit: string | null): CheckRun {
	const { project, media } = gateInput(editor);
	return runTimelineChecks(project, {
		media,
		measureText: measureText(project.settings.canvasSize.height),
		commit,
	});
}

// ------------------------------------------------------------------ file half

export async function runFileHalf({
	buffer,
	format,
	fileName,
	expect,
	commit,
}: {
	buffer: ArrayBuffer;
	format: ExportFormat;
	fileName: string;
	expect: { width: number; height: number; fps: number };
	commit: string | null;
}): Promise<{ run: CheckRun; measures: FileMeasures | null }> {
	const q = new URLSearchParams({
		w: String(expect.width),
		h: String(expect.height),
		fps: String(expect.fps),
		name: fileName,
	});
	if (commit) q.set("commit", commit);
	try {
		const res = await fetch(`/api/gate?${q.toString()}`, {
			method: "POST",
			headers: { "Content-Type": getExportMimeType({ format }) },
			body: new Blob([buffer], { type: getExportMimeType({ format }) }),
			credentials: "same-origin",
		});
		const data = (await res.json().catch(() => null)) as {
			run?: CheckRun;
			measures?: FileMeasures;
			error?: string;
			detail?: string;
		} | null;
		if (!res.ok || !data?.run) {
			// ui-fix-render (QA #4): say WHY (the route's 500 carries `detail`), not only "internal error".
			const why = `${data?.error ?? "the file checks failed"}${data?.detail ? `: ${data.detail}` : ""} (HTTP ${res.status})`;
			return { run: notRun(why), measures: null };
		}
		return { run: data.run, measures: data.measures ?? null };
	} catch (error) {
		return {
			run: notRun(`the file checks could not reach the server: ${error instanceof Error ? error.message : String(error)}`),
			measures: null,
		};
	}
}

function notRun(why: string): CheckRun {
	return { findings: [], ran: [], not_run: FILE_RULES.map((rule) => ({ rule, why })), skipped: [] };
}

// ------------------------------------------------------------------ markers

function isLinked(): boolean {
	const s = useSyncStore.getState();
	// ui-fix-timeline (QA #30): the status is transient (a pull that failed while the tab was busy encoding reads
	// "offline"); the engine's linked flag says whether the server has this project at all.
	return (
		Boolean(s.projectId) &&
		(syncEngine.isLinked() || ["synced", "dirty", "pushing", "pulling", "conflict"].includes(s.status))
	);
}

function localComment(f: Finding, trackIdOf: (elementId: string | null) => string | null): RemoteComment {
	const resolved = f.status === "dismissed" || f.status === "fixed";
	return {
		id: `gate-local:${f.id}`,
		project_id: "local",
		commit_id: f.commit ?? null,
		share_link_id: null,
		time_s: f.t,
		time_end_s: f.t_end,
		track_id: trackIdOf(f.element_id),
		track_name: f.track,
		element_id: f.element_id,
		author: f.source,
		body: `${f.message} → ${f.fix}`,
		rule_id: f.rule,
		severity: f.severity,
		status: resolved ? "resolved" : "open",
		parent_id: null,
		finding_id: f.id,
		resolved_by: f.resolved_by ?? null,
		resolved_at: null,
		created_at: new Date().toISOString(),
	};
}

/**
 * Findings become timeline markers (EXPORT-GATE §3). Linked to the project store → posted as finding@1 to the
 * port agent's comments API (upsert by finding id; gone findings are posted as "fixed"). Otherwise → local markers
 * in the same store the marker row draws from (they live until reload; nothing leaves the browser).
 */
export async function publishMarkers(
	editor: EditorCore,
	findings: Finding[],
	previous: Finding[],
	/** This report's check runs: open gate comments for rules they re-checked and no longer find are closed. */
	runs?: Array<CheckRun | null | undefined>,
): Promise<"server" | "local"> {
	const gone = fixedSince(previous, findings);
	const all = [...findings, ...gone];
	const projectId = useSyncStore.getState().projectId;
	if (isLinked() && projectId) {
		// ui-fix-timeline (QA 2026-10-20 #30): the body the comments API accepts (gate/comment-payload.ts). An empty
		// import is a 400 there, so a clean run with nothing to close posts nothing.
		const payload = gateCommentPayload({
			findings,
			previous,
			existing: useSyncStore.getState().comments,
			runs,
			commitId: useSyncStore.getState().head?.id ?? null,
		});
		if (!payload) return "server";
		try {
			const res = (await remote.addComment(projectId, payload)) as { errors?: unknown[] };
			if (res.errors?.length) console.warn("[gate] some findings were not posted as comments", res.errors);
			await syncEngine.loadComments();
			return "server";
		} catch (error) {
			console.warn("[gate] posting findings as comments failed; showing local markers", error);
		}
	}
	const trackIdOf = (elementId: string | null) => (elementId ? findTrackId(editor, elementId) : null);
	const store = useSyncStore.getState();
	const keep = store.comments.filter((c) => !c.id.startsWith("gate-local:"));
	store.set({ comments: [...keep, ...all.filter((f) => f.status !== "fixed").map((f) => localComment(f, trackIdOf))] });
	return "local";
}

export function findTrackId(editor: EditorCore, elementId: string): string | null {
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!scene) return null;
	const tracks = [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio];
	return tracks.find((t) => (t.elements as TimelineElement[]).some((e) => e.id === elementId))?.id ?? null;
}

/** Click a finding: the playhead jumps to it and its element is selected (and its marker turns neon). */
export function focusFinding(editor: EditorCore, f: Finding): void {
	editor.playback.seek({ time: mediaTimeFromSeconds({ seconds: f.t }) });
	if (f.element_id) {
		const trackId = findTrackId(editor, f.element_id);
		if (trackId) editor.selection.setSelectedElements({ elements: [{ trackId, elementId: f.element_id }] });
	}
	const comment = useSyncStore.getState().comments.find((c) => c.finding_id === f.id);
	if (comment) useSyncStore.getState().selectComment(comment.id);
}

// ------------------------------------------------------------------ the whole run

function expectedFile(project: TProject): { width: number; height: number; fps: number } {
	const brief = restorffMeta(project).brief ?? {};
	const size = parseDeliver(brief.deliver);
	const fps = brief.fps ?? project.settings.fps.numerator / project.settings.fps.denominator;
	return { ...size, fps };
}

/** Recompute the report from the stored runs (after an override), without rendering again. */
export function refreshReport(editor: EditorCore): void {
	const s = useGateStore.getState();
	if (!s.timelineRun) return;
	const runs = [s.timelineRun, ...(s.fileRun ? [s.fileRun] : [])];
	s.set({ report: buildReport(runs, projectOverrides(editor.project.getActiveOrNull())) });
}

/**
 * Render final + the export gate. ui-fix-render (2026-10-21, QA #4): by default on RestorffCut's server
 * (./server-render.ts — the tab stays responsive, ~4-5x real time); `where: "browser"` keeps the old in-browser
 * export as a fallback. Without `where`, the last choice (the store's `where`) is used.
 */
export async function runGate(
	editor: EditorCore,
	opts: { format: ExportFormat; quality: ExportQuality; includeAudio: boolean; where?: GateWhere },
): Promise<void> {
	const where = opts.where ?? useGateStore.getState().where;
	if (where === "server") {
		useGateStore.getState().set({ format: opts.format, quality: opts.quality, includeAudio: opts.includeAudio });
		return runServerGate(editor);
	}
	return runBrowserGate(editor, opts);
}

/** The in-browser fallback: the editor's exporter in this tab (slow; the main thread is busy while it encodes). */
export async function runBrowserGate(
	editor: EditorCore,
	opts: { format: ExportFormat; quality: ExportQuality; includeAudio: boolean },
): Promise<void> {
	const gate = useGateStore.getState();
	const project = editor.project.getActive();
	const previous = gate.report?.findings ?? [];
	gate.set({
		open: true,
		phase: "rendering",
		error: null,
		where: "browser",
		server: null,
		status: "Rendering in this browser (the tab is busy until it finishes)…",
		startedAt: Date.now(),
		format: opts.format,
		quality: opts.quality,
		includeAudio: opts.includeAudio,
	});
	const result = await editor.project.export({
		options: { format: opts.format, quality: opts.quality, fps: project.settings.fps, includeAudio: opts.includeAudio },
	});
	editor.project.clearExportState();
	if (result.cancelled) {
		gate.set({ phase: gate.report ? "done" : "idle", status: null, startedAt: null });
		return;
	}
	if (!result.success || !result.buffer) {
		gate.set({ phase: "error", error: result.error ?? "the render failed", status: null, startedAt: null });
		return;
	}
	gate.set({ phase: "checking", status: "Uploading the file for the file checks…" });
	const commit = useSyncStore.getState().head?.id ?? null;
	const fileName = `${project.metadata.name}${getExportFileExtension({ format: opts.format })}`;
	let timelineRun: CheckRun;
	try {
		timelineRun = runTimelineHalf(editor, commit);
	} catch (error) {
		timelineRun = {
			findings: [],
			ran: [],
			not_run: [{ rule: "TIMELINE", why: error instanceof Error ? error.message : String(error) }],
			skipped: [],
		};
	}
	const file = await runFileHalf({
		buffer: result.buffer,
		format: opts.format,
		fileName,
		expect: expectedFile(project),
		commit,
	});
	const { project: input } = gateInput(editor);
	const fileRun: CheckRun = { ...file.run, findings: pinFindings(file.run.findings, input) };
	const report = buildReport([timelineRun, fileRun], projectOverrides(editor.project.getActiveOrNull()));
	gate.set({
		phase: "done",
		status: null,
		startedAt: null,
		buffer: result.buffer,
		fileName,
		timelineRun,
		fileRun,
		measures: file.measures,
		report,
		checkedAt: new Date().toISOString(),
	});
	const markerMode = await publishMarkers(editor, report.findings, previous, [timelineRun, fileRun]).catch(() => null);
	useGateStore.getState().set({ markerMode });
}

// ------------------------------------------------------------------ overrides (D13)

/**
 * Record an owner override on the project (`metadata.restorff.overrides`) and re-evaluate the gate. Throws
 * OverrideError for claims, for anything but the owner, and for a missing reason. There is deliberately no other
 * write path: Claude's tools (ops@1, the MCP bridge) have no override op.
 */
export function recordOverride(editor: EditorCore, f: Finding, reason: string): GateOverride {
	const owner = currentOwner();
	const override = validateOverride(
		{
			rule: f.rule,
			reason,
			by: owner.by,
			by_label: owner.label,
			at: new Date().toISOString(),
			finding_id: f.id,
			t: f.rule === "LOUD" || f.rule === "FORMAT" ? null : f.t,
		},
		isProjectOwner(owner),
	);
	const project = editor.project.getActive();
	const meta = restorffMeta(project);
	const next = {
		...project,
		metadata: { ...project.metadata, restorff: { ...meta, overrides: [...(meta.overrides ?? []), override] } },
	} as TProject;
	editor.project.setActiveProject({ project: next });
	editor.save.markDirty();
	refreshReport(editor);
	const report = useGateStore.getState().report;
	const runs = useGateStore.getState();
	if (report) void publishMarkers(editor, report.findings, [], [runs.timelineRun, runs.fileRun]).catch(() => null);
	return override;
}

/** Waive a check that could not run (INCOMPLETE), owner only, with a reason. */
export function recordNotRunOverride(editor: EditorCore, rule: string, reason: string): GateOverride {
	const owner = currentOwner();
	const override = validateOverride(
		{ rule, reason, by: owner.by, by_label: owner.label, at: new Date().toISOString(), t: null },
		isProjectOwner(owner),
	);
	const project = editor.project.getActive();
	const meta = restorffMeta(project);
	editor.project.setActiveProject({
		project: {
			...project,
			metadata: { ...project.metadata, restorff: { ...meta, overrides: [...(meta.overrides ?? []), override] } },
		} as TProject,
	});
	editor.save.markDirty();
	refreshReport(editor);
	return override;
}

export function removeOverride(editor: EditorCore, at: string): void {
	const project = editor.project.getActive();
	const meta = restorffMeta(project);
	editor.project.setActiveProject({
		project: {
			...project,
			metadata: {
				...project.metadata,
				restorff: { ...meta, overrides: (meta.overrides ?? []).filter((o) => o.at !== at) },
			},
		} as TProject,
	});
	editor.save.markDirty();
	refreshReport(editor);
}

export { OverrideError };

// ------------------------------------------------------------------ Fix loudness

/**
 * One click: the gain LOUD measured (capped so the true peak stays under −1 dBTP — there is no limiter in the
 * editor yet) applied as a master gain = the same dB added to every audible element's `volume` (and its volume
 * keyframes), one undo step. Also sets `settings.loudness` (−14 LUFS / −1 dBTP) so the media agent's exporter
 * normalisation takes over when it lands. Then renders and checks again.
 */
export async function fixLoudness(editor: EditorCore): Promise<void> {
	const gate = useGateStore.getState();
	const loud = gate.report?.findings.find((f) => f.rule === "LOUD");
	const m = gate.measures?.loudness;
	if (!loud || !m) return;
	const g = loudnessGain(m);
	if (!g) return;
	gate.set({ phase: "fixing" });
	const scene = editor.scenes.getActiveScene();
	const updates: Array<{ trackId: string; elementId: string; patch: Partial<TimelineElement> }> = [];
	let clamped = 0;
	const tracks = [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio];
	for (const track of tracks) {
		for (const el of track.elements as TimelineElement[]) {
			const audible =
				el.type === "audio" || (el.type === "video" && (el as { isSourceAudioEnabled?: boolean }).isSourceAudioEnabled !== false);
			if (!audible) continue;
			const before = typeof el.params?.volume === "number" ? (el.params.volume as number) : 0;
			const after = Math.max(-60, Math.min(20, before + g.gain_db));
			if (after !== before + g.gain_db) clamped++;
			const patch: Partial<TimelineElement> = { params: { ...el.params, volume: after } };
			const channel = el.animations?.volume as { keys?: Array<{ value: unknown }> } | undefined;
			if (channel?.keys?.length) {
				patch.animations = {
					...el.animations,
					volume: {
						...channel,
						keys: channel.keys.map((k) =>
							typeof k.value === "number" ? { ...k, value: Math.max(-60, Math.min(20, k.value + g.gain_db)) } : k,
						),
					},
				} as unknown as TimelineElement["animations"];
			}
			updates.push({ trackId: track.id, elementId: el.id, patch });
		}
	}
	if (updates.length) editor.timeline.updateElements({ updates });
	try {
		await editor.project.updateSettings({
			settings: { loudness: { enabled: true, integratedLufs: -14, truePeakDb: -1 } },
		});
	} catch {
		// settings.loudness is optional (project v32); older builds ignore it.
	}
	gate.set({
		lastFix: {
			gain_db: g.gain_db,
			wanted_db: g.wanted_db,
			limited: g.limited,
			elements: updates.length,
			clamped,
			at: new Date().toISOString(),
		},
	});
	const s = useGateStore.getState();
	await runGate(editor, { format: s.format, quality: s.quality, includeAudio: s.includeAudio, where: s.where });
}
