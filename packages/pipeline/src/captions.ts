/**
 * Width-aware caption chunks. timeline-ops' chunker (chunkWords) limits words per chunk (1-3) but not width, and at
 * reel caption sizes a 3-word chunk like "continuously keep telling" overflows a 1080 px frame on both sides (SEEN in
 * the first demo render; the Judge's OCR flagged it as CAP 'tellir' / 'ntinuously'). Here a chunk also ends when the
 * next word would push it past `maxChars`, and any chunk still wider than `maxWidthPx` gets a smaller font.
 *
 * Width model (ASSUMPTION, checked by eye on renders): bold sans glyphs average `charEm` = 0.55 em per character
 * including spaces (MEASURED ~0.46 em for Arial Bold lowercase in the first demo frame; 0.55 leaves margin for capitals
 * and wide letters).
 */
import type { TimedWord } from "@restorffcut/timeline-ops";

export interface CaptionChunkPlan {
	words: TimedWord[];
	text: string;
	start: number;
	end: number;
	/** Editor font-size units for this chunk (px = size × canvasHeight / 90). */
	size: number;
	estWidthPx: number;
}

export interface CaptionLayout {
	canvasHeight: number;
	/** Base editor font size. */
	size: number;
	maxWords?: number;
	/** Widest the caption box may be (text + both paddings), px. Default 860 (110 px margins on 1080). */
	maxWidthPx?: number;
	paddingX?: number;
	charEm?: number;
	/** A pause longer than this always ends a chunk; shorter gaps are bridged (seconds). Default 0.3. */
	gap?: number;
	/** Smallest size a long single word may shrink to. Default 3. */
	minSize?: number;
}

const BREAK_AFTER = /[.!?,;:]$/;

export function estimateWidthPx(text: string, size: number, layout: CaptionLayout): number {
	const px = (size * layout.canvasHeight) / 90;
	return text.length * px * (layout.charEm ?? 0.55) + 2 * (layout.paddingX ?? 30);
}

export function chunkCaptions(words: readonly TimedWord[], layout: CaptionLayout): CaptionChunkPlan[] {
	const maxWords = Math.min(3, Math.max(1, layout.maxWords ?? 3));
	const maxWidth = layout.maxWidthPx ?? 860;
	const gap = layout.gap ?? 0.3;
	const fits = (text: string) => estimateWidthPx(text, layout.size, layout) <= maxWidth;

	const groups: TimedWord[][] = [];
	let current: TimedWord[] = [];
	for (const raw of words) {
		const word = { ...raw, text: raw.text.trim() };
		if (!word.text) continue;
		const previous = current[current.length - 1];
		const candidate = [...current.map((w) => w.text), word.text].join(" ");
		const startsNew =
			current.length > 0 &&
			(current.length >= maxWords ||
				word.start - (previous as TimedWord).end > gap ||
				BREAK_AFTER.test((previous as TimedWord).text) ||
				!fits(candidate));
		if (startsNew) {
			groups.push(current);
			current = [];
		}
		current.push(word);
	}
	if (current.length) groups.push(current);

	const chunks: CaptionChunkPlan[] = groups.map((group) => {
		const text = group.map((w) => w.text).join(" ");
		let size = layout.size;
		while (estimateWidthPx(text, size, layout) > maxWidth && size > (layout.minSize ?? 3)) {
			size = Math.round((size - 0.25) * 100) / 100;
		}
		return {
			words: group.map((w) => ({ ...w })),
			text,
			start: group[0].start,
			end: group[group.length - 1].end,
			size,
			estWidthPx: Math.round(estimateWidthPx(text, size, layout)),
		};
	});
	// Bridge short pauses so captions don't flicker; never overlap the next chunk (same rule as chunkWords).
	for (let i = 0; i < chunks.length - 1; i++) {
		const next = chunks[i + 1];
		if (next.start - chunks[i].end <= gap) chunks[i].end = next.start;
		if (chunks[i].end > next.start) chunks[i].end = next.start;
		const last = chunks[i].words[chunks[i].words.length - 1];
		last.end = chunks[i].end;
	}
	return chunks.filter((chunk) => chunk.end > chunk.start);
}
