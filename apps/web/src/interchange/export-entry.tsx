"use client";

/**
 * "Export timeline (FCPXML / OTIO)" — the interchange agent's one entry in the Export menu (EDT-19, 2026-10-20).
 * Downloads this project's server commit as FCPXML 1.10 (Final Cut Pro, DaVinci Resolve) or OTIO (any
 * OpenTimelineIO editor) from GET /api/interchange/<id>/<commit>.<ext> (server/interchange.ts). The file is made from
 * a commit, so a local draft (no server copy yet) is told how to get one. Mounted inside "Render final"'s popover
 * (components/editor/export-button.tsx).
 */
import { useSyncStore } from "@/sync/store";

const LINKED = new Set(["synced", "dirty", "pushing", "pulling", "conflict"]);
const FORMATS = [
	{ id: "fcpxml", label: "FCPXML", hint: "Final Cut Pro, Resolve" },
	{ id: "otio", label: "OTIO", hint: "OpenTimelineIO" },
] as const;

export function ExportTimelineEntry() {
	const projectId = useSyncStore((s) => s.projectId);
	const status = useSyncStore((s) => s.status);
	const head = useSyncStore((s) => s.head);
	const ready = !!projectId && !!head && LINKED.has(status);
	const waiting = status === "dirty" || status === "pushing";

	return (
		<div className="flex flex-col gap-2 border-t p-3" data-testid="export-timeline">
			<h4 className="rc-label">Export timeline (FCPXML / OTIO)</h4>
			<div className="flex gap-2">
				{FORMATS.map((format) =>
					ready ? (
						<a
							key={format.id}
							href={`/api/interchange/${encodeURIComponent(projectId as string)}/${head?.id}.${format.id}`}
							download
							title={`${format.label} · ${format.hint}`}
							className="rc-pill flex-1"
							data-testid={`export-timeline-${format.id}`}
						>
							{format.label}
						</a>
					) : (
						<button key={format.id} type="button" disabled className="rc-pill flex-1">
							{format.label}
						</button>
					),
				)}
			</div>
			<p className="rc-mono text-fog text-[0.65rem] leading-snug">
				{ready
					? `Commit ${head?.id.slice(0, 7)}${waiting ? " (your newest edits push in a few seconds)" : ""} as an editable timeline: every cut on the frame, captions as titles, comments as markers. Grade, effects and keyframes stay here.`
					: "Start version history first (the commit line in the header): the export is made from a commit."}
			</p>
		</div>
	);
}
