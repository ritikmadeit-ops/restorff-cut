/**
 * security-pass (2026-10-21): saved styles, the repeat history and dismissals are per Restorff org. The gateway sends
 * X-Restorff-Org with the service token on every call; org A's saved style must not show in org B's list, resolve or
 * revise (a trigger sentence), and the old shared "service" rows move to a neutral owner nobody reads. Runs the real
 * MCP handler (src/mcp/handler.ts) on a throwaway PGlite store in the OS temp folder. Fictional Halcyon data.
 * Run: cd apps/web && bun test src/server/__tests__/org-scope.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TOKEN = "security-pass-test-token-0123456789";
const saved = { data: process.env.RESTORFFCUT_DATA_DIR, media: process.env.RESTORFFCUT_MEDIA_DIR, token: process.env.RESTORFFCUT_SERVICE_TOKEN, db: process.env.RESTORFFCUT_DB };
const dir = mkdtempSync(path.join(tmpdir(), "rc-org-scope-"));

type Handler = (request: Request) => Promise<Response>;
let handleMcp: Handler;
let store: typeof import("@/server/styles-store");
let getDb: typeof import("@/lib/db/store").getDb;
let sessionId = "";
let rpcId = 1;

beforeAll(async () => {
	process.env.RESTORFFCUT_DATA_DIR = path.join(dir, "pglite");
	process.env.RESTORFFCUT_MEDIA_DIR = path.join(dir, "media");
	process.env.RESTORFFCUT_SERVICE_TOKEN = TOKEN;
	process.env.RESTORFFCUT_DB = "pglite";
	({ handleMcp } = await import("@/mcp/handler"));
	store = await import("@/server/styles-store");
	({ getDb } = await import("@/lib/db/store"));
	const init = await post({ jsonrpc: "2.0", id: rpcId++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "org-scope-test" } } });
	sessionId = init.headers.get("mcp-session-id") ?? "";
	expect(sessionId).not.toBe("");
}, 60_000);

afterAll(() => {
	for (const [key, value] of [
		["RESTORFFCUT_DATA_DIR", saved.data],
		["RESTORFFCUT_MEDIA_DIR", saved.media],
		["RESTORFFCUT_SERVICE_TOKEN", saved.token],
		["RESTORFFCUT_DB", saved.db],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// PGlite may still hold its files on Windows; the OS temp folder is cleaned by the OS
	}
});

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return handleMcp(
		new Request("http://localhost:8791/api/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(sessionId ? { "mcp-session-id": sessionId } : {}), ...headers },
			body: JSON.stringify(body),
		}),
	);
}

async function call(org: string | null, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const response = await post({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }, org ? { "x-restorff-org": org } : {});
	const message = (await response.json()) as { result?: { structuredContent?: Record<string, unknown> }; error?: { message: string } };
	if (!message.result) throw new Error(`${name}: ${response.status} ${JSON.stringify(message.error)}`);
	return message.result.structuredContent ?? {};
}

const A = "org_halcyon_a";
const B = "org_other_b";
const TRIGGER = "the halcyon house look";

describe("saved styles are per org (X-Restorff-Org with the service token)", () => {
	let tlA = "";
	let tlB = "";

	test("org A saves a style; org B can't list, resolve or trigger it", async () => {
		tlA = (await call(A, "timeline", { action: "create", name: "Halcyon Cold Brew / AD-040", aspect: "9:16" })).timeline_id as string;
		tlB = (await call(B, "timeline", { action: "create", name: "Other studio / AD-001", aspect: "9:16" })).timeline_id as string;
		expect(tlA).toBeTruthy();
		expect(tlB).toBeTruthy();

		const save = await call(A, "styles", { action: "save", timeline_id: tlA, title: "Halcyon house", sentence: "warmer", triggers: [TRIGGER] });
		expect(save.owner).toBe(`org:${A}`);
		expect((save.saved as { id: string }).id).toBeTruthy();

		const listA = await call(A, "styles", { action: "list", timeline_id: tlA });
		expect((listA.styles as Array<{ source: string; title?: string }>).filter((s) => s.source !== "builtin").map((s) => s.title)).toEqual(["Halcyon house"]);

		// B: the list, without a timeline and on its own timeline
		for (const args of [{ action: "list" }, { action: "list", timeline_id: tlB }]) {
			const listB = await call(B, "styles", args);
			expect(listB.owner).toBe(`org:${B}`);
			expect(listB.saved).toBe(0);
			expect((listB.styles as Array<{ source: string }>).every((s) => s.source === "builtin")).toBe(true);
		}
		// B even on A's timeline id (the gateway refuses that before RestorffCut; RestorffCut still answers B's library)
		expect((await call(B, "styles", { action: "list", timeline_id: tlA })).saved).toBe(0);

		const resolveA = await call(A, "styles", { action: "resolve", timeline_id: tlA, sentence: TRIGGER });
		expect((resolveA.saved_style as { title: string }).title).toBe("Halcyon house");
		const resolveB = await call(B, "styles", { action: "resolve", timeline_id: tlB, sentence: TRIGGER });
		expect(resolveB.saved_style).toBeUndefined();

		const reviseA = await call(A, "revise", { timeline_id: tlA, sentence: TRIGGER, dry_run: true });
		expect((reviseA.preset as { kind: string; title: string } | null)?.title).toBe("Halcyon house");
		const reviseB = await call(B, "revise", { timeline_id: tlB, sentence: TRIGGER, dry_run: true });
		expect((reviseB.preset as { kind?: string } | null)?.kind).not.toBe("saved");
		expect(JSON.stringify(reviseB)).not.toContain("Halcyon house");

		// apply by id: unknown to B
		const applyB = await call(B, "styles", { action: "apply", timeline_id: tlB, style: `restorff/user/${(save.saved as { id: string }).id}`, dry_run: true });
		expect((applyB.error as { code: string }).code).toBe("unknown_style");
		expect((applyB.error as { styles: string[] }).styles).not.toContain((save.saved as { id: string }).id); // the styles B is offered: built-ins only
	}, 120_000);

	test("the repeat history and dismissals are per org too", async () => {
		const owner = (org: string) => `org:${org}`;
		for (let i = 0; i < 3; i += 1) await store.recordOwnerInstruction(owner(A), { sentence: "bigger captions", ops: [], projectId: tlA, at: new Date(Date.UTC(2026, 9, 21, 9, i)).toISOString() }, "mcp");
		expect((await store.listOwnerHistory(owner(A))).length).toBe(3);
		expect(await store.listOwnerHistory(owner(B))).toEqual([]);
		const suggestB = await call(B, "styles", { action: "suggest" });
		expect(suggestB.suggestions).toEqual([]);
		await call(A, "styles", { action: "dismiss", pattern: "p-halcyon" });
		expect((await store.getLibrary(owner(A))).library.dismissed).toContain("p-halcyon");
		expect((await store.getLibrary(owner(B))).library.dismissed).toEqual([]);
	}, 60_000);

	test("the org header counts only with the service token; a malformed one is a 400", async () => {
		const bad = await post({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name: "styles", arguments: { action: "list" } } }, { "x-restorff-org": "org a; drop" });
		expect(bad.status).toBe(400);
		// local dev (no token) with an org header: the header is ignored, the caller is local-dev
		const response = await handleMcp(
			new Request("http://localhost:8791/api/mcp", {
				method: "POST",
				headers: { "content-type": "application/json", host: "localhost:8791", "x-restorff-org": A },
				body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "local" } } }),
			}),
		);
		if (process.env.NODE_ENV !== "production") expect(response.headers.get("x-restorffcut-auth")).toBe("local-dev");
		const { resolveActor } = await import("@/server/auth");
		const asService = await resolveActor(new Request("http://localhost:8791/api/styles", { headers: { authorization: `Bearer ${TOKEN}`, "x-restorff-org": A } }));
		expect(asService).toEqual({ kind: "service", id: "service", name: "service", org: A });
		const noOrg = await resolveActor(new Request("http://localhost:8791/api/styles", { headers: { authorization: `Bearer ${TOKEN}` } }));
		expect(noOrg?.org).toBeUndefined();
		expect(await store.styleOwner({ kind: "user", id: "user-123", name: "Ana" }, tlA)).toBe("user-123");
		expect(await store.styleOwner(asService, tlB)).toBe(`org:${A}`);
		// review F2 (2026-10-23): no org → never the project's owner ("service") or the shared library
		const bare = { kind: "service" as const, id: "service", name: "service" };
		expect(await store.styleOwner(bare, tlA)).toBe(store.SERVICE_NO_ORG_OWNER);
		expect(await store.styleOwner(bare, null)).toBe(store.SERVICE_NO_ORG_OWNER);
		const env = process.env as Record<string, string | undefined>;
		const before = env.NODE_ENV;
		env.NODE_ENV = "production";
		try {
			await expect(store.styleOwner(bare, tlA)).rejects.toMatchObject({ status: 400 });
		} finally {
			env.NODE_ENV = before;
		}
		// through MCP: a header-less service call lists the dedicated library, not A's or B's
		const listed = await call(null, "styles", { action: "list", timeline_id: tlA });
		expect([listed.owner, listed.saved]).toEqual([store.SERVICE_NO_ORG_OWNER, 0]);
	});

	test("the shared 'service' library moved to a neutral owner, once", async () => {
		const db = await getDb();
		const { sql } = await import("drizzle-orm");
		// run the migration's job again on rows written the old way: the marker makes it a no-op the second time
		await db.execute(sql`DELETE FROM rc_styles_migrations WHERE id = 'org-scope-1'`);
		await db.execute(sql`INSERT INTO rc_style_history (id, owner, sentence) VALUES ('h-legacy-1', 'service', 'the other studio''s secret line')`);
		await db.execute(sql`INSERT INTO rc_style_dismissed (owner, pattern) VALUES ('service', 'p-legacy')`);
		const first = await store.migrateServiceOwner(db);
		expect(first).toEqual({ migrated: true, styles: 0, dismissed: 1, history: 1 });
		await db.execute(sql`INSERT INTO rc_style_history (id, owner, sentence) VALUES ('h-after', 'service', 'written after')`);
		expect((await store.migrateServiceOwner(db)).migrated).toBe(false);
		expect((await store.listOwnerHistory(store.LEGACY_SERVICE_OWNER)).map((h) => h.sentence)).toEqual(["the other studio's secret line"]);
		expect((await store.listOwnerHistory("service")).map((h) => h.sentence)).toEqual(["written after"]);
		// nobody resolves to the neutral owner
		for (const actor of [
			{ kind: "service" as const, id: "service", name: "s", org: A },
			{ kind: "service" as const, id: "service", name: "s" },
			{ kind: "user" as const, id: "u1", name: "u" },
			{ kind: "local-dev" as const, id: "local-dev", name: "l" },
		]) {
			expect(await store.styleOwner(actor, tlA)).not.toBe(store.LEGACY_SERVICE_OWNER);
		}
	});
});
