/**
 * Versions that read like the reels' ("v1 cut → v2 aesthetic → v3 moody second half"), not one per commit
 * (revise-v2 agent, 2026-10-20; BUILD-BRIEF §5f, SUMMARY gap 9; paper-collage REPORT §6 item 9, neon-grid-type G-7).
 *
 *   rc_version_names   (project, commit, kind) → name: `named` (history {action:"name"}), `milestone` (one per real
 *                      revise sentence, automatic: the first one also names the cut it started from "v1 cut"), or a
 *                      `tag` that says whether a commit counts as a version (history {action:"tag"})
 *   buildHistory(…)    the commit chain with: which commits count as versions (storyboard approvals and gate fixes do
 *                      not), the named versions, and per commit what changed INSIDE its compositions (props
 *                      before → after, source line counts) — from the snapshots, so every tool's commits are covered
 *
 * The table is created here on first use (CREATE TABLE IF NOT EXISTS, once per process) like styles-store.ts does,
 * so wave-5 agents adding tables never collide on a migration id. Fold it into a numbered migration at integration.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { getDb, type StoreDb } from "@/lib/db/store";
import { rcCommits } from "@/lib/db/store-schema";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { HttpError } from "./http";
import { getCommit, listCommits } from "./projects";
import { compositionDiff, libraryNamesIn, type CompositionDiffEntry } from "./storyboard-compositions";
import { libraryManifests } from "./storyboard-recompose";

// ─── table ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const rcVersionNames = pgTable(
	"rc_version_names",
	{
		projectId: text("project_id").notNull(),
		commitId: text("commit_id").notNull(),
		/** named | milestone | tag */
		kind: text("kind").notNull(),
		/** The version's name (named, milestone) or the tag (tag: "version" | "not_a_version"). */
		name: text("name").notNull(),
		note: text("note"),
		createdBy: text("created_by"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [primaryKey({ columns: [table.projectId, table.commitId, table.kind] })],
);

const DDL = [
	`CREATE TABLE IF NOT EXISTS rc_version_names (
		project_id text NOT NULL,
		commit_id text NOT NULL,
		kind text NOT NULL,
		name text NOT NULL,
		note text,
		created_by text,
		created_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (project_id, commit_id, kind)
	)`,
	`CREATE INDEX IF NOT EXISTS rc_version_names_project_idx ON rc_version_names (project_id, created_at)`,
];

const READY_KEY = "__restorffcutVersionNamesReady";
type GlobalWithReady = typeof globalThis & { [READY_KEY]?: Promise<void> };

async function db(): Promise<StoreDb> {
	const handle = await getDb();
	const g = globalThis as GlobalWithReady;
	if (!g[READY_KEY]) {
		g[READY_KEY] = (async () => {
			for (const statement of DDL) await handle.execute(sql.raw(statement));
		})().catch((error) => {
			delete g[READY_KEY];
			throw error;
		});
	}
	await g[READY_KEY];
	return handle;
}

export interface VersionName {
	commit_id: string;
	kind: "named" | "milestone" | "tag";
	name: string;
	note: string | null;
	by: string | null;
	at: string | null;
}

export async function listVersionNames(projectId: string): Promise<VersionName[]> {
	const handle = await db();
	const rows = await handle.select().from(rcVersionNames).where(eq(rcVersionNames.projectId, projectId)).orderBy(rcVersionNames.createdAt);
	return rows.map((row) => ({ commit_id: row.commitId, kind: row.kind as VersionName["kind"], name: row.name, note: row.note ?? null, by: row.createdBy ?? null, at: row.createdAt ? row.createdAt.toISOString() : null }));
}

async function upsertName(projectId: string, commitId: string, kind: VersionName["kind"], name: string, by: string | null, note?: string | null): Promise<void> {
	const handle = await db();
	await handle
		.insert(rcVersionNames)
		.values({ projectId, commitId, kind, name, note: note ?? null, createdBy: by, createdAt: new Date() })
		.onConflictDoUpdate({ target: [rcVersionNames.projectId, rcVersionNames.commitId, rcVersionNames.kind], set: { name, note: note ?? null, createdBy: by } });
}

/** The highest "vN" among the project's version names (0 when none). */
function highestNumber(names: VersionName[]): number {
	let n = 0;
	for (const entry of names) {
		if (entry.kind === "tag") continue;
		const m = entry.name.match(/^v(\d+)\b/i);
		if (m) n = Math.max(n, Number(m[1]));
	}
	return n;
}

/** Name a commit as a version (`history {action:"name"}`). A name without "vN" gets the next number in front. */
export async function nameVersion(projectId: string, commit: string, name: string, by: string | null): Promise<VersionName> {
	const resolved = await getCommit(projectId, commit);
	const clean = name.trim().replace(/\s+/g, " ").slice(0, 80);
	if (!clean) throw new HttpError(400, "name is required");
	const names = await listVersionNames(projectId);
	const existing = names.find((entry) => entry.commit_id === resolved.id && entry.kind !== "tag");
	const number = existing?.name.match(/^v(\d+)\b/i)?.[1];
	const full = /^v\d+\b/i.test(clean) ? clean : `v${number ?? highestNumber(names) + 1} ${clean}`;
	await upsertName(projectId, resolved.id, "named", full, by);
	return { commit_id: resolved.id, kind: "named", name: full, note: null, by, at: new Date().toISOString() };
}

/** Say whether a commit counts as a version (`history {action:"tag"}`): "version" or "not_a_version". */
export async function tagCommit(projectId: string, commit: string, tag: "version" | "not_a_version", by: string | null): Promise<{ commit_id: string; tag: string }> {
	const resolved = await getCommit(projectId, commit);
	await upsertName(projectId, resolved.id, "tag", tag, by);
	return { commit_id: resolved.id, tag };
}

/**
 * A real revise commit is a milestone: "v<n> <label>". The first one on a project also names the cut it started
 * from ("v1 cut"), so history reads v1 cut → v2 aesthetic → … like the reel.
 */
export async function recordMilestone(projectId: string, commitId: string, label: string, parentId: string | null, by: string | null): Promise<{ name: string; base?: string }> {
	const names = await listVersionNames(projectId);
	const versions = names.filter((entry) => entry.kind !== "tag");
	let base: string | undefined;
	if (!versions.length && parentId) {
		base = "v1 cut";
		await upsertName(projectId, parentId, "milestone", base, by, "the cut before the first revision");
		versions.push({ commit_id: parentId, kind: "milestone", name: base, note: null, by, at: null });
	}
	const name = `v${highestNumber(versions) + 1} ${label.trim().replace(/\s+/g, " ").slice(0, 60) || "revision"}`;
	await upsertName(projectId, commitId, "milestone", name, by);
	return { name, ...(base ? { base } : {}) };
}

// ─── which commits count ────────────────────────────────────────────────────────────────────────────────────────

/** Gate fixes ("Gate fix (SAFE): …", "Fix: … (gate SAFE x6)", "… (gate FORMAT)") and storyboard approvals. */
const GATE_FIX_RE = /^gate fix\b|\(gate [A-Z]{2,}|\bgate [A-Z]{2,}\b.*\bfix|\bfix(es|ed)?\b.*\bgate\b|^check fix\b/i;
const APPROVAL_RE = /^storyboard approved:/i;

export type CommitKind = "edit" | "approval" | "gate_fix" | "revision" | "named" | "snapshot";

export function commitKind(message: string, opsCount: number): CommitKind {
	if (APPROVAL_RE.test(message)) return "approval";
	if (GATE_FIX_RE.test(message)) return "gate_fix";
	if (!opsCount) return "snapshot";
	return "edit";
}

// ─── history ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
	n: number;
	version: string | null;
	commit_id: string;
	author: string;
	author_name: string | null;
	created_at: string | null;
	note: string;
	kind: CommitKind;
	counts_as_version: boolean;
	name?: string;
	ops_count: number;
	ops: unknown;
	summary_lines: string[];
	stats: unknown;
	compositions?: CompositionDiffEntry[];
}

export interface History {
	branch: string | null;
	head: string | null;
	total_commits: number;
	/** Named versions (milestones + names) on this branch's chain, oldest first. */
	named: Array<{ version: string; commit_id: string; kind: "named" | "milestone"; at: string | null; note: string | null; by: string | null }>;
	versions_by: "names" | "commits";
	total_versions: number;
	current: { version: string | null; commits_since: number };
	entries: HistoryEntry[];
}

async function snapshotsOf(handle: StoreDb, projectId: string, ids: string[]): Promise<Map<string, ProjectSnapshot | null>> {
	const map = new Map<string, ProjectSnapshot | null>();
	if (!ids.length) return map;
	const rows = await handle.select({ id: rcCommits.id, snapshot: rcCommits.snapshot }).from(rcCommits).where(and(eq(rcCommits.projectId, projectId), inArray(rcCommits.id, ids)));
	for (const row of rows) map.set(row.id, (row.snapshot as ProjectSnapshot | null) ?? null);
	return map;
}

/** Ops that can change a composition (a new render is imported) or a whole snapshot save. */
function mayTouchCompositions(ops: unknown): boolean {
	if (!Array.isArray(ops) || !ops.length) return true;
	return (ops as Array<{ op?: string }>).some((op) => op?.op === "import_media" || op?.op === "apply_style" || op?.op === "delete" || op?.op === "insert");
}

export async function buildHistory(projectId: string, opts: { branch?: string; limit?: number } = {}): Promise<History> {
	const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
	const chain = await listCommits(projectId, { branch: opts.branch, limit: 500 });
	const commits = chain.commits; // newest first
	const total = commits.length;
	const names = await listVersionNames(projectId);
	const onChain = new Set(commits.map((commit) => commit.id));
	const tagOf = new Map(names.filter((entry) => entry.kind === "tag").map((entry) => [entry.commit_id, entry.name]));
	const nameOf = new Map<string, VersionName>();
	const milestoneOf = new Set(names.filter((entry) => entry.kind === "milestone").map((entry) => entry.commit_id));
	for (const entry of names) {
		if (entry.kind === "tag" || !onChain.has(entry.commit_id)) continue;
		const known = nameOf.get(entry.commit_id);
		if (!known || entry.kind === "named") nameOf.set(entry.commit_id, entry);
	}
	const handle = await db();
	const window = commits.slice(0, limit);
	const ids = window.map((commit) => commit.id);
	const opRows = ids.length ? await handle.select({ id: rcCommits.id, ops: rcCommits.ops }).from(rcCommits).where(and(eq(rcCommits.projectId, projectId), inArray(rcCommits.id, ids))) : [];
	const opsById = new Map(opRows.map((row) => [row.id, row.ops]));

	// counting: oldest first
	const oldestFirst = [...commits].reverse();
	const counted = new Map<string, number>();
	let count = 0;
	for (const commit of oldestFirst) {
		const tag = tagOf.get(commit.id);
		const kind = commitKind(commit.message, commit.ops_count);
		const counts = tag ? tag === "version" : kind !== "approval" && kind !== "gate_fix";
		if (counts) counted.set(commit.id, ++count);
	}
	const named = oldestFirst
		.filter((commit) => nameOf.has(commit.id))
		.map((commit) => {
			const entry = nameOf.get(commit.id) as VersionName;
			return { version: entry.name, commit_id: commit.id, kind: entry.kind as "named" | "milestone", at: entry.at, note: entry.note, by: entry.by };
		});
	const byNames = named.length > 0;

	// composition diffs for the window: the commit's snapshot against its first parent's
	const wanted = new Set<string>();
	const diffFor = new Set<string>();
	for (const commit of window) {
		if (!mayTouchCompositions(opsById.get(commit.id))) continue;
		diffFor.add(commit.id);
		wanted.add(commit.id);
		if (commit.parents[0]) wanted.add(commit.parents[0]);
	}
	const snaps = await snapshotsOf(handle, projectId, [...wanted]);
	// library compositions' params blocks: a prop the clip never stored reads as the library default, not "—"
	const libraryNames = new Set<string>();
	for (const snap of snaps.values()) for (const name of libraryNamesIn(snap)) libraryNames.add(name);
	const manifests = libraryNames.size ? await libraryManifests(libraryNames) : {};

	let latestName: string | null = null;
	let since = 0;
	for (const commit of oldestFirst) {
		const entry = nameOf.get(commit.id);
		if (entry) {
			latestName = entry.name;
			since = 0;
		} else since++;
	}
	const entries: HistoryEntry[] = window
		.map((commit, index) => {
			const kind = commitKind(commit.message, commit.ops_count);
			const nameEntry = nameOf.get(commit.id);
			const number = counted.get(commit.id);
			const version = byNames ? (nameEntry?.name ?? null) : number ? `v${number}` : null;
			const ops = opsById.get(commit.id);
			let compositions: CompositionDiffEntry[] | undefined;
			if (diffFor.has(commit.id)) {
				const after = snaps.get(commit.id) ?? null;
				const before = commit.parents[0] ? (snaps.get(commit.parents[0]) ?? null) : null;
				// a parent that could not be read would make every composition look "added": no diff then
				const diff = after && (before || !commit.parents[0]) ? compositionDiff(before, after, manifests) : [];
				if (diff.length) compositions = diff.slice(0, 24);
			}
			return {
				n: total - index,
				version,
				commit_id: commit.id,
				author: commit.author,
				author_name: commit.author_name,
				created_at: commit.created_at,
				note: commit.message,
				kind: milestoneOf.has(commit.id) ? ("revision" as const) : nameEntry?.kind === "named" && kind === "edit" ? ("named" as const) : kind,
				counts_as_version: counted.has(commit.id),
				...(nameEntry ? { name: nameEntry.name } : {}),
				ops_count: commit.ops_count,
				ops,
				summary_lines: (commit.summary?.lines ?? []).slice(0, 8),
				stats: commit.stats,
				...(compositions ? { compositions } : {}),
			};
		})
		.reverse();
	return {
		branch: chain.branch,
		head: chain.head,
		total_commits: total,
		named,
		versions_by: byNames ? "names" : "commits",
		total_versions: byNames ? named.length : count,
		current: { version: byNames ? latestName : count ? `v${count}` : null, commits_since: byNames ? since : 0 },
		entries,
	};
}

/** The newest milestone/named entry (for revise's answer). */
export async function latestVersionName(projectId: string): Promise<string | null> {
	const handle = await db();
	const [row] = await handle
		.select({ name: rcVersionNames.name })
		.from(rcVersionNames)
		.where(and(eq(rcVersionNames.projectId, projectId), inArray(rcVersionNames.kind, ["named", "milestone"])))
		.orderBy(desc(rcVersionNames.createdAt))
		.limit(1);
	return row?.name ?? null;
}
