/**
 * Projects, commits and branch heads: the server half of RestorffCut's version control.
 *
 * Mechanism ported from OpenCut-AI (commits of project JSON snapshots, branches as
 * named heads; MIT, see NOTICE), with Restorff's optimistic concurrency: a push
 * names the commit it was based on, and lands only if that is still the head of
 * its branch. Otherwise the caller gets 409 and the commits it missed.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, type StoreDb } from "@/lib/db/store";
import {
	COMMIT_AUTHORS,
	type CommitAuthor,
	type CommitRow,
	type ProjectRow,
	rcCommits,
	rcHeads,
	rcProjects,
} from "@/lib/db/store-schema";
import {
	diffSnapshots,
	hashView,
	isProjectSnapshot,
	type DiffSummary,
	type ProjectSnapshot,
	snapshotStats,
	stableStringify,
} from "@/sync/snapshot";
import { apply as applyOps, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import type { Actor } from "./auth";
import { HttpError, iso } from "./http";
// mcp-gaps-mvp (2026-10-24): projects are owned by the org / user that made them; scoped callers see only theirs
import { listOwner, ownerFor, readOwner } from "./timeline-scope";

export const DEFAULT_BRANCH = "main";
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

export interface ProjectDto {
	id: string;
	name: string;
	owner: string;
	default_branch: string;
	created_at: string | null;
}

export interface CommitDto {
	id: string;
	project_id: string;
	parents: string[];
	branch: string;
	author: CommitAuthor;
	author_name: string | null;
	message: string;
	snapshot_hash: string;
	summary: DiffSummary | null;
	stats: { duration_s: number; track_count: number; element_count: number };
	ops_count: number;
	seq: number;
	created_at: string | null;
	ops?: unknown;
	snapshot?: ProjectSnapshot | null;
}

export function toProjectDto(row: ProjectRow): ProjectDto {
	return {
		id: row.id,
		name: row.name,
		owner: row.owner,
		default_branch: row.defaultBranch,
		created_at: iso(row.createdAt),
	};
}

export function toCommitDto(
	row: Partial<CommitRow> & Pick<CommitRow, "id" | "projectId">,
	opts: { snapshot?: boolean; ops?: boolean } = {},
): CommitDto {
	const ops = row.ops;
	const dto: CommitDto = {
		id: row.id,
		project_id: row.projectId,
		parents: (row.parents as string[] | undefined) ?? [],
		branch: row.branch ?? DEFAULT_BRANCH,
		author: (row.author ?? "user") as CommitAuthor,
		author_name: row.authorName ?? null,
		message: row.message ?? "",
		snapshot_hash: row.snapshotHash ?? "",
		summary: (row.summary as DiffSummary | null | undefined) ?? null,
		stats: {
			duration_s: row.durationS ?? 0,
			track_count: row.trackCount ?? 0,
			element_count: row.elementCount ?? 0,
		},
		ops_count: Array.isArray(ops) ? ops.length : 0,
		seq: Number(row.seq ?? 0),
		created_at: iso(row.createdAt ?? null),
	};
	if (opts.ops) dto.ops = ops ?? null;
	if (opts.snapshot) dto.snapshot = (row.snapshot as ProjectSnapshot | null) ?? null;
	return dto;
}

/** Commit columns without the heavy snapshot/ops payloads. */
const commitMeta = {
	id: rcCommits.id,
	projectId: rcCommits.projectId,
	parents: rcCommits.parents,
	branch: rcCommits.branch,
	author: rcCommits.author,
	authorName: rcCommits.authorName,
	snapshotHash: rcCommits.snapshotHash,
	message: rcCommits.message,
	summary: rcCommits.summary,
	durationS: rcCommits.durationS,
	trackCount: rcCommits.trackCount,
	elementCount: rcCommits.elementCount,
	seq: rcCommits.seq,
	createdAt: rcCommits.createdAt,
	ops: rcCommits.ops,
};

export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

export function snapshotHash(snapshot: ProjectSnapshot): string {
	return sha256Hex(stableStringify(hashView(snapshot)));
}

export function assertBranch(name: string): string {
	if (!BRANCH_RE.test(name)) {
		throw new HttpError(400, `invalid branch name "${name}" (letters, digits, . _ / -; max 64)`);
	}
	return name;
}

export function assertAuthor(value: unknown): CommitAuthor {
	if (typeof value !== "string" || !(COMMIT_AUTHORS as readonly string[]).includes(value)) {
		throw new HttpError(400, `author must be one of ${COMMIT_AUTHORS.join(" · ")}`);
	}
	return value as CommitAuthor;
}

export function assertSnapshot(value: unknown, projectId?: string): ProjectSnapshot {
	if (!isProjectSnapshot(value)) {
		throw new HttpError(
			400,
			"snapshot must be a project JSON (SerializedProject: {metadata: {id, name, …}, scenes: […], settings, version})",
		);
	}
	const snapshot = JSON.parse(JSON.stringify(value)) as ProjectSnapshot;
	if (projectId) snapshot.metadata.id = projectId;
	return snapshot;
}

export async function getProjectRow(db: StoreDb, id: string): Promise<ProjectRow> {
	const [row] = await db.select().from(rcProjects).where(eq(rcProjects.id, id)).limit(1);
	if (!row) throw new HttpError(404, `project ${id} not found`);
	// an org-scoped MCP call reads only its org's projects: another org's is "not found", like a missing id
	const owner = readOwner();
	if (owner && row.owner !== owner) throw new HttpError(404, `project ${id} not found`);
	return row;
}

async function headRow(db: StoreDb, projectId: string, branch: string) {
	const [row] = await db
		.select()
		.from(rcHeads)
		.where(and(eq(rcHeads.projectId, projectId), eq(rcHeads.branch, branch)))
		.limit(1);
	return row ?? null;
}

async function commitRow(db: StoreDb, projectId: string, commitId: string) {
	const [row] = await db
		.select()
		.from(rcCommits)
		.where(and(eq(rcCommits.projectId, projectId), eq(rcCommits.id, commitId)))
		.limit(1);
	return row ?? null;
}

function makeCommitId(fields: Record<string, unknown>): string {
	return sha256Hex(stableStringify(fields)).slice(0, 40);
}

interface NewCommitInput {
	projectId: string;
	parents: string[];
	branch: string;
	author: CommitAuthor;
	authorName: string;
	ops: unknown;
	snapshot: ProjectSnapshot;
	parentSnapshot: ProjectSnapshot | null;
	message: string;
}

function buildCommit(input: NewCommitInput) {
	const hash = snapshotHash(input.snapshot);
	const createdAt = new Date();
	const stats = snapshotStats(input.snapshot);
	const id = makeCommitId({
		project: input.projectId,
		parents: input.parents,
		branch: input.branch,
		author: input.author,
		snapshot_hash: hash,
		ops: input.ops ?? null,
		message: input.message,
		created_at: createdAt.toISOString(),
		nonce: randomUUID(),
	});
	return {
		id,
		projectId: input.projectId,
		parents: input.parents,
		branch: input.branch,
		author: input.author,
		authorName: input.authorName,
		ops: (input.ops ?? null) as CommitRow["ops"],
		snapshot: input.snapshot as unknown as CommitRow["snapshot"],
		delta: null,
		snapshotHash: hash,
		message: input.message,
		summary: diffSnapshots(input.parentSnapshot, input.snapshot) as unknown as CommitRow["summary"],
		durationS: stats.durationS,
		trackCount: stats.trackCount,
		elementCount: stats.elementCount,
		createdAt,
	};
}

// ─── Create ────────────────────────────────────────────────────────────────

export async function createProject(
	actor: Actor,
	body: {
		id?: string;
		name?: string;
		snapshot: unknown;
		author?: unknown;
		message?: string;
		branch?: string;
		ops?: unknown;
	},
): Promise<{ project: ProjectDto; commit: CommitDto }> {
	const db = await getDb();
	const raw = assertSnapshot(body.snapshot);
	const id = body.id ?? raw.metadata.id ?? randomUUID();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
		throw new HttpError(400, "project id must be 1-128 characters: letters, digits, . _ -");
	}
	const snapshot = assertSnapshot(raw, id);
	const name = (body.name ?? snapshot.metadata.name ?? "Untitled").slice(0, 200);
	snapshot.metadata.name = name;
	const branch = assertBranch(body.branch ?? DEFAULT_BRANCH);
	const author = body.author === undefined ? "user" : assertAuthor(body.author);

	return db.transaction(async (tx) => {
		const exists = await tx
			.select({ id: rcProjects.id })
			.from(rcProjects)
			.where(eq(rcProjects.id, id))
			.limit(1);
		if (exists.length) {
			throw new HttpError(409, `project ${id} already exists`, { project_id: id });
		}
		const [project] = await tx
			.insert(rcProjects)
			.values({ id, name, owner: ownerFor(actor), defaultBranch: branch })
			.returning();
		const values = buildCommit({
			projectId: id,
			parents: [],
			branch,
			author,
			authorName: actor.name,
			ops: body.ops,
			snapshot,
			parentSnapshot: null,
			message: body.message?.trim() || `create ${name}`,
		});
		const [commit] = await tx.insert(rcCommits).values(values).returning();
		await tx.insert(rcHeads).values({ projectId: id, branch, commitId: commit.id });
		return { project: toProjectDto(project), commit: toCommitDto(commit) };
	});
}

// ─── Read ──────────────────────────────────────────────────────────────────

/**
 * Projects, newest first. Scoped (mcp-gaps-mvp, 2026-10-24; server/timeline-scope.ts): an org-scoped MCP call or a
 * service actor with an org sees its org's projects, a signed-in user their own; local dev and a service call with no
 * org see every project, as before.
 */
export async function listProjects(actor?: Actor | null): Promise<ProjectDto[]> {
	const db = await getDb();
	const owner = listOwner(actor);
	const rows = owner
		? await db.select().from(rcProjects).where(eq(rcProjects.owner, owner)).orderBy(desc(rcProjects.createdAt)).limit(500)
		: await db.select().from(rcProjects).orderBy(desc(rcProjects.createdAt)).limit(500);
	return rows.map(toProjectDto);
}

export async function getProjectHead(
	projectId: string,
	branchName?: string,
): Promise<{ project: ProjectDto; branch: string; head: CommitDto; snapshot: ProjectSnapshot | null }> {
	const db = await getDb();
	const project = await getProjectRow(db, projectId);
	const branch = assertBranch(branchName ?? project.defaultBranch);
	const head = await headRow(db, projectId, branch);
	if (!head) throw new HttpError(404, `branch ${branch} not found in project ${projectId}`);
	const commit = await commitRow(db, projectId, head.commitId);
	if (!commit) throw new HttpError(500, `head commit ${head.commitId} is missing`);
	return {
		project: toProjectDto(project),
		branch,
		head: toCommitDto(commit),
		snapshot: (commit.snapshot as ProjectSnapshot | null) ?? null,
	};
}

export async function getCommit(
	projectId: string,
	commitId: string,
	opts: { snapshot?: boolean; ops?: boolean } = {},
): Promise<CommitDto> {
	const db = await getDb();
	await getProjectRow(db, projectId);
	const row = await resolveCommitRow(db, projectId, commitId);
	return toCommitDto(row, opts);
}

/** Accepts a full id or a unique prefix (>= 4 characters). */
async function resolveCommitRow(db: StoreDb, projectId: string, commitId: string) {
	const exact = await commitRow(db, projectId, commitId);
	if (exact) return exact;
	if (commitId.length >= 4 && /^[0-9a-f]+$/.test(commitId)) {
		const rows = await db
			.select({ id: rcCommits.id })
			.from(rcCommits)
			.where(eq(rcCommits.projectId, projectId));
		const matches = rows.filter((r) => r.id.startsWith(commitId));
		if (matches.length === 1) {
			const row = await commitRow(db, projectId, matches[0].id);
			if (row) return row;
		}
		if (matches.length > 1) throw new HttpError(400, `commit prefix ${commitId} is ambiguous`);
	}
	throw new HttpError(404, `commit ${commitId} not found in project ${projectId}`);
}

/** First-parent walk from `fromId`, newest first, stopping before `stopAt`. */
function walkFirstParents(
	all: Map<string, { parents: string[] }>,
	fromId: string,
	stopAt: string | null,
	limit: number,
): { ids: string[]; reachedStop: boolean } {
	const ids: string[] = [];
	let cursor: string | undefined = fromId;
	const seen = new Set<string>();
	while (cursor && !seen.has(cursor) && ids.length < limit) {
		if (cursor === stopAt) return { ids, reachedStop: true };
		seen.add(cursor);
		ids.push(cursor);
		cursor = all.get(cursor)?.parents[0];
	}
	return { ids, reachedStop: stopAt === null || cursor === stopAt };
}

export async function listCommits(
	projectId: string,
	opts: { branch?: string; since?: string; limit?: number; all?: boolean } = {},
): Promise<{ branch: string | null; head: string | null; commits: CommitDto[]; since_found?: boolean }> {
	const db = await getDb();
	const project = await getProjectRow(db, projectId);
	const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
	const rows = await db
		.select(commitMeta)
		.from(rcCommits)
		.where(eq(rcCommits.projectId, projectId))
		.orderBy(desc(rcCommits.seq));
	if (opts.all) {
		return { branch: null, head: null, commits: rows.slice(0, limit).map((r) => toCommitDto(r)) };
	}
	const branch = assertBranch(opts.branch ?? project.defaultBranch);
	const head = await headRow(db, projectId, branch);
	if (!head) throw new HttpError(404, `branch ${branch} not found in project ${projectId}`);
	const byId = new Map(rows.map((r) => [r.id, { ...r, parents: (r.parents as string[]) ?? [] }]));
	const walk = walkFirstParents(byId, head.commitId, opts.since ?? null, limit);
	return {
		branch,
		head: head.commitId,
		commits: walk.ids.map((id) => toCommitDto(byId.get(id)!)),
		...(opts.since ? { since_found: walk.reachedStop } : {}),
	};
}

export async function listBranches(projectId: string) {
	const db = await getDb();
	const project = await getProjectRow(db, projectId);
	const heads = await db
		.select()
		.from(rcHeads)
		.where(eq(rcHeads.projectId, projectId))
		.orderBy(asc(rcHeads.branch));
	const ids = heads.map((h) => h.commitId);
	const commits = ids.length
		? await db.select(commitMeta).from(rcCommits).where(inArray(rcCommits.id, ids))
		: [];
	const byId = new Map(commits.map((c) => [c.id, c]));
	return {
		default_branch: project.defaultBranch,
		branches: heads.map((h) => ({
			name: h.branch,
			head: byId.get(h.commitId) ? toCommitDto(byId.get(h.commitId)!) : null,
			updated_at: iso(h.updatedAt),
		})),
	};
}

export async function createBranch(projectId: string, name: string, fromCommit?: string) {
	const db = await getDb();
	const project = await getProjectRow(db, projectId);
	const branch = assertBranch(name);
	let commitId = fromCommit;
	if (!commitId) {
		const head = await headRow(db, projectId, project.defaultBranch);
		if (!head) throw new HttpError(404, "the default branch has no head");
		commitId = head.commitId;
	}
	const commit = await resolveCommitRow(db, projectId, commitId);
	const inserted = await db
		.insert(rcHeads)
		.values({ projectId, branch, commitId: commit.id })
		.onConflictDoNothing()
		.returning();
	if (!inserted.length) throw new HttpError(409, `branch ${branch} already exists`);
	return { name: branch, head: toCommitDto(commit) };
}

// ─── Push (optimistic concurrency) ─────────────────────────────────────────

export interface PushInput {
	base_commit?: unknown;
	branch?: unknown;
	author?: unknown;
	ops?: unknown;
	snapshot?: unknown;
	message?: unknown;
}

export type PushResult =
	| { ok: true; commit: CommitDto; branch: string; created_branch: boolean; changes?: unknown }
	| { ok: false; conflict: { branch: string; head: CommitDto; since: CommitDto[]; base_found: boolean } };

class ConflictSignal extends Error {
	constructor(public headId: string) {
		super("conflict");
	}
}

export async function pushCommit(
	projectId: string,
	input: PushInput,
	actor: Actor,
): Promise<PushResult> {
	const db = await getDb();
	const project = await getProjectRow(db, projectId);
	const branch = assertBranch(
		typeof input.branch === "string" && input.branch ? input.branch : project.defaultBranch,
	);
	const author = assertAuthor(input.author);
	if (typeof input.base_commit !== "string" || !input.base_commit) {
		throw new HttpError(400, "base_commit is required (the commit your snapshot was made from)");
	}
	if (typeof input.message !== "string" || !input.message.trim()) {
		throw new HttpError(400, "message is required");
	}
	if (input.ops !== undefined && input.ops !== null && !Array.isArray(input.ops)) {
		throw new HttpError(400, "ops must be an array of ops@1 objects");
	}
	const base = await resolveCommitRow(db, projectId, input.base_commit);
	const message = input.message.trim().slice(0, 2000);
	let snapshot: ProjectSnapshot;
	let storedOps: unknown = input.ops ?? null;
	let changes: unknown;
	if (input.snapshot === undefined || input.snapshot === null) {
		// Ops-only push: the server runs the ops@1 reducer on the base snapshot.
		if (!Array.isArray(input.ops) || input.ops.length === 0) {
			throw new HttpError(400, "send a snapshot, or ops (ops@1) to apply to base_commit's snapshot");
		}
		const baseSnapshot = base.snapshot as ProjectSnapshot | null;
		if (!baseSnapshot) throw new HttpError(409, "base_commit has no snapshot to apply ops to");
		const result = applyOps(baseSnapshot as unknown as OpsProject, input.ops as Op[], {
			seed: `${projectId}/${base.id}`,
			at: new Date().toISOString(),
		});
		if (!result.ok) {
			throw new HttpError(422, "ops@1 batch refused by the reducer (nothing was committed)", {
				conflicts: result.conflicts,
				changes: result.changes,
			});
		}
		snapshot = assertSnapshot(result.project, projectId);
		storedOps = result.changes.applied;
		changes = result.changes;
	} else {
		snapshot = assertSnapshot(input.snapshot, projectId);
	}
	snapshot.metadata.name = snapshot.metadata.name || project.name;

	try {
		return await db.transaction(async (tx) => {
			const head = await headRow(tx as unknown as StoreDb, projectId, branch);
			if (head && head.commitId !== base.id) throw new ConflictSignal(head.commitId);
			const values = buildCommit({
				projectId,
				parents: [base.id],
				branch,
				author,
				authorName: actor.name,
				ops: storedOps,
				snapshot,
				parentSnapshot: (base.snapshot as ProjectSnapshot | null) ?? null,
				message,
			});
			const [commit] = await tx.insert(rcCommits).values(values).returning();
			if (head) {
				const moved = await tx
					.update(rcHeads)
					.set({ commitId: commit.id, updatedAt: new Date() })
					.where(
						and(
							eq(rcHeads.projectId, projectId),
							eq(rcHeads.branch, branch),
							eq(rcHeads.commitId, base.id),
						),
					)
					.returning({ commitId: rcHeads.commitId });
				if (!moved.length) throw new ConflictSignal(head.commitId);
			} else {
				const created = await tx
					.insert(rcHeads)
					.values({ projectId, branch, commitId: commit.id })
					.onConflictDoNothing()
					.returning();
				if (!created.length) {
					const now = await headRow(tx as unknown as StoreDb, projectId, branch);
					throw new ConflictSignal(now?.commitId ?? base.id);
				}
			}
			return {
				ok: true as const,
				commit: toCommitDto(commit),
				branch,
				created_branch: !head,
				...(changes !== undefined ? { changes } : {}),
			};
		});
	} catch (error) {
		if (!(error instanceof ConflictSignal)) throw error;
		const head = await headRow(db, projectId, branch);
		const headId = head?.commitId ?? error.headId;
		const history = await listCommits(projectId, { branch, since: base.id, limit: 200 });
		const headCommit = history.commits[0] ?? toCommitDto(await resolveCommitRow(db, projectId, headId));
		return {
			ok: false,
			conflict: {
				branch,
				head: headCommit,
				since: history.commits,
				base_found: history.since_found ?? false,
			},
		};
	}
}
