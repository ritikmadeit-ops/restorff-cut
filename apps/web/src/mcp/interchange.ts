/**
 * MCP tools `export` and `import_cuts` (interchange agent, 2026-10-20; EDT-19, reel DePNgrmToh9: "it doesn't just give
 * you a video file, it builds a full timeline you can edit").
 *
 *   export        a timeline commit → FCPXML 1.10 or OTIO; returns a download URL (route
 *                 /api/interchange/<id>/<commit>.<ext>, same commit = same bytes), its size, the tracks and clips it
 *                 holds and what the format cannot say
 *   import_cuts   an OTIO (from export, after another editor changed the cut) → split / trim / move / delete ops on a
 *                 timeline with the same media → one commit by Claude; the cut lands on the same frames (±1)
 *
 * Converters: server/interchange-{timeline,fcpxml,otio,cuts}.ts (pure). Runbook: docs/restorff/worklog/interchange.md.
 */
import { apply, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import type { Actor } from "@/server/auth";
import { HttpError } from "@/server/http";
import { buildExport, INTERCHANGE_FORMATS, type InterchangeFormat, mediaNamesOf } from "@/server/interchange";
import { type ApplyFn, planImportCuts } from "@/server/interchange-cuts";
import { getCommit, getProjectHead, listCommits, pushCommit } from "@/server/projects";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { fail, type JsonSchema, type Payload, type Tool, type ToolContext, type ToolOutput } from "./protocol";

const str = (description: string): JsonSchema => ({ type: "string", description });

function need(args: Record<string, unknown>, key: string, why: string): string {
	const value = args[key];
	if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} is required ${why}`);
	return value.trim();
}

function actorOf(ctx: ToolContext): Actor {
	const kind = ctx.auth?.kind === "service" ? "service" : "local-dev";
	return { kind, id: ctx.auth?.userId ?? kind, name: ctx.auth?.name ?? "Claude (MCP)" };
}

/** The origin a client can fetch from: RESTORFFCUT_PUBLIC_URL, else the request's own. */
function originOf(ctx: ToolContext): string {
	const configured = process.env.RESTORFFCUT_PUBLIC_URL?.replace(/\/+$/, "");
	if (configured) return configured;
	try {
		return new URL(ctx.request.url).origin;
	} catch {
		return "http://localhost:8791";
	}
}

const summaryNext = (id: string, what: string) => ({ do: what, tool: "timeline", arguments: { action: "summary", timeline_id: id } });

const applyFn: ApplyFn = (project, ops, options) => apply(project as OpsProject, ops as Op[], options) as unknown as ReturnType<ApplyFn>;

// ─── export ───────────────────────────────────────────────────────────────────────────────────────────────────

async function runExport(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "");
	const format = args.format as InterchangeFormat;
	if (!INTERCHANGE_FORMATS.includes(format)) return fail("invalid_arguments", `format must be ${INTERCHANGE_FORMATS.join(" or ")}.`);
	const origin = originOf(ctx);
	const result = await buildExport({
		projectId: timelineId,
		commit: typeof args.commit === "string" && args.commit.trim() ? args.commit.trim() : undefined,
		branch: typeof args.branch === "string" && args.branch ? args.branch : undefined,
		format,
		origin,
		mediaRoot: typeof args.media_root === "string" && args.media_root.trim() ? args.media_root.trim() : undefined,
	});
	const { summary } = result;
	return {
		payload: {
			timeline_id: timelineId,
			format,
			format_version: summary.format_version,
			url: `${origin}${result.path}`,
			path: result.path,
			file_name: result.fileName,
			bytes: result.bytes,
			content_type: result.contentType,
			commit: result.commit,
			download:
				"GET the url with the same auth as this MCP endpoint (Authorization: Bearer <RESTORFFCUT_SERVICE_TOKEN>; none in local dev). Media in the file point at this server unless media_root was given: download each media url into one folder and relink by file name.",
			fps: summary.fps,
			frame_duration: summary.frame_duration,
			duration_s: summary.duration_s,
			duration_frames: summary.duration_frames,
			tracks: summary.tracks,
			counts: summary.counts,
			media: summary.media.slice(0, 40),
			...(summary.media.length > 40 ? { media_truncated: summary.media.length } : {}),
			rounded_to_frames: summary.rounded_to_frames,
			not_expressed: summary.not_expressed,
			next:
				format === "otio"
					? {
							do: "Hand the file to the other editor. When it comes back with a changed cut, send its OTIO here and the cut points return as one commit.",
							tool: "import_cuts",
							arguments: { timeline_id: timelineId, otio: "…the edited .otio JSON…", dry_run: true },
						}
					: { do: "Teams on Resolve / Premiere / Avid can also take OTIO; it is the format import_cuts reads back.", tool: "export", arguments: { timeline_id: timelineId, format: "otio", commit: result.commit.id } },
		},
	};
}

export const EXPORT_TOOL: Tool = {
	name: "export",
	title: "Export an editable timeline (FCPXML / OTIO)",
	description:
		"Exports a timeline commit as an editable timeline another editor opens: fcpxml = FCPXML 1.10 (Final Cut Pro; DaVinci Resolve imports it), otio = OpenTimelineIO JSON (Resolve, and any OTIO-aware tool). Returns a download URL served by this server (the same commit always gives the same bytes), the file size, its tracks and clips, and not_expressed: what the format cannot say (compositions become their rendered alpha video plus a note; grade, effects, keyframes, masks are listed). Every cut is on the project's frame grid; media point at this server's files unless media_root (a folder on the editor's machine) is given. import_cuts brings an edited OTIO's cut points back.",
	inputSchema: {
		type: "object",
		properties: {
			timeline_id: str("The timeline (project id from timeline list)."),
			format: { type: "string", enum: ["fcpxml", "otio"], description: "fcpxml (Final Cut Pro, Resolve) or otio (OpenTimelineIO)." },
			commit: str("A commit id or unique prefix (from timeline summary / history). Default: the head of the branch."),
			branch: str("Branch for the head (default: the project's default branch)."),
			media_root: str("Optional folder on the receiving editor's machine (e.g. /Users/ana/Halcyon/media or D:/Halcyon/media): media become file:// paths into it, by the file names the result lists."),
		},
		required: ["timeline_id", "format"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: true, openWorldHint: false },
	async run(args, ctx) {
		return runExport(args, ctx);
	},
};

// ─── import_cuts ──────────────────────────────────────────────────────────────────────────────────────────────

const REMOVE_MODES = ["exported", "all", "none"] as const;

async function runImportCuts(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = need(args, "timeline_id", "");
	let otio: unknown = args.otio;
	if (typeof otio === "string") {
		try {
			otio = JSON.parse(otio);
		} catch (error) {
			return fail("invalid_otio", `otio is not JSON: ${(error as Error).message}`);
		}
	}
	const removeMissing = (REMOVE_MODES as readonly string[]).includes(String(args.remove_missing)) ? (args.remove_missing as (typeof REMOVE_MODES)[number]) : "exported";
	const branch = typeof args.branch === "string" && args.branch ? args.branch : undefined;
	const head = await getProjectHead(timelineId, branch);
	if (!head.snapshot) return fail("no_snapshot", "This timeline has no snapshot to edit.");
	const headId = head.head.id;
	const base = typeof args.base_commit === "string" && args.base_commit.trim() ? args.base_commit.trim() : undefined;
	if (base && base !== headId && !(base.length >= 7 && headId.startsWith(base))) {
		const since = await listCommits(timelineId, { branch: head.branch, since: base, limit: 20 }).catch(() => null);
		const out = fail("conflict", `The timeline moved on: its head is ${headId}, not ${base}. Nothing was committed.`, {
			head: headId,
			since: (since?.commits ?? []).map((commit) => ({ id: commit.id, author: commit.author, message: commit.message })),
		});
		(out.payload as Payload).next = { do: "Run it again on the head (omit base_commit, or pass the new head).", tool: "import_cuts", arguments: { timeline_id: timelineId, dry_run: true } };
		return out;
	}
	const mediaNames = await mediaNamesOf(timelineId);
	let plan: ReturnType<typeof planImportCuts>;
	try {
		plan = planImportCuts(head.snapshot, otio, { apply: applyFn, seed: `${timelineId}/${headId}/import_cuts`, removeMissing, mediaNames });
	} catch (error) {
		const out = fail("invalid_otio", (error as Error).message, { errors: (error as { errors?: string[] }).errors ?? [] });
		(out.payload as Payload).next = { do: "Send the .otio file's JSON (an OTIO Timeline.1), e.g. the one export format otio made, after the other editor saved it.", tool: "export", arguments: { timeline_id: timelineId, format: "otio" } };
		return out;
	}
	const { report } = plan;
	const common = {
		timeline_id: timelineId,
		head: headId,
		strategy: plan.strategy,
		ops_count: plan.ops.length,
		counts: report.counts,
		tracks: report.tracks,
		unmatched: report.unmatched.slice(0, 40),
		deleted: report.deleted,
		kept: report.kept.slice(0, 40),
		verify: { ...report.verify, off: report.verify.off.slice(0, 20) },
		...(report.adjusted.length ? { adjusted: report.adjusted } : {}),
		...(report.warnings.length ? { warnings: report.warnings.slice(0, 20) } : {}),
	};
	if (!plan.ok) {
		const out = fail("ops_conflict", "The timeline reducer refused the cut ops (a piece would overlap or run past its media). Nothing was committed.", {
			...common,
			conflicts: report.conflicts,
			ops: plan.ops.slice(0, 60),
		});
		(out.payload as Payload).next = summaryNext(timelineId, "Read the timeline: is it the one the OTIO came from (same media on the same tracks)?");
		return out;
	}
	if (!plan.ops.length) {
		return {
			payload: {
				...common,
				unchanged: true,
				message: "The timeline already has these cut points (±1 frame). Nothing to commit.",
				next: summaryNext(timelineId, "Read the cut."),
			},
		};
	}
	if (args.dry_run === true) {
		return {
			payload: {
				...common,
				dry_run: true,
				ops: plan.ops.slice(0, 120),
				next: { do: "Commit it: the same call without dry_run.", tool: "import_cuts", arguments: { timeline_id: timelineId, base_commit: headId, otio: "…the same OTIO…" } },
			},
		};
	}
	const message = typeof args.message === "string" && args.message.trim() ? args.message.trim() : `cut points from ${typeof (otio as { name?: unknown })?.name === "string" ? `OTIO "${(otio as { name: string }).name}"` : "OTIO"}`;
	let pushed: Awaited<ReturnType<typeof pushCommit>>;
	try {
		pushed = await pushCommit(timelineId, { base_commit: headId, branch: head.branch, author: "claude", ops: plan.ops, message }, actorOf(ctx));
	} catch (error) {
		if (error instanceof HttpError && error.status === 422) {
			const out = fail("ops_conflict", "The server's reducer refused the batch. Nothing was committed.", { ...common, conflicts: error.extra?.conflicts });
			(out.payload as Payload).next = summaryNext(timelineId, "Read the timeline summary.");
			return out;
		}
		throw error;
	}
	if (!pushed.ok) {
		const out = fail("conflict", "The timeline moved while committing. Nothing was committed.", { head: pushed.conflict.head.id });
		(out.payload as Payload).next = { do: "Run it again on the new head.", tool: "import_cuts", arguments: { timeline_id: timelineId, dry_run: true } };
		return out;
	}
	// check the commit the server made (its own reducer run): the same OTIO must now need no ops
	const committed = await getCommit(timelineId, pushed.commit.id, { snapshot: true });
	let remaining: number | null = null;
	try {
		remaining = committed.snapshot
			? planImportCuts(committed.snapshot as ProjectSnapshot, otio, { apply: applyFn, seed: `${timelineId}/${pushed.commit.id}/check`, removeMissing, mediaNames }).ops.length
			: null;
	} catch {
		remaining = null;
	}
	return {
		payload: {
			...common,
			commit_id: pushed.commit.id,
			branch: pushed.branch,
			message: pushed.commit.message,
			stats: pushed.commit.stats,
			ops: plan.ops.slice(0, 60),
			post_check: { ops_still_needed: remaining, ok: remaining === 0 },
			editor: "The editor pulls this commit within ~15 s (or on focus) and shows it as \"Claude: <message>\".",
			next: { do: "Export the new cut (or read it) to check it.", tool: "export", arguments: { timeline_id: timelineId, format: "otio", commit: pushed.commit.id } },
		},
	};
}

export const IMPORT_CUTS_TOOL: Tool = {
	name: "import_cuts",
	title: "Bring cut points back from OTIO",
	description:
		"Reads an OTIO timeline (made by export, then changed in another editor) and re-applies its cut points to a RestorffCut timeline that plays the same media: split / trim / move / delete ops in one commit by Claude, so every clip lands on the same frames (±1). Clips are matched by RestorffCut's ids in the OTIO metadata, else by media file on the track of the same name (titles by their words). New clips, effects and styling are not imported — they are listed in unmatched. remove_missing: exported (default: delete only clips the export listed and the other editor removed) · all · none. dry_run returns the ops and the frame check without committing.",
	inputSchema: {
		type: "object",
		properties: {
			timeline_id: str("The timeline to apply the cuts to (it must use the same media as the OTIO)."),
			otio: { type: ["object", "string"], description: "The .otio file's content: the JSON object, or its text." },
			base_commit: str("Optional: the head you read; if the timeline moved on, nothing is committed (conflict)."),
			branch: str("Branch (default: the project's default branch)."),
			remove_missing: { type: "string", enum: ["exported", "all", "none"], description: "Which unmatched clips to delete (default exported)." },
			dry_run: { type: "boolean", description: "Plan and check without committing." },
			message: str("The commit message (default: cut points from OTIO \"<name>\")."),
		},
		required: ["timeline_id", "otio"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
	budgetSeconds: 60,
	async run(args, ctx) {
		return runImportCuts(args, ctx);
	},
};

/** Both tools: one entry in tools.ts (`...INTERCHANGE_TOOLS`). */
export const INTERCHANGE_TOOLS: Tool[] = [EXPORT_TOOL, IMPORT_CUTS_TOOL];

/** The line the server's instructions get. */
export const INTERCHANGE_INSTRUCTIONS =
	"The timeline is the deliverable: export (format fcpxml or otio) hands an editable multi-track timeline to teams on Final Cut / Resolve / other editors; import_cuts brings an edited OTIO's cut points back as one commit.";
