/**
 * An empty RestorffCut project with Restorff's named lanes (mcp-media agent, 2026-10-20; PARITY G01): what
 * `timeline create` starts from. Copied (not moved) from Restorff's gateway, `restorff/apps/gateway/src/
 * editor-skeleton.mjs` emptyProject — the same layout `timeline compile` uses, so a timeline made over MCP and one
 * compiled from a board look the same in the editor:
 *
 *   overlay  TEXT (text) · CAPTIONS (text, role caption) · V2 B-ROLL (video)
 *   main     V1 A-ROLL (video)
 *   audio    MUSIC (role music) · SFX (role sfx)
 *
 * The editor's SerializedProject, version 32 (packages/timeline-ops MODEL.md). Pure, no I/O.
 */
import type { ProjectSnapshot } from "@/sync/snapshot";

export const ASPECTS = {
	"9:16": { width: 1080, height: 1920 },
	"4:5": { width: 1080, height: 1350 },
	"1:1": { width: 1080, height: 1080 },
	"16:9": { width: 1920, height: 1080 },
} as const;

export type Aspect = keyof typeof ASPECTS;
export const ASPECT_NAMES = Object.keys(ASPECTS) as Aspect[];

export const LANES = [
	{ id: "trk-text", name: "TEXT", group: "overlay", type: "text" },
	{ id: "trk-captions", name: "CAPTIONS", group: "overlay", type: "text", role: "caption" },
	{ id: "trk-broll", name: "V2 B-ROLL", group: "overlay", type: "video" },
	{ id: "trk-main", name: "V1 A-ROLL", group: "main", type: "video" },
	{ id: "trk-music", name: "MUSIC", group: "audio", type: "audio", role: "music" },
	{ id: "trk-sfx", name: "SFX", group: "audio", type: "audio", role: "sfx" },
] as const;

/** 30 → 30/1; the NTSC rates (23.976, 29.97, 59.94) → n×1000/1001. */
export function frameRate(fps: number): { numerator: number; denominator: number } {
	if (Number.isInteger(fps)) return { numerator: fps, denominator: 1 };
	const ntsc = Math.round(fps * 1.001);
	if (Math.abs((ntsc * 1000) / 1001 - fps) < 0.01) return { numerator: ntsc * 1000, denominator: 1001 };
	return { numerator: Math.round(fps * 1000), denominator: 1000 };
}

export function emptyProject({
	id,
	name,
	aspect = "9:16",
	fps = 30,
	now = new Date().toISOString(),
}: {
	id: string;
	name: string;
	aspect?: Aspect;
	fps?: number;
	now?: string;
}): ProjectSnapshot {
	const { width, height } = ASPECTS[aspect];
	const lane = (index: number) => {
		const spec = LANES[index];
		return {
			id: spec.id,
			name: spec.name,
			type: spec.type,
			elements: [],
			hidden: false,
			...(spec.type !== "text" ? { muted: false } : {}),
			...("role" in spec ? { restorff: { role: spec.role } } : {}),
		};
	};
	return {
		metadata: {
			id,
			name,
			duration: 0,
			createdAt: now,
			updatedAt: now,
			restorff: { opsVersion: "ops@1", pending: [], media: [] },
		},
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [lane(0), lane(1), lane(2)],
					main: lane(3),
					audio: [lane(4), lane(5)],
				},
				bookmarks: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		currentSceneId: "scene-main",
		settings: {
			fps: frameRate(fps),
			canvasSize: { width, height },
			canvasSizeMode: "preset",
			background: { type: "color", color: "#000000" },
		},
		version: 32,
		timelineViewState: { zoomLevel: 1, scrollLeft: 0, playheadTime: 0 },
	};
}
