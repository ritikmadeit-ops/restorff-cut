/**
 * The compact default of `timeline summary` (timing-helper, 2026-10-21; effects-library-nitro REPORT "Where Sonnet got
 * stuck" 4: "timeline summary ≈ 109 kB"). On a captioned timeline the six caption-layer tracks are ~85 % of the summary
 * (fe364b51-…: 53,793 of 64,508 chars), so a bare `summary` buried the clips a model came to read.
 *
 * Rule: a bare summary (no track, element_ids, from_s/to_s, offset or full) whose full answer is over
 * COMPACT_OVER_CHARS answers every track's header + count + span and its first COMPACT_PER_TRACK elements (same
 * compact element view, exact seconds); `track` gives one track in full, `full: true` the old answer (pages with
 * offset). A summary that fits under the threshold is answered whole, exactly as before. Pure.
 */
import type { ProjectSnapshot, SnapshotElement } from "@/sync/snapshot";
import { exactSeconds, scrubData } from "./timeline-read-hygiene";
import { compactElement, summaryView, tracksOf } from "./timeline-read";

export const COMPACT_OVER_CHARS = 20_000;
export const COMPACT_PER_TRACK = 5;

const startOf = (element: SnapshotElement) => (typeof element.startTime === "number" ? element.startTime : 0);
const durOf = (element: SnapshotElement) => (typeof element.duration === "number" ? element.duration : 0);

/**
 * `compact: false` → `summary` is the full summaryView answer (it fit). `compact: true` → the per-track first page.
 */
export function compactSummaryView(snapshot: ProjectSnapshot, { overChars = COMPACT_OVER_CHARS, perTrack = COMPACT_PER_TRACK } = {}) {
	const full = summaryView(snapshot);
	if (!("summary" in full) || !full.summary) return { compact: false as const, summary: null };
	const fullChars = JSON.stringify(full.summary).length;
	if (fullChars <= overChars && full.nextOffset === null) return { compact: false as const, summary: full.summary };
	const { tracks: _tracks, page: _page, ...envelope } = full.summary as typeof full.summary & { page?: unknown };
	let listed = 0;
	let total = 0;
	const tracks = tracksOf(snapshot).map(({ track, group, index }) => {
		const elements = [...(track.elements ?? [])].sort((a, b) => startOf(a) - startOf(b));
		const shown = elements.slice(0, perTrack).map((element) => scrubData(compactElement(element)).value);
		listed += shown.length;
		total += elements.length;
		const first = elements[0];
		const lastEnd = elements.reduce((end, element) => Math.max(end, startOf(element) + durOf(element)), 0);
		return {
			id: track.id,
			index,
			group,
			name: track.name ?? null,
			type: track.type,
			...(track.restorff?.role ? { role: track.restorff.role } : {}),
			...(track.hidden ? { hidden: true } : {}),
			...(track.muted ? { muted: true } : {}),
			count: elements.length,
			...(first ? { span: { from: exactSeconds(startOf(first)), to: exactSeconds(lastEnd) } } : {}),
			elements: shown,
			...(elements.length > shown.length ? { more: elements.length - shown.length } : {}),
		};
	});
	return {
		compact: true as const,
		full_chars: fullChars,
		summary: {
			...envelope,
			tracks,
			page: {
				compact: true,
				per_track: perTrack,
				listed,
				total,
				note: `Compact view (the default when the whole summary is over ${overChars.toLocaleString("en-US")} chars; this one is ${fullChars.toLocaleString("en-US")}): every track's count and span, and its first ${perTrack} elements. One track in full: track: <its id or name>. Everything: full: true (pages with offset, as before). One element in full: action element.`,
			},
		},
	};
}
