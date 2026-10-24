/**
 * The `next`-hint audit (mcp-discover, wave 5, 2026-10-20; recreations SUMMARY gap 10).
 *
 * A weaker model follows `next` literally, so a wrong hint is a trap. The recreations found these; each rule here
 * rewrites ONLY the wrong shape (so when a tool's owner fixes the hint at its source, the rule stops firing), and
 * each has a test in server/__tests__/mcp-discover.test.ts:
 *   H6  render {render_id} answered {render: {status}} only → `status`, `render_id`, `progress`, `ready` at the top
 *       level too (the nested copy stays). Two recreations polled 5–19 extra times reading top-level status.
 *   H8  storyboard approve, already approved → next rendered the OLD approved commit → render the head.
 *   H9  cutout apply → look {kind: render, ref: <timeline id>} (wrong kind, nothing rendered yet) → render the commit.
 *   H10 media upload_url (and import's upload_needed) → next import without `place` (lands in the bin only) → place on
 *       the lane its file type belongs to, said in `do`.
 *   H11 autocut → captions {element_id: <first piece>} = captions on the first 3.1 s only → captions {all: true}.
 *   H12 storyboard edit_row / revise dry run that ADDS captions over existing ones said "Commit it" → a warning and
 *       next = read the existing caption chunks (edit their text instead).
 * Defaults (handler.ts DEFAULT_NEXT) said "Read a timeline summary" with arguments {action: "list"}; a result about a
 * known timeline now points at that timeline's summary.
 */
import type { ProjectSnapshot } from "@/sync/snapshot";
import type { Payload } from "./protocol";
import { exactSeconds, tracksOf } from "@/server/timeline-read";

export interface HintCall {
	tool: string;
	args: Record<string, unknown>;
	isError: boolean;
}

/** Reads a timeline's head (id + snapshot) — only called by the rules that need it. */
export type HeadLookup = (timelineId: string) => Promise<{ head: string; snapshot: ProjectSnapshot | null } | null>;

const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

export const DEFAULT_NEXT: Record<string, Payload> = {
	timeline: { do: "List the timelines, then read one's summary.", tool: "timeline", arguments: { action: "list" } },
	timeline_ops: { do: "List the timelines, then read one's summary (element ids, exact times, head).", tool: "timeline", arguments: { action: "list" } },
	styles: { do: "List the styles.", tool: "styles", arguments: { action: "list" } },
	media: { do: "List the timelines.", tool: "timeline", arguments: { action: "list" } },
	look: { do: "List the timelines.", tool: "timeline", arguments: { action: "list" } },
	render: { do: "List the timelines.", tool: "timeline", arguments: { action: "list" } },
	composition: { do: "Read how to write one.", tool: "composition", arguments: { action: "contract" } },
	sounds: { do: "List the SFX pack.", tool: "sounds", arguments: { action: "list" } },
};

/** The default `next` for a result that has none: the timeline's summary when the call named one. */
export function defaultNext(tool: string, args: Record<string, unknown> | undefined, payload: Payload): Payload {
	const timelineId = str(payload.timeline_id) ?? str(args?.timeline_id);
	// mcp-gaps-mvp (2026-10-24): a timeline that is not found (or not the caller's org's) → list yours, not "read it again"
	const error = payload.error as { code?: unknown; message?: unknown } | undefined;
	if (timelineId && error?.code === "http_404" && typeof error.message === "string" && error.message.includes(`project ${timelineId} not found`)) {
		return { do: "That timeline is not one of yours (or does not exist): list your timelines, or create one.", tool: "timeline", arguments: { action: "list" } };
	}
	if (timelineId && tool !== "composition" && tool !== "sounds" && tool !== "styles") {
		return { do: "Read the timeline summary (element ids, exact times, the head commit).", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } };
	}
	return DEFAULT_NEXT[tool] ?? DEFAULT_NEXT.timeline;
}

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|heic|avif)$/i;

/** The lane a file belongs on by its name: audio → MUSIC, stills → V2, everything else (footage) → V1. */
export function laneFor(name: string | null): string {
	if (name && AUDIO_EXT.test(name)) return "MUSIC";
	if (name && IMAGE_EXT.test(name)) return "V2";
	return "V1";
}

function captionElements(snapshot: ProjectSnapshot | null) {
	if (!snapshot) return [];
	const out: Array<{ id: string; start: number; end: number; text: string | null; track: string }> = [];
	for (const { track } of tracksOf(snapshot)) {
		const captionTrack = track.restorff?.role === "caption" || /^caption/i.test(track.name ?? "");
		for (const element of track.elements ?? []) {
			const layer = (element.restorff as { captionLayer?: unknown; role?: unknown } | undefined) ?? {};
			if (!captionTrack && layer.role !== "caption" && typeof layer.captionLayer !== "string") continue;
			const params = (element.params ?? {}) as Record<string, unknown>;
			out.push({ id: element.id, start: element.startTime, end: element.startTime + element.duration, text: typeof params.content === "string" ? params.content : null, track: track.id });
		}
	}
	return out;
}

/** add_captions ops in a revise / edit_row answer (planned ops, or the change report). */
function addedCaptionSpans(payload: Payload): { found: boolean; spans: Array<[number, number]> } {
	const spans: Array<[number, number]> = [];
	let found = false;
	for (const op of Array.isArray(payload.ops) ? payload.ops : []) {
		const record = obj(op);
		if (record?.op !== "add_captions") continue;
		found = true;
		const words = Array.isArray(record.words) ? (record.words as Array<{ start?: unknown; end?: unknown }>) : [];
		const starts = words.map((word) => word.start).filter((v): v is number => typeof v === "number");
		const ends = words.map((word) => word.end).filter((v): v is number => typeof v === "number");
		if (starts.length && ends.length) spans.push([Math.min(...starts), Math.max(...ends)]);
	}
	for (const change of Array.isArray(payload.changes) ? payload.changes : []) {
		const record = obj(change);
		if (record?.op === "add_captions" && record.status !== "refused" && record.status !== "conflict") found = true;
	}
	return { found, spans };
}

/** Apply every rule; returns the payload unchanged when none fires. */
export async function auditNext(payload: Payload, call: HintCall, lookup: HeadLookup): Promise<Payload> {
	if (call.isError) return payload;
	const { tool, args } = call;
	const action = str(args.action);
	const next = obj(payload.next);
	const nextArgs = obj(next?.arguments) ?? {};

	// H6: render — status at the top level too
	if (tool === "render") {
		const render = obj(payload.render);
		if (render && payload.status === undefined && typeof render.status === "string") {
			const { next: keepNext, ...rest } = payload;
			return {
				status: render.status,
				render_id: render.render_id,
				ready: render.status === "done",
				...(render.progress !== undefined ? { progress: render.progress } : {}),
				...rest,
				...(keepNext !== undefined ? { next: keepNext } : {}),
			};
		}
		return payload;
	}

	// H8: storyboard approve, already approved → render the head, not the old approved commit
	if (tool === "storyboard" && action === "approve" && payload.already_approved === true && next?.tool === "render") {
		const timelineId = str(payload.timeline_id) ?? str(args.timeline_id);
		const head = timelineId ? await lookup(timelineId) : null;
		const asked = str(nextArgs.commit);
		if (head && asked && !head.head.startsWith(asked) && !asked.startsWith(head.head)) {
			return {
				...payload,
				approved_commit: asked,
				head: head.head,
				next: {
					do: `Render the head ${head.head.slice(0, 8)} (the approval was recorded on ${asked.slice(0, 8)}; what changed since does not need a new one).`,
					tool: "render",
					arguments: { ...nextArgs, timeline_id: timelineId, commit: head.head, quality: nextArgs.quality ?? "preview" },
				},
			};
		}
		return payload;
	}

	// H9: cutout apply → render the commit, then look (not look kind render with a timeline id)
	if (tool === "cutout" && action === "apply" && str(payload.commit_id) && next?.tool === "look" && nextArgs.kind === "render") {
		const timelineId = str(args.timeline_id) ?? str(nextArgs.ref);
		return {
			...payload,
			next: {
				do: "Render this commit (preview), wait for it (render {render_id}), then look {kind: \"render\", ref: <render_id>, times: [a moment inside the effect]} — is the text behind the head?",
				tool: "render",
				arguments: { timeline_id: timelineId, commit: payload.commit_id, quality: "preview" },
			},
		};
	}

	// H10: an upload URL whose next import has no place → place it on its lane
	if (tool === "media" && str(payload.put_url) && next?.tool === "media" && nextArgs.upload_id && nextArgs.place === undefined) {
		const name = str(args.name) ?? str(args.path_hint) ?? str(nextArgs.name);
		const lane = laneFor(name);
		return {
			...payload,
			next: {
				do: `PUT the file to put_url (the curl line), then finish the import: place puts it on a lane (here ${lane}; V1 = footage, V2 = stills and overlays, MUSIC / SFX = audio). Leave place out only to keep it in the media list without a clip.`,
				tool: "media",
				arguments: { ...nextArgs, place: { track: lane } },
			},
		};
	}

	// H11: autocut → captions on every clip, not on the cut clip's first piece
	if (tool === "autocut" && next?.tool === "captions" && str(nextArgs.element_id) && nextArgs.all === undefined) {
		const { element_id: _piece, ...rest } = nextArgs;
		return {
			...payload,
			next: {
				do: "Caption the whole cut (all clips with a transcript; the cut clip is now several pieces, and element_id would caption only the first). dry_run first to see the chunks.",
				tool: "captions",
				arguments: { ...rest, all: true, dry_run: true },
			},
		};
	}

	// H12: a dry run that adds captions over existing captions must not say "commit it"
	if ((tool === "revise" || (tool === "storyboard" && action === "edit_row")) && payload.dry_run === true) {
		const added = addedCaptionSpans(payload);
		if (!added.found) return payload;
		const timelineId = str(payload.timeline_id) ?? str(args.timeline_id);
		const head = timelineId ? await lookup(timelineId) : null;
		const existing = captionElements(head?.snapshot ?? null);
		const overlapping = added.spans.length
			? existing.filter((chunk) => added.spans.some(([start, end]) => chunk.start < Math.round(end * 120_000) && chunk.end > Math.round(start * 120_000)))
			: existing;
		if (!overlapping.length) return payload;
		const from = Math.min(...overlapping.map((chunk) => chunk.start));
		const to = Math.max(...overlapping.map((chunk) => chunk.end));
		const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
		return {
			...payload,
			warnings: [
				...warnings,
				`This plan ADDS a caption layer, but ${overlapping.length} caption element(s) already cover ${exactSeconds(from)}–${exactSeconds(to)} s: committing it would show the words twice.`,
			],
			duplicates_captions: { existing: overlapping.slice(0, 12).map((chunk) => ({ id: chunk.id, t: exactSeconds(chunk.start), end: exactSeconds(chunk.end), text: chunk.text, track: chunk.track })) },
			next: {
				do: "Don't commit this. Change the existing chunks instead (read them here): timeline_ops set {el: <chunk id>, prop: \"text\", value: \"…\"} on the CAPTIONS chunk and its CAPTION SHADOW twin; on CAPTION WORDS (one element per word) set only the word elements that change. To add or drop words, rebuild with the captions tool.",
				tool: "timeline",
				arguments: { action: "summary", timeline_id: timelineId, from_s: exactSeconds(from), to_s: exactSeconds(to) },
			},
		};
	}

	return payload;
}
