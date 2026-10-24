/**
 * MCP tools for reviewing and revising a cut the way reel DeUUFJQu8cw does it — mcp-review agent, 2026-10-20
 * (BUILD-BRIEF §5e; EDT-13, 14, 16, 19, 20); made composition-aware, span-aware and honest by the revise-v2 agent the
 * same evening (BUILD-BRIEF §5f; SUMMARY gaps 2, 3, 9):
 *
 *   revise      one sentence → ONE commit by claude with the sentence as its message: ops, compositions re-rendered
 *               with new params ("make the titles bigger" = every title composition, one commit), layered caption
 *               chunks rebuilt, spans ("make the second half moody" = the GRADE layer split + only those captions
 *               restyled). Every clause comes back in `clauses` as applied / nothing_to_change / not_understood (with
 *               what to send instead); `understood` is true only when none was dropped. A real revision is a version
 *               ("v2 aesthetic") in history.
 *   storyboard  get (rows = beats: time range, shots, the spoken line from captions / voice-over / transcript /
 *               explainer script, on-screen text, overlays, sound cue + approval) · edit_row (caption = the EXISTING
 *               chunk rewritten; title; a sentence for that row → one commit) · approve (project metadata; history
 *               says it is not a version)
 *   history     list (versions by name: "v1 cut", "v2 aesthetic"…; every commit with what changed, compositions'
 *               props before → after and source line counts; approvals and gate fixes don't count) · name · tag
 *   styles      the built-in editing styles AND the owner's saved styles (server-side now): list · apply · resolve ·
 *               save · delete · versions · suggest (repeat detection) · dismiss. Replaces the bridge's `styles`
 *               entry in tools.ts; list/apply/resolve answer as before for built-ins.
 *
 * Server code: ../server/storyboard*.ts, ../server/styles-store*.ts. Runbooks: docs/restorff/worklog/mcp-review.md,
 * docs/restorff/worklog/revise-v2.md.
 */
import {
	EDITING_STYLE_PRESETS,
	getEditingStylePreset,
	resolveSentence,
	STYLE_PRESET_PREFIX,
	type ApplyChanges,
	type Op,
	type Project as OpsProject,
} from "@restorffcut/timeline-ops";
import { listStyles, matchTrigger, planStyle, slugify, styleExpanders, USER_STYLE_PREFIX, type SavedStyle, type StyleStep } from "@restorffcut/styles";
import type { Actor } from "@/server/auth";
import { HttpError } from "@/server/http";
import { getProjectHead } from "@/server/projects";
import {
	approveStoryboard,
	commitAsClaude,
	compositionChanges,
	compositionsWithManifests,
	editStoryboardRow,
	getStoryboard,
	type CaptionRebuildRequest,
	type CommitOutcome,
	wordFixRoute,
} from "@/server/storyboard";
import { guardView, spansView } from "@/server/caption-words";
import { projectMediaRecord, startMatteJob } from "@/server/matte";
import { getCommit, pushCommit } from "@/server/projects";
import { firstPassView, parseFirstPass, runFirstPass } from "@/server/revise-first-pass";
import { stylePiecesLeftOut } from "@/server/revise-pieces";
import { foldGradeLayer, planRevision, toolCaptions, type NotUnderstood, type RevisionPlan } from "@/server/storyboard-revise";
import type { StoryboardRow } from "@/server/storyboard-rows";
import { captionFixesOf, recordCaptionFixes } from "@/server/storyboard-transcripts";
import { buildHistory, nameVersion, recordMilestone, tagCommit } from "@/server/storyboard-versions";
import {
	deleteOwnerStyle,
	dismissOwnerPattern,
	getLibrary,
	ownerSuggestions,
	recordOwnerInstruction,
	saveOwnerStyle,
	styleFromSentence,
	styleOwner,
} from "@/server/styles-store";
import { fail, type JsonSchema, type Payload, type Tool, type ToolContext, type ToolOutput } from "./protocol";

// ─── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────

const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string): JsonSchema => ({ type: "number", description });
const int = (description: string): JsonSchema => ({ type: "integer", description, minimum: 1 });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const oneOf = (values: string[], description?: string): JsonSchema => ({ type: "string", enum: values, ...(description ? { description } : {}) });
const schema = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function actorOf(ctx: ToolContext): Actor {
	const kind = ctx.auth?.kind === "service" ? "service" : "local-dev";
	return { kind, id: ctx.auth?.userId ?? kind, name: ctx.auth?.name ?? "Claude (MCP)" };
}

function need(args: Record<string, unknown>, key: string, why = ""): string {
	const value = args[key];
	if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} is required${why ? ` ${why}` : ""}`);
	return value.trim();
}

const opt = (args: Record<string, unknown>, key: string) => (typeof args[key] === "string" && (args[key] as string).trim() ? (args[key] as string).trim() : undefined);
const optNum = (args: Record<string, unknown>, key: string) => (typeof args[key] === "number" && Number.isFinite(args[key]) ? (args[key] as number) : undefined);

const summaryNext = (id: string, what = "Read the timeline summary (element ids, times).") => ({ do: what, tool: "timeline", arguments: { action: "summary", timeline_id: id } });
const storyboardNext = (id: string, what = "Read the storyboard (one row per beat) to check the change.") => ({ do: what, tool: "storyboard", arguments: { action: "get", timeline_id: id } });

function withNext(out: ToolOutput, next: Payload): ToolOutput {
	if (out.payload) out.payload.next = next;
	return out;
}

function changeReport(changes: ApplyChanges | undefined) {
	if (!changes) return {};
	return {
		applied: changes.ops.filter((change) => change.status === "applied").length,
		changes: changes.ops.slice(0, 60).map((change) => ({ index: change.index, op: change.op, status: change.status, summary: change.summary })),
		pending: changes.unsupported.map((record) => ({ op: record.op, honoured_by: record.honouredBy, reason: record.reason })),
		...(changes.warnings?.length ? { warnings: changes.warnings } : {}),
	};
}

/** A failed CommitOutcome → a tool error with the right next step. */
function outcomeFailure(id: string, outcome: Extract<CommitOutcome, { ok: false }>, retry?: { tool: string; arguments: Record<string, unknown> }): ToolOutput {
	const out = fail(outcome.code, outcome.message, {
		...(outcome.head ? { head: outcome.head } : {}),
		...(outcome.details ? { details: outcome.details } : {}),
		...(outcome.since ? { since: outcome.since } : {}),
	});
	if (outcome.code === "conflict") return withNext(out, summaryNext(id, "The timeline moved: read it again and resend on its head."));
	if (outcome.code === "stopped" && retry) return withNext(out, { do: "Send the same call again (the renders are cached now).", ...retry });
	if (outcome.code === "layered") return withNext(out, { do: "That clip is a layer of a layered effect: change it with the effects tool.", tool: "effects", arguments: { action: "list", timeline_id: id } });
	if (outcome.code === "render_refused") return withNext(out, { do: "Read the composition's params and send values inside their ranges.", tool: "composition", arguments: { action: "get", timeline_id: id, element_id: (outcome.details as { element_id?: string } | undefined)?.element_id ?? "<element id>" } });
	if (outcome.code === "words_lost") {
		const first = (outcome.details as { lost_words?: Array<{ text: string; t: number }> } | undefined)?.lost_words?.[0];
		return withNext(out, {
			do: `Nothing was committed: caption words would be lost. To change a wrong word, fix it in the transcript (the captions rebuild with it in one commit). If the person really wants those words gone, send the same call with allow_word_loss: true.`,
			tool: "transcribe",
			arguments: { timeline_id: id, action: "edit", fixes: [{ from: first?.text ?? "<the wrong word as the caption shows it>", to: "<the right word>", t: first?.t ?? 0 }], rebuild_captions: true },
		});
	}
	return withNext(out, summaryNext(id, "Read the summary for real element ids and times."));
}

/** What to call for the first clause revise did not do. */
function missNextOf(id: string, miss: NotUnderstood | undefined, sentence: string, head: string | undefined): Payload | null {
	if (!miss) return null;
	const step = miss.send.steps?.[0];
	if (step) return { do: `Not done: "${miss.clause}" — ${miss.why}. ${miss.send.how}`, tool: step.tool, arguments: step.arguments };
	return {
		do: `Not done: "${miss.clause}" — ${miss.why}. ${miss.send.how}`,
		tool: "timeline_ops",
		arguments: { timeline_id: id, base_commit: head ?? "<head after this call>", ops: miss.send.example_ops, message: sentence },
	};
}

function rowView(row: StoryboardRow) {
	return {
		row: row.row,
		range: row.range,
		start: row.start,
		end: row.end,
		dur: row.dur,
		shot: {
			role: row.shot.role,
			name: row.shot.name,
			element_id: row.shot.element_id,
			...(row.shot.track ? { track: row.shot.track } : {}),
			...(row.shot.under ? { under: row.shot.under } : {}),
		},
		...(row.shots.length > 1 ? { shots: row.shots.map((shot) => `${shot.t} s ${shot.role} ${shot.name}${shot.element_id ? ` (${shot.element_id})` : ""}`) } : {}),
		line: row.line,
		line_from: row.line_from,
		caption_ids: row.caption_ids,
		on_screen: row.on_screen,
		emphasis: row.emphasis,
		emphasis_ids: row.emphasis_ids,
		...(row.visual ? { visual: row.visual } : {}),
		overlays: row.overlays.map((overlay) => `${overlay.kind}: ${overlay.name}${overlay.element_id ? ` (${overlay.element_id})` : ""}`),
		sound_cue: row.sound_cue,
	};
}

function planView(plan: RevisionPlan) {
	return {
		preset: plan.preset,
		scope: plan.scope ? { kind: plan.scope.kind, label: plan.scope.label, start: plan.scope.start, end: plan.scope.end, beats: plan.scope.rows } : null,
		labels: plan.labels,
		understood: plan.understood,
		clauses: plan.clause_report,
		not_understood: plan.not_understood,
		notes: plan.notes,
	};
}

/** Start (or reuse) the person matte of some clips, at most 2 per call (each runs its own Chromium). Never throws. */
async function startMattes(id: string, snapshot: Parameters<typeof toolCaptions>[0] | null, clipIds: string[]) {
	const out: Array<{ element_id: string; media_id: string; job_id?: string; state?: string; started?: boolean; error?: string }> = [];
	if (!snapshot) return out;
	const scene = snapshot.scenes?.find((s) => s.id === snapshot.currentSceneId) ?? snapshot.scenes?.find((s) => s.isMain) ?? snapshot.scenes?.[0];
	const all = [scene?.tracks?.main, ...(scene?.tracks?.overlay ?? [])].flatMap((track) => track?.elements ?? []);
	const seen = new Set<string>();
	for (const clipId of clipIds) {
		const clip = all.find((element) => element.id === clipId);
		const mediaId = String(clip?.mediaId ?? "");
		if (!clip || !mediaId || seen.has(mediaId) || out.length >= 2) continue;
		seen.add(mediaId);
		try {
			const media = await projectMediaRecord(id, mediaId);
			if (!media) continue;
			const answer = startMatteJob({ media });
			out.push({ element_id: clipId, media_id: mediaId, job_id: answer.job.job_id, state: answer.job.state, started: answer.started });
		} catch (error) {
			out.push({ element_id: clipId, media_id: mediaId, error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
		}
	}
	return out;
}

// ─── revise ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const REVISE_TOOL: Tool = {
	name: "revise",
	title: "Revise in one sentence",
	description:
		"One sentence from the person → the edit → ONE commit by claude with the sentence as its message. Understands: editing styles (\"make it moody\", \"more aesthetic\") · grade (\"warmer\", \"darker\") · pacing (\"tighter cut\") · captions (\"bigger captions\", \"yellow captions on a box\" — word-highlight captions are rebuilt with their word layer) · titles and compositions (\"make the titles bigger\", \"all the cards slower\", \"the counter orange\", \"calmer\", \"move them up\", \"no exit\", \"hold it longer\": every matching composition re-rendered with new params in the same one commit) · words (\"change the beat 3 caption to 'cold brew, no compromise'\" rewrites the EXISTING caption) · spans (\"make the second half moody\", \"warmer from 24 s\", \"beats 3-5 tighter\", \"the last 10 s cooler\", \"the ending\", \"this section\" with t / beat / element_id: only that part changes; a style on a span = its grade on the GRADE layer split there + only those captions restyled) · saved-style triggers. Code changes to a composition (\"smoother transition\", \"loop the ending\") come back with the composition get → update recipe. Every clause is reported in `clauses`; anything not done is in not_understood with what to send instead, and understood is false. dry_run: true plans without committing (compositions are not rendered). NEVER LOSES WORDS: \"change the beat 3 caption to 'and Claude uses'\" aligns the new words inside the beat and fixes only the ones that differ (Cloud → Claude) as a TRANSCRIPT edit + captions rebuilt, in the same one commit (word_fixes says which); \"change 'Cloud' to 'Claude'\" fixes every occurrence; a change that would delete caption words nobody asked to remove is refused with what it would delete and the transcribe edit call to send instead (allow_word_loss: true only when the person said so); every answer carries words {before, after, lost}. FIRST PASS: \"take a pass at editing this\" (\"do a first pass\", \"edit this\", + \"with serif captions\" / \"with dissolves\" / \"no transitions\") = transcribe all if needed + autocut all + transitions only on set-up changes (a different source file, or a scene change between the clips' frames) + captions (the asked style, else the timeline's, else the active editing style's) in ONE commit, with undo (history restore) and alter calls. Editing styles list what they leave out (a cover, a word behind the head, their compositions) in not_understood with the exact cutout / effects calls. caption_spans lists caption sizes and fonts by span after the change (mixed spans: captions {action: \"unify\"}).",
	inputSchema: schema(
		{
			timeline_id: str("The timeline (project id from timeline list)."),
			sentence: str("What the person asked for, in their words. It becomes the commit message (and the version's name in history)."),
			beat: int("Optional: a storyboard row number (storyboard get) — only that beat changes."),
			element_id: str("Optional: one element (timeline summary) — only it changes. A composition's id makes size / speed / colour words change its params."),
			t: num("Optional: seconds; the beat playing then changes (\"this section\")."),
			dry_run: bool("Plan without committing: ops, the compositions' props before → after, each clause's fate."),
			base_commit: str("Optional: the head you read. If the timeline moved on, nothing is committed (conflict)."),
			branch: str("Branch (default: the project's default branch)."),
			allow_word_loss: bool("Only when the person said so: let a caption change remove words (by default a plan that would delete caption words nobody asked to remove is refused, with what it would delete)."),
			message: str("Ignored (the sentence is the commit message); accepted so a call that sends it is not refused."),
		},
		["timeline_id", "sentence"],
	),
	annotations: WRITE,
	// compositions re-render (≈1 s per output second each, 3 at a time) and captions are measured in Chromium
	budgetSeconds: 190,
	async run(args, ctx) {
		const id = need(args, "timeline_id");
		const sentence = need(args, "sentence");
		const branch = opt(args, "branch");
		const dryRun = args.dry_run === true;
		const actor = actorOf(ctx);
		const owner = await styleOwner(actor, id);
		const [{ library }, head] = await Promise.all([getLibrary(owner), getProjectHead(id, branch)]);
		if (!head.snapshot) return fail("no_snapshot", "The head commit has no snapshot.");
		const address = {
			...(typeof args.beat === "number" ? { beat: args.beat } : {}),
			...(opt(args, "element_id") ? { element_id: opt(args, "element_id") } : {}),
			...(optNum(args, "t") !== undefined ? { t: optNum(args, "t") } : {}),
		};
		const allowWordLoss = args.allow_word_loss === true;
		// revise-safety: "take a pass at editing this" = transcribe + autocut + captions + transitions on set-up changes, ONE commit
		const pass = Object.keys(address).length ? null : parseFirstPass(sentence);
		if (pass) {
			const done = await runFirstPass({ timelineId: id, sentence, ask: pass, actor, branch, dryRun, baseCommit: opt(args, "base_commit"), signal: ctx.signal, allowWordLoss });
			return firstPassView(done, { timelineId: id, sentence, dryRun });
		}
		const { board } = await getStoryboard(id, branch);
		const compositions = await compositionsWithManifests(head.snapshot);
		const plan = planRevision({ sentence, snapshot: head.snapshot, library, address: Object.keys(address).length ? address : undefined, board, compositions, timelineId: id, allowWordLoss });
		const base = { timeline_id: id, sentence, ...planView(plan) };
		if (plan.error) {
			return withNext(fail("invalid_address", plan.error, base), storyboardNext(id, "List the beats (rows) and address one that exists."));
		}
		// revise-safety: word fixes → a transcript edit + a caption rebuild in this commit (tool-built captions with a
		// transcript under the words); else the same words changed in place on the chunks
		const route = await wordFixRoute(id, head.snapshot, plan.word_fixes, plan);
		const rebuild: CaptionRebuildRequest | undefined = Object.keys(route.extra).length
			? { from: "transcript", extra: route.extra, looks: plan.caption_looks }
			: plan.caption_looks.length
				? { from: "doc", looks: plan.caption_looks }
				: undefined;
		const guard = {
			fixes: [
				...plan.word_fixes.map((fix) => ({ from: fix.from, to: fix.to, t: fix.t })),
				...captionFixesOf(head.snapshot, plan.ops, plan.caption_changes).map((fix) => ({ from: fix.from, to: fix.to, t: fix.start })),
			],
			exclude: plan.exclude_chunks,
			allowWordLoss,
		};
		const fixView = route.transcript.length || route.in_place.length ? { word_fixes: { ...(route.transcript.length ? { through_transcript: route.transcript } : {}), ...(route.in_place.length ? { in_place: route.in_place } : {}) } } : {};
		const miss = plan.not_understood[0];
		const nothing = !plan.ops.length && !plan.compositions.length && !plan.caption_changes.length && !rebuild;
		if (nothing) {
			return {
				payload: {
					...base,
					committed: false,
					head: head.head.id,
					next: missNextOf(id, miss, sentence, head.head.id) ?? summaryNext(id, "Nothing to do: read the summary and write ops yourself."),
				},
			};
		}
		const plannedCompositions = plan.compositions.map((edit) => ({ element_id: edit.element_id, title: edit.title, kind: edit.custom ? "custom" : "library", changes: edit.changes.map((change) => `${change.key}: ${JSON.stringify(change.from) ?? "—"} → ${JSON.stringify(change.to)} (${change.because})`), ...(edit.duration_s !== undefined ? { duration_s: edit.duration_s } : {}) }));
		const outcome = await commitAsClaude({
			timelineId: id,
			ops: plan.ops,
			message: sentence,
			actor,
			baseCommit: opt(args, "base_commit") ?? head.head.id,
			branch,
			styles: plan.styles,
			dryRun,
			compositions: compositionChanges(plan.compositions),
			captions: plan.caption_changes,
			signal: ctx.signal,
			rebuild,
			guard,
		});
		if (!outcome.ok) return outcomeFailure(id, outcome, { tool: "revise", arguments: { timeline_id: id, sentence, ...address } });
		const report = {
			...base,
			...fixView,
			ops: plan.ops.slice(0, 80),
			ops_count: plan.ops.length,
			...(plan.compositions.length ? { compositions: dryRun ? plannedCompositions : outcome.compositions } : {}),
			...(outcome.captions ? { captions_rebuilt: outcome.captions } : {}),
			...(outcome.rebuilt_captions ? { captions_rebuilt_all: outcome.rebuilt_captions } : {}),
			...(outcome.words ? { words: guardView(outcome.words) } : {}),
			...(outcome.caption_spans ? { caption_spans: spansView(outcome.caption_spans) } : {}),
			...changeReport(outcome.changes),
		};
		const leftOutNote = plan.left_out.length ? ` Then add what the style left out (${plan.left_out.length}: see not_understood), first: ${plan.left_out[0]?.send.steps?.[0]?.tool ?? "?"} ${String(plan.left_out[0]?.send.steps?.[0]?.arguments.preset ?? plan.left_out[0]?.send.steps?.[0]?.arguments.name ?? "")}.` : "";
		if (outcome.dry_run) {
			const anyApplied = plan.clause_report.some((entry) => entry.status === "applied");
			return {
				payload: {
					...report,
					dry_run: true,
					head: outcome.head,
					...(plan.compositions.length ? { render: `${plan.compositions.length} composition${plan.compositions.length === 1 ? "" : "s"} will be re-rendered on commit (≈1–3 s each, 3 at a time)` } : {}),
					next:
						plan.understood || (anyApplied && plan.left_out.length === plan.not_understood.length)
							? { do: `Looks right: commit it (same call without dry_run).${leftOutNote}`, tool: "revise", arguments: { timeline_id: id, sentence, ...address, base_commit: outcome.head } }
							: (missNextOf(id, miss, sentence, outcome.head) ?? { do: "Commit what was understood (same call without dry_run).", tool: "revise", arguments: { timeline_id: id, sentence, ...address, base_commit: outcome.head } }),
				},
			};
		}
		if (!outcome.commit) {
			return {
				payload: {
					...report,
					committed: false,
					head: outcome.head,
					...(outcome.unchanged?.length ? { unchanged: outcome.unchanged } : {}),
					message: "Nothing changed: every render came out the same as what is there.",
					next: missNextOf(id, miss, sentence, outcome.head) ?? storyboardNext(id),
				},
			};
		}
		// a real revision: a version in history, and repeat detection (the same history the browser's command bar writes)
		let version: { name: string; base?: string } | null = null;
		try {
			if (outcome.commit && plan.milestone) version = await recordMilestone(id, outcome.commit.id, plan.milestone, outcome.head, actor.name);
		} catch (error) {
			console.warn("[mcp revise] version name not recorded:", error);
		}
		// rewritten caption words become transcript fixes (a later captions rebuild keeps them)
		const fixes = await recordCaptionFixes(id, head.snapshot, captionFixesOf(head.snapshot, plan.ops, plan.caption_changes));
		// revise-safety: the person mattes the left-out style pieces need, started now (cached; the cutout calls then wait less)
		const mattes = await startMattes(id, outcome.snapshot, plan.matte_clips);
		let suggestions: Awaited<ReturnType<typeof ownerSuggestions>> = [];
		try {
			await recordOwnerInstruction(owner, { sentence, ops: plan.ops, clauses: plan.clauses, projectId: id }, "mcp");
			suggestions = await ownerSuggestions(owner);
		} catch (error) {
			console.warn("[mcp revise] history not recorded:", error);
		}
		const suggestion = suggestions[0];
		const commitId = outcome.commit?.id;
		return {
			payload: {
				commit_id: commitId,
				...report,
				version_note: outcome.commit?.message,
				...(version ? { version: version.name, ...(version.base ? { previous_version: `${version.base} (${outcome.head.slice(0, 7)})` } : {}) } : {}),
				...(fixes.recorded || fixes.skipped.length ? { transcript_fixes: { recorded: fixes.recorded, ...(fixes.skipped.length ? { skipped: fixes.skipped } : {}) } } : {}),
				...(mattes.length ? { person_mattes: mattes } : {}),
				branch: outcome.branch,
				...(suggestions.length
					? {
							repeat_suggestions: suggestions.map((s) => ({ pattern: s.pattern.key, label: s.pattern.label, count: s.count, projects: s.projects, examples: s.examples, title: s.draft_style.title })),
						}
					: {}),
				editor: "The editor pulls this commit within ~15 s (or on focus): \"Claude: <sentence>\" with a before/after.",
				next:
					missNextOf(id, miss, sentence, commitId) ??
					(suggestion
						? {
								do: `"${suggestion.pattern.label}" has now been asked ${suggestion.count} times: offer to save it as a style (one sentence applies it next time).`,
								tool: "styles",
								arguments: { action: "save", timeline_id: id, pattern: suggestion.pattern.key, title: suggestion.draft_style.title },
							}
						: plan.compositions.length
							? { do: "Look at the change: render a preview of this commit, then look.", tool: "render", arguments: { timeline_id: id, commit: commitId, quality: "preview" } }
							: storyboardNext(id)),
			},
		};
	},
};

// ─── storyboard ─────────────────────────────────────────────────────────────────────────────────────────────────

export const STORYBOARD_TOOL: Tool = {
	name: "storyboard",
	title: "Storyboard",
	description:
		"The cut as a storyboard, one row per BEAT (a spoken line, or a shot where nobody speaks), covering the whole runtime with no gaps or overlaps: time range, the shot(s) on screen, the spoken line verbatim (from captions, voice-over, the transcript, or an explainer's script — line_from says which), on_screen text (titles + the words inside compositions), overlays and effects (compositions, grade, transitions), sound cue. get = rows + approval state; edit_row = change a row's spoken line (caption: the EXISTING caption chunks are rewritten, word layer included — never a second caption track), its title (emphasis), or anything else in words (sentence, like revise on that beat) → one commit; approve = record approval in the project's metadata (a later change to the storyboard makes it stale; history does not count it as a version). Show the person the storyboard before rendering.",
	inputSchema: schema(
		{
			action: oneOf(["get", "edit_row", "approve"]),
			timeline_id: str("The timeline."),
			row: int("edit_row: the row (beat) number from get."),
			caption: str("edit_row: the row's spoken line as it should read (the words are spread over its caption chunks, which are rewritten in place)."),
			emphasis: str("edit_row: the row's on-screen title / big word (replaces it, or a title composition's words, or adds a pop)."),
			sentence: str("edit_row: anything else for this row, in words (\"bigger captions\", \"warmer\", \"slow it down\", \"the title orange\")."),
			message: str("edit_row: the commit message (default: storyboard beat N: what changed)."),
			note: str("approve: a note kept with the approval."),
			by: str("approve: who approved (default claude; pass the person's name when they said yes)."),
			dry_run: bool("edit_row: apply without committing."),
			allow_word_loss: bool("edit_row: only when the person said so — let the new line drop words the row's captions show (by default refused, with the transcribe edit call to send instead)."),
			base_commit: str("edit_row, approve: optional; the head you read."),
			branch: str("Branch (default: the project's default branch)."),
		},
		["action", "timeline_id"],
	),
	annotations: WRITE,
	budgetSeconds: 120,
	async run(args, ctx) {
		const action = args.action as string;
		const id = need(args, "timeline_id");
		const branch = opt(args, "branch");
		const actor = actorOf(ctx);
		if (action === "get") {
			const { head, board, approval } = await getStoryboard(id, branch);
			const approvedNow = approval.status === "approved";
			const withLines = board.rows.filter((row) => row.line).length;
			return {
				payload: {
					timeline_id: id,
					head,
					runtime_s: board.runtime,
					beats: board.rows.length,
					beats_with_lines: withLines,
					shots: board.shots,
					approval: {
						status: approval.status,
						...(approval.record ? { approved_at: approval.record.approved_at, approved_by: approval.record.approved_by, approved_commit: approval.record.commit } : {}),
					},
					rows: board.rows.map(rowView),
					next: board.rows.length
						? approvedNow
							? { do: "Approved: render the approved head (or revise a beat first).", tool: "render", arguments: { timeline_id: id, commit: head, quality: "preview" } }
							: {
									do: "Show the person these rows. Change a row with edit_row (or revise with beat); when they say yes, approve.",
									tool: "storyboard",
									arguments: { action: "approve", timeline_id: id, base_commit: head },
								}
						: summaryNext(id, "The timeline is empty: put clips on V1 A-ROLL first."),
				},
			};
		}
		if (action === "edit_row") {
			const row = typeof args.row === "number" ? args.row : NaN;
			if (!Number.isInteger(row) || row < 1) return withNext(fail("invalid_arguments", "row is required for edit_row (a row number from storyboard get)."), storyboardNext(id));
			const owner = await styleOwner(actor, id);
			const { library } = await getLibrary(owner);
			const result = await editStoryboardRow({
				timelineId: id,
				edit: { row, caption: opt(args, "caption"), emphasis: opt(args, "emphasis"), sentence: opt(args, "sentence") },
				library,
				actor,
				baseCommit: opt(args, "base_commit"),
				branch,
				dryRun: args.dry_run === true,
				message: opt(args, "message"),
				signal: ctx.signal,
				allowWordLoss: args.allow_word_loss === true,
			});
			if (result.error || !result.outcome) {
				const firstMiss = result.refused ?? result.plan?.not_understood[0];
				return withNext(
					fail(result.refused ? "words_refused" : "not_done", result.error ?? "nothing was changed", { not_understood: result.refused ? [result.refused, ...(result.plan?.not_understood ?? [])] : (result.plan?.not_understood ?? []), clauses: result.plan?.clause_report ?? [], notes: result.notes }),
					missNextOf(id, firstMiss, opt(args, "sentence") ?? "", undefined) ?? storyboardNext(id, "Read the rows and try again."),
				);
			}
			if (!result.outcome.ok) return outcomeFailure(id, result.outcome, { tool: "storyboard", arguments: { action: "edit_row", timeline_id: id, row, ...(opt(args, "caption") ? { caption: opt(args, "caption") } : {}), ...(opt(args, "emphasis") ? { emphasis: opt(args, "emphasis") } : {}), ...(opt(args, "sentence") ? { sentence: opt(args, "sentence") } : {}) } });
			const extras = {
				...(result.outcome.compositions.length ? { compositions: result.outcome.compositions } : {}),
				...(result.outcome.captions ? { captions_rebuilt: result.outcome.captions } : {}),
				...(result.plan ? { clauses: result.plan.clause_report } : {}),
				...(result.word_fixes ? { word_fixes: result.word_fixes } : {}),
				...(result.outcome.rebuilt_captions ? { captions_rebuilt_all: result.outcome.rebuilt_captions } : {}),
				...(result.outcome.words ? { words: guardView(result.outcome.words) } : {}),
				...(result.outcome.caption_spans ? { caption_spans: spansView(result.outcome.caption_spans) } : {}),
			};
			if (result.outcome.dry_run) {
				return {
					payload: {
						timeline_id: id,
						row,
						dry_run: true,
						labels: result.labels,
						notes: result.notes,
						...extras,
						...changeReport(result.outcome.changes),
						next: { do: "Commit it (same call without dry_run).", tool: "storyboard", arguments: { action: "edit_row", timeline_id: id, row, ...(opt(args, "caption") ? { caption: opt(args, "caption") } : {}), ...(opt(args, "emphasis") ? { emphasis: opt(args, "emphasis") } : {}), ...(opt(args, "sentence") ? { sentence: opt(args, "sentence") } : {}), base_commit: result.outcome.head } },
					},
				};
			}
			return {
				payload: {
					commit_id: result.outcome.commit?.id,
					timeline_id: id,
					row,
					message: result.outcome.commit?.message,
					labels: result.labels,
					notes: result.notes,
					...extras,
					...(result.plan?.not_understood.length ? { not_understood: result.plan.not_understood } : {}),
					...changeReport(result.outcome.changes),
					next: storyboardNext(id, "Read the storyboard again: the row shows the change."),
				},
			};
		}
		if (action === "approve") {
			const result = await approveStoryboard({ timelineId: id, actor, by: opt(args, "by"), note: opt(args, "note"), baseCommit: opt(args, "base_commit"), branch });
			if ("conflict" in result) {
				return withNext(fail("conflict", `The timeline moved on (head ${result.conflict.head}): read the storyboard again before approving it.`, result.conflict), storyboardNext(id));
			}
			// render the head as it is now: the approval commit carries the same cut (metadata only)
			const renderCommit = result.commit?.id ?? (await getProjectHead(id, branch)).head.id;
			return {
				payload: {
					timeline_id: id,
					approved: true,
					already_approved: result.already,
					record: result.record,
					commit_id: result.commit?.id ?? null,
					counts_as_version: false,
					beats: result.board.rows.length,
					next: { do: "Render it.", tool: "render", arguments: { timeline_id: id, commit: renderCommit, quality: "preview" } },
				},
			};
		}
		return fail("invalid_arguments", `Unknown action ${action}.`);
	},
};

// ─── history ────────────────────────────────────────────────────────────────────────────────────────────────────

function opSummary(ops: unknown): { line: string; counts: Record<string, number>; detail: string[] } {
	const list = Array.isArray(ops) ? (ops as Array<Record<string, unknown>>) : [];
	const counts: Record<string, number> = {};
	const detail: string[] = [];
	for (const op of list) {
		const name = typeof op?.op === "string" ? op.op : "?";
		counts[name] = (counts[name] ?? 0) + 1;
		if (name === "apply_style" && typeof op.preset_id === "string") detail.push(`style ${op.preset_id.replace(/^restorff\/(style|user)\//, "")}${op.preset_id.startsWith(USER_STYLE_PREFIX) ? " (saved)" : ""}`);
		if (name === "grade" && typeof op.preset === "string") detail.push(`grade ${op.preset}${op.target && op.target !== "all" ? ` on ${String(op.target)}` : ""}`);
		if (name === "set" && op.prop === "text" && typeof op.value === "string") detail.push(`text "${op.value.slice(0, 40)}"`);
		if (name === "set" && op.prop === "speed") detail.push(`speed ${String(op.value)}×`);
		if (name === "text_pop" && typeof op.text === "string") detail.push(`title "${op.text.slice(0, 40)}"`);
		if (name === "set_caption_style" && op.style && typeof op.style === "object") detail.push(`caption style ${Object.keys(op.style as object).join(", ")}`);
	}
	const line = list.length
		? `${list.length} op${list.length === 1 ? "" : "s"}: ${Object.entries(counts)
				.sort((a, b) => b[1] - a[1])
				.map(([name, n]) => `${n} × ${name}`)
				.join(" · ")}`
		: "no ops (a snapshot save)";
	return { line, counts, detail: [...new Set(detail)].slice(0, 8) };
}

export const HISTORY_TOOL: Tool = {
	name: "history",
	title: "Versions and change notes",
	description:
		"The timeline's versions. list (default): the named versions (\"v1 cut\", \"v2 aesthetic\", \"v3 moody second half\" — every real revise sentence becomes one automatically; name your own with action name) and the newest `limit` commits oldest first, each with who made it, its change note (the commit message), what its ops did, what changed inside its compositions (props before → after, source +/− lines), and whether it counts as a version (storyboard approvals and gate fixes do not). name = give a commit a version name. tag = say a commit is or is not a version. restore = UNDO: a new commit whose timeline is the given commit's (e.g. the head before a revise or a first pass; nothing is rewritten). Use it to tell the person \"what's new in v3\".",
	inputSchema: schema(
		{
			timeline_id: str("The timeline."),
			action: oneOf(["list", "name", "tag", "restore"], "list (default) · name {commit, name} · tag {commit, tag} · restore {commit} = undo: a new commit whose timeline is that commit's (history keeps everything)."),
			commit: str("name, tag, restore: the commit id (or a unique prefix of ≥ 4 characters)."),
			message: str("restore: the commit message (default: restore <id> (its message))."),
			base_commit: str("restore: optional; the head you read (conflict if it moved)."),
			name: str("name: the version's name (\"client cut\"; \"v4 client cut\" keeps your number, otherwise the next vN is put in front)."),
			tag: oneOf(["version", "not_a_version"], "tag: whether the commit counts as a version."),
			limit: int("list: how many of the newest commits (default 20, at most 100)."),
			branch: str("Branch (default: the project's default branch)."),
		},
		["timeline_id"],
	),
	annotations: WRITE,
	async run(args, ctx) {
		const id = need(args, "timeline_id");
		const action = (opt(args, "action") ?? "list") as "list" | "name" | "tag" | "restore";
		const by = actorOf(ctx).name;
		if (action === "restore") {
			// revise-safety: undo = a NEW commit whose timeline is that commit's (nothing is rewritten; the history keeps both)
			const target = await getCommit(id, need(args, "commit", "for restore"), { snapshot: true });
			if (!target.snapshot) return fail("no_snapshot", `Commit ${target.id} has no snapshot to restore.`);
			const head = await getProjectHead(id, opt(args, "branch"));
			if (head.head.id === target.id) return { payload: { timeline_id: id, restored: false, head: head.head.id, message: "That commit is the head already: nothing to restore.", next: { do: "Read the versions.", tool: "history", arguments: { timeline_id: id } } } };
			const base = opt(args, "base_commit");
			if (base && base !== head.head.id && !(base.length >= 7 && head.head.id.startsWith(base))) return withNext(fail("conflict", `The timeline moved on: its head is ${head.head.id}, not ${base}. Nothing was restored.`, { head: head.head.id }), summaryNext(id));
			const message = opt(args, "message") ?? `restore ${target.id.slice(0, 7)} (${target.message.slice(0, 120)})`;
			const pushed = await pushCommit(id, { base_commit: head.head.id, branch: head.branch, author: "claude", snapshot: target.snapshot, ops: [], message }, actorOf(ctx));
			if (!pushed.ok) return withNext(fail("conflict", "The timeline moved while restoring. Nothing was restored.", { head: pushed.conflict.head.id }), summaryNext(id));
			try {
				await tagCommit(id, pushed.commit.id, "not_a_version", by);
			} catch {
				/* the tag is a nicety */
			}
			return {
				payload: {
					timeline_id: id,
					restored: true,
					commit_id: pushed.commit.id,
					message: pushed.commit.message,
					restored_from: { commit_id: target.id, message: target.message },
					previous_head: head.head.id,
					editor: "The editor pulls this commit within ~15 s (or on focus).",
					next: { do: "Check the restored cut.", tool: "storyboard", arguments: { action: "get", timeline_id: id } },
				},
			};
		}
		if (action === "name") {
			const named = await nameVersion(id, need(args, "commit", "for name"), need(args, "name", "for name"), by);
			return { payload: { timeline_id: id, named: named.name, commit_id: named.commit_id, next: { do: "Read the versions.", tool: "history", arguments: { timeline_id: id } } } };
		}
		if (action === "tag") {
			const tag = opt(args, "tag");
			if (tag !== "version" && tag !== "not_a_version") return fail("invalid_arguments", "tag must be version or not_a_version.");
			const tagged = await tagCommit(id, need(args, "commit", "for tag"), tag, by);
			return { payload: { timeline_id: id, ...tagged, next: { do: "Read the versions.", tool: "history", arguments: { timeline_id: id } } } };
		}
		const limit = Math.min(100, Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : 20));
		const history = await buildHistory(id, { branch: opt(args, "branch"), limit });
		const versions = history.entries.map((entry) => {
			const ops = opSummary(entry.ops);
			return {
				version: entry.version,
				n: entry.n,
				commit_id: entry.commit_id,
				author: entry.author,
				author_name: entry.author_name,
				created_at: entry.created_at,
				note: entry.note,
				...(entry.name ? { name: entry.name } : {}),
				kind: entry.kind,
				counts_as_version: entry.counts_as_version,
				ops: ops.line,
				...(ops.detail.length ? { what: ops.detail } : {}),
				...(entry.compositions?.length ? { compositions: entry.compositions } : {}),
				changed: entry.summary_lines,
				stats: entry.stats,
			};
		});
		const newest = history.named[history.named.length - 1];
		return {
			payload: {
				timeline_id: id,
				branch: history.branch,
				head: history.head,
				versions_by: history.versions_by,
				total_versions: history.total_versions,
				total_commits: history.total_commits,
				current_version: history.current.version,
				...(history.current.commits_since ? { commits_since_current: history.current.commits_since } : {}),
				named: history.named,
				...(history.total_commits >= 500 ? { caveat: "500+ commits: numbers count the newest 500 only" } : {}),
				versions,
				next: newest
					? { do: `Tell the person what's new in ${newest.version} (the commits after the one before it: notes, what, compositions), or read the storyboard.`, tool: "storyboard", arguments: { action: "get", timeline_id: id } }
					: versions.length
						? { do: "Name the version the person is happy with (it then reads as v1 …).", tool: "history", arguments: { timeline_id: id, action: "name", commit: history.head, name: "cut" } }
						: summaryNext(id),
			},
		};
	},
};

// ─── styles (built-ins + saved) ─────────────────────────────────────────────────────────────────────────────────

function savedView(style: SavedStyle) {
	return {
		id: style.id,
		source: "saved" as const,
		title: style.title,
		version: style.version,
		triggers: style.triggers,
		instructions: style.instructions,
		steps: style.steps.map((step) => (step.kind === "sentence" ? `sentence: ${step.sentence}` : `op: ${String(step.op.op)}${step.each ? ` per ${step.each}` : ""}`)),
		params: style.params,
		updated_at: style.updated_at,
		apply_as: `${USER_STYLE_PREFIX}${style.id}`,
	};
}

function buildStyle(args: { title: string; triggers: string[]; steps: StyleStep[]; instructions?: string; params?: Record<string, unknown> }): SavedStyle {
	const at = new Date().toISOString();
	return {
		id: slugify(args.title),
		kind: "edit-style",
		stage: "edit",
		version: "1.0.0",
		title: args.title.slice(0, 60),
		instructions: args.instructions?.trim() || `Saved by Claude: ${args.steps.map((s) => (s.kind === "sentence" ? `"${s.sentence}"` : String(s.op.op))).join(", ")}.`,
		licence: "private",
		visibility: "private",
		inputs: ["timeline"],
		outputs: { schema: "ops@1" },
		params: (args.params ?? {}) as SavedStyle["params"],
		checks: [],
		triggers: args.triggers,
		steps: args.steps,
		origin: null,
		created_at: at,
		updated_at: at,
	};
}

export const STYLES_TOOL: Tool = {
	name: "styles",
	title: "Editing styles",
	description:
		"Editing styles: the five built-ins of the editor's EDITING STYLE picker (fast-ugc, talking-head, aesthetic-warm, moody-captions, paper-collage) AND the person's saved styles (\"skills\": a repeated ask saved with its trigger sentences; stored on the server, shared with the editor). list them · apply one as a commit (built-in or saved id) · resolve a sentence into the exact ops the editor's command bar would make · save a style (from a repeat-suggestion pattern, a sentence, or steps) · delete · versions · suggest (asks repeated ≥ 3 times, from revise and the command bar) · dismiss a suggestion. Prefer revise for a person's sentence: it checks saved-style triggers itself.",
	inputSchema: schema({
		action: oneOf(["list", "apply", "resolve", "save", "delete", "versions", "suggest", "dismiss"]),
		timeline_id: str("apply, resolve (required); list, save, suggest: optional — picks whose saved styles (the project's owner)."),
		base_commit: str("apply: optional; the head you read (conflict if it moved)."),
		style: str("apply, delete, versions: a style id from list (built-in or saved)."),
		sentence: str("resolve: what the person asked for. save: the instruction to save (re-read on each project)."),
		message: str("apply: the commit message (default: style: <label>)."),
		params: { type: "object", description: "apply (saved styles): overrides for the style's params." },
		dry_run: bool("apply: apply without committing."),
		title: str("save: the style's name (its id is made from it; the same id again = a new version)."),
		triggers: { type: "array", items: { type: "string" }, description: "save: sentences that call it (default: the examples / the sentence)." },
		steps: { type: "array", items: { type: "object" }, description: "save: explicit steps — {kind:'sentence', sentence} or {kind:'op', op:{…ops@1 without ids…}, each?:'$captions'|'$main'|'$clips'}." },
		pattern: str("save, dismiss: a pattern key from suggest (or from revise's repeat_suggestions)."),
		instructions: str("save: what it does, in plain words."),
		note: str("save: the change note of this version."),
	}, ["action"]),
	annotations: WRITE,
	async run(args, ctx) {
		const action = args.action as string;
		const actor = actorOf(ctx);
		const timelineId = opt(args, "timeline_id");
		const owner = await styleOwner(actor, timelineId ?? null);

		if (action === "list") {
			const { library } = await getLibrary(owner);
			const saved = listStyles(library);
			return {
				payload: {
					owner,
					styles: [
						...EDITING_STYLE_PRESETS.map((preset) => ({
							id: preset.id,
							source: "builtin" as const,
							label: preset.label,
							hint: preset.hint,
							grade: preset.grade,
							compositions: preset.compositions.map((composition) => composition.name),
							notes: preset.notes,
						})),
						...saved.map(savedView),
					],
					saved: saved.length,
					next: saved[0]
						? { do: `Saying one of its triggers to revise applies a saved style ("${saved[0].triggers[0]}"), or apply it by id.`, tool: "styles", arguments: { action: "apply", timeline_id: timelineId ?? "…", style: saved[0].id } }
						: { do: "Apply one to a timeline.", tool: "styles", arguments: { action: "apply", timeline_id: timelineId ?? "…", style: EDITING_STYLE_PRESETS[0]?.id } },
				},
			};
		}

		if (action === "resolve") {
			const id = need(args, "timeline_id", "for resolve");
			const sentence = need(args, "sentence", "for resolve");
			const [head, { library }] = await Promise.all([getProjectHead(id), getLibrary(owner)]);
			const project = head.snapshot as unknown as OpsProject;
			const plan = resolveSentence(sentence, { project, author: "claude" });
			const savedHit = matchTrigger(library, sentence);
			const savedPlan = savedHit ? planStyle(savedHit, project, { author: "claude" }) : null;
			return {
				payload: {
					timeline_id: id,
					head: head.head.id,
					label: plan.label,
					understood: plan.understood,
					unmatched: plan.unmatched,
					clauses: plan.clauses.map((clause) => ({ text: clause.text, kinds: clause.kinds, labels: clause.labels, reason: clause.reason ?? null })),
					ops: plan.ops,
					notes: plan.notes,
					...(savedHit && savedPlan
						? { saved_style: { ...savedView(savedHit), ops: savedPlan.ops, unresolved: savedPlan.unresolved, notes: savedPlan.notes } }
						: {}),
					next: savedHit
						? { do: `This is the trigger of the saved style "${savedHit.title}": revise applies it as one commit.`, tool: "revise", arguments: { timeline_id: id, sentence } }
						: plan.ops.length
							? {
									do: plan.understood ? "Commit these ops as they are (or adjust them) — or send the sentence to revise, which does both in one call." : `Commit these, then write ops yourself for: ${plan.unmatched.join(" · ")}`,
									tool: "timeline_ops",
									arguments: { timeline_id: id, base_commit: head.head.id, ops: plan.ops, message: sentence },
								}
							: summaryNext(id, "Nothing here matched: read the summary and write the ops yourself."),
				},
			};
		}

		if (action === "apply") {
			const id = need(args, "timeline_id", "for apply");
			const styleId = need(args, "style", "for apply").replace(/^restorff\/(style|user)\//, "");
			const preferSaved = String(args.style).startsWith(USER_STYLE_PREFIX);
			const builtin = preferSaved ? undefined : getEditingStylePreset(styleId);
			const { library } = await getLibrary(owner);
			const saved = builtin ? undefined : library.styles[styleId];
			if (!builtin && !saved) {
				return fail("unknown_style", `No style "${styleId}". Call styles list.`, { styles: [...EDITING_STYLE_PRESETS.map((p) => p.id), ...Object.keys(library.styles)] });
			}
			const params = args.params && typeof args.params === "object" && !Array.isArray(args.params) ? (args.params as Record<string, unknown>) : undefined;
			const op = (builtin
				? { op: "apply_style", author: "claude", preset_id: `${STYLE_PRESET_PREFIX}${builtin.id}` }
				: { op: "apply_style", author: "claude", preset_id: `${USER_STYLE_PREFIX}${(saved as SavedStyle).id}`, ...(params ? { params } : {}) }) as Op;
			const message = opt(args, "message") ?? (builtin ? `style: ${builtin.label}` : `style: ${(saved as SavedStyle).title} (saved, v${(saved as SavedStyle).version})`);
			// a GRADE layer split by a scoped revise is folded back first (the style grades the whole video) — revise-v2
			const fold = foldGradeLayer((await getProjectHead(id)).snapshot ?? ({ scenes: [] } as never));
			const outcome = await commitAsClaude({
				timelineId: id,
				ops: [...fold, op],
				message,
				actor,
				baseCommit: opt(args, "base_commit"),
				styles: saved ? styleExpanders(library) : undefined,
				dryRun: args.dry_run === true,
			});
			if (!outcome.ok) return outcomeFailure(id, outcome);
			const notes = builtin
				? [
						...builtin.notes,
						builtin.compositions.length
							? `Over MCP the style changes captions, pacing, joins and grade; its compositions (${builtin.compositions.map((c) => c.name).join(", ")}) are rendered and imported by the editor — pick the style in the editor's EDITING STYLE panel (or the command bar) to add them.`
							: "",
					].filter(Boolean)
				: planStyle(saved as SavedStyle, outcome.snapshot as unknown as OpsProject, { author: "claude" }).notes;
			// revise-safety: what the style declares and this commit does not add, with the exact calls
			const leftOut = builtin ? stylePiecesLeftOut(builtin.id, outcome.snapshot, id, `style ${builtin.label}`) : [];
			return {
				payload: {
					timeline_id: id,
					style: builtin ? { id: builtin.id, source: "builtin", label: builtin.label } : { ...savedView(saved as SavedStyle) },
					dry_run: outcome.dry_run,
					...(outcome.commit ? { commit_id: outcome.commit.id, message: outcome.commit.message, stats: outcome.commit.stats } : {}),
					...changeReport(outcome.changes),
					...(leftOut.length ? { left_out: leftOut.map((piece) => ({ what: piece.clause, why: piece.why, how: piece.send.how, calls: piece.send.steps ?? [] })) } : {}),
					...(outcome.words ? { words: guardView(outcome.words) } : {}),
					...(outcome.caption_spans ? { caption_spans: spansView(outcome.caption_spans) } : {}),
					notes,
					next: outcome.dry_run ? { do: "Commit it (same call without dry_run).", tool: "styles", arguments: { action: "apply", timeline_id: id, style: styleId } } : storyboardNext(id, "Check the cut."),
				},
			};
		}

		if (action === "save") {
			const title = opt(args, "title");
			const pattern = opt(args, "pattern");
			const sentence = opt(args, "sentence");
			const triggers = Array.isArray(args.triggers) ? (args.triggers as unknown[]).filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim()) : [];
			let style: SavedStyle | null = null;
			if (pattern) {
				const suggestions = await ownerSuggestions(owner, { threshold: 2, limit: 50 });
				const hit = suggestions.find((s) => s.pattern.key === pattern);
				if (!hit) return withNext(fail("unknown_pattern", `No open repeat pattern "${pattern}" (already saved or dismissed?).`), { do: "List the open suggestions.", tool: "styles", arguments: { action: "suggest", timeline_id: timelineId } });
				style = { ...hit.draft_style };
				if (title) {
					style.title = title.slice(0, 60);
					style.id = slugify(title);
				}
				if (triggers.length) style.triggers = triggers;
			} else if (Array.isArray(args.steps) && args.steps.length) {
				if (!title) return fail("invalid_arguments", "save with steps needs a title.");
				style = buildStyle({ title, triggers: triggers.length ? triggers : [title], steps: args.steps as StyleStep[], instructions: opt(args, "instructions"), params: args.params as Record<string, unknown> | undefined });
			} else if (sentence) {
				style = styleFromSentence({ title: title ?? sentence, sentence, triggers: triggers.length ? triggers : [sentence], projectId: timelineId });
			} else {
				return fail("invalid_arguments", "save needs a pattern (from suggest), a sentence, or steps.");
			}
			if (opt(args, "instructions")) style.instructions = opt(args, "instructions") as string;
			const saved = await saveOwnerStyle(owner, style, { projectId: timelineId ?? null, savedBy: actor.name, note: opt(args, "note") });
			return {
				payload: {
					owner,
					saved: savedView(saved.style),
					changed: saved.changed,
					older_versions: saved.versions.map((v) => v.version),
					editor: "The editor's styles lab pulls saved styles when it opens (MY STYLES under EDITING STYLE).",
					next: timelineId
						? { do: `Say a trigger to revise to apply it: "${saved.style.triggers[0]}".`, tool: "revise", arguments: { timeline_id: timelineId, sentence: saved.style.triggers[0], dry_run: true } }
						: { do: "List the styles.", tool: "styles", arguments: { action: "list" } },
				},
			};
		}

		if (action === "delete") {
			const styleId = need(args, "style", "for delete").replace(/^restorff\/user\//, "");
			const gone = await deleteOwnerStyle(owner, styleId);
			if (!gone) return fail("unknown_style", `No saved style "${styleId}" (built-ins cannot be deleted).`);
			return { payload: { owner, deleted: styleId, next: { do: "List the styles.", tool: "styles", arguments: { action: "list", timeline_id: timelineId } } } };
		}

		if (action === "versions") {
			const styleId = need(args, "style", "for versions").replace(/^restorff\/user\//, "");
			const { library } = await getLibrary(owner);
			const current = library.styles[styleId];
			if (!current) return fail("unknown_style", `No saved style "${styleId}".`);
			const all = [...(library.versions[styleId] ?? []), current];
			return {
				payload: {
					owner,
					style: styleId,
					versions: all.map((v) => ({ version: v.version, note: v.note ?? null, updated_at: v.updated_at, triggers: v.triggers, current: v.version === current.version })),
					next: { do: "Apply the current version.", tool: "styles", arguments: { action: "apply", timeline_id: timelineId ?? "…", style: styleId } },
				},
			};
		}

		if (action === "suggest") {
			const suggestions = await ownerSuggestions(owner, { limit: 5 });
			return {
				payload: {
					owner,
					suggestions: suggestions.map((s) => ({ pattern: s.pattern.key, kind: s.pattern.kind, label: s.pattern.label, count: s.count, projects: s.projects, examples: s.examples, draft: savedView(s.draft_style) })),
					next: suggestions[0]
						? { do: `Offer to save "${suggestions[0].pattern.label}" as a style.`, tool: "styles", arguments: { action: "save", timeline_id: timelineId, pattern: suggestions[0].pattern.key } }
						: { do: "Nothing repeated 3 times yet. Keep revising.", tool: "styles", arguments: { action: "list", timeline_id: timelineId } },
				},
			};
		}

		if (action === "dismiss") {
			const pattern = need(args, "pattern", "for dismiss");
			await dismissOwnerPattern(owner, pattern);
			return { payload: { owner, dismissed: pattern, next: { do: "List the styles.", tool: "styles", arguments: { action: "list", timeline_id: timelineId } } } };
		}

		return fail("invalid_arguments", `Unknown action ${action}.`);
	},
};

export const REVIEW_INSTRUCTIONS =
	"For a person's sentence (\"make it moody\", \"tighter cut, bigger captions\", \"make the titles bigger\", \"make the second half moody\", \"change the beat 3 caption to …\") call revise with the sentence as said: one call = one commit with their sentence as the note — compositions, spans and captions included (dry_run first to show what it will do); read `clauses` and do what not_understood says for anything it could not do. Before rendering, show the storyboard (storyboard get: one row per beat with its spoken line), change rows with edit_row and record the person's yes with approve. history lists the named versions (v1 cut → v2 …) with what changed, compositions' props included. When revise returns repeat_suggestions, offer to save the ask as a style (styles save). \"Take a pass at editing this\" is ONE revise call (transcribe + autocut + transitions on set-up changes + captions, one commit; undo = history restore). A wrong caption word is a word fix (revise \"change 'Cloud' to 'Claude'\" or \"change the beat 3 caption to '…'\"): revise never deletes caption words nobody asked to remove — it refuses and says what to send.";
