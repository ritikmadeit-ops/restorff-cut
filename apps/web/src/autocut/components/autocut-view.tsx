"use client";

import { useMemo, useState } from "react";
import type { CutPlan } from "@restorffcut/timeline-ops";
import { useEditor } from "@/editor/use-editor";
import { Card, Mono, NeonButton, Notice, PillButton, SectionLabel, formatSeconds, formatTime } from "@/captions/components/kit";
import { collectTimelineWords } from "@/captions/timeline-words";
import { captionDocFromWords, readCaptionDoc, rebuildCaptions } from "@/captions/build";
import { DEFAULT_CAPTION_STYLE_ID, getCaptionStyle } from "@restorffcut/timeline-ops";
import { transcribeMedia, useTranscriptStore, fingerprintOf } from "@/transcription/transcript-store";
import type { TranscribeSettings } from "@/transcription/components/transcript-view";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { cn } from "@/utils/ui";
import { applyCut, DEFAULT_CUT_SETTINGS, findCutTarget, planCut, type CutSettings } from "../plan";

const REASON_LABEL: Record<string, string> = {
	silence: "Dead air",
	retake: "Retake",
	head: "Before first word",
	tail: "After last word",
};

export function AutocutView({ transcribeSettings }: { transcribeSettings: TranscribeSettings }) {
	const editor = useEditor();
	// re-render on selection / timeline / media changes
	const selection = useEditor((e) => e.selection.getSelectedElements());
	const tracks = useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks ?? null);
	const assets = useEditor((e) => e.media.getAssets());
	const transcripts = useTranscriptStore((state) => state.transcripts);
	const jobs = useTranscriptStore((state) => state.jobs);

	const target = useMemo(
		() => (tracks ? findCutTarget({ editor }) : null),
		// recomputed whenever what findCutTarget reads (selection, tracks, media) changes
		[editor, selection, tracks, assets],
	);
	const transcript = useMemo(() => {
		if (!target) return null;
		const found = transcripts[target.asset.id];
		return found && found.fingerprint === fingerprintOf(target.asset) ? found : null;
	}, [target, transcripts]);

	const [settings, setSettings] = useState<CutSettings>(DEFAULT_CUT_SETTINGS);
	const [keep, setKeep] = useState<number[]>([]);
	const [planned, setPlanned] = useState<{ clipId: string; key: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);
	const [recaption, setRecaption] = useState(true);
	const [busy, setBusy] = useState(false);

	const planKey = target ? `${target.clip.id}:${target.clip.trimStart}:${target.clip.duration}` : "";
	const plan: CutPlan | null = useMemo(() => {
		if (!target || !transcript || !planned || planned.key !== planKey) return null;
		try {
			return planCut({ clip: target.clip, transcript, settings, keep });
		} catch {
			return null;
		}
	}, [target, transcript, planned, planKey, settings, keep]);

	const job = target ? jobs[target.asset.id] : undefined;

	const find = () => {
		if (!target || !transcript) return;
		setError(null);
		setDone(null);
		setKeep([]);
		try {
			planCut({ clip: target.clip, transcript, settings });
			setPlanned({ clipId: target.clip.id, key: planKey });
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	};

	const toggle = (index: number) =>
		setKeep((current) => (current.includes(index) ? current.filter((item) => item !== index) : [...current, index]));

	const apply = async () => {
		if (!plan) return;
		setBusy(true);
		setError(null);
		try {
			const hadCaptions = readCaptionDoc(editor.scenes.getActiveScene().tracks).doc.length > 0;
			const styleId = readCaptionDoc(editor.scenes.getActiveScene().tracks).styleId ?? DEFAULT_CAPTION_STYLE_ID;
			const removed = applyCut({ editor, plan });
			let note = `Cut ${formatSeconds(removed)} (${plan.removed.length} regions). Undo with Ctrl+Z.`;
			if (recaption && hadCaptions) {
				const { words } = collectTimelineWords({ editor });
				const style = getCaptionStyle(styleId);
				await rebuildCaptions({
					editor,
					doc: captionDocFromWords({ words, maxWords: style.maxWords }),
					styleId: style.id,
				});
				note += " Captions rebuilt on the new cut.";
			}
			setDone(note);
			setPlanned(null);
			setKeep([]);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(false);
		}
	};

	const seek = (seconds: number) => editor.playback.seek({ time: mediaTimeFromSeconds({ seconds }) });

	return (
		<div className="flex flex-col gap-4 pb-6">
			<p className="text-fog text-[0.72rem] leading-snug">
				Remove dead air and retakes from a talking-head clip using its word timings. Check the list, untick what
				should stay, then cut. One undo step.
			</p>

			<Card>
				<SectionLabel>Clip</SectionLabel>
				{!target && <Notice>Select a clip with speech on the timeline.</Notice>}
				{target && (
					<div className="flex items-center justify-between gap-2">
						<span className="min-w-0">
							<span className="text-bone block truncate text-[0.8rem] font-semibold">{target.clip.name}</span>
							<Mono className="text-fog">
								{formatTime(target.clip.startTime / TICKS_PER_SECOND)} ·{" "}
								{formatSeconds(target.clip.duration / TICKS_PER_SECOND)}
								{transcript ? ` · ${transcript.words.length} words · ${transcript.wordTimings}` : ""}
							</Mono>
						</span>
						{!transcript && (
							<PillButton
								disabled={job?.status === "working"}
								onClick={() =>
									void transcribeMedia({
										asset: target.asset,
										modelId: transcribeSettings.modelId,
										language: transcribeSettings.language,
									}).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
								}
							>
								{job?.status === "working" ? job.step : "Transcribe"}
							</PillButton>
						)}
					</div>
				)}
				{transcript?.wordTimings === "approximate" && (
					<div className="mt-2">
						<Notice tone="stale">Word times are approximate: check each cut before applying.</Notice>
					</div>
				)}
			</Card>

			<div className="flex flex-col gap-3">
				<SectionLabel>Rules</SectionLabel>
				<Slider
					label="Cut pauses longer than"
					value={settings.silence}
					min={0.2}
					max={1.5}
					step={0.05}
					onChange={(silence) => setSettings({ ...settings, silence })}
				/>
				<Slider
					label="Keep around words"
					value={settings.pad}
					min={0}
					max={0.25}
					step={0.01}
					onChange={(pad) => setSettings({ ...settings, pad })}
				/>
				<label className="flex cursor-pointer items-center justify-between gap-2">
					<span className="text-bone text-[0.76rem]">Cut earlier takes of repeated lines</span>
					<input
						type="checkbox"
						className="accent-[#F6FF00]"
						checked={settings.retakes}
						onChange={(event) => setSettings({ ...settings, retakes: event.target.checked })}
					/>
				</label>
				<PillButton disabled={!transcript || busy} onClick={find}>
					Find dead air & retakes
				</PillButton>
			</div>

			{plan && (
				<div>
					<SectionLabel
						right={
							<Mono className="text-bone">
								{formatSeconds(plan.stats.sourceSeconds)} → {formatSeconds(plan.stats.keptSeconds)}
							</Mono>
						}
					>
						{plan.candidates.length} found
					</SectionLabel>
					{plan.candidates.length === 0 && <Notice>Nothing to cut with these rules.</Notice>}
					<div className="flex flex-col gap-1">
						{plan.candidates.map((candidate) => (
							<div
								key={candidate.index}
								className={cn(
									"border-line flex items-start gap-2 rounded-[10px] border px-2.5 py-2",
									!candidate.applied && "opacity-50",
								)}
							>
								<input
									type="checkbox"
									className="mt-0.5 accent-[#F6FF00]"
									checked={candidate.applied}
									onChange={() => toggle(candidate.index)}
									aria-label={`cut ${REASON_LABEL[candidate.reason]} at ${formatTime(candidate.at)}`}
								/>
								<button
									type="button"
									className="min-w-0 flex-1 cursor-pointer text-left"
									onClick={() => seek(candidate.at)}
								>
									<span className="flex items-center justify-between gap-2">
										<span className="text-bone text-[0.76rem] font-semibold">{REASON_LABEL[candidate.reason]}</span>
										<Mono className="text-fog">
											{formatTime(candidate.at)} · {formatSeconds(candidate.end - candidate.start)}
										</Mono>
									</span>
									{candidate.detail && (
										<span className="text-fog block truncate text-[0.72rem] italic">“{candidate.detail}”</span>
									)}
								</button>
							</div>
						))}
					</div>
					{plan.retakes.length > 0 && (
						<p className="text-fog mt-2 text-[0.7rem] leading-snug">
							Retakes keep the last take: {plan.retakes.map((retake) => `“${retake.keptAs}”`).join(" · ")}
						</p>
					)}
					<label className="mt-3 flex cursor-pointer items-center justify-between gap-2">
						<span className="text-bone text-[0.76rem]">Rebuild captions after the cut</span>
						<input
							type="checkbox"
							className="accent-[#F6FF00]"
							checked={recaption}
							onChange={(event) => setRecaption(event.target.checked)}
						/>
					</label>
					<div className="mt-3">
						<NeonButton disabled={busy || !plan.ops.length} onClick={() => void apply()}>
							{busy ? "Cutting…" : `Cut ${formatSeconds(plan.stats.removedSeconds)}`}
						</NeonButton>
					</div>
				</div>
			)}

			{done && <Notice>{done}</Notice>}
			{error && <Notice tone="error">{error}</Notice>}
		</div>
	);
}

function Slider({
	label,
	value,
	min,
	max,
	step,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	onChange: (value: number) => void;
}) {
	return (
		<label className="flex flex-col gap-1">
			<span className="flex items-center justify-between">
				<span className="text-bone text-[0.76rem]">{label}</span>
				<Mono className="text-bone">{value.toFixed(2)} s</Mono>
			</span>
			<input
				type="range"
				className="accent-[#F6FF00]"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(event) => onChange(Number(event.target.value))}
			/>
		</label>
	);
}
