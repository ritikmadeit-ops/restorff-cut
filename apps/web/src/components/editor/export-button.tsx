"use client";

/**
 * "Render final" (design/edit-artboard.png: an outlined pill) — gated since 2026-10-20 (EXPORT-GATE.md, JDG-07/08,
 * EDT-18): it renders, runs the timeline checks and the file checks on the encoded file, and opens the gate sheet.
 * The file can only be downloaded from the sheet, and only when the gate passes (or the owner overrode the MUSTs
 * with a written reason, D13). Behaviour owned by the gate agent; the DESIGN agent may restyle placement.
 *
 * ui-fix-render (2026-10-21, QA #4): renders on RestorffCut's server by default (gate/server-render.ts: commit →
 * server render, polled → server check); "In this browser" is the fallback (slow, the tab is busy while it encodes).
 */
import { useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	type ExportFormat,
	type ExportQuality,
} from "@/export";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { GateSheet } from "@/gate/gate-sheet";
import { runGate } from "@/gate/run";
import { type GateWhere, isGateBusy, useGateStore } from "@/gate/store";
import { useSyncStore } from "@/sync/store";
// interchange agent (EDT-19): "Export timeline (FCPXML / OTIO)" — src/interchange/export-entry.tsx
import { ExportTimelineEntry } from "@/interchange/export-entry";

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((qualityValue) => qualityValue === value);
}

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;
	const gatePhase = useGateStore((s) => s.phase);
	const report = useGateStore((s) => s.report);
	const setGate = useGateStore((s) => s.set);
	const progress = useGateStore((s) => s.server?.progress ?? null);
	const busy = isGateBusy(gatePhase);

	return (
		<>
			{report && !busy && (
				<button
					type="button"
					className={cn(
						"rc-mono border-line hover:border-bone mr-2 h-10 rounded-[12px] border px-3 text-xs",
						report.state === "PASS" ? "text-bone" : "text-stale",
					)}
					onClick={() => setGate({ open: true })}
					title="Open the export gate"
				>
					{report.state === "PASS"
						? "gate pass"
						: report.state === "BLOCKED"
							? `${report.blocking.length} fix${report.blocking.length === 1 ? "" : "es"} before export`
							: "gate incomplete"}
				</button>
			)}
			<Popover open={isExportPopoverOpen} onOpenChange={setIsExportPopoverOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						className={cn("rc-pill", !hasProject && "cursor-not-allowed opacity-50")}
						onClick={hasProject && !busy ? () => setIsExportPopoverOpen(true) : undefined}
						disabled={!hasProject || busy}
						onKeyDown={(event) => {
							if (hasProject && !busy && (event.key === "Enter" || event.key === " ")) {
								event.preventDefault();
								setIsExportPopoverOpen(true);
							}
						}}
						data-testid="render-final"
					>
						{busy
							? gatePhase === "preparing"
								? "Preparing…"
								: gatePhase === "rendering"
									? progress !== null && progress > 0
										? `Rendering ${Math.round(progress * 100)} %`
										: "Rendering…"
									: "Checking…"
							: "Render final"}
					</button>
				</PopoverTrigger>
				{hasProject && <RenderOptions onDone={() => setIsExportPopoverOpen(false)} />}
			</Popover>
			<GateSheet />
		</>
	);
}

function RenderOptions({ onDone }: { onDone: () => void }) {
	const editor = useEditor();
	const stored = useGateStore();
	const [format, setFormat] = useState<ExportFormat>(stored.format);
	const [quality, setQuality] = useState<ExportQuality>(stored.quality);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(stored.includeAudio);
	const [where, setWhere] = useState<GateWhere>(stored.where);
	const syncStatus = useSyncStore((s) => s.status);
	const isDraft = syncStatus === "unlinked";

	const handleRender = () => {
		onDone();
		useGateStore.getState().set({ where });
		void runGate(editor, { format, quality, includeAudio: shouldIncludeAudio, where });
	};

	return (
		<PopoverContent className="bg-card mr-4 flex w-80 flex-col rounded-[16px] p-0">
			<div className="flex items-center justify-between border-b p-3">
				<h3 className="rc-label text-bone">Render final</h3>
			</div>
			<div className="flex flex-col gap-2 border-b p-3" role="radiogroup" aria-label="Where to render">
				{(
					[
						{
							value: "server",
							title: "On RestorffCut's server",
							note: isDraft
								? "Fast; the tab stays free. This draft gets a server copy first (version history starts)."
								: "Fast; the tab stays free. Commits your edits, then renders, masters and checks the MP4.",
						},
						{
							value: "browser",
							title: "In this browser",
							note: "Slow fallback: the tab is busy until the file is encoded (minutes for a long cut).",
						},
					] as const
				).map((option) => (
					<button
						key={option.value}
						type="button"
						role="radio"
						aria-checked={where === option.value}
						onClick={() => setWhere(option.value)}
						data-testid={`render-where-${option.value}`}
						className={cn(
							"border-line flex flex-col items-start gap-0.5 rounded-[12px] border px-3 py-2 text-left transition-colors",
							where === option.value ? "border-bone bg-raised" : "hover:border-fog",
						)}
					>
						<span className="text-bone flex items-center gap-2 text-sm font-semibold">
							<span
								aria-hidden
								className={cn(
									"inline-block size-2.5 rounded-full border",
									where === option.value ? "border-bone bg-bone" : "border-fog",
								)}
							/>
							{option.title}
						</span>
						<span className="text-fog text-[0.7rem] leading-snug">{option.note}</span>
					</button>
				))}
			</div>
			<div className={cn("flex flex-col", where === "server" && "hidden")}>
				<Section collapsible defaultOpen={false} showTopBorder={false}>
					<SectionHeader>
						<SectionTitle>Format</SectionTitle>
					</SectionHeader>
					<SectionContent>
						<RadioGroup
							value={format}
							onValueChange={(value) => {
								if (isExportFormat(value)) setFormat(value);
							}}
						>
							<div className="flex items-center space-x-2">
								<RadioGroupItem value="mp4" id="mp4" />
								<Label htmlFor="mp4">MP4 (H.264 + AAC) · the delivery format</Label>
							</div>
							<div className="flex items-center space-x-2">
								<RadioGroupItem value="webm" id="webm" />
								<Label htmlFor="webm">WebM (VP9) · fails the FORMAT check</Label>
							</div>
						</RadioGroup>
					</SectionContent>
				</Section>

				<Section collapsible defaultOpen={false}>
					<SectionHeader>
						<SectionTitle>Quality</SectionTitle>
					</SectionHeader>
					<SectionContent>
						<RadioGroup
							value={quality}
							onValueChange={(value) => {
								if (isExportQuality(value)) setQuality(value);
							}}
						>
							<div className="flex items-center space-x-2">
								<RadioGroupItem value="low" id="low" />
								<Label htmlFor="low">Low - Smallest file size</Label>
							</div>
							<div className="flex items-center space-x-2">
								<RadioGroupItem value="medium" id="medium" />
								<Label htmlFor="medium">Medium - Balanced</Label>
							</div>
							<div className="flex items-center space-x-2">
								<RadioGroupItem value="high" id="high" />
								<Label htmlFor="high">High - Recommended</Label>
							</div>
							<div className="flex items-center space-x-2">
								<RadioGroupItem value="very_high" id="very_high" />
								<Label htmlFor="very_high">Very high - Largest file size</Label>
							</div>
						</RadioGroup>
					</SectionContent>
				</Section>

				<Section collapsible defaultOpen={false}>
					<SectionHeader>
						<SectionTitle>Audio</SectionTitle>
					</SectionHeader>
					<SectionContent>
						<div className="flex items-center space-x-2">
							<Checkbox
								id="include-audio"
								checked={shouldIncludeAudio}
								onCheckedChange={(checked) => setShouldIncludeAudio(!!checked)}
							/>
							<Label htmlFor="include-audio">Include audio (the gate fails a silent master)</Label>
						</div>
					</SectionContent>
				</Section>
			</div>
			<div className="flex flex-col gap-2 p-3">
				<button type="button" onClick={handleRender} className="rc-pill rc-pill-strong w-full" data-testid="render-and-check">
					Render and check
				</button>
				<p className="rc-mono text-fog text-[0.65rem] leading-snug">
					{where === "server"
						? "MP4 (H.264 + AAC) at full quality, mastered to −14 LUFS / −1 dBTP, then every export-gate check. Download is in the gate sheet once it passes."
						: "Renders here, then runs every export-gate check on the timeline and on the encoded file. Download is in the gate sheet once it passes."}
				</p>
			</div>
			<ExportTimelineEntry />
		</PopoverContent>
	);
}
