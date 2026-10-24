/**
 * Zeigarnik → storyboard spec, for the storyboard compiler (./storyboard.ts).
 *
 *   specFromBoard(boardJson, { brief?, style?, aspect? })  a storyboard BOARD export → StoryboardSpec
 *   specFromBrief(docJson,   { hook?, wordsPerSecond? })    a brief DOC export      → StoryboardSpec
 *
 * Input: Zeigarnik's JSON export — `GET /api/boards/<id>/export?format=json` (the raw state), the MCP tool
 * `boards {action: "export", format: "json"}` (its payload wraps the state in `board`), or `GET /api/boards/<id>`
 * (`{board}`). Not the `boards get` outline: it flattens the cards to text.
 *
 * Board shape (zeigarnik/src/ops.mjs, templates.mjs): columns titled "S01 · Hook" holding shot cards whose content is
 * exactly {shot, visual, words, purpose, duration, image?}. The card schema has no emphasis / effect / sound fields, so
 * they are read out of the text (README "Compiler: storyboard → v0" lists the conventions):
 *   - words "(sound only: the crack)" → no line, sound cue "the crack"; any other "(…)" is a direction, not spoken;
 *   - "*word*" in the words → emphasis; any number in the line ("18", "30 %") is emphasis too;
 *   - "SFX: whoosh" / "Sound: …", "FX: Digital Zoom, whip", "Emphasis: smooth" anywhere in visual or purpose;
 *   - camera words in the visual ("slow push", "pan left", "slow-motion") are read by the compiler itself;
 *   - a column or shot titled "End card" (or a purpose starting "CTA") is the end card.
 * Pure: no I/O. Fictional demo content only (Halcyon Cold Brew).
 */
import type { StoryboardBeat, StoryboardSpec } from "./storyboard.ts";

export interface BoardSpecOptions {
	/** A brief doc export (the same shapes specFromBrief takes): fills the CTA, hooks and claims. */
	brief?: unknown;
	/** Editing-style preset id for the compiler. */
	style?: string | null;
	/** "9:16" (default). */
	aspect?: string;
}

export interface BriefSpecOptions {
	/** Which hook opens the cut: "H1" (default), "H2", "H3", or an index from 0. */
	hook?: string | number;
	/** For duration hints from word counts. Default 2.6. */
	wordsPerSecond?: number;
	style?: string | null;
	aspect?: string;
}

interface ZCard {
	id: string;
	type: string;
	x?: number;
	y?: number;
	parent?: string | null;
	order?: number;
	content?: Record<string, unknown>;
}

interface ZBlock {
	id: string;
	type: string;
	position?: number;
	content?: Record<string, unknown>;
}

interface ZComment {
	id: string;
	target?: string | null;
	text?: string;
	resolved?: boolean;
}

interface ZState {
	id?: string;
	title?: string;
	kind?: string;
	version?: number;
	cards?: Record<string, ZCard> | ZCard[];
	blocks?: Record<string, ZBlock> | ZBlock[];
	comments?: Record<string, ZComment>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The state inside any of the export wrappers. */
function unwrap(input: unknown): ZState {
	let value: unknown = input;
	if (typeof value === "string") value = JSON.parse(value);
	for (let i = 0; i < 3 && isObject(value); i++) {
		if (isObject(value.payload)) value = value.payload;
		else if (isObject(value.board) && !("cards" in value && isObject(value.cards))) value = value.board;
		else break;
	}
	if (!isObject(value)) throw new Error("expected a Zeigarnik board/doc JSON export (an object)");
	return value as ZState;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Same number words as the compiler: emphasis on digits only. */
function numberTokens(line: string): string[] {
	return line
		.split(/[\s\-–—/]+/)
		.map((token) => token.replace(/[^0-9a-z%.,]/gi, "").replace(/[.,]+$/, ""))
		.filter((token) => /\d/.test(token))
		.map((token) => token.replace(/%$/, ""));
}

export interface ParsedLine {
	/** What is spoken (directions and markup removed). */
	line: string;
	sound?: string;
	directions: string[];
	emphasis: string[];
}

/** "(sound only: the crack)" → sound cue; "(beat)" → direction; "*smooth*" → emphasis. */
export function parseWords(words: string): ParsedLine {
	const directions: string[] = [];
	let sound: string | undefined;
	const emphasis: string[] = [];
	const withoutDirections = words.replace(/[([]([^)\]]*)[)\]]/g, (_match, inner: string) => {
		const cue = /^\s*(?:sound|sfx|fx sound)(?:\s+only)?\s*[:\-–]\s*(.+)$/i.exec(inner);
		if (cue) sound = cue[1].trim();
		else if (inner.trim()) directions.push(inner.trim());
		return " ";
	});
	const line = withoutDirections
		.replace(/\*([^*]+)\*/g, (_match, inner: string) => {
			emphasis.push(inner.trim());
			return inner;
		})
		.replace(/\s+/g, " ")
		.trim();
	for (const number of numberTokens(line)) if (!emphasis.includes(number)) emphasis.push(number);
	return { line, sound, directions, emphasis };
}

function labelled(text: string, labels: string): string[] {
	const re = new RegExp(`\\b(?:${labels})\\s*:\\s*([^.;\\n]+)`, "gi");
	const found: string[] = [];
	for (const match of text.matchAll(re)) {
		for (const part of match[1].split(/,|\+|&|\band\b/)) if (part.trim()) found.push(part.trim());
	}
	return found;
}

/** The multi-word named effects of EFFECTS.md (single words like "Orbit" need an explicit "FX:" label). */
const NAMED_EFFECTS = [
	"Couch Wall", "UI World", "Frame Break", "Digital Zoom", "Phone Mockup", "Headline Wall", "Zoom Through Cut",
	"Chart Grow", "Pullback Reveal", "Green Screen", "Paper Cut", "Doodle Boil", "Cover Story", "Glass Type",
];

const COLUMN_TITLE = /^\s*([A-Za-z]{0,3}\d{1,3}[A-Za-z]?)\s*(?:[·:|]|\s[-–—]\s)\s*(.*)$/;
const END_CARD = /\bend[- ]?card\b|\bpackshot\b|\boutro\b/i;

export function specFromBoard(input: unknown, options: BoardSpecOptions = {}): StoryboardSpec {
	const state = unwrap(input);
	if (state.kind === "doc") throw new Error("this is a Zeigarnik doc (a brief): use specFromBrief");
	if (Array.isArray(state.cards)) {
		throw new Error("this looks like the `boards get` outline (cards flattened to text): pass the JSON export (boards export, format json)");
	}
	const cards = Object.values(state.cards ?? {});
	if (!cards.length) throw new Error("the board has no cards");
	const comments = Object.values(state.comments ?? {}).filter((comment) => !comment.resolved && comment.text);
	const childrenOf = (id: string) =>
		cards
			.filter((card) => card.parent === id)
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	// beat sources: columns (with their shot cards) and loose shot cards, left to right
	const sources = cards
		.filter((card) => !card.parent && (card.type === "column" || card.type === "shot"))
		.sort((a, b) => (a.x ?? 0) - (b.x ?? 0) || (a.y ?? 0) - (b.y ?? 0));
	const notes: string[] = [];
	const beats: StoryboardBeat[] = [];
	const ids = new Set<string>();
	sources.forEach((source, n) => {
		const shots = source.type === "column" ? childrenOf(source.id).filter((card) => card.type === "shot") : [source];
		const images = source.type === "column" ? childrenOf(source.id).filter((card) => card.type === "image") : [];
		const columnTitle = source.type === "column" ? str(source.content?.title) : "";
		if (!shots.length) {
			notes.push(`column "${columnTitle || source.id}" has no shot card: skipped`);
			return;
		}
		const titleMatch = COLUMN_TITLE.exec(columnTitle);
		const first = shots[0].content ?? {};
		let id = str(first.shot).trim() || titleMatch?.[1] || `S${String(n + 1).padStart(2, "0")}`;
		while (ids.has(id)) id = `${id}b`;
		ids.add(id);
		const title = titleMatch ? titleMatch[2].trim() : columnTitle.trim() || undefined;
		const parsed = shots.map((shot) => parseWords(str(shot.content?.words)));
		const visuals = shots.map((shot) => str(shot.content?.visual)).filter(Boolean);
		const purposes = shots.map((shot) => str(shot.content?.purpose)).filter(Boolean);
		const text = [...visuals, ...purposes].join(". ");
		const durations = shots.map((shot) => shot.content?.duration).filter((value): value is number => typeof value === "number" && value > 0);
		const effects = [
			...labelled(text, "fx|effects?"),
			...NAMED_EFFECTS.filter((name) => new RegExp(`\\b${name.replace(/ /g, "[ -]")}\\b`, "i").test(text)),
		];
		const sound = parsed.map((entry) => entry.sound).find(Boolean) ?? labelled(text, "sfx|sound")[0];
		const emphasis = [...new Set([...parsed.flatMap((entry) => entry.emphasis), ...labelled(text, "emphasis")])];
		const line = parsed.map((entry) => entry.line).filter(Boolean).join(" ");
		const assets = [
			...shots.map((shot) => str(shot.content?.image)).filter(Boolean),
			...images.map((card) => str(card.content?.url)).filter(Boolean),
		];
		const targetIds = new Set([source.id, ...shots.map((shot) => shot.id)]);
		const beatNotes = [
			...purposes,
			...parsed.flatMap((entry) => entry.directions.map((direction) => `direction: ${direction}`)),
			...comments.filter((comment) => comment.target && targetIds.has(comment.target)).map((comment) => `open comment: ${comment.text}`),
		];
		const endCard = END_CARD.test(`${title ?? ""} ${visuals.join(" ")}`) || purposes.some((purpose) => /^\s*cta\b/i.test(purpose));
		beats.push({
			id,
			...(title ? { title } : {}),
			...(visuals.length ? { shot: visuals.join(" / ") } : {}),
			...(line ? { line } : {}),
			...(emphasis.length ? { emphasis } : {}),
			...(effects.length ? { effects: [...new Set(effects)] } : {}),
			...(sound ? { sound } : {}),
			...(assets.length ? { assets } : {}),
			...(durations.length ? { duration: Math.round(durations.reduce((a, b) => a + b, 0) * 1000) / 1000 } : {}),
			kind: endCard ? "end_card" : "beat",
			...(endCard && line ? { cta: line } : {}),
			...(beatNotes.length ? { notes: beatNotes } : {}),
		});
	});
	// only the last end-card-looking beat is the end card
	let seenEnd = false;
	for (let i = beats.length - 1; i >= 0; i--) {
		if (beats[i].kind !== "end_card") continue;
		if (seenEnd) {
			beats[i].kind = "beat";
			delete beats[i].cta;
		}
		seenEnd = true;
	}

	const spec: StoryboardSpec = {
		...(state.title ? { title: state.title } : {}),
		aspect: options.aspect ?? "9:16",
		style: options.style ?? null,
		beats,
		source: { kind: "board", ...(state.id ? { id: state.id } : {}), ...(typeof state.version === "number" ? { version: state.version } : {}), ...(state.title ? { title: state.title } : {}) },
		...(notes.length ? { notes } : {}),
	};
	const endBeat = beats.find((beat) => beat.kind === "end_card");
	if (endBeat?.cta) spec.cta = endBeat.cta;
	if (options.brief !== undefined) {
		const brief = specFromBrief(options.brief);
		if (brief.cta) spec.cta = brief.cta;
		if (brief.hooks?.length) spec.hooks = brief.hooks;
		if (brief.claims?.length) spec.claims = brief.claims;
		if (endBeat && brief.cta) endBeat.cta = brief.cta;
	}
	return spec;
}

/** Section name of a heading ("Hooks", "Hold", "CTA", "Claims"…), lower-case. */
function section(text: string): string {
	const t = text.trim().toLowerCase();
	if (/^hooks?\b/.test(t)) return "hooks";
	if (/^hold\b|^body\b|^script\b/.test(t)) return "hold";
	if (/^cta\b|call to action/.test(t)) return "cta";
	if (/^claims?\b/.test(t)) return "claims";
	return t;
}

function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

export function specFromBrief(input: unknown, options: BriefSpecOptions = {}): StoryboardSpec {
	const state = unwrap(input);
	if (state.kind === "board") throw new Error("this is a Zeigarnik board: use specFromBoard");
	if (Array.isArray(state.blocks) && state.blocks.some((block) => !isObject(block.content))) {
		throw new Error("this looks like the `boards get` outline (blocks flattened to text): pass the JSON export");
	}
	const blocks = (Array.isArray(state.blocks) ? state.blocks : Object.values(state.blocks ?? {}))
		.slice()
		.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	let title = state.title;
	let current = "";
	const hooks: Array<{ id: string; text: string }> = [];
	const hold: string[] = [];
	const cta: string[] = [];
	const claims: Array<{ claim: string; proof: string; status: string }> = [];
	for (const block of blocks) {
		const content = block.content ?? {};
		if (block.type === "heading") {
			const level = typeof content.level === "number" ? content.level : 2;
			if (level <= 1) title = str(content.text) || title;
			else current = section(str(content.text));
			continue;
		}
		const texts =
			block.type === "list" && Array.isArray(content.items)
				? (content.items as unknown[]).map(str).filter(Boolean)
				: [str(content.text)].filter(Boolean);
		if (current === "hooks") {
			for (const text of texts) hooks.push({ id: str(content.cite) || `H${hooks.length + 1}`, text });
		} else if (current === "hold") {
			if (block.type !== "todo") hold.push(...texts);
		} else if (current === "cta") {
			if (block.type !== "todo") cta.push(...texts);
		} else if (current === "claims" && block.type === "table" && Array.isArray(content.rows)) {
			const rows = (content.rows as unknown[]).filter(Array.isArray) as unknown[][];
			for (const row of content.header === false ? rows : rows.slice(1)) {
				claims.push({ claim: str(row[0]), proof: str(row[1]), status: str(row[2]) });
			}
		}
	}
	const wps = options.wordsPerSecond ?? 2.6;
	const estimate = (line: string) => Math.max(1.2, Math.round((line.split(/\s+/).filter(Boolean).length / wps + 0.4) * 10) / 10);
	const hookPick =
		typeof options.hook === "number"
			? hooks[options.hook]
			: hooks.find((hook) => hook.id.toLowerCase() === String(options.hook ?? "H1").toLowerCase()) ?? hooks[0];
	const beats: StoryboardBeat[] = [];
	const emphasisOf = (line: string) => {
		const found = parseWords(line).emphasis;
		return found.length ? { emphasis: found } : {};
	};
	if (hookPick) beats.push({ id: hookPick.id, title: "Hook", line: hookPick.text, duration: estimate(hookPick.text), ...emphasisOf(hookPick.text) });
	sentences(hold.join(" ")).forEach((line, i) => {
		beats.push({ id: `B${String(i + 1).padStart(2, "0")}`, title: "Hold", line, duration: estimate(line), ...emphasisOf(line) });
	});
	const ctaText = cta.join(" ").trim();
	if (ctaText) beats.push({ id: "CTA", title: "End card", kind: "end_card", line: ctaText, cta: ctaText, duration: Math.max(2.5, estimate(ctaText)) });
	return {
		...(title ? { title } : {}),
		aspect: options.aspect ?? "9:16",
		style: options.style ?? null,
		beats,
		...(ctaText ? { cta: ctaText } : {}),
		...(hooks.length ? { hooks } : {}),
		...(claims.length ? { claims } : {}),
		source: { kind: "brief", ...(state.id ? { id: state.id } : {}), ...(typeof state.version === "number" ? { version: state.version } : {}), ...(title ? { title } : {}) },
	};
}
