"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Section, SectionContent } from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { duckMusicUnderVoice, DUCK_DEFAULTS } from "@/audio/duck";
import type { AudioElement } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { analysisToBeatGrid, analyzeElementBeats } from "../analyze";
import { getTimelineBeats, planSnapCutsToBeats } from "../timeline";

/**
 * "Beats & mix" properties tab for an audio element (media agent, 2026-10-20):
 * detect beats (ticks on the clip; cuts, the playhead and drags snap to them), snap the
 * main track's cuts to the nearest beat (a roll edit within ±6 frames), and duck this
 * track under the voice.
 */
export function MusicTab({ element, trackId }: { element: AudioElement; trackId: string }) {
	const editor = useEditor();
	const fps = useEditor((e) => e.project.getActive()?.settings.fps);
	const [busy, setBusy] = useState<null | "beats" | "duck">(null);
	const [duckDb, setDuckDb] = useState(DUCK_DEFAULTS.amountDb);
	const grid = element.beats;

	const detect = async () => {
		setBusy("beats");
		try {
			const analysis = await analyzeElementBeats({ element, mediaAssets: editor.media.getAssets() });
			if (analysis.beats.length === 0) {
				toast.error("No steady beat found in this audio");
				return;
			}
			editor.timeline.updateElements({
				updates: [{ trackId, elementId: element.id, patch: { beats: analysisToBeatGrid(analysis) } }],
			});
			toast.success(`${analysis.bpm} BPM · ${analysis.beats.length} beats · ${analysis.onsets.length} hits`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Beat detection failed");
		} finally {
			setBusy(null);
		}
	};

	const snapCuts = () => {
		if (!fps) return;
		const tracks = editor.scenes.getActiveScene().tracks;
		const beats = getTimelineBeats(tracks).map((beat) => beat.time);
		if (beats.length === 0) {
			toast.error("Detect beats on a music clip first");
			return;
		}
		const frameTicks = (TICKS_PER_SECOND * fps.denominator) / fps.numerator;
		const plan = planSnapCutsToBeats({
			track: tracks.main,
			beats,
			maxShiftTicks: frameTicks * 6,
			minClipTicks: frameTicks * 6,
			frameTicks,
		});
		if (plan.updates.length > 0) editor.timeline.updateElements({ updates: plan.updates });
		toast.success(
			`${plan.moved} cut${plan.moved === 1 ? "" : "s"} moved onto the beat` +
				(plan.skipped ? ` · ${plan.skipped} left (no beat within 6 frames, or no spare media)` : ""),
		);
	};

	const duck = async () => {
		setBusy("duck");
		try {
			const result = await duckMusicUnderVoice({ editor, musicTrackId: trackId, amountDb: duckDb });
			if (result.ducked === 0) {
				toast.info("No voice found under this music (main track or a voice audio track)");
				return;
			}
			toast.success(
				`Ducked ${duckDb} dB under ${result.phrases} phrase${result.phrases === 1 ? "" : "s"} (${result.voiceSeconds.toFixed(1)} s of voice)`,
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Ducking failed");
		} finally {
			setBusy(null);
		}
	};

	return (
		<Section sectionKey={`${element.id}:music`}>
			<SectionContent className="flex flex-col gap-4 pt-4">
				<div className="flex flex-col gap-2">
					<span className="rc-label text-fog text-[0.62rem]">Beats</span>
					{grid ? (
						<p className="rc-mono text-bone text-[0.72rem]">
							{grid.bpm} BPM · {grid.times.length} beats · bars estimated
						</p>
					) : (
						<p className="text-fog text-[0.72rem] leading-snug">
							Find the beat so cuts, the playhead and drags snap to it (music to picture).
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						<button type="button" className="rc-pill" disabled={busy !== null} onClick={detect}>
							{busy === "beats" ? "Listening…" : grid ? "Detect again" : "Detect beats"}
						</button>
						{grid && (
							<button type="button" className="rc-pill" onClick={snapCuts}>
								Snap cuts to beats
							</button>
						)}
						{grid && (
							<button
								type="button"
								className="rc-pill"
								onClick={() =>
									editor.timeline.updateElements({
										updates: [{ trackId, elementId: element.id, patch: { beats: undefined } }],
									})
								}
							>
								Clear
							</button>
						)}
					</div>
				</div>

				<div className="flex flex-col gap-2">
					<span className="rc-label text-fog text-[0.62rem]">Duck under voice · {duckDb} dB</span>
					<input
						type="range"
						min={-18}
						max={-12}
						step={1}
						value={duckDb}
						onChange={(event) => setDuckDb(Number(event.target.value))}
						aria-label="Duck amount in dB"
					/>
					<p className="text-fog text-[0.72rem] leading-snug">
						Listens to the main track and voice tracks, then lowers this track while someone speaks (80 ms in, 300 ms
						out). Replaces this clip's volume keyframes.
					</p>
					<button type="button" className="rc-pill self-start" disabled={busy !== null} onClick={duck}>
						{busy === "duck" ? "Listening…" : "Duck under voice"}
					</button>
				</div>
			</SectionContent>
		</Section>
	);
}
