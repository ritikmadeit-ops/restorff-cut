import type { FrameRate } from "restorffcut-wasm";
import { EXPORT_MIME_TYPES } from "./mime-types";

export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	includeAudio?: boolean;
	/**
	 * Restorff additions (all optional; old callers keep working).
	 * A delivery preset id from `@/export/presets` (size, bitrates, fps cap).
	 */
	preset?: string;
	/** Output size in px; defaults to the preset's, else the project canvas. */
	width?: number;
	height?: number;
	/** When the output aspect differs from the canvas: "contain" letterboxes, "cover" crops. */
	fit?: "contain" | "cover";
	/** Video / audio bitrate in bit/s (override the quality word and the preset). */
	videoBitrate?: number;
	audioBitrate?: number;
	/**
	 * Master loudness, measured on the encoded audio. Default: the project's
	 * `settings.loudness`, else −14 LUFS / −1 dBTP. `false` exports the mix untouched.
	 */
	loudness?: { integratedLufs: number; truePeakDb: number } | false;
}

export interface ExportLoudnessReport {
	target: { integratedLufs: number; truePeakDb: number };
	/** The mix before mastering. */
	input: { integratedLufs: number; truePeakDb: number; loudnessRangeLu: number };
	/** Measured on the audio decoded back from the finished file. */
	output: { integratedLufs: number; truePeakDb: number; loudnessRangeLu: number } | null;
	gainDb: number;
	limitedSamples: number;
	/** EXPORT-GATE "LOUD": within ±1 LU and at or under the true-peak ceiling. */
	pass: boolean;
}

export interface ExportResult {
	success: boolean;
	buffer?: ArrayBuffer;
	error?: string;
	cancelled?: boolean;
	/** Restorff: the encoded size and the loudness report (null when audio was off or silent). */
	width?: number;
	height?: number;
	loudness?: ExportLoudnessReport | null;
}

export interface ExportState {
	isExporting: boolean;
	progress: number;
	result: ExportResult | null;
}

export function getExportMimeType({
	format,
}: {
	format: ExportFormat;
}): string {
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${format}`;
}

export function downloadBuffer({
	buffer,
	filename,
	mimeType,
}: {
	buffer: ArrayBuffer;
	filename: string;
	mimeType: string;
}): void {
	const blob = new Blob([buffer], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = filename;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	URL.revokeObjectURL(url);
}
