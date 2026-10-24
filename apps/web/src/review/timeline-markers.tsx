"use client";

import { useCallback, useMemo, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { timelineTimeToPixels } from "@/timeline";
import type { RemoteComment } from "@/sync/remote";
import { formatTimecode, secondsToTicks } from "@/sync/snapshot";
import { useSyncStore } from "@/sync/store";
import { mediaTimeFromSeconds } from "@/wasm";
import { FindingCard } from "./finding-card";
import { JUDGE_MARKER_SIZE_PX, judgeMarkerStyle } from "./findings";
import { clusterMarkers, dedupeMarkers, resolveFindingTarget, type TrackWithElements } from "./judge-row";
import { MarkerClusterList } from "./marker-cluster-list";
import { isMachineAuthor, markerLabel, severityRank } from "./markers";
import { selectFindingElement } from "./select-finding";

// polish agent: 18 px so the artboard's 14 px squares fit (was 16).
const ROW_HEIGHT_PX = 18;

/**
 * Review comments and Judge findings as markers under the ruler
 * (docs/restorff/EXPORT-GATE.md §3). Click a marker: the playhead jumps there,
 * the pinned element is selected and the marker turns neon (the isolate).
 * Markers that would overlap are ONE marker with a count; clicking it opens the
 * list of what is there (ui-fix-timeline, QA #10). The same finding posted under
 * two ids is drawn once. Renders nothing when the project has no comments.
 */
export function ReviewMarkersRow({
	zoomLevel,
	dynamicTimelineWidth,
}: {
	zoomLevel: number;
	dynamicTimelineWidth: number;
}) {
	const comments = useSyncStore((s) => s.comments);
	const selectedId = useSyncStore((s) => s.selectedCommentId);
	const select = useSyncStore((s) => s.selectComment);
	const editor = useEditor();
	const scene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	const [openCluster, setOpenCluster] = useState<string | null>(null);

	const deduped = useMemo(() => {
		const tracks: TrackWithElements[] = scene
			? [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]
			: [];
		const isLive = (c: RemoteComment) => !c.element_id || resolveFindingTarget(tracks, c) !== null;
		return dedupeMarkers(
			comments.filter((c) => !c.parent_id),
			isLive,
		);
	}, [comments, scene]);

	const markers = useMemo(
		() =>
			deduped
				.map((d) => d.comment)
				// Draw resolved first and must last, so the loudest marker is on top.
				.sort((a, b) =>
					a.status !== b.status
						? a.status === "resolved"
							? -1
							: 1
						: severityRank(b.severity) - severityRank(a.severity),
				),
		[deduped],
	);
	const duplicatesOf = useMemo(
		() => new Map(deduped.map((d) => [d.comment.id, d.duplicateIds])),
		[deduped],
	);
	// A hidden duplicate can still be the selected one (e.g. picked from the gate sheet): show its kept copy.
	const selected =
		markers.find((c) => c.id === selectedId) ??
		markers.find((c) => selectedId !== null && (duplicatesOf.get(c.id) ?? []).includes(selectedId)) ??
		null;

	const leftOf = useCallback(
		(c: RemoteComment) => timelineTimeToPixels({ time: secondsToTicks(c.time_s), zoomLevel }),
		[zoomLevel],
	);
	const clusters = useMemo(
		() => clusterMarkers(markers, (c) => Math.max(0, leftOf(c) - JUDGE_MARKER_SIZE_PX / 2), JUDGE_MARKER_SIZE_PX),
		[markers, leftOf],
	);
	const closeList = useCallback(() => setOpenCluster(null), []);

	if (markers.length === 0) return null;

	const onPick = (id: string) => {
		const comment = markers.find((c) => c.id === id);
		if (!comment) return;
		setOpenCluster(null);
		select(id === selected?.id ? null : id);
		editor.playback.seek({ time: mediaTimeFromSeconds({ seconds: comment.time_s }) });
		selectFindingElement(editor, comment);
	};

	const openList = clusters.find((c) => c.key === openCluster && c.members.length > 1) ?? null;

	// polish agent, 2026-10-20: markers are the artboard's 14 px squares (radius 4) and a click opens the 360 px
	// finding card (review/finding-card.tsx: rule, severity, time, fix, who raised it; Jump · Apply fix · Resolve).
	// It replaced the one-line label + "resolve" that sat here (that resolve called the server for local gate
	// markers too and got a 404 — gate worklog open issue; the card resolves local markers in the store).
	return (
		<div
			className="relative flex-1 overflow-visible"
			style={{ height: ROW_HEIGHT_PX }}
			data-review-markers={markers.length}
		>
			<div className="relative" style={{ height: ROW_HEIGHT_PX, width: `${dynamicTimelineWidth}px` }}>
				{/* Span bars first (under every square). */}
				{markers.map((comment) => {
					const span =
						comment.time_end_s && comment.time_end_s > comment.time_s
							? timelineTimeToPixels({
									time: secondsToTicks(comment.time_end_s - comment.time_s),
									zoomLevel,
								})
							: 0;
					if (span <= JUDGE_MARKER_SIZE_PX) return null;
					const look = judgeMarkerStyle(comment, comment.id === selected?.id);
					return (
						<span
							key={`bar-${comment.id}`}
							aria-hidden
							className="pointer-events-none absolute rounded-full"
							style={{
								left: leftOf(comment),
								width: span,
								top: ROW_HEIGHT_PX / 2 - 1,
								height: 2,
								background: look.bar,
								opacity: look.opacity * 0.55,
								zIndex: 1,
							}}
						/>
					);
				})}
				{clusters.map((cluster) => {
					const count = cluster.members.length;
					const head = cluster.members.find((c) => c.id === selected?.id) ?? cluster.members[0];
					const isSelected = cluster.members.some((c) => c.id === selected?.id);
					const isOpen = openCluster === cluster.key && count > 1;
					const look = judgeMarkerStyle(head, isSelected || isOpen);
					const kilnDot = !isSelected && cluster.members.some((c) => isMachineAuthor(c.author));
					const label = markerLabel(head, (s) => formatTimecode(s, true));
					const ids = cluster.members.map((c) => c.id).join(" ");
					const filled = look.background !== "transparent" && look.background !== "#5A5A63";
					const top = (ROW_HEIGHT_PX - JUDGE_MARKER_SIZE_PX) / 2;
					return (
						<button
							key={cluster.key}
							type="button"
							data-review-marker-id={head.id}
							data-review-marker-ids={ids}
							data-review-cluster={cluster.key}
							title={
								count > 1
									? `${count} findings at ${formatTimecode(head.time_s, true)}`
									: `${label}${head.track_name ? ` · ${head.track_name}` : ""}`
							}
							aria-label={
								count > 1
									? `${count} judge findings at ${formatTimecode(head.time_s, true)}`
									: `Judge finding: ${label}`
							}
							aria-haspopup={count > 1 ? "dialog" : undefined}
							aria-expanded={count > 1 ? isOpen : isSelected}
							onMouseDown={(e) => e.stopPropagation()}
							onClick={(e) => {
								e.stopPropagation();
								if (count === 1) onPick(head.id);
								else {
									// The list replaces an open card; picking a row opens that finding's card.
									setOpenCluster(isOpen ? null : cluster.key);
									if (!isOpen) select(null);
								}
							}}
							className="rc-mono absolute flex cursor-pointer items-center justify-center p-0 text-[9px] leading-none font-bold"
							style={{
								// A finding at 0:00 would sit half off the row's left edge.
								left: cluster.left,
								top,
								minWidth: JUDGE_MARKER_SIZE_PX,
								height: JUDGE_MARKER_SIZE_PX,
								paddingInline: count > 9 ? 2 : 0,
								borderRadius: 4,
								boxSizing: "border-box",
								background: look.background,
								border: look.border,
								boxShadow: look.boxShadow,
								opacity: look.opacity,
								color: filled ? "#0C0C0E" : "var(--rc-bone)",
								zIndex: isSelected || isOpen ? 3 : 2,
							}}
						>
							{count > 1 ? count : null}
							{kilnDot && (
								<span
									aria-hidden
									className="bg-kiln absolute -top-[3px] -right-[3px] size-[5px] rounded-full"
								/>
							)}
						</button>
					);
				})}
			</div>
			{openList && (
				<MarkerClusterList
					anchorKey={openList.key}
					members={openList.members}
					onPick={onPick}
					onClose={closeList}
				/>
			)}
			{selected && !openList && (
				<FindingCard
					comment={selected}
					zoomLevel={zoomLevel}
					alsoResolve={duplicatesOf.get(selected.id) ?? []}
				/>
			)}
		</div>
	);
}
