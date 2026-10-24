/**
 * Matte cache: memory (last few) + OPFS (`restorff-mattes/`, survives reloads). A cached matte is reused when it
 * covers the requested source range at least at the requested rate with the same model.
 *
 * File name: `<mediaId>__<model>__<fps>__<startMs>__<endMs>__<a|b>.matte` (a = alpha + boxes, b = boxes only).
 * Clearing: DevTools → Application → Storage → OPFS, or `clearMatteCache()`.
 */
import { OPFSAdapter } from "@/services/storage/opfs-adapter";
import { segmentationClient } from "./client";
import {
	DEFAULT_SEGMENTATION_MODEL,
	MATTE_CACHE_DIRECTORY,
	MATTE_MEMORY_CACHE_SIZE,
	MAX_ANALYSIS_FRAMES,
	type SegmentationModelId,
} from "./config";
import { deserializeMatte, serializeMatte } from "./matte";
import type { MatteTrack, SegmentationProgress } from "./types";

interface CacheKey {
	mediaId: string;
	model: SegmentationModelId;
	fps: number;
	startMs: number;
	endMs: number;
	alpha: boolean;
}

const memory: Array<{ key: CacheKey; track: MatteTrack }> = [];
let opfs: OPFSAdapter | null = null;

function getOpfs(): OPFSAdapter | null {
	if (opfs) return opfs;
	if (typeof navigator === "undefined" || !OPFSAdapter.isSupported()) return null;
	opfs = new OPFSAdapter(MATTE_CACHE_DIRECTORY);
	return opfs;
}

function safe(part: string): string {
	return part.replace(/[^a-zA-Z0-9-]/g, "_");
}

function keyToName(key: CacheKey): string {
	return `${safe(key.mediaId)}__${key.model}__${key.fps}__${key.startMs}__${key.endMs}__${key.alpha ? "a" : "b"}.matte`;
}

function nameToKey(name: string): CacheKey | null {
	const match = /^(.+)__(multiclass|selfie)__([0-9.]+)__(\d+)__(\d+)__([ab])\.matte$/.exec(name);
	if (!match) return null;
	return {
		mediaId: match[1],
		model: match[2] as SegmentationModelId,
		fps: Number(match[3]),
		startMs: Number(match[4]),
		endMs: Number(match[5]),
		alpha: match[6] === "a",
	};
}

function covers({ have, want }: { have: CacheKey; want: CacheKey }): boolean {
	const slackMs = 1000 / Math.max(1, have.fps) + 1;
	return (
		have.mediaId === safe(want.mediaId) &&
		have.model === want.model &&
		have.fps + 1e-6 >= want.fps &&
		(have.alpha || !want.alpha) &&
		have.startMs <= want.startMs + 1 &&
		have.endMs + slackMs >= want.endMs
	);
}

function remember(key: CacheKey, track: MatteTrack) {
	memory.unshift({ key, track });
	while (memory.length > MATTE_MEMORY_CACHE_SIZE) memory.pop();
}

/** Lowers the rate for long spans so a matte never exceeds MAX_ANALYSIS_FRAMES frames. */
export function effectiveAnalysisFps({ fps, start, end }: { fps: number; start: number; end: number }): number {
	const span = Math.max(1e-3, end - start);
	const capped = Math.min(fps, MAX_ANALYSIS_FRAMES / span);
	return Math.max(0.5, Math.round(capped * 100) / 100);
}

export async function findCachedMatte(want: CacheKey): Promise<MatteTrack | null> {
	const wanted = { ...want, mediaId: safe(want.mediaId) };
	const hit = memory.find((entry) => covers({ have: entry.key, want: wanted }));
	if (hit) return hit.track;
	const store = getOpfs();
	if (!store) return null;
	try {
		const names = await store.list();
		for (const name of names) {
			const key = nameToKey(name);
			if (!key || !covers({ have: key, want: wanted })) continue;
			const file = await store.get(name);
			if (!file) continue;
			const track = await deserializeMatte(file);
			if (!track) continue;
			remember(key, track);
			return track;
		}
	} catch (error) {
		console.warn("[segmentation] matte cache read failed", error);
	}
	return null;
}

/**
 * The matte (or boxes) for a span of a media file — from the cache when possible, else analysed in the worker and
 * cached. `start`/`end` are SOURCE seconds.
 */
export async function getMatte({
	mediaId,
	file,
	start,
	end,
	fps,
	model = DEFAULT_SEGMENTATION_MODEL,
	keepAlpha = true,
	onProgress,
	signal,
}: {
	mediaId: string;
	file: File;
	start: number;
	end: number;
	fps: number;
	model?: SegmentationModelId;
	keepAlpha?: boolean;
	onProgress?: SegmentationProgress;
	signal?: AbortSignal;
}): Promise<MatteTrack> {
	const rate = effectiveAnalysisFps({ fps, start, end });
	const key: CacheKey = {
		mediaId,
		model,
		fps: rate,
		startMs: Math.round(start * 1000),
		endMs: Math.round(end * 1000),
		alpha: keepAlpha,
	};
	const cached = await findCachedMatte(key);
	if (cached) {
		onProgress?.({ done: 1, total: 1, phase: "cached" });
		return cached;
	}
	const track = await segmentationClient.analyze({
		file,
		start,
		end,
		fps: rate,
		model,
		keepAlpha,
		onProgress,
		signal,
	});
	const storedKey = { ...key, mediaId: safe(mediaId) };
	remember(storedKey, track);
	const store = getOpfs();
	if (store) {
		const name = keyToName(storedKey);
		try {
			await store.set({ key: name, value: new File([serializeMatte(track)], name) });
		} catch (error) {
			console.warn("[segmentation] matte cache write failed (quota?)", error);
		}
	}
	return track;
}

export async function clearMatteCache(): Promise<void> {
	memory.length = 0;
	await getOpfs()?.clear();
}
