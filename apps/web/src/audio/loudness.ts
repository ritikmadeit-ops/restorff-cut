/**
 * Loudness to ITU-R BS.1770-4 / EBU R128, in plain TypeScript (no Web Audio), so the same
 * code measures in the browser, in Bun and in Node.
 *
 * - K-weighting: the two BS.1770 biquads, derived for any sample rate (the formulas
 *   libebur128 uses), applied per channel.
 * - Integrated loudness: 400 ms blocks, 75 % overlap, absolute gate −70 LUFS, relative gate
 *   −10 LU; channel weights 1.0 (L, R, C; we export stereo).
 * - Loudness range (EBU 3342): 3 s short-term blocks, gate −20 LU, P95 − P10.
 * - True peak: 4× oversampling with a 12-tap-per-phase Hann-windowed sinc interpolator.
 *
 * OpenCut-AI's "LUFS" (use-loudness-normalization.ts) had none of this (no K-weighting,
 * sample peak, first channel only, clips concatenated instead of mixed) — not ported.
 */

export interface LoudnessMeasurement {
	/** Integrated loudness, LUFS (−Infinity for silence). */
	integratedLufs: number;
	/** Highest short-term (3 s) loudness, LUFS. */
	shortTermMaxLufs: number;
	/** Loudness range, LU. */
	loudnessRangeLu: number;
	/** True peak, dBTP. */
	truePeakDb: number;
	/** Sample peak, dBFS. */
	samplePeakDb: number;
	durationSeconds: number;
}

export interface LoudnessTargetSpec {
	integratedLufs: number;
	truePeakDb: number;
}

const ABSOLUTE_GATE = -70;

function dbToGain(db: number): number {
	return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
	return gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY;
}

interface Biquad {
	b0: number;
	b1: number;
	b2: number;
	a1: number;
	a2: number;
}

function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
	// Stage 1: high shelf (+4 dB above ~1.7 kHz).
	let f0 = 1681.974450955533;
	const gainDb = 3.999843853973347;
	let q = 0.7071752369554196;
	let k = Math.tan((Math.PI * f0) / sampleRate);
	const vh = 10 ** (gainDb / 20);
	const vb = vh ** 0.4996667741545416;
	let a0 = 1 + k / q + k * k;
	const shelf: Biquad = {
		b0: (vh + (vb * k) / q + k * k) / a0,
		b1: (2 * (k * k - vh)) / a0,
		b2: (vh - (vb * k) / q + k * k) / a0,
		a1: (2 * (k * k - 1)) / a0,
		a2: (1 - k / q + k * k) / a0,
	};
	// Stage 2: RLB high-pass (~38 Hz).
	f0 = 38.13547087602444;
	q = 0.5003270373238773;
	k = Math.tan((Math.PI * f0) / sampleRate);
	a0 = 1 + k / q + k * k;
	const highPass: Biquad = {
		b0: 1,
		b1: -2,
		b2: 1,
		a1: (2 * (k * k - 1)) / a0,
		a2: (1 - k / q + k * k) / a0,
	};
	return [shelf, highPass];
}

function filterChannel(samples: Float32Array, stages: Biquad[]): Float64Array {
	const out = new Float64Array(samples.length);
	for (let i = 0; i < samples.length; i++) out[i] = samples[i];
	for (const stage of stages) {
		let x1 = 0;
		let x2 = 0;
		let y1 = 0;
		let y2 = 0;
		for (let i = 0; i < out.length; i++) {
			const x = out[i];
			const y = stage.b0 * x + stage.b1 * x1 + stage.b2 * x2 - stage.a1 * y1 - stage.a2 * y2;
			x2 = x1;
			x1 = x;
			y2 = y1;
			y1 = y;
			out[i] = y;
		}
	}
	return out;
}

function hopEnergies(channels: Float32Array[], sampleRate: number): { perHop: Float64Array; hopSize: number } {
	const hopSize = Math.round(sampleRate * 0.1);
	const stages = kWeightingFilters(sampleRate);
	const count = channels.length ? Math.floor(channels[0].length / hopSize) : 0;
	const perHop = new Float64Array(count);
	for (const samples of channels) {
		const weighted = filterChannel(samples, stages);
		for (let h = 0; h < count; h++) {
			let sum = 0;
			const start = h * hopSize;
			for (let i = start; i < start + hopSize; i++) sum += weighted[i] * weighted[i];
			// Channel weight G = 1 for L/R/C.
			perHop[h] += sum;
		}
	}
	return { perHop, hopSize };
}

function blockLoudness(perHop: Float64Array, hopSize: number, hopsPerBlock: number): number[] {
	const blocks: number[] = [];
	for (let start = 0; start + hopsPerBlock <= perHop.length; start++) {
		let sum = 0;
		for (let h = start; h < start + hopsPerBlock; h++) sum += perHop[h];
		const meanSquare = sum / (hopSize * hopsPerBlock);
		blocks.push(meanSquare);
	}
	return blocks;
}

function powerToLufs(power: number): number {
	return power > 0 ? -0.691 + 10 * Math.log10(power) : Number.NEGATIVE_INFINITY;
}

function gatedIntegrated(blocks: number[], relativeGateLu: number): number {
	const absolute = blocks.filter((power) => powerToLufs(power) > ABSOLUTE_GATE);
	if (absolute.length === 0) return Number.NEGATIVE_INFINITY;
	const ungated = absolute.reduce((sum, power) => sum + power, 0) / absolute.length;
	const relativeGate = powerToLufs(ungated) + relativeGateLu;
	const relative = absolute.filter((power) => powerToLufs(power) > relativeGate);
	if (relative.length === 0) return Number.NEGATIVE_INFINITY;
	return powerToLufs(relative.reduce((sum, power) => sum + power, 0) / relative.length);
}

function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
	return sorted[index];
}

const TRUE_PEAK_TAPS = 12;
const TRUE_PEAK_PHASES = 4;

/** Phase filters for 4× interpolation (phase 0 is the sample itself). */
const TRUE_PEAK_FILTERS: Float64Array[] = (() => {
	const filters: Float64Array[] = [];
	const half = TRUE_PEAK_TAPS / 2;
	for (let phase = 1; phase < TRUE_PEAK_PHASES; phase++) {
		const fraction = phase / TRUE_PEAK_PHASES;
		const taps = new Float64Array(TRUE_PEAK_TAPS);
		let sum = 0;
		for (let j = 0; j < TRUE_PEAK_TAPS; j++) {
			// Neighbour k = m - half + 1 + j; distance from t = m + fraction.
			const distance = fraction - (j - half + 1);
			const sinc = distance === 0 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance);
			const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / half);
			taps[j] = sinc * window;
			sum += taps[j];
		}
		for (let j = 0; j < TRUE_PEAK_TAPS; j++) taps[j] /= sum;
		filters.push(taps);
	}
	return filters;
})();

/** Largest |value| between sample m and m+1 (inclusive of m), 4× oversampled. */
function truePeakAt(samples: ArrayLike<number>, m: number): number {
	let peak = Math.abs(samples[m]);
	const half = TRUE_PEAK_TAPS / 2;
	for (const taps of TRUE_PEAK_FILTERS) {
		let value = 0;
		for (let j = 0; j < TRUE_PEAK_TAPS; j++) {
			const k = m - half + 1 + j;
			if (k >= 0 && k < samples.length) value += samples[k] * taps[j];
		}
		peak = Math.max(peak, Math.abs(value));
	}
	return peak;
}

export function measureTruePeak(channels: Float32Array[]): number {
	let peak = 0;
	for (const samples of channels) {
		for (let m = 0; m < samples.length; m++) {
			// Cheap pre-check: an interpolated peak cannot exceed ~1.6× the local sample peak.
			const local = Math.max(Math.abs(samples[m]), m + 1 < samples.length ? Math.abs(samples[m + 1]) : 0);
			if (local * 1.6 <= peak) continue;
			peak = Math.max(peak, truePeakAt(samples, m));
		}
	}
	return peak;
}

export function measureLoudness(channels: Float32Array[], sampleRate: number): LoudnessMeasurement {
	const { perHop, hopSize } = hopEnergies(channels, sampleRate);
	const momentaryBlocks = blockLoudness(perHop, hopSize, 4);
	const shortTermBlocks = blockLoudness(perHop, hopSize, 30);
	const integratedLufs = gatedIntegrated(momentaryBlocks, -10);

	const shortTermLoudness = shortTermBlocks.map(powerToLufs);
	const shortTermMaxLufs = shortTermLoudness.length
		? Math.max(...shortTermLoudness)
		: powerToLufs(momentaryBlocks.length ? Math.max(...momentaryBlocks) : 0);
	const absoluteShort = shortTermBlocks.filter((power) => powerToLufs(power) > ABSOLUTE_GATE);
	let loudnessRangeLu = 0;
	if (absoluteShort.length > 0) {
		const mean = absoluteShort.reduce((sum, power) => sum + power, 0) / absoluteShort.length;
		const gate = powerToLufs(mean) - 20;
		const gated = absoluteShort
			.map(powerToLufs)
			.filter((loudness) => loudness > gate)
			.sort((a, b) => a - b);
		loudnessRangeLu = percentile(gated, 0.95) - percentile(gated, 0.1);
	}

	let samplePeak = 0;
	for (const samples of channels) {
		for (let i = 0; i < samples.length; i++) samplePeak = Math.max(samplePeak, Math.abs(samples[i]));
	}
	return {
		integratedLufs,
		shortTermMaxLufs,
		loudnessRangeLu,
		truePeakDb: gainToDb(measureTruePeak(channels)),
		samplePeakDb: gainToDb(samplePeak),
		durationSeconds: channels.length ? channels[0].length / sampleRate : 0,
	};
}

/**
 * True-peak limiter with 1.5 ms look-ahead: gain = moving average of a moving minimum of
 * (ceiling / true peak), so it never lets a true peak through and never clicks; release
 * 80 ms. Works in place.
 */
export function limitTruePeak(channels: Float32Array[], sampleRate: number, ceilingDb: number): number {
	const length = channels.length ? channels[0].length : 0;
	if (length === 0) return 0;
	const ceiling = dbToGain(ceilingDb);
	const required = new Float64Array(length);
	let limitedSamples = 0;
	for (let m = 0; m < length; m++) {
		let peak = 0;
		for (const samples of channels) {
			const local = Math.max(Math.abs(samples[m]), m + 1 < length ? Math.abs(samples[m + 1]) : 0);
			if (local * 1.6 <= ceiling) continue;
			peak = Math.max(peak, truePeakAt(samples, m));
		}
		required[m] = peak > ceiling ? ceiling / peak : 1;
		if (required[m] < 1) limitedSamples++;
	}
	if (limitedSamples === 0) return 0;

	const radius = Math.max(1, Math.round(sampleRate * 0.0015));
	// Moving minimum over [m - radius, m + radius] (monotonic deque).
	const minimum = new Float64Array(length);
	const deque: number[] = [];
	let head = 0;
	for (let i = 0; i < length + radius; i++) {
		if (i < length) {
			while (deque.length > head && required[deque[deque.length - 1]] >= required[i]) deque.pop();
			deque.push(i);
		}
		const centre = i - radius;
		if (centre >= 0) {
			while (deque[head] < centre - radius) head++;
			minimum[centre] = required[deque[head]];
		}
	}
	// Moving average over the same radius keeps gain <= required everywhere.
	const smooth = new Float64Array(length);
	const width = 2 * radius + 1;
	// Clamp at the edges (a 1 there would let a peak in the first/last 1.5 ms through).
	const valueAt = (k: number) => minimum[Math.min(length - 1, Math.max(0, k))];
	let windowSum = 0;
	for (let k = -radius; k <= radius; k++) windowSum += valueAt(k);
	for (let i = 0; i < length; i++) {
		smooth[i] = Math.min(1, windowSum / width);
		windowSum += valueAt(i + radius + 1) - valueAt(i - radius);
	}
	const release = 1 - Math.exp(-1 / (0.08 * sampleRate));
	let gain = 1;
	for (let i = 0; i < length; i++) {
		gain = Math.min(smooth[i], gain + (1 - gain) * release);
		if (gain === 1) continue;
		for (const samples of channels) samples[i] *= gain;
	}
	return limitedSamples;
}

export interface NormalizeReport {
	before: LoudnessMeasurement;
	after: LoudnessMeasurement;
	gainDb: number;
	limitedSamples: number;
	passes: number;
}

/**
 * Brings `channels` to `target` in place: static gain to the integrated target, then the
 * true-peak limiter at `limiterCeilingDb` (defaults to the target's ceiling); repeats up
 * to three times while limiting pulls the loudness more than 0.1 LU under target.
 * Silence is left alone.
 */
export function normalizeLoudness(
	channels: Float32Array[],
	sampleRate: number,
	target: LoudnessTargetSpec,
	limiterCeilingDb = target.truePeakDb,
): NormalizeReport {
	const before = measureLoudness(channels, sampleRate);
	if (!Number.isFinite(before.integratedLufs)) {
		return { before, after: before, gainDb: 0, limitedSamples: 0, passes: 0 };
	}
	let current = before;
	let totalGainDb = 0;
	let limitedSamples = 0;
	let passes = 0;
	for (; passes < 3; passes++) {
		const gainDb = target.integratedLufs - current.integratedLufs;
		if (Math.abs(gainDb) < 0.05 && current.truePeakDb <= limiterCeilingDb + 0.01) break;
		const gain = dbToGain(gainDb);
		for (const samples of channels) for (let i = 0; i < samples.length; i++) samples[i] *= gain;
		totalGainDb += gainDb;
		limitedSamples += limitTruePeak(channels, sampleRate, limiterCeilingDb);
		current = measureLoudness(channels, sampleRate);
		if (current.integratedLufs >= target.integratedLufs - 0.1) {
			passes++;
			break;
		}
	}
	return { before, after: current, gainDb: totalGainDb, limitedSamples, passes };
}
