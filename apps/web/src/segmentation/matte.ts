/**
 * Matte tracks: sampling with interpolation between analysed frames, edge shaping, (de)serialisation, and the
 * subject-box series auto-reframe uses.
 */
import { boxCenter } from "./boxes";
import type { Box, FrameBoxes, MatteHeader, MatteTrack } from "./types";

export interface EdgeShape {
	/** Alpha below `low` becomes 0, above `high` becomes 1, smoothstep between (0..1). */
	low: number;
	high: number;
}

export const DEFAULT_EDGE: EdgeShape = { low: 0.3, high: 0.72 };

function frameIndexAt({ header, time }: { header: MatteHeader; time: number }): {
	i0: number;
	i1: number;
	weight: number;
} {
	const count = header.times.length;
	if (count <= 1) return { i0: 0, i1: 0, weight: 0 };
	const position = (time - header.start) * header.fps;
	if (position <= 0) return { i0: 0, i1: 0, weight: 0 };
	if (position >= count - 1) return { i0: count - 1, i1: count - 1, weight: 0 };
	const i0 = Math.floor(position);
	return { i0, i1: i0 + 1, weight: position - i0 };
}

let edgeLut: { key: string; lut: Uint8Array } | null = null;
function getEdgeLut(edge: EdgeShape): Uint8Array {
	const key = `${edge.low}:${edge.high}`;
	if (edgeLut?.key === key) return edgeLut.lut;
	const lut = new Uint8Array(256);
	const span = Math.max(1e-3, edge.high - edge.low);
	for (let i = 0; i < 256; i++) {
		const t = Math.min(1, Math.max(0, (i / 255 - edge.low) / span));
		lut[i] = Math.round(t * t * (3 - 2 * t) * 255);
	}
	edgeLut = { key, lut };
	return lut;
}

/**
 * The matte at a SOURCE time (seconds), linearly interpolated between the two nearest analysed frames, edge-shaped,
 * written as RGBA (white, alpha = matte) into `out` (width*height*4, e.g. an ImageData's data).
 */
export function sampleMatteRgba({
	track,
	time,
	out,
	edge = DEFAULT_EDGE,
}: {
	track: MatteTrack;
	time: number;
	out: Uint8ClampedArray;
	edge?: EdgeShape;
}): void {
	const { header, data } = track;
	const size = header.width * header.height;
	const { i0, i1, weight } = frameIndexAt({ header, time });
	const a = i0 * size;
	const b = i1 * size;
	const lut = getEdgeLut(edge);
	const w1 = Math.round(weight * 256);
	const w0 = 256 - w1;
	for (let i = 0; i < size; i++) {
		const value = (data[a + i] * w0 + data[b + i] * w1) >> 8;
		const o = i * 4;
		out[o] = 255;
		out[o + 1] = 255;
		out[o + 2] = 255;
		out[o + 3] = lut[value];
	}
}

/** Boxes at a source time (nearest analysed frame). */
export function boxesAt({ header, time }: { header: MatteHeader; time: number }): FrameBoxes {
	const { i0, i1, weight } = frameIndexAt({ header, time });
	return header.boxes[weight < 0.5 ? i0 : i1] ?? header.boxes[0];
}

/** Median of the non-null boxes of one kind over a time span (robust "where is the subject in this shot"). */
export function medianBox({
	header,
	kind,
	from = header.start,
	to = header.end,
}: {
	header: MatteHeader;
	kind: "person" | "face" | "head";
	from?: number;
	to?: number;
}): Box | null {
	const picked: Box[] = [];
	header.times.forEach((time, index) => {
		if (time < from - 1e-6 || time > to + 1e-6) return;
		const box = header.boxes[index]?.[kind];
		if (box) picked.push(box);
	});
	if (picked.length === 0) return null;
	const median = (values: number[]) => {
		const sorted = [...values].sort((x, y) => x - y);
		return sorted[Math.floor(sorted.length / 2)];
	};
	return [
		median(picked.map((box) => box[0])),
		median(picked.map((box) => box[1])),
		median(picked.map((box) => box[2])),
		median(picked.map((box) => box[3])),
	];
}

export interface SubjectSample {
	/** Source time, seconds. */
	time: number;
	/** Point to keep in frame, 0..1 of the source frame. */
	x: number;
	y: number;
	/** Subject (person) box, 0..1, when found. */
	person: Box | null;
	head: Box | null;
}

/**
 * One subject point per `step` seconds: the head centre when known, else the top third of the person box, else
 * the frame centre — then smoothed with a centred moving average (`window` samples) so the reframe does not jitter.
 */
export function subjectSeries({
	header,
	step = 1,
	window = 3,
}: {
	header: MatteHeader;
	step?: number;
	window?: number;
}): SubjectSample[] {
	const raw: SubjectSample[] = [];
	for (let time = header.start; time <= header.end + 1e-6; time += step) {
		const boxes = boxesAt({ header, time: Math.min(time, header.end) });
		let point = { x: 0.5, y: 0.4 };
		if (boxes.head) point = boxCenter(boxes.head);
		else if (boxes.person) point = { x: boxes.person[0] + boxes.person[2] / 2, y: boxes.person[1] + boxes.person[3] * 0.25 };
		raw.push({ time: Math.min(time, header.end), x: point.x, y: point.y, person: boxes.person, head: boxes.head });
	}
	// Carry the last known subject over frames with nobody detected.
	for (let i = 1; i < raw.length; i++) {
		if (!raw[i].person && raw[i - 1].person) {
			raw[i] = { ...raw[i], x: raw[i - 1].x, y: raw[i - 1].y, person: raw[i - 1].person, head: raw[i - 1].head };
		}
	}
	const half = Math.max(0, Math.floor(window / 2));
	return raw.map((sample, index) => {
		let sx = 0;
		let sy = 0;
		let n = 0;
		for (let j = index - half; j <= index + half; j++) {
			const other = raw[j];
			if (!other) continue;
			sx += other.x;
			sy += other.y;
			n++;
		}
		return { ...sample, x: sx / n, y: sy / n };
	});
}

const MAGIC = "RMAT";

export function serializeMatte(track: MatteTrack): Blob {
	const headerBytes = new TextEncoder().encode(JSON.stringify(track.header));
	const prefix = new Uint8Array(8);
	prefix.set(new TextEncoder().encode(MAGIC), 0);
	new DataView(prefix.buffer).setUint32(4, headerBytes.length, true);
	return new Blob([prefix, headerBytes, track.data as unknown as BlobPart], {
		type: "application/octet-stream",
	});
}

export async function deserializeMatte(blob: Blob): Promise<MatteTrack | null> {
	const buffer = new Uint8Array(await blob.arrayBuffer());
	if (buffer.length < 8) return null;
	if (new TextDecoder().decode(buffer.subarray(0, 4)) !== MAGIC) return null;
	const headerLength = new DataView(buffer.buffer, buffer.byteOffset, 8).getUint32(4, true);
	const header = JSON.parse(new TextDecoder().decode(buffer.subarray(8, 8 + headerLength))) as MatteHeader;
	if (header.version !== 1) return null;
	const data = buffer.slice(8 + headerLength);
	const expected = header.hasAlpha ? header.width * header.height * header.times.length : 0;
	if (data.length !== expected) return null;
	return { header, data };
}
