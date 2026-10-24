"use client";

import { useMemo, useState } from "react";
import { DEFAULT_CAPTION_STYLE_ID, getCaptionStyle, type CaptionDocChunk } from "@restorffcut/timeline-ops";
import { useEditor } from "@/editor/use-editor";
import { transcribeMedia } from "@/transcription/transcript-store";
import type { TranscribeSettings } from "@/transcription/components/transcript-view";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { captionDocFromWords, clearCaptions, readCaptionDoc, rebuildCaptions } from "../build";
import { collectTimelineWords } from "../timeline-words";
import { CaptionList } from "./caption-list";
import { Mono, NeonButton, Notice, PillButton, SectionLabel, Segmented } from "./kit";
import { CaptionStylePicker } from "./style-picker";

type WordsChoice = "style" | "1" | "2" | "3";

const WORD_OPTIONS: Array<{ id: WordsChoice; label: string }> = [
	{ id: "style", label: "Style" },
	{ id: "1", label: "1 word" },
	{ id: "2", label: "2 words" },
	{ id: "3", label: "3 words" },
];

export function CaptionsView({ transcribeSettings }: { transcribeSettings: TranscribeSettings }) {
	const editor = useEditor();
	const tracks = useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks ?? null);
	const playhead = useEditor((e) => e.playback.getCurrentTime());
	const current = useMemo(
		() => (tracks ? readCaptionDoc(tracks) : { doc: [], styleId: null, trackId: null }),
		[tracks],
	);
	const [picked, setPicked] = useState<string | null>(null);
	const styleId = picked ?? current.styleId ?? DEFAULT_CAPTION_STYLE_ID;
	const [wordsChoice, setWordsChoice] = useState<WordsChoice>("style");
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);

	const maxWords = (id: string) => (wordsChoice === "style" ? getCaptionStyle(id).maxWords : Number(wordsChoice));

	const run = async (label: string, work: () => Promise<string | null>) => {
		setBusy(label);
		setError(null);
		setNote(null);
		try {
			setNote(await work());
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setBusy(null);
		}
	};

	const autoCaptions = (id = styleId) =>
		run("Captioning…", async () => {
			let collected = collectTimelineWords({ editor });
			// transcribe what isn't yet (cached afterwards)
			for (const asset of collected.missing) {
				setBusy(`Transcribing ${asset.name}…`);
				await transcribeMedia({ asset, modelId: transcribeSettings.modelId, language: transcribeSettings.language });
			}
			if (collected.missing.length) collected = collectTimelineWords({ editor });
			if (!collected.words.length) throw new Error("No speech found on the timeline.");
			const doc = captionDocFromWords({ words: collected.words, maxWords: maxWords(id) });
			setBusy("Laying out…");
			const report = await rebuildCaptions({ editor, doc, styleId: id });
			return `${report.chunks} captions · ${getCaptionStyle(id).label}${report.shrunk ? ` · ${report.shrunk} shrunk to fit the safe area` : ""}`;
		});

	const restyle = (id: string) => {
		setPicked(id);
		if (!current.doc.length) return;
		void run("Restyling…", async () => {
			const report = await rebuildCaptions({ editor, doc: current.doc, styleId: id });
			return `Restyled ${report.chunks} captions · ${getCaptionStyle(id).label}`;
		});
	};

	const edit = (doc: CaptionDocChunk[]) =>
		void run("Updating…", async () => {
			await rebuildCaptions({ editor, doc, styleId });
			return null;
		});

	const rechunk = () =>
		void run("Re-chunking…", async () => {
			const words = current.doc.flatMap((chunk) => chunk.words);
			const doc = captionDocFromWords({ words, maxWords: maxWords(styleId) });
			const report = await rebuildCaptions({ editor, doc, styleId });
			return `${report.chunks} captions`;
		});

	const seek = (seconds: number) => editor.playback.seek({ time: mediaTimeFromSeconds({ seconds }) });
	const hasCaptions = current.doc.length > 0;

	return (
		<div className="flex flex-col gap-4 pb-6">
			<p className="text-fog text-[0.72rem] leading-snug">
				Captions from the transcript, 1–3 words at a time, kept inside the safe area. Pick a style; switching styles
				restyles the captions already on the timeline.
			</p>

			<div>
				<SectionLabel right={<Mono className="text-fog">{getCaptionStyle(styleId).source}</Mono>}>Style</SectionLabel>
				<CaptionStylePicker value={styleId} onPick={restyle} disabled={Boolean(busy)} />
			</div>

			<div>
				<SectionLabel>Words per caption</SectionLabel>
				<Segmented value={wordsChoice} options={WORD_OPTIONS} onChange={setWordsChoice} />
			</div>

			<div className="flex flex-col gap-2">
				<NeonButton disabled={Boolean(busy)} onClick={() => void autoCaptions()}>
					{busy ?? (hasCaptions ? "Redo auto captions" : "Auto captions")}
				</NeonButton>
				{hasCaptions && (
					<div className="grid grid-cols-2 gap-2">
						<PillButton disabled={Boolean(busy)} onClick={rechunk}>
							Re-chunk
						</PillButton>
						<PillButton
							disabled={Boolean(busy)}
							onClick={() =>
								void run("Clearing…", async () => `Removed ${clearCaptions({ editor })} caption tracks`)
							}
						>
							Clear
						</PillButton>
					</div>
				)}
			</div>
			{note && <Notice>{note}</Notice>}
			{error && <Notice tone="error">{error}</Notice>}

			{hasCaptions && (
				<div>
					<SectionLabel right={<Mono className="text-fog">{current.doc.length} chunks</Mono>}>Captions</SectionLabel>
					<CaptionList
						doc={current.doc}
						activeTime={playhead / TICKS_PER_SECOND}
						onChange={edit}
						onSeek={seek}
						disabled={Boolean(busy)}
					/>
				</div>
			)}
		</div>
	);
}
