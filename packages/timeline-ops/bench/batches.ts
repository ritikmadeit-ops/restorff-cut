/**
 * Benchmark batches for `apply` — fictional Halcyon Cold Brew only (BUILD-BRIEF §6.3). Shared by
 * bench/apply.bench.ts (timing) and test/equivalence.test.ts (old reducer vs new, byte for byte).
 *
 * Three shapes, each sized to a target op count:
 * - `captions`: what the MCP captions tool sends — buildCaptionOps in the huge-centred style (per word: insert +
 *   4 entrance keyframes, shadow insert + 4 keyframes = 10 ops), with a deterministic fake text measure.
 * - `inserts`:  the worst case for one track — n-1 caption text inserts on ONE track (the track grows to n-1 elements).
 * - `autocut`:  a mixed cut batch — cutFromTranscript's split / split / ripple_delete chains on a long A-roll, then
 *   B-roll inserts, moves, splits and deletes on an overlay track.
 */
import {
	buildCaptionOps,
	chunkWordGroups,
	cutFromTranscript,
	getCaptionStyle,
	type AudioElement,
	type MeasureText,
	type Op,
	type Project,
	type TimedWord,
	type VideoElement,
} from "../src/index.ts";
import { fixtureProject } from "../test/fixture.ts";

export const T = 120_000;

const SCRIPT = "Halcyon cold brew steeped for twenty hours never bitter smooth and bold try it today".split(" ");

export type BatchKind = "captions" | "inserts" | "autocut";
export const BATCH_KINDS: BatchKind[] = ["captions", "inserts", "autocut"];

export interface Batch {
	kind: BatchKind;
	project: Project;
	ops: Op[];
}

/** The Halcyon fixture with the A-roll, its media and the music bed stretched to `seconds`; the B-roll track empty. */
export function longProject(seconds: number): Project {
	const project = fixtureProject();
	const ticks = Math.round(seconds * T);
	const scene = project.scenes[0];
	const aroll = scene.tracks.main.elements[0] as VideoElement;
	aroll.duration = ticks;
	aroll.sourceDuration = ticks;
	const media = project.metadata.restorff?.media ?? [];
	for (const entry of media) {
		if (entry.id === "media-aroll") entry.duration = ticks;
		if (entry.id === "media-music") entry.duration = ticks + 60 * T;
	}
	const music = scene.tracks.audio[0].elements[0] as AudioElement;
	music.duration = ticks;
	music.trimEnd = 60 * T;
	music.sourceDuration = ticks + 60 * T;
	const broll = scene.tracks.overlay.find((track) => track.id === "trk-broll");
	if (broll) (broll as { elements: unknown[] }).elements = [];
	project.metadata.duration = ticks;
	return project;
}

/** Contiguous words, 0.3 s each with 0.05 s gaps, from 0.5 s. */
export function captionWords(count: number): TimedWord[] {
	const words: TimedWord[] = [];
	for (let i = 0; i < count; i++) {
		const start = 0.5 + i * 0.35;
		words.push({ text: SCRIPT[i % SCRIPT.length], start: round3(start), end: round3(start + 0.3) });
	}
	return words;
}

/** Talking-head transcript: groups of 3 words, then a 0.6 s pause (> the 0.35 s silence cut, < the 0.8 s sentence break). */
export function pausedWords(groups: number): TimedWord[] {
	const words: TimedWord[] = [];
	let cursor = 0.5;
	for (let g = 0; g < groups; g++) {
		for (let w = 0; w < 3; w++) {
			const text = SCRIPT[(g * 3 + w) % SCRIPT.length];
			words.push({ text, start: round3(cursor), end: round3(cursor + 0.3) });
			cursor += 0.35;
		}
		cursor += 0.55;
	}
	return words;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Deterministic stand-in for the browser's canvas measureText: ~0.55 em per character. */
export const fakeMeasure: MeasureText = (text, font) =>
	text.length * 0.55 * ((font.size * 1920) / 90) + Math.max(0, text.length - 1) * font.letterSpacing;

/** huge-centred captions: 2 add_track + 10 ops per word. */
export function captionsBatch(targetOps: number): Batch {
	const wordCount = Math.max(1, Math.round((targetOps - 2) / 10));
	const words = captionWords(wordCount);
	const seconds = Math.ceil(words[words.length - 1].end + 2);
	const build = buildCaptionOps({
		chunks: chunkWordGroups(words, { maxWords: 1 }),
		style: getCaptionStyle("huge-centred"),
		canvas: { width: 1080, height: 1920 },
		measure: fakeMeasure,
		author: "claude",
	});
	return { kind: "captions", project: longProject(seconds), ops: build.ops };
}

/** One caption track, then targetOps-1 text inserts on it, 0.2 s apart. */
export function insertsBatch(targetOps: number): Batch {
	const count = Math.max(1, targetOps - 1);
	const ops: Op[] = [{ op: "add_track", author: "claude", kind: "caption", ref: "cap" }];
	for (let i = 0; i < count; i++) {
		ops.push({
			op: "insert",
			author: "claude",
			track: "cap",
			t: round3(0.5 + i * 0.2),
			dur: 0.15,
			text: SCRIPT[i % SCRIPT.length],
			name: `Caption ${i + 1}`,
			style: { font: "Oswald", size: 15, weight: "bold", color: "#EDEBE6", align: "center", x: -40, y: 0 },
			ref: `w${i}`,
		});
	}
	return { kind: "inserts", project: longProject(Math.ceil(0.5 + count * 0.2 + 2)), ops };
}

/**
 * ~40 % of the ops are cutFromTranscript's cut chains on the A-roll (split, split, ripple_delete per pause), the rest
 * are B-roll ops on trk-broll: all inserts first (1 s clips, 2 s apart), then a move of each (+0.5 s), a split of each
 * and a delete of every right half — 4 ops per clip.
 */
export function autocutBatch(targetOps: number): Batch {
	const groups = Math.max(2, Math.round((targetOps * 0.4) / 3));
	const words = pausedWords(groups);
	const seconds = Math.ceil(words[words.length - 1].end + 1);
	const plan = cutFromTranscript(words, {
		clip: { el: "el-aroll", start: 0, in: 0, out: seconds },
		captions: false,
		author: "compiler",
	});
	const ops: Op[] = [...plan.ops];
	const clips = Math.max(1, Math.floor((targetOps - ops.length) / 4));
	for (let i = 0; i < clips; i++) {
		ops.push({ op: "insert", author: "claude", track: "trk-broll", t: 2 * i, media: "media-broll", in: 0, out: 1, ref: `b${i}` });
	}
	for (let i = 0; i < clips; i++) ops.push({ op: "move", author: "claude", el: `b${i}`, t: 2 * i + 0.5 });
	for (let i = 0; i < clips; i++) ops.push({ op: "split", author: "claude", el: `b${i}`, t: 2 * i + 1.25, ref: `b${i}r` });
	for (let i = 0; i < clips; i++) ops.push({ op: "delete", author: "claude", el: `b${i}r` });
	return { kind: "autocut", project: longProject(seconds), ops };
}

export function buildBatch(kind: BatchKind, targetOps: number): Batch {
	if (kind === "captions") return captionsBatch(targetOps);
	if (kind === "inserts") return insertsBatch(targetOps);
	return autocutBatch(targetOps);
}
