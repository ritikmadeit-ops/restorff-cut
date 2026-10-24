/**
 * Batch state for apply(): what makes the reducer near-linear in the number of ops (reducer-perf agent, 2026-10-20).
 *
 * The reducer before this, per op: structuredClone(draft) as the rollback snapshot, checkInvariants() of the whole
 * scene before AND after the op, linear scans to find an element or an overlap — all O(project), so a batch of n ops
 * cost O(n²) (MEASURED: 2,702 huge-centred caption ops 12–14 s, ~75 % of it in the clone). Same results now from:
 *
 * 1. An UNDO LOG instead of the snapshot. Every change to a track's `elements` goes through the primitives below
 *    (append, replace, removeId, split, setAll, groupsChanged, trackCreated, setTrackProp); each records how to undo
 *    itself. The small containers an op may touch (settings, metadata.restorff, bookmarks, the track groups) are saved
 *    per op by the reducer's savepoint. Placed elements are never mutated — always replaced (copy-on-write) — so
 *    nothing else needs saving.
 * 2. A LIVE INDEX kept by the same primitives: element id → number of occurrences and → its track (find in O(1));
 *    per track an array sorted by startTime while the track is "regular" (finite starts, positive durations, no two
 *    elements overlapping), so an overlap query is a binary search.
 * 3. The MULTISET of checkInvariants() kept up to date incrementally. An element's own problems depend only on
 *    (element, track type, media manifest) and are cached per element object; duplicate-id problems follow from the id
 *    counts; overlap problems are empty on a regular track and recomputed (one sort) only for an irregular track the op
 *    touched. An op introduced a problem iff one of the problems of what it touched is missing from the before-multiset
 *    — the old "after minus before" test, exactly. Only then (a conflict) is the full checkInvariants() run, to word
 *    the message in the same order as before.
 *
 * Fallbacks (still no clone): the media manifest changed in the op → full check for that op. An element or track
 * OBJECT in two places (only a JS-built project can do that; JSON can't) → "legacy" for the rest of the batch: full
 * checks and linear scans, i.e. the old cost, the old results.
 */
import type { MediaManifestEntry, Project, Scene, SceneTracks, TimelineElement, TimelineTrack, TrackType } from "./model.ts";
import {
	checkInvariants,
	duplicateElementProblem,
	duplicateTrackProblem,
	elementProblems,
	endOf,
	groupProblems,
	orderedTracks,
	overlapsAny,
	sortedByStart,
	trackOverlapProblems,
} from "./scene.ts";

type Undo = () => void;
type Media = readonly MediaManifestEntry[] | undefined;
type Found = { track: TimelineTrack; element: TimelineElement; position: number };

/** More changes than this in one setAll: rebuild the track's sorted index instead of patching it. */
const BULK = 32;

function isRegular(element: TimelineElement): boolean {
	return Number.isFinite(element.startTime) && Number.isFinite(element.duration) && element.duration > 0;
}

/** First index whose startTime >= time, in an array sorted by distinct finite starts. */
function lowerBound(sorted: readonly TimelineElement[], time: number): number {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (sorted[mid].startTime < time) low = mid + 1;
		else high = mid;
	}
	return low;
}

/** The sorted overlap index of a sorted element list, or null when it isn't regular. */
function regularOrNull(sorted: TimelineElement[]): TimelineElement[] | null {
	for (let i = 0; i < sorted.length; i++) {
		if (!isRegular(sorted[i])) return null;
		if (i > 0 && sorted[i].startTime < endOf(sorted[i - 1])) return null;
	}
	return sorted;
}

/** Sorted by start, regular and pairwise disjoint (the check regularOrNull makes, without sorting). */
function isRegularSorted(list: readonly TimelineElement[]): boolean {
	for (let i = 0; i < list.length; i++) {
		if (!isRegular(list[i])) return false;
		if (i > 0 && list[i].startTime < endOf(list[i - 1])) return false;
	}
	return true;
}

/**
 * Position of the (unique) element with this id. Six cursors at once — outward from the id's own hint, outward from
 * the last position found on this track, and in from both ends — so it is found in O(distance to the nearest):
 * new elements sit at the end, a clip being cut keeps its id at the front, an element just looked up is near its
 * hint, and a batch walking a track in order finds the next target next to the last one. The two end cursors alone
 * cover every position.
 */
function indexById(elements: readonly TimelineElement[], id: string, hint: number | undefined, last: number | undefined): number {
	const n = elements.length;
	const h = hint !== undefined && hint >= 0 && hint < n ? hint : -1;
	const l = last !== undefined && last >= 0 && last < n && last !== h ? last : -1;
	if (h >= 0 && elements[h].id === id) return h;
	if (l >= 0 && elements[l].id === id) return l;
	const half = (n + 1) >> 1;
	for (let d = 0; d < half; d++) {
		if (h >= 0) {
			const up = h + 1 + d;
			const down = h - 1 - d;
			if (up < n && elements[up].id === id) return up;
			if (down >= 0 && elements[down].id === id) return down;
		}
		if (l >= 0) {
			const up = l + 1 + d;
			const down = l - 1 - d;
			if (up < n && elements[up].id === id) return up;
			if (down >= 0 && elements[down].id === id) return down;
		}
		const back = n - 1 - d;
		if (elements[back].id === id) return back;
		if (elements[d].id === id) return d;
	}
	return -1;
}

const NONE: readonly string[] = [];

/** groupProblems + the duplicate-track-id problems: every problem that is about tracks, not elements. */
function headerProblems(tracks: SceneTracks): string[] {
	const problems = groupProblems(tracks);
	const seen = new Set<string>();
	for (const track of orderedTracks(tracks)) {
		if (seen.has(track.id)) problems.push(duplicateTrackProblem(track.id));
		seen.add(track.id);
	}
	return problems;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

function multiset(list: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1);
	return counts;
}

function writable(track: TimelineTrack): TimelineElement[] {
	return track.elements as TimelineElement[];
}

/**
 * structuredClone keeps aliasing: if the input shares one `elements` array between two tracks (possible only for a
 * JS-built project), give the edited scene's tracks their own arrays — the primitives mutate arrays in place, the
 * old reducer replaced them.
 */
function unshareElementArrays(project: Project, scene: Scene): void {
	const uses = new Map<unknown, number>();
	const tracksOf = (candidate: Scene | undefined): TimelineTrack[] => {
		const tracks = candidate?.tracks;
		if (!tracks) return [];
		const list = [...(Array.isArray(tracks.overlay) ? tracks.overlay : []), tracks.main, ...(Array.isArray(tracks.audio) ? tracks.audio : [])];
		return list.filter((track): track is TimelineTrack => typeof track === "object" && track !== null);
	};
	const scenes = Array.isArray(project.scenes) ? project.scenes : [];
	const counted = new Set<TimelineTrack>();
	for (const candidate of scenes) {
		for (const track of tracksOf(candidate)) {
			if (counted.has(track)) continue;
			counted.add(track);
			uses.set(track.elements, (uses.get(track.elements) ?? 0) + 1);
		}
	}
	for (const track of tracksOf(scene)) {
		if (Array.isArray(track.elements) && (uses.get(track.elements) ?? 0) > 1) {
			uses.set(track.elements, (uses.get(track.elements) ?? 0) - 1);
			(track as { elements: TimelineElement[] }).elements = track.elements.slice();
		}
	}
}

type CommitPlan =
	| { kind: "full"; after: string[] }
	| { kind: "delta"; header?: string[]; overlaps: Map<TimelineTrack, string[]>; inScene: Set<TimelineTrack> };

export class BatchState {
	/** Full checks and linear scans for the rest of the batch (aliased objects in the input). */
	private legacy = false;

	// live index — kept by the primitives, undone with them
	private readonly idCount = new Map<string, number>();
	/** id → its track, only while the id occurs exactly once in the scene. */
	private readonly where = new Map<string, TimelineTrack>();
	/** Per track: elements sorted by startTime while the track is regular; null when it isn't. */
	private readonly sorted = new Map<TimelineTrack, TimelineElement[] | null>();
	/** id → last known position in its track's array: a guess, always verified (never undone). */
	private readonly hints = new Map<string, number>();
	/** track → the position of the last element looked up on it: also a verified guess. */
	private readonly lastAt = new Map<TimelineTrack, number>();

	// the invariant multiset of the state after the last committed op
	private counts = new Map<string, number>();
	private header: string[] = [];
	private readonly overlapsOf = new Map<TimelineTrack, string[]>();
	/**
	 * The own problems (elementProblems) of every placed element that HAS some. Every element in the scene was
	 * evaluated once — at the start of the batch or when an op placed it — so "not here" means "none".
	 */
	private readonly flagged = new Map<TimelineElement, { type: TrackType; list: readonly string[] }>();
	/** elementProblems of the elements the current op placed (computed in check, reused by commit). */
	private readonly opProblems = new Map<TimelineElement, readonly string[]>();
	private mediaRef: Media;
	private mediaLen = 0;

	// the op being applied
	private undo: Undo[] = [];
	private readonly added = new Map<TimelineElement, TimelineTrack>();
	private readonly removed = new Map<TimelineElement, TimelineTrack>();
	private readonly idDelta = new Map<string, number>();
	private readonly touched = new Set<TimelineTrack>();
	private slow = false;
	private plan: CommitPlan | undefined;

	/**
	 * Build at the point where the old reducer ran its first checkInvariants (before the first op's handler), so a
	 * malformed project throws in the same place with the same error.
	 */
	private readonly scene: Scene;

	constructor(project: Project, scene: Scene, media: Media) {
		this.scene = scene;
		const list = checkInvariants(scene, media ?? []);
		unshareElementArrays(project, scene);
		this.counts = multiset(list);
		this.header = headerProblems(scene.tracks);
		this.mediaRef = media;
		this.mediaLen = media?.length ?? 0;
		this.indexScene(media);
	}

	/** (Re)build the live index, the flagged elements and the per-track overlap lists from the scene. */
	private indexScene(media: Media): void {
		this.idCount.clear();
		this.where.clear();
		this.sorted.clear();
		this.overlapsOf.clear();
		this.flagged.clear();
		const seenTracks = new Set<TimelineTrack>();
		const seenElements = new Set<TimelineElement>();
		for (const track of orderedTracks(this.scene.tracks)) {
			if (seenTracks.has(track)) {
				this.legacy = true;
				continue;
			}
			seenTracks.add(track);
			for (const element of track.elements) {
				if (seenElements.has(element)) this.legacy = true;
				seenElements.add(element);
				const count = (this.idCount.get(element.id) ?? 0) + 1;
				this.idCount.set(element.id, count);
				if (count === 1) this.where.set(element.id, track);
				else this.where.delete(element.id);
				const list = elementProblems(element, track.type, media ?? []);
				if (list.length) this.flagged.set(element, { type: track.type, list });
			}
			const sorted = sortedByStart(track.elements);
			const regular = regularOrNull(sorted);
			this.sorted.set(track, regular);
			this.overlapsOf.set(track, regular ? [] : trackOverlapProblems(track.id, sorted));
		}
	}

	// ------------------------------------------------------------ op lifecycle

	begin(): void {
		this.undo = [];
		this.added.clear();
		this.removed.clear();
		this.idDelta.clear();
		this.touched.clear();
		this.opProblems.clear();
		this.slow = false;
		this.plan = undefined;
	}

	/** Undo everything the current op did through the primitives (the reducer restores its savepoint after). */
	rollback(): void {
		for (let i = this.undo.length - 1; i >= 0; i--) this.undo[i]();
		this.begin();
	}

	// ------------------------------------------------------------ live index bookkeeping

	private countId(id: string, delta: number, track: TimelineTrack): void {
		const before = this.idCount.get(id) ?? 0;
		const after = before + delta;
		const whereBefore = this.where.get(id);
		if (after < 0) this.slow = true;
		if (after <= 0) this.idCount.delete(id);
		else this.idCount.set(id, after);
		// `where` is known for 0 → 1 only; after 2 → 1 the holder is unknown (lookups scan, exactly as before).
		if (after === 1 && before === 0) this.where.set(id, track);
		else this.where.delete(id);
		this.idDelta.set(id, (this.idDelta.get(id) ?? 0) + delta);
		this.undo.push(() => {
			if (before <= 0) this.idCount.delete(id);
			else this.idCount.set(id, before);
			if (whereBefore) this.where.set(id, whereBefore);
			else this.where.delete(id);
		});
	}

	private dropIndex(track: TimelineTrack): void {
		const before = this.sorted.get(track);
		if (!before) return;
		this.sorted.set(track, null);
		this.undo.push(() => this.sorted.set(track, before));
	}

	private indexAdd(track: TimelineTrack, element: TimelineElement): void {
		const index = this.sorted.get(track);
		if (!index) return;
		if (!isRegular(element)) return this.dropIndex(track);
		const i = lowerBound(index, element.startTime);
		const previous = index[i - 1];
		const next = index[i];
		if ((previous && endOf(previous) > element.startTime) || (next && next.startTime < endOf(element))) {
			return this.dropIndex(track);
		}
		index.splice(i, 0, element);
		this.undo.push(() => {
			index.splice(i, 1);
		});
	}

	private indexRemove(track: TimelineTrack, element: TimelineElement): void {
		const index = this.sorted.get(track);
		if (!index) return;
		const i = Number.isFinite(element.startTime) ? lowerBound(index, element.startTime) : -1;
		if (i < 0 || index[i] !== element) return this.dropIndex(track); // not where it should be: stop trusting it
		index.splice(i, 1);
		this.undo.push(() => {
			index.splice(i, 0, element);
		});
	}

	private reindex(track: TimelineTrack): void {
		const before = this.sorted.get(track);
		this.sorted.set(track, regularOrNull(sortedByStart(track.elements)));
		this.undo.push(() => {
			if (before === undefined) this.sorted.delete(track);
			else this.sorted.set(track, before);
		});
	}

	private noteAdd(track: TimelineTrack, element: TimelineElement, index = true): void {
		if (this.legacy) return;
		this.touched.add(track);
		if (this.removed.get(element) === track) this.removed.delete(element);
		else {
			if (this.added.has(element)) this.slow = true;
			this.added.set(element, track);
		}
		this.countId(element.id, 1, track);
		if (index) this.indexAdd(track, element);
	}

	private noteRemove(track: TimelineTrack, element: TimelineElement, index = true): void {
		if (this.legacy) return;
		this.touched.add(track);
		if (this.added.get(element) === track) this.added.delete(element);
		else {
			if (this.removed.has(element)) this.slow = true;
			this.removed.set(element, track);
		}
		this.countId(element.id, -1, track);
		if (index) this.indexRemove(track, element);
	}

	/** `old` became `next` on the same track. Same id: the id counts and `where` don't change. */
	private noteReplace(track: TimelineTrack, old: TimelineElement, next: TimelineElement, index = true): void {
		if (this.legacy) return;
		if (old.id !== next.id) {
			this.noteRemove(track, old, index);
			this.noteAdd(track, next, index);
			return;
		}
		this.touched.add(track);
		if (this.added.get(old) === track) this.added.delete(old);
		else {
			if (this.removed.has(old)) this.slow = true;
			this.removed.set(old, track);
		}
		if (this.removed.get(next) === track) this.removed.delete(next);
		else {
			if (this.added.has(next)) this.slow = true;
			this.added.set(next, track);
		}
		if (index) {
			this.indexRemove(track, old);
			this.indexAdd(track, next);
		}
	}

	/** Position of `id` on `track` when the id occurs once in the scene and sits on that track; else -1. */
	private positionOf(track: TimelineTrack, id: string): number {
		if (this.legacy || this.idCount.get(id) !== 1 || this.where.get(id) !== track) return -1;
		return this.locate(track, id);
	}

	/** indexById with this state's guesses; remembers where it found the element. */
	private locate(track: TimelineTrack, id: string): number {
		const position = indexById(track.elements, id, this.hints.get(id), this.lastAt.get(track));
		if (position >= 0) {
			this.hints.set(id, position);
			this.lastAt.set(track, position);
		}
		return position;
	}

	/** After a bulk positional replace: map the sorted index through the pairs (O(k)); sort only if that broke it. */
	private patchIndex(track: TimelineTrack, pairs: ReadonlyArray<readonly [TimelineElement, TimelineElement]>): void {
		const before = this.sorted.get(track);
		if (!before) return; // irregular stays irregular until commit re-checks it
		const swap = new Map(pairs);
		const patched = before.map((element) => swap.get(element) ?? element);
		this.sorted.set(track, isRegularSorted(patched) ? patched : regularOrNull(sortedByStart(track.elements)));
		this.undo.push(() => this.sorted.set(track, before));
	}

	// ------------------------------------------------------------ primitives (the only way the reducer edits tracks)

	/** [...elements, element] */
	append(track: TimelineTrack, element: TimelineElement): void {
		const elements = writable(track);
		const length = elements.length;
		elements.push(element);
		this.undo.push(() => {
			elements.length = length;
		});
		this.hints.set(element.id, length);
		this.noteAdd(track, element);
	}

	/** elements.map(e => e.id === next.id ? next : e) */
	replace(track: TimelineTrack, next: TimelineElement): void {
		const i = this.positionOf(track, next.id);
		if (i < 0) return this.setAll(track, track.elements.map((element) => (element.id === next.id ? next : element)));
		const elements = writable(track);
		const old = elements[i];
		elements[i] = next;
		this.undo.push(() => {
			elements[i] = old;
		});
		this.noteReplace(track, old, next);
	}

	/**
	 * track.elements.map(fn) — `fn` runs once per element, in order, and returns either its argument or a FRESH object
	 * (one not placed anywhere): ripple_delete's shift. Changed positions are same-track replacements.
	 */
	mapElements(track: TimelineTrack, fn: (element: TimelineElement) => TimelineElement): void {
		const old = writable(track);
		const next = old.map(fn);
		(track as { elements: TimelineElement[] }).elements = next;
		this.undo.push(() => {
			(track as { elements: TimelineElement[] }).elements = old;
		});
		if (this.legacy) return;
		const pairs: Array<[TimelineElement, TimelineElement]> = [];
		for (let i = 0; i < next.length; i++) if (next[i] !== old[i]) pairs.push([old[i], next[i]]);
		if (!pairs.length) return;
		const bulk = pairs.length > BULK;
		for (const [before, after] of pairs) this.noteReplace(track, before, after, !bulk);
		if (bulk) this.patchIndex(track, pairs);
	}

	/** elements.filter(e => e.id !== id) */
	removeId(track: TimelineTrack, id: string): void {
		const i = this.positionOf(track, id);
		if (i < 0) return this.setAll(track, track.elements.filter((element) => element.id !== id));
		const elements = writable(track);
		const old = elements[i];
		elements.splice(i, 1);
		this.undo.push(() => {
			elements.splice(i, 0, old);
		});
		this.noteRemove(track, old);
	}

	/** elements.flatMap(e => e.id === id ? [left, right] : [e]) */
	split(track: TimelineTrack, id: string, left: TimelineElement, right: TimelineElement): void {
		const i = this.positionOf(track, id);
		if (i < 0) return this.setAll(track, track.elements.flatMap((element) => (element.id === id ? [left, right] : [element])));
		const elements = writable(track);
		const old = elements[i];
		elements.splice(i, 1, left, right);
		this.undo.push(() => {
			elements.splice(i, 2, old);
		});
		this.hints.set(right.id, i + 1);
		this.noteReplace(track, old, left);
		this.noteAdd(track, right);
	}

	/** track.elements = next (the general case: diffed by identity). */
	setAll(track: TimelineTrack, next: TimelineElement[]): void {
		const old = writable(track);
		(track as { elements: TimelineElement[] }).elements = next;
		this.undo.push(() => {
			(track as { elements: TimelineElement[] }).elements = old;
		});
		if (this.legacy) return;
		if (next.length === old.length && next.every((element, i) => element === old[i])) return;
		const left = new Map<TimelineElement, number>();
		let aliased = false;
		for (const element of old) {
			const count = left.get(element) ?? 0;
			if (count) aliased = true;
			left.set(element, count + 1);
		}
		const fresh: TimelineElement[] = [];
		const seen = new Set<TimelineElement>();
		for (const element of next) {
			if (seen.has(element)) aliased = true;
			seen.add(element);
			const count = left.get(element);
			if (count === undefined) fresh.push(element);
			else if (count === 1) left.delete(element);
			else left.set(element, count - 1);
		}
		if (aliased) {
			this.legacy = true;
			this.slow = true;
			return;
		}
		const bulk = left.size + fresh.length > BULK;
		for (const element of left.keys()) this.noteRemove(track, element, !bulk);
		for (const element of fresh) this.noteAdd(track, element, !bulk);
		if (bulk) this.reindex(track);
	}

	/** A new (empty) track was spliced into a group. */
	trackCreated(track: TimelineTrack): void {
		if (this.legacy) return;
		this.reindex(track);
		this.touched.add(track);
		for (const element of track.elements) this.noteAdd(track, element, false);
	}

	/** The groups were reassigned (remove_track, reorder_tracks, a grade track removed): members before → after. */
	groupsChanged(before: readonly TimelineTrack[], after: readonly TimelineTrack[]): void {
		if (this.legacy) return;
		const now = new Set(after);
		const was = new Set(before);
		if (now.size !== after.length) {
			this.legacy = true;
			this.slow = true;
			return;
		}
		for (const track of was) {
			if (now.has(track)) continue;
			this.touched.add(track);
			for (const element of track.elements) this.noteRemove(track, element, false);
		}
		for (const track of now) {
			if (was.has(track)) continue;
			this.reindex(track);
			this.touched.add(track);
			for (const element of track.elements) this.noteAdd(track, element, false);
		}
	}

	/** track[key] = value (name, muted, hidden). */
	setTrackProp(track: TimelineTrack, key: "name" | "muted" | "hidden", value: string | boolean): void {
		const target = track as unknown as Record<string, unknown>;
		const had = Object.hasOwn(target, key);
		const old = target[key];
		target[key] = value;
		this.undo.push(() => {
			if (had) target[key] = old;
			else delete target[key];
		});
	}

	// ------------------------------------------------------------ queries

	/** The old findElement: first track in display order, first position with that id. */
	findElement(id: string): Found | undefined {
		if (!this.legacy) {
			const count = this.idCount.get(id);
			if (count === undefined) return undefined;
			const track = count === 1 ? this.where.get(id) : undefined;
			if (track) {
				const position = this.locate(track, id);
				if (position >= 0) return { track, element: track.elements[position], position };
			}
		}
		for (const track of orderedTracks(this.scene.tracks)) {
			const position = track.elements.findIndex((element) => element.id === id);
			if (position >= 0) return { track, element: track.elements[position], position };
		}
		return undefined;
	}

	/** overlapsAny(track.elements, start, end, excludeId) !== null, in O(log k) on a regular track. */
	anyOverlap(track: TimelineTrack, start: number, end: number, excludeId?: string): boolean {
		const index = this.legacy ? undefined : this.sorted.get(track);
		if (!index || !Number.isFinite(start) || !Number.isFinite(end)) {
			return overlapsAny(track.elements, start, end, excludeId) !== null;
		}
		// regular: starts and ends both increase along the index, so the last element starting before `end` (skipping
		// the excluded one) has the latest end of all candidates.
		let j = lowerBound(index, end) - 1;
		while (j >= 0 && excludeId && index[j].id === excludeId) j--;
		return j >= 0 && endOf(index[j]) > start;
	}

	// ------------------------------------------------------------ invariants

	/** Own problems of an element the current op placed (computed once per op, reused by commit). */
	private placedProblems(element: TimelineElement, type: TrackType, media: readonly MediaManifestEntry[]): readonly string[] {
		let list = this.opProblems.get(element);
		if (!list) {
			list = elementProblems(element, type, media);
			this.opProblems.set(element, list);
		}
		return list;
	}

	/** Own problems of an element that was in the scene before the op: none unless flagged. */
	private standingProblems(element: TimelineElement, type: TrackType, media: readonly MediaManifestEntry[]): readonly string[] {
		if (!this.flagged.size) return NONE;
		const hit = this.flagged.get(element);
		if (!hit) return NONE;
		return hit.type === type ? hit.list : elementProblems(element, type, media);
	}

	/** Re-evaluate every placed element (after the media manifest changed). */
	private reflag(media: Media): void {
		this.flagged.clear();
		for (const track of orderedTracks(this.scene.tracks)) {
			for (const element of track.elements) {
				const list = elementProblems(element, track.type, media ?? []);
				if (list.length) this.flagged.set(element, { type: track.type, list });
			}
		}
	}

	private bump(list: readonly string[], sign: 1 | -1): void {
		for (const problem of list) {
			const count = (this.counts.get(problem) ?? 0) + sign;
			if (count <= 0) this.counts.delete(problem);
			else this.counts.set(problem, count);
		}
	}

	/**
	 * The problems the op introduced, in checkInvariants' order (empty = none) — the old
	 * `checkInvariants(after).filter(p => !before.has(p))`. Call after the handler, then commit() or rollback().
	 */
	check(media: Media): string[] {
		const list = media ?? [];
		const isNew = (problem: string) => !this.counts.has(problem);
		const length = media?.length ?? 0;
		const mediaChanged = length !== this.mediaLen || (media !== this.mediaRef && length > 0);
		if (this.legacy || this.slow || mediaChanged) {
			const after = checkInvariants(this.scene, list);
			const introduced = after.filter(isNew);
			if (!introduced.length) this.plan = { kind: "full", after };
			return introduced;
		}
		let suspect = false;
		const header = headerProblems(this.scene.tracks);
		const headerChanged = !sameList(header, this.header);
		if (headerChanged && header.some(isNew)) suspect = true;
		for (const [element, track] of this.added) {
			if (suspect) break;
			const own = this.placedProblems(element, track.type, list);
			if (own.length && own.some(isNew)) suspect = true;
		}
		for (const [id, delta] of this.idDelta) {
			if (suspect) break;
			if (delta !== 0 && (this.idCount.get(id) ?? 0) > 1 && isNew(duplicateElementProblem(id))) suspect = true;
		}
		const overlaps = new Map<TimelineTrack, string[]>();
		const inScene = new Set<TimelineTrack>(this.touched.size ? orderedTracks(this.scene.tracks) : []);
		for (const track of this.touched) {
			const found = !inScene.has(track) || this.sorted.get(track) ? [] : trackOverlapProblems(track.id, sortedByStart(track.elements));
			overlaps.set(track, found);
			if (!suspect && found.some(isNew)) suspect = true;
		}
		if (suspect) {
			// Something the op touched has a problem the state before didn't: word it exactly as the old reducer did.
			const after = checkInvariants(this.scene, list);
			const introduced = after.filter(isNew);
			if (!introduced.length) this.plan = { kind: "full", after };
			return introduced;
		}
		this.plan = { kind: "delta", header: headerChanged ? header : undefined, overlaps, inScene };
		return [];
	}

	/** Make the op's changes the new "before". */
	commit(media: Media): void {
		const plan = this.plan;
		this.plan = undefined;
		if (!plan || plan.kind === "full") {
			this.recount(plan?.after ?? checkInvariants(this.scene, media ?? []), media);
		} else {
			const list = media ?? [];
			for (const [element, track] of this.removed) {
				const own = this.standingProblems(element, track.type, list);
				if (own.length) {
					this.bump(own, -1);
					this.flagged.delete(element);
				}
			}
			for (const [element, track] of this.added) {
				const own = this.placedProblems(element, track.type, list);
				if (own.length) {
					this.bump(own, 1);
					this.flagged.set(element, { type: track.type, list: own });
				}
			}
			for (const [id, delta] of this.idDelta) {
				if (!delta) continue;
				const now = this.idCount.get(id) ?? 0;
				const change = Math.max(0, now - 1) - Math.max(0, now - delta - 1);
				if (change) this.bump(Array(Math.abs(change)).fill(duplicateElementProblem(id)), change > 0 ? 1 : -1);
			}
			for (const [track, overlaps] of plan.overlaps) {
				const before = this.overlapsOf.get(track) ?? [];
				if (before.length) this.bump(before, -1);
				if (overlaps.length) this.bump(overlaps, 1);
				if (plan.inScene.has(track)) {
					this.overlapsOf.set(track, overlaps);
					if (!overlaps.length && !this.sorted.get(track)) this.sorted.set(track, regularOrNull(sortedByStart(track.elements)));
				} else {
					this.overlapsOf.delete(track);
					this.sorted.delete(track);
				}
			}
			if (plan.header) {
				this.bump(this.header, -1);
				this.bump(plan.header, 1);
				this.header = plan.header;
			}
		}
		this.begin();
	}

	/** After a full check: the multiset from the list itself; every element re-evaluated (the media may have changed). */
	private recount(after: string[], media: Media): void {
		this.counts = multiset(after);
		this.header = headerProblems(this.scene.tracks);
		this.mediaRef = media;
		this.mediaLen = media?.length ?? 0;
		if (this.slow || this.legacy) {
			this.indexScene(media); // re-derive the live index; marks legacy again if objects are still aliased
			return;
		}
		this.reflag(media);
		for (const track of orderedTracks(this.scene.tracks)) {
			if (this.sorted.get(track)) {
				this.overlapsOf.set(track, []);
				continue;
			}
			const sorted = sortedByStart(track.elements);
			const regular = regularOrNull(sorted);
			this.sorted.set(track, regular);
			this.overlapsOf.set(track, regular ? [] : trackOverlapProblems(track.id, sorted));
		}
	}

	/**
	 * Test-only self-check (applyWithSelfCheck): the incremental state must equal a rebuild from scratch. Throws on
	 * any drift. O(project) — never on in production.
	 */
	verify(media: Media): void {
		if (this.legacy) return;
		const expected = multiset(checkInvariants(this.scene, media ?? []));
		const drift: string[] = [];
		for (const [problem, count] of expected) if (this.counts.get(problem) !== count) drift.push(`${problem} (${this.counts.get(problem) ?? 0} ≠ ${count})`);
		for (const [problem, count] of this.counts) if (!expected.has(problem)) drift.push(`${problem} (${count} ≠ 0)`);
		if (drift.length) throw new Error(`reducer-state: invariant multiset drifted: ${drift.join(" | ")}`);
		const ids = new Map<string, number>();
		const holder = new Map<string, TimelineTrack>();
		let flaggedInScene = 0;
		for (const track of orderedTracks(this.scene.tracks)) {
			for (const element of track.elements) {
				ids.set(element.id, (ids.get(element.id) ?? 0) + 1);
				holder.set(element.id, track);
				const own = elementProblems(element, track.type, media ?? []);
				const flag = this.flagged.get(element);
				if (own.length ? !flag || !sameList(own, flag.list) : flag) {
					throw new Error(`reducer-state: flagged problems of element ${element.id} are stale`);
				}
				if (flag) flaggedInScene++;
			}
			const index = this.sorted.get(track);
			if (index === undefined) throw new Error(`reducer-state: track ${track.id} has no index entry`);
			if (index) {
				const fresh = sortedByStart(track.elements);
				if (!regularOrNull(fresh) || fresh.length !== index.length || fresh.some((element, i) => element !== index[i])) {
					throw new Error(`reducer-state: sorted index of track ${track.id} is stale`);
				}
			}
			const overlaps = trackOverlapProblems(track.id, sortedByStart(track.elements));
			if (!sameList(overlaps, this.overlapsOf.get(track) ?? [])) throw new Error(`reducer-state: overlap list of track ${track.id} is stale`);
		}
		if (ids.size !== this.idCount.size || [...ids].some(([id, count]) => this.idCount.get(id) !== count)) {
			throw new Error("reducer-state: id counts drifted");
		}
		for (const [id, track] of this.where) {
			if (ids.get(id) !== 1 || holder.get(id) !== track) throw new Error(`reducer-state: where(${id}) is stale`);
		}
		if (flaggedInScene !== this.flagged.size) throw new Error("reducer-state: flagged holds elements no longer placed");
		if (this.undo.length) throw new Error("reducer-state: undo log not cleared after commit");
	}
}
