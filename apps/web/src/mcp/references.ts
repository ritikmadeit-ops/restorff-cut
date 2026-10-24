/**
 * MCP tool `references` (mcp-references agent, 2026-10-20; PARITY G14, EDT-21 — reel DePNgrmToh9 23.6–34.6 s): a
 * Claude drops folders of reference clips or images for a timeline, the server studies them into a style card
 * (palette, mood, grain, pacing, motion + three questions) and shows the Claude contact sheets of what it studied;
 * after the Claude has asked the person footage / format / feel, `build` makes an explainer on the Paper collage
 * preset as an editable timeline: ONE commit by `claude` whose message is the change note. Every later build is a new
 * version that replaces the last one and says "What's new in vN" (the ops diff summarised); each version also stays
 * on a branch `explainer-v<n>`.
 *
 *   add {timeline_id, files[]}            files: {path} (a file or a whole folder, on the server's machine) ·
 *                                          {url} · {data: base64, name} · {media_id} (the timeline's media store)
 *   study {timeline_id}                   → the card + contact sheets (images) + palette strip
 *   card {timeline_id}                    → the stored card, the files, the versions (no images)
 *   build {timeline_id, answers, topic, assets?} → plan → compositions rendered server-side → one commit
 *   remove {timeline_id, ids[]}           → files out of the set
 *
 * Server code: apps/web/src/server/references-{store,frames,study,build}.ts. Runbook: docs/restorff/worklog/mcp-references.md.
 */
import type { ExplainerAnswers, ExplainerAnswersV2 } from "@restorffcut/styles";
import type { Actor } from "@/server/auth";
import { getProjectHead } from "@/server/projects";
import { type AssetSpec, buildExplainerVersion, FEEL_VALUES, FOOTAGE_VALUES, FORMAT_VALUES } from "@/server/references-build";
import {
	addReferenceFiles,
	fileView,
	filesKey,
	loadSet,
	MAX_FILES,
	pathsAllowed,
	type ReferenceFileSpec,
	type ReferenceSet,
	removeReferenceFiles,
	saveSet,
	withSetLock,
} from "@/server/references-store";
import { cardView, studyReferences } from "@/server/references-study";
import { fail, type JsonSchema, type Payload, type Tool, type ToolContext, type ToolImage, type ToolOutput } from "./protocol";

const str = (description: string): JsonSchema => ({ type: "string", description });
/** How long a build waits for composition renders (the tool's budget is 200 s; placing + uploading + committing ≈ 5–20 s). */
const RENDER_WINDOW_MS = 150_000;

function actorOf(ctx: ToolContext): Actor {
	const kind = ctx.auth?.kind === "service" ? "service" : "local-dev";
	return { kind, id: ctx.auth?.userId ?? kind, name: ctx.auth?.name ?? "Claude (MCP)" };
}

function needTimeline(args: Record<string, unknown>): string {
	const value = args.timeline_id;
	if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error("timeline_id is required"), { status: 400 });
	return value.trim();
}

function editorUrl(ctx: ToolContext, timelineId: string): string {
	try {
		return `${new URL(ctx.request.url).origin}/editor/${encodeURIComponent(timelineId)}`;
	} catch {
		return `/editor/${encodeURIComponent(timelineId)}`;
	}
}

function setView(set: ReferenceSet) {
	const folders = [...new Set(set.files.map((file) => file.folder ?? "(no folder)"))];
	return {
		files: set.files.length,
		images: set.files.filter((file) => file.kind === "image").length,
		videos: set.files.filter((file) => file.kind === "video").length,
		folders,
		studied: set.study ? { at: set.study.at, current: set.study.files_key === filesKey(set.files) } : null,
		versions: set.versions.length,
	};
}

function versionsView(set: ReferenceSet) {
	return set.versions.map((version) => ({
		n: version.n,
		commit_id: version.commit_id,
		branch: version.branch,
		version_branch: version.version_branch,
		at: version.at,
		duration_s: version.summary.duration,
		note: version.change_note.split("\n").slice(0, 6).join("\n"),
	}));
}

// ─── actions ────────────────────────────────────────────────────────────────────────────────────────────────────

async function add(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = needTimeline(args);
	await getProjectHead(timelineId); // the timeline must exist
	const files = Array.isArray(args.files) ? (args.files as unknown[]) : [];
	if (!files.length) return fail("invalid_arguments", "files must list at least one {path} / {url} / {data, name} / {media_id}.");
	const specs: ReferenceFileSpec[] = [];
	for (const raw of files) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_arguments", "each file is an object: {path} | {url} | {data, name} | {media_id}, plus folder?");
		const item = raw as Record<string, unknown>;
		const pick = (key: string) => (typeof item[key] === "string" ? (item[key] as string) : undefined);
		specs.push({ data: pick("data"), url: pick("url"), path: pick("path"), media_id: pick("media_id"), name: pick("name"), folder: pick("folder"), mime: pick("mime") });
	}
	const result = await addReferenceFiles(timelineId, specs, { signal: ctx.signal });
	const view = setView(result.set);
	return {
		payload: {
			timeline_id: timelineId,
			added: result.added.map(fileView),
			skipped: result.skipped,
			set: view,
			note: "References are studied, never imported into the timeline's media (third-party material).",
			next: view.files
				? { do: "Study the references: you get the style card and contact sheets of every file — look at them before asking the person anything.", tool: "references", arguments: { action: "study", timeline_id: timelineId } }
				: { do: "Nothing was added: fix the files (see skipped) and add again.", tool: "references", arguments: { action: "add", timeline_id: timelineId, files: [{ path: "…/a reference folder" }] } },
		},
		// nothing added is an error, unless every file was simply already there
		...(result.added.length || result.skipped.every((skip) => skip.reason.startsWith("already in the set")) ? {} : { isError: true }),
	};
}

async function remove(args: Record<string, unknown>): Promise<ToolOutput> {
	const timelineId = needTimeline(args);
	const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).filter((id): id is string => typeof id === "string") : [];
	if (!ids.length) return fail("invalid_arguments", "ids must list file ids (from add or card).");
	const result = await removeReferenceFiles(timelineId, ids);
	return {
		payload: {
			timeline_id: timelineId,
			removed: result.removed,
			unknown: result.unknown,
			set: setView(result.set),
			next: { do: "Study again: the card is made from the files that are left.", tool: "references", arguments: { action: "study", timeline_id: timelineId } },
		},
	};
}

async function study(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = needTimeline(args);
	const wantImages = args.images !== false;
	return withSetLock(timelineId, async () => {
		const set = await loadSet(timelineId);
		if (!set.files.length) {
			const out = fail("no_references", "This timeline has no references yet.");
			(out.payload as Payload).next = { do: "Add the person's reference folders first.", tool: "references", arguments: { action: "add", timeline_id: timelineId, files: [{ path: "…/2.5D depth" }, { path: "…/Map zoom" }] } };
			return out;
		}
		const output = await studyReferences(set, { images: wantImages, signal: ctx.signal });
		set.study = output.study;
		await saveSet(set);
		const images: ToolImage[] = [...output.sheets.map((sheet) => ({ data: sheet.data, mimeType: sheet.mimeType })), ...(output.palette ? [output.palette] : [])];
		const card = output.study.card;
		const suggested = Object.fromEntries(card.questions.map((question) => [question.id, question.suggested]));
		return {
			payload: {
				timeline_id: timelineId,
				studied: {
					files: output.study.files.length,
					images: output.study.files.filter((file) => file.kind === "image").length,
					videos: output.study.files.filter((file) => file.kind === "video").length,
					skipped: output.study.skipped,
					failed: output.study.failed,
				},
				card: cardView(card),
				files: output.study.files.map((file) => ({
					id: file.id,
					name: file.name,
					folder: file.folder,
					kind: file.kind,
					dims: `${file.width}x${file.height}`,
					...(file.kind === "video" ? { studied_s: file.studied_s, cuts: file.cuts.length, cut_times: file.cuts.slice(0, 12) } : {}),
				})),
				images: wantImages
					? [
							...output.sheets.map((sheet, i) => ({ image: i + 1, what: `contact sheet${sheet.folder ? ` — folder "${sheet.folder}"` : ""}`, columns: sheet.columns, tiles: sheet.tiles })),
							...(output.palette ? [{ image: output.sheets.length + 1, what: "palette strip: the card's colours left to right, widths = share" }] : []),
						]
					: [],
				...(output.sheets_dropped ? { sheets_dropped: output.sheets_dropped } : {}),
				next: {
					do: `Look at the sheets, say what the references have in common (palette, texture, motion, pacing), then ask the person the card's three questions — ${card.questions.map((q) => q.ask).join(" ")} — and the topic. Then build with their answers (suggested shown).`,
					tool: "references",
					arguments: { action: "build", timeline_id: timelineId, answers: suggested, topic: "…what the explainer explains…" },
				},
			},
			images,
		};
	});
}

async function card(args: Record<string, unknown>): Promise<ToolOutput> {
	const timelineId = needTimeline(args);
	const set = await loadSet(timelineId);
	const studied = set.study;
	return {
		payload: {
			timeline_id: timelineId,
			set: setView(set),
			files: set.files.map(fileView),
			card: studied ? cardView(studied.card) : null,
			studied_at: studied?.at ?? null,
			stale: studied ? studied.files_key !== filesKey(set.files) : null,
			versions: versionsView(set),
			next: !set.files.length
				? { do: "Add reference files first.", tool: "references", arguments: { action: "add", timeline_id: timelineId, files: [{ path: "…" }] } }
				: !studied || studied.files_key !== filesKey(set.files)
					? { do: "Study the references (the card is missing or older than the files).", tool: "references", arguments: { action: "study", timeline_id: timelineId } }
					: { do: "Build (or rebuild) the explainer with the person's answers.", tool: "references", arguments: { action: "build", timeline_id: timelineId, answers: Object.fromEntries(studied.card.questions.map((q) => [q.id, q.suggested])), topic: "…" } },
		},
	};
}

function readAnswers(raw: unknown): { answers: ExplainerAnswersV2; problems: string[] } {
	const problems: string[] = [];
	const answers: ExplainerAnswersV2 = {};
	if (raw === undefined) return { answers, problems };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { answers, problems: ["answers must be an object {footage, format, feel, …}"] };
	const a = raw as Record<string, unknown>;
	const pickEnum = <T extends string>(key: string, values: readonly string[]): T | undefined => {
		if (a[key] === undefined) return undefined;
		if (typeof a[key] === "string" && values.includes(a[key] as string)) return a[key] as T;
		problems.push(`answers.${key} must be one of: ${values.join(", ")}`);
		return undefined;
	};
	const footage = pickEnum<NonNullable<ExplainerAnswers["footage"]>>("footage", FOOTAGE_VALUES);
	const format = pickEnum<NonNullable<ExplainerAnswers["format"]>>("format", FORMAT_VALUES);
	const feel = pickEnum<NonNullable<ExplainerAnswers["feel"]>>("feel", FEEL_VALUES);
	if (footage) answers.footage = footage;
	if (format) answers.format = format;
	if (feel) answers.feel = feel;
	const text = (key: "type" | "number" | "verdict" | "title" | "narration") => {
		if (a[key] === undefined) return;
		if (typeof a[key] === "string") answers[key] = a[key] as string;
		else problems.push(`answers.${key} must be a string`);
	};
	text("type");
	text("number");
	text("verdict");
	text("title");
	text("narration");
	if (a.length_s !== undefined) {
		if (typeof a.length_s === "number" && Number.isFinite(a.length_s) && a.length_s >= 5 && a.length_s <= 600) answers.length_s = a.length_s;
		else problems.push("answers.length_s must be a number of seconds, 5–600");
	}
	// beats: one line per beat — strings (as before) or {line, picture?, tag?} (explainer-v2): picture = a media id or
	// picture name for that line, tag = its label tag
	if (a.beats !== undefined) {
		const list = Array.isArray(a.beats) ? (a.beats as unknown[]) : null;
		const ok = list?.every((item) => typeof item === "string" || (item && typeof item === "object" && typeof (item as Record<string, unknown>).line === "string" && ["picture", "tag"].every((k) => (item as Record<string, unknown>)[k] === undefined || typeof (item as Record<string, unknown>)[k] === "string")));
		if (list && ok) {
			// more than the plan takes (12) is not refused: the plan's notes say which were used
			answers.beats = list.map((item) => {
				if (typeof item === "string") return item;
				const o = item as Record<string, unknown>;
				return { line: o.line as string, ...(typeof o.picture === "string" ? { picture: o.picture } : {}), ...(typeof o.tag === "string" ? { tag: o.tag } : {}) };
			});
		} else problems.push("answers.beats must be a list of lines (strings) or of {line, picture?, tag?}");
	}
	if (a.places !== undefined) {
		if (Array.isArray(a.places) && (a.places as unknown[]).every((item) => typeof item === "string")) answers.places = (a.places as string[]).slice(0, 5);
		else problems.push("answers.places must be a list of strings");
	}
	if (a.dates !== undefined) {
		const dates = Array.isArray(a.dates) ? (a.dates as unknown[]) : null;
		if (dates?.every((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).date === "string" && typeof (item as Record<string, unknown>).text === "string")) {
			answers.dates = (dates as Array<{ date: string; text: string }>).slice(0, 4).map((item) => ({ date: item.date, text: item.text }));
		} else problems.push("answers.dates must be a list of {date, text}");
	}
	const known = new Set(["footage", "format", "feel", "type", "number", "verdict", "beats", "places", "dates", "title", "narration", "length_s"]);
	for (const key of Object.keys(a)) if (!known.has(key)) problems.push(`answers.${key} is not a known answer (${[...known].join(", ")})`);
	return { answers, problems };
}

function readAssets(raw: unknown): { assets?: AssetSpec[]; problems: string[] } {
	if (raw === undefined) return { problems: [] };
	if (!Array.isArray(raw)) return { problems: ["assets must be a list of media ids (or {media_id, kind?, name?, duration?, caption?, tags?})"] };
	const assets: AssetSpec[] = [];
	for (const item of raw) {
		if (typeof item === "string" && item.trim()) assets.push(item.trim());
		else if (item && typeof item === "object" && typeof (item as Record<string, unknown>).media_id === "string") {
			const o = item as Record<string, unknown>;
			assets.push({
				media_id: o.media_id as string,
				...(o.kind === "video" || o.kind === "image" ? { kind: o.kind } : {}),
				...(typeof o.name === "string" ? { name: o.name } : {}),
				...(typeof o.duration === "number" ? { duration: o.duration } : {}),
				...(typeof o.caption === "string" ? { caption: o.caption } : {}),
				...(Array.isArray(o.tags) && o.tags.every((tag) => typeof tag === "string") ? { tags: o.tags as string[] } : {}),
			});
		} else return { problems: ["each asset is a media id string or {media_id, kind?, name?, duration?, caption?, tags?}"] };
	}
	return { assets, problems: [] };
}

async function build(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = needTimeline(args);
	const { answers, problems } = readAnswers(args.answers);
	const { assets, problems: assetProblems } = readAssets(args.assets);
	if (problems.length || assetProblems.length) return fail("invalid_arguments", "Fix the answers and build again.", { problems: [...problems, ...assetProblems] });
	const topic = typeof args.topic === "string" ? args.topic.trim().slice(0, 120) : undefined;
	// renders must be done by here: the call's 200 s budget minus room to place, upload and commit
	const deadline = Date.now() + RENDER_WINDOW_MS;
	return withSetLock(timelineId, async () => {
		const set = await loadSet(timelineId);
		if (!set.files.length) {
			const out = fail("no_references", "No references to build from: add and study them first.");
			(out.payload as Payload).next = { do: "Add the reference folders.", tool: "references", arguments: { action: "add", timeline_id: timelineId, files: [{ path: "…" }] } };
			return out;
		}
		const notes: string[] = [];
		if (!set.study || set.study.files_key !== filesKey(set.files)) {
			set.study = (await studyReferences(set, { images: false, signal: ctx.signal })).study;
			await saveSet(set);
			notes.push("the card was missing or older than the files: studied again first (call study to see the sheets)");
		}
		const outcome = await buildExplainerVersion(set, set.study.card, {
			timelineId,
			branch: typeof args.branch === "string" && args.branch ? args.branch : undefined,
			baseCommit: typeof args.base_commit === "string" && args.base_commit ? args.base_commit : undefined,
			answers,
			topic,
			assets,
			message: typeof args.message === "string" ? args.message : undefined,
			actor: actorOf(ctx),
			signal: ctx.signal,
			deadline,
		});
		if (!outcome.ok) {
			const out = fail(outcome.code, outcome.message, outcome.extra ?? {});
			(out.payload as Payload).next = { do: "Read the timeline again, then build on its head.", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } };
			return out;
		}
		set.versions.push(outcome.version);
		await saveSet(set);
		const { version, plan } = outcome;
		return {
			payload: {
				timeline_id: timelineId,
				version: version.n,
				commit_id: version.commit_id,
				branch: version.branch,
				version_branch: version.version_branch,
				change_note: version.change_note,
				...(outcome.whats_new.length ? { whats_new: outcome.whats_new } : {}),
				replaced: outcome.replaced,
				answers: outcome.answers,
				topic: version.summary.topic,
				plan: {
					start_s: version.summary.start,
					duration_s: plan.duration,
					canvas: version.summary.canvas,
					// v2: each beat = {line, picture(s) + why, tag} and its shots ("t+dur kind picture")
					beats: plan.beats.map((beat) => {
						const bound = plan.binding[beat.index];
						const nameOf = (id: string | undefined) => outcome.assets.find((asset) => asset.id === id)?.name ?? id ?? "";
						return {
							n: beat.index + 1,
							kind: beat.kind,
							t: beat.start,
							end: beat.end,
							line: beat.line,
							pictures: bound?.pictures.map((p) => ({ media: p.id, name: p.name, why: p.why })) ?? [],
							...(bound?.unmatched ? { unmatched: bound.unmatched } : {}),
							tag: bound?.tag ?? "",
							tag_from: bound?.tagFrom ?? "none",
							shots: plan.shots
								.filter((shot) => shot.beat === beat.index)
								.map((shot) => `${shot.t}+${shot.dur} ${shot.kind}${shot.picture ? ` ${nameOf(shot.picture)}` : ""}${shot.overlays.length ? ` (+ ${shot.overlays.map((key) => key.replace(/^b\d+(s\d+)?-/, "")).join(", ")})` : ""}`),
							effects: beat.effects,
						};
					}),
					pacing: { ...plan.pacing, shots: plan.shots.length },
					script: plan.script,
					effects: plan.report.effects,
					missing: plan.report.missing,
					notes: [...notes, ...plan.report.notes],
				},
				compositions: outcome.renders,
				...(outcome.extras.length ? { collage_fx_used: outcome.extras } : {}),
				footage: outcome.assets.map((asset) => ({ media: asset.id, kind: asset.kind, name: asset.name })),
				stats: outcome.stats,
				...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
				editor_url: editorUrl(ctx, timelineId),
				editor: "The editor pulls this commit (and the composition videos) within ~15 s or on focus; every beat is an ordinary clip, text or composition the person can edit.",
				next: {
					do: `Read the summary, render a preview and look at it; then tell the person "v${version.n} is done" with the change note and the editor link. For another version, build again with the changed answers.`,
					tool: "timeline",
					arguments: { action: "summary", timeline_id: timelineId },
				},
			},
		};
	});
}

// ─── the tool ───────────────────────────────────────────────────────────────────────────────────────────────────

const FILE_SCHEMA: JsonSchema = {
	type: "object",
	description: "One reference: exactly one of path, url, data, media_id; plus folder (the reference folder's name) and name.",
	properties: {
		path: str("A file or a whole folder on the server's machine (local dev): a folder adds every image and clip in it, its name becoming the folder (subfolders: theirs)."),
		url: str("An http(s) URL of an image or clip."),
		data: str("The file as base64 (or a data: URL), for small files: a request is capped at 1 MB. Needs name (with its extension) or mime."),
		media_id: str("A media id in this timeline's media store (e.g. from media import)."),
		name: str("File name with extension (data: required unless mime is given)."),
		folder: str("The reference folder it belongs to, e.g. \"2.5D depth\" or \"Map zoom\"."),
		mime: str("data / url: the content type when the name has no extension."),
	},
	additionalProperties: false,
};

export const REFERENCES_TOOL: Tool = {
	name: "references",
	title: "References → style card → explainer",
	description: `Study reference folders (clips or images of a look the person wants) and build an explainer in that style. add = put files into the timeline's reference set (${MAX_FILES} max; studied, never imported into the timeline): {path} (a file or whole folder on this machine${pathsAllowed() ? "" : " — off on this server"}), {url}, {data: base64, name}, {media_id}. study = ffmpeg reads every file (scene changes + evenly spaced frames) into a style card — palette with roles, mood, grain/texture, pacing (cuts per 10 s), motion — plus three questions (footage, format, feel) with suggested answers, and returns contact sheets of what it studied as images: look at them. card = the stored card, files and versions. build = with the person's answers {footage: mine|stills|none, format: 9:16|4:5|1:1|16:9, feel: playful|nostalgic|serious|punchy, type?, beats? (one on-screen line per beat: strings, or {line, picture?: media id or picture name, tag?}), narration? (a script: its sentences become the beats when beats is not given), title? (the title tiles' word; default beat 1's line), length_s? (target seconds), places? (map stops), dates? ({date, text}), number? (tiles on the line that says it), verdict? (the stamp)} and a topic: the Paper collage explainer as BEATS {line, picture, tag} — each line on the pictures whose name, caption or tags share its subject (a line nothing matches is said so and shown on paper, never on a random picture), each tag from the places / dates / subject the line names — cut into shots at the feel's pace (punchy ≈ 5 cuts per 10 s, playful 4, serious 3.3, nostalgic 3; length_s stretches beats into more shots): photos alternating with paper shots of photo cut-outs with a thick outline in the card's accent, drifting scraps, a map zoom, thread timeline, retro TV, halftone, parallax strip, torn-hole push, number tiles and stamp where the lines and references call for them (collage-kit compositions by name; every display text set). Every composition is rendered server-side and placed, as ONE commit by claude whose message is the change note; renders get ~150 s per call — anything not done is listed and is cached for the next build, and nothing is committed if the call runs out of time. assets = the timeline's media ids to use as pictures (default: all of them), each optionally {media_id, caption?, tags?} saying what it shows (matched like its name). Build again with changed answers for v2, v3…: each replaces the last, says "What's new in vN" (the ops diff summarised) and stays on branch explainer-v<n>. remove = files out of the set.`,
	inputSchema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["add", "study", "card", "build", "remove"] },
			timeline_id: str("The timeline (project id from timeline list) the references and the explainer belong to."),
			files: { type: "array", items: FILE_SCHEMA, description: "add: the references.", minItems: 1 },
			ids: { type: "array", items: { type: "string" }, description: "remove: file ids (from add or card)." },
			images: { type: "boolean", description: "study: return the contact sheets + palette strip as images (default true)." },
			answers: {
				type: "object",
				description: "build: the person's answers to the card's questions (unanswered ones take the card's suggestion): footage, format, feel, plus optional type, beats (strings or {line, picture?, tag?}), narration, title, length_s, places, dates, number, verdict.",
			},
			topic: str("build: what the explainer explains, e.g. \"how the farm-to-bottle route works\"."),
			assets: { type: "array", description: "build: media ids on this timeline to use as pictures (strings, or {media_id, kind?, name?, duration?, caption?, tags?} — caption/tags say what it shows and are matched against the lines). Default: every picture the timeline has." },
			base_commit: str("build: optional; the head you read. If the timeline moved on, nothing is built."),
			branch: str("build: branch (default: the project's default branch)."),
			message: str("build: optional words added to the change note's first line."),
		},
		required: ["action", "timeline_id"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	// build renders up to ~8 compositions (≈1 s per output second each, 3 at a time) + the study of up to 48 files
	budgetSeconds: 200,
	async run(args, ctx) {
		switch (args.action) {
			case "add":
				return add(args, ctx);
			case "study":
				return study(args, ctx);
			case "card":
				return card(args);
			case "build":
				return build(args, ctx);
			case "remove":
				return remove(args);
			default:
				return fail("invalid_arguments", `Unknown action ${String(args.action)}.`);
		}
	},
};

/** The line the server's instructions get. */
export const REFERENCES_INSTRUCTIONS =
	"When the person drops reference folders (clips or images of a look) and wants a video like them: references add (paths, URLs or base64) → references study (style card + contact sheets: look at them) → ask the card's three questions (footage, format, feel) and the topic → references build = an editable explainer as one commit; build again with changed answers for v2, v3 (each says what's new).";
