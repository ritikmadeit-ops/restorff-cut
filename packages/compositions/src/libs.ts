// Animation libraries a composition can ask for (anim-runtime, wave 7, 2026-10-24).
//
// A composition names them with a marker comment anywhere in its HTML — `<!-- rc-lib gsap -->`,
// `<!-- rc-lib gsap three -->` — and the renderer injects each one as an init script right after the runtime (and
// hf-protocol.js), before a library kit and before any page script: in library renders (file://) and in custom renders
// (data: URL, network blocked) alike. Nothing is fetched: every library is a file in this package.
//
//   gsap        src/gsap-compat/gsap.js — our MIT, clean-room GSAP-API runtime (GSAP itself is never shipped)
//   three       vendor/three/three-0.184.0.min.js — three.js 0.184.0 + 18 addons on THREE.addons (MIT)
//   three-r147  vendor/three-r147/ — three.js 0.147.0 build + examples/js globals (THREE.GLTFLoader, …) (MIT)
//   lottie      vendor/lottie/lottie-5.12.2.min.js — lottie-web (MIT); seek with window.__hfLottie
//   anime       vendor/anime/anime-4.5.0.umd.min.js — Anime.js v4 (MIT); seek with window.__hfAnime
//
// The HyperFrames page protocol (src/gsap-compat/hf-protocol.js) is part of every page, marker or not.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// computed here, not imported from render.ts (render.ts imports this module)
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HF_PROTOCOL_PATH = join(PKG, "src", "gsap-compat", "hf-protocol.js");

export interface LibInfo {
  name: string;
  /** Files in load order, relative to the package root. */
  files: string[];
  version: string;
  licence: string;
  /** Globals the page gets. */
  globals: string[];
  /** One line: what it is and how a composition seeks it. */
  about: string;
}

export const LIBS: Record<string, LibInfo> = {
  gsap: {
    name: "gsap",
    files: ["src/gsap-compat/gsap.js"],
    version: "gsap-compat 0.1.0 (GSAP 3 API subset)",
    licence: "MIT (RestorffCut, clean-room; no GSAP code)",
    globals: ["gsap", "CustomEase", "MotionPathPlugin", "TextPlugin", "ScrambleTextPlugin", "DrawSVGPlugin", "SplitText"],
    about: "timelines, tweens, eases, stagger, keyframes, utils; register a paused timeline on window.__timelines[id] and the runtime seeks it",
  },
  three: {
    name: "three",
    files: ["vendor/three/three-0.184.0.min.js"],
    version: "three.js 0.184.0",
    licence: "MIT",
    globals: ["THREE"],
    about: "THREE plus THREE.addons (RoomEnvironment, BufferGeometryUtils, RoundedBoxGeometry, TextGeometry, FontLoader, GLTFLoader, EffectComposer, RenderPass, ShaderPass, OutputPass, BokehPass, UnrealBloomPass, Line2, LineGeometry, LineMaterial, LineSegments2, LineSegmentsGeometry, Font); draw from the hf-seek event's time",
  },
  "three-r147": {
    name: "three-r147",
    files: ["vendor/three-r147/three-0.147.0.min.js", "vendor/three-r147/three-0.147.0-examples.js"],
    version: "three.js 0.147.0",
    licence: "MIT",
    globals: ["THREE", "THREE.GLTFLoader", "THREE.EffectComposer", "THREE.RenderPass", "THREE.ShaderPass", "THREE.UnrealBloomPass", "THREE.CopyShader", "THREE.LuminosityHighPassShader", "THREE.MaskPass", "THREE.Pass"],
    about: "the r147 UMD build and examples/js globals that older blocks were written for; draw from the hf-seek event's time",
  },
  lottie: {
    name: "lottie",
    files: ["vendor/lottie/lottie-5.12.2.min.js"],
    version: "lottie-web 5.12.2",
    licence: "MIT",
    globals: ["lottie"],
    about: "lottie.loadAnimation({ animationData, autoplay: false, loop }) and push it to window.__hfLottie; the runtime calls goToAndStop(frame, true)",
  },
  anime: {
    name: "anime",
    files: ["vendor/anime/anime-4.5.0.umd.min.js"],
    version: "Anime.js 4.5.0",
    licence: "MIT",
    globals: ["anime"],
    about: "anime.animate / anime.createTimeline with autoplay: false, pushed to window.__hfAnime; the runtime calls seek(ms)",
  },
};

const MARKER = /<!--\s*rc-lib\s+([^>]*?)\s*-->/gi;

/** Library names a source asks for, in first-seen order. Unknown names are returned in `unknown`. */
export function libsIn(html: string): { libs: string[]; unknown: string[] } {
  const libs: string[] = [];
  const unknown: string[] = [];
  for (const m of String(html).matchAll(MARKER)) {
    for (const raw of (m[1] ?? "").split(/[\s,]+/)) {
      const name = raw.trim().toLowerCase();
      if (!name) continue;
      if (!LIBS[name]) { if (!unknown.includes(name)) unknown.push(name); continue; }
      if (!libs.includes(name)) libs.push(name);
    }
  }
  // two Three.js builds on one page would fight over window.THREE
  if (libs.includes("three") && libs.includes("three-r147")) unknown.push("three+three-r147 (pick one Three.js build)");
  return { libs, unknown };
}

const cache = new Map<string, string>();
function readPkg(rel: string): string {
  let s = cache.get(rel);
  if (s === undefined) {
    s = readFileSync(join(PKG, rel), "utf8");
    cache.set(rel, s);
  }
  return s;
}

/** The script that loads the named libraries (in order), each file wrapped so a throw names it. */
export function libScript(names: string[]): string {
  let out = "";
  for (const n of names) {
    const lib = LIBS[n];
    if (!lib) continue;
    for (const f of lib.files) out += `\n;/* rc-lib ${n}: ${f} */\n${readPkg(f)}\n`;
  }
  return out;
}

/** The HyperFrames page protocol script (every page). */
export function hfProtocolScript(): string {
  return `\n;/* rc hf-protocol */\n${readPkg("src/gsap-compat/hf-protocol.js")}\n`;
}

/** sha256 over the named libraries' bytes: joins a render hash only when a composition uses libraries. */
export function libsSha(names: string[]): string {
  const h = createHash("sha256");
  for (const n of names) for (const f of LIBS[n]?.files ?? []) h.update(`${f}\n`).update(readPkg(f));
  return h.digest("hex");
}

/** sha256 of hf-protocol.js (part of every render's runtime hash). */
export function hfProtocolSha(): string {
  return createHash("sha256").update(readPkg("src/gsap-compat/hf-protocol.js")).digest("hex");
}

/** For MCP / the catalogue: what each library is. */
export function libraryList(): Array<Omit<LibInfo, "files"> & { marker: string; bytes: number }> {
  return Object.values(LIBS).map(({ files, ...rest }) => ({
    ...rest,
    marker: `<!-- rc-lib ${rest.name} -->`,
    bytes: files.reduce((n, f) => n + Buffer.byteLength(readPkg(f), "utf8"), 0),
  }));
}
