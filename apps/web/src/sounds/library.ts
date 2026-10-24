/**
 * RestorffCut's built-in SFX pack "restorff-core" (generated, ours — apps/web/src/sounds/pack). Served as static files
 * from /sfx/; this module reads its manifest once and caches the WAV blobs the panel previews and drags.
 */
import type { SfxLibraryEntry } from "@restorffcut/timeline-ops";

export interface SfxSound extends SfxLibraryEntry {
	file: string;
	description: string;
	licence: string;
	tags: string[];
	bytes: number;
	sync: "peak" | "onset";
	peak_at_s: number;
	onset_s: number;
	true_peak_dbtp: number | null;
	sample_peak_dbfs: number | null;
	rms_dbfs: number | null;
	crest_factor: number | null;
	lufs_i: number | null;
	lufs_m_max: number | null;
	target_lufs_m: number;
}

export interface SfxPackManifest {
	schema: "restorff-sfx-pack@1";
	pack: string;
	version: string;
	built: string;
	licence: string;
	measured_with: string;
	total_bytes: number;
	total_duration_s: number;
	sounds: SfxSound[];
}

export const SFX_MANIFEST_URL = "/sfx/manifest.json";

let manifestPromise: Promise<SfxPackManifest> | null = null;

export function loadSfxPack(): Promise<SfxPackManifest> {
	if (!manifestPromise) {
		manifestPromise = fetch(SFX_MANIFEST_URL)
			.then((response) => {
				if (!response.ok) throw new Error(`SFX manifest: ${response.status}`);
				return response.json() as Promise<SfxPackManifest>;
			})
			.catch((error) => {
				manifestPromise = null;
				throw error;
			});
	}
	return manifestPromise;
}

const blobs = new Map<string, Blob>();
const pending = new Map<string, Promise<Blob>>();

/** Fetch (once) the WAV of a sound; the panel warms this on hover so a drag can carry the file synchronously. */
export function loadSfxBlob(sound: Pick<SfxSound, "url">): Promise<Blob> {
	const cached = blobs.get(sound.url);
	if (cached) return Promise.resolve(cached);
	let request = pending.get(sound.url);
	if (!request) {
		request = fetch(sound.url)
			.then((response) => {
				if (!response.ok) throw new Error(`${sound.url}: ${response.status}`);
				return response.blob();
			})
			.then((blob) => {
				blobs.set(sound.url, blob);
				pending.delete(sound.url);
				return blob;
			})
			.catch((error) => {
				pending.delete(sound.url);
				throw error;
			});
		pending.set(sound.url, request);
	}
	return request;
}

export function cachedSfxBlob(sound: Pick<SfxSound, "url">): Blob | undefined {
	return blobs.get(sound.url);
}

/** "SFX whoosh-short.wav": the name a dropped file gets in the media bin and on the timeline (R23 reads it). */
export function sfxFileName(sound: Pick<SfxSound, "id">): string {
	return `SFX ${sound.id}.wav`;
}

export function matchesSfx(sound: SfxSound, query: string, category: string | null): boolean {
	if (category && sound.category !== category) return false;
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return (
		sound.id.includes(needle) ||
		sound.name.toLowerCase().includes(needle) ||
		sound.tags.some((tag) => tag.includes(needle)) ||
		sound.roles.some((role) => role.replace("_", " ").includes(needle))
	);
}
