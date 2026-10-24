"use client";

import { useMemo, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { listSpokenClips, clipWordsOnTimeline } from "@/captions/timeline-words";
import { Card, Mono, NeonButton, Notice, PillButton, SectionLabel, formatTime } from "@/captions/components/kit";
import { TRANSCRIPTION_MODELS } from "@/transcription/models";
import { TRANSCRIPTION_LANGUAGES } from "@/transcription/supported-languages";
import {
	fingerprintOf,
	transcribeMedia,
	useTranscriptStore,
	type MediaTranscript,
} from "@/transcription/transcript-store";
import type { TranscriptionLanguage, TranscriptionModelId } from "@/transcription/types";
import type { MediaAsset } from "@/media/types";
import { mediaTimeFromSeconds } from "@/wasm";
import { cn } from "@/utils/ui";

export interface TranscribeSettings {
	modelId: TranscriptionModelId;
	language: TranscriptionLanguage;
}

/** Spoken media on the timeline (one row per file), with its transcript status. */
export function useSpokenMedia(): Array<{ asset: MediaAsset; clips: number; onMain: boolean }> {
	const tracks = useEditor((editor) => editor.scenes.getActiveSceneOrNull()?.tracks ?? null);
	const assets = useEditor((editor) => editor.media.getAssets());
	return useMemo(() => {
		if (!tracks) return [];
		const byId = new Map(assets.map((asset) => [asset.id, asset]));
		const rows = new Map<string, { asset: MediaAsset; clips: number; onMain: boolean }>();
		for (const clip of listSpokenClips(tracks)) {
			const asset = byId.get(clip.mediaId);
			if (!asset || (asset.type === "video" && asset.hasAudio === false)) continue;
			const row = rows.get(asset.id) ?? { asset, clips: 0, onMain: false };
			row.clips++;
			row.onMain ||= clip.trackId === tracks.main.id;
			rows.set(asset.id, row);
		}
		return [...rows.values()].sort((a, b) => Number(b.onMain) - Number(a.onMain));
	}, [tracks, assets]);
}

export function TranscriptView({
	settings,
	onSettings,
}: {
	settings: TranscribeSettings;
	onSettings: (settings: TranscribeSettings) => void;
}) {
	const editor = useEditor();
	const media = useSpokenMedia();
	const transcripts = useTranscriptStore((state) => state.transcripts);
	const jobs = useTranscriptStore((state) => state.jobs);
	const [openId, setOpenId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const statusOf = (asset: MediaAsset): MediaTranscript | null => {
		const found = transcripts[asset.id];
		return found && found.fingerprint === fingerprintOf(asset) ? found : null;
	};
	const missing = media.filter((row) => !statusOf(row.asset));
	const busy = Object.values(jobs).some((job) => job.status === "working");

	const transcribe = async (assets: MediaAsset[], force = false) => {
		setError(null);
		for (const asset of assets) {
			try {
				await transcribeMedia({ asset, modelId: settings.modelId, language: settings.language, force });
			} catch (caught) {
				setError(caught instanceof Error ? caught.message : String(caught));
				return;
			}
		}
	};

	const open = media.find((row) => row.asset.id === openId) ?? media.find((row) => statusOf(row.asset));
	const openTranscript = open ? statusOf(open.asset) : null;

	/** Seek to a word: its first appearance on the timeline (any clip of that file). */
	const seekToWord = (asset: MediaAsset, transcript: MediaTranscript, index: number) => {
		const word = transcript.words[index];
		const tracks = editor.scenes.getActiveScene().tracks;
		for (const clip of listSpokenClips(tracks)) {
			if (clip.mediaId !== asset.id) continue;
			const placed = clipWordsOnTimeline(clip, { ...transcript, words: [word] });
			if (placed.length) {
				editor.playback.seek({ time: mediaTimeFromSeconds({ seconds: placed[0].start }) });
				return;
			}
		}
	};

	return (
		<div className="flex flex-col gap-4 pb-6">
			<p className="text-fog text-[0.72rem] leading-snug">
				Transcribed here in the browser (Whisper), word by word. Cached per file, so cutting and captioning never
				transcribe twice.
			</p>

			<div className="grid grid-cols-2 gap-2">
				<label className="flex flex-col gap-1">
					<Mono className="text-fog uppercase tracking-[0.08em]">Model</Mono>
					<select
						className="bg-surface border-line text-bone h-8 rounded-[10px] border px-2 text-[0.74rem]"
						value={settings.modelId}
						onChange={(event) => onSettings({ ...settings, modelId: event.target.value as TranscriptionModelId })}
					>
						{TRANSCRIPTION_MODELS.map((model) => (
							<option key={model.id} value={model.id}>
								{model.name}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1">
					<Mono className="text-fog uppercase tracking-[0.08em]">Language</Mono>
					<select
						className="bg-surface border-line text-bone h-8 rounded-[10px] border px-2 text-[0.74rem]"
						value={settings.language}
						onChange={(event) =>
							onSettings({ ...settings, language: event.target.value as TranscriptionLanguage })
						}
					>
						<option value="auto">Auto detect</option>
						{TRANSCRIPTION_LANGUAGES.map((language) => (
							<option key={language.code} value={language.code}>
								{language.name}
							</option>
						))}
					</select>
				</label>
			</div>

			<div>
				<SectionLabel right={<Mono className="text-fog">{media.length} files</Mono>}>Spoken clips</SectionLabel>
				{media.length === 0 && <Notice>Add a clip with sound to the timeline first.</Notice>}
				<div className="flex flex-col gap-1.5">
					{media.map(({ asset, clips, onMain }) => {
						const transcript = statusOf(asset);
						const job = jobs[asset.id];
						return (
							<button
								type="button"
								key={asset.id}
								onClick={() => setOpenId(asset.id)}
								className={cn(
									"bg-surface border-line flex cursor-pointer items-center justify-between gap-2 rounded-[12px] border px-3 py-2 text-left",
									open?.asset.id === asset.id && "border-bone/40",
								)}
							>
								<span className="min-w-0">
									<span className="text-bone block truncate text-[0.78rem] font-semibold">{asset.name}</span>
									<Mono className="text-fog">
										{onMain ? "A-ROLL" : "CLIP"} · {clips} on timeline
									</Mono>
								</span>
								<Mono
									className={cn(
										"shrink-0 text-right",
										job?.status === "error" ? "text-[#ff8a8e]" : transcript ? "text-bone" : "text-fog",
									)}
								>
									{job?.status === "working"
										? job.step
										: job?.status === "error"
											? "failed"
											: transcript
												? `${transcript.words.length} words · ${transcript.wordTimings}`
												: "not yet"}
								</Mono>
							</button>
						);
					})}
				</div>
			</div>

			{missing.length > 0 && (
				<NeonButton disabled={busy} onClick={() => void transcribe(missing.map((row) => row.asset))}>
					{busy ? "Transcribing…" : `Transcribe ${missing.length === 1 ? "this clip" : `${missing.length} files`}`}
				</NeonButton>
			)}
			{error && <Notice tone="error">{error}</Notice>}

			{open && openTranscript && (
				<Card>
					<SectionLabel
						right={
							<PillButton disabled={busy} onClick={() => void transcribe([open.asset], true)}>
								Redo
							</PillButton>
						}
					>
						Transcript
					</SectionLabel>
					{openTranscript.wordTimings === "approximate" && (
						<div className="mb-2">
							<Notice tone="stale">
								Word times are approximate (this model gave sentence times only). Cuts may land a little off;
								try the model again or another one.
							</Notice>
						</div>
					)}
					<p className="text-bone max-h-64 overflow-y-auto text-[0.78rem] leading-relaxed">
						{openTranscript.words.map((word, index) => (
							<button
								type="button"
								key={`${index}-${word.start}`}
								title={formatTime(word.start)}
								onClick={() => seekToWord(open.asset, openTranscript, index)}
								className="hover:bg-neon cursor-pointer rounded-[4px] px-[1px] hover:text-[#0C0C0E]"
							>
								{word.text}{" "}
							</button>
						))}
					</p>
				</Card>
			)}
		</div>
	);
}
