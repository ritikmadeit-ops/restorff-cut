/**
 * Compositions as revise sees them (revise-v2 agent, 2026-10-20; BUILD-BRIEF §5f, SUMMARY gap 2; neon-grid-type
 * REPORT §7 G-3, explainer-overlay §5). Pure: a snapshot (+ manifests the caller read) in, plans out.
 *
 *   listCompositions(snapshot)     every composition clip (custom = code in the clip; library = name + props)
 *   pickCompositions(clause, …)    "the titles" · "all the cards" · "the charts" · "the counter" · "the overlays" · it
 *   nudgeComposition(…)            size · speed · colour · ease · position · exit · length words → props before → after,
 *                                  with the composition contract's steps (packages/compositions/src/edits.ts, CONTRACT §4)
 *   structuralRecipe(…)            "smoother transition", "loop the ending", "animate it differently" → the exact
 *                                  composition get → update calls to send (a code change, not a param)
 *   compositionDiff(before, after) props a → b and source line counts, for history notes
 */
import { compositionTexts } from "./storyboard-rows";
import type { ProjectSnapshot, SnapshotElement, SnapshotTrack } from "@/sync/snapshot";

const TICKS = 120_000;
const r3 = (value: number) => Math.round(value * 1000) / 1000;

// ─── what a composition clip carries ────────────────────────────────────────────────────────────────────────────

export interface StoredComposition {
	custom?: boolean;
	name?: string;
	title?: string;
	source?: string;
	props?: Record<string, unknown>;
	hash?: string;
	width?: number;
	height?: number;
	fps?: number;
	duration?: number;
	author?: string;
}

/** A param spec as the params block declares it (packages/compositions CONTRACT §2). */
export interface ParamSpecLite {
	type: string;
	default?: unknown;
	min?: number;
	max?: number;
	step?: number;
	options?: string[];
	description?: string;
}

export interface ManifestLite {
	name?: string;
	title?: string;
	description?: string;
	tags?: string[];
	duration?: number;
	size?: [number, number];
	params: Record<string, ParamSpecLite>;
}

export interface CompositionTarget {
	element_id: string;
	track_id: string;
	track: string | null;
	start: number;
	end: number;
	custom: boolean;
	/** Library name, or the custom manifest's name. */
	name: string;
	title: string;
	props: Record<string, unknown>;
	source: string | null;
	hash: string | null;
	/** Words it shows (text props). */
	words: string[];
	/** Placed by `effects apply` as one layer of a layered effect (back / front plates fed from the person matte). */
	layered: boolean;
	effect: { id?: string; name?: string; layer?: string } | null;
	/** The params block, when read (custom: from its source; library: the caller reads the package file). */
	manifest: ManifestLite | null;
}

export function storedComposition(element: SnapshotElement): StoredComposition | null {
	const restorff = element.restorff as { composition?: StoredComposition } | undefined;
	return restorff?.composition && typeof restorff.composition === "object" ? restorff.composition : null;
}

/** The `<script type="application/json" id="params">` block of a composition's HTML (params.ts extractParamsBlock). */
export function manifestOf(html: string | null | undefined): ManifestLite | null {
	if (!html) return null;
	const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		const attrs = m[1] ?? "";
		if (/\bid\s*=\s*["']params["']/i.test(attrs) && /\btype\s*=\s*["']application\/json["']/i.test(attrs)) {
			try {
				const parsed = JSON.parse(m[2] ?? "") as ManifestLite;
				if (parsed && typeof parsed === "object") return { ...parsed, params: parsed.params && typeof parsed.params === "object" ? parsed.params : {} };
			} catch {
				return null;
			}
		}
	}
	return null;
}

function scenesOf(snapshot: ProjectSnapshot) {
	const scenes = snapshot.scenes ?? [];
	return scenes.find((scene) => scene.id === snapshot.currentSceneId) ?? scenes.find((scene) => scene.isMain) ?? scenes[0] ?? null;
}

/** Every composition clip on the active scene, in time order. Manifests: custom ones from their own source. */
export function listCompositions(snapshot: ProjectSnapshot, libraryManifests: Record<string, ManifestLite | null> = {}): CompositionTarget[] {
	const scene = scenesOf(snapshot);
	const tracks: SnapshotTrack[] = [...(scene?.tracks?.overlay ?? []), ...(scene?.tracks?.main ? [scene.tracks.main] : [])];
	const out: CompositionTarget[] = [];
	for (const track of tracks) {
		for (const element of track.elements ?? []) {
			const stored = storedComposition(element);
			if (!stored) continue;
			const effect = (element.restorff as { effect?: { id?: string; name?: string; layer?: string; fed_from_matte?: string[] } } | undefined)?.effect ?? null;
			const custom = stored.custom === true && typeof stored.source === "string";
			const manifest = custom ? manifestOf(stored.source) : (libraryManifests[stored.name ?? ""] ?? null);
			out.push({
				element_id: element.id,
				track_id: track.id,
				track: track.name ?? null,
				start: r3(element.startTime / TICKS),
				end: r3((element.startTime + element.duration) / TICKS),
				custom,
				name: stored.name ?? manifest?.name ?? "composition",
				title: stored.title ?? manifest?.title ?? element.name ?? stored.name ?? "composition",
				props: { ...(stored.props ?? {}) },
				source: custom ? (stored.source as string) : null,
				hash: stored.hash ?? null,
				words: compositionTexts(element),
				layered: !!effect && (!!effect.layer || !!effect.fed_from_matte?.length),
				effect: effect ? { id: effect.id, name: effect.name, layer: effect.layer } : null,
				manifest,
			});
		}
	}
	return out.sort((a, b) => a.start - b.start || a.element_id.localeCompare(b.element_id));
}

// ─── "the titles", "all the cards" ──────────────────────────────────────────────────────────────────────────────

export type CompositionKind = "title" | "card" | "chart" | "any";

const KIND_WORDS: Record<Exclude<CompositionKind, "any">, RegExp> = {
	title: /title|headline|type|word|text|kinetic|masthead|cover|lower-?third|quote|caption-stack|ignite|zoom-through|strike|emphasis|letter|wall/i,
	card: /card|pill|badge|ui|glass|panel|checklist|toc|list|notification|comment|phone|prompt|chip|form|stamp|sticker/i,
	chart: /chart|graph|curve|counter|bar|grow|meter|number|stat|waveform/i,
};

/** Nouns a person uses for compositions, → which kind. Captions are never compositions. */
const NOUNS: Array<{ re: RegExp; kind: CompositionKind; label: string }> = [
	{ re: /\b(titles?|headlines?|title cards?|big words?|kinetic type|the type|words on screen|lower thirds?|mastheads?|text overlays?|on-?screen titles?)\b/, kind: "title", label: "titles" },
	{ re: /\b(cards?|panels?|pills?|badges?|chips?|ui elements?|notifications?)\b/, kind: "card", label: "cards" },
	{ re: /\b(charts?|graphs?|curves?|counters?|stats?|bars?)\b/, kind: "chart", label: "charts" },
	{ re: /\b(compositions?|motion graphics?|graphics|overlays?|animations?|motion|effects on top|all the effects|everything on top)\b/, kind: "any", label: "compositions" },
];

/** Generic words never used to match a composition by its own name. */
const GENERIC = new Set(["halcyon", "the", "and", "with", "card", "cards", "title", "titles", "type", "word", "words", "text", "beat", "custom", "composition", "code", "pop", "line", "lines", "big", "small"]);

/** Title / card / chart by the composition's name, title and tags (its description only when those say nothing). */
export function classify(target: CompositionTarget): Set<CompositionKind> {
	const kinds = new Set<CompositionKind>(["any"]);
	const read = (hay: string) => {
		for (const [kind, re] of Object.entries(KIND_WORDS) as Array<[Exclude<CompositionKind, "any">, RegExp]>) if (re.test(hay)) kinds.add(kind);
	};
	read([target.name, target.title, ...(target.manifest?.tags ?? [])].join(" "));
	if (kinds.size === 1) read(target.manifest?.description ?? "");
	return kinds;
}

const sizeKey = (target: CompositionTarget) => paramFor(target, "size");

export interface Picked {
	targets: CompositionTarget[];
	/** What the clause called them ("titles", "the counter", "this composition"). */
	noun: string;
	/** The noun's words, to take out of the clause. */
	words: string;
	/** How they were chosen, said back to the caller. */
	how: string;
}

/**
 * Which compositions a clause is about. `within` = the span the clause is scoped to (only compositions overlapping
 * it); `element` = the element_id the call named, when it is a composition. Null = the clause names none.
 */
export function pickCompositions(clause: string, all: CompositionTarget[], opts: { within?: { start: number; end: number } | null; element?: CompositionTarget | null } = {}): Picked | null {
	const inSpan = (target: CompositionTarget) => !opts.within || (target.start < opts.within.end - 1e-6 && target.end > opts.within.start + 1e-6);
	const pool = all.filter(inSpan);
	if (/\bcaptions?\b|\bsubtitles?\b/.test(clause) && !NOUNS.some((noun) => noun.re.test(clause))) return null;
	// one composition by its own name first: "the counter", "the map", "the stamp" (a class noun must not widen it)
	const tokens = clause.split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !GENERIC.has(token));
	for (const token of tokens) {
		if (!new RegExp(`\\bthe ${token}s?\\b`).test(clause)) continue;
		const byName = pool.filter((target) => target.name.toLowerCase().split(/[^a-z0-9]+/).includes(token) || target.title.toLowerCase().split(/[^a-z0-9]+/).includes(token));
		if (byName.length) return { targets: byName, noun: `the ${token}`, words: clause.match(new RegExp(`\\bthe ${token}s?\\b`))?.[0] ?? `the ${token}`, how: `compositions named "${token}"` };
	}
	for (const noun of NOUNS) {
		const m = clause.match(noun.re);
		if (!m) continue;
		let targets = noun.kind === "any" ? pool : pool.filter((target) => classify(target).has(noun.kind));
		let how = noun.kind === "any" ? "every composition" : `compositions whose name says ${noun.label.replace(/s$/, "")}`;
		if (!targets.length && noun.kind === "title") {
			// no composition is named like a title: the ones that put words on screen and can change size
			targets = pool.filter((target) => target.words.length > 0 && (sizeKey(target) || !target.manifest));
			how = "compositions that put words on screen";
		}
		if (opts.element && targets.some((target) => target.element_id === opts.element?.element_id) && /\b(this|that|it)\b/.test(clause)) targets = [opts.element];
		return { targets, noun: noun.label, words: m[0], how };
	}
	if (opts.element) return { targets: [opts.element], noun: "this composition", words: "", how: "the element_id you sent" };
	return null;
}

// ─── nudges ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const COLOR_NAMES: Record<string, string> = {
	neon: "#F6FF00",
	yellow: "#F6FF00",
	bone: "#EDEBE6",
	white: "#FFFFFF",
	black: "#0C0C0E",
	kiln: "#C8553D",
	rust: "#C8553D",
	ember: "#FF5A1F",
	red: "#E5484D",
	orange: "#E8A33D",
	amber: "#E8A33D",
	gold: "#E8B04B",
	cream: "#F4E9DA",
	green: "#3DD68C",
	teal: "#2BB3A8",
	blue: "#4C8DFF",
	purple: "#8E6CFF",
	pink: "#FF5FA2",
	grey: "#8C8C95",
	gray: "#8C8C95",
	fog: "#8C8C95",
};
const COLOR_WORD_RE = new RegExp(`(#[0-9a-f]{6}\\b|#[0-9a-f]{3}\\b|\\b(${Object.keys(COLOR_NAMES).join("|")})\\b)`, "i");
const EASE_LADDER = ["smooth", "snappy", "bouncy", "springy", "elastic"];

/** What a clause asks of a composition. */
export interface NudgeWords {
	size?: number;
	speed?: number;
	colour?: { hex: string; word: string; part: "accent" | "text" | "background" | "any" } | { ask: true; part: "accent" | "text" | "background" | "any" };
	ease?: "smooth" | "snappy" | "bouncier";
	move?: "up" | "down";
	exit?: boolean;
	length?: number;
	/** The words that matched, for the label. */
	said: string[];
}

export function nudgeWords(clause: string): NudgeWords | null {
	const c = ` ${clause.toLowerCase()} `;
	const out: NudgeWords = { said: [] };
	const strong = /\b(much|way|a lot|lots|really|super|very|even|extra)\b/.test(c);
	const slight = /\b(slightly|a bit|a little|a touch|bit)\b/.test(c);
	if (/\b(huge|giant|massive|enormous|double the size)\b/.test(c)) (out.size = 1.35), out.said.push("much bigger");
	else if (/\b(bigger|larger|big|large|increase|grow|scale up)\b/.test(c)) (out.size = strong ? 1.35 : slight ? 1.08 : 1.15), out.said.push("bigger");
	else if (/\b(tiny)\b/.test(c)) (out.size = 0.7), out.said.push("much smaller");
	else if (/\b(smaller|small|shrink|reduce|scale down)\b/.test(c)) (out.size = strong ? 0.7 : slight ? 0.93 : 0.87), out.said.push("smaller");
	if (/\b(slow(er)?|slow (it|this|that|them)( right)? down|less rushed|take (its|their) time|calmer pace)\b/.test(c) && !/\bslow[- ]?mo/.test(c)) (out.speed = strong || /\bhalf\b/.test(c) ? 0.6 : 0.8), out.said.push("slower");
	else if (/\b(faster|quicker|speed (it|this|that|them)? ?up|snappier pace|more rushed)\b/.test(c)) (out.speed = strong ? 1.6 : 1.25), out.said.push("faster");
	const part: "accent" | "text" | "background" | "any" = /\b(background|bg|plate|backing|card colou?r|panel)\b/.test(c)
		? "background"
		: /\b(text|letters|type|font|ink|words?)\s+colou?r\b|\bcolou?r of the (text|words|letters)\b/.test(c)
			? "text"
			: /\b(accent|highlight)\b/.test(c)
				? "accent"
				: "any";
	const colour = c.match(COLOR_WORD_RE);
	if (colour) {
		const word = colour[0].toLowerCase();
		const hex = word.startsWith("#") ? word.toUpperCase() : COLOR_NAMES[word];
		if (hex) (out.colour = { hex, word, part }), out.said.push(`colour ${word}`);
	} else if (/\b(colou?rs?|recolou?r|palette|hue|accent)\b/.test(c)) {
		out.colour = { ask: true, part };
		out.said.push("colour");
	}
	if (/\b(calmer|less bouncy|less bounce|gentler|subtler|more subtle|softer motion|smoother)\b/.test(c)) (out.ease = "smooth"), out.said.push("calmer motion");
	else if (/\b(bouncier|more bounce|more playful|springier)\b/.test(c)) (out.ease = "bouncier"), out.said.push("bouncier");
	else if (/\b(snappier|punchier|sharper|more punch)\b/.test(c)) (out.ease = "snappy"), out.said.push("snappier");
	if (/\bmove (it |this |them )?up\b|\bhigher\b|\btowards? the top\b|\bup a (bit|little)\b/.test(c)) (out.move = "up"), out.said.push("move up");
	else if (/\bmove (it |this |them )?down\b|\blower\b|\btowards? the bottom\b|\bdown a (bit|little)\b/.test(c)) (out.move = "down"), out.said.push("move down");
	if (/\bno exit\b|\bstay on screen\b|\bdon'?t animate out\b|\bhold (it )?at the end\b/.test(c)) (out.exit = false), out.said.push("no exit");
	else if (/\banimate (it |them )?out\b|\bwith an exit\b/.test(c)) (out.exit = true), out.said.push("animate out");
	if (/\b(longer|hold (it|them) longer|last longer|stay longer)\b/.test(c)) (out.length = strong ? 1.5 : 1.25), out.said.push("longer");
	else if (/\b(shorter|cut (it|them) shorter|less time on screen)\b/.test(c)) (out.length = 0.8), out.said.push("shorter");
	return out.said.length ? out : null;
}

const SIZE_KEYS = ["scale", "titleScale", "textScale", "size", "fontScale", "wordScale", "typeScale"];
const SPEED_KEYS = ["speed", "pace", "tempo"];
const EASE_KEYS = ["ease", "easing", "motion"];

/** The param that carries a nudge on this composition: from its manifest, else from the props it has stored. */
export function paramFor(target: CompositionTarget, what: "size" | "speed" | "ease" | "offsetY" | "anchor" | "exit"): string | null {
	const specs = target.manifest?.params ?? {};
	const has = (key: string, type?: string) => (specs[key] ? !type || specs[key]?.type === type : !target.manifest && key in target.props);
	const numeric = (key: string) => has(key, "number") || (!target.manifest && typeof target.props[key] === "number");
	if (what === "size") return SIZE_KEYS.find(numeric) ?? Object.keys(specs).find((key) => /scale$|size$/i.test(key) && specs[key]?.type === "number") ?? null;
	if (what === "speed") return SPEED_KEYS.find(numeric) ?? Object.keys(specs).find((key) => /speed$/i.test(key) && specs[key]?.type === "number") ?? null;
	if (what === "ease") return EASE_KEYS.find((key) => has(key, "easing") || has(key, "enum") || (!target.manifest && typeof target.props[key] === "string")) ?? null;
	if (what === "offsetY") return numeric("offsetY") ? "offsetY" : null;
	if (what === "anchor") return has("anchor", "enum") ? "anchor" : null;
	return has("exit", "boolean") || (!target.manifest && typeof target.props.exit === "boolean") ? "exit" : null;
}

/** Colour params, best first for the part named. */
export function colourParams(target: CompositionTarget, part: "accent" | "text" | "background" | "any"): string[] {
	const specs = target.manifest?.params ?? {};
	const keys = target.manifest ? Object.keys(specs).filter((key) => specs[key]?.type === "color") : Object.keys(target.props).filter((key) => typeof target.props[key] === "string" && /^#[0-9a-f]{3,8}$/i.test(String(target.props[key])));
	const rank = (key: string) => {
		const k = key.toLowerCase();
		if (part === "background") return /^(bg|background|plate|card|panel|paper)/.test(k) ? 0 : 9;
		if (part === "text") return /^(color|text|textcolor|ink|fg|title(color)?|word(color)?)$/.test(k) ? 0 : /text|ink|title|word/.test(k) ? 1 : 9;
		if (part === "accent") return k === "accent" ? 0 : /accent|highlight/.test(k) ? 1 : 9;
		return k === "accent" ? 0 : /accent|highlight|curve|line|stroke|neon/.test(k) ? 1 : /^(color|ink)$/.test(k) ? 2 : /bg|background|plate|shadow/.test(k) ? 8 : 5;
	};
	return [...keys].sort((a, b) => rank(a) - rank(b)).filter((key) => part === "any" || rank(key) < 9);
}

export interface PropChange {
	key: string;
	from: unknown;
	to: unknown;
	because: string;
}

export interface CompositionNudge {
	target: CompositionTarget;
	props: Record<string, unknown>;
	changes: PropChange[];
	/** New length in seconds (a "longer" / "shorter" ask). */
	duration_s?: number;
	/** Words that matched but this composition has no param for (said back, never silently dropped). */
	skipped: string[];
}

function currentValue(target: CompositionTarget, key: string): unknown {
	if (key in target.props) return target.props[key];
	return target.manifest?.params?.[key]?.default;
}

function clampTo(spec: ParamSpecLite | undefined, value: number): number {
	let v = value;
	if (spec?.min != null) v = Math.max(spec.min, v);
	if (spec?.max != null) v = Math.min(spec.max, v);
	const step = spec?.step ?? 0.01;
	return +(Math.round(v / step) * step).toFixed(4);
}

/** Apply the nudge words to one composition: new props + what changed + what it could not do. */
export function nudgeComposition(target: CompositionTarget, words: NudgeWords, canvasHeight = 1920): CompositionNudge {
	const props = { ...target.props };
	const changes: PropChange[] = [];
	const skipped: string[] = [];
	const specs = target.manifest?.params ?? {};
	const scaleBy = (what: "size" | "speed", factor: number, because: string) => {
		const key = paramFor(target, what);
		if (!key) return void skipped.push(`${because}: ${target.title} has no ${what === "size" ? "scale / size" : "speed"} param`);
		const from = Number(currentValue(target, key) ?? 1);
		const to = clampTo(specs[key], (Number.isFinite(from) && from > 0 ? from : 1) * factor);
		if (to === from) return void skipped.push(`${because}: "${key}" is already at its limit (${from})`);
		props[key] = to;
		changes.push({ key, from, to, because });
	};
	if (words.size !== undefined) scaleBy("size", words.size, words.size > 1 ? "bigger" : "smaller");
	if (words.speed !== undefined) scaleBy("speed", words.speed, words.speed < 1 ? "slower" : "faster");
	if (words.colour && "hex" in words.colour) {
		const key = colourParams(target, words.colour.part)[0];
		if (!key) skipped.push(`colour ${words.colour.word}: ${target.title} has no ${words.colour.part === "any" ? "" : `${words.colour.part} `}colour param`);
		else {
			const from = currentValue(target, key);
			if (String(from).toUpperCase() !== words.colour.hex) {
				props[key] = words.colour.hex;
				changes.push({ key, from, to: words.colour.hex, because: `colour ${words.colour.word}` });
			} else skipped.push(`colour ${words.colour.word}: "${key}" is already ${words.colour.hex}`);
		}
	}
	if (words.ease) {
		const key = paramFor(target, "ease");
		if (!key) skipped.push(`${words.ease === "bouncier" ? "bouncier" : words.ease === "smooth" ? "calmer motion" : "snappier"}: ${target.title} has no ease param`);
		else {
			const from = String(currentValue(target, key) ?? "smooth");
			const options = specs[key]?.options;
			let to: string = words.ease === "bouncier" ? (EASE_LADDER[Math.min(EASE_LADDER.length - 1, Math.max(EASE_LADDER.indexOf(from) + 1, 2))] as string) : words.ease;
			if (options && !options.includes(to)) to = options.includes("smooth") && words.ease === "smooth" ? "smooth" : from;
			if (to !== from) {
				props[key] = to;
				changes.push({ key, from, to, because: words.ease === "bouncier" ? "bouncier" : words.ease === "smooth" ? "calmer motion" : "snappier" });
			} else skipped.push(`ease: "${key}" is already ${from}`);
		}
	}
	if (words.move) {
		const offset = paramFor(target, "offsetY");
		const anchor = paramFor(target, "anchor");
		if (offset) {
			const from = Number(currentValue(target, offset) ?? 0);
			const step = Math.round((canvasHeight * 0.04) / 10) * 10;
			const to = clampTo(specs[offset], from + (words.move === "up" ? -step : step));
			props[offset] = to;
			changes.push({ key: offset, from, to, because: `move ${words.move}` });
		} else if (anchor) {
			const order = ["top", "center", "bottom"].filter((o) => specs[anchor]?.options?.includes(o) ?? true);
			const from = String(currentValue(target, anchor) ?? "center");
			const i = Math.max(0, order.indexOf(from));
			const to = order[Math.max(0, Math.min(order.length - 1, i + (words.move === "up" ? -1 : 1)))] as string;
			if (to !== from) {
				props[anchor] = to;
				changes.push({ key: anchor, from, to, because: `move ${words.move}` });
			} else skipped.push(`move ${words.move}: already at the ${from}`);
		} else skipped.push(`move ${words.move}: ${target.title} has no offsetY or anchor param`);
	}
	if (words.exit !== undefined) {
		const key = paramFor(target, "exit");
		if (!key) skipped.push(`${words.exit ? "animate out" : "no exit"}: ${target.title} has no exit param`);
		else if (currentValue(target, key) !== words.exit) {
			changes.push({ key, from: currentValue(target, key), to: words.exit, because: words.exit ? "animate out" : "no exit" });
			props[key] = words.exit;
		}
	}
	let duration: number | undefined;
	if (words.length !== undefined) {
		const length = target.end - target.start;
		duration = r3(Math.min(60, Math.max(0.5, length * words.length)));
		changes.push({ key: "duration_s", from: r3(length), to: duration, because: words.length > 1 ? "longer" : "shorter" });
	}
	return { target, props, changes, ...(duration !== undefined ? { duration_s: duration } : {}), skipped };
}

// ─── structural asks ────────────────────────────────────────────────────────────────────────────────────────────

/** A change to how a composition moves (its code), not a param: the recipe answers with get → update. */
export const STRUCTURAL_RE =
	/\b(transitions?|loops?|looping|seamless(ly)?|entrances?|enter differently|intro animation|exit animation|animate (it |them )?(in|out) (differently|like|with)|different animation|rewrite|redesign|re-?animate|layout|camera|instead of|replace the animation|morph|choreograph)\b/;

export function isStructural(clause: string): boolean {
	return STRUCTURAL_RE.test(clause) || (/\bsmooth(er)?\b/.test(clause) && /\b(cut|exit|entrance|move|motion between|join)\b/.test(clause));
}

/** What to change in the source for a structural ask, in plain words (the Claude edits the code itself). */
export function structuralHint(clause: string): string {
	if (/\bloop/.test(clause)) return "Make the last frames lead back into the first: drop any fade/dip to black at the end, ease the final pose onto the opening pose (same position, scale, camera), and end on a whole step of any repeating motion so frame 0 follows the last frame without a jump.";
	if (/\btransition|smooth|join|cut\b/.test(clause)) return "Soften the exit/entrance in render(): a longer progress window (≈0.7 s instead of ≈0.3 s), a 'smooth' ease instead of 'ease-in', smaller scale and blur changes, and no white flash.";
	if (/\bentrance|enter|intro animation|animate (it |them )?in\b/.test(clause)) return "Change the entrance in render(): the progress window, ease and from-values of the first ~0.6 s.";
	if (/\bexit|animate (it |them )?out\b/.test(clause)) return "Change the exit in render(): use time.left to time it (the seconds until the last frame).";
	return "Edit the source's render(time, RC) where that motion is drawn; keep everything a pure function of time.";
}

// ─── history: what changed inside compositions between two snapshots ───────────────────────────────────────────

export interface CompositionDiffEntry {
	element_id: string;
	title: string;
	change: "added" | "updated" | "removed";
	/** "accent: #F6FF00 → #FF5A1F" */
	props?: string[];
	/** "+17 −4 lines (133 lines)" when the code changed. */
	source?: string;
	/** "converted to custom code" etc. */
	note?: string;
}

function lineCount(source: string | undefined): number {
	return source ? source.split("\n").length : 0;
}

/** +added −removed lines between two sources (multiset of lines: cheap, order-blind, good enough for a note). */
export function sourceLineDiff(before: string, after: string): { added: number; removed: number } {
	const count = (text: string) => {
		const map = new Map<string, number>();
		for (const line of text.split("\n")) map.set(line.trim(), (map.get(line.trim()) ?? 0) + 1);
		return map;
	};
	const a = count(before);
	const b = count(after);
	let added = 0;
	let removed = 0;
	for (const [line, k] of b) added += Math.max(0, k - (a.get(line) ?? 0));
	for (const [line, k] of a) removed += Math.max(0, k - (b.get(line) ?? 0));
	return { added, removed };
}

const short = (value: unknown) => {
	if (value === undefined) return "—";
	if (typeof value === "string" && value.startsWith("data:")) return "(an image)";
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > 40 ? `${text.slice(0, 37)}…` : text;
};

function compositionsById(snapshot: ProjectSnapshot | null): Map<string, { stored: StoredComposition; element: SnapshotElement }> {
	const map = new Map<string, { stored: StoredComposition; element: SnapshotElement }>();
	if (!snapshot) return map;
	for (const scene of snapshot.scenes ?? []) {
		const tracks = [...(scene.tracks?.overlay ?? []), ...(scene.tracks?.main ? [scene.tracks.main] : [])];
		for (const track of tracks) for (const element of track.elements ?? []) {
			const stored = storedComposition(element);
			if (stored) map.set(element.id, { stored, element });
		}
	}
	return map;
}

/** Library composition names in a snapshot (to read their params blocks for defaults). */
export function libraryNamesIn(snapshot: ProjectSnapshot | null): string[] {
	return [...compositionsById(snapshot).values()].filter(({ stored }) => !stored.custom && stored.name).map(({ stored }) => stored.name as string);
}

/**
 * Props before → after and source line counts for every composition that differs between two snapshots. A prop the
 * clip never stored reads as its default (custom: from its own params block; library: from `libraryManifests`).
 */
export function compositionDiff(before: ProjectSnapshot | null, after: ProjectSnapshot | null, libraryManifests: Record<string, ManifestLite | null> = {}): CompositionDiffEntry[] {
	const a = compositionsById(before);
	const b = compositionsById(after);
	const out: CompositionDiffEntry[] = [];
	const defaultOf = (stored: StoredComposition, key: string) => {
		const manifest = stored.custom ? manifestOf(stored.source) : libraryManifests[stored.name ?? ""];
		return manifest?.params?.[key]?.default;
	};
	for (const [id, { stored, element }] of b) {
		const old = a.get(id)?.stored;
		const title = stored.title ?? element.name ?? stored.name ?? "composition";
		if (!old) {
			out.push({ element_id: id, title, change: "added", ...(stored.custom && stored.source ? { source: `${lineCount(stored.source)} lines of code` } : {}) });
			continue;
		}
		if (old.hash && stored.hash && old.hash === stored.hash && JSON.stringify(old.props ?? {}) === JSON.stringify(stored.props ?? {})) continue;
		const props: string[] = [];
		const keys = new Set([...Object.keys(old.props ?? {}), ...Object.keys(stored.props ?? {})]);
		for (const key of keys) {
			const x = old.props?.[key] ?? defaultOf(old, key);
			const y = stored.props?.[key] ?? defaultOf(stored, key);
			if (JSON.stringify(x) !== JSON.stringify(y)) props.push(`${key}: ${short(x)} → ${short(y)}`);
		}
		const oldDur = Number(old.duration);
		const newDur = Number(stored.duration);
		if (Number.isFinite(oldDur) && Number.isFinite(newDur) && Math.abs(oldDur - newDur) > 1e-3) props.push(`duration: ${r3(oldDur)} s → ${r3(newDur)} s`);
		let source: string | undefined;
		let note: string | undefined;
		if (stored.custom && !old.custom) note = "converted to custom code (from the library's source)";
		if (stored.custom && typeof stored.source === "string" && typeof old.source === "string" && stored.source !== old.source) {
			const d = sourceLineDiff(old.source, stored.source);
			source = `+${d.added} −${d.removed} lines (${lineCount(old.source)} → ${lineCount(stored.source)} lines)`;
		}
		if (!props.length && !source && !note) continue;
		out.push({ element_id: id, title, change: "updated", ...(props.length ? { props: props.slice(0, 12) } : {}), ...(source ? { source } : {}), ...(note ? { note } : {}) });
	}
	for (const [id, { stored, element }] of a) if (!b.has(id)) out.push({ element_id: id, title: stored.title ?? element.name ?? stored.name ?? "composition", change: "removed" });
	return out;
}
