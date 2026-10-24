/**
 * `check` (EDT-18, the self-check before export): the export gate (`@restorffcut/gate`) on a render made over MCP,
 * both halves — the timeline checks on the render's own commit snapshot, and the file checks (ffprobe, ebur128,
 * blackdetect/freezedetect via the gate agent's runner `@/gate/server/ffmpeg`) on the stored master — combined by
 * `buildReport` (BLOCKED > INCOMPLETE > PASS, the owner's D13 overrides from metadata.restorff.overrides honoured).
 * Findings become timeline comments (finding@1 → `importFindings`, upsert by finding id); gate findings from an
 * earlier check that are gone now are posted as `fixed` (`fixedSince`, the editor's own rule).
 *
 * gate-v2 (2026-10-20): the piece type (metadata.restorff.piece / brief.piece / the `piece` argument / inferred)
 * chooses the rule set; the server measures what the JSON can't say (./renders-check-media.ts): each composition's
 * own render (scenes, designed flashes, alpha coverage), overlay pictures' alpha, the person matte's face boxes, text
 * widths with the caption builder's Chromium measurer, and the master's frame changes (FLASH). Every finding's
 * `fix_call` is completed with this timeline's id and head, so it is an exact call.
 */
import path from "node:path";
import {
	buildReport,
	changeMap,
	faceOnCanvas,
	fileFindings,
	filterDesignedFlashes,
	fixedSince,
	fpsOf,
	GATE_SOURCE,
	parseDeliver,
	pickScene,
	pinFindings,
	retentionFindings,
	runtimeOf,
	runTimelineChecks,
	type CheckRun,
	type RetentionMap,
	type CompositionFacts,
	type FileMeasures,
	type Finding,
	type FixCall,
	type GateOverride,
	type GateProject,
	type GateReport,
	type MediaInfo,
	type PieceDecision,
	type TimelineCheckOptions,
} from "@restorffcut/gate";
import { measureFile } from "@/gate/server/ffmpeg";
import { resolveMediaDir } from "@/lib/db/store";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { importFindings, listComments } from "./comments";
import { listProjectMedia } from "./media";
import { getCommit, getProjectHead } from "./projects";
import { loadSet } from "./references-store";
import { compositionFacts, faceTracks, masterFlashes, mediaAlpha, speakersWithoutFaces, textMeasurer, type CompositionReport, type FaceRegion, type MediaRef } from "./renders-check-media";
import { updateRow, type RenderRow } from "./renders-store";
import { endCardOf, retentionOfRender } from "./retention";

/** EXPORT-GATE checks that need a transcript, OCR, stems or a person: the Judge's, not packages/gate's. */
export const NOT_CHECKED_HERE = ["MIX", "R22", "CAP", "R18", "FIRST", "CLIP", "LIP", "TAIL", "CLAIM"];

export interface CheckMeasured {
	text: { method: string; strings: number; ms: number; fonts?: Record<string, boolean>; error?: string };
	compositions: CompositionReport;
	faces: { media_with_faces: number; /** revise-safety: talking clips with no face box (FACE judges their captions against a presumed face) */ presumed?: number };
	flash: { frames: number; median_diff: number; found: number; face_regions?: number; designed: Array<{ t: number; why: string }>; ms: number; error?: string };
	/** retention (2026-10-24): the HOOK / DEAD measure of the master (server/retention-measure.ts). */
	retention?: { ms: number; cached: boolean; end_card?: { t: number; t_end: number; why: string }; error?: string };
}

export interface CheckResult {
	report: GateReport;
	measures: FileMeasures;
	comments: { posted: number; fixed: number; errors: Array<{ index: number; id?: string; error: string }>; ids: Record<string, string> };
	snapshot: ProjectSnapshot;
	/** The piece the rules were chosen for, and how. */
	piece: PieceDecision | null;
	/** What the server measured for the gate (gate-v2). */
	measured: CheckMeasured;
	/** The head the fix calls are based on. */
	head: string;
	/** ui-fix-render (2026-10-21): the two halves as run, so the editor can re-apply the owner's overrides (D13) to the
	 * same findings without rendering again (gate/run.ts refreshReport). */
	runs: { timeline: CheckRun; file: CheckRun };
	/** retention (2026-10-24): the measured map of the master (null when it could not be measured). */
	retention: RetentionMap | null;
}

interface RestorffMetaLike {
	overrides?: GateOverride[];
	brief?: { deliver?: unknown; fps?: number };
}

function restorffMeta(snapshot: ProjectSnapshot): RestorffMetaLike {
	return ((snapshot.metadata as unknown as { restorff?: RestorffMetaLike }).restorff ?? {}) as RestorffMetaLike;
}

function fpsOfSnapshot(snapshot: ProjectSnapshot): number {
	const fps = (snapshot.settings as unknown as { fps?: { numerator: number; denominator: number } | number }).fps;
	if (typeof fps === "number") return fps;
	return fps && fps.denominator ? fps.numerator / fps.denominator : 30;
}

/** Tools whose calls take the timeline id and the head commit (the gate leaves them out; it does not know them). */
const TAKES_TIMELINE = new Set(["timeline_ops", "sounds", "music", "captions", "cutout", "composition", "timeline", "render", "effects", "retention"]);
const TAKES_BASE = new Set(["timeline_ops", "sounds", "music", "captions", "retention"]);

/** Complete a finding's fix call: timeline id, head commit, render id for look. */
export function completeFixCall(call: FixCall | null | undefined, ctx: { timelineId: string; head: string; renderId: string }): FixCall | null {
	if (!call) return null;
	const args: Record<string, unknown> = { ...call.arguments };
	if (call.tool === "look") {
		args.kind ??= "render";
		args.ref ??= ctx.renderId;
	}
	if (TAKES_TIMELINE.has(call.tool)) args.timeline_id ??= ctx.timelineId;
	if (TAKES_BASE.has(call.tool)) args.base_commit ??= ctx.head;
	return { ...call, arguments: args };
}

export async function checkRender(row: RenderRow, opts: { comments?: boolean; piece?: string | null } = {}): Promise<CheckResult> {
	if (row.status !== "done" || !row.file) throw new Error(`render ${row.render_id} is ${row.status}, not done`);
	const commit = await getCommit(row.project_id, row.commit, { snapshot: true });
	const snapshot = commit.snapshot as ProjectSnapshot | null;
	if (!snapshot) throw new Error(`commit ${row.commit} has no snapshot`);
	const project = snapshot as unknown as GateProject;
	const scene = pickScene(project);

	// The media store's facts (durations in seconds) for CLEAN "clip shorter than its slot", and files by media id.
	const media: Record<string, MediaInfo> = {};
	const refs = new Map<string, MediaRef>();
	const mediaDir = resolveMediaDir();
	for (const m of await listProjectMedia(row.project_id)) {
		const meta = (m.meta ?? {}) as Record<string, unknown>;
		const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
		media[m.media_id] = {
			duration: n(meta.duration),
			width: n(meta.width),
			height: n(meta.height),
			fps: n(meta.fps),
			hasAudio: typeof meta.hasAudio === "boolean" ? meta.hasAudio : undefined,
		};
		refs.set(m.media_id, { media_id: m.media_id, hash: m.hash, file: path.join(mediaDir, m.hash.slice(0, 2), m.hash), mime: m.mime });
	}

	// What the JSON can't say: compositions' own renders, overlay alpha, face boxes, real text widths.
	const measured: CheckMeasured = {
		text: { method: "estimate", strings: 0, ms: 0 },
		compositions: { measured: 0, cached: 0, failed: [], opaque: 0, scenes: 0, ms: 0 },
		faces: { media_with_faces: 0 },
		flash: { frames: 0, median_diff: 0, found: 0, designed: [], ms: 0 },
	};
	let facts: Record<string, CompositionFacts> = {};
	let faces: ReturnType<typeof faceTracks> = {};
	let presumedFaces: string[] = [];
	let measureText: TimelineCheckOptions["measureText"];
	let references = false;
	if (scene) {
		const [comp, text, pictures] = await Promise.all([
			compositionFacts(scene, refs).catch((error) => ({ facts: {}, report: { ...measured.compositions, failed: [{ element_id: "*", why: String(error) }] } })),
			textMeasurer(scene, project.settings.canvasSize.height).catch(() => null),
			mediaAlpha(scene, refs, media).catch(() => ({}) as Record<string, CompositionFacts>),
		]);
		// compositions by element id; alpha pictures (PNG plates) by media id
		facts = { ...pictures, ...comp.facts };
		measured.compositions = comp.report;
		if (text) {
			measureText = text.measure;
			measured.text = { method: text.report.method, strings: text.report.strings, ms: text.report.ms, fonts: text.report.fonts, ...(text.report.error ? { error: text.report.error } : {}) };
		}
		try {
			faces = faceTracks(scene, refs);
		} catch {
			faces = {};
		}
		measured.faces.media_with_faces = Object.keys(faces).length;
		// revise-safety (2026-10-21): talking clips (a transcript with words) that have no face box yet
		try {
			presumedFaces = speakersWithoutFaces(scene, refs, faces);
		} catch {
			presumedFaces = [];
		}
		if (presumedFaces.length) measured.faces.presumed = presumedFaces.length;
	}
	try {
		const set = await loadSet(row.project_id);
		references = Boolean(set.files?.length || set.versions?.length);
	} catch {
		references = false;
	}

	let timelineRun: CheckRun;
	try {
		timelineRun = runTimelineChecks(project, {
			media,
			commit: row.commit,
			source: GATE_SOURCE,
			piece: opts.piece ?? null,
			compositions: facts,
			faces,
			...(presumedFaces.length ? { presumedFaces } : {}),
			hints: { references },
			...(measureText ? { measureText, measureMethod: `chromium (the caption builder's measurer)${measured.text.method === "estimate" ? " → estimate" : ""}` } : {}),
		});
	} catch (error) {
		timelineRun = { findings: [], ran: [], not_run: [{ rule: "TIMELINE", why: error instanceof Error ? error.message : String(error) }], skipped: [] };
	}
	const piece = timelineRun.piece ?? null;

	// File half: the canvas is the delivery unless the brief says another size.
	const brief = restorffMeta(snapshot).brief ?? {};
	const canvas = project.settings.canvasSize;
	const expect = { ...(brief.deliver ? parseDeliver(brief.deliver) : { width: canvas.width, height: canvas.height }), fps: brief.fps ?? fpsOfSnapshot(snapshot) };
	const measures = await measureFile(row.file, `${row.render_id}${path.extname(row.file) || ".mp4"}`);
	if (scene) {
		const fps = fpsOf(project) || 30;
		const map = changeMap(scene, runtimeOf(scene), { fps, beats: false, media, compositions: facts });
		const cuts = map.changes.filter((c) => c.kind !== "beat").map((c) => c.t);
		// At a cut on a clip with face boxes, the flash test also runs inside the face (a same-camera sliver).
		const regions: FaceRegion[] = [];
		for (const c of map.changes) {
			if (c.kind !== "cut" && c.kind !== "transition") continue;
			const i = map.base.findIndex((r) => r.t <= c.t + 1e-6 && c.t < r.t_end - 1e-6);
			const sides = [map.base[i - 1] ? { el: map.base[i - 1].el, t: c.t - 1 / fps } : null, map.base[i] ? { el: map.base[i].el, t: c.t + 1 / fps } : null];
			const boxes = sides
				.map((s) => (s && s.el.mediaId && faces[s.el.mediaId] ? faceOnCanvas(s.el, faces[s.el.mediaId], s.t, canvas) : null))
				.filter((b): b is [number, number, number, number] => Boolean(b));
			if (!boxes.length) continue;
			// the exact face box (both sides of the cut): padding dilutes the change below the threshold (MEASURED 22.6 vs 23.1)
			const x0 = Math.min(...boxes.map((b) => b[0]));
			const y0 = Math.min(...boxes.map((b) => b[1]));
			const x1 = Math.max(...boxes.map((b) => b[2]));
			const y1 = Math.max(...boxes.map((b) => b[3]));
			regions.push({ t: c.t, box: [Math.max(0, x0), Math.max(0, y0), Math.min(1, x1), Math.min(1, y1)] });
		}
		const flash = await masterFlashes(row.file, cuts, regions).catch((error) => ({ flashes: null, fps: 0, frames: 0, median_diff: 0, ms: 0, error: String(error) }));
		if (flash.flashes) {
			const { kept, designed } = filterDesignedFlashes(flash.flashes, project, facts);
			measures.flashes = kept;
			measured.flash = { frames: flash.frames, median_diff: flash.median_diff, found: kept.length, face_regions: regions.length, designed: designed.map((d) => ({ t: d.t, why: d.why })), ms: flash.ms };
		} else measured.flash = { ...measured.flash, ...(flash.error ? { error: flash.error } : {}) };
	}
	const file = fileFindings(measures, expect, { commit: row.commit, source: GATE_SOURCE, piece: piece?.type });
	// retention (2026-10-24): HOOK + DEAD on the master, the same measurer as the `retention` tool and the MVP scorer.
	// Merged into the file run so the editor's refreshReport (runs.file) keeps them.
	let retention: RetentionMap | null = null;
	const endCard = endCardOf(snapshot);
	try {
		const got = await retentionOfRender(row);
		retention = got.map;
		measured.retention = { ms: got.ms, cached: got.cached, ...(endCard ? { end_card: endCard } : {}) };
		measures.retention = {
			first_change_s: retention.first_change_s,
			longest_still_s: retention.longest?.dur ?? null,
			longest_at: retention.longest ? [retention.longest.t, retention.longest.t_end] : null,
			still_over_3s: retention.over_bar.length,
			events_per_10s: retention.events_per_10s,
			cuts_per_10s: retention.cuts_per_10s,
			cuts_on_hit_pct: retention.cuts_on_hit_pct,
		};
	} catch (error) {
		measured.retention = { ms: 0, cached: false, error: error instanceof Error ? error.message : String(error) };
	}
	const ret = retentionFindings(retention, { commit: row.commit, source: GATE_SOURCE, file: row.file, piece: piece?.type, endCard, fixCall: { tool: "retention", arguments: { action: "fix", render_id: row.render_id }, does: "place the open move and a pattern interrupt about every 2 s in each still stretch (punch-ins, word pops, SFX) in one commit; then render a preview and check" } });
	file.findings.push(...ret.findings);
	file.ran.push(...ret.ran);
	file.skipped.push(...ret.skipped);
	const fileRun: CheckRun = { ...file, findings: pinFindings(file.findings, project, undefined, { media, compositions: facts }) };
	const report = buildReport([timelineRun, fileRun], restorffMeta(snapshot).overrides ?? []);

	// Exact fix calls: this timeline, its head, this render.
	const head = (await getProjectHead(row.project_id).catch(() => null))?.head.id ?? row.commit;
	for (const f of report.findings) {
		f.render_id = row.render_id;
		f.fix_call = completeFixCall(f.fix_call, { timelineId: row.project_id, head, renderId: row.render_id });
	}

	const comments: CheckResult["comments"] = { posted: 0, fixed: 0, errors: [], ids: {} };
	if (opts.comments !== false) {
		// Gate findings still open from an earlier check: those gone now are posted as fixed (by the re-measure).
		const previous = (await listComments(row.project_id, { status: "open", withFinding: true }))
			.filter((c) => c.finding_id?.startsWith("gate-") && c.author.startsWith("gate:") && c.finding && typeof c.finding === "object")
			.map((c) => c.finding as Finding);
		const gone = fixedSince(previous, report.findings);
		const result = await importFindings(row.project_id, [...report.findings, ...gone], { commitId: row.commit });
		const goneIds = new Set(gone.map((g) => g.id));
		comments.fixed = result.imported.filter((c) => c.finding_id && goneIds.has(c.finding_id)).length;
		comments.posted = result.imported.length - comments.fixed;
		comments.errors = result.errors;
		for (const c of result.imported) if (c.finding_id) comments.ids[c.finding_id] = c.id;
	}

	updateRow(row.render_id, {
		check: {
			state: report.state,
			counts: report.counts,
			at: new Date().toISOString(),
			blocking: report.blocking.length,
		},
	});
	return { report, measures, comments, snapshot, piece, measured, head, runs: { timeline: timelineRun, file: fileRun }, retention };
}
