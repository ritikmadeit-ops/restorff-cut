"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { syncEngine } from "@/sync/engine";
import { useSyncStore } from "@/sync/store";
import { BranchSwitcher } from "./branch-switcher";
import { CommitList } from "./commit-list";
import { ConflictBanner } from "./conflict-banner";

/**
 * The Versions panel: commit history of the followed branch, restore, branch
 * switch, diff summaries, sync status. Opened from the header's commit line.
 * Ported from OpenCut-AI's version-history panel (MIT, see NOTICE), restyled
 * to the Restorff screen skin.
 */
export function VersionsSheet() {
	const open = useSyncStore((s) => s.versionsOpen);
	const setOpen = useSyncStore((s) => s.openVersions);
	const status = useSyncStore((s) => s.status);
	const branch = useSyncStore((s) => s.branch);
	const history = useSyncStore((s) => s.history);
	const head = useSyncStore((s) => s.head);
	const conflict = useSyncStore((s) => s.conflict);
	const error = useSyncStore((s) => s.error);
	const [linking, setLinking] = useState(false);

	const startHistory = async () => {
		setLinking(true);
		try {
			const ok = await syncEngine.link();
			if (ok) toast("Version history started", { description: "Every save is now a commit on main." });
		} finally {
			setLinking(false);
		}
	};

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetContent
				side="right"
				className="bg-surface flex w-[26rem] flex-col gap-0 border-l p-0 sm:max-w-[26rem]"
			>
				<SheetHeader className="border-b px-6 pt-6 pb-4 text-left">
					<span className="rc-label">
						Versions{status !== "unlinked" && status !== "off" ? ` · ${branch}` : ""}
					</span>
					<SheetTitle className="text-bone text-xl font-bold tracking-tight">
						{status === "unlinked" ? "Local draft" : "History"}
					</SheetTitle>
					<SheetDescription className="rc-mono text-fog text-xs">
						{statusLine(status, error)}
					</SheetDescription>
				</SheetHeader>

				{status === "unlinked" ? (
					<div className="flex flex-col gap-4 px-6 py-6 text-sm leading-relaxed text-[#C9C7C2]">
						<p>
							This cut lives only in this browser. Start version history to keep
							a server copy: every save becomes a commit, Claude&apos;s edits arrive
							as commits you can keep or undo, and you can share it with an editor.
						</p>
						<button
							type="button"
							className="rc-pill self-start"
							onClick={startHistory}
							disabled={linking}
						>
							{linking ? "Starting…" : "Start version history"}
						</button>
					</div>
				) : (
					<>
						{conflict && <ConflictBanner conflict={conflict} />}
						<div className="flex items-center gap-2 border-b px-6 py-3">
							<BranchSwitcher />
							<button
								type="button"
								className="rc-mono text-fog hover:text-bone ml-auto text-xs"
								onClick={() => void syncEngine.refresh()}
							>
								pull now
							</button>
						</div>
						<CommitList commits={history} headId={head?.id ?? null} />
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}

function statusLine(status: string, error: string | null): string {
	switch (status) {
		case "checking":
			return "checking the server…";
		case "unlinked":
			return "no server copy yet";
		case "synced":
			return "in sync with the server";
		case "dirty":
			return "your edits will be committed in a few seconds";
		case "pushing":
			return "committing your edits…";
		case "pulling":
			return "pulling new commits…";
		case "conflict":
			return "the server moved while you edited";
		case "offline":
			return "server unreachable · editing locally";
		case "error":
			return error ?? "sync error";
		default:
			return "";
	}
}
