import { authHeaders, requireActor } from "@/server/auth";
import { handle, HttpError, json, readJson } from "@/server/http";
import { createShareLink, listShareLinks, revokeShareLink } from "@/server/share";

function origin(request: Request): string {
	return process.env.RESTORFFCUT_PUBLIC_URL?.replace(/\/$/, "") || new URL(request.url).origin;
}

/**
 * POST /api/share {project_id, commit_id?, branch?, can_comment?, expires_in?: 1h|24h|7d|30d|never, expires_at?}
 * 201 {token, url, editor_url, link}. No commit_id = the link follows the branch head.
 * The token is only ever returned here; the store keeps its sha256.
 */
export const POST = handle(async (request: Request) => {
	const actor = await requireActor(request);
	const body = (await readJson(request)) as Record<string, unknown>;
	if (!body || typeof body !== "object") throw new HttpError(400, "body must be an object");
	const result = await createShareLink(actor, body, origin(request));
	return json(result, 201, authHeaders(actor));
});

/** GET /api/share?project_id=<id> — 200 {links[]} (never the tokens). */
export const GET = handle(async (request: Request) => {
	const actor = await requireActor(request);
	const projectId = new URL(request.url).searchParams.get("project_id");
	if (!projectId) throw new HttpError(400, "project_id is required");
	return json({ links: await listShareLinks(projectId) }, 200, authHeaders(actor));
});

/** DELETE /api/share?id=<link id> — revokes the link. 200 {link} */
export const DELETE = handle(async (request: Request) => {
	const actor = await requireActor(request);
	const id = new URL(request.url).searchParams.get("id");
	if (!id) throw new HttpError(400, "id is required");
	return json({ link: await revokeShareLink(id) }, 200, authHeaders(actor));
});
