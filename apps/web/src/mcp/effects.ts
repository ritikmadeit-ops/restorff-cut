/**
 * MCP tool `effects` (mcp-effects agent, 2026-10-20; EDT-17): the effects library by name — the same catalogue the
 * editor's Effects → Library view shows (server/effects-catalogue.ts reads its rows), plus the package compositions,
 * transitions and grade looks that can be applied by name.
 *
 *   list      every effect with status (ready · partial · coming), kind and what it needs; filter by status, kind,
 *             reel, group or a word
 *   describe  one effect: params (live from packages/compositions for compositions), what it needs, its EFFECTS.md
 *             entry (Seen · Params · Accept), and the exact apply call
 *   apply     the effect at t, at a word's onset (word timings from the server transcript, else the caption words), on
 *             a clip (element_id) — one commit by claude. Compositions render + land on MOTION; shaders become an FX
 *             layer (or go on the clip); transitions and grades are ops@1. Matte effects answer needs: person_matte →
 *             cutout; coming ones answer not_built with what is missing.
 *
 * Server code: server/effects.ts. Runbook + example calls: docs/restorff/worklog/mcp-effects.md.
 */
import type { Actor } from "@/server/auth";
import { countByStatus, findEffect, GROUP_IMPORTED_PREFIX, type LibraryEffect } from "@/server/effects-catalogue";
import { applyEffect, describeParams, effectReference, gate, loadLibrary, matteVersion, removeEffect, updateEffect } from "@/server/effects";
import { LANE_ORDER } from "@/server/effects-lanes";
import { HttpError } from "@/server/http";
import { withParamRows } from "@/server/params-list";
import { fail, type JsonSchema, type Payload, type Tool, type ToolContext, type ToolOutput } from "./protocol";

const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: "number", description, ...extra });

const KINDS = ["composition", "shader", "transition", "grade", "captions", "layout"];

function actorOf(ctx: ToolContext): Actor {
	const kind = ctx.auth?.kind === "service" ? "service" : "local-dev";
	return { kind, id: ctx.auth?.userId ?? kind, name: ctx.auth?.name ?? "Claude (MCP)" };
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** What a row applies through, in one short string. */
function uses(effect: LibraryEffect): string | null {
	const apply = effect.apply;
	if (!apply) return null;
	switch (apply.kind) {
		case "composition":
			return `composition ${apply.composition}`;
		case "shader":
			return `shader ${apply.effectType}`;
		case "transition":
			return `transition ${apply.transition}`;
		case "grade":
			return `grade ${apply.look}`;
		case "tool":
			return `tool ${apply.tool}`;
	}
}

function row(effect: LibraryEffect) {
	return {
		id: effect.id,
		name: effect.name,
		status: effect.status,
		kind: effect.kind,
		...(uses(effect) ? { uses: uses(effect) } : {}),
		...(effect.needs.length ? { needs: effect.needs } : {}),
		...(effect.blocking.length ? { blocked_by: effect.blocking } : {}),
		...(effect.reels.length ? { reels: effect.reels } : {}),
		note: effect.note.length > 140 ? `${effect.note.slice(0, 137)}…` : effect.note,
		...(effect.warning ? { warning: effect.warning } : {}),
	};
}

/** A ready-to-send apply call for an effect (what `describe` and `list` suggest). */
function applyExample(effect: LibraryEffect, timelineId?: string): Record<string, unknown> {
	const base = { action: "apply", name: effect.id, timeline_id: timelineId ?? "…" };
	switch (effect.apply?.kind) {
		case "composition":
			return { ...base, word: "…a word that is said…", params: {} };
		case "shader":
			return { ...base, word: "…a word that is said…" };
		case "transition":
			return { ...base, t: 0, note: "t = near the cut (timeline summary shows where clips meet)" };
		case "grade":
			return { ...base };
		default:
			return base;
	}
}

async function list(args: Record<string, unknown>): Promise<ToolOutput> {
	const { library, packageError } = await loadLibrary();
	const status = text(args.status);
	const kind = text(args.kind);
	const reel = text(args.reel)?.toLowerCase();
	const group = text(args.group)?.toLowerCase();
	const query = text(args.query)?.toLowerCase();
	const wanted = library.filter((effect) => {
		if (status && status !== "all") {
			if (status === "usable" ? effect.status === "coming" : effect.status !== status) return false;
		}
		if (kind && effect.kind !== kind) return false;
		if (reel && !effect.reels.some((id) => id.toLowerCase().startsWith(reel))) return false;
		if (group && !effect.group.toLowerCase().includes(group)) return false;
		if (query && ![effect.id, effect.name, effect.note, ...effect.aliases].some((value) => value.toLowerCase().includes(query))) return false;
		return true;
	});
	const catalogue = library.filter((effect) => effect.source === "catalogue");
	const groups = [...new Set(wanted.map((effect) => effect.group))];
	const firstReady = wanted.find((effect) => effect.status === "ready") ?? wanted[0];
	return {
		payload: {
			counts: {
				catalogue: { ...countByStatus(catalogue), total: catalogue.length, from: "docs/restorff/EFFECTS.md via the editor's Library view" },
				extras: library.length - catalogue.length,
				listed: wanted.length,
			},
			...(packageError ? { package_error: `packages/compositions could not be read (${packageError}); its extras are missing and composition rows are taken at their word` } : {}),
			// fx-sync imports (hundreds): an unfiltered list names each imported group with a count and three ids;
			// list {group: "imported · captions"} (or a query) shows its effects (fx-sync 2026-10-24)
			groups: groups.map((name) => {
				const inGroup = wanted.filter((effect) => effect.group === name);
				if (!group && !query && name.startsWith(GROUP_IMPORTED_PREFIX)) {
					return { group: name, count: inGroup.length, e_g: inGroup.slice(0, 3).map((effect) => effect.id), list_it: { tool: "effects", arguments: { action: "list", group: name } } };
				}
				return { group: name, effects: inGroup.map(row) };
			}),
			statuses: { ready: "applies as the reel shows it", partial: "applies; part of the reel's look is still missing (see note)", coming: "not built: apply answers not_built or needs" },
			next: firstReady
				? { do: `Read one before applying it (params, needs, the reel's Accept bullets): e.g. ${firstReady.name}.`, tool: "effects", arguments: { action: "describe", name: firstReady.id } }
				: { do: "Nothing matched: list everything.", tool: "effects", arguments: { action: "list" } },
		},
	};
}

function unknown(name: string, candidates: LibraryEffect[]): ToolOutput {
	const out = fail("unknown_effect", `No effect called "${name}".`, {
		...(candidates.length ? { did_you_mean: candidates.map((effect) => ({ id: effect.id, name: effect.name, status: effect.status })) } : {}),
	});
	(out.payload as Payload).next = candidates[0]
		? { do: `Did you mean ${candidates[0].name}?`, tool: "effects", arguments: { action: "describe", name: candidates[0].id } }
		: { do: "List the effects (filter with query).", tool: "effects", arguments: { action: "list", query: name } };
	return out;
}

async function describe(args: Record<string, unknown>): Promise<ToolOutput> {
	const name = text(args.name);
	if (!name) return fail("invalid_arguments", "describe needs name (an id like FX-10, a name like \"Chart Grow\", or an alias).");
	const { library, entries } = await loadLibrary();
	const found = findEffect(library, name);
	if (!found.effect) return unknown(name, found.candidates);
	const effect = found.effect;
	const timelineId = text(args.timeline_id);
	const blocked = gate(effect, library, timelineId);
	const reference = await effectReference(effect.id);
	// timing-helper (2026-10-21): params as one list of {name, type, default, …} for every kind; the old shape is params_legacy
	const params = withParamRows(describeParams(effect, entries));
	// a composition with a layered recipe is built behind the speaker by effects apply itself (effects-layers agent)
	const behind = params.layers ? null : matteVersion(effect, timelineId);
	return {
		payload: {
			effect: {
				id: effect.id,
				name: effect.name,
				slug: effect.slug,
				aliases: effect.aliases,
				group: effect.group,
				status: effect.status,
				kind: effect.kind,
				build: effect.build,
				needs: effect.needs,
				blocked_by: effect.blocking,
				reels: effect.reels,
				note: effect.note,
				...(effect.related ? { related: effect.related } : {}),
				...(effect.warning ? { warning: effect.warning } : {}),
			},
			params,
			where: {
				t: "timeline seconds where it starts",
				word: "starts on the onset of this word or phrase (server transcript of the media, else the caption words); occurrence picks the n-th time",
				element_id: "a clip: shaders go on it for its whole length, transitions lead into it, grades colour it",
				duration_s: "how long (compositions: render length; shaders: layer length; transitions: transition length)",
			},
			...(reference ? { reference } : {}),
			...(behind ? { behind_the_speaker: behind } : {}),
			can_apply: !blocked,
			...(blocked ? { why_not: blocked.payload } : {}),
			next: blocked
				? (blocked.payload.next as Payload)
				: { do: `Apply ${effect.name}.`, tool: "effects", arguments: applyExample(effect, timelineId) },
		},
	};
}

/** effects-v2: update / remove an applied effect from any of its elements (server/effects.ts updateEffect/removeEffect). */
async function changeAction(action: "update" | "remove", args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const timelineId = text(args.timeline_id);
	const elementId = text(args.element_id);
	if (!timelineId || !elementId) {
		const out = fail("invalid_arguments", `${action} needs timeline_id and element_id (any element of the applied effect: a layer, its FX layer, its person cutout, or the clip it is on). apply answers it as element_id (and change_it).`);
		(out.payload as Payload).next = timelineId
			? { do: "Read the timeline summary for element ids (effect layers sit on MOTION / MOTION BACK / MOTION FRONT / FX).", tool: "timeline", arguments: { action: "summary", timeline_id: timelineId } }
			: { do: "List the timelines.", tool: "timeline", arguments: { action: "list" } };
		return out;
	}
	const { library, entries } = await loadLibrary();
	const params = args.params && typeof args.params === "object" && !Array.isArray(args.params) ? (args.params as Record<string, unknown>) : {};
	const input = {
		timelineId,
		elementId,
		effectId: text(args.effect_id),
		params,
		t: typeof args.t === "number" ? args.t : undefined,
		word: text(args.word),
		occurrence: typeof args.occurrence === "number" ? args.occurrence : undefined,
		durationS: typeof args.duration_s === "number" ? args.duration_s : undefined,
		branch: text(args.branch),
		baseCommit: text(args.base_commit),
		message: text(args.message),
		dryRun: args.dry_run === true,
		waitS: typeof args.wait_s === "number" ? args.wait_s : undefined,
		measure: typeof args.measure === "boolean" ? args.measure : undefined,
		placement: args.placement === "off" ? ("off" as const) : args.placement === "auto" ? ("auto" as const) : undefined,
		signal: ctx.signal,
	};
	try {
		return action === "update" ? await updateEffect(input, library, entries, actorOf(ctx)) : await removeEffect(input, library, entries, actorOf(ctx));
	} catch (error) {
		if (error instanceof HttpError && error.status === 404) {
			const out = fail("not_found", error.message);
			(out.payload as Payload).next = { do: "List the timelines.", tool: "timeline", arguments: { action: "list" } };
			return out;
		}
		throw error;
	}
}

async function applyAction(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
	const name = text(args.name);
	if (!name) return fail("invalid_arguments", "apply needs name (an id like FX-10, a name like \"Chart Grow\", or an alias).");
	const timelineId = text(args.timeline_id);
	const { library, entries } = await loadLibrary();
	const found = findEffect(library, name);
	if (!found.effect) return unknown(name, found.candidates);
	if (!timelineId) {
		const out = fail("invalid_arguments", "apply needs timeline_id (a project id from timeline list).");
		(out.payload as Payload).next = { do: "List the timelines.", tool: "timeline", arguments: { action: "list" } };
		return out;
	}
	const params = args.params && typeof args.params === "object" && !Array.isArray(args.params) ? (args.params as Record<string, unknown>) : {};
	try {
		return await applyEffect(
			{
				effect: found.effect,
				entries,
				timelineId,
				baseCommit: text(args.base_commit),
				branch: text(args.branch),
				t: typeof args.t === "number" ? args.t : undefined,
				word: text(args.word),
				occurrence: typeof args.occurrence === "number" ? args.occurrence : undefined,
				elementId: text(args.element_id),
				params,
				durationS: typeof args.duration_s === "number" ? args.duration_s : undefined,
				message: text(args.message),
				dryRun: args.dry_run === true,
				waitS: typeof args.wait_s === "number" ? args.wait_s : undefined,
				signal: ctx.signal,
				...(typeof args.measure === "boolean" ? { measure: args.measure } : {}),
				...(args.placement === "off" || args.placement === "auto" ? { placement: args.placement } : {}),
			},
			library,
			actorOf(ctx),
		);
	} catch (error) {
		if (error instanceof HttpError && error.status === 404) {
			const out = fail("not_found", error.message);
			(out.payload as Payload).next = { do: "List the timelines.", tool: "timeline", arguments: { action: "list" } };
			return out;
		}
		throw error;
	}
}

export const EFFECTS_TOOL: Tool = {
	name: "effects",
	title: "Effects library (by name)",
	description:
		"The effects library of the reference reels (EDT-17) by name — the same list as the editor's Effects → Library: 62 effects (Orbit, Digital Zoom, Checklist, Chart Grow, Whip, Warm grade…) with status ready · partial · coming, plus every package composition, transition kind and grade look. list (filter status/kind/reel/group/query) → describe (params as one list of {name, type, default, …} for every kind, needs, the reel's Accept bullets, the exact call) → apply at t, at the onset of a word (\"add Chart Grow on 'doubled'\"), or on a clip (element_id), as one commit by claude: compositions render and land on MOTION, shaders become an FX layer (or go on the clip), transitions and grades are ops@1. Person effects whose composition has a layer recipe (Orbit, Couch Wall, Frame Break, Green Screen, Paper Cut, Cover Story, Headline Wall, Glass Type, Vertigo…) are built in layers: clip → back render → the speaker's person cutout (server matte, made or reused; wait_s) → front render, with the matte frames, face box and clip keys the recipe asks for. effects-v2: the person cutout is a V2 CUTOUT segment only over the effect (so a transition blurs the speaker too). Placement is face-safe: overlays and front layers are measured against the speaker's face box and moved off it (offsetY, scale, or dropping example text you did not set); Digital Zoom centres on the face; Cover Story / Glass Type sit on the real head top; answers and dry runs report each overlay's box against the face box (placement). An applied effect can be changed: update {element_id, params} re-renders all its layers in ONE commit (params merge over the ones you set; t / word / duration_s move it; no params = re-place it); remove {element_id} takes its layers, its person segment and its clip keys away. element_id = any element of the effect (apply answers it). Lanes are reused in a fixed order, top → bottom: " +
		LANE_ORDER.join(" · ") +
		". Coming ones answer not_built with what is missing. dry_run shows the plan without committing (compositions render, cached, to measure placement; measure: false = plan only). How to use them well (which transition for which seam, numbers and charts, pacing): guide {topic: \"transitions\"} / \"numbers\" / \"pacing-retention\".",
	inputSchema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["list", "describe", "apply", "update", "remove"] },
			name: str("describe, apply: the effect — an id (FX-10, comp:magazine-cover, tr:dissolve, grade:film), a name (\"Chart Grow\"), a slug or alias (\"punch in\", \"whip\", \"moody\"), a composition name, a transition kind or a grade look."),
			status: { type: "string", enum: ["ready", "partial", "coming", "usable", "all"], description: "list: only this status (usable = ready + partial)." },
			kind: { type: "string", enum: KINDS, description: "list: only this kind." },
			reel: str("list: only effects seen in this reference reel (Def9pj5TWtA, DeIGbZypIUb, DeUUFJQu8cw, DeBhOJ6T1Ja, DePNgrmToh9; a prefix is enough)."),
			group: str("list: only this group (e.g. \"17 named\", \"Captions\", \"Looks\", \"Transitions\", \"Grades\")."),
			query: str("list: a word to look for in names, aliases and notes."),
			timeline_id: str("apply (describe: optional, for a ready call): the timeline (project id from timeline list)."),
			t: num("apply: where it starts, timeline seconds. Transitions: the cut nearest t.", { minimum: 0 }),
			word: str("apply: start on the onset of this word or phrase (instead of t)."),
			occurrence: num("apply with word: which time it is said (1 = first, default).", { minimum: 1 }),
			element_id: str("apply: a clip — shaders go on it (whole clip), transitions lead into it, grades colour it. update, remove: any element of the applied effect (a layer, its FX layer, its person cutout, or the clip it is on)."),
			params: { type: "object", description: "apply: the effect's params (describe lists them). Compositions: merged over the example props. Shaders: slider values. Transitions: kind / direction / track / reach_s. Grades: look / target / sliders. update: only what changes (merged over the params you set before). Image params (Orbit / Couch Wall cards, thumbnails…) take a media_id of this timeline (media import answers it; a video's id = its frame at 1 s), media:<id>, this server's /api/projects/<timeline>/media/<id> URL, an https: or a data: URL — never a file path." },
			duration_s: num("apply, update: length in seconds (composition render length · shader layer length · transition length).", { minimum: 0.1, maximum: 60 }),
			base_commit: str("apply: optional; the head you read. If the timeline moved on, nothing is done (conflict)."),
			branch: str("apply: branch (default: the project's default branch)."),
			message: str("apply: the commit message (default: effect: <name> on \"<word>\" / at <t> s)."),
			dry_run: { type: "boolean", description: "apply: show what would happen (render plan, ops, placement) without rendering or committing." },
			wait_s: num("apply, person effects (Orbit, Frame Break, Green Screen, Cover Story…): hold the call up to this many seconds while the clip's person matte is made (default 90). If it is not done by then, nothing is committed and next says how to poll. Digital Zoom waits up to 45 s for the face box by default.", { minimum: 0, maximum: 120 }),
			effect_id: str("update, remove, when element_id is a clip: the shader effect on it (apply answered on_clip.effect_id), or \"transition\" for the transition into it."),
			measure: { type: "boolean", description: "apply/update dry_run: render (cached) and measure each overlay against the face box (default true); false = plan only." },
			placement: { type: "string", enum: ["auto", "off"], description: "apply/update: auto (default) moves overlays off the speaker's face (offsetY, scale, dropping example text you did not set); off only reports where they land." },
		},
		required: ["action"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	// a composition render takes ~1 s per output second at 1080×1920 plus ~1 s to start Chromium; person effects may
	// also wait (wait_s, ≤ 120 s) for the clip's matte job
	budgetSeconds: 180,
	async run(args, ctx) {
		switch (args.action) {
			case "list":
				return list(args);
			case "describe":
				return describe(args);
			case "apply":
				return applyAction(args, ctx);
			case "update":
				return changeAction("update", args, ctx);
			case "remove":
				return changeAction("remove", args, ctx);
			default:
				return fail("invalid_arguments", `Unknown action ${String(args.action)} (list · describe · apply · update · remove).`);
		}
	},
};

/** The line the server's instructions get. */
export const EFFECTS_INSTRUCTIONS =
	"Named effects from the reference reels (Chart Grow, Digital Zoom, Checklist, Whip, Warm grade…): effects list → effects describe <name> → effects apply <name> with t, word (\"on 'doubled'\") or element_id — one commit, placed off the speaker's face; change it with effects update {element_id, params} (one commit) or effects remove {element_id}; see one effect without a render with look {kind: clip, timeline_id, element_id}; then render and look.";
