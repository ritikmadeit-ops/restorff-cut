import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import type { MediaAsset } from "@/media/types";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "./audio";

/**
 * One media file's audio as mono Float32 at the transcriber's rate (16 kHz), in SOURCE time (sample 0 = the file's
 * start), so word timings are source seconds and map onto any clip that uses the file.
 * Video files go through mediabunny (any container the editor imports); audio files through decodeAudioData.
 */
export async function decodeMediaAudioForTranscription({
	asset,
	sampleRate = DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
}: {
	asset: MediaAsset;
	sampleRate?: number;
}): Promise<Float32Array> {
	const chunks: AudioBuffer[] = [];
	let nativeRate = 0;

	if (asset.type === "audio") {
		const context = new OfflineAudioContext(1, 1, 44100);
		const decoded = await context.decodeAudioData(await asset.file.arrayBuffer());
		chunks.push(decoded);
		nativeRate = decoded.sampleRate;
	} else {
		const input = new Input({ source: new BlobSource(asset.file), formats: ALL_FORMATS });
		try {
			const track = await input.getPrimaryAudioTrack();
			if (!track) throw new Error(`"${asset.name}" has no audio track`);
			const sink = new AudioBufferSink(track);
			for await (const { buffer } of sink.buffers(0)) {
				chunks.push(buffer);
				nativeRate = buffer.sampleRate;
			}
		} finally {
			input.dispose();
		}
	}
	if (!chunks.length || !nativeRate) throw new Error(`no audio decoded from "${asset.name}"`);

	// mix down to mono at the native rate
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const mono = new Float32Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		const channels = chunk.numberOfChannels;
		for (let channel = 0; channel < channels; channel++) {
			const data = chunk.getChannelData(channel);
			for (let i = 0; i < chunk.length; i++) mono[offset + i] += data[i] / channels;
		}
		offset += chunk.length;
	}
	if (nativeRate === sampleRate) return mono;

	// resample with an OfflineAudioContext
	const outputLength = Math.max(1, Math.ceil((total * sampleRate) / nativeRate));
	const offline = new OfflineAudioContext(1, outputLength, sampleRate);
	const source = offline.createBuffer(1, total, nativeRate);
	source.copyToChannel(mono, 0);
	const node = offline.createBufferSource();
	node.buffer = source;
	node.connect(offline.destination);
	node.start(0);
	const rendered = await offline.startRendering();
	return rendered.getChannelData(0).slice();
}
