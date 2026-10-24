/**
 * MCP tool `retention` (agent retention, 2026-10-24; owner I-9a: "high retention ... viral edits"; I-8: a weaker model
 * must get it right too, so it lives in the tool):
 *
 *   map   the retention map of a render (default: the newest finished render of the head): when the picture first
 *         changes (the hook), every stretch with no visual change over 3 s, changes per 10 s (overall and per 10 s
 *         window), cuts per 10 s, % of cuts on a sound hit — measured on the encoded file, the same measurer as `check`
 *         (HOOK / DEAD) and the MVP scorer — plus the moves `fix` would place, each named ("punch-in on "eighteen" at
 *         9.40 s").
 *   fix   ONE commit by claude on the head that render shows: the open move inside the first second when the hook is
 *         late, and a move about every 2 s inside each still stretch over 3 s (not the marked end card) — punch-ins on
 *         the base picture centred on the face box, word pops of the spoken word clear of the face and the captions,
 *         an SFX on each. dry_run shows the ops without committing.
 *
 * Server: ../server/retention.ts (glue), retention-plan.ts (the moves, pure), retention-measure.ts (ffmpeg) and
 * packages/gate/src/retention.ts (the maths). Runbook: docs/restorff/worklog/retention.md.
 */
import { HttpError } from "@/server/http";
import { rendersOfCommit } from "@/server/renders";
import { freshRow, isRenderId, type RenderRow } from "@/server/renders-store";
import { getCommit, getProjectHead, listBranches } from "@/server/projects";
import type { Actor } from "@/server/auth";
import { planForSnapshot, RETENTION_FIX_PREFIX, retentionFix, retentionOfRender, retentionView, summaryLine } from "@/server/retention";
import { describeMove, type PlannedMove, type RetentionPlanOptions } from "@/server/retention-plan";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { fail, type JsonSchema, type Payload, type Tool, type ToolContext, type ToolOutput } from "./protocol";

const str = (description: string): JsonSchema => ({ type: "string", description });
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function actorOf(ctx: ToolContext): Actor {
	const kind = ctx.auth?.kind === "service" ? "service" : "local-dev";
	return { kind, id: ctx.auth?.userId ?? kind, name: ctx.auth?.name ?? "Claude (MCP)" };
}

const listTimelines = { do: "List the timelines.", tool: "timeline", arguments: { action: "list" } };

function failNext(code: string, message: string, next: Payload, extra: Record<string, unknown> = {}): ToolOutput {
	const out = fail(code, message, extra);
	(out.payload as Payload).next = next;
	return out;
}

/** render_id, else the newest finished render of the head; otherwise an answer that says what to do. */
async function renderFor(args: Record<string, unknown>): Promise<{ row: RenderRow; head: { id: string; branch: string; message: string } } | { out: ToolOutput }> {
	const renderId = text(args.render_id);
	let timelineId = text(args.timeline_id);
	let row: RenderRow | null = null;
	if (renderId) {
		if (!isRenderId(renderId)) return { out: fail("invalid_arguments", `render_id ${renderId} is not a render id (r + letters/digits).`) };
		row = freshRow(renderId);
		if (!row) return { out: failNext("not_found", `No render ${renderId} on this server.`, listTimelines) };
		if (row.status !== "done" || !row.file) {
			return { out: { payload: { render_id: renderId, status: row.status, ready: false, next: { do: "Wait for the render to finish.", tool: "render", arguments: { render_id: renderId, wait_s: 25 } } } } };
		}
		if (timelineId && timelineId !== row.project_id) return { out: fail("invalid_arguments", `render ${renderId} belongs to timeline ${row.project_id}, not ${timelineId}.`) };
		timelineId = row.project_id;
	}
	if (!timelineId) return { out: fail("invalid_arguments", "Pass timeline_id (its head's newest render is measured) or render_id.") };
	// the branch: asked, else the render's own, else the branch whose head the render shows, else the default
	let branch = text(args.branch) ?? row?.branch ?? undefined;
	if (!branch && row) branch = (await listBranches(timelineId).catch(() => null))?.branches.find((b) => b.head?.id === row?.commit)?.name;
	const head = await getProjectHead(timelineId, branch);
	const h = { id: head.head.id, branch: head.branch, message: head.head.message };
	if (!row) {
		const { done, running } = rendersOfCommit(timelineId, h.id);
		if (!done) {
			return {
				out: {
					payload: {
						timeline_id: timelineId,
						head: h.id,
						rendered: false,
						message: `No finished render of the head (${h.id.slice(0, 7)}): retention is measured on the encoded file, never guessed.`,
						next: running
							? { do: "Wait for the head's render, then measure.", tool: "render", arguments: { render_id: running.render_id, wait_s: 25 } }
							: { do: "Render the head (preview), then call retention again with its render_id.", tool: "render", arguments: { timeline_id: timelineId, ...(head.branch ? { branch: head.branch } : {}), quality: "preview" } },
					},
				},
			};
		}
		row = done;
	}
	return { row, head: h };
}

function optionsOf(args: Record<string, unknown>): RetentionPlanOptions {
	const o: RetentionPlanOptions = {};
	if (Array.isArray(args.moves)) o.moves = (args.moves as unknown[]).filter((m): m is "punch" | "word" => m === "punch" || m === "word");
	if (typeof args.spacing_s === "number" && args.spacing_s >= 1 && args.spacing_s <= 3) o.spacing_s = args.spacing_s;
	if (typeof args.punch === "number" && args.punch >= 1.05 && args.punch <= 1.4) o.punch = args.punch;
	return o;
}

const moveView = (m: PlannedMove) => ({
	what: describeMove(m),
	kind: m.kind,
	t: m.t,
	...(m.word ? { word: m.word.text.trim().replace(/[.,;:!?"]+$/u, "") } : {}),
	element_id: m.element_id,
	on: m.element_name,
	for: m.for === "hook" ? "hook" : `still ${m.stretch[0]}–${m.stretch[1]} s`,
	...(m.until !== undefined ? { until: m.until } : {}),
});

export const RETENTION_TOOL: Tool = {
	name: "retention",
	title: "Retention: hook + dead stretches",
	description:
		"Keeps viewers watching. map = the retention map of a render (default: the head's newest finished render), measured on the encoded file: hook (first visual change; bar: within 1.0 s), every still stretch over 3.0 s with what would break it (\"punch-in on \\\"eighteen\\\" at 9.40 s\"), visual changes per 10 s (overall + per 10 s window), cuts per 10 s, % of cuts on a sound hit. fix = ONE commit on the head that render shows: an open move inside the first second when the hook is late, and a move about every 2 s inside each still stretch over 3 s (a marked end card stays still): punch-ins (a held scale step on the picture, face kept in place when there is a face box), word pops of the spoken word (clear of the face and captions) on footage, an SFX on each. Then render a preview and check: HOOK and DEAD findings go when the picture changes. dry_run shows the ops. moves: [\"punch\"] or [\"word\"] to allow only those. check and look already show this map; call fix when they say so.",
	inputSchema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["map", "fix"], description: "map (read) or fix (one commit)." },
			timeline_id: str("The timeline (its head's newest finished render is used when render_id is not given)."),
			render_id: str("The render to measure (fix: it must show the head)."),
			branch: str("Branch whose head to use (default: the project's default branch)."),
			base_commit: str("fix: the head you expect (refused if the timeline moved)."),
			moves: { type: "array", items: { type: "string", enum: ["punch", "word"] }, description: "fix: limit the moves to these kinds (default auto: punches on motion graphics, punches + word pops on footage)." },
			spacing_s: { type: "number", minimum: 1, maximum: 3, description: "fix: seconds between moves inside a still stretch (default 2.0)." },
			punch: { type: "number", minimum: 1.05, maximum: 1.4, description: "fix: punch-in scale factor (default 1.15)." },
			dry_run: { type: "boolean", description: "fix: show the moves and ops, commit nothing." },
			message: str("fix: the commit message (default: \"retention fix: …\")."),
		},
		required: ["action"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	budgetSeconds: 120,
	async run(args, ctx) {
		const action = text(args.action);
		if (action !== "map" && action !== "fix") return fail("invalid_arguments", "action is map or fix.");
		let resolved: Awaited<ReturnType<typeof renderFor>>;
		try {
			resolved = await renderFor(args);
		} catch (error) {
			if (error instanceof HttpError && error.status === 404) return failNext("not_found", error.message, listTimelines);
			throw error;
		}
		if ("out" in resolved) return resolved.out;
		const { row, head } = resolved;
		const timelineId = row.project_id;
		const options = optionsOf(args);

		if (action === "map") {
			const { map, ms, cached } = await retentionOfRender(row, ctx.signal);
			const snapshot = (await getCommit(timelineId, row.commit, { snapshot: true })).snapshot as ProjectSnapshot | null;
			const planned = snapshot ? await planForSnapshot(timelineId, snapshot, map, options).catch(() => null) : null;
			const isHead = row.commit === head.id;
			const headIsFix = head.message?.startsWith(RETENTION_FIX_PREFIX) ?? false;
			const view = retentionView(map, { timelineId, renderId: row.render_id, commit: row.commit, head: head.id, plan: planned?.plan ?? null, headIsFix });
			const failing = "fix" in view;
			return {
				payload: {
					retention: view,
					...(planned ? { would_place: planned.plan.moves.map(moveView), skipped: planned.plan.skipped, words_from: planned.words_source, ...(planned.end_card ? { end_card: planned.end_card } : {}) } : {}),
					events: map.events,
					measured: { ms, cached },
					is_head: isHead,
					next: !isHead
						? { do: "This render is not the head: render the head and measure that.", tool: "render", arguments: { timeline_id: timelineId, quality: "preview" } }
						: failing
							? { do: `Place the moves in one commit (${planned ? summaryLine(planned.plan) : "hook + still stretches"}), then render a preview and check.`, ...(view as { fix: { tool: string; arguments: Record<string, unknown> } }).fix }
							: { do: "Retention passes (hook within 1 s, no still stretch over 3 s). Check the render for the rest.", tool: "check", arguments: { render_id: row.render_id } },
				},
			};
		}

		// fix
		const answer = await retentionFix(
			{ timelineId, branch: text(args.branch) ?? head.branch, baseCommit: text(args.base_commit), render: row, options, message: text(args.message), dryRun: args.dry_run === true, signal: ctx.signal },
			actorOf(ctx),
		);
		if (!answer.ok) {
			return failNext(
				answer.code,
				answer.message,
				answer.code === "stale_render" || answer.code === "conflict"
					? { do: "Render the head (preview), wait for it, then retention fix with that render_id.", tool: "render", arguments: { timeline_id: timelineId, quality: "preview" } }
					: { do: "Read the timeline, then place a move by hand (timeline_ops keyframe / text_pop, or effects apply on a word).", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } },
				answer.extra ?? {},
			);
		}
		const placed = answer.plan.moves.map(moveView);
		if (!answer.ops.length) {
			return {
				payload: {
					placed: 0,
					message: "Nothing to place: the hook is in the first second and no still stretch is over 3 s (or each one is the end card / has no picture to move).",
					retention: retentionView(answer.map, { timelineId, renderId: row.render_id, commit: row.commit, head: head.id, plan: answer.plan }),
					skipped: answer.plan.skipped,
					next: { do: "Check the render.", tool: "check", arguments: { render_id: row.render_id } },
				},
			};
		}
		return {
			payload: {
				...(answer.commit_id ? { commit_id: answer.commit_id } : {}),
				dry_run: answer.dry_run,
				branch: answer.branch,
				message: answer.message,
				placed: placed.filter((m) => m.kind !== "punch_out").length,
				moves: placed,
				skipped: answer.plan.skipped,
				predicted: { ...answer.plan.predicted, note: "each move is one visual change on the timeline; the render's measure decides (render → check)" },
				before: { first_change_s: answer.map.first_change_s, longest_still_s: answer.map.longest?.dur ?? null, still_over_3s: answer.map.over_bar.length, events_per_10s: answer.map.events_per_10s },
				words_from: answer.words_source,
				...(answer.end_card ? { end_card: answer.end_card } : {}),
				...(answer.notes.length ? { notes: answer.notes } : {}),
				...(answer.dry_run ? { ops: answer.ops, changes: answer.changes } : { ops_count: answer.ops.length }),
				undo: "history lists this commit; revert by committing its parent's state, or remove the moves with timeline_ops (delete the text pops / SFX, keyframe scale back)",
				next: answer.dry_run
					? { do: "Looks right: commit it (same call without dry_run).", tool: "retention", arguments: { action: "fix", timeline_id: timelineId, render_id: row.render_id } }
					: { do: "Render the fixed head (preview), then check it: HOOK and DEAD should be gone.", tool: "render", arguments: { timeline_id: timelineId, commit: answer.commit_id, quality: "preview", ...(answer.branch ? { branch: answer.branch } : {}) } },
			},
		};
	},
};

export const RETENTION_INSTRUCTIONS =
	"Retention is checked on every render: check and look answer a retention map (the hook = first visual change, bar 1.0 s; every still stretch over 3.0 s, each with the move that breaks it). When it fails, retention {action: \"fix\", timeline_id, render_id} places the open move and the pattern interrupts (punch-ins, word pops, SFX) in ONE commit; then render a preview and check again. retention {action: \"map\"} measures any render.";
