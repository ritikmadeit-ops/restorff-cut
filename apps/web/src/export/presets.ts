/**
 * Delivery presets for paid-social and web (ported idea: OpenCut-AI lib/export-presets.ts,
 * which had sizes and a quality word only). Ours carry explicit bitrates and the master
 * loudness, because a preset is a delivery spec, not a quality slider.
 *
 * Bitrates (ASSUMPTION, set 2026-10-20; re-check against current platform upload specs):
 * the platforms re-encode everything, so uploads are kept well above their delivery rates
 * (≈ 2–5 Mbit/s at 1080 p) to survive the second encode — 12 Mbit/s for 1080×1920,
 * 10 for 1080×1350 and 1920×1080, 8 for 1080×1080; AAC 192 kbit/s. Audio is mastered to
 * −14 LUFS integrated, ≤ −1 dBTP true peak (owner rule, README "Sound is half the ad").
 */
import type { ExportFormat } from "./index";

export interface ExportPreset {
	id: string;
	label: string;
	platforms: string;
	aspect: "9:16" | "4:5" | "1:1" | "16:9";
	width: number;
	height: number;
	format: ExportFormat;
	/** Video bitrate, bit/s. */
	videoBitrate: number;
	/** Audio bitrate, bit/s. */
	audioBitrate: number;
	/** Frame rate cap; the project's rate is used when lower. */
	maxFps: number;
}

export const DEFAULT_LOUDNESS_TARGET = { integratedLufs: -14, truePeakDb: -1 } as const;

export const EXPORT_PRESETS: ExportPreset[] = [
	{
		id: "vertical-1080x1920",
		label: "Vertical 9:16",
		platforms: "TikTok · Reels · Shorts · Stories",
		aspect: "9:16",
		width: 1080,
		height: 1920,
		format: "mp4",
		videoBitrate: 12_000_000,
		audioBitrate: 192_000,
		maxFps: 60,
	},
	{
		id: "portrait-1080x1350",
		label: "Portrait 4:5",
		platforms: "Instagram · Facebook feed",
		aspect: "4:5",
		width: 1080,
		height: 1350,
		format: "mp4",
		videoBitrate: 10_000_000,
		audioBitrate: 192_000,
		maxFps: 60,
	},
	{
		id: "square-1080x1080",
		label: "Square 1:1",
		platforms: "Feed · carousel · LinkedIn",
		aspect: "1:1",
		width: 1080,
		height: 1080,
		format: "mp4",
		videoBitrate: 8_000_000,
		audioBitrate: 192_000,
		maxFps: 60,
	},
	{
		id: "landscape-1920x1080",
		label: "Landscape 16:9",
		platforms: "YouTube · web · CTV",
		aspect: "16:9",
		width: 1920,
		height: 1080,
		format: "mp4",
		videoBitrate: 10_000_000,
		audioBitrate: 192_000,
		maxFps: 60,
	},
	{
		id: "review-720x1280",
		label: "Review 9:16 (small)",
		platforms: "Quick share for notes",
		aspect: "9:16",
		width: 720,
		height: 1280,
		format: "mp4",
		videoBitrate: 4_000_000,
		audioBitrate: 128_000,
		maxFps: 30,
	},
];

export function getExportPreset(id: string | undefined): ExportPreset | null {
	if (!id) return null;
	return EXPORT_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** The preset whose aspect matches the canvas (within 1 %), else the vertical default. */
export function suggestExportPreset(canvas: { width: number; height: number }): ExportPreset {
	const ratio = canvas.width / canvas.height;
	const match = EXPORT_PRESETS.find(
		(preset) => preset.id !== "review-720x1280" && Math.abs(preset.width / preset.height - ratio) / ratio < 0.01,
	);
	return match ?? EXPORT_PRESETS[0];
}

/** True when the preset's aspect differs from the canvas: the export letterboxes or crops. */
export function presetChangesAspect(preset: ExportPreset, canvas: { width: number; height: number }): boolean {
	const ratio = canvas.width / canvas.height;
	return Math.abs(preset.width / preset.height - ratio) / ratio >= 0.01;
}
