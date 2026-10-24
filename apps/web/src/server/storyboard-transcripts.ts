/**
 * The storyboard's one door into the transcript store (revise-v2 agent, 2026-10-20): server/transcripts*.ts belong
 * to the captions-v2 agent (wave 5) and may move; everything the storyboard reads from them — and the one thing it
 * writes, a transcript fix — comes through here, so a rename there is a one-file fix here.
 *
 * recordCaptionFixes: when a person rewrites a caption (storyboard edit_row {caption}, revise "change the beat 3
 * caption to …"), the same words are recorded as a transcript fix of the media under it (captions-v2's
 * `<sha256>/edits.json`, applied on every read), so a later `captions` rebuild keeps them instead of bringing Whisper's
 * words back (warm-moody REPORT §5 item 9).
 */
import type { Op } from "@restorffcut/timeline-ops";
import type { ProjectSnapshot, SnapshotElement, SnapshotTrack } from "@/sync/snapshot";
import { captionTracksOf, findSnapshotElement } from "./storyboard-rows";
import { findTranscript, readEdits, resolveMediaFile, saveEdits } from "./transcripts";
import { clipWordsOnTimeline, spokenClips } from "./transcripts-timeline";

export { clipWordsOnTimeline, findTranscript, resolveMediaFile };

const TICKS = 120_000;

/** Clips that can carry speech (video with sound on, uploaded audio) — not voice-over takes (their words are on the clip). */
export function spokenClipsOf(snapshot: ProjectSnapshot): Array<{ element: SnapshotElement; track: SnapshotTrack }> {
	return spokenClips(snapshot)
		.filter(({ element }) => !(element.restorff as { voice?: unknown } | undefined)?.voice)
		.map(({ element, track }) => ({ element, track }));
}

const contentOf = (element: SnapshotElement | undefined) => {
	const content = (element?.params as Record<string, unknown> | undefined)?.content;
	return typeof content === "string" ? content.trim() : "";
};

/** The words a caption chunk shows, as the transcript has them (its caption tag's words, else its text). */
function chunkWords(element: SnapshotElement): string {
	const tag = (element.restorff as { caption?: { words?: Array<{ text: string }> } } | undefined)?.caption;
	return tag?.words?.length ? tag.words.map((word) => word.text).join(" ") : contentOf(element);
}

/** Caption text changes in a batch: `set text` on caption clips + chunk rebuilds with a new text. */
export function captionFixesOf(snapshot: ProjectSnapshot, ops: readonly Op[], chunks: ReadonlyArray<{ id: string; text?: string }>): Array<{ start: number; from: string; to: string }> {
	const ordered = captionTracksOf(snapshot)
		.flatMap((track) => track.elements ?? [])
		.sort((a, b) => a.startTime - b.startTime);
	const indexOf = new Map(ordered.map((element, i) => [element.id, i]));
	const changed: Array<{ index: number; start: number; from: string; to: string }> = [];
	const push = (id: string, to: string) => {
		const element = findSnapshotElement(snapshot, id)?.element;
		const index = indexOf.get(id);
		if (!element || index === undefined) return;
		const from = chunkWords(element);
		if (from && from !== to.trim()) changed.push({ index, start: element.startTime / TICKS, from, to: to.trim() });
	};
	for (const op of ops) {
		const set = op as { op: string; el?: string; prop?: string; value?: unknown };
		if (set.op === "set" && set.prop === "text" && typeof set.value === "string" && set.el) push(set.el, set.value);
	}
	for (const chunk of chunks) if (typeof chunk.text === "string") push(chunk.id, chunk.text);
	// neighbouring chunks rewritten together are ONE fix (the line's words moved across chunk edges)
	changed.sort((a, b) => a.index - b.index);
	const out: Array<{ start: number; from: string; to: string }> = [];
	let run: { last: number; start: number; from: string[]; to: string[] } | null = null;
	for (const entry of changed) {
		if (run && entry.index === run.last + 1) {
			run.last = entry.index;
			run.from.push(entry.from);
			if (entry.to) run.to.push(entry.to);
			continue;
		}
		if (run) out.push({ start: run.start, from: run.from.join(" "), to: run.to.join(" ") });
		run = { last: entry.index, start: entry.start, from: [entry.from], to: entry.to ? [entry.to] : [] };
	}
	if (run) out.push({ start: run.start, from: run.from.join(" "), to: run.to.join(" ") });
	return out;
}

/** Record the fixes on the media under each caption (nearest occurrence, by source time). Never throws. */
export async function recordCaptionFixes(timelineId: string, snapshot: ProjectSnapshot, fixes: Array<{ start: number; from: string; to: string }>): Promise<{ recorded: number; skipped: string[] }> {
	const skipped: string[] = [];
	let recorded = 0;
	if (!fixes.length) return { recorded, skipped };
	const clips = spokenClips(snapshot).map(({ element }) => element);
	const byHash = new Map<string, Array<{ from: string; to: string; source_t: number; created_at: string }>>();
	const transcribed = new Map<string, string | null>(); // media id → hash of a media that HAS a transcript
	const hashWithTranscript = async (mediaId: string) => {
		if (!transcribed.has(mediaId)) {
			let hash: string | null = null;
			try {
				const media = await resolveMediaFile(timelineId, mediaId);
				if (findTranscript(media.hash, { raw: true })) hash = media.hash;
			} catch {
				hash = null;
			}
			transcribed.set(mediaId, hash);
		}
		return transcribed.get(mediaId) ?? null;
	};
	for (const fix of fixes) {
		// the clip whose words these are: under the caption AND transcribed (a silent A-roll under a voice-over is not)
		const at = Math.round(fix.start * TICKS) + 1;
		let chosen: { clip: SnapshotElement; hash: string } | null = null;
		for (const clip of clips) {
			if (!clip.mediaId || clip.startTime > at || clip.startTime + clip.duration <= at) continue;
			const hash = await hashWithTranscript(clip.mediaId);
			if (hash) {
				chosen = { clip, hash };
				break;
			}
		}
		if (!chosen) {
			skipped.push(`"${fix.from}" → "${fix.to}": no transcribed clip under it (the caption changed; no transcript to fix)`);
			continue;
		}
		const { clip, hash } = chosen;
		const rate = Number((clip.retime as { rate?: number } | undefined)?.rate) || 1;
		const sourceT = (clip.trimStart ?? 0) / TICKS + (fix.start - clip.startTime / TICKS) * rate;
		const list = byHash.get(hash) ?? [];
		list.push({ from: fix.from, to: fix.to, source_t: Math.round(sourceT * 1000) / 1000, created_at: new Date().toISOString() });
		byHash.set(hash, list);
	}
	for (const [hash, list] of byHash) {
		try {
			saveEdits(hash, [...readEdits(hash), ...list]);
			recorded += list.length;
		} catch (error) {
			skipped.push(`transcript ${hash.slice(0, 8)}: ${(error as Error).message.slice(0, 160)}`);
		}
	}
	return { recorded, skipped };
}
