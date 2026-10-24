/**
 * Fictional fixtures (Halcyon Cold Brew): a 9:16 project with an A-roll clip and a captions track, synthetic pixel
 * frames for the style card, and a command history. No real client data.
 */
import type { Op, Project, TextElement } from "@restorffcut/timeline-ops";
import type { InstructionRecord, PixelFrame, ReferenceInput } from "../src/index.ts";

export const T = 120_000;

function caption(id: string, start: number, text: string): TextElement {
	return {
		id,
		type: "text",
		name: text,
		startTime: start * T,
		duration: 1 * T,
		trimStart: 0,
		trimEnd: 0,
		params: { content: text, fontSize: 5, color: "#ffffff", fontWeight: "bold" },
		restorff: { role: "caption" },
	};
}

export function project(id = "proj-halcyon-ad021"): Project {
	return {
		metadata: {
			id,
			name: "Halcyon Cold Brew / AD-021",
			duration: 12 * T,
			createdAt: "2026-10-20T09:00:00.000Z",
			updatedAt: "2026-10-20T09:00:00.000Z",
			restorff: {
				opsVersion: "ops@1",
				pending: [],
				media: [{ id: "media-aroll", kind: "video", name: "halcyon-aroll.mp4", duration: 12 * T, width: 1080, height: 1920, fps: 30, hasAudio: true, author: "user" }],
			},
		},
		scenes: [
			{
				id: "scene-main",
				name: "Main scene",
				isMain: true,
				tracks: {
					overlay: [
						{
							id: "trk-captions",
							name: "CAPTIONS",
							type: "text",
							hidden: false,
							restorff: { role: "caption" },
							elements: [caption("cap-1", 0, "Steeped"), caption("cap-2", 2, "eighteen hours"), caption("cap-3", 6, "never bitter")],
						},
					],
					main: {
						id: "trk-main",
						name: "V1 A-ROLL",
						type: "video",
						muted: false,
						hidden: false,
						elements: [
							{
								id: "el-aroll",
								type: "video",
								name: "S01 talking head",
								mediaId: "media-aroll",
								startTime: 0,
								duration: 12 * T,
								trimStart: 0,
								trimEnd: 0,
								sourceDuration: 12 * T,
								isSourceAudioEnabled: true,
								hidden: false,
								params: { "transform.positionX": 0, "transform.positionY": 0, "transform.scaleX": 1, "transform.scaleY": 1, "transform.rotate": 0, opacity: 1, blendMode: "normal", volume: 0, muted: false },
							},
						],
					},
					audio: [],
				},
				bookmarks: [],
				createdAt: "2026-10-20T09:00:00.000Z",
				updatedAt: "2026-10-20T09:00:00.000Z",
			},
		],
		currentSceneId: "scene-main",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1080, height: 1920 },
			canvasSizeMode: "preset",
			background: { type: "color", color: "#000000" },
		},
		version: 32,
	};
}

/**
 * What the command bar would have produced for "bigger captions" on a project (one set_caption_style), with the
 * caption size the project had before (ui-fix-panels: the command bar records it so a draft stores a ratio).
 * `before: null` = an old record without it.
 */
export function biggerCaptions(sentence: string, projectId: string, size: number, before: number | null = 5): InstructionRecord {
	const ops: Op[] = [{ op: "set_caption_style", author: "user", track: `trk-captions-${projectId}`, style: { size } }];
	return {
		sentence,
		ops,
		clauses: [{ text: sentence.toLowerCase(), ops }],
		projectId,
		at: "2026-10-20T10:00:00.000Z",
		...(before !== null ? { caption_size_before: before } : {}),
	};
}

/** The fixture project with its captions replaced: short words, `size`, centred on the safe area like the builder. */
export function projectWithCaptions(texts: string[], size: number, id = "proj-halcyon-ad030"): Project {
	const p = project(id);
	const scene = p.scenes[0];
	const track = scene?.tracks.overlay[0];
	if (!track) throw new Error("fixture has no caption track");
	track.elements = texts.map((text, i) => {
		const element = caption(`cap-${i + 1}`, i * 2, text);
		element.params = { ...element.params, fontSize: size, "transform.positionX": -40, "transform.positionY": 280 };
		return element;
	});
	return p;
}

/** A solid frame with optional ±noise (deterministic), RGBA. */
export function solid(width: number, height: number, rgb: [number, number, number], noise = 0, seed = 1, t?: number): PixelFrame {
	const data = new Uint8ClampedArray(width * height * 4);
	let s = seed >>> 0;
	const rand = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
	for (let i = 0; i < width * height; i++) {
		const n = noise ? Math.round((rand() * 2 - 1) * noise) : 0;
		data[i * 4] = rgb[0] + n;
		data[i * 4 + 1] = rgb[1] + n;
		data[i * 4 + 2] = rgb[2] + n;
		data[i * 4 + 3] = 255;
	}
	return { width, height, data, ...(t !== undefined ? { t } : {}) };
}

/** A frame split in two blocks: top `a`, bottom `b` (share of `a` = topShare). */
export function twoTone(width: number, height: number, a: [number, number, number], b: [number, number, number], topShare: number): PixelFrame {
	const data = new Uint8ClampedArray(width * height * 4);
	const split = Math.round(height * topShare);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const c = y < split ? a : b;
			const i = (y * width + x) * 4;
			data[i] = c[0];
			data[i + 1] = c[1];
			data[i + 2] = c[2];
			data[i + 3] = 255;
		}
	}
	return { width, height, data };
}

/** Synthetic "paper collage" references: cream paper with grain, a brick-red cut-out, a mustard map, and a 6 s clip with 3 shots. */
export function collageReferences(): ReferenceInput[] {
	const cream: [number, number, number] = [236, 226, 204];
	const brick: [number, number, number] = [200, 53, 43];
	const mustard: [number, number, number] = [226, 184, 74];
	const ink: [number, number, number] = [20, 20, 22];
	return [
		{ name: "paper-01.jpg", folder: "Paper textures", kind: "image", width: 1080, height: 1920, frames: [solid(48, 64, cream, 9, 3)] },
		{ name: "cutout-02.png", folder: "Paper textures", kind: "image", width: 1080, height: 1920, frames: [twoTone(48, 64, cream, brick, 0.6)] },
		{ name: "map-03.jpg", folder: "Map zoom", kind: "image", width: 1080, height: 1920, frames: [twoTone(48, 64, mustard, ink, 0.85)] },
		{
			name: "explainer-04.mp4",
			folder: "Map zoom",
			kind: "video",
			width: 1080,
			height: 1920,
			duration: 6,
			// shots: cream 0–2 s, brick 2–4 s, mustard 4–6 s, sampled at 2 fps
			frames: [0, 0.5, 1, 1.5, 2.25, 2.75, 3.25, 3.75, 4.25, 4.75, 5.25, 5.75].map((t, i) =>
				solid(24, 32, t < 2 ? cream : t < 4 ? brick : mustard, 4, 10 + i, t),
			),
		},
	];
}
