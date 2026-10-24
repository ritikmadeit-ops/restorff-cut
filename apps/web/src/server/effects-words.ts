/**
 * Words on a timeline, for "apply this effect on the word …" (mcp-effects agent, 2026-10-20; EDT-17).
 *
 * Two sources, best first:
 *   1. transcripts per media (SOURCE seconds; the mcp-cut agent's server-side store) mapped onto the clips that play
 *      them — `wordsFromTranscripts` (the same rule as the editor's captions/timeline-words.ts: a word belongs to a
 *      clip when its middle is inside the clip's source window);
 *   2. the caption elements already on the timeline — each chunk on the CAPTIONS track carries its words in
 *      `restorff.caption.words` (seconds from the element's start; captions/build.ts); a caption without them gets its
 *      words spread over its time by letters, as the editor does.
 * Pure: snapshot in, words out. Times are timeline seconds.
 */
import type { ProjectSnapshot, SnapshotElement, SnapshotScene, SnapshotTrack } from "@/sync/snapshot";

const TICKS = 120_000;

export interface TimelineWord {
	text: string;
	/** Timeline seconds. */
	start: number;
	end: number;
}

export interface SourceWord {
	text: string;
	/** SOURCE seconds (into the media file). */
	start: number;
	end: number;
}

export function activeScene(snapshot: ProjectSnapshot): SnapshotScene | null {
	const scenes = snapshot.scenes ?? [];
	return scenes.find((scene) => scene.id === snapshot.currentSceneId) ?? scenes.find((scene) => scene.isMain) ?? scenes[0] ?? null;
}

/** Tracks top to bottom: overlay, main, audio. */
export function orderedTracks(snapshot: ProjectSnapshot): SnapshotTrack[] {
	const tracks = activeScene(snapshot)?.tracks;
	if (!tracks) return [];
	return [...(tracks.overlay ?? []), ...(tracks.main ? [tracks.main] : []), ...(tracks.audio ?? [])];
}

// ─── 1. transcripts per media ────────────────────────────────────────────────────────────────────────────────

const rateOf = (element: SnapshotElement): number => {
	const retime = element.retime as { rate?: number } | undefined;
	return typeof retime?.rate === "number" && retime.rate > 0 ? retime.rate : 1;
};

/** Every transcribed word on the timeline: each audible clip whose media has a transcript, in time order. */
export function wordsFromTranscripts(snapshot: ProjectSnapshot, transcriptOf: (mediaId: string) => SourceWord[] | null): TimelineWord[] {
	const words: TimelineWord[] = [];
	const seen = new Set<string>();
	for (const track of orderedTracks(snapshot)) {
		if (track.muted) continue;
		for (const element of track.elements ?? []) {
			if (!element.mediaId || (element.type !== "video" && element.type !== "audio")) continue;
			if (element.isSourceAudioEnabled === false || (element.params as { muted?: unknown } | undefined)?.muted === true) continue;
			const source = transcriptOf(element.mediaId);
			if (!source?.length) continue;
			const rate = rateOf(element);
			const sourceIn = (element.trimStart ?? 0) / TICKS;
			const start = element.startTime / TICKS;
			const length = element.duration / TICKS;
			const sourceOut = sourceIn + length * rate;
			for (const word of source) {
				const middle = (word.start + word.end) / 2;
				if (middle < sourceIn || middle >= sourceOut) continue;
				const a = Math.max(start, start + (word.start - sourceIn) / rate);
				const b = Math.min(start + length, start + (word.end - sourceIn) / rate);
				if (!(b > a)) continue;
				const key = `${word.text}@${a.toFixed(3)}`;
				if (seen.has(key)) continue; // a video and its separated audio saying the same word
				seen.add(key);
				words.push({ text: word.text, start: round(a), end: round(b) });
			}
		}
	}
	return words.sort((x, y) => x.start - y.start);
}

// ─── 2. caption elements ─────────────────────────────────────────────────────────────────────────────────────

const CAPTION_LAYER_NAMES = new Set(["CAPTION WORDS", "CAPTION SHADOW"]);

interface CaptionTagged {
	role?: string;
	captionLayer?: string;
	caption?: { words?: Array<{ text: string; start: number; end: number }> };
}

/** The base caption track (not the words/shadow layers the caption builder adds). */
function captionTrack(snapshot: ProjectSnapshot): SnapshotTrack | null {
	const overlay = activeScene(snapshot)?.tracks?.overlay ?? [];
	const candidates = overlay.filter((track) => {
		if (track.type !== "text") return false;
		const tag = track.restorff as CaptionTagged | undefined;
		return Boolean(tag?.captionLayer) || tag?.role === "caption" || (track.name ?? "").toUpperCase().startsWith("CAPTION");
	});
	return (
		candidates.find((track) => (track.restorff as CaptionTagged | undefined)?.captionLayer === "base") ??
		candidates.find((track) => {
			const tag = track.restorff as CaptionTagged | undefined;
			return !tag?.captionLayer && !CAPTION_LAYER_NAMES.has((track.name ?? "").toUpperCase());
		}) ??
		null
	);
}

export function captionWords(snapshot: ProjectSnapshot): TimelineWord[] {
	const track = captionTrack(snapshot);
	if (!track) return [];
	const words: TimelineWord[] = [];
	for (const element of [...(track.elements ?? [])].sort((a, b) => a.startTime - b.startTime)) {
		const start = element.startTime / TICKS;
		const end = start + element.duration / TICKS;
		const tagged = (element.restorff as CaptionTagged | undefined)?.caption?.words;
		if (tagged?.length) {
			for (const word of tagged) words.push({ text: word.text, start: round(start + word.start), end: round(start + word.end) });
			continue;
		}
		const content = String((element.params as { content?: unknown } | undefined)?.content ?? "").trim();
		const tokens = content.split(/\s+/).filter(Boolean);
		const letters = tokens.reduce((sum, token) => sum + token.length + 1, 0) || 1;
		let cursor = start;
		for (const token of tokens) {
			const span = ((end - start) * (token.length + 1)) / letters;
			words.push({ text: token, start: round(cursor), end: round(cursor + span) });
			cursor += span;
		}
	}
	return words;
}

// ─── finding a word or phrase ───────────────────────────────────────────────────────────────────────────────

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
const token = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");

export type WordMatch =
	| { found: true; index: number; start: number; end: number; matched: string; occurrences: number }
	| { found: false; occurrences: number; vocabulary: string[] };

/**
 * The onset of `phrase` (one word or several in a row, case and punctuation ignored) — its `occurrence`-th time
 * (1-based; default the first). When not found: the distinct words the timeline has, so the caller can pick one.
 */
export function findWord(words: TimelineWord[], phrase: string, occurrence = 1): WordMatch {
	const wanted = phrase.split(/\s+/).map(token).filter(Boolean);
	const tokens = words.map((word) => token(word.text));
	const hits: number[] = [];
	if (wanted.length) {
		for (let i = 0; i + wanted.length <= tokens.length; i++) {
			if (wanted.every((w, k) => tokens[i + k] === w)) hits.push(i);
		}
		// one word given, nothing exact: a word that starts with it ("double" → "doubled")
		if (!hits.length && wanted.length === 1 && wanted[0].length >= 3) {
			tokens.forEach((t, i) => {
				if (t.startsWith(wanted[0])) hits.push(i);
			});
		}
	}
	const pick = hits[Math.max(0, Math.min(hits.length - 1, Math.floor(occurrence) - 1))];
	if (pick === undefined || occurrence > hits.length) {
		const vocabulary = [...new Set(words.map((word) => word.text.replace(/[^\p{L}\p{N}'’-]+/gu, "")).filter(Boolean))].slice(0, 60);
		return { found: false, occurrences: hits.length, vocabulary };
	}
	const last = words[pick + Math.max(0, wanted.length - 1)] ?? words[pick];
	return {
		found: true,
		index: pick,
		start: words[pick].start,
		end: last.end,
		matched: words.slice(pick, pick + Math.max(1, wanted.length)).map((word) => word.text).join(" "),
		occurrences: hits.length,
	};
}

/** Where the sentence holding words[index] ends: at a word ending in . ! ? or before a pause ≥ `pause` seconds. */
export function sentenceEnd(words: TimelineWord[], index: number, pause = 0.6): number {
	for (let i = index; i < words.length; i++) {
		const next = words[i + 1];
		if (/[.!?…]["'”’)]*$/.test(words[i].text.trim())) return words[i].end;
		if (!next || next.start - words[i].end >= pause) return words[i].end;
	}
	return words[words.length - 1]?.end ?? 0;
}
