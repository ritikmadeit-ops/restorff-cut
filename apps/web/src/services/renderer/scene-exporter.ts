import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { FrameRate } from "restorffcut-wasm";
import { mediaTimeToSeconds } from "restorffcut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportLoudnessReport, ExportQuality } from "@/export";
import type { LoudnessTargetSpec } from "@/audio/loudness";
import { masterForExport, measureEncodedAudio } from "@/audio/master";
import { CanvasRenderer } from "./canvas-renderer";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	/** Restorff: encode at this size (the scene still renders at width × height). */
	outputWidth?: number;
	outputHeight?: number;
	fit?: "contain" | "cover";
	/** Colour behind letterbox bars. */
	letterboxColor?: string;
	videoBitrate?: number;
	audioBitrate?: number;
	/** Master the audio to this target, measured on the encoded audio; null = untouched. */
	loudness?: LoudnessTargetSpec | null;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

type AudioBitrate = ConstructorParameters<typeof AudioBufferSource>[0]["bitrate"];

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [buffer: ArrayBuffer];
	error: [error: Error];
	cancelled: [];
};

function createEncodeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
	if (typeof document !== "undefined") {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		return canvas;
	}
	return new OffscreenCanvas(width, height);
}

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;
	private outputWidth: number;
	private outputHeight: number;
	private fit: "contain" | "cover";
	private letterboxColor: string;
	private videoBitrate?: number;
	private audioBitrate?: number;
	private loudness: LoudnessTargetSpec | null;

	private isCancelled = false;

	/** Set after `export()` when audio was mastered. */
	loudnessReport: ExportLoudnessReport | null = null;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		outputWidth,
		outputHeight,
		fit,
		letterboxColor,
		videoBitrate,
		audioBitrate,
		loudness,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
		// Encoders want even dimensions.
		this.outputWidth = Math.max(2, Math.round((outputWidth ?? width) / 2) * 2);
		this.outputHeight = Math.max(2, Math.round((outputHeight ?? height) / 2) * 2);
		this.fit = fit ?? "contain";
		this.letterboxColor = letterboxColor ?? "#000000";
		this.videoBitrate = videoBitrate;
		this.audioBitrate = audioBitrate;
		this.loudness = loudness ?? null;
	}

	cancel(): void {
		this.isCancelled = true;
	}

	private needsResample(): boolean {
		return (
			this.outputWidth !== this.renderer.width ||
			this.outputHeight !== this.renderer.height
		);
	}

	/** Draws the compositor's frame into the encode canvas, fitted (letterbox or crop). */
	private drawIntoEncodeCanvas(target: HTMLCanvasElement | OffscreenCanvas): void {
		const context = target.getContext("2d") as
			| CanvasRenderingContext2D
			| OffscreenCanvasRenderingContext2D
			| null;
		if (!context) throw new Error("Failed to get a 2d context for the encode canvas");
		const source = this.renderer.getOutputCanvas();
		const { width: sw, height: sh } = this.renderer;
		const scale =
			this.fit === "cover"
				? Math.max(this.outputWidth / sw, this.outputHeight / sh)
				: Math.min(this.outputWidth / sw, this.outputHeight / sh);
		const dw = sw * scale;
		const dh = sh * scale;
		context.fillStyle = this.letterboxColor;
		context.fillRect(0, 0, this.outputWidth, this.outputHeight);
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = "high";
		context.drawImage(source, (this.outputWidth - dw) / 2, (this.outputHeight - dh) / 2, dw, dh);
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);

		const outputFormat =
			this.format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat();

		const output = new Output({
			format: outputFormat,
			target: new BufferTarget(),
		});

		const encodeCanvas = this.needsResample()
			? createEncodeCanvas(this.outputWidth, this.outputHeight)
			: null;
		const videoSource = new CanvasSource(
			encodeCanvas ?? this.renderer.getOutputCanvas(),
			{
				codec: this.format === "webm" ? "vp9" : "avc",
				bitrate: this.videoBitrate ?? qualityMap[this.quality],
			},
		);

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		let audioSource: AudioBufferSource | null = null;
		let audioBuffer = this.audioBuffer;
		if (this.shouldIncludeAudio && audioBuffer) {
			let audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: audioBuffer.sampleRate,
					numberOfChannels: audioBuffer.numberOfChannels,
					bitrate: 192000,
				});
				if (!supported) audioCodec = "opus";
			}

			const audioBitrate: AudioBitrate = this.audioBitrate ?? qualityMap[this.quality];
			if (this.loudness) {
				const mastered = await masterForExport({
					audioBuffer,
					target: this.loudness,
					encode: {
						container: this.format === "webm" ? "webm" : "mp4",
						codec: audioCodec,
						bitrate: audioBitrate,
					},
				});
				audioBuffer = mastered.buffer;
				const { report } = mastered;
				this.loudnessReport = {
					target: report.target,
					input: {
						integratedLufs: report.input.integratedLufs,
						truePeakDb: report.input.truePeakDb,
						loudnessRangeLu: report.input.loudnessRangeLu,
					},
					output: report.encoded
						? {
								integratedLufs: report.encoded.integratedLufs,
								truePeakDb: report.encoded.truePeakDb,
								loudnessRangeLu: report.encoded.loudnessRangeLu,
							}
						: null,
					gainDb: report.gainDb,
					limitedSamples: report.limitedSamples,
					pass: report.pass,
				};
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: audioBitrate,
			});
			output.addAudioTrack(audioSource);
		}

		await output.start();

		if (audioSource && audioBuffer) {
			await audioSource.add(audioBuffer);
			audioSource.close();
		}

		for (let i = 0; i < frameCount; i++) {
			if (this.isCancelled) {
				await output.cancel();
				this.emit("cancelled");
				return null;
			}

			const timeTicks = i * ticksPerFrame;
			const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
			await this.renderer.render({ node: rootNode, time: timeTicks });
			if (encodeCanvas) this.drawIntoEncodeCanvas(encodeCanvas);
			await videoSource.add(timeSeconds, 1 / fpsFloat);

			this.emit("progress", i / frameCount);
		}

		if (this.isCancelled) {
			await output.cancel();
			this.emit("cancelled");
			return null;
		}

		videoSource.close();
		await output.finalize();
		this.emit("progress", 1);

		const buffer = output.target.buffer;
		if (!buffer) {
			this.emit("error", new Error("Failed to export video"));
			return null;
		}

		// Re-measure the finished file: the gate judges the encoded master, not the mix.
		if (this.loudnessReport) {
			try {
				const final = await measureEncodedAudio(buffer);
				if (final) {
					this.loudnessReport.output = {
						integratedLufs: final.integratedLufs,
						truePeakDb: final.truePeakDb,
						loudnessRangeLu: final.loudnessRangeLu,
					};
					this.loudnessReport.pass =
						Math.abs(final.integratedLufs - this.loudnessReport.target.integratedLufs) <= 1 &&
						final.truePeakDb <= this.loudnessReport.target.truePeakDb + 0.05;
				}
			} catch (error) {
				console.warn("Could not re-measure the exported audio", error);
			}
		}

		this.emit("complete", buffer);
		return buffer;
	}
}
