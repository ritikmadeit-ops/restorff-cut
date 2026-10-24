/**
 * EDT-21 step 1 — a STYLE CARD from a dropped folder of references (reel DePNgrmToh9 23.6–29.5 s: folders dropped,
 * Claude studies them, writes down the look, then asks for footage, format and feel).
 *
 * Everything here is measured from what the browser can extract client-side (downsampled frames, durations, scene
 * changes); nothing is guessed that the pixels cannot show. Type is NOT guessed (lettering needs OCR or a model):
 * it is left as a question. Deeper study (TVF: shot lists, transcripts, motion) can fill the same card later.
 */
import {
	frameDifference,
	grainBands,
	histogram,
	histogramDistance,
	paletteCoverage,
	paletteFromFrames,
	type PaletteColor,
	type PixelFrame,
	recoverSaturated,
} from "./palette.ts";

/** One reference file, as the browser extracted it. */
export interface ReferenceInput {
	name: string;
	/** The dropped folder it came from ("2.5D depth", "Map zoom"). */
	folder?: string;
	kind: "image" | "video";
	/** Natural size of the file. */
	width: number;
	height: number;
	/** Downsampled frames (≤ ~96 px on the long side): one for an image, several (with `t`) for a video. */
	frames: PixelFrame[];
	/** Optional full-resolution crops (e.g. 128×128 from the centre) for grain; else the frames are used. */
	detail?: PixelFrame[];
	/** Videos: length in seconds. */
	duration?: number;
	/** Videos: scene-change times in seconds, when the browser measured them; else estimated from `frames`. */
	sceneChanges?: number[];
}

export interface CardQuestion {
	id: "footage" | "format" | "feel";
	ask: string;
	options: Array<{ value: string; label: string }>;
	/** Suggested answer from the references. */
	suggested: string;
}

export interface StyleCard {
	schema: "style-card@1";
	references: { images: number; videos: number; folders: string[]; frames: number };
	palette: PaletteColor[];
	mood: { temperature: number; label: "warm" | "cool" | "neutral"; brightness: number; contrast: number; saturation: number };
	/** Not guessed from pixels: a question for the person (or for Claude after a TVF read). */
	type: { guess: null; question: string; options: string[] };
	motion: { energy: number | null; label: string };
	texture: { grain: number | null; label: string; paper: boolean };
	pacing: { avgShot: number | null; cutsPer10s: number | null; shots: number; measuredSeconds: number; label: string };
	/** What the card is based on and what it could not measure, in plain words. */
	notes: string[];
	questions: CardQuestion[];
	/**
	 * Collage devices the references show, read from their file and folder NAMES (not pixels): "map", "globe", "zoom",
	 * "torn-hole", "halftone", "parallax", "scraps", "cut-outs", "retro-tv", "timeline", "stamp", "doodles", "paper".
	 * The explainer build uses them to pick pieces (explainer-v2, 2026-10-20). Optional: older stored cards lack it.
	 */
	cues?: string[];
}

/** File/folder name words → the collage device they name. */
const NAME_CUES: Array<[RegExp, string]> = [
	[/\bmaps?\b|route|journey/i, "map"],
	[/globe|earth|world/i, "globe"],
	[/zoom|push[- ]?in/i, "zoom"],
	[/torn|tear|rip|hole/i, "torn-hole"],
	[/halftone|dots?\b|print/i, "halftone"],
	[/parallax|depth|2\.5d|layers/i, "parallax"],
	[/scraps?|snippet|confetti/i, "scraps"],
	[/cut-?outs?|outline|sticker|redline/i, "cut-outs"],
	[/\btv\b|retro|television/i, "retro-tv"],
	[/timeline|thread|history|dates?/i, "timeline"],
	[/stamp|seal/i, "stamp"],
	[/doodle|scribble|hand-?drawn/i, "doodles"],
	[/paper|kraft|texture|grain/i, "paper"],
];

/** The collage devices a set of references names (see StyleCard.cues). */
export function cuesFromNames(refs: ReadonlyArray<Pick<ReferenceInput, "name" | "folder">>): string[] {
	const found = new Set<string>();
	for (const ref of refs) {
		const words = `${ref.folder ?? ""} ${ref.name.replace(/\.[a-z0-9]+$/i, "")}`.replace(/[_]+/g, " ");
		for (const [pattern, cue] of NAME_CUES) if (pattern.test(words)) found.add(cue);
	}
	return NAME_CUES.map(([, cue]) => cue).filter((cue, i, all) => found.has(cue) && all.indexOf(cue) === i);
}

/**
 * Re-pick the accent (explainer-v2, 2026-10-20): the loud colour that recurs across references in small areas — score =
 * saturation × (1 + log2(1 + references it appears in)), halved when it fills more than 60 % of some reference (then
 * it is a paper or a background, not an accent). The recreation's red outline/route/scraps lost to a full-frame
 * mustard paper under the old share-weighted pick.
 */
function pickAccent(palette: PaletteColor[], groups: ReadonlyArray<readonly PixelFrame[]>): void {
	const coverage = paletteCoverage(groups, palette);
	let best = -1;
	let bestScore = 0;
	palette.forEach((color, i) => {
		if (color.role === "paper" || color.role === "ink") return;
		if (color.saturation <= 0.35 || color.luma <= 0.1 || color.luma >= 0.9) return;
		const stat = coverage[i] as { presence: number; maxShare: number; avgShare: number };
		// a colour that covers a quarter of the frames it is in is a ground (land, sea, paper), not an accent
		const score = color.saturation * (1 + Math.log2(1 + stat.presence)) * (stat.maxShare > 0.6 ? 0.5 : 1) * (stat.avgShare > 0.25 ? 0.6 : 1);
		if (score > bestScore) {
			bestScore = score;
			best = i;
		}
	});
	if (best < 0) return;
	for (const color of palette) if (color.role === "accent") color.role = "tone";
	(palette[best] as PaletteColor).role = "accent";
}

/** Scene changes (seconds) from consecutive sampled frames whose colour histograms jump by more than `threshold`. */
export function sceneChangesFromFrames(frames: readonly PixelFrame[], threshold = 0.35): number[] {
	const timed = frames.filter((frame) => typeof frame.t === "number").sort((a, b) => (a.t as number) - (b.t as number));
	const changes: number[] = [];
	for (let i = 1; i < timed.length; i++) {
		const a = timed[i - 1] as PixelFrame;
		const b = timed[i] as PixelFrame;
		if (histogramDistance(histogram(a), histogram(b)) > threshold) changes.push(((a.t as number) + (b.t as number)) / 2);
	}
	return changes;
}

function round(n: number, digits = 2): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

function median(values: number[]): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function formatOf(refs: readonly ReferenceInput[]): string {
	let portrait = 0;
	let landscape = 0;
	let square = 0;
	for (const ref of refs) {
		if (!ref.width || !ref.height) continue;
		const ratio = ref.height / ref.width;
		if (ratio > 1.3) portrait++;
		else if (ratio < 0.77) landscape++;
		else square++;
	}
	if (portrait >= landscape && portrait >= square) return "9:16";
	if (landscape >= square) return "16:9";
	return "1:1";
}

/** grainBands value from which a reference counts as textured, and from which the grain is heavy (MEASURED on
 * synthetic references, 2026-10-20: drawn flat colour 0.00, ffmpeg paper noise 1.3–3.3, heavy paper 6–14). */
export const GRAIN_TEXTURED = 0.6;
export const GRAIN_HEAVY = 4;

/** Measure a style card from the references. Deterministic for the same input. */
export function styleCardFromReferences(refs: readonly ReferenceInput[]): StyleCard {
	const images = refs.filter((ref) => ref.kind === "image");
	const videos = refs.filter((ref) => ref.kind === "video");
	const frames = refs.flatMap((ref) => ref.frames);
	const folders = [...new Set(refs.map((ref) => ref.folder).filter((folder): folder is string => Boolean(folder)))];
	const notes: string[] = [];

	// palette + mood; saturated colours k-means merged away come back, and the accent is the loud colour that recurs
	// across the references (explainer-v2, 2026-10-20)
	const palette = recoverSaturated(frames, paletteFromFrames(frames, { k: 6, seed: 7 }));
	pickAccent(
		palette,
		refs.map((ref) => ref.frames),
	);
	const lumas: number[] = [];
	for (const frame of frames) {
		for (let i = 0; i + 3 < frame.data.length; i += 16) {
			lumas.push((0.2126 * (frame.data[i] as number) + 0.7152 * (frame.data[i + 1] as number) + 0.0722 * (frame.data[i + 2] as number)) / 255);
		}
	}
	const brightness = lumas.length ? lumas.reduce((a, b) => a + b, 0) / lumas.length : 0;
	const contrast = lumas.length ? Math.sqrt(lumas.reduce((a, b) => a + (b - brightness) ** 2, 0) / lumas.length) : 0;
	let warm = 0;
	let cool = 0;
	let saturation = 0;
	for (const color of palette) {
		saturation += color.saturation * color.share;
		if (color.saturation < 0.15) continue;
		if (color.hue < 70 || color.hue >= 300) warm += color.share * color.saturation;
		else if (color.hue >= 160 && color.hue < 280) cool += color.share * color.saturation;
	}
	const temperature = round(warm - cool, 3);
	const mood: StyleCard["mood"] = {
		temperature,
		label: temperature > 0.04 ? "warm" : temperature < -0.04 ? "cool" : "neutral",
		brightness: round(brightness, 3),
		contrast: round(contrast, 3),
		saturation: round(saturation, 3),
	};
	if (!frames.length) notes.push("no frames could be read: the palette is empty");

	// texture (explainer-v2, 2026-10-20): grain per reference at three scales (grainBands: flat drawn colour = 0, paper
	// noise 1.3–3.3, heavy paper 6+); the card's grain is the median over the TEXTURED references when at least a quarter
	// of them are textured (one grainy paper among flat maps is still a grainy look), else over all of them
	const perRef = refs
		.map((ref) => (ref.detail?.length ? ref.detail : ref.frames).map((frame) => grainBands(frame)?.grain).filter((g): g is number => g !== undefined))
		.filter((values) => values.length)
		.map((values) => Math.max(...values));
	const textured = perRef.filter((g) => g >= GRAIN_TEXTURED);
	const grain = textured.length && textured.length >= perRef.length / 4 ? median(textured) : median(perRef);
	const paperColor = palette.find((color) => color.role === "paper");
	const paperish = Boolean(paperColor && paperColor.share >= 0.15 && paperColor.hue >= 20 && paperColor.hue <= 70);
	const paper = paperish || (grain !== null && grain >= GRAIN_TEXTURED && brightness > 0.45 && Boolean(paperColor));
	const textureLabel =
		grain === null ? "unknown" : grain < GRAIN_TEXTURED ? "clean (flat colour)" : grain >= GRAIN_HEAVY ? "heavy grain / paper texture" : paper ? "textured paper (fine grain)" : "fine grain";
	if (perRef.length) notes.push(`grain: ${textured.length} of ${perRef.length} reference(s) textured (≥ ${GRAIN_TEXTURED})`);
	if (!refs.some((ref) => ref.detail?.length)) notes.push("grain measured on downsampled frames: fine grain reads lower than it is");

	// pacing (videos)
	let shots = 0;
	let measured = 0;
	const shotLengths: number[] = [];
	for (const video of videos) {
		if (!video.duration || video.duration <= 0) continue;
		const changes = (video.sceneChanges ?? sceneChangesFromFrames(video.frames)).filter((t) => t > 0 && t < (video.duration as number)).sort((a, b) => a - b);
		const cuts = [0, ...changes, video.duration];
		for (let i = 1; i < cuts.length; i++) shotLengths.push((cuts[i] as number) - (cuts[i - 1] as number));
		shots += changes.length + 1;
		measured += video.duration;
	}
	const avgShot = shots ? round(measured / shots) : null;
	const pacing: StyleCard["pacing"] = {
		avgShot,
		cutsPer10s: measured ? round(((shots - videos.filter((v) => v.duration).length) / measured) * 10, 1) : null,
		shots,
		measuredSeconds: round(measured, 1),
		label: avgShot === null ? "unknown (no video references)" : avgShot < 1.5 ? "fast" : avgShot <= 3.5 ? "medium" : "slow",
	};
	if (videos.length && videos.some((v) => !v.sceneChanges)) {
		notes.push("cuts estimated from sampled frames (colour jumps); a cut between two similar shots can be missed");
	}
	if (shotLengths.length) {
		const m = median(shotLengths);
		if (m !== null) notes.push(`median shot ${round(m)} s over ${shotLengths.length} shots`);
	}

	// motion: mean frame difference inside shots
	const diffs: number[] = [];
	for (const video of videos) {
		const timed = video.frames.filter((frame) => typeof frame.t === "number").sort((a, b) => (a.t as number) - (b.t as number));
		const changes = video.sceneChanges ?? sceneChangesFromFrames(timed);
		for (let i = 1; i < timed.length; i++) {
			const a = timed[i - 1] as PixelFrame;
			const b = timed[i] as PixelFrame;
			if (changes.some((t) => t > (a.t as number) && t <= (b.t as number))) continue; // a cut, not motion
			const d = frameDifference(a, b);
			if (d !== undefined) diffs.push(d / Math.max(0.1, (b.t as number) - (a.t as number)));
		}
	}
	const energy = median(diffs);
	const motion: StyleCard["motion"] = {
		energy: energy === null ? null : round(energy, 3),
		label: energy === null ? (videos.length ? "unknown (too few frames)" : "stills only: collage pieces move by design") : energy < 0.02 ? "still / locked-off" : energy < 0.07 ? "gentle movement" : "lively, lots of movement",
	};

	notes.unshift(
		`${images.length} image${images.length === 1 ? "" : "s"}, ${videos.length} video${videos.length === 1 ? "" : "s"}${folders.length ? ` from ${folders.map((f) => `"${f}"`).join(", ")}` : ""}; palette from ${frames.length} frame${frames.length === 1 ? "" : "s"}`,
	);

	const cues = cuesFromNames(refs);
	if (cues.length) notes.push(`the reference names show: ${cues.join(", ")} (read from file and folder names, not pixels)`);
	const accentColor = palette.find((color) => color.role === "accent");
	if (accentColor) notes.push(`accent ${accentColor.hex}: the loud colour that recurs across the references (${Math.round(accentColor.share * 1000) / 10} % of the pixels)`);

	const format = formatOf(refs);
	const feel = paper ? (mood.label === "warm" ? "nostalgic" : "playful") : pacing.label === "fast" ? "punchy" : mood.contrast > 0.28 ? "serious" : "playful";
	const questions: CardQuestion[] = [
		{
			id: "footage",
			ask: "What footage should the explainer use?",
			options: [
				{ value: "mine", label: "My clips and stills (pick from media)" },
				{ value: "stills", label: "Stills only (cut-outs)" },
				{ value: "none", label: "No footage: paper and motion only" },
			],
			suggested: "mine",
		},
		{
			id: "format",
			ask: "Which format?",
			options: [
				{ value: "9:16", label: "9:16 vertical" },
				{ value: "1:1", label: "1:1 square" },
				{ value: "4:5", label: "4:5 feed" },
				{ value: "16:9", label: "16:9 landscape" },
			],
			suggested: format,
		},
		{
			id: "feel",
			ask: "What should it feel like?",
			options: [
				{ value: "playful", label: "Playful (bouncy, doodles)" },
				{ value: "nostalgic", label: "Nostalgic (gentle, retro TV)" },
				{ value: "serious", label: "Serious (smooth, calm)" },
				{ value: "punchy", label: "Punchy (snappy, stamps)" },
			],
			suggested: feel,
		},
	];

	return {
		schema: "style-card@1",
		references: { images: images.length, videos: videos.length, folders, frames: frames.length },
		palette,
		mood,
		type: {
			guess: null,
			question: "What lettering do the references use?",
			options: ["typewriter / mono caps", "serif", "bold sans", "handwritten"],
		},
		motion,
		texture: { grain: grain === null ? null : round(grain, 2), label: textureLabel, paper },
		pacing,
		notes,
		questions,
		cues,
	};
}
