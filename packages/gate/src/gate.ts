/**
 * Putting the two halves together: pin file findings to the timeline, merge duplicates (same rule within ±0.5 s),
 * apply the owner's overrides (D13), compute the gate state, rank worst first.
 *
 * D13 (plan/DECISIONS.md, answered by the owner 2026-10-20): a failed MUST may be overridden only by the project
 * owner, with a written reason; CLAIM (claims) can never be overridden; Claude can never override.
 */
import { baseRuns } from "./changes.ts";
import { pickScene, shotAt, shotMap, sounds, textElements, isCaption, elStart, elEnd, trackForVideo, fpsOf, type Shot } from "./project.ts";
import { laneOf } from "./timeline.ts";
import type { CheckRun, CompositionFacts, Finding, FindingTrack, GateOverride, GateProject, GateReport, GateState, GateTrack, MediaInfo } from "./types.ts";

/** Rules no one may override (D13: claims are a veto). */
export const NEVER_OVERRIDE = new Set(["CLAIM"]);

export const MIN_REASON_CHARS = 12;

const SEVERITY_RANK = { must: 0, should: 1, info: 2 } as const;

/**
 * Fill track + element_id (+ the real lane: track_id, track_name) for findings measured on a file (EXPORT-GATE §3
 * "Pinning"). With `facts` (media alpha, composition facts) a video finding is pinned to the BASE picture — the
 * top-most element that covers the frame — not to a transparent overlay above it (a paper texture, a TOC).
 */
export function pinFindings(
	findings: Finding[],
	project: GateProject,
	sceneId?: string,
	facts: { media?: Record<string, MediaInfo>; compositions?: Record<string, CompositionFacts> } = {},
): Finding[] {
	const scene = pickScene(project, sceneId);
	if (!scene) return findings;
	const map = shotMap(scene);
	const base = baseRuns(scene, map.runtime, { fps: fpsOf(project) || 30, beats: false, media: facts.media, compositions: facts.compositions });
	const baseAt = (t: number): Shot | null => {
		const r = base.find((x) => x.t <= t && t < x.t_end) ?? null;
		return r ? { t: r.t, t_end: r.t_end, el: r.el, track: r.track, isMain: r.isMain } : shotAt(map, t);
	};
	const lane = (track: GateTrack | null | undefined, el: Parameters<typeof laneOf>[1], isMain: boolean) => laneOf(track, el, isMain);
	return findings.map((f) => {
		if (f.track && f.element_id && f.track_name !== undefined) return f;
		let track: FindingTrack = f.track;
		let element_id = f.element_id;
		let real: { track_id: string | null; track_name: string | null } | null = null;
		switch (f.rule) {
			case "LOUD":
			case "FORMAT":
				track = "MASTER";
				real = { track_id: null, track_name: "MASTER" };
				break;
			case "MIX":
			case "R12":
			case "R21":
			case "R22": {
				track = "MUSIC";
				const s = sounds(scene).find((x) => x.role === "music" && x.t <= f.t && f.t < x.t_end);
				element_id ??= s?.el.id ?? null;
				if (s) real = lane(s.track, s.el, false);
				break;
			}
			case "R4":
			case "R23":
				track = "SFX";
				break;
			case "CAP":
			case "CAP-LEN":
			case "R18":
			case "R3":
			case "R15":
			case "SAFE": {
				const hit = textElements(scene).find(({ el }) => elStart(el) <= f.t && f.t < elEnd(el));
				track = track ?? (hit && isCaption(hit.track, hit.el) ? "CAPTIONS" : "TEXT");
				element_id ??= hit?.el.id ?? null;
				if (hit) real = lane(hit.track, hit.el, false);
				break;
			}
			default: {
				const s = baseAt(f.t);
				if (s) {
					track = track ?? trackForVideo(s.isMain);
					element_id ??= s.el.id;
					real = lane(s.track, s.el, s.isMain);
				}
			}
		}
		return {
			...f,
			track,
			element_id,
			track_id: f.track_id ?? real?.track_id ?? null,
			track_name: f.track_name ?? real?.track_name ?? (track ?? null),
		};
	});
}

/** Same rule within ±0.5 s → one finding (the worse severity; the timeline's element wins; measures merged). */
export function mergeFindings(...lists: Finding[][]): Finding[] {
	const out: Finding[] = [];
	for (const f of lists.flat()) {
		const twin = out.find(
			(g) =>
				g.rule === f.rule &&
				Math.abs(g.t - f.t) <= 0.5 &&
				(g.t_end === null || f.t_end === null || Math.abs(g.t_end - f.t_end) <= 0.5 || g.rule === "LOUD") &&
				g.evidence !== f.evidence,
		);
		if (!twin) {
			out.push({ ...f });
			continue;
		}
		if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[twin.severity]) {
			twin.severity = f.severity;
			twin.message = f.message;
		}
		twin.element_id ??= f.element_id;
		twin.track ??= f.track;
		twin.track_id ??= f.track_id;
		twin.track_name ??= f.track_name;
		twin.fix_call ??= f.fix_call;
		twin.measure = { ...(f.measure ?? {}), ...(twin.measure ?? {}) };
		twin.file ??= f.file;
		// a timeline twin is exact: a measured candidate merged with it is confirmed by it
		if (twin.status === "candidate" && f.evidence === "TIMELINE") twin.status = "open";
	}
	return out;
}

export function sortFindings(findings: Finding[]): Finding[] {
	return [...findings].sort((a, b) => {
		const open = (f: Finding) => (f.status === "dismissed" || f.status === "fixed" ? 1 : 0);
		return open(a) - open(b) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.t - b.t;
	});
}

export function isBlocking(f: Finding): boolean {
	return f.severity === "must" && (f.status === "open" || f.status === "candidate");
}

export function overrideMatches(o: GateOverride, f: { rule: string; t: number; id?: string }): boolean {
	if (o.rule !== f.rule) return false;
	if (o.finding_id && f.id && o.finding_id === f.id) return true;
	if (o.t === null || o.t === undefined) return true;
	return Math.abs(o.t - f.t) <= 0.5;
}

export class OverrideError extends Error {}

/**
 * Validate an override before it is recorded. Throws OverrideError with the reason in plain words.
 * `isOwner` is the caller's verdict on who `by` is (until real sign-in, the local user is the owner).
 */
export function validateOverride(o: GateOverride, isOwner: boolean): GateOverride {
	if (NEVER_OVERRIDE.has(o.rule)) throw new OverrideError(`${o.rule} can never be overridden (D13: claims are a veto).`);
	if (/^claude|^judge|^worker|^compiler|^gate:/i.test(o.by)) {
		throw new OverrideError("Claude and the judges can never override the gate (D13); only the project owner can.");
	}
	if (!isOwner) throw new OverrideError("Only the project owner may override a MUST (D13).");
	const reason = (o.reason ?? "").trim();
	if (reason.length < MIN_REASON_CHARS) {
		throw new OverrideError(`Write why this ships anyway (at least ${MIN_REASON_CHARS} characters).`);
	}
	return { ...o, reason };
}

/** Mark overridden musts as dismissed (they stop blocking) and return which overrides were used. */
export function applyOverrides(
	findings: Finding[],
	overrides: GateOverride[],
): { findings: Finding[]; applied: GateOverride[] } {
	const valid = overrides.filter((o) => !NEVER_OVERRIDE.has(o.rule) && !/^claude/i.test(o.by) && o.reason?.trim());
	const applied = new Set<GateOverride>();
	const out = findings.map((f) => {
		if (f.severity !== "must" || !isBlocking(f)) return f;
		const o = valid.find((v) => overrideMatches(v, f));
		if (!o) return f;
		applied.add(o);
		return { ...f, status: "dismissed" as const, dismissed_reason: o.reason, resolved_by: o.by };
	});
	return { findings: out, applied: [...applied] };
}

/** Combine runs into a report: state BLOCKED > INCOMPLETE > PASS (EXPORT-GATE §2 "The gate's state"). */
export function buildReport(runs: CheckRun[], overrides: GateOverride[] = []): GateReport {
	const merged = mergeFindings(...runs.map((r) => r.findings));
	const { findings, applied } = applyOverrides(merged, overrides);
	const ran = [...new Set(runs.flatMap((r) => r.ran))];
	// A check with two halves (CLEAN, FORMAT) is incomplete while either half did not run.
	const notRunAll = runs
		.flatMap((r) => r.not_run)
		.filter((n, i, all) => all.findIndex((m) => m.rule === n.rule && m.why === n.why) === i);
	// A not-run check can be waived only by an owner override for that rule (t = null).
	const not_run = notRunAll.filter((n) => {
		const o = overrides.find((v) => v.rule === n.rule && (v.t === null || v.t === undefined) && v.reason?.trim());
		if (o && !NEVER_OVERRIDE.has(n.rule)) {
			if (!applied.includes(o)) applied.push(o);
			return false;
		}
		return true;
	});
	const skipped = runs.flatMap((r) => r.skipped);
	const sorted = sortFindings(findings);
	const blocking = sorted.filter(isBlocking);
	const state: GateState = blocking.length ? "BLOCKED" : not_run.length ? "INCOMPLETE" : "PASS";
	const open = sorted.filter((f) => f.status !== "dismissed" && f.status !== "fixed");
	const piece = runs.find((r) => r.piece)?.piece;
	const changes = runs.find((r) => r.changes)?.changes;
	// a rule ran when any half ran it; it is "skipped" only when no half ran it
	const skippedOnly = skipped.filter((s, i, all) => !ran.includes(s.rule) && all.findIndex((x) => x.rule === s.rule) === i);
	return {
		state,
		findings: sorted,
		ran,
		not_run,
		skipped: skippedOnly,
		...(piece ? { piece } : {}),
		...(changes ? { changes } : {}),
		blocking,
		applied_overrides: applied,
		counts: {
			must: open.filter((f) => f.severity === "must").length,
			should: open.filter((f) => f.severity === "should").length,
			info: open.filter((f) => f.severity === "info").length,
		},
	};
}

/**
 * Findings from an earlier run that are gone now → status "fixed" (set by the re-measure, never by hand;
 * EXPORT-GATE §3.4). Matched by rule within ±0.5 s.
 */
export function fixedSince(previous: Finding[], current: Finding[]): Finding[] {
	return previous
		.filter((p) => p.status !== "fixed" && !current.some((c) => c.rule === p.rule && Math.abs(c.t - p.t) <= 0.5))
		.map((p) => ({ ...p, status: "fixed" as const, resolved_by: "re-measure" }));
}

/**
 * finding@1 strictly per the canonical schema (evidence TIMELINE → READ; the gate-v2 additions track_id, track_name
 * and fix_call dropped: the schema has additionalProperties false).
 */
export function toSchemaFinding(f: Finding): Finding {
	const { track_id: _id, track_name: _name, fix_call: _call, ...rest } = f;
	return { ...rest, evidence: f.evidence === "TIMELINE" ? "READ" : f.evidence };
}
