/**
 * Turns ExportOptions + the project into concrete delivery settings: output size, fit,
 * fps (capped by the preset), bitrates and the loudness target. Pure; used by
 * RendererManager.exportProject.
 */
import type { FrameRate } from "restorffcut-wasm";
import type { TBackground, TCanvasSize, TDeliverySettings, TLoudnessTarget } from "@/project/types";
import type { ExportOptions } from "./index";
import { DEFAULT_LOUDNESS_TARGET, getExportPreset } from "./presets";

export interface ExportDelivery {
	width: number;
	height: number;
	fit: "contain" | "cover";
	fps: FrameRate;
	videoBitrate?: number;
	audioBitrate?: number;
	loudness: { integratedLufs: number; truePeakDb: number } | null;
	letterboxColor: (background: TBackground) => string;
}

function capFps(fps: FrameRate, maxFps: number | undefined): FrameRate {
	if (!maxFps) return fps;
	const value = fps.numerator / fps.denominator;
	if (value <= maxFps + 0.01) return fps;
	return { numerator: maxFps, denominator: 1 };
}

export function resolveExportDelivery({
	options,
	canvasSize,
	projectFps,
	projectLoudness,
	projectDelivery,
}: {
	options: ExportOptions;
	canvasSize: TCanvasSize;
	projectFps: FrameRate;
	projectLoudness?: TLoudnessTarget;
	/** The project's own delivery choice (Settings → Delivery); options win over it. */
	projectDelivery?: TDeliverySettings;
}): ExportDelivery {
	const preset = getExportPreset(options.preset ?? projectDelivery?.preset);
	const width = options.width ?? preset?.width ?? canvasSize.width;
	const height = options.height ?? preset?.height ?? canvasSize.height;
	let loudness: ExportDelivery["loudness"];
	if (options.loudness === false) {
		loudness = null;
	} else if (options.loudness) {
		loudness = options.loudness;
	} else if (projectLoudness) {
		loudness = projectLoudness.enabled
			? { integratedLufs: projectLoudness.integratedLufs, truePeakDb: projectLoudness.truePeakDb }
			: null;
	} else {
		loudness = { ...DEFAULT_LOUDNESS_TARGET };
	}
	return {
		width,
		height,
		fit: options.fit ?? projectDelivery?.fit ?? "contain",
		fps: capFps(projectFps, preset?.maxFps),
		videoBitrate: options.videoBitrate ?? preset?.videoBitrate,
		audioBitrate: options.audioBitrate ?? preset?.audioBitrate,
		loudness,
		letterboxColor: (background) =>
			background.type === "color" && !/gradient\(/i.test(background.color) && background.color !== "transparent"
				? background.color
				: "#000000",
	};
}
