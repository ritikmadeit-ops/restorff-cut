/**
 * Build the CC0 UI-cue pack "uisfx-cinematic-cc0" into apps/web/public/sfx/cc0/ (scout agent, 2026-10-24).
 *
 *   bun third_party/uisfx/build-cc0-pack.ts            (from restorffcut/; needs ffmpeg on PATH or FFMPEG=<path>)
 *
 * Source: uisfx (https://github.com/romainsimon/uisfx) — code MIT, audio CC0-1.0 (packages/uisfx/LICENSE-AUDIO:
 * "procedurally generated audio files … dedicated to the public domain"). For every cue in PICK: download the .ogg
 * at the pinned COMMIT from raw.githubusercontent.com (cached in %TEMP%/restorffcut-scout/uisfx-cache, outside the
 * repo) → decode to float mono 48 kHz → gain to −1.2 dBTP → 16-bit mono 48 kHz WAV in public/sfx/cc0 → measure the
 * same way as apps/web/src/sounds/pack/build-pack.ts (ebur128 with a 0.5 s pad, astats; sync points from the same
 * `landmarks()`) → write public/sfx/cc0/manifest.json in the core pack's schema (restorff-sfx-pack@1).
 * Fails if a file ends above −1 dBTP or the pack reaches 3 MB. Nothing loads this pack yet (sounds owner: see NOTES).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { landmarks } from "../../apps/web/src/sounds/pack/synth";

const COMMIT = "9950fe66f993a6660dab9c2651dcbcd899ffd83b"; // HEAD on 2026-10-24 (committed 2026-09-08)
const PERSONALITY = "cinematic";
const RAW = (cue: string) => `https://raw.githubusercontent.com/romainsimon/uisfx/${COMMIT}/packages/uisfx/sounds/${PERSONALITY}/${cue}.ogg`;
const OUT_DIR = resolve(import.meta.dir, "../../apps/web/public/sfx/cc0");
const CACHE = join(process.env.TEMP ?? tmpdir(), "restorffcut-scout", "uisfx-cache", COMMIT, PERSONALITY);
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const TARGET_TP = -1.2;
const CEILING_TP = -1.0;
const PACK_BYTES_MAX = 3_000_000;

type Pick = { cue: string; name: string; tags: string[]; roles: string[]; use: string; sync: "onset" | "peak"; target: number };
/** Cues our synthesized core pack has no sound for: on-screen UI events in motion graphics. */
const PICK: Pick[] = [
  { cue: "success", name: "Success", tags: ["success", "done", "approved", "check", "ui"], roles: ["accent"], use: "a task or check turns green (checklist done, APPROVED)", sync: "onset", target: -21 },
  { cue: "complete", name: "Complete", tags: ["complete", "done", "finish", "100", "ui"], roles: ["accent"], use: "a progress bar or counter reaches 100 %", sync: "onset", target: -21 },
  { cue: "error", name: "Error", tags: ["error", "wrong", "fail", "x", "ui"], roles: ["accent"], use: "a wrong answer or a struck-out claim", sync: "onset", target: -22 },
  { cue: "warning", name: "Warning", tags: ["warning", "alert", "caution", "ui"], roles: ["accent"], use: "a warning badge or a problem beat", sync: "onset", target: -22 },
  { cue: "notification", name: "Notification", tags: ["notification", "message", "alert", "phone", "ui"], roles: ["accent", "text_in"], use: "a notification card or DM drops in", sync: "onset", target: -21 },
  { cue: "send", name: "Send", tags: ["send", "sent", "message", "prompt", "ui"], roles: ["accent"], use: "a prompt or message is sent (prompt-box SENT)", sync: "onset", target: -22 },
  { cue: "receive", name: "Receive", tags: ["receive", "reply", "message", "chat", "ui"], roles: ["accent", "text_in"], use: "a chat reply appears", sync: "onset", target: -22 },
  { cue: "mention", name: "Mention", tags: ["mention", "tag", "comment", "ui"], roles: ["accent", "text_in"], use: "a comment or @-mention pops", sync: "onset", target: -23 },
  { cue: "level-up", name: "Level up", tags: ["level-up", "win", "upgrade", "reward", "ui"], roles: ["accent", "hit"], use: "a payoff beat: a number jumps, a tier unlocks", sync: "onset", target: -19 },
  { cue: "achievement", name: "Achievement", tags: ["achievement", "badge", "win", "reward", "ui"], roles: ["accent", "hit"], use: "a badge, award or milestone lands", sync: "onset", target: -19 },
  { cue: "reward", name: "Reward", tags: ["reward", "bonus", "gift", "offer", "ui"], roles: ["accent"], use: "an offer or free gift is revealed", sync: "onset", target: -21 },
  { cue: "streak", name: "Streak", tags: ["streak", "combo", "counter", "ui"], roles: ["accent"], use: "a streak counter ticks up", sync: "onset", target: -22 },
  { cue: "badge", name: "Badge", tags: ["badge", "pill", "label", "ui"], roles: ["accent", "text_in"], use: "a pill or badge pops in", sync: "onset", target: -23 },
  { cue: "purchase", name: "Purchase", tags: ["purchase", "buy", "checkout", "price", "ui"], roles: ["accent"], use: "a buy button is pressed (CTA)", sync: "onset", target: -21 },
  { cue: "add-to-cart", name: "Add to cart", tags: ["cart", "add", "shop", "ui"], roles: ["accent"], use: "a product drops into a cart", sync: "onset", target: -22 },
  { cue: "checkout", name: "Checkout", tags: ["checkout", "order", "pay", "ui"], roles: ["accent"], use: "an order is placed / confirmed", sync: "onset", target: -21 },
  { cue: "coupon", name: "Coupon", tags: ["coupon", "discount", "code", "offer", "ui"], roles: ["accent"], use: "a discount code appears", sync: "onset", target: -22 },
  { cue: "unlock", name: "Unlock", tags: ["unlock", "open", "access", "reveal", "ui"], roles: ["accent"], use: "something is unlocked or revealed", sync: "onset", target: -22 },
  { cue: "lock", name: "Lock", tags: ["lock", "secure", "close", "ui"], roles: ["accent"], use: "something locks or is secured", sync: "onset", target: -23 },
  { cue: "toggle-on", name: "Toggle on", tags: ["toggle", "on", "switch", "ui"], roles: ["accent"], use: "a switch flips on (subscribe and save)", sync: "onset", target: -24 },
  { cue: "toggle-off", name: "Toggle off", tags: ["toggle", "off", "switch", "ui"], roles: ["accent"], use: "a switch flips off", sync: "onset", target: -24 },
  { cue: "swipe", name: "Swipe", tags: ["swipe", "slide", "card", "ui"], roles: ["accent", "transition"], use: "a card swipes away", sync: "onset", target: -23 },
  { cue: "open", name: "Open", tags: ["open", "panel", "window", "ui"], roles: ["accent", "text_in"], use: "a panel or window opens", sync: "onset", target: -24 },
  { cue: "close", name: "Close", tags: ["close", "panel", "window", "ui"], roles: ["accent"], use: "a panel or window closes", sync: "onset", target: -24 },
  { cue: "expand", name: "Expand", tags: ["expand", "grow", "zoom", "ui"], roles: ["accent"], use: "a card expands to full size", sync: "onset", target: -24 },
  { cue: "snap", name: "Snap", tags: ["snap", "align", "place", "ui"], roles: ["accent"], use: "an element snaps into place", sync: "onset", target: -23 },
  { cue: "drop", name: "Drop", tags: ["drop", "place", "land", "ui"], roles: ["accent"], use: "a dragged item lands", sync: "onset", target: -23 },
  { cue: "copy", name: "Copy", tags: ["copy", "clipboard", "code", "ui"], roles: ["accent"], use: "a code or link is copied", sync: "onset", target: -24 },
];

function run(args: string[], encoding: "utf8" | "buffer" = "utf8") {
  const result = spawnSync(FFMPEG, ["-hide_banner", "-nostats", ...args], { encoding: encoding === "utf8" ? "utf8" : undefined, maxBuffer: 64 * 1024 * 1024 } as never);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed:\n${result.stderr}`);
  return result as unknown as { stdout: Buffer | string; stderr: string | Buffer };
}
const num = (text: string | undefined): number | null => {
  if (text === undefined || /^-?inf$/i.test(text)) return null;
  const v = Number.parseFloat(text);
  return Number.isFinite(v) ? v : null;
};
function loudness(file: string, pad: boolean) {
  const log = String(run(["-i", file, "-af", `${pad ? "apad=pad_dur=0.5," : ""}ebur128=peak=true:framelog=info`, "-f", "null", "-"]).stderr);
  const [frames, summary = ""] = log.split("Summary:");
  let mMax: number | null = null;
  for (const m of frames.matchAll(/\bM:\s*(-?[\d.]+|-?inf)/g)) {
    const v = num(m[1]);
    if (v !== null && v > -120 && (mMax === null || v > mMax)) mMax = v;
  }
  const lufsI = num(summary.match(/I:\s+(-?[\d.]+|-?inf) LUFS/)?.[1]);
  const truePeak = num(summary.match(/True peak:\s*[\r\n]+\s*Peak:\s+(-?[\d.]+|-?inf)/)?.[1]);
  return { lufsI: lufsI !== null && lufsI <= -70 ? null : lufsI, lufsMMax: mMax, truePeak };
}
function stats(file: string) {
  const overall = String(run(["-i", file, "-af", "astats", "-f", "null", "-"]).stderr).split("Overall").pop() ?? "";
  return {
    samplePeak: num(overall.match(/Peak level dB:\s*(-?[\d.]+|-?inf)/)?.[1]),
    rms: num(overall.match(/RMS level dB:\s*(-?[\d.]+|-?inf)/)?.[1]),
    crest: num(overall.match(/Crest factor:\s*(-?[\d.]+)/)?.[1]),
  };
}
const round = (v: number | null, step = 0.1): number | null => (v === null ? null : Number((Math.round(v / step) * step).toFixed(3)));
function pcm(file: string): Float32Array {
  const out = run(["-i", file, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], "buffer").stdout as Buffer;
  return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(CACHE, { recursive: true });
  const keep = new Set(PICK.map((p) => `${p.cue}.wav`));
  for (const name of readdirSync(OUT_DIR)) if (name.endsWith(".wav") && !keep.has(name)) unlinkSync(join(OUT_DIR, name));
  const versionLine = (spawnSync(FFMPEG, ["-version"], { encoding: "utf8" }).stdout.split("\n")[0] ?? "ffmpeg").trim();
  const sounds = [];
  const failures: string[] = [];
  let totalBytes = 0;
  let totalSeconds = 0;
  for (const p of PICK) {
    const src = join(CACHE, `${p.cue}.ogg`);
    if (!existsSync(src)) {
      const res = await fetch(RAW(p.cue));
      if (!res.ok) throw new Error(`${RAW(p.cue)}: HTTP ${res.status}`);
      writeFileSync(src, new Uint8Array(await res.arrayBuffer()));
    }
    const before = loudness(src, false);
    if (before.truePeak === null) throw new Error(`${p.cue}: no true peak`);
    const file = join(OUT_DIR, `${p.cue}.wav`);
    let gainDb = TARGET_TP - before.truePeak;
    let after = before;
    for (let attempt = 0; attempt < 3; attempt++) {
      run(["-y", "-i", src, "-af", `volume=${gainDb.toFixed(3)}dB`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", file]);
      after = loudness(file, true);
      if (after.truePeak !== null && after.truePeak <= CEILING_TP) break;
      gainDb -= (after.truePeak ?? 0) - TARGET_TP;
    }
    const signal = pcm(file);
    const marks = landmarks(signal);
    const st = stats(file);
    const bytes = statSync(file).size;
    const duration = signal.length / 48000;
    totalBytes += bytes;
    totalSeconds += duration;
    if (after.truePeak === null || after.truePeak > CEILING_TP) failures.push(`${p.cue}: true peak ${after.truePeak} dBTP`);
    const syncAt = p.sync === "peak" ? marks.peakAt : marks.onset;
    const defaultDb = after.lufsMMax === null ? -12 : Math.max(-30, Math.min(6, Math.round((p.target - after.lufsMMax) * 2) / 2));
    sounds.push({
      id: `ui-${p.cue}`,
      name: `UI ${p.name.toLowerCase()}`,
      file: `${p.cue}.wav`,
      url: `/sfx/cc0/${p.cue}.wav`,
      category: "ui",
      tags: p.tags,
      roles: p.roles,
      description: `uisfx "${PERSONALITY}" cue "${p.cue}" (procedural, CC0). For ${p.use}. Not auditioned by scout.`,
      licence: "CC0-1.0 (uisfx)",
      source: RAW(p.cue),
      duration_s: round(duration, 0.001),
      bytes,
      sync: p.sync,
      sync_s: round(syncAt, 0.001),
      peak_at_s: round(marks.peakAt, 0.001),
      onset_s: round(marks.onset, 0.001),
      true_peak_dbtp: round(after.truePeak),
      sample_peak_dbfs: round(st.samplePeak, 0.01),
      rms_dbfs: round(st.rms, 0.01),
      crest_factor: round(st.crest, 0.01),
      lufs_i: round(after.lufsI),
      lufs_m_max: round(after.lufsMMax),
      target_lufs_m: p.target,
      default_db: defaultDb,
      gain_applied_db: round(gainDb, 0.01),
    });
    console.log(`${p.cue.padEnd(14)} ${duration.toFixed(3)} s  ${(bytes / 1024).toFixed(0)} KB  TP ${after.truePeak?.toFixed(1)}  Mmax ${after.lufsMMax?.toFixed(1) ?? "n/a"}  sync ${syncAt.toFixed(3)} s  default ${defaultDb} dB`);
  }
  if (totalBytes >= PACK_BYTES_MAX) failures.push(`pack is ${totalBytes} bytes (limit ${PACK_BYTES_MAX})`);
  const manifest = {
    schema: "restorff-sfx-pack@1",
    pack: "uisfx-cinematic-cc0",
    version: "0.1.0",
    built: new Date().toISOString().slice(0, 10),
    licence: "CC0-1.0",
    licence_note: `Audio from uisfx (https://github.com/romainsimon/uisfx @ ${COMMIT}, packages/uisfx/LICENSE-AUDIO): procedurally generated and dedicated to the public domain under CC0 1.0. Gain-normalised and re-encoded here. Credit appreciated: "UI sounds: uisfx (CC0)".`,
    generator: "third_party/uisfx/build-cc0-pack.ts",
    rebuild: "bun third_party/uisfx/build-cc0-pack.ts",
    format: { container: "wav", codec: "pcm_s16le", sample_rate: 48000, channels: 1 },
    targets: { true_peak_dbtp_max: CEILING_TP, pack_bytes_max: PACK_BYTES_MAX },
    measured_with: `${versionLine}: ebur128=peak=true on each file plus 0.5 s of silence, astats on the file; sync points by apps/web/src/sounds/pack/synth.ts landmarks()`,
    fields: JSON.parse(readFileSync(resolve(import.meta.dir, "../../apps/web/public/sfx/manifest.json"), "utf8")).fields,
    total_bytes: totalBytes,
    total_duration_s: round(totalSeconds, 0.001),
    sounds,
  };
  writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
  console.log(`\n${sounds.length} sounds, ${totalBytes} bytes (${(totalBytes / 1024 / 1024).toFixed(2)} MB), ${totalSeconds.toFixed(2)} s -> ${OUT_DIR}`);
  if (failures.length) {
    console.error(`FAIL\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log("PASS: every file <= -1 dBTP, pack < 3 MB");
}

await main();
