/**
 * Piece types (gate-v2, 2026-10-20): what kind of piece a timeline is chooses the gate's rule set. The five
 * recreations (docs/restorff/recreations/SUMMARY.md gap 5) showed a gate written for vertical ads blocking good
 * explainers and motion graphics: an offer MUST, a Reels safe zone on 16:9, "should be 1080x1920".
 *
 * One table (PROFILES) says, per piece, each rule's severity or why it is skipped, and the rhythm bars. The ad row is
 * the studio's CRAFT bar unchanged; the other rows' rhythm bars are ASSUMPTIONs set from the reels' MEASURED pacing in
 * docs/restorff/PARITY.md §8 (about two thirds of the reel's rate, so the reels themselves pass). EXPORT-GATE §2a.
 *
 * Who decides the piece: the owner's setting (`metadata.restorff.piece`, or `brief.piece`) wins; then a `check
 * {piece}` argument; else it is inferred from the timeline and the result says so. A Claude cannot re-type an
 * owner-set ad to drop R15 (D13), and a brief with a verified offer keeps R15 a MUST on any piece.
 */
import type { GateProject, PieceDecision, PieceType, Severity } from "./types.ts";

export const PIECE_TYPES: readonly PieceType[] = ["ad", "explainer", "brand_film", "motion_graphic", "talking_head"];

/** A rule's mode on a piece: a severity, or "skip" (listed in `skipped` with the profile's reason). */
export type RuleMode = Severity | "skip";

export interface RhythmBars {
	/** R1: shots that must start in 0–3 s (null = not a rule for this piece). */
	r1: number | null;
	/** R5: median shot length, seconds (null = no median rule). */
	median: number | null;
	/** R5: longest stretch with no picture change and no move, seconds. */
	longest: number;
	/** R6: picture changes per 10 s. */
	perTen: number;
	/** Overlay beats (a composition or text pop entering) count as picture changes. */
	beats: boolean;
	/** R6: a window whose every shot moves (a camera move, an animated composition) has enough change. */
	movingCounts: boolean;
	/** Where the numbers come from (said in the finding's target). */
	basis: string;
}

export interface PieceProfile {
	label: string;
	rules: Record<string, RuleMode>;
	/** Why a rule is skipped on this piece. */
	skipWhy: Record<string, string>;
	rhythm: RhythmBars;
	/** R3: the hook headline must be on screen by this time, seconds. */
	r3By: number;
	/** CAP-LEN: most words in one caption chunk (ad: CRAFT R18, 1–3; elsewhere the reels' 1–5, PARITY §8.1/8.2). */
	capMax: number;
	/** Aspect ratios this piece is delivered in (FORMAT accepts any of them; it never flips orientation). */
	aspects: string[];
}

const AD_ONLY = "an ad rule (the piece is not an ad)";

export const PROFILES: Record<PieceType, PieceProfile> = {
	ad: {
		label: "ad",
		rules: {
			SAFE: "must", "CAP-LEN": "should", R3: "should", R15: "must", R1: "should", R5: "should", R6: "should",
			R12: "should", R23: "should", R4: "should", R21: "should", CLEAN: "must", FORMAT: "must", FACE: "should", FLASH: "must",
		},
		skipWhy: {},
		rhythm: { r1: 3, median: 2.2, longest: 3.5, perTen: 4, beats: false, movingCounts: false, basis: "CRAFT R1/R5/R6" },
		r3By: 0.3,
		capMax: 3,
		aspects: ["9:16", "4:5", "1:1", "16:9"],
	},
	talking_head: {
		label: "talking head",
		rules: {
			SAFE: "must", "CAP-LEN": "should", R3: "should", R15: "skip", R1: "skip", R5: "should", R6: "should",
			R12: "info", R23: "should", R4: "skip", R21: "skip", CLEAN: "must", FORMAT: "must", FACE: "should", FLASH: "must",
		},
		skipWhy: { R15: AD_ONLY, R1: `${AD_ONLY}: a talking head opens on the speaker, its hook is the headline (R3)`, R4: AD_ONLY, R21: AD_ONLY },
		// PARITY §8.1 overlay beats 5.1 / 10 s (0 visible cuts), §8.2 1.9 cuts / 10 s, §8.4 ~10 changes / 10 s.
		rhythm: { r1: null, median: null, longest: 8, perTen: 2, beats: true, movingCounts: false, basis: "reels §8.1/8.2/8.4: 1.9–10 changes per 10 s (ASSUMPTION)" },
		r3By: 0.3,
		capMax: 5,
		aspects: ["9:16", "4:5", "1:1", "16:9"],
	},
	explainer: {
		label: "explainer",
		rules: {
			SAFE: "must", "CAP-LEN": "should", R3: "should", R15: "skip", R1: "skip", R5: "should", R6: "should",
			R12: "info", R23: "should", R4: "skip", R21: "skip", CLEAN: "must", FORMAT: "must", FACE: "should", FLASH: "must",
		},
		skipWhy: { R15: AD_ONLY, R1: `${AD_ONLY}: an explainer opens on its title or first beat`, R4: AD_ONLY, R21: AD_ONLY },
		// PARITY §8.5 4.7 cuts / 10 s, §8.1 5.1 overlay beats / 10 s.
		rhythm: { r1: null, median: null, longest: 6, perTen: 3, beats: true, movingCounts: false, basis: "reels §8.1/8.5: 4.7–5.1 changes per 10 s (ASSUMPTION)" },
		r3By: 0.3,
		capMax: 5,
		aspects: ["16:9", "9:16", "1:1", "4:5"],
	},
	motion_graphic: {
		label: "motion graphic",
		rules: {
			SAFE: "must", "CAP-LEN": "should", R3: "info", R15: "skip", R1: "skip", R5: "should", R6: "should",
			R12: "should", R23: "should", R4: "skip", R21: "skip", CLEAN: "must", FORMAT: "must", FACE: "should", FLASH: "should",
		},
		skipWhy: { R15: AD_ONLY, R1: `${AD_ONLY}: a motion graphic builds its own opening`, R4: AD_ONLY, R21: AD_ONLY },
		// PARITY §8.3 ≈ 2.1 scene changes / 10 s.
		rhythm: { r1: null, median: null, longest: 10, perTen: 1.5, beats: false, movingCounts: true, basis: "reel §8.3: 2.1 scene changes per 10 s (ASSUMPTION)" },
		r3By: 1,
		capMax: 5,
		aspects: ["9:16", "16:9", "1:1", "4:5"],
	},
	brand_film: {
		label: "brand film",
		rules: {
			SAFE: "must", "CAP-LEN": "should", R3: "skip", R15: "skip", R1: "skip", R5: "should", R6: "should",
			R12: "should", R23: "should", R4: "skip", R21: "skip", CLEAN: "must", FORMAT: "must", FACE: "should", FLASH: "should",
		},
		skipWhy: { R3: "a feed rule (a brand film is not cut for sound-off scrolling)", R15: AD_ONLY, R1: AD_ONLY, R4: AD_ONLY, R21: AD_ONLY },
		// PARITY §8.2 1.9 cuts / 10 s (the founder piece).
		rhythm: { r1: null, median: null, longest: 8, perTen: 1, beats: false, movingCounts: true, basis: "reel §8.2: 1.9 cuts per 10 s (ASSUMPTION)" },
		r3By: 0.3,
		capMax: 5,
		aspects: ["16:9", "9:16", "1:1", "4:5", "2.39:1", "1.85:1"],
	},
};

export function isPieceType(value: unknown): value is PieceType {
	return typeof value === "string" && (PIECE_TYPES as readonly string[]).includes(value);
}

/** Accepts "motion graphic", "Motion-Graphic", "brand film", "talking head", "tutorial" (→ explainer)… */
export function normalizePiece(value: unknown): PieceType | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
	if (isPieceType(v)) return v;
	const alias: Record<string, PieceType> = {
		motion: "motion_graphic", motiongraphic: "motion_graphic", motion_graphics: "motion_graphic", mograph: "motion_graphic",
		brand: "brand_film", film: "brand_film", brandfilm: "brand_film",
		talkinghead: "talking_head", talking: "talking_head", ugc: "talking_head",
		tutorial: "explainer", how_to: "explainer", howto: "explainer",
		advert: "ad", advertisement: "ad", commercial: "ad", promo: "ad",
	};
	return alias[v] ?? null;
}

// ------------------------------------------------------------------ inference

export interface PieceSignals {
	/** Canvas aspect, w / h. */
	aspect: number;
	/** The brief carries a verified offer (price / reason / cta). */
	briefOffer: boolean;
	/** On-screen text in the timeline that reads like an offer (a price and a call to action). */
	offerOnScreen: boolean;
	/** Share of the runtime whose base picture is a composition (motion graphics written as code). */
	compositionShare: number;
	/** Share of the runtime with camera video on the picture's base layer. */
	videoShare: number;
	/** Camera video with its own sound (a speaker) or a voice-over covers this share of the runtime. */
	speechShare: number;
	/** The timeline was built from reference folders (references build) or carries explainer beats. */
	references: boolean;
	/** Captions on the timeline. */
	captions: boolean;
}

/** Decide the piece: owner-set first (project, brief), then the check argument, else inferred from the signals. */
export function decidePiece(project: GateProject, requested: unknown, signals: PieceSignals): PieceDecision {
	const meta = (project.metadata?.restorff ?? {}) as { piece?: unknown; brief?: { piece?: unknown } };
	const set = meta.piece && typeof meta.piece === "object" ? (meta.piece as { type?: unknown }).type : meta.piece;
	const fromProject = normalizePiece(set);
	const fromBrief = normalizePiece(meta.brief?.piece);
	const asked = requested == null || requested === "" ? null : normalizePiece(requested);
	const askedBad = requested != null && requested !== "" && !asked;
	const ignore = (owner: PieceType, where: string) =>
		asked && asked !== owner
			? { type: asked, why: `the owner set the piece to ${owner} (${where}); only the owner changes it (D13)` }
			: askedBad
				? { type: String(requested), why: `not a piece type (${PIECE_TYPES.join(" · ")})` }
				: null;
	if (fromProject) return { type: fromProject, source: "project", why: "metadata.restorff.piece", ignored: ignore(fromProject, "metadata.restorff.piece") };
	if (fromBrief) return { type: fromBrief, source: "brief", why: "metadata.restorff.brief.piece", ignored: ignore(fromBrief, "the brief") };
	if (asked) return { type: asked, source: "check argument", why: `asked for in this check (piece: "${asked}"); not saved on the timeline` };
	const inferred = inferPiece(signals);
	return askedBad ? { ...inferred, ignored: { type: String(requested), why: `not a piece type (${PIECE_TYPES.join(" · ")})` } } : inferred;
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

export function inferPiece(s: PieceSignals): PieceDecision {
	const landscape = s.aspect > 1.2;
	const base = (type: PieceType, why: string): PieceDecision => ({
		type,
		source: "inferred",
		why: `${why}. If that is wrong: check {piece: "<${PIECE_TYPES.join(" | ")}>"}, or the owner sets metadata.restorff.piece`,
	});
	if (s.briefOffer) return base("ad", "the brief carries a verified offer");
	if (s.offerOnScreen) return base("ad", "an offer (a price and a call to action) is on screen");
	if (s.compositionShare >= 0.6 && s.videoShare < 0.3)
		return base("motion_graphic", `compositions are the picture for ${pct(s.compositionShare)} of the runtime (camera video ${pct(s.videoShare)})`);
	if (landscape && (s.references || s.compositionShare > 0.15 || s.speechShare > 0))
		return base("explainer", `a ${s.aspect.toFixed(2)}:1 landscape canvas${s.references ? " built from reference folders" : ""}${s.compositionShare > 0.15 ? `, compositions on ${pct(s.compositionShare)} of it` : ""}`);
	if (s.videoShare >= 0.5 && s.speechShare >= 0.5)
		return base("talking_head", `camera video with speech on ${pct(Math.min(s.videoShare, s.speechShare))} of the runtime, no offer in the brief or on screen`);
	if (landscape) return base("brand_film", "a landscape canvas with no voice, offer or compositions");
	return base("ad", "a vertical cut with no other signal (the gate's default)");
}

// ------------------------------------------------------------------ safe zones and formats

export interface SafeZone {
	x0: number;
	x1: number;
	y0: number;
	y1: number;
	/** Name and basis, said in SAFE findings. */
	name: string;
}

/**
 * The text safe area for a canvas and platform, canvas px.
 * - 9:16 on reels / tiktok / shorts (the default for 9:16): x 60–940, y 220–1500 on 1080x1920, scaled (EXPORT-GATE
 *   SAFE, ASSUMPTION, UNVERIFIED against today's overlays).
 * - every other canvas (16:9, 1:1, 4:5, or platform feed / youtube / broadcast): title-safe, 5 % in from each edge
 *   (ASSUMPTION: the SMPTE/EBU 90 % title-safe convention).
 */
export function safeZoneFor(canvas: { width: number; height: number }, platform?: string | null): SafeZone {
	const p = (platform ?? "").toLowerCase();
	const vertical = canvas.height / canvas.width > 1.6;
	const reels = vertical && !/feed|youtube|broadcast|tv|landscape/.test(p);
	if (reels) {
		const kx = canvas.width / 1080;
		const ky = canvas.height / 1920;
		return { x0: 60 * kx, x1: 940 * kx, y0: 220 * ky, y1: 1500 * ky, name: `${p || "reels"} zone (x 60–940, y 220–1500 on 1080x1920)` };
	}
	return {
		x0: canvas.width * 0.05,
		x1: canvas.width * 0.95,
		y0: canvas.height * 0.05,
		y1: canvas.height * 0.95,
		name: `title-safe 90 %${p ? ` (${p})` : ""}`,
	};
}

const ASPECTS: Record<string, number> = { "9:16": 9 / 16, "4:5": 4 / 5, "1:1": 1, "16:9": 16 / 9, "2.39:1": 2.39, "1.85:1": 1.85 };

export function aspectName(width: number, height: number): string | null {
	const r = width / height;
	for (const [name, value] of Object.entries(ASPECTS)) if (Math.abs(r - value) / value < 0.01) return name;
	return null;
}

/** Standard delivery sizes per aspect (FORMAT's fix never changes orientation). */
export const STANDARD_SIZES: Record<string, Array<[number, number]>> = {
	"9:16": [[1080, 1920], [1440, 2560], [2160, 3840], [720, 1280]],
	"4:5": [[1080, 1350], [1440, 1800]],
	"1:1": [[1080, 1080], [1440, 1440]],
	"16:9": [[1920, 1080], [2560, 1440], [3840, 2160], [1280, 720]],
	"2.39:1": [[1920, 804], [3840, 1608]],
	"1.85:1": [[1998, 1080], [1920, 1038]],
};

/** The nearest standard size with the same orientation (and the same aspect if it is a known one). */
export function nearestStandard(width: number, height: number, aspects: string[]): [number, number] {
	const landscape = width >= height;
	const pool = aspects
		.flatMap((a) => STANDARD_SIZES[a] ?? [])
		.filter(([w, h]) => (w >= h) === landscape || w === h);
	const r = width / height;
	let best: [number, number] = landscape ? [1920, 1080] : [1080, 1920];
	let score = Number.POSITIVE_INFINITY;
	for (const [w, h] of pool) {
		const s = Math.abs(Math.log(w / h / r)) * 10 + Math.abs(Math.log(w / width));
		if (s < score) {
			score = s;
			best = [w, h];
		}
	}
	return best;
}
