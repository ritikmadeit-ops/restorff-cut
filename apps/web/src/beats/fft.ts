/**
 * In-place iterative radix-2 FFT (real input packed as re/im arrays). Small and allocation-
 * free per call; enough for onset analysis at 1024 points.
 */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	if (n !== im.length || (n & (n - 1)) !== 0) {
		throw new Error(`fftInPlace: length must be a power of two, got ${n}`);
	}
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			const tr = re[i];
			re[i] = re[j];
			re[j] = tr;
			const ti = im[i];
			im[i] = im[j];
			im[j] = ti;
		}
	}
	for (let size = 2; size <= n; size <<= 1) {
		const half = size >> 1;
		const step = (-2 * Math.PI) / size;
		const wr = Math.cos(step);
		const wi = Math.sin(step);
		for (let start = 0; start < n; start += size) {
			let cr = 1;
			let ci = 0;
			for (let k = 0; k < half; k++) {
				const a = start + k;
				const b = a + half;
				const xr = re[b] * cr - im[b] * ci;
				const xi = re[b] * ci + im[b] * cr;
				re[b] = re[a] - xr;
				im[b] = im[a] - xi;
				re[a] += xr;
				im[a] += xi;
				const nr = cr * wr - ci * wi;
				ci = cr * wi + ci * wr;
				cr = nr;
			}
		}
	}
}
