/**
 * Beat and onset detection for "music to picture" (README: "Snap cuts to beats/hits within
 * one frame"). Pure TypeScript over mono PCM, so it runs in the browser, in a worker, in
 * Bun or in Node.
 *
 * Method (replaces OpenCut-AI's energy-peak picker, which has no tempo model):
 *  1. Onset strength: half-wave-rectified spectral flux of log-compressed magnitudes
 *     (1024-point Hann STFT, hop 256 at 22.05 kHz = 11.6 ms), detrended and normalised.
 *  2. Tempo: autocorrelation of the (slightly smoothed) onset envelope over 60-200 BPM,
 *     weighted by a log-normal prior around 120 BPM (one octave wide), parabolic refinement.
 *  3. Beats: dynamic-programming tracker (Ellis 2007) with tightness 100 - beats prefer
 *     strong onsets but keep a steady period.
 *  4. Each beat is moved onto the attack of the nearest transient within +-35 ms using a
 *     fine (1.5 ms hop) energy-rise envelope, so a cut lands on the hit, not ~10 ms off.
 *  5. Downbeats (bar starts, 4/4 assumed): the beat phase whose beats carry the most
 *     low-band (< 200 Hz) onset energy. Marked "estimated" in the UI.
 * Onsets ("hits") are peak-picked separately (adaptive threshold, 60 ms minimum spacing).
 *
 * Checked 2026-10-20 on synthetic click tracks (92/120/128/150 BPM, 20 s): tempo exact,
 * beats within one frame of the clicks (worklog media.md has the numbers).
 */
import { fftInPlace } from "./fft";

export interface BeatAnalysis {
	bpm: number;
	/** Beat times in seconds (from the start of the analysed audio), ascending. */
	beats: number[];
	/** Onset strength at each beat, 0..1. */
	strengths: number[];
	/** Indices into `beats` that start a bar (estimated). */
	downbeats: number[];
	/** Strong onsets ("hits"), seconds, with strength 0..1. */
	onsets: Array<{ time: number; strength: number }>;
	/** 0..1: how peaked the tempo estimate was. */
	confidence: number;
}

export interface DetectOptions {
	minBpm?: number;
	maxBpm?: number;
	/** Centre of the tempo prior. */
	preferredBpm?: number;
}

const FRAME = 1024;
const HOP = 256;
const TIGHTNESS = 100;
const FINE_HALF_WINDOW = 128;

function hann(size: number): Float64Array {
	const window = new Float64Array(size);
	for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
	return window;
}

/** Spectral-flux onset envelope (full band and low band) at hop HOP, frames centred. */
function onsetEnvelopes(samples: Float32Array, sampleRate: number): { full: Float64Array; low: Float64Array } {
	const window = hann(FRAME);
	const frames = Math.max(1, Math.floor(samples.length / HOP) + 1);
	const bins = FRAME / 2;
	const lowBins = Math.max(2, Math.round((200 / sampleRate) * FRAME));
	const full = new Float64Array(frames);
	const low = new Float64Array(frames);
	const re = new Float64Array(FRAME);
	const im = new Float64Array(FRAME);
	let previous = new Float64Array(bins);
	let current = new Float64Array(bins);
	for (let f = 0; f < frames; f++) {
		const offset = f * HOP - FRAME / 2;
		for (let i = 0; i < FRAME; i++) {
			const index = offset + i;
			re[i] = index >= 0 && index < samples.length ? samples[index] * window[i] : 0;
			im[i] = 0;
		}
		fftInPlace(re, im);
		let sum = 0;
		let lowSum = 0;
		for (let k = 1; k < bins; k++) {
			const magnitude = Math.log1p(100 * Math.hypot(re[k], im[k]));
			current[k] = magnitude;
			const rise = magnitude - previous[k];
			if (rise > 0) {
				sum += rise;
				if (k < lowBins) lowSum += rise;
			}
		}
		full[f] = f === 0 ? 0 : sum;
		low[f] = f === 0 ? 0 : lowSum;
		const swap = previous;
		previous = current;
		current = swap;
	}
	return { full, low };
}

/** Subtract a moving mean (about 0.25 s), rectify, scale to unit standard deviation. */
function normaliseEnvelope(envelope: Float64Array, radius: number): Float64Array {
	const out = new Float64Array(envelope.length);
	let windowSum = 0;
	let count = 0;
	let lo = 0;
	let hi = -1;
	for (let i = 0; i < envelope.length; i++) {
		while (hi < Math.min(envelope.length - 1, i + radius)) {
			hi++;
			windowSum += envelope[hi];
			count++;
		}
		while (lo < i - radius) {
			windowSum -= envelope[lo];
			lo++;
			count--;
		}
		out[i] = Math.max(0, envelope[i] - windowSum / count);
	}
	let mean = 0;
	for (const value of out) mean += value;
	mean /= Math.max(1, out.length);
	let variance = 0;
	for (const value of out) variance += (value - mean) ** 2;
	const std = Math.sqrt(variance / Math.max(1, out.length)) || 1;
	for (let i = 0; i < out.length; i++) out[i] /= std;
	return out;
}

function gaussianSmooth(input: Float64Array, sigma: number): Float64Array {
	const radius = Math.ceil(sigma * 3);
	const out = new Float64Array(input.length);
	for (let i = 0; i < input.length; i++) {
		let sum = 0;
		let weight = 0;
		for (let k = -radius; k <= radius; k++) {
			const j = i + k;
			if (j < 0 || j >= input.length) continue;
			const w = Math.exp(-0.5 * (k / sigma) ** 2);
			sum += input[j] * w;
			weight += w;
		}
		out[i] = sum / weight;
	}
	return out;
}

function estimateTempo(
	input: Float64Array,
	frameRate: number,
	options: Required<DetectOptions>,
): { lag: number; confidence: number } {
	// Widen sharp onset peaks first: with a non-integer true period, one-frame peaks line
	// up better at twice the lag than at the lag itself (a half-tempo error, seen at 150 BPM).
	const envelope = gaussianSmooth(input, 1.5);
	const minLag = Math.max(1, Math.floor((60 * frameRate) / options.maxBpm));
	const maxLag = Math.min(envelope.length - 1, Math.ceil((60 * frameRate) / options.minBpm));
	const scores = new Float64Array(maxLag + 2);
	let best = -1;
	let bestLag = Math.round((60 * frameRate) / options.preferredBpm);
	let total = 0;
	for (let lag = minLag; lag <= maxLag; lag++) {
		let acf = 0;
		for (let i = lag; i < envelope.length; i++) acf += envelope[i] * envelope[i - lag];
		acf /= envelope.length - lag;
		const bpm = (60 * frameRate) / lag;
		const prior = Math.exp(-0.5 * Math.log2(bpm / options.preferredBpm) ** 2);
		scores[lag] = acf * prior;
		total += Math.max(0, scores[lag]);
		if (scores[lag] > best) {
			best = scores[lag];
			bestLag = lag;
		}
	}
	let lag = bestLag;
	if (bestLag > minLag && bestLag < maxLag) {
		const a = scores[bestLag - 1];
		const b = scores[bestLag];
		const c = scores[bestLag + 1];
		const denominator = a - 2 * b + c;
		if (denominator < 0) lag = bestLag + (0.5 * (a - c)) / denominator;
	}
	const mean = total / Math.max(1, maxLag - minLag + 1);
	const confidence = best > 0 ? Math.max(0, Math.min(1, 1 - mean / best)) : 0;
	return { lag, confidence };
}

function trackBeats(envelope: Float64Array, period: number): number[] {
	const n = envelope.length;
	if (n === 0 || !(period > 1)) return [];
	// Smooth the onsets with a Gaussian about period/32 wide (as the reference tracker does).
	const radius = Math.max(1, Math.round(period));
	const kernel: number[] = [];
	for (let i = -radius; i <= radius; i++) kernel.push(Math.exp(-0.5 * ((i * 32) / period) ** 2));
	const local = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let sum = 0;
		for (let k = -radius; k <= radius; k++) {
			const j = i + k;
			if (j >= 0 && j < n) sum += envelope[j] * kernel[k + radius];
		}
		local[i] = sum;
	}
	const cumulative = new Float64Array(n);
	const backlink = new Int32Array(n).fill(-1);
	const windowStart = Math.round(2 * period);
	const windowEnd = Math.max(1, Math.round(period / 2));
	for (let i = 0; i < n; i++) {
		let best = Number.NEGATIVE_INFINITY;
		let bestIndex = -1;
		for (let j = i - windowStart; j <= i - windowEnd; j++) {
			if (j < 0) continue;
			const score = cumulative[j] - TIGHTNESS * Math.log((i - j) / period) ** 2;
			if (score > best) {
				best = score;
				bestIndex = j;
			}
		}
		cumulative[i] = local[i] + (bestIndex >= 0 ? Math.max(0, best) : 0);
		backlink[i] = bestIndex >= 0 && best > 0 ? bestIndex : -1;
	}
	// Last beat: a local maximum of the cumulative score in the final two periods.
	let maxima = 0;
	let maximaCount = 0;
	for (let i = 1; i < n - 1; i++) {
		if (cumulative[i] > cumulative[i - 1] && cumulative[i] >= cumulative[i + 1]) {
			maxima += cumulative[i];
			maximaCount++;
		}
	}
	const threshold = maximaCount ? (0.5 * maxima) / maximaCount : 0;
	let last = n - 1;
	for (let i = n - 1; i >= Math.max(0, n - Math.round(period * 2)); i--) {
		const isPeak =
			(i === n - 1 || cumulative[i] >= cumulative[i + 1]) && (i === 0 || cumulative[i] > cumulative[i - 1]);
		if (cumulative[i] >= threshold && isPeak) {
			last = i;
			break;
		}
	}
	const beats: number[] = [];
	for (let i = last; i >= 0; i = backlink[i]) {
		beats.push(i);
		if (backlink[i] < 0) break;
	}
	beats.reverse();
	// Drop weak beats at either end (silence before the music starts / after it stops).
	let rms = 0;
	for (const beat of beats) rms += local[beat] ** 2;
	rms = Math.sqrt(rms / Math.max(1, beats.length));
	const floor = 0.3 * rms;
	let start = 0;
	let end = beats.length;
	while (start < end && local[beats[start]] < floor) start++;
	while (end > start && local[beats[end - 1]] < floor) end--;
	return beats.slice(start, end);
}

/**
 * Fine energy-rise envelope: per `hop` samples, the rectified rise of an RMS over
 * [centre - 128, centre + 128). The rise starts when the window's leading edge meets the
 * transient, so callers add FINE_HALF_WINDOW back.
 */
function fineRise(samples: Float32Array, hop: number): Float64Array {
	const frames = Math.floor(samples.length / hop);
	const rms = new Float64Array(frames);
	const half = FINE_HALF_WINDOW;
	for (let f = 0; f < frames; f++) {
		const centre = f * hop;
		let sum = 0;
		let count = 0;
		for (let i = Math.max(0, centre - half); i < Math.min(samples.length, centre + half); i++) {
			sum += samples[i] * samples[i];
			count++;
		}
		rms[f] = Math.sqrt(sum / Math.max(1, count));
	}
	const rise = new Float64Array(frames);
	for (let f = 1; f < frames; f++) rise[f] = Math.max(0, rms[f] - rms[f - 1]);
	return rise;
}

function pickOnsets(envelope: Float64Array, frameRate: number): Array<{ frame: number; strength: number }> {
	const radius = Math.round(0.1 * frameRate);
	const spacing = Math.round(0.06 * frameRate);
	const peaks: Array<{ frame: number; strength: number }> = [];
	let maxValue = 0;
	for (const value of envelope) maxValue = Math.max(maxValue, value);
	if (maxValue <= 0) return peaks;
	for (let i = 1; i < envelope.length - 1; i++) {
		const value = envelope[i];
		if (value < envelope[i - 1] || value < envelope[i + 1]) continue;
		let localMax = 0;
		let localMean = 0;
		let count = 0;
		for (let j = Math.max(0, i - radius); j <= Math.min(envelope.length - 1, i + radius); j++) {
			localMax = Math.max(localMax, envelope[j]);
			localMean += envelope[j];
			count++;
		}
		localMean /= count;
		if (value < localMax || value < localMean + 0.5 || value < 1) continue;
		const last = peaks[peaks.length - 1];
		if (last && i - last.frame < spacing) {
			if (value > last.strength * maxValue) peaks[peaks.length - 1] = { frame: i, strength: value / maxValue };
			continue;
		}
		peaks.push({ frame: i, strength: value / maxValue });
	}
	return peaks;
}

export function detectBeats(
	samples: Float32Array,
	sampleRate: number,
	options: DetectOptions = {},
): BeatAnalysis {
	const settings: Required<DetectOptions> = {
		minBpm: options.minBpm ?? 60,
		maxBpm: options.maxBpm ?? 200,
		preferredBpm: options.preferredBpm ?? 120,
	};
	const frameRate = sampleRate / HOP;
	const { full, low } = onsetEnvelopes(samples, sampleRate);
	const envelope = normaliseEnvelope(full, Math.round(0.25 * frameRate));
	const lowEnvelope = normaliseEnvelope(low, Math.round(0.25 * frameRate));
	const { lag, confidence } = estimateTempo(envelope, frameRate, settings);
	const beatFrames = trackBeats(envelope, lag);

	// Refine onto the attack of the nearest transient (+-35 ms).
	const fineHop = Math.max(1, Math.round(sampleRate * 0.0015));
	const rise = fineRise(samples, fineHop);
	const search = Math.round((0.035 * sampleRate) / fineHop);
	let envelopeMax = 0;
	for (const value of envelope) envelopeMax = Math.max(envelopeMax, value);
	const beats: number[] = [];
	const strengths: number[] = [];
	for (const frame of beatFrames) {
		const coarse = (frame * HOP) / sampleRate;
		const centre = Math.round((coarse * sampleRate) / fineHop);
		let best = -1;
		let bestValue = 0;
		for (let j = Math.max(1, centre - search); j <= Math.min(rise.length - 1, centre + search); j++) {
			if (rise[j] > bestValue) {
				bestValue = rise[j];
				best = j;
			}
		}
		// Attack start: walk back while the rise is still more than a quarter of its peak.
		let attack = best;
		while (attack > 1 && rise[attack - 1] > bestValue * 0.25) attack--;
		const refined = best > 0 ? (attack * fineHop + FINE_HALF_WINDOW) / sampleRate : coarse;
		beats.push(Math.max(0, refined));
		strengths.push(envelopeMax > 0 ? Math.min(1, envelope[frame] / envelopeMax) : 0);
	}

	// Downbeat phase (4/4): the phase whose beats carry the most low-band onset energy.
	const downbeats: number[] = [];
	if (beatFrames.length >= 8) {
		let bestPhase = 0;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let phase = 0; phase < 4; phase++) {
			let score = 0;
			let count = 0;
			for (let i = phase; i < beatFrames.length; i += 4) {
				score += lowEnvelope[beatFrames[i]] + 0.25 * envelope[beatFrames[i]];
				count++;
			}
			score /= Math.max(1, count);
			if (score > bestScore) {
				bestScore = score;
				bestPhase = phase;
			}
		}
		for (let i = bestPhase; i < beatFrames.length; i += 4) downbeats.push(i);
	}

	const onsets = pickOnsets(envelope, frameRate).map(({ frame, strength }) => ({
		time: (frame * HOP) / sampleRate,
		strength,
	}));

	let bpm = (60 * frameRate) / lag;
	if (beats.length >= 4) {
		// The tracked beats give a better average than the autocorrelation lag.
		const span = beats[beats.length - 1] - beats[0];
		if (span > 0) bpm = (60 * (beats.length - 1)) / span;
	}

	return {
		bpm: Math.round(bpm * 10) / 10,
		beats,
		strengths,
		downbeats,
		onsets,
		confidence,
	};
}
