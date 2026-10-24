/**
 * The timeline checks of docs/restorff/EXPORT-GATE.md §2 — every check readable exactly from the project JSON (no
 * OCR, no render): SAFE, CAP-LEN, R3, R15, R1/R5/R6, R12, R23, R4, R21, CLEAN (timeline half), FORMAT (timeline
 * half), FACE, FLASH (timeline half). Each returns finding@1 objects with evidence "TIMELINE".
 *
 * gate-v2 (2026-10-20): the piece type (piece.ts) chooses each rule's severity or skips it; rhythm counts picture
 * changes (changes.ts: cuts, scenes inside compositions, effects, overlay beats) instead of clips; R3 / R15 read the
 * text inside compositions (compositions.ts); SAFE uses the canvas's own zone; FORMAT accepts the piece's aspect
 * ratios; every finding names its real lane (`track_name`) and carries an exact `fix_call`.
 */
import { changeMap, covers, effectOf, isCutout, type ChangeMap } from "./changes.ts";
import { compositionFacts, localToTimeline, storedComposition } from "./compositions.ts";
import { boxCoverage, compositionFaceCoverage, faceOnCanvas, runsOf, sampleTimes, within, type Box01 } from "./face.ts";
import {
	aspectName,
	decidePiece,
	nearestStandard,
	PROFILES,
	safeZoneFor,
	type PieceProfile,
	type PieceSignals,
	type RuleMode,
	type SafeZone,
} from "./piece.ts";
import {
	briefOf,
	elEnd,
	elStart,
	formatTime,
	fpsOf,
	frameSeconds,
	isCaption,
	musicHits,
	pickScene,
	restorffMeta,
	round,
	shotMap,
	type ShotMap,
	sounds,
	textContent,
	textElements,
	ticksToSeconds,
	union,
	videoElements,
	wordCount,
	type PlacedElement,
} from "./project.ts";
import type {
	CheckRun,
	Finding,
	FindingTrack,
	FixCall,
	GateElement,
	GateProject,
	GateScene,
	GateTrack,
	PieceDecision,
	Severity,
	TextRect,
	TimelineCheckOptions,
} from "./types.ts";

export const GATE_SOURCE = "gate:restorffcut@0.2.0";

/** Every check this module runs, in table order. */
export const TIMELINE_CHECKS = [
	"SAFE",
	"CAP-LEN",
	"R3",
	"R15",
	"R1",
	"R5",
	"R6",
	"R12",
	"R23",
	"R4",
	"R21",
	"CLEAN",
	"FORMAT",
	"FACE",
	"FLASH",
] as const;

/** EXPORT-GATE SAFE on 1080x1920 (ASSUMPTION, UNVERIFIED in the spec): x 60–940, y 220–1500; scaled to the canvas. */
export const SAFE_AREA_1080x1920 = { left: 60, right: 940, top: 220, bottom: 1500 } as const;

/** Caption zones of the caption builder (apps/web/src/server/transcripts-timeline.ts CAPTION_ZONES): anchor in the safe area. */
const CAPTION_ZONES = { top: 0.1, upper: 0.3, middle: 0.5, lower: 0.72, bottom: 0.94 } as const;

interface Ctx {
	project: GateProject;
	scene: GateScene;
	opts: TimelineCheckOptions;
	map: ShotMap;
	pic: ChangeMap;
	piece: PieceDecision;
	profile: PieceProfile;
	canvas: { width: number; height: number };
	zone: SafeZone;
	fps: number;
	findings: Finding[];
	ids: Set<string>;
}

// ------------------------------------------------------------------ lanes

/** finding@1 lane + the real lane (id and name) of a placed element. */
export function laneOf(track: GateTrack | null | undefined, el?: GateElement | null, isMain = false): { track: FindingTrack; track_id: string | null; track_name: string | null } {
	if (!track) return { track: null, track_id: null, track_name: null };
	let lane: FindingTrack;
	if (isMain) lane = "V1 A-ROLL";
	else if (track.type === "text") lane = el && isCaption(track, el) ? "CAPTIONS" : isCaptionTrackLike(track) ? "CAPTIONS" : "TEXT";
	else if (track.type === "audio") {
		const role = (el?.restorff?.role ?? track.restorff?.role ?? "") as string;
		const name = (track.name ?? "").toUpperCase();
		lane = role === "music" || /MUSIC|BED/.test(name) ? "MUSIC" : role === "sfx" || /SFX/.test(name) ? "SFX" : null;
	} else lane = "V2 B-ROLL";
	return { track: lane, track_id: track.id ?? null, track_name: track.name ?? null };
}

function isCaptionTrackLike(track: GateTrack): boolean {
	return track.restorff?.role === "caption" || /CAPTION|SUBTITLE/i.test(track.name ?? "") || Boolean(track.restorff?.captionLayer);
}

function findTrack(scene: GateScene, pred: (t: GateTrack) => boolean): GateTrack | null {
	return [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio].filter(Boolean).find(pred) ?? null;
}

// ------------------------------------------------------------------ findings

interface AddArgs {
	key?: string;
	t: number;
	t_end?: number | null;
	/** The finding@1 lane when there is no element to place it by (MASTER, MUSIC, SFX, TEXT…). */
	track?: FindingTrack;
	/** The element the finding sits on, with its track: sets element_id, track, track_id, track_name. */
	place?: { track: GateTrack; el?: GateElement | null; isMain?: boolean } | null;
	element_id?: string | null;
	message: string;
	fix: string;
	fix_call?: FixCall | null;
	measure?: Finding["measure"];
	target?: string;
	status?: Finding["status"];
}

function add(ctx: Ctx, rule: string, severity: Severity, f: AddArgs): void {
	const lane = f.place ? laneOf(f.place.track, f.place.el ?? null, f.place.isMain ?? false) : null;
	const elementId = f.element_id !== undefined ? f.element_id : (f.place?.el?.id ?? null);
	let id = `gate-${rule}-${f.key ?? elementId ?? Math.round(f.t * 10)}`;
	let n = 2;
	while (ctx.ids.has(id)) id = `gate-${rule}-${f.key ?? elementId ?? Math.round(f.t * 10)}-${n++}`;
	ctx.ids.add(id);
	ctx.findings.push({
		id,
		rule,
		severity,
		status: f.status ?? "open",
		t: round(Math.max(0, f.t), 3),
		t_end: f.t_end == null ? null : round(Math.max(0, f.t_end), 3),
		track: f.track !== undefined ? f.track : (lane?.track ?? null),
		element_id: elementId,
		...(f.measure ? { measure: f.measure } : {}),
		...(f.target ? { target: f.target } : {}),
		evidence: "TIMELINE",
		message: f.message,
		fix: f.fix,
		source: ctx.opts.source ?? GATE_SOURCE,
		commit: ctx.opts.commit ?? null,
		track_id: lane?.track_id ?? null,
		track_name: lane?.track_name ?? (f.track && f.track !== null ? f.track : null),
		fix_call: f.fix_call ?? null,
	});
}

function label(el: GateElement): string {
	return el.name ? `"${el.name}"` : el.id;
}

/** The rule's mode on this piece; a brief with a verified offer keeps R15 a MUST on any piece. */
function modeOf(ctx: Ctx, rule: string): RuleMode {
	if (rule === "R15" && briefHasOffer(ctx.project)) return "must";
	return ctx.profile.rules[rule] ?? "should";
}

function skipWhy(ctx: Ctx, rule: string): string {
	return `${ctx.profile.skipWhy[rule] ?? "not a rule for this piece"} — piece: ${ctx.piece.type} (${ctx.piece.source})`;
}

const ops = (list: Array<Record<string, unknown>>, message: string, does: string): FixCall => ({
	tool: "timeline_ops",
	arguments: { ops: list.map((op) => ({ author: "claude", ...op })), message },
	does,
});
const look = (times: number[], does: string): FixCall => ({ tool: "look", arguments: { kind: "render", times: times.map((t) => round(Math.max(0, t), 3)) }, does });

// ------------------------------------------------------------------ SAFE

function num(v: unknown, d: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/** ASSUMPTION: without a real measurer, 0.55 em per character and the element's line height (+ its background box). */
export function estimateTextRect(el: GateElement, canvasHeight: number): TextRect {
	const p = el.params ?? {};
	const size = num(p.fontSize, 15);
	const fontPx = (size * canvasHeight) / 90;
	const lines = textContent(el).split("\n");
	const longest = Math.max(1, ...lines.map((l) => l.length));
	const spacing = num(p.letterSpacing, 0);
	const width = longest * fontPx * 0.55 + Math.max(0, longest - 1) * spacing;
	const height = lines.length * fontPx * num(p.lineHeight, 1.2);
	const align = p.textAlign === "left" ? 0 : p.textAlign === "right" ? -width : -width / 2;
	return withBackground({ left: align, top: -height / 2, width, height }, p, size);
}

/** The editor's visual rect: the text block, grown by the background box when it is on (text/layout.ts). */
export function withBackground(rect: TextRect, p: Record<string, unknown>, fontSize: number): TextRect {
	if (p["background.enabled"] !== true || !p["background.color"] || p["background.color"] === "transparent") return rect;
	const ratio = fontSize / 15;
	const px = num(p["background.paddingX"], 30) * ratio;
	const py = num(p["background.paddingY"], 42) * ratio;
	const ox = num(p["background.offsetX"], 0);
	const oy = num(p["background.offsetY"], 0);
	const bg = { left: rect.left - px + ox, top: rect.top - py + oy, width: rect.width + 2 * px, height: rect.height + 2 * py };
	const left = Math.min(rect.left, bg.left);
	const top = Math.min(rect.top, bg.top);
	return {
		left,
		top,
		width: Math.max(rect.left + rect.width, bg.left + bg.width) - left,
		height: Math.max(rect.top + rect.height, bg.top + bg.height) - top,
	};
}

/** The element's box on the canvas (px, origin top-left), from its transform at its own start. */
export function textBox(
	el: GateElement,
	canvas: { width: number; height: number },
	measure?: TimelineCheckOptions["measureText"],
): { x0: number; y0: number; x1: number; y1: number } {
	const p = el.params ?? {};
	const rect = measure?.(el) ?? estimateTextRect(el, canvas.height);
	const sx = num(p["transform.scaleX"], 1);
	const sy = num(p["transform.scaleY"], 1);
	const cx = canvas.width / 2 + num(p["transform.positionX"], 0);
	const cy = canvas.height / 2 + num(p["transform.positionY"], 0);
	const corners = [
		[rect.left * sx, rect.top * sy],
		[(rect.left + rect.width) * sx, rect.top * sy],
		[rect.left * sx, (rect.top + rect.height) * sy],
		[(rect.left + rect.width) * sx, (rect.top + rect.height) * sy],
	];
	const rad = (num(p["transform.rotate"], 0) * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const xs = corners.map(([x, y]) => cx + x * cos - y * sin);
	const ys = corners.map(([x, y]) => cy + x * sin + y * cos);
	return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** The text safe area on a canvas (the platform's zone: Reels on 9:16, title-safe elsewhere). */
export function safeArea(canvas: { width: number; height: number }, platform?: string | null) {
	const z = safeZoneFor(canvas, platform);
	return { x0: z.x0, x1: z.x1, y0: z.y0, y1: z.y1 };
}

/** Exact ops that bring a box inside the zone: shrink about the anchor if it is too big, then move it in. */
export function fitOps(
	el: GateElement,
	box: { x0: number; y0: number; x1: number; y1: number },
	zone: SafeZone,
	canvas: { width: number; height: number },
): Array<Record<string, unknown>> {
	const p = el.params ?? {};
	const sx = num(p["transform.scaleX"], 1);
	const sy = num(p["transform.scaleY"], 1);
	const px = num(p["transform.positionX"], 0);
	const py = num(p["transform.positionY"], 0);
	const f = Math.min(1, ((zone.x1 - zone.x0) / (box.x1 - box.x0)) * 0.98, ((zone.y1 - zone.y0) / (box.y1 - box.y0)) * 0.98);
	const out: Array<Record<string, unknown>> = [];
	let { x0, y0, x1, y1 } = box;
	if (f < 1) {
		// the box scales about the element's anchor: the canvas centre + its position
		const ax = canvas.width / 2 + px;
		const ay = canvas.height / 2 + py;
		x0 = ax + (x0 - ax) * f;
		x1 = ax + (x1 - ax) * f;
		y0 = ay + (y0 - ay) * f;
		y1 = ay + (y1 - ay) * f;
		out.push({ op: "set", el: el.id, prop: "transform.scaleX", value: round(sx * f, 3) });
		out.push({ op: "set", el: el.id, prop: "transform.scaleY", value: round(sy * f, 3) });
	}
	const dx = x0 < zone.x0 ? zone.x0 - x0 + 2 : x1 > zone.x1 ? zone.x1 - x1 - 2 : 0;
	const dy = y0 < zone.y0 ? zone.y0 - y0 + 2 : y1 > zone.y1 ? zone.y1 - y1 - 2 : 0;
	if (Math.abs(dx) >= 0.5) out.push({ op: "set", el: el.id, prop: "transform.positionX", value: Math.round(px + dx) });
	if (Math.abs(dy) >= 0.5) out.push({ op: "set", el: el.id, prop: "transform.positionY", value: Math.round(py + dy) });
	return out;
}

function checkSafe(ctx: Ctx): void {
	const zone = ctx.zone;
	const tol = 0.5;
	const severity = modeOf(ctx, "SAFE") as Severity;
	for (const { track, el } of textElements(ctx.scene)) {
		if (!textContent(el).trim()) continue;
		const box = textBox(el, ctx.canvas, ctx.opts.measureText);
		const out = box.x0 < zone.x0 - tol || box.x1 > zone.x1 + tol || box.y0 < zone.y0 - tol || box.y1 > zone.y1 + tol;
		if (!out) continue;
		const caption = isCaption(track, el) || isCaptionTrackLike(track);
		const sides = [
			box.x0 < zone.x0 - tol ? `left by ${Math.round(zone.x0 - box.x0)} px` : "",
			box.x1 > zone.x1 + tol ? `right by ${Math.round(box.x1 - zone.x1)} px` : "",
			box.y0 < zone.y0 - tol ? `top by ${Math.round(zone.y0 - box.y0)} px` : "",
			box.y1 > zone.y1 + tol ? `bottom by ${Math.round(box.y1 - zone.y1)} px` : "",
		].filter(Boolean);
		const zoneText = `x ${Math.round(zone.x0)}–${Math.round(zone.x1)}, y ${Math.round(zone.y0)}–${Math.round(zone.y1)}`;
		const fit = fitOps(el, box, zone, ctx.canvas);
		add(ctx, "SAFE", severity, {
			t: elStart(el),
			t_end: elEnd(el),
			place: { track, el },
			track: caption ? "CAPTIONS" : "TEXT",
			measure: {
				box_x0_px: Math.round(box.x0),
				box_y0_px: Math.round(box.y0),
				box_x1_px: Math.round(box.x1),
				box_y1_px: Math.round(box.y1),
				measured: ctx.opts.measureText ? (ctx.opts.measureMethod ?? "canvas") : "estimate",
				zone: zone.name,
			},
			target: `inside ${zoneText} px (${zone.name})`,
			message: `${caption ? "Caption" : "Text"} ${label(el)} leaves the safe area (${sides.join(", ")}).`,
			fix: `move ${label(el)} inside the safe area (${zoneText}) or make it smaller`,
			fix_call: fit.length ? ops(fit, `gate fix (SAFE): bring ${label(el)} inside the safe area`, `scale/move ${label(el)} so its measured box sits inside ${zoneText}`) : null,
		});
	}
	// Declared composition text with a box (0..1 of the canvas).
	for (const p of videoElements(ctx.scene)) {
		const facts = compositionFacts(p.el, ctx.opts.compositions);
		for (const item of facts?.text ?? []) {
			if (!item.box) continue;
			const [x, y, w, h] = item.box;
			const box = { x0: x * ctx.canvas.width, y0: y * ctx.canvas.height, x1: (x + w) * ctx.canvas.width, y1: (y + h) * ctx.canvas.height };
			if (box.x0 >= zone.x0 - tol && box.x1 <= zone.x1 + tol && box.y0 >= zone.y0 - tol && box.y1 <= zone.y1 + tol) continue;
			add(ctx, "SAFE", severity, {
				key: `${p.el.id}-${item.content.slice(0, 12)}`,
				t: item.t !== undefined ? (localToTimeline(p.el, item.t) ?? elStart(p.el)) : elStart(p.el),
				t_end: elEnd(p.el),
				place: { track: p.track, el: p.el, isMain: p.isMain },
				measure: { box_x0_px: Math.round(box.x0), box_y0_px: Math.round(box.y0), box_x1_px: Math.round(box.x1), box_y1_px: Math.round(box.y1), measured: "declared" },
				target: `inside the safe area (${zone.name})`,
				message: `Text "${item.content.slice(0, 40)}" in ${label(p.el)} leaves the safe area.`,
				fix: `move the text inside the composition's safe area (RC.safe) and update the composition`,
				fix_call: { tool: "composition", arguments: { action: "get", element_id: p.el.id }, does: "read the composition's source, keep the text inside RC.safe, then composition update" },
			});
		}
	}
}

// ------------------------------------------------------------------ CAP-LEN

/** The caption builder's derived layers (word highlights, drop shadows) repeat the base chunk: checked once, on the base. */
function isDerivedCaptionLayer(track: GateTrack): boolean {
	const layer = track.restorff?.captionLayer;
	return layer === "words" || layer === "shadow" || /^CAPTION (WORDS|SHADOW)$/i.test(track.name ?? "");
}

function checkCapLen(ctx: Ctx): void {
	const severity = modeOf(ctx, "CAP-LEN") as Severity;
	const max = ctx.profile.capMax;
	for (const { track, el } of textElements(ctx.scene)) {
		if (!isCaption(track, el) || isDerivedCaptionLayer(track)) continue;
		const words = wordCount(textContent(el));
		if (words >= 1 && words <= max) continue;
		add(ctx, "CAP-LEN", severity, {
			t: elStart(el),
			t_end: elEnd(el),
			place: { track, el },
			track: "CAPTIONS",
			measure: { words, max_words: max },
			target: `1–${max} words per caption chunk (${max === 3 ? "R18, an ad" : `a ${ctx.profile.label}: the reels run 1–5`})`,
			message: words === 0 ? `Caption ${label(el)} is empty.` : `Caption ${label(el)} shows ${words} words at once.`,
			fix: `split the caption into chunks of 1–${max} words`,
			fix_call: { tool: "captions", arguments: { words_per_chunk: max }, does: `rebuild the captions from the transcript in chunks of at most ${max} words (one commit)` },
		});
	}
}

// ------------------------------------------------------------------ text on screen (timeline + compositions)

interface ScreenText {
	content: string;
	t: number;
	t_end: number;
	el: GateElement;
	track: GateTrack;
	isMain: boolean;
	caption: boolean;
	fromComposition: boolean;
}

function screenTexts(ctx: Ctx): ScreenText[] {
	const out: ScreenText[] = [];
	for (const { track, el } of textElements(ctx.scene)) {
		const content = textContent(el);
		if (!content.trim()) continue;
		out.push({ content, t: elStart(el), t_end: elEnd(el), el, track, isMain: false, caption: isCaption(track, el) || isCaptionTrackLike(track), fromComposition: false });
	}
	for (const p of videoElements(ctx.scene)) {
		if (!storedComposition(p.el)) continue;
		const facts = compositionFacts(p.el, ctx.opts.compositions);
		for (const item of facts?.text ?? []) {
			const t = item.t !== undefined ? (localToTimeline(p.el, item.t) ?? elStart(p.el)) : elStart(p.el);
			const t_end = item.t_end !== undefined ? (localToTimeline(p.el, item.t_end) ?? elEnd(p.el)) : elEnd(p.el);
			out.push({ content: item.content, t, t_end, el: p.el, track: p.track, isMain: p.isMain, caption: item.role === "caption", fromComposition: true });
		}
	}
	return out;
}

// ------------------------------------------------------------------ R3

function checkR3(ctx: Ctx): CheckRun["skipped"][number] | null {
	const mode = modeOf(ctx, "R3");
	if (mode === "skip") return { rule: "R3", why: skipWhy(ctx, "R3") };
	const by = ctx.profile.r3By;
	const texts = screenTexts(ctx).filter((x) => !x.caption);
	const early = texts.filter((x) => x.t <= by + 1e-6).sort((a, b) => a.t - b.t);
	if (early.some((x) => wordCount(x.content) <= 7)) return null;
	const target = `a headline of ≤ 7 words on screen by ${by} s (timeline text or text inside a composition)`;
	if (early.length) {
		const first = early[0];
		const words = wordCount(first.content);
		add(ctx, "R3", mode, {
			t: first.t,
			t_end: Math.min(first.t_end, 3),
			place: { track: first.track, el: first.el, isMain: first.isMain },
			track: "TEXT",
			measure: { words, in_composition: first.fromComposition },
			target,
			message: `The hook headline is ${words} words; 7 or fewer reads at a glance.`,
			fix: "cut the headline to 7 words or fewer",
			fix_call: first.fromComposition
				? { tool: "composition", arguments: { action: "get", element_id: first.el.id }, does: "shorten the opening text in the composition to ≤ 7 words, then composition update" }
				: ops([{ op: "set", el: first.el.id, prop: "content", value: first.content.split(/\s+/).slice(0, 7).join(" ") }], "gate fix (R3): hook headline ≤ 7 words", "keep the first 7 words of the headline (edit the words if they no longer read)"),
		});
		return null;
	}
	const later = texts.sort((a, b) => a.t - b.t)[0];
	add(ctx, "R3", mode, {
		t: 0,
		t_end: by,
		track: "TEXT",
		place: later ? { track: later.track, el: null, isMain: later.isMain } : null,
		element_id: null,
		measure: later ? { first_text_s: round(later.t) } : { first_text_s: null },
		target,
		message: later
			? `No hook headline by ${by} s: the first text appears at ${formatTime(later.t)} ("${later.content.slice(0, 40)}").`
			: "No hook headline: nothing on screen reads with the sound off.",
		fix: `add a headline (≤ 7 words) in by ${by} s`,
		fix_call: later && !later.fromComposition && wordCount(later.content) <= 7
			? ops([{ op: "move", el: later.el.id, t: 0 }], "gate fix (R3): the headline in on frame 1", `move ${label(later.el)} to 0.0 s (it is already ≤ 7 words)`)
			: { tool: "timeline_ops", arguments: { ops: [{ op: "text_pop", author: "claude", t: 0, dur: 2.5, text: "<the hook, ≤ 7 words>" }], message: "gate fix (R3): hook headline" }, does: "write the hook (≤ 7 words, your words) into text and commit" },
	});
	return null;
}

// ------------------------------------------------------------------ R15

const PRICE_RE =
	/([$€£₹¥]\s?\d[\d.,]*|\d[\d.,]*\s?(?:[$€£₹¥]|usd|eur|gbp|inr|rs\.?)\b|\d+\s?%\s?off|\bfree\b|\bbogo\b|buy\s?\d+\s?get)/i;
const REASON_RE =
	/\b(today|tonight|ends?|ending|only|limited|last|until|till|before|while|left|sale|launch|first\s\d+|this week|weekend|24\s?h|hours?|deadline|expires?|free shipping|drop|restock|sold out)\b/i;
const CTA_RE =
	/\b(shop|buy|order|get|try|tap|click|link in bio|sign up|signup|download|subscribe|claim|grab|book|start|join|visit|swipe|use code|save)\b/i;

function briefHasOffer(project: GateProject): boolean {
	const brief = briefOf(project);
	if (brief.offer === false) return false;
	const offer = typeof brief.offer === "object" && brief.offer ? brief.offer : {};
	return Boolean(offer.price ?? brief.price ?? offer.cta ?? brief.cta);
}

function checkR15(ctx: Ctx): CheckRun["skipped"][number] | null {
	const brief = briefOf(ctx.project);
	if (brief.offer === false) return { rule: "R15", why: "the brief says offer: false" };
	const mode = modeOf(ctx, "R15");
	if (mode === "skip") return { rule: "R15", why: skipWhy(ctx, "R15") };
	const offer = typeof brief.offer === "object" && brief.offer ? brief.offer : {};
	const price = offer.price ?? brief.price;
	const reason = offer.reason ?? brief.reason;
	const cta = offer.cta ?? brief.cta;

	const runtime = ctx.pic.runtime;
	const from = Math.max(0, runtime - 6);
	const texts = screenTexts(ctx).filter((x) => !x.caption && x.t_end > from + 1e-6 && x.t < runtime);
	const all = texts.map((x) => x.content).join(" \n ");
	const norm = (s: string) => s.replace(/\s+/g, " ").trim();
	const has = (needle: string | undefined, re: RegExp, caseSensitive: boolean) =>
		needle
			? caseSensitive
				? norm(all).includes(norm(needle))
				: norm(all).toLowerCase().includes(norm(needle).toLowerCase())
			: re.test(all);
	const missing: string[] = [];
	if (!has(price, PRICE_RE, true)) missing.push(price ? `the price "${price}"` : "a price or offer");
	if (!has(reason, REASON_RE, false)) missing.push(reason ? `the reason "${reason}"` : "a reason to act now");
	if (!has(cta, CTA_RE, false)) missing.push(cta ? `the CTA "${cta}"` : "a call to action");
	if (!missing.length) return null;
	const card = texts.sort((a, b) => b.t - a.t)[0] ?? null;
	const verified = Boolean(price && reason && cta);
	add(ctx, "R15", mode, {
		key: "offer",
		t: from,
		t_end: runtime,
		track: "TEXT",
		place: card ? { track: card.track, el: card.el, isMain: card.isMain } : null,
		element_id: card?.el.id ?? null,
		measure: { texts_in_window: texts.length, verified_strings: Boolean(price || reason || cta), piece: ctx.piece.type },
		target: "in the last 6 s: the verified price + a reason to act now + a CTA",
		message: `The last 6 s are missing ${missing.join(", ")}${price || reason || cta ? "" : " (no verified offer in the brief: matched by pattern)"}.`,
		fix: `add the offer card: ${price ?? "{price}"} + ${reason ?? "{reason}"} + ${cta ?? "{cta}"}, in the last 6 s`,
		fix_call: verified
			? ops([{ op: "text_pop", t: round(Math.max(0, runtime - 5), 3), dur: round(Math.min(5, runtime), 3), text: `${price} · ${reason} · ${cta}` }], "gate fix (R15): the offer card", "put the brief's verified offer on screen for the last 5 s")
			: { tool: "timeline", arguments: { action: "summary" }, does: "the brief has no verified offer: ask the owner for the price, the reason and the CTA (never invent an offer), or the owner sets the piece type if this is not an ad" },
	});
	return null;
}

// ------------------------------------------------------------------ R1 R5 R6 (picture changes)

function checkRhythm(ctx: Ctx): CheckRun["skipped"] {
	const skipped: CheckRun["skipped"] = [];
	const { shots, runtime } = ctx.pic;
	const bars = ctx.profile.rhythm;
	if (!shots.length) return skipped;
	const brief = briefOf(ctx.project);
	const counted = `picture changes (${Object.entries(ctx.pic.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`).join(", ") || "none"})`;
	const placeOf = (s: (typeof shots)[number]) => ({ track: s.track, el: s.el, isMain: s.isMain });
	// R1
	const r1 = modeOf(ctx, "R1");
	if (r1 === "skip" || bars.r1 === null) skipped.push({ rule: "R1", why: skipWhy(ctx, "R1") });
	else {
		const opening = shots.filter((s) => s.t < 3 - 1e-6).length;
		const dramatic = brief.dramatic_open === true || shots[0].el.restorff?.dramatic === true;
		if (opening < bars.r1 && !dramatic && runtime >= 3) {
			const first = shots[0];
			const spans = first.t_end >= 3 - 1e-6 && first.el.type !== "text" && !storedComposition(first.el);
			add(ctx, "R1", r1, {
				key: "open",
				t: 0,
				t_end: Math.min(3, runtime),
				place: placeOf(first),
				measure: { shots_in_first_3s: opening },
				target: `≥ ${bars.r1} shots start in 0–3 s (or one marked dramatic shot)`,
				message: `Only ${opening} shot${opening === 1 ? "" : "s"} in the first 3 s; the hook needs at least ${bars.r1}.`,
				fix: "cut the first 3 s into 3 or more shots, or mark the opening as one dramatic shot",
				fix_call: spans
					? ops(
							[
								{ op: "split", el: first.el.id, t: 1, ref: "r1-b" },
								{ op: "set", el: "r1-b", prop: "transform.scaleX", value: 1.15 },
								{ op: "set", el: "r1-b", prop: "transform.scaleY", value: 1.15 },
								{ op: "split", el: "r1-b", t: 2, ref: "r1-c" },
								{ op: "set", el: "r1-c", prop: "transform.scaleX", value: 1 },
								{ op: "set", el: "r1-c", prop: "transform.scaleY", value: 1 },
							],
							"gate fix (R1): punch-in cuts at 1 s and 2 s",
							"three shots in the first 3 s: a punch-in (1.15x) cut at 1 s and back at 2 s",
						)
					: look([0.5, 1.5, 2.5], "look at the opening, then cut it into 3 shots"),
			});
		}
	}
	// R5
	const r5 = modeOf(ctx, "R5");
	if (r5 === "skip") skipped.push({ rule: "R5", why: skipWhy(ctx, "R5") });
	else {
		if (bars.median !== null) {
			const lengths = shots.map((s) => s.t_end - s.t).sort((a, b) => a - b);
			const mid = Math.floor(lengths.length / 2);
			const median = lengths.length % 2 ? lengths[mid] : (lengths[mid - 1] + lengths[mid]) / 2;
			if (median > bars.median + 1e-6) {
				add(ctx, "R5", r5, {
					key: "median",
					t: 0,
					t_end: runtime,
					track: "V1 A-ROLL",
					element_id: null,
					measure: { median_shot_s: round(median), shots: shots.length },
					target: `median shot ≤ ${bars.median} s (${bars.basis}); counted: ${counted}`,
					message: `The median shot is ${round(median, 1)} s; the bar is ${bars.median} s.`,
					fix: "tighten the cut: split long shots or trim them so the median is under the bar",
					fix_call: look(shots.filter((s) => s.t_end - s.t > bars.median!).slice(0, 6).map((s) => (s.t + s.t_end) / 2), "look at the longest shots, then split or trim them"),
				});
			}
		}
		for (const s of shots) {
			const len = s.t_end - s.t;
			if (len <= bars.longest + 1e-6 || s.moving) continue;
			const camera = s.el.type === "video" || s.el.type === "image";
			add(ctx, "R5", r5, {
				t: s.t,
				t_end: s.t_end,
				place: placeOf(s),
				measure: { shot_s: round(len), longest_s: bars.longest },
				target: `no stretch over ${bars.longest} s without a picture change or a camera move (${bars.basis})`,
				message: `${label(s.el)} holds for ${round(len, 1)} s with no change on screen.`,
				fix: `cut ${label(s.el)} to ${bars.longest} s or give it a move`,
				fix_call: camera
					? ops(
							[
								{ op: "keyframe", el: s.el.id, prop: "scale", t: round(s.t, 3), value: 1 },
								{ op: "keyframe", el: s.el.id, prop: "scale", t: round(s.t_end, 3), value: 1.08 },
							],
							`gate fix (R5): a slow push-in on ${s.el.name ?? s.el.id}`,
							`a slow push-in (1.0 → 1.08) from ${formatTime(s.t)} to ${formatTime(s.t_end)}: the shot moves`,
						)
					: look([s.t + len / 2], "look at the hold, then add a change (a beat, a cut) inside it"),
			});
		}
	}
	// R6: every 10 s window; a final partial window ≥ 2.5 s needs its share.
	const r6 = modeOf(ctx, "R6");
	if (r6 === "skip") skipped.push({ rule: "R6", why: skipWhy(ctx, "R6") });
	else {
		for (let w = 0; w < runtime - 1e-6; w += 10) {
			const end = Math.min(runtime, w + 10);
			const len = end - w;
			if (len < 2.5) break;
			const need = Math.ceil((bars.perTen * len) / 10 - 1e-9);
			const count = shots.filter((s) => s.t >= w - 1e-9 && s.t < end - 1e-9).length;
			if (count >= need) continue;
			if (bars.movingCounts && shots.filter((s) => s.t < end && s.t_end > w).every((s) => s.moving)) continue;
			const longest = shots
				.filter((s) => s.t < end && s.t_end > w)
				.sort((a, b) => Math.min(end, b.t_end) - Math.max(w, b.t) - (Math.min(end, a.t_end) - Math.max(w, a.t)))[0];
			const camera = longest && (longest.el.type === "video" || longest.el.type === "image") && !storedComposition(longest.el);
			const mid = longest ? round((Math.max(w, longest.t) + Math.min(end, longest.t_end)) / 2, 3) : w + len / 2;
			add(ctx, "R6", r6, {
				key: `w${w}`,
				t: w,
				t_end: end,
				place: longest ? placeOf(longest) : null,
				measure: { shots_in_window: count, window_s: round(len), need },
				target: `≥ ${bars.perTen} picture changes per 10 s (${bars.basis}); counted: ${counted}`,
				message: `${count} shot${count === 1 ? "" : "s"} between ${formatTime(w)} and ${formatTime(end)}; the bar is ${need}.`,
				fix: `cut ${formatTime(w)}–${formatTime(end)} into ${need} or more shots (or add beats on screen)`,
				fix_call: camera
					? ops(
							[
								{ op: "split", el: longest.el.id, t: mid, ref: "r6-b" },
								{ op: "set", el: "r6-b", prop: "transform.scaleX", value: 1.12 },
								{ op: "set", el: "r6-b", prop: "transform.scaleY", value: 1.12 },
							],
							`gate fix (R6): a punch-in cut at ${formatTime(mid)}`,
							`one more shot in the window: a punch-in cut (1.12x) at ${formatTime(mid)}; repeat if the bar needs more`,
						)
					: look([mid], "look at the window, then add a cut or a beat"),
			});
		}
	}
	return skipped;
}

// ------------------------------------------------------------------ R12

function checkR12(ctx: Ctx): CheckRun["skipped"][number] | null {
	const mode = modeOf(ctx, "R12");
	if (mode === "skip") return { rule: "R12", why: skipWhy(ctx, "R12") };
	const runtime = ctx.pic.runtime;
	if (runtime <= 0) return null;
	const music = union(sounds(ctx.scene).filter((s) => s.role === "music"));
	const silences = (restorffMeta(ctx.project).silences ?? []).filter((s) => s.reason?.trim());
	const covered = union([...music, ...silences.map((s) => ({ t: s.t, t_end: s.t_end }))]);
	const coveredS = covered.reduce((a, s) => a + Math.max(0, Math.min(runtime, s.t_end) - Math.max(0, s.t)), 0);
	const share = coveredS / runtime;
	if (share >= 0.9 - 1e-9) return null;
	let gap = { t: 0, t_end: runtime };
	let cursor = 0;
	let best = -1;
	for (const s of [...covered, { t: runtime, t_end: runtime }]) {
		if (s.t - cursor > best) {
			best = s.t - cursor;
			gap = { t: cursor, t_end: s.t };
		}
		cursor = Math.max(cursor, s.t_end);
	}
	const musicSound = sounds(ctx.scene).find((s) => s.role === "music") ?? null;
	const musicTrack = musicSound?.track ?? findTrack(ctx.scene, (t) => t.type === "audio" && (t.restorff?.role === "music" || /MUSIC/i.test(t.name ?? "")));
	add(ctx, "R12", mode, {
		key: "bed",
		t: gap.t,
		t_end: gap.t_end,
		track: "MUSIC",
		place: musicTrack ? { track: musicTrack, el: musicSound?.el ?? null } : null,
		element_id: musicSound?.el.id ?? null,
		measure: { music_coverage_pct: round(share * 100, 1) },
		target: `music covers ≥ 90 % of the runtime, or each gap has a silence reason${mode === "info" ? ` (optional on a ${ctx.profile.label})` : ""}`,
		message: music.length
			? `The music bed covers ${round(share * 100, 0)} % of the cut; ${formatTime(gap.t)}–${formatTime(gap.t_end)} has none.`
			: "There is no music bed.",
		fix: `run the bed under ${formatTime(gap.t)}–${formatTime(gap.t_end)}, or write why it is silent`,
		fix_call: { tool: "music", arguments: { action: "place", mood: "warm", t: round(gap.t, 3), duration_s: round(Math.max(0.5, gap.t_end - gap.t), 3) }, does: `a generated bed under ${formatTime(gap.t)}–${formatTime(gap.t_end)}, ducked under the voice (pick the mood)` },
	});
	return null;
}

// ------------------------------------------------------------------ R23

function checkR23(ctx: Ctx): CheckRun["skipped"][number] | null {
	const mode = modeOf(ctx, "R23");
	if (mode === "skip") return { rule: "R23", why: skipWhy(ctx, "R23") };
	const all = sounds(ctx.scene);
	const hits = musicHits(ctx.scene);
	for (const s of ctx.pic.shots) {
		if (typeof s.el.restorff?.silence === "string" && s.el.restorff.silence.trim()) continue;
		const designed = all.some((snd) => snd.role !== "music" && snd.t < s.t_end - 1e-6 && snd.t_end > s.t + 1e-6);
		const hit = hits.some((h) => h >= s.t - 1e-6 && h < s.t_end);
		if (designed || hit) continue;
		const sfxTrack = findTrack(ctx.scene, (t) => t.type === "audio" && (t.restorff?.role === "sfx" || /SFX/i.test(t.name ?? "")));
		add(ctx, "R23", mode, {
			t: s.t,
			t_end: s.t_end,
			track: "SFX",
			place: sfxTrack ? { track: sfxTrack, el: null } : null,
			element_id: s.el.id,
			target: "every shot has voice, an SFX, a music hit, room tone, or a silence reason",
			message: `${label(s.el)} (${formatTime(s.t)}) has no designed sound.`,
			fix: `add an SFX for ${label(s.el)} (named, on the visual event), or write why it is silent`,
			fix_call: { tool: "sounds", arguments: { action: "place", name: "whoosh-short", t: round(s.t, 3) }, does: `a whoosh on the change at ${formatTime(s.t)} (pick the sound that matches the picture)` },
		});
	}
	return null;
}

// ------------------------------------------------------------------ R4

function checkR4(ctx: Ctx): CheckRun["skipped"][number] | null {
	const mode = modeOf(ctx, "R4");
	if (mode === "skip") return { rule: "R4", why: skipWhy(ctx, "R4") };
	const frame = frameSeconds(ctx.project);
	const all = sounds(ctx.scene);
	const sfxAtZero = all.some((s) => s.role === "sfx" && s.t <= frame + 1e-6);
	const beatsKnown = all.some((s) => s.role === "music" && s.el.beats?.times?.length);
	const musicAtZero = beatsKnown
		? musicHits(ctx.scene).some((h) => h <= frame + 1e-6)
		: // ASSUMPTION: with no beat grid, a music element that starts on frame 1 counts as a downbeat.
			all.some((s) => s.role === "music" && s.t <= frame + 1e-6);
	if (sfxAtZero || musicAtZero) return null;
	const sfxTrack = findTrack(ctx.scene, (t) => t.type === "audio" && (t.restorff?.role === "sfx" || /SFX/i.test(t.name ?? "")));
	add(ctx, "R4", mode, {
		key: "frame1",
		t: 0,
		t_end: null,
		track: "SFX",
		place: sfxTrack ? { track: sfxTrack, el: null } : null,
		element_id: null,
		target: "an SFX or a music downbeat at 0.0 s",
		message: "Frame 1 has no sound hit.",
		fix: "start the hook on a hit: an SFX or a downbeat at 0.0 s",
		fix_call: { tool: "sounds", arguments: { action: "place", name: "impact", t: 0 }, does: "an impact on frame 1" },
	});
	return null;
}

// ------------------------------------------------------------------ R21

function checkR21(ctx: Ctx): CheckRun["skipped"][number] | null {
	const mode = modeOf(ctx, "R21");
	if (mode === "skip") return { rule: "R21", why: skipWhy(ctx, "R21") };
	const meta = restorffMeta(ctx.project);
	const board = meta.board?.music?.hits ?? meta.music?.hits ?? [];
	if (!board.length) return { rule: "R21", why: "no board music.hits markers in metadata.restorff" };
	const frame = frameSeconds(ctx.project);
	const cuts = ctx.pic.shots.map((s) => s.t).filter((t) => t > 0);
	const beats = musicHits(ctx.scene);
	const musicSound = sounds(ctx.scene).find((s) => s.role === "music") ?? null;
	for (const h of board) {
		const ok = [...cuts, ...beats].some((x) => Math.abs(x - h.t) <= frame + 1e-6);
		if (ok) continue;
		const s = ctx.pic.shots.find((x) => x.t <= h.t && h.t < x.t_end) ?? null;
		const what = h.what ?? "hit";
		add(ctx, "R21", mode, {
			t: h.t,
			t_end: null,
			track: "MUSIC",
			place: musicSound ? { track: musicSound.track, el: null } : null,
			element_id: null,
			measure: { board_hit_s: h.t },
			target: "every board music hit lands on a cut or a music hit within one frame",
			message: `The board's ${what} at ${formatTime(h.t)} lands on no cut and no music hit.`,
			fix: `move the music so its ${what} lands on ${h.shot ?? (s ? label(s.el) : formatTime(h.t))}`,
			fix_call: { tool: "timeline_ops", arguments: { ops: [{ op: "snap_cuts", author: "claude", track: "main", max_shift: 0.2 }], message: "gate fix (R21): cuts onto the beat grid" }, does: "snap the cuts to the music's beats (within 0.2 s); move the bed if the board's hit still misses" },
		});
	}
	return null;
}

// ------------------------------------------------------------------ CLEAN (timeline half)

function checkClean(ctx: Ctx): void {
	const frame = frameSeconds(ctx.project);
	const severity = modeOf(ctx, "CLEAN") as Severity;
	const main = ctx.scene.tracks.main;
	for (const g of ctx.map.gaps) {
		if (g.t_end - g.t < frame - 1e-6) continue;
		const next = main?.elements.find((el) => Math.abs(elStart(el) - g.t_end) < 1e-6) ?? null;
		add(ctx, "CLEAN", severity, {
			key: `gap${Math.round(g.t * 100)}`,
			t: g.t,
			t_end: g.t_end,
			track: "V1 A-ROLL",
			place: main ? { track: main, el: null, isMain: true } : null,
			element_id: null,
			measure: { black_s: round(g.t_end - g.t, 3) },
			target: "0 black frames",
			message: `No picture from ${formatTime(g.t)} to ${formatTime(g.t_end)} (${round(g.t_end - g.t, 2)} s of black).`,
			fix: "close the gap on the video track: move the next clip up, extend a clip, or end the cut earlier",
			fix_call: next
				? ops([{ op: "move", el: next.id, t: round(g.t, 3) }], "gate fix (CLEAN): close the gap", `move ${label(next)} up to ${formatTime(g.t)} (check what follows it)`)
				: look([g.t, (g.t + g.t_end) / 2], "look at the black, then extend a clip over it"),
		});
	}
	const held: Array<{ el: GateElement; track: GateTrack; isMain: boolean; held: number }> = [];
	for (const { el, isMain, track } of videoElements(ctx.scene)) {
		if (el.type !== "video" || storedComposition(el)) continue;
		const rate = el.retime?.rate || 1;
		const known =
			ctx.opts.media?.[el.mediaId ?? ""]?.duration ??
			(typeof el.sourceDuration === "number" ? ticksToSeconds(el.sourceDuration) : undefined);
		if (known === undefined) continue;
		const need = ticksToSeconds((el.trimStart ?? 0) + el.duration * rate);
		const over = (need - known) / rate;
		if (over > frame + 1e-6) held.push({ el, isMain, track, held: over });
	}
	const total = held.reduce((a, h) => a + h.held, 0);
	for (const h of held) {
		const sev: Severity = severity === "must" && (h.held >= 1.5 || total >= 0.5) ? "must" : severity === "info" ? "info" : "should";
		const from = elEnd(h.el) - h.held;
		add(ctx, "CLEAN", sev, {
			t: from,
			t_end: elEnd(h.el),
			place: { track: h.track, el: h.el, isMain: h.isMain },
			measure: { held_s: round(h.held, 3), held_total_s: round(total, 3) },
			target: "held frames < 0.2 s each, < 0.5 s in total; ≥ 1.5 s is a stall",
			message: `${label(h.el)} is ${round(h.held, 2)} s shorter than its slot: the picture holds still at the end.`,
			fix: "the clip is shorter than its slot: trim the slot, extend the clip, or add a camera move",
			fix_call: ops(
				[
					{ op: "keyframe", el: h.el.id, prop: "scale", t: round(elStart(h.el), 3), value: 1 },
					{ op: "keyframe", el: h.el.id, prop: "scale", t: round(elEnd(h.el), 3), value: 1.08 },
				],
				`gate fix (CLEAN): a camera move through ${h.el.name ?? h.el.id}'s held tail`,
				`a slow push-in so the held ${round(h.held, 2)} s still moves (or trim the slot to the clip)`,
			),
		});
	}
}

// ------------------------------------------------------------------ FORMAT (timeline half)

export function parseDeliver(deliver: unknown): { width: number; height: number } {
	if (deliver && typeof deliver === "object") {
		const d = deliver as { width?: number; height?: number };
		if (d.width && d.height) return { width: d.width, height: d.height };
	}
	if (typeof deliver === "string") {
		const m = /(\d{3,5})\s*[x×]\s*(\d{3,5})/.exec(deliver);
		if (m) return { width: Number(m[1]), height: Number(m[2]) };
	}
	return { width: 1080, height: 1920 };
}

/** The brief's delivery size when the brief says one, else null (the canvas is the delivery). */
export function briefDeliver(project: GateProject): { width: number; height: number } | null {
	const d = briefOf(project).deliver;
	return d ? parseDeliver(d) : null;
}

const STANDARD_FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

function checkFormat(ctx: Ctx): void {
	const brief = briefOf(ctx.project);
	const { width, height } = ctx.canvas;
	const severity = modeOf(ctx, "FORMAT") as Severity;
	const want = briefDeliver(ctx.project);
	const aspect = aspectName(width, height);
	if (want && (width !== want.width || height !== want.height)) {
		const sameOrientation = (want.width >= want.height) === (width >= height);
		const reframeSize = aspectName(want.width, want.height);
		add(ctx, "FORMAT", severity, {
			key: "canvas",
			t: 0,
			t_end: null,
			track: "MASTER",
			measure: { width_px: width, height_px: height },
			target: `${want.width}x${want.height} (the brief's deliver)`,
			message: `The canvas is ${width}x${height}; the brief delivers ${want.width}x${want.height}.`,
			fix: sameOrientation ? `set the canvas to ${want.width}x${want.height} and re-render` : `reframe the cut to ${want.width}x${want.height} (an orientation change), or the owner changes the brief`,
			fix_call: sameOrientation
				? ops([{ op: "set_canvas", w: want.width, h: want.height }], "gate fix (FORMAT): the brief's delivery size", `canvas to ${want.width}x${want.height} (same orientation)`)
				: reframeSize && ["4:5", "1:1", "16:9"].includes(reframeSize)
					? { tool: "cutout", arguments: { action: "reframe", size: reframeSize }, does: `reframe to ${reframeSize} on its own branch, clips following the face boxes` }
					: { tool: "timeline", arguments: { action: "summary" }, does: `no automatic reframe to ${want.width}x${want.height}: ask the owner (the brief or a re-edit)` },
		});
	} else if (!want && (!aspect || !ctx.profile.aspects.includes(aspect) || Math.min(width, height) < 720)) {
		const [w, h] = nearestStandard(width, height, ctx.profile.aspects);
		add(ctx, "FORMAT", severity, {
			key: "canvas",
			t: 0,
			t_end: null,
			track: "MASTER",
			measure: { width_px: width, height_px: height, aspect: aspect ?? "non-standard" },
			target: `a ${ctx.profile.label} in ${ctx.profile.aspects.join(" · ")}, short side ≥ 720 px`,
			message: `The canvas is ${width}x${height} (${aspect ?? "a non-standard aspect"}); a ${ctx.profile.label} is delivered in ${ctx.profile.aspects.join(" · ")}.`,
			fix: `set the canvas to ${w}x${h} (same orientation) and re-render`,
			fix_call: ops([{ op: "set_canvas", w, h }], "gate fix (FORMAT): a standard delivery size", `canvas to ${w}x${h}: the nearest standard size in the same orientation`),
		});
	}
	const fps = ctx.fps;
	const bad = brief.fps ? Math.abs(fps - brief.fps) > 0.01 : !STANDARD_FPS.some((f) => Math.abs(f - fps) < 0.01);
	if (bad) {
		const to = brief.fps ?? 30;
		add(ctx, "FORMAT", severity, {
			key: "fps",
			t: 0,
			t_end: null,
			track: "MASTER",
			measure: { fps: round(fps, 3) },
			target: brief.fps ? `${brief.fps} fps (the brief)` : "a standard frame rate",
			message: `The project runs at ${round(fps, 3)} fps${brief.fps ? `; the brief asks for ${brief.fps}` : ""}.`,
			fix: `set the project to ${to} fps and re-render`,
			fix_call: ops([{ op: "set_canvas", fps: to }], "gate fix (FORMAT): frame rate", `the project to ${to} fps`),
		});
	}
}

// ------------------------------------------------------------------ FACE

interface Overlay {
	el: GateElement;
	track: GateTrack;
	order: number;
	kind: "text" | "caption" | "composition" | "picture";
}

function overlaysOf(ctx: Ctx): Overlay[] {
	const out: Overlay[] = [];
	ctx.scene.tracks.overlay.forEach((track, order) => {
		if (track.hidden) return;
		for (const el of track.elements) {
			if (el.hidden) continue;
			if (el.type === "text") {
				if (!textContent(el).trim() || track.restorff?.captionLayer === "shadow" || /^CAPTION SHADOW$/i.test(track.name ?? "")) continue;
				out.push({ el, track, order, kind: isCaption(track, el) || isCaptionTrackLike(track) ? "caption" : "text" });
				continue;
			}
			if (track.type !== "video" || (el.type !== "video" && el.type !== "image") || isCutout(el)) continue;
			const fx = effectOf(el);
			if (fx && (fx.side === "below_cutout" || (fx as { layer?: string }).layer === "back")) continue;
			if (covers({ track, el, order, isMain: false }, { media: ctx.opts.media, compositions: ctx.opts.compositions })) continue;
			out.push({ el, track, order, kind: storedComposition(el) ? "composition" : "picture" });
		}
	});
	return out;
}

/** A cut-out of the person drawn above this overlay at t (the face is in front of it). */
function cutoutAbove(ctx: Ctx, order: number, t: number): boolean {
	return ctx.scene.tracks.overlay.some((track, i) => i < order && !track.hidden && track.elements.some((el) => isCutout(el) && within(el, t)));
}

function checkFace(ctx: Ctx): CheckRun["skipped"][number] | null {
	const mode = modeOf(ctx, "FACE");
	if (mode === "skip") return { rule: "FACE", why: skipWhy(ctx, "FACE") };
	const faces = ctx.opts.faces ?? {};
	const faceRuns = ctx.pic.base.filter((r) => r.el.type === "video" && r.el.mediaId && faces[r.el.mediaId]);
	// revise-safety (2026-10-21): talking clips with no face box yet — captions over them are judged against a presumed face
	const presumed = new Set(ctx.opts.presumedFaces ?? []);
	const presumedRuns = ctx.pic.base.filter((r) => r.el.type === "video" && r.el.mediaId && presumed.has(r.el.mediaId) && !faces[r.el.mediaId]);
	if (presumedRuns.length) checkPresumedFaces(ctx, mode, presumedRuns);
	if (!faceRuns.length) {
		if (presumedRuns.length) return null;
		return {
			rule: "FACE",
			why: Object.keys(faces).length
				? "no clip with face boxes is on screen"
				: "no face boxes: none of the clips on screen has a person matte (cutout matte {element_id} makes one, then check again)",
		};
	}
	const step = 0.1;
	const W = ctx.canvas.width;
	const H = ctx.canvas.height;
	for (const o of overlaysOf(ctx)) {
		const samples: Array<{ t: number; v: number; face: Box01; over: Box01 | null }> = [];
		// a picture with alpha (a PNG plate) is judged by its visible pixels, like a composition
		const pictureAlpha = o.kind === "picture" ? (ctx.opts.compositions?.[o.el.id] ?? ctx.opts.compositions?.[o.el.mediaId ?? ""] ?? null) : null;
		const facts = o.kind === "composition" ? compositionFacts(o.el, ctx.opts.compositions) : pictureAlpha?.alpha ? pictureAlpha : null;
		if (o.kind === "composition" && !facts?.alpha) continue; // no measured coverage: nothing to say
		let tb: { x0: number; y0: number; x1: number; y1: number } | null = null;
		if (o.kind === "text" || o.kind === "caption") tb = textBox(o.el, ctx.canvas, ctx.opts.measureText);
		const pictureBox = (): Box01 | null => {
			const info = ctx.opts.media?.[o.el.mediaId ?? ""];
			if (!info?.width || !info.height) return null;
			const p = o.el.params ?? {};
			const contain = Math.min(W / info.width, H / info.height);
			const dw = info.width * contain * Math.abs(num(p["transform.scaleX"], 1));
			const dh = info.height * contain * Math.abs(num(p["transform.scaleY"], 1));
			const cx = W / 2 + num(p["transform.positionX"], 0);
			const cy = H / 2 + num(p["transform.positionY"], 0);
			return [(cx - dw / 2) / W, (cy - dh / 2) / H, (cx + dw / 2) / W, (cy + dh / 2) / H];
		};
		const pbox = o.kind === "picture" && !facts ? pictureBox() : null;
		if (o.kind === "picture" && !pbox && !facts) continue;
		for (const run of faceRuns) {
			const a = Math.max(run.t, elStart(o.el));
			const b = Math.min(run.t_end, elEnd(o.el));
			if (b - a < step / 2) continue;
			const track = faces[run.el.mediaId as string];
			for (const t of sampleTimes(a, b, step)) {
				if (cutoutAbove(ctx, o.order, t)) continue;
				const face = faceOnCanvas(run.el, track, t, ctx.canvas);
				if (!face) continue;
				let v = 0;
				let over: Box01 | null = null;
				if (tb) {
					over = [tb.x0 / W, tb.y0 / H, tb.x1 / W, tb.y1 / H];
					v = boxCoverage(face, over);
				} else if (pbox) {
					over = pbox;
					v = boxCoverage(face, pbox);
				} else if (facts) {
					// a layer that fills most of the frame is a frame treatment (a pullback, a zoom), not an overlay on the face
					if ((compositionFaceCoverage(o.el, facts, [0, 0, 1, 1], t) ?? 0) >= 0.6) continue;
					v = compositionFaceCoverage(o.el, facts, face, t) ?? 0;
				}
				samples.push({ t, v, face, over });
			}
		}
		const runs = runsOf(samples, 0.25, step).filter((r) => r.t_end - r.t >= 0.3 - 1e-6);
		if (!runs.length) continue;
		const worst = runs.sort((x, y) => y.peak - x.peak)[0];
		const at = samples.filter((s) => s.t >= worst.t - 1e-9 && s.t < worst.t_end).sort((x, y) => y.v - x.v)[0];
		const face = at.face;
		const what = o.kind === "caption" ? "Caption" : o.kind === "text" ? "Text" : o.kind === "composition" ? "Overlay" : "Picture";
		add(ctx, "FACE", mode, {
			t: worst.t,
			t_end: Math.min(elEnd(o.el), worst.t_end),
			place: { track: o.track, el: o.el },
			measure: {
				face_covered_pct: Math.round(worst.peak * 100),
				face_x0: round(face[0], 3),
				face_y0: round(face[1], 3),
				face_x1: round(face[2], 3),
				face_y1: round(face[3], 3),
				covered_s: round(worst.t_end - worst.t, 2),
				measured: o.kind === "composition" ? "alpha of its own render" : o.kind === "picture" ? "media size" : ctx.opts.measureText ? (ctx.opts.measureMethod ?? "canvas") : "estimate",
			},
			target: "no overlay over the face box (≥ 25 % of the face for ≥ 0.3 s)",
			message: `${what} ${label(o.el)} covers ${Math.round(worst.peak * 100)} % of the face from ${formatTime(worst.t)} to ${formatTime(worst.t_end)}.`,
			fix: `move ${label(o.el)} off the face (above or below the face box y ${Math.round(face[1] * H)}–${Math.round(face[3] * H)} px)`,
			fix_call: faceFix(ctx, o, face, at.over),
		});
	}
	return null;
}

/**
 * Where a face is presumed in a talking clip with no face box: the middle band of the frame (centre of the caption
 * inside 33–75 % of the height). MEASURED on the oat run's c02 close-up: the face box spans y 0.52–0.75; the caption the
 * Sonnet run left there (centre ≈ 0.49) sat on the eyes.
 */
export const PRESUMED_FACE_BAND = { y0: 0.33, y1: 0.75 } as const;

/**
 * FACE for captions over talking clips with no face box (revise-safety, 2026-10-21): one finding per clip run whose
 * captions sit with their centre inside the presumed face band for ≥ 0.3 s. Measured: the caption's box (text
 * measurer); presumed: the face. The fix rebuilds the captions in the top zone, or makes the face box first.
 */
function checkPresumedFaces(ctx: Ctx, mode: Severity, runs: Array<{ el: GateElement; t: number; t_end: number }>): void {
	const step = 0.1;
	const H = ctx.canvas.height;
	const captions = overlaysOf(ctx).filter((o) => o.kind === "caption");
	for (const run of runs) {
		const samples: Array<{ t: number; v: number }> = [];
		let first: Overlay | null = null;
		let chunks = 0;
		let centre = 0;
		for (const o of captions) {
			const a = Math.max(run.t, elStart(o.el));
			const b = Math.min(run.t_end, elEnd(o.el));
			if (b - a < step / 2) continue;
			const tb = textBox(o.el, ctx.canvas, ctx.opts.measureText);
			const cy = (tb.y0 + tb.y1) / 2 / H;
			if (cy < PRESUMED_FACE_BAND.y0 || cy > PRESUMED_FACE_BAND.y1) continue;
			let hit = false;
			for (const t of sampleTimes(a, b, step)) {
				if (cutoutAbove(ctx, o.order, t)) continue;
				samples.push({ t, v: 1 });
				hit = true;
			}
			if (!hit) continue;
			chunks++;
			centre += cy;
			first ??= o;
		}
		const found = runsOf(samples.sort((x, y) => x.t - y.t), 0.5, step).filter((r) => r.t_end - r.t >= 0.3 - 1e-6);
		if (!found.length || !first) continue;
		const covered = found.reduce((sum, r) => sum + (r.t_end - r.t), 0);
		const mean = centre / Math.max(1, chunks);
		add(ctx, "FACE", mode, {
			t: found[0].t,
			t_end: found[found.length - 1].t_end,
			place: { track: first.track, el: first.el },
			key: `${run.el.id}-presumed`,
			measure: {
				presumed_face: true,
				face_band_pct: `${PRESUMED_FACE_BAND.y0 * 100}–${PRESUMED_FACE_BAND.y1 * 100}`,
				captions: chunks,
				caption_centre_y_pct: round(mean * 100, 1),
				covered_s: round(covered, 2),
				measured: ctx.opts.measureText ? (ctx.opts.measureMethod ?? "canvas") : "estimate",
			},
			target: "captions over a talking clip with no face box sit outside the middle band (33–75 % of the height) where its face usually is",
			message: `${chunks} caption(s) sit mid-frame (centre at ${round(mean * 100, 0)} % of the height) over ${label(run.el)}, a talking clip with no face box yet, from ${formatTime(found[0].t)} to ${formatTime(found[found.length - 1].t_end)}: they may cover the face.`,
			fix: `move them to the top band (captions zone top), or make the clip's face box (cutout matte) and rebuild the captions so they are placed clear of the face`,
			fix_call: { tool: "captions", arguments: { zone: "top" }, does: "rebuild the captions in the top zone, above where a talking head's face usually is (or run cutout {action: \"matte\", element_id} first, then captions, to place them by the real face)" },
		});
	}
}

/** Move an overlay clear of the face: the caption zone that misses it, or the nearest y above / below inside the safe zone. */
function faceFix(ctx: Ctx, o: Overlay, face: Box01, over: Box01 | null): FixCall {
	const H = ctx.canvas.height;
	const zone = ctx.zone;
	if (o.kind === "caption" && over) {
		const h = (over[3] - over[1]) * H;
		const options = (Object.entries(CAPTION_ZONES) as Array<[string, number]>).map(([name, anchor]) => {
			const cy = Math.min(zone.y1 - h / 2, Math.max(zone.y0 + h / 2, zone.y0 + anchor * (zone.y1 - zone.y0)));
			const box: Box01 = [over[0], (cy - h / 2) / H, over[2], (cy + h / 2) / H];
			return { name, cover: boxCoverage(face, box), dist: Math.abs(cy - ((over[1] + over[3]) / 2) * H) };
		});
		const best = options.filter((x) => x.cover < 0.05).sort((a, b) => a.dist - b.dist)[0];
		if (best) return { tool: "captions", arguments: { zone: best.name }, does: `rebuild the captions in the ${best.name} zone, clear of the face` };
	}
	const p = o.el.params ?? {};
	const py = num(p["transform.positionY"], 0);
	const boxTop = (over?.[1] ?? face[1]) * H;
	const boxBottom = (over?.[3] ?? face[3]) * H;
	const up = face[1] * H - 12 - boxBottom; // negative: move up by this
	const down = face[3] * H + 12 - boxTop; // positive: move down by this
	const fitsUp = boxTop + up >= zone.y0;
	const fitsDown = boxBottom + down <= zone.y1;
	const dy = fitsUp && (!fitsDown || Math.abs(up) <= Math.abs(down)) ? up : fitsDown ? down : up;
	return ops(
		[{ op: "set", el: o.el.id, prop: "transform.positionY", value: Math.round(py + dy) }],
		`gate fix (FACE): ${o.el.name ?? o.el.id} off the face`,
		`move ${o.el.name ?? o.el.id} ${dy < 0 ? "up" : "down"} ${Math.abs(Math.round(dy))} px, clear of the face box`,
	);
}

// ------------------------------------------------------------------ FLASH (timeline half)

function checkFlash(ctx: Ctx): CheckRun["skipped"][number] | null {
	const mode = modeOf(ctx, "FLASH");
	if (mode === "skip") return { rule: "FLASH", why: skipWhy(ctx, "FLASH") };
	const max = 3;
	for (const f of ctx.pic.flashes) {
		const i = ctx.pic.base.findIndex((r) => r.el.id === f.el.id && Math.abs(r.t - f.t) < 1e-9);
		const prev = i > 0 ? ctx.pic.base[i - 1] : null;
		const onlyHere = Math.abs(elStart(f.el) - f.t) < 1e-6 && Math.abs(elEnd(f.el) - f.t_end) < 1e-6;
		const prevAdjacent = prev && Math.abs(prev.t_end - f.t) < 1e-6 && Math.abs(elEnd(prev.el) - f.t) < 1e-6 && prev.el.type === "video";
		const list: Array<Record<string, unknown>> = [];
		if (onlyHere) list.push({ op: "delete", el: f.el.id });
		if (prevAdjacent && prev) {
			const rate = prev.el.retime?.rate || 1;
			// exact to the tick: 6 decimals (4 overshoots the next clip by 4 ticks: 3.0667 s vs 3.066667 s, MEASURED)
			const out = ticksToSeconds((prev.el.trimStart ?? 0) + prev.el.duration * rate + Math.round((f.t_end - f.t) * 120_000) * rate);
			list.push({ op: "trim", el: prev.el.id, out: round(out, 6) });
		}
		add(ctx, "FLASH", mode, {
			t: f.t,
			t_end: f.t_end,
			place: { track: f.track, el: f.el, isMain: f.isMain },
			measure: { frames: f.frames, max_frames: max },
			target: `no picture on screen for only 1–${max} frames at a cut (mark a designed flash with restorff.flash)`,
			message: `${label(f.el)} is on screen for ${f.frames} frame${f.frames === 1 ? "" : "s"} at ${formatTime(f.t)}: a flash frame.`,
			fix: onlyHere ? `delete ${label(f.el)} and let the previous shot run on` : `remove the ${f.frames}-frame sliver of ${label(f.el)} at ${formatTime(f.t)}`,
			fix_call: list.length
				? ops(list, `gate fix (FLASH): remove the ${f.frames}-frame flash at ${formatTime(f.t)}`, onlyHere ? `delete the ${f.frames}-frame clip${prevAdjacent ? " and extend the shot before it over the gap" : ""}` : "extend the shot before it over the sliver")
				: look([f.t, f.t_end], `look at the ${f.frames} frames, then trim them away`),
		});
	}
	return null;
}

// ------------------------------------------------------------------ piece signals

function pieceSignals(ctx: Omit<Ctx, "piece" | "profile">): PieceSignals {
	const runtime = ctx.pic.runtime || 1;
	let compS = 0;
	let videoS = 0;
	for (const r of ctx.pic.base) {
		const len = r.t_end - r.t;
		if (storedComposition(r.el)) compS += len;
		else if (r.el.type === "video") videoS += len;
	}
	const voice = union(sounds(ctx.scene).filter((s) => s.role === "voice").map((s) => ({ t: s.t, t_end: s.t_end })));
	const speechS = voice.reduce((a, s) => a + Math.max(0, Math.min(runtime, s.t_end) - Math.max(0, s.t)), 0);
	const from = Math.max(0, ctx.pic.runtime - 6);
	const lastTexts = screenTexts(ctx as Ctx).filter((x) => !x.caption && x.t_end > from);
	const joined = lastTexts.map((x) => x.content).join(" \n ");
	const meta = restorffMeta(ctx.project) as Record<string, unknown>;
	return {
		aspect: ctx.canvas.width / ctx.canvas.height,
		briefOffer: briefHasOffer(ctx.project),
		offerOnScreen: PRICE_RE.test(joined) && CTA_RE.test(joined),
		compositionShare: compS / runtime,
		videoShare: videoS / runtime,
		speechShare: speechS / runtime,
		references: Boolean(ctx.opts.hints?.references || meta.references || meta.explainer),
		captions: textElements(ctx.scene).some(({ track, el }) => isCaption(track, el)),
	};
}

// ------------------------------------------------------------------ run

/** Run every timeline check. Pure: the project is never changed. */
export function runTimelineChecks(project: GateProject, opts: TimelineCheckOptions = {}): CheckRun {
	const scene = pickScene(project, opts.sceneId);
	if (!scene) {
		return {
			findings: [],
			ran: [],
			not_run: TIMELINE_CHECKS.map((rule) => ({ rule, why: "the project has no scene" })),
			skipped: [],
		};
	}
	const fps = fpsOf(project) || 30;
	const map = shotMap(scene);
	const canvas = project.settings.canvasSize;
	const meta = restorffMeta(project);
	const platform = opts.platform ?? briefOf(project).platform ?? meta.platform ?? null;
	const partial = { project, scene, opts, map, canvas, fps, findings: [] as Finding[], ids: new Set<string>(), zone: safeZoneFor(canvas, platform) };
	// The base picture does not depend on the piece; the beats do. Signals first, then the piece, then the map it counts.
	const probe = changeMap(scene, map.runtime, { fps, beats: false, media: opts.media, compositions: opts.compositions });
	const piece = decidePiece(project, opts.piece, pieceSignals({ ...partial, pic: probe }));
	const profile = PROFILES[piece.type];
	const pic = profile.rhythm.beats ? changeMap(scene, map.runtime, { fps, beats: true, media: opts.media, compositions: opts.compositions }) : probe;
	const ctx: Ctx = { ...partial, pic, piece, profile };
	const skipped: CheckRun["skipped"] = [];
	const not_run: CheckRun["not_run"] = [];
	const ran: string[] = [];
	const steps: Array<[string[], () => CheckRun["skipped"][number] | CheckRun["skipped"] | null | void]> = [
		[["SAFE"], () => checkSafe(ctx)],
		[["CAP-LEN"], () => checkCapLen(ctx)],
		[["R3"], () => checkR3(ctx)],
		[["R15"], () => checkR15(ctx)],
		[["R1", "R5", "R6"], () => checkRhythm(ctx)],
		[["R12"], () => checkR12(ctx)],
		[["R23"], () => checkR23(ctx)],
		[["R4"], () => checkR4(ctx)],
		[["R21"], () => checkR21(ctx)],
		[["CLEAN"], () => checkClean(ctx)],
		[["FORMAT"], () => checkFormat(ctx)],
		[["FACE"], () => checkFace(ctx)],
		[["FLASH"], () => checkFlash(ctx)],
	];
	for (const [rules, step] of steps) {
		try {
			const result = step();
			const skips = Array.isArray(result) ? result : result ? [result] : [];
			skipped.push(...skips);
			for (const rule of rules) if (!skips.some((s) => s.rule === rule)) ran.push(rule);
		} catch (error) {
			for (const rule of rules)
				not_run.push({ rule, why: `check crashed: ${error instanceof Error ? error.message : String(error)}` });
		}
	}
	return { findings: ctx.findings, ran, not_run, skipped, piece, changes: { ...pic.counts, shots: pic.shots.length } };
}

export type { PlacedElement };
