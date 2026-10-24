"use client";

import { useRef, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { parseSubtitleFile } from "@/subtitles/parse";
import { WORD_TIMING_MODEL } from "@/transcription/models";
import { TranscriptView, type TranscribeSettings } from "@/transcription/components/transcript-view";
import { AutocutView } from "@/autocut/components/autocut-view";
import { CaptionsView } from "@/captions/components/captions-view";
import { Notice, PillButton, Segmented } from "@/captions/components/kit";
import { rebuildCaptions, readCaptionDoc } from "@/captions/build";
import { DEFAULT_CAPTION_STYLE_ID, type CaptionDocChunk } from "@restorffcut/timeline-ops";

/**
 * The CAPTIONS tab (captions agent, 2026-10-20): the talking-head workflow without Claude —
 * TRANSCRIPT (Whisper in the browser, word timings, cached per file) → CUT (dead air & retakes, EDT-11) →
 * CAPTIONS (auto captions in the reel styles, safe area, caption editor, EDT-12). Subtitle files (.srt / .ass) import
 * from the header. Worklog: docs/restorff/worklog/captions.md.
 */
type View = "transcript" | "cut" | "captions";

const VIEWS: Array<{ id: View; label: string }> = [
	{ id: "transcript", label: "Transcript" },
	{ id: "cut", label: "Cut" },
	{ id: "captions", label: "Captions" },
];

export function Captions() {
	const editor = useEditor();
	const [view, setView] = useState<View>("captions");
	const [settings, setSettings] = useState<TranscribeSettings>({
		modelId: WORD_TIMING_MODEL,
		language: "auto",
	});
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [importNote, setImportNote] = useState<{ tone: "info" | "error"; text: string } | null>(null);

	const importFile = async (file: File) => {
		setImportNote(null);
		try {
			const result = parseSubtitleFile({ fileName: file.name, input: await file.text() });
			if (!result.captions.length) {
				setImportNote({ tone: "error", text: "No valid subtitle cues in that file." });
				return;
			}
			// subtitles become a caption document (words spread over each cue) so they get a style and the editor
			const doc: CaptionDocChunk[] = result.captions.map((cue) => {
				const tokens = cue.text.trim().split(/\s+/).filter(Boolean);
				const start = cue.startTime;
				const end = cue.startTime + cue.duration;
				const letters = tokens.reduce((sum, token) => sum + token.length + 1, 0) || 1;
				let cursor = start;
				return {
					start,
					end,
					words: tokens.map((token) => {
						const span = ((end - start) * (token.length + 1)) / letters;
						const word = { text: token, start: cursor, end: cursor + span };
						cursor += span;
						return word;
					}),
				};
			});
			const styleId = readCaptionDoc(editor.scenes.getActiveScene().tracks).styleId ?? DEFAULT_CAPTION_STYLE_ID;
			await rebuildCaptions({ editor, doc, styleId });
			setImportNote({
				tone: "info",
				text: `Imported ${result.captions.length} cues${result.skippedCueCount ? `, skipped ${result.skippedCueCount}` : ""}.${result.warnings.length ? ` ${result.warnings.join(" ")}` : ""}`,
			});
			setView("captions");
		} catch (error) {
			setImportNote({ tone: "error", text: error instanceof Error ? error.message : String(error) });
		}
	};

	return (
		<PanelView
			title="Captions"
			actions={
				<PillButton onClick={() => fileInputRef.current?.click()} title="Import .srt or .ass subtitles">
					Import
				</PillButton>
			}
		>
			<input
				ref={fileInputRef}
				type="file"
				accept=".srt,.ass"
				className="hidden"
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (file) void importFile(file);
				}}
			/>
			<div className="mb-4">
				<Segmented value={view} options={VIEWS} onChange={setView} />
			</div>
			{importNote && (
				<div className="mb-3">
					<Notice tone={importNote.tone}>{importNote.text}</Notice>
				</div>
			)}
			{view === "transcript" && <TranscriptView settings={settings} onSettings={setSettings} />}
			{view === "cut" && <AutocutView transcribeSettings={settings} />}
			{view === "captions" && <CaptionsView transcribeSettings={settings} />}
		</PanelView>
	);
}
