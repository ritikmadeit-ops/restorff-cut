"use client";

import { useState } from "react";
import { toast } from "sonner";
import { syncEngine } from "@/sync/engine";
import type { RemoteCommit } from "@/sync/remote";
import { describeDiff } from "@/sync/snapshot";
import { authorLabel } from "@/sync/store";
import { cn } from "@/utils/ui";

/**
 * Commit history, newest first (ported idea: OpenCut-AI commit-list /
 * commit-item / change-summary). Kiln dot = Claude's presence; mono for hashes
 * and times; the diff summary is the server's, against the first parent.
 */
export function CommitList({
	commits,
	headId,
}: {
	commits: RemoteCommit[];
	headId: string | null;
}) {
	const [expanded, setExpanded] = useState<string | null>(null);
	if (commits.length === 0) {
		return <p className="rc-mono text-fog px-6 py-6 text-xs">no commits yet</p>;
	}
	return (
		<ol className="min-h-0 flex-1 overflow-y-auto py-2">
			{commits.map((commit) => (
				<CommitItem
					key={commit.id}
					commit={commit}
					isHead={commit.id === headId}
					expanded={expanded === commit.id}
					onToggle={() => setExpanded((id) => (id === commit.id ? null : commit.id))}
				/>
			))}
		</ol>
	);
}

function CommitItem({
	commit,
	isHead,
	expanded,
	onToggle,
}: {
	commit: RemoteCommit;
	isHead: boolean;
	expanded: boolean;
	onToggle: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const [restoring, setRestoring] = useState(false);
	const summary = describeDiff(commit.summary);

	const restore = async () => {
		if (!confirming) {
			setConfirming(true);
			return;
		}
		setRestoring(true);
		try {
			await syncEngine.restore(commit.id);
			toast(`Restored ${commit.id.slice(0, 7)}`, { description: commit.message });
		} catch (error) {
			toast.error("Restore failed", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setRestoring(false);
			setConfirming(false);
		}
	};

	return (
		<li className={cn("group border-b border-line/60 px-6 py-3", expanded && "bg-raised/40")}>
			<button type="button" onClick={onToggle} className="flex w-full items-start gap-3 text-left">
				<span
					aria-hidden
					className={cn(
						"mt-1.5 size-2 shrink-0 rounded-full",
						commit.author === "claude" ? "bg-kiln" : commit.author === "user" ? "bg-bone/70" : "bg-fog",
					)}
				/>
				<span className="min-w-0 flex-1">
					<span className="text-bone block truncate text-sm">{commit.message}</span>
					<span className="rc-mono text-fog mt-0.5 block truncate text-[0.6875rem]">
						{commit.id.slice(0, 7)} · {authorLabel(commit.author)} · {timeAgo(commit.created_at)}
						{summary ? ` · ${summary}` : ""}
					</span>
				</span>
				{isHead && <span className="rc-label text-bone shrink-0">head</span>}
			</button>
			{expanded && (
				<div className="mt-2 ml-5 flex flex-col gap-2">
					{commit.summary?.lines?.length ? (
						<ul className="rc-mono text-[0.6875rem] leading-5 text-[#C9C7C2]">
							{commit.summary.lines.map((line) => (
								<li key={line} className="truncate">
									{line}
								</li>
							))}
						</ul>
					) : (
						<p className="rc-mono text-fog text-[0.6875rem]">
							{commit.parents.length ? "no changes to the cut" : "first commit"}
						</p>
					)}
					<p className="rc-mono text-fog text-[0.6875rem]">
						{commit.stats.element_count} elements · {commit.stats.track_count} tracks ·{" "}
						{commit.stats.duration_s.toFixed(2)} s{commit.ops_count ? ` · ${commit.ops_count} ops` : ""}
					</p>
					{!isHead && (
						<button
							type="button"
							onClick={restore}
							disabled={restoring}
							className="rc-pill h-8 self-start px-3 text-xs"
						>
							{restoring ? "Restoring…" : confirming ? "Confirm: replace the cut" : "Restore this version"}
						</button>
					)}
				</div>
			)}
		</li>
	);
}

function timeAgo(iso: string | null): string {
	if (!iso) return "";
	const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
	if (seconds < 60) return `${Math.floor(seconds)} s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)} m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
	return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
