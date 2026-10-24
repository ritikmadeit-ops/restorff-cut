/**
 * When the compositor may skip re-uploading an external texture (a decoded video/image frame).
 *
 * RestorffCut (ui-fix-render, 2026-10-21, QA 2026-10-20 #6): the video cache decodes into a pool of 3 canvases
 * (mediabunny CanvasSink `poolSize: 3`) that are redrawn round-robin, so the SAME canvas object comes back with a
 * different frame in it — every whole-second seek at 30 fps lands on the same pool slot (30 frames ≡ 0 mod 3). The
 * upstream cache compared the source object only, so a paused seek kept the old frame on screen (PSNR ∞ across seeks)
 * while playback (a new slot every frame) looked fine. A hit now needs the same source, size AND version (the frame's
 * timestamp for video; undefined for immutable sources such as images and stickers).
 *
 * Pure (no wasm import) so bun can test it: services/renderer/__tests__/texture-cache.test.ts.
 */
export interface ExternalTextureKey {
	source: unknown;
	version?: string;
	width: number;
	height: number;
}

export function isExternalCacheHit(
	previous: ({ kind: string } & Partial<ExternalTextureKey>) | undefined,
	texture: ExternalTextureKey,
): boolean {
	return (
		previous?.kind === "external" &&
		previous.source === texture.source &&
		previous.version === texture.version &&
		previous.width === texture.width &&
		previous.height === texture.height
	);
}
