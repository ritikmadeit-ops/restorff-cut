import { webEnv } from "@/env/web";

/**
 * Freesound is optional: the built-in pack (public/sfx) works with no key. `.env.example` ships placeholders
 * ("your_…"), so a key that is empty or still a placeholder counts as not configured.
 */
export function freesoundConfigured(): boolean {
	const key = webEnv.FREESOUND_API_KEY?.trim() ?? "";
	return key.length > 0 && !/^your[_-]/i.test(key);
}

export const FREESOUND_NOT_CONFIGURED = {
	error: "freesound_not_configured",
	message: "add a Freesound key in settings (FREESOUND_API_KEY in apps/web/.env.local)",
} as const;
