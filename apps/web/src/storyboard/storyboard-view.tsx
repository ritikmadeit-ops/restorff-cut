"use client";

import { useEffect, useMemo, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { cn } from "@/utils/ui";
import { buildShots, type Shot } from "./shots";
import { grabFrames } from "./frame-grab";
import { formatShortTime, formatTenths } from "./labels";
import { useStoryboardStore } from "./store";

const FRAME_WIDTH_PX = 180;

/**
 * The storyboard (reel DeUUFJQu8cw 29.7–35.2 s: "before rendering, it gives me a
 * complete storyboard"): every shot as a card — the composited frame at the
 * shot's midpoint, "01 · 0:00.0–0:02.8 · 2.8 s", its track, the words over it
 * and any on-screen text. Click a card: the playhead jumps to it, the clip is
 * selected and the Edit view comes back. Gaps (nothing on screen) get a card too.
 */
export function StoryboardView() {
	const editor = useEditor();
	const scene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	const project = useEditor((e) => e.project.getActiveOrNull());
	const tree = useEditor((e) => e.renderer.getRenderTree());
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const setView = useStoryboardStore((s) => s.setView);
	const shots = useMemo(() => buildShots(scene), [scene]);
	const [frames, setFrames] = useState<Record<string, string>>({});
	const [playheadSeconds, setPlayheadSeconds] = useState(
		() => editor.playback.getCurrentTime() / TICKS_PER_SECOND,
	);

	useEffect(() => {
		editor.playback.pause();
		return editor.playback.onSeek((time) => setPlayheadSeconds(time / TICKS_PER_SECOND));
	}, [editor.playback]);

	// Composite frames, one per shot, at its midpoint. Re-run when the cut changes.
	const signature = shots.map((s) => `${s.id}:${s.midTicks}`).join("|");
	useEffect(() => {
		if (!tree || !project || shots.length === 0) return;
		let cancelled = false;
		const { canvasSize, fps } = project.settings;
		const ids = shots.map((s) => s.id);
		grabFrames(
			shots.map((s) => ({ tree, time: s.midTicks })),
			{
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
				outWidth: FRAME_WIDTH_PX,
				restore: { tree, time: editor.playback.getCurrentTime() },
				isCancelled: () => cancelled,
				onFrame: (index, url) => {
					if (cancelled) return;
					setFrames((prev) => ({ ...prev, [ids[index]]: url }));
				},
			},
		).catch((error) => console.warn("[storyboard] frames", error));
		return () => {
			cancelled = true;
		};
		// signature covers shots; tree identity changes on every edit
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [signature, tree, project?.settings.canvasSize.width, project?.settings.canvasSize.height]);

	const runtime = shots.reduce((max, s) => Math.max(max, s.end), 0);
	const shotCount = shots.filter((s) => s.role !== "GAP").length;
	const aspect = project
		? `${project.settings.canvasSize.width} / ${project.settings.canvasSize.height}`
		: "9 / 16";

	const open = (shot: Shot) => {
		editor.playback.seek({ time: mediaTimeFromSeconds({ seconds: shot.start }) });
		if (shot.trackId && shot.elementId) {
			editor.selection.setSelectedElements({
				elements: [{ trackId: shot.trackId, elementId: shot.elementId }],
			});
		}
		setView("edit");
	};

	return (
		// pt-14 keeps the header clear of the floating "Tell Claude" bar over the preview.
		<div className="flex size-full min-h-0 flex-col pt-14">
			<div className="flex shrink-0 items-baseline gap-4 px-[22px] pb-3">
				<h2 className="rc-label">
					Storyboard · {shotCount} {shotCount === 1 ? "shot" : "shots"} · {formatShortTime(runtime)}
				</h2>
				<span className="rc-mono text-fog text-[11px]">
					frame at each shot’s middle · click a card to edit there
				</span>
			</div>
			{shots.length === 0 ? (
				<div className="text-fog flex flex-1 items-center justify-center text-[14px]">
					No shots yet. Put clips on V1 A-ROLL and the storyboard fills in.
				</div>
			) : (
				<ol className="scrollbar-hidden grid flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-x-3.5 gap-y-5 overflow-y-auto px-[22px] pb-[22px]">
					{shots.map((shot) => {
						const isCurrent =
							shot.role !== "GAP" && playheadSeconds >= shot.start && playheadSeconds < shot.end;
						const fallback = shot.mediaId
							? mediaAssets.find((a) => a.id === shot.mediaId)?.thumbnailUrl
							: undefined;
						const src = frames[shot.id] ?? fallback;
						return (
							<li key={shot.id} className="min-w-0">
								<button
									type="button"
									onClick={() => open(shot)}
									className="group flex w-full flex-col gap-2 text-left outline-none"
									title={`${shot.name} · ${formatTenths(shot.start)}–${formatTenths(shot.end)}`}
								>
									<span
										className={cn(
											"bg-surface relative block w-full overflow-hidden rounded-[10px] shadow-[0_0_0_1px_#2e2e35] transition-shadow group-hover:shadow-[0_0_0_1px_#8c8c95] group-focus-visible:shadow-[0_0_0_1.5px_#edebe6]",
											isCurrent && "shadow-[0_0_0_1.5px_#edebe6]",
											shot.role === "GAP" && "border border-dashed border-[#3a3a42] bg-transparent shadow-none",
										)}
										style={{ aspectRatio: aspect }}
									>
										{src && shot.role !== "GAP" && (
											// biome-ignore lint/performance/noImgElement: data URLs from the compositor
											<img src={src} alt="" className="absolute inset-0 size-full object-cover" />
										)}
										<span className="rc-mono absolute top-1.5 left-1.5 rounded-[4px] bg-black/60 px-1 text-[10px] leading-[14px] text-bone">
											{String(shot.number).padStart(2, "0")}
										</span>
									</span>
									<span className="rc-mono text-mist text-[10px] leading-[14px]">
										{formatTenths(shot.start)}–{formatTenths(shot.end)} · {(shot.end - shot.start).toFixed(1)} s
									</span>
									<span className="flex min-w-0 items-baseline gap-1.5">
										<span className="rc-mono text-fog shrink-0 text-[10px] tracking-[0.08em]">{shot.role}</span>
										<span className="truncate text-[13px] text-bone">{shot.name}</span>
									</span>
									{shot.emphasis.length > 0 && (
										<span className="rc-mono text-bone line-clamp-2 text-[10px] leading-[14px] uppercase">
											<span className="text-fog">text · </span>
											{shot.emphasis.join(" / ")}
										</span>
									)}
									{shot.words && (
										<span className="text-fog line-clamp-3 text-[12px] leading-snug">“{shot.words}”</span>
									)}
								</button>
							</li>
						);
					})}
				</ol>
			)}
		</div>
	);
}
