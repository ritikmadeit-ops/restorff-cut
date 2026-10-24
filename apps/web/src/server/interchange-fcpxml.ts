/**
 * Snapshot → FCPXML 1.10 (Final Cut Pro; DaVinci Resolve imports it too). Written by hand from Apple's public FCPXML
 * reference; no dependencies, no I/O.
 *
 * Shape: library → event → project → sequence → spine. The main track (V1 A-ROLL) is the primary storyline, with
 * <gap>s where it has none and a trailing gap so every connected clip has a parent. Overlay tracks are connected lanes
 * above it (overlay index 0 = the highest lane), audio tracks lanes below it (audio 0 = lane -1). A connected clip
 * hangs off the spine item under its start: its offset is in that item's local time (item start + distance from the
 * item's offset). Times are rational seconds on the project's frame grid ("1001/30000s" steps at 29.97).
 *
 * Clips: video → <asset-clip>, stills → <video>, audio → <asset-clip> with a role, text → <title> (Basic Title),
 * main-track transitions → <transition> (Cross Dissolve, centred on the cut, as the editor draws it), review comments
 * and bookmarks → <marker>s (must/should findings as to-do markers). Everything else is listed in not_expressed.
 */
import {
	baseSummary,
	type ExportSummary,
	flattenSnapshot,
	type FrameRate,
	gcd,
	type IClip,
	type IMarker,
	type InterchangeInput,
	type ITimeline,
	type MediaInfo,
	type NoteBook,
	type TrackSummary,
} from "./interchange-timeline";

export const FCPXML_VERSION = "1.10";
const BASIC_TITLE_UID = ".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti";
const CROSS_DISSOLVE_UID = "FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265";
/** The Basic Title's Position parameter (what Final Cut writes for it). */
const TITLE_POSITION_KEY = "9999/999166631/999166633/1/100/101";

// ─── a tiny XML tree ──────────────────────────────────────────────────────────────────────────────────────────

type Attr = [string, string | number | undefined | null | false];
interface XmlNode {
	tag: string;
	attrs?: Attr[];
	children?: XmlNode[];
	text?: string;
}

/** Escapes text and attribute values; drops characters XML 1.0 forbids. */
export function xmlEscape(value: string): string {
	return value
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function serialize(node: XmlNode, depth: number, out: string[]): void {
	const pad = "    ".repeat(depth);
	const attrs = (node.attrs ?? [])
		.filter(([, value]) => value !== undefined && value !== null && value !== false)
		.map(([key, value]) => ` ${key}="${xmlEscape(String(value))}"`)
		.join("");
	if (node.text !== undefined) {
		out.push(`${pad}<${node.tag}${attrs}>${xmlEscape(node.text)}</${node.tag}>`);
		return;
	}
	if (!node.children?.length) {
		out.push(`${pad}<${node.tag}${attrs}/>`);
		return;
	}
	out.push(`${pad}<${node.tag}${attrs}>`);
	for (const child of node.children) serialize(child, depth + 1, out);
	out.push(`${pad}</${node.tag}>`);
}

// ─── time ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whole frames → FCPXML rational seconds, reduced: 45 frames at 30 fps = "3/2s"; 0 = "0s". */
export function fcpTime(frames: number, fps: FrameRate): string {
	if (!frames) return "0s";
	const n = frames * fps.den;
	const d = fps.num;
	const g = gcd(n, d);
	return d / g === 1 ? `${n / g}s` : `${n / g}/${d / g}s`;
}

/** A float rate (a media file's fps) as a rational frame duration, standard NTSC rates exact. */
function rateFromFloat(fps: number): FrameRate {
	for (const [value, num] of [
		[23.976, 24000],
		[29.97, 30000],
		[59.94, 60000],
	] as const) {
		if (Math.abs(fps - value) < 0.01) return { num, den: 1001 };
	}
	return Math.abs(fps - Math.round(fps)) < 0.01 ? { num: Math.round(fps), den: 1 } : { num: Math.round(fps * 1000), den: 1000 };
}

// ─── writer ───────────────────────────────────────────────────────────────────────────────────────────────────

interface SpineItem {
	node: XmlNode;
	/** Sequence frames. */
	offset: number;
	dur: number;
	/** The item's own start attribute, frames (its local time at its offset). */
	localStart: number;
	head: XmlNode[];
	anchors: Array<{ node: XmlNode; offset: number; lane: number }>;
	markers: Array<{ node: XmlNode; start: number }>;
}

function audioRoleFor(trackName: string): string {
	const name = trackName.toUpperCase();
	if (name.includes("MUSIC")) return "music";
	if (name.includes("SFX") || name.includes("EFFECT")) return "effects";
	return "dialogue";
}

const round4 = (value: number) => Math.round(value * 10000) / 10000;

export function toFcpxml(input: InterchangeInput): { xml: string; summary: ExportSummary } {
	const timeline = flattenSnapshot(input);
	const notes = timeline.notes.clone();
	const { fps } = timeline;
	const t = (frames: number) => fcpTime(frames, fps);

	// resources: formats, assets, effects — ids r1, r2… in a fixed order
	let nextId = 1;
	const rid = () => `r${nextId++}`;
	const resources: XmlNode[] = [];
	const sequenceFormat = rid();
	resources.push({
		tag: "format",
		attrs: [["id", sequenceFormat], ["frameDuration", t(1)], ["width", timeline.width], ["height", timeline.height], ["colorSpace", "1-1-1 (Rec. 709)"]],
	});
	const formats = new Map<string, string>([[`${timeline.width}x${timeline.height}@${fps.num}/${fps.den}`, sequenceFormat]]);
	const formatFor = (info: MediaInfo): string | undefined => {
		if (info.kind === "audio") return undefined;
		const width = info.width ?? timeline.width;
		const height = info.height ?? timeline.height;
		if (info.kind === "image") {
			const key = `still-${width}x${height}`;
			if (!formats.has(key)) {
				const id = rid();
				formats.set(key, id);
				resources.push({ tag: "format", attrs: [["id", id], ["name", "FFVideoFormatRateUndefined"], ["width", width], ["height", height], ["colorSpace", "1-1-1 (Rec. 709)"]] });
			}
			return formats.get(key);
		}
		const rate = info.fps ? rateFromFloat(info.fps) : fps;
		const key = `${width}x${height}@${rate.num}/${rate.den}`;
		if (!formats.has(key)) {
			const id = rid();
			formats.set(key, id);
			resources.push({ tag: "format", attrs: [["id", id], ["frameDuration", fcpTime(1, rate)], ["width", width], ["height", height], ["colorSpace", "1-1-1 (Rec. 709)"]] });
		}
		return formats.get(key);
	};

	// how much of each media the clips reach into (frames), so an asset is never shorter than its use
	const reach = new Map<string, number>();
	for (const track of timeline.tracks) {
		for (const clip of track.clips) {
			if (!clip.mediaId) continue;
			const used = clip.inF + Math.ceil((clip.end - clip.start) * clip.rate);
			reach.set(clip.mediaId, Math.max(reach.get(clip.mediaId) ?? 0, used));
		}
	}
	const assetIds = new Map<string, string>();
	for (const info of timeline.media) {
		const format = formatFor(info);
		const id = rid();
		assetIds.set(info.id, id);
		const known = info.durationTicks ? Math.floor(info.durationTicks / timeline.tpf) : 0;
		const frames = info.kind === "image" ? 0 : Math.max(known, reach.get(info.id) ?? 0);
		const hasAudio = info.kind === "audio" || (info.kind === "video" && info.hasAudio !== false);
		resources.push({
			tag: "asset",
			attrs: [
				["id", id],
				["name", info.name],
				["start", "0s"],
				["duration", t(frames)],
				["hasVideo", info.kind === "audio" ? "0" : "1"],
				["format", format],
				["hasAudio", hasAudio ? "1" : "0"],
				["videoSources", info.kind === "audio" ? undefined : "1"],
				["audioSources", hasAudio ? "1" : undefined],
				["audioChannels", hasAudio ? "2" : undefined],
				["audioRate", hasAudio ? "48000" : undefined],
			],
			children: [{ tag: "media-rep", attrs: [["kind", "original-media"], ["src", info.url]] }],
		});
	}
	const usesTitles = timeline.tracks.some((track) => track.clips.some((clip) => clip.kind === "text"));
	const titleEffect = usesTitles ? rid() : undefined;
	if (titleEffect) resources.push({ tag: "effect", attrs: [["id", titleEffect], ["name", "Basic Title"], ["uid", BASIC_TITLE_UID]] });
	const main = timeline.tracks.find((track) => track.group === "main");
	const usesTransitions = !!main?.clips.some((clip) => clip.transitionIn);
	const dissolveEffect = usesTransitions ? rid() : undefined;
	if (dissolveEffect) resources.push({ tag: "effect", attrs: [["id", dissolveEffect], ["name", "Cross Dissolve"], ["uid", CROSS_DISSOLVE_UID]] });

	let styleCount = 0;
	const counts = { tracks: 0, clips: 0, titles: 0, audio: 0, generators: 0, gaps: 0, transitions: 0, markers: 0 };

	/** One clip as its FCPXML element; null when the format has no such thing. */
	function clipNode(clip: IClip, offset: number, lane: number | undefined, trackName: string): XmlNode | null {
		const common: Attr[] = [
			["lane", lane],
			["offset", t(offset)],
			["name", clip.name],
		];
		const disabled: Attr = ["enabled", clip.enabled ? undefined : "0"];
		const duration = clip.end - clip.start;
		if (clip.rate !== 1) notes.add("retime-fcpxml", "speed changes (retime)", "FCPXML: exported at 100 % with the same timeline length; the source out point differs", clip.id);
		if (clip.kind === "video" || clip.kind === "image" || clip.kind === "audio") {
			const ref = clip.mediaId ? assetIds.get(clip.mediaId) : undefined;
			if (!ref) {
				notes.add("no-media", "clip without a media file", "not exported", clip.id);
				return null;
			}
			const head: XmlNode[] = [];
			if (clip.scale) head.push({ tag: "adjust-transform", attrs: [["scale", `${round4(clip.scale.x)} ${round4(clip.scale.y)}`]] });
			if (clip.volumeDb !== undefined && clip.audioEnabled) head.push({ tag: "adjust-volume", attrs: [["amount", `${round4(clip.volumeDb)}dB`]] });
			if (clip.kind === "image") {
				counts.clips += 1;
				return { tag: "video", attrs: [["ref", ref], ...common, ["start", "0s"], ["duration", t(duration)], disabled], children: head };
			}
			const hasAudio = clip.kind === "audio" || clip.media?.hasAudio !== false;
			if (clip.kind === "audio") counts.audio += 1;
			else counts.clips += 1;
			return {
				tag: "asset-clip",
				attrs: [
					["ref", ref],
					...common,
					["start", t(clip.inF)],
					["duration", t(duration)],
					disabled,
					["srcEnable", clip.kind === "video" && hasAudio && !clip.audioEnabled ? "video" : undefined],
					["audioRole", hasAudio && (clip.kind === "audio" || clip.audioEnabled) ? audioRoleFor(trackName) : undefined],
					["tcFormat", "NDF"],
				],
				children: head,
			};
		}
		if (clip.kind === "text" && titleEffect && clip.style) {
			counts.titles += 1;
			const style = clip.style;
			const id = `ts${++styleCount}`;
			const children: XmlNode[] = [];
			if (style.x || style.y) children.push({ tag: "param", attrs: [["name", "Position"], ["key", TITLE_POSITION_KEY], ["value", `${round4(style.x)} ${round4(-style.y)}`]] });
			children.push({ tag: "text", children: [{ tag: "text-style", attrs: [["ref", id]], text: clip.text ?? "" }] });
			children.push({
				tag: "text-style-def",
				attrs: [["id", id]],
				children: [
					{
						tag: "text-style",
						attrs: [
							["font", style.font],
							["fontSize", round4(style.sizePx)],
							["fontFace", style.bold ? (style.italic ? "Bold Italic" : "Bold") : style.italic ? "Italic" : "Regular"],
							["fontColor", style.color.map(round4).join(" ")],
							["bold", style.bold ? "1" : undefined],
							["italic", style.italic ? "1" : undefined],
							["alignment", style.align],
						],
					},
				],
			});
			return { tag: "title", attrs: [["ref", titleEffect], ...common, ["start", "0s"], ["duration", t(duration)], disabled], children };
		}
		if (clip.kind === "graphic" || clip.kind === "sticker") {
			notes.add(`fcpxml-${clip.kind}`, `${clip.kind} element (${clip.generator})`, "FCPXML: not exported (no generator equivalent)", clip.id);
			return null;
		}
		return null;
	}

	// the primary storyline: main-track clips with gaps between, covering the whole sequence
	const spine: SpineItem[] = [];
	const transitions: Array<{ before: number; node: XmlNode }> = [];
	const gapItem = (offset: number, dur: number): SpineItem => {
		counts.gaps += 1;
		return { node: { tag: "gap", attrs: [["name", "Gap"], ["offset", t(offset)], ["start", "0s"], ["duration", t(dur)]] }, offset, dur, localStart: 0, head: [], anchors: [], markers: [] };
	};
	let cursor = 0;
	for (const clip of main?.clips ?? []) {
		if (clip.start > cursor) spine.push(gapItem(cursor, clip.start - cursor));
		const node = clipNode(clip, clip.start, undefined, main?.name ?? "V1 A-ROLL");
		if (!node) {
			spine.push(gapItem(clip.start, clip.end - clip.start));
			cursor = clip.end;
			continue;
		}
		if (clip.transitionIn && dissolveEffect) {
			const previous = spine[spine.length - 1];
			const frames = Math.min(clip.transitionIn.frames, clip.end - clip.start, previous ? previous.dur : 0);
			const half = Math.floor(frames / 2);
			if (!previous || frames < 1 || clip.start - half < 0) {
				notes.add("transition-at-start", "transition into the first clip", "not exported (nothing before it to transition from)", clip.id);
			} else {
				counts.transitions += 1;
				if (clip.transitionIn.type !== "dissolve") notes.add(`transition-${clip.transitionIn.type}`, `${clip.transitionIn.type} transition`, "FCPXML: exported as a Cross Dissolve of the same length", clip.id);
				transitions.push({
					before: spine.length,
					node: {
						tag: "transition",
						attrs: [["name", "Cross Dissolve"], ["offset", t(clip.start - half)], ["duration", t(frames)]],
						children: [{ tag: "filter-video", attrs: [["ref", dissolveEffect], ["name", "Cross Dissolve"]] }],
					},
				});
			}
		}
		const head = node.children ?? [];
		node.children = undefined;
		spine.push({ node, offset: clip.start, dur: clip.end - clip.start, localStart: clip.kind === "image" ? 0 : clip.inF, head, anchors: [], markers: [] });
		cursor = clip.end;
	}
	if (cursor < timeline.duration) spine.push(gapItem(cursor, timeline.duration - cursor));
	const total = Math.max(cursor, timeline.duration);
	const parentAt = (frame: number): SpineItem | undefined =>
		spine.find((item) => frame >= item.offset && frame < item.offset + item.dur) ?? spine[spine.length - 1];

	// connected lanes
	const overlayCount = timeline.tracks.filter((track) => track.group === "overlay").length;
	const trackSummaries: TrackSummary[] = [];
	for (const track of timeline.tracks) {
		if (track.group === "main") {
			counts.tracks += 1;
			trackSummaries.push({ name: track.name, kind: "video (primary storyline)", clips: track.clips.length, lane: 0, exported: true });
			continue;
		}
		if (track.type === "effect") {
			for (const clip of track.clips) notes.add(`layer-${clip.generator}`, `${clip.generator} adjustment layer (track ${track.name})`, "not exported: re-create it in the other editor", clip.id);
			trackSummaries.push({ name: track.name, kind: "effect layer", clips: track.clips.length, exported: false });
			continue;
		}
		const lane = track.group === "overlay" ? overlayCount - track.index : -(track.index + 1);
		let exported = 0;
		for (const clip of track.clips) {
			if (clip.transitionIn) notes.add("transition-lane", "transition on a connected lane", "FCPXML: not exported (only primary-storyline transitions are)", clip.id);
			const parent = parentAt(clip.start);
			if (!parent) continue;
			const local = parent.localStart + (clip.start - parent.offset);
			const node = clipNode(clip, local, lane, track.name);
			if (!node) continue;
			parent.anchors.push({ node, offset: local, lane });
			exported += 1;
		}
		counts.tracks += 1;
		trackSummaries.push({ name: track.name, kind: track.type, clips: exported, lane, exported: true });
	}

	// markers on the storyline item under them
	for (const marker of timeline.markers) {
		const parent = parentAt(marker.start);
		if (!parent) continue;
		const local = parent.localStart + (marker.start - parent.offset);
		parent.markers.push({ node: markerNode(marker, local, t), start: local });
		counts.markers += 1;
	}

	const spineNodes: XmlNode[] = [];
	spine.forEach((item, index) => {
		for (const transition of transitions) if (transition.before === index) spineNodes.push(transition.node);
		item.anchors.sort((a, b) => a.offset - b.offset || b.lane - a.lane);
		item.markers.sort((a, b) => a.start - b.start);
		const children = [...item.head, ...item.anchors.map((anchor) => anchor.node), ...item.markers.map((marker) => marker.node)];
		spineNodes.push({ ...item.node, ...(children.length ? { children } : {}) });
	});

	const projectName = timeline.name;
	const root: XmlNode = {
		tag: "fcpxml",
		attrs: [["version", FCPXML_VERSION]],
		children: [
			{ tag: "resources", children: resources },
			{
				tag: "library",
				children: [
					{
						tag: "event",
						attrs: [["name", `RestorffCut${timeline.timelineId ? ` · ${timeline.timelineId}` : ""}`]],
						children: [
							{
								tag: "project",
								attrs: [["name", projectName]],
								children: [
									{
										tag: "sequence",
										attrs: [["format", sequenceFormat], ["duration", t(total)], ["tcStart", "0s"], ["tcFormat", "NDF"], ["audioLayout", "stereo"], ["audioRate", "48k"]],
										children: [{ tag: "spine", children: spineNodes }],
									},
								],
							},
						],
					},
				],
			},
		],
	};
	const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE fcpxml>", provenance(timeline)];
	serialize(root, 0, lines);
	const xml = `${lines.join("\n")}\n`;
	return {
		xml,
		summary: {
			...baseSummary(timeline, "fcpxml", FCPXML_VERSION),
			tracks: trackSummaries,
			counts,
			not_expressed: notesList(notes),
		},
	};
}

function markerNode(marker: IMarker, local: number, t: (frames: number) => string): XmlNode {
	const todo = marker.kind === "comment" && (marker.severity === "must" || marker.severity === "should");
	return {
		tag: "marker",
		attrs: [
			["start", t(local)],
			["duration", t(marker.dur)],
			["value", marker.name],
			["completed", todo ? (marker.resolved ? "1" : "0") : undefined],
		],
	};
}

function provenance(timeline: ITimeline): string {
	const parts = [
		"Exported by RestorffCut interchange",
		timeline.timelineId ? `timeline ${timeline.timelineId}` : "",
		timeline.commitId ? `commit ${timeline.commitId}` : "",
		timeline.exportedAt ? `at ${timeline.exportedAt}` : "",
	].filter(Boolean);
	// "--" may not appear inside an XML comment
	return `<!-- ${parts.join(" · ").replace(/-{2,}/g, "-")} -->`;
}

function notesList(notes: NoteBook) {
	return notes.list();
}
