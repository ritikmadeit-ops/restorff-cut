/**
 * DSP for RestorffCut's generated music beds (voice-music agent, 2026-10-20). Everything is synthesized from code —
 * no samples, no third-party audio — so RestorffCut owns the beds outright (same spirit as src/sounds/pack).
 *
 * Loops are rendered CIRCULARLY: a note that rings past the loop's end wraps to its start (addWrapped), and every
 * effect with memory (reverb, delay, filters) runs over the loop twice and keeps the second pass, so the state at the
 * loop's end equals the state its start was rendered with. Played back to back, a bed has no seam.
 */
export const SR = 48_000;

export type Mono = Float32Array;
export interface Stereo {
	L: Float32Array;
	R: Float32Array;
}

export const stereo = (n: number): Stereo => ({ L: new Float32Array(n), R: new Float32Array(n) });
export const midi = (note: number) => 440 * 2 ** ((note - 69) / 12);

/** Deterministic random numbers (mulberry32). */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Add a mono note into a stereo loop at sample `at`, wrapping past the end; equal-power pan −1…1. */
export function addWrapped(dst: Stereo, src: Mono, at: number, gain = 1, pan = 0): void {
	const n = dst.L.length;
	const angle = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
	const gl = Math.cos(angle) * gain;
	const gr = Math.sin(angle) * gain;
	let index = ((Math.round(at) % n) + n) % n;
	for (let i = 0; i < src.length; i++) {
		dst.L[index] += src[i] * gl;
		dst.R[index] += src[i] * gr;
		index++;
		if (index === n) index = 0;
	}
}

export function mixInto(dst: Stereo, src: Stereo, gain = 1): void {
	for (let i = 0; i < dst.L.length; i++) {
		dst.L[i] += src.L[i] * gain;
		dst.R[i] += src.R[i] * gain;
	}
}

// ─── oscillators and envelopes ───────────────────────────────────────────────────────────────────────────────

/** PolyBLEP correction for a naive saw at phase p (0..1) with increment dt. */
function blep(p: number, dt: number): number {
	if (p < dt) {
		const x = p / dt;
		return x + x - x * x - 1;
	}
	if (p > 1 - dt) {
		const x = (p - 1) / dt;
		return x * x + x + x + 1;
	}
	return 0;
}

export function saw(freq: number, n: number, phase0 = 0): Mono {
	const out = new Float32Array(n);
	const dt = freq / SR;
	let p = phase0 % 1;
	for (let i = 0; i < n; i++) {
		out[i] = 2 * p - 1 - blep(p, dt);
		p += dt;
		if (p >= 1) p -= 1;
	}
	return out;
}

export function sine(freq: number | ((t: number) => number), n: number, phase0 = 0): Mono {
	const out = new Float32Array(n);
	let phase = phase0;
	for (let i = 0; i < n; i++) {
		const f = typeof freq === "number" ? freq : freq(i / SR);
		out[i] = Math.sin(phase);
		phase += (2 * Math.PI * f) / SR;
	}
	return out;
}

export function noise(n: number, random: () => number): Mono {
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = random() * 2 - 1;
	return out;
}

/** Attack / hold / release envelope in seconds (linear attack, exponential-ish release). */
export function ahr(n: number, attack: number, hold: number, release: number): Mono {
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		let v: number;
		if (t < attack) v = attack > 0 ? t / attack : 1;
		else if (t < attack + hold) v = 1;
		else {
			const r = (t - attack - hold) / Math.max(1e-4, release);
			v = r >= 1 ? 0 : (1 - r) ** 2;
		}
		out[i] = v;
	}
	return out;
}

export function mul(a: Mono, b: Mono | ((t: number) => number)): Mono {
	for (let i = 0; i < a.length; i++) a[i] *= typeof b === "function" ? b(i / SR) : b[i];
	return a;
}

export function add(a: Mono, b: Mono, gain = 1): Mono {
	for (let i = 0; i < Math.min(a.length, b.length); i++) a[i] += b[i] * gain;
	return a;
}

// ─── filters (RBJ biquads; cutoff may change over time) ──────────────────────────────────────────────────────

export type FilterKind = "lowpass" | "highpass" | "bandpass";

export class Biquad {
	private x1 = 0;
	private x2 = 0;
	private y1 = 0;
	private y2 = 0;
	private b0 = 1;
	private b1 = 0;
	private b2 = 0;
	private a1 = 0;
	private a2 = 0;
	constructor(
		private kind: FilterKind,
		freq: number,
		private q = 0.707,
	) {
		this.set(freq);
	}
	set(freq: number, q = this.q): void {
		const w = (2 * Math.PI * Math.max(10, Math.min(SR * 0.45, freq))) / SR;
		const cos = Math.cos(w);
		const alpha = Math.sin(w) / (2 * q);
		const a0 = 1 + alpha;
		if (this.kind === "lowpass") {
			this.b0 = (1 - cos) / 2 / a0;
			this.b1 = (1 - cos) / a0;
			this.b2 = this.b0;
		} else if (this.kind === "highpass") {
			this.b0 = (1 + cos) / 2 / a0;
			this.b1 = -(1 + cos) / a0;
			this.b2 = this.b0;
		} else {
			this.b0 = alpha / a0;
			this.b1 = 0;
			this.b2 = -alpha / a0;
		}
		this.a1 = (-2 * cos) / a0;
		this.a2 = (1 - alpha) / a0;
	}
	tick(x: number): number {
		const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
		this.x2 = this.x1;
		this.x1 = x;
		this.y2 = this.y1;
		this.y1 = y;
		return y;
	}
}

/** Filter a note (not a loop: no wrap). `freq` may be a function of seconds; updated every 32 samples. */
export function filter(input: Mono, kind: FilterKind, freq: number | ((t: number) => number), q = 0.707): Mono {
	const f = new Biquad(kind, typeof freq === "number" ? freq : freq(0), q);
	const out = new Float32Array(input.length);
	for (let i = 0; i < input.length; i++) {
		if (typeof freq !== "number" && i % 32 === 0) f.set(freq(i / SR));
		out[i] = f.tick(input[i]);
	}
	return out;
}

/** Filter a stereo LOOP: two passes, the second kept (periodic steady state). `freq(t)` must be periodic in the loop. */
export function filterLoop(input: Stereo, kind: FilterKind, freq: number | ((t: number) => number), q = 0.707): Stereo {
	const n = input.L.length;
	const out = stereo(n);
	for (const [src, dst] of [
		[input.L, out.L],
		[input.R, out.R],
	] as const) {
		const f = new Biquad(kind, typeof freq === "number" ? freq : freq(0), q);
		for (let pass = 0; pass < 2; pass++) {
			for (let i = 0; i < n; i++) {
				if (typeof freq !== "number" && i % 32 === 0) f.set(freq(i / SR));
				const y = f.tick(src[i]);
				if (pass === 1) dst[i] = y;
			}
		}
	}
	return out;
}

// ─── loop effects ────────────────────────────────────────────────────────────────────────────────────────────

class Comb {
	private buf: Float32Array;
	private i = 0;
	private store = 0;
	constructor(
		size: number,
		private feedback: number,
		private damp: number,
	) {
		this.buf = new Float32Array(size);
	}
	tick(x: number): number {
		const y = this.buf[this.i];
		this.store = y * (1 - this.damp) + this.store * this.damp;
		this.buf[this.i] = x + this.store * this.feedback;
		this.i = (this.i + 1) % this.buf.length;
		return y;
	}
}

class Allpass {
	private buf: Float32Array;
	private i = 0;
	constructor(size: number) {
		this.buf = new Float32Array(size);
	}
	tick(x: number): number {
		const b = this.buf[this.i];
		const y = -x + b;
		this.buf[this.i] = x + b * 0.5;
		this.i = (this.i + 1) % this.buf.length;
		return y;
	}
}

/** A Freeverb-style stereo reverb over a loop (wet only), rt60 in seconds, damping 0..1, pre-delay seconds. */
export function reverbLoop(input: Stereo, rt60: number, damping = 0.35, predelay = 0.02): Stereo {
	const n = input.L.length;
	const combSizes = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
	const allSizes = [556, 441, 341, 225];
	const scale = SR / 44_100;
	const out = stereo(n);
	const pre = Math.round(predelay * SR);
	for (const [channel, spread] of [
		["L", 0],
		["R", 23],
	] as const) {
		const combs = combSizes.map((size) => {
			const length = Math.round((size + spread) * scale);
			const feedback = 10 ** ((-3 * length) / SR / rt60);
			return new Comb(length, feedback, damping);
		});
		const alls = allSizes.map((size) => new Allpass(Math.round((size + spread) * scale)));
		const src = channel === "L" ? input.L : input.R;
		const mono = new Float32Array(n);
		for (let i = 0; i < n; i++) mono[i] = (input.L[i] + input.R[i]) * 0.5 * 0.7 + src[i] * 0.3;
		const dst = out[channel];
		// three passes: the tail of a long reverb (rt60 up to ~4 s) settles to the loop's steady state
		for (let pass = 0; pass < 3; pass++) {
			for (let i = 0; i < n; i++) {
				const x = mono[(i - pre + n) % n] * 0.015;
				let y = 0;
				for (const comb of combs) y += comb.tick(x);
				for (const all of alls) y = all.tick(y);
				if (pass === 2) dst[i] = y * 3;
			}
		}
	}
	return out;
}

/** Ping-pong delay over a loop (wet only): time seconds, feedback 0..0.9. */
export function pingPongLoop(input: Stereo, time: number, feedback: number): Stereo {
	const n = input.L.length;
	const d = Math.max(1, Math.round(time * SR));
	const out = stereo(n);
	const bufL = new Float32Array(d);
	const bufR = new Float32Array(d);
	let j = 0;
	for (let pass = 0; pass < 3; pass++) {
		for (let i = 0; i < n; i++) {
			const yl = bufL[j];
			const yr = bufR[j];
			const x = (input.L[i] + input.R[i]) * 0.5;
			bufL[j] = x + yr * feedback;
			bufR[j] = yl * feedback;
			j = (j + 1) % d;
			if (pass === 2) {
				out.L[i] = yl;
				out.R[i] = yr;
			}
		}
	}
	return out;
}

/** Sidechain-style pump: gain dips by `depth` at every beat and recovers with time constant `tau` seconds. */
export function pump(input: Stereo, beatSeconds: number, depth: number, tau: number): Stereo {
	const n = input.L.length;
	for (let i = 0; i < n; i++) {
		const t = (i / SR) % beatSeconds;
		const g = 1 - depth * Math.exp(-t / tau);
		input.L[i] *= g;
		input.R[i] *= g;
	}
	return input;
}

/** Soft saturation, normalised so small signals pass at unity. */
export function saturate(input: Stereo, drive: number): Stereo {
	const k = Math.tanh(drive);
	for (let i = 0; i < input.L.length; i++) {
		input.L[i] = Math.tanh(input.L[i] * drive) / k;
		input.R[i] = Math.tanh(input.R[i] * drive) / k;
	}
	return input;
}

export function peakOf(input: Stereo): number {
	let peak = 0;
	for (let i = 0; i < input.L.length; i++) peak = Math.max(peak, Math.abs(input.L[i]), Math.abs(input.R[i]));
	return peak;
}

export function scale(input: Stereo, gain: number): Stereo {
	for (let i = 0; i < input.L.length; i++) {
		input.L[i] *= gain;
		input.R[i] *= gain;
	}
	return input;
}

/** 32-bit float stereo WAV (for measuring and encoding). */
export function encodeStereoFloatWav(input: Stereo): Uint8Array {
	const n = input.L.length;
	const bytes = new Uint8Array(44 + n * 8);
	const view = new DataView(bytes.buffer);
	const text = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
	};
	text(0, "RIFF");
	view.setUint32(4, 36 + n * 8, true);
	text(8, "WAVE");
	text(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 3, true);
	view.setUint16(22, 2, true);
	view.setUint32(24, SR, true);
	view.setUint32(28, SR * 8, true);
	view.setUint16(32, 8, true);
	view.setUint16(34, 32, true);
	text(36, "data");
	view.setUint32(40, n * 8, true);
	for (let i = 0; i < n; i++) {
		view.setFloat32(44 + i * 8, input.L[i], true);
		view.setFloat32(48 + i * 8, input.R[i], true);
	}
	return bytes;
}

// ─── instruments (each returns one mono note, longer than its duration by its release) ─────────────────────

/** Electric piano: FM tine with a decaying index, a short bark partial, note-off fade. */
export function epiano(freq: number, dur: number, vel = 0.7): Mono {
	const n = Math.round((dur + 1.2) * SR);
	const out = new Float32Array(n);
	const w = (2 * Math.PI * freq) / SR;
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		const index = (0.6 + 1.2 * vel) * Math.exp(-t / 0.25);
		const off = t > dur ? Math.exp(-(t - dur) / 0.18) : 1;
		const body = Math.sin(w * i + index * Math.sin(w * i)) * Math.exp(-t / 1.8);
		const bark = 0.18 * vel * Math.sin(4 * w * i) * Math.exp(-t / 0.06);
		out[i] = (body + bark) * off * vel;
	}
	return out;
}

/** Warm pad: three detuned saws + a sub, low-passed, slow attack. */
export function pad(freq: number, dur: number, { attack = 0.8, release = 1.4, cutoff = 1400, seed = 1 } = {}): Mono {
	const n = Math.round((dur + release) * SR);
	const random = rng(seed);
	const v = add(add(saw(freq * 2 ** (-7 / 1200), n, random()), saw(freq, n, random())), saw(freq * 2 ** (7 / 1200), n, random()));
	add(v, sine(freq / 2, n), 0.6);
	const filtered = filter(v, "lowpass", cutoff, 0.6);
	return mul(filtered, ahr(n, attack, Math.max(0, dur - attack), release));
}

/** Plucked synth: saw through a closing low-pass. */
export function pluck(freq: number, dur: number, vel = 0.7, bright = 4200): Mono {
	const n = Math.round((dur + 0.35) * SR);
	const s = saw(freq, n);
	const f = filter(s, "lowpass", (t) => 500 + bright * vel * Math.exp(-t / 0.09), 0.9);
	return mul(f, (t) => vel * Math.exp(-t / 0.28) * (t > dur ? Math.exp(-(t - dur) / 0.05) : 1));
}

/** Bass: sine + second harmonic through soft clipping. */
export function bass(freq: number, dur: number, vel = 0.8): Mono {
	const n = Math.round((dur + 0.08) * SR);
	const out = new Float32Array(n);
	const w = (2 * Math.PI * freq) / SR;
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		const env = Math.min(1, t / 0.006) * (t > dur ? Math.max(0, 1 - (t - dur) / 0.08) : 1);
		out[i] = Math.tanh(1.6 * (Math.sin(w * i) + 0.35 * Math.sin(2 * w * i))) * env * vel * 0.7;
	}
	return out;
}

/** Sub: plain sine with soft edges. */
export function sub(freq: number, dur: number, vel = 0.7): Mono {
	const n = Math.round((dur + 0.3) * SR);
	return mul(sine(freq, n), ahr(n, 0.08, Math.max(0, dur - 0.08), 0.3).map((v) => v * vel));
}

export function kick(vel = 1, { pitch = 48, punch = 95, decay = 0.32 } = {}): Mono {
	const n = Math.round(0.6 * SR);
	const body = sine((t) => pitch + punch * Math.exp(-t / 0.035), n);
	mul(body, (t) => Math.exp(-t / decay));
	const click = filter(noise(Math.round(0.004 * SR), rng(7)), "highpass", 3000);
	add(body, click, 0.25);
	return mul(body, () => vel);
}

export function snare(vel = 0.8, seed = 3, tone = 190): Mono {
	const n = Math.round(0.35 * SR);
	const hiss = filter(noise(n, rng(seed)), "bandpass", 2400, 0.7);
	mul(hiss, (t) => Math.exp(-t / 0.11));
	const body = mul(sine((t) => tone * (1 + 0.4 * Math.exp(-t / 0.01)), n), (t) => 0.6 * Math.exp(-t / 0.05));
	return mul(add(hiss, body), () => vel);
}

export function clap(vel = 0.8, seed = 5): Mono {
	const n = Math.round(0.4 * SR);
	const src = filter(noise(n, rng(seed)), "bandpass", 1500, 0.9);
	return mul(src, (t) => {
		const bursts = [0, 0.011, 0.022].reduce((sum, at) => sum + (t >= at ? Math.exp(-(t - at) / 0.006) : 0), 0);
		return vel * (0.6 * bursts + (t >= 0.022 ? Math.exp(-(t - 0.022) / 0.13) : 0));
	});
}

export function hat(open = false, vel = 0.5, seed = 11): Mono {
	const n = Math.round((open ? 0.45 : 0.08) * SR);
	const h = filter(filter(noise(n, rng(seed)), "highpass", 7000), "highpass", 7000);
	return mul(h, (t) => vel * Math.exp(-t / (open ? 0.16 : 0.022)));
}

export function shaker(vel = 0.35, seed = 13): Mono {
	const n = Math.round(0.12 * SR);
	const s = filter(noise(n, rng(seed)), "bandpass", 5200, 1.2);
	return mul(s, (t) => vel * Math.min(1, t / 0.012) * Math.exp(-Math.max(0, t - 0.012) / 0.035));
}

export function rim(vel = 0.5): Mono {
	const n = Math.round(0.08 * SR);
	const tone = mul(sine(1700, n), (t) => Math.exp(-t / 0.012));
	const click = mul(filter(noise(n, rng(17)), "bandpass", 3500, 2), (t) => Math.exp(-t / 0.006));
	return mul(add(tone, click, 0.8), () => vel);
}

/** FM bell (inharmonic 3.5 ratio). */
export function bell(freq: number, vel = 0.5, decay = 2.4): Mono {
	const n = Math.round((decay + 0.5) * SR);
	const out = new Float32Array(n);
	const w = (2 * Math.PI * freq) / SR;
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		const index = 2.2 * Math.exp(-t / 0.5);
		out[i] = vel * Math.sin(w * i + index * Math.sin(3.5 * w * i)) * Math.exp(-t / (decay / 2.5)) * Math.min(1, t / 0.003);
	}
	return out;
}

/** Low drum (taiko-like): pitched thump + low noise. */
export function tom(vel = 0.9, pitch = 62): Mono {
	const n = Math.round(0.9 * SR);
	const body = mul(sine((t) => pitch * (1 + 0.5 * Math.exp(-t / 0.03)), n), (t) => Math.exp(-t / 0.28));
	const skin = mul(filter(noise(n, rng(19)), "lowpass", 900), (t) => 0.5 * Math.exp(-t / 0.06));
	return mul(add(body, skin), () => vel);
}

/** Filtered-noise riser over `dur` seconds (cutoff sweeps up, level swells). */
export function riser(dur: number, vel = 0.4, seed = 23): Mono {
	const n = Math.round(dur * SR);
	const s = filter(noise(n, rng(seed)), "bandpass", (t) => 400 * (14 ** (t / dur)), 1.4);
	// 15 ms fade at the very end: a riser lands on a downbeat, often the loop point, and must not click there
	return mul(s, (t) => vel * (t / dur) ** 2.2 * Math.min(1, Math.max(0, dur - t) / 0.015));
}
