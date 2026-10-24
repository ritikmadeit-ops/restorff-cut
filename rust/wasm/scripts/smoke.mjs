// Smoke test for the built pkg in Node (no GPU): loads rust/wasm/pkg and, optionally, a
// reference build (e.g. the upstream npm package's entry .js) for comparison, then calls the
// pure (non-GPU) exports.
//
// Run from the repo root after `wasm-pack build rust/wasm --target bundler --out-dir pkg`:
//   node --experimental-wasm-modules rust/wasm/scripts/smoke.mjs [path/to/reference-entry.js]
// Exit code 0 = every check passed. GPU exports (initializeGpu, applyEffectPasses, ...) need a
// browser and are covered by `cargo test -p effects --test gpu_render` on the host GPU instead.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
// `bun run build:wasm` writes packages/restorffcut-wasm (what the app imports); a plain
// `wasm-pack build rust/wasm` writes rust/wasm/pkg. Prefer the app's copy when it exists.
const candidates = ["packages/restorffcut-wasm/restorffcut_wasm.js", "rust/wasm/pkg/restorffcut_wasm.js"];
const localPath = resolve(root, candidates.find((candidate) => existsSync(resolve(root, candidate))) ?? candidates[1]);
console.log(`local: ${localPath}`);
const upstreamPath = process.argv[2] ? resolve(root, process.argv[2]) : null;

const local = await import(pathToFileURL(localPath).href);
const upstream =
	upstreamPath && existsSync(upstreamPath)
		? await import(pathToFileURL(upstreamPath).href)
		: null;
console.log(`reference: ${upstream ? upstreamPath : "none"}`);

let failures = 0;
function check(name, condition, detail = "") {
	console.log(`${condition ? "ok  " : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
	if (!condition) failures += 1;
}

const rate = { numerator: 30000, denominator: 1001 };
const cases = [
	["TICKS_PER_SECOND", (m) => m.TICKS_PER_SECOND()],
	["mediaTimeFromSeconds", (m) => m.mediaTimeFromSeconds({ seconds: 12.4 })],
	["formatTimecode HH:MM:SS:FF", (m) => m.formatTimecode({ time: m.mediaTimeFromSeconds({ seconds: 12.4 }), format: "HH:MM:SS:FF", rate })],
	["roundToFrame", (m) => m.roundToFrame({ time: m.mediaTimeFromSeconds({ seconds: 1.234 }), rate })],
	["parseTimecode", (m) => m.parseTimecode({ timeCode: "00:00:31:00", format: "HH:MM:SS:FF", rate: { numerator: 30, denominator: 1 } })],
	["guessTimecodeFormat", (m) => m.guessTimecodeFormat({ timeCode: "00:12" })],
];
for (const [name, run] of cases) {
	const value = run(local);
	if (upstream) {
		const expected = run(upstream);
		check(name, String(value) === String(expected), `local ${value} / npm ${expected}`);
	} else {
		check(name, value !== undefined, String(value));
	}
}

const shaders = local.listEffectShaders();
const ids = shaders.map((shader) => shader.id);
check("listEffectShaders ids", ids.join(",") === "gaussian-blur,restorff-digital-zoom,restorff-vertigo,restorff-glass-panel,restorff-grade", ids.join(","));
const gradeShader = shaders.find((shader) => shader.id === "restorff-grade");
check(
	"grade uniforms (defaults = identity)",
	gradeShader?.uniforms.map((u) => `${u.name}:${u.defaultValue?.join("/")}`).join(",") ===
		"u_exposure:0,u_contrast:0,u_saturation:1,u_temperature:0,u_tint:0,u_lift:0,u_gamma:1,u_gain:1,u_vignette:0,u_grain:0,u_grain_seed:0,u_amount:1,u_split:0/0/0/0",
	gradeShader?.uniforms.map((u) => `${u.name}:${u.defaultValue?.join("/")}`).join(","),
);
const zoom = shaders.find((shader) => shader.id === "restorff-digital-zoom");
check("digital zoom uniforms", zoom?.uniforms.map((u) => `${u.name}:${u.kind}`).join(",") === "u_focal:vec2,u_zoom:number,u_blur:number,u_chroma:number");
const blur = shaders.find((shader) => shader.id === "gaussian-blur");
check("gaussian blur uniforms are required (no defaultValue)", blur?.uniforms.every((u) => u.defaultValue === undefined));

const transitions = local.listTransitionShaders();
const transitionIds = transitions.map((shader) => shader.id.replace("restorff-transition-", ""));
check(
	"listTransitionShaders ids",
	transitionIds.join(",") === "dissolve,dip,flash,whip,slide,zoom,wipe,iris,glitch,blur",
	transitionIds.join(","),
);
const whip = transitions.find((shader) => shader.id === "restorff-transition-whip");
check(
	"whip uniforms have defaults",
	whip?.uniforms.map((u) => `${u.name}:${u.kind}:${u.defaultValue?.join("/")}`).join(",") === "u_direction:vec2:-1/0,u_blur:number:0.3499999940395355",
	whip?.uniforms.map((u) => `${u.name}:${u.kind}:${u.defaultValue?.join("/")}`).join(","),
);

if (upstream) {
	const localExports = Object.keys(local).sort();
	const upstreamExports = Object.keys(upstream).sort();
	const missing = upstreamExports.filter((name) => !localExports.includes(name));
	const added = localExports.filter((name) => !upstreamExports.includes(name));
	check("no upstream export missing", missing.length === 0, missing.join(",") || "none");
	console.log(`info added exports: ${added.join(",") || "none"}`);
}

console.log(failures === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
