/**
 * Build an explainer from a studied reference set, server-side (EDT-21, PARITY G14 + E7; mcp-references agent,
 * 2026-10-20). The browser's `styles-lab/explainer/build.ts`, without a browser:
 *   1. the previous version on this branch (if any) is taken out: its elements, and its tracks once empty
 *   2. `explainerPlan(card, answers, timeline media, {start: end of the main track})` (@restorffcut/styles) → ops@1 with
 *      `composition:<key>` placeholders; collage compositions collage-fx added since (parallax-strip, triptych…) are
 *      slotted in as extra beats before the closing stamp when the library has them
 *   3. every composition rendered at the target canvas by the compositions service (cached by input hash), recorded
 *      with `import_media` (url /api/compositions/file/<hash>) and its file put in the project's media store
 *   4. `bindCompositions` → one atomic batch → ONE commit by `claude` whose message is the change note
 *   5. a branch `explainer-v<n>` at that commit, and the version recorded in the reference set (for "What's new")
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	bindCompositions,
	COLLAGE_COMPOSITIONS,
	collageColors,
	COMPOSITION_PLACEHOLDER_PREFIX,
	type CompositionRequest,
	describePlan,
	type ExplainerAnswersV2,
	explainerPlanV2,
	type ExplainerPlanV2,
	FORMATS,
	type BoundComposition,
	type ExplainerAnswers,
	type ExplainerAsset,
	type ExplainerBeat,
	type ExplainerPlan,
	type PictureAsset,
	resolveStills,
	type StyleCard,
} from "@restorffcut/styles";
import { apply, type Op, type Project as OpsProject } from "@restorffcut/timeline-ops";
import { callService } from "@/app/api/compositions/_lib/service";
import { resolveMediaDir } from "@/lib/db/store";
import type { ProjectSnapshot, SnapshotElement, SnapshotScene, SnapshotTrack } from "@/sync/snapshot";
import type { Actor } from "./auth";
import { listProjectMedia, putProjectMedia } from "./media";
import { createBranch, getProjectHead, pushCommit } from "./projects";
import { hasAlpha, stillDataUrl, toneOf } from "./references-frames";
import type { ExplainerVersion, ReferenceSet, VersionSummary } from "./references-store";

const TICKS = 120_000;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const seconds = (ticks: number) => round3(ticks / TICKS);

export const FOOTAGE_VALUES = ["mine", "stills", "none"] as const;
export const FEEL_VALUES = ["playful", "nostalgic", "serious", "punchy"] as const;
export const FORMAT_VALUES = Object.keys(FORMATS);

// ─── snapshot helpers ───────────────────────────────────────────────────────────────────────────────────────────

function activeScene(snapshot: ProjectSnapshot): SnapshotScene | null {
	const scenes = snapshot.scenes ?? [];
	return scenes.find((scene) => scene.id === snapshot.currentSceneId) ?? scenes.find((scene) => scene.isMain) ?? scenes[0] ?? null;
}

function tracksOf(scene: SnapshotScene | null): SnapshotTrack[] {
	if (!scene?.tracks) return [];
	return [...(scene.tracks.overlay ?? []), ...(scene.tracks.main ? [scene.tracks.main] : []), ...(scene.tracks.audio ?? [])];
}

function findElement(snapshot: ProjectSnapshot, id: string): SnapshotElement | null {
	for (const track of tracksOf(activeScene(snapshot))) {
		const element = (track.elements ?? []).find((candidate) => candidate.id === id);
		if (element) return element;
	}
	return null;
}

function mainTrackEnd(snapshot: ProjectSnapshot): number {
	const main = activeScene(snapshot)?.tracks?.main;
	return seconds((main?.elements ?? []).reduce((end, element) => Math.max(end, element.startTime + element.duration), 0));
}

function canvasOf(snapshot: ProjectSnapshot): { width: number; height: number; fps: number } {
	const size = snapshot.settings?.canvasSize;
	const fps = snapshot.settings?.fps;
	const rate = typeof fps === "number" ? fps : fps ? fps.numerator / fps.denominator : 30;
	return { width: size?.width ?? 1080, height: size?.height ?? 1920, fps: Math.max(1, Math.min(120, Math.round(rate))) };
}

// ─── assets ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A picture to use: a media id, or {media_id, …} with what the person says it shows (explainer-v2: caption and tags
 * are matched against the lines, like its name). */
export type AssetSpec = string | { media_id: string; kind?: "video" | "image"; name?: string; duration?: number; caption?: string; tags?: string[] };

interface ManifestEntry {
	id: string;
	kind: string;
	name?: string;
	duration?: number;
	width?: number;
	height?: number;
	url?: string;
}

/** Pictures the timeline knows (manifest + media its clips play), composition renders left out. */
function timelineMedia(snapshot: ProjectSnapshot): ExplainerAsset[] {
	const out = new Map<string, ExplainerAsset>();
	const manifest = (((snapshot.metadata.restorff ?? {}) as { media?: ManifestEntry[] }).media ?? []) as ManifestEntry[];
	for (const entry of manifest) {
		if (entry.kind !== "video" && entry.kind !== "image") continue;
		if (typeof entry.url === "string" && entry.url.startsWith("/api/compositions/")) continue;
		out.set(entry.id, {
			id: entry.id,
			kind: entry.kind,
			name: entry.name ?? entry.id,
			...(entry.kind === "video" && typeof entry.duration === "number" ? { duration: seconds(entry.duration) } : {}),
			...(entry.width ? { width: entry.width } : {}),
			...(entry.height ? { height: entry.height } : {}),
		});
	}
	for (const scene of snapshot.scenes ?? []) {
		for (const track of tracksOf(scene)) {
			for (const element of track.elements ?? []) {
				if (!element.mediaId || out.has(element.mediaId)) continue;
				if (element.type !== "video" && element.type !== "image") continue;
				if ((element.restorff as { composition?: unknown } | undefined)?.composition) continue;
				const source = typeof element.sourceDuration === "number" ? seconds(element.sourceDuration as number) : undefined;
				out.set(element.mediaId, { id: element.mediaId, kind: element.type, name: element.name ?? element.mediaId, ...(element.type === "video" && source ? { duration: source } : {}) });
			}
		}
	}
	return [...out.values()];
}

function resolveAssets(snapshot: ProjectSnapshot, specs: AssetSpec[] | undefined, exclude: Set<string>): { assets: PictureAsset[]; unknown: string[] } {
	const known = timelineMedia(snapshot);
	if (!specs) return { assets: known.filter((asset) => !exclude.has(asset.id)), unknown: [] };
	const assets: PictureAsset[] = [];
	const unknown: string[] = [];
	for (const spec of specs) {
		const id = typeof spec === "string" ? spec : spec.media_id;
		const found = known.find((asset) => asset.id === id);
		const said = typeof spec === "string" ? {} : { ...(spec.caption?.trim() ? { caption: spec.caption.trim() } : {}), ...(spec.tags?.length ? { tags: spec.tags } : {}) };
		if (found) {
			assets.push(typeof spec === "string" ? found : { ...found, ...(spec.name ? { name: spec.name } : {}), ...(spec.duration ? { duration: spec.duration } : {}), ...said });
		} else if (typeof spec !== "string" && spec.kind) {
			assets.push({ id, kind: spec.kind, name: spec.name ?? id, ...(spec.duration ? { duration: spec.duration } : {}), ...said });
		} else unknown.push(id);
	}
	return { assets, unknown };
}

// ─── the composition library ────────────────────────────────────────────────────────────────────────────────────

interface ParamSpec {
	type?: string;
	default?: unknown;
	maxLength?: number;
	options?: unknown[];
}

interface CatalogueEntry {
	name: string;
	title?: string;
	duration?: number;
	params?: Record<string, ParamSpec>;
}

let catalogueCache: { at: number; entries: CatalogueEntry[] } | null = null;

async function catalogue(): Promise<CatalogueEntry[] | null> {
	if (catalogueCache && Date.now() - catalogueCache.at < 60_000) return catalogueCache.entries;
	try {
		const entries = await callService<CatalogueEntry[]>({ verb: "catalogue" });
		catalogueCache = { at: Date.now(), entries };
		return entries;
	} catch {
		return null;
	}
}

interface RenderAnswer {
	name: string;
	hash: string;
	file: string;
	cached: boolean;
	duration: number;
	width: number;
	height: number;
	fps: number;
	frames: number;
	bytes: number;
	ms: number;
}

/**
 * Collage pieces collage-fx builds into the library (EFFECTS.md FX-56, 57, 60, 61 + a map zoom), used as extra beats
 * before the stamp when the library has them. The plan (packages/styles) does not know them yet.
 */
const COLLAGE_EXTRAS: Array<{ names: string[]; effect: string; line: string }> = [
	{ names: ["parallax-strip"], effect: "FX-61 side-scrolling parallax strip", line: "Along the way" },
	{ names: ["map-zoom", "globe-zoom", "globe"], effect: "map / globe zoom", line: "Zoom in on where it starts" },
	{ names: ["halftone-push"], effect: "FX-56 halftone push-in", line: "Up close" },
	{ names: ["triptych"], effect: "FX-57 triptych panels", line: "Three steps" },
	{ names: ["letter-tiles"], effect: "FX-60 letter tiles", line: "" },
];
const MAX_EXTRAS = 2;

/** Props for a composition the plan does not know: colours by param name from the card, text params from the topic. */
function extraProps(entry: CatalogueEntry, colors: ReturnType<typeof collageColors>, short: string, feelEase: string, still: string | null): Record<string, unknown> {
	const props: Record<string, unknown> = {};
	for (const [key, spec] of Object.entries(entry.params ?? {})) {
		const k = key.toLowerCase();
		// a photo param (halftone-push `image`) gets the timeline's own still; cut-out params (`hero`) keep their art
		if (spec.type === "image") {
			if (k === "image" && still) props[key] = still;
		} else if (spec.type === "color") {
			if (/paper|background|bg|wall|sky/.test(k)) props[key] = colors.paper;
			else if (/accent|tag|label/.test(k)) props[key] = colors.accent;
			else if (/route|thread|line|outline|red|stroke/.test(k)) props[key] = colors.red;
			else if (/ink|text|type/.test(k)) props[key] = colors.ink;
		} else if (spec.type === "string" && /^(title|text|label|tag|legend|headline|caption|word)$/.test(k)) {
			const max = spec.maxLength ?? 28;
			props[key] = short.length <= max ? short : `${short.slice(0, max - 1).trimEnd()}…`;
		} else if (k === "ease" && Array.isArray(spec.options) && spec.options.includes(feelEase)) {
			props[key] = feelEase;
		}
	}
	return props;
}

/**
 * Slot library compositions the plan does not know (collage-fx) in before the closing stamp: the stamp beat and
 * everything after it moves later by their length; the main track's gap is filled from the same footage.
 */
export function addCollageExtras(plan: ExplainerPlan, entries: CatalogueEntry[], card: StyleCard, answers: ExplainerAnswers, assets: ExplainerAsset[], still: string | null = null): string[] {
	const used = new Set(plan.compositions.map((request) => request.name));
	const picks: Array<{ entry: CatalogueEntry; effect: string; line: string }> = [];
	for (const extra of COLLAGE_EXTRAS) {
		const entry = entries.find((candidate) => extra.names.includes(candidate.name) && !used.has(candidate.name));
		if (entry && picks.length < MAX_EXTRAS) picks.push({ entry, effect: extra.effect, line: extra.line });
	}
	const stamp = plan.beats.at(-1);
	if (!picks.length || !stamp || stamp.kind !== "stamp") return [];
	const at = stamp.start;
	const lengths = picks.map((pick) => Math.max(2.5, Math.min(5, pick.entry.duration ?? 4)));
	const shift = round3(lengths.reduce((a, b) => a + b, 0));
	// 1. move the stamp (and anything at or after it) later
	const loose = plan.ops as unknown as Array<Record<string, unknown>>;
	for (const op of loose) {
		if ((op.op === "insert" || op.op === "text_pop") && typeof op.t === "number" && op.t >= at - 1e-6) op.t = round3(op.t + shift);
	}
	for (const request of plan.compositions) if (request.at >= at - 1e-6) request.at = round3(request.at + shift);
	stamp.start = round3(stamp.start + shift);
	stamp.end = round3(stamp.end + shift);
	// 2. the extra beats
	const colors = collageColors(card);
	const topic = (answers.topic ?? "").trim() || "How the farm-to-bottle route works";
	const short = topic.toUpperCase().slice(0, 28);
	const ease = { playful: "bouncy", nostalgic: "gentle", serious: "smooth", punchy: "snappy" }[answers.feel ?? "playful"] ?? "bouncy";
	const textStyle = loose.find((op) => op.op === "text_pop" && op.track === "explainer-text")?.style;
	const mainSources = loose.filter((op) => op.op === "insert" && op.track === "main");
	const added: Op[] = [];
	let cursor = at;
	picks.forEach((pick, i) => {
		const dur = lengths[i] as number;
		const key = `extra${i + 1}-${pick.entry.name}`;
		const placeholder = `${COMPOSITION_PLACEHOLDER_PREFIX}${key}`;
		const props = extraProps(pick.entry, colors, short, ease, still);
		plan.compositions.push({ key, name: pick.entry.name, title: pick.entry.title ?? pick.entry.name, props, at: round3(cursor), dur, placeholder, beat: plan.beats.length - 1 + i });
		added.push({ op: "insert", author: "claude", track: "explainer-motion", t: round3(cursor), media: placeholder, media_kind: "video", dur, name: pick.entry.title ?? pick.entry.name, ref: `explainer-${key}` } as Op);
		// footage under it, so the main track has no hole (a still, or a clip long enough)
		if (mainSources.length) {
			const still = assets.find((asset) => asset.kind === "image");
			const clip = assets.find((asset) => asset.kind === "video" && (asset.duration ?? 0) >= dur);
			if (clip) added.push({ op: "insert", author: "claude", track: "main", t: round3(cursor), media: clip.id, media_kind: "video", in: 0, out: dur, name: clip.name } as Op);
			else if (still) added.push({ op: "insert", author: "claude", track: "main", t: round3(cursor), media: still.id, media_kind: "image", dur, name: still.name } as Op);
		}
		if (pick.line && textStyle) {
			added.push({ op: "text_pop", author: "claude", t: round3(cursor + 0.25), text: pick.line, dur: round3(Math.max(0.6, dur - 0.45)), track: "explainer-text", style: textStyle } as Op);
		}
		const beat: ExplainerBeat = { index: 0, kind: "footage", start: round3(cursor), end: round3(cursor + dur), line: pick.line, visual: pick.entry.title ?? pick.entry.name, effects: [pick.effect] };
		plan.beats.splice(plan.beats.length - 1, 0, beat);
		plan.report.effects.push(`${pick.effect} (${pick.entry.name})`);
		cursor += dur;
	});
	plan.beats.forEach((beat, index) => {
		beat.index = index;
	});
	plan.ops.push(...added);
	plan.duration = round3(plan.duration + shift);
	if (!loose.some((op) => op.op === "add_track" && op.ref === "explainer-motion")) {
		plan.ops.splice(2, 0, { op: "add_track", author: "claude", kind: "video", name: "MOTION", index: 0, ref: "explainer-motion" } as Op);
	}
	const names = picks.map((pick) => pick.entry.name);
	// the plan's "FX-61 …, FX-57 …, FX-56 …: not built yet" line, said again for what is still missing
	const kitLine: Array<[string, string, string]> = [
		["FX-61", "parallax-strip", "FX-61 parallax strip"],
		["FX-57", "triptych", "FX-57 triptych panels"],
		["FX-56", "halftone-push", "FX-56 halftone push-in"],
	];
	const inLibrary = new Set(entries.map((entry) => entry.name));
	const notBuilt = kitLine.filter(([, name]) => !inLibrary.has(name)).map(([, , words]) => words);
	const unused = kitLine.filter(([, name]) => inLibrary.has(name) && !names.includes(name)).map(([, , words]) => words);
	plan.report.missing = plan.report.missing.flatMap((line) => {
		if (!/^FX-61 parallax strip, FX-57/.test(line)) return [line];
		return [...(notBuilt.length ? [`${notBuilt.join(", ")}: not built yet`] : []), ...(unused.length ? [`${unused.join(", ")}: in the library, not used this time (at most ${MAX_EXTRAS} extra beats)`] : [])];
	});
	plan.report.notes.push(`collage-fx compositions slotted in before the stamp: ${names.join(", ")}`);
	return names;
}

const FEEL_EASE: Record<string, string> = { playful: "bouncy", nostalgic: "gentle", serious: "smooth", punchy: "snappy" };
/**
 * paper-texture is incompressible grain: at the full 1920×1080 canvas a 4 s render passed the service's 240 s cap
 * (2026-10-20 17:0x); at half size a 2 s render takes ~7 s. It renders at half the canvas and loops every 2 s (the
 * editor scales a clip to the canvas).
 */
const PAPER_LOOP_S = 2;

export interface KitPiece {
	request: CompositionRequest;
	/** Render size; null = the canvas. */
	size: { width: number; height: number } | null;
	/** Put the piece into the plan: called only after its render succeeded. */
	apply: () => void;
}

/** Which paper-texture `kind` tints like the card's paper colour. */
function paperKind(hex: string): string {
	const n = Number.parseInt(hex.replace("#", ""), 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const light = (max + min) / 510;
	const sat = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
	if (light > 0.8) return "cream";
	if (sat > 0.45 && r > b) return "mustard";
	if (r > b && light < 0.55) return "kraft";
	return "old";
}

/**
 * The collage kit collage-fx shipped (2026-10-20 ~14:00) that the plan (packages/styles) does not use yet, as pieces
 * that are rendered FIRST and put into the plan only when their render succeeded (a failed one leaves the plan as it
 * was — 2026-10-20: v4 lost its cut-out still when cutout-outline was refused after the plain slide had been removed):
 *   cutout-outline (FX-52)  each plain sliding still becomes a paper cut-out with the red outline, a torn edge and a
 *                           shadow; the piece is the timeline's own still as a ≤ 720 px data: URL (`stills`), because the
 *                           service refuses server paths in image params
 *   paper-texture (FX-53)   an overlay of fibres, grain and a vignette over the whole explainer on its own PAPER track,
 *                           above MOTION / CUT-OUTS and under the lines and tags; a 2 s half-size render, looped
 */
export function planCollageKit(plan: ExplainerPlan, entries: CatalogueEntry[], card: StyleCard, answers: Pick<ExplainerAnswers, "feel">, stills: (mediaId: string) => string | null, canvas: { width: number; height: number }): KitPiece[] {
	const loose = plan.ops as unknown as Array<Record<string, unknown>>;
	const names = new Set(entries.map((entry) => entry.name));
	const colors = collageColors(card);
	const ease = FEEL_EASE[answers.feel ?? "playful"] ?? "bouncy";
	const speed = { playful: 1, nostalgic: 0.85, serious: 0.9, punchy: 1.2 }[answers.feel ?? "playful"] ?? 1;
	const pieces: KitPiece[] = [];
	const ensureMotionTrack = () => {
		if (!loose.some((op) => op.op === "add_track" && op.ref === "explainer-motion")) {
			plan.ops.splice(2, 0, { op: "add_track", author: "claude", kind: "video", name: "MOTION", index: 0, ref: "explainer-motion" } as Op);
		}
	};
	const note = (name: string) => {
		const line = `collage-fx pieces used: `;
		const at = plan.report.notes.findIndex((candidate) => candidate.startsWith(line));
		if (at < 0) plan.report.notes.push(`${line}${name}`);
		else if (!(plan.report.notes[at] as string).includes(name)) plan.report.notes[at] = `${plan.report.notes[at]}, ${name}`;
	};

	if (names.has("cutout-outline")) {
		const cutouts = loose.filter((op) => op.op === "insert" && op.track === "explainer-cutouts" && typeof op.name === "string" && op.name.startsWith("cut-out · "));
		for (const op of cutouts) {
			const image = typeof op.media === "string" ? stills(op.media) : null;
			if (!image || typeof op.t !== "number" || typeof op.dur !== "number") continue;
			const t = op.t;
			const dur = op.dur;
			const beat = plan.beats.find((candidate) => Math.abs(candidate.start - t) < 0.01);
			const index = beat?.index ?? 0;
			const key = `beat${index + 1}-cutout-outline`;
			const left = index % 2 === 0;
			const request: CompositionRequest = {
				key,
				name: "cutout-outline",
				title: "Cut-out with outline",
				props: {
					pieces: [{ image, x: left ? 0.42 : 0.58, y: 0.46, width: canvas.width > canvas.height ? 0.42 : 0.62, rotate: left ? -4 : 3, at: 0.1, from: left ? "left" : "right", depth: 0.5 }],
					outline: colors.red,
					outlineWidth: 10,
					tear: 0.15,
					shadow: 0.35,
					ease,
					speed,
				},
				at: t,
				dur,
				placeholder: `${COMPOSITION_PLACEHOLDER_PREFIX}${key}`,
				beat: index,
			};
			pieces.push({
				request,
				size: null,
				apply: () => {
					const ref = op.ref;
					for (let i = loose.length - 1; i >= 0; i--) {
						const candidate = loose[i] as Record<string, unknown>;
						if (candidate === op || (candidate.op === "keyframe" && candidate.el === ref)) plan.ops.splice(i, 1);
					}
					plan.compositions.push(request);
					ensureMotionTrack();
					plan.ops.push({ op: "insert", author: "claude", track: "explainer-motion", t, media: request.placeholder, media_kind: "video", dur, name: request.title, ref: `explainer-${key}` } as Op);
					if (beat) beat.effects = beat.effects.map((effect) => (effect.startsWith("FX-52") ? "FX-52 cut-out with red outline (cutout-outline)" : effect));
					if (!loose.some((candidate) => candidate.op !== "add_track" && candidate.track === "explainer-cutouts")) {
						const at = loose.findIndex((candidate) => candidate.op === "add_track" && candidate.ref === "explainer-cutouts");
						if (at >= 0) plan.ops.splice(at, 1);
					}
					plan.report.effects = plan.report.effects.map((effect) => (effect.startsWith("FX-52") ? "FX-52 paper cut-out with red outline, torn edge + shadow (cutout-outline)" : effect));
					plan.report.missing = plan.report.missing.filter((line) => !line.startsWith("FX-52"));
					note("cutout-outline");
				},
			});
		}
	}

	const first = plan.beats[0];
	if (names.has("paper-texture") && first && plan.duration > 0.5) {
		const start = first.start;
		const end = round3(start + plan.duration);
		const key = "paper-texture";
		const grain = card.texture.label;
		const request: CompositionRequest = {
			key,
			name: "paper-texture",
			title: "Paper texture",
			props: { mode: "overlay", kind: paperKind(colors.paper), amount: grain.startsWith("heavy") ? 0.75 : grain === "fine grain" || grain.startsWith("textured") ? 0.55 : 0.45, vignette: 0.3, flickerFps: 8 },
			at: start,
			dur: PAPER_LOOP_S,
			placeholder: `${COMPOSITION_PLACEHOLDER_PREFIX}${key}`,
			beat: 0,
		};
		const half = (n: number) => Math.max(2, Math.round(n / 4) * 2);
		pieces.push({
			request,
			size: { width: half(canvas.width), height: half(canvas.height) },
			apply: () => {
				plan.compositions.push(request);
				// PAPER goes in right after the picture tracks are added (MOTION / CUT-OUTS; v2: SCRAPS, MOTION, STAMPS): it
				// ends up above them, under TAGS / TEXT
				let at = -1;
				loose.forEach((op, i) => {
					if (op.op === "add_track" && typeof op.ref === "string" && ["explainer-motion", "explainer-cutouts", "explainer-stamps", "explainer-scraps"].includes(op.ref)) at = Math.max(at, i);
				});
				if (at < 0) at = Math.max(0, loose.findIndex((op) => op.op === "add_track"));
				plan.ops.splice(at + 1, 0, { op: "add_track", author: "claude", kind: "video", name: "PAPER", index: 0, ref: "explainer-paper" } as Op);
				let n = 0;
				for (let t = start; t < end - 0.05; t += PAPER_LOOP_S) {
					const dur = round3(Math.min(PAPER_LOOP_S, end - t));
					plan.ops.push({ op: "insert", author: "claude", track: "explainer-paper", t: round3(t), media: request.placeholder, media_kind: "video", dur, name: request.title, ref: n === 0 ? `explainer-${key}` : `explainer-${key}-loop${n}` } as Op);
					n++;
				}
				plan.report.effects.push("FX-53 paper texture overlay (paper-texture)");
				plan.report.missing = plan.report.missing.filter((line) => !line.startsWith("FX-53"));
				note("paper-texture");
			},
		});
	}
	return pieces;
}

// ─── version summary + "What's new" ─────────────────────────────────────────────────────────────────────────────

function sortedJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortedJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([key]) => key !== "author")
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, inner]) => [key, sortedJson(inner)]),
		);
	}
	if (typeof value === "number") return Math.round(value * 100) / 100;
	return value;
}

function opSignature(op: Op): string {
	return JSON.stringify(sortedJson(op));
}

function summarize(plan: ExplainerPlan, topic: string, answers: Record<string, unknown>, canvas: { width: number; height: number }, start: number, assets: ExplainerAsset[], rendered: Set<string>): VersionSummary {
	return {
		topic,
		answers,
		canvas,
		duration: plan.duration,
		start,
		beats: plan.beats.map((beat) => {
			// v2: the beat's tag and pictures, so "What's new" can say a line moved to another picture
			const bound = (plan as Partial<ExplainerPlanV2>).binding?.[beat.index];
			return { index: beat.index, kind: beat.kind, start: beat.start, end: beat.end, line: beat.line, visual: beat.visual, ...(bound ? { tag: bound.tag, pictures: bound.pictures.map((p) => p.name) } : {}) };
		}),
		compositions: plan.compositions.map((request) => ({ key: request.key, name: request.name, props: request.props, rendered: rendered.has(request.key) })),
		effects: plan.report.effects,
		assets: assets.map((asset) => asset.id),
		op_signatures: plan.ops.map(opSignature),
	};
}

const fmt = (value: unknown) => {
	if (value === undefined || value === null || value === "") return "—";
	if (typeof value === "string" && value.startsWith("data:")) return "(a still)";
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > 48 ? `${text.slice(0, 45)}…` : text;
};

const beatWords = (beat: VersionSummary["beats"][number]) => `${beat.visual || beat.kind}${beat.line ? ` ("${beat.line.length > 40 ? `${beat.line.slice(0, 37)}…` : beat.line}")` : ""}`;

type BeatSummary = VersionSummary["beats"][number];

/** Pair the beats of two versions by kind (longest common subsequence), so one beat taken out reads as one removal. */
function alignBeats(a: BeatSummary[], b: BeatSummary[]): Array<[BeatSummary | null, BeatSummary | null]> {
	const width = b.length + 1;
	const dp = new Array<number>((a.length + 1) * width).fill(0);
	const at = (i: number, j: number) => dp[i * width + j] ?? 0;
	const kindA = (i: number) => (a[i] as BeatSummary).kind;
	const kindB = (j: number) => (b[j] as BeatSummary).kind;
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			dp[i * width + j] = kindA(i) === kindB(j) ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
		}
	}
	const out: Array<[BeatSummary | null, BeatSummary | null]> = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (kindA(i) === kindB(j)) out.push([a[i++] as BeatSummary, b[j++] as BeatSummary]);
		else if (at(i + 1, j) >= at(i, j + 1)) out.push([a[i++] as BeatSummary, null]);
		else out.push([null, b[j++] as BeatSummary]);
	}
	while (i < a.length) out.push([a[i++] as BeatSummary, null]);
	while (j < b.length) out.push([null, b[j++] as BeatSummary]);
	return out;
}

function opName(signature: string): string {
	return /"op":"([a-z_]+)"/.exec(signature)?.[1] ?? "?";
}

/** The ops diff summarised: how many plan ops are new, gone or the same, by op type. */
function opsDiff(prev: string[], next: string[]): { line: string; added: number; removed: number; same: number } {
	const left = new Map<string, number>();
	for (const sig of prev) left.set(sig, (left.get(sig) ?? 0) + 1);
	const added: string[] = [];
	let same = 0;
	for (const sig of next) {
		const count = left.get(sig) ?? 0;
		if (count > 0) {
			left.set(sig, count - 1);
			same++;
		} else added.push(sig);
	}
	const removed: string[] = [];
	for (const [sig, count] of left) for (let i = 0; i < count; i++) removed.push(sig);
	const byType = (sigs: string[]) => {
		const counts = new Map<string, number>();
		for (const sig of sigs) counts.set(opName(sig), (counts.get(opName(sig)) ?? 0) + 1);
		return [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(", ");
	};
	const parts = [`${next.length} plan ops (was ${prev.length}): ${added.length} new, ${removed.length} gone, ${same} unchanged`];
	if (added.length) parts.push(`new: ${byType(added)}`);
	if (removed.length) parts.push(`gone: ${byType(removed)}`);
	return { line: `Ops: ${parts.join("; ")}`, added: added.length, removed: removed.length, same };
}

/** "What's new in vN": answers, canvas, length, beats, compositions (props), effects, footage, then the ops diff. */
export function whatsNew(prev: VersionSummary, next: VersionSummary): string[] {
	const lines: string[] = [];
	const labels: Record<string, string> = { footage: "Footage", format: "Format", feel: "Feel", type: "Lettering", beats: "Script lines", narration: "Narration", title: "Title", length_s: "Length asked (s)", places: "Map stops", dates: "Timeline dates", number: "Number tiles", verdict: "Stamp" };
	for (const [key, label] of Object.entries(labels)) {
		const a = prev.answers[key];
		const b = next.answers[key];
		if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) lines.push(`${label}: ${fmt(a)} → ${fmt(b)}`);
	}
	if (prev.topic !== next.topic) lines.push(`Topic: "${prev.topic}" → "${next.topic}"`);
	if (prev.canvas.width !== next.canvas.width || prev.canvas.height !== next.canvas.height) {
		lines.push(`Canvas: ${prev.canvas.width}×${prev.canvas.height} → ${next.canvas.width}×${next.canvas.height}`);
	}
	if (Math.abs(prev.duration - next.duration) >= 0.05) lines.push(`Length: ${prev.duration} s → ${next.duration} s`);
	for (const [a, b] of alignBeats(prev.beats, next.beats)) {
		if (!a && b) lines.push(`Beat ${b.index + 1} added: ${beatWords(b)}`);
		else if (a && !b) lines.push(`Beat ${a.index + 1} of the last version removed: ${beatWords(a)}`);
		else if (a && b && (a.visual !== b.visual || a.line !== b.line)) lines.push(`Beat ${b.index + 1}: ${beatWords(a)} → ${beatWords(b)}`);
		if (a && b && (a.tag ?? "") !== (b.tag ?? "") && (a.tag !== undefined || b.tag !== undefined)) lines.push(`Beat ${b.index + 1} tag: ${fmt(a.tag)} → ${fmt(b.tag)}`);
	}
	// only what is on the timeline counts: a composition that did not render is not part of that version
	const prevPlaced = prev.compositions.filter((c) => c.rendered);
	const nextPlaced = next.compositions.filter((c) => c.rendered);
	const prevNames = prevPlaced.map((c) => c.name);
	const nextNames = nextPlaced.map((c) => c.name);
	const addedNames = nextNames.filter((name) => !prevNames.includes(name));
	const goneNames = prevNames.filter((name) => !nextNames.includes(name));
	if (addedNames.length) lines.push(`Compositions added: ${[...new Set(addedNames)].join(", ")}`);
	if (goneNames.length) lines.push(`Compositions removed: ${[...new Set(goneNames)].join(", ")}`);
	for (const b of nextPlaced) {
		const a = prevPlaced.find((candidate) => candidate.name === b.name && candidate.key.replace(/^beat\d+-|^extra\d+-/, "") === b.key.replace(/^beat\d+-|^extra\d+-/, ""));
		if (!a) continue;
		const keys = [...new Set([...Object.keys(a.props), ...Object.keys(b.props)])];
		const changed = keys.filter((key) => JSON.stringify(sortedJson(a.props[key])) !== JSON.stringify(sortedJson(b.props[key])));
		if (changed.length) {
			const shown = changed.slice(0, 4).map((key) => `${key} ${fmt(a.props[key])} → ${fmt(b.props[key])}`);
			lines.push(`${b.name}: ${shown.join(", ")}${changed.length > 4 ? ` (+${changed.length - 4} more)` : ""}`);
		}
	}
	const effectsAdded = next.effects.filter((effect) => !prev.effects.includes(effect));
	const effectsGone = prev.effects.filter((effect) => !next.effects.includes(effect));
	if (effectsAdded.length) lines.push(`Effects added: ${effectsAdded.join("; ")}`);
	if (effectsGone.length) lines.push(`Effects removed: ${effectsGone.join("; ")}`);
	if (JSON.stringify(prev.assets) !== JSON.stringify(next.assets)) lines.push(`Footage picked: ${prev.assets.length} → ${next.assets.length} media`);
	if (!lines.length) lines.push("Same answers and the same plan: rebuilt on the current head (anything changed by hand in the explainer was replaced)");
	lines.push(opsDiff(prev.op_signatures, next.op_signatures).line);
	return lines;
}

// ─── the build ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface BuildInput {
	timelineId: string;
	branch?: string;
	baseCommit?: string;
	answers: ExplainerAnswersV2;
	topic?: string;
	assets?: AssetSpec[];
	message?: string;
	actor: Actor;
	signal?: AbortSignal;
	/** Epoch ms by which every render must be done (the MCP call's budget minus time to place + commit). */
	deadline?: number;
}

export type BuildOutcome =
	| { ok: false; code: string; message: string; extra?: Record<string, unknown> }
	| {
			ok: true;
			version: ExplainerVersion;
			whats_new: string[];
			plan: ExplainerPlanV2;
			answers: Record<string, unknown>;
			renders: Array<{ key: string; name: string; t: number; dur: number; cached: boolean | null; ms: number | null; error?: string }>;
			replaced: { version: number; elements: number; tracks: number } | null;
			extras: string[];
			assets: ExplainerAsset[];
			warnings: string[];
			stats: unknown;
	  };

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i] as T);
			}
		}),
	);
	return out;
}

/** Fill unanswered questions with the card's suggestions (what the Styles tab pre-selects). */
export function answersWithDefaults<T extends Pick<ExplainerAnswers, "footage" | "format" | "feel">>(card: StyleCard, answers: T): T {
	const suggested = (id: string) => card.questions.find((question) => question.id === id)?.suggested;
	return {
		...answers,
		footage: answers.footage ?? (suggested("footage") as ExplainerAnswers["footage"]),
		format: answers.format ?? (suggested("format") as ExplainerAnswers["format"]),
		feel: answers.feel ?? (suggested("feel") as ExplainerAnswers["feel"]),
	};
}

/** String (display text) params a request leaves unset are set to "" (hidden): no example text leaks (explainer-v2;
 * recreation: parallax-strip's "every morning", halftone-push's default vinyl label). Returns the keys it blanked. */
export function blankDisplayDefaults(props: Record<string, unknown>, params: Record<string, ParamSpec> | undefined): string[] {
	const blanked: string[] = [];
	for (const [key, spec] of Object.entries(params ?? {})) {
		if (spec.type !== "string" || Object.hasOwn(props, key)) continue;
		props[key] = "";
		blanked.push(key);
	}
	return blanked;
}

export async function buildExplainerVersion(set: ReferenceSet, card: StyleCard, input: BuildInput): Promise<BuildOutcome> {
	const { timelineId } = input;
	const head = await getProjectHead(timelineId, input.branch);
	if (!head.snapshot) return { ok: false, code: "no_snapshot", message: "This timeline has no snapshot to build on." };
	const headId = head.head.id;
	if (input.baseCommit && input.baseCommit !== headId && !(input.baseCommit.length >= 7 && headId.startsWith(input.baseCommit))) {
		return { ok: false, code: "conflict", message: `The timeline moved on: its head is ${headId}, not ${input.baseCommit}. Nothing was built.`, extra: { head: headId } };
	}
	const n = set.versions.reduce((max, version) => Math.max(max, version.n), 0) + 1;
	const previous = [...set.versions].reverse().find((version) => version.branch === head.branch) ?? null;
	const warnings: string[] = [];
	const at = new Date().toISOString();

	// 1. take the previous version out (what is still there of it)
	const removal: Op[] = [];
	let replaced: { version: number; elements: number; tracks: number } | null = null;
	if (previous) {
		const scene = activeScene(head.snapshot);
		const tracks = tracksOf(scene);
		const mainId = scene?.tracks?.main?.id;
		const owned = new Set(previous.element_ids);
		const removedTracks = tracks.filter((track) => track.id !== mainId && previous.track_ids.includes(track.id) && (track.elements ?? []).every((element) => owned.has(element.id)));
		const onRemoved = new Set(removedTracks.flatMap((track) => (track.elements ?? []).map((element) => element.id)));
		const elements = tracks.flatMap((track) => (track.elements ?? []).filter((element) => owned.has(element.id) && !onRemoved.has(element.id)));
		for (const element of elements) removal.push({ op: "delete", author: "claude", el: element.id } as Op);
		for (const track of removedTracks) removal.push({ op: "remove_track", author: "claude", track: track.id } as Op);
		replaced = { version: previous.n, elements: elements.length + onRemoved.size, tracks: removedTracks.length };
		const kept = previous.track_ids.filter((id) => tracks.some((track) => track.id === id) && !removedTracks.some((track) => track.id === id));
		if (kept.length) warnings.push(`v${previous.n}'s track(s) ${kept.join(", ")} were kept: something not made by the explainer is on them`);
	}
	let base = head.snapshot;
	if (removal.length) {
		const out = apply(head.snapshot as unknown as OpsProject, removal, { seed: `${timelineId}/${headId}/explainer-v${n}/out` });
		if (!out.ok) return { ok: false, code: "ops_conflict", message: `Taking v${previous?.n} out was refused by the reducer. Nothing was committed.`, extra: { conflicts: out.conflicts.slice(0, 10) } };
		base = out.project as unknown as ProjectSnapshot;
	}

	// 2. the plan
	const exclude = new Set(previous?.media_ids ?? []);
	const { assets, unknown } = resolveAssets(base, input.assets, exclude);
	if (unknown.length) warnings.push(`not on this timeline (media list shows what is), left out: ${unknown.join(", ")}`);
	const answers = answersWithDefaults(card, { ...input.answers, ...(input.topic ? { topic: input.topic } : {}) });
	const library = await catalogue();
	if (!library) warnings.push("the composition library could not be read: the plan assumes the starter collage pieces");
	const start = mainTrackEnd(base);
	const current = canvasOf(base);
	// the pictures the server holds (stills for compositions, alpha for cut-out heroes)
	const serverMedia = await listProjectMedia(timelineId).catch(() => []);
	const fileOf = (mediaId: string) => {
		const media = serverMedia.find((item) => item.media_id === mediaId);
		if (!media) return null;
		const file = path.join(resolveMediaDir(), media.hash.slice(0, 2), media.hash);
		return existsSync(file) ? { file, media } : null;
	};
	// per picture: alpha (a cut-out PNG becomes a hero cut-out, never full frame) and its average colour (the plan picks
	// the paper ground that differs most from it, so the cut to the next paper shot is visible)
	for (const asset of assets) {
		if (asset.kind !== "image" && asset.kind !== "video") continue;
		const found = fileOf(asset.id);
		if (!found) continue;
		if (asset.kind === "image" && /png|webp|gif/.test(found.media.mime)) asset.alpha = await hasAlpha(found.file, input.signal);
		const tone = await toneOf(found.file, asset.kind === "video" ? Math.min(2, Math.max(0.2, (asset.duration ?? 2) * 0.4)) : undefined, input.signal);
		if (tone) asset.tone = tone;
	}
	// explainer-v2 (2026-10-20): beats bound to pictures by subject, shots at the feel's pace, the collage kit by name
	const plan: ExplainerPlanV2 = explainerPlanV2(card, answers, assets, {
		start,
		canvas: { width: current.width, height: current.height },
		...(library ? { available: library.map((entry) => entry.name) } : {}),
		author: "claude",
	});
	const target = plan.canvas ?? { width: current.width, height: current.height };
	// the stills the compositions need, as ≤ 720 px data: URLs (the compositions service refuses server paths in image
	// params); a clip gives a frame at 40 % of its length (≤ 2 s in)
	const stills = new Map<string, string>();
	for (const id of plan.stills) {
		const found = fileOf(id);
		if (!found) continue;
		const asset = assets.find((item) => item.id === id);
		const video = found.media.mime.startsWith("video/");
		const at = video ? Math.min(2, Math.max(0.2, (asset?.duration ?? 2) * 0.4)) : undefined;
		const url = await stillDataUrl(found.file, found.media.hash, !video && /png|webp|gif/.test(found.media.mime), input.signal, at).catch(() => null);
		if (url) stills.set(id, url);
	}
	const unresolvedStills = new Map<string, string[]>();
	for (const request of plan.compositions) {
		const { value, unresolved } = resolveStills(request.props, (id) => stills.get(id) ?? null);
		request.props = value as Record<string, unknown>;
		if (unresolved.length) unresolvedStills.set(request.key, unresolved);
	}
	const extras: string[] = [];
	// the paper overlay over everything (its cut-out part finds no plain cut-outs in a v2 plan)
	const kit: KitPiece[] = library ? planCollageKit(plan, library, card, answers, (id) => stills.get(id) ?? null, target) : [];
	// props a composition does not declare would make the render refuse it (2026-10-20: the plan sent `ease` to
	// thread-timeline): drop them here and say so; display text left unset is blanked (no example text leaks)
	const jobs = [...plan.compositions.map((request) => ({ request, size: request.size ?? (null as KitPiece["size"]), piece: null as KitPiece | null })), ...kit.map((piece) => ({ request: piece.request, size: piece.size, piece }))];
	if (library) {
		const blankedBy = new Map<string, string[]>();
		for (const { request } of jobs) {
			const params = library.find((entry) => entry.name === request.name)?.params;
			if (!params) continue;
			for (const key of blankDisplayDefaults(request.props, params)) blankedBy.set(`${request.name}.${key}`, [...(blankedBy.get(`${request.name}.${key}`) ?? []), request.key]);
			const unknownKeys = Object.keys(request.props).filter((key) => !Object.hasOwn(params, key));
			if (!unknownKeys.length) continue;
			for (const key of unknownKeys) delete request.props[key];
			warnings.push(`${request.name}: dropped prop(s) it does not have: ${unknownKeys.join(", ")}`);
		}
		if (blankedBy.size) plan.report.notes.push(`display text the plan did not set was blanked (no example text): ${[...blankedBy.keys()].join(", ")}`);
	}

	// 3. render every composition (cached by input hash), all of them inside the call's deadline: a render that is not
	//    done by then is left out (it keeps going in its own process and is cached for the next build)
	const deadline = input.deadline ?? Date.now() + 150_000;
	const renders = await pool(jobs, 4, async ({ request, size, piece }) => {
		const left = deadline - Date.now();
		const missingStills = unresolvedStills.get(request.key);
		if (missingStills) return { request, piece, answer: null, error: `picture(s) not in the server's media store (media import them): ${missingStills.join(", ")}` };
		if (left <= 1000 || input.signal?.aborted) return { request, piece, answer: null, error: "not started: no time left in this call (build again; finished renders are cached)" };
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const answer = await Promise.race([
				callService<RenderAnswer>({
					verb: "render",
					request: { name: request.name, props: request.props, width: size?.width ?? target.width, height: size?.height ?? target.height, fps: current.fps, duration: request.dur },
				}),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`not done within this call's time (${Math.round(left / 1000)} s left when it started): build again, it is cached once finished`)), left);
				}),
			]);
			return { request, piece, answer, error: null as string | null };
		} catch (error) {
			return { request, piece, answer: null, error: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	});
	// collage-kit pieces go into the plan only now, and only the ones that rendered
	for (const { piece, answer, error, request } of renders) {
		if (!piece) continue;
		if (answer) {
			piece.apply();
			extras.push(request.name);
		} else warnings.push(`${request.name} (${request.key}) did not render, the plan keeps what it had: ${String(error).slice(0, 200)}`);
	}
	// effects of plan compositions that did not render are not in this version (the beat keeps its footage)
	for (const { piece, answer, request } of renders) {
		if (piece || answer) continue;
		const effect = COLLAGE_COMPOSITIONS[request.name]?.effect;
		if (!renders.some((other) => other.answer && other.request.name === request.name)) {
			plan.report.effects = plan.report.effects.filter((candidate) => candidate !== effect && !candidate.endsWith(`(${request.name})`));
		}
		// v2: say which shot lost its piece (the shot keeps its photo or paper ground; a paper ground that failed falls
		// back to the beat's picture)
		const shot = plan.shots.find((candidate) => candidate.pieces.includes(request.key) || candidate.overlays.includes(request.key));
		if (shot) warnings.push(`beat ${shot.beat + 1} shot ${shot.index + 1} (${shot.kind}): ${request.name} did not render — the shot shows its ${shot.main === "picture" ? "photo" : "paper ground"} only`);
		const beat = plan.beats[shot?.beat ?? -1];
		if (beat) beat.effects = beat.effects.filter((candidate) => !candidate.includes(`(${request.name})`) || renders.some((other) => other.answer && other.request.name === request.name && other.request.beat === beat.index));
	}
	if (input.signal?.aborted) return { ok: false, code: "cancelled", message: "The call was cancelled (out of time) before committing. Nothing was committed; build again — finished renders are cached." };
	const imports: Op[] = [];
	const bound: Record<string, BoundComposition | null> = {};
	for (const { request, answer } of renders) {
		if (!answer) {
			bound[request.key] = null;
			continue;
		}
		const ref = `explainer-media-${request.key}`;
		imports.push({
			op: "import_media",
			author: "claude",
			kind: "video",
			name: `${request.title} · explainer`,
			url: `/api/compositions/file/${answer.hash}`,
			duration: answer.duration,
			width: answer.width,
			height: answer.height,
			fps: answer.fps,
			has_audio: false,
			ref,
		} as Op);
		bound[request.key] = { media: ref, dur: answer.duration };
	}
	const { ops: placed, dropped } = bindCompositions(plan, bound);
	if (dropped.length) warnings.push(`left out (did not render): ${dropped.join(", ")}`);

	// 4. one batch on the head → one commit
	const ops = [...removal, ...imports, ...placed];
	const result = apply(head.snapshot as unknown as OpsProject, ops, { seed: `${timelineId}/${headId}/explainer-v${n}`, at });
	if (!result.ok) {
		return { ok: false, code: "ops_conflict", message: "The timeline reducer refused the explainer batch. Nothing was committed.", extra: { conflicts: result.conflicts.slice(0, 10) } };
	}
	const snapshot = result.project as unknown as ProjectSnapshot;
	const refs = result.changes.refs;
	const mediaIds: string[] = [];
	for (const { request, answer } of renders) {
		if (!answer) continue;
		const mediaId = refs[`explainer-media-${request.key}`];
		// the clip(s) playing it: one, or a loop (paper-texture) — each carries its composition so the editor can re-make it
		const base = `explainer-${request.key}`;
		for (const [ref, elementId] of Object.entries(refs)) {
			if (ref !== base && !ref.startsWith(`${base}-loop`)) continue;
			const element = findElement(snapshot, elementId);
			if (!element) continue;
			element.restorff = {
				...(element.restorff ?? {}),
				composition: { name: request.name, props: request.props, hash: answer.hash, width: answer.width, height: answer.height, fps: answer.fps, duration: answer.duration },
			} as SnapshotElement["restorff"];
		}
		if (!mediaId) continue;
		mediaIds.push(mediaId);
		const bytes = await readFile(answer.file);
		const meta = { name: `${request.title} · explainer v${n}.webm`, type: "video", width: answer.width, height: answer.height, duration: answer.duration, fps: answer.fps, hasAudio: false, size: bytes.byteLength, lastModified: Date.now() };
		await putProjectMedia(
			timelineId,
			mediaId,
			new Request("http://restorffcut.internal/media", {
				method: "PUT",
				body: new Uint8Array(bytes),
				headers: { "content-type": "video/webm", "x-media-meta": Buffer.from(JSON.stringify(meta), "utf8").toString("base64url") },
			}),
		);
	}

	// what this version made (apply_style's own expansion — the GRADE layer, caption style — is the style's, not ours)
	const elementIds: string[] = [];
	const trackIds: string[] = [];
	for (const change of result.changes.ops) {
		if (change.index.includes(".") || change.status !== "applied") continue;
		elementIds.push(...(change.created?.elements ?? []));
		trackIds.push(...(change.created?.tracks ?? []));
	}

	const rendered = new Set(renders.filter((item) => item.answer).map((item) => item.request.key));
	const answersRecord = { ...answers } as Record<string, unknown>;
	delete answersRecord.topic;
	const topic = (answers.topic ?? "").trim() || "How the farm-to-bottle route works";
	const summary = summarize(plan, topic, answersRecord, target, start, assets, rendered);
	const news = previous ? whatsNew(previous.summary, summary) : [];
	const look = `Look (style card): ${card.mood.label}, ${card.pacing.label} pacing${card.pacing.avgShot ? ` (${card.pacing.avgShot} s shots)` : ""}, ${card.texture.label}; palette ${card.palette.slice(0, 5).map((color) => color.hex).join(" ")}.`;
	const answerLine = `Answers: footage ${answers.footage ?? "—"} · format ${answers.format ?? "—"} · feel ${answers.feel ?? "—"}${answers.type ? ` · lettering ${answers.type}` : ""}.`;
	const head1 = `explainer v${n} — ${topic}`;
	const pacingLine = `Pacing (${plan.pacing.feel}): ${plan.shots.length} shots in ${plan.pacing.length_s} s = ${plan.pacing.planned_cuts_per_10s} cuts per 10 s (target ${plan.pacing.target_cuts_per_10s})${plan.pacing.asked_length_s ? `, length asked ${plan.pacing.asked_length_s} s` : ""}.`;
	const unmatched = plan.binding.filter((beat) => beat.unmatched).map((beat) => beat.index + 1);
	const bindLine = `Lines → pictures: ${plan.binding.length - unmatched.length} of ${plan.binding.length} lines on a picture of their subject${unmatched.length ? `; no picture for beat(s) ${unmatched.join(", ")} (shown on paper)` : ""}.`;
	const body = previous
		? [`What's new in v${n}:`, ...news.map((line) => `- ${line}`), pacingLine, `Replaces v${previous.n} (kept on branch ${previous.version_branch ?? "—"}).`]
		: [describePlan(plan), bindLine, pacingLine, look, answerLine];
	const custom = input.message?.trim();
	const changeNote = [custom ? `${head1} — ${custom}` : head1, ...body].join("\n").slice(0, 1990);

	// a call that ran out of time must not commit behind the client's back (2026-10-20: v4 was committed after the
	// client had been told over_budget)
	if (input.signal?.aborted) return { ok: false, code: "cancelled", message: "The call was cancelled (out of time) before committing. Nothing was committed; build again — finished renders are cached." };
	const pushed = await pushCommit(timelineId, { base_commit: headId, branch: head.branch, author: "claude", snapshot, ops: result.changes.applied, message: changeNote }, input.actor);
	if (!pushed.ok) {
		return { ok: false, code: "conflict", message: "The timeline moved while committing. Nothing was committed.", extra: { head: pushed.conflict.head.id } };
	}
	let versionBranch: string | null = `explainer-v${n}`;
	try {
		await createBranch(timelineId, versionBranch, pushed.commit.id);
	} catch (error) {
		warnings.push(`branch ${versionBranch} not made: ${error instanceof Error ? error.message : String(error)}`);
		versionBranch = null;
	}
	const onServer = new Set((await listProjectMedia(timelineId).catch(() => [])).map((media) => media.media_id));
	const missing = assets.filter((asset) => !onServer.has(asset.id)).map((asset) => asset.id);
	if (missing.length) warnings.push(`footage only in a browser (render needs it in the server's media store): ${missing.join(", ")}`);

	const version: ExplainerVersion = {
		n,
		commit_id: pushed.commit.id,
		branch: pushed.branch,
		version_branch: versionBranch,
		at,
		change_note: changeNote,
		element_ids: elementIds,
		track_ids: trackIds,
		media_ids: mediaIds,
		summary,
	};
	return {
		ok: true,
		version,
		whats_new: news,
		plan,
		answers: answersRecord,
		renders: renders.map(({ request, answer, error }) => ({
			key: request.key,
			name: request.name,
			t: request.at,
			dur: answer ? round3(answer.duration) : request.dur,
			cached: answer?.cached ?? null,
			ms: answer?.ms ?? null,
			...(error ? { error: error.slice(0, 300) } : {}),
		})),
		replaced,
		extras: [...new Set(extras)],
		assets,
		warnings,
		stats: pushed.commit.stats,
	};
}
