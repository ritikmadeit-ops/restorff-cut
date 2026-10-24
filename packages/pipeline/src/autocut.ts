/**
 * Auto-cut job builder (EDT-03, EDT-11/12): one talking-head video → a render job folder.
 *
 *   probe → TVF word timings → ops@1 (import_media + insert on V1 A-ROLL) → cutFromTranscript (dead air + retakes
 *   out, 1-3-word captions on CAPTIONS) → apply → job folder:
 *
 *   <job>/job.json       what the render page loads (schema restorffcut-render-job@1)
 *   <job>/project.json   the RestorffCut project (serialized form, version 31)
 *   <job>/media/<file>   the source (hard link when possible, else a copy)
 *   <job>/cut.json       the plan: kept / removed (with reasons) / retakes / caption chunks / stats
 *   <job>/ops.json       every op applied, in order (what a commit would store)
 *   <job>/words.json     the source word timings used
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
	apply,
	cutFromTranscript,
	EDITOR_PROJECT_VERSION,
	type Op,
	type Project,
	type TextStyle,
} from "@restorffcut/timeline-ops";
import { chunkCaptions } from "./captions.ts";
import { clipWordsToSilences, detectSilences } from "./silence.ts";
import { assertOutsideRepo } from "./paths.ts";
import { transcribe, type TvfTranscript } from "./tvf.ts";
import { probe, type Probe } from "./util.ts";

const T = 120_000;

export interface AutocutOptions {
	out: string;
	/** Pauses longer than this are cut (seconds). Default 0.35 (the compiler's default). */
	silence?: number;
	pad?: number;
	maxWords?: number;
	/** Caption centre, px from the canvas centre (y down). Default +540 (1500 px on a 1920 canvas). */
	captionY?: number;
	captionSize?: number;
	/** Default "high" (the export's bitrate preset; "preview" in the CLI maps to "medium"). */
	quality?: "low" | "medium" | "high" | "very_high";
	forceTvf?: boolean;
	canvas?: { width: number; height: number };
}

export interface AutocutResult {
	jobDir: string;
	jobName: string;
	source: string;
	probe: Probe;
	transcript: Pick<TvfTranscript, "workDir" | "backend" | "model" | "device" | "reused" | "ms"> & { words: number };
	inputSeconds: number;
	outputSeconds: number;
	cuts: number;
	removed: Array<{ start: number; end: number; reason: string; detail?: string }>;
	retakes: Array<{ dropped: string; keptAs: string }>;
	captions: number;
	conflicts: number;
}

export const DEFAULT_CAPTION_STYLE = (height: number, y?: number, size?: number): TextStyle => ({
	font: "Arial",
	size: size ?? 4.5,
	weight: "bold",
	color: "#FFFFFF",
	align: "center",
	bg: true,
	bg_color: "#0C0C0E",
	bg_radius: 18,
	y: y ?? Math.round(height * 0.28125),
});

function emptyProject(name: string, fps: { numerator: number; denominator: number }, canvas: { width: number; height: number }): Project {
	const now = "2026-10-20T00:00:00.000Z";
	return {
		metadata: {
			id: `pipeline-${name}`,
			name,
			duration: 0,
			createdAt: now,
			updatedAt: now,
			restorff: { opsVersion: "ops@1", pending: [], media: [] },
		},
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [],
					main: { id: "trk-main", name: "V1 A-ROLL", type: "video", muted: false, hidden: false, elements: [] },
					audio: [],
				},
				bookmarks: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		currentSceneId: "scene-main",
		settings: {
			fps,
			canvasSize: canvas,
			canvasSizeMode: "preset",
			background: { type: "color", color: "#000000" },
		},
		version: EDITOR_PROJECT_VERSION,
		timelineViewState: { zoomLevel: 1, scrollLeft: 0, playheadTime: 0 },
	} as Project;
}

function linkOrCopy(from: string, to: string): "link" | "copy" {
	if (existsSync(to)) return "link";
	try {
		linkSync(from, to);
		return "link";
	} catch {
		copyFileSync(from, to);
		return "copy";
	}
}

export function jobNameFor(dir: string): string {
	return basename(resolve(dir)).replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "job";
}

function projectEnd(project: Project): number {
	const scene = project.scenes.find((s) => s.id === project.currentSceneId) ?? project.scenes[0];
	let end = 0;
	for (const track of [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]) {
		for (const element of track.elements) end = Math.max(end, element.startTime + element.duration);
	}
	return end;
}

export async function autocut(video: string, opts: AutocutOptions): Promise<AutocutResult> {
	const source = resolve(video);
	if (!existsSync(source)) throw new Error(`video not found: ${source}`);
	const jobDir = resolve(opts.out);
	assertOutsideRepo(jobDir);
	mkdirSync(join(jobDir, "media"), { recursive: true });
	const jobName = jobNameFor(jobDir);

	const info = await probe(source);
	if (!info.video) throw new Error(`${source} has no video stream`);
	const fps = info.video.fps;
	// Clip length: the decodable video (frames / fps), so the last frame is never a hold of a missing one.
	const videoSeconds =
		info.video.frames != null ? (info.video.frames * fps.denominator) / fps.numerator : info.video.duration ?? info.duration;
	const clipOut = Math.floor(videoSeconds * T) / T;

	const transcript = await transcribe(source, { force: opts.forceTvf, workRoot: join(jobDir, "tvf") });
	if (!transcript.words.length) throw new Error(`TVF found no words in ${source} (${transcript.workDir})`);

	const ext = extname(source) || ".mp4";
	const mediaFile = `media/source${ext}`;
	const how = linkOrCopy(source, join(jobDir, mediaFile));

	const canvas = opts.canvas ?? { width: 1080, height: 1920 };
	const seed = `pipeline/${jobName}`;
	let project = emptyProject(jobName, fps, canvas);
	const setup: Op[] = [
		{
			op: "import_media",
			author: "compiler",
			kind: "video",
			name: basename(source),
			url: `job:${mediaFile}`,
			duration: clipOut,
			width: info.video.width,
			height: info.video.height,
			fps: info.video.fpsFloat,
			has_audio: !!info.audio,
			ref: "src",
		},
		{
			op: "insert",
			author: "compiler",
			track: "main",
			t: 0,
			media: "src",
			in: 0,
			out: clipOut,
			name: "S01 talking head",
			ref: "aroll",
		},
	];
	const first = apply(project, setup, { seed: `${seed}/setup` });
	if (!first.ok) throw new Error(`setup ops conflicted: ${JSON.stringify(first.conflicts)}`);
	project = first.project;
	const mediaId = first.changes.refs.src;
	const arollId = first.changes.refs.aroll;

	// The compiler cuts (dead air + retakes); captions are added after, width-aware (captions.ts), one add_captions op
	// per chunk on one CAPTIONS track — all in the same batch, so it is one commit.
	const silences = info.audio ? await detectSilences(source, { minSeconds: opts.silence ?? 0.35 }) : [];
	const clippedWords = clipWordsToSilences(transcript.words, silences);
	const plan = cutFromTranscript(clippedWords.words, {
		clip: { el: arollId, start: 0, in: 0, out: clipOut },
		silence: opts.silence,
		pad: opts.pad,
		captions: false,
	});
	const baseStyle = DEFAULT_CAPTION_STYLE(canvas.height, opts.captionY, opts.captionSize);
	const chunks = chunkCaptions(plan.words, {
		canvasHeight: canvas.height,
		size: baseStyle.size ?? 4.5,
		maxWords: opts.maxWords ?? 3,
		maxWidthPx: Math.round(canvas.width * 0.8),
	});
	const captionOps: Op[] = chunks.map((chunk, i) => ({
		op: "add_captions",
		author: "compiler",
		words: chunk.words,
		max_words: 3,
		style: { ...baseStyle, size: chunk.size },
		...(i === 0 ? { ref: "th-captions" } : { track: "th-captions" }),
	}));
	const ops = [...plan.ops, ...captionOps];
	let second = apply(project, ops, { seed: `${seed}/cut`, snap: "frame" });
	let snap = "frame";
	if (!second.ok) {
		// Frame snapping can make two neighbouring cuts collide on very short stretches; fall back to exact ticks.
		second = apply(project, ops, { seed: `${seed}/cut` });
		snap = "none";
	}
	if (!second.ok) throw new Error(`cut ops conflicted: ${JSON.stringify(second.conflicts).slice(0, 2000)}`);
	project = second.project;
	project.metadata.duration = projectEnd(project);

	const captionTexts = second.changes.ops
		.filter((c) => c.op === "add_captions")
		.flatMap((c) => (c.details as { chunks?: string[] } | undefined)?.chunks ?? []);
	const captionChunks = captionTexts.length;
	const cuts = plan.removed.filter((r) => r.reason === "silence" || r.reason === "retake").length;

	writeFileSync(join(jobDir, "project.json"), `${JSON.stringify(project, null, 1)}\n`);
	writeFileSync(
		join(jobDir, "job.json"),
		`${JSON.stringify(
			{
				schema: "restorffcut-render-job@1",
				project: "project.json",
				media: [
					{
						id: mediaId,
						file: mediaFile,
						type: "video",
						name: basename(source),
						width: info.video.width,
						height: info.video.height,
						duration: clipOut,
						fps: Math.round(info.video.fpsFloat),
						hasAudio: !!info.audio,
					},
				],
				export: { format: "mp4", quality: opts.quality ?? "high" },
			},
			null,
			1,
		)}\n`,
	);
	writeFileSync(
		join(jobDir, "ops.json"),
		`${JSON.stringify({ seed, snap, setup: first.changes.applied, cut: second.changes.applied }, null, 1)}\n`,
	);
	writeFileSync(join(jobDir, "words.json"), `${JSON.stringify(transcript.words, null, 0)}\n`);

	const result: AutocutResult = {
		jobDir,
		jobName,
		source,
		probe: info,
		transcript: {
			workDir: transcript.workDir,
			backend: transcript.backend,
			model: transcript.model,
			device: transcript.device,
			reused: transcript.reused,
			ms: transcript.ms,
			words: transcript.words.length,
		},
		inputSeconds: clipOut,
		outputSeconds: project.metadata.duration / T,
		cuts,
		removed: plan.removed,
		retakes: plan.retakes,
		captions: captionChunks,
		conflicts: second.conflicts.length,
	};
	writeFileSync(
		join(jobDir, "cut.json"),
		`${JSON.stringify(
			{
				...result,
				mediaLinked: how,
				snap,
				silences,
				wordsClippedToSilence: clippedWords.clipped,
				kept: plan.kept,
				stats: plan.stats,
				captionChunks: chunks.map((c) => ({ text: c.text, start: c.start, end: c.end, size: c.size, estWidthPx: c.estWidthPx })),
				captionTexts,
				keptWords: plan.words,
			},
			null,
			1,
		)}\n`,
	);
	return result;
}
