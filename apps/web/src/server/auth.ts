/**
 * Who is calling the project store.
 *
 * 1. Machine writers (Restorff's gateway): `Authorization: Bearer <RESTORFFCUT_SERVICE_TOKEN>`,
 *    compared in constant time. May write commits as any author (user · claude · compiler · preset).
 *    With `X-Restorff-Org: <org id>` (honoured only here) the actor carries that org (./tenant.ts).
 * 2. Browser users with a better-auth session cookie (when auth is configured): author is always `user`.
 * 3. Local dev mode: NODE_ENV is not production, the request is addressed to localhost and did not
 *    come through a proxy. No auth at all, any author. Every response carries
 *    `X-RestorffCut-Auth: local-dev` so it is never mistaken for a secured server.
 *    Turn it off with RESTORFFCUT_LOCAL_DEV=0.
 * Anything else gets 401.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http";
import { orgFromHeader } from "./tenant";
import type { CommitAuthor } from "@/lib/db/store-schema";

export type ActorKind = "service" | "local-dev" | "user";

export interface Actor {
	kind: ActorKind;
	/** "service", "local-dev", or the better-auth user id. */
	id: string;
	name: string;
	/**
	 * Service token only: the Restorff org the call is for (X-Restorff-Org; ./tenant.ts). Scopes saved styles, the
	 * repeat history and dismissals (styles-store.ts styleOwner). Never set for a session or local dev.
	 */
	org?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function digest(value: string): Buffer {
	return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time string compare (hashes first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
	return timingSafeEqual(digest(a), digest(b));
}

function bearer(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header) return null;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? match[1].trim() : null;
}

export function isLocalDevRequest(request: Request): boolean {
	if (process.env.NODE_ENV === "production") return false;
	if (process.env.RESTORFFCUT_LOCAL_DEV === "0") return false;
	let hostname: string;
	try {
		hostname = new URL(request.url).hostname;
	} catch {
		return false;
	}
	const hostHeader = request.headers.get("host")?.replace(/:\d+$/, "") ?? hostname;
	if (!LOOPBACK_HOSTS.has(hostname) || !LOOPBACK_HOSTS.has(hostHeader)) return false;
	const forwarded = request.headers.get("x-forwarded-for");
	if (forwarded) {
		const first = forwarded.split(",")[0]?.trim() ?? "";
		const loopback =
			first === "127.0.0.1" || first === "::1" || first === "::ffff:127.0.0.1";
		if (!loopback) return false;
	}
	return true;
}

async function sessionUser(request: Request): Promise<Actor | null> {
	const cookie = request.headers.get("cookie") ?? "";
	if (!cookie.includes("session_token")) return null;
	try {
		const { auth } = await import("@/auth/server");
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session?.user) return null;
		return {
			kind: "user",
			id: session.user.id,
			name: session.user.name || session.user.email || session.user.id,
		};
	} catch (error) {
		console.warn("[project-store] session lookup failed:", error);
		return null;
	}
}

/** Resolves the caller, or null when nobody is authenticated. */
export async function resolveActor(request: Request): Promise<Actor | null> {
	const token = bearer(request);
	const serviceToken = process.env.RESTORFFCUT_SERVICE_TOKEN;
	if (token) {
		if (serviceToken && safeEqual(token, serviceToken)) {
			// the org header counts only here, behind the service token (security-pass, 2026-10-21)
			const org = orgFromHeader(request);
			return { kind: "service", id: "service", name: "service", ...(org ? { org } : {}) };
		}
		throw new HttpError(401, "invalid bearer token");
	}
	const user = await sessionUser(request);
	if (user) return user;
	if (isLocalDevRequest(request)) {
		return { kind: "local-dev", id: "local-dev", name: "local dev (no auth)" };
	}
	return null;
}

export async function requireActor(request: Request): Promise<Actor> {
	const actor = await resolveActor(request);
	if (!actor) {
		throw new HttpError(
			401,
			"authentication required: send Authorization: Bearer <RESTORFFCUT_SERVICE_TOKEN>, or sign in",
		);
	}
	return actor;
}

/** Browser users may only commit as `user`; the service and local dev may use any author. */
export function assertMayAuthor(actor: Actor, author: CommitAuthor): void {
	if (actor.kind === "user" && author !== "user") {
		throw new HttpError(403, `a signed-in user commits as "user", not "${author}"`);
	}
}

export function authHeaders(actor: Actor | null): Record<string, string> {
	return { "X-RestorffCut-Auth": actor?.kind ?? "none" };
}
