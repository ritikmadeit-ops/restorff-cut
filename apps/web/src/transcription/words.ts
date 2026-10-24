import type { TranscriptionSegment, TranscriptionWord } from "./types";

/**
 * Word timings when the model only gave segment timings: each segment's time is split across its words by letter
 * count (plus one for the gap). Marked "approximate" by the caller — good enough for captions, rough for cuts.
 */
export function splitSegmentsIntoWords({
	segments,
}: {
	segments: TranscriptionSegment[];
}): TranscriptionWord[] {
	const words: TranscriptionWord[] = [];
	for (const segment of segments) {
		const tokens = segment.text.trim().split(/\s+/).filter(Boolean);
		if (!tokens.length) continue;
		const start = Math.max(0, segment.start);
		const end = Math.max(start, segment.end);
		const weights = tokens.map((token) => token.length + 1);
		const total = weights.reduce((sum, weight) => sum + weight, 0);
		let cursor = start;
		tokens.forEach((token, index) => {
			const span = ((end - start) * weights[index]) / total;
			words.push({ text: token, start: cursor, end: cursor + span * 0.9 });
			cursor += span;
		});
	}
	return words;
}

/**
 * Clean the model's word chunks: trim, glue punctuation-only chunks to the previous word, drop empty ones, keep times
 * monotonic, give zero-length words a minimum length.
 */
export function normalizeWords({
	words,
}: {
	words: TranscriptionWord[];
}): TranscriptionWord[] {
	const result: TranscriptionWord[] = [];
	for (const raw of words) {
		const text = raw.text.trim();
		if (!text) continue;
		const previous = result[result.length - 1];
		if (previous && /^[.,!?;:%…'"’)\]-]+$/.test(text)) {
			previous.text += text;
			previous.end = Math.max(previous.end, raw.end);
			continue;
		}
		const start = Math.max(previous ? previous.start : 0, raw.start);
		const end = Math.max(start + 0.04, raw.end);
		result.push({ text, start, end });
	}
	return result;
}
