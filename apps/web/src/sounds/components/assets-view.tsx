"use client";

import { useEffect, useMemo, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DesignTheSound } from "@/sound-design/design-button";
import { MusicBedsSection } from "@/music/components/music-beds-section";
import { cn } from "@/utils/ui";
import { loadSfxPack, matchesSfx, type SfxPackManifest } from "../library";
import { onPreviewChange, previewingUrl, stopPreview } from "../preview";
import { FreesoundSection } from "./freesound-section";
import { SfxRow } from "./sfx-row";

/**
 * The SOUNDS tab (sounds agent, 2026-10-20; registered as the `sounds` entry of
 * components/editor/panels/assets/assets-panel-store.tsx, rendered by components/editor/panels/assets/index.tsx).
 *
 *   - "Design the sound": the owner's rule as one button (sound-design/).
 *   - The built-in pack "restorff-core": 20 sounds we generated (public/sfx, licence "generated, ours"), no key
 *     needed. Filter by category or search name / tag / role; hover to hear; drag onto a track; + to place.
 *   - Freesound, when FREESOUND_API_KEY is set (else a one-line hint).
 */
export function SoundsView() {
	const [pack, setPack] = useState<SfxPackManifest | null>(null);
	const [packError, setPackError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState<string | null>(null);
	const [freesound, setFreesound] = useState<{ ready: boolean; message: string | null } | null>(null);
	const [playingUrl, setPlayingUrl] = useState<string | null>(previewingUrl());

	useEffect(() => {
		let live = true;
		loadSfxPack()
			.then((manifest) => live && setPack(manifest))
			.catch((error) => live && setPackError(error instanceof Error ? error.message : String(error)));
		fetch("/api/sounds/status")
			.then((response) => (response.ok ? response.json() : null))
			.then((status) => live && setFreesound({ ready: !!status?.freesound, message: status?.message ?? null }))
			.catch(() => live && setFreesound({ ready: false, message: null }));
		const off = onPreviewChange(setPlayingUrl);
		return () => {
			live = false;
			off();
			stopPreview();
		};
	}, []);

	const categories = useMemo(() => {
		if (!pack) return [];
		const counts = new Map<string, number>();
		for (const sound of pack.sounds) counts.set(sound.category, (counts.get(sound.category) ?? 0) + 1);
		return [...counts.entries()];
	}, [pack]);

	const sounds = useMemo(
		() => (pack ? pack.sounds.filter((sound) => matchesSfx(sound, query, category)) : []),
		[pack, query, category],
	);

	return (
		<PanelView
			title="Sounds"
			actions={
				pack ? (
					<span className="rc-mono text-fog pr-2.5 text-[0.6rem]" title={pack.measured_with}>
						{pack.sounds.length} built in · {(pack.total_bytes / 1024 / 1024).toFixed(1)} MB
					</span>
				) : null
			}
		>
			<DesignTheSound />

			<input
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				placeholder="Search sounds: whoosh, riser, pop, hit…"
				className="bg-surface border-line text-bone placeholder:text-fog mb-3 w-full rounded-[10px] border px-3 py-1.5 text-[0.75rem] outline-none"
			/>
			<div className="mb-4 flex flex-wrap gap-1.5">
				<Chip active={category === null} onClick={() => setCategory(null)} label="all" />
				{categories.map(([name, count]) => (
					<Chip
						key={name}
						active={category === name}
						onClick={() => setCategory(category === name ? null : name)}
						label={`${name} ${count}`}
					/>
				))}
			</div>

			<section className="mb-6 flex flex-col gap-2">
				<div className="flex items-center justify-between gap-2">
					<h3 className="rc-label text-fog text-[0.62rem]">Restorff pack · {sounds.length}</h3>
					<span className="rc-mono text-[0.58rem] text-[#5c5c64]">generated, ours</span>
				</div>
				{packError && <p className="text-[0.68rem] text-[#E8A33D]">built-in pack unavailable: {packError}</p>}
				{!pack && !packError && <p className="rc-mono text-fog text-[0.66rem]">loading…</p>}
				{pack && sounds.length === 0 && <p className="rc-mono text-fog text-[0.66rem]">no built-in match</p>}
				<div className="flex flex-col gap-1.5" role="list">
					{sounds.map((sound) => (
						<SfxRow key={sound.id} sound={sound} playing={playingUrl === sound.url} />
					))}
				</div>
				<p className="text-[0.62rem] leading-snug text-[#5c5c64]">
					Hover to hear. Drag onto a track (the file starts where you drop it). + or double-click puts the
					sound's peak or attack on the playhead, on the SFX track.
				</p>
			</section>

			<MusicBedsSection query={query} playingUrl={playingUrl} />

			<div className="pb-6">
				{freesound?.ready ? (
					<FreesoundSection query={query} playingUrl={playingUrl} />
				) : (
					<section className="flex flex-col gap-1">
						<h3 className="rc-label text-fog text-[0.62rem]">Freesound</h3>
						<p className="rc-mono text-fog text-[0.66rem]">
							{freesound ? "add a Freesound key in settings" : "checking…"}
						</p>
						{freesound?.message && <p className="text-[0.6rem] text-[#5c5c64]">{freesound.message}</p>}
					</section>
				)}
			</div>
		</PanelView>
	);
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rc-mono cursor-pointer rounded-full border px-2.5 py-0.5 text-[0.62rem] transition-colors",
				active ? "border-bone text-bone" : "border-line text-fog hover:text-bone",
			)}
		>
			{label}
		</button>
	);
}
