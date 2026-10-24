/**
 * UI-facing entry points (toolbar popover, command bar, Claude bridge): each runs as a tracked job with a toast.
 * Programmatic callers that want no toast use cutOutPerson / applyMattePreset / switchToSize directly.
 */
import { toast } from "sonner";
import type { EditorCore } from "@/core";
import type { SegmentationModelId } from "@/segmentation/config";
import type { ElementRef } from "@/timeline";
import { switchToSize } from "@/reframe/build";
import type { ReframeSizeId } from "@/reframe/sizes";
import { cutOutPerson } from "./cut-out-person";
import { applyMattePreset, MATTE_PRESETS } from "./presets";
import { runCutoutJob } from "./store";
import type { MattePresetOptions } from "./types";

function report(error: unknown, what: string) {
	if (error instanceof DOMException && error.name === "AbortError") {
		toast(`${what} cancelled`);
		return;
	}
	toast.error(`${what} failed`, { description: error instanceof Error ? error.message : String(error) });
}

export async function runCutOutPerson({
	editor,
	ref,
	model,
	force,
}: {
	editor: EditorCore;
	ref: ElementRef;
	model?: SegmentationModelId;
	force?: boolean;
}) {
	try {
		const result = await runCutoutJob({
			label: "Cut out person",
			run: ({ onProgress, signal }) => cutOutPerson({ editor, ref, model, force, onProgress, signal }),
		});
		toast.success(result.created ? "Person cut out" : "This clip already has a cutout", {
			description: "Anything on a track between the clip and V2 CUTOUT now sits behind the person.",
		});
		return result;
	} catch (error) {
		report(error, "Cut out person");
		return null;
	}
}

export async function runMattePreset({
	editor,
	ref,
	preset,
}: {
	editor: EditorCore;
	ref: ElementRef;
	preset: MattePresetOptions;
}) {
	const info = MATTE_PRESETS.find((entry) => entry.id === preset.preset);
	const label = info?.name ?? preset.preset;
	try {
		const result = await runCutoutJob({
			label,
			run: ({ onProgress, signal }) => applyMattePreset({ editor, ref, preset, onProgress, signal }),
		});
		toast.success(`${label} added`);
		return result;
	} catch (error) {
		report(error, label);
		return null;
	}
}

export async function runSwitchToSize({
	editor,
	size,
	rebuild,
}: {
	editor: EditorCore;
	size: ReframeSizeId;
	rebuild?: boolean;
}) {
	try {
		return await runCutoutJob({
			label: rebuild ? `Rebuild ${size}` : `Size ${size}`,
			run: ({ onProgress, signal }) => switchToSize({ editor, size, rebuild, onProgress, signal }),
			progressMap: (progress) =>
				progress.phase === "segment" ? progress.progress * 0.9 : 0.9 + progress.progress * 0.1,
		});
	} catch (error) {
		report(error, `Reframe to ${size}`);
		return null;
	}
}
