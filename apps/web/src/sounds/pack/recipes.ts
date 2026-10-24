/**
 * The recipes of RestorffCut's built-in SFX pack "restorff-core" (generated, ours). Each recipe renders one mono
 * 48 kHz signal from ./synth.ts with a fixed seed, so the pack is reproducible byte for byte.
 *
 * `roles` tell "Design the sound" (packages/timeline-ops/src/sound-design.ts) what a sound is for:
 *   cut · transition · text_in · hook_riser · hit · caption_tick · foley · accent
 * `sync` says where the sound's event is: "peak" (whooshes, risers: the loudest moment lands on the visual event) or
 * "onset" (hits, pops, clicks: the attack lands on it). The times themselves are MEASURED by build-pack.ts.
 * `target_lufs_m` is the momentary-max loudness the sound should sit at under a −14 LUFS mix; build-pack.ts turns it
 * into `default_db` from the measured loudness.
 */
import {
	attackDecay,
	brownNoise,
	buffer,
	crush,
	drive,
	filter,
	gain,
	glide,
	mix,
	mixInto,
	modulate,
	osc,
	pinkNoise,
	reverb,
	reverse,
	rng,
	SAMPLE_RATE,
	shape,
	type Signal,
	smoothRandom,
	swell,
	whiteNoise,
} from "./synth";

export type SfxRole = "cut" | "transition" | "text_in" | "hook_riser" | "hit" | "caption_tick" | "foley" | "accent";

export interface SfxRecipe {
	id: string;
	name: string;
	category: "whoosh" | "riser" | "hit" | "ui" | "foley" | "glitch" | "bell" | "scratch";
	tags: string[];
	roles: SfxRole[];
	sync: "peak" | "onset";
	target_lufs_m: number;
	description: string;
	render: () => Signal;
}

// ---------------------------------------------------------------- building blocks

function whoosh(seconds: number, peakFraction: number, from: number, top: number, to: number, seed: number): Signal {
	const random = rng(seed);
	const peakAt = seconds * peakFraction;
	const centre = (t: number) =>
		t < peakAt ? from * (top / from) ** (t / peakAt) : top * (to / top) ** ((t - peakAt) / (seconds - peakAt));
	const pink = pinkNoise(seconds, random);
	const band = filter(pink, "bandpass", centre, 1.1);
	const air = filter(filter(whiteNoise(seconds, random), "highpass", (t) => centre(t) * 1.8, 0.7), "lowpass", 12_000);
	const body = filter(pink, "lowpass", (t) => centre(t) * 0.5, 0.9);
	const layered = mix(seconds, [
		{ signal: band, level: 1 },
		{ signal: air, level: 0.22 },
		{ signal: body, level: 0.45 },
	]);
	const flutter = modulate(layered, smoothRandom(seconds, 28, random), 0.3);
	return shape(flutter, swell(peakAt, seconds, 2.2, 1.6));
}

function riser(seconds: number, from: number, to: number, seed: number): Signal {
	const random = rng(seed);
	const progress = (t: number) => Math.min(1, t / seconds);
	const noise = filter(pinkNoise(seconds, random), "bandpass", (t) => 300 * (8000 / 300) ** (progress(t) ** 1.3), 2.5);
	const pitch = (t: number) => from * (to / from) ** progress(t);
	const tone = mix(seconds, [
		{ signal: osc(seconds, "saw", pitch), level: 0.5 },
		{ signal: osc(seconds, "saw", (t) => pitch(t) * 1.007, 0.3), level: 0.5 },
		{ signal: osc(seconds, "sine", (t) => pitch(t) / 2), level: 0.6 },
	]);
	const bright = filter(tone, "lowpass", (t) => 500 + 5500 * progress(t) ** 2, 1.4);
	const lfo = osc(seconds, "sine", (t) => 4 + 14 * progress(t) ** 2);
	const tremolo = new Float32Array(lfo.length);
	for (let i = 0; i < lfo.length; i++) tremolo[i] = 0.5 + 0.5 * lfo[i];
	const layered = mix(seconds, [
		{ signal: noise, level: 0.8 },
		{ signal: modulate(bright, tremolo, 0.35), level: 0.55 },
	]);
	return shape(layered, (t) => progress(t) ** 2.4);
}

function typewriterKey(random: () => number): Signal {
	const seconds = 0.12;
	return mix(seconds, [
		{
			signal: shape(filter(whiteNoise(seconds, random), "bandpass", 1800 + random() * 1400, 1.3), attackDecay(0.0003, 0.012)),
			level: 1,
		},
		{ signal: shape(osc(seconds, "sine", glide(170, 110, 0.02)), attackDecay(0.001, 0.02)), level: 0.6 },
		{
			signal: shape(filter(whiteNoise(seconds, random), "highpass", 5000, 0.7), attackDecay(0.0002, 0.002)),
			at: 0.004,
			level: 0.3,
		},
	]);
}

function withRoom(dry: Signal, rt60: number, wet: number, damping = 0.5): Signal {
	return mix(dry.length / SAMPLE_RATE, [
		{ signal: dry, level: 1 },
		{ signal: reverb(dry, rt60, damping), level: wet },
	]);
}

// ---------------------------------------------------------------- the pack

export const RECIPES: SfxRecipe[] = [
	{
		id: "whoosh-short",
		name: "Whoosh short",
		category: "whoosh",
		tags: ["whoosh", "transition", "cut", "air", "fast", "swipe"],
		roles: ["cut", "transition"],
		sync: "peak",
		target_lufs_m: -21,
		description: "A quick band-swept air whoosh that peaks on the cut.",
		render: () => whoosh(0.45, 0.6, 400, 2500, 900, 101),
	},
	{
		id: "whoosh-long",
		name: "Whoosh long",
		category: "whoosh",
		tags: ["whoosh", "transition", "cut", "air", "slow", "sweep", "pass-by"],
		roles: ["transition", "cut"],
		sync: "peak",
		target_lufs_m: -21,
		description: "A slower, fuller pass-by whoosh for longer transitions.",
		render: () => whoosh(1.0, 0.62, 250, 3000, 600, 102),
	},
	{
		id: "swish",
		name: "Swish",
		category: "whoosh",
		tags: ["swish", "whoosh", "cut", "air", "fast", "light", "swipe"],
		roles: ["cut"],
		sync: "peak",
		target_lufs_m: -22,
		description: "A thin, high, fast swish for quick cuts and swipes.",
		render: () => {
			const seconds = 0.3;
			const random = rng(103);
			const noise = filter(whiteNoise(seconds, random), "highpass", 1800, 0.7);
			const band = filter(noise, "bandpass", glide(3000, 7500, 0.14), 1.4);
			return shape(band, swell(0.12, seconds, 1.8, 2));
		},
	},
	{
		id: "riser-1s",
		name: "Riser 1 s",
		category: "riser",
		tags: ["riser", "build", "tension", "hook", "uplifter", "sweep"],
		roles: ["hook_riser"],
		sync: "peak",
		target_lufs_m: -21,
		description: "A one-second rising noise and tone that resolves on its last frame.",
		render: () => riser(1.0, 110, 440, 104),
	},
	{
		id: "riser-2s",
		name: "Riser 2 s",
		category: "riser",
		tags: ["riser", "build", "tension", "hook", "uplifter", "sweep", "long"],
		roles: ["hook_riser"],
		sync: "peak",
		target_lufs_m: -21,
		description: "A two-second build with an accelerating tremolo; ends at full level for a hit to follow.",
		render: () => riser(2.0, 80, 660, 105),
	},
	{
		id: "reverse-swell",
		name: "Reverse swell",
		category: "riser",
		tags: ["reverse", "swell", "suck", "build", "transition", "cymbal"],
		roles: ["hook_riser", "transition"],
		sync: "peak",
		target_lufs_m: -21,
		description: "A reversed cymbal-and-room swell that sucks into the cut.",
		render: () => {
			const seconds = 0.9;
			const random = rng(106);
			const hit = mix(seconds, [
				{ signal: shape(filter(whiteNoise(seconds, random), "highpass", 3000, 0.7), attackDecay(0.001, 0.25)), level: 0.8 },
				{ signal: shape(osc(seconds, "sine", glide(120, 60, 0.05)), attackDecay(0.002, 0.12)), level: 0.4 },
			]);
			const tail = reverb(hit, 1.2, 0.2);
			return reverse(mix(seconds, [{ signal: hit, level: 0.5 }, { signal: tail, level: 1 }]));
		},
	},
	{
		id: "impact",
		name: "Impact",
		category: "hit",
		tags: ["impact", "hit", "punch", "thud", "kick", "accent", "hook"],
		roles: ["hit"],
		sync: "onset",
		target_lufs_m: -17,
		description: "A tight punchy hit: pitched kick, knock and a short room.",
		render: () => {
			const seconds = 0.9;
			const random = rng(107);
			const dry = mix(seconds, [
				{ signal: shape(osc(seconds, "sine", glide(130, 44, 0.09)), attackDecay(0.001, 0.22)), level: 1 },
				{ signal: shape(filter(whiteNoise(seconds, random), "lowpass", 3500, 0.7), attackDecay(0.0005, 0.025)), level: 0.6 },
				{ signal: shape(filter(whiteNoise(seconds, random), "bandpass", 900, 1.2), attackDecay(0.001, 0.06)), level: 0.4 },
			]);
			return drive(withRoom(dry, 0.9, 0.35, 0.4), 1.8);
		},
	},
	{
		id: "boom",
		name: "Boom",
		category: "hit",
		tags: ["boom", "impact", "cinematic", "trailer", "hit", "low", "rumble"],
		roles: ["hit"],
		sync: "onset",
		target_lufs_m: -17,
		description: "A deep cinematic boom with a rumbling tail.",
		render: () => {
			const seconds = 1.6;
			const random = rng(108);
			const dry = mix(seconds, [
				{ signal: shape(osc(seconds, "sine", glide(85, 34, 0.35)), attackDecay(0.002, 0.55)), level: 1 },
				{ signal: shape(filter(brownNoise(seconds, random), "lowpass", 220, 0.8), attackDecay(0.005, 0.5)), level: 0.7 },
				{ signal: shape(filter(whiteNoise(seconds, random), "bandpass", 1800, 0.8), attackDecay(0.0005, 0.03)), level: 0.35 },
			]);
			return drive(withRoom(dry, 1.6, 0.5, 0.5), 2.2);
		},
	},
	{
		id: "sub-hit",
		name: "Sub hit",
		category: "hit",
		tags: ["sub", "hit", "bass", "thump", "low", "808", "hook"],
		roles: ["hit"],
		sync: "onset",
		target_lufs_m: -17,
		description: "A sub thump, saturated so its harmonics still read on phone speakers.",
		render: () => {
			const seconds = 1.0;
			const random = rng(109);
			const dry = mix(seconds, [
				{ signal: shape(osc(seconds, "sine", glide(95, 50, 0.045)), attackDecay(0.0015, 0.3)), level: 1 },
				{ signal: shape(filter(whiteNoise(seconds, random), "lowpass", 2000, 0.7), attackDecay(0.0003, 0.006)), level: 0.3 },
			]);
			return drive(dry, 3);
		},
	},
	{
		id: "bass-drop",
		name: "Bass drop",
		category: "hit",
		tags: ["bass", "drop", "sub", "down", "pitch", "low", "trailer"],
		roles: ["hit", "accent"],
		sync: "onset",
		target_lufs_m: -18,
		description: "A pitch-falling sub and filtered saw, 150 Hz to 34 Hz.",
		render: () => {
			const seconds = 1.6;
			const pitch = glide(150, 34, 1.1);
			const layered = mix(seconds, [
				{ signal: osc(seconds, "sine", pitch), level: 1 },
				{ signal: filter(osc(seconds, "saw", pitch), "lowpass", (t) => 900 * (1 - t / seconds) + 120, 0.9), level: 0.35 },
			]);
			const envelope = (t: number) => (t < 0.01 ? t / 0.01 : 1) * (t > 1.1 ? Math.exp(-(t - 1.1) / 0.18) : 1);
			return drive(shape(layered, envelope), 2.5);
		},
	},
	{
		id: "pop",
		name: "Pop",
		category: "ui",
		tags: ["pop", "text", "title", "bubble", "ui", "appear", "headline"],
		roles: ["text_in"],
		sync: "onset",
		target_lufs_m: -23,
		description: "A short round pop for text and graphics popping in.",
		render: () => {
			const seconds = 0.12;
			const random = rng(110);
			return mix(seconds, [
				{ signal: shape(osc(seconds, "sine", glide(950, 320, 0.05)), attackDecay(0.0015, 0.022)), level: 1 },
				{ signal: shape(filter(whiteNoise(seconds, random), "highpass", 3000, 0.7), attackDecay(0.0003, 0.003)), level: 0.25 },
			]);
		},
	},
	{
		id: "click",
		name: "Click",
		category: "ui",
		tags: ["click", "ui", "button", "tap", "mouse", "caption"],
		roles: ["caption_tick", "text_in"],
		sync: "onset",
		target_lufs_m: -27,
		description: "A dry interface click.",
		render: () => {
			const seconds = 0.06;
			const random = rng(111);
			return mix(seconds, [
				{ signal: shape(filter(whiteNoise(seconds, random), "bandpass", 3200, 1.5), attackDecay(0.0003, 0.006)), level: 1 },
				{ signal: shape(osc(seconds, "sine", 1900), attackDecay(0.0005, 0.008)), level: 0.5 },
			]);
		},
	},
	{
		id: "tick",
		name: "Tick",
		category: "ui",
		tags: ["tick", "clock", "ui", "caption", "counter", "small"],
		roles: ["caption_tick"],
		sync: "onset",
		target_lufs_m: -29,
		description: "A tiny high tick for caption chunks and counters.",
		render: () => {
			const seconds = 0.05;
			const random = rng(112);
			return mix(seconds, [
				{ signal: shape(filter(whiteNoise(seconds, random), "bandpass", 6500, 2), attackDecay(0.0002, 0.003)), level: 1 },
				{ signal: shape(osc(seconds, "sine", 4300), attackDecay(0.0003, 0.005)), level: 0.4 },
			]);
		},
	},
	{
		id: "ding",
		name: "Ding",
		category: "bell",
		tags: ["ding", "bell", "chime", "notification", "success", "price", "offer"],
		roles: ["accent"],
		sync: "onset",
		target_lufs_m: -22,
		description: "A bright bell strike (C6 with inharmonic partials) for prices, checks and offers.",
		render: () => {
			const seconds = 1.4;
			const random = rng(113);
			const fundamental = 1046.5;
			const partials: Array<[number, number, number]> = [
				[1, 1, 1.1],
				[2.0, 0.45, 0.7],
				[2.76, 0.3, 0.45],
				[5.4, 0.18, 0.22],
				[8.93, 0.08, 0.12],
			];
			const layers = partials.map(([ratio, level, tau]) => ({
				signal: shape(osc(seconds, "sine", fundamental * ratio), attackDecay(0.002, tau)),
				level,
			}));
			layers.push({
				signal: shape(filter(whiteNoise(seconds, random), "highpass", 4000, 0.7), attackDecay(0.0003, 0.004)),
				level: 0.15,
			});
			return withRoom(mix(seconds, layers), 1.0, 0.15, 0.3);
		},
	},
	{
		id: "camera-shutter",
		name: "Camera shutter",
		category: "foley",
		tags: ["camera", "shutter", "photo", "snap", "flash", "freeze-frame", "foley"],
		roles: ["foley", "accent"],
		sync: "onset",
		target_lufs_m: -22,
		description: "A two-blade mechanical shutter (open, close at 0.11 s) for freeze frames and photo moments.",
		render: () => {
			const seconds = 0.35;
			const random = rng(114);
			const blade = (centre: number, from: number, to: number) =>
				mix(seconds, [
					{ signal: shape(filter(whiteNoise(seconds, random), "bandpass", centre, 1.3), attackDecay(0.0003, 0.01)), level: 1 },
					{ signal: shape(osc(seconds, "sine", glide(from, to, 0.02)), attackDecay(0.001, 0.015)), level: 0.5 },
				]);
			const whirr = shape(filter(whiteNoise(seconds, random), "bandpass", 1400, 3), (t) => swell(0.05, 0.1, 1, 1)(t - 0.01));
			const dry = mix(seconds, [
				{ signal: blade(2600, 220, 140), level: 1 },
				{ signal: whirr, level: 0.15 },
				{ signal: blade(3400, 180, 120), at: 0.11, level: 0.85 },
			]);
			return withRoom(dry, 0.25, 0.2, 0.5);
		},
	},
	{
		id: "typewriter",
		name: "Typewriter",
		category: "foley",
		tags: ["typewriter", "typing", "keys", "text", "type-on", "foley"],
		roles: ["foley", "text_in"],
		sync: "onset",
		target_lufs_m: -23,
		description: "Seven typewriter keystrokes at a human pace, for type-on text.",
		render: () => {
			const seconds = 1.3;
			const random = rng(115);
			const out = buffer(seconds);
			let at = 0.002;
			for (let key = 0; key < 7; key++) {
				mixInto(out, typewriterKey(random), at, 0.75 + random() * 0.25);
				at += 0.11 + random() * 0.09;
			}
			return withRoom(out, 0.3, 0.15, 0.5);
		},
	},
	{
		id: "typewriter-key",
		name: "Typewriter key",
		category: "foley",
		tags: ["typewriter", "key", "typing", "text", "letter", "foley"],
		roles: ["foley", "text_in", "caption_tick"],
		sync: "onset",
		target_lufs_m: -24,
		description: "One typewriter keystroke, for per-word or per-letter text.",
		render: () => typewriterKey(rng(116)),
	},
	{
		id: "glitch",
		name: "Glitch",
		category: "glitch",
		tags: ["glitch", "digital", "error", "data", "stutter", "tech", "transition"],
		roles: ["accent", "transition"],
		sync: "onset",
		target_lufs_m: -22,
		description: "Bit-crushed digital stutter: square bursts, crushed noise and gaps.",
		render: () => {
			const seconds = 0.5;
			const random = rng(117);
			const out = buffer(seconds);
			let at = 0;
			while (at < seconds - 0.02) {
				const length = 0.015 + random() * 0.045;
				const pick = random();
				let segment: Signal;
				if (pick < 0.35) segment = osc(length, "square", 150 + random() * 2350);
				else if (pick < 0.7) segment = crush(whiteNoise(length, random), 800 + random() * 3200, 3);
				else if (pick < 0.85) segment = crush(osc(length, "saw", 60 + random() * 60), 2000, 4);
				else segment = new Float32Array(Math.round(length * SAMPLE_RATE));
				const fade = Math.min(24, Math.floor(segment.length / 2));
				for (let i = 0; i < fade; i++) {
					segment[i] *= i / fade;
					segment[segment.length - 1 - i] *= i / fade;
				}
				mixInto(out, segment, at, 0.5 + random() * 0.5);
				at += length;
			}
			return shape(out, (t) => (t > seconds - 0.08 ? (seconds - t) / 0.08 : 1));
		},
	},
	{
		id: "paper-rustle",
		name: "Paper rustle",
		category: "foley",
		tags: ["paper", "rustle", "crinkle", "collage", "cutout", "page", "foley"],
		roles: ["foley", "transition"],
		sync: "peak",
		target_lufs_m: -24,
		description: "A crinkle of paper for collage and cut-out moves.",
		render: () => {
			const seconds = 0.7;
			const random = rng(118);
			const density = swell(0.25, seconds, 1, 1.2);
			const out = buffer(seconds);
			for (let i = 0; i < 220; i++) {
				const at = random() * seconds;
				if (random() > density(at)) continue;
				const crackle = shape(
					filter(whiteNoise(0.008, random), "bandpass", 2000 + random() * 4500, 2),
					attackDecay(0.0002, 0.0015 + random() * 0.003),
				);
				mixInto(out, crackle, at, 0.3 + random() * 0.7);
			}
			const bed = shape(
				modulate(filter(whiteNoise(seconds, random), "bandpass", 2800, 0.6), smoothRandom(seconds, 40, random), 0.8),
				density,
			);
			return mix(seconds, [
				{ signal: out, level: 1 },
				{ signal: bed, level: 0.25 },
			]);
		},
	},
	{
		id: "record-scratch",
		name: "Record scratch",
		category: "scratch",
		tags: ["record", "scratch", "vinyl", "dj", "stop", "rewind", "comedy"],
		roles: ["accent"],
		sync: "onset",
		target_lufs_m: -22,
		description: "A back-and-forth vinyl scratch (the 'wait, what?' moment).",
		render: () => {
			const seconds = 0.55;
			const random = rng(119);
			const speed = (t: number) => (t < 0.36 ? Math.sin((2 * Math.PI * t) / 0.36) : Math.sin((Math.PI * (t - 0.36)) / 0.19));
			const rate = (t: number) => Math.abs(speed(t));
			const tone = mix(seconds, [
				{ signal: osc(seconds, "saw", (t) => 220 * rate(t)), level: 0.5 },
				{ signal: osc(seconds, "saw", (t) => 330 * rate(t)), level: 0.4 },
			]);
			const noise = shape(
				filter(whiteNoise(seconds, random), "bandpass", (t) => 400 + 3000 * rate(t), 1.5),
				(t) => rate(t) ** 0.7,
			);
			const layered = mix(seconds, [
				{ signal: filter(tone, "lowpass", 2500, 0.8), level: 0.6 },
				{ signal: noise, level: 0.8 },
			]);
			return drive(gain(layered, 1.2), 1.5);
		},
	},
	// ---- pack 1.1 (sound-voice-v2 agent, 2026-10-20): hits that land ON a cut, and the explainer / collage foley the
	// recreations had to fake (SUMMARY gap 7). Same rules: synthesized here, seeded, no samples.
	{
		id: "whoosh-hit",
		name: "Whoosh hit",
		category: "whoosh",
		tags: ["whoosh", "hit", "cut", "transition", "swipe", "knock", "punch"],
		roles: ["cut", "transition"],
		sync: "peak",
		target_lufs_m: -19,
		description: "An air whoosh that rises into a tight knock: the knock (its loudest moment) lands ON the cut, so the cut is heard, not just swept past.",
		render: () => {
			const seconds = 0.55;
			const at = 0.28;
			const random = rng(120);
			const air = shape(whoosh(at + 0.02, 0.98, 350, 2600, 2400, 121), (t) => (t < at ? 1 : Math.max(0, 1 - (t - at) / 0.02)));
			const knock = mix(seconds - at, [
				{ signal: shape(osc(seconds - at, "sine", glide(190, 70, 0.05)), attackDecay(0.0008, 0.07)), level: 1 },
				{ signal: shape(filter(whiteNoise(seconds - at, random), "bandpass", 1300, 1.2), attackDecay(0.0004, 0.025)), level: 0.7 },
				{ signal: shape(filter(whiteNoise(seconds - at, random), "highpass", 4500, 0.7), attackDecay(0.0002, 0.004)), level: 0.35 },
			]);
			return mix(seconds, [
				{ signal: air, level: 0.42 },
				{ signal: drive(withRoom(knock, 0.35, 0.18, 0.5), 1.6), at, level: 1 },
			]);
		},
	},
	{
		id: "swish-hit",
		name: "Swish hit",
		category: "whoosh",
		tags: ["swish", "hit", "cut", "fast", "light", "tick", "swipe"],
		roles: ["cut"],
		sync: "peak",
		target_lufs_m: -21,
		description: "A thin fast swish that ends on a dry click on the cut: the lighter partner of Whoosh hit for quick cuts.",
		render: () => {
			const seconds = 0.32;
			const at = 0.16;
			const random = rng(122);
			const swish = shape(
				filter(filter(whiteNoise(at + 0.01, random), "highpass", 1800, 0.7), "bandpass", glide(2600, 7800, at), 1.4),
				(t) => (t < at ? (t / at) ** 2 : Math.max(0, 1 - (t - at) / 0.01)),
			);
			const click = mix(seconds - at, [
				{ signal: shape(filter(whiteNoise(seconds - at, random), "bandpass", 3400, 1.6), attackDecay(0.0003, 0.008)), level: 1 },
				{ signal: shape(osc(seconds - at, "sine", glide(900, 300, 0.03)), attackDecay(0.0006, 0.02)), level: 0.7 },
			]);
			return mix(seconds, [
				{ signal: swish, level: 0.45 },
				{ signal: withRoom(click, 0.25, 0.12, 0.5), at, level: 1 },
			]);
		},
	},
	{
		id: "marker-scribble",
		name: "Marker scribble",
		category: "foley",
		tags: ["marker", "scribble", "pen", "draw", "underline", "circle", "highlight", "doodle", "strike", "foley"],
		roles: ["foley", "accent"],
		sync: "onset",
		target_lufs_m: -24,
		description: "A felt-tip marker drawn fast on paper (four strokes): for underlines, circles, strikes and hand-drawn arrows.",
		render: () => {
			const seconds = 0.85;
			const random = rng(123);
			const out = buffer(seconds);
			let at = 0;
			for (let stroke = 0; stroke < 4; stroke++) {
				const length = 0.12 + random() * 0.08;
				const squeak = 1700 + random() * 1300;
				const felt = filter(filter(whiteNoise(length, random), "highpass", 1200, 0.7), "bandpass", (t) => squeak * (1 + 0.35 * Math.sin((Math.PI * t) / length)), 3.2);
				const grain = modulate(felt, smoothRandom(length, 90, random), 0.6);
				const body = filter(pinkNoise(length, random), "bandpass", 900, 0.9);
				const envelope = (t: number) => (t < 0.006 ? t / 0.006 : 1) * Math.min(1, (length - t) / 0.03) * (0.8 + 0.2 * Math.sin((Math.PI * t) / length));
				mixInto(out, shape(mix(length, [{ signal: grain, level: 1 }, { signal: body, level: 0.35 }]), envelope), at, 0.75 + random() * 0.25);
				at += length + 0.03 + random() * 0.04;
				if (at > seconds - 0.12) break;
			}
			return out;
		},
	},
	{
		id: "stamp-slam",
		name: "Stamp slam",
		category: "hit",
		tags: ["stamp", "slam", "rubber", "approve", "reject", "thud", "desk", "paper", "seal"],
		roles: ["hit", "accent"],
		sync: "onset",
		target_lufs_m: -18,
		description: "A rubber stamp slammed on a desk: a low thump, a paper slap and the wood under it. For stamps, seals, verdicts.",
		render: () => {
			const seconds = 0.6;
			const random = rng(124);
			const dry = mix(seconds, [
				{ signal: shape(osc(seconds, "sine", glide(120, 52, 0.07)), attackDecay(0.0008, 0.11)), level: 1 },
				{ signal: shape(filter(whiteNoise(seconds, random), "bandpass", 1600, 0.9), attackDecay(0.0003, 0.035)), level: 0.8 },
				{ signal: shape(filter(whiteNoise(seconds, random), "bandpass", 420, 3), attackDecay(0.001, 0.06)), level: 0.55 },
				{ signal: shape(filter(whiteNoise(seconds, random), "highpass", 5000, 0.7), attackDecay(0.0002, 0.003)), level: 0.25 },
			]);
			return drive(withRoom(dry, 0.45, 0.22, 0.45), 2);
		},
	},
	{
		id: "tape-stop",
		name: "Tape stop",
		category: "scratch",
		tags: ["tape", "stop", "slowdown", "power-down", "brake", "halt", "record", "wind-down", "pause"],
		roles: ["accent", "transition"],
		sync: "onset",
		target_lufs_m: -22,
		description: "A tape machine braking to a stop (pitch and speed fall to nothing over 0.7 s): for 'wait —' moments, freezes and the end of a loop.",
		render: () => {
			const seconds = 0.8;
			const stopAt = 0.7;
			const random = rng(125);
			const rate = (t: number) => Math.max(0, 1 - t / stopAt) ** 1.6;
			const pitch = (base: number) => (t: number) => base * rate(t) + 0.5;
			const chord = mix(seconds, [
				{ signal: osc(seconds, "saw", pitch(220)), level: 0.45 },
				{ signal: osc(seconds, "saw", pitch(277.2)), level: 0.35 },
				{ signal: osc(seconds, "saw", pitch(329.6)), level: 0.3 },
				{ signal: osc(seconds, "sine", pitch(110)), level: 0.6 },
			]);
			const dark = filter(chord, "lowpass", (t) => 200 + 3800 * rate(t), 0.9);
			const hiss = filter(whiteNoise(seconds, random), "bandpass", (t) => 500 + 4000 * rate(t), 0.8);
			const layered = mix(seconds, [
				{ signal: dark, level: 1 },
				{ signal: hiss, level: 0.18 },
			]);
			return shape(layered, (t) => (t < 0.004 ? t / 0.004 : 1) * Math.sqrt(rate(t)));
		},
	},
	{
		id: "typing-burst",
		name: "Typing burst",
		category: "foley",
		tags: ["typing", "keyboard", "keys", "laptop", "type-on", "code", "prompt", "terminal", "text", "foley"],
		roles: ["foley", "text_in"],
		sync: "onset",
		target_lufs_m: -24,
		description: "A quick laptop-keyboard burst (about a dozen keys and a space bar in 0.9 s): for type-on text, prompts and code.",
		render: () => {
			const seconds = 1.0;
			const random = rng(126);
			const key = (space: boolean): Signal => {
				const length = 0.06;
				return mix(length, [
					{ signal: shape(filter(whiteNoise(length, random), "bandpass", space ? 1400 : 2600 + random() * 1600, 1.4), attackDecay(0.0003, space ? 0.008 : 0.004)), level: 1 },
					{ signal: shape(osc(length, "sine", glide(space ? 210 : 320 + random() * 80, space ? 140 : 220, 0.012)), attackDecay(0.0006, space ? 0.016 : 0.009)), level: space ? 0.8 : 0.45 },
					{ signal: shape(filter(whiteNoise(length, random), "highpass", 6000, 0.7), attackDecay(0.0002, 0.0015)), at: 0.003, level: 0.3 },
				]);
			};
			const out = buffer(seconds);
			let at = 0.001;
			for (let i = 0; i < 14 && at < seconds - 0.08; i++) {
				const space = i === 5 || i === 10;
				mixInto(out, key(space), at, 0.7 + random() * 0.3);
				at += 0.05 + random() * 0.04;
			}
			return withRoom(out, 0.2, 0.1, 0.5);
		},
	},
	{
		id: "paper-slide",
		name: "Paper slide",
		category: "foley",
		tags: ["paper", "slide", "swipe", "card", "collage", "cutout", "sheet", "page", "cut", "foley"],
		roles: ["foley", "transition", "cut"],
		sync: "peak",
		target_lufs_m: -22,
		description: "A sheet of paper slid across paper that lands with a soft tap: the tap (its loudest moment) on the cut. For collage cuts and cards sliding in.",
		render: () => {
			const seconds = 0.6;
			const at = 0.32;
			const random = rng(127);
			const friction = modulate(
				filter(filter(whiteNoise(at + 0.02, random), "highpass", 900, 0.7), "bandpass", glide(1400, 3600, at), 0.9),
				smoothRandom(at + 0.02, 60, random),
				0.7,
			);
			const slide = shape(friction, (t) => (t < at ? (t / at) ** 1.6 : Math.max(0, 1 - (t - at) / 0.02)));
			const tap = mix(seconds - at, [
				{ signal: shape(osc(seconds - at, "sine", glide(170, 110, 0.03)), attackDecay(0.0008, 0.03)), level: 1 },
				{ signal: shape(filter(whiteNoise(seconds - at, random), "bandpass", 2400, 1.1), attackDecay(0.0003, 0.012)), level: 0.9 },
			]);
			return mix(seconds, [
				{ signal: slide, level: 0.4 },
				{ signal: withRoom(tap, 0.3, 0.12, 0.5), at, level: 1 },
			]);
		},
	},
];
