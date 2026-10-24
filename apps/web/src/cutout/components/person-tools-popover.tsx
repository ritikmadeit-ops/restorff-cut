"use client";

/**
 * The popover behind the timeline toolbar's one "person & size" button:
 * SIZE (auto-reframe switcher) · PERSON (cut out) · BEHIND THE PERSON (matte presets) · running jobs.
 */
import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, RefreshIcon, ScissorIcon } from "@hugeicons/core-free-icons";
import { useEditor } from "@/editor/use-editor";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { cn } from "@/utils/ui";
import { SEGMENTATION_MODELS, DEFAULT_SEGMENTATION_MODEL, type SegmentationModelId } from "@/segmentation/config";
import { activeSizeOf, getReframeState } from "@/reframe/state";
import { REFRAME_SIZE_ORDER, REFRAME_SIZES } from "@/reframe/sizes";
import { runCutOutPerson, runMattePreset, runSwitchToSize } from "../actions";
import { MATTE_PRESETS } from "../presets";
import { useCutoutJobs } from "../store";
import { getCutoutSource } from "../timeline-utils";
import type { GreenScreenBackground, MattePresetId, MattePresetOptions } from "../types";

const field =
	"h-8 w-full rounded-sm border border-line bg-ground px-2 text-xs text-bone outline-hidden focus:border-bone";
const smallButton =
	"inline-flex h-8 items-center justify-center gap-1.5 rounded-sm border border-outline px-3 text-xs font-semibold text-bone transition-colors hover:border-bone hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50";

export function PersonToolsPopover() {
	const editor = useEditor();
	const { selectedElements } = useElementSelection();
	const project = useEditor((current) => current.project.getActiveOrNull());
	const assets = useEditor((current) => current.media.getAssets());
	const jobs = useCutoutJobs((state) => state.jobs);
	const clearFinished = useCutoutJobs((state) => state.clearFinished);
	const [model, setModel] = useState<SegmentationModelId>(DEFAULT_SEGMENTATION_MODEL);
	const [openPreset, setOpenPreset] = useState<MattePresetId | null>("text-behind");

	const selected = useMemo(() => {
		if (selectedElements.length !== 1) return null;
		return editor.timeline.getElementsWithTracks({ elements: selectedElements })[0] ?? null;
	}, [editor, selectedElements]);
	const element = selected?.element ?? null;
	const isMediaClip = element?.type === "video" || element?.type === "image";
	const isCutout = !!getCutoutSource(element);
	const ref = selected ? { trackId: selected.track.id, elementId: selected.element.id } : null;
	const running = jobs.some((job) => job.status === "running");

	const activeSize = project ? activeSizeOf(project) : "9:16";
	const reframe = project ? getReframeState(project) : null;

	return (
		<div className="flex flex-col gap-4">
			<section className="flex flex-col gap-2">
				<div className="flex items-center justify-between">
					<span className="rc-label">Size</span>
					{activeSize !== "9:16" && (
						<button
							type="button"
							className="rc-mono inline-flex items-center gap-1 text-[11px] text-fog hover:text-bone disabled:opacity-50"
							disabled={running}
							onClick={() => runSwitchToSize({ editor, size: activeSize, rebuild: true })}
							title="Rebuild this size from the 9:16 master (replaces edits made in this size)"
						>
							<HugeiconsIcon icon={RefreshIcon} className="size-3" /> Rebuild from master
						</button>
					)}
				</div>
				<div className="grid grid-cols-4 gap-1">
					{REFRAME_SIZE_ORDER.map((id) => {
						const built = id === "9:16" || !!reframe?.scenes[id];
						return (
							<button
								key={id}
								type="button"
								disabled={running}
								onClick={() => id !== activeSize && runSwitchToSize({ editor, size: id })}
								className={cn(
									"rc-mono flex h-12 flex-col items-center justify-center rounded-sm border text-xs transition-colors disabled:opacity-50",
									id === activeSize
										? "border-bone bg-raised text-bone"
										: "border-line text-fog hover:border-outline hover:text-bone",
								)}
								title={built ? `Switch to ${id}` : `Auto-reframe the 9:16 master to ${id}`}
							>
								<SizeGlyph width={REFRAME_SIZES[id].width} height={REFRAME_SIZES[id].height} />
								<span>{id}</span>
							</button>
						);
					})}
				</div>
				<p className="text-[11px] leading-4 text-fog">
					Other sizes follow the speaker from the 9:16 master, one key per second. Export each size after
					switching to it.
				</p>
			</section>

			<section className="flex flex-col gap-2 border-t border-line pt-3">
				<span className="rc-label">Person</span>
				<p className="text-xs text-bone">
					{element
						? `${element.name}${isCutout ? " · cutout" : ""}`
						: "Select one video or image clip on the timeline."}
				</p>
				<div className="flex gap-2">
					<select
						className={cn(field, "flex-1")}
						value={model}
						onChange={(event) => setModel(event.target.value as SegmentationModelId)}
						aria-label="Person model"
					>
						{Object.values(SEGMENTATION_MODELS).map((info) => (
							<option key={info.id} value={info.id}>
								{info.label}
							</option>
						))}
					</select>
					<button
						type="button"
						className={cn(smallButton, "border-bone")}
						disabled={!ref || !isMediaClip || isCutout || running}
						onClick={() => ref && runCutOutPerson({ editor, ref, model })}
					>
						<HugeiconsIcon icon={ScissorIcon} className="size-3.5" /> Cut out person
					</button>
				</div>
			</section>

			<section className="flex flex-col gap-2 border-t border-line pt-3">
				<span className="rc-label">Behind the person</span>
				{MATTE_PRESETS.map((info) => (
					<div key={info.id} className="rounded-sm border border-line">
						<button
							type="button"
							className="flex w-full items-center justify-between px-3 py-2 text-left"
							onClick={() => setOpenPreset(openPreset === info.id ? null : info.id)}
						>
							<span className="text-xs font-semibold text-bone">{info.name}</span>
							<span className="rc-mono text-[10px] text-fog">{info.fx}</span>
						</button>
						{openPreset === info.id && (
							<div className="flex flex-col gap-2 border-t border-line px-3 py-2">
								<p className="text-[11px] leading-4 text-fog">{info.description}</p>
								<PresetForm
									preset={info.id}
									assets={assets.filter((asset) => asset.type !== "audio")}
									disabled={!ref || (!isMediaClip && !isCutout) || running}
									onApply={(preset) => ref && runMattePreset({ editor, ref, preset })}
								/>
							</div>
						)}
					</div>
				))}
			</section>

			{jobs.length > 0 && (
				<section className="flex flex-col gap-2 border-t border-line pt-3">
					<div className="flex items-center justify-between">
						<span className="rc-label">Jobs</span>
						<button type="button" className="rc-mono text-[11px] text-fog hover:text-bone" onClick={clearFinished}>
							Clear
						</button>
					</div>
					{jobs.map((job) => (
						<div key={job.id} className="flex flex-col gap-1">
							<div className="flex items-center justify-between gap-2">
								<span className="truncate text-xs text-bone">{job.label}</span>
								{job.status === "running" ? (
									<button
										type="button"
										className="text-fog hover:text-bone"
										onClick={() => job.controller.abort()}
										aria-label="Cancel"
									>
										<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
									</button>
								) : (
									<span className="rc-mono text-[10px] text-fog">{job.status}</span>
								)}
							</div>
							<div className="h-1 w-full overflow-hidden rounded-full bg-raised">
								<div
									className={cn(
										"h-full transition-[width]",
										job.status === "error" ? "bg-kiln" : job.status === "running" ? "bg-neon" : "bg-bone",
									)}
									style={{ width: `${Math.round(job.progress * 100)}%` }}
								/>
							</div>
							<span className="rc-mono truncate text-[10px] text-fog">{job.error ?? job.message}</span>
						</div>
					))}
				</section>
			)}
		</div>
	);
}

function SizeGlyph({ width, height }: { width: number; height: number }) {
	const scale = 14 / Math.max(width, height);
	return (
		<span
			className="mb-1 block rounded-[2px] border border-current"
			style={{ width: Math.round(width * scale), height: Math.round(height * scale) }}
		/>
	);
}

function PresetForm({
	preset,
	assets,
	disabled,
	onApply,
}: {
	preset: MattePresetId;
	assets: Array<{ id: string; name: string; type: string }>;
	disabled: boolean;
	onApply: (preset: MattePresetOptions) => void;
}) {
	const [text, setText] = useState("STEEP");
	const [dateline, setDateline] = useState("NO. 01 · OCTOBER 2026");
	const [lines, setLines] = useState("Cold brew, slowly\n18 hours in the making");
	const [backgroundKind, setBackgroundKind] = useState<GreenScreenBackground["kind"]>("color");
	const [color, setColor] = useState("#2F3B40");
	const [mediaId, setMediaId] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [blur, setBlur] = useState(35);
	const [frameScale, setFrameScale] = useState(80);

	const apply = () => {
		switch (preset) {
			case "text-behind":
				onApply({ preset, options: { text } });
				return;
			case "cover-story":
				onApply({
					preset,
					options: { masthead: text, dateline, lines: lines.split("\n").filter((line) => line.trim()) },
				});
				return;
			case "frame-break":
				onApply({ preset, options: { scale: frameScale / 100 } });
				return;
			case "green-screen": {
				let background: GreenScreenBackground;
				if (backgroundKind === "media") background = { kind: "media", mediaId };
				else if (backgroundKind === "file" && file) background = { kind: "file", file };
				else if (backgroundKind === "blur") background = { kind: "blur", intensity: blur };
				else background = { kind: "color", color };
				onApply({ preset, options: { background } });
				return;
			}
		}
	};

	const canApply =
		!disabled &&
		!(preset === "green-screen" && backgroundKind === "media" && !mediaId) &&
		!(preset === "green-screen" && backgroundKind === "file" && !file) &&
		!((preset === "text-behind" || preset === "cover-story") && !text.trim());

	return (
		<div className="flex flex-col gap-2">
			{(preset === "text-behind" || preset === "cover-story") && (
				<input
					className={field}
					value={text}
					maxLength={24}
					onChange={(event) => setText(event.target.value)}
					placeholder={preset === "cover-story" ? "Masthead" : "Headline"}
					aria-label={preset === "cover-story" ? "Masthead" : "Headline"}
				/>
			)}
			{preset === "cover-story" && (
				<>
					<input
						className={field}
						value={dateline}
						onChange={(event) => setDateline(event.target.value)}
						placeholder="Dateline"
						aria-label="Dateline"
					/>
					<textarea
						className={cn(field, "h-14 py-1")}
						value={lines}
						onChange={(event) => setLines(event.target.value)}
						placeholder="Cover lines, one per line"
						aria-label="Cover lines"
					/>
				</>
			)}
			{preset === "green-screen" && (
				<>
					<div className="grid grid-cols-4 gap-1">
						{(["color", "media", "file", "blur"] as const).map((kind) => (
							<button
								key={kind}
								type="button"
								onClick={() => setBackgroundKind(kind)}
								className={cn(
									"rc-mono h-7 rounded-sm border text-[10px] uppercase",
									kind === backgroundKind ? "border-bone text-bone" : "border-line text-fog hover:text-bone",
								)}
							>
								{kind === "color" ? "Colour" : kind === "media" ? "Media" : kind === "file" ? "Upload" : "Blur"}
							</button>
						))}
					</div>
					{backgroundKind === "color" && (
						<div className="flex items-center gap-2">
							<input
								type="color"
								value={color}
								onChange={(event) => setColor(event.target.value)}
								className="h-8 w-10 cursor-pointer rounded-sm border border-line bg-ground"
								aria-label="Background colour"
							/>
							<span className="rc-mono text-xs text-fog">{color.toUpperCase()}</span>
						</div>
					)}
					{backgroundKind === "media" && (
						<select
							className={field}
							value={mediaId}
							onChange={(event) => setMediaId(event.target.value)}
							aria-label="Background media"
						>
							<option value="">Pick an image or video…</option>
							{assets.map((asset) => (
								<option key={asset.id} value={asset.id}>
									{asset.name}
								</option>
							))}
						</select>
					)}
					{backgroundKind === "file" && (
						<input
							type="file"
							accept="image/*,video/*"
							className="text-xs text-fog file:mr-2 file:rounded-sm file:border file:border-outline file:bg-transparent file:px-2 file:py-1 file:text-bone"
							onChange={(event) => setFile(event.target.files?.[0] ?? null)}
						/>
					)}
					{backgroundKind === "blur" && (
						<label className="flex items-center gap-2 text-xs text-fog">
							<input
								type="range"
								min={5}
								max={100}
								value={blur}
								onChange={(event) => setBlur(Number(event.target.value))}
								className="flex-1"
							/>
							<span className="rc-mono w-8 text-right">{blur}</span>
						</label>
					)}
				</>
			)}
			{preset === "frame-break" && (
				<label className="flex items-center gap-2 text-xs text-fog">
					Inset
					<input
						type="range"
						min={55}
						max={92}
						value={frameScale}
						onChange={(event) => setFrameScale(Number(event.target.value))}
						className="flex-1"
					/>
					<span className="rc-mono w-10 text-right">{frameScale}%</span>
				</label>
			)}
			<button type="button" className={cn(smallButton, "self-end")} disabled={!canApply} onClick={apply}>
				Apply
			</button>
		</div>
	);
}
