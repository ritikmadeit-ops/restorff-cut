/**
 * Lane hygiene for effects (effects-v2 agent, 2026-10-20; SUMMARY gap 18b, recreation E-8: MOTION 8, MOTION
 * BACK/FRONT 1–3, two V2 CUTOUT tracks, captions pushed under MOTION).
 *
 * THE LAYER ORDER effects keep (overlay index 0 = top of the stack; the main track V1 A-ROLL is under everything):
 *
 *   rank 0  TEXT · CAPTIONS · CAPTION WORDS · CAPTION SHADOW   text lanes: captions stay on top
 *   rank 1  MOTION, MOTION 2 …                                 overlay compositions (effects, custom code)
 *   rank 2  FX, FX 2 …                                         shader effect layers (Digital Zoom…): they act on
 *                                                              everything under them, the person stack included
 *   rank 3  V2 B-ROLL, GRADE, other footage / unknown lanes
 *   rank 4  MOTION FRONT …                                     person effects, above the person
 *   rank 5  V2 CUTOUT                                          the person (span-limited segments, one lane)
 *   rank 6  MOTION BACK …                                      person effects, behind the person
 *           (the clip the person is cut from: V1 A-ROLL, or its overlay lane right under the block)
 *
 * Rules: a new lane goes where its rank says (never index 0 above the captions); a free lane of the same role is
 * always reused first (free = no element overlaps the window); MOTION BACK lanes sit directly under their V2 CUTOUT
 * lane and MOTION FRONT lanes directly over it, so back/front pairs stay adjacent; nothing here reorders existing
 * lanes (other tools re-running — captions on index 0 — keep this order because effects never go above rank 0).
 */
import type { SnapshotTrack } from "@/sync/snapshot";

export const LANE_ORDER = [
	"TEXT / CAPTIONS (rank 0, top)",
	"MOTION, MOTION 2 … (rank 1)",
	"FX, FX 2 … (rank 2)",
	"V2 B-ROLL, GRADE, other footage (rank 3)",
	"MOTION FRONT … (rank 4)",
	"V2 CUTOUT (rank 5)",
	"MOTION BACK … (rank 6)",
	"the clip: V1 A-ROLL (main)",
] as const;

export const MOTION = "MOTION";
export const MOTION_BACK = "MOTION BACK";
export const MOTION_FRONT = "MOTION FRONT";
export const FX_LANE = "FX";
export const CUTOUT_LANE = "V2 CUTOUT";

const upper = (track: SnapshotTrack | undefined) => (track?.name ?? "").toUpperCase();
const role = (track: SnapshotTrack) => (track.restorff as { role?: string } | undefined)?.role;

export const isMotionLane = (track: SnapshotTrack) => track.type === "video" && /^MOTION( \d+)?$/.test(upper(track));
export const isBackLane = (track: SnapshotTrack | undefined) => !!track && track.type === "video" && upper(track).startsWith(MOTION_BACK);
export const isFrontLane = (track: SnapshotTrack | undefined) => !!track && track.type === "video" && upper(track).startsWith(MOTION_FRONT);
export const isCutoutLane = (track: SnapshotTrack | undefined) => !!track && track.type === "video" && upper(track).startsWith(CUTOUT_LANE);
export const isFxLane = (track: SnapshotTrack) => track.type === "effect" && role(track) !== "grade" && upper(track).startsWith(FX_LANE);

export function laneRank(track: SnapshotTrack): number {
	if (track.type === "text" || track.type === "caption" || role(track) === "caption" || upper(track).startsWith("CAPTION")) return 0;
	if (isMotionLane(track)) return 1;
	if (isFxLane(track)) return 2;
	if (isFrontLane(track)) return 4;
	if (isCutoutLane(track)) return 5;
	if (isBackLane(track)) return 6;
	return 3;
}

/** Where a new lane of `rank` goes: just above the first lane ranked below it (top → bottom). */
export function insertIndexFor(overlay: SnapshotTrack[], rank: number): number {
	const index = overlay.findIndex((track) => laneRank(track) > rank);
	return index >= 0 ? index : overlay.length;
}

const overlapsWindow = (track: SnapshotTrack, start: number, end: number) =>
	(track.elements ?? []).some((el) => start < el.startTime + el.duration && end > el.startTime);

export const laneFree = (track: SnapshotTrack, start: number, end: number) => !overlapsWindow(track, start, end);

/** Indexes of the MOTION FRONT lanes directly above and MOTION BACK lanes directly below the cutout lane at `index`. */
export function personBlock(overlay: SnapshotTrack[], cutoutIndex: number): { fronts: number[]; backs: number[] } {
	const fronts: number[] = [];
	for (let i = cutoutIndex - 1; i >= 0 && isFrontLane(overlay[i]); i--) fronts.push(i);
	const backs: number[] = [];
	for (let i = cutoutIndex + 1; i < overlay.length && isBackLane(overlay[i]); i++) backs.push(i);
	return { fronts, backs };
}

/** The next free name of a lane family ("MOTION BACK" → "MOTION BACK 2" when one exists). */
export function nextLaneName(overlay: SnapshotTrack[], prefix: string, extra = 0): string {
	const family = overlay.filter((track) => {
		const name = upper(track);
		if (prefix === MOTION) return isMotionLane(track);
		return name === prefix || name.startsWith(`${prefix} `);
	}).length + extra;
	return family ? `${prefix} ${family + 1}` : prefix;
}

/** Lanes top → bottom with their rank, for answers ("lanes") and the worklog's checks. */
export function laneView(overlay: SnapshotTrack[]): Array<{ index: number; name: string; rank: number }> {
	return overlay.map((track, index) => ({ index, name: track.name ?? track.id, rank: laneRank(track) }));
}

/** Lanes out of the documented order (a lane ranked above one over it), e.g. MOTION over CAPTIONS from older applies. */
export function laneDrift(overlay: SnapshotTrack[]): string[] {
	const out: string[] = [];
	for (let i = 1; i < overlay.length; i++) {
		const above = overlay[i - 1];
		const here = overlay[i];
		const a = laneRank(above);
		const b = laneRank(here);
		// the person block (4-6) may sit under any footage lane; text lanes behind the person (BEHIND TEXT…) are fine
		if (b < a && !(b === 0 && a >= 4) && !(b === 3 && a >= 4)) out.push(`${here.name ?? here.id} (rank ${b}) sits under ${above.name ?? above.id} (rank ${a})`);
	}
	return out;
}
