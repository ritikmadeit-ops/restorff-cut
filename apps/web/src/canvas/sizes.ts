import type { TCanvasSize } from "@/project/types";

export const DEFAULT_CANVAS_PRESETS: TCanvasSize[] = [
	{ width: 1080, height: 1920 },
	{ width: 1920, height: 1080 },
	{ width: 1080, height: 1080 },
	{ width: 1440, height: 1080 },
];

// Restorff ads are vertical (9:16), as in design/edit-artboard.png.
export const DEFAULT_CANVAS_SIZE: TCanvasSize = { width: 1080, height: 1920 };
