/**
 * The five generated music beds (voice-music agent, 2026-10-20): warm, moody, upbeat, ambient, tense. Each is a whole
 * number of 4/4 bars at a fixed tempo, written as notes on a grid and rendered by ./dsp.ts as a seamless loop, so the
 * beat grid is exact (beat i at i × 60 / bpm seconds; a downbeat every 4 beats). Seeded: a rebuild is identical.
 * Original material: chord progressions are common-practice; every note, drum and texture is synthesized here.
 */
import {
	addWrapped,
	bass,
	bell,
	clap,
	epiano,
	filterLoop,
	hat,
	kick,
	midi,
	mixInto,
	pad,
	pingPongLoop,
	pluck,
	pump,
	reverbLoop,
	rim,
	riser,
	rng,
	SR,
	type Stereo,
	saturate,
	shaker,
	snare,
	stereo,
	sub,
	tom,
} from "./dsp";

export type BedMood = "warm" | "moody" | "upbeat" | "ambient" | "tense";

export interface BedRecipe {
	id: string;
	name: string;
	mood: BedMood;
	description: string;
	tags: string[];
	bpm: number;
	bars: number;
	key: string;
	chords: string[];
	/** Where a voice sits best against it, for the tool's notes. */
	use: string;
	render(): Stereo;
}

function grid(bpm: number, bars: number) {
	const beat = 60 / bpm;
	const n = Math.round(bars * 4 * beat * SR);
	/** Sample index of (bar, beat-in-bar), beats may be fractional. */
	const at = (bar: number, b: number) => (bar * 4 + b) * beat * SR;
	return { beat, n, at };
}

// ─── warm: 90 BPM, D major, 8 bars (21.33 s) ──────────────────────────────────────────────────────────────────

const warm: BedRecipe = {
	id: "warm-90",
	name: "Warm morning",
	mood: "warm",
	description: "Soft electric piano on major-ninth chords, round bass, a lazy swung shaker and a rim click. Coffee-shop warm.",
	tags: ["warm", "cozy", "lofi", "morning", "friendly", "piano"],
	bpm: 90,
	bars: 8,
	key: "D major",
	chords: ["Dmaj9", "Bm9", "Gmaj9", "A13sus4"],
	use: "under a friendly voice-over or a lifestyle cut; sits low, leaves 1–4 kHz to the voice",
	render() {
		const { n, at, beat } = grid(this.bpm, this.bars);
		const keys = stereo(n);
		const low = stereo(n);
		const drums = stereo(n);
		const send = stereo(n);
		const chords = [
			{ root: 50, voicing: [54, 57, 61, 64] },
			{ root: 47, voicing: [57, 61, 62, 66] },
			{ root: 43, voicing: [54, 57, 59, 62] },
			{ root: 45, voicing: [55, 59, 62, 66] },
		];
		const swing = (b: number) => (b % 1 === 0.5 ? b + 0.08 : b);
		for (let bar = 0; bar < 8; bar++) {
			const chord = chords[Math.floor(bar / 2)];
			const second = bar % 2 === 1;
			const hits = second ? [{ b: 0, d: 1.8, v: 0.62 }, { b: 2, d: 0.6, v: 0.5 }, { b: 2.75, d: 1.1, v: 0.55 }] : [{ b: 0, d: 1.4, v: 0.7 }, { b: 1.5, d: 0.45, v: 0.5 }, { b: 2.5, d: 1.3, v: 0.58 }];
			for (const hit of hits) {
				chord.voicing.forEach((note, i) => {
					const e = epiano(midi(note), hit.d * beat, hit.v * (0.85 + 0.05 * i));
					addWrapped(keys, e, at(bar, swing(hit.b)) + i * 40, 0.16, -0.3 + i * 0.2);
					addWrapped(send, e, at(bar, swing(hit.b)) + i * 40, 0.05, 0);
				});
			}
			// a soft high answer every other bar
			if (second) {
				const tune = [74, 78, 81, 76][Math.floor(bar / 2)];
				const e = epiano(midi(tune), beat * 1.5, 0.4);
				addWrapped(keys, e, at(bar, 3), 0.14, 0.35);
				addWrapped(send, e, at(bar, 3), 0.1, 0);
			}
			const r = chord.root;
			const line = second ? [{ b: 0, note: r, d: 1.2 }, { b: 1.5, note: r + 12, d: 0.4 }, { b: 3.5, note: r + 7, d: 0.45 }] : [{ b: 0, note: r, d: 1.4 }, { b: 2.5, note: r, d: 0.4 }, { b: 3, note: r + 7, d: 0.9 }];
			for (const step of line) addWrapped(low, bass(midi(step.note - 12), step.d * beat, 0.75), at(bar, swing(step.b)), 0.5, 0);
			// drums
			for (const b of [0, 2.5]) addWrapped(drums, kick(0.85, { pitch: 50, punch: 70, decay: 0.28 }), at(bar, b), 0.55, 0);
			if (bar % 4 === 3) addWrapped(drums, kick(0.6, { pitch: 50, punch: 70, decay: 0.25 }), at(bar, 3.75), 0.45, 0);
			for (const b of [1, 3]) addWrapped(drums, rim(0.55), at(bar, b), 0.32, 0.15);
			for (let e8 = 0; e8 < 8; e8++) {
				const b = swing(e8 / 2);
				addWrapped(drums, shaker(e8 % 2 ? 0.32 : 0.22, 13 + bar * 8 + e8), at(bar, b), 0.4, 0.4);
			}
		}
		const verb = reverbLoop(send, 1.6, 0.45);
		const master = stereo(n);
		mixInto(master, filterLoop(keys, "lowpass", 6500), 1);
		mixInto(master, filterLoop(low, "lowpass", 900), 1);
		mixInto(master, filterLoop(drums, "lowpass", 11000), 1);
		mixInto(master, verb, 0.9);
		return saturate(master, 1.1);
	},
};

// ─── moody: 72 BPM, A minor, 8 bars (26.67 s) ────────────────────────────────────────────────────────────────

const moody: BedRecipe = {
	id: "moody-72",
	name: "Late blue",
	mood: "moody",
	description: "Dark detuned pads on a minor progression, sparse reverb piano, sub bass and a half-time kick and snare.",
	tags: ["moody", "dark", "cinematic", "night", "minor", "slow"],
	bpm: 72,
	bars: 8,
	key: "A minor",
	chords: ["Am(add9)", "Fmaj7", "Dm9", "E7sus4 → E7"],
	use: "night shots, slow reveals, a serious voice; the voice sits above the pads",
	render() {
		const { n, at, beat } = grid(this.bpm, this.bars);
		const pads = stereo(n);
		const keys = stereo(n);
		const low = stereo(n);
		const drums = stereo(n);
		const send = stereo(n);
		const chords = [
			{ root: 45, voicing: [57, 60, 64, 71] },
			{ root: 41, voicing: [53, 57, 60, 64] },
			{ root: 38, voicing: [52, 57, 60, 65] },
			{ root: 40, voicing: [50, 57, 59, 64], turn: [56, 59, 62, 64] },
		];
		chords.forEach((chord, c) => {
			chord.voicing.forEach((note, i) => {
				const span = chord.turn ? 4 : 8;
				const p = pad(midi(note), span * beat, { attack: 0.9, release: 1.6, cutoff: 1100, seed: 31 + c * 4 + i });
				addWrapped(pads, p, at(c * 2, 0), 0.07, -0.5 + i * 0.33);
				addWrapped(send, p, at(c * 2, 0), 0.03, 0);
			});
			if (chord.turn) {
				chord.turn.forEach((note, i) => {
					const p = pad(midi(note), 4 * beat, { attack: 0.6, release: 1.6, cutoff: 1200, seed: 71 + i });
					addWrapped(pads, p, at(c * 2 + 1, 0), 0.07, -0.5 + i * 0.33);
					addWrapped(send, p, at(c * 2 + 1, 0), 0.03, 0);
				});
			}
			addWrapped(low, sub(midi(chord.root), 8 * beat - 0.3, 0.9), at(c * 2, 0), 0.42, 0);
		});
		// a sparse minor-pentatonic line, answered every other bar
		const phrase = [
			[{ b: 0.5, note: 76, d: 1.5 }, { b: 2, note: 74, d: 1 }, { b: 3, note: 72, d: 1 }],
			[{ b: 1.5, note: 69, d: 2.5 }],
			[{ b: 0.5, note: 72, d: 1.5 }, { b: 2, note: 76, d: 1 }, { b: 3, note: 79, d: 1 }],
			[{ b: 1, note: 76, d: 3 }],
		];
		for (let bar = 0; bar < 8; bar++) {
			for (const step of phrase[bar % 4]) {
				const e = epiano(midi(step.note), step.d * beat, 0.45);
				addWrapped(keys, e, at(bar, step.b), 0.13, 0.25);
				addWrapped(send, e, at(bar, step.b), 0.14, 0);
			}
			addWrapped(drums, kick(0.9, { pitch: 46, punch: 80, decay: 0.38 }), at(bar, 0), 0.55, 0);
			if (bar % 2 === 1) addWrapped(drums, kick(0.6, { pitch: 46, punch: 80, decay: 0.3 }), at(bar, 2.75), 0.45, 0);
			const s = snare(0.7, 41 + bar, 170);
			addWrapped(drums, s, at(bar, 2), 0.32, 0);
			addWrapped(send, s, at(bar, 2), 0.08, 0);
			for (let e8 = 0; e8 < 8; e8++) addWrapped(drums, hat(false, e8 % 2 ? 0.25 : 0.16, 51 + bar * 8 + e8), at(bar, e8 / 2), 0.35, -0.3);
		}
		const verb = reverbLoop(send, 3.0, 0.5, 0.04);
		const master = stereo(n);
		mixInto(master, filterLoop(pads, "lowpass", (t) => 1500 + 700 * Math.sin((2 * Math.PI * t) / ((n / SR) / 2))), 1);
		mixInto(master, keys, 1);
		mixInto(master, low, 1);
		mixInto(master, filterLoop(drums, "lowpass", 9000), 1);
		mixInto(master, verb, 1.1);
		return saturate(master, 1.05);
	},
};

// ─── upbeat: 120 BPM, G major, 16 bars (32 s) ───────────────────────────────────────────────────────────────

const upbeat: BedRecipe = {
	id: "upbeat-120",
	name: "Out the door",
	mood: "upbeat",
	description: "Four-on-the-floor kick, claps, off-beat hats, a bright pluck arpeggio and pumping pad on I–V–vi–IV; a hook from bar 9.",
	tags: ["upbeat", "energetic", "pop", "house", "bright", "fast"],
	bpm: 120,
	bars: 16,
	key: "G major",
	chords: ["G", "D", "Em", "C"],
	use: "fast cuts, product reveals, launch energy; duck it under a voice",
	render() {
		const { n, at, beat } = grid(this.bpm, this.bars);
		const pads = stereo(n);
		const plucks = stereo(n);
		const low = stereo(n);
		const drums = stereo(n);
		const send = stereo(n);
		const chords = [
			{ root: 43, tones: [55, 59, 62, 67] },
			{ root: 38, tones: [54, 57, 62, 66] },
			{ root: 40, tones: [55, 59, 64, 67] },
			{ root: 36, tones: [55, 60, 64, 67] },
		];
		const arp = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 3, 2, 1, 2];
		const hook = [79, 81, 83, 86, 83, 81, 79, 76];
		for (let bar = 0; bar < 16; bar++) {
			const chord = chords[bar % 4];
			chord.tones.forEach((note, i) => {
				const p = pad(midi(note), 4 * beat, { attack: 0.05, release: 0.3, cutoff: 2600, seed: 101 + bar * 4 + i });
				addWrapped(pads, p, at(bar, 0), 0.045, -0.6 + i * 0.4);
			});
			for (let s16 = 0; s16 < 16; s16++) {
				const tone = chord.tones[arp[s16]] + (s16 >= 12 && bar % 2 ? 12 : 0);
				const p = pluck(midi(tone + 12), 0.1, s16 % 4 === 0 ? 0.75 : 0.5, 3600);
				addWrapped(plucks, p, at(bar, s16 / 4), 0.12, s16 % 2 ? 0.45 : -0.45);
				if (s16 % 4 === 2) addWrapped(send, p, at(bar, s16 / 4), 0.05, 0);
			}
			if (bar >= 8) {
				const note = hook[bar % 8];
				const h = pluck(midi(note), 0.9 * beat, 0.7, 3000);
				addWrapped(plucks, h, at(bar, 0), 0.16, 0);
				addWrapped(send, h, at(bar, 0), 0.08, 0);
				const h2 = pluck(midi(note - 3 + (bar % 2 ? 5 : 0)), 0.5 * beat, 0.6, 3000);
				addWrapped(plucks, h2, at(bar, 1.5), 0.14, 0.1);
			}
			const r = chord.root;
			for (const b of [0.5, 1.5, 2.5, 3.5]) addWrapped(low, bass(midi(r + (b === 1.5 ? 12 : 0)), 0.42 * beat, 0.8), at(bar, b), 0.42, 0);
			if (bar % 2 === 0) addWrapped(low, bass(midi(r), 0.4 * beat, 0.7), at(bar, 0), 0.38, 0);
			// drums
			for (let b = 0; b < 4; b++) addWrapped(drums, kick(1, { pitch: 50, punch: 110, decay: 0.24 }), at(bar, b), 0.6, 0);
			for (const b of [1, 3]) {
				const c = clap(0.8, 61 + bar * 2 + b);
				addWrapped(drums, c, at(bar, b), 0.3, 0.05);
				addWrapped(send, c, at(bar, b), 0.06, 0);
			}
			for (let b = 0; b < 4; b++) addWrapped(drums, hat(true, 0.45, 81 + bar * 4 + b), at(bar, b + 0.5), 0.2, 0.3);
			for (let s16 = 0; s16 < 16; s16++) addWrapped(drums, hat(false, s16 % 2 ? 0.35 : 0.2, 201 + bar * 16 + s16), at(bar, s16 / 4), 0.16, -0.35);
			if (bar === 15) {
				for (let s16 = 8; s16 < 16; s16++) addWrapped(drums, snare(0.35 + 0.05 * (s16 - 8), 301 + s16, 210), at(bar, s16 / 4), 0.22, 0);
				addWrapped(drums, riser(2 * beat, 0.5, 307), at(bar, 2), 0.25, 0);
			}
		}
		const bus = stereo(n);
		mixInto(bus, filterLoop(pads, "lowpass", 3200), 1);
		mixInto(bus, plucks, 1);
		mixInto(bus, filterLoop(low, "lowpass", 1100), 1);
		pump(bus, beat, 0.55, 0.11);
		const echo = pingPongLoop(send, 0.75 * beat, 0.35);
		const verb = reverbLoop(send, 1.4, 0.4);
		const master = stereo(n);
		mixInto(master, bus, 1);
		mixInto(master, filterLoop(drums, "highpass", 30), 1);
		mixInto(master, echo, 0.5);
		mixInto(master, verb, 0.7);
		return saturate(master, 1.15);
	},
};

// ─── ambient: 60 BPM, E major, 8 bars (32 s) ─────────────────────────────────────────────────────────────────

const ambient: BedRecipe = {
	id: "ambient-60",
	name: "Still air",
	mood: "ambient",
	description: "Slow-breathing pads on E major colours, sparse FM bells through a dotted echo and a long hall, a soft heartbeat pulse.",
	tags: ["ambient", "calm", "airy", "minimal", "spacious", "slow"],
	bpm: 60,
	bars: 8,
	key: "E major",
	chords: ["Emaj9", "C#m11", "Amaj9", "B6sus4"],
	use: "calm product shots, narration-heavy explainers; leaves the most room for a voice",
	render() {
		const { n, at, beat } = grid(this.bpm, this.bars);
		const pads = stereo(n);
		const bells = stereo(n);
		const low = stereo(n);
		const pulse = stereo(n);
		const send = stereo(n);
		const chords = [
			{ root: 40, voicing: [56, 59, 63, 66] },
			{ root: 37, voicing: [52, 56, 59, 66] },
			{ root: 33, voicing: [56, 59, 61, 64] },
			{ root: 35, voicing: [52, 56, 59, 61] },
		];
		chords.forEach((chord, c) => {
			chord.voicing.forEach((note, i) => {
				const p = pad(midi(note), 8 * beat, { attack: 2.2, release: 3.2, cutoff: 900, seed: 401 + c * 4 + i });
				addWrapped(pads, p, at(c * 2, 0), 0.07, -0.6 + i * 0.4);
				addWrapped(send, p, at(c * 2, 0), 0.04, 0);
			});
			addWrapped(low, sub(midi(chord.root), 8 * beat - 0.5, 0.8), at(c * 2, 0), 0.32, 0);
		});
		const random = rng(4242);
		const scale = [76, 78, 80, 83, 85, 88];
		for (let bar = 0; bar < 8; bar++) {
			const count = bar % 2 ? 1 : 2;
			for (let k = 0; k < count; k++) {
				const b = Math.floor(random() * 8) / 2;
				const note = scale[Math.floor(random() * scale.length)];
				const bl = bell(midi(note), 0.35, 2.8);
				addWrapped(bells, bl, at(bar, b), 0.1, random() * 1.2 - 0.6);
				addWrapped(send, bl, at(bar, b), 0.12, 0);
			}
			addWrapped(pulse, kick(0.5, { pitch: 44, punch: 30, decay: 0.3 }), at(bar, 0), 0.25, 0);
			addWrapped(pulse, kick(0.35, { pitch: 44, punch: 30, decay: 0.25 }), at(bar, 0.75), 0.2, 0);
		}
		const echo = pingPongLoop(send, 0.75 * beat, 0.45);
		const verb = reverbLoop(send, 4.0, 0.55, 0.05);
		const master = stereo(n);
		mixInto(master, filterLoop(pads, "lowpass", (t) => 1300 + 500 * Math.sin((2 * Math.PI * t) / ((n / SR) / 2))), 1);
		mixInto(master, bells, 1);
		mixInto(master, low, 1);
		mixInto(master, filterLoop(pulse, "lowpass", 400), 1);
		mixInto(master, echo, 0.45);
		mixInto(master, verb, 1.2);
		return saturate(master, 1.0);
	},
};

// ─── tense: 100 BPM, F# minor, 8 bars (19.2 s) ───────────────────────────────────────────────────────────────

const tense: BedRecipe = {
	id: "tense-100",
	name: "Countdown",
	mood: "tense",
	description: "A low sixteenth-note ostinato whose filter opens and closes, ticking hats, low tom hits, a dissonant swell and a riser into the loop point.",
	tags: ["tense", "suspense", "urgent", "dark", "pulse", "build"],
	bpm: 100,
	bars: 8,
	key: "F# minor",
	chords: ["F#m (pedal)", "F#m / G (b9 cluster)"],
	use: "problem → solution hooks, countdowns, before-reveal; the riser lands on the loop point",
	render() {
		const { n, at, beat } = grid(this.bpm, this.bars);
		const ost = stereo(n);
		const pads = stereo(n);
		const drums = stereo(n);
		const send = stereo(n);
		const loopS = n / SR;
		const pattern = [42, 42, 54, 42, 42, 45, 42, 43, 42, 42, 54, 42, 49, 45, 43, 42];
		for (let bar = 0; bar < 8; bar++) {
			for (let s16 = 0; s16 < 16; s16++) {
				const p = pluck(midi(pattern[s16]), 0.11, s16 % 4 === 0 ? 0.8 : 0.55, 2600);
				addWrapped(ost, p, at(bar, s16 / 4), 0.22, s16 % 2 ? 0.2 : -0.2);
			}
			addWrapped(drums, tom(0.95, 58), at(bar, 0), 0.5, 0);
			if (bar % 2 === 1) addWrapped(drums, tom(0.7, 66), at(bar, 2.5), 0.42, 0.2);
			for (let e8 = 0; e8 < 8; e8++) addWrapped(drums, hat(false, e8 % 2 ? 0.42 : 0.22, 501 + bar * 8 + e8), at(bar, e8 / 2), 0.22, 0.35);
			if (bar % 4 === 3) addWrapped(drums, rim(0.6), at(bar, 3), 0.3, -0.2);
			addWrapped(drums, kick(0.8, { pitch: 44, punch: 60, decay: 0.3 }), at(bar, 0), 0.45, 0);
			addWrapped(drums, kick(0.6, { pitch: 44, punch: 60, decay: 0.25 }), at(bar, 2), 0.4, 0);
		}
		// pedal drone all loop; the b9 cluster swells in bars 5–8
		for (const [i, note] of [42, 49].entries()) {
			const p = pad(midi(note), loopS - 1.2, { attack: 1.5, release: 1.2, cutoff: 700, seed: 601 + i });
			addWrapped(pads, p, at(0, 0), 0.07, i ? 0.4 : -0.4);
		}
		for (const [i, note] of [66, 67].entries()) {
			const p = pad(midi(note), 4 * 4 * beat - 0.4, { attack: 4 * 4 * beat * 0.8, release: 0.4, cutoff: 2200, seed: 611 + i });
			addWrapped(pads, p, at(4, 0), 0.045, i ? 0.5 : -0.5);
			addWrapped(send, p, at(4, 0), 0.04, 0);
		}
		addWrapped(drums, riser(4 * beat, 0.6, 701), at(7, 0), 0.3, 0);
		addWrapped(send, riser(4 * beat, 0.6, 702), at(7, 0), 0.05, 0);
		// the ostinato's filter opens for four bars and closes for four (periodic: no jump at the loop point)
		const sweep = (t: number) => {
			const x = (t % loopS) / loopS;
			const tri = x < 0.5 ? x * 2 : 2 - x * 2;
			return 380 * 6 ** tri;
		};
		const verb = reverbLoop(send, 2.2, 0.45);
		const master = stereo(n);
		mixInto(master, filterLoop(ost, "lowpass", sweep, 1.4), 1);
		mixInto(master, pads, 1);
		mixInto(master, drums, 1);
		mixInto(master, verb, 0.9);
		return saturate(master, 1.2);
	},
};

export const BED_RECIPES: BedRecipe[] = [warm, moody, upbeat, ambient, tense];
