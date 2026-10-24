/**
 * Retention (2026-10-24, agent retention): what a viewer's eye gets, measured on the encoded file — when the picture
 * first changes, every stretch where it does not change, how often it changes, and how often a cut lands on a sound.
 * Pure maths here; the ffmpeg half (grey frames, scene cuts, mono PCM) is apps/web/src/server/retention-measure.ts.
 *
 * The detectors are tools/mcp-test/score.py 0.1.1's, constant for constant, so the product and the MVP scorer agree:
 *   - visual-change events: mean absolute difference of consecutive grey frames (135×240, 15 fps); an event is a rise
 *     over an adaptive threshold (median + 3 MAD of the whole file, at least 2.0 grey levels) after ≥ 4 frames
 *     (int(0.33 × 15)) at or under it; merged with the scene cuts, events closer than 0.2 s are one;
 *   - scene cuts: ffmpeg `select='gt(scene,0.3)'`;
 *   - sound hits (audio onsets): RMS energy per 256-sample hop of mono 11025 Hz PCM, a peak rising ≥ 6 dB over the mean
 *     of the previous 8 hops, ≥ 0.10 s apart; a cut is on a hit when an onset lies within ±0.10 s.
 * Gate rules (EXPORT-GATE.md HOOK / DEAD; SHOULD on every piece until the owner decides piece types):
 *   HOOK  the first visual change within 1.0 s;
 *   DEAD  no stretch without a visual change longer than 3.0 s (a stretch inside a marked end card is skipped).
 */
import { formatTime, round } from "./project.ts";
import type { CheckRun, Finding, FixCall, PieceType } from "./types.ts";

export const RETENTION_MEASURER = "retention@1";

/** The bars (seconds). SHOULD, not MUST: the owner has not decided the piece types yet (2026-10-24). */
export const RETENTION_BARS = { hook_s: 1.0, dead_s: 3.0 } as const;

/** score.py's constants (one place). */
export const RETENTION_DETECTOR = {
	fps: 15,
	width: 135,
	height: 240,
	k_mad: 3,
	floor: 2.0,
	quiet_s: 0.33,
	merge_s: 0.2,
	scene: 0.3,
	sample_rate: 11025,
	hop: 256,
	onset_db: 6,
	onset_history: 8,
	onset_gap_s: 0.1,
	hit_window_s: 0.1,
} as const;

export interface RetentionStretch {
	/** Seconds: from the change before (or 0) to the change after (or the end). */
	t: number;
	t_end: number;
	dur: number;
	/**
	 * Share (%) of the stretch's frame changes over the detector's threshold. High = the picture keeps moving (a
	 * composition's own animation, a handheld drift) without a change landing: the detector counts a change only after
	 * ≥ 4 calm frames, so a punch-in inside continuous motion is not counted (MEASURED 2026-10-24, neon-grid ruler: a
	 * 1.15 punch changed the frame by 19.5 grey levels against 2–3 of motion over a 2.0 threshold — no event).
	 */
	moving_pct?: number;
}

export interface RetentionWindow {
	t: number;
	t_end: number;
	events: number;
	per_10s: number;
}

export interface RetentionMap {
	measurer: typeof RETENTION_MEASURER;
	duration_s: number;
	/** The first visual change (s), null when the picture never changes. */
	first_change_s: number | null;
	/** Visual-change events (s), cuts included. */
	events: number[];
	events_per_10s: number;
	cuts: number[];
	cuts_per_10s: number;
	onsets_per_10s: number | null;
	cuts_on_hit: number | null;
	cuts_on_hit_pct: number | null;
	/** Share of the timeline within ±0.10 s of an onset: the % a random cut would land on a hit. */
	on_hit_chance_pct: number | null;
	/** Every stretch between changes, the opening (0 → first) and the tail (last → end) included. */
	stretches: RetentionStretch[];
	longest: RetentionStretch | null;
	/** Stretches longer than the DEAD bar. */
	over_bar: RetentionStretch[];
	/** Events per 10 s in consecutive 10 s windows (the last one shorter). */
	windows: RetentionWindow[];
	detector: { threshold: number; median: number; mad: number; diff_events: number; frames: number };
}

function median(values: ArrayLike<number>): number {
	const n = values.length;
	if (!n) return 0;
	const s = Array.from(values).sort((a, b) => a - b);
	const m = n >> 1;
	return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Visual-change events from per-frame diffs (diffs[i] = change from frame i to frame i + 1, at `fps`), merged with
 * scene cuts. score.py `visual_events`.
 */
export function visualEvents(diffs: ArrayLike<number>, cuts: number[], fps: number = RETENTION_DETECTOR.fps) {
	const med = median(diffs);
	const dev: number[] = [];
	for (let i = 0; i < diffs.length; i++) dev.push(Math.abs(diffs[i] - med));
	const mad = median(dev);
	const thr = Math.max(RETENTION_DETECTOR.floor, med + RETENTION_DETECTOR.k_mad * mad);
	const quiet = Math.floor(RETENTION_DETECTOR.quiet_s * fps);
	const ev: number[] = [];
	for (let i = 0; i < diffs.length; i++) {
		if (!(diffs[i] > thr)) continue;
		let calm = true;
		if (i > 0) {
			let max = Number.NEGATIVE_INFINITY;
			for (let j = Math.max(0, i - quiet); j < i; j++) if (diffs[j] > max) max = diffs[j];
			calm = max <= thr;
		}
		if (calm) ev.push(round((i + 1) / fps, 3));
	}
	const merged: number[] = [];
	for (const t of [...ev, ...cuts].sort((a, b) => a - b)) {
		if (!merged.length || t - merged[merged.length - 1] > RETENTION_DETECTOR.merge_s) merged.push(t);
	}
	return { events: merged, detector: { threshold: round(thr, 2), median: round(med, 2), mad: round(mad, 2), diff_events: ev.length, frames: diffs.length + 1 } };
}

/** Every stretch between changes: [0, e0], [e0, e1] … [en, end]. score.py `gaps` (spans rounded to 0.01 s). */
export function stretchesOf(events: number[], duration: number): RetentionStretch[] {
	const pts = [0, ...events, duration];
	const out: RetentionStretch[] = [];
	for (let i = 0; i + 1 < pts.length; i++) {
		const t = round(pts[i], 2);
		const t_end = round(pts[i + 1], 2);
		out.push({ t, t_end, dur: round(t_end - t, 2) });
	}
	return out;
}

/** Audio onsets (s) from mono 16-bit PCM. score.py `audio_onsets`. */
export function audioOnsets(pcm: ArrayLike<number>, sampleRate: number = RETENTION_DETECTOR.sample_rate, hop: number = RETENTION_DETECTOR.hop): number[] {
	const n = Math.floor((pcm.length - hop) / hop);
	if (n <= 9) return [];
	const energy = new Float64Array(n);
	for (let k = 0; k < n; k++) {
		let sum = 0;
		for (let i = k * hop; i < (k + 1) * hop; i++) sum += pcm[i] * pcm[i];
		energy[k] = 10 * Math.log10(sum / hop + 1e-9);
	}
	const H = RETENTION_DETECTOR.onset_history;
	const strength = new Float64Array(n);
	for (let k = H; k < n; k++) {
		let mean = 0;
		for (let j = k - H; j < k; j++) mean += energy[j];
		strength[k] = Math.max(0, energy[k] - mean / H);
	}
	const out: number[] = [];
	let last = -1;
	for (let k = 1; k < n - 1; k++) {
		if (strength[k] >= RETENTION_DETECTOR.onset_db && strength[k] >= strength[k - 1] && strength[k] >= strength[k + 1]) {
			const t = (k * hop) / sampleRate;
			if (t - last >= RETENTION_DETECTOR.onset_gap_s) {
				out.push(round(t, 3));
				last = t;
			}
		}
	}
	return out;
}

/** How many cuts land within ±w of an onset, as a % of the cuts, and the chance %. score.py `on_hit`. */
export function cutsOnHit(cuts: number[], onsets: number[], duration: number, w: number = RETENTION_DETECTOR.hit_window_s) {
	const hits = cuts.filter((c) => onsets.some((o) => Math.abs(c - o) <= w)).length;
	const step = 0.01;
	const grid = Math.floor(duration / step);
	const so = [...onsets].sort((a, b) => a - b);
	let covered = 0;
	let j = 0;
	for (let i = 0; i < grid; i++) {
		const g = i * step;
		while (j < so.length && so[j] < g - w) j++;
		if (j < so.length && Math.abs(so[j] - g) <= w) covered++;
	}
	return { hits, pct: round((100 * hits) / Math.max(1, cuts.length), 1), chance: round((100 * covered) / Math.max(1, grid), 1) };
}

/** Events per 10 s in consecutive windows of `size` seconds. */
export function eventWindows(events: number[], duration: number, size = 10): RetentionWindow[] {
	const out: RetentionWindow[] = [];
	for (let t = 0; t < duration - 1e-9; t += size) {
		const t_end = Math.min(duration, t + size);
		const n = events.filter((e) => e >= t && e < t_end).length;
		out.push({ t: round(t, 2), t_end: round(t_end, 2), events: n, per_10s: round((10 * n) / Math.max(0.01, t_end - t), 2) });
	}
	return out;
}

/** Events per 10 s inside [a, b] (a span of the timeline). */
export function eventsPer10s(map: Pick<RetentionMap, "events">, a: number, b: number): number {
	const n = map.events.filter((t) => a <= t && t <= b).length;
	return round((10 * n) / Math.max(0.01, b - a), 2);
}

/** The whole map from what ffmpeg gave. `onsets` null = the file has no audio. */
export function retentionMap(input: { duration: number; diffs: ArrayLike<number>; cuts: number[]; onsets: number[] | null; fps?: number; deadBar?: number }): RetentionMap {
	const duration = round(input.duration, 2);
	const fps = input.fps ?? RETENTION_DETECTOR.fps;
	const { events, detector } = visualEvents(input.diffs, input.cuts, fps);
	const stretches = stretchesOf(events, duration);
	for (const s of stretches) {
		let n = 0;
		let over = 0;
		for (let i = Math.max(0, Math.ceil(s.t * fps)); i < input.diffs.length && (i + 1) / fps < s.t_end - 1e-9; i++) {
			n++;
			if (input.diffs[i] > detector.threshold) over++;
		}
		s.moving_pct = n ? round((100 * over) / n, 0) : 0;
	}
	const longest = stretches.reduce<RetentionStretch | null>((best, s) => (!best || s.dur > best.dur ? s : best), null);
	const bar = input.deadBar ?? RETENTION_BARS.dead_s;
	const hit = input.onsets ? cutsOnHit(input.cuts, input.onsets, duration) : null;
	return {
		measurer: RETENTION_MEASURER,
		duration_s: duration,
		first_change_s: events.length ? round(events[0], 2) : null,
		events,
		events_per_10s: round((10 * events.length) / Math.max(0.01, duration), 2),
		cuts: input.cuts,
		cuts_per_10s: round((10 * input.cuts.length) / Math.max(0.01, duration), 2),
		onsets_per_10s: input.onsets ? round((10 * input.onsets.length) / Math.max(0.01, duration), 1) : null,
		cuts_on_hit: hit ? hit.hits : null,
		cuts_on_hit_pct: hit ? hit.pct : null,
		on_hit_chance_pct: hit ? hit.chance : null,
		stretches,
		longest,
		over_bar: stretches.filter((s) => s.dur > bar + 1e-9),
		windows: eventWindows(events, duration),
		detector,
	};
}

// ─── the gate rules ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RetentionRuleOptions {
	source?: string;
	commit?: string | null;
	file?: string;
	piece?: PieceType;
	/** A marked end card [t, t_end] (seconds): a stretch that starts inside it is skipped by DEAD. */
	endCard?: { t: number; t_end: number; why: string } | null;
	/** The exact call that fixes both rules (the server fills it: retention fix on this timeline / render). */
	fixCall?: FixCall | null;
	bars?: { hook_s?: number; dead_s?: number };
}

export const RETENTION_CHECKS = ["HOOK", "DEAD"] as const;

/**
 * HOOK and DEAD findings from a measured map. Both SHOULD. A stretch from 0 that HOOK already reports is not reported
 * again by DEAD; a stretch that starts inside the marked end card is skipped (said in `skipped`).
 */
export function retentionFindings(map: RetentionMap | null, opts: RetentionRuleOptions = {}): CheckRun {
	if (!map) return { findings: [], ran: [], not_run: [], skipped: [{ rule: "HOOK", why: "the file's picture changes were not measured" }, { rule: "DEAD", why: "the file's picture changes were not measured" }] };
	const hookBar = opts.bars?.hook_s ?? RETENTION_BARS.hook_s;
	const deadBar = opts.bars?.dead_s ?? RETENTION_BARS.dead_s;
	const base = {
		status: "open" as const,
		evidence: "MEASURED" as const,
		source: opts.source ?? "restorffcut-gate",
		commit: opts.commit ?? null,
		element_id: null,
		track: null,
		...(opts.file ? { file: opts.file } : {}),
	};
	const findings: Finding[] = [];
	const skipped: CheckRun["skipped"] = [];
	const first = map.first_change_s;
	const hookLate = first === null || first > hookBar + 1e-9;
	if (hookLate) {
		const until = first ?? map.duration_s;
		findings.push({
			...base,
			id: "gate-HOOK-file",
			rule: "HOOK",
			severity: "should",
			t: 0,
			t_end: round(until, 2),
			measure: { first_change_s: first, bar_s: hookBar },
			target: `the picture changes within ${hookBar.toFixed(1)} s (a cut, a punch-in, a word or an effect landing)`,
			message:
				first === null
					? "Nothing on screen changes in the whole file: there is no hook."
					: `The first visual change is at ${first.toFixed(2)} s: nothing moves the picture in the first ${hookBar.toFixed(1)} s, where the viewer decides to stay.`,
			fix: "open on a move in the first second: a punch-in on the first spoken word, a word pop or an effect on it (retention fix does it)",
			fix_call: opts.fixCall ?? null,
		});
	}
	for (const s of map.stretches) {
		if (s.dur <= deadBar + 1e-9) continue;
		if (s.t === 0 && hookLate) {
			skipped.push({ rule: "DEAD", why: `the opening stretch 0–${s.t_end.toFixed(2)} s is reported once, as HOOK` });
			continue;
		}
		const end = opts.endCard;
		if (end && s.t >= end.t - 0.05 && s.t_end >= map.duration_s - 0.05) {
			skipped.push({ rule: "DEAD", why: `${s.t.toFixed(2)}–${s.t_end.toFixed(2)} s is the marked end card (${end.why})` });
			continue;
		}
		findings.push({
			...base,
			id: `gate-DEAD-file${Math.round(s.t * 100)}`,
			rule: "DEAD",
			severity: "should",
			t: s.t,
			t_end: s.t_end,
			measure: { still_s: s.dur, bar_s: deadBar, ...(s.moving_pct !== undefined ? { moving_pct: s.moving_pct } : {}) },
			target: `no stretch longer than ${deadBar.toFixed(1)} s without a visual change (pattern interrupts)`,
			message:
				(s.moving_pct ?? 0) >= 50
					? `No change lands for ${s.dur.toFixed(2)} s, ${formatTime(s.t)}–${formatTime(s.t_end)}: the picture keeps drifting (${s.moving_pct} % of frames move a little) but nothing new arrives — it reads as one long shot.`
					: `Nothing changes on screen for ${s.dur.toFixed(2)} s, ${formatTime(s.t)}–${formatTime(s.t_end)}: a dead stretch where viewers scroll away.`,
			fix:
				(s.moving_pct ?? 0) >= 50
					? "cut inside it (a b-roll cut, a new scene) or let the motion settle before a move: a punch-in in constant motion is not counted as a change (retention fix places punches; a cut is surer here)"
					: "put a pattern interrupt every ~2 s inside it: a punch-in on a spoken word, a b-roll cut, a word pop or an effect on a word (retention fix fills it)",
			fix_call: opts.fixCall ?? null,
		});
	}
	return { findings, ran: ["HOOK", "DEAD"], not_run: [], skipped };
}
