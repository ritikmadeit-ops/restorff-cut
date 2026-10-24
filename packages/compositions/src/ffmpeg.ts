// FFmpeg/ffprobe helpers: encoder args for alpha video, probing, frame hashes, contact sheets for looking.
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";

const FFMPEG = process.env.RESTORFFCUT_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.RESTORFFCUT_FFPROBE ?? "ffprobe";

/** Chrome captures sRGB RGBA; convert with the BT.709 matrix to limited range and tag it, or colours shift (BT.601 default). */
const TO_709 = "scale=out_color_matrix=bt709:out_range=tv";
const TAGS_709 = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

/**
 * Args that read PNG frames from stdin and write alpha video.
 * webm: VP9 + yuva420p. `-auto-alt-ref 0` is required with alpha; `alpha_mode=1` marks the track so players
 *       (and ffmpeg's libvpx decoder) use it. Same flags HyperFrames uses (chunkEncoder.ts).
 * mov:  ProRes 4444 + yuva444p10le (no chroma subsampling: the high-quality interchange option).
 */
export function encoderArgs(format: "webm" | "mov", fps: number, out: string, crf = 31): string[] {
  const input = ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-"];
  if (format === "webm") {
    return [
      ...input,
      "-vf", `${TO_709},format=yuva420p`,
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
      // realtime/cpu-used 8 measured 4x faster than good/cpu-used 4 at the same quality (42.4 dB composited PSNR)
      "-b:v", "0", "-crf", String(crf), "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1",
      // a keyframe every second keeps scrubbing in the editor responsive
      "-g", String(Math.max(1, Math.round(fps))),
      "-auto-alt-ref", "0", "-metadata:s:v:0", "alpha_mode=1",
      ...TAGS_709, "-an", out,
    ];
  }
  return [
    ...input,
    "-vf", `${TO_709},format=yuva444p10le`,
    "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0",
    ...TAGS_709, "-an", out,
  ];
}

export interface Encoder {
  stdin: Writable;
  done: Promise<void>;
}

export function spawnEncoder(args: string[]): Encoder {
  const p = spawn(FFMPEG, args, { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  p.stderr.on("data", (d: Buffer) => (err += d.toString()));
  const done = new Promise<void>((resolve, reject) => {
    p.on("error", (e) => reject(new Error(`could not start ffmpeg (${FFMPEG}): ${e.message}`)));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(-800)}`))));
  });
  p.stdin.on("error", () => {
    /* surfaced through `done` */
  });
  return { stdin: p.stdin, done };
}

export function run(cmd: string, args: string[]): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    // "close", not "exit": exit can fire before the last stdout chunk arrives, which cut ffprobe's JSON short
    // ("JSON Parse error: Expected ']'" on some clips, fx-sync 2026-10-24)
    p.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err }));
  });
}

async function must(cmd: string, args: string[]): Promise<Buffer> {
  const r = await run(cmd, args);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} → ${r.code}: ${r.stderr.trim().slice(-600)}`);
  return r.stdout;
}

/** VP9 alpha is only decoded by libvpx (ffmpeg's native vp9 decoder drops it): force it for .webm inputs. */
export function decoderArgs(file: string): string[] {
  return /\.webm$/i.test(file) ? ["-c:v", "libvpx-vp9"] : [];
}

export interface ProbeInfo {
  codec: string;
  profile?: string;
  width: number;
  height: number;
  fps: number;
  /** pix_fmt as stored (VP9 alpha reports yuv420p here; the alpha plane is side data). */
  pixFmt: string;
  /** pix_fmt when decoded with the alpha-aware decoder (yuva420p / yuva444p12le when alpha is present). */
  decodedPixFmt: string;
  alphaMode: boolean;
  frames: number;
  duration: number;
}

export async function probe(file: string): Promise<ProbeInfo> {
  const j = JSON.parse(
    (await must(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_streams", "-show_format", "-of", "json", file])).toString(),
  ) as { streams: Record<string, unknown>[]; format: Record<string, unknown> };
  const s = j.streams[0] ?? {};
  const tags = (s.tags ?? {}) as Record<string, string>;
  const [n, d] = String(s.r_frame_rate ?? "0/1").split("/").map(Number);
  // Decode one frame with the alpha-aware decoder to learn the real pixel format.
  const decodedPixFmt = await decodedFormat(file);
  return {
    codec: String(s.codec_name ?? ""),
    profile: s.profile ? String(s.profile) : undefined,
    width: Number(s.width),
    height: Number(s.height),
    fps: d ? (n ?? 0) / d : 0,
    pixFmt: String(s.pix_fmt ?? ""),
    decodedPixFmt,
    alphaMode: Object.entries(tags).some(([k, v]) => k.toLowerCase() === "alpha_mode" && v === "1"),
    frames: Number(s.nb_read_frames ?? s.nb_frames ?? 0),
    duration: Number(j.format.duration ?? s.duration ?? 0),
  };
}

async function decodedFormat(file: string): Promise<string> {
  const r = await run(FFMPEG, ["-hide_banner", ...decoderArgs(file), "-i", file, "-frames:v", "1", "-f", "null", "-"]);
  // "Stream #0:0 -> #0:0 (vp9 (libvpx-vp9) -> wrapped_avframe (native))" then the output stream line holds the format.
  const m = r.stderr.match(/Output #0[\s\S]*?Video: wrapped_avframe, (\w+)/);
  return m?.[1] ?? "";
}

/** One md5 per decoded frame (RGBA, alpha included). Two identical renders give identical lists. */
export async function frameMd5(file: string): Promise<string[]> {
  const out = (await must(FFMPEG, ["-v", "error", ...decoderArgs(file), "-i", file, "-pix_fmt", "rgba", "-f", "framemd5", "-"])).toString();
  return out.split(/\r?\n/).filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop()!.trim());
}

/** Min/max/mean of the alpha plane at time `t` (0..255). Fully opaque video gives min=max=255. */
export async function alphaStats(file: string, t: number): Promise<{ min: number; max: number; mean: number }> {
  const out = (await must(FFMPEG, [
    "-v", "error", ...decoderArgs(file), "-ss", String(t), "-i", file, "-frames:v", "1",
    "-vf", "format=rgba,alphaextract,format=gray", "-f", "rawvideo", "-",
  ]));
  let min = 255;
  let max = 0;
  let sum = 0;
  for (const v of out) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, mean: out.length ? sum / out.length : 0 };
}

/**
 * Contact sheet for looking at a render: `count` frames spread over the clip, composited on a plate colour,
 * tiled in one row. Times are returned so the caller can label what it looked at.
 */
export async function contactSheet(
  file: string,
  out: string,
  opts: {
    count?: number; plate?: string; tileWidth?: number; frames: number; fps: number; width: number; height: number;
    /** Optional window in seconds: spread the frames between these times instead of over the whole clip. */
    from?: number; to?: number;
  },
): Promise<number[]> {
  const first = Math.max(0, Math.min(opts.frames - 1, Math.round((opts.from ?? 0) * opts.fps)));
  const last = Math.max(first, Math.min(opts.frames - 1, opts.to != null ? Math.round(opts.to * opts.fps) : opts.frames - 1));
  const count = Math.max(1, Math.min(opts.count ?? 6, last - first + 1));
  const idx = Array.from({ length: count }, (_, i) => first + Math.round((i * (last - first)) / Math.max(1, count - 1)));
  const tw = opts.tileWidth ?? 360;
  const th = Math.round((opts.height * tw) / opts.width / 2) * 2;
  const plate = (opts.plate ?? "#3a3a40").replace("#", "0x");
  const select = idx.map((i) => `eq(n\\,${i})`).join("+");
  const graph =
    `[0:v]select='${select}',setpts=N/TB,format=rgba,scale=${tw}:${th}[fg];` +
    `color=c=${plate}:s=${tw}x${th}:r=1,format=rgba[bg];` +
    `[bg][fg]overlay=shortest=1:format=auto,tile=${count}x1:padding=6:margin=6:color=0x111114`;
  await must(FFMPEG, ["-y", "-v", "error", ...decoderArgs(file), "-i", file, "-filter_complex", graph, "-frames:v", "1", out]);
  return idx.map((i) => +(i / opts.fps).toFixed(3));
}
