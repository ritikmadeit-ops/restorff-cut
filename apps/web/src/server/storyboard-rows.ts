/**
 * The storyboard as data (EDT-14; reel DeUUFJQu8cw 29.7–35.2 s: "before rendering, it gives me a complete storyboard"),
 * for Claude over MCP (`storyboard get`) and the server (mcp-review agent, 2026-10-20). Pure: a project snapshot in,
 * rows out; no node, no DOM, no wasm — safe on both sides.
 *
 * Same reading of the cut as the editor's Storyboard view (apps/web/src/storyboard/shots.ts, design agent): shots are
 * video/image clips on V1 A-ROLL and the B-roll tracks, captions give the words, TEXT clips the on-screen text, and a
 * GAP wherever nothing is on screen. Two differences, both from EDT-14's acceptance ("rows cover the whole runtime with
 * no gaps or overlaps", "one row per beat"):
 *   - rows PARTITION the runtime: a B-roll cut-in over A-roll is its own row (the A-roll is noted as `under`), not a
 *     second, overlapping card;
 *   - a long shot is split into beats at spoken-line boundaries (a caption ending . ! ?, a pause ≥ 0.5 s, or a line
 *     reaching 3.5 s), so a 30 s talking head reads as ~10 beats, like the reel's storyboard, not as one card.
 * Row N is "beat N" everywhere (revise {beat}, storyboard edit_row {row}).
 *
 * The view's role rules (timeline/components/track-layout.ts getTrackRole) are copied here because that module pulls
 * editor constants; keep the two in step.
 *
 * revise-v2 agent, 2026-10-20 (BUILD-BRIEF §5f, SUMMARY gap 3) — rows are BEATS, not clips:
 *   - the spoken words come from the captions the `captions` tool builds (their base layer is tagged
 *     `restorff.captionLayer: "base"`, which this file used to read as a word-highlight layer: every line was empty),
 *     from voice-over clips (`restorff.voice.words`), and from server transcripts the caller passes in (`words`);
 *   - a shot change INSIDE a spoken line no longer splits the row (the row lists every shot it shows in `shots`);
 *     shot changes in pauses and where nobody speaks still do;
 *   - an explainer built by `references` passes its beats (`beats`): rows follow them, `visual` names the picture;
 *   - person cut-outs and layered-effect plates are overlays, never shots;
 *   - `on_screen` = TEXT-track words + the text props of compositions over the row.
 */
import { gradeLabel } from "@restorffcut/timeline-ops";
import { clipLabel, formatTenths } from "@/storyboard/labels";
import { quickHash, type ProjectSnapshot, type SnapshotElement, type SnapshotScene, type SnapshotTrack } from "@/sync/snapshot";

const TICKS = 120_000;
const LINE_PAUSE_S = 0.5;
const LINE_MAX_S = 3.5;
const MIN_ROW_S = 0.2;

export type ShotRole = "A-ROLL" | "B-ROLL" | "GAP";
type TrackRole = "captions" | "text" | "aroll" | "broll" | "sfx" | "music" | "graphic" | "effect" | "words";

export interface RowShot {
	role: ShotRole;
	element_id: string | null;
	track_id: string | null;
	track: string | null;
	name: string;
	media: string | null;
	/** The A-roll still running under a B-roll cut-in (its voice carries on). */
	under?: { element_id: string; name: string };
}

export interface RowOverlay {
	kind: "composition" | "text" | "effect" | "grade" | "transition" | "sticker" | "graphic" | "clip-effect";
	name: string;
	element_id: string | null;
	t: number;
}

export interface RowSound {
	kind: "music" | "sfx";
	name: string;
	element_id: string;
	t: number;
	/** starts = begins inside this beat; bed = was already playing. */
	cue: "starts" | "bed";
}

export interface StoryboardRow {
	/** 1-based: "beat N". */
	row: number;
	start: number;
	end: number;
	dur: number;
	/** "0:00.0–0:02.8" as the view prints it. */
	range: string;
	/** The shot on screen longest in this beat. */
	shot: RowShot;
	/** Every shot this beat shows, in order (a beat can hold a cut-in or a few stills under one line). */
	shots: Array<{ role: ShotRole; element_id: string | null; name: string; t: number }>;
	/** The words spoken in this beat, verbatim (caption clips that start inside it, else voice-over / transcript words). */
	line: string;
	/** Where `line` came from. */
	line_from: "captions" | "voice" | "transcript" | "script" | null;
	caption_ids: string[];
	/** On-screen text (TEXT-track clips: titles, pops, big words) over this beat. */
	emphasis: string[];
	emphasis_ids: string[];
	/** Everything written on screen over this beat: `emphasis` + the words inside compositions (their text props). */
	on_screen: string[];
	/** Explainer beats (references build): what the picture is meant to be. */
	visual?: string;
	overlays: RowOverlay[];
	sound: RowSound[];
	/** One line: "▶ whoosh 0:03.2 · bed Halcyon bed". Empty when silent. */
	sound_cue: string;
}

/** A spoken word on the timeline (seconds), from a transcript the caller read (server/transcripts*). */
export interface SpokenWord {
	text: string;
	start: number;
	end: number;
}

/** Extra inputs the pure builder cannot read from the snapshot itself. */
export interface StoryboardInputs {
	/** Transcript words in timeline seconds for spoken clips (used where no caption covers them). */
	words?: SpokenWord[];
	/** Explainer beats (references-store VersionSummary.beats): rows follow them. */
	beats?: Array<{ start: number; end: number; line?: string; visual?: string; kind?: string }>;
}

export interface Storyboard {
	rows: StoryboardRow[];
	runtime: number;
	shots: number;
	/** Hash of what a person approves (times, shots, lines, emphasis, overlays, sound): changes when any of it does. */
	hash: string;
}

const round = (seconds: number, digits = 3) => {
	const f = 10 ** digits;
	return Math.round(seconds * f) / f;
};
const sec = (ticks: number) => ticks / TICKS;
const endOf = (element: SnapshotElement) => element.startTime + element.duration;

function textOf(element: SnapshotElement): string {
	const content = (element.params as Record<string, unknown> | undefined)?.content;
	return typeof content === "string" ? content.trim() : "";
}

function roleOf(track: SnapshotTrack, group: "overlay" | "main" | "audio"): TrackRole {
	const role = track.restorff?.role;
	const name = (track.name ?? "").toUpperCase();
	switch (track.type) {
		case "text": {
			// the captions tool / Captions tab tag their layers base | words | shadow: only base holds the spoken chunks
			const layer = (track.restorff as { captionLayer?: string } | undefined)?.captionLayer;
			if (layer === "words" || layer === "shadow" || /^CAPTION (WORDS|SHADOW)$/.test(name)) return "words";
			if (layer === "base" || role === "caption" || name.startsWith("CAPTIONS")) return "captions";
			return "text";
		}
		case "video":
			if (group === "main" || role === "aroll" || name === "V1 A-ROLL" || name === "MAIN TRACK") return "aroll";
			return "broll";
		case "audio":
			if (role === "sfx" || name.startsWith("SFX")) return "sfx";
			return "music";
		case "graphic":
			return "graphic";
		case "effect":
			return "effect";
		default:
			return "graphic";
	}
}

export function activeScene(snapshot: ProjectSnapshot | null): SnapshotScene | null {
	const scenes = snapshot?.scenes ?? [];
	return scenes.find((scene) => scene.id === snapshot?.currentSceneId) ?? scenes.find((scene) => scene.isMain) ?? scenes[0] ?? null;
}

function compositionName(element: SnapshotElement): string | null {
	const stored = (element.restorff as { composition?: { name?: string; title?: string } } | undefined)?.composition;
	return stored ? (stored.title ?? (element.name ? shotName(element.name) : null) ?? stored.name ?? "composition") : null;
}

/** A person cut-out (cutout tool) or a layer of a layered effect (effects apply): an overlay, never a shot. */
function isPlate(element: SnapshotElement): boolean {
	const restorff = element.restorff as { cutout?: unknown; effect?: unknown } | undefined;
	return !!restorff?.cutout || !!restorff?.effect;
}

/** A video/image element that is a shot (not a rendered composition on MOTION, not a cut-out or effect plate). */
function isShot(element: SnapshotElement): boolean {
	return (element.type === "video" || element.type === "image") && !compositionName(element) && !isPlate(element) && !element.hidden;
}

/** Prop keys of a composition that hold words it puts on screen (library + custom conventions). */
const TEXT_PROP_RE = /^(word|words|title|titles|headline|headlines|text|texts|kicker|sub|subtitle|label|labels|line|lines|items|pills|caption|quote|keyword|cta|tag|tags|heading|eyebrow|question|answer|verdict|stamp|name)$/i;

/** The words a composition shows, from its stored props (short strings only; never data: URLs or colours). */
export function compositionTexts(element: SnapshotElement): string[] {
	const props = (element.restorff as { composition?: { props?: Record<string, unknown> } } | undefined)?.composition?.props;
	if (!props || typeof props !== "object") return [];
	const out: string[] = [];
	const take = (value: unknown) => {
		if (typeof value !== "string") return;
		const text = value.trim();
		if (!text || text.length > 80 || /^(#|data:|https?:|\/)/i.test(text)) return;
		out.push(text);
	};
	for (const [key, value] of Object.entries(props)) {
		if (!TEXT_PROP_RE.test(key)) continue;
		if (Array.isArray(value)) value.slice(0, 8).forEach((item) => (typeof item === "string" ? take(item) : take((item as { text?: unknown } | null)?.text)));
		else take(value);
	}
	return out.slice(0, 8);
}

/** "warm morning", "moody · 80 %", or the grade agent's own label for custom values (timeline-ops grades.ts). */
function gradeName(params: Record<string, unknown> | undefined): string {
	try {
		return gradeLabel(params);
	} catch {
		const look = typeof params?.look === "string" ? params.look : null;
		return look ?? "custom";
	}
}

/** A clip's name as the view prints it, without the "(left)" / "(right)" a split appends (once per split). */
function shotName(name: string): string {
	return clipLabel(name.replace(/(\s*\((left|right)\))+$/i, "").trim() || name);
}

/** One spoken unit: a caption chunk (with its element id) or a voice-over / transcript word. Ticks. */
interface Unit {
	start: number;
	end: number;
	text: string;
	caption_id?: string;
	from: "captions" | "voice" | "transcript";
}

interface Line {
	start: number;
	end: number;
}

/** Group spoken units into lines (ticks): a sentence end, a pause ≥ 0.5 s, or a line reaching 3.5 s ends one. */
function linesOf(units: Unit[]): Line[] {
	const lines: Line[] = [];
	let current: Line | null = null;
	let lastText = "";
	for (const unit of units) {
		if (current) {
			const pause = sec(unit.start - current.end);
			const ended = /[.!?…]["”’)]*$/.test(lastText);
			const tooLong = sec(unit.end - current.start) > LINE_MAX_S;
			if (ended || pause >= LINE_PAUSE_S || tooLong) {
				lines.push(current);
				current = null;
			}
		}
		if (!current) current = { start: unit.start, end: unit.end };
		else current.end = Math.max(current.end, unit.end);
		lastText = unit.text;
	}
	if (current) lines.push(current);
	return lines;
}

/** Voice-over words on the timeline (ticks): `restorff.voice.words` are seconds into the take (the clip's source). */
function voiceUnits(tracks: Array<{ track: SnapshotTrack; role: TrackRole }>): Unit[] {
	const out: Unit[] = [];
	for (const { track } of tracks) {
		if (track.muted) continue;
		for (const element of track.elements ?? []) {
			const voice = (element.restorff as { voice?: { words?: Array<{ text?: string; start?: number; end?: number }> } } | undefined)?.voice;
			if (!voice?.words?.length) continue;
			const rate = Number((element.retime as { rate?: number } | undefined)?.rate) || 1;
			const trim = element.trimStart ?? 0;
			for (const word of voice.words) {
				if (typeof word.text !== "string" || typeof word.start !== "number" || typeof word.end !== "number") continue;
				const start = element.startTime + Math.round((word.start * TICKS - trim) / rate);
				const end = element.startTime + Math.round((word.end * TICKS - trim) / rate);
				if (end <= element.startTime || start >= endOf(element)) continue;
				out.push({ start: Math.max(start, element.startTime), end: Math.min(end, endOf(element)), text: word.text.trim(), from: "voice" });
			}
		}
	}
	return out;
}

export function buildStoryboard(snapshot: ProjectSnapshot | null, inputs: StoryboardInputs = {}): Storyboard {
	const scene = activeScene(snapshot);
	const empty: Storyboard = { rows: [], runtime: 0, shots: 0, hash: quickHash("[]") };
	if (!scene?.tracks) return empty;
	const overlay = scene.tracks.overlay ?? [];
	const main = scene.tracks.main;
	const audio = scene.tracks.audio ?? [];
	const all: Array<{ track: SnapshotTrack; group: "overlay" | "main" | "audio"; role: TrackRole }> = [
		...overlay.map((track) => ({ track, group: "overlay" as const, role: roleOf(track, "overlay") })),
		...(main ? [{ track: main, group: "main" as const, role: roleOf(main, "main") }] : []),
		...audio.map((track) => ({ track, group: "audio" as const, role: roleOf(track, "audio") })),
	];

	// shot layers, top first: overlay video/image tracks in display order, then the main track
	const shotLayers = all.filter(({ track, role }) => (role === "aroll" || role === "broll") && !track.hidden);
	const captions = all
		.filter(({ role }) => role === "captions")
		.flatMap(({ track }) => (track.hidden ? [] : track.elements ?? []))
		.filter((element) => textOf(element))
		.sort((a, b) => a.startTime - b.startTime);
	const texts = all.filter(({ role }) => role === "text").flatMap(({ track }) => track.elements ?? []);

	let runtimeTicks = 0;
	for (const { track } of all) for (const element of track.elements ?? []) runtimeTicks = Math.max(runtimeTicks, endOf(element));
	if (runtimeTicks <= 0) return empty;

	// the spoken words: caption chunks first; voice-over and transcript words only where no caption is
	const captionUnits: Unit[] = captions.map((element) => ({ start: element.startTime, end: endOf(element), text: textOf(element), caption_id: element.id, from: "captions" }));
	const covered = (start: number, end: number) => captionUnits.some((unit) => (start + end) / 2 >= unit.start && (start + end) / 2 < unit.end);
	const otherUnits: Unit[] = [
		...voiceUnits(all.filter(({ role }) => role === "music")),
		...(inputs.words ?? []).map((word) => ({ start: Math.round(word.start * TICKS), end: Math.round(word.end * TICKS), text: word.text.trim(), from: "transcript" as const })),
	]
		.filter((unit) => unit.text && unit.end > unit.start && !covered(unit.start, unit.end))
		.sort((a, b) => a.start - b.start);
	// a word said twice at one moment (a clip and its own audio, a VO and its transcript) once
	const spoken: Unit[] = [];
	for (const unit of [...captionUnits, ...otherUnits].sort((a, b) => a.start - b.start)) {
		const previous = spoken[spoken.length - 1];
		if (previous && previous.from !== "captions" && unit.from !== "captions" && previous.text === unit.text && Math.abs(previous.start - unit.start) < 0.03 * TICKS) continue;
		spoken.push(unit);
	}

	const minRow = MIN_ROW_S * TICKS;
	const points = new Set<number>([0, runtimeTicks]);
	const shotEdges: number[] = [];
	for (const { track } of shotLayers) {
		for (const element of track.elements ?? []) {
			if (!isShot(element)) continue;
			shotEdges.push(element.startTime, endOf(element));
		}
	}
	const lines = linesOf(spoken);
	const explainer = (inputs.beats ?? []).filter((beat) => beat.end > beat.start);
	if (explainer.length) {
		// an explainer's own beats (references build): its edges, nothing else
		for (const beat of explainer) {
			for (const edge of [beat.start, beat.end]) {
				const ticks = Math.round(edge * TICKS);
				if (ticks > 0 && ticks < runtimeTicks) points.add(ticks);
			}
		}
	} else {
		// beats = spoken lines; a shot change inside a line does not split it, one in a pause or in silence does
		const insideLine = (edge: number) => lines.some((line) => edge > line.start + minRow && edge < line.end - minRow);
		for (const edge of shotEdges) if (edge > 0 && edge < runtimeTicks && !insideLine(edge)) points.add(edge);
		for (let i = 1; i < lines.length; i++) {
			const prev = lines[i - 1] as Line;
			const next = lines[i] as Line;
			const boundary = next.start > prev.end ? Math.round((prev.end + next.start) / 2) : next.start;
			// a shot edge already near this line boundary is the beat edge
			if (shotEdges.some((edge) => Math.abs(edge - boundary) < minRow || (edge >= prev.end && edge <= next.start))) continue;
			points.add(boundary);
		}
	}
	let cuts = [...points].sort((a, b) => a - b);
	// drop slivers (< 0.2 s): keep the earlier edge; the runtime end always stays
	const kept: number[] = [];
	for (const point of cuts) {
		const last = kept[kept.length - 1];
		if (last === undefined || point - last >= minRow) {
			kept.push(point);
			continue;
		}
		if (point === runtimeTicks) {
			if (kept.length > 1) kept.pop();
			kept.push(point);
		}
	}
	cuts = kept;

	const topAt = (t: number) => {
		let top: { element: SnapshotElement; track: SnapshotTrack; role: TrackRole } | null = null;
		let aroll: SnapshotElement | null = null;
		for (const { track, role } of shotLayers) {
			for (const element of track.elements ?? []) {
				if (!isShot(element) || element.startTime > t || endOf(element) <= t) continue;
				if (!top) top = { element, track, role };
				if (role === "aroll" && !aroll) aroll = element;
			}
		}
		return { top, aroll };
	};
	const shotView = (t: number): RowShot => {
		const { top, aroll } = topAt(t);
		if (!top) return { role: "GAP", element_id: null, track_id: null, track: null, name: "nothing on screen", media: null };
		const role: ShotRole = top.role === "aroll" ? "A-ROLL" : "B-ROLL";
		return {
			role,
			element_id: top.element.id,
			track_id: top.track.id,
			track: top.track.name ?? null,
			name: shotName(top.element.name ?? top.element.id),
			media: top.element.mediaId ?? null,
			...(role === "B-ROLL" && aroll ? { under: { element_id: (aroll as SnapshotElement).id, name: shotName((aroll as SnapshotElement).name ?? (aroll as SnapshotElement).id) } } : {}),
		};
	};
	/** Every shot over [a, b): a sample at a and just after each shot edge inside; the longest on screen first. */
	const shotsOver = (a: number, b: number) => {
		const samples = [a, ...shotEdges.filter((edge) => edge > a && edge < b)].sort((x, y) => x - y);
		const seen = new Map<string, { view: RowShot; t: number; ticks: number }>();
		samples.forEach((sample, i) => {
			const until = i + 1 < samples.length ? (samples[i + 1] as number) : b;
			if (until <= sample) return;
			const view = shotView(sample);
			const key = view.element_id ?? `gap@${sample}`;
			const known = seen.get(key);
			if (known) known.ticks += until - sample;
			else seen.set(key, { view, t: sample, ticks: until - sample });
		});
		const list = [...seen.values()];
		const longest = [...list].sort((x, y) => y.ticks - x.ticks)[0];
		return { list, longest: longest?.view ?? shotView(Math.round((a + b) / 2)) };
	};

	const rows: StoryboardRow[] = [];
	for (let i = 0; i < cuts.length - 1; i++) {
		const a = cuts[i] as number;
		const b = cuts[i + 1] as number;
		if (b <= a) continue;
		const inRow = (element: { startTime: number }) => element.startTime >= a && element.startTime < b;
		// half a frame of tolerance: a split at a rounded second must not show the piece before it in this beat
		const overlapsRow = (element: SnapshotElement) => element.startTime < b - 2000 && endOf(element) > a + 2000;
		const rowCaptions = captions.filter(inRow);
		const rowUnits = spoken.filter((unit) => unit.start >= a && unit.start < b);
		const rowTexts = texts.filter((element) => overlapsRow(element) && textOf(element));
		const { list: rowShots, longest: shot } = shotsOver(a, b);
		const overlays: RowOverlay[] = [];
		const compositionWords: string[] = [];
		for (const { track, role } of all) {
			if (role === "captions" || role === "words" || role === "text" || role === "music" || role === "sfx") continue;
			for (const element of track.elements ?? []) {
				if (!overlapsRow(element)) continue;
				const t = round(sec(Math.max(element.startTime, a)), 2);
				const composition = compositionName(element);
				if (composition) {
					overlays.push({ kind: "composition", name: composition, element_id: element.id, t });
					compositionWords.push(...compositionTexts(element));
				} else if (element.type === "effect") {
					const effectType = String((element as { effectType?: unknown }).effectType ?? "effect");
					const isGrade = /grade/i.test(effectType) || (track.name ?? "").toUpperCase() === "GRADE";
					overlays.push({ kind: isGrade ? "grade" : "effect", name: isGrade ? gradeName(element.params) : effectType, element_id: element.id, t });
				} else if (element.type === "sticker" || element.type === "graphic") {
					overlays.push({ kind: element.type, name: element.name ?? element.type, element_id: element.id, t });
				} else if (isPlate(element) && !element.hidden) {
					overlays.push({ kind: "effect", name: (element.restorff as { cutout?: unknown } | undefined)?.cutout ? "person cut-out" : shotName(element.name ?? "effect layer"), element_id: element.id, t });
				}
				// per-clip effects and the transition into a clip that starts in this beat
				if (isShot(element) && rowShots.some((candidate) => candidate.view.element_id === element.id)) {
					for (const effect of (element.effects as Array<{ type?: string; enabled?: boolean; params?: Record<string, unknown> }> | undefined) ?? []) {
						if (effect?.enabled === false) continue;
						const isGrade = /grade/i.test(effect?.type ?? "");
						overlays.push({ kind: isGrade ? "grade" : "clip-effect", name: isGrade ? gradeName(effect.params) : String(effect?.type ?? "effect"), element_id: element.id, t });
					}
				}
				const transition = element.transitionIn as { type?: string } | undefined;
				if (transition?.type && isShot(element) && element.startTime >= a && element.startTime < b) {
					overlays.push({ kind: "transition", name: transition.type, element_id: element.id, t: round(sec(element.startTime), 2) });
				}
			}
		}
		const sound: RowSound[] = [];
		for (const { track, role } of all) {
			if (role !== "music" && role !== "sfx") continue;
			if (track.muted) continue;
			// a voice-over is the beat's line, not a sound cue
			if (track.restorff?.role === "voice" || /^VOICE\b/i.test(track.name ?? "")) continue;
			for (const element of track.elements ?? []) {
				if (!overlapsRow(element)) continue;
				const starts = element.startTime >= a && element.startTime < b;
				sound.push({ kind: role, name: element.name ?? element.id, element_id: element.id, t: round(sec(Math.max(a, element.startTime)), 2), cue: starts ? "starts" : "bed" });
			}
		}
		const cue = sound
			.map((s) => (s.cue === "starts" ? `▶ ${s.kind === "sfx" ? "" : "music "}${s.name} ${formatTenths(s.t)}` : `bed ${s.name}`))
			.join(" · ");
		const start = round(sec(a));
		const end = round(sec(b));
		const beat = explainer.find((candidate) => Math.abs(candidate.start * TICKS - a) < minRow) ?? explainer.find((candidate) => candidate.start * TICKS <= a && candidate.end * TICKS > a);
		const spokenLine = rowUnits.map((unit) => unit.text).join(" ").replace(/\s+/g, " ").trim();
		const line = spokenLine || (beat?.line ?? "").trim();
		const lineFrom: StoryboardRow["line_from"] = spokenLine ? (rowUnits[0]?.from ?? null) : line ? "script" : null;
		const emphasis = rowTexts.map(textOf);
		rows.push({
			row: rows.length + 1,
			start,
			end,
			dur: round(end - start, 2),
			range: `${formatTenths(start)}–${formatTenths(end)}`,
			shot,
			shots: rowShots.map((item) => ({ role: item.view.role, element_id: item.view.element_id, name: item.view.name, t: round(sec(item.t), 2) })),
			line,
			line_from: lineFrom,
			caption_ids: rowCaptions.map((element) => element.id),
			emphasis,
			emphasis_ids: rowTexts.map((element) => element.id),
			on_screen: [...new Set([...emphasis, ...compositionWords])],
			...(beat?.visual || beat?.kind ? { visual: String(beat.visual || beat.kind) } : {}),
			overlays,
			sound,
			sound_cue: cue,
		});
	}
	const shots = new Set(rows.flatMap((row) => row.shots.map((item) => item.element_id)).filter(Boolean)).size;
	const hash = quickHash(
		JSON.stringify(rows.map((row) => [row.start, row.end, row.shot.element_id, row.line, row.emphasis, row.on_screen, row.overlays.map((o) => o.name), row.sound.map((s) => s.name)])),
	);
	return { rows, runtime: round(sec(runtimeTicks)), shots, hash };
}

/** The row (beat) playing at `t` seconds (the last row for t ≥ runtime). */
export function rowAt(board: Storyboard, t: number): StoryboardRow | null {
	if (!board.rows.length) return null;
	return board.rows.find((row) => t >= row.start && t < row.end) ?? (t >= board.runtime ? (board.rows[board.rows.length - 1] ?? null) : null);
}

// ─── approval (kept in the project metadata: metadata.restorff.storyboard) ─────────────────────────────────────

export interface StoryboardApprovalRecord {
	approved: boolean;
	approved_at: string;
	approved_by: string;
	/** The head commit whose storyboard was approved. */
	commit: string;
	/** Storyboard.hash at approval: a later edit that changes the storyboard makes the approval stale. */
	hash: string;
	rows: number;
	note?: string;
}

export interface StoryboardApprovalState {
	status: "not_approved" | "approved" | "stale";
	record: StoryboardApprovalRecord | null;
}

export function approvalRecordOf(snapshot: ProjectSnapshot | null): StoryboardApprovalRecord | null {
	const restorff = snapshot?.metadata?.restorff as { storyboard?: StoryboardApprovalRecord } | undefined;
	const record = restorff?.storyboard;
	return record && typeof record === "object" && typeof record.hash === "string" ? record : null;
}

/**
 * Is this cut's storyboard approved? `stale` = it was approved, then the cut changed in a way the storyboard shows.
 * For render gates (EDT-14: "no render job starts before approval in Manual mode") — mcp-render can call this.
 */
export function storyboardApproval(snapshot: ProjectSnapshot | null, board: Storyboard = buildStoryboard(snapshot)): StoryboardApprovalState {
	const record = approvalRecordOf(snapshot);
	if (!record?.approved) return { status: "not_approved", record };
	return { status: record.hash === board.hash ? "approved" : "stale", record };
}

// ─── for edits ──────────────────────────────────────────────────────────────────────────────────────────────────

export function findSnapshotElement(snapshot: ProjectSnapshot | null, id: string): { element: SnapshotElement; track: SnapshotTrack; group: "overlay" | "main" | "audio" } | null {
	const scene = activeScene(snapshot);
	if (!scene?.tracks) return null;
	const groups: Array<["overlay" | "main" | "audio", SnapshotTrack[]]> = [
		["overlay", scene.tracks.overlay ?? []],
		["main", scene.tracks.main ? [scene.tracks.main] : []],
		["audio", scene.tracks.audio ?? []],
	];
	for (const [group, tracks] of groups) {
		for (const track of tracks) {
			const element = (track.elements ?? []).find((candidate) => candidate.id === id);
			if (element) return { element, track, group };
		}
	}
	return null;
}

/** Caption tracks (not the per-word highlight / shadow layers), as the storyboard reads them. */
export function captionTracksOf(snapshot: ProjectSnapshot | null): SnapshotTrack[] {
	const scene = activeScene(snapshot);
	return (scene?.tracks?.overlay ?? []).filter((track) => roleOf(track, "overlay") === "captions");
}

/** Plain TEXT tracks (titles, pops). */
export function textTracksOf(snapshot: ProjectSnapshot | null): SnapshotTrack[] {
	const scene = activeScene(snapshot);
	return (scene?.tracks?.overlay ?? []).filter((track) => roleOf(track, "overlay") === "text");
}
