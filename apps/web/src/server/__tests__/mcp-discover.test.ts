/**
 * mcp-discover (wave 5, 2026-10-20): the op reference, readable timelines, result hygiene and the hint audit.
 * Pure tests (no DB, no dev server); the live path is in docs/restorff/worklog/mcp-discover.md (bun scripts/mcp-call.ts).
 */
import { describe, expect, test } from "bun:test";
import { apply, OP_NAMES, opFieldRules, validateOp, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import { auditNext, defaultNext, laneFor, type HeadLookup } from "@/mcp/hints";
import { closestOps, describeRule, explainInvalidOps, fieldsOf, OP_DOCS, opsItemSchema, referencePayload } from "@/mcp/ops-reference";
import { fitFields, makeMcpHandler, orderKeys, oversize, type Payload, type Tool } from "@/mcp/protocol";
import { elementView, pageView, resolveTrackNames, resolveTrackStrict, summaryView } from "@/server/timeline-read";
import { exactSeconds, scrubData, secondsEverywhere, secondsInText } from "@/server/timeline-read-hygiene";
import { emptyProject } from "@/server/timeline-skeleton";
import type { ProjectSnapshot } from "@/sync/snapshot";

const JPEG = `data:image/jpeg;base64,${"/9j/4AAQSkZJRgABAgAAAQABAAD".repeat(200)}`;

/** A Halcyon fixture: 40 text elements on TEXT, a caption chunk on CAPTIONS, keyframes and a moved one. */
function fixture(count = 40): ProjectSnapshot {
	const base = emptyProject({ id: "halcyon-fixture", name: "Halcyon Cold Brew / fixture", now: "2026-10-20T00:00:00.000Z" }) as unknown as OpsProject;
	const ops: Array<Record<string, unknown>> = [];
	for (let i = 0; i < count; i++) {
		ops.push({ op: "insert", author: "claude", track: "trk-text", t: i / 3, dur: 1 / 3, text: `Halcyon word ${i} steeped eighteen hours`, ref: `w${i}` });
	}
	ops.push({ op: "set", author: "claude", el: "w0", prop: "y", value: -600 });
	ops.push({ op: "keyframe", author: "claude", el: "w1", prop: "scale", t: 1 / 3, value: 1 });
	ops.push({ op: "keyframe", author: "claude", el: "w1", prop: "scale", t: 2 / 3 - 1 / 30, value: 1.12, ease: "ease_out" });
	ops.push({ op: "insert", author: "claude", track: "trk-captions", t: 0.4, dur: 1.2, text: "Steeped slow", ref: "cap" });
	const result = apply(base, ops as unknown as Op[], { seed: "mcp-discover-fixture" });
	if (!result.ok) throw new Error(JSON.stringify(result.conflicts.slice(0, 3)));
	return result.project as unknown as ProjectSnapshot;
}

const idOf = (snapshot: ProjectSnapshot, text: string) =>
	(snapshot.scenes[0].tracks?.overlay ?? []).flatMap((track) => track.elements).find((element) => (element.params as { content?: string }).content === text)?.id as string;

// ─── op reference ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("op reference (generated from the validator)", () => {
	test("every op has docs + an example that validates; docs and validator agree field for field", () => {
		for (const op of OP_NAMES) {
			const doc = OP_DOCS[op];
			expect(doc, op).toBeDefined();
			expect(validateOp({ ...doc.example, author: "claude" }), `${op} example`).toEqual([]);
			const rules = opFieldRules(op);
			expect(rules, op).not.toBeNull();
			const fields = [...Object.keys(rules?.required ?? {}), ...Object.keys(rules?.optional ?? {})].sort();
			expect(Object.keys(doc.fields).sort(), `${op} documented fields = validator fields`).toEqual(fields);
		}
	});

	test("types and ranges come from the rules", () => {
		const move = fieldsOf("move");
		expect(move?.required.map((f) => f.field)).toEqual(["el", "t"]);
		expect(move?.required.find((f) => f.field === "t")?.type).toBe("number, >= 0");
		expect(move?.optional.map((f) => f.field)).toEqual(["track"]);
		const canvas = fieldsOf("set_canvas");
		expect(canvas?.optional.find((f) => f.field === "w")?.type).toBe("integer, >= 16, <= 8192");
		expect(canvas?.rule).toBe("needs at least one of w, h, fps, background");
		expect(fieldsOf("transition")?.optional.find((f) => f.field === "dur")?.type).toBe("number, > 0, <= 10");
		expect(fieldsOf("add_track")?.required[0].schema.enum).toEqual(["video", "audio", "text", "caption", "overlay", "effect"]);
		expect(fieldsOf("insert")?.optional.find((f) => f.field === "style")?.type).toContain("object with keys font, size");
		expect(fieldsOf("insert")?.rule).toBe("needs exactly one of media, text, shape");
		expect(fieldsOf("grade")?.optional.find((f) => f.field === "params")?.type).toContain("exposure");
		expect(describeRule((value) => (typeof value === "boolean" ? null : "must be a boolean")).text).toBe("boolean");
	});

	test("reference payloads: the whole list and one op", () => {
		const all = referencePayload();
		expect((all.ops as unknown[]).length).toBe(OP_NAMES.length);
		const trim = referencePayload("trim");
		expect(trim.required).toEqual([{ field: "el", type: "string (not empty)", means: expect.stringContaining("element id") }]);
		expect((trim.example as { op: string }).op).toBe("trim");
		const unknown = referencePayload("remove");
		expect((unknown.error as { did_you_mean: string[] }).did_you_mean[0]).toBe("delete");
		expect(JSON.stringify(all)).not.toMatch(/README|plan\/06|packages\//);
	});

	test("timeline_ops.ops schema: oneOf keyed by op, small enough for a client", () => {
		const schema = opsItemSchema();
		expect(schema.oneOf?.length).toBe(OP_NAMES.length);
		const trim = schema.oneOf?.find((branch) => branch.title === "trim");
		expect(trim?.properties?.op).toEqual({ const: "trim" });
		expect(trim?.required).toEqual(["op", "el"]);
		expect(JSON.stringify(schema).length).toBeLessThan(20_000);
	});
});

// ─── invalid ops name the right field (H1) ───────────────────────────────────────────────────────────────────────

describe("invalid ops are explained (H1)", () => {
	test("trim with target → use el; allowed + required listed; next = the reference, not a repo file", () => {
		const ops = [{ op: "trim", author: "claude", target: "abc", out: 6 }];
		const { errors } = { errors: validateOp(ops[0], 0) };
		const explained = explainInvalidOps(ops, errors);
		const unknown = explained.errors.find((error) => error.path === "target");
		expect(unknown?.did_you_mean).toBe("el");
		expect(unknown?.required).toEqual(["el"]);
		expect(unknown?.allowed).toEqual(expect.arrayContaining(["el", "in", "out"]));
		expect(explained.message).toContain('use "el"');
		expect(explained.message).toContain("trim takes el (required), in, out");
		expect(explained.next).toEqual({ do: expect.any(String), tool: "timeline_ops", arguments: { action: "reference", op: "trim" } });
		expect(JSON.stringify(explained)).not.toMatch(/README|plan\/06|\.md/);
		expect((explained.fields.trim as { example: unknown }).example).toEqual(OP_DOCS.trim.example);
	});

	test("delete with target (paper-collage n 21) and keyframe with keys (n 66)", () => {
		const del = explainInvalidOps([{ op: "delete", author: "claude", target: "x" }], validateOp({ op: "delete", author: "claude", target: "x" }, 0));
		expect(del.errors.find((e) => e.path === "target")?.did_you_mean).toBe("el");
		const kf = { op: "keyframe", author: "claude", el: "x", prop: "scale", keys: [[0, 1]] };
		const explained = explainInvalidOps([kf], validateOp(kf, 0));
		expect(explained.message).toContain("keyframe takes el (required), prop (required), t (required), value (required)");
		expect(explained.errors.find((e) => e.path === "keys")?.did_you_mean).toContain("ONE keyframe per op");
	});

	test("an unknown op name gets a did-you-mean", () => {
		expect(closestOps("remove")[0]).toBe("delete");
		expect(closestOps("spilt")).toContain("split");
		const bad = { op: "cut", author: "claude", el: "x", t: 1 };
		const explained = explainInvalidOps([bad], validateOp(bad, 0));
		expect(explained.errors[0].did_you_mean).toBe("split");
	});
});

// ─── hygiene: data URLs, ticks, size ─────────────────────────────────────────────────────────────────────────────

describe("result hygiene (18a)", () => {
	test("whole data URLs → mime + sha256 + length; inline ones marked; code under `source` kept", () => {
		const { value, omitted } = scrubData({ params: { cards: [{ image: JPEG, stat: "" }] }, note: `see ${JPEG} here`, source: `<img src="${JPEG}">` });
		const card = (value.params.cards[0] as unknown as { image: Record<string, unknown> }).image;
		expect(card).toEqual({ omitted: "data URL", mime: "image/jpeg", sha256: expect.stringMatching(/^[0-9a-f]{16}$/), chars: JPEG.length });
		expect(value.note).toMatch(/^see data:image\/jpeg;base64,\[omitted: sha256 [0-9a-f]{16}, \d+ chars\] here$/);
		expect(value.source).toContain(JPEG);
		expect(omitted.length).toBe(2);
		const { source: _code, ...rest } = value;
		expect(JSON.stringify(rest)).not.toContain("/9j/4AAQ");
	});

	test("bare long base64 is omitted; short strings untouched", () => {
		const { value } = scrubData({ blob: "QUJD".repeat(600), word: "data:,hi" });
		expect(value.blob as unknown).toEqual({ omitted: "base64", sha256: expect.any(String), chars: 2400 });
		expect(value.word).toBe("data:,hi");
	});

	test("the reducer's tick messages become seconds (H7); prose counts and *_ticks fields stay", () => {
		expect(secondsInText('video "halcyon-raw-take.mp4" at 0 ticks for 6441600 on "V1 A-ROLL"')).toBe('video "halcyon-raw-take.mp4" at 0 s for 53.68 s on "V1 A-ROLL"');
		expect(secondsInText("[1020000, 1972000) ticks overlaps element 86bd8e69 [368040, 1020040) on track trk-main")).toBe(
			"[8.5, 16.433333) s overlaps element 86bd8e69 [3.067, 8.500333) s on track trk-main",
		);
		expect(secondsInText('ripple-deleted "x", closed a 120000-tick gap on "V1"')).toBe('ripple-deleted "x", closed a 1 s gap on "V1"');
		expect(secondsInText("split at 1022400 ticks: left a, right b")).toBe("split at 8.52 s: left a, right b");
		expect(secondsInText("the box draws 3 ticks")).toBe("the box draws 3 ticks");
		expect(secondsEverywhere({ start_ticks: "at 0 ticks", summary: "moved to 240000 ticks" })).toEqual({ start_ticks: "at 0 ticks", summary: "moved to 2 s" });
	});

	test("exact seconds give back every tick (ms rounding did not: the warm-moody move conflict)", () => {
		let msBroken = 0;
		for (let ticks = 0; ticks < 2_000_000; ticks += 37) {
			expect(Math.round(exactSeconds(ticks) * 120_000)).toBe(ticks);
			if (Math.round((Math.round((ticks / 120_000) * 1000) / 1000) * 120_000) !== ticks) msBroken++;
		}
		expect(msBroken).toBeGreaterThan(0);
	});

	test("commit_id first; a write over the cap keeps its commit and is NOT an error (H4)", () => {
		expect(Object.keys(orderKeys({ ok: true, applied: 3, commit_id: "c0ffee", next: {} }))).toEqual(["commit_id", "ok", "applied", "next"]);
		expect(Object.keys(orderKeys({ a: 1, next: {}, omitted_data: {} }))).toEqual(["a", "omitted_data", "next"]);
		const big = { applied: 1, effect: { props: "x".repeat(90_000) }, commit_id: "c0ffee12", timeline_id: "t1", next: { do: "Render it.", tool: "render" } };
		const cut = oversize(big, { tool: "effects", isError: false, chars: 90_200, limit: 75_000, hint: null });
		expect(cut.isError).toBe(false);
		expect(Object.keys(cut.payload)[0]).toBe("commit_id");
		expect(cut.payload.committed).toBe(true);
		expect((cut.payload.trimmed as { dropped: Array<{ field: string }> }).dropped.map((d) => d.field)).toEqual(["effect"]);
		expect((cut.payload.trimmed as { note: string }).note).toContain("IS made");
		expect(cut.payload.next).toEqual({ do: "Render it.", tool: "render" });
		expect(JSON.stringify(cut.payload).length).toBeLessThan(75_000);
	});

	test("a read over the cap names a real paging argument (H3: was 'Page it' with none)", () => {
		const hint = { do: "Read it in pages: the same call with offset.", tool: "timeline", arguments: { action: "get", timeline_id: "t1", offset: 0 } };
		const cut = oversize({ snapshot: { huge: "y".repeat(80_000) }, timeline_id: "t1", head: "abc" }, { tool: "timeline", isError: false, chars: 80_100, limit: 75_000, hint });
		expect(cut.isError).toBe(true);
		expect((cut.payload.error as { code: string; message: string }).message).toContain("offset");
		expect(cut.payload.next).toEqual(hint);
		expect(cut.payload.partial).toEqual({ timeline_id: "t1", head: "abc" });
		expect(fitFields({ a: 1, b: "z".repeat(50) }, 30).dropped.map((d) => d.field)).toEqual(["b"]);
	});

	test("through the protocol: data URLs scrubbed, commit kept, isError false, images untouched", async () => {
		const tool: Tool = {
			name: "fake_apply",
			description: "test",
			inputSchema: { type: "object", properties: {} },
			// 30 echoed images (scrubbed) + 80 KB of ordinary text (not base64: it has spaces) → over the cap after a write
			run: () => ({ payload: { applied: 1, effect: { cards: Array.from({ length: 30 }, () => ({ image: JPEG })) }, commit_id: "c0ffee99", filler: "steeped slow ".repeat(6_200) } }),
		};
		const handle = makeMcpHandler({ serverInfo: { name: "t", version: "0" }, tools: [tool] });
		const post = (body: unknown, session?: string) =>
			handle(new Request("http://localhost/api/mcp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(session ? { "mcp-session-id": session } : {}) } }));
		const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
		const session = init.headers.get("mcp-session-id") as string;
		const reply = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fake_apply", arguments: {} } }, session)).json()) as {
			result: { isError?: boolean; structuredContent: Payload; content: Array<{ text: string }> };
		};
		expect(reply.result.isError).toBeUndefined();
		expect(Object.keys(reply.result.structuredContent)[0]).toBe("commit_id");
		expect(reply.result.content[0].text).not.toContain("/9j/4AAQ");
		expect(reply.result.content[0].text.length).toBeLessThan(75_000);
		expect((reply.result.structuredContent.omitted_data as { count: number }).count).toBe(30);
		expect(reply.result.structuredContent.committed).toBe(true);
		expect((reply.result.structuredContent.trimmed as { dropped: Array<{ field: string }> }).dropped.map((d) => d.field)).toEqual(["filler"]);
	});
});

// ─── reading a timeline (gap 1) ──────────────────────────────────────────────────────────────────────────────────

describe("reading a timeline", () => {
	test("summary: exact seconds, end, non-default transforms, keyframe counts", () => {
		const snapshot = fixture();
		const read = summaryView(snapshot);
		if (!("summary" in read) || !read.summary) throw new Error("no summary");
		const text = read.summary.tracks.find((track) => track.name === "TEXT");
		const third = text?.elements[2] as { t: number; dur: number; end: number };
		expect(third.t).toBe(0.666667);
		expect(Math.round(third.t * 120_000)).toBe(80_000);
		expect(third.end).toBe(1);
		const first = text?.elements[0] as { transform?: Record<string, number> };
		expect(first.transform).toEqual({ y: -600 });
		const second = text?.elements[1] as { keyframes?: Record<string, number> };
		expect(second.keyframes).toEqual({ scale_x: 2, scale_y: 2 });
		expect("page" in read.summary).toBe(false);
	});

	test("summary pages under a small budget and the pages add up to every element", () => {
		const snapshot = fixture(120);
		const seen: string[] = [];
		let offset: number | null = 0;
		let pages = 0;
		while (offset !== null && pages < 50) {
			const read = summaryView(snapshot, { offset }, 12_000);
			if (!("summary" in read) || !read.summary) throw new Error("no summary");
			expect(JSON.stringify(read.summary).length).toBeLessThan(12_000);
			for (const track of read.summary.tracks) for (const element of track.elements as Array<{ id: string }>) seen.push(element.id);
			offset = read.nextOffset;
			pages++;
		}
		expect(pages).toBeGreaterThan(1);
		expect(new Set(seen).size).toBe(121);
	});

	test("get pages: full elements in seconds and *_ticks, data URLs scrubbed, every page under the limit", () => {
		const snapshot = fixture(60);
		const text = snapshot.scenes[0].tracks?.overlay?.find((track) => track.name === "TEXT");
		(text?.elements[3] as { restorff?: unknown }).restorff = { composition: { name: "orbit", props: { cards: [{ image: JPEG }] } } };
		let offset: number | null = 0;
		let total = 0;
		while (offset !== null) {
			const read = pageView(snapshot, { track: "TEXT", offset }, 15_000);
			if (!("page" in read) || !read.page) throw new Error(JSON.stringify(read));
			const json = JSON.stringify(read.page);
			expect(json.length).toBeLessThan(15_000);
			expect(json).not.toContain("/9j/4AAQ");
			const elements = read.page.tracks[0].elements as Array<{ t: number; start_ticks: number }>;
			for (const element of elements) expect(Math.round(element.t * 120_000)).toBe(element.start_ticks);
			total += elements.length;
			offset = read.nextOffset;
		}
		expect(total).toBe(60);
		const window = pageView(snapshot, { from_s: 1, to_s: 2 });
		if (!("page" in window) || !window.page) throw new Error("no page");
		expect(window.page.page.total).toBe(4); // 1.0, 1.333, 1.667 on TEXT + the caption (0.4–1.6)
	});

	test("element: full props, transform, keyframes in seconds, neighbours, op templates with exact numbers", () => {
		const snapshot = fixture();
		const id = idOf(snapshot, "Halcyon word 1 steeped eighteen hours");
		const view = elementView(snapshot, id);
		expect(view?.element.t).toBe(0.333333);
		expect(view?.element.start_ticks).toBe(40_000);
		expect(view?.element.transform).toEqual({ x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 });
		const scale = (view?.element.keyframes as Record<string, { keys: Array<{ t: number; at: number; value: number }> }>).scale_x;
		expect(scale.keys.map((key) => key.at)).toEqual([0.333333, 0.633333]);
		expect(view?.before?.gap_s).toBe(0);
		expect(view?.op_templates[0]).toEqual({ op: "move", el: id, t: 0.333333 });
		const moved = apply(snapshot as unknown as OpsProject, [{ ...(view?.op_templates[0] as object), author: "claude" } as Op], { seed: "noop-move" });
		expect(moved.ok).toBe(true);
		expect(elementView(snapshot, "nope")).toBeNull();
	});

	test("tracks by name: unique names resolve, V1 = main, duplicates are ambiguous (never a guess)", () => {
		const snapshot = fixture(2);
		expect(resolveTrackStrict(snapshot, "MUSIC").match?.track.id).toBe("trk-music");
		expect(resolveTrackStrict(snapshot, "v1").match?.group).toBe("main");
		expect(resolveTrackStrict(snapshot, "V2").match?.track.id).toBe("trk-broll");
		const twice = apply(snapshot as unknown as OpsProject, [{ op: "add_track", author: "claude", kind: "text", name: "TEXT" } as Op], { seed: "dup" });
		const dup = twice.project as unknown as ProjectSnapshot;
		expect(resolveTrackStrict(dup, "TEXT").match).toBeNull();
		expect(resolveTrackStrict(dup, "TEXT").ambiguous.length).toBe(2);
		const { ops, resolved } = resolveTrackNames(snapshot, [
			{ op: "move", el: "x", t: 1, track: "MUSIC" },
			{ op: "duck", track: "music", under: "V1", amount_db: 8 },
			{ op: "add_track", kind: "text", ref: "mine" },
			{ op: "insert", track: "mine", t: 0, text: "x", dur: 1 },
		]);
		expect(ops[0]).toMatchObject({ track: "trk-music" });
		expect(ops[1]).toMatchObject({ track: "trk-music", under: "main" });
		expect(ops[3]).toMatchObject({ track: "mine" });
		expect(resolved.length).toBe(3);
	});
});

// ─── the hint audit (gap 10): one test per fixed hint ────────────────────────────────────────────────────────────

const noLookup: HeadLookup = async () => null;

describe("hint audit", () => {
	test("H6 render wait: status at the top level too, nested copy kept", async () => {
		const payload = { render: { render_id: "rabc", status: "running", progress: 0.4 }, next: { do: "Wait", tool: "render" } };
		const out = await auditNext(payload, { tool: "render", args: { render_id: "rabc" }, isError: false }, noLookup);
		expect(out).toMatchObject({ status: "running", render_id: "rabc", ready: false, progress: 0.4, render: { status: "running" } });
		expect(Object.keys(out).at(-1)).toBe("next");
	});

	test("H8 approve, already approved: render the head, not the old approved commit", async () => {
		const lookup: HeadLookup = async () => ({ head: "newhead1234", snapshot: null });
		const payload = { timeline_id: "t1", approved: true, already_approved: true, next: { do: "Render it.", tool: "render", arguments: { timeline_id: "t1", commit: "oldapproved", quality: "preview" } } };
		const out = await auditNext(payload, { tool: "storyboard", args: { action: "approve", timeline_id: "t1" }, isError: false }, lookup);
		expect((out.next as { arguments: { commit: string } }).arguments.commit).toBe("newhead1234");
		const same = await auditNext({ ...payload, next: { ...payload.next, arguments: { ...payload.next.arguments, commit: "newhead1234" } } }, { tool: "storyboard", args: { action: "approve" }, isError: false }, lookup);
		expect(same.approved_commit).toBeUndefined();
	});

	test("H9 cutout apply: render the commit (not look kind render with a timeline id)", async () => {
		const payload = { commit_id: "c1", next: { do: "Render it and look", tool: "look", arguments: { kind: "render", ref: "t1" } } };
		const out = await auditNext(payload, { tool: "cutout", args: { action: "apply", timeline_id: "t1" }, isError: false }, noLookup);
		expect(out.next).toMatchObject({ tool: "render", arguments: { timeline_id: "t1", commit: "c1", quality: "preview" } });
	});

	test("H10 upload_url: the import puts the file on its lane", async () => {
		const payload = { upload_id: "u1", put_url: "http://x/api/media-uploads/tok", next: { do: "Upload", tool: "media", arguments: { action: "import", timeline_id: "t1", upload_id: "u1" } } };
		const music = await auditNext(payload, { tool: "media", args: { action: "upload_url", timeline_id: "t1", name: "bed.mp3" }, isError: false }, noLookup);
		expect((music.next as { arguments: { place: unknown } }).arguments.place).toEqual({ track: "MUSIC" });
		const take = await auditNext(payload, { tool: "media", args: { action: "upload_url", timeline_id: "t1", name: "take-1.mp4" }, isError: false }, noLookup);
		expect((take.next as { arguments: { place: unknown } }).arguments.place).toEqual({ track: "V1" });
		expect(laneFor("still.png")).toBe("V2");
		const placed = { ...payload, next: { ...payload.next, arguments: { ...payload.next.arguments, place: { track: "V2" } } } };
		expect(await auditNext(placed, { tool: "media", args: { action: "upload_url" }, isError: false }, noLookup)).toBe(placed);
	});

	test("H11 autocut: captions on every clip, not the cut clip's first piece", async () => {
		const payload = { commit_id: "c2", pieces_after: [{ id: "p1" }, { id: "p2" }], next: { do: "Caption the cut clip", tool: "captions", arguments: { timeline_id: "t1", element_id: "p1", style: "word-pop", dry_run: true } } };
		const out = await auditNext(payload, { tool: "autocut", args: { timeline_id: "t1", element_id: "p1" }, isError: false }, noLookup);
		expect((out.next as { arguments: Record<string, unknown> }).arguments).toEqual({ timeline_id: "t1", style: "word-pop", dry_run: true, all: true });
	});

	test("H12 revise / edit_row dry run that duplicates captions: a warning, not 'Commit it'", async () => {
		const snapshot = fixture(2);
		const lookup: HeadLookup = async () => ({ head: "h1", snapshot });
		const payload = {
			timeline_id: "t1",
			dry_run: true,
			ops: [{ op: "add_captions", words: [{ text: "and", start: 0.5, end: 0.7 }, { text: "Claude", start: 0.7, end: 1.1 }] }],
			next: { do: "Looks right: commit it (same call without dry_run).", tool: "revise" },
		};
		const out = await auditNext(payload, { tool: "revise", args: { timeline_id: "t1", dry_run: true }, isError: false }, lookup);
		expect(out.next).toMatchObject({ tool: "timeline", arguments: { action: "summary", timeline_id: "t1" } });
		expect(String((out.warnings as string[])[0])).toContain("ADDS a caption layer");
		const row = { timeline_id: "t1", row: 2, dry_run: true, changes: [{ index: 0, op: "add_captions", status: "applied" }], next: { do: "Commit it (same call without dry_run).", tool: "storyboard" } };
		const edited = await auditNext(row, { tool: "storyboard", args: { action: "edit_row", timeline_id: "t1", dry_run: true }, isError: false }, lookup);
		expect((edited.next as { tool: string }).tool).toBe("timeline");
		const empty: HeadLookup = async () => ({ head: "h1", snapshot: emptyProject({ id: "e", name: "empty" }) });
		expect(await auditNext(payload, { tool: "revise", args: { dry_run: true }, isError: false }, empty)).toBe(payload);
	});

	test("defaults: a result about a timeline points at its summary; 'Read a timeline summary' no longer means list", () => {
		expect(defaultNext("timeline_ops", { timeline_id: "t9" }, {})).toEqual({ do: expect.any(String), tool: "timeline", arguments: { action: "summary", timeline_id: "t9" } });
		const none = defaultNext("timeline", {}, {});
		expect(none.arguments).toEqual({ action: "list" });
		expect(String(none.do)).toMatch(/^List the timelines/);
	});

	test("rules leave a correct hint alone (so a fix at the source wins)", async () => {
		const right = { commit_id: "c2", next: { do: "Caption it", tool: "captions", arguments: { timeline_id: "t1", all: true } } };
		expect(await auditNext(right, { tool: "autocut", args: {}, isError: false }, noLookup)).toBe(right);
		const error = { error: { code: "x" }, next: { tool: "look", arguments: { kind: "render" } } };
		expect(await auditNext(error, { tool: "cutout", args: { action: "apply" }, isError: true }, noLookup)).toBe(error);
	});
});
