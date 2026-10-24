/**
 * composition-v3 agent, 2026-10-21: composition versions (append, history diffs, revert plans), the timeline kit
 * (marker, which clips include it, the record on the snapshot) and the version bookkeeping inside swapRendered.
 * Pure: an in-memory blob store, no database (the dev server holds the PGlite directory), no renders.
 * Fictional data (Halcyon Cold Brew). Run: cd apps/web && bun test src/server/__tests__/composition-v3.test.ts
 */
import { describe, expect, test } from "bun:test";
import type { ProjectSnapshot, SnapshotElement } from "@/sync/snapshot";
import {
	appendVersion,
	diffVersions,
	KIT_MARKER,
	kitBody,
	kitClips,
	memoryStore,
	planRevert,
	propsPatch,
	setTimelineKit,
	sha256,
	stableJson,
	timelineKitInput,
	timelineKitOf,
	usesKitMarker,
	versionsOf,
	withKitMarker,
	type VersionedComposition,
} from "../composition-versions";
import { mergeProps, swapRendered, type RenderedChange } from "../storyboard-recompose";

const T = 120_000;
const SOURCE_A = `<!doctype html><html><head><script type="application/json" id="params">{"params":{"word":{"type":"string","default":"COLD"}}}</script></head><body><script>RC.composition({ render: function () {} });</script></body></html>`;
const SOURCE_B = SOURCE_A.replace("render: function () {}", "render: function (time) { void time.t; }");

const custom = (source: string, props: Record<string, unknown>, hash: string, extra: Partial<VersionedComposition> = {}): VersionedComposition => ({
	custom: true,
	name: "kinetic",
	title: "Kinetic",
	source,
	props,
	hash,
	width: 1080,
	height: 1920,
	fps: 30,
	duration: 3,
	author: "claude",
	...extra,
});

async function storeAll(store: ReturnType<typeof memoryStore>, blobs: Array<{ kind: "source" | "props" | "kit"; body: string }>) {
	await store.put(blobs);
}

describe("versions", () => {
	test("write = v1; each change appends; texts go to the store once (content-addressed)", async () => {
		const store = memoryStore();
		const v1 = appendVersion(null, custom(SOURCE_A, { word: "COLD" }, "h1"), { note: "write", at: "2026-10-21T00:00:00Z" });
		expect(v1.record.versions?.map((v) => v.v)).toEqual([1]);
		expect(v1.record.versions?.[0]?.source_sha).toBe(sha256(SOURCE_A));
		await storeAll(store, v1.blobs);
		const v2 = appendVersion(v1.record, custom(SOURCE_A, { word: "BREW" }, "h2"), { note: "key word" });
		const v3 = appendVersion(v2.record, custom(SOURCE_B, { word: "BREW" }, "h3"), { note: "tilt" });
		await storeAll(store, [...v2.blobs, ...v3.blobs]);
		expect(v3.record.versions?.map((v) => [v.v, v.note])).toEqual([[1, "write"], [2, "key word"], [3, "tilt"]]);
		// the same source is stored once: two sources, three props
		expect([...store.map.values()].filter((body) => body.startsWith("<!doctype")).length).toBe(2);
		expect(store.map.size).toBe(2 + 2); // props {COLD}, {BREW} + sources A, B
	});

	test("a clip from before versions were kept becomes v1 the first time it changes (its texts are stored then)", () => {
		const old = custom(SOURCE_A, { word: "COLD" }, "h0");
		expect(versionsOf(old).map((v) => [v.v, v.note])).toEqual([[1, "before versions were kept"]]);
		const next = appendVersion(old, custom(SOURCE_A, { word: "BREW" }, "h1"), { note: "update" });
		expect(next.record.versions?.map((v) => v.v)).toEqual([1, 2]);
		expect(next.blobs.some((b) => b.body === stableJson({ word: "COLD" }))).toBe(true);
		expect(next.blobs.some((b) => b.body === SOURCE_A)).toBe(true);
	});

	test("history diffs: props a → b, source +/- lines, kit, length; a missing text says so", () => {
		const a = appendVersion(null, custom(SOURCE_A, { word: "COLD", accent: "#F6FF00" }, "h1", { kit_sha: "a".repeat(64) }), {});
		const b = appendVersion(a.record, custom(`${SOURCE_A}\n<!-- two -->\n<!-- lines -->`, { word: "BREW" }, "h2", { duration: 4, kit_sha: "b".repeat(64) }), {});
		const texts = new Map([...a.blobs, ...b.blobs].map((blob) => [sha256(blob.body), blob.body]));
		const [va, vb] = b.record.versions ?? [];
		const diff = diffVersions(va ?? null, vb as NonNullable<typeof vb>, texts);
		expect(diff.props).toEqual({ accent: '"#F6FF00" → —', word: '"COLD" → "BREW"' });
		expect(diff.source).toEqual({ added: 2, removed: 0 });
		expect(diff.kit).toBe("aaaaaaaa → bbbbbbbb");
		expect(diff.duration).toBe("3 s → 4 s");
		expect(diffVersions(va ?? null, vb as NonNullable<typeof vb>, new Map()).props).toEqual({ "(props)": "changed (text not in the store)" });
	});

	test("props keys are order-free (stable JSON) and $comment never counts", () => {
		expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }));
		expect(mergeProps({ word: "COLD" }, { $comment: "note", word: "BREW" })).toEqual({ word: "BREW" });
	});

	test("at most 100 versions stay on a clip", () => {
		let record: VersionedComposition = custom(SOURCE_A, { n: 0 }, "h0");
		for (let i = 1; i <= 105; i++) record = appendVersion(record, custom(SOURCE_A, { n: i }, `h${i}`), {}).record;
		expect(record.versions?.length).toBe(100);
		expect(record.versions?.[99]?.v).toBe(106);
	});
});

describe("revert", () => {
	async function threeVersions() {
		const store = memoryStore();
		const v1 = appendVersion(null, custom(SOURCE_A, { word: "COLD", accent: "#F6FF00" }, "h1"), { note: "write" });
		const v2 = appendVersion(v1.record, custom(SOURCE_A, { word: "BREW", accent: "#FF5A1F" }, "h2"), { note: "colour" });
		const v3 = appendVersion(v2.record, custom(SOURCE_B, { word: "BREW", accent: "#FF5A1F", scale: 1.2 }, "h3", { duration: 4 }), { note: "code" });
		await store.put([...v1.blobs, ...v2.blobs, ...v3.blobs]);
		return { store, record: v3.record };
	}

	test("revert to v1 = its source, its props exactly (keys added since are removed), its length", async () => {
		const { store, record } = await threeVersions();
		const shas = (record.versions ?? []).flatMap((v) => [v.props_sha, ...(v.source_sha ? [v.source_sha] : [])]);
		const planned = planRevert(record, 1, await store.get(shas), 4);
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		expect(planned.plan.source).toBe(SOURCE_A);
		expect(planned.plan.duration_s).toBe(3);
		expect(planned.plan.note).toBe("revert to v1");
		// what commitAsClaude will store: the merge of the current props and the patch = v1's props
		expect(mergeProps(record.props, planned.plan.props)).toEqual({ word: "COLD", accent: "#F6FF00" });
		expect(propsPatch(record.props, { word: "COLD" })).toEqual({ accent: null, scale: null, word: "COLD" });
	});

	test('"previous", the current version, an unknown one, a text missing from the store', async () => {
		const { store, record } = await threeVersions();
		const all = await store.get((record.versions ?? []).flatMap((v) => [v.props_sha, ...(v.source_sha ? [v.source_sha] : [])]));
		const prev = planRevert(record, "previous", all, 4);
		expect(prev.ok && prev.plan.want.v).toBe(2);
		expect(prev.ok && prev.plan.source).toBe(SOURCE_A);
		expect(planRevert(record, 3, all, 4)).toMatchObject({ ok: false, code: "unchanged" });
		expect(planRevert(record, 9, all, 4)).toMatchObject({ ok: false, code: "not_found" });
		expect(planRevert(record, 1, new Map(), 4)).toMatchObject({ ok: false, code: "not_in_store" });
	});

	test("a library version cannot come back into a clip that is custom code now", async () => {
		const lib = appendVersion(null, { name: "counter", title: "Counter", props: { to: 18 }, hash: "l1", duration: 2 }, {});
		const now = appendVersion(lib.record, custom(SOURCE_A, { word: "COLD" }, "c1"), { note: "made custom" });
		const texts = new Map([...lib.blobs, ...now.blobs].map((b) => [sha256(b.body), b.body]));
		expect(planRevert(now.record, 1, texts, 3)).toMatchObject({ ok: false, code: "not_supported" });
	});
});

describe("timeline kit", () => {
	test("the marker goes into <head> (after the doctype when there is none), once", () => {
		const withHead = withKitMarker(SOURCE_A);
		expect(withHead).toContain(`<head>\n${KIT_MARKER}`);
		expect(withKitMarker(withHead)).toBe(withHead);
		const bare = withKitMarker("<!doctype html><div id='stage'></div>");
		expect(bare.startsWith(`<!doctype html>${KIT_MARKER}`)).toBe(true);
		expect(usesKitMarker(bare)).toBe(true);
		expect(usesKitMarker(null)).toBe(false);
	});

	function snapshotWith(elements: SnapshotElement[]): ProjectSnapshot {
		return {
			metadata: { id: "p1", name: "Halcyon kit test", restorff: { media: [] } },
			scenes: [{ id: "s1", name: "Main", isMain: true, tracks: { overlay: [{ id: "trk-motion", name: "MOTION", type: "video", elements }], main: { id: "trk-main", name: "V1", type: "video", elements: [] }, audio: [] } }],
		} as unknown as ProjectSnapshot;
	}
	const clip = (id: string, composition: VersionedComposition | null, start: number): SnapshotElement =>
		({ id, type: "video", name: id, mediaId: `m-${id}`, startTime: start * T, duration: 2 * T, trimStart: 0, trimEnd: 0, ...(composition ? { restorff: { composition } } : {}) }) as unknown as SnapshotElement;

	test("exactly the custom clips whose source has the marker include the kit; library and plain code do not", () => {
		const snap = snapshotWith([
			clip("box", custom(withKitMarker(SOURCE_A), {}, "k1"), 0),
			clip("dot", custom(withKitMarker(SOURCE_B), {}, "k2"), 2),
			clip("kinetic", custom(SOURCE_A, {}, "c1"), 4),
			clip("counter", { name: "counter", props: { to: 18 }, hash: "l1" }, 6),
			clip("broll", null, 8),
		]);
		const { including, others } = kitClips(snap);
		expect(including.map((c) => c.element.id)).toEqual(["box", "dot"]);
		expect(others.map((c) => c.element.id)).toEqual(["kinetic", "counter"]);
	});

	test("the kit record lives on metadata.restorff (other keys kept) with its history; the body round-trips the store", async () => {
		const snap = snapshotWith([]);
		const store = memoryStore();
		const k1 = { js: "var SWATCH = { fill: '#F6FF00' };" };
		const k2 = { js: "var SWATCH = { fill: '#FF5A1F' };", css: ".k{}" };
		await store.put([{ kind: "kit", body: kitBody(k1) }, { kind: "kit", body: kitBody(k2) }]);
		setTimelineKit(snap, { sha: sha256(kitBody(k1)), bytes: 40, at: "t1", from: "inline" });
		setTimelineKit(snap, { sha: sha256(kitBody(k2)), bytes: 50, at: "t2", from: "library:neon-grid" });
		const record = timelineKitOf(snap);
		expect(record?.from).toBe("library:neon-grid");
		expect(record?.history?.map((h) => h.at)).toEqual(["t1"]);
		expect((snap.metadata.restorff as { media?: unknown[] }).media).toEqual([]);
		expect((await timelineKitInput(snap, store))?.kit).toEqual({ css: ".k{}", js: k2.js });
		expect(kitBody({ js: "a", css: "b" })).toBe(kitBody({ css: "b", js: "a" }));
	});

	test("swapRendered keeps the version history, notes why and records the kit the render used", () => {
		const v1 = appendVersion(null, custom(withKitMarker(SOURCE_A), { word: "COLD" }, "old", { kit_sha: "k".repeat(64) }), { note: "write" });
		const snap = snapshotWith([clip("box", v1.record, 0)]);
		const item: RenderedChange = {
			change: { element_id: "box", note: "kit 40fb85d6 (inline)" },
			kind: "custom",
			title: "Kit box",
			name: "kit-box",
			source: withKitMarker(SOURCE_A),
			props: { word: "COLD" },
			previous: v1.record,
			answer: { hash: "new", file: "x.webm", cached: false, duration: 2, width: 1080, height: 1920, fps: 30, frames: 60, ms: 1 },
			url: "/api/compositions/custom/new",
			kit_sha: "n".repeat(64),
		};
		expect(swapRendered(snap, { recomp_media_0: "media-2" }, [item])).toBeNull();
		const record = (snap.scenes[0]?.tracks?.overlay?.[0]?.elements?.[0] as unknown as { restorff: { composition: VersionedComposition } }).restorff.composition;
		expect(record.hash).toBe("new");
		expect(record.kit_sha).toBe("n".repeat(64));
		expect(record.versions?.map((v) => [v.v, v.note, v.kit_sha?.slice(0, 1)])).toEqual([[1, "write", "k"], [2, "kit 40fb85d6 (inline)", "n"]]);
		expect(item.blobs?.length).toBeGreaterThan(0);
	});
});
