"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { buildScene } from "@/services/renderer/scene-builder";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type { SceneTracks } from "@/timeline";
import { remote } from "@/sync/remote";
import { authorLabel, useSyncStore } from "@/sync/store";
import type { ProjectSnapshot } from "@/sync/snapshot";
import { grabFrames } from "@/storyboard/frame-grab";
import { useStoryboardStore } from "@/storyboard/store";

interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

interface BeforeSource {
	tree: RootNode;
	/** Mono chip text: "before · commit 7f3a1b2 · compiler" or "before · no effects". */
	label: string;
}

/**
 * Before / after wipe over the preview (reel DeUUFJQu8cw 9.1–15.0 s: the
 * "make it more aesthetic" wipe; FX-36). Left of the handle: the frame at the
 * playhead as it was BEFORE; right: the live preview (AFTER = now).
 *
 * "Before" is, in order:
 *   1. the previous commit's snapshot — the head itself when there are unsaved
 *      edits, else the head's parent (server commits from src/sync, port agent);
 *   2. otherwise the current cut with every effect switched off (fallback when
 *      there is no server copy or only one commit).
 * The frame is re-grabbed when the playhead or the cut changes (debounced), so
 * scrub with the transport and the wipe follows.
 */
export function CompareOverlay({ rect }: { rect: Rect }) {
	const editor = useEditor();
	const project = useEditor((e) => e.project.getActiveOrNull());
	const scene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	const tree = useEditor((e) => e.renderer.getRenderTree());
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const projectId = useSyncStore((s) => s.projectId);
	const head = useSyncStore((s) => s.head);
	const history = useSyncStore((s) => s.history);
	const status = useSyncStore((s) => s.status);
	const setCompare = useStoryboardStore((s) => s.setCompare);

	const [source, setSource] = useState<BeforeSource | null>(null);
	const [frame, setFrame] = useState<string | null>(null);
	const [split, setSplit] = useState(0.5);
	const [time, setTime] = useState(() => editor.playback.getCurrentTime());
	const boxRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		editor.playback.pause();
		const offSeek = editor.playback.onSeek(setTime);
		const offUpdate = editor.playback.onUpdate(setTime);
		return () => {
			offSeek();
			offUpdate();
		};
	}, [editor.playback]);

	// Which commit is "before".
	const beforeCommit = useMemo(() => {
		if (!head) return null;
		if (status === "dirty" || status === "conflict") return head;
		const list = history.length && history[0].id === head.id ? history : [head, ...history];
		const index = list.findIndex((c) => c.id === head.id);
		return list[index + 1] ?? null;
	}, [head, history, status]);

	// Build the "before" render tree.
	useEffect(() => {
		if (!project || !scene) return;
		let cancelled = false;
		const common = {
			canvasSize: project.settings.canvasSize,
			mediaAssets,
			duration: editor.timeline.getTotalDuration(),
			background: project.settings.background,
			isPreview: true,
		};
		const withoutEffects = (): BeforeSource => ({
			tree: buildScene({ ...common, tracks: stripEffects(scene.tracks) }),
			label: "before · no effects",
		});
		(async () => {
			if (projectId && beforeCommit) {
				try {
					const { commit } = await remote.getCommit(projectId, beforeCommit.id);
					const tracks = tracksFromSnapshot(commit.snapshot ?? null, scene.id);
					if (tracks && !cancelled) {
						setSource({
							tree: buildScene({ ...common, tracks }),
							label: `before · commit ${beforeCommit.id.slice(0, 7)} · ${authorLabel(beforeCommit.author)}`,
						});
						return;
					}
				} catch (error) {
					console.warn("[compare] previous commit unavailable, comparing without effects", error);
				}
			}
			if (!cancelled) setSource(withoutEffects());
		})();
		return () => {
			cancelled = true;
		};
	}, [project, scene, mediaAssets, projectId, beforeCommit, editor.timeline]);

	// Grab the "before" frame at the playhead (debounced), then restore the live frame.
	useEffect(() => {
		if (!source || !tree || !project) return;
		let cancelled = false;
		const handle = window.setTimeout(() => {
			const { canvasSize, fps } = project.settings;
			grabFrames([{ tree: source.tree, time }], {
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
				outWidth: Math.min(canvasSize.width, Math.max(240, Math.round(rect.width * 2))),
				restore: { tree, time },
				quality: 0.9,
				isCancelled: () => cancelled,
			})
				.then(([url]) => {
					if (!cancelled && url) setFrame(url);
				})
				.catch(() => undefined);
		}, 120);
		return () => {
			cancelled = true;
			window.clearTimeout(handle);
		};
	}, [source, tree, time, project, rect.width]);

	const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		event.stopPropagation();
		const box = boxRef.current;
		if (!box) return;
		const move = (clientX: number) => {
			const r = box.getBoundingClientRect();
			setSplit(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
		};
		move(event.clientX);
		const onMove = (e: PointerEvent) => move(e.clientX);
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	const pct = `${(split * 100).toFixed(2)}%`;

	return (
		<div
			ref={boxRef}
			className="pointer-events-none absolute z-20 overflow-hidden rounded-[16px]"
			style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
			aria-label="Before and after"
		>
			{frame && (
				// biome-ignore lint/performance/noImgElement: a data URL grabbed from the compositor
				<img
					src={frame}
					alt="Before"
					className="absolute inset-0 size-full object-cover"
					style={{ clipPath: `inset(0 calc(100% - ${pct}) 0 0)` }}
				/>
			)}
			{/* ui-fix-panels (QA #21): "before · commit …" and "after · now" no longer share one row (they overlapped on a
			    narrow picture); before sits bottom-left with the whole width to itself, after top-right; full text on hover */}
			<span
				title={source?.label ?? "before · loading"}
				className="rc-mono absolute bottom-2 left-2 max-w-[calc(100%-16px)] truncate rounded-[6px] bg-black/65 px-1.5 py-0.5 text-[10px] text-bone"
			>
				{source?.label ?? "before · loading"}
			</span>
			<span className="rc-mono absolute top-2 right-2 rounded-[6px] bg-black/65 px-1.5 py-0.5 text-[10px] whitespace-nowrap text-bone">
				after · now
			</span>
			{/* The wipe handle: a bone hairline with a round grip. */}
			<div
				role="slider"
				tabIndex={0}
				aria-label="Wipe position"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(split * 100)}
				onPointerDown={onPointerDown}
				onKeyDown={(e) => {
					if (e.key === "ArrowLeft") setSplit((s) => Math.max(0, s - 0.05));
					if (e.key === "ArrowRight") setSplit((s) => Math.min(1, s + 0.05));
					if (e.key === "Escape") setCompare(false);
					e.stopPropagation();
				}}
				className="pointer-events-auto absolute top-0 bottom-0 w-6 -translate-x-1/2 cursor-ew-resize outline-none"
				style={{ left: pct }}
			>
				<span className="bg-bone absolute top-0 bottom-0 left-1/2 w-[1.5px] -translate-x-1/2" />
				<span className="bg-bone absolute top-1/2 left-1/2 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[#0C0C0E] shadow-[0_2px_10px_rgba(0,0,0,.5)]">
					<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
						<path d="M6 3 1 8l5 5M10 3l5 5-5 5" />
					</svg>
				</span>
			</div>
		</div>
	);
}

/** The cut with every effect off: the fallback "before". */
function stripEffects(tracks: SceneTracks): SceneTracks {
	const strip = <T extends { elements: unknown[] }>(track: T): T => ({
		...track,
		elements: track.elements.map((element) =>
			element && typeof element === "object" && "effects" in element
				? { ...(element as object), effects: [] }
				: element,
		),
	});
	return {
		overlay: tracks.overlay.map(strip),
		main: strip(tracks.main),
		audio: tracks.audio,
	};
}

/** A commit snapshot's scene tracks, in the editor's shape (same JSON the editor saves). */
function tracksFromSnapshot(snapshot: ProjectSnapshot | null, sceneId: string): SceneTracks | null {
	if (!snapshot?.scenes?.length) return null;
	const scene =
		snapshot.scenes.find((s) => s.id === sceneId) ??
		snapshot.scenes.find((s) => s.id === snapshot.currentSceneId) ??
		snapshot.scenes.find((s) => s.isMain) ??
		snapshot.scenes[0];
	const tracks = scene?.tracks;
	if (!tracks?.main) return null;
	return {
		overlay: (tracks.overlay ?? []) as unknown as SceneTracks["overlay"],
		main: tracks.main as unknown as SceneTracks["main"],
		audio: (tracks.audio ?? []) as unknown as SceneTracks["audio"],
	};
}
