/**
 * `render`, `look` and `check` for RestorffCut's standalone MCP (mcp-render agent, BUILD-BRIEF §5e; EDT-06, 08, 09,
 * 18). The loop a Claude runs before anything leaves (reel DeIGbZypIUb: "screenshots all the frames and fixes anything
 * that looks off before it renders"):
 *
 *   render {timeline_id, quality: "preview"} → render {render_id} (wait) → look {kind: "render", ref: render_id}
 *   → check {render_id} → fix with timeline_ops → render again … → check PASS → render {quality: "final"} → check.
 *
 * Server code: ../server/renders.ts (job folder + detached worker), renders-store.ts (rows), renders-worker.ts (pipeline
 * render + master), renders-look.ts (frames), renders-check.ts (packages/gate + comments). Every result ends with
 * `next`. Runbook: docs/restorff/worklog/mcp-render.md.
 */
import { formatTime } from "@restorffcut/gate";
import { HttpError } from "@/server/http";
import { getCommit, getProjectHead, listBranches } from "@/server/projects";
import { MediaMissingError, rendersOfCommit, startRender, waitRender } from "@/server/renders";
import { checkRender, NOT_CHECKED_HERE } from "@/server/renders-check";
import { lookClip } from "@/server/effects-look";
import { contactSheets, stills } from "@/server/renders-look";
import { freshRow, isRenderId, type RenderQuality, type RenderRow } from "@/server/renders-store";
import type { RetentionMap } from "@restorffcut/gate";
import { planForSnapshot, RETENTION_FIX_PREFIX, retentionOfRender, retentionView } from "@/server/retention";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { fail, type JsonSchema, type Payload, type Tool, type ToolContext, type ToolOutput } from "./protocol";

// ─── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────

const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: "number", description, ...extra });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const oneOf = (values: string[], description?: string): JsonSchema => ({ type: "string", enum: values, ...(description ? { description } : {}) });
const schema = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const round2 = (value: number | null | undefined) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : null);

function withNext(out: ToolOutput, next: Payload): ToolOutput {
	(out.payload as Payload).next = next;
	return out;
}

function origin(ctx: ToolContext): string {
	try {
		return new URL(ctx.request.url).origin;
	} catch {
		return "http://localhost:8791";
	}
}

/** What a caller needs to know about a render (no job internals beyond the paths). */
function view(row: RenderRow, ctx: ToolContext): Payload {
	const done = row.status === "done";
	return {
		render_id: row.render_id,
		timeline_id: row.project_id,
		commit: row.commit,
		quality: row.quality,
		status: row.status,
		phase: row.phase,
		...(row.status === "running" || row.status === "queued" ? { progress: Math.round(row.progress * 100) / 100 } : {}),
		...(done
			? {
					duration_s: row.duration_s,
					size: row.width && row.height ? `${row.width}x${row.height}` : null,
					fps: row.fps,
					codecs: [row.video_codec, row.audio_codec ?? "no audio"].filter(Boolean).join(" + "),
					bytes: row.bytes,
					loudness: row.loudness?.after
						? {
								render_lufs: round2(row.loudness.before?.integratedLufs),
								master_lufs: round2(row.loudness.after.integratedLufs),
								master_true_peak_dbtp: round2(row.loudness.after.truePeakDbtp),
								on_target: row.loudness.ok,
							}
						: { note: "no audio stream: not mastered (the gate's LOUD check will block it)" },
					seconds: {
						render: row.timings.render_ms ? round2(row.timings.render_ms / 1000) : null,
						master: row.timings.master_ms ? round2(row.timings.master_ms / 1000) : null,
						total: row.timings.total_ms ? round2(row.timings.total_ms / 1000) : null,
					},
					file: row.file,
					url: `${origin(ctx)}/api/renders/${row.render_id}/file`,
				}
			: {}),
		...(row.error ? { error: row.error, log: row.log } : {}),
		...(row.check ? { last_check: row.check } : {}),
		created_at: row.created_at,
		finished_at: row.finished_at,
	};
}

const waitNext = (row: RenderRow): Payload => ({
	do: `Rendering (${row.phase}${row.status === "running" ? `, ${Math.round(row.progress * 100)} %` : ""}): the editor's own export runs headless at ~4-5x real time, plus ~10 s to start. Wait for it.`,
	tool: "render",
	arguments: { render_id: row.render_id, wait_s: 20 },
});

const lookNext = (row: RenderRow, what = "Look at it: one contact sheet per second (7 frames each)."): Payload => ({
	do: what,
	tool: "look",
	arguments: { kind: "render", ref: row.render_id },
});

function statusNext(row: RenderRow): Payload {
	if (row.status === "queued" || row.status === "running") return waitNext(row);
	if (row.status === "failed") {
		return {
			do: `The render failed (${row.error?.slice(0, 200) ?? "see log"}). Fix the cause if it is the cut's (media, an op), then render again.`,
			tool: "render",
			arguments: { timeline_id: row.project_id, commit: row.commit, quality: row.quality, fresh: true },
		};
	}
	if (row.check?.state === "PASS" && row.quality === "final") {
		return { do: "This final passed the gate: hand the owner its url (or file). Nothing more to do.", tool: "timeline", arguments: { action: "comments", timeline_id: row.project_id } };
	}
	return lookNext(row);
}

async function headOf(timelineId: string, branch?: string) {
	const head = await getProjectHead(timelineId, branch);
	return { id: head.head.id, branch: head.branch, message: head.head.message };
}

/**
 * retention (2026-10-24): the head a render belongs to — its own branch, else the branch whose head it shows, else the
 * default branch (a render of a commit on another branch is not "behind" just because main moved).
 */
async function headOfRow(row: RenderRow) {
	if (row.branch) return headOf(row.project_id, row.branch).catch(() => null);
	const main = await headOf(row.project_id).catch(() => null);
	if (!main || main.id === row.commit) return main;
	const other = (await listBranches(row.project_id).catch(() => null))?.branches.find((b) => b.head?.id === row.commit);
	return other ? headOf(row.project_id, other.name).catch(() => main) : main;
}

/** A render id, or the newest finished render of a timeline's head; otherwise an answer that says what to do. */
async function resolveRender(
	ref: string,
	ctx: ToolContext,
	opts: { branch?: string; tool: string },
): Promise<{ row: RenderRow; head: { id: string; branch: string } | null } | { out: ToolOutput }> {
	if (isRenderId(ref)) {
		const row = freshRow(ref);
		if (!row) return { out: withNext(fail("not_found", `No render ${ref} on this server.`), { do: "List the timelines.", tool: "timeline", arguments: { action: "list" } }) };
		if (row.status !== "done") {
			return { out: { payload: { render: view(row, ctx), ready: false, next: statusNext(row) } } };
		}
		return { row, head: null };
	}
	const head = await headOf(ref, opts.branch);
	const { done, running, older } = rendersOfCommit(ref, head.id);
	if (!done) {
		return {
			out: {
				payload: {
					timeline_id: ref,
					head: head.id,
					rendered: false,
					message: `No finished render of the head (${head.id.slice(0, 7)}) yet: ${opts.tool} shows renders, never a guess.`,
					...(running ? { running: view(running, ctx) } : {}),
					...(older ? { older_render: { render_id: older.render_id, commit: older.commit, quality: older.quality, note: "an earlier commit: look at it with kind render, ref this id" } } : {}),
					next: running
						? waitNext(running)
						: { do: "Render the head first (preview), then look again.", tool: "render", arguments: { timeline_id: ref, commit: head.id, quality: "preview" } },
				},
			},
		};
	}
	return { row: done, head: { id: head.id, branch: head.branch } };
}

function notFound(error: unknown, timelineId: string | undefined): ToolOutput | null {
	if (error instanceof HttpError && error.status === 404) {
		return withNext(fail("not_found", error.message), {
			do: timelineId ? "Check the timeline id and commit: list the timelines." : "List the timelines.",
			tool: "timeline",
			arguments: { action: "list" },
		});
	}
	return null;
}

/**
 * retention (2026-10-24): the short retention map of a render for check / look — hook, still stretches over 3 s with
 * the move that breaks each, rates, and the fix call. Null when it cannot be measured (never blocks the answer).
 */
async function retentionBlock(row: RenderRow, map?: RetentionMap | null, snapshot?: ProjectSnapshot | null): Promise<Payload | null> {
	try {
		const m = map ?? (await retentionOfRender(row)).map;
		const commit = await getCommit(row.project_id, row.commit, { snapshot: !snapshot });
		const snap = snapshot ?? (commit.snapshot as ProjectSnapshot | null);
		const head = await headOfRow(row);
		const planned = snap ? await planForSnapshot(row.project_id, snap, m).catch(() => null) : null;
		return retentionView(m, {
			timelineId: row.project_id,
			renderId: row.render_id,
			commit: row.commit,
			head: head?.id ?? null,
			plan: planned?.plan ?? null,
			headIsFix: (commit.message ?? "").startsWith(RETENTION_FIX_PREFIX),
		}) as unknown as Payload;
	} catch {
		return null;
	}
}

// ─── render ────────────────────────────────────────────────────────────────────────────────────────────────────

export const RENDER_TOOL: Tool = {
	name: "render",
	title: "Render",
	description:
		"Renders a timeline commit with the editor's own export (headless Chromium, ~4-5x real time on this PC's GPU), masters it to -14 LUFS / <= -1 dBTP and stores it. It runs in the background: the first call returns render_id with status running (it does not wait). WAITING: each render {render_id} call waits AT MOST 25 s (wait_s 0-25; a larger wait_s is refused as invalid_arguments) — while render.status is running, call render {render_id, wait_s: 25} again, and repeat until it is done (a 50 s cut takes ~10-15 s to render, a final ~2 polls; then: url, file, duration, loudness). scripts/render-wait.sh does the loop. quality preview = medium bitrate, for look + check; final = high, the deliverable. commit defaults to the head. Every media file the cut plays must be in the server's media store; media_missing lists the ids that are only in a browser. The same commit + quality is not rendered twice (fresh: true forces it).",
	inputSchema: schema({
		timeline_id: str("The timeline to render (its id is the project id)."),
		commit: str("The commit (full id or a unique prefix). Default: the branch head."),
		quality: oneOf(["preview", "final"], "preview (default) for look + check; final for delivery."),
		branch: str("Branch whose head to render when commit is not given (default: the project's default branch)."),
		render_id: str("Instead of starting one: the render to report on (and wait for)."),
		wait_s: num("With render_id: wait up to this many seconds for it to finish (default 20, MAX 25 — more is refused). Still running after it: call render {render_id, wait_s: 25} again.", { minimum: 0, maximum: 25 }),
		fresh: bool("Render again even if this commit + quality was already rendered."),
		sizes: { type: "array", items: { type: "string" }, description: "Gateway compatibility: aspect ratios. Only the timeline's own canvas renders (make a size variant with the cutout tool's reframe, then render that)." },
	}),
	annotations: WRITE,
	budgetSeconds: 45,
	async run(args, ctx) {
		const renderId = text(args.render_id);
		if (renderId) {
			if (!isRenderId(renderId)) return fail("invalid_arguments", `render_id ${renderId} is not a render id (r + letters/digits).`);
			const waitS = typeof args.wait_s === "number" ? Math.min(25, Math.max(0, args.wait_s)) : 20;
			const row = await waitRender(renderId, waitS, ctx.signal);
			if (!row) return withNext(fail("not_found", `No render ${renderId} on this server.`), { do: "List the timelines.", tool: "timeline", arguments: { action: "list" } });
			return { payload: { render: view(row, ctx), next: statusNext(row) } };
		}
		const timelineId = text(args.timeline_id);
		if (!timelineId) return fail("invalid_arguments", "Pass timeline_id (to start a render) or render_id (to wait for one).");
		const quality: RenderQuality = args.quality === "final" ? "final" : "preview";
		const sizes = Array.isArray(args.sizes) ? (args.sizes as unknown[]).filter((s): s is string => typeof s === "string" && s !== "9:16") : [];
		try {
			const { row, repeated } = await startRender({
				projectId: timelineId,
				commit: text(args.commit),
				branch: text(args.branch),
				quality,
				fresh: args.fresh === true,
			});
			return {
				payload: {
					render_id: row.render_id,
					status: row.status,
					repeated,
					render: view(row, ctx),
					media: row.media.map((m) => m.id),
					...(sizes.length ? { sizes_not_built: sizes, note: "Only the timeline's own canvas renders; reframe to a size variant first." } : {}),
					next: repeated && row.status === "done" ? statusNext(row) : waitNext(row),
				},
			};
		} catch (error) {
			if (error instanceof MediaMissingError) {
				return withNext(
					fail("media_missing", error.message, { missing: error.missing, on_server: error.have }),
					{
						do: `Open the timeline in RestorffCut (/editor/${timelineId}) and let it push (Start version history, or any save): the editor uploads the media the server lacks. Or upload each file: PUT /api/projects/${timelineId}/media/<media id>. Then render again.`,
						tool: "media",
						arguments: { action: "list", timeline_id: timelineId },
					},
				);
			}
			const missing = notFound(error, timelineId);
			if (missing) return missing;
			throw error;
		}
	},
};

// ─── look ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const LOOK_TOOL: Tool = {
	name: "look",
	title: "Look at a render",
	description:
		"Frames of a render, as images (at most 12 per call). Default: contact sheets, one image per second, each tiling that second's 7 frames left to right (t0/t1 pick the seconds; the answer's next pages on). With times: one full frame per time (exact seek, 432x768 for 9:16). kind render + ref = a render_id; kind timeline + ref = a timeline id = the newest finished render of its head (none: next says render it). kind clip + timeline_id + element_id = ONE scene without a render: an applied effect (any of its elements), a composition or a clip, composited from the layers' own files on disk (the composition's render, the clip, the person cutout) at times (default 4 across it); FX shader layers, captions and grades are not drawn. Look before you check, and after every fix. The first page of a render's contact sheets also answers retention: the hook (first visual change, bar 1.0 s) and every still stretch over 3 s with the move that breaks it (retention fix places them). What to look for and how to write the fixes: guide {topic: \"qa-loop\"}.",
	inputSchema: schema(
		{
			kind: oneOf(["render", "timeline", "clip"], "render: ref is a render_id. timeline: ref is a timeline id (its head's newest render). clip: timeline_id + element_id, one scene from its own files (no render)."),
			timeline_id: str("kind clip: the timeline (ref works too)."),
			element_id: str("kind clip: an element of the scene to look at (an effect layer, a composition, a person cutout or a clip)."),
			over: oneOf(["clip", "none"], "kind clip: draw it over the clip under it (default) or alone over black."),
			ref: str("A render_id (kind render) or a timeline id (kind timeline)."),
			ids: { type: "array", items: { type: "string" }, description: "Gateway compatibility: ids[0] is used as ref." },
			t0: num("Contact sheets from this second (default 0).", { minimum: 0 }),
			t1: num("Contact sheets up to this second (default: the end, at most 12 seconds per call).", { minimum: 0 }),
			times: { type: "array", items: { type: "number" }, description: "Stills at these times (seconds), at most 12. Overrides t0/t1." },
			branch: str("kind timeline: the branch whose head to look at."),
		},
		["kind"],
	),
	annotations: READ,
	budgetSeconds: 90,
	async run(args, ctx) {
		// effects-v2 (additive): one scene from its own files, no render — server/effects-look.ts
		if (args.kind === "clip") {
			const timelineId = text(args.timeline_id) ?? text(args.ref);
			const elementId = text(args.element_id);
			if (!timelineId || !elementId) return fail("invalid_arguments", "kind clip needs timeline_id and element_id (an effect layer, a composition, a person cutout or a clip from timeline summary).");
			try {
				const times = Array.isArray(args.times) ? (args.times as unknown[]).filter((t): t is number => typeof t === "number" && Number.isFinite(t)) : undefined;
				if (times && times.length > 12) return fail("too_many_images", "At most 12 times per call.", { asked: times.length });
				return await lookClip({ timelineId, elementId, times, branch: text(args.branch), over: args.over === "none" ? "none" : "clip", signal: ctx.signal });
			} catch (error) {
				const missing = notFound(error, timelineId);
				if (missing) return missing;
				throw error;
			}
		}
		const ref = text(args.ref) ?? (Array.isArray(args.ids) ? text(args.ids[0]) : undefined);
		if (!ref) return fail("invalid_arguments", "Pass ref: a render_id (kind render) or a timeline id (kind timeline).");
		let resolved: Awaited<ReturnType<typeof resolveRender>>;
		try {
			resolved = await resolveRender(ref, ctx, { branch: text(args.branch), tool: "look" });
		} catch (error) {
			const missing = notFound(error, ref);
			if (missing) return missing;
			throw error;
		}
		if ("out" in resolved) return resolved.out;
		const { row } = resolved;
		const file = row.file as string;
		const times = Array.isArray(args.times) ? (args.times as unknown[]).filter((t): t is number => typeof t === "number" && Number.isFinite(t)) : [];
		const common = {
			render: { render_id: row.render_id, timeline_id: row.project_id, commit: row.commit, quality: row.quality, made_at: row.finished_at, duration_s: row.duration_s },
			...(resolved.head ? { is_head: true } : {}),
		};
		if (times.length) {
			if (times.length > 12) return fail("too_many_images", "At most 12 times per call.", { asked: times.length });
			const shot = await stills(file, times, { duration: row.duration_s ?? undefined, signal: ctx.signal });
			return {
				payload: {
					...common,
					frames: shot.stills.map((s, i) => ({ image: i + 1, t: s.t, at: formatTime(s.t) })),
					next: { do: "Check the render against the export gate (timeline + file checks; findings become comments).", tool: "check", arguments: { render_id: row.render_id } },
				},
				images: shot.stills.map(({ data, mimeType }) => ({ data, mimeType })),
			};
		}
		const t0 = typeof args.t0 === "number" ? args.t0 : 0;
		const t1 = typeof args.t1 === "number" ? args.t1 : null;
		if (t1 !== null && !(t1 > t0)) return fail("invalid_arguments", `t1 must be after t0 (the render is ${row.duration_s} s).`);
		const sheet = await contactSheets(file, { t0, t1, max: 12, duration: row.duration_s ?? undefined, signal: ctx.signal });
		if (!sheet.sheets.length) return fail("invalid_arguments", `No seconds in [${t0}, ${t1 ?? sheet.duration_s}) (the render is ${sheet.duration_s} s).`);
		// retention (2026-10-24): on the first page, what the frames can't show at a glance — hook and still stretches
		const retention = t0 === 0 ? await retentionBlock(row) : null;
		return {
			payload: {
				...common,
				...(retention ? { retention } : {}),
				duration_s: sheet.duration_s,
				seconds: sheet.sheets.map((s, i) => ({ image: i + 1, second: s.second, at: formatTime(s.second) })),
				how_to_read: "one image per second; it tiles that second's 7 frames left to right (~0.14 s apart)",
				next:
					sheet.next_t0 !== null
						? { do: "Look at the next seconds.", tool: "look", arguments: { kind: "render", ref: row.render_id, t0: sheet.next_t0, ...(t1 !== null ? { t1 } : {}) } }
						: { do: "Check the render against the export gate (timeline + file checks; findings become comments).", tool: "check", arguments: { render_id: row.render_id } },
			},
			images: sheet.sheets.map(({ data, mimeType }) => ({ data, mimeType })),
		};
	},
};

// ─── check ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface FindingLike {
	id: string;
	rule: string;
	severity: string;
	t: number;
	t_end: number | null;
	element_id: string | null;
	message: string;
	fix: string;
	target?: string;
	/** gate-v2: the exact call that fixes it (timeline id + head already filled by renders-check). */
	fix_call?: { tool: string; arguments: Record<string, unknown>; does?: string } | null;
}

/** Where to go for a blocking finding: the gate's exact fix call (gate-v2), else the older rules below. */
function fixNext(f: FindingLike, row: RenderRow, head: string): Payload {
	const ops = { timeline_id: row.project_id, base_commit: head };
	if (f.fix_call) {
		const call = f.fix_call;
		const then = call.tool === "look" ? { then: { tool: "timeline_ops", arguments: ops } } : {};
		return { do: `${f.rule} at ${formatTime(Math.max(0, f.t))}: ${f.message} Fix: ${call.does ?? f.fix} — then render a preview and check again.`, tool: call.tool, arguments: call.arguments, ...then };
	}
	if (f.rule === "FORMAT" && f.id === "gate-FORMAT-canvas") {
		const m = /(\d{3,5})x(\d{3,5})/.exec(f.target ?? "");
		if (m) {
			return { do: `${f.message} → ${f.fix}`, tool: "timeline_ops", arguments: { ...ops, ops: [{ op: "set_canvas", w: Number(m[1]), h: Number(m[2]) }], message: "canvas to the delivery size (gate FORMAT)" } };
		}
	}
	if (f.rule === "FORMAT" && f.id === "gate-FORMAT-fps") {
		const fps = Number(/(\d+(?:\.\d+)?) fps/.exec(f.fix)?.[1] ?? 30);
		return { do: `${f.message} → ${f.fix}`, tool: "timeline_ops", arguments: { ...ops, ops: [{ op: "set_canvas", fps }], message: "frame rate per the brief (gate FORMAT)" } };
	}
	if (f.rule === "LOUD") {
		return {
			do: `${f.message} → ${f.fix}. A silent master needs sound on the timeline (voice, music bed, SFX); otherwise normalize and render again.`,
			tool: "timeline",
			arguments: { action: "summary", timeline_id: row.project_id },
		};
	}
	const t = Math.max(0, f.t);
	const times = f.t_end !== null && f.t_end - t > 0.3 ? [t, Math.round(((t + f.t_end) / 2) * 1000) / 1000] : [t];
	return {
		do: `${f.rule} at ${formatTime(t)}: ${f.message} Look at it, then fix: ${f.fix}${f.element_id ? ` (element ${f.element_id})` : ""} — timeline_ops on base ${head.slice(0, 12)}, render a preview, check again.`,
		tool: "look",
		arguments: { kind: "render", ref: row.render_id, times },
		then: { tool: "timeline_ops", arguments: ops },
	};
}

export const CHECK_TOOL: Tool = {
	name: "check",
	title: "Check a render (export gate)",
	description:
		"The export gate on a render (EDT-18): the timeline checks on the render's commit (safe area, caption length, hook text, rhythm, music cover, sound under every shot, gaps, canvas/fps, overlays over the face, flash frames) plus the file checks on the mastered file (loudness -14 LUFS / <= -1 dBTP, black and held frames, flash frames, size/fps/codecs). The rules follow the piece type - ad, explainer, brand_film, motion_graphic, talking_head (only an ad needs an offer card; a 16:9 explainer is judged as 16:9): the owner's setting (metadata.restorff.piece) wins, else the piece argument, else it is inferred and the answer's piece says how. Rhythm counts picture changes (cuts, scenes inside compositions, effects), not clips. Answers PASS, BLOCKED (an open MUST) or INCOMPLETE (a check could not run - never a pass), with every finding, its time, its real lane (track) and fix_call: the exact call that fixes it. Findings become comments on the timeline (gone ones are marked fixed); next is the first blocker's fix_call or, on a pass, render final. Only the owner can override a MUST (in the editor, with a written reason); there is no override here. Not here (the Judge's: transcript, OCR, stems): MIX, R22, CAP, R18, FIRST, CLIP, LIP, TAIL, CLAIM. Retention (measured on the master, SHOULD): HOOK = the picture changes within 1.0 s, DEAD = no stretch over 3.0 s without a visual change (a marked end card excepted); the answer's retention block lists the hook and each still stretch with the concrete move that breaks it, and when they fail on a passing render next is retention {action: fix} (one commit). Pass render_id, or timeline_id for the newest render of its head.",
	inputSchema: schema({
		render_id: str("The render to check."),
		timeline_id: str("Or a timeline: its head's newest finished render."),
		branch: str("With timeline_id: the branch (default: the project's default branch)."),
		comments: bool("Post findings as timeline comments (default true)."),
		piece: oneOf(["ad", "explainer", "brand_film", "motion_graphic", "talking_head"], "Judge this render as this piece type (this check only; the owner's metadata.restorff.piece wins). Default: inferred, see the answer's piece."),
	}),
	annotations: WRITE,
	budgetSeconds: 180,
	async run(args, ctx) {
		const ref = text(args.render_id) ?? text(args.timeline_id);
		if (!ref) return fail("invalid_arguments", "Pass render_id, or timeline_id (its head's newest render).");
		let resolved: Awaited<ReturnType<typeof resolveRender>>;
		try {
			resolved = await resolveRender(ref, ctx, { branch: text(args.branch), tool: "check" });
		} catch (error) {
			const missing = notFound(error, ref);
			if (missing) return missing;
			throw error;
		}
		if ("out" in resolved) return resolved.out;
		const { row } = resolved;
		const piece = text(args.piece) ?? null;
		const result = await checkRender(row, { comments: args.comments !== false, piece });
		const { report, measures } = result;
		const head = resolved.head ?? (await headOfRow(row));
		const headId = head?.id ?? row.commit;
		const isHead = headId === row.commit;
		const findings = report.findings.slice(0, 40).map((f) => ({
			id: f.id,
			rule: f.rule,
			severity: f.severity,
			status: f.status,
			t: f.t,
			t_end: f.t_end,
			at: formatTime(f.t),
			// the real lane (e.g. MOTION); lane = the finding@1 lane the comments use
			track: f.track_name ?? f.track,
			...(f.track_name && f.track_name !== f.track ? { lane: f.track } : {}),
			...(f.track_id ? { track_id: f.track_id } : {}),
			element_id: f.element_id,
			message: f.message,
			fix: f.fix,
			fix_call: f.fix_call ?? null,
			...(result.comments.ids[f.id] ? { comment_id: result.comments.ids[f.id] } : {}),
		}));
		// retention (2026-10-24): the hook + still stretches, each with the move that breaks it, and the one-call fix
		const retention = result.retention ? await retentionBlock(row, result.retention, result.snapshot) : null;
		const retentionFails = Boolean(retention && "fix" in retention);
		let next: Payload;
		if (report.state === "BLOCKED") next = fixNext(report.blocking[0] as FindingLike, row, headId);
		else if (report.state === "INCOMPLETE") {
			next = {
				do: `Not every check ran (${report.not_run.map((n) => `${n.rule}: ${n.why}`).join("; ").slice(0, 400)}). Fix the cause and check again; INCOMPLETE is never a pass.`,
				tool: "check",
				arguments: { render_id: row.render_id, ...(piece ? { piece } : {}) },
			};
		} else if (!isHead) {
			next = { do: "This render passed, but the timeline moved on since: render the head and check that.", tool: "render", arguments: { timeline_id: row.project_id, quality: row.quality } };
		} else if (retentionFails && retention && "fix" in retention) {
			const r = retention as { hook: { ok: boolean; first_change_s: number | null }; longest_still_s: number | null; still_over_3s: unknown[]; fix: { tool: string; arguments: Record<string, unknown> } };
			next = {
				do: `The gate passes, but viewers will scroll: ${r.hook.ok ? "" : `the first visual change is at ${r.hook.first_change_s ?? "never"} s (bar 1.0 s); `}${r.still_over_3s.length} still stretch${r.still_over_3s.length === 1 ? "" : "es"} over 3 s (longest ${r.longest_still_s} s). One call places the open move and the pattern interrupts (see retention.still_over_3s[].next) in one commit; then render a preview and check again.`,
				tool: r.fix.tool,
				arguments: r.fix.arguments,
			};
		} else if (row.quality === "preview") {
			next = { do: "The preview passed the gate: render the final (same commit), then check it.", tool: "render", arguments: { timeline_id: row.project_id, commit: row.commit, quality: "final" } };
		} else {
			next = { do: "The final passed the gate: it is ready. Hand the owner its url.", tool: "render", arguments: { render_id: row.render_id, wait_s: 0 } };
		}
		return {
			payload: {
				state: report.state,
				render: { render_id: row.render_id, timeline_id: row.project_id, commit: row.commit, quality: row.quality, duration_s: row.duration_s },
				...(result.piece ? { piece: result.piece } : {}),
				...(report.changes ? { picture_changes: report.changes } : {}),
				is_head: isHead,
				...(isHead ? {} : { head: headId }),
				counts: report.counts,
				blocking: report.blocking.length,
				findings,
				...(report.findings.length > findings.length ? { more_findings: report.findings.length - findings.length } : {}),
				not_run: report.not_run,
				skipped: report.skipped,
				ran: report.ran,
				not_checked_here: NOT_CHECKED_HERE,
				measures: {
					integrated_lufs: round2(measures.loudness?.integrated_lufs),
					true_peak_dbtp: round2(measures.loudness?.true_peak_dbtp),
					size: measures.probe ? `${measures.probe.width}x${measures.probe.height}` : null,
					fps: round2(measures.probe?.fps),
					codecs: measures.probe ? `${measures.probe.video_codec ?? "?"} + ${measures.probe.audio_codec ?? "no audio"}` : null,
					black_spans: measures.black?.length ?? null,
					held_spans: measures.frozen?.length ?? null,
					flash_spans: measures.flashes?.length ?? null,
				},
				measured: {
					text: result.measured.text.method,
					compositions: { measured: result.measured.compositions.measured + result.measured.compositions.cached, opaque: result.measured.compositions.opaque, scenes: result.measured.compositions.scenes, failed: result.measured.compositions.failed.slice(0, 5) },
					media_with_faces: result.measured.faces.media_with_faces,
					flash: { found: result.measured.flash.found, face_regions: result.measured.flash.face_regions ?? 0, ...(result.measured.flash.error ? { error: result.measured.flash.error } : {}) },
					...(result.measured.flash.designed.length ? { designed_flashes: result.measured.flash.designed.slice(0, 5) } : {}),
				},
				...(retention ? { retention } : {}),
				...(report.applied_overrides.length ? { overrides: report.applied_overrides.map((o) => ({ rule: o.rule, reason: o.reason, by: o.by })) } : {}),
				comments: { posted: result.comments.posted, marked_fixed: result.comments.fixed, errors: result.comments.errors.slice(0, 10) },
				next,
			},
		};
	},
};

export const RENDER_INSTRUCTIONS =
	"Before anything leaves, run the self-check loop: render {timeline_id, quality: preview} → render {render_id} until done → look {kind: render, ref: render_id} (contact sheets; times for stills) → check {render_id} (export gate; findings become comments) → fix with timeline_ops → render again; when check says PASS, render quality final and check that.";
