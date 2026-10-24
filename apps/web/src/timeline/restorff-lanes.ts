import type { SceneTracks, TimelineTrack } from "@/timeline";

/**
 * The fixed lanes of the Edit artboard (design/edit-artboard.png): TEXT · CAPTIONS · V2 B-ROLL · V1 A-ROLL · MUSIC ·
 * SFX. The gateway's skeleton (`restorff/apps/gateway/src/editor-skeleton.mjs`) creates them empty; ops fill them.
 * V1 A-ROLL is the main track, which the editor never removes, so it is not listed here.
 */
export type RestorffLane = "TEXT" | "CAPTIONS" | "V2 B-ROLL" | "MUSIC" | "SFX";

type LaneTrack = Pick<TimelineTrack, "id" | "type" | "name"> & { restorff?: { role?: string } };

/** Which Restorff lane a track is, from its ops@1 role tag (`restorff.role`) first, then its exact name. */
export function getRestorffLane(track: LaneTrack): RestorffLane | null {
	const role = track.restorff?.role;
	const name = (track.name ?? "").trim().toUpperCase();
	switch (track.type) {
		case "text":
			if (role === "caption" || name === "CAPTIONS") return "CAPTIONS";
			if (role === "text" || name === "TEXT") return "TEXT";
			return null;
		case "video":
			if (role === "broll" || name === "V2 B-ROLL") return "V2 B-ROLL";
			return null;
		case "audio":
			if (role === "sfx" || name === "SFX") return "SFX";
			if (role === "music" || name === "MUSIC") return "MUSIC";
			return null;
		default:
			return null;
	}
}

/**
 * Returns a predicate for the editor's empty-track cleanup: `true` = keep this EMPTY track because it is the one
 * track holding its Restorff lane. A lane already held by a track with elements keeps no empty duplicate; among
 * empty candidates the exact lane name wins over a role-only match (e.g. CAPTIONS over a tagged caption layer),
 * then the first one in order.
 */
export function createRestorffLaneKeeper(): (track: LaneTrack, tracks: SceneTracks) => boolean {
	let keepers: Map<RestorffLane, string> | null = null;

	return (track, tracks) => {
		if (!keepers) keepers = pickLaneKeepers(tracks);
		const lane = getRestorffLane(track);
		return lane !== null && keepers.get(lane) === track.id;
	};
}

function pickLaneKeepers(tracks: SceneTracks): Map<RestorffLane, string> {
	const all = [...tracks.overlay, ...tracks.audio] as LaneTrack[];
	const held = new Set<RestorffLane>();
	for (const track of all) {
		const lane = getRestorffLane(track);
		if (lane && (track as unknown as TimelineTrack).elements.length > 0) held.add(lane);
	}

	const keepers = new Map<RestorffLane, string>();
	const exactName = new Set<RestorffLane>();
	for (const track of all) {
		const lane = getRestorffLane(track);
		if (!lane || held.has(lane)) continue;
		const isExact = (track.name ?? "").trim().toUpperCase() === lane;
		if (!keepers.has(lane) || (isExact && !exactName.has(lane))) {
			keepers.set(lane, track.id);
			if (isExact) exactName.add(lane);
		}
	}
	return keepers;
}
