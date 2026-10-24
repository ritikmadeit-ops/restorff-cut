/**
 * ffmpeg helpers for the voice-over and music beds (voice-music agent, 2026-10-20): run ffmpeg, measure loudness
 * (EBU R128 integrated + true peak via `ebur128=peak=true`, the same meter the SFX pack and the pipeline's master use),
 * decode to mono float, find silences. ffmpeg: $RESTORFFCUT_FFMPEG, else $FFMPEG, else on PATH (8.1.1 here).
 */
import { spawn } from "node:child_process";

export function ffmpegBin(): string {
	return process.env.RESTORFFCUT_FFMPEG || process.env.FFMPEG || "ffmpeg";
}

export interface RunResult {
	code: number;
	stdout: Buffer;
	stderr: string;
}

/** Spawn a program (no shell), collect stdout as bytes and stderr as text; reject on spawn error or timeout. */
export function runProgram(
	command: string,
	args: string[],
	{ signal, timeoutMs = 120_000, input }: { signal?: AbortSignal; timeoutMs?: number; input?: Buffer } = {},
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		let err = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)} s`));
		}, timeoutMs);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			if (err.length < 4_000_000) err += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
		});
		if (input) child.stdin.end(input);
		else child.stdin.end();
	});
}

export async function ffmpeg(args: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RunResult> {
	const result = await runProgram(ffmpegBin(), ["-hide_banner", "-nostats", ...args], opts);
	if (result.code !== 0) {
		const tail = result.stderr.split(/\r?\n/).filter(Boolean).slice(-6).join(" | ");
		throw new Error(`ffmpeg failed (exit ${result.code}): ${tail}`);
	}
	return result;
}

const num = (text: string | undefined): number | null => {
	if (text === undefined || /inf/i.test(text)) return null;
	const value = Number.parseFloat(text);
	return Number.isFinite(value) ? value : null;
};

export interface Loudness {
	/** Integrated loudness, LUFS (null when every block is gated out). */
	lufsI: number | null;
	/** True peak, dBTP. */
	truePeak: number | null;
	/** Loudness range, LU. */
	lra: number | null;
}

/** Parse the Summary block of ffmpeg's ebur128 filter. */
export function parseEbur128(log: string): Loudness {
	const summary = log.split("Summary:").pop() ?? "";
	const lufsI = num(summary.match(/I:\s+(-?[\d.]+|-?inf) LUFS/)?.[1]);
	const truePeak = num(summary.match(/True peak:\s*[\r\n]+\s*Peak:\s+(-?[\d.]+|-?inf)/)?.[1]);
	const lra = num(summary.match(/LRA:\s+(-?[\d.]+) LU/)?.[1]);
	return { lufsI: lufsI !== null && lufsI <= -70 ? null : lufsI, truePeak, lra };
}

/** EBU R128 of a file (optionally after a filter chain), e.g. measureLoudness(f, "atrim=start=1:end=4"). */
export async function measureLoudness(file: string, filters = "", signal?: AbortSignal): Promise<Loudness> {
	const chain = `${filters ? `${filters},` : ""}ebur128=peak=true`;
	const { stderr } = await ffmpeg(["-i", file, "-af", chain, "-f", "null", "-"], { signal });
	return parseEbur128(stderr);
}

/** Decode any audio file to mono float32 at `rate` (soxr resampler). */
export async function decodeMono(file: string, rate = 48_000, signal?: AbortSignal): Promise<Float32Array> {
	const { stdout } = await ffmpeg(
		["-v", "error", "-i", file, "-af", `aresample=${rate}:resampler=soxr`, "-ac", "1", "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"],
		{ signal, timeoutMs: 120_000 },
	);
	const copy = new Uint8Array(stdout.byteLength);
	copy.set(stdout);
	return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

export interface Silence {
	start: number;
	end: number;
}

/** ffmpeg silencedetect: spans quieter than `noiseDb` for at least `minSeconds`. */
export async function detectSilences(file: string, noiseDb = -45, minSeconds = 0.12, signal?: AbortSignal): Promise<Silence[]> {
	const { stderr } = await ffmpeg(["-i", file, "-af", `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`, "-f", "null", "-"], { signal });
	const out: Silence[] = [];
	let open: number | null = null;
	for (const match of stderr.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
		const value = Number.parseFloat(match[2]);
		if (match[1] === "start") open = Math.max(0, value);
		else if (open !== null) {
			out.push({ start: open, end: value });
			open = null;
		}
	}
	return out;
}
