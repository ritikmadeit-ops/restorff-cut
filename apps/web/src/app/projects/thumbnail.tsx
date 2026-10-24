"use client";

import { useEffect, useState } from "react";

/**
 * A project card's picture (ui-fix-panels, 2026-10-21, QA #28: cards of projects whose first frame is black — an
 * empty canvas, a fade-in — showed as solid black tiles). The thumbnail is sampled once on load (16×28 px); a picture
 * with almost no light is replaced by the "no picture yet" placeholder the card shows when there is no thumbnail.
 */
const DARK_LUMA = 10;

function isNearlyBlack(src: string): Promise<boolean> {
	return new Promise((resolve) => {
		const image = new Image();
		image.crossOrigin = "anonymous";
		image.onload = () => {
			try {
				const canvas = document.createElement("canvas");
				canvas.width = 16;
				canvas.height = 28;
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				if (!ctx) return resolve(false);
				ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
				const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
				let max = 0;
				for (let i = 0; i < data.length; i += 4) {
					const luma = 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
					if (luma > max) max = luma;
				}
				resolve(max < DARK_LUMA);
			} catch {
				resolve(false); // a tainted canvas: keep the picture
			}
		};
		image.onerror = () => resolve(true);
		image.src = src;
	});
}

const verdicts = new Map<string, Promise<boolean>>();

/** True once the thumbnail is known to be (nearly) black or broken; false while unknown or fine. */
export function useBlankThumbnail(src: string | null | undefined): boolean {
	const [blank, setBlank] = useState(false);
	useEffect(() => {
		if (!src) {
			setBlank(false);
			return;
		}
		let alive = true;
		let verdict = verdicts.get(src);
		if (!verdict) {
			verdict = isNearlyBlack(src);
			verdicts.set(src, verdict);
		}
		verdict.then((value) => alive && setBlank(value));
		return () => {
			alive = false;
		};
	}, [src]);
	return blank;
}
