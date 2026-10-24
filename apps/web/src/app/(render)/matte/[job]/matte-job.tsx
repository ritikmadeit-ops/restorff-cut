"use client";

// Headless matte page (mcp-cutout agent, 2026-10-20; EDT-22). Opened by src/server/matte-driver.ts in headless
// Chromium; never by people. Runs, on one media file of the project media store:
//   1. the cutout agent's segmentation worker (`segmentationClient.analyze`: MediaPipe 0.10.35, multiclass selfie
//      model, 15 fps at 256 px, temporal smoothing) — the SAME code the editor's Person tools run;
//   2. MediaPipe's BlazeFace short-range face detector (Apache-2.0) at the same times, 640 px long side;
//   3. the cutout agent's VP9-with-alpha render worker (`renderCutoutVideo`) → person.webm.
// The driver talks to it through `window.__restorffcutMatte`. Nothing here is written to IndexedDB/OPFS.
// Runbook: docs/restorff/worklog/mcp-cutout.md.
import { useEffect, useRef, useState } from "react";
import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { renderCutoutVideo } from "@/cutout/render";
import { segmentationClient } from "@/segmentation/client";
import { getMediapipeWasmBase } from "@/segmentation/config";
import { boxesAt, medianBox } from "@/segmentation/matte";
import type { Box, MatteTrack } from "@/segmentation/types";
import type { FaceDetection, FaceFrame, FaceTrack, MatteSpec } from "@/server/matte";

type MatteResult = {
	ok: boolean;
	webmBytes: number;
	facesChars: number;
	width: number;
	height: number;
	fps: number;
	frames: number;
	duration: number;
	source: { width: number; height: number; duration: number; fps: number };
	range: { start: number; end: number };
	matteFrames: number;
	faceFrames: number;
	timings: Record<string, number>;
	env: Record<string, unknown>;
};

type MatteApi = {
	job: string;
	state: "loading" | "ready" | "running" | "done" | "error";
	phase: string;
	progress: number;
	done: number;
	total: number;
	error: string | null;
	result: MatteResult | null;
	run: (spec: MatteSpec) => Promise<void>;
	/** Base64 of [offset, offset + length) of the person WebM or the faces JSON. */
	chunk: (kind: "webm" | "faces", offset: number, length: number) => Promise<string>;
};

declare global {
	interface Window {
		__restorffcutMatte?: MatteApi;
	}
}

const r4 = (value: number) => Math.round(value * 10_000) / 10_000;
const box4 = (box: Box | null): Box | null => (box ? [r4(box[0]), r4(box[1]), r4(box[2]), r4(box[3])] : null);

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

function webglRenderer(): string | null {
	try {
		const gl = document.createElement("canvas").getContext("webgl2");
		if (!gl) return null;
		const debug = gl.getExtension("WEBGL_debug_renderer_info");
		return String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
	} catch {
		return null;
	}
}

async function createFaceDetector(modelUrl: string): Promise<{ detector: FaceDetector; delegate: "GPU" | "CPU" }> {
	// Classic loader files, like the segmentation worker (segmentation/worker.ts).
	const fileset = await FilesetResolver.forVisionTasks(getMediapipeWasmBase(), false);
	try {
		const detector = await FaceDetector.createFromOptions(fileset, {
			baseOptions: { modelAssetPath: modelUrl, delegate: "GPU" },
			runningMode: "IMAGE",
			minDetectionConfidence: 0.5,
		});
		return { detector, delegate: "GPU" };
	} catch (error) {
		console.warn("[matte] face detector GPU delegate failed, using CPU", error);
		const detector = await FaceDetector.createFromOptions(fileset, {
			baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
			runningMode: "IMAGE",
			minDetectionConfidence: 0.5,
		});
		return { detector, delegate: "CPU" };
	}
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

function medianOf(boxes: Box[]): Box | null {
	if (!boxes.length) return null;
	return [0, 1, 2, 3].map((i) => median(boxes.map((box) => box[i]))) as Box;
}

export function MatteJobRunner({ job }: { job: string }) {
	const [status, setStatus] = useState("loading");
	const started = useRef(false);

	useEffect(() => {
		if (started.current) return;
		started.current = true;
		const blobs: { webm: Blob | null; faces: Blob | null } = { webm: null, faces: null };

		const api: MatteApi = {
			job,
			state: "loading",
			phase: "loading",
			progress: 0,
			done: 0,
			total: 0,
			error: null,
			result: null,
			chunk: async (kind, offset, length) => {
				const blob = blobs[kind];
				if (!blob) throw new Error(`no ${kind} yet`);
				return blobToBase64(blob.slice(offset, offset + length));
			},
			run: async (spec) => {
				if (api.state === "running") return;
				api.state = "running";
				api.error = null;
				const phase = (name: string, done = 0, total = 0) => {
					api.phase = name;
					api.done = done;
					api.total = total;
					api.progress = total > 0 ? done / total : 0;
					setStatus(`${name} ${done}/${total}`);
				};
				const timings: Record<string, number> = {};
				const clock = () => performance.now();
				try {
					// 0. the file
					phase("fetch");
					let t = clock();
					const response = await fetch(`/matte/${encodeURIComponent(job)}/source`, { cache: "no-store" });
					if (!response.ok) throw new Error(`source: HTTP ${response.status} ${await response.text()}`);
					const blob = await response.blob();
					const file = new File([blob], spec.name || "source", { type: spec.mime || blob.type });
					timings.fetch_ms = Math.round(clock() - t);

					const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
					const track = await input.getPrimaryVideoTrack();
					if (!track) throw new Error("no video track in this media");
					if (!(await track.canDecode())) throw new Error("headless Chromium cannot decode this video codec");
					const mediaDuration = await input.computeDuration();
					const stats = await track.computePacketStats(240);
					const sourceFps = stats.averagePacketRate > 0 ? stats.averagePacketRate : 30;
					const source = {
						width: track.displayWidth,
						height: track.displayHeight,
						duration: r4(mediaDuration),
						fps: Math.round(sourceFps * 1000) / 1000,
					};
					const start = Math.max(0, Math.min(spec.start, mediaDuration));
					const end = Math.min(mediaDuration, spec.end && spec.end > start ? spec.end : mediaDuration, start + spec.max_seconds);
					if (!(end > start)) throw new Error(`empty range [${start}, ${end}] (media is ${mediaDuration.toFixed(2)} s)`);

					// 1. person matte (the editor's segmentation worker, unchanged)
					phase("segment-model");
					t = clock();
					let firstFrameAt = 0;
					const matte: MatteTrack = await segmentationClient.analyze({
						file,
						start,
						end,
						fps: spec.matte_fps,
						model: "multiclass",
						keepAlpha: true,
						onProgress: ({ done, total, phase: p }) => {
							if (p === "segment") {
								if (!firstFrameAt) firstFrameAt = clock();
								phase("segment", done, total);
							}
						},
					});
					const segmentEnd = clock();
					timings.segment_model_ms = Math.round((firstFrameAt || segmentEnd) - t);
					timings.segment_ms = Math.round(segmentEnd - (firstFrameAt || t));
					const segmenterDelegate = segmentationClient.delegate ?? "unknown";

					// 2. faces at the matte's times
					phase("faces-model");
					t = clock();
					const { detector, delegate: detectorDelegate } = await createFaceDetector(spec.face_model_url);
					timings.faces_model_ms = Math.round(clock() - t);
					t = clock();
					const times = matte.header.times;
					const scale = Math.min(1, spec.face_long_side / Math.max(source.width, source.height));
					const fw = Math.max(16, Math.round(source.width * scale));
					const fh = Math.max(16, Math.round(source.height * scale));
					const sink = new CanvasSink(track, { width: fw, height: fh, fit: "fill" });
					const detections: FaceDetection[][] = [];
					let index = 0;
					for await (const wrapped of sink.canvasesAtTimestamps(times.map((time) => time + 0.0005))) {
						let faces: FaceDetection[] = detections[index - 1] ?? [];
						if (wrapped) {
							const result = detector.detect(wrapped.canvas);
							faces = result.detections
								.filter((d) => d.boundingBox)
								.map((d) => {
									const bb = d.boundingBox as { originX: number; originY: number; width: number; height: number };
									const x = Math.max(0, bb.originX / fw);
									const y = Math.max(0, bb.originY / fh);
									return {
										box: box4([x, y, Math.min(1 - x, bb.width / fw), Math.min(1 - y, bb.height / fh)]) as Box,
										score: r4(d.categories?.[0]?.score ?? 0),
										keypoints: (d.keypoints ?? []).map((k) => [r4(k.x), r4(k.y)] as [number, number]),
									};
								})
								.sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]);
						}
						detections.push(faces);
						index++;
						if (index % 5 === 0 || index === times.length) phase("faces", index, times.length);
						if (index >= times.length) break;
					}
					while (detections.length < times.length) detections.push(detections[detections.length - 1] ?? []);
					detector.close();
					timings.faces_ms = Math.round(clock() - t);
					input.dispose();

					// 3. the person as a transparent video (the editor's cutout render worker, unchanged)
					const outFps = Math.max(1, Math.min(spec.out_max_fps, Math.round(sourceFps)));
					phase("encode");
					t = clock();
					const rendered = await renderCutoutVideo({
						file,
						matte,
						start,
						end,
						fps: outFps,
						name: `${spec.name} · person`,
						onProgress: ({ done, total }) => phase("encode", done, total),
					});
					timings.encode_ms = Math.round(clock() - t);

					// 4. the faces file (restorffcut-faces@1)
					const frames: FaceFrame[] = times.map((time, i) => {
						const boxes = boxesAt({ header: matte.header, time });
						return {
							t: r4(time),
							faces: detections[i] ?? [],
							person: box4(boxes.person),
							head: box4(boxes.head),
							face_seg: box4(boxes.face),
							coverage: r4(boxes.coverage),
						};
					});
					const firstFaces = frames.map((frame) => frame.faces[0]?.box).filter((box): box is Box => !!box);
					const track_: FaceTrack = {
						schema: "restorffcut-faces@1",
						media_hash: spec.media_hash,
						source,
						range: { start: r4(start), end: r4(end) },
						fps: spec.matte_fps,
						detector: { name: "blaze_face_short_range", model_url: spec.face_model_url, delegate: detectorDelegate, long_side: Math.max(fw, fh) },
						segmenter: { model: matte.header.model, delegate: segmenterDelegate, long_side: Math.max(matte.header.width, matte.header.height) },
						frames,
						summary: {
							frames: frames.length,
							face_found: r4(firstFaces.length / Math.max(1, frames.length)),
							face: box4(medianOf(firstFaces)),
							head: box4(medianBox({ header: matte.header, kind: "head" })),
							person: box4(medianBox({ header: matte.header, kind: "person" })),
							max_faces: Math.max(0, ...frames.map((frame) => frame.faces.length)),
						},
					};
					blobs.faces = new Blob([JSON.stringify(track_)], { type: "application/json" });
					blobs.webm = rendered.file;
					api.result = {
						ok: true,
						webmBytes: rendered.file.size,
						facesChars: blobs.faces.size,
						width: rendered.width,
						height: rendered.height,
						fps: outFps,
						frames: rendered.frames,
						duration: r4(rendered.duration),
						source,
						range: { start: r4(start), end: r4(end) },
						matteFrames: times.length,
						faceFrames: times.length,
						timings,
						env: {
							webgl2Renderer: webglRenderer(),
							segmenterDelegate,
							detectorDelegate,
							matteSize: `${matte.header.width}x${matte.header.height}`,
							faceSize: `${fw}x${fh}`,
						},
					};
					api.state = "done";
					phase("done", 1, 1);
					setStatus("done");
				} catch (error) {
					api.state = "error";
					api.error = error instanceof Error ? error.message : String(error);
					setStatus(`error: ${api.error}`);
				}
			},
		};
		window.__restorffcutMatte = api;
		api.state = "ready";
		api.phase = "ready";
		setStatus("ready");
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
			<div style={{ letterSpacing: "0.14em", textTransform: "uppercase", color: "#8C8C95" }}>RestorffCut · headless matte</div>
			<div style={{ marginTop: 12 }}>job {job}</div>
			<div data-matte-status={status} style={{ marginTop: 4 }}>
				{status}
			</div>
		</main>
	);
}
