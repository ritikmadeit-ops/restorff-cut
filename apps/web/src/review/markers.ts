/**
 * How a review comment / Judge finding looks as a timeline marker, in the
 * Restorff skin. Neon (#F6FF00) is the one isolate per view, so it is only the
 * SELECTED marker; must/should are stale (#E8A33D, status colour); could and
 * reviewer notes are a bone outline; info is fog; resolved markers fade.
 * Comments raised by Claude or a judge carry a Kiln (#C8553D) dot.
 */

export interface MarkerComment {
	id: string;
	time_s: number;
	time_end_s: number | null;
	severity: "must" | "should" | "could" | "info" | null;
	status: "open" | "resolved";
	author: string;
	rule_id: string | null;
	body: string;
	track_name: string | null;
	commit_id: string | null;
	parent_id?: string | null;
}

export const RC = {
	neon: "#F6FF00",
	stale: "#E8A33D",
	bone: "#EDEBE6",
	fog: "#8C8C95",
	kiln: "#C8553D",
} as const;

export interface MarkerLook {
	fill: string;
	stroke: string;
	opacity: number;
	/** Tick (instant) width in px; spans use their own length. */
	width: number;
	kilnDot: boolean;
}

export function isMachineAuthor(author: string): boolean {
	return /^(claude|judge|worker:judge|compiler)/i.test(author);
}

export function markerLook(comment: MarkerComment, selected: boolean): MarkerLook {
	const kilnDot = isMachineAuthor(comment.author);
	if (selected) {
		return { fill: RC.neon, stroke: RC.neon, opacity: 1, width: 4, kilnDot };
	}
	if (comment.status === "resolved") {
		return { fill: "transparent", stroke: RC.fog, opacity: 0.45, width: 2, kilnDot: false };
	}
	switch (comment.severity) {
		case "must":
			return { fill: RC.stale, stroke: RC.stale, opacity: 1, width: 4, kilnDot };
		case "should":
			return { fill: "transparent", stroke: RC.stale, opacity: 1, width: 3, kilnDot };
		case "info":
			return { fill: RC.fog, stroke: RC.fog, opacity: 0.8, width: 2, kilnDot };
		default:
			return { fill: "transparent", stroke: RC.bone, opacity: 0.9, width: 3, kilnDot };
	}
}

/** "R5 · 0:08 · S16 holds for 3.8 s" — the mono label from EXPORT-GATE.md §3. */
export function markerLabel(comment: MarkerComment, formatTime: (s: number) => string): string {
	const parts = [comment.rule_id, formatTime(comment.time_s), comment.body].filter(Boolean);
	return parts.join(" · ");
}

export function severityRank(severity: MarkerComment["severity"]): number {
	return { must: 0, should: 1, could: 2, info: 3 }[severity ?? "could"] ?? 2;
}
