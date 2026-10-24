/**
 * OTIO cut points → ops@1 (`import_cuts`, EDT-19). Another editor changed the cut (split, trimmed, slipped, moved,
 * removed clips); this turns its OTIO back into split / trim / move / delete ops against a RestorffCut timeline that
 * plays the same media, so the cut comes back at the same frames (±1). A full import (new clips, effects, titles'
 * styling) is out of scope: clips with no counterpart are listed, not created.
 *
 * Pure: `apply` (packages/timeline-ops) is passed in, so tests and the MCP tool run exactly the same logic. Plan:
 *   1. map OTIO tracks → timeline tracks (restorffcut track id, else name, else order within Video / Audio)
 *   2. match each OTIO clip to an element (restorffcut element id, else same media on the mapped track with the most
 *      source overlap; titles by text, graphics by id); several clips on one element = it was split
 *   3. ops: delete elements missing from a mapped track · split elements into their pieces · per changed piece trim
 *      (source in/out) + move (timeline start, and track)
 *   4. apply "direct"; if the reducer refuses (a piece collides on the way) or the result is off by more than a
 *      frame, re-plan "park": changed pieces go to a temporary track, are trimmed there and moved back in order, and
 *      the temporary track is removed — always collision-free when the target layout is
 *   5. verify every piece's start / end / in point against the OTIO, in frames
 */
import type { ProjectSnapshot, SnapshotElement, SnapshotScene, SnapshotTrack } from "@/sync/snapshot";
import { type OtioCut, type OtioTrackCuts, readOtio, validateOtio } from "./interchange-otio";
import { frameRateOf, TICKS_PER_SECOND, ticksPerFrame, toFrames } from "./interchange-timeline";

type Json = Record<string, unknown>;

export interface ApplyLike {
	ok: boolean;
	project: unknown;
	conflicts: Array<{ index?: unknown; op?: unknown; kind?: string; message?: string; target?: string }>;
	changes?: { refs?: Record<string, string> };
}
export type ApplyFn = (project: unknown, ops: unknown[], options: { seed: string; mode?: "atomic" | "best_effort" }) => ApplyLike;

export interface ImportCutsOptions {
	apply: ApplyFn;
	/** Seed for the reducer's ids (same input + seed = same output). */
	seed: string;
	author?: "claude" | "user";
	/**
	 * Elements on a mapped track that no OTIO clip matches:
	 *   "exported" (default) delete only those the OTIO's own export listed on that track (removed in the other editor);
	 *   "all" delete every unmatched element on mapped tracks (for OTIO that lost our metadata);
	 *   "none" never delete.
	 */
	removeMissing?: "exported" | "all" | "none";
	/** Media file names this server knows (media id → name), to match clips whose OTIO lost our metadata. */
	mediaNames?: Record<string, string>;
}

interface Piece {
	/** Element id, or the split ref that names it inside the batch. */
	ref: string;
	elementId?: string;
	element: SnapshotElement;
	track: SnapshotTrack;
	start: number;
	dur: number;
	in: number;
	rate: number;
	sourced: boolean;
	cut: OtioCut;
	targetTrack: SnapshotTrack;
	otioTrack: string;
	target?: { start: number; dur: number; in: number };
	changed?: boolean;
}

export interface TrackReport {
	otio_track: string;
	otio_kind: "Video" | "Audio";
	target_track: string | null;
	target_track_id: string | null;
	mapped_by: "track id" | "name" | "order" | "none";
	clips: number;
	matched: number;
}

export interface ImportCutsReport {
	tracks: TrackReport[];
	counts: { clips: number; matched: number; unmatched: number; splits: number; trims: number; moves: number; deletes: number; unchanged: number };
	unmatched: Array<{ track: string; name: string; start_s: number; end_s: number; reason: string }>;
	deleted: Array<{ element_id: string; name: string; track: string }>;
	/** Unmatched elements left alone (not listed by the export, or remove_missing "none"). */
	kept: Array<{ element_id: string; name: string; track: string }>;
	adjusted: Array<{ element: string; reason: string }>;
	verify: { checked: number; within_one_frame: number; max_error_frames: number; off: Array<{ element: string; want: Json; got: Json | null }> };
	warnings: string[];
	conflicts: ApplyLike["conflicts"];
}

export interface ImportCutsResult {
	ok: boolean;
	strategy: "none" | "direct" | "park";
	ops: Json[];
	project: ProjectSnapshot;
	report: ImportCutsReport;
}

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const sec = (ticks: number) => ticks / TICKS_PER_SECOND;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

function activeScene(snapshot: ProjectSnapshot): SnapshotScene | null {
	const scenes = snapshot.scenes ?? [];
	return scenes.find((scene) => scene.id === snapshot.currentSceneId) ?? scenes.find((scene) => scene.isMain) ?? scenes[0] ?? null;
}

interface TargetTrack {
	track: SnapshotTrack;
	group: "overlay" | "main" | "audio";
	kind: "Video" | "Audio";
}

/** Visual tracks bottom → top (main, then overlay from just above main to the top), then audio from A1 down. */
function targetTracks(scene: SnapshotScene | null): TargetTrack[] {
	if (!scene?.tracks) return [];
	const out: TargetTrack[] = [];
	if (scene.tracks.main) out.push({ track: scene.tracks.main, group: "main", kind: "Video" });
	for (const track of [...(scene.tracks.overlay ?? [])].reverse()) if (track.type !== "effect") out.push({ track, group: "overlay", kind: "Video" });
	for (const track of scene.tracks.audio ?? []) out.push({ track, group: "audio", kind: "Audio" });
	return out;
}

const SOURCED = new Set(["video", "audio"]);
const EXPORTED_TYPES = new Set(["video", "image", "audio", "text", "graphic", "sticker"]);

function rateOf(element: SnapshotElement): number {
	const retime = element.retime as { rate?: number } | undefined;
	return SOURCED.has(element.type) && retime && typeof retime.rate === "number" && retime.rate > 0 ? retime.rate : 1;
}

/** Element types a track type holds (timeline/placement/compatibility.ts). */
function fits(elementType: string, trackType: string): boolean {
	if (trackType === "video") return elementType === "video" || elementType === "image";
	if (trackType === "audio") return elementType === "audio";
	if (trackType === "text") return elementType === "text";
	if (trackType === "graphic") return elementType === "graphic" || elementType === "sticker";
	return false;
}

const roundHalfAway = (value: number) => Math.sign(value) * Math.round(Math.abs(value));

/** Per track (by id), each element's cut points in frames — what "the same cut" is measured on. */
export function cutPointsOf(snapshot: ProjectSnapshot): Array<{ track: string; name: string; clips: Array<{ id: string; name: string; start: number; end: number; in: number }> }> {
	const fps = frameRateOf(snapshot);
	const tpf = ticksPerFrame(fps);
	const scene = activeScene(snapshot);
	return targetTracks(scene).map(({ track }) => ({
		track: track.id,
		name: track.name ?? track.id,
		clips: [...(track.elements ?? [])]
			.sort((a, b) => a.startTime - b.startTime)
			.map((element) => ({
				id: element.id,
				name: element.name ?? "",
				start: toFrames(element.startTime, tpf),
				end: toFrames(element.startTime + element.duration, tpf),
				in: SOURCED.has(element.type) ? toFrames(element.trimStart ?? 0, tpf) : 0,
			})),
	}));
}

export function planImportCuts(snapshot: ProjectSnapshot, otioValue: unknown, options: ImportCutsOptions): ImportCutsResult {
	const errors = validateOtio(otioValue);
	if (errors.length) throw Object.assign(new Error(`not a valid OTIO timeline: ${errors.slice(0, 5).join("; ")}`), { errors });
	const author = options.author ?? "claude";
	const removeMissing = options.removeMissing ?? "exported";
	const fps = frameRateOf(snapshot);
	const tpf = ticksPerFrame(fps);
	const list = readOtio(otioValue, fps);
	const scene = activeScene(snapshot);
	const targets = targetTracks(scene);
	const report: ImportCutsReport = {
		tracks: [],
		counts: { clips: 0, matched: 0, unmatched: 0, splits: 0, trims: 0, moves: 0, deletes: 0, unchanged: 0 },
		unmatched: [],
		deleted: [],
		kept: [],
		adjusted: [],
		verify: { checked: 0, within_one_frame: 0, max_error_frames: 0, off: [] },
		warnings: [...list.warnings],
		conflicts: [],
	};

	// 1. tracks
	const mapping = new Map<OtioTrackCuts, TargetTrack>();
	const taken = new Set<string>();
	const how = new Map<OtioTrackCuts, TrackReport["mapped_by"]>();
	const take = (otio: OtioTrackCuts, target: TargetTrack, by: TrackReport["mapped_by"]) => {
		mapping.set(otio, target);
		taken.add(target.track.id);
		how.set(otio, by);
	};
	for (const otio of list.tracks) {
		const target = otio.trackId ? targets.find((candidate) => candidate.track.id === otio.trackId && candidate.kind === otio.kind) : undefined;
		if (target && !taken.has(target.track.id)) take(otio, target, "track id");
	}
	for (const otio of list.tracks) {
		if (mapping.has(otio)) continue;
		const name = otio.name.trim().toLowerCase();
		const target = targets.find((candidate) => !taken.has(candidate.track.id) && candidate.kind === otio.kind && (candidate.track.name ?? "").trim().toLowerCase() === name);
		if (target) take(otio, target, "name");
	}
	for (const kind of ["Video", "Audio"] as const) {
		const free = targets.filter((candidate) => candidate.kind === kind && !taken.has(candidate.track.id));
		for (const otio of list.tracks.filter((track) => track.kind === kind && !mapping.has(track))) {
			const target = free.shift();
			if (target) take(otio, target, "order");
		}
	}

	// 2. clips → elements
	const index = new Map<string, { element: SnapshotElement; track: SnapshotTrack }>();
	for (const { track } of targets) for (const element of track.elements ?? []) index.set(element.id, { element, track });
	const manifestNames = new Map<string, string>();
	const restorff = (snapshot.metadata?.restorff ?? {}) as { media?: Array<{ id?: string; name?: string }> };
	for (const entry of restorff.media ?? []) if (entry.id && entry.name) manifestNames.set(entry.id, entry.name);
	for (const [id, name] of Object.entries(options.mediaNames ?? {})) manifestNames.set(id, name);
	const nameMatches = (element: SnapshotElement, cut: OtioCut) => {
		const known = element.mediaId ? manifestNames.get(element.mediaId) : undefined;
		if (!known) return false;
		const file = cut.mediaUrl ? decodeURIComponent(cut.mediaUrl.split(/[?#]/)[0].split("/").pop() ?? "") : "";
		return [cut.mediaName, file].some((candidate) => !!candidate && (candidate === known || candidate.endsWith(`-${known}`) || candidate === element.mediaId));
	};

	const sameThing = (element: SnapshotElement, cut: OtioCut) => {
		if (cut.elementId && cut.elementId === element.id) return true;
		if (cut.kind === "media") return (SOURCED.has(element.type) || element.type === "image") && (cut.mediaId ? element.mediaId === cut.mediaId : nameMatches(element, cut));
		if (cut.kind === "text") return element.type === "text" && (element.params as Json | undefined)?.content === cut.text;
		if (cut.kind === "generator") return (element.type === "graphic" || element.type === "sticker") && String(element.definitionId ?? element.stickerId ?? "") === cut.generator;
		return false;
	};
	const sameFrames = (element: SnapshotElement, cut: OtioCut) =>
		toFrames(element.startTime, tpf) === cut.start &&
		toFrames(element.startTime + element.duration, tpf) === cut.end &&
		(!SOURCED.has(element.type) || toFrames(element.trimStart ?? 0, tpf) === cut.inF);

	// 2a. exact: an element already on a clip's frames claims it (so importing the same OTIO twice does nothing, even
	// after a split gave two pieces the same restorffcut element id)
	const exact = new Map<OtioCut, { element: SnapshotElement; track: SnapshotTrack }>();
	const claimed = new Set<string>();
	for (const otio of list.tracks) {
		const target = mapping.get(otio);
		if (!target) continue;
		for (const cut of otio.cuts) {
			const byId = cut.elementId ? index.get(cut.elementId) : undefined;
			const pool = [...(byId ? [byId] : []), ...(target.track.elements ?? []).map((element) => ({ element, track: target.track }))];
			const hit = pool.find(({ element }) => !claimed.has(element.id) && sameThing(element, cut) && sameFrames(element, cut));
			if (hit) {
				exact.set(cut, hit);
				claimed.add(hit.element.id);
			}
		}
	}

	// 2b. the rest: by restorffcut element id, else by media / words / graphic on the mapped track
	const assigned = new Map<string, Array<{ cut: OtioCut; target: TargetTrack; otio: OtioTrackCuts }>>();
	for (const otio of list.tracks) {
		const target = mapping.get(otio) ?? null;
		const trackReport: TrackReport = {
			otio_track: otio.name,
			otio_kind: otio.kind,
			target_track: target?.track.name ?? null,
			target_track_id: target?.track.id ?? null,
			mapped_by: how.get(otio) ?? "none",
			clips: otio.cuts.length,
			matched: 0,
		};
		report.tracks.push(trackReport);
		for (const cut of otio.cuts) {
			report.counts.clips += 1;
			const miss = (reason: string) => {
				report.counts.unmatched += 1;
				report.unmatched.push({ track: otio.name, name: cut.name, start_s: round3(sec(cut.start * tpf)), end_s: round3(sec(cut.end * tpf)), reason });
			};
			if (!target) {
				miss("its track has no counterpart in this timeline (add a track in RestorffCut, then import again)");
				continue;
			}
			let match = exact.get(cut) ?? (cut.elementId ? index.get(cut.elementId) : undefined);
			if (match && !exact.has(cut) && claimed.has(match.element.id)) match = undefined; // that element is another clip's, exactly
			if (match && !fits(match.element.type, target.track.type)) {
				report.warnings.push(`"${cut.name}" sits on ${otio.name} in the OTIO, which cannot hold a ${match.element.type}: kept on ${match.track.name}`);
			}
			if (!match) {
				const candidates = (target.track.elements ?? []).filter((element) => !claimed.has(element.id) && sameThing(element, cut));
				const overlap = (element: SnapshotElement) => {
					if (!SOURCED.has(element.type)) return 0;
					const rate = rateOf(element);
					const from = element.trimStart ?? 0;
					const to = from + Math.round(element.duration * rate);
					return Math.max(0, Math.min(to, cut.ticks.in + (cut.ticks.end - cut.ticks.start) * rate) - Math.max(from, cut.ticks.in));
				};
				candidates.sort(
					(a, b) =>
						overlap(b) - overlap(a) ||
						(assigned.has(a.id) ? 1 : 0) - (assigned.has(b.id) ? 1 : 0) ||
						Math.abs(a.startTime - cut.ticks.start) - Math.abs(b.startTime - cut.ticks.start),
				);
				let best = candidates[0];
				if (!best && cut.kind === "text") {
					// the other editor changed the words: take the title it overlaps most; the text stays RestorffCut's
					const spanOverlap = (element: SnapshotElement) =>
						Math.min(element.startTime + element.duration, cut.ticks.end) - Math.max(element.startTime, cut.ticks.start);
					best = (target.track.elements ?? [])
						.filter((element) => element.type === "text" && !assigned.has(element.id) && !claimed.has(element.id) && spanOverlap(element) > 0)
						.sort((a, b) => spanOverlap(b) - spanOverlap(a))[0];
					if (best) report.warnings.push(`title "${cut.text ?? cut.name}" has different words than "${String((best.params as Json | undefined)?.content ?? "")}": timing taken, RestorffCut's text kept`);
				}
				if (best) match = { element: best, track: target.track };
			}
			if (!match) {
				miss(
					cut.kind === "missing"
						? "no media reference"
						: `no ${cut.kind === "text" ? "title with this text" : cut.kind === "generator" ? "graphic like it" : "clip of this media"} on ${target.track.name}: new clips are not imported (cut points only)`,
				);
				continue;
			}
			trackReport.matched += 1;
			report.counts.matched += 1;
			const list = assigned.get(match.element.id) ?? [];
			list.push({ cut, target: fits(match.element.type, target.track.type) ? target : (targets.find((candidate) => candidate.track.id === match.track.id) ?? target), otio });
			assigned.set(match.element.id, list);
		}
	}

	// 3. deletes, splits, targets
	const deletes: Json[] = [];
	for (const [otio, target] of mapping) {
		const listed = new Set(otio.exportedIds ?? []);
		for (const element of target.track.elements ?? []) {
			if (assigned.has(element.id) || !EXPORTED_TYPES.has(element.type)) continue;
			const entry = { element_id: element.id, name: element.name ?? "", track: target.track.name ?? target.track.id };
			const remove = removeMissing === "all" || (removeMissing === "exported" && listed.has(element.id));
			if (remove) {
				deletes.push({ op: "delete", author, el: element.id });
				report.deleted.push(entry);
			} else {
				report.kept.push(entry);
			}
		}
	}
	report.counts.deletes = deletes.length;

	const splits: Json[] = [];
	const pieces: Piece[] = [];
	let refCount = 0;
	for (const [elementId, cuts] of assigned) {
		const found = index.get(elementId);
		if (!found) continue;
		const { element, track } = found;
		const rate = rateOf(element);
		const sourced = SOURCED.has(element.type);
		const ordered = [...cuts].sort((a, b) => (sourced ? a.cut.ticks.in - b.cut.ticks.in : 0) || a.cut.ticks.start - b.cut.ticks.start);
		const start = element.startTime;
		const end = element.startTime + element.duration;
		// split points inside the element: where each piece's source begins (or, for titles/stills, its offset)
		let points = ordered.slice(1).map(({ cut }) =>
			sourced ? start + roundHalfAway((cut.ticks.in - (element.trimStart ?? 0)) / rate) : start + (cut.ticks.start - ordered[0].cut.ticks.start),
		);
		const natural = points.every((point, i) => point - (i ? points[i - 1] : start) >= tpf) && (points.length === 0 || end - points[points.length - 1] >= tpf);
		if (!natural) {
			const span = Math.floor(element.duration / tpf);
			if (span < ordered.length) {
				report.warnings.push(`${element.name ?? element.id} is ${span} frame(s) long, too short for ${ordered.length} pieces: only the first is used`);
				ordered.length = Math.max(1, span);
			}
			points = ordered.slice(1).map((_, i) => start + Math.round((span * (i + 1)) / ordered.length) * tpf);
		}
		let current = { ref: elementId, start, dur: element.duration, in: element.trimStart ?? 0 };
		ordered.forEach((entry, i) => {
			if (i > 0) {
				const at = points[i - 1];
				const ref = `ic-split-${++refCount}`;
				splits.push({ op: "split", author, el: current.ref, t: sec(at), ref });
				report.counts.splits += 1;
				const relative = at - current.start;
				const leftSource = roundHalfAway(relative * rate);
				pieces[pieces.length - 1].dur = relative;
				current = { ref, start: at, dur: current.start + current.dur - at, in: current.in + leftSource };
			}
			pieces.push({
				ref: current.ref,
				...(i === 0 ? { elementId } : {}),
				element,
				track,
				start: current.start,
				dur: current.dur,
				in: current.in,
				rate,
				sourced,
				cut: entry.cut,
				targetTrack: entry.target.track,
				otioTrack: entry.otio.name,
			});
		});
	}

	for (const piece of pieces) {
		const { cut } = piece;
		const startT = toFrames(piece.start, tpf) === cut.start ? piece.start : cut.start * tpf;
		const endT = toFrames(piece.start + piece.dur, tpf) === cut.end ? piece.start + piece.dur : cut.end * tpf;
		const inT = !piece.sourced ? piece.in : toFrames(piece.in, tpf) === cut.inF ? piece.in : cut.inF * tpf;
		piece.target = { start: startT, dur: Math.max(tpf, endT - startT), in: inT };
		piece.changed = piece.target.start !== piece.start || piece.target.dur !== piece.dur || piece.target.in !== piece.in || piece.targetTrack.id !== piece.track.id;
		if (!piece.changed) report.counts.unchanged += 1;
	}

	const changed = pieces.filter((piece) => piece.changed).sort((a, b) => (a.target?.start ?? 0) - (b.target?.start ?? 0));
	const trimOp = (piece: Piece): Json | null => {
		const target = piece.target!;
		if (target.in === piece.in && target.dur === piece.dur) return null;
		return { op: "trim", author, el: piece.ref, in: sec(target.in), out: sec(target.in + roundHalfAway(target.dur * piece.rate)) };
	};
	const startAfterTrim = (piece: Piece, from: number) => from + (piece.target!.in === piece.in ? 0 : roundHalfAway((piece.target!.in - piece.in) / piece.rate));
	const moveOp = (piece: Piece, track?: string): Json => ({ op: "move", author, el: piece.ref, t: sec(piece.target!.start), ...(track ? { track } : {}) });

	function direct(): Json[] {
		const ops: Json[] = [...deletes, ...splits];
		for (const piece of changed) {
			const trim = trimOp(piece);
			if (trim) ops.push(trim);
			const otherTrack = piece.targetTrack.id !== piece.track.id;
			if (startAfterTrim(piece, piece.start) !== piece.target!.start || otherTrack) ops.push(moveOp(piece, otherTrack ? piece.targetTrack.id : undefined));
		}
		return ops;
	}

	function park(): Json[] {
		const ops: Json[] = [...deletes, ...splits];
		const parkFor = new Map<string, string>();
		const slots = new Map<string, number>();
		const kindOf = (type: string) => (type === "audio" ? "audio" : type === "text" ? "text" : type === "graphic" || type === "sticker" ? "overlay" : "video");
		for (const piece of changed) {
			const kind = kindOf(piece.element.type);
			if (!parkFor.has(kind)) {
				const ref = `ic-park-${kind}`;
				parkFor.set(kind, ref);
				ops.push({ op: "add_track", author, kind, name: "IMPORT · PARK", ref });
			}
			const ref = parkFor.get(kind)!;
			const slot = slots.get(ref) ?? 0;
			const target = piece.target!;
			const leftReach = Math.max(0, roundHalfAway((piece.in - target.in) / piece.rate));
			const at = slot + leftReach;
			ops.push({ op: "move", author, el: piece.ref, t: sec(at), track: ref });
			const trim = trimOp(piece);
			if (trim) ops.push(trim);
			const after = startAfterTrim(piece, at);
			const slotEnd = Math.max(at + piece.dur, after + target.dur) + tpf;
			slots.set(ref, Math.ceil(slotEnd / tpf) * tpf);
		}
		for (const piece of changed) ops.push(moveOp(piece, piece.targetTrack.id));
		for (const ref of parkFor.values()) ops.push({ op: "remove_track", author, track: ref });
		return ops;
	}

	const countOps = (ops: Json[]) => {
		report.counts.trims = ops.filter((op) => op.op === "trim").length;
		report.counts.moves = ops.filter((op) => op.op === "move").length;
	};

	const verify = (result: ApplyLike): ImportCutsReport["verify"] => {
		const project = result.project as ProjectSnapshot;
		const refs = result.changes?.refs ?? {};
		const all = new Map<string, { element: SnapshotElement; track: SnapshotTrack }>();
		for (const { track } of targetTracks(activeScene(project))) for (const element of track.elements ?? []) all.set(element.id, { element, track });
		const out: ImportCutsReport["verify"] = { checked: 0, within_one_frame: 0, max_error_frames: 0, off: [] };
		for (const piece of pieces) {
			const id = piece.elementId ?? refs[piece.ref] ?? piece.ref;
			const found = all.get(id);
			const want = { start: piece.cut.start, end: piece.cut.end, in: piece.sourced ? piece.cut.inF : 0, track: piece.targetTrack.id };
			out.checked += 1;
			if (!found) {
				out.off.push({ element: id, want, got: null });
				continue;
			}
			const got = {
				start: toFrames(found.element.startTime, tpf),
				end: toFrames(found.element.startTime + found.element.duration, tpf),
				in: piece.sourced ? toFrames(found.element.trimStart ?? 0, tpf) : 0,
				track: found.track.id,
			};
			const error = Math.max(Math.abs(got.start - want.start), Math.abs(got.end - want.end), Math.abs(got.in - want.in));
			out.max_error_frames = Math.max(out.max_error_frames, error);
			if (error <= 1 && got.track === want.track) out.within_one_frame += 1;
			else out.off.push({ element: id, want, got });
		}
		return out;
	};

	if (!deletes.length && !splits.length && !changed.length) {
		const identity = { ok: true, project: snapshot, conflicts: [], changes: { refs: {} } } as ApplyLike;
		report.verify = verify(identity);
		return { ok: report.verify.off.length === 0, strategy: "none", ops: [], project: snapshot, report };
	}

	const attempt = (ops: Json[], strategy: "direct" | "park") => {
		const result = options.apply(snapshot, ops, { seed: `${options.seed}/${strategy}`, mode: "atomic" });
		return { result, ops, strategy, checked: result.ok ? verify(result) : null };
	};
	let best = attempt(direct(), "direct");
	if (!best.result.ok || (best.checked && best.checked.off.length)) {
		const second = attempt(park(), "park");
		if (second.result.ok && (!best.result.ok || (second.checked?.off.length ?? 0) <= (best.checked?.off.length ?? 0))) best = second;
	}
	countOps(best.ops);
	if (!best.result.ok) {
		report.conflicts = best.result.conflicts.slice(0, 20);
		return { ok: false, strategy: best.strategy, ops: best.ops, project: snapshot, report };
	}
	report.verify = best.checked!;
	for (const off of report.verify.off) {
		const want = off.want as { start: number };
		const got = off.got as { start: number } | null;
		if (got && got.start === 0 && want.start > 0) report.adjusted.push({ element: off.element, reason: "the main track starts at 0 (the editor's magnetic main track)" });
	}
	return { ok: true, strategy: best.strategy, ops: best.ops, project: best.result.project as ProjectSnapshot, report };
}
