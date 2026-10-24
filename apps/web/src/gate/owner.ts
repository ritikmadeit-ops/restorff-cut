/**
 * Who may override a failed MUST (D13: the project owner, with a written reason; Claude never).
 *
 * Until RestorffCut has real sign-in for projects, the person using this browser IS the owner: the label says so on
 * every override, so nobody mistakes it for a verified identity. When sign-in lands, replace `currentOwner` with the
 * signed-in user and `isProjectOwner` with a check against the project's owner.
 */
export interface GateOwner {
	/** Recorded in `by` on the override: always "user:<id>", never "claude…". */
	by: string;
	label: string;
}

export const LOCAL_OWNER: GateOwner = {
	by: "user:local-owner",
	label: "local user (owner until sign-in)",
};

export function currentOwner(): GateOwner {
	return LOCAL_OWNER;
}

export function isProjectOwner(owner: GateOwner): boolean {
	return owner.by.startsWith("user:");
}
