/**
 * Review comments anchored to the timeline (time, track, element), and the
 * import of Judge findings (finding@1) as comments.
 *
 * Comment model ported from OpenCut-AI's review comments (MIT, see NOTICE),
 * extended with rule id, severity and status for Restorff's export gate
 * (docs/restorff/EXPORT-GATE.md §3 "Pinning").
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { getDb, type StoreDb } from "@/lib/db/store";
import {
	COMMENT_SEVERITIES,
	COMMENT_STATUSES,
	type CommentSeverity,
	type CommentStatus,
	type ReviewCommentRow,
	rcCommits,
	rcHeads,
	rcReviewComments,
} from "@/lib/db/store-schema";
import {
	mainScene,
	orderedTracks,
	type ProjectSnapshot,
	secondsToTicks,
	type SnapshotTrack,
} from "@/sync/snapshot";
import { HttpError, iso, num, str } from "./http";
import { getProjectRow } from "./projects";

export interface CommentDto {
	id: string;
	project_id: string;
	commit_id: string | null;
	share_link_id: string | null;
	time_s: number;
	time_end_s: number | null;
	track_id: string | null;
	track_name: string | null;
	element_id: string | null;
	author: string;
	body: string;
	rule_id: string | null;
	severity: CommentSeverity | null;
	status: CommentStatus;
	parent_id: string | null;
	finding_id: string | null;
	finding?: unknown;
	resolved_by: string | null;
	resolved_at: string | null;
	created_at: string | null;
}

export function toCommentDto(row: ReviewCommentRow, withFinding = false): CommentDto {
	return {
		id: row.id,
		project_id: row.projectId,
		commit_id: row.commitId,
		share_link_id: row.shareLinkId,
		time_s: row.timeS,
		time_end_s: row.timeEndS,
		track_id: row.trackId,
		track_name: row.trackName,
		element_id: row.elementId,
		author: row.author,
		body: row.body,
		rule_id: row.ruleId,
		severity: row.severity ?? null,
		status: row.status,
		parent_id: row.parentId,
		finding_id: row.findingId,
		...(withFinding ? { finding: row.finding } : {}),
		resolved_by: row.resolvedBy,
		resolved_at: iso(row.resolvedAt),
		created_at: iso(row.createdAt),
	};
}

export async function listComments(
	projectId: string,
	opts: { commit?: string; status?: string; withFinding?: boolean } = {},
): Promise<CommentDto[]> {
	const db = await getDb();
	await getProjectRow(db, projectId);
	const where = [eq(rcReviewComments.projectId, projectId)];
	if (opts.commit) where.push(eq(rcReviewComments.commitId, opts.commit));
	if (opts.status) {
		if (!(COMMENT_STATUSES as readonly string[]).includes(opts.status)) {
			throw new HttpError(400, `status must be ${COMMENT_STATUSES.join(" or ")}`);
		}
		where.push(eq(rcReviewComments.status, opts.status as CommentStatus));
	}
	const rows = await db
		.select()
		.from(rcReviewComments)
		.where(and(...where))
		.orderBy(asc(rcReviewComments.timeS), asc(rcReviewComments.createdAt));
	return rows.map((r) => toCommentDto(r, opts.withFinding));
}

// ─── Pinning (EXPORT-GATE.md §3) ───────────────────────────────────────────

/** Track a finding pins to when the file could not say (§3 step 1). */
const RULE_TRACK: Record<string, string> = {
	LOUD: "MASTER",
	FORMAT: "MASTER",
	MIX: "MUSIC",
	R12: "MUSIC",
	R21: "MUSIC",
	R22: "MUSIC",
	R4: "SFX",
	R23: "SFX",
	CAP: "CAPTIONS",
	"CAP-LEN": "CAPTIONS",
	R18: "CAPTIONS",
	SAFE: "CAPTIONS",
	R3: "TEXT",
	R15: "TEXT",
	CLIP: "V1 A-ROLL",
	LIP: "V1 A-ROLL",
	CLAIM: "V1 A-ROLL",
	BRIEF: "V1 A-ROLL",
};
/** Rules pinned to the top-most visible video element at t. */
const TOP_VIDEO_RULES = new Set(["CLEAN", "R1", "R5", "R6", "TAIL", "FIRST"]);

function norm(name: string | undefined): string {
	return (name ?? "").trim().toUpperCase();
}

function elementAt(track: SnapshotTrack, ticks: number) {
	return (track.elements ?? []).find(
		(el) => !el.hidden && el.startTime <= ticks && ticks < el.startTime + el.duration,
	);
}

export interface Pin {
	track_id: string | null;
	track_name: string | null;
	element_id: string | null;
}

/** Resolve a track name (or a rule's default track) and hit-test the element at t. */
export function pinToTimeline(
	snapshot: ProjectSnapshot | null,
	opts: { trackName?: string | null; trackId?: string | null; rule?: string | null; t: number },
): Pin {
	const tracks = orderedTracks(snapshot ? mainScene(snapshot) : null);
	const ticks = secondsToTicks(opts.t);
	if (opts.trackId) {
		const found = tracks.find((t) => t.track.id === opts.trackId);
		if (found) {
			return {
				track_id: found.track.id,
				track_name: found.track.name ?? null,
				element_id: elementAt(found.track, ticks)?.id ?? null,
			};
		}
	}
	let wanted = opts.trackName ? norm(opts.trackName) : "";
	const rule = opts.rule ? opts.rule.toUpperCase() : "";
	if (!wanted && rule && TOP_VIDEO_RULES.has(rule)) {
		for (const { track } of tracks) {
			if (track.type !== "video" || track.hidden) continue;
			const el = elementAt(track, ticks);
			if (el) return { track_id: track.id, track_name: track.name ?? null, element_id: el.id };
		}
		wanted = "V1 A-ROLL";
	}
	if (!wanted && rule) wanted = RULE_TRACK[rule] ?? "";
	if (!wanted) return { track_id: null, track_name: null, element_id: null };
	if (wanted === "MASTER") return { track_id: null, track_name: "MASTER", element_id: null };
	const match =
		tracks.find((t) => norm(t.track.name) === wanted) ??
		(wanted === "V1 A-ROLL" ? tracks.find((t) => t.group === "main") : undefined) ??
		(wanted === "CAPTIONS"
			? tracks.find((t) => t.track.restorff?.role === "caption")
			: undefined) ??
		(wanted === "SFX" ? tracks.find((t) => t.track.restorff?.role === "sfx") : undefined);
	if (!match) return { track_id: null, track_name: wanted, element_id: null };
	return {
		track_id: match.track.id,
		track_name: match.track.name ?? wanted,
		element_id: elementAt(match.track, ticks)?.id ?? null,
	};
}

async function snapshotFor(db: StoreDb, projectId: string, commitId: string | null) {
	let id = commitId;
	if (!id) {
		const project = await getProjectRow(db, projectId);
		const [head] = await db
			.select()
			.from(rcHeads)
			.where(and(eq(rcHeads.projectId, projectId), eq(rcHeads.branch, project.defaultBranch)))
			.limit(1);
		id = head?.commitId ?? null;
	}
	if (!id) return { commitId: null, snapshot: null };
	const [row] = await db
		.select({ id: rcCommits.id, snapshot: rcCommits.snapshot })
		.from(rcCommits)
		.where(and(eq(rcCommits.projectId, projectId), eq(rcCommits.id, id)))
		.limit(1);
	return {
		commitId: row?.id ?? null,
		snapshot: (row?.snapshot as ProjectSnapshot | null) ?? null,
	};
}

// ─── Create ────────────────────────────────────────────────────────────────

export interface CommentInput {
	time_s?: unknown;
	time_end_s?: unknown;
	track_id?: unknown;
	track_name?: unknown;
	element_id?: unknown;
	author?: unknown;
	body?: unknown;
	rule_id?: unknown;
	severity?: unknown;
	parent_id?: unknown;
	commit_id?: unknown;
}

function severityOf(value: unknown): CommentSeverity | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || !(COMMENT_SEVERITIES as readonly string[]).includes(value)) {
		throw new HttpError(400, `severity must be one of ${COMMENT_SEVERITIES.join(" · ")}`);
	}
	return value as CommentSeverity;
}

export async function createComment(
	projectId: string,
	input: CommentInput,
	opts: { defaultAuthor: string; shareLinkId?: string | null; commitId?: string | null },
): Promise<CommentDto> {
	const db = await getDb();
	await getProjectRow(db, projectId);
	const t = num(input.time_s, "time_s", { min: 0 })!;
	const tEnd = num(input.time_end_s, "time_end_s", { optional: true, min: 0 }) ?? null;
	const body = str(input.body, "body", { max: 5000 })!.trim();
	if (!body) throw new HttpError(400, "body is required");
	const author = (str(input.author, "author", { optional: true, max: 120 }) ?? opts.defaultAuthor).trim();
	const parentId = str(input.parent_id, "parent_id", { optional: true }) ?? null;
	if (parentId) {
		const [parent] = await db
			.select({ id: rcReviewComments.id })
			.from(rcReviewComments)
			.where(and(eq(rcReviewComments.projectId, projectId), eq(rcReviewComments.id, parentId)))
			.limit(1);
		if (!parent) throw new HttpError(404, `parent comment ${parentId} not found`);
	}
	const requestedCommit =
		opts.commitId ?? str(input.commit_id, "commit_id", { optional: true }) ?? null;
	const { commitId, snapshot } = await snapshotFor(db, projectId, requestedCommit);
	const pin = pinToTimeline(snapshot, {
		trackId: str(input.track_id, "track_id", { optional: true }) ?? null,
		trackName: str(input.track_name, "track_name", { optional: true }) ?? null,
		rule: str(input.rule_id, "rule_id", { optional: true }) ?? null,
		t,
	});
	const explicitElement = str(input.element_id, "element_id", { optional: true }) ?? null;
	const [row] = await db
		.insert(rcReviewComments)
		.values({
			id: randomUUID(),
			projectId,
			commitId,
			shareLinkId: opts.shareLinkId ?? null,
			timeS: t,
			timeEndS: tEnd,
			trackId: pin.track_id,
			trackName: pin.track_name,
			elementId: explicitElement ?? pin.element_id,
			author,
			body,
			ruleId: str(input.rule_id, "rule_id", { optional: true, max: 32 }) ?? null,
			severity: severityOf(input.severity),
			status: "open",
			parentId,
		})
		.returning();
	return toCommentDto(row);
}

// ─── Findings import (finding@1) ───────────────────────────────────────────

const FINDING_REQUIRED = ["id", "rule", "severity", "status", "t", "message", "fix"] as const;
const FINDING_TRACKS = new Set(["TEXT", "CAPTIONS", "V2 B-ROLL", "V1 A-ROLL", "MUSIC", "SFX", "MASTER"]);

export interface FindingImportResult {
	imported: CommentDto[];
	errors: Array<{ index: number; id?: string; error: string }>;
}

export function looksLikeFinding(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.rule === "string" && typeof v.t === "number" && "fix" in v;
}

export async function importFindings(
	projectId: string,
	findings: unknown[],
	opts: { commitId?: string | null } = {},
): Promise<FindingImportResult> {
	const db = await getDb();
	await getProjectRow(db, projectId);
	const result: FindingImportResult = { imported: [], errors: [] };
	const snapshots = new Map<string, Awaited<ReturnType<typeof snapshotFor>>>();

	for (const [index, raw] of findings.entries()) {
		const f = raw as Record<string, unknown>;
		const missing = FINDING_REQUIRED.filter((k) => f?.[k] === undefined || f?.[k] === null);
		if (!f || typeof f !== "object" || missing.length) {
			result.errors.push({
				index,
				id: typeof f?.id === "string" ? f.id : undefined,
				error: `not a finding@1: missing ${missing.join(", ")}`,
			});
			continue;
		}
		try {
			const severity = String(f.severity);
			if (!["must", "should", "info"].includes(severity)) {
				throw new Error(`severity "${severity}" is not must · should · info`);
			}
			const t = Number(f.t);
			if (!Number.isFinite(t) || t < 0) throw new Error("t must be seconds >= 0");
			const tEnd = typeof f.t_end === "number" && Number.isFinite(f.t_end) ? f.t_end : null;
			const track = typeof f.track === "string" ? f.track : null;
			if (track && !FINDING_TRACKS.has(track)) throw new Error(`unknown track "${track}"`);
			const status = String(f.status);
			const resolved = status === "dismissed" || status === "fixed";
			// The finding's own commit wins when the store knows it; else the request's; else head.
			const candidates = [
				typeof f.commit === "string" && f.commit ? f.commit : null,
				opts.commitId ?? null,
				null, // head of the default branch
			].filter((c, i, all) => all.indexOf(c) === i);
			let target: Awaited<ReturnType<typeof snapshotFor>> = { commitId: null, snapshot: null };
			for (const candidate of candidates) {
				const key = candidate ?? "__head__";
				if (!snapshots.has(key)) snapshots.set(key, await snapshotFor(db, projectId, candidate));
				target = snapshots.get(key)!;
				if (target.commitId) break;
			}
			const pin = pinToTimeline(target.snapshot, {
				trackName: track,
				// gate-v2: a finding that names its real lane (track_id) is pinned to that lane, not the role's default
				trackId: typeof f.track_id === "string" && f.track_id ? f.track_id : null,
				rule: String(f.rule),
				t,
			});
			const elementId = typeof f.element_id === "string" && f.element_id ? f.element_id : pin.element_id;
			const body = `${String(f.message)} → ${String(f.fix)}`;
			const author = typeof f.source === "string" && f.source ? f.source : "judge";
			const values = {
				id: randomUUID(),
				projectId,
				commitId: target.commitId,
				shareLinkId: null,
				timeS: t,
				timeEndS: tEnd,
				trackId: pin.track_id,
				trackName: pin.track_name ?? track,
				elementId,
				author,
				body,
				ruleId: String(f.rule),
				severity: severity as CommentSeverity,
				status: (resolved ? "resolved" : "open") as CommentStatus,
				parentId: null,
				findingId: String(f.id),
				finding: f as ReviewCommentRow["finding"],
				resolvedBy: resolved
					? (typeof f.resolved_by === "string" && f.resolved_by) || (status === "fixed" ? "re-measure" : "dismissed")
					: null,
				resolvedAt: resolved ? new Date() : null,
			};
			const { id: _id, ...updatable } = values;
			const [row] = await db
				.insert(rcReviewComments)
				.values(values)
				.onConflictDoUpdate({
					target: [rcReviewComments.projectId, rcReviewComments.findingId],
					set: updatable,
				})
				.returning();
			result.imported.push(toCommentDto(row));
		} catch (error) {
			result.errors.push({
				index,
				id: String(f.id),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}

// ─── Update ────────────────────────────────────────────────────────────────

export async function updateComment(
	projectId: string,
	commentId: string,
	patch: { status?: unknown; body?: unknown; resolved_by?: unknown },
	actorName: string,
): Promise<CommentDto> {
	const db = await getDb();
	const set: Partial<ReviewCommentRow> = {};
	if (patch.status !== undefined) {
		if (typeof patch.status !== "string" || !(COMMENT_STATUSES as readonly string[]).includes(patch.status)) {
			throw new HttpError(400, `status must be ${COMMENT_STATUSES.join(" or ")}`);
		}
		set.status = patch.status as CommentStatus;
		const resolved = patch.status === "resolved";
		set.resolvedAt = resolved ? new Date() : null;
		set.resolvedBy = resolved
			? (str(patch.resolved_by, "resolved_by", { optional: true }) ?? actorName)
			: null;
	}
	if (patch.body !== undefined) set.body = str(patch.body, "body", { max: 5000 })!;
	if (!Object.keys(set).length) throw new HttpError(400, "nothing to update (status or body)");
	const [row] = await db
		.update(rcReviewComments)
		.set(set)
		.where(and(eq(rcReviewComments.projectId, projectId), eq(rcReviewComments.id, commentId)))
		.returning();
	if (!row) throw new HttpError(404, `comment ${commentId} not found`);
	return toCommentDto(row);
}
