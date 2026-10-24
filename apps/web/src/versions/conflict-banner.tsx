"use client";

import { useState } from "react";
import { syncEngine } from "@/sync/engine";
import type { RemoteConflict } from "@/sync/remote";
import { authorLabel } from "@/sync/store";

/**
 * Shown when the server moved while you edited (push → 409). Status colour is
 * stale (#E8A33D); the two ways out are explicit (ported idea: OpenCut-AI
 * conflict-resolution, reduced to whole-snapshot "theirs / mine").
 */
export function ConflictBanner({ conflict }: { conflict: RemoteConflict }) {
	const [busy, setBusy] = useState(false);
	const run = async (choice: "theirs" | "mine") => {
		setBusy(true);
		try {
			await syncEngine.resolveConflict(choice);
		} finally {
			setBusy(false);
		}
	};
	const n = conflict.since.length;
	return (
		<div className="border-stale/40 bg-stale/10 flex flex-col gap-2 border-b px-6 py-4">
			<span className="rc-label text-stale">Conflict · {conflict.branch}</span>
			<p className="text-sm leading-relaxed text-[#C9C7C2]">
				{authorLabel(conflict.head.author)} pushed “{conflict.head.message}”
				{n > 1 ? ` and ${n - 1} more` : ""} while you were editing.
			</p>
			<div className="flex gap-2">
				<button type="button" className="rc-pill h-8 px-3 text-xs" disabled={busy} onClick={() => run("theirs")}>
					Take theirs
				</button>
				<button type="button" className="rc-pill h-8 px-3 text-xs" disabled={busy} onClick={() => run("mine")}>
					Keep mine on top
				</button>
			</div>
			<p className="rc-mono text-fog text-[0.6875rem]">
				head {conflict.head.id.slice(0, 7)} · keeping yours commits it after theirs; nothing is lost
			</p>
		</div>
	);
}
