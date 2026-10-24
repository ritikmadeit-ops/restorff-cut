/**
 * The cut as a storyboard: one row per shot (every video/image clip on V1 A-ROLL
 * and the B-roll tracks), in time order, with the words spoken over it (caption
 * clips), the on-screen text over it (TEXT clips), and a GAP row wherever
 * nothing is on screen, so the rows cover the whole runtime (EDT-14). Pure.
 */
import type { TScene, TimelineElement, TimelineTrack } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { getTrackRole } from "@/timeline/components/track-layout";
import { clipLabel } from "./labels";

export type ShotRole = "A-ROLL" | "B-ROLL" | "GAP";

export interface Shot {
	/** 1-based, in time order. */
	number: number;
	id: string;
	role: ShotRole;
	trackId: string | null;
	trackName: string | null;
	elementId: string | null;
	mediaId: string | null;
	name: string;
	/** Seconds. */
	start: number;
	end: number;
	/** Ticks: where the storyboard frame is taken. */
	midTicks: number;
	/** Caption words over this shot, verbatim, in order. */
	words: string;
	/** On-screen text (TEXT track) over this shot. */
	emphasis: string[];
}

const MIN_GAP_SECONDS = 0.1;

function textOf(element: TimelineElement): string {
	return typeof element.params?.content === "string" ? element.params.content.trim() : "";
}

function overlaps(element: TimelineElement, start: number, end: number): boolean {
	const s = element.startTime / TICKS_PER_SECOND;
	const e = (element.startTime + element.duration) / TICKS_PER_SECOND;
	return s < end && e > start;
}

export function buildShots(scene: TScene | null): Shot[] {
	if (!scene) return [];
	const videoTracks: TimelineTrack[] = [
		scene.tracks.main,
		...scene.tracks.overlay.filter((track) => track.type === "video"),
	];
	const captionClips: TimelineElement[] = [];
	const textClips: TimelineElement[] = [];
	for (const track of scene.tracks.overlay) {
		if (track.type !== "text") continue;
		const role = getTrackRole(track);
		for (const element of track.elements) {
			(role === "captions" ? captionClips : textClips).push(element);
		}
	}
	captionClips.sort((a, b) => a.startTime - b.startTime);
	textClips.sort((a, b) => a.startTime - b.startTime);

	type Draft = Omit<Shot, "number" | "words" | "emphasis">;
	const drafts: Draft[] = [];
	for (const track of videoTracks) {
		const role: ShotRole = getTrackRole(track) === "aroll" ? "A-ROLL" : "B-ROLL";
		for (const element of track.elements) {
			if (element.type !== "video" && element.type !== "image") continue;
			const start = element.startTime / TICKS_PER_SECOND;
			const end = (element.startTime + element.duration) / TICKS_PER_SECOND;
			drafts.push({
				id: element.id,
				role,
				trackId: track.id,
				trackName: track.name,
				elementId: element.id,
				mediaId: element.mediaId,
				name: clipLabel(element.name),
				start,
				end,
				midTicks: Math.round(element.startTime + element.duration / 2),
			});
		}
	}

	// Gaps: spans of the runtime with no video at all.
	const runtimeEnd = Math.max(
		0,
		...drafts.map((d) => d.end),
		...scene.tracks.audio.flatMap((track) =>
			track.elements.map((e) => (e.startTime + e.duration) / TICKS_PER_SECOND),
		),
		...captionClips.map((c) => (c.startTime + c.duration) / TICKS_PER_SECOND),
		...textClips.map((c) => (c.startTime + c.duration) / TICKS_PER_SECOND),
	);
	const covered = drafts
		.map((d) => [d.start, d.end] as const)
		.sort((a, b) => a[0] - b[0]);
	let cursor = 0;
	const gaps: Draft[] = [];
	for (const [s, e] of covered) {
		if (s - cursor >= MIN_GAP_SECONDS) gaps.push(gapDraft(cursor, s));
		cursor = Math.max(cursor, e);
	}
	if (runtimeEnd - cursor >= MIN_GAP_SECONDS) gaps.push(gapDraft(cursor, runtimeEnd));

	return [...drafts, ...gaps]
		.sort((a, b) => a.start - b.start || (a.role === "A-ROLL" ? -1 : 1))
		.map((draft, index) => ({
			...draft,
			number: index + 1,
			words: captionClips
				.filter((c) => overlaps(c, draft.start, draft.end))
				.map(textOf)
				.filter(Boolean)
				.join(" "),
			emphasis: textClips
				.filter((c) => overlaps(c, draft.start, draft.end))
				.map(textOf)
				.filter(Boolean),
		}));
}

function gapDraft(start: number, end: number): Omit<Shot, "number" | "words" | "emphasis"> {
	return {
		id: `gap-${start.toFixed(2)}`,
		role: "GAP",
		trackId: null,
		trackName: null,
		elementId: null,
		mediaId: null,
		name: "nothing on screen",
		start,
		end,
		midTicks: Math.round(((start + end) / 2) * TICKS_PER_SECOND),
	};
}
