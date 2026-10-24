/**
 * Pure helpers for the JUDGE row (review/timeline-markers.tsx) — ui-fix-timeline agent, 2026-10-21, from
 * docs/restorff/QA-2026-10-20.md:
 *
 * - #2  a finding's element is looked up on whatever lane it sits on NOW. The gate pins some findings to a role's
 *       lane (R5 → V2 B-ROLL) while the element lives elsewhere (MOTION); selecting {that lane, that element} matched
 *       nothing and the inspector went blank until reload.
 * - #10 markers that would overlap become ONE marker with a count that opens a list (4 findings at 0:00 were
 *       stacked and only the top one was clickable), and the same finding posted twice under two ids (the gate's
 *       R5 at 0:21.08) is drawn once.
 */
import { severityRank } from "./markers";

export interface ElementRef {
	trackId: string;
	elementId: string;
}

export interface TrackWithElements {
	id: string;
	elements: ReadonlyArray<{ id: string }>;
}

/**
 * The element a finding points at, on the lane it lives on now (the pinned lane first). null when the finding names
 * no element or the element is gone — then nothing should be selected (the selection stays as it was).
 */
export function resolveFindingTarget(
	tracks: ReadonlyArray<TrackWithElements>,
	ref: { track_id: string | null; element_id: string | null },
): ElementRef | null {
	const elementId = ref.element_id;
	if (!elementId) return null;
	const holds = (track: TrackWithElements) => track.elements.some((el) => el.id === elementId);
	const pinned = ref.track_id ? tracks.find((t) => t.id === ref.track_id) : undefined;
	if (pinned && holds(pinned)) return { trackId: pinned.id, elementId };
	const owner = tracks.find(holds);
	return owner ? { trackId: owner.id, elementId } : null;
}

/** The fields de-duplication and clustering read (a RemoteComment has them all). */
export interface RowComment {
	id: string;
	time_s: number;
	time_end_s: number | null;
	rule_id: string | null;
	severity: "must" | "should" | "could" | "info" | null;
	status: "open" | "resolved";
	body: string;
	created_at?: string | null;
}

/** Same rule, same time span, same words, same severity = the same finding, whatever its id. */
export function duplicateKey(c: RowComment): string {
	const ms = (s: number | null) => (s === null || s === undefined ? "-" : String(Math.round(s * 1000)));
	return [c.rule_id ?? "", ms(c.time_s), ms(c.time_end_s), c.severity ?? "", (c.body ?? "").trim()].join("|");
}

export interface DedupedMarker<T extends RowComment> {
	comment: T;
	/** Ids of the hidden copies (resolve them with the shown one). */
	duplicateIds: string[];
}

/**
 * One marker per finding. The copy kept: the one whose element still exists (`isLive`), then an open one over a
 * resolved one, then the newest. Order of the input is kept (by the kept copy's first appearance).
 */
export function dedupeMarkers<T extends RowComment>(
	comments: ReadonlyArray<T>,
	isLive: (comment: T) => boolean = () => true,
): DedupedMarker<T>[] {
	const groups = new Map<string, T[]>();
	const order: string[] = [];
	for (const c of comments) {
		const key = duplicateKey(c);
		const group = groups.get(key);
		if (group) group.push(c);
		else {
			groups.set(key, [c]);
			order.push(key);
		}
	}
	return order.map((key) => {
		const group = groups.get(key)!;
		if (group.length === 1) return { comment: group[0], duplicateIds: [] };
		const ranked = [...group].sort((a, b) => {
			const live = Number(isLive(b)) - Number(isLive(a));
			if (live) return live;
			const open = Number(b.status === "open") - Number(a.status === "open");
			if (open) return open;
			return (b.created_at ?? "").localeCompare(a.created_at ?? "");
		});
		return { comment: ranked[0], duplicateIds: ranked.slice(1).map((c) => c.id) };
	});
}

export interface MarkerCluster<T> {
	/** Stable while the same markers overlap: their ids, sorted. */
	key: string;
	/** Left edge (px) of the cluster's square: its first member's. */
	left: number;
	members: T[];
}

/**
 * Groups markers whose squares would overlap at the current zoom (left edges closer than `size` px to the
 * group's first square). Members come out loudest first: open before resolved, must → should → info → note.
 */
export function clusterMarkers<T extends { id: string; severity: RowComment["severity"]; status: RowComment["status"] }>(
	items: ReadonlyArray<T>,
	leftOf: (item: T) => number,
	size: number,
): MarkerCluster<T>[] {
	const sorted = [...items].map((item) => ({ item, left: leftOf(item) })).sort((a, b) => a.left - b.left);
	const clusters: Array<{ left: number; members: T[] }> = [];
	for (const { item, left } of sorted) {
		const last = clusters[clusters.length - 1];
		if (last && left - last.left < size) last.members.push(item);
		else clusters.push({ left, members: [item] });
	}
	return clusters.map(({ left, members }) => {
		const loudestFirst = [...members].sort(compareLoudness);
		return { key: members.map((m) => m.id).sort().join(" "), left, members: loudestFirst };
	});
}

/** Open before resolved, then must → should → could/note → info. */
export function compareLoudness(
	a: { severity: RowComment["severity"]; status: RowComment["status"] },
	b: { severity: RowComment["severity"]; status: RowComment["status"] },
): number {
	if (a.status !== b.status) return a.status === "open" ? -1 : 1;
	return severityRank(a.severity) - severityRank(b.severity);
}
