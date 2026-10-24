/**
 * The generated music beds in the editor (voice-music agent, 2026-10-20): reads /music/manifest.json once (built by
 * src/music/beds/build-beds.ts; licence "generated, ours"). The beds play from /music/<id>.ogg.
 */
import type { MusicBed } from "@/server/music-plan";

export interface MusicBedsManifest {
	schema: "restorff-music-beds@1";
	pack: string;
	version: string;
	licence: string;
	licence_note: string;
	measured_with: string;
	total_bytes: number;
	total_duration_s: number;
	beds: MusicBed[];
}

export const MUSIC_MANIFEST_URL = "/music/manifest.json";

let manifestPromise: Promise<MusicBedsManifest> | null = null;

export function loadMusicBeds(): Promise<MusicBedsManifest> {
	if (!manifestPromise) {
		manifestPromise = fetch(MUSIC_MANIFEST_URL)
			.then((response) => {
				if (!response.ok) throw new Error(`music manifest: ${response.status}`);
				return response.json() as Promise<MusicBedsManifest>;
			})
			.catch((error) => {
				manifestPromise = null;
				throw error;
			});
	}
	return manifestPromise;
}

export function matchesBed(bed: MusicBed, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return [bed.id, bed.name, bed.mood, ...(bed.tags ?? [])].some((field) => field.toLowerCase().includes(q));
}
