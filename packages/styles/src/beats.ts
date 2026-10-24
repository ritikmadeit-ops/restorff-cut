/**
 * explainer-v2 (2026-10-20, SUMMARY gap 13) — an explainer's script as BEATS {line, picture, tag}, bound by what each
 * line is about, and the pacing a feel asks for.
 *
 * The paper-collage recreation (docs/restorff/recreations/paper-collage/REPORT.md) found the v1 plan pairing lines,
 * pictures and tags by position: "Poured at the cafe on day 5" over the farm, every tag the cut-off topic, the title
 * tiles showing the number answer. Here:
 *   - scriptOf(): the lines, from `answers.beats` (strings or {line, picture?, tag?}), else the narration's sentences,
 *     else made from the title / places / dates / verdict (said so)
 *   - bindBeats(): each line → the pictures whose NAME, CAPTION or TAGS share its subject (farm, roastery, bottle,
 *     café, brew…: exact words, a small subject lexicon, the places answer as a boost); nothing matching = said so,
 *     never cycled; tags from the places, dates and subjects a line names — never the topic string
 *   - pacingFor() / beatLengths(): the feel's shot length and cuts per 10 s, beats sized to their reading time (and to
 *     a `length_s` answer), split into shots of the feel's length
 * Pure and deterministic. Fictional Halcyon examples only.
 */
import type { ExplainerAnswers, ExplainerAsset } from "./explainer.ts";

/** One beat as the person (or their Claude) wrote it. */
export interface BeatInput {
	line: string;
	/** A picture for this line: a media id or a picture name (overrides the subject match). */
	picture?: string;
	/** The label tag for this line (overrides the one made from places / dates / subjects). */
	tag?: string;
}

/** The answers the v2 plan reads: v1's, plus beats as objects, narration, a title and a length. */
export type ExplainerAnswersV2 = Omit<ExplainerAnswers, "beats"> & {
	beats?: Array<string | BeatInput>;
	/** A narration script: its sentences become the beats when `beats` is not given. */
	narration?: string;
	/** The title (the letter tiles use its key word, ≤ 10 letters). Default: beat 0's line. */
	title?: string;
	/** Target length in seconds; beats stretch (more shots) or tighten (to their reading time) to fit. */
	length_s?: number;
};

/** A picture the build may use, with what the person said about it. */
export interface PictureAsset extends ExplainerAsset {
	caption?: string;
	tags?: string[];
	/** The still has a transparent background (a cut-out already): PNG / WebP / GIF with alpha. */
	alpha?: boolean;
	/** Its average colour (the server measures it): the plan picks the paper ground that differs most from it, so the
	 * cut between the photo and the next paper shot is visible. */
	tone?: [number, number, number];
}

export interface ScriptBeat {
	line: string;
	picture?: string;
	tag?: string;
}

export interface PictureMatch {
	id: string;
	name: string;
	score: number;
	/** Why, in words: "'cafe' in its name; the place Cafe". */
	why: string;
}

export interface BoundBeat {
	index: number;
	line: string;
	/** Best first; empty when nothing matches. */
	pictures: PictureMatch[];
	/** The label tag ("" = none). */
	tag: string;
	tagFrom: "given" | "places" | "dates" | "place+date" | "subject" | "none";
	/** Subject groups the line names (farm, roastery, bottle, cafe, brew…). */
	subjects: string[];
	places: string[];
	dates: Array<{ date: string; text: string }>;
	/** The picture was named by the person (beats[i].picture). */
	explicit: boolean;
	/** Plain words when no picture matched (the build says it, instead of cycling pictures). */
	unmatched?: string;
}

// ─── words ──────────────────────────────────────────────────────────────────────────────────────────────────────

const STOP = new Set(
	"a an the and or but of to in on at by for from with into onto over under up down out off is are was were be been being it its it's this that these those there here then than so as one two three our we you your they their them he she his her how what why when where who which just all any each every some most more no not only own same too very can will would should could do does did done has have had get gets got make makes made goes go going come comes per via about after before again once also still even far near new old big small first last next week weeks day days time times way ways".split(
		" ",
	),
);
/** Words of file names that say nothing about the subject. */
const FILE_WORDS = new Set(["jpg", "jpeg", "png", "webp", "gif", "mp4", "mov", "webm", "mkv", "img", "image", "photo", "pic", "still", "clip", "video", "final", "copy", "edit", "v1", "v2", "v3"]);

/** Lower case, accents off ("café" → "cafe"). */
function plain(text: string): string {
	return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** A crude English stem: roasted → roast, bottled / bottle / bottling → bottl, cafes → cafe, metres → metr. */
export function stem(word: string): string {
	let w = plain(word).replace(/'s$/, "");
	if (/^\d/.test(w)) return w.replace(/,/g, "");
	if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
	else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
	else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
	else if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
	else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
	if (w.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss)$/.test(w)) w = w.slice(0, -1); // stopp → stop
	if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
	return w;
}

/** The words of a text that can name a subject: stems, no stop words, numbers kept ("1,400" → "1400"). */
export function words(text: string): string[] {
	const out: string[] = [];
	for (const raw of plain(text).match(/[a-z0-9][a-z0-9,']*/g) ?? []) {
		const token = raw.replace(/,(?=\d)/g, "").replace(/[,']+$/, "");
		if (!token || STOP.has(token) || FILE_WORDS.has(token)) continue;
		if (!/^\d/.test(token) && token.length < 3) continue;
		out.push(stem(token));
	}
	return out;
}

/**
 * Subject groups: words that name the same thing in a food / drink / product explainer. A line and a picture that
 * share a group share a subject even with different words ("estate" ~ farm, "roasted" ~ roastery).
 */
const SUBJECT_WORDS: Record<string, string[]> = {
	farm: ["farm", "farmer", "estate", "field", "harvest", "pick", "picker", "grow", "grown", "grower", "plantation", "origin", "highland", "metre", "meter", "altitude", "hill", "cherry", "crop", "orchard", "plant", "soil", "slope"],
	roastery: ["roastery", "roast", "roaster", "oven", "drum"],
	bottle: ["bottle", "bottling", "bottler", "label", "can", "canning", "pack", "package", "packaging", "seal", "cap"],
	cafe: ["cafe", "coffeehouse", "coffeeshop", "shop", "counter", "serve", "barista", "customer", "menu", "store"],
	brew: ["brew", "brewing", "steep", "pour", "glass", "ice", "tap", "keg", "cup", "drink", "sip"],
	beans: ["bean", "ground", "grind", "grinder"],
	water: ["water", "filter", "filtered"],
	delivery: ["van", "truck", "deliver", "delivery", "ship", "shipping", "road", "drive", "cart", "bike", "courier"],
	people: ["hand", "hands", "people", "team", "founder", "worker", "crew"],
};
const SUBJECT_OF = new Map<string, string>();
for (const [group, list] of Object.entries(SUBJECT_WORDS)) for (const word of list) SUBJECT_OF.set(stem(word), group);

/** Subject groups named by a list of stems. */
export function subjectsOf(stems: readonly string[]): string[] {
	const out: string[] = [];
	for (const s of stems) {
		const group = SUBJECT_OF.get(s);
		if (group && !out.includes(group)) out.push(group);
	}
	return out;
}

// ─── script ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Sentences of a narration ("Here's how… It starts… "); very short ones join the next. */
export function sentencesOf(narration: string): string[] {
	const parts = narration
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?…])\s+(?=[A-Z0-9"“‘(])/)
		.map((part) => part.trim())
		.filter(Boolean);
	const out: string[] = [];
	let carry = "";
	for (const part of parts) {
		const text = carry ? `${carry} ${part}` : part;
		if (text.split(" ").length < 3) carry = text;
		else {
			out.push(text);
			carry = "";
		}
	}
	if (carry) {
		if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${carry}`;
		else out.push(carry);
	}
	return out;
}

const MAX_BEATS = 12;

/** The script: `beats` (strings or objects), else the narration's sentences, else lines made from the other answers. */
export function scriptOf(answers: ExplainerAnswersV2): { beats: ScriptBeat[]; source: "beats" | "narration" | "made"; notes: string[] } {
	const notes: string[] = [];
	const given = (answers.beats ?? [])
		.map((item): ScriptBeat | null => {
			if (typeof item === "string") return item.trim() ? { line: item.trim() } : null;
			if (!item || typeof item.line !== "string" || !item.line.trim()) return null;
			return { line: item.line.trim(), ...(item.picture?.trim() ? { picture: item.picture.trim() } : {}), ...(item.tag?.trim() ? { tag: item.tag.trim() } : {}) };
		})
		.filter((beat): beat is ScriptBeat => beat !== null);
	if (given.length) {
		if (given.length > MAX_BEATS) notes.push(`${given.length} beats given: the first ${MAX_BEATS} are used`);
		return { beats: given.slice(0, MAX_BEATS), source: "beats", notes };
	}
	const sentences = answers.narration?.trim() ? sentencesOf(answers.narration) : [];
	if (sentences.length) {
		if (sentences.length > MAX_BEATS) notes.push(`the narration has ${sentences.length} sentences: the first ${MAX_BEATS} are the beats`);
		notes.push(`beats = the narration's ${Math.min(sentences.length, MAX_BEATS)} sentence(s)`);
		return { beats: sentences.slice(0, MAX_BEATS).map((line) => ({ line })), source: "narration", notes };
	}
	// nothing written: lines from the other answers, said so
	const made: ScriptBeat[] = [];
	const title = answers.title?.trim() || answers.topic?.trim() || "How the farm-to-bottle route works";
	made.push({ line: title });
	for (const place of answers.places ?? []) if (place.trim()) made.push({ line: place.trim() });
	for (const date of answers.dates ?? []) if (date.date.trim()) made.push({ line: `${date.date.trim()}: ${date.text.trim()}` });
	if (answers.verdict?.trim()) made.push({ line: answers.verdict.trim() });
	notes.push("no beats or narration given: the lines are made from the title, places, dates and verdict — write one line per beat (answers.beats) or pass the narration (answers.narration) and build again");
	return { beats: made.slice(0, MAX_BEATS), source: "made", notes };
}

// ─── binding ────────────────────────────────────────────────────────────────────────────────────────────────────

interface PictureWords {
	asset: PictureAsset;
	stems: Set<string>;
	groups: Set<string>;
	label: string;
}

/** Words shared by most picture names (a brand: "halcyon-farm", "halcyon-cafe"…) say nothing about the subject. */
function pictureWords(assets: readonly PictureAsset[]): PictureWords[] {
	const raw = assets.map((asset) => ({ asset, name: words(asset.name.replace(/\.[a-z0-9]+$/i, "")), extra: words(`${asset.caption ?? ""} ${(asset.tags ?? []).join(" ")}`) }));
	const counts = new Map<string, number>();
	for (const item of raw) for (const w of new Set(item.name)) counts.set(w, (counts.get(w) ?? 0) + 1);
	const brand = new Set(assets.length >= 3 ? [...counts].filter(([, n]) => n / assets.length >= 0.6).map(([w]) => w) : []);
	return raw.map(({ asset, name, extra }) => {
		const stems = new Set([...name.filter((w) => !brand.has(w)), ...extra]);
		const label = (asset.caption?.trim() || name.filter((w) => !brand.has(w) && !/^\d+$/.test(w)).join(" ") || asset.name).toUpperCase();
		return { asset, stems, groups: new Set(subjectsOf([...stems])), label };
	});
}

const sameText = (a: string, b: string) => plain(a).replace(/[^a-z0-9]+/g, "") === plain(b).replace(/[^a-z0-9]+/g, "");

/** Places the line names: a place's own words, or its subject group (place "Roastery" ~ "roasted"). */
function placesIn(lineStems: readonly string[], lineGroups: readonly string[], places: readonly string[], brand: Set<string>): string[] {
	return places.filter((place) => {
		const own = words(place).filter((w) => !brand.has(w));
		if (own.some((w) => lineStems.includes(w))) return true;
		return subjectsOf(own).some((group) => lineGroups.includes(group));
	});
}

/** Dates the line names: the date itself ("day 5") or the words of its text ("Steeped 18 h" ~ "steeped … 18 hours"). */
function datesIn(line: string, lineStems: readonly string[], dates: ReadonlyArray<{ date: string; text: string }>): Array<{ date: string; text: string; how: "date" | "text" }> {
	const out: Array<{ date: string; text: string; how: "date" | "text" }> = [];
	const flat = ` ${plain(line).replace(/[^a-z0-9]+/g, " ")} `;
	for (const item of dates) {
		const date = plain(item.date).replace(/[^a-z0-9]+/g, " ").trim();
		if (date && flat.includes(` ${date} `)) {
			out.push({ ...item, how: "date" });
			continue;
		}
		const text = words(item.text).filter((w) => !/^\d+$/.test(w) || w.length > 1);
		if (text.length && text.some((w) => !/^\d+$/.test(w) && lineStems.includes(w))) out.push({ ...item, how: "text" });
	}
	return out;
}

const upper = (text: string) => text.trim().toUpperCase();
const fit = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** Label tags are ≤ 32 characters (FX-59; map-route / paper-cut / retro-tv tags). */
export const TAG_MAX = 32;

/** The tag of a line: given › several dates › place + date › date + its text › places › the picture's subject. */
function tagFor(beat: ScriptBeat, places: string[], dates: Array<{ date: string; text: string; how: "date" | "text" }>, picture: PictureWords | undefined): { tag: string; from: BoundBeat["tagFrom"] } {
	if (beat.tag) return { tag: fit(upper(beat.tag), TAG_MAX), from: "given" };
	if (dates.length >= 2) return { tag: fit(dates.map((d) => upper(`${d.date} ${d.text}`)).join(" · "), TAG_MAX), from: "dates" };
	// a line naming two places is a route ("farm to bottle"), even when one of its words is also a date's text
	if (places.length >= 2 && !dates.some((d) => d.how === "date")) return { tag: fit(places.map(upper).join(" → "), TAG_MAX), from: "places" };
	if (dates.length === 1 && places.length) return { tag: fit(`${upper(places[0] as string)} · ${upper((dates[0] as { date: string }).date)}`, TAG_MAX), from: "place+date" };
	if (dates.length === 1) {
		const d = dates[0] as { date: string; text: string };
		return { tag: fit(upper(d.text ? `${d.date} · ${d.text}` : d.date), TAG_MAX), from: "dates" };
	}
	if (places.length >= 2) return { tag: fit(places.map(upper).join(" → "), TAG_MAX), from: "places" };
	if (places.length === 1) return { tag: fit(upper(places[0] as string), TAG_MAX), from: "places" };
	if (picture) return { tag: fit(picture.label, TAG_MAX), from: "subject" };
	return { tag: "", from: "none" };
}

/**
 * Bind each line to its pictures. Score per picture: 3 per word the line and the picture's name / caption / tags
 * share, 2 per shared subject group, 2 when the line names a place that is that picture's subject. A picture matches
 * at 2 or more; the best one leads, others ≥ 40 % of it follow (≤ 3 pictures per line: the cut-outs). A beat whose
 * `picture` names a media id or a picture name gets exactly that picture.
 */
export function bindBeats(script: readonly ScriptBeat[], assets: readonly PictureAsset[], answers: Pick<ExplainerAnswersV2, "places" | "dates"> = {}): BoundBeat[] {
	const pictures = pictureWords(assets.filter((asset) => asset.kind === "image" || asset.kind === "video"));
	const counts = new Map<string, number>();
	for (const asset of assets) for (const w of new Set(words(asset.name.replace(/\.[a-z0-9]+$/i, "")))) counts.set(w, (counts.get(w) ?? 0) + 1);
	const brand = new Set(assets.length >= 3 ? [...counts].filter(([, n]) => n / assets.length >= 0.6).map(([w]) => w) : []);
	const places = (answers.places ?? []).map((place) => place.trim()).filter(Boolean);
	const dates = (answers.dates ?? []).filter((item) => item.date.trim());

	return script.map((beat, index) => {
		const lineStems = words(beat.line).filter((w) => !brand.has(w));
		const lineGroups = subjectsOf(lineStems);
		const named = placesIn(lineStems, lineGroups, places, brand);
		const namedDates = datesIn(beat.line, lineStems, dates);
		let matches: PictureMatch[] = [];
		let explicit = false;
		if (beat.picture) {
			const pick = pictures.find((p) => p.asset.id === beat.picture) ?? pictures.find((p) => sameText(p.asset.name, beat.picture as string) || sameText(p.asset.name.replace(/\.[a-z0-9]+$/i, ""), beat.picture as string));
			if (pick) {
				matches = [{ id: pick.asset.id, name: pick.asset.name, score: 99, why: "named for this beat" }];
				explicit = true;
			}
		}
		if (!explicit) {
			const scored = pictures
				.map((p, order) => {
					const shared = lineStems.filter((w, i) => p.stems.has(w) && lineStems.indexOf(w) === i);
					const groups = lineGroups.filter((g) => p.groups.has(g));
					const viaPlace = named.filter((place) => {
						const own = words(place).filter((w) => !brand.has(w));
						return own.some((w) => p.stems.has(w)) || subjectsOf(own).some((g) => p.groups.has(g));
					});
					const score = 3 * shared.length + 2 * groups.length + 2 * viaPlace.length;
					const why = [
						...(shared.length ? [`${shared.map((w) => `'${w}'`).join(", ")} in its ${p.asset.caption || p.asset.tags?.length ? "name / caption" : "name"}`] : []),
						...(groups.length ? [`subject ${groups.join(", ")}`] : []),
						...(viaPlace.length ? [`the place ${viaPlace.join(", ")}`] : []),
					].join("; ");
					// first mention in the line breaks ties (the line's own word order)
					const firstAt = Math.min(...[...shared, ...lineStems.filter((w) => subjectsOf([w]).some((g) => groups.includes(g)))].map((w) => lineStems.indexOf(w)).filter((i) => i >= 0), 99);
					return { p, score, why, firstAt, order };
				})
				.filter((item) => item.score >= 2)
				.sort((a, b) => b.score - a.score || a.firstAt - b.firstAt || a.order - b.order);
			const best = scored[0]?.score ?? 0;
			matches = scored
				.filter((item, i) => i === 0 || item.score >= Math.max(2, 0.4 * best))
				.slice(0, 3)
				.map((item) => ({ id: item.p.asset.id, name: item.p.asset.name, score: item.score, why: item.why }));
		}
		const lead = pictures.find((p) => p.asset.id === matches[0]?.id);
		const { tag, from } = tagFor(beat, named, namedDates, lead);
		return {
			index,
			line: beat.line,
			pictures: matches,
			tag,
			tagFrom: from,
			subjects: lineGroups,
			places: named,
			dates: namedDates.map(({ date, text }) => ({ date, text })),
			explicit,
			...(matches.length
				? {}
				: {
						unmatched: beat.picture
							? `"${beat.picture}" (named for this beat) is not a picture on this timeline`
							: `no picture's name, caption or tags share a subject with this line${lineGroups.length ? ` (it is about ${lineGroups.join(", ")})` : ""}: name or caption a picture for it, or pass beats[${index}].picture`,
					}),
		};
	});
}

// ─── pacing ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type Feel = NonNullable<ExplainerAnswers["feel"]>;

/**
 * Pacing per feel. shot = target seconds per shot (a cut at every shot); cuts = target cuts per 10 s; linger =
 * how much longer than its reading time a beat stays. Reel DePNgrmToh9: 4.7 cuts / 10 s (FINDINGS) → punchy ≈ 5.
 */
export const FEEL_PACE: Record<Feel, { shot: number; cuts: number; linger: number }> = {
	punchy: { shot: 2, cuts: 5, linger: 1 },
	playful: { shot: 2.5, cuts: 4, linger: 1.15 },
	serious: { shot: 3, cuts: 3.3, linger: 1.25 },
	nostalgic: { shot: 3.3, cuts: 3, linger: 1.4 },
};

/** Words per second a narrator reads at (REPORT §7: ~2.6 at rate 1.05). */
export const READ_WPS = 2.6;

/** Seconds a line needs on screen: its words at READ_WPS + 0.5 s, at least 1.6 s. */
export function readingSeconds(line: string): number {
	const count = line.trim().split(/\s+/).filter(Boolean).length;
	return Math.max(1.6, Math.round((count / READ_WPS + 0.5) * 100) / 100);
}

export interface BeatTiming {
	/** Seconds per beat. */
	lengths: number[];
	/** Shots per beat. */
	shots: number[];
	/** The feel's shot length (seconds). */
	shot: number;
	targetCutsPer10s: number;
	/** Cuts the plan makes per 10 s (every shot boundary is a cut). */
	plannedCutsPer10s: number;
	/** Sum of reading times. */
	readingS: number;
	totalS: number;
	notes: string[];
}

/**
 * Beat lengths and shots for a feel: each beat = its reading time × the feel's linger (≥ one shot); with `lengthS` the
 * beats scale to it (never below their reading time: then it says so); every beat is split into shots of about the
 * feel's shot length, so punchy cuts ~5 times per 10 s whatever the length.
 */
export function beatLengths(lines: readonly string[], feel: Feel = "playful", lengthS?: number, minShots: readonly number[] = [], seamless = 0): BeatTiming {
	const pace = FEEL_PACE[feel] ?? FEEL_PACE.playful;
	const notes: string[] = [];
	const reading = lines.map(readingSeconds);
	let lengths = reading.map((r) => Math.max(pace.shot, r * pace.linger));
	const readingS = reading.reduce((a, b) => a + b, 0);
	if (lengthS && lengthS > 0) {
		const natural = lengths.reduce((a, b) => a + b, 0);
		const scale = lengthS / natural;
		lengths = lengths.map((len, i) => Math.max(reading[i] as number, len * scale));
		const got = lengths.reduce((a, b) => a + b, 0);
		if (got > lengthS + 0.5) notes.push(`length_s ${lengthS} s is shorter than the script reads (${Math.round(readingS * 10) / 10} s at ${READ_WPS} words/s): ${Math.round(got * 10) / 10} s — cut lines to get there`);
		else if (Math.abs(got - lengthS) > 0.5) {
			// lines that hit their reading time leave room: give it to the others
			const free = lengths.map((len, i) => len > (reading[i] as number) + 0.01);
			const room = lengthS - got;
			const share = free.filter(Boolean).length;
			if (share) lengths = lengths.map((len, i) => (free[i] ? len + room / share : len));
		}
	}
	lengths = lengths.map((len) => Math.round(len * 100) / 100);
	const totalS = Math.round(lengths.reduce((a, b) => a + b, 0) * 100) / 100;
	// shots: as many as the feel's cut rate asks over the whole length (cuts = shots − 1), shared out by beat length
	// (largest remainder), at least one per beat (`minShots`: two where a collage piece needs its own shot), none
	// shorter than 0.6 × the feel's shot
	const minShot = pace.shot * 0.6;
	// `seamless` shot boundaries are transitions, not cuts (a torn hole pushing into its photo): one more shot each
	const want = Math.max(lines.length, Math.round((totalS * pace.cuts) / 10) + 1 + seamless);
	const caps = lengths.map((len) => Math.max(1, Math.floor(len / minShot)));
	const floors = lengths.map((len, i) => Math.min(caps[i] as number, Math.max(1, minShots[i] ?? 1)));
	const ideal = lengths.map((len) => (want * len) / Math.max(0.01, totalS));
	const shots = ideal.map((x, i) => Math.min(caps[i] as number, Math.max(floors[i] as number, Math.floor(x))));
	let left = want - shots.reduce((a, b) => a + b, 0);
	const order = ideal.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
	for (let pass = 0; left > 0 && pass < 4; pass++) {
		for (const { i } of order) {
			if (left <= 0) break;
			if ((shots[i] as number) < (caps[i] as number)) {
				shots[i] = (shots[i] as number) + 1;
				left--;
			}
		}
	}
	const cuts = shots.reduce((a, b) => a + b, 0) - 1 - seamless;
	return {
		lengths,
		shots,
		shot: pace.shot,
		targetCutsPer10s: pace.cuts,
		plannedCutsPer10s: totalS > 0 ? Math.round((cuts / totalS) * 100) / 10 : 0,
		readingS: Math.round(readingS * 100) / 100,
		totalS,
		notes,
	};
}
