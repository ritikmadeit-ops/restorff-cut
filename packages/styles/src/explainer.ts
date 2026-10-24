/**
 * EDT-21 step 2 — build an explainer on the **Paper collage** preset from a style card + the person's answers
 * (footage, format, feel) as ops@1: an editable timeline, not a video file (reel DePNgrmToh9, EDT-19).
 *
 * What a plan holds:
 *   - `apply_style restorff/style/paper-collage` (captions, paper grade on a GRADE layer), `set_canvas` (format + paper colour)
 *   - its own tracks: TEXT (beat lines), TAGS (FX-59 label tags), MOTION (compositions), V2 CUT-OUTS (FX-52 stills)
 *   - per beat: footage on the main track cut at the references' pace, cut-out stills sliding in, and the collage
 *     compositions where packages/compositions has them (paper-cut FX-13/52/60, map-route FX-54, retro-tv FX-55,
 *     thread-timeline FX-58, stamp FX-26, doodle-boil FX-14) — coloured from the card's palette
 *   - `report.missing`: every collage piece the reel shows that RestorffCut cannot build yet, said plainly
 *
 * Compositions must be rendered before they can be placed (the reducer is pure), so their `insert` ops carry a
 * placeholder media id (`composition:<key>`); the editor renders `plan.compositions`, imports them and calls
 * bindCompositions() to swap in the real media ids before applying.
 */
import type { Author, Op } from "@restorffcut/timeline-ops";
import type { StyleCard } from "./card.ts";
import { hexToRgb, luma, rgbToHsl } from "./palette.ts";

export const PAPER_COLLAGE_STYLE_ID = "restorff/style/paper-collage";
export const COMPOSITION_PLACEHOLDER_PREFIX = "composition:";

/** The collage compositions this plan knows how to fill (name → default length in seconds, from their manifests). */
export const COLLAGE_COMPOSITIONS: Record<string, { dur: number; title: string; effect: string }> = {
	"paper-cut": { dur: 4, title: "Paper cut", effect: "FX-13/FX-60 paper cut + letter tiles (paper-cut)" },
	"map-route": { dur: 4.5, title: "Map route", effect: "FX-54 map with route and pins (map-route)" },
	"retro-tv": { dur: 4, title: "Retro TV", effect: "FX-55 retro TV frame (retro-tv)" },
	"thread-timeline": { dur: 4.5, title: "Thread timeline", effect: "FX-58 thread timeline (thread-timeline)" },
	stamp: { dur: 2.5, title: "Rubber stamp", effect: "FX-26 rubber stamp (stamp)" },
	"doodle-boil": { dur: 4, title: "Doodle boil", effect: "FX-14 doodle boil (doodle-boil)" },
};

export const FORMATS: Record<string, { width: number; height: number }> = {
	"9:16": { width: 1080, height: 1920 },
	"4:5": { width: 1080, height: 1350 },
	"1:1": { width: 1080, height: 1080 },
	"16:9": { width: 1920, height: 1080 },
};

export interface ExplainerAnswers {
	/** mine = clips + stills from the project's media; stills = images as cut-outs only; none = paper + motion only. */
	footage?: "mine" | "stills" | "none";
	format?: "9:16" | "4:5" | "1:1" | "16:9";
	feel?: "playful" | "nostalgic" | "serious" | "punchy";
	/** Answer to the card's type question ("typewriter / mono caps", "serif", "bold sans", "handwritten"). */
	type?: string;
	/** What the explainer explains. Default (fictional): "How the farm-to-bottle route works". */
	topic?: string;
	/** One on-screen line per beat (the script). Without it the lines are placeholders to replace. */
	beats?: string[];
	/** Map stops in travel order (2–5). */
	places?: string[];
	/** Dated facts for a thread timeline (2–4). */
	dates?: Array<{ date: string; text: string }>;
	/** Word or number spelled in paper tiles on the title beat (≤ 10 characters). */
	number?: string;
	/** Stamp on the last beat (≤ 16 characters). */
	verdict?: string;
}

/** Media the person picked from the project (already in the editor's media store). */
export interface ExplainerAsset {
	id: string;
	kind: "video" | "image" | "audio";
	name: string;
	/** Seconds (videos). */
	duration?: number;
	width?: number;
	height?: number;
}

export interface ExplainerOptions {
	/** Timeline seconds where the explainer starts (the editor passes the end of what is there). Default 0. */
	start?: number;
	/** The project's current canvas; set_canvas is only emitted for a different format. */
	canvas?: { width: number; height: number };
	/** Composition names in the library (the editor passes its catalogue). Default: all of COLLAGE_COMPOSITIONS. */
	available?: readonly string[];
	/** Author on every op (default "compiler": a deterministic builder, so a later style change never deletes it). */
	author?: Author;
	/** Apply the Paper collage editing style first (default true). */
	applyPreset?: boolean;
}

export interface CompositionRequest {
	/** Unique in the plan. */
	key: string;
	name: string;
	title: string;
	props: Record<string, unknown>;
	/** Timeline seconds. */
	at: number;
	/** Seconds the plan reserves (render with this duration). */
	dur: number;
	/** The media id the plan's insert op carries until bindCompositions(). */
	placeholder: string;
	beat: number;
	/** Render size when not the canvas (explainer-v2: the paper ground renders at half size and is scaled up). */
	size?: { width: number; height: number };
}

export interface ExplainerBeat {
	index: number;
	kind: BeatKind;
	start: number;
	end: number;
	line: string;
	visual: string;
	effects: string[];
}

export interface ExplainerPlan {
	ops: Op[];
	compositions: CompositionRequest[];
	beats: ExplainerBeat[];
	/** Seconds from `start` to the end of the last beat. */
	duration: number;
	/** The canvas the plan asks for (null = unchanged). */
	canvas: { width: number; height: number } | null;
	report: {
		/** Collage pieces the reel shows that cannot be built yet (or were skipped), in plain words. */
		missing: string[];
		notes: string[];
		/** Effects used (EFFECTS.md ids). */
		effects: string[];
	};
	/**
	 * explainer-v2: ops to place instead of a composition insert whose render failed, by the insert's `ref` (e.g. the
	 * beat's picture where the paper ground did not render). bindCompositions() uses them.
	 */
	fallbacks?: Record<string, Op[]>;
}

type BeatKind = "title" | "cutouts" | "map" | "retro" | "timeline" | "stamp" | "doodle" | "footage";

const BEAT_COMPOSITION: Partial<Record<BeatKind, string>> = {
	title: "paper-cut",
	map: "map-route",
	retro: "retro-tv",
	timeline: "thread-timeline",
	stamp: "stamp",
	doodle: "doodle-boil",
};

const PLACEHOLDER_LINES: Record<BeatKind, string> = {
	title: "",
	cutouts: "Here's what goes in",
	map: "Here's the route",
	retro: "How it used to be done",
	timeline: "How we got here",
	stamp: "That's the whole story",
	doodle: "Made by hand",
	footage: "Up close",
};

const FEEL_MOTION: Record<string, { ease: string; speed: number }> = {
	playful: { ease: "bouncy", speed: 1 },
	nostalgic: { ease: "gentle", speed: 0.85 },
	serious: { ease: "smooth", speed: 0.9 },
	punchy: { ease: "snappy", speed: 1.2 },
};

const DEFAULT_TOPIC = "How the farm-to-bottle route works";
const DEFAULT_PLACES = ["FARM · HIGHLANDS", "ROASTERY", "CAFÉ · DOWNTOWN"];

function cut(text: string, max: number): string {
	const t = text.trim();
	return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

/** Colours to dress the collage in, from the card (fallbacks: the paper-collage defaults). */
export function collageColors(card: StyleCard): { paper: string; ink: string; accent: string; red: string; chips: string[] } {
	const palette = card.palette;
	const paper = palette.find((c) => c.role === "paper")?.hex ?? [...palette].filter((c) => c.luma > 0.6).sort((a, b) => b.share - a.share)[0]?.hex ?? "#F3EFE4";
	const ink = palette.find((c) => c.role === "ink")?.hex ?? [...palette].filter((c) => c.luma < 0.35).sort((a, b) => a.luma - b.luma)[0]?.hex ?? "#111111";
	const accent = palette.find((c) => c.role === "accent")?.hex ?? "#F2D04B";
	// a second loud colour for routes, threads and stamps: the most saturated non-accent, else the reel's red
	const second = [...palette]
		.filter((c) => c.hex !== accent && c.saturation > 0.4 && c.luma > 0.12 && c.luma < 0.8)
		.sort((a, b) => b.saturation - a.saturation)[0];
	const red = second?.hex ?? "#C8352B";
	const chips = palette.slice(0, 4).map((c) => c.hex);
	return { paper, ink, accent, red, chips: chips.length ? chips : ["#C8352B", "#E2B84A", "#2F5D50", "#8DB7C7"] };
}

/** Black or near-black text on a light background, bone on a dark one. */
export function textOn(background: string, ink: string): string {
	return luma(hexToRgb(background)) > 0.5 ? (luma(hexToRgb(ink)) < 0.4 ? ink : "#111111") : "#EDEBE6";
}

export function fontsFor(type: string | undefined): { line: string; italic: boolean; tag: string; missing?: string } {
	const t = (type ?? "").toLowerCase();
	if (/mono|typewriter/.test(t)) return { line: "JetBrains Mono", italic: false, tag: "JetBrains Mono" };
	if (/hand/.test(t)) return { line: "Instrument Serif", italic: true, tag: "JetBrains Mono", missing: "handwritten lettering: no handwritten font in the editor yet — serif italic used instead" };
	if (/sans/.test(t)) return { line: "Archivo", italic: false, tag: "JetBrains Mono" };
	return { line: "Instrument Serif", italic: false, tag: "JetBrains Mono" };
}

/**
 * The beat kinds in order: title, the collage middle, stamp. Without a script the natural length is used (no
 * padding with repeats); with N script lines the middle is padded or cut to N beats (3–8).
 */
function sequenceFor(lineCount: number, answers: ExplainerAnswers, footage: "mine" | "stills" | "none", hasImages: boolean): BeatKind[] {
	const middle: BeatKind[] = [];
	if (footage !== "none" && hasImages) middle.push("cutouts");
	else if (footage === "mine") middle.push("footage");
	middle.push("map");
	if (answers.feel === "playful") middle.push("doodle");
	if (footage !== "none") middle.push("retro");
	if ((answers.dates?.length ?? 0) >= 2) middle.push("timeline");
	const fillers: BeatKind[] = footage === "none" ? ["doodle", "map"] : footage === "stills" ? ["cutouts"] : hasImages ? ["footage", "cutouts"] : ["footage"];
	const target = lineCount ? clamp(lineCount, 3, 8) : Math.max(3, middle.length + 2);
	let i = 0;
	while (middle.length < target - 2) middle.push(fillers[i++ % fillers.length] as BeatKind);
	return ["title", ...middle.slice(0, target - 2), "stamp"];
}

const TITLE_STOP = new Set(["how", "the", "what", "why", "when", "where", "who", "works", "work", "does", "with", "your", "from", "into", "this", "that", "and"]);

/** The word for the title's letter tiles: the longest topic word that fits (≤ 10 letters), else "WHY". */
export function titleWord(topic: string): string {
	const words = topic
		.split(/[\s/]+/)
		.map((w) => w.replace(/[^\p{L}\p{N}%-]/gu, ""))
		.filter((w) => w.length >= 3 && w.length <= 10 && !TITLE_STOP.has(w.toLowerCase()));
	return (words.sort((a, b) => b.length - a.length)[0] ?? "WHY").toUpperCase();
}

/**
 * Build the explainer plan. Pure: the same card, answers, assets and options always give the same ops. The ops
 * validate with timeline-ops validateOps; composition inserts carry placeholders until bindCompositions().
 */
export function explainerPlan(card: StyleCard, answers: ExplainerAnswers = {}, assets: readonly ExplainerAsset[] = [], options: ExplainerOptions = {}): ExplainerPlan {
	const author: Author = options.author ?? "compiler";
	const start = Math.max(0, options.start ?? 0);
	const available = new Set(options.available ?? Object.keys(COLLAGE_COMPOSITIONS));
	const footage = answers.footage ?? (assets.some((a) => a.kind !== "audio") ? "mine" : "none");
	const motion = FEEL_MOTION[answers.feel ?? "playful"] ?? (FEEL_MOTION.playful as { ease: string; speed: number });
	const colors = collageColors(card);
	const fonts = fontsFor(answers.type);
	const topic = cut(answers.topic?.trim() || DEFAULT_TOPIC, 80);
	const short = cut(topic.toUpperCase(), 28);
	const missing: string[] = [];
	const notes: string[] = [];
	const effects = new Set<string>();
	const ops: Op[] = [];
	const compositions: CompositionRequest[] = [];
	const beats: ExplainerBeat[] = [];

	const format = answers.format ?? (card.questions.find((q) => q.id === "format")?.suggested as ExplainerAnswers["format"]) ?? "9:16";
	const target = FORMATS[format] ?? (FORMATS["9:16"] as { width: number; height: number });
	const canvasChange = !options.canvas || options.canvas.width !== target.width || options.canvas.height !== target.height;
	const W = target.width;
	const H = target.height;

	const footageAssets = footage === "mine" ? assets.filter((a) => a.kind === "video" || a.kind === "image") : [];
	const images = footage === "none" ? [] : assets.filter((a) => a.kind === "image");
	if (footage === "mine" && !footageAssets.length) notes.push("no clips or stills were picked: the explainer is paper and motion only");

	// pace: shots on the main track follow the references' average shot (clamped to what reads on a phone)
	const shotLen = clamp(card.pacing.avgShot ?? 2.2, 1.2, 4);
	const lines = (answers.beats ?? []).map((line) => line.trim()).filter(Boolean);
	const mode: "mine" | "stills" | "none" = footageAssets.length ? "mine" : footage === "stills" && images.length ? "stills" : "none";
	const sequence = sequenceFor(lines.length, answers, mode, images.length > 0);
	if (!lines.length) notes.push("the on-screen lines are placeholders: write one line per beat (or ask your Claude for a script) and build again");

	// 1. the preset + the canvas (tracks are added in step 3, once we know which ones the beats used)
	if (options.applyPreset !== false) ops.push({ op: "apply_style", author, preset_id: PAPER_COLLAGE_STYLE_ID });
	ops.push(canvasChange ? { op: "set_canvas", author, w: W, h: H, background: colors.paper } : { op: "set_canvas", author, background: colors.paper });
	const tracksAt = ops.length;

	// 2. beats
	let cursor = start;
	let footageIndex = 0;
	const usedIn = new Map<string, number>();
	let imageIndex = 0;
	let refN = 0;
	const ref = (what: string) => `explainer-${what}-${++refN}`;
	const total = sequence.length;

	/** Main-track footage over [from, to), cut every shotLen seconds, cycling through the picked clips. */
	const placeFootage = (from: number, to: number) => {
		if (!footageAssets.length) return;
		let t = from;
		let guard = 0;
		while (to - t > 0.05 && guard++ < 200) {
			const asset = footageAssets[footageIndex % footageAssets.length] as ExplainerAsset;
			footageIndex++;
			let len = Math.min(shotLen, to - t);
			if (to - t - len < 0.5) len = to - t; // never leave a sliver at the end of a beat
			if (asset.kind === "image") {
				ops.push({ op: "insert", author, track: "main", t: round3(t), media: asset.id, media_kind: "image", dur: round3(len), name: asset.name || "clip" });
			} else if (asset.duration && asset.duration > 0.2) {
				const used = usedIn.get(asset.id) ?? 0;
				const from = used + len <= asset.duration ? used : 0;
				const take = Math.min(len, asset.duration - from);
				ops.push({ op: "insert", author, track: "main", t: round3(t), media: asset.id, media_kind: "video", in: round3(from), out: round3(from + take), name: asset.name || "clip" });
				usedIn.set(asset.id, from + take);
				len = take;
			} else {
				ops.push({ op: "insert", author, track: "main", t: round3(t), media: asset.id, media_kind: "video", dur: round3(len), name: asset.name || "clip" });
			}
			t += len;
		}
	};

	/** One cut-out still on V2 CUT-OUTS sliding in from the right with a 6° settle (FX-52 minus the outline). */
	const placeCutout = (asset: ExplainerAsset, from: number, dur: number, slot: number, scale = 0.55) => {
		const r = ref("cutout");
		const x = slot % 2 === 0 ? -Math.round(W * 0.12) : Math.round(W * 0.12);
		const y = -Math.round(H * 0.06);
		const rot = slot % 2 === 0 ? -4 : 3;
		ops.push({
			op: "insert",
			author,
			track: "explainer-cutouts",
			t: round3(from),
			media: asset.id,
			media_kind: "image",
			dur: round3(dur),
			name: `cut-out · ${asset.name}`,
			params: { "transform.scaleX": scale, "transform.scaleY": scale, "transform.positionX": x, "transform.positionY": y, "transform.rotate": rot },
			ref: r,
		});
		const enter = Math.min(0.25, dur / 4);
		ops.push({ op: "keyframe", author, el: r, prop: "x", t: 0, value: x + Math.round(W * 0.9), local: true });
		ops.push({ op: "keyframe", author, el: r, prop: "x", t: round3(enter), value: x, ease: "ease_out", local: true });
		ops.push({ op: "keyframe", author, el: r, prop: "rotation", t: 0, value: rot + 6, local: true });
		ops.push({ op: "keyframe", author, el: r, prop: "rotation", t: round3(Math.min(0.32, dur / 3)), value: rot, ease: "ease_out", local: true });
	};

	const addComposition = (name: string, props: Record<string, unknown>, at: number, beat: number): number | null => {
		const spec = COLLAGE_COMPOSITIONS[name];
		if (!spec || !available.has(name)) {
			missing.push(`${name}: not in the composition library — beat ${beat + 1} uses footage instead`);
			return null;
		}
		const key = `beat${beat + 1}-${name}`;
		const placeholder = `${COMPOSITION_PLACEHOLDER_PREFIX}${key}`;
		compositions.push({ key, name, title: spec.title, props, at: round3(at), dur: spec.dur, placeholder, beat });
		ops.push({ op: "insert", author, track: "explainer-motion", t: round3(at), media: placeholder, media_kind: "video", dur: spec.dur, name: spec.title, ref: `explainer-${key}` });
		effects.add(spec.effect);
		return spec.dur;
	};

	const lineStyle = {
		font: fonts.line,
		italic: fonts.italic,
		size: 5.2,
		color: textOn(colors.paper, colors.ink),
		bg: true,
		bg_color: colors.paper,
		bg_radius: 0,
		bg_padding_x: 22,
		bg_padding_y: 10,
		align: "center" as const,
		y: Math.round(H * 0.3),
	};
	const tagStyle = {
		font: fonts.tag,
		size: 3,
		weight: "bold" as const,
		color: textOn(colors.accent, "#111111"),
		bg: true,
		bg_color: colors.accent,
		bg_radius: 0,
		bg_padding_x: 18,
		bg_padding_y: 8,
		uppercase: true,
		align: "center" as const,
		y: -Math.round(H * 0.36),
	};
	if (fonts.missing) missing.push(fonts.missing);

	sequence.forEach((planned, index) => {
		let kind: BeatKind = planned;
		const from = cursor;
		const beatEffects: string[] = [];
		let visual = "";
		let length = clamp(shotLen * 2, 2.5, 5);
		const composition = BEAT_COMPOSITION[kind];
		const layout = footageAssets.length ? "card" : "full";

		if (composition) {
			let props: Record<string, unknown> = { ease: motion.ease, speed: motion.speed };
			if (kind === "title") {
				const word = cut((answers.number?.trim() || titleWord(topic)).toUpperCase(), 10);
				props = { ...props, text: word, tag: short, note: "", layout: "full", paper: colors.paper, ink: colors.red, accent: colors.accent };
				visual = `paper sheet, "${word}" in letter tiles`;
			} else if (kind === "map") {
				const places = (answers.places?.length ? answers.places : DEFAULT_PLACES).slice(0, 5).map((name) => cut(name.toUpperCase(), 24));
				const stops = places.length >= 2 ? places : [...places, "HERE"];
				props = {
					...props,
					places: stops.map((name, i) => ({ name, x: round3(0.2 + (0.62 * i) / Math.max(1, stops.length - 1)), y: i % 2 === 0 ? 0.7 : 0.42 })),
					title: short,
					layout,
					route: colors.red,
					accent: colors.accent,
				};
				visual = `map route ${stops.join(" → ")}`;
			} else if (kind === "retro") {
				props = { ...props, label: cut(short, 32), chips: colors.chips, wall: colors.paper, accent: colors.accent };
				visual = "retro TV over the footage";
			} else if (kind === "timeline") {
				const items = (answers.dates ?? []).slice(0, 4).map((d) => ({ date: cut(d.date, 14), text: cut(d.text, 40) }));
				props = { ...props, items, legend: cut(short, 32), thread: colors.red, paper: colors.paper, accent: colors.accent };
				visual = `thread timeline ${items.map((i) => i.date).join(" · ")}`;
			} else if (kind === "stamp") {
				const word = cut((answers.verdict?.trim() || "SMALL BATCH").toUpperCase(), 16);
				props = { ...props, text: word, sub: cut(short, 32), color: colors.red };
				visual = `stamp "${word}"`;
			} else if (kind === "doodle") {
				const { ease: _ease, ...rest } = props; // doodle-boil has no easing param
				props = { ...rest, word: "", accent: colors.accent, color: footageAssets.length ? "#FFFFFF" : textOn(colors.paper, colors.ink) };
				visual = "doodles boil around the frame";
			}
			const placed = addComposition(composition, props, from, index);
			if (placed === null) {
				kind = footageAssets.length ? "footage" : images.length ? "cutouts" : "footage";
				visual = "";
			} else {
				length = placed;
				beatEffects.push(COLLAGE_COMPOSITIONS[composition]?.effect ?? composition);
			}
		}

		const to = from + length;
		// footage under every beat (the main track is magnetic to 0: keep it continuous from the start)
		placeFootage(from, to);

		if (kind === "cutouts" && images.length) {
			const asset = images[imageIndex % images.length] as ExplainerAsset;
			imageIndex++;
			placeCutout(asset, from, length, index);
			effects.add("FX-52 cut-out stills sliding in (no outline yet)");
			beatEffects.push("FX-52 cut-out");
			visual = visual || `cut-out ${asset.name}`;
		}
		if (kind === "retro" && !footageAssets.length && images.length) {
			// nothing on the main track: put a still under the TV so its screen is not empty
			const asset = images[imageIndex % images.length] as ExplainerAsset;
			imageIndex++;
			ops.push({ op: "insert", author, track: "explainer-cutouts", t: round3(from), media: asset.id, media_kind: "image", dur: round3(length), name: `in the TV · ${asset.name}`, params: { "transform.scaleX": 0.7, "transform.scaleY": 0.7, "transform.positionY": -Math.round(H * 0.08) } });
		}
		if (kind === "footage") visual = visual || (footageAssets.length ? "footage" : "paper");

		// the line (serif on a paper label) and a mono chapter tag
		const line = kind === "title" ? topic : (lines[index] ?? PLACEHOLDER_LINES[kind]);
		if (line) {
			ops.push({ op: "text_pop", author, t: round3(from + 0.25), text: cut(line, 90), dur: round3(Math.max(0.6, length - 0.45)), track: "explainer-text", style: lineStyle });
		}
		if (kind === "footage" || kind === "cutouts" || kind === "doodle") {
			ops.push({ op: "text_pop", author, t: round3(from + 0.1), text: `${cut(short, 20)} · ${index + 1}/${total}`, dur: round3(Math.max(0.6, length - 0.3)), track: "explainer-tags", style: tagStyle });
			effects.add("FX-59 label tags");
			beatEffects.push("FX-59 label tag");
		}
		beats.push({ index, kind, start: round3(from), end: round3(to), line, visual, effects: beatEffects });
		cursor = to;
	});

	// 3. tracks, only the ones the beats used (each add_track index 0 goes on top: TEXT, TAGS, MOTION, V2 CUT-OUTS)
	const uses = (ref: string) => ops.some((op) => (op as { track?: unknown }).track === ref);
	const trackOps: Op[] = [];
	if (uses("explainer-cutouts")) trackOps.push({ op: "add_track", author, kind: "video", name: "V2 CUT-OUTS", index: 0, ref: "explainer-cutouts" });
	if (uses("explainer-motion")) trackOps.push({ op: "add_track", author, kind: "video", name: "MOTION", index: 0, ref: "explainer-motion" });
	if (uses("explainer-tags")) trackOps.push({ op: "add_track", author, kind: "text", name: "TAGS", index: 0, ref: "explainer-tags" });
	if (uses("explainer-text")) trackOps.push({ op: "add_track", author, kind: "text", name: "TEXT", index: 0, ref: "explainer-text" });
	ops.splice(tracksAt, 0, ...trackOps);

	// 4. what cannot be built yet (EFFECTS.md collage kit), said plainly
	if (images.length && sequence.includes("cutouts")) missing.push("FX-52 red outline + drop shadow on cut-outs: needs the outline shader — the stills slide in without an outline");
	missing.push("FX-53 paper texture background: no paper-bg composition or shader yet — the canvas background is the card's paper colour");
	missing.push("FX-61 parallax strip, FX-57 triptych panels, FX-56 halftone push-in: not built yet");
	if (mode === "none" && footage !== "none") missing.push("no clips or stills picked: no cut-outs and no retro TV beat (it needs something to play in its screen)");
	notes.push("no voice-over yet, so no captions: add a VO, then auto-captions (the Paper collage caption style is already set)");
	notes.push("no music or SFX: use Design the sound after building");
	// grade agent, 2026-10-20: the style's "paper" grade is the real restorff-grade effect now (GRADE layer)

	return {
		ops,
		compositions,
		beats,
		duration: round3(cursor - start),
		canvas: canvasChange ? { width: W, height: H } : null,
		report: { missing, notes, effects: [...effects] },
	};
}

export interface BoundComposition {
	/** Media id of the imported render. */
	media: string;
	/** Real render length, seconds (the plan's length is kept when longer, so beats never overlap). */
	dur?: number;
}

/**
 * Swap composition placeholders for real media ids. A composition that did not render (null / missing) is dropped,
 * and named in `dropped`.
 */
export function bindCompositions(plan: ExplainerPlan, bound: Record<string, BoundComposition | null | undefined>): { ops: Op[]; dropped: string[] } {
	const byPlaceholder = new Map(plan.compositions.map((request) => [request.placeholder, request]));
	const dropped: string[] = [];
	const ops: Op[] = [];
	// explainer-v2: keyframes on a dropped insert would point at nothing (the reducer refuses them): they go too, and a
	// plan's fallback for that insert (by ref) goes in its place
	const droppedRefs = new Set<string>();
	for (const op of plan.ops) {
		if (op.op === "insert" && typeof op.media === "string" && op.media.startsWith(COMPOSITION_PLACEHOLDER_PREFIX)) {
			const request = byPlaceholder.get(op.media);
			const binding = request ? bound[request.key] : undefined;
			if (!request || !binding) {
				const key = request?.key ?? op.media;
				if (!dropped.includes(key)) dropped.push(key);
				if (op.ref) {
					droppedRefs.add(op.ref);
					ops.push(...(plan.fallbacks?.[op.ref] ?? []));
				}
				continue;
			}
			const dur = binding.dur && binding.dur > 0 ? Math.min(binding.dur, op.dur ?? binding.dur) : op.dur;
			ops.push({ ...op, media: binding.media, ...(dur ? { dur: round3(dur) } : {}) });
			continue;
		}
		if (droppedRefs.size && "el" in op && typeof op.el === "string" && droppedRefs.has(op.el)) continue;
		ops.push(op);
	}
	return { ops, dropped };
}

/** Plain-words summary for the "What's in this version" note (EDT-19/21 change notes). */
export function describePlan(plan: ExplainerPlan): string {
	const pieces = plan.beats.map((beat) => `${beat.index + 1}. ${beat.visual || beat.kind}${beat.line ? ` — "${beat.line}"` : ""}`);
	return [`Explainer, ${plan.beats.length} beats, ${plan.duration} s, Paper collage.`, ...pieces].join("\n");
}

/** Hue name of a colour, for the card's swatch labels ("mustard", "brick"…): coarse on purpose. */
export function colorName(hex: string): string {
	const rgb = hexToRgb(hex);
	const { h, s, l } = rgbToHsl(rgb);
	if (l > 0.9) return "white";
	if (l < 0.12) return "black";
	if (s < 0.12) return l > 0.6 ? "paper grey" : l > 0.35 ? "grey" : "charcoal";
	const names: Array<[number, string]> = [
		[15, "red"],
		[40, "orange"],
		[55, l < 0.5 ? "mustard" : "ochre"],
		[70, "yellow"],
		[160, "green"],
		[200, "teal"],
		[250, "blue"],
		[290, "violet"],
		[335, "pink"],
		[360, "red"],
	];
	const base = names.find(([limit]) => h < limit)?.[1] ?? "red";
	if (base === "orange" && l < 0.4) return "brown";
	if (base === "red" && l < 0.4) return "brick";
	return l > 0.75 ? `pale ${base}` : base;
}
