/**
 * Browser side of beat detection: decode a music element's media to mono 22.05 kHz,
 * run `detectBeats`, and turn the result into a `BeatGrid` in SOURCE ticks (so the grid
 * moves and trims with the clip). Results are cached per media id for the session.
 */
import type { MediaAsset } from "@/media/types";
import type { AudioElement, BeatGrid } from "@/timeline";
import { mediaTimeFromSeconds } from "@/wasm";
import { decodeAudioToFloat32, fetchLibraryUrl } from "@/media/audio";
import { detectBeats, type BeatAnalysis } from "./detect";

const ANALYSIS_SAMPLE_RATE = 22050;
const cache = new Map<string, Promise<BeatAnalysis>>();

async function fetchElementAudio({
	element,
	mediaAssets,
}: {
	element: AudioElement;
	mediaAssets: MediaAsset[];
}): Promise<{ key: string; blob: Blob }> {
	if (element.sourceType === "upload") {
		const asset = mediaAssets.find((candidate) => candidate.id === element.mediaId);
		if (!asset) throw new Error("The music file is not in this project's media");
		return { key: asset.id, blob: asset.file };
	}
	const response = await fetchLibraryUrl(element.sourceUrl); // security-pass: no private / internal hosts
	if (!response.ok) throw new Error(`Could not fetch the music (${response.status})`);
	return { key: element.sourceUrl, blob: await response.blob() };
}

export async function analyzeElementBeats({
	element,
	mediaAssets,
}: {
	element: AudioElement;
	mediaAssets: MediaAsset[];
}): Promise<BeatAnalysis> {
	const { key, blob } = await fetchElementAudio({ element, mediaAssets });
	let pending = cache.get(key);
	if (!pending) {
		pending = decodeAudioToFloat32({ audioBlob: blob, sampleRate: ANALYSIS_SAMPLE_RATE }).then(
			({ samples, sampleRate }) => detectBeats(samples, sampleRate),
		);
		cache.set(key, pending);
		pending.catch(() => cache.delete(key));
	}
	return pending;
}

export function analysisToBeatGrid(analysis: BeatAnalysis): BeatGrid {
	return {
		bpm: analysis.bpm,
		times: analysis.beats.map((seconds) => mediaTimeFromSeconds({ seconds })),
		downbeats: analysis.downbeats,
		source: "detected",
	};
}
