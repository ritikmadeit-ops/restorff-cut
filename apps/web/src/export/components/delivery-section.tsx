"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/utils/ui";
import type { ExportLoudnessReport } from "../index";
import { EXPORT_PRESETS, getExportPreset, presetChangesAspect } from "../presets";

export interface DeliveryChoice {
	/** "" = the project canvas as it is. */
	presetId: string;
	fit: "contain" | "cover";
	normalize: boolean;
}

/**
 * Delivery choices in the Render final popover (media agent, 2026-10-20): platform preset
 * (size + bitrates), letterbox vs crop when the preset's aspect differs from the canvas,
 * and loudness normalisation to −14 LUFS / −1 dBTP measured on the encoded file.
 */
export function DeliverySection({
	value,
	onChange,
	canvas,
}: {
	value: DeliveryChoice;
	onChange: (next: DeliveryChoice) => void;
	canvas: { width: number; height: number };
}) {
	const preset = getExportPreset(value.presetId);
	const aspectChanges = preset ? presetChangesAspect(preset, canvas) : false;
	return (
		<div className="flex flex-col gap-3 border-b p-3">
			<span className="rc-label text-fog text-[0.62rem]">Deliver for</span>
			<div className="grid grid-cols-2 gap-1.5">
				<PresetButton
					active={value.presetId === ""}
					title="Canvas"
					detail={`${canvas.width}×${canvas.height}`}
					onClick={() => onChange({ ...value, presetId: "" })}
				/>
				{EXPORT_PRESETS.map((option) => (
					<PresetButton
						key={option.id}
						active={value.presetId === option.id}
						title={option.label}
						detail={`${option.width}×${option.height} · ${Math.round(option.videoBitrate / 1_000_000)} Mb/s`}
						hint={option.platforms}
						onClick={() => onChange({ ...value, presetId: option.id })}
					/>
				))}
			</div>
			{aspectChanges && (
				<div className="flex flex-col gap-1.5">
					<p className="rc-mono text-[0.62rem] text-[#E8A33D]">
						The canvas is {canvas.width}×{canvas.height}: this preset changes the shape.
					</p>
					<div className="flex gap-1.5">
						{(["contain", "cover"] as const).map((fit) => (
							<button
								key={fit}
								type="button"
								onClick={() => onChange({ ...value, fit })}
								className={cn(
									"rc-mono flex-1 cursor-pointer rounded-[10px] border px-2 py-1 text-[0.65rem]",
									value.fit === fit ? "border-bone text-bone" : "border-line text-fog",
								)}
							>
								{fit === "contain" ? "Letterbox (fit)" : "Crop (fill)"}
							</button>
						))}
					</div>
				</div>
			)}
			<div className="flex items-center space-x-2">
				<Checkbox
					id="normalize-loudness"
					checked={value.normalize}
					onCheckedChange={(checked) => onChange({ ...value, normalize: !!checked })}
				/>
				<Label htmlFor="normalize-loudness">Master to −14 LUFS · −1 dBTP</Label>
			</div>
		</div>
	);
}

function PresetButton({
	active,
	title,
	detail,
	hint,
	onClick,
}: {
	active: boolean;
	title: string;
	detail: string;
	hint?: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={hint}
			className={cn(
				"flex cursor-pointer flex-col items-start rounded-[10px] border px-2 py-1.5 text-left transition-colors",
				active ? "border-bone bg-[#2a2a31]" : "border-line hover:border-bone/40",
			)}
		>
			<span className="text-bone text-[0.7rem] leading-tight">{title}</span>
			<span className="rc-mono text-fog text-[0.58rem]">{detail}</span>
		</button>
	);
}

export function formatLoudnessReport(report: ExportLoudnessReport): string {
	const output = report.output;
	if (!output) return "Master: not measured";
	return `Master ${output.integratedLufs.toFixed(1)} LUFS · ${output.truePeakDb.toFixed(1)} dBTP · LRA ${output.loudnessRangeLu.toFixed(1)} LU (measured on the file) — ${report.pass ? "LOUD pass" : "LOUD fail"}`;
}
