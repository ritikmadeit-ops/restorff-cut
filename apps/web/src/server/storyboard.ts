/**
 * Storyboard on the server (EDT-14) + the one commit path every review edit uses (EDT-16, EDT-19) — mcp-review agent,
 * 2026-10-20; compositions, caption rebuilds and transcripts added by the revise-v2 agent the same evening.
 *
 *   getStoryboard(id)          rows = beats (./storyboard-rows.ts) + approval state, for MCP `storyboard get` and the
 *                              route; spoken lines from captions, voice-over words, server transcripts and the
 *                              references build's explainer beats
 *   editStoryboardRow(…)       a row's caption / title text, or a sentence addressed to it → ONE commit by claude; the
 *                              caption edit rewrites the EXISTING chunk (never a second caption track)
 *   approveStoryboard(…)       records approval in the project metadata (metadata.restorff.storyboard) as a commit
 *                              (history tags it: not a version), so the editor, share links and renders all see it;
 *                              a later edit that changes the storyboard makes it `stale` (storyboardApproval)
 *   commitAsClaude(…)          validate → reducer (with saved-style expanders when given) → layered caption chunks
 *                              rebuilt → compositions re-rendered in place → push the snapshot + the ops as ONE
 *                              commit, author claude, the sentence as its message; or a dry run / conflict
 */
import { apply, validateOps, type ApplyChanges, type Op, type Project as OpsProject, type StyleExpander } from "@restorffcut/timeline-ops";
import type { StyleLibrary } from "@restorffcut/styles";
import type { ProjectSnapshot } from "@/sync/snapshot";
import type { Actor } from "./auth";
import { HttpError } from "./http";
import { getProjectHead, listCommits, pushCommit, type CommitDto } from "./projects";
import { loadSet } from "./references-store";
import { planChunkRebuild, tagRebuilt, type ChunkChange } from "./storyboard-captions";
import { listCompositions } from "./storyboard-compositions";
import { importOps, isUnchanged, libraryManifests, renderChanges, renderedView, swapRendered, uploadRendered, type CompositionChange, type RenderedChange } from "./storyboard-recompose";
import { buildStoryboard, captionTracksOf, storyboardApproval, type SpokenWord, type Storyboard, type StoryboardApprovalRecord, type StoryboardApprovalState, type StoryboardInputs } from "./storyboard-rows";
import { captionTextPlan, planRevision, resolveScope, textChangeOps, toolCaptions, type CompositionEdit, type NotUnderstood, type PlannedWordFix, type RevisionPlan, type RevisionScope } from "./storyboard-revise";
import { captionFixesOf, clipWordsOnTimeline, findTranscript, recordCaptionFixes, resolveMediaFile, spokenClipsOf } from "./storyboard-transcripts";
import { guardSnapshots, guardView, measureCaptionSpans, type CaptionSpanReport, type WordGuard } from "./caption-words";
import { rebuildCaptionsCore, rebuildFromDoc, resolveWordFixes, type ExtraEdits, type LookChange } from "./captions-rebuild";
import { readEdits, saveEdits } from "./transcripts";
import type { PlacementReport } from "./transcripts-timeline";

// ─── the commit path ────────────────────────────────────────────────────────────────────────────────────────────

export type CommitOutcome =
	| ({
			ok: true;
			dry_run: boolean;
			head: string;
			commit: CommitDto | null;
			branch: string;
			changes: ApplyChanges;
			snapshot: ProjectSnapshot;
			/** Compositions re-rendered (or, in a dry run, planned): props before → after. */
			compositions: Array<Record<string, unknown>>;
			/** Layered caption chunks rebuilt. */
			captions: { chunks: number; measured: string | null; notes: string[] } | null;
			/** Compositions whose render came out identical (same code, props, length): left as they were. */
			unchanged?: string[];
	  } & CommitExtras)
	| {
			ok: false;
			code: "invalid_ops" | "conflict" | "ops_conflict" | "render_refused" | "overlap" | "layered" | "not_found" | "stopped" | "captions_failed" | "words_lost";
			message: string;
			head?: string;
			details?: unknown;
			since?: Array<{ id: string; author: string; message: string }>;
	  };

/** revise-safety: a full caption rebuild in the same commit (transcript word fixes and/or restyles of tool-built captions). */
export interface CaptionRebuildRequest {
	/** transcript = re-chunk from the transcripts (with `extra` fixes); doc = from the chunks already there (a restyle). */
	from: "transcript" | "doc";
	/** Transcript fixes by media hash, saved only when the commit is made. */
	extra?: ExtraEdits;
	looks?: LookChange[];
}

/** revise-safety: what the word guard may ignore (changes asked for) and whether it is cut-aware. */
export interface WordGuardRequest {
	fixes?: Array<{ from: string; to: string; t?: number }>;
	exclude?: string[];
	cutAware?: boolean;
	/** The person confirmed losing words: report, never refuse. */
	allowWordLoss?: boolean;
}

/** What every successful commitAsClaude adds (revise-safety). */
export interface CommitExtras {
	/** Caption words before → after (lost = gone without a reason). */
	words?: WordGuard;
	/** Caption sizes and fonts by span after the change. */
	caption_spans?: CaptionSpanReport;
	/** The full caption rebuild, when one ran. */
	rebuilt_captions?: { from: "transcript" | "doc"; chunks: number; placement: PlacementReport; outside_safe_area: number; transcript_fixes: number };
}

export async function commitAsClaude(args: {
	timelineId: string;
	ops: Op[];
	message: string;
	actor: Actor;
	baseCommit?: string;
	branch?: string;
	styles?: Record<string, StyleExpander>;
	dryRun?: boolean;
	/** Compositions to re-render in place in this same commit. */
	compositions?: CompositionChange[];
	/** Layered caption chunks to rebuild (after the ops). */
	captions?: ChunkChange[];
	/** The call's signal: an over-budget call never commits late. */
	signal?: AbortSignal;
	/** revise-safety: rebuild every caption after the ops (word fixes through the transcript, restyles of tool-built captions). */
	rebuild?: CaptionRebuildRequest;
	/** revise-safety: the word guard (always on; this says what it may ignore). */
	guard?: WordGuardRequest;
}): Promise<CommitOutcome> {
	const ops = args.ops.map((op) => ((op as { author?: string }).author ? op : ({ ...op, author: "claude" } as Op)));
	const valid = validateOps(ops);
	if (!valid.ok) return { ok: false, code: "invalid_ops", message: "Some ops are malformed; nothing was applied.", details: valid.errors.slice(0, 20) };
	const head = await getProjectHead(args.timelineId, args.branch);
	const headId = head.head.id;
	if (args.baseCommit && args.baseCommit !== headId && !(args.baseCommit.length >= 7 && headId.startsWith(args.baseCommit))) {
		const since = await listCommits(args.timelineId, { branch: head.branch, since: args.baseCommit, limit: 20 }).catch(() => null);
		return {
			ok: false,
			code: "conflict",
			message: `The timeline moved on: its head is ${headId}, not ${args.baseCommit}. Nothing was committed.`,
			head: headId,
			since: (since?.commits ?? []).map((c) => ({ id: c.id, author: c.author, message: c.message })),
		};
	}
	if (!head.snapshot) throw new HttpError(409, "the head commit has no snapshot");
	const options = { seed: `${args.timelineId}/${headId}`, at: new Date().toISOString(), mode: "atomic" as const, ...(args.styles ? { styles: args.styles } : {}) };
	const refused = (result: { conflicts: unknown[] }) => ({ ok: false as const, code: "ops_conflict" as const, message: "The reducer refused the batch (a target is missing, overlaps, or is out of range). Nothing was committed.", head: headId, details: result.conflicts.slice(0, 20) });

	// 1. the ops alone (the caption rebuild is planned on what they make)
	let allOps = ops;
	let captionReport: { chunks: number; measured: string | null; notes: string[] } | null = null;
	let tags: Array<{ ref: string; restorff: Record<string, unknown> }> = [];
	if (args.captions?.length) {
		let after = head.snapshot;
		if (ops.length) {
			const first = apply(head.snapshot as unknown as OpsProject, ops, options);
			if (!first.ok) return refused(first);
			after = first.project as unknown as ProjectSnapshot;
		}
		const rebuild = await planChunkRebuild(after, args.captions, { author: "claude" });
		if ("error" in rebuild) return { ok: false, code: "captions_failed", message: `The caption chunks could not be rebuilt: ${rebuild.error}. Nothing was committed.`, head: headId };
		allOps = [...ops, ...rebuild.ops];
		tags = rebuild.tags;
		captionReport = { chunks: rebuild.chunks.length, measured: rebuild.measure?.method ?? null, notes: rebuild.notes };
	}

	// 2. compositions: a dry run only says what would change; a real run renders them all first
	let rendered: RenderedChange[] = [];
	const unchanged: string[] = [];
	if (args.compositions?.length && !args.dryRun) {
		const done = await renderChanges(head.snapshot, args.compositions, args.signal);
		if (!done.ok) {
			const code = done.code === "refused" ? "render_refused" : done.code === "not_composition" ? "not_found" : done.code;
			return { ok: false, code, message: done.message, head: headId, details: { element_id: done.element_id, ...(done.details ? { details: done.details } : {}) } };
		}
		const snapshot0 = head.snapshot;
		rendered = done.rendered.filter((item) => {
			if (!isUnchanged(snapshot0, item)) return true;
			unchanged.push(item.change.element_id);
			return false;
		});
	}

	// 3. apply: the ops (+ chunk rebuilds), then — revise-safety — a full caption rebuild, then the composition swaps
	let batch: Op[];
	let snapshot: ProjectSnapshot;
	let changes: ApplyChanges;
	let rebuiltReport: CommitExtras["rebuilt_captions"];
	if (args.rebuild) {
		const first = apply(head.snapshot as unknown as OpsProject, allOps, options);
		if (!first.ok) return refused(first);
		const afterOps = first.project as unknown as ProjectSnapshot;
		if (tags.length) tagRebuilt(afterOps, first.changes.refs, tags);
		changes = first.changes;
		const seed = `${args.timelineId}/${headId}/revise-captions`;
		const remade =
			args.rebuild.from === "transcript"
				? await rebuildCaptionsCore({ timelineId: args.timelineId, snapshot: afterOps, seed, signal: args.signal, extra: args.rebuild.extra, look: args.rebuild.looks })
				: await rebuildFromDoc({ timelineId: args.timelineId, snapshot: afterOps, seed, signal: args.signal, look: args.rebuild.looks });
		if (!remade.ok) return { ok: false, code: "captions_failed", message: "The caption rebuild was refused by the reducer. Nothing was committed.", head: headId, details: remade.conflicts };
		snapshot = remade.built.snapshot;
		batch = [...(first.changes.applied as Op[]), ...remade.built.ops];
		const fixes = Object.values(args.rebuild.extra ?? {}).reduce((sum, list) => sum + list.length, 0);
		rebuiltReport = { from: args.rebuild.from, chunks: remade.built.build.chunks.length, placement: remade.built.placement, outside_safe_area: remade.built.outsideSafeArea.length, transcript_fixes: fixes };
		const imports = importOps(rendered);
		if (imports.length) {
			const second = apply(snapshot as unknown as OpsProject, imports, { ...options, seed: `${options.seed}/compositions` });
			if (!second.ok) return refused(second);
			snapshot = second.project as unknown as ProjectSnapshot;
			const swapped = swapRendered(snapshot, second.changes.refs, rendered);
			if (swapped) return { ok: false, code: swapped.code === "overlap" ? "overlap" : "not_found", message: swapped.message, head: headId, details: { element_id: swapped.element_id } };
			batch = [...batch, ...imports];
		}
	} else {
		batch = [...allOps, ...importOps(rendered)];
		if (!batch.length) {
			const result0 = apply(head.snapshot as unknown as OpsProject, [], options);
			return { ok: true, dry_run: Boolean(args.dryRun), head: headId, commit: null, branch: head.branch, changes: result0.changes, snapshot: head.snapshot, compositions: [], captions: captionReport, unchanged };
		}
		const result = apply(head.snapshot as unknown as OpsProject, batch, options);
		if (!result.ok) return refused(result);
		snapshot = result.project as unknown as ProjectSnapshot;
		changes = result.changes;
		if (tags.length) tagRebuilt(snapshot, result.changes.refs, tags);
		const swapped = swapRendered(snapshot, result.changes.refs, rendered);
		if (swapped) return { ok: false, code: swapped.code === "overlap" ? "overlap" : "not_found", message: swapped.message, head: headId, details: { element_id: swapped.element_id } };
	}

	// 4. revise-safety: the word guard — caption words before vs after; a drop nobody asked for is refused
	const words = guardSnapshots(head.snapshot, snapshot, { fixes: args.guard?.fixes, exclude: args.guard?.exclude, cutAware: args.guard?.cutAware });
	if (!words.ok && !args.guard?.allowWordLoss) {
		return {
			ok: false,
			code: "words_lost",
			message: `Refused: this change would remove ${words.lost.length} caption word${words.lost.length === 1 ? "" : "s"} nobody asked to remove (${words.lost
				.slice(0, 10)
				.map((word) => `"${word.text}" @ ${word.t} s`)
				.join(", ")}${words.lost.length > 10 ? " …" : ""}). Nothing was committed. To change a wrong word, fix it in the transcript: transcribe {action: "edit", fixes: [{from, to, t}]} (captions rebuilt in the same commit).`,
			head: headId,
			details: guardView(words),
		};
	}
	const spans = measureCaptionSpans(snapshot);
	const extras: CommitExtras = { words, ...(spans.chunks ? { caption_spans: spans } : {}), ...(rebuiltReport ? { rebuilt_captions: rebuiltReport } : {}) };

	if (args.dryRun) {
		const planned = (args.compositions ?? []).map((change) => ({ element_id: change.element_id, would_set: change.props ?? {}, ...(change.duration_s !== undefined ? { duration_s: change.duration_s } : {}), ...(change.source !== undefined ? { new_source: true } : {}) }));
		return { ok: true, dry_run: true, head: headId, commit: null, branch: head.branch, changes, snapshot, compositions: planned, captions: captionReport, ...extras };
	}
	await uploadRendered(args.timelineId, rendered);
	if (args.signal?.aborted) {
		return { ok: false, code: "stopped", message: "The call ran out of time before committing; nothing was committed (renders are cached: the same call again is fast).", head: headId };
	}
	const pushed = await pushCommit(args.timelineId, { base_commit: headId, branch: head.branch, author: "claude", ops: batch, snapshot, message: args.message }, args.actor);
	if (!pushed.ok) {
		return {
			ok: false,
			code: "conflict",
			message: "The timeline moved while committing. Nothing was committed.",
			head: pushed.conflict.head.id,
			since: pushed.conflict.since.map((c) => ({ id: c.id, author: c.author, message: c.message })),
		};
	}
	// the transcript fixes are saved once the commit is made (every later rebuild keeps them)
	for (const [hash, list] of Object.entries(args.rebuild?.extra ?? {})) {
		if (list.length) saveEdits(hash, [...readEdits(hash), ...list]);
	}
	return { ok: true, dry_run: false, head: headId, commit: pushed.commit, branch: pushed.branch, changes, snapshot, compositions: rendered.map(renderedView), captions: captionReport, ...(unchanged.length ? { unchanged } : {}), ...extras };
}

/**
 * revise-safety: caption word fixes → transcript edits (not saved until the commit) when the captions were built from
 * a transcript and every fix of a clause matches the transcript under it; otherwise that clause's fixes are done in
 * place on the caption chunks (pushed into `sink.ops` / `sink.caption_changes`) and recorded as transcript fixes after.
 */
export async function wordFixRoute(id: string, snapshot: ProjectSnapshot, fixes: readonly PlannedWordFix[], sink: { ops: Op[]; caption_changes: ChunkChange[] }) {
	const extra: ExtraEdits = {};
	const transcript: Array<{ from: string; to: string; t: number; media_id: string; source_t: number }> = [];
	const inPlace: Array<{ from: string; to: string; t: number; why: string }> = [];
	if (!fixes.length) return { extra, transcript, in_place: inPlace };
	const built = toolCaptions(snapshot);
	const resolved = built ? await resolveWordFixes(id, snapshot, fixes) : null;
	const byClause = new Map<string, PlannedWordFix[]>();
	for (const fix of fixes) byClause.set(fix.clause, [...(byClause.get(fix.clause) ?? []), fix]);
	for (const group of byClause.values()) {
		const hits = resolved ? group.map((fix) => resolved.resolved.find((entry) => entry.fix === fix) ?? null) : [];
		if (resolved && hits.length && hits.every((hit) => hit !== null)) {
			for (const hit of hits) {
				if (!hit) continue;
				extra[hit.hash] = [...(extra[hit.hash] ?? []), hit.edit];
				transcript.push({ from: hit.fix.from, to: hit.fix.to, t: Math.round(hit.fix.t * 100) / 100, media_id: hit.media_id, source_t: hit.source_t });
			}
			continue;
		}
		const fallback = group[0]?.fallback;
		if (fallback) {
			sink.ops.push(...fallback.ops);
			sink.caption_changes.push(...fallback.chunks);
		}
		const why = !built
			? "these captions were not built by the captions tool (no transcript link): changed in place, recorded as a transcript fix"
			: (resolved?.unresolved.find((entry) => group.some((fix) => fix === entry.fix))?.why ?? "not every word matched the transcript under it");
		for (const fix of group) inPlace.push({ from: fix.from, to: fix.to, t: Math.round(fix.t * 100) / 100, why });
	}
	return { extra, transcript, in_place: inPlace };
}

/** A plan's composition edits → the changes commitAsClaude renders. */
export function compositionChanges(edits: CompositionEdit[]): CompositionChange[] {
	return edits.map((edit) => ({
		element_id: edit.element_id,
		props: edit.props,
		before: Object.fromEntries(edit.changes.filter((change) => change.key !== "duration_s").map((change) => [change.key, change.from])),
		...(edit.duration_s !== undefined ? { duration_s: edit.duration_s } : {}),
	}));
}

// ─── read ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the pure builder cannot read from the snapshot: transcript words of spoken clips, an explainer's beats. */
export async function storyboardInputs(timelineId: string, snapshot: ProjectSnapshot): Promise<StoryboardInputs> {
	const inputs: StoryboardInputs = {};
	try {
		const words: SpokenWord[] = [];
		const cache = new Map<string, Array<{ text: string; start: number; end: number }> | null>();
		// a clip that already has captions over it speaks through them (its transcript would only repeat them)
		const captioned = captionTracksOf(snapshot).flatMap((track) => (track.elements ?? []).map((element) => [element.startTime, element.startTime + element.duration] as const));
		for (const { element } of spokenClipsOf(snapshot)) {
			if (captioned.some(([a, b]) => a < element.startTime + element.duration && b > element.startTime)) continue;
			const mediaId = element.mediaId as string;
			if (!cache.has(mediaId)) {
				let list: Array<{ text: string; start: number; end: number }> | null = null;
				try {
					const media = await resolveMediaFile(timelineId, mediaId);
					list = findTranscript(media.hash)?.words ?? null;
				} catch {
					list = null;
				}
				cache.set(mediaId, list);
			}
			const list = cache.get(mediaId);
			if (list?.length) words.push(...clipWordsOnTimeline(element, list));
		}
		if (words.length) inputs.words = words;
	} catch {
		/* transcripts are optional: captions and voice-over words still give lines */
	}
	try {
		const set = await loadSet(timelineId);
		const latest = set.versions[set.versions.length - 1];
		if (latest?.summary?.beats?.length) inputs.beats = latest.summary.beats;
	} catch {
		/* no explainer build on this timeline */
	}
	return inputs;
}

export async function getStoryboard(timelineId: string, branch?: string): Promise<{ head: string; branch: string; board: Storyboard; approval: StoryboardApprovalState; snapshot: ProjectSnapshot }> {
	const head = await getProjectHead(timelineId, branch);
	if (!head.snapshot) throw new HttpError(409, "the head commit has no snapshot");
	const inputs = await storyboardInputs(timelineId, head.snapshot);
	// an explainer's beats only while the cut still has its length (a later re-cut makes them stale)
	if (inputs.beats?.length) {
		const plain = buildStoryboard(head.snapshot);
		const last = Math.max(...inputs.beats.map((beat) => beat.end));
		if (Math.abs(last - plain.runtime) > 1.5) delete inputs.beats;
	}
	const board = buildStoryboard(head.snapshot, inputs);
	return { head: head.head.id, branch: head.branch, board, approval: storyboardApproval(head.snapshot, board), snapshot: head.snapshot };
}

/** The timeline's compositions with their params blocks (library manifests read from the package). */
export async function compositionsWithManifests(snapshot: ProjectSnapshot) {
	const plain = listCompositions(snapshot);
	const names = plain.filter((target) => !target.custom).map((target) => target.name);
	return names.length ? listCompositions(snapshot, await libraryManifests(names)) : plain;
}

// ─── edit a row ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface RowEdit {
	row: number;
	/** The row's spoken line, verbatim, as it should read. */
	caption?: string;
	/** The row's on-screen title / big word. */
	emphasis?: string;
	/** Anything else, in words, addressed to this row ("bigger captions", "warmer", "slow this down"). */
	sentence?: string;
}

export async function editStoryboardRow(args: {
	timelineId: string;
	edit: RowEdit;
	library: StyleLibrary;
	actor: Actor;
	baseCommit?: string;
	branch?: string;
	dryRun?: boolean;
	message?: string;
	signal?: AbortSignal;
	/** revise-safety: the person confirmed a caption change that drops words. */
	allowWordLoss?: boolean;
}): Promise<{
	outcome: CommitOutcome | null;
	scope: RevisionScope | null;
	labels: string[];
	plan: RevisionPlan | null;
	error?: string;
	notes: string[];
	/** revise-safety: the caption change refused because it would delete words (with the call to send instead). */
	refused?: NotUnderstood;
	/** revise-safety: how the caption's word fixes were made. */
	word_fixes?: { through_transcript?: Array<Record<string, unknown>>; in_place?: Array<Record<string, unknown>> };
}> {
	const { head, snapshot, board } = await getStoryboard(args.timelineId, args.branch);
	const row = board.rows[args.edit.row - 1];
	if (!row) return { outcome: null, scope: null, labels: [], plan: null, notes: [], error: `there is no row ${args.edit.row}: the storyboard has ${board.rows.length}` };
	const compositions = await compositionsWithManifests(snapshot);
	const ops: Op[] = [];
	const labels: string[] = [];
	const notes: string[] = [];
	const chunks: ChunkChange[] = [];
	const edits: CompositionEdit[] = [];
	const wordFixes: PlannedWordFix[] = [];
	const looks: LookChange[] = [];
	const exclude: string[] = [];
	let plan: RevisionPlan | null = null;
	let scope: RevisionScope | null = null;
	if (args.edit.sentence?.trim()) {
		plan = planRevision({ sentence: args.edit.sentence, snapshot, library: args.library, address: { beat: row.row }, board, compositions, timelineId: args.timelineId, allowWordLoss: args.allowWordLoss });
		if (plan.error) return { outcome: null, scope: null, labels: [], plan, notes: [], error: plan.error };
		scope = plan.scope;
		ops.push(...plan.ops);
		labels.push(...plan.labels);
		notes.push(...plan.notes);
		chunks.push(...plan.caption_changes);
		edits.push(...plan.compositions);
		wordFixes.push(...plan.word_fixes);
		looks.push(...plan.caption_looks);
		exclude.push(...plan.exclude_chunks);
	}
	if (!scope || scope.kind !== "beat") {
		const resolved = resolveScope(snapshot, board, { beat: row.row }, "arguments");
		if (resolved && typeof resolved !== "string") scope = resolved;
	}
	if (!scope) return { outcome: null, scope: null, labels, plan, notes, error: "the row could not be read (internal)" };
	for (const [target, text] of [
		["caption", args.edit.caption],
		["text", args.edit.emphasis],
	] as const) {
		if (typeof text !== "string" || !text.trim()) continue;
		// revise-safety: a row's new line is aligned inside its words — a word fix, a rewrite that loses no word, or refused
		if (target === "caption" && scope.caption_ids.length) {
			const planned = captionTextPlan(snapshot, scope, text.trim(), `row ${row.row} caption → "${text.trim()}"`, args.timelineId);
			if (planned.kind === "same") {
				labels.push(planned.label);
				continue;
			}
			if (planned.kind === "fix") {
				wordFixes.push(...planned.fixes);
				labels.push(planned.label);
				continue;
			}
			if (planned.kind === "loss" && !args.allowWordLoss) {
				return { outcome: null, scope, labels, plan, notes, error: planned.miss.why, refused: planned.miss };
			}
		}
		const made = textChangeOps(snapshot, scope, { target, text: text.trim(), rest: "" }, compositions);
		if ("error" in made) return { outcome: null, scope, labels, plan, notes, error: made.error };
		ops.push(...made.ops);
		chunks.push(...(made.chunks ?? []));
		edits.push(...(made.compositions ?? []));
		labels.push(made.label);
		if (made.note) notes.push(made.note);
	}
	const route = await wordFixRoute(args.timelineId, snapshot, wordFixes, { ops, caption_changes: chunks });
	const rebuild: CaptionRebuildRequest | undefined = Object.keys(route.extra).length ? { from: "transcript", extra: route.extra, looks } : looks.length ? { from: "doc", looks } : undefined;
	if (!ops.length && !chunks.length && !edits.length && !rebuild) {
		const nothing = labels.length && !plan?.not_understood.length ? `nothing to change: ${labels.join("; ")}` : plan?.not_understood.length ? "nothing in the sentence could be done for this row (see not_understood)" : "nothing to change: send caption, emphasis or sentence";
		return { outcome: null, scope, labels, plan, notes, error: nothing };
	}
	const message = args.message?.trim() || `storyboard beat ${row.row}: ${labels.join(" + ")}`.slice(0, 300);
	const outcome = await commitAsClaude({
		timelineId: args.timelineId,
		ops,
		message,
		actor: args.actor,
		baseCommit: args.baseCommit ?? head,
		branch: args.branch,
		styles: plan?.styles,
		dryRun: args.dryRun,
		captions: chunks,
		compositions: compositionChanges(edits),
		signal: args.signal,
		rebuild,
		guard: {
			fixes: [...wordFixes.map((fix) => ({ from: fix.from, to: fix.to, t: fix.t })), ...captionFixesOf(snapshot, ops, chunks).map((fix) => ({ from: fix.from, to: fix.to, t: fix.start }))],
			exclude,
			allowWordLoss: args.allowWordLoss,
		},
	});
	// the person's words become transcript fixes, so a later captions rebuild keeps them
	if (outcome.ok && outcome.commit) {
		const fixes = await recordCaptionFixes(args.timelineId, snapshot, captionFixesOf(snapshot, ops, chunks));
		if (fixes.recorded) notes.push(`${fixes.recorded} transcript fix${fixes.recorded === 1 ? "" : "es"} recorded: a captions rebuild keeps these words`);
		notes.push(...fixes.skipped);
	}
	const fixView = route.transcript.length || route.in_place.length ? { word_fixes: { ...(route.transcript.length ? { through_transcript: route.transcript } : {}), ...(route.in_place.length ? { in_place: route.in_place } : {}) } } : {};
	return { outcome, scope, labels, plan, notes, ...fixView };
}

// ─── approve ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Commit messages approve writes start with this (history tags them: not a version). */
export const APPROVAL_MESSAGE_PREFIX = "storyboard approved:";

export async function approveStoryboard(args: {
	timelineId: string;
	actor: Actor;
	by?: string;
	note?: string;
	baseCommit?: string;
	branch?: string;
}): Promise<{ already: boolean; record: StoryboardApprovalRecord; commit: CommitDto | null; board: Storyboard } | { conflict: { head: string; since: Array<{ id: string; author: string; message: string }> } }> {
	const head = await getProjectHead(args.timelineId, args.branch);
	if (!head.snapshot) throw new HttpError(409, "the head commit has no snapshot");
	if (args.baseCommit && args.baseCommit !== head.head.id && !(args.baseCommit.length >= 7 && head.head.id.startsWith(args.baseCommit))) {
		const since = await listCommits(args.timelineId, { branch: head.branch, since: args.baseCommit, limit: 20 }).catch(() => null);
		return { conflict: { head: head.head.id, since: (since?.commits ?? []).map((c) => ({ id: c.id, author: c.author, message: c.message })) } };
	}
	const { board } = await getStoryboard(args.timelineId, args.branch);
	const state = storyboardApproval(head.snapshot, board);
	if (state.status === "approved" && state.record) return { already: true, record: state.record, commit: null, board };
	const record: StoryboardApprovalRecord = {
		approved: true,
		approved_at: new Date().toISOString(),
		approved_by: args.by?.trim() || "claude",
		commit: head.head.id,
		hash: board.hash,
		rows: board.rows.length,
		...(args.note?.trim() ? { note: args.note.trim().slice(0, 500) } : {}),
	};
	const snapshot = JSON.parse(JSON.stringify(head.snapshot)) as ProjectSnapshot;
	const restorff = (snapshot.metadata.restorff && typeof snapshot.metadata.restorff === "object" ? snapshot.metadata.restorff : { opsVersion: "ops@1", pending: [], media: [] }) as Record<string, unknown>;
	restorff.storyboard = record;
	snapshot.metadata.restorff = restorff;
	const pushed = await pushCommit(
		args.timelineId,
		{ base_commit: head.head.id, branch: head.branch, author: "claude", snapshot, message: `${APPROVAL_MESSAGE_PREFIX} ${board.rows.length} beats, ${board.runtime} s${record.approved_by !== "claude" ? ` (by ${record.approved_by})` : ""}` },
		args.actor,
	);
	if (!pushed.ok) return { conflict: { head: pushed.conflict.head.id, since: pushed.conflict.since.map((c) => ({ id: c.id, author: c.author, message: c.message })) } };
	return { already: false, record, commit: pushed.commit, board };
}
