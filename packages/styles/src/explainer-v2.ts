/**
 * explainer-v2 (2026-10-20, SUMMARY gap 13) — the Paper collage explainer as BEATS {line, picture, tag} cut into
 * SHOTS at the feel's pace, with the collage kit packages/compositions ships, used by name:
 *
 *   beat   = one script line (beats.ts: bound to the pictures that share its subject, tagged from its places / dates /
 *            subject), on screen for its reading time × the feel's linger (or scaled to `length_s`)
 *   shot   = ~the feel's shot length (punchy 2 s → ~5 cuts per 10 s); shots alternate the MAIN track between the
 *            beat's photo and a paper ground, so every shot boundary is a hard cut a viewer (and ffmpeg) sees:
 *              photo      the picture full frame (a slow push; the 2nd time a punch-in), number tiles over it
 *              cut-outs   1–3 of the beat's pictures as paper cut-outs with a THICK outline in the card's accent
 *                         (cutout-outline), drifting scraps behind them (cutout-outline with paper scraps)
 *              title      paper-cut letter tiles from the title answer / beat 0's line (never the number answer)
 *              map        map-route full frame + a zoom toward the beat's place (the title's map zooms out instead)
 *              timeline   thread-timeline with the dates, over paper
 *              parallax   parallax-strip with the beat's cut-out picture (alpha) as the hero
 *              halftone   halftone-push of the beat's picture (no default vinyl: match none)
 *              retro      retro-tv over the beat's clip
 *              torn       a torn-paper hole (cutout-outline, torn edge) pushing into the beat's next photo
 *   text   = every display-text param of every piece is set (to the beat's words, or "" to hide): no example text
 *            leaks ("every morning", "HALCYON TV · EST. 1956"…)
 *
 * Pictures inside composition props are `still:<media id>` placeholders: the server swaps in ≤ 720 px data: URLs
 * (the compositions service accepts no server paths). Pure and deterministic.
 */
import type { Author, Op } from "@restorffcut/timeline-ops";
import { beatLengths, bindBeats, type BoundBeat, type ExplainerAnswersV2, FEEL_PACE, type PictureAsset, scriptOf, TAG_MAX, words } from "./beats.ts";
import type { StyleCard } from "./card.ts";
import {
	COLLAGE_COMPOSITIONS,
	COMPOSITION_PLACEHOLDER_PREFIX,
	collageColors,
	type CompositionRequest,
	type ExplainerBeat,
	type ExplainerOptions,
	type ExplainerPlan,
	FORMATS,
	fontsFor,
	PAPER_COLLAGE_STYLE_ID,
	textOn,
	titleWord,
} from "./explainer.ts";
import { hexToRgb, luma, type PaletteColor, type Rgb, rgbToHsl } from "./palette.ts";

/** Prefix of a picture reference inside composition props; the server replaces it with a data: URL. */
export const STILL_PREFIX = "still:";

/** Kit pieces the v2 plan uses by name when the library has them (packages/compositions). */
export const KIT_PIECES = ["cutout-outline", "paper-texture", "parallax-strip", "halftone-push", "map-route", "thread-timeline", "retro-tv", "paper-cut", "stamp", "doodle-boil"] as const;

export type ShotKind = "title" | "photo" | "hero" | "cutouts" | "paper" | "map" | "timeline" | "parallax" | "halftone" | "retro" | "torn";

export interface ShotPlan {
	beat: number;
	/** Shot number inside its beat (0-based). */
	index: number;
	t: number;
	dur: number;
	kind: ShotKind;
	/** What fills the main track: the picture, or the paper ground. */
	main: "picture" | "paper";
	/** Media id of the picture on the main track / in the piece. */
	picture?: string;
	/** Composition keys on this shot (MOTION, SCRAPS, STAMPS). */
	pieces: string[];
	/** Overlays on this shot: number tiles, stamp, doodles. */
	overlays: string[];
}

export interface ExplainerPlanV2 extends ExplainerPlan {
	planVersion: 2;
	shots: ShotPlan[];
	binding: BoundBeat[];
	script: { source: "beats" | "narration" | "made"; lines: number };
	pacing: {
		feel: string;
		shot_s: number;
		target_cuts_per_10s: number;
		planned_cuts_per_10s: number;
		length_s: number;
		reading_s: number;
		asked_length_s: number | null;
	};
	/** Media ids whose stills the compositions need (as `still:<id>` in props). */
	stills: string[];
}

const FEEL_MOTION: Record<string, { ease: string; speed: number }> = {
	playful: { ease: "bouncy", speed: 1 },
	nostalgic: { ease: "gentle", speed: 0.85 },
	serious: { ease: "smooth", speed: 0.9 },
	punchy: { ease: "snappy", speed: 1.2 },
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const upper = (text: string) => text.trim().toUpperCase();
const fit = (text: string, max: number) => {
	const t = text.trim();
	return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

function hueGap(a: number, b: number): number {
	const d = Math.abs(a - b) % 360;
	return d > 180 ? 360 - d : d;
}

/** The v2 colours: outlines, routes, threads and stamps in the card's ACCENT (red when the references are red); tags in
 * the second loud colour (the reel's yellow tags), else a tag yellow. */
export function collageColorsV2(card: StyleCard): { paper: string; ink: string; accent: string; tagBg: string; tagInk: string; sea: string; land: string; chips: string[]; edge: string } {
	const base = collageColors(card);
	const accentColor = card.palette.find((c) => c.role === "accent");
	const accent = accentColor?.hex ?? "#C8352B";
	const loud = [...card.palette].filter((c) => c.hex !== accent && c.role !== "paper" && c.saturation > 0.35 && c.luma > 0.3 && c.luma < 0.85 && hueGap(c.hue, accentColor?.hue ?? 0) > 25);
	const rank = (a: PaletteColor, b: PaletteColor) => b.saturation * Math.sqrt(b.share) - a.saturation * Math.sqrt(a.share);
	// tags are the reel's yellow / mustard labels: a warm loud colour first (live run 1 took a teal and tinted the map's
	// land the sea's colour), lifted until black type reads on it
	const warm = loud.filter((c) => c.hue >= 25 && c.hue <= 70).sort(rank)[0];
	const lift = (hex: string, k: number) => {
		const [r, g, b] = hexToRgb(hex);
		const up = (v: number) => Math.round(v + (255 - v) * k);
		return `#${[up(r), up(g), up(b)].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
	};
	let tagBg = warm?.hex ?? "#F2D04B";
	for (let k = 0.15; luma(hexToRgb(tagBg)) < 0.58 && k <= 0.6; k += 0.15) tagBg = lift(warm?.hex ?? tagBg, k);
	const sea = card.palette.find((c) => c.hue >= 165 && c.hue <= 235 && c.saturation > 0.2 && c.luma > 0.2)?.hex ?? "#8DB7C7";
	// land: the warm tag colour (yellow land, blue sea in the reel), never the sea's own colour
	const land = hueGap(rgbToHsl(hexToRgb(tagBg)).h, rgbToHsl(hexToRgb(sea)).h) > 40 ? tagBg : "#E2B84A";
	// the paper edge of a torn hole / scrap: the paper colour lifted towards white
	const edge = lift(base.paper, 0.55);
	return { paper: base.paper, ink: base.ink, accent, tagBg, tagInk: textOn(tagBg, "#111111"), sea, land, chips: base.chips, edge };
}

/** paper-texture's sheet colours per kind (its `PAPER` table, read 2026-10-20) — for picking the contrasting ground. */
const PAPER_KIND_BASE: Record<string, string> = { cream: "#F1EADB", old: "#E6D7B8", mustard: "#D6A23A", kraft: "#C49A6C", grid: "#F3EFE4", map: "#E6D7B8" };

/** How different two colours look (RGB distance, luma weighted double). */
function toneGap(a: Rgb, b: Rgb): number {
	const d = Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
	return d + 2 * 255 * Math.abs(luma(a) - luma(b));
}

/** Which paper-texture `kind` tints like the card's paper colour. */
export function paperKindOf(hex: string): string {
	const [r, g, b] = hexToRgb(hex);
	const { s, l } = rgbToHsl([r, g, b]);
	if (l > 0.8) return "cream";
	if (s > 0.45 && r > b) return "mustard";
	if (r > b && l < 0.55) return "kraft";
	return "old";
}

/** A torn paper scrap as an SVG data: URL (the compositions service takes data: images). Deterministic per seed. */
export function scrapSvg(color: string, seed: number, aspect = 1.4): string {
	let s = seed * 9301 + 49297;
	const rand = () => {
		s = (s * 9301 + 49297) % 233280;
		return s / 233280;
	};
	const w = 200;
	const h = Math.round(w / aspect);
	const points: string[] = [];
	const edge = (x0: number, y0: number, x1: number, y1: number, steps: number) => {
		for (let i = 0; i < steps; i++) {
			const k = i / steps;
			const jitter = (rand() - 0.5) * 9;
			const x = x0 + (x1 - x0) * k + (y0 === y1 ? 0 : jitter);
			const y = y0 + (y1 - y0) * k + (x0 === x1 ? 0 : jitter);
			points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
		}
	};
	edge(6, 6, w - 6, 6, 9);
	edge(w - 6, 6, w - 6, h - 6, 6);
	edge(w - 6, h - 6, 6, h - 6, 9);
	edge(6, h - 6, 6, 6, 6);
	const fibres = Array.from({ length: 5 }, () => {
		const y = 10 + rand() * (h - 20);
		return `<path d="M10 ${y.toFixed(1)} C ${(w * 0.3).toFixed(0)} ${(y + 4).toFixed(1)}, ${(w * 0.6).toFixed(0)} ${(y - 4).toFixed(1)}, ${w - 10} ${(y + 2).toFixed(1)}" stroke="#000" stroke-opacity="0.07" stroke-width="2" fill="none"/>`;
	}).join("");
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polygon points="${points.join(" ")}" fill="${color}"/>${fibres}</svg>`;
	return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const CLOSE_WORDS = new Set(["close", "closer", "detail", "inside", "zoom", "look", "just", "macro"]);

interface Special {
	map?: { place: number };
	timeline?: true;
	parallax?: { hero: PictureAsset };
	halftone?: { picture: PictureAsset };
	retro?: { clip: PictureAsset };
	torn?: true;
	number?: string;
	doodle?: true;
}

interface Shot {
	kind: ShotKind;
	main: "picture" | "paper";
	picture?: PictureAsset;
	punch?: boolean;
	variant?: number;
}

/**
 * The v2 plan. Same ExplainerPlan shape as v1 (ops@1 with composition placeholders, beats, report) plus shots, the
 * binding of every line, the pacing and the stills the compositions need.
 */
export function explainerPlanV2(card: StyleCard, answers: ExplainerAnswersV2 = {}, assets: readonly PictureAsset[] = [], options: ExplainerOptions = {}): ExplainerPlanV2 {
	const author: Author = options.author ?? "compiler";
	const start = Math.max(0, options.start ?? 0);
	const available = new Set(options.available ?? [...Object.keys(COLLAGE_COMPOSITIONS), ...KIT_PIECES]);
	const has = (name: string) => available.has(name);
	const feel = answers.feel ?? "playful";
	const motion = FEEL_MOTION[feel] ?? (FEEL_MOTION.playful as { ease: string; speed: number });
	const pace = FEEL_PACE[feel] ?? FEEL_PACE.playful;
	const colors = collageColorsV2(card);
	const fonts = fontsFor(answers.type);
	const cues = new Set(card.cues ?? []);
	const missing: string[] = [];
	const notes: string[] = [];
	const effects = new Set<string>();
	const ops: Op[] = [];
	const compositions: CompositionRequest[] = [];
	const fallbacks: Record<string, Op[]> = {};
	const stills = new Set<string>();

	const format = answers.format ?? (card.questions.find((q) => q.id === "format")?.suggested as ExplainerAnswersV2["format"]) ?? "9:16";
	const target = FORMATS[format] ?? (FORMATS["9:16"] as { width: number; height: number });
	const canvasChange = !options.canvas || options.canvas.width !== target.width || options.canvas.height !== target.height;
	const W = target.width;
	const H = target.height;
	const landscape = W > H;

	const footage = answers.footage ?? (assets.some((a) => a.kind !== "audio") ? "mine" : "none");
	const pictures: PictureAsset[] = footage === "none" ? [] : assets.filter((a) => a.kind === "image" || (footage === "mine" && a.kind === "video"));
	if (footage !== "none" && !pictures.length) notes.push("no pictures were picked: the explainer is paper and motion only");

	// 1. script → beats bound to pictures → lengths and shots
	const script = scriptOf(answers);
	notes.push(...script.notes);
	const binding = bindBeats(script.beats, pictures, answers);
	const lines = script.beats.map((beat) => beat.line);
	let timing = beatLengths(lines, feel, answers.length_s);
	const byId = new Map(pictures.map((p) => [p.id, p]));
	const picsOf = (beat: BoundBeat) => beat.pictures.map((m) => byId.get(m.id)).filter((p): p is PictureAsset => Boolean(p));
	const stillOf = (p: PictureAsset) => {
		stills.add(p.id);
		return `${STILL_PREFIX}${p.id}`;
	};
	for (const beat of binding) if (beat.unmatched) missing.push(`beat ${beat.index + 1} "${fit(beat.line, 48)}": ${beat.unmatched} — it is shown on paper, no picture`);

	// 2. which beat gets which collage piece (each piece where it fits the line, most of them once)
	const n = binding.length;
	const places = (answers.places ?? []).map((p) => p.trim()).filter(Boolean);
	const dates = (answers.dates ?? []).filter((d) => d.date.trim());
	const verdict = answers.verdict?.trim() ?? "";
	const lastLine = binding[n - 1]?.line ?? "";
	const stampText = verdict ? fit(upper(verdict), 16) : lastLine.length <= 16 && n >= 3 ? upper(lastLine) : "";
	const hasStamp = has("stamp") && n >= 2 && Boolean(stampText);
	if (n >= 2 && has("stamp") && !stampText) missing.push("stamp: no verdict answer and the last line is longer than 16 letters — no stamp (answers.verdict sets one)");
	const middle = binding.filter((beat) => beat.index > 0 && (!hasStamp || beat.index < n - 1)).map((beat) => beat.index);
	const specials = new Map<number, Special>(binding.map((beat) => [beat.index, {}]));
	const special = (i: number) => specials.get(i) as Special;
	const free = (i: number) => {
		const s = special(i);
		return !s.map && !s.timeline && !s.parallax && !s.halftone && !s.retro;
	};
	const mapCue = cues.has("map") || cues.has("globe") || cues.has("zoom") || places.length >= 2;
	if (has("map-route") && places.length >= 2 && mapCue) {
		// one map beat (a zoom in to the first place a line names); the title's zoom-out only when no beat has one
		const withPlace = middle.filter((i) => (binding[i] as BoundBeat).places.length > 0);
		const i = withPlace[0];
		if (i !== undefined) special(i).map = { place: Math.max(0, places.indexOf((binding[i] as BoundBeat).places[0] as string)) };
	}
	const titleMap = has("map-route") && places.length >= 2 && mapCue && n > 1 && !middle.some((i) => special(i).map);
	if (has("thread-timeline") && dates.length >= 2) {
		const ranked = [...middle].sort((a, b) => (binding[b] as BoundBeat).dates.length - (binding[a] as BoundBeat).dates.length || a - b);
		const pick = ranked.find((i) => (binding[i] as BoundBeat).dates.length > 0 && !special(i).map) ?? ranked.find((i) => free(i));
		if (pick !== undefined) special(pick).timeline = true;
	}
	const alphaPics = pictures.filter((p) => p.kind === "image" && p.alpha);
	if (has("parallax-strip") && alphaPics.length) {
		const pick = middle.find((i) => free(i) && picsOf(binding[i] as BoundBeat).some((p) => p.alpha && p.kind === "image"));
		if (pick !== undefined) special(pick).parallax = { hero: picsOf(binding[pick] as BoundBeat).find((p) => p.alpha && p.kind === "image") as PictureAsset };
	}
	if (has("retro-tv") && (cues.has("retro-tv") || feel === "nostalgic" || pictures.some((p) => p.kind === "video"))) {
		const pick = middle.find((i) => free(i) && picsOf(binding[i] as BoundBeat)[0]?.kind === "video") ?? (feel === "nostalgic" ? middle.find((i) => free(i) && picsOf(binding[i] as BoundBeat).length > 0) : undefined);
		if (pick !== undefined) special(pick).retro = { clip: picsOf(binding[pick] as BoundBeat)[0] as PictureAsset };
	}
	if (has("halftone-push") && cues.has("halftone")) {
		const stillPic = (i: number) => picsOf(binding[i] as BoundBeat).find((p) => p.kind === "image") ?? picsOf(binding[i] as BoundBeat)[0];
		const close = middle.find((i) => free(i) && stillPic(i) && words((binding[i] as BoundBeat).line).some((w) => CLOSE_WORDS.has(w)));
		const pick = close ?? [...middle].reverse().find((i) => free(i) && stillPic(i));
		if (pick !== undefined) special(pick).halftone = { picture: stillPic(pick) as PictureAsset };
	}
	if (has("cutout-outline") && cues.has("torn-hole")) {
		let used = 0;
		for (const i of middle) {
			if (used >= 2) break;
			// a torn hole needs a shot of its own before the photo it opens onto
			if ((timing.lengths[i] ?? 0) >= 2 * 0.6 * pace.shot && picsOf(binding[i] as BoundBeat).some((p) => p.kind === "image") && !special(i).halftone && !special(i).parallax) {
				special(i).torn = true;
				used++;
			}
		}
	}
	const number = answers.number?.trim() ?? "";
	if (number && has("paper-cut")) {
		// not on the stamp beat: the stamp has the STAMPS track there
		const at = binding.findIndex((beat) => beat.index > 0 && !(hasStamp && beat.index === n - 1) && words(beat.line).includes(words(number)[0] ?? number.toLowerCase()));
		if (at > 0) {
			// the number and the word after it ("18 hours" → "18 HOURS") when that fits the 10 tiles
			const after = new RegExp(`${number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+([A-Za-z]+)`, "i").exec((binding[at] as BoundBeat).line)?.[1] ?? "";
			const tiles = after && `${number} ${after}`.length <= 10 ? `${number} ${after}` : number;
			special(at).number = fit(upper(tiles), 10);
		} else missing.push(`number "${number}": no line says it, so no number tiles (write it into the line it belongs to)`);
	}
	if (feel === "playful" && has("doodle-boil")) {
		// one overlay per beat on the STAMPS track: not where the number tiles are
		const pick = middle.find((i) => picsOf(binding[i] as BoundBeat).length > 0 && !special(i).retro && !special(i).number);
		if (pick !== undefined) special(pick).doodle = true;
	}
	// beats carrying collage pieces get a shot for each (the photo + the piece), when their length allows
	const minShots = binding.map((beat) => {
		const s = special(beat.index);
		// a torn hole takes two shots (the hole, then the photo it opens onto): live run 2 lost beat 3's timeline to it
		const pieces = [s.map, s.timeline, s.parallax, s.halftone, s.retro, s.torn].filter(Boolean).length + (s.torn ? 1 : 0);
		return Math.min(4, 1 + pieces + (beat.index === 0 && titleMap ? 1 : 0));
	});
	timing = beatLengths(lines, feel, answers.length_s, minShots, binding.filter((beat) => special(beat.index).torn).length);
	notes.push(...timing.notes);

	// 3. tracks (each add_track index 0 goes on top: added bottom → top; the server puts PAPER above STAMPS)
	if (options.applyPreset !== false) ops.push({ op: "apply_style", author, preset_id: PAPER_COLLAGE_STYLE_ID });
	ops.push(canvasChange ? { op: "set_canvas", author, w: W, h: H, background: colors.paper } : { op: "set_canvas", author, background: colors.paper });
	const tracksAt = ops.length;

	// shared pieces: the paper ground under paper shots, two scrap layers
	const paperShotMax = Math.max(2, ...timing.lengths.map((len, i) => len / (timing.shots[i] ?? 1)));
	const groundDur = clamp(Math.ceil(paperShotMax * 2) / 2, 2, 4);
	const half = (v: number) => Math.max(2, Math.round(v / 4) * 2);
	const grain = card.texture.label;
	// two paper grounds: the card's paper and a contrasting sheet (mustard, or cream under a dark paper). Each paper
	// shot takes the one that differs most from the shot before it, so the cut is visible (live run 1: a cream clip →
	// cream paper scored < 0.3 and ffmpeg saw no cut)
	const kindA = paperKindOf(colors.paper);
	const kindB = kindA === "mustard" || kindA === "kraft" ? "cream" : "mustard";
	const makeGround = (key: string, kind: string): CompositionRequest => ({
		key,
		name: "paper-texture",
		title: kind === kindA ? "Paper ground" : `Paper ground (${kind})`,
		props: { mode: "background", kind, amount: grain.startsWith("heavy") ? 0.8 : grain.startsWith("clean") ? 0.45 : 0.65, vignette: 0.35, flickerFps: 4, folds: false, seed: 9, fade: false, speed: 1 },
		at: start,
		dur: groundDur,
		placeholder: `${COMPOSITION_PLACEHOLDER_PREFIX}${key}`,
		beat: 0,
		size: { width: half(W), height: half(H) },
	});
	const grounds = has("paper-texture") ? [makeGround("paper-ground", kindA), makeGround("paper-ground-b", kindB)] : [];
	const groundTone = (request: CompositionRequest): Rgb => hexToRgb(PAPER_KIND_BASE[String(request.props.kind)] ?? colors.paper);
	compositions.push(...grounds);
	if (!grounds.length) missing.push("paper-texture: not in the library — paper shots show the canvas colour");
	const scrapColors = [colors.accent, colors.tagBg, colors.sea, colors.edge, colors.land];
	const scrapRequests: CompositionRequest[] = [];
	if (has("cutout-outline")) {
		for (const [v, seed] of [
			[0, 31],
			[1, 57],
		] as Array<[number, number]>) {
			// scraps sit around the edges (the middle is for the pictures), drifting at different depths
			const spots = landscape
				? [
						[0.1, 0.18, -12],
						[0.88, 0.16, 9],
						[0.08, 0.78, 7],
						[0.9, 0.8, -8],
						[0.5, 0.08, 4],
					]
				: [
						[0.15, 0.1, -12],
						[0.85, 0.14, 9],
						[0.12, 0.88, 7],
						[0.86, 0.9, -8],
						[0.5, 0.05, 4],
					];
			const pieces = spots.map(([x, y, rotate], i) => ({
				image: scrapSvg(scrapColors[(i + v) % scrapColors.length] as string, seed + i, i % 2 ? 1.1 : 1.7),
				x: round3((x as number) + (v ? 0.03 : 0)),
				y: round3(y as number),
				width: round3((landscape ? 0.11 : 0.18) + (i % 3) * 0.025),
				rotate: (rotate as number) * (v ? -1 : 1),
				at: round3(0.04 * i),
				from: "pop",
				depth: round3(0.2 + 0.18 * i),
			}));
			const request: CompositionRequest = {
				key: `scraps-${v ? "b" : "a"}`,
				name: "cutout-outline",
				title: "Paper scraps",
				props: { pieces, outline: colors.edge, outlineWidth: 5, tear: 0.7, shadow: 0.3, drift: 3, seed, speed: motion.speed, ease: motion.ease, exit: false, drawSubject: true, matte: [], matteFps: 30 },
				at: start,
				dur: groundDur,
				placeholder: `${COMPOSITION_PLACEHOLDER_PREFIX}scraps-${v ? "b" : "a"}`,
				beat: 0,
			};
			compositions.push(request);
			scrapRequests.push(request);
		}
		effects.add("FX-52 drifting paper scraps for depth (cutout-outline)");
	}

	// text styles (as v1: a serif line on a paper label, mono caps tags — the reel's yellow tags)
	const lineStyle = { font: fonts.line, italic: fonts.italic, size: 5.2, color: textOn(colors.paper, colors.ink), bg: true, bg_color: colors.paper, bg_radius: 0, bg_padding_x: 22, bg_padding_y: 10, align: "center" as const, y: Math.round(H * 0.3) };
	const tagStyle = { font: fonts.tag, size: 3, weight: "bold" as const, color: colors.tagInk, bg: true, bg_color: colors.tagBg, bg_radius: 0, bg_padding_x: 18, bg_padding_y: 8, uppercase: true, align: "center" as const, y: -Math.round(H * 0.36) };
	if (fonts.missing) missing.push(fonts.missing);

	// 4. shots
	const beats: ExplainerBeat[] = [];
	const shots: ShotPlan[] = [];
	let cursor = start;
	let lastMain: "picture" | "paper" | null = null;
	let lastPicture: string | null = null;
	const usedIn = new Map<string, number>();
	/** What the last shot looked like overall (its picture's tone, its ground, an opaque piece's colour). */
	let prevTone: Rgb | null = null;
	let groundN = 0;
	let scrapN = 0;
	let shotN = 0;
	const title = answers.title?.trim() || binding[0]?.line || answers.topic?.trim() || "How the farm-to-bottle route works";
	const tiles = fit(upper(title.length <= 10 ? title : titleWord(title)), 10);
	const route = places.length >= 2 ? fit(`${upper(places[0] as string)} → ${upper(places[places.length - 1] as string)}`, TAG_MAX) : (binding[0]?.tag ?? "");

	const addPiece = (track: string, key: string, name: string, title: string, props: Record<string, unknown>, at: number, dur: number, beat: number, extra: Partial<CompositionRequest> = {}): string => {
		const placeholder = `${COMPOSITION_PLACEHOLDER_PREFIX}${key}`;
		compositions.push({ key, name, title, props, at: round3(at), dur: round3(dur), placeholder, beat, ...extra });
		ops.push({ op: "insert", author, track, t: round3(at), media: placeholder, media_kind: "video", dur: round3(dur), name: title, ref: `explainer-${key}` });
		return key;
	};
	/** A shared piece (paper ground, scraps) over [at, at + dur): as many clips of its render as it takes. */
	const placeShared = (request: CompositionRequest, track: string, at: number, dur: number, counter: () => number, fallback?: (t: number, d: number) => Op[]) => {
		let t = at;
		while (at + dur - t > 0.04) {
			const d = round3(Math.min(request.dur, at + dur - t));
			const n = counter();
			const ref = n === 0 ? `explainer-${request.key}` : `explainer-${request.key}-loop${n}`;
			ops.push({ op: "insert", author, track, t: round3(t), media: request.placeholder, media_kind: "video", dur: d, name: request.title, ref });
			if (fallback) fallbacks[ref] = fallback(round3(t), d);
			t += d;
		}
	};
	/** The picture on the main track over [at, at + dur) (a clip continues where it left off; a still gets a slow push). */
	const mainPicture = (p: PictureAsset, at: number, dur: number, punch: boolean, push = true, place?: { track: string; params: Record<string, number> }): Op[] => {
		const out: Op[] = [];
		const ref = `explainer-shot-${++shotN}`;
		const scale = punch ? 1.3 : 1;
		const params = place?.params ?? (punch ? { "transform.scaleX": scale, "transform.scaleY": scale } : undefined);
		const track = place?.track ?? "main";
		if (p.kind === "video" && p.duration && p.duration > 0.2) {
			let t = at;
			let guard = 0;
			while (at + dur - t > 0.04 && guard++ < 20) {
				const used = usedIn.get(p.id) ?? 0;
				const from = used + 0.2 < p.duration ? used : 0;
				const take = Math.min(at + dur - t, p.duration - from);
				// in/out from the rounded timeline span, so the clip ends exactly where the next one starts
				const t0 = round3(t);
				const t1 = round3(t + take);
				const inPoint = round3(from);
				out.push({ op: "insert", author, track, t: t0, media: p.id, media_kind: "video", in: inPoint, out: round3(inPoint + (t1 - t0)), name: p.name || "clip", ...(params ? { params } : {}), ...(t === at ? { ref } : {}) });
				usedIn.set(p.id, from + take);
				t += take;
			}
		} else {
			out.push({ op: "insert", author, track, t: round3(at), media: p.id, media_kind: p.kind === "video" ? "video" : "image", dur: round3(dur), name: p.name || "still", ...(params ? { params } : {}), ref });
			if (push && p.kind === "image") {
				out.push({ op: "keyframe", author, el: ref, prop: "scale", t: 0, value: scale, local: true });
				out.push({ op: "keyframe", author, el: ref, prop: "scale", t: round3(dur), value: round3(scale * (punch ? 1.05 : 1.07)), ease: "ease_in_out", local: true });
			}
		}
		return out;
	};
	/** How a shot looks overall when known before it is placed (null = a paper shot whose ground is not picked yet). */
	const toneOfShot = (s: Shot | undefined): Rgb | null => {
		if (!s) return null;
		if (s.kind === "photo") return s.picture?.tone ?? null;
		if (s.kind === "retro") return hexToRgb(colors.tagBg);
		if (s.kind === "title") return hexToRgb(PAPER_KIND_BASE.grid as string);
		if (s.kind === "map") return hexToRgb(colors.sea);
		if (s.kind === "halftone") return hexToRgb(colors.paper);
		return null;
	};
	/** The paper ground on the main track: the sheet that differs most from the shots on either side (visible cuts):
	 * the one whose smaller gap to the shot before / after is larger. */
	const groundAt = (beat: BoundBeat, at: number, dur: number, nextTone: Rgb | null = null) => {
		const near = [prevTone, nextTone].filter((tone): tone is Rgb => tone !== null);
		const score = (request: CompositionRequest) => (near.length ? Math.min(...near.map((tone) => toneGap(groundTone(request), tone))) : 0);
		const ground = near.length ? [...grounds].sort((a, b) => score(b) - score(a))[0] : grounds[0];
		if (ground) {
			const lead = picsOf(beat)[0] ?? (lastPicture ? byId.get(lastPicture) : undefined) ?? pictures[0];
			placeShared(
				ground,
				"main",
				at,
				dur,
				() => groundN++,
				lead ? (t, d) => mainPicture(lead, t, d, false, false) : undefined,
			);
			prevTone = groundTone(ground);
		} else if (pictures[0]) ops.push(...mainPicture(picsOf(beat)[0] ?? (pictures[0] as PictureAsset), at, dur, false));
	};
	const scrapsAt = (at: number, dur: number) => {
		const request = scrapRequests[scrapN % Math.max(1, scrapRequests.length)];
		if (!request) return;
		const counter = (() => {
			let k = 0;
			return () => scrapN * 10 + k++;
		})();
		placeShared(request, "explainer-scraps", at, dur, counter);
		scrapN++;
	};
	/** Cut-out pieces for 1–3 pictures, laid out for the canvas (portrait pictures narrower). */
	const cutoutPieces = (pics: PictureAsset[], variant: number) => {
		const layouts = landscape
			? [
					[[0.5, 0.47, 0.44, -3, "left"]],
					[
						[0.33, 0.45, 0.36, -5, "left"],
						[0.68, 0.54, 0.34, 4, "right"],
					],
					[
						[0.25, 0.42, 0.3, -6, "left"],
						[0.6, 0.36, 0.28, 5, "top"],
						[0.62, 0.7, 0.26, -3, "bottom"],
					],
				]
			: [
					[[0.5, 0.44, 0.7, -3, "left"]],
					[
						[0.4, 0.34, 0.6, -5, "left"],
						[0.6, 0.6, 0.56, 4, "right"],
					],
					[
						[0.36, 0.28, 0.52, -6, "left"],
						[0.64, 0.48, 0.5, 5, "right"],
						[0.42, 0.7, 0.5, -3, "bottom"],
					],
				];
		const layout = layouts[Math.min(pics.length, 3) - 1] as Array<[number, number, number, number, string]>;
		return pics.slice(0, 3).map((p, i) => {
			const [x, y, width, rotate, from] = layout[i] as [number, number, number, number, string];
			return { image: stillOf(p), x: round3(variant % 2 ? 1 - x : x), y, width: pieceWidth(p, width, 0.62), rotate: variant % 2 ? -rotate : rotate, at: round3(0.05 + 0.15 * i), from: variant % 2 && (from === "left" || from === "right") ? (from === "left" ? "right" : "left") : from, depth: round3(0.45 + 0.2 * i) };
		});
	};
	/** A piece's width (fraction of the frame width) so a tall picture stays at most `maxH` of the frame height. */
	const pieceWidth = (p: PictureAsset, width: number, maxH: number) => {
		const aspect = (p.width ?? 16) / (p.height ?? 9);
		return round3(Math.min(width, maxH * (H / W) * aspect));
	};

	binding.forEach((beat, bi) => {
		const length = timing.lengths[bi] as number;
		const count = timing.shots[bi] as number;
		const from = cursor;
		const sp = special(bi);
		const pics = picsOf(beat);
		const isTitle = bi === 0 && n > 1;
		const isStamp = hasStamp && bi === n - 1;
		// the queues: photos (main = picture) and paper shots (main = paper ground)
		// a picture with a transparent background (a bottle cut-out) is not put full frame on the main track (it would show
		// the canvas through it): it is a HERO cut-out on a contrasting paper ground
		const photos: Shot[] = pics.map((p): Shot => (p.kind === "image" && p.alpha && has("cutout-outline") ? { kind: "hero", main: "paper", picture: p } : { kind: "photo", main: "picture", picture: p }));
		// the retro TV plays the beat's clip: it IS the beat's photo shot (first), the plain clip can follow
		if (sp.retro) photos.unshift({ kind: "retro", main: "picture", picture: sp.retro.clip });
		const papers: Shot[] = [];
		if (isTitle) {
			if (has("paper-cut")) papers.push({ kind: "title", main: "paper" });
			if (titleMap) papers.push({ kind: "map", main: "paper" });
		}
		if (sp.map) papers.push({ kind: "map", main: "paper" });
		if (sp.timeline) papers.push({ kind: "timeline", main: "paper" });
		if (sp.parallax) papers.push({ kind: "parallax", main: "paper", picture: sp.parallax.hero });
		if (sp.halftone) papers.push({ kind: "halftone", main: "paper", picture: sp.halftone.picture });
		// a torn hole needs its own shot plus the photo it opens onto: first in line when the beat has 3+ shots
		if (sp.torn && count >= 3) {
			const into = [...pics].reverse().find((p) => p.kind === "image");
			if (into) papers.unshift({ kind: "torn", main: "paper", picture: into });
		}
		if (pics.length && has("cutout-outline")) papers.push({ kind: "cutouts", main: "paper" });
		if (!pics.length) papers.push({ kind: "paper", main: "paper" });
		// the verdict lands on the cut-outs: on the stamp beat they are kept for its last shot
		const stampFinal = isStamp && papers.some((s) => s.kind === "cutouts") ? (papers.splice(papers.findIndex((s) => s.kind === "cutouts"), 1)[0] as Shot) : null;

		const chosen: Shot[] = [];
		let forced: Shot | null = null;
		let variant = 0;
		for (let k = 0; k < count; k++) {
			let shot: Shot | undefined;
			if (k === 0 && isTitle && papers[0]?.kind === "title") shot = papers.shift();
			else if (stampFinal && k === count - 1) shot = stampFinal;
			else if (forced) {
				shot = forced;
				forced = null;
			} else {
				// main track alternates photo ↔ paper so every shot boundary is a hard cut; never the same picture in two
				// photo shots in a row (no visible cut) — after a paper shot the same picture is a cut again
				const want = lastMain === "paper" ? "picture" : "paper";
				const prevPhoto = lastMain === "picture" ? lastPicture : null;
				const fresh = (s: Shot) => s.main === "paper" || s.kind === "retro" || s.picture?.id !== prevPhoto;
				const take = (queue: Shot[], ok: (s: Shot) => boolean) => {
					const index = queue.findIndex(ok);
					return index >= 0 ? queue.splice(index, 1)[0] : undefined;
				};
				// a torn hole opens onto the next shot's photo: never on the beat's last shot
				const paperOk = (s: Shot) => fresh(s) && !(s.kind === "torn" && k === count - 1);
				if (want === "picture") {
					shot = take(photos, fresh);
					// out of photos: a punch-in on a full-frame picture (never a cut-out PNG: that is a hero, below) …
					const framed = pics.filter((q) => !(q.kind === "image" && q.alpha));
					if (!shot && framed.length) {
						variant++;
						const p = framed.find((q) => q.id !== prevPhoto) ?? (framed[variant % framed.length] as PictureAsset);
						shot = { kind: "photo", main: "picture", picture: p, punch: true };
					}
					// … else the beat's next collage piece, else its cut-out picture again as a hero
					if (!shot) shot = take(papers, paperOk);
					if (!shot && pics.length) {
						variant++;
						shot = { kind: "hero", main: "paper", picture: pics[variant % pics.length] as PictureAsset, variant };
					}
				} else {
					shot = take(papers, paperOk);
					// a hero cut-out (paper ground) before repeating the cut-outs
					if (!shot) shot = take(photos, (s) => s.main === "paper");
					if (!shot && pics.length && has("cutout-outline")) {
						variant++;
						shot = { kind: "cutouts", main: "paper", variant };
					}
					if (!shot) shot = take(photos, fresh);
				}
				if (!shot) {
					variant++;
					shot = { kind: "paper", main: "paper", variant };
				}
			}
			if (shot?.kind === "torn" && shot.picture && k < count - 1) forced = { kind: "photo", main: "picture", picture: shot.picture };
			else if (shot?.kind === "torn") shot = { kind: "cutouts", main: "paper", variant: 1 };
			chosen.push(shot as Shot);
			lastMain = (shot as Shot).main;
			lastPicture = (shot as Shot).main === "picture" ? ((shot as Shot).picture?.id ?? null) : lastPicture;
		}

		// a collage piece that found no shot is said, not dropped silently
		const unplaced = papers.filter((s) => ["map", "timeline", "parallax", "halftone"].includes(s.kind)).map((s) => s.kind);
		if (photos.some((s) => s.kind === "retro")) unplaced.push("retro");
		if (unplaced.length) notes.push(`beat ${bi + 1}: no shot left for ${unplaced.join(", ")} (${count} shots in ${Math.round(length * 10) / 10} s) — a longer length_s gives it one`);

		// place them
		const shotDur = length / count;
		const beatEffects = new Set<string>();
		// number tiles / doodles ride on the beat's first photo shot, else on its first see-through shot
		const overlayShot = chosen.find((s) => s.kind === "photo") ?? chosen.find((s) => s.kind === "cutouts" || s.kind === "paper" || s.kind === "timeline" || s.kind === "parallax") ?? chosen[0];
		chosen.forEach((shot, k) => {
			// boundaries are rounded once and each shot ends exactly where the next starts (separately rounded starts and
			// lengths overlapped by 1 ms on the main track: reducer conflict, 2026-10-20)
			const at = round3(from + k * shotDur);
			const next = round3(k === count - 1 ? from + length : from + (k + 1) * shotDur);
			const dur = round3(next - at);
			const keyBase = `b${bi + 1}s${k + 1}`;
			const plan: ShotPlan = { beat: bi, index: k, t: at, dur, kind: shot.kind, main: shot.main, ...(shot.picture ? { picture: shot.picture.id } : {}), pieces: [], overlays: [] };
			const nextTone = toneOfShot(chosen[k + 1]);
			if (shot.kind === "retro" && shot.picture) {
				// the TV plays its clip in the screen only: a contrasting ground on the main track, the clip under the TV
				// sized to its screen (live run 2: the clip full frame under the TV's fade-in made no visible cut)
				groundAt(beat, at, dur, nextTone);
				ops.push(...mainPicture(shot.picture, at, dur, false, false, { track: "explainer-scraps", params: { "transform.scaleX": 0.53, "transform.scaleY": 0.53, "transform.positionY": -Math.round(H * 0.08) } }));
			} else if (shot.main === "picture" && shot.picture) {
				ops.push(...mainPicture(shot.picture, at, dur, Boolean(shot.punch)));
				prevTone = shot.picture.tone ?? null;
			} else {
				groundAt(beat, at, dur, nextTone);
				if (shot.kind !== "halftone" && shot.kind !== "map" && shot.kind !== "title") scrapsAt(at, dur);
			}
			// what the shot looks like overall, for the next ground's contrast: opaque pieces cover the ground
			if (shot.kind === "title") prevTone = hexToRgb(PAPER_KIND_BASE.grid as string);
			else if (shot.kind === "map") prevTone = hexToRgb(colors.sea);
			else if (shot.kind === "halftone") prevTone = hexToRgb(colors.paper);
			else if (shot.kind === "retro") prevTone = hexToRgb(colors.tagBg);
			// pieces never animate out (exit: false): the next shot's hard cut is their exit (live run 2: the TV's 0.4 s exit
			// spread the cut over frames and ffmpeg saw no cut)
			const base = { speed: motion.speed, seed: 7 + bi * 13 + k };
			switch (shot.kind) {
				case "title": {
					plan.pieces.push(addPiece("explainer-motion", `${keyBase}-paper-cut`, "paper-cut", "Paper cut title", { text: tiles, tag: route, note: "", layout: "full", paper: colors.paper, ink: colors.accent, accent: colors.tagBg, tileStagger: 0.08, scale: 1, anchor: "center", offsetY: 0, ease: motion.ease, exit: false, layer: "all", ...base }, at, dur, bi));
					beatEffects.add("FX-13/FX-60 paper title + letter tiles (paper-cut)");
					break;
				}
				case "map": {
					const stops = places.slice(0, 5).map((name, i, all) => ({ name: fit(upper(name), 24), x: round3(0.18 + (0.64 * i) / Math.max(1, all.length - 1)), y: i % 2 === 0 ? 0.66 : 0.4 }));
					const focus = isTitle ? 0 : (sp.map?.place ?? 0);
					// title "": the beat's tag is on the TAGS track already (live run 1: the map's own title sat over a pin)
					const key = addPiece("explainer-motion", `${keyBase}-map-route`, "map-route", "Map route", { places: stops, title: "", layout: "full", land: colors.land, sea: colors.sea, route: colors.accent, accent: colors.tagBg, scale: 1, anchor: "center", offsetY: 0, ease: motion.ease, exit: false, ...base }, at, dur, bi);
					// zoom toward the place (the title's map zooms OUT from the first stop: a globe-to-route reveal)
					const stop = stops[focus] ?? stops[0];
					const s1 = 1.4;
					const dx = stop ? clamp(-(stop.x - 0.5) * W * s1, -(s1 - 1) * W * 0.5, (s1 - 1) * W * 0.5) : 0;
					const dy = stop ? clamp(-(stop.y - 0.5) * H * s1, -(s1 - 1) * H * 0.5, (s1 - 1) * H * 0.5) : 0;
					const [a, b] = isTitle ? [1, 0] : [0, 1];
					const keys: Array<[string, number, number]> = [
						["scale", 1, s1],
						["x", 0, round3(dx)],
						["y", 0, round3(dy)],
					];
					for (const [prop, v0, v1] of keys) {
						ops.push({ op: "keyframe", author, el: `explainer-${key}`, prop, t: 0, value: a ? v1 : v0, local: true });
						ops.push({ op: "keyframe", author, el: `explainer-${key}`, prop, t: dur, value: b ? v1 : v0, ease: "ease_in_out", local: true });
					}
					plan.pieces.push(key);
					beatEffects.add(isTitle ? "FX-54 map route, zoom out from the first stop (map-route + keyframes)" : "FX-54 map route, zoom in to the place (map-route + keyframes)");
					break;
				}
				case "timeline": {
					const items = dates.slice(0, 4).map((d) => ({ date: fit(d.date, 14), text: fit(d.text, 40) }));
					plan.pieces.push(addPiece("explainer-motion", `${keyBase}-thread-timeline`, "thread-timeline", "Thread timeline", { items, legend: "", thread: colors.accent, paper: colors.paper, accent: colors.tagBg, scale: 1.15, anchor: "center", offsetY: 0, exit: false, ...base }, at, dur, bi));
					beatEffects.add("FX-58 thread timeline (thread-timeline)");
					break;
				}
				case "parallax": {
					const hero = shot.picture as PictureAsset;
					// caption / key "": the line and the tag are on TEXT / TAGS (live run 1: the caption sat under the tag)
					plan.pieces.push(addPiece("explainer-motion", `${keyBase}-parallax-strip`, "parallax-strip", "Parallax strip", { hero: stillOf(hero), heroSize: 0.62, band: { top: 0.3, bottom: 0.8 }, paper: colors.paper, skyline: colors.ink, accent: colors.accent, caption: "", key: "", scroll: feel === "punchy" ? 0.8 : 0.5, outline: true, exit: false, ...base }, at, dur, bi));
					beatEffects.add("FX-61 parallax strip with the beat's cut-out (parallax-strip)");
					break;
				}
				case "halftone": {
					plan.pieces.push(addPiece("explainer-motion", `${keyBase}-halftone-push`, "halftone-push", "Halftone push-in", { image: stillOf(shot.picture as PictureAsset), focus: { x: 0.5, y: 0.45, r: 0.02 }, zoom: 1.8, cell: 5, angle: 45, contrast: 1.5, paper: colors.paper, ink: colors.ink, match: "none", label: "", accent: colors.accent, push: round3(Math.max(0.6, dur - 0.2)), speed: 1 }, at, dur, bi));
					beatEffects.add("FX-56 halftone push-in of the beat's picture (halftone-push)");
					break;
				}
				case "retro": {
					// retro-tv has no seed param; the wall in the tag colour (the reel: a wooden TV on mustard paper) — a visible
					// cut from paper; label "" (the tag is on TAGS)
					plan.pieces.push(addPiece("explainer-motion", `${keyBase}-retro-tv`, "retro-tv", "Retro TV", { label: "", chips: colors.chips, wall: colors.tagBg, pattern: "dots", accent: colors.tagBg, scanlines: true, screenY: 0.42, scale: 1, ease: motion.ease, exit: false, speed: motion.speed }, at, dur, bi));
					beatEffects.add("FX-55 retro TV playing the beat's clip (retro-tv)");
					break;
				}
				case "cutouts": {
					const set = pics.length ? pics : [];
					if (set.length) {
						plan.pieces.push(addPiece("explainer-motion", `${keyBase}-cutout-outline`, "cutout-outline", "Cut-outs with outline", { pieces: cutoutPieces(set, (shot.variant ?? 0) + bi), outline: colors.accent, outlineWidth: 26, tear: 0.2, shadow: 0.45, drift: 1.5, drawSubject: true, matte: [], matteFps: 30, ease: motion.ease, exit: false, ...base }, at, dur, bi));
						beatEffects.add("FX-52 photo cut-outs, thick accent outline + shadow (cutout-outline)");
					}
					break;
				}
				case "hero": {
					// the cut-out picture big and centred, thick accent outline, on the contrasting ground
					const p = shot.picture as PictureAsset;
					plan.pieces.push(addPiece("explainer-motion", `${keyBase}-hero`, "cutout-outline", "Hero cut-out", { pieces: [{ image: stillOf(p), x: variant % 2 ? 0.56 : 0.44, y: 0.47, width: pieceWidth(p, landscape ? 0.5 : 0.8, 0.8), rotate: variant % 2 ? 3 : -3, at: 0.05, from: "bottom", depth: 0.6 }], outline: colors.accent, outlineWidth: 26, tear: 0.15, shadow: 0.5, drift: 1.2, drawSubject: true, matte: [], matteFps: 30, ease: motion.ease, exit: false, ...base }, at, dur, bi));
					beatEffects.add("FX-52 hero cut-out, thick accent outline + shadow (cutout-outline)");
					break;
				}
				case "torn": {
					const key = addPiece("explainer-motion", `${keyBase}-torn-hole`, "cutout-outline", "Torn-hole push", { pieces: [{ image: stillOf(shot.picture as PictureAsset), x: 0.5, y: 0.5, width: landscape ? 0.34 : 0.5, rotate: -2, at: 0, from: "pop", depth: 0 }], outline: colors.edge, outlineWidth: 30, tear: 1, shadow: 0.6, drift: 0, drawSubject: true, matte: [], matteFps: 30, ease: "snappy", exit: false, speed: 1, seed: base.seed }, at, dur, bi);
					ops.push({ op: "keyframe", author, el: `explainer-${key}`, prop: "scale", t: 0, value: 1, local: true });
					ops.push({ op: "keyframe", author, el: `explainer-${key}`, prop: "scale", t: dur, value: 3.4, ease: "ease_in", local: true });
					plan.pieces.push(key);
					beatEffects.add("torn-hole push into the next photo (cutout-outline torn edge + scale keys)");
					break;
				}
				default:
					break;
			}
			// overlays: number tiles, doodles (playful)
			if (shot === overlayShot) {
				if (sp.number) {
					plan.overlays.push(addPiece("explainer-stamps", `${keyBase}-number-tiles`, "paper-cut", "Number tiles", { text: sp.number, tag: "", note: "", layout: "card", paper: colors.paper, ink: colors.accent, accent: colors.tagBg, tileStagger: 0.08, scale: 0.85, anchor: "top", offsetY: 0, ease: motion.ease, exit: false, layer: "all", ...base }, at, dur, bi));
					beatEffects.add("FX-60 number in letter tiles (paper-cut)");
				}
				if (sp.doodle) {
					plan.overlays.push(addPiece("explainer-stamps", `${keyBase}-doodle-boil`, "doodle-boil", "Doodle boil", { word: "", color: "#FFFFFF", accent: colors.tagBg, exit: false, ...base }, at, dur, bi));
					beatEffects.add("FX-14 doodle boil (doodle-boil)");
				}
			}
			shots.push(plan);
		});
		if (isStamp) {
			const dur = round3(Math.min(length, 2.5));
			const at = round3(from + length - dur);
			const last = shots[shots.length - 1] as ShotPlan;
			last.overlays.push(addPiece("explainer-stamps", `b${bi + 1}-stamp`, "stamp", "Rubber stamp", { text: stampText, sub: route, color: colors.accent, rotate: -8, scale: 1, anchor: "center", offsetY: 0, ease: motion.ease, exit: false, speed: motion.speed, seed: 4 }, at, dur, bi));
			beatEffects.add("FX-26 rubber stamp (stamp)");
		}

		// the line and its tag
		ops.push({ op: "text_pop", author, t: round3(from + 0.15), text: fit(beat.line, 90), dur: round3(Math.max(0.6, length - 0.3)), track: "explainer-text", style: lineStyle });
		if (beat.tag && !isTitle) {
			ops.push({ op: "text_pop", author, t: round3(from + 0.1), text: beat.tag, dur: round3(Math.max(0.6, length - 0.2)), track: "explainer-tags", style: tagStyle });
			beatEffects.add("FX-59 label tag");
		}
		for (const effect of beatEffects) effects.add(effect);
		const kinds = chosen.map((s) => s.kind);
		beats.push({
			index: bi,
			kind: isTitle ? "title" : isStamp ? "stamp" : kinds.includes("map") ? "map" : kinds.includes("timeline") ? "timeline" : kinds.includes("retro") ? "retro" : pics.length ? "cutouts" : "footage",
			start: round3(from),
			end: round3(from + length),
			line: beat.line,
			visual: `${pics.length ? pics.map((p) => p.name).join(" + ") : "paper (no picture matches)"} — ${kinds.join(", ")}`,
			effects: [...beatEffects],
		});
		cursor = from + length;
	});

	// 5. tracks, bottom → top (each index 0 lands on top): SCRAPS, MOTION, STAMPS, TAGS, TEXT
	const uses = (ref: string) => ops.some((op) => (op as { track?: unknown }).track === ref);
	const trackOps: Op[] = [];
	if (uses("explainer-scraps")) trackOps.push({ op: "add_track", author, kind: "video", name: "SCRAPS", index: 0, ref: "explainer-scraps" });
	if (uses("explainer-motion")) trackOps.push({ op: "add_track", author, kind: "video", name: "MOTION", index: 0, ref: "explainer-motion" });
	if (uses("explainer-stamps")) trackOps.push({ op: "add_track", author, kind: "video", name: "STAMPS", index: 0, ref: "explainer-stamps" });
	if (uses("explainer-tags")) trackOps.push({ op: "add_track", author, kind: "text", name: "TAGS", index: 0, ref: "explainer-tags" });
	if (uses("explainer-text")) trackOps.push({ op: "add_track", author, kind: "text", name: "TEXT", index: 0, ref: "explainer-text" });
	ops.splice(tracksAt, 0, ...trackOps);
	// shared pieces nobody placed are not rendered
	const placed = new Set(ops.filter((op) => op.op === "insert").map((op) => (op as { media?: string }).media));
	const kept = compositions.filter((request) => placed.has(request.placeholder));

	// 6. what the kit cannot do yet, said plainly
	if (cues.has("globe")) missing.push("globe: the references show a globe; the library has no globe piece — the title's map zoom (map-route + scale keys) stands in");
	if (cues.has("torn-hole")) missing.push("torn-hole: no torn-hole piece in the library — built from cutout-outline (torn paper edge) + a scale push");
	if (!alphaPics.length && has("parallax-strip")) notes.push("parallax strip skipped: it needs a picture with a transparent background (a cut-out PNG) for its hero");
	notes.push("no voice-over yet, so no captions: add a VO (one take per beat; beats are timed for ~2.6 words/s), then auto-captions");
	notes.push("no music or SFX: use Design the sound after building (every shot boundary is a cut to hit)");

	const shotCount = shots.length;
	const total = round3(cursor - start);
	// cuts a viewer sees: every shot boundary except a torn hole pushing into its own photo (a transition)
	const seamless = shots.filter((shot, i) => shot.kind === "torn" && shots[i + 1]?.picture === shot.picture && shots[i + 1]?.kind === "photo").length;
	const planned = total > 0 ? Math.round(((shotCount - 1 - seamless) / total) * 100) / 10 : 0;
	return {
		planVersion: 2,
		ops,
		compositions: kept,
		beats,
		duration: total,
		canvas: canvasChange ? { width: W, height: H } : null,
		report: { missing, notes, effects: [...effects] },
		fallbacks,
		shots,
		binding,
		script: { source: script.source, lines: script.beats.length },
		pacing: { feel, shot_s: pace.shot, target_cuts_per_10s: pace.cuts, planned_cuts_per_10s: planned, length_s: total, reading_s: timing.readingS, asked_length_s: answers.length_s ?? null },
		stills: [...stills],
	};
}

/** Every `still:<id>` string inside a value replaced by `resolve(id)` (null = left as it was, reported by the caller). */
export function resolveStills(value: unknown, resolve: (id: string) => string | null): { value: unknown; unresolved: string[] } {
	const unresolved: string[] = [];
	const walk = (v: unknown): unknown => {
		if (typeof v === "string" && v.startsWith(STILL_PREFIX)) {
			const id = v.slice(STILL_PREFIX.length);
			const url = resolve(id);
			if (!url) unresolved.push(id);
			return url ?? v;
		}
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, inner]) => [k, walk(inner)]));
		return v;
	};
	return { value: walk(value), unresolved };
}
