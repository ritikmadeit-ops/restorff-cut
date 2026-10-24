/**
 * A tiny, deterministic synthesizer for RestorffCut's built-in SFX pack (sounds agent, 2026-10-20).
 *
 * Pure TypeScript over Float32Array, mono, 48 kHz. No WebAudio, no dependencies, so the pack can be rebuilt with
 * `bun` on any machine and every byte is reproducible (seeded noise). The pack's recipes are in ./recipes.ts and the
 * build (render → ffmpeg true-peak → measure → manifest) in ./build-pack.ts. Runbook: docs/restorff/worklog/sounds.md.
 */

export const SAMPLE_RATE = 48_000;

export type Signal = Float32Array;
export type Curve = number | ((t: number) => number);

const valueAt = (curve: Curve, t: number): number => (typeof curve === "number" ? curve : curve(t));

export function buffer(seconds: number): Signal {
	return new Float32Array(Math.max(1, Math.round(seconds * SAMPLE_RATE)));
}

export function durationOf(signal: Signal): number {
	return signal.length / SAMPLE_RATE;
}

// ---------------------------------------------------------------- randomness

/** mulberry32: small, fast, seeded PRNG in [0, 1). */
export function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function whiteNoise(seconds: number, random: () => number): Signal {
	const out = buffer(seconds);
	for (let i = 0; i < out.length; i++) out[i] = random() * 2 - 1;
	return out;
}

/** Pink noise (Paul Kellet's refined filter), roughly unit peak. */
export function pinkNoise(seconds: number, random: () => number): Signal {
	const out = buffer(seconds);
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	let b3 = 0;
	let b4 = 0;
	let b5 = 0;
	let b6 = 0;
	for (let i = 0; i < out.length; i++) {
		const white = random() * 2 - 1;
		b0 = 0.99886 * b0 + white * 0.0555179;
		b1 = 0.99332 * b1 + white * 0.0750759;
		b2 = 0.969 * b2 + white * 0.153852;
		b3 = 0.8665 * b3 + white * 0.3104856;
		b4 = 0.55 * b4 + white * 0.5329522;
		b5 = -0.7616 * b5 - white * 0.016898;
		out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
		b6 = white * 0.115926;
	}
	return out;
}

/** Brown (red) noise: integrated white noise with a leak, roughly unit peak. */
export function brownNoise(seconds: number, random: () => number): Signal {
	const out = buffer(seconds);
	let last = 0;
	for (let i = 0; i < out.length; i++) {
		last = (last + 0.02 * (random() * 2 - 1)) / 1.02;
		out[i] = last * 3.5;
	}
	return out;
}

/** A smoothly wandering random curve in [0, 1] (for amplitude flutter), `rate` changes per second. */
export function smoothRandom(seconds: number, rate: number, random: () => number): Signal {
	const out = buffer(seconds);
	const step = Math.max(1, Math.round(SAMPLE_RATE / rate));
	let from = random();
	let to = random();
	for (let i = 0; i < out.length; i++) {
		const phase = (i % step) / step;
		if (phase === 0 && i > 0) {
			from = to;
			to = random();
		}
		const smooth = phase * phase * (3 - 2 * phase);
		out[i] = from + (to - from) * smooth;
	}
	return out;
}

// ---------------------------------------------------------------- oscillators

export type Wave = "sine" | "saw" | "square" | "triangle";

/** An oscillator whose frequency may glide (`freq` as a function of seconds). */
export function osc(seconds: number, wave: Wave, freq: Curve, phase0 = 0): Signal {
	const out = buffer(seconds);
	let phase = phase0;
	for (let i = 0; i < out.length; i++) {
		const t = i / SAMPLE_RATE;
		const p = phase - Math.floor(phase);
		switch (wave) {
			case "sine":
				out[i] = Math.sin(2 * Math.PI * p);
				break;
			case "saw":
				out[i] = 2 * p - 1;
				break;
			case "square":
				out[i] = p < 0.5 ? 1 : -1;
				break;
			case "triangle":
				out[i] = 1 - 4 * Math.abs(p - 0.5);
				break;
		}
		phase += valueAt(freq, t) / SAMPLE_RATE;
	}
	return out;
}

/** Exponential glide from `from` Hz to `to` Hz over `over` seconds, then hold. */
export function glide(from: number, to: number, over: number): (t: number) => number {
	return (t) => (t >= over ? to : from * (to / from) ** (t / over));
}

// ---------------------------------------------------------------- filters (RBJ cookbook biquads)

export type FilterType = "lowpass" | "highpass" | "bandpass" | "peaking";

interface Coefficients {
	b0: number;
	b1: number;
	b2: number;
	a1: number;
	a2: number;
}

function coefficients(type: FilterType, freq: number, q: number, gainDb: number): Coefficients {
	const f0 = Math.min(Math.max(freq, 10), SAMPLE_RATE * 0.45);
	const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
	const cos = Math.cos(w0);
	const alpha = Math.sin(w0) / (2 * Math.max(q, 0.05));
	let b0: number;
	let b1: number;
	let b2: number;
	let a0: number;
	let a1: number;
	let a2: number;
	switch (type) {
		case "lowpass":
			b0 = (1 - cos) / 2;
			b1 = 1 - cos;
			b2 = (1 - cos) / 2;
			a0 = 1 + alpha;
			a1 = -2 * cos;
			a2 = 1 - alpha;
			break;
		case "highpass":
			b0 = (1 + cos) / 2;
			b1 = -(1 + cos);
			b2 = (1 + cos) / 2;
			a0 = 1 + alpha;
			a1 = -2 * cos;
			a2 = 1 - alpha;
			break;
		case "bandpass": // constant 0 dB peak gain
			b0 = alpha;
			b1 = 0;
			b2 = -alpha;
			a0 = 1 + alpha;
			a1 = -2 * cos;
			a2 = 1 - alpha;
			break;
		case "peaking": {
			const a = 10 ** (gainDb / 40);
			b0 = 1 + alpha * a;
			b1 = -2 * cos;
			b2 = 1 - alpha * a;
			a0 = 1 + alpha / a;
			a1 = -2 * cos;
			a2 = 1 - alpha / a;
			break;
		}
	}
	return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** A biquad whose cutoff and Q may move over time (coefficients refreshed every 16 samples). */
export function filter(input: Signal, type: FilterType, freq: Curve, q: Curve = 0.707, gainDb = 0): Signal {
	const out = new Float32Array(input.length);
	let x1 = 0;
	let x2 = 0;
	let y1 = 0;
	let y2 = 0;
	let c = coefficients(type, valueAt(freq, 0), valueAt(q, 0), gainDb);
	const moving = typeof freq === "function" || typeof q === "function";
	for (let i = 0; i < input.length; i++) {
		if (moving && i % 16 === 0) c = coefficients(type, valueAt(freq, i / SAMPLE_RATE), valueAt(q, i / SAMPLE_RATE), gainDb);
		const x = input[i];
		const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
		x2 = x1;
		x1 = x;
		y2 = y1;
		y1 = y;
		out[i] = y;
	}
	return out;
}

// ---------------------------------------------------------------- envelopes and shaping

/** Multiply by an envelope given as a function of seconds. */
export function shape(input: Signal, envelope: (t: number) => number): Signal {
	const out = new Float32Array(input.length);
	for (let i = 0; i < input.length; i++) out[i] = input[i] * envelope(i / SAMPLE_RATE);
	return out;
}

/** Multiply sample by sample with another signal (e.g. a smoothRandom flutter). */
export function modulate(input: Signal, by: Signal, depth = 1): Signal {
	const out = new Float32Array(input.length);
	for (let i = 0; i < input.length; i++) out[i] = input[i] * (1 - depth + depth * (by[i] ?? 0));
	return out;
}

/** Linear attack to 1 at `attack` s, then exponential decay with time constant `tau` s. */
export const attackDecay =
	(attack: number, tau: number) =>
	(t: number): number =>
		t < attack ? t / attack : Math.exp(-(t - attack) / tau);

/** Rises as (t/peak)^rise to 1 at `peak`, then falls as ((end-t)/(end-peak))^fall to 0 at `end`. */
export const swell =
	(peak: number, end: number, rise = 2, fall = 1.5) =>
	(t: number): number => {
		if (t <= 0 || t >= end) return 0;
		if (t < peak) return (t / peak) ** rise;
		return ((end - t) / (end - peak)) ** fall;
	};

export function drive(input: Signal, amount: number): Signal {
	const out = new Float32Array(input.length);
	const norm = Math.tanh(amount);
	for (let i = 0; i < input.length; i++) out[i] = Math.tanh(input[i] * amount) / norm;
	return out;
}

/** Sample-and-hold to `rate` Hz and quantise to `bits` (the glitch's grit). */
export function crush(input: Signal, rate: number, bits: number): Signal {
	const out = new Float32Array(input.length);
	const hold = Math.max(1, Math.round(SAMPLE_RATE / rate));
	const levels = 2 ** (bits - 1);
	let held = 0;
	for (let i = 0; i < input.length; i++) {
		if (i % hold === 0) held = Math.round(input[i] * levels) / levels;
		out[i] = held;
	}
	return out;
}

export function reverse(input: Signal): Signal {
	const out = new Float32Array(input.length);
	for (let i = 0; i < input.length; i++) out[i] = input[input.length - 1 - i];
	return out;
}

// ---------------------------------------------------------------- mixing

export function gain(input: Signal, factor: number): Signal {
	const out = new Float32Array(input.length);
	for (let i = 0; i < input.length; i++) out[i] = input[i] * factor;
	return out;
}

/** Add `source` × `level` into `target` starting at `at` seconds (in place; returns target). */
export function mixInto(target: Signal, source: Signal, at = 0, level = 1): Signal {
	const offset = Math.round(at * SAMPLE_RATE);
	for (let i = 0; i < source.length; i++) {
		const j = offset + i;
		if (j < 0) continue;
		if (j >= target.length) break;
		target[j] += source[i] * level;
	}
	return target;
}

export function mix(seconds: number, layers: Array<{ signal: Signal; at?: number; level?: number }>): Signal {
	const out = buffer(seconds);
	for (const layer of layers) mixInto(out, layer.signal, layer.at ?? 0, layer.level ?? 1);
	return out;
}

// ---------------------------------------------------------------- space

/** A small Schroeder reverb (4 combs + 2 allpasses). Returns the wet signal only, same length as the input. */
export function reverb(input: Signal, rt60: number, damping = 0.3): Signal {
	const combDelays = [29.7, 37.1, 41.1, 43.7].map((ms) => Math.round((ms / 1000) * SAMPLE_RATE));
	const out = new Float32Array(input.length);
	for (const delay of combDelays) {
		const feedback = 10 ** ((-3 * delay) / SAMPLE_RATE / rt60);
		const line = new Float32Array(delay);
		let index = 0;
		let low = 0;
		for (let i = 0; i < input.length; i++) {
			const delayed = line[index];
			low = delayed * (1 - damping) + low * damping;
			line[index] = input[i] + low * feedback;
			out[i] += delayed * 0.25;
			index = (index + 1) % delay;
		}
	}
	let signal = out;
	for (const ms of [5.0, 1.7]) {
		const delay = Math.round((ms / 1000) * SAMPLE_RATE);
		const line = new Float32Array(delay);
		const next = new Float32Array(signal.length);
		let index = 0;
		for (let i = 0; i < signal.length; i++) {
			const delayed = line[index];
			const value = signal[i] + delayed * 0.7;
			line[index] = value;
			next[i] = delayed - value * 0.7;
			index = (index + 1) % delay;
		}
		signal = next;
	}
	return signal;
}

// ---------------------------------------------------------------- finishing

export function peak(signal: Signal): number {
	let max = 0;
	for (let i = 0; i < signal.length; i++) max = Math.max(max, Math.abs(signal[i]));
	return max;
}

/** DC-block, short fades at both ends (no clicks at the cut points), scale the sample peak to `target`. */
export function finish(input: Signal, { fadeIn = 0.0008, fadeOut = 0.012, target = 0.89 } = {}): Signal {
	const out = filter(input, "highpass", 18, 0.707);
	const inSamples = Math.round(fadeIn * SAMPLE_RATE);
	const outSamples = Math.round(fadeOut * SAMPLE_RATE);
	for (let i = 0; i < inSamples && i < out.length; i++) out[i] *= i / inSamples;
	for (let i = 0; i < outSamples && i < out.length; i++) out[out.length - 1 - i] *= i / outSamples;
	const max = peak(out);
	return max > 0 ? gain(out, target / max) : out;
}

/** Time (s) of the loudest 10 ms window, and the first time the 10 ms envelope reaches −20 dB of that. */
export function landmarks(signal: Signal): { peakAt: number; onset: number } {
	const window = Math.round(0.01 * SAMPLE_RATE);
	const hop = Math.round(0.002 * SAMPLE_RATE);
	const envelope: Array<[number, number]> = [];
	for (let start = 0; start + window <= signal.length; start += hop) {
		let sum = 0;
		for (let i = start; i < start + window; i++) sum += signal[i] * signal[i];
		envelope.push([start / SAMPLE_RATE, Math.sqrt(sum / window)]);
	}
	if (!envelope.length) return { peakAt: 0, onset: 0 };
	let best = envelope[0];
	for (const point of envelope) if (point[1] > best[1]) best = point;
	const threshold = best[1] * 0.1;
	const first = envelope.find((point) => point[1] >= threshold) ?? best;
	const centre = window / 2 / SAMPLE_RATE;
	return { peakAt: best[0] + centre, onset: first[0] };
}

/** 32-bit float mono WAV bytes (the intermediate the ffmpeg pass reads). */
export function encodeFloatWav(signal: Signal): Uint8Array {
	const dataBytes = signal.length * 4;
	const bytes = new Uint8Array(44 + dataBytes);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 3, true); // IEEE float
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * 4, true);
	view.setUint16(32, 4, true);
	view.setUint16(34, 32, true);
	ascii(36, "data");
	view.setUint32(40, dataBytes, true);
	for (let i = 0; i < signal.length; i++) view.setFloat32(44 + i * 4, signal[i], true);
	return bytes;
}
