"use client";

import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";
import { cachedSfxBlob, loadSfxBlob, sfxFileName, type SfxSound } from "../library";
import { placeSfxAtPlayhead } from "../place";
import { playPreview, stopPreview } from "../preview";

const fmt = (value: number | null, digits = 1) => (value === null ? "n/a" : value.toFixed(digits).replace("-", "−"));

/**
 * One sound of the built-in pack. Hover = preview. Drag = the WAV as a file onto a timeline track (the timeline's
 * file drop imports it and puts its start under the mouse). + or double-click = on the SFX track with its event
 * (peak / attack) on the playhead, through ops@1.
 */
export function SfxRow({ sound, playing }: { sound: SfxSound; playing: boolean }) {
	const editor = useEditor();

	const place = () => {
		const result = placeSfxAtPlayhead({ editor, sound });
		if (result.ok) toast.success(result.message);
		else toast.error(`Couldn't place ${sound.name}`, { description: result.message });
	};

	const onDragStart = (event: React.DragEvent) => {
		stopPreview();
		const blob = cachedSfxBlob(sound);
		event.dataTransfer.effectAllowed = "copy";
		event.dataTransfer.setData("text/plain", sound.name);
		if (blob) {
			try {
				event.dataTransfer.items.add(new File([blob], sfxFileName(sound), { type: "audio/wav" }));
			} catch {
				// a browser that refuses files in dragstart: + still works
			}
		} else {
			void loadSfxBlob(sound);
		}
	};

	return (
		<div
			role="listitem"
			draggable
			onDragStart={onDragStart}
			onDragEnd={stopPreview}
			onMouseEnter={() => {
				void loadSfxBlob(sound).catch(() => undefined);
				playPreview(sound.url, { delay: 120 });
			}}
			onMouseLeave={stopPreview}
			onDoubleClick={place}
			title={`${sound.description}\nHover to hear · drag onto a track · + puts its ${sound.sync === "peak" ? "peak" : "attack"} on the playhead`}
			className={cn(
				"group border-line hover:border-bone/40 flex cursor-grab items-center gap-3 rounded-[12px] border px-2.5 py-2 transition-colors active:cursor-grabbing",
				playing ? "bg-[#222228]" : "bg-surface",
			)}
		>
			<Glyph sound={sound} playing={playing} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				{/* ui-fix-panels (QA #21): full name on two lines; the row's title has everything on hover */}
				<span className="text-bone line-clamp-2 text-[0.76rem] leading-tight break-words">{sound.name}</span>
				<span className="rc-mono text-fog truncate text-[0.6rem]">
					{sound.duration_s.toFixed(2)} s · M {fmt(sound.lufs_m_max)} LUFS · TP {fmt(sound.true_peak_dbtp)}
				</span>
			</div>
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					place();
				}}
				title="Put it on the SFX track at the playhead"
				className="text-fog hover:text-bone flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full opacity-70 group-hover:opacity-100"
			>
				<HugeiconsIcon icon={PlusSignIcon} className="size-4" />
			</button>
		</div>
	);
}

/** A tiny shape of the sound: where its event sits in its length (bone bar) and how long it is. */
function Glyph({ sound, playing }: { sound: SfxSound; playing: boolean }) {
	const at = sound.duration_s > 0 ? Math.min(1, sound.sync_s / sound.duration_s) : 0;
	return (
		<div className="relative h-8 w-10 shrink-0 overflow-hidden rounded-[8px] bg-[#0C0C0E]">
			<div
				className={cn("absolute inset-y-1.5 w-[3px] rounded-full", playing ? "bg-bone" : "bg-fog")}
				style={{ left: `calc(${(at * 100).toFixed(1)}% - ${at * 3}px)` }}
			/>
			<div
				className="absolute bottom-1 left-1 h-[2px] rounded-full bg-[#4a4a52]"
				style={{ width: `${Math.min(100, (sound.duration_s / 2) * 100) * 0.8}%` }}
			/>
		</div>
	);
}
