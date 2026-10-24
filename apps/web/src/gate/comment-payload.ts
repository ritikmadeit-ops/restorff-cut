/**
 * The body the gate POSTs to the comments API (`POST /api/projects/:id/comments`, port agent's
 * server/comments.ts `importFindings`) — ui-fix-timeline agent, 2026-10-21, QA 2026-10-20 #30.
 *
 * What the API accepts: `{findings: [finding@1…], commit_id?}` where each finding has id · rule · severity · status ·
 * t · message · fix (none null), severity must · should · info, `track` one of the seven finding@1 lanes or absent,
 * `t` seconds ≥ 0. It answers **400 when nothing was imported** — which is what a clean re-run sent (`findings: []`,
 * QA's scratch duplicate: 0 timeline findings + the file half not run), so the editor fell back to local markers.
 *
 * Also closes the gap behind QA #10's duplicate R5: a run only marked as fixed the findings of its own in-memory
 * previous report, so after a reload a finding whose element was replaced stayed open on the server while the new
 * element's copy was posted under a new id. Open gate comments that this run re-checked (their rule ran, completely)
 * and no longer finds (by finding id) are now sent back as `fixed`.
 *
 * Pure: no editor, no fetch. Tests: gate/__tests__/comment-payload.test.ts.
 */
import { type CheckRun, type Finding, type FindingTrack, fixedSince } from "@restorffcut/gate";

/** finding@1's lanes (server/comments.ts FINDING_TRACKS). */
export const COMMENT_LANES: ReadonlySet<string> = new Set([
	"TEXT",
	"CAPTIONS",
	"V2 B-ROLL",
	"V1 A-ROLL",
	"MUSIC",
	"SFX",
	"MASTER",
]);
const SEVERITIES: ReadonlySet<string> = new Set(["must", "should", "info"]);

/** The fields of a stored comment this module reads (sync/remote.ts RemoteComment has them all). */
export interface ExistingComment {
	id: string;
	finding_id: string | null;
	author: string;
	status: "open" | "resolved";
	rule_id: string | null;
	severity: string | null;
	time_s: number;
	time_end_s: number | null;
	track_id: string | null;
	track_name: string | null;
	element_id: string | null;
	commit_id: string | null;
	body: string;
	parent_id?: string | null;
}

/** One finding as the API's finding@1 import takes it, or null when it cannot be sent (no id / rule, bad severity). */
export function toCommentFinding(f: Finding): Finding | null {
	if (!f || typeof f.id !== "string" || !f.id || typeof f.rule !== "string" || !f.rule) return null;
	if (!SEVERITIES.has(String(f.severity))) return null;
	const t = typeof f.t === "number" && Number.isFinite(f.t) && f.t >= 0 ? f.t : 0;
	const tEnd = typeof f.t_end === "number" && Number.isFinite(f.t_end) && f.t_end >= t ? f.t_end : null;
	const track = typeof f.track === "string" && COMMENT_LANES.has(f.track) ? f.track : null;
	return {
		...f,
		t,
		t_end: tEnd,
		track,
		// The real lane stays readable when it is not one of the seven (e.g. MOTION).
		track_name: f.track_name ?? (typeof f.track === "string" && !track ? f.track : null),
		status: f.status ?? "open",
		message: String(f.message ?? ""),
		fix: String(f.fix ?? ""),
	};
}

/** Rules this run checked completely: ran in some half and not listed as not run in any. */
export function rulesChecked(runs: ReadonlyArray<CheckRun | null | undefined>): Set<string> {
	const ran = new Set<string>();
	const notRun = new Set<string>();
	for (const run of runs) {
		if (!run) continue;
		for (const rule of run.ran ?? []) ran.add(rule);
		for (const n of run.not_run ?? []) notRun.add(n.rule);
	}
	for (const rule of notRun) ran.delete(rule);
	return ran;
}

function splitBody(body: string): { message: string; fix: string } {
	const at = body.lastIndexOf(" → ");
	return at > 0 ? { message: body.slice(0, at).trim(), fix: body.slice(at + 3).trim() } : { message: body.trim(), fix: "" };
}

/**
 * Open gate comments (author `gate:…`) whose rule this run checked completely and whose finding id is not among
 * `keepIds`: rebuilt as finding@1 with status `fixed` (the upsert by finding id then resolves them).
 */
export function staleGateFindings({
	existing,
	keepIds,
	checked,
}: {
	existing: ReadonlyArray<ExistingComment>;
	keepIds: ReadonlySet<string>;
	checked: ReadonlySet<string>;
}): Finding[] {
	const out: Finding[] = [];
	for (const c of existing) {
		if (c.parent_id || c.status !== "open" || !c.finding_id || !c.rule_id) continue;
		if (!c.author.startsWith("gate:") || c.id.startsWith("gate-local:")) continue;
		if (!checked.has(c.rule_id) || keepIds.has(c.finding_id)) continue;
		if (!SEVERITIES.has(String(c.severity))) continue;
		const { message, fix } = splitBody(c.body ?? "");
		const lane = c.track_name && COMMENT_LANES.has(c.track_name) ? (c.track_name as FindingTrack) : null;
		out.push({
			id: c.finding_id,
			rule: c.rule_id,
			severity: c.severity as Finding["severity"],
			status: "fixed",
			t: c.time_s,
			t_end: c.time_end_s,
			track: lane,
			track_id: c.track_id,
			track_name: c.track_name,
			element_id: c.element_id,
			evidence: "TIMELINE",
			message,
			fix,
			source: c.author,
			commit: c.commit_id,
			resolved_by: "re-measure",
		});
	}
	return out;
}

/**
 * The POST body, or null when there is nothing to send (never an empty import: the API answers it with 400).
 * `runs` = this report's check runs (timeline + file); without them no stale comment is closed.
 */
export function gateCommentPayload({
	findings,
	previous,
	existing,
	runs,
	commitId,
}: {
	findings: ReadonlyArray<Finding>;
	previous: ReadonlyArray<Finding>;
	existing: ReadonlyArray<ExistingComment>;
	runs?: ReadonlyArray<CheckRun | null | undefined>;
	commitId?: string | null;
}): { findings: Finding[]; commit_id?: string } | null {
	const gone = fixedSince([...previous], [...findings]);
	const keepIds = new Set([...findings, ...gone].map((f) => f.id));
	const stale = runs ? staleGateFindings({ existing, keepIds, checked: rulesChecked(runs) }) : [];
	const seen = new Set<string>();
	const out: Finding[] = [];
	for (const raw of [...findings, ...gone, ...stale]) {
		const f = toCommentFinding(raw);
		if (!f || seen.has(f.id)) continue;
		seen.add(f.id);
		out.push(f);
	}
	if (out.length === 0) return null;
	return commitId ? { findings: out, commit_id: commitId } : { findings: out };
}
