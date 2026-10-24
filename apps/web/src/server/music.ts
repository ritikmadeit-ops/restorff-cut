/**
 * The generated music beds on the server (voice-music agent, 2026-10-20): reads apps/web/public/music/manifest.json
 * (built by `bun src/music/beds/build-beds.ts`; licence "generated, ours") and finds a bed by id or mood.
 * RESTORFFCUT_MUSIC_DIR overrides the folder (default <apps/web>/public/music, served at /music/).
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { HttpError } from "./http";
import type { MusicBed } from "./music-plan";

export interface MusicManifest {
	schema: "restorff-music-beds@1";
	pack: string;
	version: string;
	built: string;
	licence: string;
	licence_note: string;
	total_bytes: number;
	total_duration_s: number;
	beds: MusicBed[];
}

export function musicDir(): string {
	const configured = process.env.RESTORFFCUT_MUSIC_DIR?.trim();
	if (configured) return path.resolve(configured);
	return path.join(process.cwd(), "public", "music");
}

let cached: { mtime: number; manifest: MusicManifest } | null = null;

export function loadBeds(): MusicManifest {
	const file = path.join(musicDir(), "manifest.json");
	let mtime: number;
	try {
		mtime = statSync(file).mtimeMs;
	} catch {
		throw new HttpError(501, `no music beds on this server (${file} is missing): cd apps/web && bun src/music/beds/build-beds.ts`);
	}
	if (cached && cached.mtime === mtime) return cached.manifest;
	const manifest = JSON.parse(readFileSync(file, "utf8")) as MusicManifest;
	if (manifest?.schema !== "restorff-music-beds@1" || !Array.isArray(manifest.beds)) throw new HttpError(500, `${file} is not a restorff-music-beds@1 manifest`);
	cached = { mtime, manifest };
	return manifest;
}

export const MOODS = ["warm", "moody", "upbeat", "ambient", "tense"] as const;

/** A bed by id ("warm-90", or its prefix "warm"), else by mood; a 400 that lists the beds otherwise. */
export function findBed({ id, mood }: { id?: string; mood?: string }): MusicBed {
	const { beds } = loadBeds();
	const want = (id ?? "").trim().toLowerCase();
	const feel = (mood ?? "").trim().toLowerCase();
	const found =
		(want && (beds.find((bed) => bed.id === want) ?? beds.find((bed) => bed.id.startsWith(`${want}-`) || bed.name.toLowerCase() === want))) ||
		(feel && (beds.find((bed) => bed.mood === feel) ?? beds.find((bed) => bed.tags?.includes(feel))));
	if (found) return found;
	throw new HttpError(400, `no bed ${want ? `"${want}"` : `for mood "${feel}"`}; beds: ${beds.map((bed) => `${bed.id} (${bed.mood})`).join(", ")}`, {
		beds: beds.map((bed) => ({ id: bed.id, mood: bed.mood })),
	});
}
