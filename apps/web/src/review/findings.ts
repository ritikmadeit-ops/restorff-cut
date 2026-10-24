/**
 * Pure helpers for the judge finding card (design/edit-artboard.png, JUDGE row: a 360 px card opened from a marker).
 * A marker is a review comment (port agent's comments API, `finding@1` imported as a comment) or a local gate finding
 * (`gate-local:*`, gate agent). The card shows the finding's rule, severity, time, the fix in plain words and who
 * raised it; this file turns the comment (+ the original finding@1 when known) into that text.
 *
 * Machine fix (Restorff extension, polish agent 2026-10-20): a finding may carry `fix_ops`, an ops@1 array the
 * timeline can apply (e.g. `[{op:"move", el:"el-endcard", t:23, author:"user"}]` for "Move the end card to 0:23").
 * finding@1's canonical schema has `additionalProperties: false`, so `fix_ops` is NOT in it yet — the comments API
 * stores the whole object and returns it with `?finding=1`. Proposal for the schema owner: add `fix_ops` (optional,
 * ops@1 array) to restorff/workers/judge/schemas/finding.schema.json.
 */
import type { MarkerComment } from "./markers";

/** The fields of finding@1 the card reads (all optional: a reviewer comment has none of them). */
export interface CardFinding {
	id?: string;
	rule?: string;
	severity?: string;
	t?: number;
	t_end?: number | null;
	message?: string;
	fix?: string;
	source?: string;
	judges?: string[];
	evidence?: string;
	status?: string;
	fix_ops?: unknown[];
}

export interface CardComment extends MarkerComment {
	element_id: string | null;
	track_id: string | null;
	finding_id: string | null;
}

/** "Restorff Sell" from "judge:restorff-sell@1.2"; "Judge worker" from "worker:judge@0.1.0"; "export gate"… */
export function sourceLabel(source: string): string {
	const s = source.trim();
	if (!s) return "unknown";
	const [kind, rest = ""] = s.includes(":") ? [s.slice(0, s.indexOf(":")), s.slice(s.indexOf(":") + 1)] : [s, ""];
	const name = rest.replace(/@.*$/, "");
	switch (kind.toLowerCase()) {
		case "judge":
			return name ? titleCase(name) : "Judge";
		case "worker":
			return name === "judge" || !name ? "Judge worker" : `${titleCase(name)} worker`;
		case "gate":
			return "export gate";
		case "claude":
			return "Claude";
		case "compiler":
			return "compiler";
		case "user":
			return name ? name : "you";
		case "reviewer":
			return name ? `${name} (review link)` : "reviewer";
		default:
			return rest ? s : titleCaseIfSlug(s);
	}
}

function titleCase(slug: string): string {
	return slug
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

function titleCaseIfSlug(value: string): string {
	return /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(value) ? titleCase(value) : value;
}

/** Who raised it: every judge that raised it after merging (finding.judges), else its source, else the author. */
export function raisedBy(comment: Pick<MarkerComment, "author">, finding: CardFinding | null): string {
	const judges = (finding?.judges ?? []).filter((j) => typeof j === "string" && j.trim());
	if (judges.length) return [...new Set(judges.map(sourceLabel))].join(" + ");
	if (finding?.source) return sourceLabel(finding.source);
	return sourceLabel(comment.author);
}

/** The finding's sentence and its fix. Comments store `message → fix` (server/comments.ts, gate/run.ts). */
export function messageAndFix(
	comment: Pick<MarkerComment, "body">,
	finding: CardFinding | null,
): { message: string; fix: string | null } {
	if (finding?.message) return { message: finding.message, fix: finding.fix?.trim() || null };
	const body = comment.body ?? "";
	const at = body.lastIndexOf(" → ");
	if (at > 0) return { message: body.slice(0, at).trim(), fix: body.slice(at + 3).trim() || null };
	return { message: body.trim(), fix: null };
}

/** Sentence-case the first letter ("move the music…" → "Move the music…") for a button or a line. */
export function sentenceCase(text: string): string {
	return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * "MUST · R15 · 0:26" — severity (or NOTE for a reviewer comment) · rule · time. The span's end is not repeated:
 * the JUDGE row draws it as a bar, and the artboard's heading is one line ("MUST · 0:26 · Restorff Sell + …").
 */
export function cardHeading(comment: MarkerComment, formatTime: (s: number) => string): string {
	const severity = (comment.severity ?? "note").toUpperCase();
	return [severity, comment.rule_id, formatTime(comment.time_s)].filter(Boolean).join(" · ");
}

/** The ops@1 machine fix a finding carries, if it is a non-empty array of op objects. */
export function fixOpsOf(finding: CardFinding | null): Record<string, unknown>[] | null {
	const ops = finding?.fix_ops;
	if (!Array.isArray(ops) || ops.length === 0) return null;
	if (!ops.every((op) => op && typeof op === "object" && typeof (op as { op?: unknown }).op === "string")) return null;
	return ops as Record<string, unknown>[];
}

/**
 * A JUDGE-row marker as the artboard draws it: a 14 px square, radius 4 (DOM, artboard "6 · Edit"). Colours:
 * selected = neon with the artboard's glow (the view's one isolate); open must = stale amber (BUILD-BRIEF/polish
 * brief, port's markers.ts) — the artboard and EXPORT-GATE §3 both draw an open must neon: an open design question,
 * see worklog/polish.md; should = #5A5A63 (artboard); info = fog outline; reviewer notes = bone outline; resolved =
 * faded fog outline.
 */
export interface JudgeMarkerStyle {
	background: string;
	border: string;
	boxShadow: string;
	opacity: number;
	/** Colour of the thin bar drawn under a span finding (t → t_end). */
	bar: string;
}

export const JUDGE_MARKER_SIZE_PX = 14;

export function judgeMarkerStyle(comment: Pick<MarkerComment, "severity" | "status">, selected: boolean): JudgeMarkerStyle {
	const none = "none";
	if (selected) {
		return {
			background: "var(--rc-neon)",
			border: "1.5px solid var(--rc-neon)",
			boxShadow: "0 0 18px rgba(246, 255, 0, 0.5)",
			opacity: 1,
			bar: "var(--rc-neon)",
		};
	}
	if (comment.status === "resolved") {
		return { background: "transparent", border: "1.5px solid var(--rc-fog)", boxShadow: none, opacity: 0.45, bar: "var(--rc-fog)" };
	}
	switch (comment.severity) {
		case "must":
			return { background: "var(--rc-stale)", border: "1.5px solid var(--rc-stale)", boxShadow: none, opacity: 1, bar: "var(--rc-stale)" };
		case "should":
			return { background: "#5A5A63", border: "1.5px solid #5A5A63", boxShadow: none, opacity: 1, bar: "#5A5A63" };
		case "info":
			return { background: "transparent", border: "1.5px solid var(--rc-fog)", boxShadow: none, opacity: 0.85, bar: "var(--rc-fog)" };
		default:
			return { background: "transparent", border: "1.5px solid var(--rc-bone)", boxShadow: none, opacity: 0.9, bar: "var(--rc-bone)" };
	}
}

/** Local gate findings live in the browser only (gate/run.ts `localComment`); they resolve in the store, not on the server. */
export function isLocalGateComment(id: string): boolean {
	return id.startsWith("gate-local:");
}
