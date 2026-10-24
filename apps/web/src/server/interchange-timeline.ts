/**
 * Interchange (EDT-19, interchange agent 2026-10-20): a commit's project snapshot as a frame-exact, editor-neutral
 * timeline — the one model both writers read (./interchange-fcpxml.ts, ./interchange-otio.ts) — plus the list of what
 * the formats cannot say. Pure: no I/O, no clock, no run-time imports (the snapshot type is erased).
 *
 * Time: the snapshot counts integer ticks (120 000 / s); interchange counts whole frames of the project's rate
 * (30 fps = 4 000 ticks per frame, 29.97 = 4 004). Frame rounding is the editor's: half a frame rounds up. Adjacent
 * clips stay adjacent because both share the rounded boundary.
 *
 * Runbook: docs/restorff/worklog/interchange.md.
 */
import type { ProjectSnapshot, SnapshotElement, SnapshotScene, SnapshotTrack } from "@/sync/snapshot";

export const TICKS_PER_SECOND = 120_000;
export const INTERCHANGE_VERSION = "0.1.0";

export interface FrameRate {
	num: number;
	den: number;
}

export interface MediaInfo {
	id: string;
	/** Display name (usually the original file name). */
	name: string;
	kind: "video" | "audio" | "image";
	/** Where the receiving editor finds the file: an http(s) URL to this server's media, or a file:// URL. */
	url: string;
	/** A unique, relinkable file name (what to save the file as when relinking by name). */
	fileName: string;
	/** Media length, ticks (unknown for stills). */
	durationTicks?: number;
	width?: number;
	height?: number;
	fps?: number;
	hasAudio?: boolean;
	hasVideo?: boolean;
	mime?: string;
}

export interface CommentInfo {
	id?: string;
	time_s: number;
	time_end_s?: number | null;
	body: string;
	author?: string | null;
	severity?: string | null;
	status?: string | null;
	rule_id?: string | null;
}

export interface InterchangeInput {
	snapshot: ProjectSnapshot;
	/** What the server knows about each media id (its media store meta), merged over the ops manifest. */
	media?: Record<string, Partial<MediaInfo>>;
	/**
	 * Builds a media URL from the id, the chosen file name and (library audio) the element's own sourceUrl.
	 * Default: the sourceUrl, else `file:///media/<fileName>`.
	 */
	mediaUrl?: (mediaId: string, fileName: string, sourceUrl?: string) => string;
	/** Review comments of the commit (become markers). */
	comments?: CommentInfo[];
	timelineId?: string;
	commitId?: string;
	/** ISO time to stamp into the file (no clock in here). */
	exportedAt?: string;
}

export type ClipKind = "video" | "image" | "audio" | "text" | "graphic" | "sticker" | "effect";

export interface TitleStyle {
	font: string;
	/** Rendered size in canvas px (editor unit × canvas height / 90). */
	sizePx: number;
	/** RGBA, 0..1. */
	color: [number, number, number, number];
	bold: boolean;
	italic: boolean;
	align: "left" | "center" | "right";
	/** Canvas px from the centre, y down (the editor's transform.position). */
	x: number;
	y: number;
}

export interface IClip {
	id: string;
	name: string;
	kind: ClipKind;
	/** Timeline frames, [start, end). */
	start: number;
	end: number;
	/** Source in point, frames of the project rate. */
	inF: number;
	/** The exact values, for a tick-exact re-import into RestorffCut. */
	ticks: { start: number; duration: number; trimStart: number; sourceDuration?: number };
	/** Retime rate (1 = normal speed). */
	rate: number;
	mediaId?: string;
	media?: MediaInfo;
	text?: string;
	style?: TitleStyle;
	/** Sticker id or graphic definition id. */
	generator?: string;
	/** Element shown (false: hidden element or hidden/muted track). */
	enabled: boolean;
	/** Video: the clip's own audio plays. */
	audioEnabled: boolean;
	volumeDb?: number;
	scale?: { x: number; y: number };
	transitionIn?: { type: string; frames: number };
	composition?: { name: string; title?: string; custom: boolean };
	effects: string[];
	keyframes: string[];
	masks: number;
	blend?: string;
	opacity?: number;
	moved: boolean;
	rotated: boolean;
	author?: string;
	params?: Record<string, unknown>;
}

export interface ITrack {
	id: string;
	name: string;
	type: string;
	group: "overlay" | "main" | "audio";
	/** Index inside its group (overlay 0 = top; audio 0 = just below main). */
	index: number;
	role?: string;
	hidden: boolean;
	muted: boolean;
	clips: IClip[];
}

export interface IMarker {
	/** Timeline frames. */
	start: number;
	dur: number;
	name: string;
	note: string;
	kind: "comment" | "bookmark";
	severity?: string;
	resolved?: boolean;
	color?: string;
}

export interface NotExpressed {
	what: string;
	count: number;
	elements: string[];
	how: string;
}

export interface ITimeline {
	name: string;
	fps: FrameRate;
	/** Ticks per frame. */
	tpf: number;
	width: number;
	height: number;
	/** Total length, frames. */
	duration: number;
	/** Display order, top to bottom (overlay…, main, audio…). */
	tracks: ITrack[];
	markers: IMarker[];
	/** Every media the clips use, in first-use order. */
	media: MediaInfo[];
	/** Elements whose times were not on the frame grid (rounded, at most half a frame). */
	rounded: number;
	timelineId?: string;
	commitId?: string;
	exportedAt?: string;
	loudness?: { integratedLufs?: number; truePeakDb?: number };
	/** Things both formats drop, collected while flattening (writers add their own). */
	notes: NoteBook;
}

// ─── small helpers ─────────────────────────────────────────────────────────────────────────────────────────────

export function gcd(a: number, b: number): number {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y) [x, y] = [y, x % y];
	return x || 1;
}

const STANDARD_RATES: Array<[number, FrameRate]> = [
	[23.976, { num: 24000, den: 1001 }],
	[29.97, { num: 30000, den: 1001 }],
	[47.952, { num: 48000, den: 1001 }],
	[59.94, { num: 60000, den: 1001 }],
	[119.88, { num: 120000, den: 1001 }],
];

/** The snapshot's fps (a number or {numerator, denominator}) as a rate whose frame is a whole number of ticks. */
export function frameRateOf(snapshot: ProjectSnapshot): FrameRate {
	const raw = snapshot.settings?.fps;
	let rate: FrameRate = { num: 30, den: 1 };
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
		const standard = STANDARD_RATES.find(([value]) => Math.abs(value - raw) < 0.01);
		rate = standard ? standard[1] : Math.abs(raw - Math.round(raw)) < 0.01 ? { num: Math.round(raw), den: 1 } : { num: Math.round(raw * 1000), den: 1000 };
	} else if (raw && typeof raw === "object" && raw.numerator > 0 && raw.denominator > 0) {
		rate = { num: Math.round(raw.numerator), den: Math.round(raw.denominator) };
	}
	const g = gcd(rate.num, rate.den);
	rate = { num: rate.num / g, den: rate.den / g };
	const tpf = (TICKS_PER_SECOND * rate.den) / rate.num;
	return Number.isInteger(tpf) ? rate : { num: 30, den: 1 };
}

export const ticksPerFrame = (rate: FrameRate) => (TICKS_PER_SECOND * rate.den) / rate.num;
export const fpsValue = (rate: FrameRate) => rate.num / rate.den;
/** Ticks → frames with the editor's rounding (remainder × 2 ≥ tpf rounds up). */
export const toFrames = (ticks: number, tpf: number) => Math.floor((ticks + tpf / 2) / tpf);

function activeScene(snapshot: ProjectSnapshot): SnapshotScene | null {
	const scenes = snapshot.scenes ?? [];
	return scenes.find((scene) => scene.id === snapshot.currentSceneId) ?? scenes.find((scene) => scene.isMain) ?? scenes[0] ?? null;
}

const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

const NAMED_COLORS: Record<string, [number, number, number]> = {
	white: [255, 255, 255],
	black: [0, 0, 0],
	red: [255, 0, 0],
	green: [0, 128, 0],
	blue: [0, 0, 255],
	yellow: [255, 255, 0],
	transparent: [0, 0, 0],
};

/** A CSS colour (#rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), a few names) as RGBA 0..1; white when unreadable. */
export function parseColor(value: unknown): [number, number, number, number] {
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	const round = (n: number) => Math.round(n * 10000) / 10000;
	const hex = /^#([0-9a-f]{3,8})$/.exec(text);
	if (hex) {
		let digits = hex[1];
		if (digits.length === 3 || digits.length === 4) digits = [...digits].map((d) => d + d).join("");
		if (digits.length === 6 || digits.length === 8) {
			const parts = digits.match(/../g)!.map((pair) => Number.parseInt(pair, 16) / 255);
			return [round(parts[0]), round(parts[1]), round(parts[2]), round(parts[3] ?? 1)];
		}
	}
	const fn = /^rgba?\(([^)]+)\)$/.exec(text);
	if (fn) {
		const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map((part) => (part.endsWith("%") ? (Number.parseFloat(part) / 100) * 255 : Number.parseFloat(part)));
		if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
			const alpha = parts.length >= 4 && Number.isFinite(parts[3]) ? (parts[3] > 1 ? parts[3] / 255 : parts[3]) : 1;
			return [round(parts[0] / 255), round(parts[1] / 255), round(parts[2] / 255), round(alpha)];
		}
	}
	if (text in NAMED_COLORS) {
		const [r, g, b] = NAMED_COLORS[text];
		return [round(r / 255), round(g / 255), round(b / 255), text === "transparent" ? 0 : 1];
	}
	return [1, 1, 1, 1];
}

/** A file name safe on every OS, keeping the extension. */
export function safeFileName(name: string): string {
	const cleaned = name
		.replace(/[\u0000-\u001f<>:"/|?*\\]+/g, "-")
		.replace(/\s+/g, " ")
		.replace(/^[.\s-]+|[.\s]+$/g, "")
		.slice(0, 120);
	return cleaned || "media";
}

const EXTENSION_BY_MIME: Record<string, string> = {
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"video/webm": ".webm",
	"audio/mpeg": ".mp3",
	"audio/mp4": ".m4a",
	"audio/wav": ".wav",
	"audio/x-wav": ".wav",
	"audio/wave": ".wav",
	"audio/ogg": ".ogg",
	"audio/webm": ".webm",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
};

// ─── what the formats drop ─────────────────────────────────────────────────────────────────────────────────────

export class NoteBook {
	private readonly items = new Map<string, NotExpressed>();

	add(key: string, what: string, how: string, elementId?: string): void {
		const item = this.items.get(key) ?? { what, count: 0, elements: [], how };
		item.count += 1;
		if (elementId && item.elements.length < 12 && !item.elements.includes(elementId)) item.elements.push(elementId);
		this.items.set(key, item);
	}

	list(): NotExpressed[] {
		return [...this.items.values()];
	}

	clone(): NoteBook {
		const copy = new NoteBook();
		for (const [key, item] of this.items) copy.items.set(key, { ...item, elements: [...item.elements] });
		return copy;
	}
}

// ─── snapshot → frame model ────────────────────────────────────────────────────────────────────────────────────

function kindOf(element: SnapshotElement): ClipKind | null {
	switch (element.type) {
		case "video":
		case "image":
		case "audio":
		case "text":
		case "graphic":
		case "sticker":
		case "effect":
			return element.type;
		default:
			return null;
	}
}

function mediaKindOf(element: SnapshotElement): MediaInfo["kind"] {
	return element.type === "audio" ? "audio" : element.type === "image" ? "image" : "video";
}

interface MediaRegistry {
	get(element: SnapshotElement): MediaInfo | undefined;
	used(): MediaInfo[];
}

function mediaRegistry(input: InterchangeInput): MediaRegistry {
	const manifest = new Map<string, Record<string, unknown>>();
	const restorff = (input.snapshot.metadata?.restorff ?? {}) as { media?: Array<Record<string, unknown>> };
	for (const entry of restorff.media ?? []) if (typeof entry.id === "string") manifest.set(entry.id, entry);
	const byId = new Map<string, MediaInfo>();
	const order: MediaInfo[] = [];
	const takenNames = new Set<string>();
	const urlOf = input.mediaUrl ?? ((_id: string, fileName: string, sourceUrl?: string) => sourceUrl ?? `file:///media/${encodeURIComponent(fileName)}`);

	function uniqueFileName(id: string, name: string, mime?: string): string {
		let base = safeFileName(name || id);
		if (!/\.[a-z0-9]{2,5}$/i.test(base) && mime && EXTENSION_BY_MIME[mime]) base += EXTENSION_BY_MIME[mime];
		let candidate = base;
		if (takenNames.has(candidate.toLowerCase())) candidate = safeFileName(`${id}-${base}`);
		takenNames.add(candidate.toLowerCase());
		return candidate;
	}

	return {
		get(element) {
			const library = element.type === "audio" && element.sourceType === "library" && typeof element.sourceUrl === "string";
			const id = library ? `library:${element.sourceUrl as string}` : typeof element.mediaId === "string" ? element.mediaId : undefined;
			if (!id) return undefined;
			const known = byId.get(id);
			if (known) {
				const length = typeof element.sourceDuration === "number" ? element.sourceDuration : undefined;
				if (length && !known.durationTicks) known.durationTicks = length;
				return known;
			}
			const meta = input.media?.[id] ?? {};
			const listed = manifest.get(id) ?? {};
			const kind = (meta.kind ?? (listed.kind as MediaInfo["kind"] | undefined) ?? mediaKindOf(element)) as MediaInfo["kind"];
			const sourceUrl = library ? (element.sourceUrl as string) : undefined;
			const name = String(meta.name ?? listed.name ?? (sourceUrl ? decodeURIComponent(sourceUrl.split(/[?#]/)[0].split("/").pop() || "library-audio") : element.name ?? id));
			const fileName = meta.fileName ?? uniqueFileName(library ? "library" : id, name, meta.mime);
			const durationTicks =
				typeof meta.durationTicks === "number"
					? meta.durationTicks
					: typeof listed.duration === "number"
						? (listed.duration as number)
						: typeof element.sourceDuration === "number"
							? (element.sourceDuration as number)
							: undefined;
			const info: MediaInfo = {
				id,
				name,
				kind,
				url: meta.url ?? urlOf(id, fileName, sourceUrl),
				fileName,
				...(durationTicks !== undefined ? { durationTicks } : {}),
				...(num(meta.width ?? listed.width, 0) ? { width: num(meta.width ?? listed.width, 0) } : {}),
				...(num(meta.height ?? listed.height, 0) ? { height: num(meta.height ?? listed.height, 0) } : {}),
				...(num(meta.fps ?? listed.fps, 0) ? { fps: num(meta.fps ?? listed.fps, 0) } : {}),
				hasAudio: kind === "audio" ? true : kind === "image" ? false : ((meta.hasAudio ?? listed.hasAudio) as boolean | undefined) !== false,
				hasVideo: kind !== "audio",
				...(meta.mime ? { mime: meta.mime } : {}),
			};
			byId.set(id, info);
			order.push(info);
			return info;
		},
		used: () => order,
	};
}

function titleStyle(params: Record<string, unknown>, canvasHeight: number): TitleStyle {
	const align = params.textAlign === "left" || params.textAlign === "right" ? params.textAlign : "center";
	return {
		font: typeof params.fontFamily === "string" && params.fontFamily ? params.fontFamily : "Helvetica",
		sizePx: Math.round(((num(params.fontSize, 5) * canvasHeight) / 90) * 100) / 100,
		color: parseColor(params.color ?? "#ffffff"),
		bold: params.fontWeight === "bold" || num(params.fontWeight, 400) >= 600,
		italic: params.fontStyle === "italic",
		align,
		x: num(params["transform.positionX"], 0),
		y: num(params["transform.positionY"], 0),
	};
}

/** Flattens the active scene (the one ops@1 edits) into whole frames. */
export function flattenSnapshot(input: InterchangeInput): ITimeline {
	const { snapshot } = input;
	const fps = frameRateOf(snapshot);
	const tpf = ticksPerFrame(fps);
	const width = num(snapshot.settings?.canvasSize?.width, 1080);
	const height = num(snapshot.settings?.canvasSize?.height, 1920);
	const scene = activeScene(snapshot);
	const notes = new NoteBook();
	const media = mediaRegistry(input);
	let rounded = 0;
	let duration = 0;

	const groups: Array<{ group: ITrack["group"]; tracks: SnapshotTrack[] }> = [
		{ group: "overlay", tracks: scene?.tracks?.overlay ?? [] },
		{ group: "main", tracks: scene?.tracks?.main ? [scene.tracks.main] : [] },
		{ group: "audio", tracks: scene?.tracks?.audio ?? [] },
	];
	const tracks: ITrack[] = [];
	for (const { group, tracks: list } of groups) {
		list.forEach((track, index) => {
			const hidden = track.hidden === true;
			const muted = track.muted === true;
			const role = typeof track.restorff?.role === "string" ? track.restorff.role : undefined;
			const out: ITrack = {
				id: track.id,
				name: track.name ?? (group === "main" ? "V1 A-ROLL" : track.type.toUpperCase()),
				type: track.type,
				group,
				index,
				...(role ? { role } : {}),
				hidden,
				muted,
				clips: [],
			};
			if (hidden) notes.add("hidden-track", "hidden track", "exported with its clips disabled", track.id);
			if (muted) notes.add("muted-track", "muted track", "exported with its clips disabled", track.id);
			const elements = [...(track.elements ?? [])].sort((a, b) => a.startTime - b.startTime);
			let cursor = 0;
			for (const element of elements) {
				const kind = kindOf(element);
				if (!kind) {
					notes.add(`type-${element.type}`, `${element.type} element`, "unknown element type: not exported", element.id);
					continue;
				}
				const startTicks = num(element.startTime, 0);
				const durationTicks = num(element.duration, 0);
				const trimStart = num(element.trimStart, 0);
				if (startTicks % tpf || durationTicks % tpf || trimStart % tpf) rounded += 1;
				const start = toFrames(startTicks, tpf);
				const end = Math.max(start + 1, toFrames(startTicks + durationTicks, tpf));
				if (start < cursor) {
					notes.add("overlap", "clip overlapping the one before it on its track", "dropped (a track holds one clip at a time)", element.id);
					continue;
				}
				cursor = end;
				duration = Math.max(duration, end);
				const params = (element.params ?? {}) as Record<string, unknown>;
				const retime = element.retime as { rate?: number } | undefined;
				const rate = (kind === "video" || kind === "audio") && retime && typeof retime.rate === "number" && retime.rate > 0 ? retime.rate : 1;
				const stored = (element.restorff as { composition?: { name?: string; title?: string; custom?: boolean }; author?: string } | undefined) ?? {};
				const effects = Array.isArray(element.effects)
					? (element.effects as Array<{ type?: string; enabled?: boolean }>).filter((effect) => effect && effect.enabled !== false).map((effect) => String(effect.type ?? "effect"))
					: [];
				const keyframes = element.animations && typeof element.animations === "object" ? Object.keys(element.animations as object) : [];
				const masks = Array.isArray(element.masks) ? element.masks.length : 0;
				const scaleX = num(params["transform.scaleX"], 1);
				const scaleY = num(params["transform.scaleY"], 1);
				const transition = element.transitionIn as { type?: string; duration?: number } | undefined;
				const clip: IClip = {
					id: element.id,
					name: element.name ?? element.id,
					kind,
					start,
					end,
					inF: toFrames(trimStart, tpf),
					ticks: { start: startTicks, duration: durationTicks, trimStart, ...(typeof element.sourceDuration === "number" ? { sourceDuration: element.sourceDuration as number } : {}) },
					rate,
					enabled: element.hidden !== true && !hidden && !muted,
					audioEnabled: kind === "audio" || (kind === "video" && element.isSourceAudioEnabled !== false && params.muted !== true),
					effects,
					keyframes,
					masks,
					moved: num(params["transform.positionX"], 0) !== 0 || num(params["transform.positionY"], 0) !== 0,
					rotated: num(params["transform.rotate"], 0) !== 0,
					params,
					...(typeof stored.author === "string" ? { author: stored.author } : {}),
				};
				if (kind === "audio" && params.muted === true) clip.enabled = false;
				if (kind === "video" || kind === "image" || kind === "audio") {
					const info = media.get(element);
					if (info) {
						clip.media = info;
						clip.mediaId = info.id;
					}
				}
				if ((kind === "video" || kind === "audio") && typeof params.volume === "number" && params.volume !== 0) clip.volumeDb = params.volume;
				if (kind !== "audio" && kind !== "effect" && (scaleX !== 1 || scaleY !== 1)) clip.scale = { x: scaleX, y: scaleY };
				if (typeof params.blendMode === "string" && params.blendMode !== "normal") clip.blend = params.blendMode;
				if (typeof params.opacity === "number" && params.opacity !== 1) clip.opacity = params.opacity;
				if (kind === "text") {
					clip.text = typeof params.content === "string" ? params.content : "";
					clip.style = titleStyle(params, height);
				}
				if (kind === "sticker") clip.generator = String(element.stickerId ?? "sticker");
				if (kind === "graphic") clip.generator = String(element.definitionId ?? "graphic");
				if (kind === "effect") clip.generator = String(element.effectType ?? "effect");
				if ((kind === "video" || kind === "image") && transition?.type && typeof transition.duration === "number" && transition.duration > 0) {
					clip.transitionIn = { type: transition.type, frames: Math.max(1, toFrames(transition.duration, tpf)) };
				}
				if (stored.composition) {
					clip.composition = { name: String(stored.composition.name ?? "composition"), ...(stored.composition.title ? { title: String(stored.composition.title) } : {}), custom: stored.composition.custom === true };
					notes.add(
						"composition",
						"composition (motion graphic)",
						"exported as its rendered alpha video; its code and props stay in RestorffCut (composition get)",
						element.id,
					);
				}
				for (const effect of effects) {
					notes.add(`effect-${effect}`, `${effect} effect on a clip`, effect.includes("grade") ? "not exported: re-grade in the other editor (values in RestorffCut's inspector)" : "not exported", element.id);
				}
				if (masks) notes.add("masks", "masks", "not exported", element.id);
				if (keyframes.length) notes.add("keyframes", "keyframes (animated position, scale, opacity, volume / ducking)", "not exported: the clip keeps its static value", element.id);
				if (clip.blend) notes.add("blend", "blend modes", "not exported (normal)", element.id);
				if (clip.opacity !== undefined) notes.add("opacity", "opacity below 100 %", "not exported (100 %)", element.id);
				if (kind !== "text" && clip.moved) notes.add("position", "clip position (moved off centre)", "not exported (scale is)", element.id);
				if (clip.rotated) notes.add("rotation", "rotation", "not exported", element.id);
				out.clips.push(clip);
			}
			tracks.push(out);
		});
	}

	const markers: IMarker[] = [];
	const fpsFloat = fpsValue(fps);
	for (const bookmark of (scene?.bookmarks ?? []) as Array<{ time?: number; note?: string; color?: string; duration?: number }>) {
		if (typeof bookmark?.time !== "number") continue;
		const start = toFrames(bookmark.time, tpf);
		markers.push({
			start,
			dur: Math.max(1, toFrames(num(bookmark.duration, 0), tpf)),
			name: bookmark.note?.trim() || "Bookmark",
			note: bookmark.note ?? "",
			kind: "bookmark",
			...(bookmark.color ? { color: bookmark.color } : {}),
		});
	}
	for (const comment of input.comments ?? []) {
		if (typeof comment.time_s !== "number" || !Number.isFinite(comment.time_s)) continue;
		const start = Math.max(0, Math.round(comment.time_s * fpsFloat));
		const end = typeof comment.time_end_s === "number" && comment.time_end_s > comment.time_s ? Math.round(comment.time_end_s * fpsFloat) : start + 1;
		const tag = [comment.severity ? comment.severity.toUpperCase() : "", comment.rule_id ?? ""].filter(Boolean).join(" ");
		const body = comment.body.replace(/\s+/g, " ").trim();
		markers.push({
			start,
			dur: Math.max(1, end - start),
			name: `${tag ? `${tag} · ` : ""}${body}`.slice(0, 240),
			note: `${comment.author ? `${comment.author}: ` : ""}${comment.body}`,
			kind: "comment",
			...(comment.severity ? { severity: comment.severity } : {}),
			resolved: comment.status === "resolved",
		});
	}
	markers.sort((a, b) => a.start - b.start);
	for (const marker of markers) duration = Math.max(duration, marker.start + 1);

	const loudness = snapshot.settings?.loudness as { enabled?: boolean; integratedLufs?: number; truePeakDb?: number } | undefined;
	if (loudness?.enabled) notes.add("loudness", `loudness target ${loudness.integratedLufs ?? "?"} LUFS / ${loudness.truePeakDb ?? "?"} dBTP`, "not exported: master to it in the other editor", undefined);
	const background = snapshot.settings?.background as { type?: string } | undefined;
	if (background?.type === "blur") notes.add("background", "blurred background fill", "not exported", undefined);

	return {
		name: snapshot.metadata?.name || input.timelineId || "RestorffCut timeline",
		fps,
		tpf,
		width,
		height,
		duration,
		tracks,
		markers,
		media: media.used(),
		rounded,
		notes,
		...(input.timelineId ? { timelineId: input.timelineId } : {}),
		...(input.commitId ? { commitId: input.commitId } : {}),
		...(input.exportedAt ? { exportedAt: input.exportedAt } : {}),
		...(loudness?.enabled ? { loudness: { integratedLufs: loudness.integratedLufs, truePeakDb: loudness.truePeakDb } } : {}),
	};
}

/** Lines a person can read: "V2 B-ROLL · video · 3 clips". */
export interface TrackSummary {
	name: string;
	kind: string;
	clips: number;
	lane?: number;
	exported: boolean;
}

export interface ExportSummary {
	format: "fcpxml" | "otio";
	format_version: string;
	name: string;
	fps: string;
	frame_duration: string;
	duration_s: number;
	duration_frames: number;
	tracks: TrackSummary[];
	counts: { tracks: number; clips: number; titles: number; audio: number; generators: number; gaps: number; transitions: number; markers: number };
	media: Array<{ media_id: string; name: string; file_name: string; kind: string; url: string }>;
	rounded_to_frames: number;
	not_expressed: NotExpressed[];
}

export function baseSummary(timeline: ITimeline, format: ExportSummary["format"], version: string): Omit<ExportSummary, "tracks" | "counts" | "not_expressed"> {
	return {
		format,
		format_version: version,
		name: timeline.name,
		fps: `${timeline.fps.num}/${timeline.fps.den}`,
		frame_duration: `${timeline.fps.den}/${timeline.fps.num}s`,
		duration_s: Math.round((timeline.duration * timeline.fps.den * 1000) / timeline.fps.num) / 1000,
		duration_frames: timeline.duration,
		media: timeline.media.map((info) => ({ media_id: info.id, name: info.name, file_name: info.fileName, kind: info.kind, url: info.url })),
		rounded_to_frames: timeline.rounded,
	};
}
