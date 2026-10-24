"use client";

import { useEffect, useState } from "react";
import type { TimelineElement, TimelineTrack, TScene } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { useEditor } from "@/editor/use-editor";
import { GradeRowValue } from "@/grade/grade-row";
import { isGradeLayer } from "@/grade/target";
import { useSyncStore, authorLabel } from "@/sync/store";
import { clipLabel, formatDb, shotKey } from "@/storyboard/labels";

/**
 * "SELECTED · S19 · A-ROLL" — the artboard prints the shot key (or the clip name)
 * and the track's role without its V-number ("V1 A-ROLL" -> "A-ROLL").
 */
export function selectedLabel({
	element,
	track,
}: {
	element: TimelineElement;
	track: TimelineTrack;
}): string {
	const role = track.name.replace(/^V\d+\s+/i, "");
	// ui-fix-panels (QA #18): a cut-out is named "<clip> · cutout" on the "V2 CUTOUT" track, which printed
	// "· CUTOUT · CUTOUT"; a name part that repeats the track's role is dropped
	const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
	const parts = (shotKey(element.name) ? [shotKey(element.name) as string] : clipLabel(element.name).split(/\s+·\s+/)).filter(
		(part) => part && !same(part, role),
	);
	return ["Selected", parts.join(" · "), role].filter(Boolean).join(" · ");
}

interface SummaryRow {
	label: string;
	value: string;
	mono?: boolean;
	/** Nothing to report for this clip type: printed in fog. */
	empty?: boolean;
	/** The Grade row: rendered by GradeRowValue (a picker), not as text. */
	grade?: boolean;
}

/**
 * The artboard's six inspector rows — Scale, Move, Captions, Voice, Grade,
 * Author — each read from the selected clip's real data:
 *   Scale    transform.scaleX, or its keyframes first → last ("100 → 108 %")
 *   Move     scale/position keyframes: push-in / pull-out / pan + their span ("push-in · 2.2 s")
 *   Captions caption clips over this clip's time: words per chunk + style ("1–3 words · highlight")
 *   Voice    the clip's volume in dB ("−2 dB"), or "muted"
 *   Grade    its look ("warm morning", "film · timeline"), or "none"; a button that opens the grade picker
 *   Author   element.restorff createdBy → author ("compiler · then you"); else the head
 *            commit's author when the server has commits; else "you"
 * Layout from the artboard DOM: 2 equal columns, gap 10 / 12, dt #A6A6AE, numbers mono.
 */
export function SelectedSummary({
	element,
	track,
}: {
	element: TimelineElement;
	track?: TimelineTrack;
}) {
	const scene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	const head = useSyncStore((s) => s.head);
	const rows = buildRows({ element, track, scene, headAuthor: head?.author ?? null });
	const { ref, compact } = useCompactRows();

	// ui-fix-panels (QA #19): in a short inspector (the default split leaves ≈ 250–320 px) the rows pack two to a line,
	// so the clip's own controls (transform first) start inside the panel instead of below it
	return (
		<dl
			ref={ref}
			className={
				compact
					? "m-0 grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[12.5px] leading-[1.35] [&_dd]:truncate"
					: "m-0 grid grid-cols-2 gap-x-3 gap-y-2.5 text-[14px] leading-[1.4]"
			}
		>
			{rows.map((row) => (
				<div key={row.label} className="contents">
					<dt className="text-mist">{row.label}</dt>
					{row.grade && track ? (
						<GradeRowValue element={element} track={track} />
					) : (
						<dd
							className={
								row.empty
									? "text-fog m-0"
									: row.mono
										? "rc-mono m-0 text-bone"
										: "m-0 text-bone"
							}
						>
							{row.value}
						</dd>
					)}
				</div>
			))}
		</dl>
	);
}

const DASH = "—";
/** Below this inspector height the rows pack two to a line (QA #19). */
const COMPACT_BELOW_PX = 520;

function useCompactRows(): { ref: (node: HTMLDListElement | null) => void; compact: boolean } {
	const [node, setNode] = useState<HTMLDListElement | null>(null);
	const [compact, setCompact] = useState(false);
	useEffect(() => {
		const panel = node?.closest<HTMLElement>(".panel");
		if (!panel) return;
		const measure = () => setCompact(panel.clientHeight > 0 && panel.clientHeight < COMPACT_BELOW_PX);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(panel);
		return () => observer.disconnect();
	}, [node]);
	return { ref: setNode, compact };
}

function buildRows({
	element,
	track,
	scene,
	headAuthor,
}: {
	element: TimelineElement;
	track?: TimelineTrack;
	scene: TScene | null;
	headAuthor: string | null;
}): SummaryRow[] {
	const params = element.params ?? {};
	const rows: SummaryRow[] = [];
	const kind = rowKind(element, track);

	// ui-fix-panels (QA #18): only rows that fit the element — a grade layer has its look and author; sound has its
	// level (Voice only on a voice clip); a composition has no voice or captions; footage keeps all six
	if (kind === "grade") {
		if (track) rows.push({ label: "Grade", value: "", grade: true });
		rows.push({ label: "Author", value: authorValue(element, headAuthor) });
		return rows;
	}
	if (kind === "voice" || kind === "music" || kind === "sfx") {
		const volume = asNumber(params.volume);
		const label = kind === "voice" ? "Voice" : "Level";
		rows.push(
			params.muted === true
				? { label, value: "muted" }
				: volume !== null
					? { label, value: formatDb(volume), mono: true }
					: { label, value: "0 dB", mono: true },
		);
		if (kind === "music" && (element as TaggedElement & { restorff?: { ducked?: unknown } }).restorff?.ducked) {
			rows.push({ label: "Ducked", value: "under the voice" });
		}
		rows.push({ label: "Author", value: authorValue(element, headAuthor) });
		return rows;
	}

	// Scale
	const scaleKeys = channelKeys(element, "transform.scaleX");
	const scaleX = asNumber(params["transform.scaleX"]);
	if (scaleKeys.length >= 2) {
		const first = Math.round(scaleKeys[0].value * 100);
		const last = Math.round(scaleKeys[scaleKeys.length - 1].value * 100);
		rows.push({ label: "Scale", value: first === last ? `${first} %` : `${first} → ${last} %`, mono: true });
	} else if (scaleX !== null) {
		rows.push({ label: "Scale", value: `${Math.round(scaleX * 100)} %`, mono: true });
	} else {
		rows.push({ label: "Scale", value: DASH, empty: true });
	}

	// Move
	rows.push(moveRow(element));

	// Captions (footage and text; a composition is a graphic, not something captions sit over)
	if (kind !== "composition" && kind !== "graphic") rows.push(captionsRow({ element, track, scene }));

	// Voice (a clip's own sound: video footage only)
	if (kind === "footage" && element.type === "video") {
		const volume = asNumber(params.volume);
		if (params.muted === true) {
			rows.push({ label: "Voice", value: "muted" });
		} else if (volume !== null) {
			rows.push({ label: "Voice", value: formatDb(volume), mono: true });
		} else {
			rows.push({ label: "Voice", value: DASH, empty: true });
		}
	}

	// Grade — grade agent, 2026-10-20: the clip's look (its own restorff-grade effect and/or the GRADE layer over
	// it), a button that opens the look picker + sliders (apps/web/src/grade/grade-row.tsx)
	if (track && (["video", "image", "text", "sticker", "graphic"].includes(element.type) || isGradeLayer(element))) {
		rows.push({ label: "Grade", value: "", grade: true });
	} else {
		rows.push({ label: "Grade", value: DASH, empty: true });
	}

	// Author
	rows.push({ label: "Author", value: authorValue(element, headAuthor) });

	return rows;
}

type RowKind = "grade" | "voice" | "music" | "sfx" | "composition" | "text" | "footage" | "graphic";

/** What the selected element is, for choosing its rows (QA #18). Audio roles come from the track (restorff.role, then name). */
function rowKind(element: TimelineElement, track?: TimelineTrack): RowKind {
	if (isGradeLayer(element)) return "grade";
	if (element.type === "audio") {
		const role = (track as { restorff?: { role?: string } } | undefined)?.restorff?.role ?? "";
		const name = (track?.name ?? "").toUpperCase();
		if (role === "sfx" || name.startsWith("SFX")) return "sfx";
		if (role === "music" || name.startsWith("MUSIC")) return "music";
		return "voice";
	}
	if ((element as TaggedElement & { restorff?: { composition?: unknown } }).restorff?.composition) return "composition";
	if (element.type === "text") return "text";
	if (element.type === "video" || element.type === "image") return "footage";
	return "graphic";
}

type TaggedElement = TimelineElement & {
	restorff?: { createdBy?: string; author?: string; role?: string; style?: string };
};

function authorValue(element: TimelineElement, headAuthor: string | null): string {
	const tag = (element as TaggedElement).restorff;
	const created = tag?.createdBy;
	const last = tag?.author;
	if (created && last && created !== last) return `${authorLabel(created)} · then ${authorLabel(last)}`;
	if (created || last) return authorLabel((created ?? last) as string);
	if (headAuthor && headAuthor !== "user") return `${authorLabel(headAuthor)} · then you`;
	return "you";
}

interface Key {
	time: number;
	value: number;
}

/** Numeric keyframes of one animated property, sorted by time (handles composite channel data). */
function channelKeys(element: TimelineElement, path: string): Key[] {
	const data = element.animations?.[path] as unknown;
	const keysOf = (channel: unknown): Key[] => {
		const keys = (channel as { keys?: Array<{ time: number; value: unknown }> } | undefined)?.keys;
		if (!Array.isArray(keys)) return [];
		return keys
			.filter((key) => typeof key.value === "number")
			.map((key) => ({ time: Number(key.time), value: key.value as number }))
			.sort((a, b) => a.time - b.time);
	};
	const direct = keysOf(data);
	if (direct.length) return direct;
	if (data && typeof data === "object") {
		for (const sub of Object.values(data as Record<string, unknown>)) {
			const found = keysOf(sub);
			if (found.length) return found;
		}
	}
	return [];
}

function spanSeconds(keys: Key[]): number {
	if (keys.length < 2) return 0;
	return (keys[keys.length - 1].time - keys[0].time) / TICKS_PER_SECOND;
}

function moveRow(element: TimelineElement): SummaryRow {
	const scale = channelKeys(element, "transform.scaleX");
	const posX = channelKeys(element, "transform.positionX");
	const posY = channelKeys(element, "transform.positionY");
	const rotate = channelKeys(element, "transform.rotate");
	const parts: string[] = [];
	let span = 0;
	if (scale.length >= 2) {
		const delta = scale[scale.length - 1].value - scale[0].value;
		if (Math.abs(delta) > 0.001) parts.push(delta > 0 ? "push-in" : "pull-out");
		span = Math.max(span, spanSeconds(scale));
	}
	const moved = (keys: Key[]) =>
		keys.length >= 2 && Math.abs(keys[keys.length - 1].value - keys[0].value) > 0.5;
	if (moved(posX) || moved(posY)) {
		parts.push("pan");
		span = Math.max(span, spanSeconds(posX), spanSeconds(posY));
	}
	if (moved(rotate)) {
		parts.push("rotate");
		span = Math.max(span, spanSeconds(rotate));
	}
	if (!parts.length) {
		const visual = ["video", "image", "text", "sticker", "graphic"].includes(element.type);
		return { label: "Move", value: visual ? "static" : DASH, empty: true };
	}
	return { label: "Move", value: `${parts.join(" + ")} · ${(Math.round(span * 10) / 10).toFixed(1)} s` };
}

function isCaptionTrack(track: TimelineTrack): boolean {
	const role = (track as { restorff?: { role?: string } }).restorff?.role;
	return track.type === "text" && (role === "caption" || track.name.toUpperCase().startsWith("CAPTIONS"));
}

function wordsIn(element: TimelineElement): number {
	const content = typeof element.params?.content === "string" ? element.params.content : "";
	return content.trim() ? content.trim().split(/\s+/).length : 0;
}

function captionStyle(elements: TimelineElement[]): string | null {
	for (const element of elements) {
		const params = element.params ?? {};
		for (const [key, value] of Object.entries(params)) {
			if (/highlight|karaoke/i.test(key) && value !== false && value !== null && value !== "" && value !== 0) {
				return "highlight";
			}
		}
	}
	const style = (elements[0] as TaggedElement | undefined)?.restorff?.style;
	if (style) return style.replace(/^restorff\/style\//, "").replace(/[-_]/g, " ");
	const background = elements[0]?.params?.["background.color"];
	if (typeof background === "string" && background !== "transparent" && !/^#?0{0,8}$/.test(background)) {
		return "box";
	}
	return null;
}

function captionsRow({
	element,
	track,
	scene,
}: {
	element: TimelineElement;
	track?: TimelineTrack;
	scene: TScene | null;
}): SummaryRow {
	let captions: TimelineElement[] = [];
	if (track && isCaptionTrack(track)) {
		captions = [element];
	} else if (scene) {
		const start = element.startTime;
		const end = element.startTime + element.duration;
		for (const overlay of scene.tracks.overlay) {
			if (!isCaptionTrack(overlay)) continue;
			for (const caption of overlay.elements) {
				if (caption.startTime < end && caption.startTime + caption.duration > start) captions.push(caption);
			}
		}
	}
	if (!captions.length) {
		if (element.type === "text") {
			const words = wordsIn(element);
			return { label: "Captions", value: words === 1 ? "1 word" : `${words} words` };
		}
		return { label: "Captions", value: "none", empty: true };
	}
	const counts = captions.map(wordsIn).filter((n) => n > 0);
	const min = counts.length ? Math.min(...counts) : 0;
	const max = counts.length ? Math.max(...counts) : 0;
	const words = min === max ? (min === 1 ? "1 word" : `${min} words`) : `${min}–${max} words`;
	const style = captionStyle(captions);
	return { label: "Captions", value: style ? `${words} · ${style}` : words };
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
