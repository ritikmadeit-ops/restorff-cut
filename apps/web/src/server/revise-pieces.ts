/**
 * What an editing style declares but `revise` does not add in its one commit (revise-safety agent, 2026-10-21;
 * warm-moody-oat REPORT item 2: "make it more aesthetic" added no cover and no word behind the head, and said nothing,
 * so a Sonnet guessed three more commits). Over MCP a style changes captions, pacing, joins and grade; the pieces that
 * need the speaker cut out (a magazine cover with the masthead behind the head, a big word behind the head) or a
 * rendered composition are listed here with the exact calls that add them — never skipped silently.
 *
 * Pure: the style id, the snapshot and the timeline id in; not_understood-style entries out (+ the clips whose person
 * matte the calls need, which revise starts in the background so the calls are quick).
 */
import { EDITING_STYLE_PRESETS } from "@restorffcut/timeline-ops";
import type { ProjectSnapshot, SnapshotElement } from "@/sync/snapshot";
import { captionWords, wordKey } from "./caption-words";
import { activeScene } from "./transcripts-timeline";

export interface LeftOutPiece {
	clause: string;
	why: string;
	send: { tool: string; how: string; example_ops: Array<Record<string, unknown>>; steps?: Array<{ tool: string; arguments: Record<string, unknown> }> };
	/** The clips whose person matte the steps need (the caller starts them in the background). */
	matte_clips: string[];
}

const T = 120_000;
const STOP = new Set("a an the and or but so to of in on at for with from by as is are was were be it its this that i you we my your our just not no do can will".split(" "));

/** The A-roll clips in time order (main track, footage only). */
function mainClips(snapshot: ProjectSnapshot): SnapshotElement[] {
	const main = activeScene(snapshot)?.tracks?.main;
	return [...(main?.elements ?? [])]
		.filter((element) => element.type === "video" && !(element.restorff as { cutout?: unknown; composition?: unknown } | undefined)?.cutout && !(element.restorff as { composition?: unknown } | undefined)?.composition)
		.sort((a, b) => a.startTime - b.startTime);
}

/** "Halcyon Oat Latte / founder reel" → brand HALCYON, product OAT LATTE (a guess the answer says is one). */
function namesOf(snapshot: ProjectSnapshot): { brand: string; product: string | null } {
	const name = String(snapshot.metadata?.name ?? "").split("/")[0]?.trim() ?? "";
	const words = name.split(/\s+/).filter(Boolean);
	const brand = (words[0] ?? "HALCYON").toUpperCase();
	const rest = words.slice(1).join(" ").toUpperCase();
	return { brand, product: rest || null };
}

/** The hook's telling word: the longest non-stopword in the first 3 s of captions. */
function hookWord(snapshot: ProjectSnapshot): string | null {
	const words = captionWords(snapshot).filter((word) => word.start < 3);
	const best = words.map((word) => word.text.replace(/[^\p{L}\p{N}']/gu, "")).filter((text) => text.length >= 3 && !STOP.has(wordKey(text))).sort((a, b) => b.length - a.length)[0];
	return best ? best.toUpperCase() : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The pieces of a built-in editing style revise left out, each with the exact calls that add it. `clause` = the
 * sentence clause that named the style (reported with each piece).
 */
export function stylePiecesLeftOut(styleId: string, snapshot: ProjectSnapshot, timelineId: string, clause: string): LeftOutPiece[] {
	const preset = EDITING_STYLE_PRESETS.find((candidate) => candidate.id === styleId);
	if (!preset) return [];
	const clips = mainClips(snapshot);
	const hook = clips[0];
	const second = clips[1] ?? clips[0];
	const { brand, product } = namesOf(snapshot);
	const out: LeftOutPiece[] = [];
	const guessNote = `Texts are guesses from the timeline name and the hook's words (brand ${brand}${product ? `, product ${product}` : ""}): change them to what the person wants.`;
	if (styleId === "aesthetic-warm") {
		if (second) {
			out.push({
				clause: `${clause} — the magazine cover`,
				why: `the style's cover (masthead behind the speaker's head, cover lines in front) needs the speaker cut out: revise does not add it in its commit`,
				send: {
					tool: "cutout",
					how: `cutout apply with preset cover_story on a clip (its own commit; it starts or reuses the clip's person matte and waits up to wait_s). The style's plain composition instead: effects apply {name: "comp:magazine-cover", t: 0}. ${guessNote}`,
					example_ops: [],
					steps: [
						{
							tool: "cutout",
							arguments: { action: "apply", timeline_id: timelineId, element_id: second.id, preset: "cover_story", text: brand, ...(product ? { lines: [product, "STEEPED SLOW", "NO SYRUP"] } : {}), dateline: "ISSUE 01", wait_s: 120, message: `${clause} (the cover)` },
						},
					],
				},
				matte_clips: [second.id],
			});
		}
		if (hook) {
			const word = product ?? hookWord(snapshot) ?? brand;
			out.push({
				clause: `${clause} — the word behind the head`,
				why: "the style's big word behind the speaker's head (on the hook) needs the speaker cut out: revise does not add it in its commit",
				send: {
					tool: "cutout",
					how: `cutout apply with preset text_behind_person on the hook clip (its own commit; starts or reuses the person matte). ${guessNote}`,
					example_ops: [],
					steps: [{ tool: "cutout", arguments: { action: "apply", timeline_id: timelineId, element_id: hook.id, preset: "text_behind_person", text: word, wait_s: 120, message: `${clause} (a word behind the head)` } }],
				},
				matte_clips: [hook.id],
			});
		}
		return out;
	}
	// every other built-in: its declared compositions (the editor renders them when the style is picked there)
	for (const composition of preset.compositions) {
		const runtime = Math.max(0, ...clips.map((clip) => (clip.startTime + clip.duration) / T));
		const at = composition.at < 0 ? Math.max(0, runtime + composition.at) : composition.at;
		out.push({
			clause: `${clause} — ${composition.name}`,
			why: `the style's ${composition.name} composition is rendered and imported by the editor when the style is picked there; over MCP revise does not add it`,
			send: {
				tool: "effects",
				how: `effects apply with the composition at ${r2(at)} s (its own commit; params are the style's defaults — Halcyon examples: change them to the person's words).`,
				example_ops: [],
				steps: [{ tool: "effects", arguments: { action: "apply", timeline_id: timelineId, name: `comp:${composition.name}`, t: r2(at), ...(Object.keys(composition.props ?? {}).length ? { params: composition.props } : {}) } }],
			},
			matte_clips: [],
		});
	}
	return out;
}
