/**
 * MCP tool `director` (director agent, 2026-10-24; owner I-10: "make it knowledgeable enough to when to use those
 * features, effects, styles, techniques etc to make the video more retention worthy"; I-8: a weaker model must make
 * the same choices, so the taste lives in the tool).
 *
 *   plan        read the timeline (words, pictures, cuts, captions), split the words into beats, classify each (hook,
 *               number, list, proof, product, comparison, cta, …), pick a technique per beat from the catalogue with
 *               the rules (hook ≤ 1 s, a change every interval_s of the style, nothing reused inside its spacing,
 *               energy rising to the payoff, CTA last, face-safe, captions not fought, one big-word punch, sound on
 *               the events), params filled from the words — one line per choice. Never commits.
 *   apply       the same plan in ONE commit (effects apply chained + ops for punch-ins, word pops and sounds);
 *               dry_run = plan.
 *   fill        after a render: its retention map's still stretches (and a late hook) → plan only inside them; apply
 *               unless dry_run.
 *   techniques  the catalogue: filter by kind / purpose / beat / id; each with when to use it and why it holds attention.
 *
 * Server: ../server/director.ts (I/O), director-plan.ts (planner, pure), director-rules.ts (styles, classifier,
 * energy), director-fill.ts (params from words); records: packages/compositions/src/techniques-builtin.ts + sidecars.
 * Runbook: docs/restorff/worklog/director.md.
 */
import { join } from "node:path";
import { countByKind, loadTechniques, matchesRef, type TechniqueMeta } from "@restorffcut/compositions/techniques";
import { COMPOSITIONS_DIR } from "@/app/api/compositions/_lib/service";
import type { Actor } from "@/server/auth";
import { applyPlan, type DirectorRequest, directorContext, planFor, windowsFromRender } from "@/server/director";
import type { DirectorPlan, Override, PlannedEvent } from "@/server/director-plan";
import { type PieceType, RULES, STYLE_PROFILES } from "@/server/director-rules";
import { HttpError } from "@/server/http";
import { freshRow, isRenderId } from "@/server/renders-store";
import { rendersOfCommit } from "@/server/renders";
import { fail, type JsonSchema, type Payload, type Tool, type ToolContext, type ToolOutput } from "./protocol";

const str = (description: string): JsonSchema => ({ type: "string", description });
const num = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: "number", description, ...extra });
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const numberOr = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim()) : undefined);

function actorOf(ctx: ToolContext): Actor {
	const kind = ctx.auth?.kind === "service" ? "service" : "local-dev";
	return { kind, id: ctx.auth?.userId ?? kind, name: ctx.auth?.name ?? "Claude (MCP)" };
}

const listTimelines = { do: "List the timelines.", tool: "timeline", arguments: { action: "list" } };
function failNext(code: string, message: string, next: Payload, extra: Record<string, unknown> = {}): ToolOutput {
	const out = fail(code, message, extra);
	(out.payload as Payload).next = next;
	return out;
}

const PIECES: PieceType[] = ["ad", "reel", "explainer", "brand-film", "motion-graphic"];

function requestOf(args: Record<string, unknown>, ctx: ToolContext, dryRun: boolean): DirectorRequest | string {
	const timelineId = text(args.timeline_id);
	if (!timelineId) return "timeline_id is required.";
	const piece = text(args.piece) as PieceType | undefined;
	if (piece && !PIECES.includes(piece)) return `piece is one of ${PIECES.join(", ")}.`;
	const product = args.product && typeof args.product === "object" && !Array.isArray(args.product) ? (args.product as Record<string, unknown>) : null;
	const cta = args.cta && typeof args.cta === "object" && !Array.isArray(args.cta) ? (args.cta as Record<string, unknown>) : null;
	const overrides = Array.isArray(args.overrides)
		? (args.overrides as unknown[])
				.filter((o): o is Record<string, unknown> => !!o && typeof o === "object" && typeof (o as { beat?: unknown }).beat === "number")
				.map((o) => ({ beat: o.beat as number, ...(text(o.use) ? { use: text(o.use) } : {}), ...(o.skip === true ? { skip: true } : {}), ...(o.params && typeof o.params === "object" ? { params: o.params as Record<string, unknown> } : {}) }) as Override)
		: undefined;
	const energy = numberOr(args.energy);
	return {
		timelineId,
		dryRun,
		signal: ctx.signal,
		...(text(args.branch) ? { branch: text(args.branch) } : {}),
		...(text(args.base_commit) ? { baseCommit: text(args.base_commit) } : {}),
		...(text(args.style) ? { style: text(args.style) } : {}),
		...(piece ? { piece } : {}),
		...(energy !== undefined ? { energy: Math.max(1, Math.min(5, energy)) } : {}),
		...(args.seed !== undefined ? { seed: String(args.seed) } : {}),
		...(numberOr(args.from_s) !== undefined ? { from: numberOr(args.from_s) } : {}),
		...(numberOr(args.to_s) !== undefined ? { to: numberOr(args.to_s) } : {}),
		...(product ? { product: { ...(text(product.name) ? { name: text(product.name) } : {}), ...(text(product.image) ? { image: text(product.image) } : {}), ...(text(product.brand) ? { brand: text(product.brand) } : {}) } } : {}),
		...(cta ? { cta: { ...(text(cta.text) ? { text: text(cta.text) } : {}), ...(text(cta.keyword) ? { keyword: text(cta.keyword) } : {}) } } : {}),
		...(strings(args.images)?.length ? { images: strings(args.images) } : {}),
		...(strings(args.places)?.length ? { places: strings(args.places) } : {}),
		...(args.matte === true ? { matte: true } : {}),
		...(overrides?.length ? { overrides } : {}),
		...(strings(args.avoid)?.length ? { avoid: strings(args.avoid) } : {}),
		...(strings(args.only)?.length ? { only: strings(args.only) } : {}),
		...(args.grade === false ? { grade: false } : {}),
		...(args.sound === false ? { sound: false } : {}),
		...(text(args.message) ? { message: text(args.message) } : {}),
	};
}

/** The plan as an answer: compact events with their one-line why. */
function planView(plan: DirectorPlan, extra: { matched: string; words_source: string; techniques: { count: number; sidecars: number; errors: string[] } }) {
	const ev = (e: PlannedEvent) => ({
		n: e.n,
		role: e.role,
		...(e.beat !== null ? { beat: e.beat } : {}),
		t: e.t,
		duration_s: e.duration_s,
		id: e.id,
		name: e.name,
		...(e.word ? { word: e.word } : {}),
		...(Object.keys(e.params).length ? { params: e.params } : {}),
		why: e.why,
		...(e.alternatives.length ? { alternatives: e.alternatives } : {}),
	});
	return {
		planner: plan.planner,
		style: { ...plan.style, matched: extra.matched },
		seed: plan.seed,
		span: plan.span,
		words_source: extra.words_source,
		catalogue: { techniques: extra.techniques.count, sidecars: extra.techniques.sidecars, ...(extra.techniques.errors.length ? { sidecar_errors: extra.techniques.errors.slice(0, 5) } : {}) },
		beats: plan.beats.map((b) => ({ n: b.n, t: b.t, end: b.end, type: b.type, line: b.line.length > 90 ? `${b.line.slice(0, 87)}…` : b.line, why: b.why, energy: b.energy_target })),
		events: plan.events.map(ev),
		sounds: plan.sounds.map((s) => ({ t: s.t, id: s.id, name: s.name, on: s.word ?? undefined })),
		predicted: plan.predicted,
		...(plan.recommendations.length ? { recommendations: plan.recommendations } : {}),
		...(plan.notes.length ? { notes: plan.notes } : {}),
		rules: RULES,
		change_it:
			'One sentence = one change: overrides [{beat: 3, use: "FX-10"}] swaps a beat\'s technique (any id from alternatives or techniques), [{beat: 3, skip: true}] drops it, avoid ["FX-26"] never uses one, only [...] limits the pool, energy 1–5 moves the whole curve, style switches the grammar, seed gives another equally valid plan.',
	};
}

async function techniques(args: Record<string, unknown>): Promise<ToolOutput> {
	const loaded = loadTechniques({ dir: join(COMPOSITIONS_DIR, "compositions") });
	const kind = text(args.kind);
	const purpose = text(args.purpose);
	const beat = text(args.beat);
	const id = text(args.id);
	let list: TechniqueMeta[] = loaded.techniques;
	if (id) list = list.filter((t) => t.id === id || t.name.toLowerCase() === id.toLowerCase());
	if (kind) list = list.filter((t) => matchesRef(t, `kind:${kind}`));
	if (purpose) list = list.filter((t) => matchesRef(t, `purpose:${purpose}`));
	if (beat) list = list.filter((t) => matchesRef(t, `beat:${beat}`));
	const full = !!id || list.length <= 12;
	return {
		payload: {
			count: list.length,
			of: loaded.techniques.length,
			by_kind: countByKind(loaded.techniques),
			sidecars: loaded.sidecars,
			...(loaded.errors.length ? { sidecar_errors: loaded.errors.slice(0, 10) } : {}),
			styles: Object.values(STYLE_PROFILES).map((p) => ({ id: p.id, label: p.label, interval_s: p.intervalS, ref_events_per_10s: p.refEventsPer10s, energy: p.energy })),
			techniques: list.map((t) =>
				full
					? t
					: { id: t.id, kind: t.kind, name: t.name, purpose: t.purpose, beats: t.beats, energy: t.energy, placement: t.placement, needs: t.needs, via: t.apply.via, retention: t.retention },
			),
			next: { do: "Plan a timeline with these (director plan); give id for one technique in full.", tool: "director", arguments: { action: "plan", timeline_id: "<timeline_id>" } },
		},
	};
}

export const DIRECTOR_TOOL: Tool = {
	name: "director",
	title: "Director: picks effects, moves and sounds per beat for retention",
	description:
		"Decides WHEN to use which effect, transition, caption style, grade, sound and edit move, so the edit holds attention — the know-how of the five reference reels, in the tool. plan {timeline_id, style?, energy?, piece?}: splits the words into beats, classifies each (hook · problem · claim · number · list · steps · proof · product · comparison · explain · story · reveal · quote · cta · bridge) and picks a technique per beat from the catalogue with fixed rules — something changes inside 1 s, a change about every interval_s of the style (never a still stretch over 3 s, never busier than the reference), no technique reused inside its spacing, energy rising to the payoff, a CTA on the last beat, overlays face-safe, captions not fought, at least one big-word punch, a paired sound on events — with params filled from the words (numbers, list items, the keyword, the CTA) and times on word starts; one line per choice says why and how to change it. Never commits. apply: the same plan as ONE commit (dry_run = plan). fill {render_id}: plan only inside that render's still stretches (and a late hook), then apply (dry_run to look first). techniques {kind?, purpose?, beat?, id?}: the catalogue — what each does, which beats it fits, its energy, needs and why it works. Styles: explainer-overlay · neon-grid-type · paper-collage · effects-library · warm-moody · ad · fast-ugc · talking-head (saved style ids like restorff/style/fast-ugc work too). Give product {name, image (media id)}, cta {text, keyword}, images, places when you have them: techniques that need them become possible. Run autocut and captions first; render + check after.",
	inputSchema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["plan", "apply", "fill", "techniques"], description: "plan (read) · apply (one commit) · fill (a render's still stretches) · techniques (the catalogue)." },
			timeline_id: str("The timeline (its head is read; apply / fill commit on it)."),
			branch: str("Branch (default: the project's default branch)."),
			base_commit: str("apply / fill: the head you expect (refused if the timeline moved)."),
			style: str("explainer-overlay · neon-grid-type · paper-collage · effects-library · warm-moody · ad · fast-ugc · talking-head (or a saved style id). Default: from piece."),
			piece: { type: "string", enum: PIECES, description: "ad (default) · reel · explainer · brand-film · motion-graphic: picks the style when none is given." },
			energy: num("Base energy 1 (calm) – 5 (loud); the curve escalates from it. Default: the style's.", { minimum: 1, maximum: 5 }),
			seed: { type: ["string", "number"], description: "Same seed + same timeline = the same plan. Default: the timeline + head." },
			from_s: num("Plan from here (seconds)."),
			to_s: num("Plan up to here (seconds)."),
			product: { type: "object", description: "{name, image (a media id from media list / import), brand}: product beats, cards and showcases use them.", properties: { name: str("Product name."), image: str("Media id of a product still."), brand: str("Brand name.") } },
			cta: { type: "object", description: "{text, keyword}: the end card's line and the word to comment.", properties: { text: str("CTA line."), keyword: str("One word viewers comment.") } },
			images: { type: "array", items: { type: "string" }, description: "Media ids of stills effects may show (cards, cut-outs, before/after)." },
			places: { type: "array", items: { type: "string" }, description: "Place names for map routes (2+)." },
			matte: { type: "boolean", description: "Allow person-matte effects (behind the speaker): they wait for the matte (minutes). Default false." },
			overrides: { type: "array", items: { type: "object" }, description: "[{beat, use?: technique id or name, skip?: true, params?: {…}}]: change one beat's choice." },
			avoid: { type: "array", items: { type: "string" }, description: "Technique ids or selectors (kind:transition, purpose:hook) never to use." },
			only: { type: "array", items: { type: "string" }, description: "Use only these ids / selectors (plus sounds)." },
			grade: { type: "boolean", description: "false: leave the grade alone (default: the style's look when none is on)." },
			sound: { type: "boolean", description: "false: no sounds." },
			render_id: str("fill: the render whose retention map to fill (default: the head's newest finished render)."),
			kind: str("techniques: effect · transition · caption-style · grade · sound · edit-move · style."),
			purpose: str("techniques: hook · emphasis · pattern-interrupt · transition · list-steps · number-data · proof-social · product-showcase · comparison · cta · b-roll-replace · explain-concept · mood."),
			beat: str("techniques: a beat type (number, list, cta, …)."),
			id: str("techniques: one technique in full (id or name)."),
			dry_run: { type: "boolean", description: "apply / fill: show the plan, commit nothing." },
			message: str("apply / fill: the commit message (default \"director: <style> — N techniques + M sounds on K beats\")."),
		},
		required: ["action"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	budgetSeconds: 200,
	async run(args, ctx) {
		const action = text(args.action);
		if (action === "techniques") return techniques(args);
		if (action !== "plan" && action !== "apply" && action !== "fill") return fail("invalid_arguments", "action is plan, apply, fill or techniques.");
		const dryRun = action === "plan" || args.dry_run === true;
		const req = requestOf(args, ctx, dryRun);
		if (typeof req === "string") return failNext("invalid_arguments", req, listTimelines);
		try {
			let fillInfo: Record<string, unknown> | null = null;
			const context = await directorContext(req);
			if (action === "fill") {
				const renderId = text(args.render_id);
				let row = renderId ? (isRenderId(renderId) ? freshRow(renderId) : null) : null;
				if (renderId && !row) return failNext("not_found", `No render ${renderId} on this server.`, listTimelines);
				if (!row) row = rendersOfCommit(req.timelineId, context.head.headId).done ?? null;
				if (!row || row.status !== "done" || !row.file) {
					return failNext("no_render", "fill needs a finished render of the head: the still stretches are measured on the encoded file.", { do: "Render the head (preview), then fill with its render_id.", tool: "render", arguments: { timeline_id: req.timelineId, quality: "preview" } });
				}
				if (row.commit !== context.head.headId) {
					return failNext("stale_render", `Render ${row.render_id} shows commit ${row.commit.slice(0, 12)}, the head is ${context.head.headId.slice(0, 12)}: its times may not match.`, { do: "Render the head, then fill.", tool: "render", arguments: { timeline_id: req.timelineId, quality: "preview" } });
				}
				const got = await windowsFromRender(row, ctx.signal);
				if (!got.windows.length) {
					return { payload: { filled: false, render_id: row.render_id, retention: got.map, message: "Nothing to fill: the hook is inside 1 s and no still stretch is over the bar.", next: { do: "Check the render.", tool: "check", arguments: { render_id: row.render_id, comments: false } } } };
				}
				req.windows = got.windows;
				fillInfo = { render_id: row.render_id, retention_before: got.map, windows: got.windows };
			}
			const plan = planFor(context, req);
			const view = planView(plan, context);
			if (dryRun) {
				return {
					payload: {
						committed: false,
						head: context.head.headId,
						...(fillInfo ? { fill: fillInfo } : {}),
						...view,
						next: { do: "Looks right: apply it as one commit (same arguments, action apply); or change a beat with overrides.", tool: "director", arguments: { ...args, action: action === "fill" ? "fill" : "apply", dry_run: false, base_commit: context.head.headId } },
					},
				};
			}
			const answer = await applyPlan(context, req, plan, actorOf(ctx));
			if (!answer.ok) {
				return failNext(answer.code ?? "not_applied", answer.error ?? "Nothing was committed.", { do: "Read the plan again on the current head.", tool: "director", arguments: { action: "plan", timeline_id: req.timelineId } }, { steps: answer.steps, notes: answer.notes });
			}
			return {
				payload: {
					committed: true,
					commit_id: answer.commit_id,
					head_before: answer.head_before,
					branch: answer.branch,
					message: answer.message,
					...(fillInfo ? { fill: fillInfo } : {}),
					applied: answer.steps.filter((s) => s.ok).length,
					failed: answer.steps.filter((s) => !s.ok).map((s) => ({ n: s.n, id: s.id, t: s.t, error: s.error })),
					ops: answer.ops_count,
					...view,
					...(answer.notes.length ? { notes: [...(view.notes ?? []), ...answer.notes] } : {}),
					next: { do: "Render this commit and check it (the retention map shows whether every stretch now moves).", tool: "render", arguments: { timeline_id: req.timelineId, commit: answer.commit_id, quality: "preview" } },
				},
			};
		} catch (error) {
			if (error instanceof HttpError && error.status === 404) return failNext("not_found", error.message, listTimelines);
			throw error;
		}
	},
};

/** The line the server's instructions get. */
export const DIRECTOR_INSTRUCTIONS =
	"For taste and timing, ask the director: director plan {timeline_id, style} picks a technique per beat (hook ≤ 1 s, a change every ~2 s, energy rising, CTA last, face-safe, sounds on events) with params from the words and one line of why each; director apply makes it one commit; after render, director fill {render_id} fills the still stretches. director techniques lists what exists and when to use it.";
