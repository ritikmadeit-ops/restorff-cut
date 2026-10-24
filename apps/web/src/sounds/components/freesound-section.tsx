"use client";

import { useEffect } from "react";
import { FavouriteIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/utils/ui";
import { useSoundsStore } from "../sounds-store";
import type { SoundEffect } from "../types";
import { useSoundSearch } from "../use-sound-search";
import { playPreview, stopPreview } from "../preview";

/**
 * Freesound results under the built-in pack. The server route (app/api/sounds/search) needs FREESOUND_API_KEY;
 * without it the panel shows a one-line hint instead of rendering this.
 */
export function FreesoundSection({ query, playingUrl }: { query: string; playingUrl: string | null }) {
	const setSearchQuery = useSoundsStore((s) => s.setSearchQuery);
	const showCommercialOnly = useSoundsStore((s) => s.showCommercialOnly);
	const toggleCommercialFilter = useSoundsStore((s) => s.toggleCommercialFilter);
	const loadSavedSounds = useSoundsStore((s) => s.loadSavedSounds);
	const savedSounds = useSoundsStore((s) => s.savedSounds);

	useEffect(() => {
		setSearchQuery({ query });
	}, [query, setSearchQuery]);
	useEffect(() => {
		void loadSavedSounds();
	}, [loadSavedSounds]);

	const { results, isLoading, error, loadMore, hasNextPage, isLoadingMore, totalCount } = useSoundSearch({
		query,
		commercialOnly: showCommercialOnly,
	});

	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-2">
				<h3 className="rc-label text-fog text-[0.62rem]">
					Freesound{query.trim() && totalCount ? ` · ${totalCount}` : ""}
				</h3>
				<label className="text-fog hover:text-bone flex cursor-pointer items-center gap-1.5 text-[0.62rem] select-none">
					<input
						type="checkbox"
						checked={showCommercialOnly}
						onChange={() => toggleCommercialFilter()}
						className="accent-[#EDEBE6] size-3"
					/>
					commercial licences only
				</label>
			</div>
			{!query.trim() && savedSounds.length === 0 && (
				<p className="rc-mono text-fog text-[0.66rem]">type to search Freesound</p>
			)}
			{isLoading && <p className="rc-mono text-fog text-[0.66rem]">searching…</p>}
			{error && <p className="text-[0.66rem] text-[#E8A33D]">{error}</p>}
			{!isLoading && query.trim() && !error && results.length === 0 && (
				<p className="rc-mono text-fog text-[0.66rem]">no match on Freesound</p>
			)}
			<div className="flex flex-col gap-1.5" role="list">
				{(query.trim()
					? results
					: savedSounds.map(
							(saved): SoundEffect => ({
								id: saved.id,
								name: saved.name,
								description: "",
								url: "",
								previewUrl: saved.previewUrl,
								downloadUrl: saved.downloadUrl,
								duration: saved.duration,
								filesize: 0,
								type: "audio",
								channels: 0,
								bitrate: 0,
								bitdepth: 0,
								samplerate: 0,
								username: saved.username,
								tags: saved.tags,
								license: saved.license,
								created: saved.savedAt,
								downloads: 0,
								rating: 0,
								ratingCount: 0,
							}),
						)
				).map((sound) => (
					<FreesoundRow key={sound.id} sound={sound} playing={!!sound.previewUrl && playingUrl === sound.previewUrl} />
				))}
			</div>
			{query.trim() && hasNextPage && (
				<button
					type="button"
					onClick={() => void loadMore()}
					disabled={isLoadingMore}
					className="rc-mono text-fog hover:text-bone cursor-pointer self-start text-[0.66rem]"
				>
					{isLoadingMore ? "loading…" : "more from Freesound"}
				</button>
			)}
		</section>
	);
}

function FreesoundRow({ sound, playing }: { sound: SoundEffect; playing: boolean }) {
	const addSoundToTimeline = useSoundsStore((s) => s.addSoundToTimeline);
	const isSaved = useSoundsStore((s) => s.savedSounds.some((saved) => saved.id === sound.id));
	const toggleSavedSound = useSoundsStore((s) => s.toggleSavedSound);
	return (
		<div
			role="listitem"
			onMouseEnter={() => sound.previewUrl && playPreview(sound.previewUrl, { delay: 150 })}
			onMouseLeave={stopPreview}
			title={`${sound.name} by ${sound.username} · ${sound.license}`}
			className={cn(
				"group border-line hover:border-bone/40 flex items-center gap-3 rounded-[12px] border px-2.5 py-2 transition-colors",
				playing ? "bg-[#222228]" : "bg-surface",
			)}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="text-bone truncate text-[0.74rem] leading-tight">{sound.name}</span>
				<span className="rc-mono text-fog truncate text-[0.6rem]">
					{sound.duration.toFixed(2)} s · {sound.username} · {sound.license.replace(/^https?:\/\/[^/]+\//, "")}
				</span>
			</div>
			<button
				type="button"
				onClick={() => void toggleSavedSound({ soundEffect: sound })}
				title={isSaved ? "Remove from saved" : "Save"}
				className={cn("flex size-7 shrink-0 cursor-pointer items-center justify-center", isSaved ? "text-bone" : "text-fog hover:text-bone")}
			>
				<HugeiconsIcon icon={FavouriteIcon} className={cn("size-4", isSaved && "fill-current")} />
			</button>
			<button
				type="button"
				onClick={() => void addSoundToTimeline({ sound })}
				title="Add at the playhead"
				className="text-fog hover:text-bone flex size-7 shrink-0 cursor-pointer items-center justify-center"
			>
				<HugeiconsIcon icon={PlusSignIcon} className="size-4" />
			</button>
		</div>
	);
}
