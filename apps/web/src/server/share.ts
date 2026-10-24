/**
 * Share links: an unguessable token that opens one project read-only in the
 * review player, pinned to a commit or following a branch head, optionally
 * allowing comments. Only sha256(token) is stored; the token is returned once.
 *
 * Ported from OpenCut-AI's share links (MIT, see NOTICE): random base64url
 * tokens, expiry, revocation, "expired and revoked look the same to strangers".
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/store";
import { rcCommits, rcShareLinks, type ShareLinkRow } from "@/lib/db/store-schema";
import type { ProjectSnapshot } from "@/sync/snapshot";
import type { Actor } from "./auth";
import { listComments, type CommentDto } from "./comments";
import { HttpError, iso } from "./http";
import { listProjectMedia } from "./media";
import {
	assertBranch,
	getCommit,
	getProjectHead,
	getProjectRow,
	toCommitDto,
	type CommitDto,
	type ProjectDto,
	toProjectDto,
} from "./projects";

export const SHARE_EXPIRY: Record<string, number | null> = {
	"1h": 3_600_000,
	"24h": 86_400_000,
	"7d": 604_800_000,
	"30d": 2_592_000_000,
	never: null,
};

export interface ShareLinkDto {
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

export function hashToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

export function toShareLinkDto(row: ShareLinkRow): ShareLinkDto {
	return {
		id: row.id,
		project_id: row.projectId,
		commit_id: row.commitId,
		pinned: !!row.commitId,
		branch: row.branch,
		can_comment: row.canComment,
		expires_at: iso(row.expiresAt),
		revoked: !!row.revokedAt,
		view_count: row.viewCount,
		created_by: row.createdBy,
		created_at: iso(row.createdAt),
	};
}

function isActive(row: ShareLinkRow, now = Date.now()): boolean {
	if (row.revokedAt && row.revokedAt.getTime() <= now) return false;
	if (row.expiresAt && row.expiresAt.getTime() <= now) return false;
	return true;
}

export async function createShareLink(
	actor: Actor,
	body: {
		project_id?: unknown;
		commit_id?: unknown;
		branch?: unknown;
		can_comment?: unknown;
		expires_in?: unknown;
		expires_at?: unknown;
	},
	origin: string,
): Promise<{ token: string; url: string; editor_url: string; link: ShareLinkDto }> {
	if (typeof body.project_id !== "string" || !body.project_id) {
		throw new HttpError(400, "project_id is required");
	}
	const db = await getDb();
	const project = await getProjectRow(db, body.project_id);
	const branch = assertBranch(
		typeof body.branch === "string" && body.branch ? body.branch : project.defaultBranch,
	);
	let commitId: string | null = null;
	if (typeof body.commit_id === "string" && body.commit_id) {
		commitId = (await getCommit(project.id, body.commit_id)).id;
	} else {
		await getProjectHead(project.id, branch); // the branch must exist
	}
	let expiresAt: Date | null = null;
	if (typeof body.expires_at === "string") {
		expiresAt = new Date(body.expires_at);
		if (Number.isNaN(expiresAt.getTime())) throw new HttpError(400, "expires_at must be an ISO date");
	} else {
		const key = typeof body.expires_in === "string" ? body.expires_in : "7d";
		if (!(key in SHARE_EXPIRY)) {
			throw new HttpError(400, `expires_in must be one of ${Object.keys(SHARE_EXPIRY).join(" · ")}`);
		}
		const ms = SHARE_EXPIRY[key];
		expiresAt = ms === null ? null : new Date(Date.now() + ms);
	}
	const token = randomBytes(24).toString("base64url");
	const [row] = await db
		.insert(rcShareLinks)
		.values({
			id: randomUUID(),
			tokenHash: hashToken(token),
			projectId: project.id,
			commitId,
			branch,
			canComment: body.can_comment === undefined ? true : body.can_comment === true,
			expiresAt,
			createdBy: actor.name,
		})
		.returning();
	return {
		token,
		url: `${origin}/shared/${token}`,
		editor_url: `${origin}/editor/${encodeURIComponent(project.id)}`,
		link: toShareLinkDto(row),
	};
}

export async function listShareLinks(projectId: string): Promise<ShareLinkDto[]> {
	const db = await getDb();
	await getProjectRow(db, projectId);
	const rows = await db
		.select()
		.from(rcShareLinks)
		.where(eq(rcShareLinks.projectId, projectId))
		.orderBy(desc(rcShareLinks.createdAt));
	return rows.map(toShareLinkDto);
}

export async function revokeShareLink(id: string): Promise<ShareLinkDto> {
	const db = await getDb();
	const [row] = await db
		.update(rcShareLinks)
		.set({ revokedAt: new Date() })
		.where(eq(rcShareLinks.id, id))
		.returning();
	if (!row) throw new HttpError(404, `share link ${id} not found`);
	return toShareLinkDto(row);
}

/** Resolve a token to its active link, or 404 (expired and revoked look the same). */
export async function resolveShareToken(token: string): Promise<ShareLinkRow> {
	if (!token || token.length < 16 || token.length > 128) throw new HttpError(404, "link not found");
	const db = await getDb();
	const [row] = await db
		.select()
		.from(rcShareLinks)
		.where(eq(rcShareLinks.tokenHash, hashToken(token)))
		.limit(1);
	if (!row || !isActive(row)) throw new HttpError(404, "link not found");
	return row;
}

export interface SharedPayload {
	link: ShareLinkDto & { project_name: string };
	project: ProjectDto;
	commit: CommitDto;
	head: CommitDto;
	snapshot: ProjectSnapshot | null;
	comments: CommentDto[];
	/** mediaId → {mime, size} for every file on the server (fetch at /api/share/:token/media/:mediaId). */
	media: Record<string, { mime: string; size: number }>;
}

export async function openSharedProject(token: string, countView: boolean): Promise<SharedPayload> {
	const link = await resolveShareToken(token);
	const db = await getDb();
	const project = await getProjectRow(db, link.projectId);
	const head = await getProjectHead(project.id, link.branch);
	let commit = head.head;
	let snapshot = head.snapshot;
	if (link.commitId) {
		const [row] = await db
			.select()
			.from(rcCommits)
			.where(and(eq(rcCommits.projectId, project.id), eq(rcCommits.id, link.commitId)))
			.limit(1);
		if (!row) throw new HttpError(404, "link not found");
		commit = toCommitDto(row);
		snapshot = (row.snapshot as ProjectSnapshot | null) ?? null;
	}
	if (countView) {
		await db
			.update(rcShareLinks)
			.set({ viewCount: sql`${rcShareLinks.viewCount} + 1` })
			.where(eq(rcShareLinks.id, link.id));
	}
	const [comments, mediaList] = await Promise.all([
		listComments(project.id),
		listProjectMedia(project.id),
	]);
	const media: SharedPayload["media"] = {};
	for (const m of mediaList) media[m.media_id] = { mime: m.mime, size: m.size };
	return {
		link: { ...toShareLinkDto(link), project_name: project.name },
		project: toProjectDto(project),
		commit,
		head: head.head,
		snapshot,
		comments,
		media,
	};
}
