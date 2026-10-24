/**
 * The editor's sync engine: keeps this browser's copy of a project and the
 * server's commits in step.
 *
 *  - Local first: the editor saves to IndexedDB as before. When the project has
 *    a server copy, every save that changed the cut is pushed as a commit
 *    (author `user`) a few seconds after the editing stops.
 *  - Pull: on load, every 15 s while the tab is visible, and on focus, the head
 *    of the followed branch is fetched. When it moved and there are no local
 *    edits, its snapshot replaces the local copy ("Claude pushed: …").
 *  - Conflict: the server moved AND there are local edits → the push gets 409;
 *    the user picks "take theirs" or "keep mine" (a new commit on top).
 *
 * Ported from OpenCut-AI's SyncEngine (MIT, see NOTICE): offline-first, push/pull
 * of commit snapshots, auto-sync on an interval and when the browser comes back
 * online. Their engine synced a local commit graph; ours syncs one working copy
 * against server heads with optimistic concurrency (base_commit → 201 or 409).
 */
import type { EditorCore } from "@/core";
import { storageService } from "@/services/storage/service";
import type { SerializedProject } from "@/services/storage/types";
import { toast } from "sonner";
import { onProjectSaved } from "./hooks";
import {
	type LocalSyncRecord,
	readSyncRecord,
	remote,
	RemoteError,
	type RemoteCommit,
	type RemoteConflict,
	writeSyncRecord,
} from "./remote";
import {
	cutChanged,
	describeDiff,
	diffSnapshots,
	type ProjectSnapshot,
	snapshotFingerprint,
	stripForCommit,
} from "./snapshot";
import { authorLabel, useSyncStore } from "./store";

const PULL_INTERVAL_MS = 15_000;
const PUSH_DEBOUNCE_MS = 6_000;
const HISTORY_LIMIT = 40;

class SyncEngine {
	private editor: EditorCore | null = null;
	private projectId: string | null = null;
	private record: LocalSyncRecord = { branch: "main", base: null, fingerprint: null };
	/** The snapshot at `record.base` (for diff summaries in commit messages). Set it with setBaseSnapshot. */
	private baseSnapshot: ProjectSnapshot | null = null;
	/** snapshotFingerprint(baseSnapshot), cached: "is the cut still the base commit's?" runs on every save. */
	private baseFingerprint: string | null = null;
	private applying = false;
	private busy = false;
	private pushTimer: ReturnType<typeof setTimeout> | null = null;
	private pullTimer: ReturnType<typeof setInterval> | null = null;
	private unsubscribeSaved: (() => void) | null = null;
	private linked = false;

	// ─── Lifecycle ──────────────────────────────────────────────────────────

	attach(editor: EditorCore, projectId: string): void {
		if (this.projectId === projectId && this.editor === editor) return;
		this.detach();
		this.editor = editor;
		this.projectId = projectId;
		this.record = readSyncRecord(projectId) ?? { branch: "main", base: null, fingerprint: null };
		this.setBaseSnapshot(null);
		this.linked = false;
		useSyncStore.getState().set({
			projectId,
			status: "checking",
			branch: this.record.branch,
			base: this.record.base,
			head: null,
			history: [],
			pulled: null,
			conflict: null,
			error: null,
			comments: [],
		});
		this.unsubscribeSaved = onProjectSaved((project) => this.onSaved(project));
		this.pullTimer = setInterval(() => {
			// Unlinked drafts are re-checked on focus only (no 404 every 15 s).
			if (this.linked && document.visibilityState === "visible") void this.refresh();
		}, PULL_INTERVAL_MS);
		window.addEventListener("focus", this.onFocus);
		window.addEventListener("online", this.onFocus);
		window.addEventListener("offline", this.onOffline);
		void this.refresh();
	}

	detach(): void {
		if (this.pushTimer) clearTimeout(this.pushTimer);
		if (this.pullTimer) clearInterval(this.pullTimer);
		this.pushTimer = null;
		this.pullTimer = null;
		this.unsubscribeSaved?.();
		this.unsubscribeSaved = null;
		if (typeof window !== "undefined") {
			window.removeEventListener("focus", this.onFocus);
			window.removeEventListener("online", this.onFocus);
			window.removeEventListener("offline", this.onOffline);
		}
		this.editor = null;
		this.projectId = null;
		useSyncStore.getState().reset();
	}

	private onFocus = () => {
		void this.refresh();
	};

	private onOffline = () => {
		this.setStatus("offline");
	};

	// ─── Local copy ─────────────────────────────────────────────────────────

	private currentSnapshot(): ProjectSnapshot | null {
		const editor = this.editor;
		const active = editor?.project.getActiveOrNull();
		if (!editor || !active) return null;
		const scenes = editor.scenes.getScenes();
		const project = { ...active, scenes: scenes.length ? scenes : active.scenes };
		return storageService.serializeProject({ project }) as unknown as ProjectSnapshot;
	}

	private saveRecord(patch: Partial<LocalSyncRecord>): void {
		if (!this.projectId) return;
		this.record = { ...this.record, ...patch };
		writeSyncRecord(this.projectId, this.record);
		useSyncStore.getState().set({ base: this.record.base, branch: this.record.branch });
	}

	private setStatus(status: ReturnType<typeof useSyncStore.getState>["status"], extra: Record<string, unknown> = {}) {
		useSyncStore.getState().set({ status, ...extra });
	}

	private setBaseSnapshot(snapshot: ProjectSnapshot | null): void {
		this.baseSnapshot = snapshot;
		this.baseFingerprint = snapshot ? snapshotFingerprint(snapshot) : null;
	}

	/** Records the local copy's fingerprint as synced (it equals the base commit's cut). */
	private adoptFingerprint(local: ProjectSnapshot): void {
		const fingerprint = snapshotFingerprint(local);
		if (fingerprint !== this.record.fingerprint) this.saveRecord({ fingerprint });
	}

	/**
	 * Did the user change the cut since the last sync? Timestamps, the thumbnail and the timeline's view state never
	 * count (snapshot.ts hashView), and a copy whose cut equals the base commit's is not an edit even when the stored
	 * fingerprint is stale (ui-fix-timeline, QA 2026-10-20 #3: browsing pushed "edit: no changes to the cut").
	 */
	private hasLocalEdits(local: ProjectSnapshot | null): boolean {
		if (!local || !this.record.fingerprint) return false;
		if (
			!cutChanged({
				local,
				syncedFingerprint: this.record.fingerprint,
				baseFingerprint: this.baseFingerprint,
			})
		) {
			this.adoptFingerprint(local);
			return false;
		}
		return true;
	}

	/**
	 * Before calling a moved head a conflict: is the local cut really different from the commit it was based on?
	 * Fetches that commit when it is not the loaded base. Any failure answers "yes, different" (the safe side).
	 */
	private async differsFromCommit(
		projectId: string,
		commitId: string | null,
		local: ProjectSnapshot | null,
	): Promise<boolean> {
		if (!commitId || !local) return true;
		try {
			const { commit } = await remote.getCommit(projectId, commitId);
			if (!commit.snapshot || this.projectId !== projectId) return true;
			if (snapshotFingerprint(local) !== snapshotFingerprint(commit.snapshot)) return true;
			this.setBaseSnapshot(commit.snapshot);
			this.adoptFingerprint(local);
			return false;
		} catch {
			return true;
		}
	}

	/** Replace the local copy with a commit's snapshot and reload the editor. */
	private async applySnapshot(snapshot: ProjectSnapshot, commit: RemoteCommit): Promise<void> {
		const editor = this.editor;
		const projectId = this.projectId;
		if (!editor || !projectId) return;
		this.applying = true;
		try {
			const local = this.currentSnapshot();
			const now = new Date().toISOString();
			const merged = JSON.parse(JSON.stringify(snapshot)) as ProjectSnapshot;
			merged.metadata.id = projectId;
			merged.metadata.createdAt ??= local?.metadata.createdAt ?? now;
			merged.metadata.updatedAt = now;
			if (local?.metadata.thumbnail) merged.metadata.thumbnail = local.metadata.thumbnail;
			if (local?.timelineViewState) merged.timelineViewState = local.timelineViewState;
			for (const scene of merged.scenes ?? []) {
				scene.createdAt ??= now;
				scene.updatedAt ??= now;
				scene.bookmarks ??= [];
			}
			await storageService.saveSerializedProject({
				project: merged as unknown as SerializedProject,
			});
			// Files the pulled cut uses that this browser lacks (e.g. Claude's imports).
			await storageService.importRemoteMedia({ projectId });
			await editor.project.loadProject({ id: projectId });
			editor.command.clear();
			const after = this.currentSnapshot();
			this.setBaseSnapshot(snapshot);
			this.saveRecord({
				base: commit.id,
				fingerprint: after ? snapshotFingerprint(after) : null,
			});
		} finally {
			this.applying = false;
		}
	}

	// ─── Pull ───────────────────────────────────────────────────────────────

	async refresh(): Promise<void> {
		const projectId = this.projectId;
		if (!projectId || this.busy || this.applying) return;
		if (typeof navigator !== "undefined" && !navigator.onLine) {
			this.setStatus("offline");
			return;
		}
		this.busy = true;
		try {
			let headInfo: Awaited<ReturnType<typeof remote.getHead>>;
			try {
				headInfo = await remote.getHead(projectId, this.record.branch);
			} catch (error) {
				if (error instanceof RemoteError && error.status === 404) {
					// The followed branch may be gone: fall back to the default branch once.
					if (this.record.branch !== "main" && /branch/.test(error.message)) {
						this.saveRecord({ branch: "main" });
						this.busy = false;
						return this.refresh();
					}
					this.linked = false;
					this.setStatus("unlinked", { head: null, history: [], comments: [] });
					return;
				}
				if (error instanceof RemoteError && error.status === 401) {
					this.setStatus("error", { error: "the project server needs you to sign in" });
					return;
				}
				this.setStatus("offline", { error: error instanceof Error ? error.message : String(error) });
				return;
			}
			if (this.projectId !== projectId) return;
			this.linked = true;
			const head = headInfo.head;
			const local = this.currentSnapshot();
			if (!this.record.base || !this.record.fingerprint) {
				// First contact in this browser (opened by link, or linked elsewhere): adopt the
				// local copy as synced with the head it came from.
				const base = this.record.base ?? head.id;
				this.saveRecord({
					base,
					fingerprint: local ? snapshotFingerprint(local) : null,
				});
				if (base === head.id) this.setBaseSnapshot(headInfo.snapshot);
			}
			useSyncStore.getState().set({ head, branch: headInfo.branch, error: null });

			if (head.id === this.record.base) {
				if (!this.baseSnapshot) this.setBaseSnapshot(headInfo.snapshot);
				if (this.hasLocalEdits(local)) {
					this.setStatus("dirty");
					this.schedulePush();
				} else {
					this.setStatus("synced", { conflict: null, lastSyncAt: Date.now() });
				}
			} else if (
				!this.hasLocalEdits(local) ||
				// A stale fingerprint is not an edit: compare with the commit the local copy came from (QA #3).
				!(await this.differsFromCommit(projectId, this.record.base, local))
			) {
				// The server moved and nothing local is at risk: take it.
				this.setStatus("pulling");
				const since = await remote
					.listCommits(projectId, { branch: headInfo.branch, since: this.record.base ?? undefined, limit: 50 })
					.catch(() => null);
				if (headInfo.snapshot) await this.applySnapshot(headInfo.snapshot, head);
				const count = since?.commits.length ?? 1;
				useSyncStore.getState().set({
					pulled: { commit: head, count, at: Date.now() },
					conflict: null,
					lastSyncAt: Date.now(),
				});
				this.setStatus("synced");
				const who = head.author === "user" ? "Pulled your edits from another session" : `${authorLabel(head.author)} pushed`;
				toast(`${who}: ${head.message}`, {
					description: `commit ${head.id.slice(0, 7)}${count > 1 ? ` · ${count} new commits` : ""}`,
				});
			} else {
				const conflict = await this.conflictFor(projectId, headInfo.branch, head);
				this.setStatus("conflict", { conflict });
			}
			await Promise.all([this.loadHistory(), this.loadComments(), this.loadBranches()]);
		} finally {
			this.busy = false;
		}
	}

	private async conflictFor(projectId: string, branch: string, head: RemoteCommit): Promise<RemoteConflict> {
		const since = await remote
			.listCommits(projectId, { branch, since: this.record.base ?? undefined, limit: 50 })
			.catch(() => null);
		return {
			branch,
			head,
			since: since?.commits ?? [head],
			base_found: since?.since_found ?? false,
		};
	}

	async loadHistory(): Promise<void> {
		const projectId = this.projectId;
		if (!projectId || !this.linked) return;
		try {
			const list = await remote.listCommits(projectId, { branch: this.record.branch, limit: HISTORY_LIMIT });
			if (this.projectId === projectId) useSyncStore.getState().set({ history: list.commits });
		} catch {
			// History is informative; a failed fetch keeps the old list.
		}
	}

	async loadComments(): Promise<void> {
		const projectId = this.projectId;
		if (!projectId || !this.linked) return;
		try {
			const { comments } = await remote.listComments(projectId);
			if (this.projectId === projectId) useSyncStore.getState().set({ comments });
		} catch {
			// Keep the markers we have.
		}
	}

	async loadBranches(): Promise<void> {
		const projectId = this.projectId;
		if (!projectId || !this.linked) return;
		try {
			const { branches } = await remote.listBranches(projectId);
			if (this.projectId === projectId) {
				useSyncStore.getState().set({ branches: branches.map((b) => b.name) });
			}
		} catch {
			// Branch list is informative.
		}
	}

	// ─── Push ───────────────────────────────────────────────────────────────

	private onSaved(project: ProjectSnapshot): void {
		if (this.applying || !this.linked || project.metadata?.id !== this.projectId) return;
		if (!this.record.fingerprint) return;
		// A save that did not change the cut (view state, timestamps, a no-op track rewrite) is not an edit (QA #3).
		if (!this.hasLocalEdits(project)) return;
		const status = useSyncStore.getState().status;
		if (status === "conflict") return;
		this.setStatus("dirty");
		this.schedulePush();
	}

	private schedulePush(): void {
		if (this.pushTimer) clearTimeout(this.pushTimer);
		this.pushTimer = setTimeout(() => {
			this.pushTimer = null;
			void this.push();
		}, PUSH_DEBOUNCE_MS);
	}

	/** Push the local copy as a commit by `user`. Resolves to the new commit, or null. */
	async push(opts: { message?: string; base?: string } = {}): Promise<RemoteCommit | null> {
		const projectId = this.projectId;
		if (!projectId || !this.linked || this.applying) return null;
		if (this.busy) {
			this.schedulePush();
			return null;
		}
		const local = this.currentSnapshot();
		const base = opts.base ?? this.record.base;
		if (!local || !base) return null;
		const fingerprint = snapshotFingerprint(local);
		// Never commit a cut that did not change (QA 2026-10-20 #3): such commits raced Claude's `base_commit`.
		// Restore and "keep mine" pass a base + message and always push.
		if (
			!opts.message &&
			!opts.base &&
			!cutChanged({ local, syncedFingerprint: this.record.fingerprint, baseFingerprint: this.baseFingerprint })
		) {
			if (fingerprint !== this.record.fingerprint) this.saveRecord({ fingerprint });
			this.setStatus("synced");
			return null;
		}
		this.busy = true;
		this.setStatus("pushing");
		try {
			const snapshot = stripForCommit(local);
			const summary = this.baseSnapshot ? diffSnapshots(this.baseSnapshot, snapshot) : null;
			const message = opts.message ?? (summary ? `edit: ${describeDiff(summary)}` : "edits by you");
			const { commit } = await remote.pushCommit(projectId, {
				base_commit: base,
				branch: this.record.branch,
				author: "user",
				snapshot,
				message,
			});
			this.setBaseSnapshot(snapshot);
			this.saveRecord({ base: commit.id, fingerprint });
			const state = useSyncStore.getState();
			state.set({
				head: commit,
				history: [commit, ...state.history].slice(0, HISTORY_LIMIT),
				pulled: null,
				conflict: null,
				lastSyncAt: Date.now(),
			});
			this.setStatus(this.hasLocalEdits(this.currentSnapshot()) ? "dirty" : "synced");
			void this.uploadMissingMedia();
			return commit;
		} catch (error) {
			if (error instanceof RemoteError && error.status === 409) {
				const conflict = (error.body as { conflict?: RemoteConflict } | null)?.conflict ?? null;
				this.setStatus("conflict", { conflict });
				return null;
			}
			this.setStatus("error", { error: error instanceof Error ? error.message : String(error) });
			return null;
		} finally {
			this.busy = false;
		}
	}

	// ─── Media (content-addressed on the server) ────────────────────────────

	private mediaRun: Promise<number> | null = null;

	/**
	 * Uploads this project's media files the server does not have yet. Runs one at
	 * a time; returns how many were uploaded. Never throws (failures are toasts).
	 */
	uploadMissingMedia(): Promise<number> {
		if (this.mediaRun) return this.mediaRun;
		const projectId = this.projectId;
		if (!projectId || !this.linked) return Promise.resolve(0);
		this.mediaRun = (async () => {
			try {
				const [{ media }, local] = await Promise.all([
					remote.listMedia(projectId),
					storageService.listMediaAssetData({ projectId }),
				]);
				const onServer = new Map(media.map((m) => [m.media_id, m]));
				const missing = local.filter(
					(m) => !m.ephemeral && (!onServer.has(m.id) || onServer.get(m.id)!.size !== m.size),
				);
				let uploaded = 0;
				for (const item of missing) {
					const file = await storageService.loadMediaFile({ projectId, id: item.id });
					if (!file) continue;
					const { thumbnailUrl: _thumb, ...meta } = item;
					await remote.uploadMedia(projectId, item.id, file, meta as Record<string, unknown>);
					uploaded++;
				}
				return uploaded;
			} catch (error) {
				toast.error("Media upload failed", {
					description: error instanceof Error ? error.message : String(error),
				});
				return 0;
			} finally {
				this.mediaRun = null;
			}
		})();
		return this.mediaRun;
	}

	// ─── User actions (Versions panel, Share dialog) ────────────────────────

	/** Create the server copy of this project (first commit). */
	async link(): Promise<boolean> {
		const projectId = this.projectId;
		const local = this.currentSnapshot();
		if (!projectId || !local) return false;
		try {
			const snapshot = stripForCommit(local);
			const { commit } = await remote.createProject({
				snapshot,
				author: "user",
				message: "start version history",
			});
			this.linked = true;
			this.setBaseSnapshot(snapshot);
			this.saveRecord({ branch: commit.branch, base: commit.id, fingerprint: snapshotFingerprint(local) });
			useSyncStore.getState().set({ head: commit, history: [commit], status: "synced", error: null });
			await Promise.all([this.loadComments(), this.loadBranches()]);
			void this.uploadMissingMedia();
			return true;
		} catch (error) {
			if (error instanceof RemoteError && error.status === 409) {
				await this.refresh();
				return true;
			}
			toast.error("Could not start version history", {
				description: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	async resolveConflict(choice: "theirs" | "mine"): Promise<void> {
		const projectId = this.projectId;
		const conflict = useSyncStore.getState().conflict;
		if (!projectId || !conflict) return;
		if (choice === "theirs") {
			const { commit } = await remote.getCommit(projectId, conflict.head.id);
			if (commit.snapshot) await this.applySnapshot(commit.snapshot, commit);
			useSyncStore.getState().set({ head: conflict.head, conflict: null });
			this.setStatus("synced");
		} else {
			this.setBaseSnapshot((await remote.getCommit(projectId, conflict.head.id)).commit.snapshot ?? null);
			useSyncStore.getState().set({ conflict: null });
			await this.push({
				base: conflict.head.id,
				message: `keep my edits over ${conflict.head.id.slice(0, 7)} (${authorLabel(conflict.head.author)}: ${conflict.head.message})`,
			});
		}
		await this.loadHistory();
	}

	/** Make an old commit the new head: its snapshot, committed on top as `user`. */
	async restore(commitId: string): Promise<void> {
		const projectId = this.projectId;
		const head = useSyncStore.getState().head;
		if (!projectId || !head) return;
		const { commit } = await remote.getCommit(projectId, commitId);
		if (!commit.snapshot) throw new Error("that commit has no snapshot");
		await this.applySnapshot(commit.snapshot, head);
		await this.push({
			base: head.id,
			message: `restore ${commit.id.slice(0, 7)} (${authorLabel(commit.author)}: ${commit.message})`,
		});
	}

	async switchBranch(name: string): Promise<void> {
		const projectId = this.projectId;
		if (!projectId) return;
		const target = await remote.getHead(projectId, name);
		this.saveRecord({ branch: name });
		if (target.snapshot) await this.applySnapshot(target.snapshot, target.head);
		useSyncStore.getState().set({ head: target.head, pulled: null, conflict: null });
		this.setStatus("synced");
		await this.loadHistory();
	}

	async createBranch(name: string): Promise<void> {
		const projectId = this.projectId;
		const base = this.record.base;
		if (!projectId || !base) return;
		await remote.createBranch(projectId, name, base);
		this.saveRecord({ branch: name });
		await this.loadBranches();
		await this.refresh();
	}

	getProjectId(): string | null {
		return this.projectId;
	}

	isLinked(): boolean {
		return this.linked;
	}
}

export const syncEngine = new SyncEngine();
