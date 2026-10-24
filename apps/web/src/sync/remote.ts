/**
 * Browser client for the project store API (/api/projects, /api/share).
 * Shapes: docs/restorff/worklog/port.md "API reference" and apps/web/README-RESTORFF.md.
 */
import type { DiffSummary, ProjectSnapshot } from "./snapshot";

export type CommitAuthor = "user" | "claude" | "compiler" | "preset";

export interface RemoteCommit {
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
	snapshot?: ProjectSnapshot | null;
	ops?: unknown;
}

export interface RemoteProject {
	id: string;
	name: string;
	owner: string;
	default_branch: string;
	created_at: string | null;
}

export interface RemoteHead {
	project: RemoteProject;
	branch: string;
	head: RemoteCommit;
	snapshot: ProjectSnapshot | null;
}

export interface RemoteConflict {
	branch: string;
	head: RemoteCommit;
	since: RemoteCommit[];
	base_found: boolean;
}

export interface RemoteComment {
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
	severity: "must" | "should" | "could" | "info" | null;
	status: "open" | "resolved";
	parent_id: string | null;
	finding_id: string | null;
	resolved_by: string | null;
	resolved_at: string | null;
	created_at: string | null;
}

export interface RemoteShareLink {
	id: string;
	project_id: string;
	commit_id: string | null;
	pinned: boolean;
	branch: string;
	can_comment: boolean;
	expires_at: string | null;
	revoked: boolean;
	view_count: number;
	created_by: string | null;
	created_at: string | null;
}

export interface RemoteMedia {
	media_id: string;
	hash: string;
	size: number;
	mime: string;
	meta: Record<string, unknown> | null;
	updated_at: string | null;
}

export class RemoteError extends Error {
	constructor(
		public status: number,
		message: string,
		public body: unknown,
	) {
		super(message);
	}
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
		cache: "no-store",
		credentials: "same-origin",
	});
	const text = await res.text();
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = { raw: text };
	}
	if (!res.ok) {
		const message =
			(json as { error?: string } | null)?.error ?? `${method} ${url} failed (${res.status})`;
		throw new RemoteError(res.status, message, json);
	}
	return json as T;
}

const enc = encodeURIComponent;

export const remote = {
	getHead(projectId: string, branch?: string) {
		const q = branch ? `?branch=${enc(branch)}` : "";
		return request<RemoteHead>("GET", `/api/projects/${enc(projectId)}${q}`);
	},
	createProject(body: { snapshot: ProjectSnapshot; author?: CommitAuthor; message?: string; branch?: string }) {
		return request<{ project: RemoteProject; commit: RemoteCommit }>("POST", "/api/projects", body);
	},
	listCommits(projectId: string, opts: { branch?: string; since?: string; limit?: number } = {}) {
		const q = new URLSearchParams();
		if (opts.branch) q.set("branch", opts.branch);
		if (opts.since) q.set("since", opts.since);
		if (opts.limit) q.set("limit", String(opts.limit));
		const qs = q.toString();
		return request<{ branch: string; head: string; commits: RemoteCommit[]; since_found?: boolean }>(
			"GET",
			`/api/projects/${enc(projectId)}/commits${qs ? `?${qs}` : ""}`,
		);
	},
	getCommit(projectId: string, commitId: string) {
		return request<{ commit: RemoteCommit }>(
			"GET",
			`/api/projects/${enc(projectId)}/commits/${enc(commitId)}`,
		);
	},
	/** Resolves {commit} on 201; a 409 throws RemoteError whose body is {conflict}. */
	pushCommit(
		projectId: string,
		body: {
			base_commit: string;
			branch?: string;
			author: CommitAuthor;
			ops?: unknown[];
			snapshot: ProjectSnapshot;
			message: string;
		},
	) {
		return request<{ commit: RemoteCommit; branch: string; created_branch: boolean }>(
			"POST",
			`/api/projects/${enc(projectId)}/commits`,
			body,
		);
	},
	listBranches(projectId: string) {
		return request<{
			default_branch: string;
			branches: Array<{ name: string; head: RemoteCommit | null; updated_at: string | null }>;
		}>("GET", `/api/projects/${enc(projectId)}/branches`);
	},
	createBranch(projectId: string, name: string, fromCommit?: string) {
		return request<{ name: string; head: RemoteCommit }>(
			"POST",
			`/api/projects/${enc(projectId)}/branches`,
			{ name, from_commit: fromCommit },
		);
	},
	listComments(projectId: string) {
		return request<{ comments: RemoteComment[] }>("GET", `/api/projects/${enc(projectId)}/comments`);
	},
	addComment(projectId: string, body: Record<string, unknown>) {
		return request<{ comments: RemoteComment[] }>(
			"POST",
			`/api/projects/${enc(projectId)}/comments`,
			body,
		);
	},
	updateComment(projectId: string, id: string, patch: { status?: "open" | "resolved"; body?: string }) {
		return request<{ comment: RemoteComment }>(
			"PATCH",
			`/api/projects/${enc(projectId)}/comments`,
			{ id, ...patch },
		);
	},
	createShare(body: {
		project_id: string;
		commit_id?: string;
		branch?: string;
		can_comment?: boolean;
		expires_in?: "1h" | "24h" | "7d" | "30d" | "never";
	}) {
		return request<{ token: string; url: string; editor_url: string; link: RemoteShareLink }>(
			"POST",
			"/api/share",
			body,
		);
	},
	listMedia(projectId: string) {
		return request<{ media: RemoteMedia[] }>("GET", `/api/projects/${enc(projectId)}/media`);
	},
	async uploadMedia(projectId: string, mediaId: string, file: Blob, meta: Record<string, unknown>) {
		const json = JSON.stringify(meta);
		const bytes = new TextEncoder().encode(json);
		let binary = "";
		for (const b of bytes) binary += String.fromCharCode(b);
		const metaHeader = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		const res = await fetch(`/api/projects/${enc(projectId)}/media/${enc(mediaId)}`, {
			method: "PUT",
			headers: {
				"Content-Type": file.type || "application/octet-stream",
				"X-Media-Meta": metaHeader,
			},
			body: file,
			credentials: "same-origin",
		});
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			throw new RemoteError(res.status, (body as { error?: string } | null)?.error ?? "upload failed", body);
		}
		return ((await res.json()) as { media: RemoteMedia }).media;
	},
	async downloadMedia(projectId: string, mediaId: string): Promise<Blob> {
		const res = await fetch(`/api/projects/${enc(projectId)}/media/${enc(mediaId)}`, {
			credentials: "same-origin",
		});
		if (!res.ok) throw new RemoteError(res.status, `download of ${mediaId} failed`, null);
		return res.blob();
	},
	listShares(projectId: string) {
		return request<{ links: RemoteShareLink[] }>("GET", `/api/share?project_id=${enc(projectId)}`);
	},
	revokeShare(id: string) {
		return request<{ link: RemoteShareLink }>("DELETE", `/api/share?id=${enc(id)}`);
	},
};

/**
 * Used by storageService.loadProject when a project id is not in this browser:
 * a link to /editor/<id> opens the server's copy (head of the default branch).
 * Returns null when there is no server, no such project, or no access.
 */
export async function fetchRemoteSnapshot(projectId: string): Promise<ProjectSnapshot | null> {
	if (typeof window === "undefined") return null;
	try {
		const head = await remote.getHead(projectId);
		if (!head.snapshot) return null;
		const snapshot = head.snapshot;
		snapshot.metadata.id = projectId;
		const now = new Date().toISOString();
		snapshot.metadata.createdAt ??= now;
		snapshot.metadata.updatedAt ??= now;
		for (const scene of snapshot.scenes ?? []) {
			scene.createdAt ??= now;
			scene.updatedAt ??= now;
			scene.bookmarks ??= [];
		}
		rememberPulledHead(projectId, head.branch, head.head.id);
		return snapshot;
	} catch {
		return null;
	}
}

// ─── Per-project sync bookkeeping (this browser) ───────────────────────────

export interface LocalSyncRecord {
	/** Branch this browser follows. */
	branch: string;
	/** The commit the local copy was last synced with (pushed or pulled). */
	base: string | null;
	/** snapshotFingerprint of the local project right after that sync; null = re-fingerprint on next load. */
	fingerprint: string | null;
}

const KEY = (projectId: string) => `restorffcut.sync.${projectId}`;

export function readSyncRecord(projectId: string): LocalSyncRecord | null {
	try {
		const raw = window.localStorage.getItem(KEY(projectId));
		return raw ? (JSON.parse(raw) as LocalSyncRecord) : null;
	} catch {
		return null;
	}
}

export function writeSyncRecord(projectId: string, record: LocalSyncRecord): void {
	try {
		window.localStorage.setItem(KEY(projectId), JSON.stringify(record));
	} catch {
		// Private mode or blocked storage: sync still works for this session.
	}
}

function rememberPulledHead(projectId: string, branch: string, commitId: string): void {
	writeSyncRecord(projectId, { branch, base: commitId, fingerprint: null });
}
