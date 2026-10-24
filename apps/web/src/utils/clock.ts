import { TICKS_PER_SECOND } from "@/wasm";

/** 00:12.40 — minutes:seconds.hundredths, the artboard's timecode style. */
export function formatClock(ticks: number): string {
	const totalSeconds = Math.max(0, ticks / TICKS_PER_SECOND);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds - minutes * 60;
	const whole = Math.floor(seconds);
	const hundredths = Math.floor((seconds - whole) * 100);
	return `${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}
