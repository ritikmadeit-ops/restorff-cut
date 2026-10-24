/**
 * React-facing state of the sync engine and the review comments of the open
 * project (ported idea: OpenCut-AI stores/version-store.ts; state shape is ours).
 */
import { create } from "zustand";
import type { RemoteComment, RemoteCommit, RemoteConflict } from "./remote";

export type SyncStatus =
	| "off" //        no project open
	| "checking" //   first contact with the server
	| "unlinked" //   the server has no copy: a local draft
	| "synced" //     local copy = server head
	| "dirty" //      local edits waiting to be pushed
	| "pushing"
	| "pulling"
	| "conflict" //   the server moved while you edited
	| "offline" //    no server reachable
	| "error";

export interface PulledNotice {
	commit: RemoteCommit;
	/** How many commits arrived in this pull (the newest is `commit`). */
	count: number;
	at: number;
}

export interface SyncState {
	projectId: string | null;
	status: SyncStatus;
	branch: string;
	head: RemoteCommit | null;
	base: string | null;
	history: RemoteCommit[];
	branches: string[];
	pulled: PulledNotice | null;
	conflict: RemoteConflict | null;
	error: string | null;
	lastSyncAt: number | null;
	comments: RemoteComment[];
	selectedCommentId: string | null;
	versionsOpen: boolean;
	set: (patch: Partial<SyncState>) => void;
	selectComment: (id: string | null) => void;
	openVersions: (open: boolean) => void;
	reset: () => void;
}

const initial = {
	projectId: null,
	status: "off" as SyncStatus,
	branch: "main",
	head: null,
	base: null,
	history: [],
	branches: [],
	pulled: null,
	conflict: null,
	error: null,
	lastSyncAt: null,
	comments: [],
	selectedCommentId: null,
	versionsOpen: false,
};

export const useSyncStore = create<SyncState>()((set) => ({
	...initial,
	set: (patch) => set(patch),
	selectComment: (id) => set({ selectedCommentId: id }),
	openVersions: (open) => set({ versionsOpen: open }),
	reset: () => set({ ...initial }),
}));

export function authorLabel(author: string): string {
	switch (author) {
		case "claude":
			return "Claude";
		case "compiler":
			return "compiler";
		case "preset":
			return "preset";
		default:
			return "you";
	}
}

/**
 * The header's commit line, as in design/edit-artboard.png:
 * "commit 7f3a1b2 · compiler v0 + 4 edits by you", or "commit 7f3a1b2 · Claude pushed: <message>".
 */
export function commitLineText(state: Pick<SyncState, "status" | "head" | "history" | "pulled">): string {
	const { head, history, pulled, status } = state;
	if (status === "off" || status === "checking") return "checking for commits…";
	if (status === "unlinked") return "local draft · no commits";
	if (status === "offline" && !head) return "local draft · server offline";
	if (!head) return "no commits";
	const hash = head.id.slice(0, 7);
	let text: string;
	if (pulled && pulled.commit.id === head.id && head.author !== "user") {
		const more = pulled.count > 1 ? ` (+${pulled.count - 1} more)` : "";
		text = `commit ${hash} · ${authorLabel(head.author)} pushed: ${head.message}${more}`;
	} else {
		const list = history.length && history[0].id === head.id ? history : [head, ...history];
		const k = list.findIndex((c) => c.author !== "user");
		if (k === 0) {
			text = `commit ${hash} · ${authorLabel(head.author)}: ${head.message}`;
		} else if (k > 0) {
			const anchor = list[k];
			const anchorLabel =
				anchor.author === "compiler" ? anchor.message : `${authorLabel(anchor.author)} ${anchor.message}`;
			text = `commit ${hash} · ${anchorLabel} + ${k} edit${k === 1 ? "" : "s"} by you`;
		} else {
			text = `commit ${hash} · ${list.length} edit${list.length === 1 ? "" : "s"} by you`;
		}
	}
	const suffix: Partial<Record<string, string>> = {
		dirty: "unsaved edits",
		pushing: "pushing…",
		pulling: "pulling…",
		conflict: "conflict: the server moved",
		offline: "offline",
		error: "sync error",
	};
	return suffix[status] ? `${text} · ${suffix[status]}` : text;
}
