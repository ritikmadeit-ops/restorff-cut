/**
 * Study a reference set (EDT-21, PARITY G14; mcp-references agent, 2026-10-20): ffmpeg reads every file into the
 * numbers `@restorffcut/styles` `styleCardFromReferences` measures (the same pure code the Styles tab runs in the
 * browser), and the contact sheets + palette strip a Claude looks at. Limits as the browser: 40 images, 8 clips (the
 * first ones by folder/name); each clip's first 60 s.
 */
import { colorName, styleCardFromReferences, type PixelFrame, type ReferenceInput, type StyleCard } from "@restorffcut/styles";
import {
	clipTileTimes,
	contactSheet,
	detailCrop,
	paletteStrip,
	pixelFrames,
	probeMedia,
	SCENE_MIN_GAP_S,
	SCENE_SPIKE_MIN,
	SCENE_SPIKE_RATIO,
	SCENE_THRESHOLD,
	sceneChanges,
	STUDY_SPAN_S,
	type Sheet,
	type SheetTileSpec,
} from "./references-frames";
import { filePathOf, filesKey, type ReferenceFile, type ReferenceSet, type ReferenceStudy, type StudiedFile } from "./references-store";

const MAX_IMAGES = 40;
const MAX_VIDEOS = 8;
/** Tiles per contact sheet (6 columns × 5 rows). */
const TILES_PER_SHEET = 30;
/** MCP allows 12 images per result: up to 11 sheets + the palette strip. */
const MAX_SHEETS = 11;

export interface StudyOutput {
	study: ReferenceStudy;
	sheets: Sheet[];
	palette: { data: string; mimeType: "image/jpeg" } | null;
	/** Sheets that did not fit in one answer. */
	sheets_dropped: number;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i] as T);
			}
		}),
	);
	return out;
}

interface Extracted {
	file: ReferenceFile;
	input: ReferenceInput;
	studied: StudiedFile;
	tiles: SheetTileSpec[];
}

async function extract(set: ReferenceSet, file: ReferenceFile, signal?: AbortSignal): Promise<Extracted> {
	const full = filePathOf(set.timeline_id, file);
	const probe = await probeMedia(full, signal);
	const label = `${file.folder ? `${file.folder}/` : ""}${file.name}`;
	if (file.kind === "image") {
		const frames = await pixelFrames(full, probe, "image", 0, signal);
		const crop = await detailCrop(full, probe, null, signal);
		return {
			file,
			input: { name: file.name, ...(file.folder ? { folder: file.folder } : {}), kind: "image", width: probe.width, height: probe.height, frames, ...(crop ? { detail: [crop] } : {}) },
			studied: { id: file.id, name: file.name, folder: file.folder, kind: "image", width: probe.width, height: probe.height, studied_s: null, cuts: [], frames: frames.length },
			tiles: [{ file: full, at: null, label }],
		};
	}
	const span = Math.min(probe.duration ?? 0, STUDY_SPAN_S);
	if (!(span > 0)) throw new Error("the clip has no readable duration");
	const [frames, cuts] = await Promise.all([pixelFrames(full, probe, "video", span, signal), sceneChanges(full, span, signal)]);
	const crop = await detailCrop(full, probe, span / 2, signal);
	const times = clipTileTimes(span, cuts);
	return {
		file,
		input: {
			name: file.name,
			...(file.folder ? { folder: file.folder } : {}),
			kind: "video",
			width: probe.width,
			height: probe.height,
			frames: frames as PixelFrame[],
			...(crop ? { detail: [crop] } : {}),
			duration: span,
			sceneChanges: cuts,
		},
		studied: { id: file.id, name: file.name, folder: file.folder, kind: "video", width: probe.width, height: probe.height, studied_s: Math.round(span * 100) / 100, cuts, frames: frames.length },
		tiles: times.map((t) => ({ file: full, at: t, label: `${label} @ ${t.toFixed(2)} s${cuts.some((cut) => Math.abs(cut + 0.1 - t) < 0.02) ? " (after a cut)" : ""}` })),
	};
}

/** Study every file of the set: the card (stored in the set by the caller) + images. */
export async function studyReferences(set: ReferenceSet, opts: { images?: boolean; signal?: AbortSignal } = {}): Promise<StudyOutput> {
	const sorted = [...set.files].sort((a, b) => `${a.folder ?? ""}/${a.name}`.localeCompare(`${b.folder ?? ""}/${b.name}`));
	const images = sorted.filter((file) => file.kind === "image").slice(0, MAX_IMAGES);
	const videos = sorted.filter((file) => file.kind === "video").slice(0, MAX_VIDEOS);
	const chosen = new Set([...images, ...videos].map((file) => file.id));
	const skipped = sorted.filter((file) => !chosen.has(file.id)).map((file) => `${file.name} (over the limit: ${MAX_IMAGES} images, ${MAX_VIDEOS} clips)`);
	const failed: string[] = [];
	const results = await pool(sorted.filter((file) => chosen.has(file.id)), 3, async (file) => {
		try {
			return await extract(set, file, opts.signal);
		} catch (error) {
			failed.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	});
	const extracted = results.filter((item): item is Extracted => item !== null);
	const card: StyleCard = styleCardFromReferences(extracted.map((item) => item.input));
	if (extracted.some((item) => item.file.kind === "video")) {
		card.notes.push(
			`server study: cuts are frames whose ffmpeg scene score is over ${SCENE_THRESHOLD}, or a spike of ≥ ${SCENE_SPIKE_MIN} that stands ${SCENE_SPIKE_RATIO}× over the frames around it (cuts < ${SCENE_MIN_GAP_S} s apart count once), in each clip's first ${STUDY_SPAN_S} s; frames sampled at 2 fps`,
		);
	}
	if (skipped.length) card.notes.push(`${skipped.length} file(s) over the study limit were left out`);
	if (failed.length) card.notes.push(`${failed.length} file(s) could not be read: ${failed.map((line) => line.split(":")[0]).join(", ")}`);

	const study: ReferenceStudy = {
		at: new Date().toISOString(),
		files_key: filesKey(set.files),
		card,
		files: extracted.map((item) => item.studied),
		skipped,
		failed,
	};
	if (opts.images === false) return { study, sheets: [], palette: null, sheets_dropped: 0 };

	// one or more sheets per folder, in folder order
	const byFolder = new Map<string | null, SheetTileSpec[]>();
	for (const item of extracted) {
		const key = item.file.folder;
		byFolder.set(key, [...(byFolder.get(key) ?? []), ...item.tiles]);
	}
	const jobs: Array<{ folder: string | null; tiles: SheetTileSpec[] }> = [];
	for (const [folder, tiles] of byFolder) {
		for (let at = 0; at < tiles.length; at += TILES_PER_SHEET) jobs.push({ folder, tiles: tiles.slice(at, at + TILES_PER_SHEET) });
	}
	const kept = jobs.slice(0, MAX_SHEETS);
	const sheets = await pool(kept, 2, (job) => contactSheet(job.folder, job.tiles, opts.signal));
	const palette = await paletteStrip(card.palette, opts.signal);
	return { study, sheets, palette, sheets_dropped: jobs.length - kept.length };
}

/** The card as a Claude reads it: swatches with names, the measures in words, the three questions. */
export function cardView(card: StyleCard) {
	return {
		references: card.references,
		palette: card.palette.map((color) => ({ hex: color.hex, name: colorName(color.hex), role: color.role, share: Math.round(color.share * 1000) / 1000 })),
		mood: card.mood,
		texture: card.texture,
		pacing: card.pacing,
		motion: card.motion,
		type: card.type,
		notes: card.notes,
		questions: card.questions,
		// explainer-v2: the collage devices the reference names show (the build picks pieces from them)
		cues: card.cues ?? [],
	};
}
