/**
 * RestorffCut's server-side project store: projects, commits, branch heads,
 * share links and review comments.
 *
 * The mechanism (commits of project JSON snapshots, branches as named heads,
 * token share links, review comments anchored to time/track/element) is ported
 * from OpenCut-AI's version control (MIT, Copyright 2025 OpenCut-AI; see NOTICE),
 * re-shaped for RestorffCut's project model (wasm MediaTime ticks, ops@1).
 *
 * The SQL that creates these tables lives in ./store-migrations.ts and runs at
 * startup; keep the two in step.
 */
import {
	bigint,
	bigserial,
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const COMMIT_AUTHORS = ["user", "claude", "compiler", "preset"] as const;
export type CommitAuthor = (typeof COMMIT_AUTHORS)[number];

export const COMMENT_SEVERITIES = ["must", "should", "could", "info"] as const;
export type CommentSeverity = (typeof COMMENT_SEVERITIES)[number];

export const COMMENT_STATUSES = ["open", "resolved"] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const rcProjects = pgTable("rc_projects", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	owner: text("owner").notNull(),
	defaultBranch: text("default_branch").notNull().default("main"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const rcCommits = pgTable(
	"rc_commits",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => rcProjects.id, { onDelete: "cascade" }),
		/** Parent commit ids, first parent first (a merge would carry two). */
		parents: jsonb("parents").$type<string[]>().notNull().default([]),
		branch: text("branch").notNull(),
		author: text("author").$type<CommitAuthor>().notNull(),
		/** Who exactly: "service", "local-dev", or a user id. */
		authorName: text("author_name"),
		/** The ops@1 batch behind this commit, as applied (optional). */
		ops: jsonb("ops"),
		/** The full project JSON (SerializedProject). */
		snapshot: jsonb("snapshot"),
		/** Reserved for delta storage (always null today: every commit is a snapshot). */
		delta: jsonb("delta"),
		snapshotHash: text("snapshot_hash").notNull(),
		message: text("message").notNull(),
		/** Diff summary against the first parent (src/sync/snapshot.ts diffSnapshots). */
		summary: jsonb("summary"),
		durationS: doublePrecision("duration_s").notNull().default(0),
		trackCount: integer("track_count").notNull().default(0),
		elementCount: integer("element_count").notNull().default(0),
		seq: bigserial("seq", { mode: "number" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("rc_commits_project_seq_idx").on(table.projectId, table.seq),
	],
);

export const rcHeads = pgTable(
	"rc_heads",
	{
		projectId: text("project_id")
			.notNull()
			.references(() => rcProjects.id, { onDelete: "cascade" }),
		branch: text("branch").notNull(),
		commitId: text("commit_id")
			.notNull()
			.references(() => rcCommits.id),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [primaryKey({ columns: [table.projectId, table.branch] })],
);

export const rcShareLinks = pgTable(
	"rc_share_links",
	{
		id: text("id").primaryKey(),
		/** sha256(token) in hex. The token itself is shown once and never stored. */
		tokenHash: text("token_hash").notNull().unique(),
		projectId: text("project_id")
			.notNull()
			.references(() => rcProjects.id, { onDelete: "cascade" }),
		/** Pinned commit, or null to follow the head of `branch`. */
		commitId: text("commit_id").references(() => rcCommits.id),
		branch: text("branch").notNull().default("main"),
		canComment: boolean("can_comment").notNull().default(true),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdBy: text("created_by"),
		viewCount: integer("view_count").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [index("rc_share_links_project_idx").on(table.projectId)],
);

export const rcReviewComments = pgTable(
	"rc_review_comments",
	{
		id: text("id").primaryKey(),
		projectId: text("project_id")
			.notNull()
			.references(() => rcProjects.id, { onDelete: "cascade" }),
		/** The commit the comment was made against (null = not pinned to one). */
		commitId: text("commit_id"),
		shareLinkId: text("share_link_id"),
		timeS: doublePrecision("time_s").notNull(),
		timeEndS: doublePrecision("time_end_s"),
		trackId: text("track_id"),
		/** Track name as written ("V1 A-ROLL", "MASTER"), kept even when no track id resolves. */
		trackName: text("track_name"),
		elementId: text("element_id"),
		author: text("author").notNull(),
		body: text("body").notNull(),
		ruleId: text("rule_id"),
		severity: text("severity").$type<CommentSeverity>(),
		status: text("status").$type<CommentStatus>().notNull().default("open"),
		parentId: text("parent_id"),
		/** finding@1 id when imported from the Judge (upsert key with project_id). */
		findingId: text("finding_id"),
		/** The original finding@1 object, verbatim. */
		finding: jsonb("finding"),
		resolvedBy: text("resolved_by"),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("rc_review_comments_project_idx").on(table.projectId),
		uniqueIndex("rc_review_comments_finding_idx").on(
			table.projectId,
			table.findingId,
		),
	],
);

/** Content-addressed media files (sha256), stored on disk under the media dir. */
export const rcMediaObjects = pgTable("rc_media_objects", {
	hash: text("hash").primaryKey(),
	size: bigint("size", { mode: "number" }).notNull(),
	mime: text("mime").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

/** Which file a project's `mediaId` points at, plus the editor's MediaAssetData (no thumbnail). */
export const rcProjectMedia = pgTable(
	"rc_project_media",
	{
		projectId: text("project_id")
			.notNull()
			.references(() => rcProjects.id, { onDelete: "cascade" }),
		mediaId: text("media_id").notNull(),
		hash: text("hash")
			.notNull()
			.references(() => rcMediaObjects.hash),
		meta: jsonb("meta"),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [primaryKey({ columns: [table.projectId, table.mediaId] })],
);

export const storeSchema = {
	rcProjects,
	rcCommits,
	rcHeads,
	rcShareLinks,
	rcReviewComments,
	rcMediaObjects,
	rcProjectMedia,
};

export type ProjectMediaRow = typeof rcProjectMedia.$inferSelect;

export type ProjectRow = typeof rcProjects.$inferSelect;
export type CommitRow = typeof rcCommits.$inferSelect;
export type HeadRow = typeof rcHeads.$inferSelect;
export type ShareLinkRow = typeof rcShareLinks.$inferSelect;
export type ReviewCommentRow = typeof rcReviewComments.$inferSelect;
