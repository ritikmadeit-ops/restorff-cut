"use client";

// Headless render page (spike S2). Loads a render job (job.json + project.json + media files served by
// /api/render-jobs/<job>/...) straight into the editor core — no IndexedDB, no editor UI — and runs the editor's OWN
// export (`editor.project.export` → RendererManager.exportProject → SceneExporter: wasm compositor + mediabunny
// WebCodecs). A driver (scripts/render/render.ts) talks to it through `window.__restorffcutRender`.
// Runbook: docs/restorff/PIPELINE.md.
//
// Thin wrapper by design: nothing in services/renderer or export is changed (those belong to the media agent).
import { useEffect, useRef, useState } from "react";
import { EditorCore } from "@/core";
import {
	initializeGpuRenderer,
	isGpuAvailable,
} from "@/services/renderer/gpu-renderer";
import { loadFonts } from "@/fonts/google-fonts";
import { getElementFontFamilies } from "@/timeline/element-utils";
import type { TProject } from "@/project/types";
import type { TScene } from "@/timeline/types";
import type { MediaAsset, MediaType } from "@/media/types";
import type { ExportFormat, ExportQuality } from "@/export";

type JobMedia = {
	id: string;
	file: string;
	type: MediaType;
	name?: string;
	width?: number;
	height?: number;
	/** Seconds. */
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
};

type RenderJob = {
	schema: string;
	project: string;
	media: JobMedia[];
	export?: { format?: ExportFormat; quality?: ExportQuality };
};

type StartOptions = {
	format?: ExportFormat;
	quality?: ExportQuality;
	includeAudio?: boolean;
};

type RenderSummary = {
	ok: boolean;
	error?: string;
	bytes?: number;
	mime?: string;
	format?: ExportFormat;
	quality?: ExportQuality;
	renderMs?: number;
	durationSeconds?: number;
	frames?: number;
};

type RenderEnv = {
	userAgent: string;
	hardwareConcurrency: number;
	webgl2: boolean;
	webgl2Renderer: string | null;
	webgpu: boolean;
	gpuEffectsAvailable: boolean;
	videoEncoderAvc1080x1920: boolean | null;
	videoEncoderAvcHardware: boolean | null;
	audioEncoderAac: boolean | null;
	videoDecoderVp9: boolean | null;
	audioDecoderAac: boolean | null;
};

type RenderApi = {
	job: string;
	state: "loading" | "ready" | "rendering" | "done" | "error";
	ready: boolean;
	error: string | null;
	progress: number;
	loadMs: number | null;
	info: {
		projectName: string;
		width: number;
		height: number;
		fps: number;
		durationSeconds: number;
		media: number;
		elements: number;
	} | null;
	result: RenderSummary | null;
	start: (options?: StartOptions) => Promise<RenderSummary>;
	env: () => Promise<RenderEnv>;
	/** Base64 of result bytes [offset, offset + length). */
	chunk: (offset: number, length: number) => Promise<string>;
};

declare global {
	interface Window {
		__restorffcutRender?: RenderApi;
	}
}

const TICKS_PER_SECOND = 120_000;

function reviveProject(raw: TProject): TProject {
	// project.json is the serialized form (ISO dates); the editor core holds Date objects.
	const toDate = (value: unknown) =>
		value instanceof Date ? value : new Date(String(value ?? Date.now()));
	return {
		...raw,
		metadata: {
			...raw.metadata,
			createdAt: toDate(raw.metadata.createdAt),
			updatedAt: toDate(raw.metadata.updatedAt),
		},
		scenes: raw.scenes.map(
			(scene): TScene => ({
				...scene,
				createdAt: toDate(scene.createdAt),
				updatedAt: toDate(scene.updatedAt),
			}),
		),
	};
}

async function probeEnv(): Promise<RenderEnv> {
	const canvas = document.createElement("canvas");
	const gl = canvas.getContext("webgl2");
	let renderer: string | null = null;
	if (gl) {
		const debug = gl.getExtension("WEBGL_debug_renderer_info");
		renderer = String(
			gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
		);
	}
	const supported = async (
		fn: () => Promise<{ supported?: boolean }>,
	): Promise<boolean | null> => {
		try {
			return !!(await fn()).supported;
		} catch {
			return null;
		}
	};
	const hasVideoEncoder = typeof VideoEncoder !== "undefined";
	const hasAudioEncoder = typeof AudioEncoder !== "undefined";
	return {
		userAgent: navigator.userAgent,
		hardwareConcurrency: navigator.hardwareConcurrency,
		webgl2: !!gl,
		webgl2Renderer: renderer,
		webgpu: "gpu" in navigator,
		gpuEffectsAvailable: isGpuAvailable(),
		videoEncoderAvc1080x1920: hasVideoEncoder
			? await supported(() =>
					VideoEncoder.isConfigSupported({
						codec: "avc1.640033",
						width: 1080,
						height: 1920,
						bitrate: 8_000_000,
						framerate: 30,
					}),
				)
			: null,
		videoEncoderAvcHardware: hasVideoEncoder
			? await supported(() =>
					VideoEncoder.isConfigSupported({
						codec: "avc1.640033",
						width: 1080,
						height: 1920,
						bitrate: 8_000_000,
						framerate: 30,
						hardwareAcceleration: "prefer-hardware",
					}),
				)
			: null,
		audioEncoderAac: hasAudioEncoder
			? await supported(() =>
					AudioEncoder.isConfigSupported({
						codec: "mp4a.40.2",
						sampleRate: 48000,
						numberOfChannels: 2,
						bitrate: 192000,
					}),
				)
			: null,
		videoDecoderVp9:
			typeof VideoDecoder !== "undefined"
				? await supported(() =>
						VideoDecoder.isConfigSupported({ codec: "vp09.00.40.08" }),
					)
				: null,
		audioDecoderAac:
			typeof AudioDecoder !== "undefined"
				? await supported(() =>
						AudioDecoder.isConfigSupported({
							codec: "mp4a.40.2",
							sampleRate: 44100,
							numberOfChannels: 2,
						}),
					)
				: null,
	};
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			resolve(url.slice(url.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

export function RenderJobRunner({ job }: { job: string }) {
	const [status, setStatus] = useState("loading");
	const [progress, setProgress] = useState(0);
	const started = useRef(false);

	useEffect(() => {
		if (started.current) return;
		started.current = true;

		let resultBlob: Blob | null = null;
		const api: RenderApi = {
			job,
			state: "loading",
			ready: false,
			error: null,
			progress: 0,
			loadMs: null,
			info: null,
			result: null,
			start: async () => ({ ok: false, error: "not ready" }),
			env: probeEnv,
			chunk: async (offset, length) => {
				if (!resultBlob) throw new Error("no result yet");
				return blobToBase64(resultBlob.slice(offset, offset + length));
			},
		};
		window.__restorffcutRender = api;
		const fail = (error: unknown) => {
			api.state = "error";
			api.error = error instanceof Error ? error.message : String(error);
			setStatus(`error: ${api.error}`);
		};

		const base = `/api/render-jobs/${encodeURIComponent(job)}`;
		const t0 = performance.now();

		(async () => {
			const editor = EditorCore.getInstance();
			// Never write this throwaway project to the browser's IndexedDB.
			editor.save.pause();
			await initializeGpuRenderer();
			editor.renderer.setDegraded(!isGpuAvailable());

			const jobResponse = await fetch(`${base}/job.json`, { cache: "no-store" });
			if (!jobResponse.ok) {
				throw new Error(`job.json: HTTP ${jobResponse.status} ${await jobResponse.text()}`);
			}
			const spec = (await jobResponse.json()) as RenderJob;
			const projectResponse = await fetch(`${base}/${spec.project}`, { cache: "no-store" });
			if (!projectResponse.ok) {
				throw new Error(`${spec.project}: HTTP ${projectResponse.status}`);
			}
			const project = reviveProject((await projectResponse.json()) as TProject);

			const assets: MediaAsset[] = await Promise.all(
				spec.media.map(async (media) => {
					const response = await fetch(
						`${base}/${media.file.split("/").map(encodeURIComponent).join("/")}`,
						{ cache: "no-store" },
					);
					if (!response.ok) throw new Error(`${media.file}: HTTP ${response.status}`);
					const blob = await response.blob();
					const file = new File([blob], media.name ?? media.file.split("/").pop() ?? media.id, {
						type: blob.type,
					});
					return {
						id: media.id,
						name: file.name,
						type: media.type,
						width: media.width,
						height: media.height,
						duration: media.duration,
						fps: media.fps,
						hasAudio: media.hasAudio,
						file,
						url: URL.createObjectURL(file),
					};
				}),
			);

			editor.project.setActiveProject({ project });
			editor.scenes.initializeScenes({
				scenes: project.scenes,
				currentSceneId: project.currentSceneId,
			});
			editor.media.setAssets({ assets });
			await loadFonts({
				families: [
					...new Set(
						project.scenes.flatMap((scene) =>
							getElementFontFamilies({ tracks: scene.tracks }),
						),
					),
				],
			});

			const scene = editor.scenes.getActiveScene();
			const tracks = [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio];
			const durationTicks = editor.timeline.getTotalDuration();
			const fps = project.settings.fps.numerator / project.settings.fps.denominator;
			api.info = {
				projectName: project.metadata.name,
				width: project.settings.canvasSize.width,
				height: project.settings.canvasSize.height,
				fps,
				durationSeconds: durationTicks / TICKS_PER_SECOND,
				media: assets.length,
				elements: tracks.reduce((sum, track) => sum + track.elements.length, 0),
			};

			api.start = async (options: StartOptions = {}) => {
				if (api.state === "rendering") return { ok: false, error: "already rendering" };
				const format = options.format ?? spec.export?.format ?? "mp4";
				const quality = options.quality ?? spec.export?.quality ?? "high";
				api.state = "rendering";
				api.progress = 0;
				api.result = null;
				resultBlob = null;
				setStatus("rendering");
				const unsubscribe = editor.project.subscribe(() => {
					const value = editor.project.getExportState().progress;
					api.progress = value;
					setProgress(value);
				});
				const started = performance.now();
				try {
					const result = await editor.project.export({
						options: { format, quality, includeAudio: options.includeAudio ?? true },
					});
					const renderMs = Math.round(performance.now() - started);
					if (!result.success || !result.buffer) {
						api.state = "error";
						api.error = result.error ?? (result.cancelled ? "cancelled" : "export failed");
						api.result = { ok: false, error: api.error, renderMs };
						setStatus(`error: ${api.error}`);
						return api.result;
					}
					const mime = format === "webm" ? "video/webm" : "video/mp4";
					resultBlob = new Blob([result.buffer], { type: mime });
					api.state = "done";
					api.progress = 1;
					api.result = {
						ok: true,
						bytes: result.buffer.byteLength,
						mime,
						format,
						quality,
						renderMs,
						durationSeconds: api.info?.durationSeconds,
						frames: Math.floor((api.info?.durationSeconds ?? 0) * fps),
					};
					setStatus("done");
					return api.result;
				} catch (error) {
					fail(error);
					api.result = { ok: false, error: api.error ?? "export threw" };
					return api.result;
				} finally {
					unsubscribe();
				}
			};

			api.loadMs = Math.round(performance.now() - t0);
			api.state = "ready";
			api.ready = true;
			setStatus("ready");
		})().catch(fail);
	}, [job]);

	return (
		<main
			style={{
				minHeight: "100vh",
				background: "#0C0C0E",
				color: "#EDEBE6",
				fontFamily: "var(--font-jetbrains-mono), monospace",
				fontSize: 13,
				padding: 24,
			}}
		>
			<div style={{ letterSpacing: "0.14em", textTransform: "uppercase", color: "#8C8C95" }}>
				RestorffCut · headless render
			</div>
			<div style={{ marginTop: 12 }}>job {job}</div>
			<div data-render-status={status} style={{ marginTop: 4 }}>
				{status} · {Math.round(progress * 100)}%
			</div>
		</main>
	);
}
