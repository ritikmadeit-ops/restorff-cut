"use client";

import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import type { MusicBed } from "@/server/music-plan";
import { playPreview, stopPreview } from "@/sounds/preview";
import { cn } from "@/utils/ui";
import { loadMusicBeds, matchesBed, type MusicBedsManifest } from "../library";
import { placeBedUnderCut } from "../place";

const fmt = (value: number | null | undefined, digits = 1) => (typeof value === "number" ? value.toFixed(digits).replace("-", "−") : "n/a");

/**
 * MUSIC BEDS in the Sounds tab (voice-music agent, 2026-10-20), under the SFX pack: the five generated beds
 * (public/music, licence "generated, ours"). Hover = hear (the shared preview voice of src/sounds/preview.ts);
 * + = under the whole cut on the MUSIC track, looped, beats on the clip, ducked under a VOICE track — one undo step.
 * Mounted by one line in src/sounds/components/assets-view.tsx (sounds agent's file).
 */
export function MusicBedsSection({ query, playingUrl }: { query: string; playingUrl: string | null }) {
	const [manifest, setManifest] = useState<MusicBedsManifest | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		loadMusicBeds()
			.then((loaded) => live && setManifest(loaded))
			.catch((failure) => live && setError(failure instanceof Error ? failure.message : String(failure)));
		return () => {
			live = false;
		};
	}, []);

	const beds = useMemo(() => (manifest ? manifest.beds.filter((bed) => matchesBed(bed, query)) : []), [manifest, query]);

	return (
		<section className="mb-6 flex flex-col gap-2">
			<div className="flex items-center justify-between gap-2">
				<h3 className="rc-label text-fog whitespace-nowrap text-[0.62rem]">Music beds · {beds.length}</h3>
				<span className="rc-mono whitespace-nowrap text-[0.58rem] text-[#5c5c64]" title={manifest?.licence_note}>
					ours
				</span>
			</div>
			{error && <p className="text-[0.68rem] text-[#E8A33D]">music beds unavailable: {error}</p>}
			{!manifest && !error && <p className="rc-mono text-fog text-[0.66rem]">loading…</p>}
			{manifest && beds.length === 0 && <p className="rc-mono text-fog text-[0.66rem]">no bed matches</p>}
			<div className="flex flex-col gap-1.5" role="list">
				{beds.map((bed) => (
					<BedRow key={bed.id} bed={bed} playing={playingUrl === bed.url} />
				))}
			</div>
			<p className="text-[0.62rem] leading-snug text-[#5c5c64]">
				Hover to hear. + puts the bed under the whole cut on the MUSIC track — looped, its beats on the clip, ducked
				under a VOICE track. Claude does the same with the music tool.
			</p>
		</section>
	);
}

function BedRow({ bed, playing }: { bed: MusicBed; playing: boolean }) {
	const editor = useEditor();
	const place = () => {
		stopPreview();
		const result = placeBedUnderCut({ editor, bed });
		if (result.ok) toast.success(result.message);
		else toast.error(`Couldn't place ${bed.name}`, { description: result.message });
	};
	return (
		<div
			role="listitem"
			onMouseEnter={() => playPreview(bed.url, { delay: 150, volume: 0.6 })}
			onMouseLeave={stopPreview}
			onDoubleClick={place}
			title={`${bed.name} (${bed.mood}) · ${bed.key ?? ""} · ${fmt(bed.lufs_i)} LUFS\n${bed.description ?? ""}\n${bed.use ?? ""}\nHover to hear · + or double-click: under the whole cut`}
			className={cn(
				"group border-line hover:border-bone/40 flex items-center gap-3 rounded-[12px] border px-2.5 py-2 transition-colors",
				playing ? "bg-[#222228]" : "bg-surface",
			)}
		>
			<BeatGlyph bed={bed} playing={playing} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				{/* ui-fix-panels (QA #21): the whole name on two lines and the facts wrapping ("Warm mor…", "upbeat · 1…") */}
				<span className="text-bone line-clamp-2 text-[0.76rem] leading-tight break-words">{bed.name}</span>
				<span className="rc-mono text-fog text-[0.6rem] leading-snug">
					{bed.mood} · {bed.bpm} BPM · {Math.round(bed.duration_s)} s
				</span>
			</div>
			<button
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					place();
				}}
				title="Put it under the whole cut (MUSIC track)"
				className="text-fog hover:text-bone flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full opacity-70 group-hover:opacity-100"
			>
				<HugeiconsIcon icon={PlusSignIcon} className="size-4" />
			</button>
		</div>
	);
}

/** Four bars of beat ticks, the downbeats taller: the bed's tempo at a glance. */
function BeatGlyph({ bed, playing }: { bed: MusicBed; playing: boolean }) {
	const ticks = Math.min(16, bed.beat_times_s.length);
	return (
		<div className="relative flex h-8 w-10 shrink-0 items-end justify-between overflow-hidden rounded-[8px] bg-[#0C0C0E] px-1 pb-1">
			{Array.from({ length: ticks }, (_, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative ticks
					key={i}
					className={cn("w-[1.5px] rounded-full", i % 4 === 0 ? (playing ? "bg-bone" : "bg-fog") : "bg-[#4a4a52]")}
					style={{ height: i % 4 === 0 ? "70%" : "35%" }}
				/>
			))}
		</div>
	);
}
