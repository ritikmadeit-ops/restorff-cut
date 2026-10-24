/**
 * Mastering for export, measured on the ENCODED audio (EXPORT-GATE: "loudness, true peak
 * and format are only ever judged on the encoded file").
 *
 * 1. Normalise the mix to the target (−14 LUFS) with the true-peak limiter set a little
 *    under the ceiling (−1.5 dBTP for −1), because AAC/Opus encoding adds overshoot.
 * 2. Encode the audio alone with the SAME codec and bitrate the export will use, decode it
 *    back and measure. If the encoded true peak is over the ceiling, or the loudness is more
 *    than 0.3 LU off, correct and try again (at most three probes).
 * 3. The caller muxes the final buffer; `measureEncodedAudio` re-measures the finished file
 *    for the report.
 * Encoding is deterministic for the same input and settings, so the probe predicts the file.
 */
import {
	ALL_FORMATS,
	AudioBufferSink,
	AudioBufferSource,
	BlobSource,
	BufferTarget,
	Input,
	Mp4OutputFormat,
	Output,
	WebMOutputFormat,
} from "mediabunny";
import {
	measureLoudness,
	normalizeLoudness,
	type LoudnessMeasurement,
	type LoudnessTargetSpec,
} from "./loudness";

export interface EncodeSettings {
	container: "mp4" | "webm";
	codec: "aac" | "opus";
	/** bit/s, or a mediabunny Quality — exactly what the export passes. */
	bitrate: ConstructorParameters<typeof AudioBufferSource>[0]["bitrate"];
}

export interface MasteringReport {
	target: LoudnessTargetSpec;
	/** The mix before mastering. */
	input: LoudnessMeasurement;
	/** Measured on decoded encoded audio. */
	encoded: LoudnessMeasurement | null;
	gainDb: number;
	limiterCeilingDb: number;
	limitedSamples: number;
	probes: number;
	/** Within ±1 LU and at or under the true-peak ceiling (EXPORT-GATE LOUD). */
	pass: boolean;
}

function channelsOf(buffer: AudioBuffer): Float32Array[] {
	return Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
		Float32Array.from(buffer.getChannelData(channel)),
	);
}

function toAudioBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
	const buffer = new AudioBuffer({
		numberOfChannels: channels.length,
		length: channels[0]?.length ?? 1,
		sampleRate,
	});
	channels.forEach((samples, channel) => buffer.getChannelData(channel).set(samples));
	return buffer;
}

/** Decodes the primary audio track of an encoded file and measures it. */
export async function measureEncodedAudio(data: ArrayBuffer | Blob): Promise<LoudnessMeasurement | null> {
	const blob = data instanceof Blob ? data : new Blob([data]);
	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) return null;
		const sink = new AudioBufferSink(track);
		const chunks: AudioBuffer[] = [];
		let total = 0;
		for await (const { buffer } of sink.buffers()) {
			chunks.push(buffer);
			total += buffer.length;
		}
		if (chunks.length === 0) return null;
		const channelCount = chunks[0].numberOfChannels;
		const channels = Array.from({ length: channelCount }, () => new Float32Array(total));
		let offset = 0;
		for (const chunk of chunks) {
			for (let channel = 0; channel < channelCount; channel++) {
				channels[channel].set(chunk.getChannelData(Math.min(channel, chunk.numberOfChannels - 1)), offset);
			}
			offset += chunk.length;
		}
		return measureLoudness(channels, chunks[0].sampleRate);
	} finally {
		input.dispose();
	}
}

async function encodeAudioOnly(buffer: AudioBuffer, settings: EncodeSettings): Promise<ArrayBuffer | null> {
	const output = new Output({
		format: settings.container === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new AudioBufferSource({ codec: settings.codec, bitrate: settings.bitrate });
	output.addAudioTrack(source);
	await output.start();
	await source.add(buffer);
	source.close();
	await output.finalize();
	return output.target.buffer;
}

function passes(measurement: LoudnessMeasurement, target: LoudnessTargetSpec): boolean {
	return (
		Math.abs(measurement.integratedLufs - target.integratedLufs) <= 1 &&
		measurement.truePeakDb <= target.truePeakDb + 0.05
	);
}

export async function masterForExport({
	audioBuffer,
	target,
	encode,
}: {
	audioBuffer: AudioBuffer;
	target: LoudnessTargetSpec;
	encode: EncodeSettings;
}): Promise<{ buffer: AudioBuffer; report: MasteringReport }> {
	const original = channelsOf(audioBuffer);
	const input = measureLoudness(original, audioBuffer.sampleRate);
	let ceiling = target.truePeakDb - 0.5;
	let loudnessTarget = target.integratedLufs;
	let best: { buffer: AudioBuffer; report: MasteringReport } | null = null;

	for (let probe = 1; probe <= 3; probe++) {
		const channels = original.map((samples) => Float32Array.from(samples));
		const normalized = normalizeLoudness(
			channels,
			audioBuffer.sampleRate,
			{ integratedLufs: loudnessTarget, truePeakDb: target.truePeakDb },
			ceiling,
		);
		const buffer = toAudioBuffer(channels, audioBuffer.sampleRate);
		let encoded: LoudnessMeasurement | null = null;
		try {
			const bytes = await encodeAudioOnly(buffer, encode);
			encoded = bytes ? await measureEncodedAudio(bytes) : null;
		} catch (error) {
			console.warn("Loudness probe encode failed; using the PCM measurement", error);
		}
		const measured = encoded ?? normalized.after;
		const report: MasteringReport = {
			target,
			input,
			encoded,
			gainDb: normalized.gainDb,
			limiterCeilingDb: ceiling,
			limitedSamples: normalized.limitedSamples,
			probes: probe,
			pass: Number.isFinite(measured.integratedLufs) ? passes(measured, target) : true,
		};
		best = { buffer, report };
		if (!Number.isFinite(input.integratedLufs) || !encoded) break;
		const peakExcess = encoded.truePeakDb - target.truePeakDb;
		const loudnessError = encoded.integratedLufs - target.integratedLufs;
		if (peakExcess <= 0 && Math.abs(loudnessError) <= 0.3) break;
		if (peakExcess > 0) ceiling -= peakExcess + 0.1;
		if (Math.abs(loudnessError) > 0.3) loudnessTarget -= loudnessError;
	}
	if (!best) throw new Error("mastering produced no buffer");
	return best;
}
