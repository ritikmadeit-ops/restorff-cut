/**
 * `bun test` preload: instantiate the engine's WebAssembly for tests.
 *
 * restorffcut-wasm is wasm-pack's bundler output (`import * as wasm from "./restorffcut_wasm_bg.wasm"`), which Next's
 * bundler instantiates but Bun's test runner does not — every test touching `@/wasm` failed with
 * "wasm.__wbindgen_start is not a function" and then "Cannot access 'ZERO_MEDIA_TIME' before initialization"
 * (2026-10-20, 8 failures + 2 errors). This plugin loads the .wasm as an object module whose exports are the
 * instantiated instance's exports, with the glue file (`_bg.js`) as its only import module.
 */
import { plugin } from "bun";

plugin({
	name: "restorffcut-wasm-for-tests",
	setup(build) {
		build.onLoad({ filter: /_bg\.wasm$/ }, async (args) => {
			const bytes = await Bun.file(args.path).arrayBuffer();
			const gluePath = args.path.replace(/_bg\.wasm$/, "_bg.js");
			const glue = await import(gluePath);
			const importModule = `./${gluePath.split(/[\\/]/).pop()}`;
			const { instance } = await WebAssembly.instantiate(bytes, { [importModule]: glue });
			return { exports: instance.exports as Record<string, unknown>, loader: "object" };
		});
	},
});
