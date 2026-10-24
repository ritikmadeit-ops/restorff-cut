"use client";

import { useState, useEffect, useRef } from "react";
import { useEditor } from "@/editor/use-editor";
import { invokeAction } from "@/actions";
import { useKeyboardShortcutsHelp } from "@/actions/use-keyboard-shortcuts-help";
import { Button } from "@/components/ui/button";
import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	FullScreenIcon,
	PauseIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Separator } from "@/components/ui/separator";
import {
	Select,
	SelectTrigger,
	SelectContent,
	SelectItem,
	SelectSeparator,
} from "@/components/ui/select";
import { PREVIEW_ZOOM_PRESETS } from "@/preview/zoom";
import { usePreviewViewport } from "./preview-viewport";
import { usePreviewStore } from "@/preview/preview-store";
import {
	Tooltip,
	TooltipTrigger,
	TooltipContent,
} from "@/components/ui/tooltip";
import {
	mediaTimeFromSeconds,
	snapSeekMediaTime,
	type MediaTime,
} from "@/wasm";
import { cn } from "@/utils/ui";
import { formatClock } from "@/utils/clock";

export function PreviewToolbar({
	onToggleFullscreen,
}: {
	onToggleFullscreen: () => void;
}) {
	// Transport from design/edit-artboard.png: prev · play (bone circle) · next,
	// then a mono "00:12.40 / 00:31.00". Zoom and fullscreen stay at the right.
	return (
		<div className="relative flex items-center justify-center px-[22px] pt-3.5 pb-[22px]">
			{/* Artboard DOM: gap 14; 40 px step buttons (radius 10, #2E2E35 on #16161A); 48 px bone play. */}
			<div className="flex items-center gap-3.5">
				<StepButton direction="backward" />
				<PlayPauseButton />
				<StepButton direction="forward" />
				<TimecodeDisplay />
			</div>
			<div className="absolute right-5 flex items-center gap-2.5">
				<ZoomSelect />
				<Separator orientation="vertical" className="h-4" />
				<Button
					variant="text"
					onClick={onToggleFullscreen}
					aria-label="Fullscreen preview"
					className="text-fog hover:text-bone"
				>
					<HugeiconsIcon icon={FullScreenIcon} />
				</Button>
			</div>
		</div>
	);
}

function TimecodeDisplay() {
	const editor = useEditor();
	const totalDuration = useEditor((e) => e.timeline.getTotalDuration());
	const fps = useEditor((e) => e.project.getActive().settings.fps);
	const [currentTime, setCurrentTime] = useState<MediaTime>(() =>
		editor.playback.getCurrentTime(),
	);
	const [draft, setDraft] = useState<string | null>(null);
	const [hasError, setHasError] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const isEditing = draft !== null;

	useEffect(() => {
		if (isEditing) inputRef.current?.select();
	}, [isEditing]);

	useEffect(() => {
		const unsubscribeUpdate = editor.playback.onUpdate(setCurrentTime);
		const unsubscribeSeek = editor.playback.onSeek(setCurrentTime);
		return () => {
			unsubscribeUpdate();
			unsubscribeSeek();
		};
	}, [editor.playback]);

	const commit = () => {
		if (draft === null) return;
		const seconds = parseClock(draft);
		if (seconds === null) {
			setHasError(true);
			return;
		}
		const time = mediaTimeFromSeconds({ seconds });
		editor.playback.seek({
			time: totalDuration
				? snapSeekMediaTime({ time, duration: totalDuration, fps })
				: time,
		});
		setDraft(null);
		setHasError(false);
	};

	return (
		<div className="rc-mono flex items-center text-[13px]">
			{draft === null ? (
				<button
					type="button"
					className="cursor-text rounded-sm px-0.5 text-bone hover:bg-accent"
					title="Click to type a time (mm:ss.cc)"
					onClick={() => setDraft(formatClock(currentTime))}
				>
					{formatClock(currentTime)}
				</button>
			) : (
				<input
					ref={inputRef}
					value={draft}
					aria-label="Playhead time (mm:ss.cc)"
					onChange={(event) => {
						setDraft(event.target.value);
						setHasError(false);
					}}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") commit();
						if (event.key === "Escape") {
							setDraft(null);
							setHasError(false);
						}
						event.stopPropagation();
					}}
					className={cn(
						"w-[5.6ch] rounded-sm bg-surface px-0.5 text-bone outline-none ring-1 ring-ring",
						hasError && "ring-destructive",
					)}
				/>
			)}
			<span className="text-mist">&nbsp;/ {formatClock(totalDuration)}</span>
		</div>
	);
}

/** "mm:ss.cc" or plain seconds -> seconds. */
function parseClock(value: string): number | null {
	const match = value.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
	if (!match) return null;
	const minutes = match[1] ? Number(match[1]) : 0;
	const seconds = Number(match[2]);
	if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
	return minutes * 60 + seconds;
}

function StepButton({ direction }: { direction: "backward" | "forward" }) {
	const isBack = direction === "backward";
	const label = isBack ? "Back 1 frame" : "Forward 1 frame";
	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					onClick={() =>
						invokeAction(isBack ? "frame-step-backward" : "frame-step-forward")
					}
					className="bg-surface flex size-10 cursor-pointer items-center justify-center rounded-[10px] border border-[#2e2e35] text-bone transition-colors hover:border-[#4a4a52]"
				>
					<HugeiconsIcon
						icon={isBack ? ArrowLeft01Icon : ArrowRight01Icon}
						className="size-4"
						strokeWidth={1.6}
					/>
				</button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

function ZoomSelect() {
	const { isAtFit, zoomPercent, fitToScreen, setViewportPercent } =
		usePreviewViewport();

	const displayLabel = isAtFit ? "Fit" : `${zoomPercent}%`;

	const onValueChange = (value: string) => {
		if (value === "fit") {
			fitToScreen();
		} else {
			setViewportPercent({ percent: Number(value) });
		}
	};

	return (
		<Select
			value={isAtFit ? "fit" : String(zoomPercent)}
			onValueChange={onValueChange}
		>
			<SelectTrigger className="tabular-nums">{displayLabel}</SelectTrigger>
			<SelectContent>
				<SelectItem value="fit">Fit</SelectItem>
				<SelectSeparator />
				{PREVIEW_ZOOM_PRESETS.map((preset) => (
					<SelectItem key={preset} value={String(preset)}>
						{preset}%
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function PlayPauseButton() {
	const isPlaying = useEditor((e) => e.playback.getIsPlaying());
	const { shortcuts } = useKeyboardShortcutsHelp();
	const shortcut = shortcuts.find((s) => s.action === "toggle-play");
	const tooltipText = shortcut
		? `Play/Pause (${shortcut.keys.join(" or ")})`
		: "Play/Pause";

	return (
		<Tooltip delayDuration={200}>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={isPlaying ? "Pause" : "Play"}
					onClick={() => invokeAction("toggle-play")}
					className="bg-bone flex size-12 cursor-pointer items-center justify-center rounded-full text-[#0C0C0E] transition-transform hover:scale-[1.04] active:scale-95"
				>
					<HugeiconsIcon
						icon={isPlaying ? PauseIcon : PlayIcon}
						className={cn("size-4 fill-current", !isPlaying && "translate-x-px")}
					/>
				</button>
			</TooltipTrigger>
			<TooltipContent>{tooltipText}</TooltipContent>
		</Tooltip>
	);
}
