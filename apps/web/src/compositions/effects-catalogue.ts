/**
 * Every effect in docs/restorff/EFFECTS.md (FX-01 … FX-62) with what RestorffCut can do about it TODAY. Shown in the
 * Effects panel's Library view. Rules: honest status, no fake buttons — only "available"/"partial" rows link to
 * something that works (a composition in packages/compositions or a shader effect in effects/definitions).
 *
 * Keep in step with EFFECTS.md (ids and names) and with the composition library (names). When an effect lands,
 * change its row here: status + `via` + a one-line note of what is still missing.
 */

import { gradeEffectParams, lookParams } from "@restorffcut/timeline-ops";

export type EffectStatus = "available" | "partial" | "coming";

export type EffectVia =
	| { kind: "composition"; name: string }
	/** `params` (grade agent, 2026-10-20): start values over the definition's defaults, e.g. a grade look. */
	| { kind: "shader"; type: string; params?: Record<string, number | string> }
	| { kind: "editor"; where: string };

export interface CatalogueEffect {
	id: string;
	slug: string;
	name: string;
	group: string;
	/** Build paths from EFFECTS.md: S shader · C composition · O timeline ops · M person matte. */
	build: string;
	status: EffectStatus;
	via?: EffectVia;
	/** What it is, or what it still waits on. One line. */
	note: string;
}

const NAMED = "The 17 named effects";
const TYPE = "Captions and type";
const UI = "UI and data overlays";
const LOOKS = "Looks and transitions";
const LAYOUT = "Layout and layering";
const MOTION = "Motion design";
const COLLAGE = "Collage / explainer kit";

const comp = (name: string): EffectVia => ({ kind: "composition", name });
/** A grade look's slider values + its `look` tag (packages/timeline-ops/src/grades.ts). */
const gradeLookParams = (look: string): Record<string, number | string> => gradeEffectParams(lookParams(look), look);
const shader = (type: string): EffectVia => ({ kind: "shader", type });

export const EFFECTS_CATALOGUE: CatalogueEffect[] = [
	{ id: "FX-01", slug: "orbit", name: "Orbit", group: NAMED, build: "C+O+M", status: "available", via: comp("orbit"), note: "Cards circle the speaker on a tilted ring. Behind them: render layer back under the clip's person cutout and layer front above it (one drop = layer all, no occlusion)." },
	{ id: "FX-02", slug: "couch-wall", name: "Couch Wall", group: NAMED, build: "C+O+M", status: "available", via: comp("couch-wall"), note: "A wall of thumbnails with view counts builds behind the speaker: layer back under the person cutout, the caption (layer front) above it." },
	{ id: "FX-03", slug: "ui-world", name: "UI World", group: NAMED, build: "C+O", status: "available", via: comp("ui-world"), note: "Chat app on the top half, clips fly into the input box, the command types; key the clip down a quarter (plate keys in the composition's effect block)." },
	{ id: "FX-04", slug: "frame-break", name: "Frame Break", group: NAMED, build: "O+C+M", status: "available", via: comp("frame-break"), note: "The picture shrinks into an inner reel frame; head and hands break out. Key the clip and its person cutout (plate keys), layer back between them, layer front on top." },
	{ id: "FX-05", slug: "digital-zoom", name: "Digital Zoom", group: NAMED, build: "O+S", status: "available", via: shader("restorff-digital-zoom"), note: "Punch-in toward a focal point, optional smear and chroma split." },
	{ id: "FX-06", slug: "phone-mockup", name: "Phone Mockup", group: NAMED, build: "C", status: "available", via: comp("phone-mockup"), note: "A phone floats beside the speaker; an assistant screen and a tap on Approve." },
	{ id: "FX-07", slug: "checklist", name: "Checklist", group: NAMED, build: "C", status: "available", via: comp("checklist"), note: "Glass panel, rows tick in, counter and progress bar." },
	{ id: "FX-08", slug: "headline-wall", name: "Headline Wall", group: NAMED, build: "C+O+M", status: "available", via: comp("headline-wall"), note: "Layout wall: clippings, notes, posts and a search bar pin one by one around the speaker; put it under the clip's person cutout so the head covers the cards behind it." },
	{ id: "FX-09", slug: "zoom-through", name: "Zoom Through Cut", group: NAMED, build: "S+O", status: "available", via: { kind: "editor", where: "Transitions tab → Zoom through (zoom-in)" }, note: "The zoom-in transition at the cut: radial zoom blur out of one shot into the next (keep it ≤ 0.35 s). Zoom-through title is the matching type overlay." },
	{ id: "FX-10", slug: "chart-grow", name: "Chart Grow", group: NAMED, build: "C", status: "available", via: comp("chart-grow"), note: "Bars or a line grow with counting numbers; the numbers are the input." },
	{ id: "FX-11", slug: "pullback-reveal", name: "Pullback Reveal", group: NAMED, build: "O+C", status: "available", via: comp("pullback-window"), note: "The shot pulls back into an editor window, steps tick, counter runs to 100 %. With pullFrom frame-width and the plate keys, the clip stays locked in the window's hole." },
	{ id: "FX-12", slug: "green-screen", name: "Green Screen", group: NAMED, build: "S+C+M", status: "available", via: comp("green-screen"), note: "A new scene (focus-app world, gradient or an image) under the clip's person cutout; with matte frames, layer front wraps the scene's light around the speaker." },
	{ id: "FX-13", slug: "paper-cut", name: "Paper Cut", group: NAMED, build: "S+C+M", status: "available", via: comp("paper-cut"), note: "Layout full + matte frames: the speaker becomes a torn white-edged paper cut-out on grid paper (layer back under the person cutout), tiles and scribbles in front." },
	{ id: "FX-14", slug: "doodle-boil", name: "Doodle Boil", group: NAMED, build: "S+C+M", status: "available", via: comp("doodle-boil"), note: "Doodles that boil every 2 frames; with matte frames a hand-drawn outline boils around the body. One overlay, no cutout track needed." },
	{ id: "FX-15", slug: "vertigo", name: "Vertigo", group: NAMED, build: "S+O+M", status: "available", via: comp("vertigo"), note: "The room dolly-zooms behind the person cutout from a clean plate, or a still of the clip with the person's hole filled. The no-mask shader (restorff-vertigo) is the quick alternative." },
	{ id: "FX-16", slug: "cover-story", name: "Cover Story", group: NAMED, build: "C+M", status: "available", via: comp("cover-story"), note: "Masthead builds letter by letter behind the head (layer back under the person cutout, mastheadOffset to overlap), frame and coverlines in front (layer front)." },
	{ id: "FX-17", slug: "glass-type", name: "Glass Type", group: NAMED, build: "C+S", status: "available", via: comp("glass-type"), note: "Extruded clear-glass letters bend a still of the room behind the speaker (put them under the person cutout). The frosted panel shader is restorff-glass-type." },

	{ id: "FX-18", slug: "captions-clean", name: "Word-chunk captions (clean)", group: TYPE, build: "O", status: "available", via: { kind: "editor", where: "Captions tab + Talking head style" }, note: "Captions from the transcript; the Talking head style sets the clean look." },
	{ id: "FX-19", slug: "emphasis-underline", name: "Emphasis line with drawn underline", group: TYPE, build: "C", status: "available", via: comp("emphasis-underline"), note: "Words go grey to white one by one, underlines draw under the key words." },
	{ id: "FX-20", slug: "captions-karaoke-box", name: "Karaoke boxed captions", group: TYPE, build: "C", status: "partial", via: comp("word-pop"), note: "Word-pop's box style highlights the spoken word; the serif label-box look is not a preset yet." },
	{ id: "FX-21", slug: "caption-stack", name: "Mixed-type caption stack", group: TYPE, build: "C", status: "available", via: comp("caption-stack"), note: "Heavy caps on a box, italic serif, small-caps boxes word by word, big serif on a label." },
	{ id: "FX-22", slug: "big-word", name: "Big-word punch", group: TYPE, build: "C", status: "available", via: comp("big-word-punch"), note: "One huge word slams in, underline draws." },
	{ id: "FX-23", slug: "ignite-type", name: "Ignite-then-cool kinetic type", group: TYPE, build: "C", status: "available", via: comp("ignite-type"), note: "Extended caps reveal word by word, ignite ember-orange and cool to white." },
	{ id: "FX-24", slug: "type-on", name: "Type-on title", group: TYPE, build: "C", status: "available", via: comp("type-on"), note: "Section title types on in the top-left safe area in about 0.3 s." },
	{ id: "FX-25", slug: "strike", name: "Strike-through", group: TYPE, build: "C", status: "available", via: comp("strike"), note: "A drawn strike (line, cross or scribble), then the correction writes in." },
	{ id: "FX-26", slug: "stamp", name: "Rubber stamp", group: TYPE, build: "C", status: "available", via: comp("stamp"), note: "Red rubber stamp slams in with an overshoot and ink texture." },

	{ id: "FX-27", slug: "ui-card", name: "UI card pop-in", group: UI, build: "C", status: "available", via: comp("ui-card-pop"), note: "A screenshot card flies in tilted and lands with a pop." },
	{ id: "FX-28", slug: "badges", name: "Badge pills", group: UI, build: "C", status: "available", via: comp("badge-pills"), note: "Mono pills stacking in, one neon." },
	{ id: "FX-29", slug: "explainer-panel", name: "Glass panel overlay grammar", group: UI, build: "C", status: "available", via: comp("glass-panel-kit"), note: "A kit of frosted panels, mono labels, icon tiles and one moving part per beat (library-v2, from the explainer recreation's kit)." },
	{ id: "FX-30", slug: "prompt-box", name: "Typed prompt box / chat", group: UI, build: "C", status: "available", via: comp("prompt-box"), note: "A prompt pill types, shows SENT with a spinner, lands on DONE." },
	{ id: "FX-31", slug: "chips-tick", name: "Chips that tick", group: UI, build: "C", status: "partial", via: comp("checklist"), note: "Checklist covers ticking rows; the chip layout is not a preset yet." },
	{ id: "FX-32", slug: "counter", name: "Counter / flip-clock", group: UI, build: "C", status: "available", via: comp("counter"), note: "Counts to the real number (plain, split-flap or serif); the label flips when it lands." },
	{ id: "FX-33", slug: "dead-space-collapse", name: "Waveform with collapsing gaps", group: UI, build: "C", status: "available", via: comp("waveform-collapse"), note: "Dashed DEAD gaps close into one block; pass the real cut list from autocut as props for a true picture." },
	{ id: "FX-34", slug: "frame-check", name: "Filmstrip + flash + scan", group: UI, build: "C", status: "available", via: comp("filmstrip-flash"), note: "Thumbnails flash, a counter counts frames, LOOKS OFF flips to FIXED; pass the self-check's numbers as props." },
	{ id: "FX-35", slug: "cta-social", name: "Social CTA overlays", group: UI, build: "C", status: "available", via: comp("cta-social"), note: "Neutral comment box types the keyword, heart fills, Follow flips to Following." },

	{ id: "FX-36", slug: "before-after", name: "Before/after wipe", group: LOOKS, build: "S+C", status: "available", via: comp("before-after-wipe"), note: "Slanted divider with a handle and BEFORE / AFTER labels over two stills (data: images)." },
	{ id: "FX-37", slug: "grade-wipe", name: "Grade by wipe", group: LOOKS, build: "S", status: "coming", note: "Waits on the shader (same machinery as before/after)." },
	{ id: "FX-38", slug: "grade-warm", name: "Warm grade", group: LOOKS, build: "S", status: "available", via: { kind: "shader", type: "restorff-grade", params: gradeLookParams("warm-morning") }, note: "Grade · warm morning: golden light, lifted blacks, peach highlights. Every slider keyframable." },
	{ id: "FX-39", slug: "grade-moody", name: "Moody grade", group: LOOKS, build: "S", status: "partial", via: { kind: "shader", type: "restorff-grade", params: gradeLookParams("moody") }, note: "Grade · moody: darker, cooler, teal shadows, warm highlights. No protected lamp-hue range yet." },
	{ id: "FX-40", slug: "whip", name: "Whip / blur transition", group: LOOKS, build: "S+O", status: "available", via: { kind: "editor", where: "Transitions tab" }, note: "Whip left / right / up / down in Transitions; the Fast UGC style whips on the beat." },
	{ id: "FX-41", slug: "zoom-blur-out", name: "Zoom-blur exit", group: LOOKS, build: "S", status: "coming", note: "Same shader as Zoom Through Cut, one-sided." },

	{ id: "FX-42", slug: "float-thumbs", name: "Floating thumbnails", group: LAYOUT, build: "C", status: "available", via: comp("float-thumbs"), note: "Portrait cards pop in above the head and drift up; takes real stills through its images param (library-v2)." },
	{ id: "FX-43", slug: "text-behind", name: "Text behind subject", group: LAYOUT, build: "C+M", status: "coming", note: "Waits on the person matte." },
	{ id: "FX-44", slug: "collage-grid", name: "Collage grid", group: LAYOUT, build: "C+O", status: "coming", note: "3 × 3 covers with the live clip in the centre: not written yet." },
	{ id: "FX-45", slug: "droste", name: "Recursive picture-in-picture", group: LAYOUT, build: "S/O", status: "coming", note: "Frames within frames: not built yet." },
	{ id: "FX-46", slug: "storyboard-doc", name: "Storyboard document", group: LAYOUT, build: "C", status: "coming", note: "As a feature it is the storyboard view (EDT-14)." },
	{ id: "FX-47", slug: "comment-card", name: "Comment thread card", group: LAYOUT, build: "C", status: "coming", note: "As a feature it is review comments (EDT-16)." },

	{ id: "FX-48", slug: "neon-grid", name: "Kinetic type on a 3D grid", group: MOTION, build: "C", status: "available", via: comp("neon-grid"), note: "Dark perspective grid, camera glides, big extended caps, one ember accent." },
	{ id: "FX-49", slug: "flow-spark", name: "Flowchart with travelling spark", group: MOTION, build: "C", status: "available", via: comp("flow-spark"), note: "Nodes and a travelling spark; a node gets an X and the path re-routes." },
	{ id: "FX-50", slug: "curve-demo", name: "Easing-curve explainer", group: MOTION, build: "C", status: "available", via: comp("easing-curve"), note: "Bezier with handles, a riding dot and a read-out (library-v2, from the neon-grid recreation)." },
	{ id: "FX-51", slug: "paper-form", name: "Paper form look", group: MOTION, build: "C", status: "available", via: comp("paper-form"), note: "Form sheet with typed boxes, a red strike, X and tick (library-v2, from the neon-grid recreation)." },

	{ id: "FX-52", slug: "cutout-red", name: "Paper cut-out with red outline", group: COLLAGE, build: "S+C", status: "available", via: comp("cutout-outline"), note: "Any image with alpha (or a moving matte) gets a paper edge around its exact shape: white, or the thick red outline (#C8352B), optional torn edge, drop shadow, depth drift." },
	{ id: "FX-53", slug: "paper-bg", name: "Old-paper and map backgrounds", group: COLLAGE, build: "S/C", status: "available", via: comp("paper-texture"), note: "Paper texture: an opaque sheet (cream, old, mustard, kraft, grid, map) or a light overlay with fibres, mottling and a scanned flicker." },
	{ id: "FX-54", slug: "map-route", name: "Map with route and city pins", group: COLLAGE, build: "C", status: "available", via: comp("map-route"), note: "A dotted route draws between pins with label tags (collage kit: pairs with paper-texture and cutout-outline)." },
	{ id: "FX-55", slug: "retro-tv", name: "Retro TV frame", group: COLLAGE, build: "C+O", status: "available", via: comp("retro-tv"), note: "A wooden TV slides in; the footage below plays through its screen (checked over the stand-in clip)." },
	{ id: "FX-56", slug: "halftone-push", name: "Halftone portrait push-in", group: COLLAGE, build: "S+O+C", status: "available", via: comp("halftone-push"), note: "A portrait as a crisp halftone print, push-in to one eye; the iris becomes a spinning record (or an image) that fills the frame." },
	{ id: "FX-57", slug: "triptych", name: "Triptych panels", group: COLLAGE, build: "O+C", status: "available", via: comp("triptych"), note: "Three 16:9 panels slide in (paper + cut-out, colour, photo, or a hole for a clip below) with mono captions on the seams." },
	{ id: "FX-58", slug: "thread-timeline", name: "Thread timeline with pinned cards", group: COLLAGE, build: "C", status: "available", via: comp("thread-timeline"), note: "Dated paper cards pinned onto a red thread, with a legend tag." },
	{ id: "FX-59", slug: "label-tag", name: "Label tags", group: COLLAGE, build: "C", status: "partial", via: comp("map-route"), note: "Yellow mono tags are in Map route and Paper cut; a stand-alone tag preset is not written yet." },
	{ id: "FX-60", slug: "letter-tiles", name: "Letter tiles and cracking sign", group: COLLAGE, build: "C+S", status: "partial", via: comp("paper-cut"), note: "Ransom-note letter tiles stamp in (Paper cut); the cracking sign is not built." },
	{ id: "FX-61", slug: "parallax-strip", name: "Side-scrolling parallax strip", group: COLLAGE, build: "C", status: "available", via: comp("parallax-strip"), note: "2.5D street in paper cut-outs: skyline, post boxes and benches, kerb and blurred scraps at five speeds; a hero cut-out (any image) rides through." },
	{ id: "FX-62", slug: "split-hook", name: "Split-screen hook", group: COLLAGE, build: "O+C", status: "coming", note: "Two cropped tracks with a seam title: not built yet." },
];

export const EFFECT_GROUPS = [NAMED, TYPE, UI, LOOKS, LAYOUT, MOTION, COLLAGE];

export function catalogueCounts(): Record<EffectStatus, number> {
	const counts: Record<EffectStatus, number> = { available: 0, partial: 0, coming: 0 };
	for (const effect of EFFECTS_CATALOGUE) counts[effect.status]++;
	return counts;
}
