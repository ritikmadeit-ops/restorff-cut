/**
 * Deterministic ids. The editor uses crypto.randomUUID (utils/id.ts); the reducer must be reproducible, so ids are
 * derived from (seed, op index, counter) and formatted as RFC 4122 v4-shaped UUIDs so they look like the editor's own.
 */

function cyrb128(input: string): [number, number, number, number] {
	let h1 = 1779033703;
	let h2 = 3144134277;
	let h3 = 1013904242;
	let h4 = 2773480762;
	for (let i = 0; i < input.length; i++) {
		const k = input.charCodeAt(i);
		h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
		h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
		h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
		h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
	}
	h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
	h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
	h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
	h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
	h1 ^= h2 ^ h3 ^ h4;
	h2 ^= h1;
	h3 ^= h1;
	h4 ^= h1;
	return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function hex8(value: number): string {
	return value.toString(16).padStart(8, "0");
}

/** A UUID-shaped id that is a pure function of its key. */
export function deterministicUuid(key: string): string {
	const [a, b, c, d] = cyrb128(key);
	const h = hex8(a) + hex8(b) + hex8(c) + hex8(d);
	const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface IdSource {
	/** Next id for the op currently being applied. */
	next(purpose: string): string;
}

/** One IdSource per op: ids depend on the seed, the op's index in the batch and how many ids the op drew. */
export function createIdSource(seed: string, opPath: string): IdSource {
	let counter = 0;
	return {
		next(purpose: string): string {
			counter += 1;
			return deterministicUuid(`${seed}|${opPath}|${counter}|${purpose}`);
		},
	};
}
