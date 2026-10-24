/**
 * Seconds <-> ticks, ported exactly from the editor's Rust time crate (shipped as the npm package `restorffcut-wasm`):
 * rust/crates/time/src/media_time.rs and frame_rate.rs. Pure TypeScript so the reducer needs no wasm.
 */
import type { FrameRate, Ticks } from "./model.ts";

/** media_time.rs:10 — `pub const TICKS_PER_SECOND: i64 = 120_000;` */
export const TICKS_PER_SECOND = 120_000;

/** Rust `f64::round`: half away from zero; and never `-0` (media-time.ts:69 roundMediaTime). */
export function roundHalfAwayFromZero(value: number): number {
	const magnitude = Math.round(Math.abs(value));
	if (magnitude === 0) return 0;
	// Math.round on the magnitude rounds .5 up, i.e. away from zero once the sign is put back.
	return value < 0 ? -magnitude : magnitude;
}

/**
 * Exactly `MediaTime::from_seconds_f64` (media_time.rs:30): `(seconds * 120000).round()`, `None` for non-finite.
 * Throws instead of returning None.
 */
export function secondsToTicks(seconds: number): Ticks {
	if (!Number.isFinite(seconds)) {
		throw new Error(`secondsToTicks: not a finite number of seconds: ${seconds}`);
	}
	return roundHalfAwayFromZero(seconds * TICKS_PER_SECOND);
}

/** media_time.rs:39 — `ticks / 120000.0`. */
export function ticksToSeconds(ticks: Ticks): number {
	return ticks / TICKS_PER_SECOND;
}

/** frame_rate.rs ticks_per_frame: null when the rate is invalid or does not divide the tick rate exactly. */
export function ticksPerFrame(rate: FrameRate): number | null {
	if (!(rate.numerator > 0) || !(rate.denominator > 0)) return null;
	const tickNumerator = TICKS_PER_SECOND * rate.denominator;
	if (tickNumerator % rate.numerator !== 0) return null;
	return tickNumerator / rate.numerator;
}

function divEuclid(a: number, b: number): number {
	const q = Math.trunc(a / b);
	return a - q * b < 0 ? (b > 0 ? q - 1 : q + 1) : q;
}

function remEuclid(a: number, b: number): number {
	const r = a % b;
	return r < 0 ? r + Math.abs(b) : r;
}

/** media_time.rs:48 to_frame_round: halves round up (toward +inf). */
export function ticksToFrameRound(ticks: Ticks, rate: FrameRate): number | null {
	const tpf = ticksPerFrame(rate);
	if (tpf === null) return null;
	const remainder = remEuclid(ticks, tpf);
	const floor = divEuclid(ticks, tpf);
	return remainder * 2 >= tpf ? floor + 1 : floor;
}

/** media_time.rs:64 round_to_frame; falls back to the input when the rate is unsupported (media-time.ts:172). */
export function roundTicksToFrame(ticks: Ticks, rate: FrameRate): Ticks {
	const tpf = ticksPerFrame(rate);
	const frame = ticksToFrameRound(ticks, rate);
	if (tpf === null || frame === null) return ticks;
	const result = frame * tpf;
	return result === 0 ? 0 : result;
}

const STANDARD_FRAME_RATES: Array<{ value: number; rate: FrameRate }> = [
	{ value: 24_000 / 1_001, rate: { numerator: 24_000, denominator: 1_001 } },
	{ value: 24, rate: { numerator: 24, denominator: 1 } },
	{ value: 25, rate: { numerator: 25, denominator: 1 } },
	{ value: 30_000 / 1_001, rate: { numerator: 30_000, denominator: 1_001 } },
	{ value: 30, rate: { numerator: 30, denominator: 1 } },
	{ value: 48, rate: { numerator: 48, denominator: 1 } },
	{ value: 50, rate: { numerator: 50, denominator: 1 } },
	{ value: 60_000 / 1_001, rate: { numerator: 60_000, denominator: 1_001 } },
	{ value: 60, rate: { numerator: 60, denominator: 1 } },
	{ value: 120, rate: { numerator: 120, denominator: 1 } },
];

function gcd(left: number, right: number): number {
	let a = Math.abs(left);
	let b = Math.abs(right);
	while (b !== 0) {
		const t = b;
		b = a % b;
		a = t;
	}
	return a;
}

/** Port of apps/web/src/fps/utils.ts floatToFrameRate (tolerance 0.01 to the standard rates). */
export function floatToFrameRate(fps: number): FrameRate {
	const standard = STANDARD_FRAME_RATES.find((candidate) => Math.abs(fps - candidate.value) <= 0.01);
	if (standard) return { ...standard.rate };
	if (Number.isInteger(fps)) return { numerator: fps, denominator: 1 };
	const scaledNumerator = Math.round(fps * 1_000_000);
	const divisor = gcd(scaledNumerator, 1_000_000);
	return { numerator: scaledNumerator / divisor, denominator: 1_000_000 / divisor };
}

export function frameRateToFloat(rate: FrameRate): number {
	return rate.numerator / rate.denominator;
}
