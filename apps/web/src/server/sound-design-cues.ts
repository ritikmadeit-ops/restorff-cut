/**
 * Sound cues from inside compositions (sound-voice-v2 agent, 2026-10-20; recreations SUMMARY gap 7, neon-grid G-8):
 * "Design the sound" can see a composition's typing, stamps, ignites and scene cuts, not only its clip edges.
 *
 * Where a composition clip's cues come from, first hit wins:
 *   1. its RENDER — the sidecar `<render>.webm.json` next to the cached render may carry `cues: [{t, kind, label?,
 *      sound?}]`, `t` = real seconds into that rendered file (already resolved for its duration and speed);
 *   2. its MANIFEST — the `<script type="application/json" id="params">` block (a custom clip's stored `source`, else the
 *      library file packages/compositions/compositions/<name>/<name>.html) may carry
 *        "cues": [{ "t": 0.4, "kind": "stamp", "label": "NO SUGAR lands", "sound": "stamp-slam" }]
 *      `t` = seconds of ANIMATION time from the start (CONTRACT §3 `time.t`; real time = t / speed), or `from_end` =
 *      seconds before the clip's end (for exits). `sound` (optional) names a pack sound and wins over the kind's default.
 *      The manifest validator ignores unknown top-level keys, so this field is additive (library-v2 owns the manifests:
 *      the field is documented in docs/restorff/worklog/sound-voice-v2.md "For library-v2").
 *   3. its FRAMES — fallback: the cached render decoded at 64×64 RGBA; a frame whose change from the previous one
 *      (premultiplied luma + coverage) is a local peak well above the clip's own median becomes a cue ("cut" when
 *      ≥ 0.25 of the picture changes, else "accent"; "appear" when the picture was empty before). The library name gives
 *      the kind of the strongest one (stamp → stamp, type-on → type …). Cached in <apps/web>/.data/sound-cues/<hash>.json.
 * It also tells whether a clip is FULL-FRAME (its first frame covers ≥ 90 % of the picture): only then are its edges
 * cuts; a graphic over the video is heard through its cues instead.
 *
 * Server-only (fs + ffmpeg). The planner that uses this is ./sound-design-plan.ts (pure).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Project as OpsProject } from "@restorffcut/timeline-ops";
import { CACHE_DIR, COMPOSITIONS_DIR, CUSTOM_CACHE_DIR } from "@/app/api/compositions/_lib/service";
import type { CueSource, TimelineCue } from "./sound-design-plan";
import { runProgram, ffmpegBin } from "./voice-ffmpeg";

const TICKS = 120_000;
const FRAME_SIZE = 64;
export const CUES_VERSION = 4;

/** A cue as a manifest or a render sidecar writes it. */
export interface CompositionCue {
	t?: number;
	from_end?: number;
	kind: string;
	label?: string;
	sound?: string;
}

interface CompositionTag {
	name?: string;
	title?: string;
	props?: Record<string, unknown>;
	hash?: string;
	duration?: number;
	custom?: boolean;
	source?: string;
}

export interface FrameAnalysis {
	version: number;
	hash: string;
	fps: number;
	frames: number;
	/** Mean alpha of the first / max frame (0–1). */
	coverage_first: number;
	coverage_max: number;
	/** The first frame anything shows (coverage ≥ 0.002), seconds. */
	first_visible: number | null;
	/**
	 * `t` = the frame the change shows on; `settle` = the last frame of that burst of motion (the next frame changes
	 * < 30 % as much): where a slam LANDS (MEASURED 2026-10-20 on the library stamp: appears +0.033 s, lands +0.10 s).
	 */
	events: Array<{ t: number; strength: number; kind: "cut" | "accent" | "appear"; settle?: number }>;
	ms: number;
}

export interface ClipCueReport {
	element: string;
	name: string;
	composition: string;
	source: CueSource | "none";
	cues: number;
	full_frame: boolean | null;
	note?: string;
}

export interface CollectedCues {
	cues: TimelineCue[];
	clips: ClipCueReport[];
	/** element id → whether the clip covers the whole frame (null = unknown). */
	fullFrame: Record<string, boolean | null>;
}

const r3 = (value: number) => Math.round(value * 1000) / 1000;

function cuesDir(): string {
	const configured = process.env.RESTORFFCUT_SOUND_CUES_DIR?.trim();
	return configured ? path.resolve(configured) : path.join(process.cwd(), ".data", "sound-cues");
}

function paramsBlock(html: string): Record<string, unknown> | null {
	const block = /<script[^>]*type=["']application\/json["'][^>]*id=["']params["'][^>]*>([\s\S]*?)<\/script>/i.exec(html) ?? /<script[^>]*id=["']params["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
	if (!block) return null;
	try {
		const parsed = JSON.parse(block[1]) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function validCues(raw: unknown): CompositionCue[] {
	if (!Array.isArray(raw)) return [];
	const out: CompositionCue[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const cue = item as Record<string, unknown>;
		const kind = typeof cue.kind === "string" && cue.kind.trim() ? cue.kind.trim().toLowerCase() : null;
		const t = typeof cue.t === "number" && Number.isFinite(cue.t) && cue.t >= 0 ? cue.t : undefined;
		const fromEnd = typeof cue.from_end === "number" && Number.isFinite(cue.from_end) && cue.from_end >= 0 ? cue.from_end : undefined;
		if (!kind || (t === undefined && fromEnd === undefined)) continue;
		out.push({ kind, ...(t !== undefined ? { t } : {}), ...(fromEnd !== undefined ? { from_end: fromEnd } : {}), ...(typeof cue.label === "string" ? { label: cue.label.slice(0, 60) } : {}), ...(typeof cue.sound === "string" ? { sound: cue.sound } : {}) });
	}
	return out;
}

/** The manifest of a composition clip: its own stored source (custom), else the library file. */
function manifestOf(tag: CompositionTag): Record<string, unknown> | null {
	if (tag.custom && typeof tag.source === "string") return paramsBlock(tag.source);
	const name = tag.name ?? "";
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return null;
	try {
		return paramsBlock(readFileSync(path.join(COMPOSITIONS_DIR, "compositions", name, `${name}.html`), "utf8"));
	} catch {
		return null;
	}
}

export function renderFileOf(tag: CompositionTag): string | null {
	if (!tag.hash || !/^[0-9a-f]{16,128}$/.test(tag.hash)) return null;
	const file = path.join(tag.custom ? CUSTOM_CACHE_DIR : CACHE_DIR, `${tag.hash}.webm`);
	return existsSync(file) ? file : null;
}

function sidecarCues(file: string | null): CompositionCue[] {
	if (!file || !existsSync(`${file}.json`)) return [];
	try {
		return validCues((JSON.parse(readFileSync(`${file}.json`, "utf8")) as { cues?: unknown }).cues);
	} catch {
		return [];
	}
}

/** Decode a render at 64×64 RGBA and find its own picture events (cached by render hash). */
export async function analyseFrames(file: string, hash: string, signal?: AbortSignal): Promise<FrameAnalysis | null> {
	const cacheFile = path.join(cuesDir(), `${hash}.json`);
	try {
		const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as FrameAnalysis;
		if (cached.version === CUES_VERSION) return cached;
	} catch {
		/* not cached yet */
	}
	const began = Date.now();
	let fps = 30;
	try {
		const side = JSON.parse(readFileSync(`${file}.json`, "utf8")) as { fps?: number };
		if (typeof side.fps === "number" && side.fps > 0) fps = side.fps;
	} catch {
		/* default 30 */
	}
	// libvpx-vp9 keeps the alpha plane (the native vp9 decoder drops it)
	const result = await runProgram(
		ffmpegBin(),
		["-hide_banner", "-v", "error", "-c:v", "libvpx-vp9", "-i", file, "-vf", `scale=${FRAME_SIZE}:${FRAME_SIZE}:flags=area,format=rgba`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
		{ signal, timeoutMs: 120_000 },
	).catch(() => null);
	if (!result || result.code !== 0 || !result.stdout.byteLength) return null;
	const px = FRAME_SIZE * FRAME_SIZE;
	const bytes = result.stdout;
	const frames = Math.floor(bytes.byteLength / (px * 4));
	if (frames < 2) return null;
	const luma = new Float32Array(px);
	const alpha = new Float32Array(px);
	const prevL = new Float32Array(px);
	const prevA = new Float32Array(px);
	const diff: number[] = [0];
	const coverage: number[] = [];
	for (let f = 0; f < frames; f++) {
		let cov = 0;
		let d = 0;
		for (let i = 0; i < px; i++) {
			const o = (f * px + i) * 4;
			const a = bytes[o + 3] / 255;
			const l = ((0.299 * bytes[o] + 0.587 * bytes[o + 1] + 0.114 * bytes[o + 2]) / 255) * a;
			luma[i] = l;
			alpha[i] = a;
			cov += a;
			if (f > 0) d += Math.abs(l - prevL[i]) + 0.5 * Math.abs(a - prevA[i]);
		}
		coverage.push(cov / px);
		if (f > 0) diff.push(d / px);
		prevL.set(luma);
		prevA.set(alpha);
	}
	const sorted = [...diff].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
	// A full-frame piece (first frame ≥ 90 % covered) is often a DARK scene whose changes are soft: MEASURED 2026-10-20
	// on the neon-grid recreation's hook-hours (mean luma 0.07), its 3.2 s scene change peaks at d = 0.015 = 6.7× the
	// median and 5× the ±0.5 s neighbourhood, spread over 6 frames. So there: a relative test, and only "cut"s (camera
	// moves make accents noise). A graphic over the video has a transparent ground: an absolute floor works.
	const full = (coverage[0] ?? 0) >= 0.9;
	// a small graphic can only change as much of the frame as it covers (MEASURED: the library stamp covers 4–9 %, its
	// slam changes d ≈ 0.04): its floor scales with its coverage
	const coverageMax = Math.max(...coverage);
	const floor = full ? Math.max(0.008, 6 * median) : Math.max(0.004, 0.15 * coverageMax, 4 * median);
	const localMean = (f: number) => {
		const span = Math.round(0.5 * fps);
		let sum = 0;
		let n = 0;
		for (let g = Math.max(1, f - span); g <= Math.min(frames - 1, f + span); g++) {
			if (Math.abs(g - f) <= 1) continue;
			sum += diff[g];
			n += 1;
		}
		return n ? sum / n : 0;
	};
	const candidates: FrameAnalysis["events"] = [];
	for (let f = 1; f < frames; f++) {
		const d = diff[f];
		if (d < floor) continue;
		let peak = true;
		for (let g = Math.max(1, f - 2); g <= Math.min(frames - 1, f + 2); g++) if (diff[g] > d) peak = false;
		if (!peak) continue;
		if (full && d < 4 * localMean(f)) continue;
		const kind = full ? "cut" : coverage[f - 1] < 0.02 && coverage[f] >= 0.02 ? "appear" : d >= 0.25 ? "cut" : "accent";
		let last = f;
		while (last + 1 < frames && last - f < Math.round(0.4 * fps) && diff[last + 1] >= 0.3 * d) last++;
		candidates.push({ t: r3(f / fps), strength: r3(d), kind, ...(last > f ? { settle: r3(last / fps) } : {}) });
	}
	// ≥ 0.2 s apart, the stronger wins
	const events: FrameAnalysis["events"] = [];
	for (const event of [...candidates].sort((a, b) => b.strength - a.strength)) {
		if (events.some((other) => Math.abs(other.t - event.t) < 0.2)) continue;
		events.push(event);
	}
	events.sort((a, b) => a.t - b.t);
	const analysis: FrameAnalysis = {
		version: CUES_VERSION,
		hash,
		fps,
		frames,
		coverage_first: r3(coverage[0] ?? 0),
		coverage_max: r3(Math.max(...coverage)),
		first_visible: (() => {
			const f = coverage.findIndex((value) => value >= 0.002);
			return f >= 0 ? r3(f / fps) : null;
		})(),
		events: events.slice(0, 12),
		ms: Date.now() - began,
	};
	try {
		mkdirSync(cuesDir(), { recursive: true });
		writeFileSync(cacheFile, JSON.stringify(analysis));
	} catch {
		/* a cache write failure is harmless */
	}
	return analysis;
}

/** Library compositions whose strongest frame event has a known sound (fallback when no cues are declared). */
const NAME_KIND: Array<[RegExp, string]> = [
	[/stamp/, "stamp"],
	[/type-on|prompt|typewriter|terminal|code/, "type"],
	[/strike|underline|doodle|scribble|marker/, "marker"],
	[/paper-cut|cutout|collage|thread|paper-form/, "paper"],
	[/ignite/, "ignite"],
	[/big-word|punch|headline|word-pop|kinetic/, "word"],
	[/counter|checklist|chart/, "tick"],
	[/glitch/, "glitch"],
	[/zoom-through|whip|vertigo|pullback/, "whoosh"],
];

const nameKind = (name: string) => NAME_KIND.find(([re]) => re.test(name))?.[1] ?? null;

type AnyTrack = OpsProject["scenes"][number]["tracks"]["overlay"][number];
type AnyElement = AnyTrack["elements"][number];

/** Every composition clip's cues on the open scene, in timeline seconds. `frames: false` skips the fallback. */
export async function collectCompositionCues(project: OpsProject, { frames = true, signal }: { frames?: boolean; signal?: AbortSignal } = {}): Promise<CollectedCues> {
	const scene = project.scenes.find((candidate) => candidate.id === project.currentSceneId) ?? project.scenes.find((candidate) => candidate.isMain) ?? project.scenes[0];
	const cues: TimelineCue[] = [];
	const clips: ClipCueReport[] = [];
	const fullFrame: Record<string, boolean | null> = {};
	if (!scene) return { cues, clips, fullFrame };
	const tracks = [scene.tracks.main, ...scene.tracks.overlay].filter((track) => track.type === "video") as AnyTrack[];
	for (const track of tracks) {
		for (const element of track.elements as AnyElement[]) {
			const tag = (element as { restorff?: { composition?: CompositionTag } }).restorff?.composition;
			if (!tag || typeof tag !== "object") continue;
			if ((element as { hidden?: boolean }).hidden) continue;
			const start = element.startTime / TICKS;
			const end = (element.startTime + element.duration) / TICKS;
			const rate = (element as { retime?: { rate?: number } }).retime?.rate || 1;
			const trimIn = element.trimStart / TICKS;
			const clipLength = typeof tag.duration === "number" && tag.duration > 0 ? tag.duration : (element.sourceDuration ?? element.duration + element.trimStart + element.trimEnd) / TICKS;
			const name = tag.name ?? "composition";
			const label = tag.title ?? element.name ?? name;
			const toTimeline = (sourceT: number) => start + (sourceT - trimIn) / rate;
			const add = (source: CueSource, list: Array<{ t: number; kind: string; label?: string; sound?: string; strength?: number }>) => {
				let n = 0;
				for (const cue of list) {
					const at = toTimeline(cue.t);
					if (at < start - 1e-6 || at > end - 0.02) continue;
					cues.push({ t: r3(at), kind: cue.kind, label: cue.label ? `${label}: ${cue.label}` : label, source, element: element.id, ...(cue.sound ? { sound: cue.sound } : {}), ...(cue.strength !== undefined ? { strength: cue.strength } : {}) });
					n += 1;
				}
				return n;
			};
			const file = renderFileOf(tag);
			let analysis: FrameAnalysis | null = null;
			if (frames && file && tag.hash) analysis = await analyseFrames(file, tag.hash, signal);
			fullFrame[element.id] = analysis ? analysis.coverage_first >= 0.9 : null;

			// 1. the render's own cues
			const rendered = sidecarCues(file);
			if (rendered.length) {
				const n = add("render", rendered.map((cue) => ({ ...cue, t: cue.t ?? Math.max(0, clipLength - (cue.from_end ?? 0)) })));
				clips.push({ element: element.id, name: label, composition: name, source: "render", cues: n, full_frame: fullFrame[element.id] });
				continue;
			}
			// 2. the manifest's cues (animation time → real time by the clip's speed)
			const manifest = manifestOf(tag);
			const declared = validCues(manifest?.cues);
			if (declared.length) {
				const params = (manifest?.params ?? {}) as Record<string, { default?: unknown }>;
				const speedValue = tag.props?.speed ?? params.speed?.default;
				const speed = typeof speedValue === "number" && speedValue > 0 ? speedValue : 1;
				const n = add(
					"manifest",
					declared.map((cue) => ({ ...cue, t: cue.t !== undefined ? cue.t / speed : Math.max(0, clipLength - (cue.from_end ?? 0)) })),
				);
				clips.push({ element: element.id, name: label, composition: name, source: "manifest", cues: n, full_frame: fullFrame[element.id], ...(speed !== 1 ? { note: `times ÷ speed ${speed}` } : {}) });
				continue;
			}
			// 3. the frames
			const hint = nameKind(name);
			if (analysis && (analysis.events.length || (analysis.first_visible !== null && !fullFrame[element.id]))) {
				// the event the library name explains: a typing piece types from where it first shows; anything else's
				// signature moment is its strongest change — and an impact (stamp, word) sounds where that burst LANDS
				const strongest = analysis.events.length ? analysis.events.reduce((best, event) => (event.strength > best.strength ? event : best), analysis.events[0]) : null;
				const target = hint === "type" ? null : strongest;
				const impact = hint === "stamp" || hint === "word";
				const list = analysis.events
					// a full-frame clip's first frame is its own cut (the clip edge covers it)
					.filter((event) => !(fullFrame[element.id] && event.t < 0.05))
					.filter((event) => !(hint === "type" && event.kind === "appear"))
					.map((event) => {
						const named = !!hint && event === target;
						const at = named && impact && event.settle !== undefined ? event.settle : event.t;
						return { t: at, kind: named ? (hint as string) : event.kind, label: `${named ? hint : event.kind} at +${at.toFixed(2)} s (frames)`, strength: event.strength };
					});
				// typing starts where the piece first shows; a graphic with no sharp change still "appears" there — only when
				// it starts empty (a piece visible on its first frame appears at the clip's edge, which the planner handles;
				// 2026-10-20: a paper-texture loop "appeared" at every 2 s seam before this rule)
				if (analysis.first_visible !== null && analysis.first_visible > 0 && !fullFrame[element.id]) {
					if (hint === "type") list.push({ t: analysis.first_visible, kind: "type", label: `types from +${analysis.first_visible.toFixed(2)} s (frames)`, strength: 1 });
					else if (!list.some((cue) => cue.t <= analysis.first_visible! + 0.1)) list.push({ t: analysis.first_visible, kind: "appear", label: `appears at +${analysis.first_visible.toFixed(2)} s (frames)`, strength: 0 });
				}
				list.sort((a, b) => a.t - b.t);
				const n = add("frames", list);
				clips.push({ element: element.id, name: label, composition: name, source: "frames", cues: n, full_frame: fullFrame[element.id], note: `${analysis.frames} frames, coverage ${analysis.coverage_first}→${analysis.coverage_max}` });
				continue;
			}
			clips.push({ element: element.id, name: label, composition: name, source: "none", cues: 0, full_frame: fullFrame[element.id], note: file ? "no cues declared and no clear picture events" : "render file not on this server: no frames to read" });
		}
	}
	cues.sort((a, b) => a.t - b.t);
	return { cues, clips, fullFrame };
}
