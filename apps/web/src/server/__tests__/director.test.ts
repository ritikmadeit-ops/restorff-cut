/**
 * director (wave 7, 2026-10-24): the planner's rules on a synthetic Halcyon ad, the param filler, the classifier, and
 * the MCP tool on a throwaway PGlite store (plan → apply = ONE commit). Fictional Halcyon data; nothing leaves the OS
 * temp folder. Run: cd apps/web && bun test src/server/__tests__/director.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUILTIN_TECHNIQUES, type TechniqueMeta } from "@restorffcut/compositions/techniques";
import { fillParams } from "@/server/director-fill";
import { beatsOf, collapseRepeats, type DirectorInput, type DirectorPlan, planDirector } from "@/server/director-plan";
import { classifyBeat, energyAt, numbersIn, resolveStyle, STYLE_PROFILES } from "@/server/director-rules";

// ─── a synthetic 24 s Halcyon ad: words with real-looking timings ────────────────────────────────────────────

const SCRIPT: Array<[string, number]> = [
	["Stop", 0.25], ["making", 0.55], ["cold", 0.85], ["brew", 1.1], ["the", 1.35], ["slow", 1.5], ["way.", 1.8],
	["Tired", 2.6], ["of", 2.95], ["bitter", 3.1], ["coffee", 3.45], ["every", 3.85], ["morning?", 4.15],
	["Halcyon", 5.0], ["Cold", 5.5], ["Brew", 5.8], ["is", 6.1], ["steeped", 6.3], ["for", 6.7], ["eighteen", 6.9], ["hours.", 7.35],
	["We", 8.2], ["sold", 8.4], ["40,000", 8.7], ["cans", 9.4], ["in", 9.7], ["six", 9.85], ["months.", 10.15],
	["All", 11.0], ["you", 11.2], ["need:", 11.35], ["ice,", 11.8], ["a", 12.2], ["glass,", 12.35], ["and", 12.8], ["one", 13.0], ["pour.", 13.25],
	["Not", 14.1], ["hot", 14.35], ["coffee", 14.6], ["on", 14.95], ["ice,", 15.1], ["real", 15.6], ["cold", 15.9], ["brew.", 16.2],
	["People", 17.0], ["say", 17.35], ["it", 17.55], ["tastes", 17.7], ["like", 18.05], ["a", 18.2], ["café.", 18.35],
	["Here's", 19.2], ["the", 19.5], ["secret:", 19.65], ["no", 20.15], ["sugar.", 20.4],
	["Comment", 21.3], ["HALCYON", 21.75], ["for", 22.4], ["the", 22.55], ["recipe.", 22.7],
];
const WORDS = SCRIPT.map(([text, start], i) => ({ text, start, end: Math.min(start + 0.3, SCRIPT[i + 1]?.[1] ?? start + 0.4) }));
const DURATION = 24;

/** Statuses the effects library reports as coming today (catalogue rows without a build). */
const COMING = new Set(["FX-37", "FX-41", "FX-43", "FX-44", "FX-45", "FX-46", "FX-47", "FX-62"]);

function inputOf(over: Partial<DirectorInput> = {}): DirectorInput {
	return {
		words: WORDS,
		clips: [{ id: "a-roll", start: 0, end: DURATION, kind: "footage", keyed: false }],
		cuts: [],
		durationS: DURATION,
		aspect: "9:16",
		fps: 30,
		captions: true,
		matte: false,
		images: [],
		product: { name: "Halcyon Cold Brew", brand: "Halcyon" },
		cta: { text: "Comment HALCYON for the recipe", keyword: "HALCYON" },
		existing: [],
		graded: false,
		techniques: BUILTIN_TECHNIQUES,
		available: (t) => (t.apply.via === "effects" || t.apply.via === "ops" || t.apply.via === "sounds") && !COMING.has(t.id),
		specs: () => null,
		...over,
	};
}

const byId = new Map(BUILTIN_TECHNIQUES.map((t) => [t.id, t]));
const visual = (plan: DirectorPlan) => plan.events.filter((e) => e.role !== "grade");
const plan = (style: string, over: Partial<DirectorInput> = {}, seed = "test", extra: Record<string, unknown> = {}) =>
	planDirector(inputOf(over), { profile: resolveStyle(style, "ad").profile, seed, ...extra });

describe("director planner — the rules", () => {
	for (const style of Object.keys(STYLE_PROFILES)) {
		test(`${style}: hook inside 1 s, no still stretch over the bar, spacing kept, CTA last, a big-word punch`, () => {
			const p = plan(style);
			const profile = STYLE_PROFILES[style];
			expect(p.predicted.first_change_s).not.toBeNull();
			expect(p.predicted.first_change_s as number).toBeLessThanOrEqual(1.0);
			expect(p.predicted.longest_gap_s).toBeLessThanOrEqual(profile.maxGapS + 1e-6);
			// no reuse inside a technique's spacing
			const seen = new Map<string, number>();
			for (const e of visual(p)) {
				const last = seen.get(e.id);
				if (last !== undefined) expect(e.t - last).toBeGreaterThanOrEqual((byId.get(e.id) as TechniqueMeta).minSpacing - 1e-6);
				seen.set(e.id, e.t);
			}
			// the last beat carries a CTA
			const cta = p.events.filter((e) => e.role === "cta");
			expect(cta.length).toBe(1);
			expect((byId.get(cta[0].id) as TechniqueMeta).purpose).toContain("cta");
			expect(cta[0].t).toBeGreaterThanOrEqual(WORDS.find((w) => w.text === "Comment")!.start - 3.6);
			expect(p.predicted.big_word_punch).toBe(true);
			// times on the frame grid
			for (const e of visual(p)) expect(Math.abs(e.t * 30 - Math.round(e.t * 30))).toBeLessThan(0.02);
		});
	}

	test("never busier than the reference + 15 % (styles with a reference)", () => {
		for (const style of ["explainer-overlay", "neon-grid-type", "paper-collage", "warm-moody", "effects-library"]) {
			const p = plan(style);
			const ref = STYLE_PROFILES[style].refEventsPer10s as number;
			// the cap may only be exceeded when dropping more would open a stretch over the bar
			if (p.predicted.events_per_10s > ref * 1.15 + 0.5) expect(p.notes.join(" ")).toContain("pace cap");
		}
	});

	test("face-safe: a face-never-covered style puts no full-frame cutaway on footage; nothing behind the person without a matte", () => {
		for (const style of ["explainer-overlay", "warm-moody", "talking-head", "ad"]) {
			const p = plan(style);
			for (const e of visual(p)) {
				expect(e.placement).not.toBe("full-frame");
				expect(e.placement).not.toBe("behind-person");
			}
		}
		const noMatte = plan("effects-library");
		for (const e of visual(noMatte)) expect((byId.get(e.id) as TechniqueMeta).needs).not.toContain("person_matte");
		const withMatte = plan("effects-library", { matte: true });
		expect(visual(withMatte).some((e) => (byId.get(e.id) as TechniqueMeta).needs.includes("person_matte"))).toBe(true);
	});

	test("deterministic for a seed; the seed is the only source of variation", () => {
		const a = JSON.stringify(plan("ad", {}, "seed-1"));
		const b = JSON.stringify(plan("ad", {}, "seed-1"));
		expect(a).toBe(b);
	});

	test("beats are classified from the words and get matching techniques with params from the words", () => {
		const p = plan("ad");
		const types = p.beats.map((b) => b.type);
		expect(types[0]).toBe("hook");
		expect(types.at(-1)).toBe("cta");
		expect(types).toContain("number");
		expect(types).toContain("list");
		expect(types).toContain("comparison");
		expect(types).toContain("proof");
		const numberBeat = p.beats.find((b) => b.line.includes("40,000"))!;
		const onNumber = p.events.find((e) => e.beat === numberBeat.n && e.role !== "transition")!;
		expect((byId.get(onNumber.id) as TechniqueMeta).purpose.some((x) => x === "number-data" || x === "emphasis")).toBe(true);
		const listBeat = p.beats.find((b) => b.type === "list")!;
		expect(listBeat.items.length).toBeGreaterThanOrEqual(2);
		const cta = p.events.find((e) => e.role === "cta")!;
		if (cta.id === "FX-35") expect(cta.params.keyword).toBe("HALCYON");
		for (const e of visual(p)) expect(e.why.length).toBeGreaterThan(20);
	});

	test("energy escalates toward the payoff (curve) and the hook starts high", () => {
		expect(energyAt(3, 0.05, "hook")).toBe(4);
		expect(energyAt(3, 0.2, "claim")).toBeLessThan(energyAt(3, 0.85, "claim"));
		expect(energyAt(3, 0.99, "cta")).toBe(3);
		const p = plan("ad");
		const mid = p.beats.filter((b) => b.type !== "hook" && b.type !== "cta");
		expect(mid[0].energy_target).toBeLessThan(mid.at(-1)!.energy_target);
	});

	test("overrides swap or drop one beat's technique; avoid never uses one", () => {
		const base = plan("ad");
		const numberBeat = base.beats.find((b) => b.line.includes("40,000"))!;
		const swapped = plan("ad", {}, "test", { overrides: [{ beat: numberBeat.n, use: "FX-10" }] });
		expect(swapped.events.find((e) => e.beat === numberBeat.n && e.id === "FX-10")).toBeTruthy();
		const dropped = plan("ad", {}, "test", { overrides: [{ beat: numberBeat.n, skip: true }] });
		expect(dropped.events.find((e) => e.beat === numberBeat.n && e.role === "beat")).toBeFalsy();
		const avoided = plan("ad", {}, "test", { avoid: ["FX-22", "move:punch-in"] });
		expect(avoided.events.some((e) => e.id === "FX-22" || e.id === "move:punch-in")).toBe(false);
	});

	test("fill mode plans only inside the given stretches", () => {
		const p = plan("ad", {}, "test", { windows: [[8, 13]] });
		for (const e of visual(p)) expect(e.t >= 8 - 1e-6 && e.t <= 13 + 1e-6).toBe(true);
		expect(visual(p).length).toBeGreaterThan(0);
	});

	test("unavailable techniques are never chosen; transitions only on existing cuts", () => {
		const p = plan("fast-ugc", { cuts: [7.9, 16.6], clips: [{ id: "a", start: 0, end: 7.9, kind: "footage", keyed: false }, { id: "b", start: 7.9, end: 16.6, kind: "footage", keyed: false }, { id: "c", start: 16.6, end: 24, kind: "footage", keyed: false }] });
		for (const e of p.events) expect(COMING.has(e.id)).toBe(false);
		const transitions = p.events.filter((e) => e.kind === "transition");
		expect(transitions.length).toBeGreaterThan(0);
		for (const tr of transitions) expect([7.9, 16.6].some((c) => Math.abs(tr.t + tr.duration_s / 2 - c) < 0.05)).toBe(true);
		// a sound on every transition (fast-ugc: sound all)
		for (const tr of transitions) expect(p.sounds.some((s) => Math.abs(s.t - (tr.t + tr.duration_s / 2)) < 0.05)).toBe(true);
	});

	test("repeated TTS number tokens collapse to one word; '1,700' is a number, not a list (live run 13:5x)", () => {
		const tts = [
			{ text: "Colombia,", start: 6.5, end: 7.0 }, { text: "at", start: 7.0, end: 7.2 },
			{ text: "1,700", start: 7.2, end: 7.5 }, { text: "1,700", start: 7.5, end: 7.8 }, { text: "1,700", start: 7.8, end: 8.1 }, { text: "1,700", start: 8.1, end: 8.4 },
			{ text: "metres.", start: 8.4, end: 8.9 },
		];
		expect(collapseRepeats(tts).length).toBe(4);
		const beats = beatsOf(tts, STYLE_PROFILES.ad, { durationS: 9 });
		expect(beats.length).toBe(1);
		expect(beats[0].line).toBe("Colombia, at 1,700 metres.");
		expect(classifyBeat(beats[0].line.split(" "), { first: false, last: false, position: 0.3 }).type).toBe("number");
	});

	test("one look per piece: a paper piece takes no neon technique unless the style names it", () => {
		const p = plan("paper-collage");
		for (const e of visual(p)) {
			const look = (byId.get(e.id) as TechniqueMeta).look;
			if (look) expect(["paper", "retro", "photo", "clean"].includes(look) || [...STYLE_PROFILES["paper-collage"].prefer, ...STYLE_PROFILES["paper-collage"].ctas, ...STYLE_PROFILES["paper-collage"].hooks, ...STYLE_PROFILES["paper-collage"].interrupts, ...STYLE_PROFILES["paper-collage"].transitions].includes(e.id)).toBe(true);
		}
	});

	test("full-frame cutaways start and end on their picture's edges (no flash frames: live run gate FLASH 2026-10-24)", () => {
		const clips = [
			{ id: "farm", start: 0, end: 8.6, kind: "image" as const, keyed: false },
			{ id: "roastery", start: 8.6, end: 17.2, kind: "image" as const, keyed: false },
			{ id: "pour", start: 17.2, end: 24, kind: "footage" as const, keyed: false },
		];
		const p = plan("paper-collage", { clips, cuts: [8.6, 17.2], images: ["/api/projects/x/media/farm-still"] });
		const full = visual(p).filter((e) => e.placement === "full-frame");
		expect(full.length).toBeGreaterThan(0);
		for (const e of full) {
			const under = clips.find((c) => c.start <= e.t + 1e-6 && e.t < c.end) ?? clips[0];
			expect(e.t - under.start === 0 || e.t - under.start >= 0.35 - 1e-6).toBe(true);
			const atEnd = clips.find((c) => c.start <= e.end - 0.01 && e.end - 0.01 < c.end);
			if (atEnd) expect(atEnd.end - e.end === 0 || atEnd.end - e.end >= 0.35 - 1e-6).toBe(true);
		}
	});

	test("sounds: ≥ 0.45 s apart except a riser peaking on its hit; a full-frame exit gets a swish in sound-all styles", () => {
		const clips = [
			{ id: "farm", start: 0, end: 8.6, kind: "image" as const, keyed: false },
			{ id: "roastery", start: 8.6, end: 24, kind: "image" as const, keyed: false },
		];
		const p = plan("paper-collage", { clips, cuts: [8.6], images: ["/api/projects/x/media/farm-still"] });
		const plain = p.sounds.filter((s) => s.id !== "sfx:riser");
		for (let i = 1; i < plain.length; i++) expect(plain[i].t - plain[i - 1].t).toBeGreaterThanOrEqual(0.45 - 1e-6);
		for (const e of visual(p).filter((x) => x.placement === "full-frame" && x.end < 23.7)) {
			expect(p.sounds.some((s) => Math.abs(s.t - e.end) < 0.45)).toBe(true);
		}
	});

	test("a punch-in is never planned on a picture with its own camera keys", () => {
		const p = plan("talking-head", { clips: [{ id: "a", start: 0, end: DURATION, kind: "footage", keyed: true }] });
		expect(p.events.some((e) => e.id === "move:punch-in")).toBe(false);
	});
});

describe("director rules — classifier, numbers, styles", () => {
	test("numbers in words", () => {
		expect(numbersIn(["sold", "40,000", "cans"]).map((n) => n.value)).toEqual([40000]);
		expect(numbersIn(["$4", "and", "92%", "12k"]).map((n) => n.value)).toEqual([4, 92, 12000]);
		expect(numbersIn(["eighteen", "hours"]).length).toBe(0); // not in the number-word list: stays a claim unless a digit
		expect(numbersIn(["twelve", "hours"]).map((n) => n.value)).toEqual([12]);
	});

	test("beat types", () => {
		const c = (line: string, o: Partial<{ first: boolean; last: boolean; position: number }> = {}) => classifyBeat(line.split(" "), { first: false, last: false, position: 0.5, product: ["Halcyon"], ...o }).type;
		expect(c("Stop scrolling right now", { first: true })).toBe("hook");
		expect(c("Comment HALCYON for the recipe", { last: true })).toBe("cta");
		expect(c("Three things you need to know")).toBe("list");
		expect(c("We sold 40,000 cans")).toBe("number");
		expect(c("Not hot coffee on ice, real cold brew")).toBe("comparison");
		expect(c("People say it tastes like a café")).toBe("proof");
		expect(c("Halcyon is smooth")).toBe("product");
		expect(c("Tired of bitter coffee?")).toBe("problem");
		expect(c("Then you pour it over ice")).toBe("steps");
	});

	test("styles resolve by id, alias, apply_style id and piece type", () => {
		expect(resolveStyle("explainer-overlay", undefined).profile.id).toBe("explainer-overlay");
		expect(resolveStyle("restorff/style/fast-ugc", undefined).profile.id).toBe("fast-ugc");
		expect(resolveStyle("moody", undefined).profile.id).toBe("warm-moody");
		expect(resolveStyle(undefined, "motion-graphic").profile.id).toBe("neon-grid-type");
		expect(resolveStyle("nonsense", "explainer").matched).toContain("unknown style");
	});
});

describe("director fill — params shaped to the manifest", () => {
	const facts = classifyBeat(["We", "sold", "40,000", "cans", "in", "six", "months."], { first: false, last: false, position: 0.4 });
	const beat = { t: 8.2, end: 10.4, words: WORDS.slice(21, 28), facts };

	test("numbers → value + label; word timings in timeline seconds when the composition has t0, local otherwise", () => {
		const counter = byId.get("FX-32") as TechniqueMeta;
		const got = fillParams(counter, { beat, at: 8.7, images: [], specs: { to: { type: "number", required: true }, label: { type: "string", maxLength: 24 } } });
		expect(got.params.to).toBe(40000);
		expect(got.params.label).toBe("cans");
		expect(got.missing).toEqual([]);

		const neon = byId.get("comp:neon-beats") as TechniqueMeta;
		const specsT0 = { t0: { type: "number" }, words: { type: "list", of: { type: "object", fields: { w: { type: "string" }, s: { type: "number" }, e: { type: "number" } } } }, beats: { type: "list", required: true, maxItems: 8, of: { type: "object", fields: { text: { type: "string", maxLength: 12 }, at: { type: "number" } } } } };
		const n = fillParams(neon, { beat, at: 8.2, images: [], specs: specsT0 });
		expect((n.params.words as Array<{ s: number }>)[0].s).toBe(8.2);
		expect(n.params.t0).toBe(8.2);
		expect((n.params.beats as unknown[]).length).toBeGreaterThan(0);

		const pop = byId.get("comp:word-pop") as TechniqueMeta;
		const local = fillParams(pop, { beat, at: 8.2, images: [], specs: { words: { type: "list", of: { type: "object", fields: { text: { type: "string" }, start: { type: "number" }, end: { type: "number" } } } } } });
		expect((local.params.words as Array<{ start: number }>)[0].start).toBe(0);
	});

	test("a required param nothing can fill is reported missing (the technique is then not chosen)", () => {
		const chart = byId.get("FX-10") as TechniqueMeta;
		const noNumbers = classifyBeat(["It", "tastes", "smooth."], { first: false, last: false, position: 0.5 });
		const got = fillParams(chart, { beat: { t: 1, end: 2, words: WORDS.slice(0, 3), facts: noNumbers }, at: 1, images: [], specs: { bars: { type: "list", required: true, of: { type: "object", fields: { label: { type: "string" }, value: { type: "number" } } } } } });
		expect(got.missing).toEqual(["bars"]);
	});

	test("object items get their other required fields (thread-timeline {date, text}: live run 13:57 refused items without date)", () => {
		const thread = byId.get("FX-58") as TechniqueMeta;
		const listFacts = classifyBeat("Then three things happen: we grind them coarse, add cold water, and wait eighteen hours.".split(" "), { first: false, last: false, position: 0.6 });
		const got = fillParams(thread, { beat: { t: 22, end: 27, words: WORDS.slice(0, 3), facts: listFacts }, at: 22, images: [], specs: { items: { type: "list", maxItems: 4, of: { type: "object", fields: { date: { type: "string", maxLength: 14 }, text: { type: "string", maxLength: 40 } } } } } });
		expect(got.missing).toEqual([]);
		expect(got.params.items).toEqual([{ text: "we grind them coarse", date: "01" }, { text: "add cold water", date: "02" }, { text: "wait eighteen hours", date: "03" }]);
	});

	test("a word longer than its slot is left out, never sliced", () => {
		const stamp = byId.get("FX-26") as TechniqueMeta;
		const f = classifyBeat(["Absolutely", "unbelievable."], { first: false, last: false, position: 0.5 });
		const got = fillParams(stamp, { beat: { t: 1, end: 2, words: WORDS.slice(0, 2), facts: f }, at: 1, images: [], specs: { text: { type: "string", maxLength: 6, required: true } } });
		expect(got.params.text).toBeUndefined();
		expect(got.missing).toEqual(["text"]);
	});

	test("list items respect maxItems and maxLength; unknown params are never sent", () => {
		const checklist = byId.get("FX-07") as TechniqueMeta;
		const listFacts = classifyBeat("All you need: ice, a glass, and one pour, a straw, a lid, a sleeve, a smile".split(" "), { first: false, last: false, position: 0.5 });
		const got = fillParams(checklist, { beat: { t: 11, end: 14, words: WORDS.slice(28, 37), facts: listFacts }, at: 11, images: [], specs: { items: { type: "list", maxItems: 3, of: { type: "string", maxLength: 8 } } } });
		expect((got.params.items as string[]).length).toBeLessThanOrEqual(3);
		for (const item of got.params.items as string[]) expect(item.length).toBeLessThanOrEqual(8);
		expect("title" in got.params).toBe(false);
	});
});

// ─── MCP: plan → apply = ONE commit, on a throwaway store ────────────────────────────────────────────────────

const TOKEN = "director-test-token-0123456789";
const saved = { data: process.env.RESTORFFCUT_DATA_DIR, media: process.env.RESTORFFCUT_MEDIA_DIR, token: process.env.RESTORFFCUT_SERVICE_TOKEN, db: process.env.RESTORFFCUT_DB, renders: process.env.RESTORFFCUT_RENDERS_DIR };
const dir = mkdtempSync(path.join(tmpdir(), "rc-director-"));

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
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("MCP director on a throwaway store", () => {
	type Handler = (request: Request) => Promise<Response>;
	let handleMcp: Handler;
	let sessionId = "";
	let rpcId = 1;
	let timelineId = "";

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
		await forgetStore();
		({ handleMcp } = await import("@/mcp/handler"));
		const init = await post({ jsonrpc: "2.0", id: rpcId++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "director-test" } } });
		sessionId = init.headers.get("mcp-session-id") ?? "";
		timelineId = (await call("timeline", { action: "create", name: "Halcyon Cold Brew / director test", aspect: "9:16" })).timeline_id as string;
		const head = ((await call("timeline", { action: "summary", timeline_id: timelineId })).head as string) ?? "";
		const done = await call("timeline_ops", {
			timeline_id: timelineId,
			base_commit: head,
			message: "a talking-head clip + captions",
			ops: [
				{ op: "import_media", kind: "video", url: "https://example.invalid/halcyon-a-roll.mp4", name: "Halcyon A-roll", duration: 24, width: 1080, height: 1920, ref: "m" },
				{ op: "insert", track: "main", t: 0, media: "m", out: 24 },
				{ op: "add_captions", words: WORDS, max_words: 3 },
			],
		});
		expect(done.commit_id).toBeTruthy();
	}, 120_000);

	test("tools/list has director; techniques answers the catalogue", async () => {
		const response = await post({ jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} });
		const list = (await response.json()) as { result: { tools: Array<{ name: string }> } };
		expect(list.result.tools.some((t) => t.name === "director")).toBe(true);
		const got = await call("director", { action: "techniques", purpose: "cta" });
		expect(got.count as number).toBeGreaterThan(0);
		expect((got.of as number) >= BUILTIN_TECHNIQUES.length).toBe(true);
	});

	test("plan reads the timeline's words and never commits", async () => {
		const before = (await call("timeline", { action: "summary", timeline_id: timelineId })).head as string;
		const got = await call("director", { action: "plan", timeline_id: timelineId, style: "talking-head", seed: 7 });
		expect(got.committed).toBe(false);
		expect((got.beats as unknown[]).length).toBeGreaterThan(5);
		expect((got.predicted as { first_change_s: number }).first_change_s).toBeLessThanOrEqual(1.0);
		expect((got.next as { tool: string; arguments: { action: string } }).arguments.action).toBe("apply");
		const after = (await call("timeline", { action: "summary", timeline_id: timelineId })).head as string;
		expect(after).toBe(before);
	}, 60_000);

	test("apply makes ONE commit with punch-ins, word pops and sounds (render-free techniques only)", async () => {
		const before = (await call("timeline", { action: "summary", timeline_id: timelineId })).head as string;
		const got = await call("director", { action: "apply", timeline_id: timelineId, style: "talking-head", seed: 7, only: ["move:punch-in", "move:word-pop", "FX-05"], base_commit: before });
		if (!got.committed) console.log(JSON.stringify(got).slice(0, 2000));
		expect(got.committed).toBe(true);
		expect(got.applied as number).toBeGreaterThanOrEqual(3);
		expect((got.message as string).startsWith("director")).toBe(true);
		const history = await call("history", { timeline_id: timelineId, limit: 5 });
		const text = JSON.stringify(history);
		expect(text.split("director: talking-head").length - 1).toBe(1);
		const after = (await call("timeline", { action: "summary", timeline_id: timelineId })).head as string;
		expect(after).toBe(got.commit_id as string);
		// a stale base is refused, nothing committed
		const again = await call("director", { action: "apply", timeline_id: timelineId, style: "talking-head", only: ["move:punch-in"], base_commit: before });
		expect((again.error as { code: string }).code).toBe("conflict");
	}, 120_000);
});
