/**
 * RestorffCut's standalone MCP tools (plan/06-mcp.md §4): `timeline`, `timeline_ops`, `render`, `look` with the same
 * names and schemas as Restorff's gateway, plus `styles` and `media`. Writes go through the port agent's project
 * store (`@/server/projects` pushCommit: base_commit → commit, or a conflict), so the editor pulls Claude's commit
 * like any other ("Claude: <message>" in the command bar, the commit line in the header).
 *
 * Every result ends with `next` (decorate in ./handler.ts). Runbook + example calls: docs/restorff/worklog/bridge.md.
 */
import {
	apply,
	validateOps,
	type ApplyChanges,
	type Op,
	type Project as OpsProject,
} from "@restorffcut/timeline-ops";
import type { Actor } from "@/server/auth";
import { createComment, listComments } from "@/server/comments";
import { HttpError } from "@/server/http";
import { getProjectHead, listCommits, listProjects, pushCommit } from "@/server/projects";
import { COMPOSITION_INSTRUCTIONS, COMPOSITION_TOOL } from "./composition";
import { CHECK_TOOL, LOOK_TOOL, RENDER_INSTRUCTIONS, RENDER_TOOL } from "./render-tool";
import { AUTOCUT_TOOL, CAPTIONS_TOOL, CUT_INSTRUCTIONS, TRANSCRIBE_TOOL } from "./cut";
import { EFFECTS_INSTRUCTIONS, EFFECTS_TOOL } from "./effects";
import { CUTOUT_INSTRUCTIONS, CUTOUT_TOOL } from "./cutout";
import { HISTORY_TOOL, REVIEW_INSTRUCTIONS, REVISE_TOOL, STORYBOARD_TOOL, STYLES_TOOL } from "./review";
import { createTimeline, MEDIA_INSTRUCTIONS, MEDIA_TOOL, shareTimeline, SOUNDS_TOOL } from "./media-tool";
import { REFERENCES_INSTRUCTIONS, REFERENCES_TOOL } from "./references";
import { INTERCHANGE_INSTRUCTIONS, INTERCHANGE_TOOLS } from "./interchange";
import { AUDIO_INSTRUCTIONS, MUSIC_TOOL, VOICEOVER_TOOL } from "./audio";
import { fail, type JsonSchema, type Tool, type ToolContext, type ToolOutput } from "./protocol";
import { slimSnapshot } from "./summary";
// mcp-discover (wave 5, 2026-10-20; SUMMARY gap 1): the op reference + paged reads with exact seconds
import { explainInvalidOps, opsItemSchema, referencePayload } from "./ops-reference";
import { elementView, PAGE_LIMIT_CHARS, pageView, type ReadFilter, resolveTrackNames, similarIds, SUMMARY_UNITS, summaryView } from "@/server/timeline-read";
import { scrubData } from "@/server/timeline-read-hygiene";
// timing-helper (2026-10-21): the plan tool (scenes · effects · trim from the words) + the compact summary default
import { PLAN_INSTRUCTIONS, PLAN_TOOL } from "./plan";
import { compactSummaryView } from "@/server/timeline-read-compact";
// retention (2026-10-24): the hook + dead-stretch map and the one-commit fix
import { RETENTION_INSTRUCTIONS, RETENTION_TOOL } from "./retention";
// director (2026-10-24, wave 7): techniques per beat for retention — plan · apply (one commit) · fill · techniques
import { DIRECTOR_INSTRUCTIONS, DIRECTOR_TOOL } from "./director";
// hf-skills (2026-10-24, wave 7): the craft playbooks (packages/compositions/knowledge), one topic per call
import { GUIDE_INSTRUCTIONS, GUIDE_TOOL } from "./guide";

// ─── schema helpers (the gateway's, tools.mjs) ────────────────────────────────────────────────────────────────

const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string): JsonSchema => ({ type: "number", description });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const oneOf = (values: string[], description?: string): JsonSchema => ({ type: "string", enum: values, ...(description ? { description } : {}) });
const list = (items: JsonSchema, description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: "array", items, description, ...extra });
const schema = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

function notBuilt(tool: string, why: string, next: Record<string, unknown>): ToolOutput {
	return { payload: { status: "not_built", tool, message: why, next } };
}

function actorOf(ctx: ToolContext): Actor {
	const kind = ctx.auth?.kind === "service" ? "service" : "local-dev";
	return { kind, id: ctx.auth?.userId ?? kind, name: ctx.auth?.name ?? "Claude (MCP)" };
}

function need(args: Record<string, unknown>, key: string, why: string): string {
	const value = args[key];
	if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} is required ${why}`);
	return value.trim();
}

const summaryNext = (id: string, what = "Read the timeline summary (element ids, times) before editing.") => ({
	do: what,
	tool: "timeline",
	arguments: { action: "summary", timeline_id: id },
});

function withAuthor(ops: unknown[]): unknown[] {
	return ops.map((op) => (op && typeof op === "object" && !("author" in op) ? { ...(op as object), author: "claude" } : op));
}

function changeReport(changes: ApplyChanges | undefined) {
	if (!changes) return {};
	return {
		applied: changes.ops.filter((change) => change.status === "applied").length,
		ops: changes.ops.slice(0, 60).map((change) => ({ index: change.index, op: change.op, status: change.status, summary: change.summary })),
		pending: changes.unsupported.map((record) => ({ op: record.op, honoured_by: record.honouredBy, reason: record.reason })),
		refs: changes.refs,
		...(changes.warnings?.length ? { warnings: changes.warnings } : {}),
	};
}

const readFilter = (args: Record<string, unknown>): ReadFilter => ({
	...(typeof args.track === "string" && args.track.trim() ? { track: args.track.trim() } : {}),
	...(Array.isArray(args.element_ids) && args.element_ids.length ? { element_ids: (args.element_ids as unknown[]).filter((id): id is string => typeof id === "string") } : {}),
	...(typeof args.from_s === "number" ? { from_s: args.from_s } : {}),
	...(typeof args.to_s === "number" ? { to_s: args.to_s } : {}),
	...(typeof args.offset === "number" ? { offset: Math.max(0, Math.floor(args.offset)) } : {}),
});

const editNext = (id: string, headId: string) => ({
	do: "Edit with timeline_ops on this head: el = an element id from here, track = a track id, times in seconds exactly as printed. Add your ops and a one-line message; dry_run first. Every op's fields + an example: timeline_ops {action: \"reference\"}.",
	tool: "timeline_ops",
	arguments: { timeline_id: id, base_commit: headId, dry_run: true },
});

/** validate → (head check) → reducer on the server → commit as Claude. Shared by timeline_ops and styles apply. */
async function commitOps(
	ctx: ToolContext,
	{ timelineId, baseCommit, ops, message, branch, dryRun }: { timelineId: string; baseCommit: string; ops: unknown[]; message: string; branch?: string; dryRun?: boolean },
): Promise<ToolOutput> {
	let filled = withAuthor(ops);
	const valid = validateOps(filled);
	if (!valid.ok) {
		// mcp-discover: name the allowed + required fields and the likely right one; next = the reference, never a repo file
		const explained = explainInvalidOps(filled, valid.errors);
		const out = fail("invalid_ops", explained.message, { errors: explained.errors, fields: explained.fields });
		(out.payload as Record<string, unknown>).next = explained.next;
		return out;
	}
	const head = await getProjectHead(timelineId, branch);
	const headId = head.head.id;
	// mcp-discover: a track named instead of its id ("MUSIC", "V2 B-ROLL", "V1") resolves when exactly one matches
	const named = head.snapshot ? resolveTrackNames(head.snapshot, filled) : { ops: filled, resolved: [] };
	filled = named.ops;
	const resolvedNote = named.resolved.length ? { track_names_resolved: named.resolved } : {};
	if (baseCommit !== headId && !(baseCommit.length >= 7 && headId.startsWith(baseCommit))) {
		const since = await listCommits(timelineId, { branch: head.branch, since: baseCommit, limit: 20 }).catch(() => null);
		const out = fail("conflict", `The timeline moved on: its head is ${headId}, not ${baseCommit}. Nothing was committed.`, {
			head: headId,
			since: (since?.commits ?? []).map((commit) => ({ id: commit.id, author: commit.author, message: commit.message })),
		});
		(out.payload as Record<string, unknown>).next = summaryNext(timelineId, "Read the timeline again and rebase your ops on its head.");
		return out;
	}
	if (dryRun) {
		const result = apply(head.snapshot as unknown as OpsProject, filled as Op[], { seed: `${timelineId}/${headId}/dry-run`, mode: "atomic" });
		const opsSmall = JSON.stringify(ops).length <= 4_000;
		return {
			payload: {
				dry_run: true,
				ok: result.ok,
				conflicts: result.conflicts.slice(0, 20),
				...changeReport(result.changes),
				...resolvedNote,
				next: result.ok
					? {
							do: "Looks good: commit it — the same call without dry_run (same ops, same message).",
							tool: "timeline_ops",
							arguments: { timeline_id: timelineId, base_commit: headId, ...(opsSmall ? { ops } : {}), message },
						}
					: summaryNext(timelineId, "Read the summary (exact times, to the tick) and fix the op the conflict names; times that touch must be equal, not rounded."),
			},
			isError: !result.ok,
		};
	}
	try {
		const pushed = await pushCommit(timelineId, { base_commit: headId, branch: head.branch, author: "claude", ops: filled, message }, actorOf(ctx));
		if (!pushed.ok) {
			const out = fail("conflict", "The timeline moved while committing. Nothing was committed.", {
				head: pushed.conflict.head.id,
				since: pushed.conflict.since.map((commit) => ({ id: commit.id, author: commit.author, message: commit.message })),
			});
			(out.payload as Record<string, unknown>).next = summaryNext(timelineId, "Rebase on the new head.");
			return out;
		}
		return {
			payload: {
				commit_id: pushed.commit.id,
				branch: pushed.branch,
				message: pushed.commit.message,
				stats: pushed.commit.stats,
				...changeReport(pushed.changes as ApplyChanges | undefined),
				...resolvedNote,
				editor: "The editor pulls this commit within ~15 s (or on focus) and shows it as \"Claude: <message>\" with a before/after.",
				next: summaryNext(timelineId, "Read the summary to check the change (it is the new head); render → look to see it."),
			},
		};
	} catch (error) {
		if (error instanceof HttpError && error.status === 422) {
			const out = fail("ops_conflict", "The reducer refused the batch (an op targets something missing, overlaps, or is out of range). Nothing was committed.", {
				conflicts: Array.isArray(error.extra?.conflicts) ? (error.extra?.conflicts as unknown[]).slice(0, 20) : error.extra?.conflicts,
			});
			(out.payload as Record<string, unknown>).next = summaryNext(timelineId, "Read the timeline summary for real element ids and times.");
			return out;
		}
		throw error;
	}
}

// ─── tools ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const TOOLS: Tool[] = [
	{
		name: "timeline",
		title: "Timelines",
		description:
			"List your RestorffCut timelines (projects: only the ones your org / account made), create a new one (create {name, aspect: 9:16 | 4:5 | 1:1 | 16:9, fps}: empty, with the lanes TEXT · CAPTIONS · V2 B-ROLL · V1 A-ROLL · MUSIC · SFX), read one, read and add review comments, or share it (share {timeline_id, can_comment?, expires_in?}: a review link for a person + the editor link). Reading: summary = tracks top to bottom, every element's id, exact times in seconds (t, dur, end — use them as printed), transform and keyframe counts (over 20,000 chars it answers compact: every track's count, span and first 5 elements — track: <id or name> or full: true for every element); element {element_id} = one element in full (params, transform, keyframes in seconds, neighbours, op templates with its numbers); get = full elements, in pages under the size cap (narrow with track, from_s + to_s or element_ids; page on with offset = page.next_offset). A timeline's id is its project id; edit it with timeline_ops on its head commit.",
		inputSchema: schema({
			action: oneOf(["list", "create", "get", "summary", "element", "comments", "comment", "compile", "share"]),
			// mcp-discover (2026-10-20): reading in pages + one element
			element_id: str("For element: the element to read in full (an id from summary)."),
			track: str("For get / summary: only this track (its id, or a name like \"CAPTIONS\", \"V1\", \"MUSIC\")."),
			element_ids: list({ type: "string" }, "For get: only these elements (ids from summary)."),
			from_s: num("For get / summary: only elements overlapping from_s…to_s (timeline seconds)."),
			to_s: num("For get / summary: see from_s."),
			offset: { type: "integer", minimum: 0, description: "For get / summary: where the page starts (the previous answer's page.next_offset)." },
			// timing-helper (2026-10-21): a bare summary of a big timeline is compact; full / track / offset read everything
			full: bool("For summary: every element (pages with offset when large). Without it, a big timeline's summary is compact: every track's count and span and its first 5 elements."),
			project: str("Unused here (gateway compatibility: compile builds a v0 from a Restorff board)."),
			timeline_id: str("For get, summary, comments, comment, share."),
			branch: str("Branch to read (default: the project's default branch)."),
			text: str("For comment."),
			time_s: num("For comment: where on the timeline."),
			// create + share (mcp-media agent, 2026-10-20; PARITY G01, G12): ./media-tool.ts
			name: str("For create: the timeline's name."),
			aspect: oneOf(["9:16", "4:5", "1:1", "16:9"], "For create: the canvas (default 9:16 = 1080×1920)."),
			fps: num("For create: frames per second (default 30)."),
			message: str("For create: the first commit's message."),
			can_comment: bool("For share: may the person comment (default true)."),
			expires_in: oneOf(["1h", "24h", "7d", "30d", "never"], "For share: link lifetime (default 7d)."),
			commit_id: str("For share: pin the link to this commit (default: it follows the branch head)."),
		}, ["action"]),
		annotations: WRITE,
		async run(args, ctx) {
			const action = args.action as string;
			if (action === "list") {
				const projects = await listProjects();
				return {
					payload: {
						timelines: projects.map((project) => ({ timeline_id: project.id, name: project.name, default_branch: project.default_branch, created_at: project.created_at })),
						next: projects[0]
							? summaryNext(projects[0].id)
							: // mcp-gaps-mvp (2026-10-24): the list is the caller's own (org-scoped), so a new user starts empty
								{ do: "You have no timelines yet: create one (name it after the piece).", tool: "timeline", arguments: { action: "create", name: "New reel", aspect: "9:16" } },
					},
				};
			}
			if (action === "compile") {
				return notBuilt("timeline", "compile builds a v0 from a Restorff board; standalone RestorffCut has no boards. Start a project in the editor instead.", {
					do: "List the timelines that exist.",
					tool: "timeline",
					arguments: { action: "list" },
				});
			}
			if (action === "create") return createTimeline(args, ctx);
			if (action === "share") return shareTimeline(args, ctx);
			const id = need(args, "timeline_id", `for timeline ${action}`);
			if (action === "comments") {
				const comments = await listComments(id);
				return {
					payload: {
						comments: comments.slice(0, 200).map((comment) => ({ id: comment.id, time_s: comment.time_s, author: comment.author, body: comment.body, status: comment.status, severity: comment.severity, rule_id: comment.rule_id })),
						next: summaryNext(id),
					},
				};
			}
			if (action === "comment") {
				const text = need(args, "text", "for comment");
				const added = await createComment(id, { time_s: typeof args.time_s === "number" ? args.time_s : 0, author: "claude", body: text }, { defaultAuthor: "claude" });
				return { payload: { added: { id: added.id, time_s: added.time_s }, next: summaryNext(id) } };
			}
			const head = await getProjectHead(id, typeof args.branch === "string" ? args.branch : undefined);
			const common = {
				timeline_id: id,
				branch: head.branch,
				head: head.head.id,
				head_commit: { id: head.head.id, author: head.head.author, message: head.head.message, created_at: head.head.created_at },
			};
			if (!head.snapshot) return fail("no_snapshot", `The head commit ${head.head.id} has no snapshot to read.`);
			const snapshot = head.snapshot;
			const filter = readFilter(args);
			const filterArgs = Object.fromEntries(Object.entries(filter).filter(([key]) => key !== "offset"));
			const badFilter = (problem: { code: string; message: string; candidates?: unknown[] }) => {
				const out = fail(problem.code, problem.message, { tracks: problem.candidates ?? [] });
				(out.payload as Record<string, unknown>).next = { do: "Pass a track id from this list.", tool: "timeline", arguments: { action, timeline_id: id } };
				return out;
			};
			if (action === "element") {
				const elementId = need(args, "element_id", "for timeline element");
				const view = elementView(snapshot, elementId);
				if (!view) {
					const out = fail("not_found", `No element ${elementId} on this timeline's head (${head.head.id.slice(0, 8)}).`, { similar_ids: similarIds(snapshot, elementId) });
					(out.payload as Record<string, unknown>).next = summaryNext(id, "Read the summary for the element ids that exist.");
					return out;
				}
				return {
					payload: {
						...common,
						...view,
						units: SUMMARY_UNITS,
						next: {
							do: "Edit it with timeline_ops on this head: op_templates hold its exact numbers — change the one you mean, dry_run, then commit.",
							tool: "timeline_ops",
							arguments: { timeline_id: id, base_commit: head.head.id, ops: [view.op_templates[0]], message: "what you changed, in one line", dry_run: true },
						},
					},
				};
			}
			if (action === "summary") {
				// timing-helper (2026-10-21): a bare summary over 20,000 chars answers compact (per-track first page)
				if (args.full !== true && Object.keys(filter).length === 0) {
					const compact = compactSummaryView(snapshot);
					if (compact.compact) {
						return {
							payload: {
								...common,
								summary: compact.summary,
								ops_reference: "timeline_ops {action: \"reference\"} lists every op's fields, units and an example.",
								next: editNext(id, head.head.id),
							},
						};
					}
				}
				const read = summaryView(snapshot, filter);
				if ("problem" in read && read.problem) return badFilter(read.problem);
				const more = "nextOffset" in read ? read.nextOffset : null;
				return {
					payload: {
						...common,
						summary: read.summary,
						ops_reference: "timeline_ops {action: \"reference\"} lists every op's fields, units and an example.",
						next:
							more !== null && more !== undefined
								? { do: "Read the next page of the summary.", tool: "timeline", arguments: { action: "summary", timeline_id: id, ...filterArgs, offset: more } }
								: editNext(id, head.head.id),
					},
				};
			}
			// get: the whole snapshot when it fits (as before), else full elements in pages
			const filtered = Object.keys(filter).length > 0;
			if (!filtered) {
				const slim = scrubData(slimSnapshot(snapshot)).value;
				const chars = JSON.stringify(slim).length;
				if (chars <= PAGE_LIMIT_CHARS) {
					return {
						payload: {
							...common,
							snapshot: slim,
							units: "snapshot times are editor ticks (120,000 per second; seconds = ticks / 120000). For seconds use summary, element, or get with offset: 0 (pages of elements in seconds).",
							next: editNext(id, head.head.id),
						},
					};
				}
			}
			const read = pageView(snapshot, filter);
			if ("problem" in read && read.problem) return badFilter(read.problem);
			const more = "nextOffset" in read ? read.nextOffset : null;
			return {
				payload: {
					...common,
					paged: true,
					...(!filtered ? { why_paged: `The whole snapshot is too large for one answer: it comes as pages of full elements (in seconds), track by track.` } : {}),
					...("page" in read ? read.page : {}),
					next:
						more !== null && more !== undefined
							? { do: "Read the next page.", tool: "timeline", arguments: { action: "get", timeline_id: id, ...filterArgs, offset: more } }
							: editNext(id, head.head.id),
				},
			};
		},
	},
	{
		name: "timeline_ops",
		title: "Edit a timeline",
		description:
			"Applies ops@1 operations on top of base_commit as one commit (author claude), or returns a conflict listing what changed since. base_commit is REQUIRED to apply (with timeline_id, ops, message): it is the timeline's head commit id — timeline summary (or element / get) answers it as head; after each commit the answer's commit_id is the new head; a stale one answers conflict with the new head and nothing is committed. Before your first edit read action \"reference\" ({action: \"reference\"} lists every op's fields with an example; {action: \"reference\", op: \"move\"} gives one op's types, units and ranges). Each op is an object {op: <name>, …fields}: set_canvas, add_size_variant, import_media, add_track, remove_track, reorder_tracks, insert, move, trim, split, delete, ripple_delete, set, keyframe, add_captions, set_caption_style, text_pop, transition, gain, duck, sfx, normalize, grade, apply_style, mark, beats, snap_cuts. Element ops take el = an element id (move {el, t}, trim {el, in, out}, split {el, t}, delete {el}, set {el, prop, value}, keyframe {el, prop, t, value}); track = a track id, \"main\", or an unambiguous track name; times are seconds exactly as timeline summary prints them; a ref names something new for later ops in the same batch. Errors name the allowed and required fields. grade {target: element id | track id | \"main\" | \"all\", preset?: a look (warm-morning, moody, clean, film, cool-night, punchy, paper, mono) or a nudge (warmer, cooler, brighter, darker, more-contrast, less-contrast, more-saturation, less-saturation, more-grain) or \"none\", params?: {exposure (stops, -3..3), contrast, saturation, temperature, tint, shadows, midtones, highlights, vignette (-100..100), grain, shadowTint, highlightTint, amount (0..100), shadowHue, highlightHue (0..360)}} is applied as a real GPU grade; \"all\" = a GRADE layer under the captions. dry_run: true shows what would happen without committing.",
		inputSchema: schema(
			{
				// mcp-discover (2026-10-20): the op reference over MCP; apply = the old behaviour (default)
				action: oneOf(["apply", "reference"], "apply (default): commit the ops. reference: every op's fields, types, units and an example (no other arguments needed)."),
				op: str("For reference: one op's name for its full entry, e.g. \"move\"."),
				timeline_id: str("For apply: the timeline."),
				base_commit: str("For apply (required): the commit your ops build on — `head` in a timeline summary / element / get answer, or the commit_id your last commit answered."),
				ops: list(opsItemSchema(), "For apply: ops@1 operations, one object per op keyed by \"op\".", { minItems: 1 }),
				message: str("For apply: the commit message (the person's sentence)."),
				branch: str("Branch (default: the project's default branch)."),
				dry_run: bool("Apply without committing and report what each op would do."),
			},
			[],
		),
		annotations: DESTRUCTIVE,
		async run(args, ctx) {
			if (args.action === "reference") {
				const payload = referencePayload(typeof args.op === "string" && args.op.trim() ? args.op.trim() : undefined);
				return { payload, ...(payload.error ? { isError: true } : {}) };
			}
			// required for apply (checked here since reference needs none of them)
			const missing = ["timeline_id", "base_commit", "ops", "message"].filter((key) => {
				const value = args[key];
				return value === undefined || (typeof value === "string" && !value.trim());
			});
			if (missing.length) {
				const out = fail("invalid_arguments", `Fix the arguments and call timeline_ops again: ${missing.map((key) => `"${key}"`).join(", ")} ${missing.length === 1 ? "is" : "are"} required to apply ops.`, {
					problems: missing.map((key) => `missing "${key}"`),
				});
				const timelineId = typeof args.timeline_id === "string" && args.timeline_id.trim() ? args.timeline_id.trim() : null;
				(out.payload as Record<string, unknown>).next =
					missing.includes("base_commit") && timelineId
						? summaryNext(timelineId, "Read the summary: its head is the base_commit.")
						: missing.includes("ops")
							? { do: "Read the op reference, then send ops.", tool: "timeline_ops", arguments: { action: "reference" } }
							: { do: "List the timelines, then read one's summary (its head is the base_commit).", tool: "timeline", arguments: { action: "list" } };
				return out;
			}
			return commitOps(ctx, {
				timelineId: need(args, "timeline_id", ""),
				baseCommit: need(args, "base_commit", ""),
				ops: args.ops as unknown[],
				message: need(args, "message", ""),
				branch: typeof args.branch === "string" ? args.branch : undefined,
				dryRun: args.dry_run === true,
			});
		},
	},
	// built-in editing styles + saved styles server-side: list · apply · resolve (as before) · save · delete ·
	// versions · suggest · dismiss (mcp-review agent, 2026-10-20; EDT-20): ./review.ts
	STYLES_TOOL,
	// media import (url · base64 · server path · signed upload) → probe → store → place, one commit; list; upload_url
	// (mcp-media agent, 2026-10-20; PARITY G01): ./media-tool.ts
	MEDIA_TOOL,
	// look + render: server-side renders of a commit (mcp-render agent, 2026-10-20): ./render-tool.ts
	LOOK_TOOL,
	RENDER_TOOL,
	// motion graphics written as code (motion-code agent, 2026-10-20): ./composition.ts
	COMPOSITION_TOOL,
	// the export gate on a render, findings as comments (mcp-render agent, EDT-18): ./render-tool.ts
	CHECK_TOOL,
	// talking head: transcribe → autocut → captions, server side (mcp-cut agent, 2026-10-20): ./cut.ts
	TRANSCRIBE_TOOL,
	AUTOCUT_TOOL,
	CAPTIONS_TOOL,
	// the effects library by name: list · describe · apply (mcp-effects agent, 2026-10-20; EDT-17): ./effects.ts
	EFFECTS_TOOL,
	// person matte + face boxes server side, matte presets, reframe (mcp-cutout agent, 2026-10-20; EDT-22): ./cutout.ts
	CUTOUT_TOOL,
	// one-sentence revisions, storyboard (rows · edit_row · approve), versions with change notes (mcp-review agent,
	// 2026-10-20; EDT-13/14/16/19): ./review.ts
	REVISE_TOOL,
	STORYBOARD_TOOL,
	HISTORY_TOOL,
	// the SFX pack: list · place · design (server-side "Design the sound") (mcp-media agent, 2026-10-20; PARITY G09):
	// ./media-tool.ts
	SOUNDS_TOOL,
	// reference folders → style card + contact sheets → explainer as one commit, versions with "What's new"
	// (mcp-references agent, 2026-10-20; PARITY G14, EDT-21): ./references.ts
	REFERENCES_TOOL,
	// export (FCPXML 1.10 / OTIO of a commit) + import_cuts (OTIO cut points back) (interchange agent, 2026-10-20;
	// EDT-19): ./interchange.ts
	...INTERCHANGE_TOOLS,
	// local voice-over (Windows speech, word timings → VOICE + transcript store) + generated music beds (ducked,
	// beats) (voice-music agent, 2026-10-20): ./audio.ts
	VOICEOVER_TOOL,
	MUSIC_TOOL,
	// timing from the words (scenes · effects · trim), read-only, answers the calls to send (timing-helper, 2026-10-21):
	// ./plan.ts
	PLAN_TOOL,
	// retention map (hook, still stretches over 3 s) + fix in one commit (retention, 2026-10-24): ./retention.ts
	RETENTION_TOOL,
	// which technique on which beat, for retention: plan · apply · fill · techniques (director, 2026-10-24): ./director.ts
	DIRECTOR_TOOL,
	// craft playbooks adapted from HyperFrames' skills: index · topic · section · query (hf-skills, 2026-10-24): ./guide.ts
	GUIDE_TOOL,
];

export const SERVER_INSTRUCTIONS = [
	"RestorffCut is a video editor; you edit its timelines with ops@1 and every edit is a commit the editor pulls.",
	"Start with timeline list → timeline summary (element ids, exact times in seconds, the head commit); timeline element {element_id} reads one element in full; timeline get comes in pages (offset).",
	"Edit with timeline_ops on that head; one sentence from the person = one commit, with their sentence as the message. Read timeline_ops {action: \"reference\"} once before your first edit: every op's fields with an example (el = element id, track = track id, times in seconds as summary prints them).",
	"styles resolve turns a sentence (\"tighter cut, bigger captions\", \"make it moody\") into the ops the editor would make; use it first, then add ops for anything it did not understand.",
	COMPOSITION_INSTRUCTIONS,
	RENDER_INSTRUCTIONS,
	CUT_INSTRUCTIONS,
	EFFECTS_INSTRUCTIONS,
	CUTOUT_INSTRUCTIONS,
	REVIEW_INSTRUCTIONS,
	MEDIA_INSTRUCTIONS,
	REFERENCES_INSTRUCTIONS,
	INTERCHANGE_INSTRUCTIONS,
	AUDIO_INSTRUCTIONS,
	PLAN_INSTRUCTIONS,
	RETENTION_INSTRUCTIONS,
	DIRECTOR_INSTRUCTIONS,
	GUIDE_INSTRUCTIONS,
	"Every answer ends with next: the step that comes next.",
].join(" ");
