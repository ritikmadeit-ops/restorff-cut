/**
 * Interchange (EDT-19): FCPXML 1.10 + OTIO export of a Halcyon fixture, and the OTIO → import_cuts round trip.
 * Fictional data only (Halcyon Cold Brew). Run: cd apps/web && bun test src/server/interchange.test.ts
 */
import { describe, expect, test } from "bun:test";
import { apply } from "@restorffcut/timeline-ops";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { type ApplyFn, cutPointsOf, planImportCuts } from "./interchange-cuts";
import { toFcpxml } from "./interchange-fcpxml";
import { fixtureInput, halcyonFixture } from "./interchange-fixture";
import { readOtio, toOtio, validateOtio } from "./interchange-otio";

type Json = Record<string, any>;

const applyFn: ApplyFn = (project, ops, options) => apply(project as never, ops as never, options) as never;
const input = fixtureInput;

// ─── a strict little XML reader (well-formedness: one root, matched tags, quoted attributes, legal & entities) ──

interface XNode {
	name: string;
	attrs: Record<string, string>;
	children: XNode[];
	text: string;
}

function parseXml(xml: string): XNode {
	let i = 0;
	const stack: XNode[] = [];
	let root: XNode | null = null;
	const decode = (raw: string, where: string) => {
		if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(raw)) throw new Error(`bare & in ${where}`);
		if (raw.includes("<")) throw new Error(`bare < in ${where}`);
		return raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
	};
	while (i < xml.length) {
		if (xml.startsWith("<?", i)) {
			const end = xml.indexOf("?>", i);
			if (end < 0) throw new Error("unclosed <?");
			i = end + 2;
		} else if (xml.startsWith("<!--", i)) {
			const end = xml.indexOf("-->", i);
			if (end < 0) throw new Error("unclosed comment");
			if (xml.slice(i + 4, end).includes("--")) throw new Error("-- inside a comment");
			i = end + 3;
		} else if (xml.startsWith("<!DOCTYPE", i)) {
			i = xml.indexOf(">", i) + 1;
		} else if (xml.startsWith("</", i)) {
			const end = xml.indexOf(">", i);
			const name = xml.slice(i + 2, end).trim();
			const open = stack.pop();
			if (!open || open.name !== name) throw new Error(`</${name}> closes <${open?.name}>`);
			i = end + 1;
		} else if (xml[i] === "<") {
			const end = xml.indexOf(">", i);
			let body = xml.slice(i + 1, end);
			const selfClosing = body.endsWith("/");
			if (selfClosing) body = body.slice(0, -1);
			const name = /^[A-Za-z_][\w.-]*/.exec(body)?.[0];
			if (!name) throw new Error(`bad tag at ${i}`);
			const attrs: Record<string, string> = {};
			const rest = body.slice(name.length);
			const re = /\s+([A-Za-z_][\w.:-]*)="([^"]*)"/g;
			let consumed = 0;
			for (let m = re.exec(rest); m; m = re.exec(rest)) {
				if (m.index !== consumed) throw new Error(`junk in <${name}>: ${rest.slice(consumed, m.index)}`);
				if (m[1] in attrs) throw new Error(`duplicate attribute ${m[1]} on <${name}>`);
				attrs[m[1]] = decode(m[2], `${name}@${m[1]}`);
				consumed = m.index + m[0].length;
			}
			if (rest.slice(consumed).trim()) throw new Error(`junk in <${name}>: ${rest.slice(consumed)}`);
			const node: XNode = { name, attrs, children: [], text: "" };
			if (stack.length) stack[stack.length - 1].children.push(node);
			else if (root) throw new Error("two root elements");
			else root = node;
			if (!selfClosing) stack.push(node);
			i = end + 1;
		} else {
			const end = xml.indexOf("<", i);
			const raw = xml.slice(i, end < 0 ? xml.length : end);
			if (raw.trim()) {
				if (!stack.length) throw new Error("text outside the root");
				stack[stack.length - 1].text += decode(raw, "text");
			}
			i = end < 0 ? xml.length : end;
		}
	}
	if (stack.length) throw new Error(`unclosed <${stack[stack.length - 1].name}>`);
	if (!root) throw new Error("no root element");
	return root;
}

const walk = (node: XNode, visit: (node: XNode, parent: XNode | null) => void, parent: XNode | null = null) => {
	visit(node, parent);
	for (const child of node.children) walk(child, visit, node);
};

/** "3/2s" → {n: 3, d: 2}; "0s" → {n: 0, d: 1}. */
function rational(value: string): { n: number; d: number } {
	const match = /^(\d+)(?:\/(\d+))?s$/.exec(value);
	if (!match) throw new Error(`not a rational time: ${value}`);
	return { n: Number(match[1]), d: Number(match[2] ?? 1) };
}

/** A rational time in frames of frameDuration fd; throws when it is off the frame grid. */
function inFrames(value: string, fd: { n: number; d: number }): number {
	const { n, d } = rational(value);
	const frames = (n * fd.d) / (d * fd.n);
	if (!Number.isInteger(frames)) throw new Error(`${value} is not a whole number of ${fd.n}/${fd.d}s frames`);
	return frames;
}

// ─── FCPXML ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("FCPXML 1.10", () => {
	test("is well-formed, every ref resolves, every time is a whole frame on the rational grid", () => {
		const { xml, summary } = toFcpxml(input(halcyonFixture()));
		const root = parseXml(xml);
		expect(root.name).toBe("fcpxml");
		expect(root.attrs.version).toBe("1.10");
		const ids = new Set<string>();
		const refs: string[] = [];
		const times: string[] = [];
		walk(root, (node) => {
			if (node.attrs.id) {
				expect(ids.has(node.attrs.id)).toBe(false);
				ids.add(node.attrs.id);
			}
			if (node.attrs.ref) refs.push(node.attrs.ref);
			for (const key of ["offset", "start", "duration", "tcStart"]) if (node.attrs[key] !== undefined && node.name !== "text-style") times.push(node.attrs[key]);
		});
		for (const ref of refs) expect(ids.has(ref)).toBe(true);
		const format = root.children[0].children.find((node) => node.name === "format")!;
		expect(format.attrs.frameDuration).toBe("1/30s");
		const fd = rational(format.attrs.frameDuration);
		for (const time of times) inFrames(time, fd); // throws when off the grid
		expect(summary.counts.clips).toBeGreaterThan(0);
		expect(xml).not.toContain("NaN");
		expect(xml).not.toContain("undefined");
	});

	test("the spine is contiguous, lanes are the tracks, connected clips land on their timeline frames", () => {
		const { xml, summary } = toFcpxml(input(halcyonFixture()));
		const root = parseXml(xml);
		const fd = { n: 1, d: 30 };
		let sequence: XNode | undefined;
		walk(root, (node) => {
			if (node.name === "sequence") sequence = node;
		});
		const spine = sequence!.children[0];
		expect(spine.name).toBe("spine");
		let cursor = 0;
		const placed: Array<{ name: string; lane: number; start: number; end: number; tag: string }> = [];
		for (const item of spine.children) {
			if (item.name === "transition") {
				// centred on the S02 cut at 180: 15 frames from 173 (half = 7)
				expect(inFrames(item.attrs.offset, fd)).toBe(173);
				expect(inFrames(item.attrs.duration, fd)).toBe(15);
				continue;
			}
			const offset = inFrames(item.attrs.offset, fd);
			const duration = inFrames(item.attrs.duration, fd);
			expect(offset).toBe(cursor);
			const localStart = inFrames(item.attrs.start ?? "0s", fd);
			placed.push({ name: item.attrs.name, lane: 0, start: offset, end: offset + duration, tag: item.name });
			for (const child of item.children) {
				if (child.attrs.lane === undefined) continue;
				const at = offset + inFrames(child.attrs.offset, fd) - localStart;
				placed.push({ name: child.attrs.name, lane: Number(child.attrs.lane), start: at, end: at + inFrames(child.attrs.duration, fd), tag: child.name });
			}
			cursor = offset + duration;
		}
		expect(inFrames(sequence!.attrs.duration, fd)).toBe(cursor);
		expect(cursor).toBe(300); // 10 s at 30 fps
		const find = (name: string) => placed.find((entry) => entry.name === name);
		expect(find("S01 talking head")).toEqual({ name: "S01 talking head", lane: 0, start: 0, end: 180, tag: "asset-clip" });
		expect(find("S02 fridge")).toEqual({ name: "S02 fridge", lane: 0, start: 180, end: 300, tag: "asset-clip" });
		// overlay: GRADE(0, not exported) CAPTIONS(1) TEXT(2) MOTION(3) V2 B-ROLL(4) → lanes 4, 3, 2, 1; audio MUSIC -1, SFX -2
		expect(find("S03 pour")).toEqual({ name: "S03 pour", lane: 1, start: 90, end: 180, tag: "asset-clip" });
		expect(find("S05 can")).toEqual({ name: "S05 can", lane: 1, start: 240, end: 300, tag: "video" });
		expect(find("Badge pills")).toEqual({ name: "Badge pills", lane: 2, start: 15, end: 75, tag: "asset-clip" });
		expect(find("ONE POUR.")).toEqual({ name: "ONE POUR.", lane: 3, start: 186, end: 246, tag: "title" });
		expect(find("Steeped for twenty hours.")).toEqual({ name: "Steeped for twenty hours.", lane: 4, start: 48, end: 90, tag: "title" });
		expect(find("Halcyon bed")).toEqual({ name: "Halcyon bed", lane: -1, start: 0, end: 300, tag: "asset-clip" });
		expect(find("Whoosh")).toEqual({ name: "Whoosh", lane: -2, start: 173, end: 191, tag: "asset-clip" }); // 172.5 → 173
		expect(summary.rounded_to_frames).toBe(1);
		// a source in point: S01 starts 0.5 s into its file
		const s01 = spine.children.find((node) => node.attrs.name === "S01 talking head")!;
		expect(s01.attrs.start).toBe("1/2s");
		// titles carry their words; the comment is a to-do marker; the muted pour plays video only
		expect(xml).toContain(">ONE POUR.</text-style>");
		expect(xml).toContain('completed="0"');
		expect(xml).toContain('srcEnable="video"');
		expect(xml).toContain('<adjust-volume amount="-10dB"/>');
		expect(xml).toContain('<adjust-transform scale="1.2 1.2"/>');
		expect(xml).toContain('src="http://localhost:8791/api/projects/proj-halcyon-interchange/media/media-aroll"');
		const notes = summary.not_expressed.map((item) => item.what).join(" | ");
		expect(notes).toContain("composition");
		expect(notes).toContain("grade adjustment layer");
		expect(notes).toContain("keyframes");
		expect(summary.counts).toMatchObject({ clips: 5, titles: 4, audio: 2, transitions: 1, markers: 2 });
	});

	test("29.97 fps: NTSC rational times (1001/30000s frames)", () => {
		const { xml } = toFcpxml(input(halcyonFixture({ numerator: 30000, denominator: 1001 })));
		const root = parseXml(xml);
		const format = root.children[0].children.find((node) => node.name === "format")!;
		expect(format.attrs.frameDuration).toBe("1001/30000s");
		const fd = rational(format.attrs.frameDuration);
		walk(root, (node) => {
			for (const key of ["offset", "duration"]) if (node.attrs[key] !== undefined && node.name !== "format") inFrames(node.attrs[key], fd);
		});
		expect(xml).toMatch(/duration="\d+\/30000s"/);
	});

	test("escapes markup in names and text", () => {
		const snapshot = halcyonFixture();
		const title = snapshot.scenes[0].tracks!.overlay![2].elements[0];
		(title.params as Json).content = 'Cold <brew> & "ice"';
		title.name = "A & B <c>";
		const { xml } = toFcpxml(input(snapshot));
		parseXml(xml);
		expect(xml).toContain("Cold &lt;brew&gt; &amp; &quot;ice&quot;");
	});
});

// ─── OTIO ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("OTIO", () => {
	test("validates against the schema shape (strict), tracks bottom → top then audio", () => {
		const { otio, text, summary } = toOtio(input(halcyonFixture()));
		expect(validateOtio(otio, { strict: true })).toEqual([]);
		expect(validateOtio(JSON.parse(text), { strict: true })).toEqual([]);
		const tracks = (otio.tracks as Json).children as Json[];
		expect(tracks.map((track) => `${track.kind}:${track.name}`)).toEqual([
			"Video:V1 A-ROLL",
			"Video:V2 B-ROLL",
			"Video:MOTION",
			"Video:TEXT",
			"Video:CAPTIONS",
			"Audio:MUSIC",
			"Audio:SFX",
		]);
		const main = tracks[0].children as Json[];
		expect(main.map((item) => item.OTIO_SCHEMA)).toEqual(["Clip.2", "Transition.1", "Clip.2"]);
		expect(main[0].source_range).toEqual({
			OTIO_SCHEMA: "TimeRange.1",
			duration: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: 180 },
			start_time: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: 15 },
		});
		expect(main[1]).toMatchObject({ transition_type: "SMPTE_Dissolve", in_offset: { value: 7 }, out_offset: { value: 8 } });
		expect(((otio.tracks as Json).markers as Json[]).map((marker) => marker.color)).toEqual(["RED", "PURPLE"]);
		expect(summary.counts.tracks).toBe(7);
		// every value is a whole frame
		const values: number[] = [];
		JSON.stringify(otio, (key, value) => {
			if (key === "value" && typeof value === "number") values.push(value);
			return value;
		});
		expect(values.every(Number.isInteger)).toBe(true);
	});

	test("refuses broken documents with a reason", () => {
		expect(validateOtio({ OTIO_SCHEMA: "Clip.2" })[0]).toContain("not an OTIO timeline");
		const { otio } = toOtio(input(halcyonFixture()));
		const broken = JSON.parse(JSON.stringify(otio));
		broken.tracks.children[0].children.unshift({ OTIO_SCHEMA: "Transition.1", in_offset: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: 1 }, out_offset: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: 1 } });
		expect(validateOtio(broken).join(" ")).toContain("needs an item on both sides");
	});
});

// ─── round trip: export → (edit) → import_cuts onto a copy → same cut points ±1 frame ─────────────────────────

const copyOf = (snapshot: ProjectSnapshot) => JSON.parse(JSON.stringify(snapshot)) as ProjectSnapshot;

interface Cut {
	start: number;
	end: number;
	in: number;
}

/** Per OTIO track name: its clips' cut points (frames). */
function otioCuts(otio: unknown): Record<string, Cut[]> {
	const list = readOtio(otio, { num: 30, den: 1 });
	return Object.fromEntries(list.tracks.map((track) => [track.name, track.cuts.map((cut) => ({ start: cut.start, end: cut.end, in: cut.kind === "media" ? cut.inF : 0 }))]));
}

function expectSameCuts(actual: Record<string, Cut[]>, expected: Record<string, Cut[]>) {
	expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
	for (const [track, cuts] of Object.entries(expected)) {
		const got = actual[track];
		expect(got.length).toBe(cuts.length);
		cuts.forEach((cut, i) => {
			expect(Math.abs(got[i].start - cut.start)).toBeLessThanOrEqual(1);
			expect(Math.abs(got[i].end - cut.end)).toBeLessThanOrEqual(1);
			expect(Math.abs(got[i].in - cut.in)).toBeLessThanOrEqual(1);
		});
	}
}

/** Rebuilds a track's children from clips at absolute frames (what an editor writes after a cut-only edit). */
function setTrack(otio: Json, name: string, clips: Array<{ from: Json; start: number; dur: number; in?: number }>) {
	const track = (otio.tracks.children as Json[]).find((candidate) => candidate.name === name)!;
	const children: Json[] = [];
	let cursor = 0;
	for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
		if (clip.start > cursor) children.push({ OTIO_SCHEMA: "Gap.1", metadata: {}, name: "", source_range: { OTIO_SCHEMA: "TimeRange.1", duration: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: clip.start - cursor }, start_time: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: 0 } }, effects: [], markers: [], enabled: true });
		const copy = JSON.parse(JSON.stringify(clip.from));
		copy.source_range = {
			OTIO_SCHEMA: "TimeRange.1",
			duration: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: clip.dur },
			start_time: { OTIO_SCHEMA: "RationalTime.1", rate: 30, value: clip.in ?? copy.source_range.start_time.value },
		};
		children.push(copy);
		cursor = clip.start + clip.dur;
	}
	track.children = children;
}

const clipsOf = (otio: Json, name: string) => ((otio.tracks.children as Json[]).find((track) => track.name === name)!.children as Json[]).filter((item) => item.OTIO_SCHEMA === "Clip.2");

/** A cut-only edit, as another editor would make it: split + lift, slip, ripple, nudge, shorten, delete. */
function editInOtherEditor(otio: Json): Json {
	const edited = JSON.parse(JSON.stringify(otio));
	const [s01, s02] = clipsOf(edited, "V1 A-ROLL");
	// S01 [0,180) in 15 → split at 3 s, lift 1 s of source: [0,90) in 15 + [90,150) in 135; S02 rippled 30 frames left
	setTrack(edited, "V1 A-ROLL", [
		{ from: s01, start: 0, dur: 90, in: 15 },
		{ from: s01, start: 90, dur: 60, in: 135 },
		{ from: s02, start: 150, dur: 120 },
	]);
	const [pour, can] = clipsOf(edited, "V2 B-ROLL");
	setTrack(edited, "V2 B-ROLL", [
		{ from: pour, start: 100, dur: 80, in: 10 }, // head trimmed 10 frames
		{ from: can, start: 240, dur: 60 },
	]);
	const [cap1, cap2, cap3] = clipsOf(edited, "CAPTIONS");
	setTrack(edited, "CAPTIONS", [
		{ from: cap1, start: 15, dur: 30 },
		{ from: cap2, start: 45, dur: 42 }, // nudged 3 frames earlier
		{ from: cap3, start: 93, dur: 27 },
	]);
	const [music] = clipsOf(edited, "MUSIC");
	setTrack(edited, "MUSIC", [{ from: music, start: 0, dur: 270 }]); // shortened by 1 s
	setTrack(edited, "SFX", []); // the whoosh deleted
	return edited;
}

describe("import_cuts round trip", () => {
	test("export → import onto a copy: nothing to do, cut points identical", () => {
		const original = halcyonFixture();
		const { otio } = toOtio(input(original));
		const result = planImportCuts(copyOf(original), otio, { apply: applyFn, seed: "test/identity" });
		expect(result.ok).toBe(true);
		expect(result.strategy).toBe("none");
		expect(result.ops).toEqual([]);
		expect(result.report.counts.unchanged).toBe(result.report.counts.matched);
		expect(result.report.verify.within_one_frame).toBe(result.report.verify.checked);
		expect(cutPointsOf(result.project)).toEqual(cutPointsOf(original));
	});

	test("edited in another editor → import_cuts → re-export has the same cut points (±1 frame)", () => {
		const original = halcyonFixture();
		const edited = editInOtherEditor(toOtio(input(original)).otio);
		expect(validateOtio(edited, { strict: true })).toEqual([]);
		const result = planImportCuts(copyOf(original), edited, { apply: applyFn, seed: "test/edited" });
		expect(result.report.conflicts).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.report.verify.off).toEqual([]);
		expect(result.report.counts).toMatchObject({ splits: 1, deletes: 1 });
		expect(result.report.deleted.map((entry) => entry.element_id)).toEqual(["el-whoosh"]);
		const again = toOtio({ ...input(result.project), comments: [] }).otio;
		expectSameCuts(otioCuts(again), otioCuts(edited));
		// importing the same OTIO again changes nothing (both halves of the split carry el-s01's id in the OTIO)
		const twice = planImportCuts(result.project, edited, { apply: applyFn, seed: "test/edited-again" });
		expect(twice.ok).toBe(true);
		expect(twice.ops).toEqual([]);
		expect(twice.strategy).toBe("none");
	});

	test("a copy with new ids and an OTIO that lost our metadata: matched by media, titles by text", () => {
		const original = halcyonFixture();
		const edited = editInOtherEditor(toOtio(input(original)).otio);
		const stripped = JSON.parse(JSON.stringify(edited, (key, value) => (key === "restorffcut" ? undefined : value)));
		const copy = copyOf(original);
		const raw = JSON.stringify(copy).replace(/"(el|trk)-([a-z0-9-]+)"/g, '"copy-$1-$2"');
		const result = planImportCuts(JSON.parse(raw), stripped, { apply: applyFn, seed: "test/stripped", removeMissing: "all" });
		expect(result.report.conflicts).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.report.tracks.every((track) => track.mapped_by === "name")).toBe(true);
		expect(result.report.unmatched).toEqual([]);
		expectSameCuts(otioCuts(toOtio({ ...input(result.project), comments: [] }).otio), otioCuts(stripped));
	});

	test("clips that swap places need the park strategy, and still land on their frames", () => {
		const original = halcyonFixture();
		const otio = JSON.parse(JSON.stringify(toOtio(input(original)).otio));
		const [pour, can] = clipsOf(otio, "V2 B-ROLL");
		setTrack(otio, "V2 B-ROLL", [
			{ from: can, start: 90, dur: 60 },
			{ from: pour, start: 200, dur: 90, in: 0 },
		]);
		const result = planImportCuts(copyOf(original), otio, { apply: applyFn, seed: "test/swap" });
		expect(result.ok).toBe(true);
		expect(result.strategy).toBe("park");
		expect(result.report.verify.off).toEqual([]);
		expect(JSON.stringify(result.project)).not.toContain("IMPORT · PARK");
		expectSameCuts(otioCuts(toOtio({ ...input(result.project), comments: [] }).otio), otioCuts(otio));
	});

	test("a slip of the first A-roll clip (earlier source in at 0) goes through the park track", () => {
		const original = halcyonFixture();
		const otio = JSON.parse(JSON.stringify(toOtio(input(original)).otio));
		const [s01, s02] = clipsOf(otio, "V1 A-ROLL");
		setTrack(otio, "V1 A-ROLL", [
			{ from: s01, start: 0, dur: 180, in: 6 },
			{ from: s02, start: 180, dur: 120 },
		]);
		const result = planImportCuts(copyOf(original), otio, { apply: applyFn, seed: "test/slip" });
		expect(result.ok).toBe(true);
		expect(result.strategy).toBe("park");
		expect(result.report.verify.off).toEqual([]);
		expectSameCuts(otioCuts(toOtio({ ...input(result.project), comments: [] }).otio), otioCuts(otio));
	});

	test("unknown clips are listed, not created; elements the export never listed are kept", () => {
		const original = halcyonFixture();
		const otio = JSON.parse(JSON.stringify(toOtio(input(original)).otio));
		const [music] = clipsOf(otio, "MUSIC");
		const stranger = JSON.parse(JSON.stringify(music));
		stranger.metadata = {};
		stranger.media_references.DEFAULT_MEDIA = { OTIO_SCHEMA: "ExternalReference.1", metadata: {}, name: "other-bed.wav", available_range: null, available_image_bounds: null, target_url: "file:///Volumes/media/other-bed.wav" };
		setTrack(otio, "SFX", [{ from: stranger, start: 30, dur: 30, in: 0 }]);
		const copy = copyOf(original);
		const result = planImportCuts(copy, otio, { apply: applyFn, seed: "test/stranger" });
		expect(result.ok).toBe(true);
		expect(result.report.unmatched.length).toBe(1);
		expect(result.report.unmatched[0].reason).toContain("new clips are not imported");
		// the whoosh was listed by the export and is gone from SFX → deleted (it was removed in the other editor)
		expect(result.report.deleted.map((entry) => entry.element_id)).toEqual(["el-whoosh"]);
	});
});
