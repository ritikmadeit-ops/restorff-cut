/**
 * Hand-written, append-only migrations for the project store (./store-schema.ts).
 * They run once per process at startup (./store.ts) on PGlite and on Postgres.
 * Never edit a shipped migration: add a new one with the next id.
 */
export interface StoreMigration {
	id: number;
	name: string;
	statements: string[];
}

export const STORE_MIGRATIONS: StoreMigration[] = [
	{
		id: 1,
		name: "project store: projects, commits, heads, share links, review comments",
		statements: [
			`CREATE TABLE IF NOT EXISTS rc_projects (
				id text PRIMARY KEY,
				name text NOT NULL,
				owner text NOT NULL,
				default_branch text NOT NULL DEFAULT 'main',
				created_at timestamptz NOT NULL DEFAULT now()
			)`,
			`CREATE TABLE IF NOT EXISTS rc_commits (
				id text PRIMARY KEY,
				project_id text NOT NULL REFERENCES rc_projects(id) ON DELETE CASCADE,
				parents jsonb NOT NULL DEFAULT '[]'::jsonb,
				branch text NOT NULL,
				author text NOT NULL CHECK (author IN ('user', 'claude', 'compiler', 'preset')),
				author_name text,
				ops jsonb,
				snapshot jsonb,
				delta jsonb,
				snapshot_hash text NOT NULL,
				message text NOT NULL,
				summary jsonb,
				duration_s double precision NOT NULL DEFAULT 0,
				track_count integer NOT NULL DEFAULT 0,
				element_count integer NOT NULL DEFAULT 0,
				seq bigserial NOT NULL,
				created_at timestamptz NOT NULL DEFAULT now()
			)`,
			`CREATE INDEX IF NOT EXISTS rc_commits_project_seq_idx ON rc_commits (project_id, seq)`,
			`CREATE TABLE IF NOT EXISTS rc_heads (
				project_id text NOT NULL REFERENCES rc_projects(id) ON DELETE CASCADE,
				branch text NOT NULL,
				commit_id text NOT NULL REFERENCES rc_commits(id),
				updated_at timestamptz NOT NULL DEFAULT now(),
				PRIMARY KEY (project_id, branch)
			)`,
			`CREATE TABLE IF NOT EXISTS rc_share_links (
				id text PRIMARY KEY,
				token_hash text NOT NULL UNIQUE,
				project_id text NOT NULL REFERENCES rc_projects(id) ON DELETE CASCADE,
				commit_id text REFERENCES rc_commits(id),
				branch text NOT NULL DEFAULT 'main',
				can_comment boolean NOT NULL DEFAULT true,
				expires_at timestamptz,
				revoked_at timestamptz,
				created_by text,
				view_count integer NOT NULL DEFAULT 0,
				created_at timestamptz NOT NULL DEFAULT now()
			)`,
			`CREATE INDEX IF NOT EXISTS rc_share_links_project_idx ON rc_share_links (project_id)`,
			`CREATE TABLE IF NOT EXISTS rc_review_comments (
				id text PRIMARY KEY,
				project_id text NOT NULL REFERENCES rc_projects(id) ON DELETE CASCADE,
				commit_id text,
				share_link_id text,
				time_s double precision NOT NULL,
				time_end_s double precision,
				track_id text,
				track_name text,
				element_id text,
				author text NOT NULL,
				body text NOT NULL,
				rule_id text,
				severity text CHECK (severity IS NULL OR severity IN ('must', 'should', 'could', 'info')),
				status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
				parent_id text,
				finding_id text,
				finding jsonb,
				resolved_by text,
				resolved_at timestamptz,
				created_at timestamptz NOT NULL DEFAULT now()
			)`,
			`CREATE INDEX IF NOT EXISTS rc_review_comments_project_idx ON rc_review_comments (project_id)`,
			`CREATE UNIQUE INDEX IF NOT EXISTS rc_review_comments_finding_idx ON rc_review_comments (project_id, finding_id)`,
		],
	},
	{
		id: 2,
		name: "media: content-addressed files and per-project media ids",
		statements: [
			`CREATE TABLE IF NOT EXISTS rc_media_objects (
				hash text PRIMARY KEY,
				size bigint NOT NULL,
				mime text NOT NULL,
				created_at timestamptz NOT NULL DEFAULT now()
			)`,
			`CREATE TABLE IF NOT EXISTS rc_project_media (
				project_id text NOT NULL REFERENCES rc_projects(id) ON DELETE CASCADE,
				media_id text NOT NULL,
				hash text NOT NULL REFERENCES rc_media_objects(hash),
				meta jsonb,
				updated_at timestamptz NOT NULL DEFAULT now(),
				PRIMARY KEY (project_id, media_id)
			)`,
		],
	},
];
