/**
 * retention (2026-10-24): the measurer on synthetic clips (ffmpeg lavfi colour / SMPTE bars + a tone), the fix planner
 * and its ops (through the real ops@1 reducer), and the MCP `retention` + `check` tools end to end on a throwaway
 * PGlite store with a render row pointing at a synthetic master. Fictional Halcyon data; nothing leaves the OS temp
 * folder. Needs ffmpeg + ffprobe on PATH (the measurer tests skip without them).
 * Run: cd apps/web && bun test src/server/__tests__/retention.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { retentionFindings, retentionMap } from "@restorffcut/gate";
import { apply, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import { type PlanBase, planRetention, retentionOps } from "@/server/retention-plan";
import { emptyProject } from "@/server/timeline-skeleton";

const FFMPEG = process.env.RESTORFFCUT_FFMPEG?.trim() || "ffmpeg";
const HAS_FFMPEG = spawnSync(FFMPEG, ["-version"], { windowsHide: true }).status === 0;
const TOKEN = "retention-test-token-0123456789";
const saved = { data: process.env.RESTORFFCUT_DATA_DIR, media: process.env.RESTORFFCUT_MEDIA_DIR, token: process.env.RESTORFFCUT_SERVICE_TOKEN, db: process.env.RESTORFFCUT_DB, renders: process.env.RESTORFFCUT_RENDERS_DIR, gate: process.env.RESTORFFCUT_GATE_DIR };
const dir = mkdtempSync(path.join(tmpdir(), "rc-retention-"));

/** A clip of still segments (lavfi sources) with a 0.2 s tone at each `beeps` time. 270×480, 30 fps, H.264 + AAC. */
function makeClip(file: string, segments: Array<{ src: string; d: number }>, beeps: number[]): void {
	const total = segments.reduce((a, s) => a + s.d, 0);
	const tone = beeps.length ? beeps.map((b) => `between(t,${b},${b + 0.2})`).join("+") : "0";
	const args = ["-y", "-v", "error"];
	for (const s of segments) args.push("-f", "lavfi", "-i", `${s.src}${s.src.includes("=") ? ":" : "="}s=270x480:r=30:d=${s.d}`);
	args.push("-f", "lavfi", "-i", `aevalsrc=exprs='0.4*sin(2*PI*440*t)*(${tone})':s=44100:d=${total}`);
	const n = segments.length;
	args.push("-filter_complex", `${segments.map((_, i) => `[${i}:v]`).join("")}concat=n=${n}:v=1:a=0[v]`, "-map", "[v]", "-map", `${n}:a`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file);
	const r = spawnSync(FFMPEG, args, { windowsHide: true, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

const LATE = path.join(dir, "late-and-still.mp4"); // grey 2.5 s → bars 4.5 s → white 1 s; a tone on the first cut
const LIVELY = path.join(dir, "lively.mp4"); // a new picture every ≤ 1 s from 0.5 s

beforeAll(() => {
	if (!HAS_FFMPEG) return;
	makeClip(LATE, [{ src: "color=c=0x404040", d: 2.5 }, { src: "smptebars", d: 4.5 }, { src: "color=c=white", d: 1 }], [2.5]);
	makeClip(LIVELY, [{ src: "color=c=0x404040", d: 0.5 }, { src: "smptebars", d: 1 }, { src: "color=c=white", d: 1 }, { src: "color=c=0x202060", d: 1 }, { src: "smptebars", d: 1 }, { src: "color=c=black", d: 1.5 }], []);
}, 120_000);

/**
 * bun runs every test file in one process and the store is a process global: close whatever store an earlier file
 * left open and forget the per-store "ready" flags, so this file gets its own throwaway store (mcp-gaps-mvp's pattern).
 */
async function forgetStore(): Promise<void> {
	const g = globalThis as unknown as Record<string, unknown>;
	try {
		const handle = (await g.__restorffcutProjectStore) as { db?: { $client?: { close?: () => Promise<void> } } } | undefined;
		await handle?.db?.$client?.close?.();
	} catch {
		// never opened, or already closed
	}
	for (const key of ["__restorffcutProjectStore", "__restorffcutCompositionStoreReady", "__restorffcutVersionNamesReady", "__restorffcutStylesStoreReady", "__restorffcutStylesOrgScoped"]) delete g[key];
}

afterAll(async () => {
	await forgetStore();
	for (const [key, value] of [
		["RESTORFFCUT_DATA_DIR", saved.data],
		["RESTORFFCUT_MEDIA_DIR", saved.media],
		["RESTORFFCUT_SERVICE_TOKEN", saved.token],
		["RESTORFFCUT_DB", saved.db],
		["RESTORFFCUT_RENDERS_DIR", saved.renders],
		["RESTORFFCUT_GATE_DIR", saved.gate],
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

// ─── the measurer (ffmpeg) ───────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_FFMPEG)("measureRetention on synthetic clips", () => {
	test("a late hook and a 4.5 s still: first change 2.5 s, the still stretch, cuts, a cut on the tone", async () => {
		process.env.RESTORFFCUT_GATE_DIR = path.join(dir, "gate");
		const { measureRetention } = await import("@/server/retention-measure");
		const got = await measureRetention(LATE, { cache: false });
		const m = got.map;
		expect(m.duration_s).toBeCloseTo(8, 1);
		expect(m.first_change_s).toBeCloseTo(2.5, 1);
		expect(m.events.length).toBe(2);
		expect(m.events[1]).toBeCloseTo(7, 1);
		expect(m.cuts.length).toBe(2);
		expect(m.cuts_on_hit).toBe(1);
		expect(m.cuts_on_hit_pct).toBe(50);
		expect(m.over_bar.map((s) => Math.round(s.dur * 10) / 10)).toEqual([4.5]);
		const run = retentionFindings(m);
		expect(run.findings.map((f) => f.rule)).toEqual(["HOOK", "DEAD"]);
		// cached the second time, same answer
		const again = await measureRetention(LATE);
		const third = await measureRetention(LATE);
		expect(third.cached).toBe(true);
		expect(third.map.events).toEqual(again.map.events);
	}, 60_000);

	test("a lively clip: first change at 0.5 s, nothing over 3 s, no findings", async () => {
		const { measureRetention } = await import("@/server/retention-measure");
		const m = (await measureRetention(LIVELY, { cache: false })).map;
		expect(m.first_change_s).toBeCloseTo(0.5, 1);
		expect(m.longest?.dur ?? 9).toBeLessThanOrEqual(1.6);
		expect(m.events_per_10s).toBeGreaterThan(8);
		expect(retentionFindings(m).findings).toEqual([]);
	}, 60_000);
});

// ─── the planner + its ops (pure, through the real reducer) ──────────────────────────────────────────────────

const WORDS = [
	["Steeped", 0.42, 0.9], ["eighteen", 4.1, 4.6], ["hours", 4.6, 5.0], ["not", 5.4, 5.6], ["twelve", 5.6, 6.1],
	["cold", 6.9, 7.2], ["water", 7.2, 7.6], ["ground", 8.1, 8.5], ["beans", 8.5, 8.9], ["time", 9.0, 9.3],
].map(([text, start, end]) => ({ text: String(text), start: Number(start), end: Number(end) }));

function mapWith(events: number[], duration: number) {
	// diffs that put events exactly at these times (score.py's detector on a calm file)
	const d = new Array(Math.round(duration * 15) - 1).fill(0.5);
	for (const t of events) d[Math.round(t * 15) - 1] = 30;
	return retentionMap({ duration, diffs: d, cuts: [], onsets: [] });
}

const base = (over: Partial<PlanBase> = {}): PlanBase => ({ id: "el-motion", name: "Neon grid code", type: "video", start: 0, end: 12, composition: true, keyed: false, scale: 1, x: 0, y: 0, ...over });

describe("planRetention", () => {
	const map = mapWith([2.6, 3.4, 9.4], 12);

	test("the open move lands on the first word inside the first second; every still stretch gets moves every ~2 s", () => {
		const plan = planRetention({ map, words: WORDS, baseAt: () => base(), endCard: null, fps: 30 });
		const hook = plan.moves.find((m) => m.for === "hook");
		expect(hook).toMatchObject({ kind: "punch_in", t: 0.433, word: { text: "Steeped" } });
		expect(plan.predicted.first_change_s).toBeLessThanOrEqual(1);
		expect(plan.predicted.longest_s).toBeLessThanOrEqual(3);
		expect(plan.predicted.over_bar).toEqual([]);
		// moves snap to spoken words, content words first
		const fill = plan.moves.filter((m) => m.for === "dead" && m.word);
		expect(fill.length).toBeGreaterThanOrEqual(2); // a punch-in on one word, the punch back out on the next
		for (const m of fill) expect(["eighteen", "twelve", "water", "ground", "beans", "cold", "hours"]).toContain(m.word?.text ?? "");
		// every move sits on the 30 fps grid and no two moves are closer than 0.4 s (no flash)
		const times = plan.moves.map((m) => m.t).sort((a, b) => a - b);
		for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(0.4);
		for (const t of times) expect(Math.abs(t * 30 - Math.round(t * 30))).toBeLessThan(0.05);
	});

	test("a punch is never released within 0.35 s of the picture's end (that would flash the unzoomed frame)", () => {
		const plan = planRetention({ map, words: [], baseAt: (t) => (t < 9.4 ? base({ id: "a", end: 9.4 }) : base({ id: "b", start: 9.4 })), endCard: null, fps: 30 });
		for (const m of plan.moves.filter((x) => x.kind === "punch_out" && x.element_id === "a")) expect(9.4 - m.t).toBeGreaterThanOrEqual(0.35);
	});

	test("footage gets word pops between punches; a base with its own keyframes is never punched", () => {
		const footage = planRetention({ map, words: WORDS, baseAt: () => base({ composition: false, name: "A-roll" }), endCard: null, fps: 30 });
		expect(footage.moves.some((m) => m.kind === "word_pop")).toBe(true);
		const keyed = planRetention({ map, words: WORDS, baseAt: () => base({ keyed: true }), endCard: null, fps: 30 });
		expect(keyed.moves.every((m) => m.kind === "word_pop")).toBe(true);
	});

	test("the marked end card stays still", () => {
		const tail = mapWith([0.4, 2.2, 4.2, 6.6], 12); // 6.6 → 12 is the end card
		const plan = planRetention({ map: tail, words: [], baseAt: () => base(), endCard: { t: 6.5, t_end: 12, why: "element End card" }, fps: 30 });
		expect(plan.moves).toEqual([]);
		expect(plan.skipped[0].why).toMatch(/end card/);
	});

	test("ops: keyframes in time order with hold, the face kept in place, a word pop clear of the face, SFX on a new lane — and the reducer takes them", () => {
		const plan = planRetention({ map, words: WORDS, baseAt: () => base({ id: "clip", composition: false, name: "A-roll" }), endCard: null, fps: 30 });
		const faces: Record<number, { x: number; y: number }> = {};
		const pops: Record<number, { y: number; size: number }> = {};
		plan.moves.forEach((m, i) => {
			if (m.kind === "punch_in") faces[i] = { x: 100, y: -300 };
			if (m.kind === "word_pop") pops[i] = { y: 380, size: 7 };
		});
		const sound = { id: "whoosh-short", url: "/sfx/whoosh-short.wav", duration_s: 0.45, sync_s: 0.267, default_db: -6 };
		const { ops } = retentionOps(plan, { elements: { clip: base({ id: "clip", composition: false }) }, faces, popPlace: pops, sounds: { punch: sound, pop: { ...sound, id: "pop", url: "/sfx/pop.wav", duration_s: 0.2, sync_s: 0.01 } } });
		const scale = ops.filter((o) => o.op === "keyframe" && o.prop === "scale");
		expect(scale[0]).toMatchObject({ t: 0, value: 1 });
		expect(scale[1]).toMatchObject({ value: 1.15, ease: "hold" });
		const xs = ops.filter((o) => o.op === "keyframe" && o.prop === "x");
		// the face at x = 100 px stays at 100 px: 1.15 × (100 − x') + x' = 100 → x' = (1 − 1.15) × 100 = −15
		expect(xs[1]).toMatchObject({ value: -15, ease: "hold" });
		expect(ops.some((o) => o.op === "text_pop" && (o.style as { y: number }).y === 380)).toBe(true);
		expect(ops.filter((o) => o.op === "add_track")).toHaveLength(1);
		expect(ops.filter((o) => o.op === "sfx").length).toBeGreaterThan(0);

		// the real reducer: a 9:16 timeline with one 12 s clip on the main track, then the fix
		const project = emptyProject({ id: "retention-test", name: "Halcyon Cold Brew / retention test" }) as unknown as OpsProject;
		const setup = apply(project, [
			{ op: "import_media", author: "user", kind: "video", url: "https://example.invalid/halcyon-a-roll.mp4", name: "A-roll", duration: 12, width: 1080, height: 1920, ref: "m" },
			{ op: "insert", author: "user", track: "main", t: 0, media: "m", out: 12, ref: "clip" },
		] as unknown as Op[], { seed: "retention-test" });
		if (!setup.ok) console.log(JSON.stringify(setup.conflicts).slice(0, 800));
		expect(setup.ok).toBe(true);
		const clipId = setup.changes.refs.clip;
		const real = JSON.parse(JSON.stringify(ops).split('"clip"').join(`"${clipId}"`)) as Op[];
		const fixed = apply(setup.project, real, { seed: "retention-test-fix" });
		if (!fixed.ok) console.log(JSON.stringify(fixed.conflicts).slice(0, 1500));
		expect(fixed.conflicts).toEqual([]);
		expect(fixed.ok).toBe(true);
	});
});

// ─── MCP end to end: retention map + fix, check's retention block ────────────────────────────────────────────

describe.skipIf(!HAS_FFMPEG)("MCP retention + check on a throwaway store", () => {
	type Handler = (request: Request) => Promise<Response>;
	let handleMcp: Handler;
	let sessionId = "";
	let rpcId = 1;
	let timelineId = "";
	let renderId = "";

	const post = (body: unknown): Promise<Response> =>
		handleMcp(
			new Request("http://localhost:8791/api/mcp", {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
				body: JSON.stringify(body),
			}),
		);
	async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const response = await post({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } });
		const message = (await response.json()) as { result?: { structuredContent?: Record<string, unknown> }; error?: { message: string } };
		if (!message.result) throw new Error(`${name}: ${response.status} ${JSON.stringify(message.error)}`);
		return message.result.structuredContent ?? {};
	}

	beforeAll(async () => {
		process.env.RESTORFFCUT_DATA_DIR = path.join(dir, "pglite");
		process.env.RESTORFFCUT_MEDIA_DIR = path.join(dir, "media");
		process.env.RESTORFFCUT_SERVICE_TOKEN = TOKEN;
		process.env.RESTORFFCUT_DB = "pglite";
		process.env.RESTORFFCUT_RENDERS_DIR = path.join(dir, "renders");
		process.env.RESTORFFCUT_GATE_DIR = path.join(dir, "gate");
		mkdirSync(process.env.RESTORFFCUT_RENDERS_DIR, { recursive: true });
		await forgetStore();
		({ handleMcp } = await import("@/mcp/handler"));
		const init = await post({ jsonrpc: "2.0", id: rpcId++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "retention-test" } } });
		sessionId = init.headers.get("mcp-session-id") ?? "";

		timelineId = (await call("timeline", { action: "create", name: "Halcyon Cold Brew / retention test", aspect: "9:16" })).timeline_id as string;
		const head = ((await call("timeline", { action: "summary", timeline_id: timelineId })).head as string) ?? "";
		const done = await call("timeline_ops", {
			timeline_id: timelineId,
			base_commit: head,
			message: "a still clip + captions",
			ops: [
				{ op: "import_media", kind: "video", url: "https://example.invalid/halcyon-still.mp4", name: "Halcyon still", duration: 8, width: 1080, height: 1920, ref: "m" },
				{ op: "insert", track: "main", t: 0, media: "m", out: 8 },
				{ op: "add_captions", words: [{ text: "Steeped", start: 0.4, end: 0.9 }, { text: "eighteen", start: 3.5, end: 4.0 }, { text: "hours", start: 4.0, end: 4.4 }, { text: "cold", start: 5.2, end: 5.5 }, { text: "water", start: 5.5, end: 6.0 }], max_words: 2 },
			],
		});
		const commit = done.commit_id as string;
		expect(commit).toBeTruthy();
		// a finished render row of that commit whose master is the synthetic clip (the render pipeline is not run here)
		const store = await import("@/server/renders-store");
		renderId = store.newRenderId();
		const now = new Date().toISOString();
		store.writeRow({
			schema: store.RENDER_SCHEMA, render_id: renderId, project_id: timelineId, commit, branch: null, quality: "preview", status: "done", phase: "done", progress: 1,
			created_at: now, updated_at: now, started_at: now, finished_at: now, job_dir: dir, file: LATE, bytes: 1, duration_s: 8, width: 270, height: 480, fps: 30,
			video_codec: "h264", audio_codec: "aac", loudness: null, timings: {}, media: [], error: null, pid: null, log: "", check: null,
		});
	}, 120_000);

	test("retention map names the open move and the moves in the still stretch, and points at fix", async () => {
		const got = await call("retention", { action: "map", timeline_id: timelineId });
		if (!got.retention) console.log(JSON.stringify(got).slice(0, 1500));
		const r = got.retention as { hook: { ok: boolean; first_change_s: number; next: string }; still_over_3s: Array<{ next: string }>; fix?: { tool: string } };
		expect(r.hook.ok).toBe(false);
		expect(r.hook.next).toMatch(/Steeped/);
		expect(r.still_over_3s.length).toBe(1);
		expect(r.fix?.tool).toBe("retention");
		expect((got.next as { tool: string }).tool).toBe("retention");
	}, 120_000);

	test("check answers HOOK + DEAD (SHOULD) with the retention block and the fix call", async () => {
		const got = await call("check", { render_id: renderId, comments: false });
		const rules = (got.findings as Array<{ rule: string; severity: string; fix_call: { tool: string; arguments: Record<string, unknown> } }>).filter((f) => f.rule === "HOOK" || f.rule === "DEAD");
		expect(rules.map((f) => f.rule).sort()).toEqual(["DEAD", "HOOK"]);
		for (const f of rules) {
			expect(f.severity).toBe("should");
			expect(f.fix_call.tool).toBe("retention");
			expect(f.fix_call.arguments.timeline_id).toBe(timelineId);
		}
		expect((got.retention as { longest_still_s: number }).longest_still_s).toBeGreaterThan(4);
		expect((got.ran as string[]).includes("HOOK")).toBe(true);
	}, 180_000);

	test("retention fix: ONE commit with the punch-ins, word pops and SFX; a second fix on the old render is refused", async () => {
		const before = (await call("timeline", { action: "summary", timeline_id: timelineId })).head as string;
		const got = await call("retention", { action: "fix", timeline_id: timelineId, render_id: renderId });
		expect(got.commit_id).toBeTruthy();
		expect(got.placed as number).toBeGreaterThanOrEqual(2);
		expect((got.message as string).startsWith("retention fix")).toBe(true);
		expect((got.next as { tool: string }).tool).toBe("render");
		const history = await call("history", { timeline_id: timelineId, limit: 3 });
		expect(JSON.stringify(history)).toContain("retention fix");
		const after = (await call("timeline", { action: "summary", timeline_id: timelineId })).head as string;
		expect(after).not.toBe(before);
		expect(after).toBe(got.commit_id as string);
		const element = await call("timeline", { action: "summary", timeline_id: timelineId });
		expect(JSON.stringify(element)).toMatch(/retention (punch-in|word pop)/);
		// the render shows the old head now: fixing again with it is refused, nothing committed
		const again = await call("retention", { action: "fix", timeline_id: timelineId, render_id: renderId });
		expect((again.error as { code: string }).code).toBe("stale_render");
	}, 180_000);
});
