"use client";

import { useEffect, useState } from "react";
import { remote, type RemoteCommit } from "@/sync/remote";
import { authorLabel } from "@/sync/store";

type LastCommit = { state: "loading" } | { state: "none" } | { state: "commit"; commit: RemoteCommit };

const cache = new Map<string, Promise<RemoteCommit | null>>();
let serverIds: Promise<Set<string> | null> | null = null;

/** The ids the server holds, asked once per page load (null when the server can't be reached). */
function fetchServerIds(): Promise<Set<string> | null> {
	if (!serverIds) {
		serverIds = fetch("/api/projects", { cache: "no-store", credentials: "same-origin" })
			.then((res) => (res.ok ? (res.json() as Promise<{ projects?: Array<{ id: string }> }>) : null))
			.then((body) => (body?.projects ? new Set(body.projects.map((project) => project.id)) : null))
			.catch(() => null);
	}
	return serverIds;
}

/**
 * ui-fix-panels (QA #28): a local draft the server never had is "local draft" without asking for its commits
 * (that was a 404 per draft on every load).
 */
function fetchLastCommit(projectId: string): Promise<RemoteCommit | null> {
	let pending = cache.get(projectId);
	if (!pending) {
		pending = fetchServerIds().then((ids) =>
			ids && !ids.has(projectId)
				? null
				: remote
						.listCommits(projectId, { limit: 1 })
						.then((res) => res.commits[0] ?? null)
						.catch(() => null),
		);
		cache.set(projectId, pending);
	}
	return pending;
}

/**
 * "commit 7f3a1b2 · compiler" — the newest server commit of a project and who
 * made it (src/sync, port agent's API); "local draft" when the server has no
 * copy (or is not running). One request per project per page load.
 */
export function LastCommitLine({ projectId }: { projectId: string }) {
	const [value, setValue] = useState<LastCommit>({ state: "loading" });

	useEffect(() => {
		let alive = true;
		fetchLastCommit(projectId).then((commit) => {
			if (!alive) return;
			setValue(commit ? { state: "commit", commit } : { state: "none" });
		});
		return () => {
			alive = false;
		};
	}, [projectId]);

	if (value.state === "loading") return <span className="text-[#5c5c64]">checking commits…</span>;
	if (value.state === "none") return <span>local draft</span>;
	const { commit } = value;
	return (
		<span title={commit.message}>
			commit {commit.id.slice(0, 7)} · {authorLabel(commit.author)}
		</span>
	);
}
