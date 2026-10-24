/**
 * mcp-gaps-mvp (2026-10-24): the four gaps the MVP test's real Claude client hit (worklog mcp-gaps-mvp.md).
 *   1. composition image params take a media_id / media:<id> / this server's media URL (resolved server-side)
 *   2. no server filesystem path in any MCP answer (unit + a sweep of real error paths)
 *   3. timeline list and reads by id are scoped to the caller's org
 *   4. no call hangs: past the answer deadline it answers "working" and the same call collects it; one write per
 *      timeline at a time (queued), a clear timeline_busy past the budget
 * Parts 3 + the sweep + 1 run the real MCP handler on a throwaway PGlite store in the OS temp folder. Needs ffmpeg on
 * PATH (test media) and the compositions package (one float-thumbs render, ~5-15 s). Fictional Halcyon data.
 * Run: cd apps/web && bun test src/server/__tests__/mcp-gaps-mvp.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { callKey, takeTurn, TimelineBusyError, writeTurnFor } from "@/mcp/call-queue";
import { makeMcpHandler, type Tool } from "@/mcp/protocol";
import { runWithCallScope } from "@/server/call-scope";
import { holdsImage, specRow } from "@/server/params-list";
import { findPaths, pathsIn, SERVER_PATH, scrubServerPaths, scrubText } from "@/server/path-scrub";

const TOKEN = "mcp-gaps-mvp-test-token-0123456789";
const saved = {
	data: process.env.RESTORFFCUT_DATA_DIR,
	media: process.env.RESTORFFCUT_MEDIA_DIR,
	token: process.env.RESTORFFCUT_SERVICE_TOKEN,
	db: process.env.RESTORFFCUT_DB,
	answer: process.env.RESTORFFCUT_MCP_ANSWER_S,
	renders: process.env.RESTORFFCUT_RENDERS_DIR,
};
const dir = mkdtempSync(path.join(tmpdir(), "rc-mcp-gaps-"));
const REPO = path.resolve(process.cwd(), "..", "..");

afterAll(async () => {
	// bun runs every test file in one process: close this file's throwaway store and forget the per-store "tables are
	// ready" flags, so the next file that opens its own store (org-scope.test.ts) gets a fresh one
	const g = globalThis as unknown as Record<string, unknown>;
	try {
		const handle = (await g.__restorffcutProjectStore) as { db?: { $client?: { close?: () => Promise<void> } } } | undefined;
		await handle?.db?.$client?.close?.();
	} catch {
		// never opened, or already closed
	}
	for (const key of ["__restorffcutProjectStore", "__restorffcutCompositionStoreReady", "__restorffcutVersionNamesReady", "__restorffcutStylesStoreReady", "__restorffcutStylesOrgScoped"]) delete g[key];
	for (const [key, value] of [
		["RESTORFFCUT_DATA_DIR", saved.data],
		["RESTORFFCUT_MEDIA_DIR", saved.media],
		["RESTORFFCUT_SERVICE_TOKEN", saved.token],
		["RESTORFFCUT_DB", saved.db],
		["RESTORFFCUT_MCP_ANSWER_S", saved.answer],
		["RESTORFFCUT_RENDERS_DIR", saved.renders],
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

// ── gap 2: path scrub (pure) ───────────────────────────────────────────────────────────────────────────────────

describe("gap 2 — server paths never reach the client", () => {
	test("windows, UNC, file: and POSIX server paths are replaced; URLs are not", () => {
		const cases: Array<[string, string]> = [
			["cards[0].image: image not found: C:\\data\\code\\overkill\\restorff-apps\\restorffcut\\packages\\compositions\\compositions\\orbit\\b1cc6697", `cards[0].image: image not found: ${SERVER_PATH}`],
			["file at C:/data/code/x/apps/web/.data/renders/rmv1/master.mp4.", `file at ${SERVER_PATH}/master.mp4.`],
			["open 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe' failed", `open '${SERVER_PATH}/ffmpeg.exe' failed`],
			["share \\\\nas01\\media\\halcyon\\a.mov gone", `share ${SERVER_PATH}/a.mov gone`],
			["loaded file:///C:/data/code/orbit/orbit.html", `loaded ${SERVER_PATH}/orbit.html`],
			["ENOENT: /home/app/restorffcut/.data/media/ab/abcd", `ENOENT: ${SERVER_PATH}`],
			["see /tmp/rc-x/job.json and /var/lib/x", `see ${SERVER_PATH}/job.json and ${SERVER_PATH}`],
		];
		for (const [input, want] of cases) expect(scrubText(input).text).toBe(want);
		for (const url of [
			"http://localhost:8791/api/renders/rmv1/file",
			"https://cdn.example.com/data/halcyon.png",
			"/api/projects/tl-1/media/m-1",
			"/editor/d1afd111",
			"data:image/png;base64,iVBORw0KGgo=",
			"12:30 / 45:00",
			"V1 A-ROLL / V2 B-ROLL",
		]) {
			expect(scrubText(url).text).toBe(url);
		}
	});

	test("a path the caller sent comes back as written; other paths in the same answer do not", () => {
		const args = { path_hint: "C:\\Users\\ana\\Halcyon\\take-1.mp4" };
		const allowed = pathsIn(args);
		const answer = { source: "C:\\Users\\ana\\Halcyon\\take-1.mp4", also: "C:/Users/ana/Halcyon/take-1.mp4", stored: "C:\\data\\code\\restorffcut\\apps\\web\\.data\\media\\ab\\abcd" };
		const { value, count } = scrubServerPaths(answer, allowed);
		expect(value.source).toBe(answer.source);
		expect(value.also).toBe(answer.also);
		expect(value.stored).toBe(SERVER_PATH);
		expect(count).toBe(1);
		expect(findPaths("no paths here: 1/2 and a/b")).toEqual([]);
	});

	test("a tool that throws with a server path answers without it", async () => {
		const tools: Tool[] = [
			{
				name: "boom",
				description: "throws",
				inputSchema: { type: "object", properties: {} },
				run() {
					throw new Error(`ENOENT: no such file or directory, open '${path.join(REPO, "apps", "web", ".data", "media", "ab", "abcdef")}'`);
				},
			},
		];
		const { call } = fakeServer(tools);
		const out = await call("boom", {});
		expect(out.text).not.toContain(REPO);
		expect(out.text).not.toMatch(/[A-Za-z]:[\\/]{1,2}data/);
		expect(out.text).toContain(SERVER_PATH);
	});
});

// ── gap 4: the call queue (protocol level, fake tools) ─────────────────────────────────────────────────────────

/** A protocol handler over `tools` with one session; call() answers {text, structured, isError}. */
function fakeServer(tools: Tool[]) {
	const handler = makeMcpHandler({ serverInfo: { name: "test", version: "0" }, tools });
	let sid = "";
	let id = 1;
	const post = (body: unknown) =>
		handler(
			new Request("http://localhost/api/mcp", {
				method: "POST",
				headers: { "content-type": "application/json", ...(sid ? { "mcp-session-id": sid } : {}) },
				body: JSON.stringify(body),
			}),
			{ auth: { userId: "u1", kind: "service", name: "t" } },
		);
	const call = async (name: string, args: Record<string, unknown>) => {
		if (!sid) {
			const init = await post({ jsonrpc: "2.0", id: id++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
			sid = init.headers.get("mcp-session-id") ?? "";
		}
		const response = await post({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } });
		const message = (await response.json()) as { result: { content: Array<{ text?: string }>; structuredContent: Record<string, unknown>; isError?: boolean } };
		return { text: message.result.content[0]?.text ?? "", structured: message.result.structuredContent, isError: Boolean(message.result.isError) };
	};
	return { call };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const WRITE = { readOnlyHint: false };

describe("gap 4 — no MCP call hangs", () => {
	test("past the answer deadline: 'working' with next = the same call; the same call collects it, run once", async () => {
		process.env.RESTORFFCUT_MCP_ANSWER_S = "0.15";
		try {
			let runs = 0;
			const tools: Tool[] = [
				{
					name: "slow",
					description: "slow write",
					inputSchema: { type: "object", properties: { timeline_id: { type: "string" }, n: { type: "number" } } },
					annotations: WRITE,
					budgetSeconds: 5,
					async run(args) {
						runs++;
						await sleep(400);
						return { payload: { done: true, n: args.n, commit_id: "c1" } };
					},
				},
			];
			const { call } = fakeServer(tools);
			const args = { timeline_id: "tl-slow", n: 7 };
			const t0 = Date.now();
			const first = await call("slow", args);
			expect(Date.now() - t0).toBeLessThan(350);
			expect(first.isError).toBe(false);
			expect(first.structured.status).toBe("working");
			expect((first.structured.next as { tool: string; arguments: unknown }).arguments).toEqual(args);
			expect(String(first.structured.message)).toContain("NOT stopped");
			// the same call again: waits (≤ deadline), still running → working again, then the result
			let second = await call("slow", args);
			for (let i = 0; i < 10 && second.structured.status === "working"; i++) second = await call("slow", args);
			expect(second.structured.done).toBe(true);
			expect(second.structured.commit_id).toBe("c1");
			expect(runs).toBe(1);
			// collected once: a later identical call runs again
			const third = await call("slow", args);
			for (let i = 0; i < 10 && third.structured.status === "working"; i++) Object.assign(third, await call("slow", args));
			expect(runs).toBe(2);
		} finally {
			process.env.RESTORFFCUT_MCP_ANSWER_S = saved.answer ?? "";
			if (saved.answer === undefined) delete process.env.RESTORFFCUT_MCP_ANSWER_S;
		}
	});

	test("two writes to one timeline at once queue (no overlap) and both succeed; reads don't wait", async () => {
		const log: string[] = [];
		const tools: Tool[] = [
			{
				name: "fx",
				description: "write",
				inputSchema: { type: "object", properties: { action: { type: "string" }, timeline_id: { type: "string" }, name: { type: "string" } } },
				annotations: WRITE,
				budgetSeconds: 10,
				async run(args) {
					if (args.action === "describe") return { payload: { read: true } };
					log.push(`start ${args.name}`);
					await sleep(150);
					log.push(`end ${args.name}`);
					return { payload: { commit_id: `c-${args.name}` } };
				},
			},
		];
		const { call } = fakeServer(tools);
		const a = call("fx", { action: "apply", timeline_id: "tl-q", name: "Paper Cut" });
		await sleep(10);
		const b = call("fx", { action: "apply", timeline_id: "tl-q", name: "Doodle Boil" });
		await sleep(10);
		const t0 = Date.now();
		const read = await call("fx", { action: "describe", timeline_id: "tl-q" });
		expect(read.structured.read).toBe(true);
		expect(Date.now() - t0).toBeLessThan(100);
		const [ra, rb] = await Promise.all([a, b]);
		expect(ra.structured.commit_id).toBe("c-Paper Cut");
		expect(rb.structured.commit_id).toBe("c-Doodle Boil");
		expect(log).toEqual(["start Paper Cut", "end Paper Cut", "start Doodle Boil", "end Doodle Boil"]);
	});

	test("a queue longer than the budget answers timeline_busy fast, naming what holds it", async () => {
		const release = await takeTurn("tl-busy", "effects apply", { maxWaitMs: 5000 });
		try {
			const tools: Tool[] = [
				{
					name: "quick",
					description: "write with a short budget",
					inputSchema: { type: "object", properties: { timeline_id: { type: "string" } } },
					annotations: WRITE,
					budgetSeconds: 0.3,
					run: () => ({ payload: { ok: true } }),
				},
			];
			const { call } = fakeServer(tools);
			const t0 = Date.now();
			const out = await call("quick", { timeline_id: "tl-busy" });
			expect(Date.now() - t0).toBeLessThan(1500);
			expect(out.isError).toBe(true);
			const error = out.structured.error as { code: string; message: string; busy_with: Array<{ label: string }>; next: { tool: string } };
			expect(error.code).toBe("timeline_busy");
			expect(error.message).toContain("Nothing was done");
			expect(error.busy_with[0]?.label).toBe("effects apply");
			expect(error.next.tool).toBe("quick");
		} finally {
			release();
		}
		// the turn is free again
		const again = await takeTurn("tl-busy", "x", { maxWaitMs: 100 });
		again();
	});

	test("which calls take a write turn", () => {
		expect(writeTurnFor({ name: "effects", annotations: WRITE }, { action: "apply", timeline_id: "t" })).toBe("t");
		expect(writeTurnFor({ name: "effects", annotations: WRITE }, { action: "describe", timeline_id: "t" })).toBeNull();
		expect(writeTurnFor({ name: "timeline", annotations: WRITE }, { action: "summary", timeline_id: "t" })).toBeNull();
		expect(writeTurnFor({ name: "look", annotations: { readOnlyHint: true } }, { timeline_id: "t" })).toBeNull();
		expect(writeTurnFor({ name: "history", annotations: WRITE }, { timeline_id: "t" })).toBeNull();
		expect(writeTurnFor({ name: "render", annotations: WRITE }, { timeline_id: "t" })).toBe("t");
		expect(writeTurnFor({ name: "render", annotations: WRITE }, { render_id: "r" })).toBeNull();
		expect(callKey("a", { x: 1, y: 2 }, { userId: "u" })).toBe(callKey("a", { y: 2, x: 1 }, { userId: "u" }));
		expect(callKey("a", { x: 1 }, { userId: "u", org: "o1" })).not.toBe(callKey("a", { x: 1 }, { userId: "u", org: "o2" }));
	});

	test("a waiter that gives up does not block the ones behind it", async () => {
		const first = await takeTurn("tl-chain", "one", { maxWaitMs: 1000 });
		const second = takeTurn("tl-chain", "two", { maxWaitMs: 50 });
		const third = takeTurn("tl-chain", "three", { maxWaitMs: 2000 });
		await expect(second).rejects.toBeInstanceOf(TimelineBusyError);
		setTimeout(first, 100);
		const releaseThird = await third;
		releaseThird();
	});
});

// ── the real handler: gaps 3, 1 and the error sweep ────────────────────────────────────────────────────────────

type Handler = (request: Request) => Promise<Response>;
let handleMcp: Handler;
let sessionId = "";
let rpcId = 1;
const PNG_FILE = path.join(dir, "halcyon-bottle.png");
const MP4_FILE = path.join(dir, "halcyon-pour.mp4");

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return handleMcp(
		new Request("http://localhost:8791/api/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(sessionId ? { "mcp-session-id": sessionId } : {}), ...headers },
			body: JSON.stringify(body),
		}),
	);
}

async function mcp(org: string | null, name: string, args: Record<string, unknown>): Promise<{ structured: Record<string, unknown>; text: string; isError: boolean }> {
	const response = await post({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }, org ? { "x-restorff-org": org } : {});
	const message = (await response.json()) as { result?: { content: Array<{ text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean }; error?: { message: string } };
	if (!message.result) throw new Error(`${name}: ${response.status} ${JSON.stringify(message.error)}`);
	return { structured: message.result.structuredContent ?? {}, text: message.result.content.map((c) => c.text ?? "").join("\n"), isError: Boolean(message.result.isError) };
}

const A = "mvp_test_org_a";
const B = "mvp_test_org_b";
let tlA = "";
let tlB = "";
let tlLegacy = "";
let imageId = "";
let videoId = "";

describe("the real MCP handler (throwaway store)", () => {
	beforeAll(async () => {
		process.env.RESTORFFCUT_DATA_DIR = path.join(dir, "pglite");
		process.env.RESTORFFCUT_MEDIA_DIR = path.join(dir, "media");
		process.env.RESTORFFCUT_SERVICE_TOKEN = TOKEN;
		process.env.RESTORFFCUT_DB = "pglite";
		process.env.RESTORFFCUT_RENDERS_DIR = path.join(dir, "renders");
		// fictional test media: a 96x96 amber square (PNG) and a 2 s teal clip (MP4)
		const png = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0xE0A030:s=96x96:d=1", "-frames:v", "1", PNG_FILE]);
		const mp4 = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x208080:s=96x96:d=2:r=10", "-pix_fmt", "yuv420p", MP4_FILE]);
		expect([png.status, mp4.status]).toEqual([0, 0]);
		({ handleMcp } = await import("@/mcp/handler"));
		const init = await post({ jsonrpc: "2.0", id: rpcId++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-gaps-mvp-test" } } });
		sessionId = init.headers.get("mcp-session-id") ?? "";
		expect(sessionId).not.toBe("");
	}, 60_000);

	test("gap 3 — timeline list and reads by id are per org; no org = every timeline (dev)", async () => {
		tlA = (await mcp(A, "timeline", { action: "create", name: "Halcyon Cold Brew / MVP A", aspect: "9:16" })).structured.timeline_id as string;
		tlB = (await mcp(B, "timeline", { action: "create", name: "Halcyon Cold Brew / MVP B", aspect: "9:16" })).structured.timeline_id as string;
		tlLegacy = (await mcp(null, "timeline", { action: "create", name: "Halcyon Cold Brew / no org", aspect: "9:16" })).structured.timeline_id as string;
		expect([tlA, tlB, tlLegacy].every(Boolean)).toBe(true);

		const ids = (out: { structured: Record<string, unknown> }) => (out.structured.timelines as Array<{ timeline_id: string }>).map((t) => t.timeline_id);
		expect(ids(await mcp(A, "timeline", { action: "list" }))).toEqual([tlA]);
		expect(ids(await mcp(B, "timeline", { action: "list" }))).toEqual([tlB]);
		const fresh = await mcp("mvp_test_org_fresh", "timeline", { action: "list" });
		expect(ids(fresh)).toEqual([]);
		expect((fresh.structured.next as { arguments: { action: string } }).arguments.action).toBe("create");
		expect(ids(await mcp(null, "timeline", { action: "list" }))).toEqual(expect.arrayContaining([tlA, tlB, tlLegacy]));

		// reads by id: B can't read, write or render A's timeline, nor the no-org one; the answer is "not found"
		for (const [tool, args] of [
			["timeline", { action: "summary", timeline_id: tlA }],
			["timeline", { action: "get", timeline_id: tlA }],
			["history", { timeline_id: tlA }],
			["media", { action: "list", timeline_id: tlA }],
			["timeline", { action: "summary", timeline_id: tlLegacy }],
		] as const) {
			const out = await mcp(B, tool, args as Record<string, unknown>);
			expect(out.isError).toBe(true);
			expect(out.text).toContain("not found");
			expect(out.text).not.toContain("MVP A");
		}
		// A still reads its own
		expect((await mcp(A, "timeline", { action: "summary", timeline_id: tlA })).isError).toBe(false);
		// a 404 on a timeline points at the caller's own list, not at reading the same id again
		const notMine = await mcp(B, "timeline", { action: "summary", timeline_id: tlA });
		expect((notMine.structured.next as { arguments: { action: string } }).arguments.action).toBe("list");

		// renders by id: a render of A's timeline is "not found" for B, like a render that does not exist
		const { writeRow } = await import("@/server/renders-store");
		const now = new Date().toISOString();
		writeRow({ render_id: "rmvgapsorgscope1", project_id: tlA, commit: "c", branch: "main", quality: "preview", status: "failed", phase: "failed", progress: 0, created_at: now, updated_at: now, started_at: now, finished_at: now, job_dir: "", file: null, bytes: null, duration_s: null, width: null, height: null, fps: null, video_codec: null, audio_codec: null, loudness: null, timings: {}, media: [], error: "test row", pid: null, log: "" } as unknown as Parameters<typeof writeRow>[0]);
		for (const [tool, args] of [
			["render", { render_id: "rmvgapsorgscope1", wait_s: 0 }],
			["look", { kind: "render", ref: "rmvgapsorgscope1" }],
		] as const) {
			const asB = await mcp(B, tool, args as Record<string, unknown>);
			expect((asB.structured.error as { code: string }).code).toBe("not_found");
			const asA = await mcp(A, tool, args as Record<string, unknown>);
			expect(asA.text).toContain("rmvgapsorgscope1");
			expect((asA.structured.error as { code?: string } | undefined)?.code).not.toBe("not_found");
		}
	}, 60_000);

	test("gap 1 — media ids, media:<id> and the server's media URL work in a composition's image params", async () => {
		const imported = await mcp(A, "media", { action: "import", timeline_id: tlA, data_base64: readFileSync(PNG_FILE).toString("base64"), name: "halcyon-bottle.png" });
		imageId = imported.structured.media_id as string;
		const importedVideo = await mcp(A, "media", { action: "import", timeline_id: tlA, data_base64: readFileSync(MP4_FILE).toString("base64"), name: "halcyon-pour.mp4" });
		videoId = importedVideo.structured.media_id as string;
		expect(imageId).toBeTruthy();
		expect(videoId).toBeTruthy();

		const { resolveMediaProps } = await import("@/server/composition-media");
		// resolved server-side, inside a call's scope only
		const outside = await resolveMediaProps({ images: [imageId] });
		expect(outside.resolved).toBe(0);
		const { runWithOrg } = await import("@/server/tenant");
		const inside = await runWithOrg(A, () =>
			runWithCallScope({ timelineId: tlA }, () =>
				resolveMediaProps({ images: [imageId, `media:${imageId}`, `/api/projects/${tlA}/media/${imageId}`, `http://localhost:8791/api/projects/${tlA}/media/${videoId}?t=0.5`, videoId], label: "heart" }),
			),
		);
		expect(inside.problems).toEqual([]);
		expect(inside.resolved).toBe(5);
		const images = (inside.props as { images: string[]; label: string }).images;
		expect(images.slice(0, 3).every((url) => url.startsWith("data:image/png;base64,"))).toBe(true);
		expect(images.slice(3).every((url) => url.startsWith("data:image/jpeg;base64,"))).toBe(true);
		expect((inside.props as { label: string }).label).toBe("heart");
		// B can't pull A's media by URL; an unknown explicit ref names the param and what is allowed
		const fromB = await runWithOrg(B, () => runWithCallScope({ timelineId: tlB }, () => resolveMediaProps({ cards: [{ image: `/api/projects/${tlA}/media/${imageId}` }, { image: "media:nope-404" }] })));
		expect(fromB.resolved).toBe(0);
		expect(fromB.problems.map((problem) => problem.path)).toEqual(["cards[0].image", "cards[1].image"]);
		expect(fromB.problems[0].message).toContain("not found");
		expect(fromB.problems[1].message).toContain("media_id");

		// end to end: Floating Thumbnails (float-thumbs) with the three forms; the stored props keep the ids
		const applied = await mcp(A, "effects", {
			action: "apply",
			name: "FX-42",
			timeline_id: tlA,
			t: 0,
			duration_s: 1,
			params: { images: [imageId, `media:${videoId}#t=1`, `/api/projects/${tlA}/media/${imageId}`], cards: [{ label: "ORIGINAL" }, { label: "POUR" }, { label: "BOTTLE" }] },
		});
		if (process.env.MCP_GAPS_DEBUG) console.log("apply", applied.text.slice(0, 1500));
		expect(applied.isError).toBe(false);
		expect(applied.structured.commit_id).toBeTruthy();
		expect(applied.text).not.toContain("data:image");
		// the props stored on the element are the ids the caller sent, never the inlined data: images
		const stored = (applied.structured.composition as { props: { images: string[] } }).props.images;
		expect(stored).toEqual([imageId, `media:${videoId}#t=1`, `/api/projects/${tlA}/media/${imageId}`]);
		const summary = await mcp(A, "timeline", { action: "element", timeline_id: tlA, element_id: applied.structured.element_id as string });
		expect(summary.isError).toBe(false);
		expect(summary.text).not.toContain("data:image");
	}, 180_000);

	test("gap 2 — sweep: error answers of real tools carry no server path", async () => {
		const calls: Array<[string, Record<string, unknown>]> = [
			["effects", { action: "apply", name: "FX-42", timeline_id: tlA, t: 0, duration_s: 1, params: { images: ["C:/Users/someone/Desktop/cover-1.jpg"] } }],
			["effects", { action: "apply", name: "FX-42", timeline_id: tlA, t: 0, duration_s: 1, params: { images: ["b1cc6697-4b21-4d6e-97ce-ce14528febdf"] } }],
			["effects", { action: "apply", name: "FX-42", timeline_id: tlA, t: 0, duration_s: 1, params: { images: ["media:does-not-exist"] } }],
			["effects", { action: "apply", name: "FX-42", timeline_id: tlA, t: 0, duration_s: 1, params: { images: ["../../../../secret.png"] } }],
			["timeline", { action: "summary", timeline_id: "no-such-timeline" }],
			["media", { action: "import", timeline_id: tlA, path_hint: "C:/nowhere/halcyon/missing.mp4" }],
			["render", { render_id: "rmvzzzzzzzzzzzz", wait_s: 0 }],
			["look", { kind: "render", ref: "rmvzzzzzzzzzzzz" }],
			["composition", { action: "write", timeline_id: tlA, source: "<!doctype html><p>no params</p>", duration_s: 1 }],
			["references", { action: "add", timeline_id: tlA, files: [{ path: "C:/nowhere/ref.mp4" }] }],
			["cutout", { action: "status", job_id: "../../etc/passwd" }],
			["timeline_ops", { timeline_id: tlA, ops: [{ op: "import_media", kind: "image", url: "C:/nowhere/halcyon.png", name: "x" }] }],
			["sounds", { action: "place", timeline_id: tlA, name: "no-such-sound-anywhere", t: 0 }],
		];
		const leaks: string[] = [];
		const roots = [REPO, path.resolve(process.cwd()), dir, tmpdir()].map((root) => root.replace(/\\/g, "/").toLowerCase());
		for (const [tool, args] of calls) {
			const out = await mcp(A, tool, args);
			if (process.env.MCP_GAPS_DEBUG) console.log(tool, args.action ?? "", out.text.slice(0, 600));
			const sent = pathsIn(args);
			const text = out.text.replace(/\\\\/g, "\\");
			for (const p of findPaths(text)) {
				const norm = p.replace(/[\\/]+/g, "/").toLowerCase();
				if (!sent.has(norm.replace(/\/$/, "")) && !norm.startsWith("<")) leaks.push(`${tool} ${String(args.action ?? "")}: ${p}`);
			}
			for (const root of roots) if (text.replace(/\\/g, "/").toLowerCase().includes(root)) leaks.push(`${tool} ${String(args.action ?? "")}: root ${root}`);
		}
		expect(leaks).toEqual([]);
		// the file-path refusal says what to send instead
		const refused = await mcp(A, "effects", calls[0][1]);
		expect(refused.text).toContain("media import");
		expect(refused.text).toContain("media_id");
	}, 180_000);
});

describe("gap 1 — describe tells the client what an image param takes", () => {
	test("image params (and lists / objects of them) carry accepts", () => {
		expect(holdsImage({ type: "list", of: { type: "object", fields: { label: { type: "string" }, image: { type: "image" } } } })).toBe(true);
		expect(holdsImage({ type: "list", of: { type: "string" } })).toBe(false);
		expect(specRow("images", { type: "list", of: { type: "image" } }).accepts).toContain("media_id");
		expect(specRow("label", { type: "string" }).accepts).toBeUndefined();
	});
});
