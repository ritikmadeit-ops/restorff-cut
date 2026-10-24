/**
 * Names as the Edit artboard prints them (docs/restorff/design/edit-artboard.png):
 * shot keys ("S01", "S16–S19"), the breadcrumb ("Halcyon Cold Brew / AD-014"),
 * clip names without file extensions. Pure functions, shared by the left panel,
 * the inspector, the timeline clips, the storyboard and the projects page.
 */

/** "morning-bed.mp3" -> "morning-bed". */
export function stripExtension(name: string): string {
	return name.replace(/\.[a-z0-9]{2,5}$/i, "");
}

/**
 * The shot key a clip carries in its name, as the compiler names shots:
 * "S19", "s19_pour.mp4", "AD-014_S03-kettle.mov" -> "S19" / "S19" / "S03".
 * Ranges ("S16–S19") are kept as written. Null when the name has none.
 */
export function shotKey(name: string | null | undefined): string | null {
	if (!name) return null;
	const range = name.match(/(?:^|[^A-Za-z0-9])([Ss]\d{1,3})\s*[–-]\s*([Ss]\d{1,3})(?=$|[^0-9])/);
	if (range) return `${range[1].toUpperCase()}–${range[2].toUpperCase()}`;
	const single = name.match(/(?:^|[^A-Za-z0-9])([Ss]\d{1,3})(?=$|[^0-9])/);
	return single ? single[1].toUpperCase() : null;
}

/** Tile label in KEPT CLIPS: the shot key when the name has one, else the name. */
export function shotLabel(name: string): string {
	return shotKey(name) ?? stripExtension(name);
}

/**
 * Clip label on the timeline: "S03 kettle" from "S03_kettle.mp4", or the bare
 * name. Underscores become spaces only after a shot key ("kettle_click" stays).
 */
export function clipLabel(name: string): string {
	const base = stripExtension(name);
	const key = shotKey(base);
	if (!key || key.includes("–")) return base;
	const rest = base
		.replace(/^.*?[Ss]\d{1,3}/, "")
		.replace(/^[\s_\-·.]+/, "")
		.replace(/_/g, " ")
		.trim();
	return rest ? `${key} ${rest}` : key;
}

export interface ProjectCrumbs {
	brand: string | null;
	ad: string | null;
	/** What to print when the name does not split into brand / ad. */
	name: string;
}

type RestorffMetaLike = { brand?: unknown; ad?: unknown; adId?: unknown } | null | undefined;

/**
 * Brand and ad for the breadcrumb ("in Restorff · Halcyon Cold Brew / AD-014 / Edit").
 * Order of truth: `metadata.restorff.brand` / `.ad` (or `.adId`) when a project came
 * from Restorff and carries them; else the project name split on " / " or " · "
 * ("Halcyon Cold Brew / AD-014"); else the name alone.
 */
export function projectCrumbs(name: string, restorff?: unknown): ProjectCrumbs {
	const meta = (restorff && typeof restorff === "object" ? restorff : null) as RestorffMetaLike;
	const metaBrand = typeof meta?.brand === "string" && meta.brand.trim() ? meta.brand.trim() : null;
	const metaAdRaw = typeof meta?.ad === "string" ? meta.ad : typeof meta?.adId === "string" ? meta.adId : null;
	const metaAd = metaAdRaw?.trim() ? metaAdRaw.trim() : null;
	if (metaBrand || metaAd) return { brand: metaBrand, ad: metaAd, name };

	const parts = name
		.split(/\s+[/·]\s+/)
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length >= 2) {
		return { brand: parts[0], ad: parts.slice(1).join(" / "), name };
	}
	return { brand: null, ad: null, name };
}

/** "0:05" — the artboard's ruler and storyboard time (m:ss, no leading zero on minutes). */
export function formatShortTime(seconds: number): string {
	const s = Math.max(0, seconds);
	const m = Math.floor(s / 60);
	const rest = Math.floor(s - m * 60);
	return `${m}:${String(rest).padStart(2, "0")}`;
}

/** "0:12.4" — storyboard ranges, one decimal. */
export function formatTenths(seconds: number): string {
	const s = Math.max(0, seconds);
	const m = Math.floor(s / 60);
	const rest = s - m * 60;
	return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** "−2 dB" with a real minus sign, as the artboard prints gains. */
export function formatDb(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	if (rounded === 0) return "0 dB";
	return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} dB`;
}
