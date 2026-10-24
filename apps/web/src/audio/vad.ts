/**
 * Voice activity from a mono/stereo voice mix: 20 ms frames, an adaptive threshold
 * (10 dB over the noise floor, at least −50 dBFS, no more than 30 dB under the loud speech
 * level), 150 ms hangover, gaps under 250 ms bridged, blips under 100 ms dropped.
 * Good enough to drive ducking; not a speech recogniser.
 */

export interface VoiceSpan {
	/** Seconds from the start of the analysed audio. */
	start: number;
	end: number;
}

export function detectVoiceSpans(channels: Float32Array[], sampleRate: number): VoiceSpan[] {
	const length = channels[0]?.length ?? 0;
	const frame = Math.max(1, Math.round(sampleRate * 0.02));
	const frames = Math.floor(length / frame);
	if (frames === 0) return [];
	const levels = new Float64Array(frames);
	for (let f = 0; f < frames; f++) {
		let sum = 0;
		for (const samples of channels) {
			for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i] * samples[i];
		}
		const meanSquare = sum / (frame * channels.length);
		levels[f] = meanSquare > 0 ? 10 * Math.log10(meanSquare) : -120;
	}
	const audible = [...levels].filter((level) => level > -90).sort((a, b) => a - b);
	if (audible.length === 0) return [];
	const floor = audible[Math.floor(audible.length * 0.1)];
	const loud = audible[Math.floor(audible.length * 0.95)];
	const threshold = Math.max(floor + 10, -50, loud - 30);

	const hangover = Math.round(0.15 / 0.02);
	const active = new Uint8Array(frames);
	let hold = 0;
	for (let f = 0; f < frames; f++) {
		if (levels[f] > threshold) {
			active[f] = 1;
			hold = hangover;
		} else if (hold > 0) {
			active[f] = 1;
			hold--;
		}
	}
	const spans: VoiceSpan[] = [];
	let start = -1;
	for (let f = 0; f <= frames; f++) {
		const on = f < frames && active[f] === 1;
		if (on && start < 0) start = f;
		if (!on && start >= 0) {
			spans.push({ start: (start * frame) / sampleRate, end: (f * frame) / sampleRate });
			start = -1;
		}
	}
	const merged: VoiceSpan[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span.start - last.end < 0.25) last.end = span.end;
		else merged.push({ ...span });
	}
	return merged.filter((span) => span.end - span.start >= 0.1);
}
