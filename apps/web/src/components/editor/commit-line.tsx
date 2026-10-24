"use client";

import { useEditor } from "@/editor/use-editor";
import { frameRateToFloat } from "@/fps/utils";
import { useProjectSync } from "@/sync/use-project-sync";
import { commitLineText, useSyncStore } from "@/sync/store";
import { VersionsSheet } from "@/versions/versions-sheet";
import { cn } from "@/utils/ui";

/**
 * The mono status line in the header (design/edit-artboard.png shows
 * "commit 7f3a · compiler v0 + 4 edits by you · preview rendered in 2 m 14 s").
 *
 * The commit part comes from the server's commits (src/sync): "commit <hash7> ·
 * <who/what>", "Claude pushed: <message>" right after a pull, or "local draft ·
 * no commits" for a project with no server copy. The rest is what the project
 * knows (canvas, fps, last save). Clicking it opens the Versions panel.
 * It also mounts the sync engine for the open project.
 */
export function CommitLine() {
	useProjectSync();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const status = useSyncStore((s) => s.status);
	const head = useSyncStore((s) => s.head);
	const history = useSyncStore((s) => s.history);
	const pulled = useSyncStore((s) => s.pulled);
	const openVersions = useSyncStore((s) => s.openVersions);
	if (!activeProject) return null;

	const { canvasSize, fps } = activeProject.settings;
	const fpsValue = Math.round(frameRateToFloat(fps) * 100) / 100;
	const savedAt = formatClock(activeProject.metadata.updatedAt);
	const commitText = commitLineText({ status, head, history, pulled });
	const claudeJustPushed =
		!!pulled && head?.id === pulled.commit.id && head.author !== "user";

	const segments = [
		`${canvasSize.width}×${canvasSize.height} · ${fpsValue} fps`,
		savedAt ? `saved ${savedAt}` : null,
	].filter(Boolean);

	return (
		<>
			<button
				type="button"
				onClick={() => openVersions(true)}
				className="rc-mono hidden min-w-0 cursor-pointer truncate rounded-sm pr-2 text-left text-[0.8125rem] text-[#C9C7C2] outline-none hover:text-bone focus-visible:ring-1 focus-visible:ring-ring xl:block"
				title="Versions: history, restore, branches"
				data-sync-status={status}
			>
				<span
					className={cn(
						claudeJustPushed && "text-bone",
						status === "conflict" && "text-stale",
					)}
				>
					{claudeJustPushed && (
						<span
							aria-hidden
							className="bg-kiln mr-1.5 inline-block size-1.5 rounded-full align-middle"
						/>
					)}
					{commitText}
				</span>
				{segments.length > 0 && <span> · {segments.join(" · ")}</span>}
			</button>
			<VersionsSheet />
		</>
	);
}

function formatClock(date: Date | string | undefined): string | null {
	if (!date) return null;
	const value = date instanceof Date ? date : new Date(date);
	if (Number.isNaN(value.getTime())) return null;
	return value.toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
	});
}
