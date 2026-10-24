/**
 * Read a dropped reference folder in the browser (EDT-21): files from a drop (folders walked with
 * webkitGetAsEntry) or a picker, then per file the numbers @restorffcut/styles needs for a style card:
 *   images  one downsampled frame (≤ 64 px), a ≤ 128 px native-resolution centre crop (grain), a thumbnail
 *   videos  duration, frames sampled every 0.5 s over the first 30 s (≤ 32 px, for cuts + motion + palette),
 *           a centre crop from the middle (grain), a thumbnail
 * Nothing leaves the browser. Reference media is third-party: it is studied, never imported into the project.
 */
import type { PixelFrame, ReferenceInput } from "@restorffcut/styles";

export interface DroppedFile {
	file: File;
	/** Top-level folder the file came from, when dropped as a folder. */
	folder?: string;
}

export interface ExtractedReference extends ReferenceInput {
	thumbnail: string;
	size: number;
}

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const VIDEO_RE = /\.(mp4|mov|webm|m4v|mkv)$/i;

function isImage(file: File): boolean {
	return file.type.startsWith("image/") || IMAGE_RE.test(file.name);
}

function isVideo(file: File): boolean {
	return file.type.startsWith("video/") || VIDEO_RE.test(file.name);
}

async function readEntry(entry: FileSystemEntry, folder: string | undefined, out: DroppedFile[], depth = 0): Promise<void> {
	if (depth > 6 || out.length > 400) return;
	if (entry.isFile) {
		const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
		out.push({ file, folder });
		return;
	}
	if (entry.isDirectory) {
		const reader = (entry as FileSystemDirectoryEntry).createReader();
		const top = folder ?? entry.name;
		for (;;) {
			const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
			if (!batch.length) break;
			for (const child of batch) await readEntry(child, top, out, depth + 1);
		}
	}
}

/** Files of a drop, folders walked (each file tagged with the dropped folder's name). */
export async function filesFromDataTransfer(data: DataTransfer): Promise<DroppedFile[]> {
	const out: DroppedFile[] = [];
	const entries = Array.from(data.items ?? [])
		.map((item) => (item.kind === "file" && typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
		.filter((entry): entry is FileSystemEntry => entry !== null);
	if (entries.length) {
		for (const entry of entries) await readEntry(entry, undefined, out);
		return out;
	}
	return Array.from(data.files ?? []).map((file) => ({ file }));
}

/** Files from an <input type="file" webkitdirectory> or a plain multi-file input. */
export function filesFromInput(list: FileList | null): DroppedFile[] {
	return Array.from(list ?? []).map((file) => {
		const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
		const folder = path.includes("/") ? path.split("/")[0] : undefined;
		return { file, ...(folder ? { folder } : {}) };
	});
}

function canvas(width: number, height: number): CanvasRenderingContext2D {
	const element = document.createElement("canvas");
	element.width = Math.max(1, Math.round(width));
	element.height = Math.max(1, Math.round(height));
	const context = element.getContext("2d", { willReadFrequently: true });
	if (!context) throw new Error("no 2D canvas");
	return context;
}

function fit(width: number, height: number, longSide: number): { w: number; h: number } {
	const scale = Math.min(1, longSide / Math.max(width, height));
	return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

function grab(source: CanvasImageSource, width: number, height: number, longSide: number, t?: number): PixelFrame {
	const { w, h } = fit(width, height, longSide);
	const context = canvas(w, h);
	context.drawImage(source, 0, 0, w, h);
	const data = context.getImageData(0, 0, w, h).data;
	return { width: w, height: h, data, ...(t !== undefined ? { t } : {}) };
}

/** Native-resolution centre crop (grain must not be averaged away by downsampling). */
function crop(source: CanvasImageSource, width: number, height: number, size = 128): PixelFrame {
	const side = Math.min(size, width, height);
	const context = canvas(side, side);
	context.drawImage(source, Math.floor((width - side) / 2), Math.floor((height - side) / 2), side, side, 0, 0, side, side);
	return { width: side, height: side, data: context.getImageData(0, 0, side, side).data };
}

function thumbnail(source: CanvasImageSource, width: number, height: number): string {
	const { w, h } = fit(width, height, 160);
	const context = canvas(w, h);
	context.drawImage(source, 0, 0, w, h);
	return context.canvas.toDataURL("image/jpeg", 0.7);
}

async function readImage(item: DroppedFile): Promise<ExtractedReference> {
	const bitmap = await createImageBitmap(item.file);
	try {
		const { width, height } = bitmap;
		return {
			name: item.file.name,
			...(item.folder ? { folder: item.folder } : {}),
			kind: "image",
			width,
			height,
			frames: [grab(bitmap, width, height, 64)],
			detail: [crop(bitmap, width, height)],
			thumbnail: thumbnail(bitmap, width, height),
			size: item.file.size,
		};
	} finally {
		bitmap.close();
	}
}

function waitFor(video: HTMLVideoElement, event: "loadedmetadata" | "seeked" | "loadeddata", ms = 4000): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			cleanup();
			reject(new Error(`${event} timed out`));
		}, ms);
		const ok = () => {
			cleanup();
			resolve();
		};
		const fail = () => {
			cleanup();
			reject(new Error("this video cannot be decoded here"));
		};
		const cleanup = () => {
			window.clearTimeout(timer);
			video.removeEventListener(event, ok);
			video.removeEventListener("error", fail);
		};
		video.addEventListener(event, ok, { once: true });
		video.addEventListener("error", fail, { once: true });
	});
}

async function readVideo(item: DroppedFile, onFrame?: () => void): Promise<ExtractedReference> {
	const url = URL.createObjectURL(item.file);
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";
	video.src = url;
	try {
		await waitFor(video, "loadedmetadata");
		const duration = Number.isFinite(video.duration) ? video.duration : 0;
		const width = video.videoWidth || 1;
		const height = video.videoHeight || 1;
		const span = Math.min(duration, 30);
		const times: number[] = [];
		for (let t = 0.05; t < span; t += 0.5) times.push(Math.round(t * 100) / 100);
		if (!times.length) times.push(0);
		const frames: PixelFrame[] = [];
		let thumb = "";
		let detail: PixelFrame[] = [];
		const middle = times[Math.floor(times.length / 2)];
		for (const t of times) {
			video.currentTime = t;
			try {
				await waitFor(video, "seeked", 3000);
			} catch {
				continue; // a frame that will not seek is skipped, not fatal
			}
			frames.push(grab(video, width, height, 32, t));
			if (!thumb && t >= Math.min(1, span * 0.1)) thumb = thumbnail(video, width, height);
			if (t === middle) detail = [crop(video, width, height)];
			onFrame?.();
		}
		if (!thumb && frames.length) thumb = thumbnail(video, width, height);
		return {
			name: item.file.name,
			...(item.folder ? { folder: item.folder } : {}),
			kind: "video",
			width,
			height,
			duration: span,
			frames,
			detail,
			thumbnail: thumb,
			size: item.file.size,
		};
	} finally {
		video.removeAttribute("src");
		video.load();
		URL.revokeObjectURL(url);
	}
}

export interface ExtractProgress {
	done: number;
	total: number;
	current: string;
}

/**
 * Extract every image and video (others are skipped). Limits: 40 images, 8 videos (the first ones by name).
 * A file that cannot be read is reported in `failed`, never thrown.
 */
export async function extractReferences(
	files: DroppedFile[],
	{ onProgress, maxImages = 40, maxVideos = 8 }: { onProgress?: (progress: ExtractProgress) => void; maxImages?: number; maxVideos?: number } = {},
): Promise<{ references: ExtractedReference[]; skipped: string[]; failed: string[] }> {
	const sorted = [...files].sort((a, b) => `${a.folder ?? ""}/${a.file.name}`.localeCompare(`${b.folder ?? ""}/${b.file.name}`));
	const images = sorted.filter((item) => isImage(item.file)).slice(0, maxImages);
	const videos = sorted.filter((item) => isVideo(item.file)).slice(0, maxVideos);
	const skipped = sorted.filter((item) => !isImage(item.file) && !isVideo(item.file)).map((item) => item.file.name);
	const over = sorted.filter((item) => (isImage(item.file) && !images.includes(item)) || (isVideo(item.file) && !videos.includes(item)));
	skipped.push(...over.map((item) => `${item.file.name} (over the limit)`));
	const queue = [...images, ...videos];
	const references: ExtractedReference[] = [];
	const failed: string[] = [];
	for (let i = 0; i < queue.length; i++) {
		const item = queue[i] as DroppedFile;
		onProgress?.({ done: i, total: queue.length, current: item.file.name });
		try {
			references.push(isImage(item.file) ? await readImage(item) : await readVideo(item));
		} catch (error) {
			failed.push(`${item.file.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	onProgress?.({ done: queue.length, total: queue.length, current: "" });
	return { references, skipped, failed };
}
