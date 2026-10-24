/** Delivery sizes. The master is 9:16; every other size is a derived scene (see reframe/build.ts). */
export type ReframeSizeId = "9:16" | "4:5" | "1:1" | "16:9";

export interface ReframeSize {
	id: ReframeSizeId;
	label: string;
	width: number;
	height: number;
	/** Where the subject's head centre sits vertically (0 = top, 1 = bottom). */
	headAnchorY: number;
}

export const REFRAME_SIZES: Record<ReframeSizeId, ReframeSize> = {
	"9:16": { id: "9:16", label: "9:16", width: 1080, height: 1920, headAnchorY: 0.36 },
	"4:5": { id: "4:5", label: "4:5", width: 1080, height: 1350, headAnchorY: 0.36 },
	"1:1": { id: "1:1", label: "1:1", width: 1080, height: 1080, headAnchorY: 0.38 },
	"16:9": { id: "16:9", label: "16:9", width: 1920, height: 1080, headAnchorY: 0.4 },
};

export const REFRAME_SIZE_ORDER: ReframeSizeId[] = ["9:16", "4:5", "1:1", "16:9"];

export const MASTER_SIZE_ID: ReframeSizeId = "9:16";

export function sceneNameForSize(size: ReframeSizeId): string {
	return `Reframe ${size}`;
}

/** The size whose aspect ratio is closest to a canvas (used when no reframe state exists yet). */
export function nearestSize({ width, height }: { width: number; height: number }): ReframeSizeId {
	const aspect = width / Math.max(1, height);
	let best: ReframeSizeId = MASTER_SIZE_ID;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const id of REFRAME_SIZE_ORDER) {
		const size = REFRAME_SIZES[id];
		const distance = Math.abs(Math.log(aspect / (size.width / size.height)));
		if (distance < bestDistance) {
			best = id;
			bestDistance = distance;
		}
	}
	return best;
}
